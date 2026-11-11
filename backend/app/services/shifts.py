"""Shift roster rules (same as the portal, src/features/workforce/shiftsStore.ts).

- A manager rosters their direct reports, for future days only. Rules per person: no shift on approved leave,
  at most 6 shift days a week, at least 11 hours rest between shifts.
- Coverage minimum per shift and weekday: the manager's own rule, else the company rule (scope "*"),
  else the starting default (one person on each day shift on weekdays, one on weekend support).
  Holidays (manager's country) need no one. People on approved leave don't count.
- Publishing a week with under-covered upcoming slots is refused unless allow_gaps is set.
- Approving a swap re-checks the rules and coverage; a swap that creates a new gap is refused unless allow_gaps.
- At most MAX_WEEK_HOURS paid hours a week (shift length minus its break); a shift type for one country only goes to
  people working in that country.
- Warnings (shown, not blocking): the person marked themselves unavailable, prefers another shift, or the day is
  their weekly off or a public holiday.
- Attendance and the timesheet day target use the person's shift on the published roster that day (rostered_shift).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    Account, CoverageMinimum, Employee, LeaveRequest, RosterShift, RosterWeek, ShiftAvailability, ShiftType,
)
from app.services.headcount import has_started
from app.services.leave import holiday_dates

MIN_REST_HOURS = 11
MAX_DAYS_PER_WEEK = 6
MAX_WEEK_HOURS = 48
MIN_SHIFT_HOURS, MAX_SHIFT_HOURS = 4, 12
SHIFT_COLORS = ("amber", "green", "blue", "violet", "teal", "rose", "slate")
MAX_COVERAGE = 20
COMPANY_SCOPE = "*"
WEEKDAY_NAMES = ("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")
DAY_NAMES = ("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")
DEFAULT_MINIMUMS: dict[str, tuple[int, int]] = {  # shift id -> (weekday, weekend)
    "sh-morning": (1, 0),
    "sh-general": (1, 0),
    "sh-evening": (1, 0),
    "sh-night": (0, 0),
    "sh-weekend": (0, 1),
}


class RosterError(ValueError):
    """A roster rule was broken; the message is safe to show."""


def portal_weekday(d: date) -> int:
    """0 = Sunday ... 6 = Saturday."""
    return (d.weekday() + 1) % 7


def week_start_of(d: date) -> date:
    return d - timedelta(days=d.weekday())


def week_dates(week_start: date) -> list[date]:
    return [week_start + timedelta(days=i) for i in range(7)]


def is_weekend(d: date) -> bool:
    return d.weekday() >= 5


def team_ids(db: Session, manager_id: str) -> list[str]:
    return list(db.scalars(select(Employee.id).where(Employee.manager_id == manager_id).order_by(Employee.id)))


def starts_after(db: Session, employee_id: str, d: date) -> Employee | None:
    """The person if they haven't joined by this day (pre-boarding joiners aren't rostered before their start)."""
    emp = db.get(Employee, employee_id)
    return emp if emp is not None and emp.joining_date > d else None


def swap_partner_error(db: Session, employee_id: str, d: date, today: date) -> str | None:
    """Why this colleague can't be asked to swap on day d (they must have started and be able to sign in to respond)."""
    emp = db.get(Employee, employee_id)
    if emp is None:
        return "That colleague wasn't found."
    if emp.joining_date > d or not has_started(emp, today):
        return f"{emp.full_name} hasn't started yet, so they can't swap shifts."
    if db.scalar(select(Account.id).where(Account.employee_id == employee_id, Account.active.is_(True))) is None:
        return f"{emp.full_name} has no sign-in account, so they can't respond to a swap."
    return None


def on_leave(db: Session, employee_id: str, d: date) -> bool:
    return db.scalar(select(LeaveRequest.id).where(
        LeaveRequest.employee_id == employee_id, LeaveRequest.status == "approved",
        LeaveRequest.from_date <= d, LeaveRequest.to_date >= d)) is not None


def _minutes(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def _span(shift: ShiftType, d: date) -> tuple[datetime, datetime]:
    start = datetime.combine(d, datetime.min.time()) + timedelta(minutes=_minutes(shift.start))
    end = datetime.combine(d, datetime.min.time()) + timedelta(minutes=_minutes(shift.end))
    if end <= start:
        end += timedelta(days=1)  # overnight
    return start, end


def span_minutes(start: str, end: str) -> int:
    """Length of a shift in minutes; an end at or before the start is on the next day (overnight)."""
    return (_minutes(end) - _minutes(start)) % 1440 or 1440


def is_overnight(shift: ShiftType) -> bool:
    return _minutes(shift.end) <= _minutes(shift.start)


def paid_hours(shift: ShiftType) -> float:
    """Paid hours: the shift's length minus its unpaid break."""
    return round(max(0, span_minutes(shift.start, shift.end) - (shift.break_minutes or 0)) / 60, 2)


def shift_type_error(start: str, end: str, break_minutes: int, color: str | None, country_code: str | None) -> str | None:
    """Validation for a shift template (same as the portal's saveShift)."""
    if start == end:
        return "Start and end can't be the same."
    length = span_minutes(start, end)
    if length < MIN_SHIFT_HOURS * 60 or length > MAX_SHIFT_HOURS * 60:
        return f"A shift must be between {MIN_SHIFT_HOURS} and {MAX_SHIFT_HOURS} hours long."
    if break_minutes >= length:
        return "The break can't be as long as the shift."
    if color and color not in SHIFT_COLORS:
        return "Pick one of the roster colours."
    if country_code and (len(country_code) != 2 or not country_code.isalpha()):
        return "Country must be a 2-letter code."
    return None


def rostered_shift(db: Session, employee_id: str, day: date) -> ShiftType | None:
    """The person's shift on the published roster that day (attendance late/early flags and the timesheet day)."""
    row = db.scalar(select(RosterShift).where(RosterShift.employee_id == employee_id, RosterShift.work_date == day))
    if row is None or not is_published(db, row):
        return None
    return db.get(ShiftType, row.shift_id)


def rule_error(db: Session, employee_id: str, d: date, shift: ShiftType, exclude: set[str] | None = None,
               override: dict[str, str] | None = None) -> str | None:
    """Leave, 6-days-a-week and 11-hour-rest checks for putting this person on this shift that day."""
    if shift.weekend_only and not is_weekend(d):
        return f"{shift.name} runs only on weekends."
    if on_leave(db, employee_id, d):
        return "That person is on approved leave that day."
    if shift.country_code:
        emp = db.get(Employee, employee_id)
        if emp is not None and (emp.country_code or "").upper() != shift.country_code.upper():
            return f"{shift.name} is for people working in {shift.country_code.upper()}."
    exclude = exclude or set()
    override = override or {}
    others = [r for r in db.scalars(select(RosterShift).where(
        RosterShift.employee_id == employee_id, RosterShift.work_date >= d - timedelta(days=7),
        RosterShift.work_date <= d + timedelta(days=7))) if r.id not in exclude and r.work_date != d]
    ws = week_start_of(d)
    if len([r for r in others if week_start_of(r.work_date) == ws]) + 1 > MAX_DAYS_PER_WEEK:
        return f"At most {MAX_DAYS_PER_WEEK} shift days a week."
    week_hours = paid_hours(shift)
    for r in others:
        if week_start_of(r.work_date) == ws:
            other = db.get(ShiftType, override.get(r.id, r.shift_id))
            week_hours += paid_hours(other) if other else 0
    if week_hours > MAX_WEEK_HOURS:
        return f"Weekly hours: that would be {week_hours:g} paid hours in the week (max {MAX_WEEK_HOURS})."
    start, end = _span(shift, d)
    for r in others:
        if abs((r.work_date - d).days) != 1:
            continue
        other = db.get(ShiftType, override.get(r.id, r.shift_id))
        if other is None:
            continue
        o_start, o_end = _span(other, r.work_date)
        gap = (start - o_end) if r.work_date < d else (o_start - end)
        if gap < timedelta(hours=MIN_REST_HOURS):
            return f"Rest rule: {MIN_REST_HOURS} hours are needed between shifts."
    return None


def availability_for(db: Session, employee_id: str, d: date) -> list[ShiftAvailability]:
    """The person's availability entries that apply on day d (that date, or that weekday every week)."""
    return list(db.scalars(select(ShiftAvailability).where(
        ShiftAvailability.employee_id == employee_id,
        (ShiftAvailability.work_date == d) | (ShiftAvailability.weekday == portal_weekday(d)))))


def assign_warnings(db: Session, employee_id: str, d: date, shift: ShiftType) -> list[str]:
    """Reasons to think twice (not rule breaks): unavailable, prefers another shift, weekly off, public holiday."""
    from app.services.leave import holiday_dates_for, weekly_off_for_employee

    out: list[str] = []
    emp = db.get(Employee, employee_id)
    name = emp.full_name if emp else employee_id
    for a in availability_for(db, employee_id, d):
        when = "that day" if a.work_date else f"every {DAY_NAMES[a.weekday or 0]}"
        if a.kind == "unavailable":
            out.append(f"{name} marked themselves unavailable {when}" + (f" ({a.note})." if a.note else "."))
        elif a.kind == "preferred" and a.shift_id and a.shift_id != shift.id:
            pref = db.get(ShiftType, a.shift_id)
            out.append(f"{name} prefers {pref.name if pref else 'another shift'} {when}.")
    if emp is not None:
        try:
            if d.weekday() in weekly_off_for_employee(db, emp):
                out.append(f"{d.strftime('%A')} is {name}'s weekly off.")
        except Exception:  # noqa: BLE001 (no schedule data)
            pass
        if d in holiday_dates_for(db, emp, d, d):
            out.append(f"{d.isoformat()} is a public holiday for {name}.")
    return out


def coverage_minimum(db: Session, scope: str, shift: ShiftType, weekday: int) -> int:
    for s in (scope, COMPANY_SCOPE):
        row = db.scalar(select(CoverageMinimum).where(CoverageMinimum.scope == s, CoverageMinimum.shift_id == shift.id,
                                                      CoverageMinimum.weekday == weekday))
        if row is not None:
            return row.minimum
    weekend = weekday in (0, 6)
    if shift.weekend_only and not weekend:
        return 0
    seed = DEFAULT_MINIMUMS.get(shift.id, (0, 0))
    return seed[1] if weekend else seed[0]


@dataclass
class CoverageSlot:
    date: date
    shift_id: str
    shift_name: str
    required: int
    assigned: int
    on_leave: list[str] = field(default_factory=list)
    status: str = "ok"  # under | ok | over | none


def week_coverage(db: Session, manager_id: str, week_start: date, override: dict[str, str] | None = None) -> list[CoverageSlot]:
    """Assigned vs required for every shift on every day of the manager's week. override: roster row id -> shift id."""
    override = override or {}
    manager = db.get(Employee, manager_id)
    days = week_dates(week_start)
    holidays = holiday_dates(db, manager.country_code, days[0], days[-1]) if manager else set()
    rows = list(db.scalars(select(RosterShift).where(RosterShift.manager_id == manager_id,
                                                     RosterShift.work_date >= days[0], RosterShift.work_date <= days[-1])))
    slots: list[CoverageSlot] = []
    for shift in db.scalars(select(ShiftType).order_by(ShiftType.start)):
        for d in days:
            here = [r for r in rows if r.work_date == d and override.get(r.id, r.shift_id) == shift.id]
            if (not shift.active or (shift.weekend_only and not is_weekend(d))) and not here:
                continue
            leave = [r.employee_id for r in here if on_leave(db, r.employee_id, d)]
            assigned = len(here) - len(leave)
            if d in holidays or not shift.active or (shift.weekend_only and not is_weekend(d)):
                required = 0
            else:
                required = coverage_minimum(db, manager_id, shift, portal_weekday(d))
            status = ("under" if assigned < required else "over" if required > 0 and assigned > required
                      else "none" if required == 0 and assigned == 0 else "ok")
            slots.append(CoverageSlot(d, shift.id, shift.name, required, assigned, leave, status))
    return slots


def coverage_gaps(db: Session, manager_id: str, week_start: date, today: date,
                  override: dict[str, str] | None = None) -> list[CoverageSlot]:
    return sorted((s for s in week_coverage(db, manager_id, week_start, override) if s.status == "under" and s.date > today),
                  key=lambda s: (s.date, s.shift_id))


def new_gaps(before: list[CoverageSlot], after: list[CoverageSlot]) -> list[CoverageSlot]:
    out = []
    for a in after:
        prev = next((b for b in before if b.date == a.date and b.shift_id == a.shift_id), None)
        if prev is None or a.assigned < prev.assigned:
            out.append(a)
    return out


def describe(gaps: list[CoverageSlot]) -> str:
    parts = [f"{g.shift_name} on {g.date.isoformat()} ({g.assigned} of {g.required})" for g in gaps[:3]]
    return ", ".join(parts) + (f" and {len(gaps) - 3} more" if len(gaps) > 3 else "")


def roster_week(db: Session, manager_id: str, week_start: date) -> RosterWeek | None:
    return db.scalar(select(RosterWeek).where(RosterWeek.manager_id == manager_id, RosterWeek.week_start == week_start))


def is_published(db: Session, row: RosterShift) -> bool:
    week = roster_week(db, row.manager_id, week_start_of(row.work_date))
    return week is not None and week.status == "published"


# ---------- comp-off for working a weekly off or holiday (migration 0025) ----------
COMP_OFF_VALID_DAYS = 90


def comp_off_reason(db: Session, employee: Employee, d: date) -> str | None:
    """Why working this day earns comp-off (a holiday in the person's calendar, or Saturday / Sunday), or None."""
    from app.services.leave import holiday_dates_for
    from app.models import Holiday

    if d in holiday_dates_for(db, employee, d, d):
        name = db.scalar(select(Holiday.name).where(Holiday.date == d, Holiday.country_code == employee.country_code))
        return f"Holiday ({name})" if name else "Holiday"
    if d.weekday() == 5:
        return "Weekly off (Saturday)"
    if d.weekday() == 6:
        return "Weekly off (Sunday)"
    return None


def roster_comp_off_days(db: Session, employee_id: str, year: int, today: date) -> tuple[float, float]:
    """(earned, used): comp-off days from roster credits worked in the year — credits used by comp-off leave before
    they expired plus credits still valid (same rule as the portal's compOffCreditsFor) — and how many were used."""
    from app.models import CompOffCredit

    credits = list(db.scalars(select(CompOffCredit).where(
        CompOffCredit.employee_id == employee_id, CompOffCredit.worked_date >= date(year, 1, 1),
        CompOffCredit.worked_date <= date(year, 12, 31)).order_by(CompOffCredit.worked_date)))
    if not credits:
        return 0.0, 0.0
    taken = db.scalars(select(LeaveRequest).where(
        LeaveRequest.employee_id == employee_id, LeaveRequest.leave_code == "comp_off",
        LeaveRequest.status.in_(("pending", "approved")), LeaveRequest.from_date >= date(year, 1, 1)))
    days: list[date] = []
    for req in taken:
        d = req.from_date
        while d <= req.to_date:
            days.append(d)
            d += timedelta(days=1)
    used: set[str] = set()
    for d in sorted(days):
        credit = next((c for c in credits if c.id not in used and c.worked_date < d <= c.expires_on), None)
        if credit is not None:
            used.add(credit.id)
    earned = float(sum(float(c.days) for c in credits if c.id in used or c.expires_on >= today))
    return earned, float(sum(float(c.days) for c in credits if c.id in used))
