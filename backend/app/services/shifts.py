"""Shift roster rules (same as the portal, src/features/workforce/shiftsStore.ts).

- A manager rosters their direct reports, for future days only. Rules per person: no shift on approved leave,
  at most 6 shift days a week, at least 11 hours rest between shifts.
- Coverage minimum per shift and weekday: the manager's own rule, else the company rule (scope "*"),
  else the starting default (one person on each day shift on weekdays, one on weekend support).
  Holidays (manager's country) need no one. People on approved leave don't count.
- Publishing a week with under-covered upcoming slots is refused unless allow_gaps is set.
- Approving a swap re-checks the rules and coverage; a swap that creates a new gap is refused unless allow_gaps.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Account, CoverageMinimum, Employee, LeaveRequest, RosterShift, RosterWeek, ShiftType
from app.services.headcount import has_started
from app.services.leave import holiday_dates

MIN_REST_HOURS = 11
MAX_DAYS_PER_WEEK = 6
MAX_COVERAGE = 20
COMPANY_SCOPE = "*"
WEEKDAY_NAMES = ("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")
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


def rule_error(db: Session, employee_id: str, d: date, shift: ShiftType, exclude: set[str] | None = None,
               override: dict[str, str] | None = None) -> str | None:
    """Leave, 6-days-a-week and 11-hour-rest checks for putting this person on this shift that day."""
    if shift.weekend_only and not is_weekend(d):
        return f"{shift.name} runs only on weekends."
    if on_leave(db, employee_id, d):
        return "That person is on approved leave that day."
    exclude = exclude or set()
    override = override or {}
    others = [r for r in db.scalars(select(RosterShift).where(
        RosterShift.employee_id == employee_id, RosterShift.work_date >= d - timedelta(days=7),
        RosterShift.work_date <= d + timedelta(days=7))) if r.id not in exclude and r.work_date != d]
    ws = week_start_of(d)
    if len([r for r in others if week_start_of(r.work_date) == ws]) + 1 > MAX_DAYS_PER_WEEK:
        return f"At most {MAX_DAYS_PER_WEEK} shift days a week."
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
