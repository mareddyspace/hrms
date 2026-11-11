"""Attendance rules.

- A session belongs to the date in the person's time zone at check-in; check-in/out are stored in UTC.
- Shift hours: the person's shift on the published roster that day (app/services/shifts.rostered_shift), else their
  own (employees.shift_start/shift_end), else the country default, else 09:30-18:30. An overnight shift ends next day.
- Late: checked in after shift start. Early leave: checked out before shift end on the same local date.
- Worked minutes = check-out - check-in - breaks. Breaks are started and ended on the session (kept as a list);
  the total is the sum of closed breaks (an open break is closed at check-out). Overtime = anything over 9 hours.
- Corrections: for a date in the last 30 days (not the future), one pending request per date.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import utcnow
from app.models import AttendanceSession, Employee, LeaveRequest
from app.services.leave import WORKING_LEAVE, holiday_dates_for, weekly_off_for_employee

DEFAULT_SHIFT = ("09:30", "18:30")
COUNTRY_SHIFTS: dict[str, tuple[str, str]] = {
    "IN": ("09:30", "18:30"),
    "US": ("09:00", "17:30"),
    "CA": ("09:00", "17:30"),
    "GB": ("09:00", "17:30"),
    "DE": ("09:00", "17:30"),
    "AU": ("09:00", "17:30"),
    "AE": ("09:00", "18:00"),
    "SA": ("08:00", "17:00"),
}
OVERTIME_AFTER_MINUTES = 9 * 60
CORRECTION_WINDOW_DAYS = 30
WORK_MODES = ("office", "wfh", "remote")
SOURCES = ("web", "mobile", "device")


class AttendanceError(ValueError):
    """A rule was broken; the message is safe to show the user."""


def now() -> datetime:
    """Current UTC time (tests replace this to check in at a fixed moment)."""
    return utcnow()


def zone(employee: Employee) -> ZoneInfo:
    try:
        return ZoneInfo(employee.time_zone)
    except Exception:  # unknown zone name
        return ZoneInfo("UTC")


def local_today(employee: Employee) -> date:
    return now().astimezone(zone(employee)).date()


def shift_for(employee: Employee, db: Session | None = None, day: date | None = None) -> tuple[str, str]:
    if db is not None and day is not None:
        try:
            from app.services.shifts import rostered_shift

            rostered = rostered_shift(db, employee.id, day)
        except Exception:  # noqa: BLE001 (roster tables missing on an old database)
            rostered = None
        if rostered is not None:
            return rostered.start, rostered.end
    if employee.shift_start and employee.shift_end:
        return employee.shift_start, employee.shift_end
    return COUNTRY_SHIFTS.get(employee.country_code, DEFAULT_SHIFT)


def _hm(value: str) -> time:
    h, m = value.split(":")
    return time(int(h), int(m))


def to_utc(value: datetime, employee: Employee) -> datetime:
    """A naive time is read as the person's local time."""
    if value.tzinfo is None:
        value = value.replace(tzinfo=zone(employee))
    return value.astimezone(UTC)


def _parse(value: str | None) -> datetime | None:
    if not value:
        return None
    moment = datetime.fromisoformat(value)
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def break_list(session: AttendanceSession) -> list[dict]:
    return [dict(b) for b in (session.breaks or [])]


def open_break(session: AttendanceSession) -> dict | None:
    return next((b for b in break_list(session) if not b.get("end")), None)


def breaks_minutes(breaks: list[dict], until: datetime | None = None) -> int:
    """Total minutes of the breaks; an open one counts up to `until` (or not at all)."""
    total = 0
    for b in breaks:
        start, end = _parse(b.get("start")), _parse(b.get("end")) or until
        if start and end and end > start:
            total += int((end - start).total_seconds() // 60)
    return total


def start_break(session: AttendanceSession, moment: datetime) -> None:
    if session.check_out is not None:
        raise AttendanceError("You have already checked out.")
    if open_break(session):
        raise AttendanceError("You are already on a break.")
    if moment < session.check_in:
        raise AttendanceError("A break can't start before check-in.")
    session.breaks = break_list(session) + [{"start": moment.astimezone(UTC).isoformat(), "end": None}]


def end_break(session: AttendanceSession, moment: datetime) -> None:
    items = break_list(session)
    current = next((b for b in items if not b.get("end")), None)
    if current is None:
        raise AttendanceError("You are not on a break.")
    current["end"] = moment.astimezone(UTC).isoformat()
    session.breaks = items
    session.break_minutes = breaks_minutes(items)


def close_breaks(session: AttendanceSession, moment: datetime) -> None:
    """At check-out: end an open break and take the total from the list."""
    items = break_list(session)
    if not items:
        return
    for b in items:
        if not b.get("end"):
            b["end"] = moment.astimezone(UTC).isoformat()
    session.breaks = items
    session.break_minutes = min(720, breaks_minutes(items))


def apply_flags(session: AttendanceSession) -> None:
    """Recompute late/early flags and worked minutes from the session's times and shift snapshot."""
    tz = ZoneInfo(session.time_zone) if session.time_zone else ZoneInfo("UTC")
    start = datetime.combine(session.work_date, _hm(session.shift_start), tz)
    end = datetime.combine(session.work_date, _hm(session.shift_end), tz)
    if end <= start:  # overnight shift: ends the next morning
        end += timedelta(days=1)
    late = int((session.check_in - start).total_seconds() // 60)
    session.late_minutes = max(0, late)
    session.is_late = late > 0
    if session.check_out is None:
        session.early_minutes, session.is_early_leave, session.worked_minutes = 0, False, None
        return
    early = int((end - session.check_out).total_seconds() // 60)
    session.early_minutes = max(0, early)
    session.is_early_leave = early > 0
    worked = int((session.check_out - session.check_in).total_seconds() // 60) - (session.break_minutes or 0)
    session.worked_minutes = max(0, worked)


# The day's clock stops at 9 hours of work (breaks not counted): the session is closed at that moment and the person
# adds that day's timesheet when they next sign in (routers/timesheets.py lets them, even on a later day).
MAX_WORK_MINUTES = 9 * 60
AUTO_CHECKOUT_NOTE = "Checked out automatically after 9 hours of work."


def is_auto_checked_out(session: AttendanceSession | None) -> bool:
    return bool(session and session.check_out is not None and (session.note or "").startswith(AUTO_CHECKOUT_NOTE))


def cap_moment(session: AttendanceSession) -> datetime | None:
    """When worked time reaches MAX_WORK_MINUTES, or None while it can't yet (checked out, or on a break)."""
    if session.check_out is not None:
        return None
    moment = session.check_in + timedelta(minutes=MAX_WORK_MINUTES)
    for b in sorted(break_list(session), key=lambda x: x.get("start") or ""):
        start, end = _parse(b.get("start")), _parse(b.get("end"))
        if start is None or start >= moment:
            break
        if end is None:
            return None  # on a break that began before the 9-hour mark: the clock is paused
        moment += end - start
    return moment


def auto_checkout(session: AttendanceSession, at: datetime | None = None) -> bool:
    """Close an open session at the 9-hour mark once that moment has passed. True when it closed the session."""
    moment = cap_moment(session)
    if moment is None or moment > (at or now()):
        return False
    session.breaks = [b for b in break_list(session) if (_parse(b.get("start")) or moment) < moment] or None
    close_breaks(session, moment)
    session.break_minutes = breaks_minutes(break_list(session))
    session.check_out = moment
    session.note = AUTO_CHECKOUT_NOTE + (f" {session.note}" if session.note else "")
    apply_flags(session)
    return True


def close_overdue(db: Session, employee_id: str | None = None, at: datetime | None = None) -> list[AttendanceSession]:
    """Auto check-out every open session (or one person's) past 9 hours; audited, and the person is told."""
    from app.services.activity import notify, record_audit

    stmt = select(AttendanceSession).where(AttendanceSession.check_out.is_(None))
    if employee_id:
        stmt = stmt.where(AttendanceSession.employee_id == employee_id)
    closed = [s for s in db.scalars(stmt) if auto_checkout(s, at)]
    for s in closed:
        record_audit(db, actor_id=None, action="attendance_auto_checkout", entity="attendance_session", entity_id=s.id,
                     subject_id=s.employee_id, before={"check_out": None},
                     after={"check_out": s.check_out, "worked_minutes": s.worked_minutes})
        notify(db, recipient_id=s.employee_id, title="Checked out after 9 hours",
               body=f"Your attendance for {s.work_date} stopped at 9 hours. Add what you worked on and submit that "
                    "day's timesheet.", href=f"/timesheet?day={s.work_date.isoformat()}")
    if closed:
        db.flush()
    return closed


def new_session(employee: Employee, work_date: date, check_in: datetime, work_mode: str, source: str,
                db: Session | None = None) -> AttendanceSession:
    shift_start, shift_end = shift_for(employee, db, work_date)
    return AttendanceSession(
        id=f"att-{employee.id}-{work_date.isoformat()}"[:64],
        employee_id=employee.id,
        work_date=work_date,
        time_zone=str(zone(employee).key),
        check_in=check_in,
        check_out=None,
        break_minutes=0,
        work_mode=work_mode,
        source=source,
        shift_start=shift_start,
        shift_end=shift_end,
        corrected=False,
    )


def validate_correction_times(
    employee: Employee, work_date: date, check_in: datetime | None, check_out: datetime | None, has_session: bool
) -> None:
    today = local_today(employee)
    if work_date > today:
        raise AttendanceError("You can't correct a future date.")
    if work_date < today - timedelta(days=CORRECTION_WINDOW_DAYS):
        raise AttendanceError(f"Corrections are only possible for the last {CORRECTION_WINDOW_DAYS} days.")
    if check_in is None and check_out is None:
        raise AttendanceError("Give a check-in or check-out time.")
    if check_in is None and not has_session:
        raise AttendanceError("There is no attendance for that day, so a check-in time is needed.")
    tz = zone(employee)
    if check_in is not None and check_in.astimezone(tz).date() != work_date:
        raise AttendanceError("The check-in time must be on the date being corrected.")
    if check_in is not None and check_out is not None:
        if check_out <= check_in:
            raise AttendanceError("Check-out must be after check-in.")
        if check_out - check_in > timedelta(hours=24):
            raise AttendanceError("A session can't be longer than 24 hours.")
    if check_out is not None and check_out > now():
        raise AttendanceError("Check-out can't be in the future.")


@dataclass
class MonthSummary:
    employee_id: str
    month: str
    working_days: int
    present: int
    absent: int
    on_leave: float
    late: int
    early: int
    hours: float
    overtime_hours: float
    expected_days: int = 0
    attendance_pct: float = 0
    avg_hours: float = 0
    missing_punches: int = 0
    late_minutes: int = 0
    break_minutes: int = 0


def month_summary(db: Session, employee: Employee, year: int, month: int) -> MonthSummary:
    first = date(year, month, 1)
    last = (date(year + (month == 12), month % 12 + 1, 1)) - timedelta(days=1)
    today = local_today(employee)
    sessions = {
        s.work_date: s
        for s in db.scalars(
            select(AttendanceSession).where(
                AttendanceSession.employee_id == employee.id,
                AttendanceSession.work_date >= first,
                AttendanceSession.work_date <= last,
            )
        )
    }
    holidays = holiday_dates_for(db, employee, first, last)
    weekly_off = weekly_off_for_employee(db, employee)
    leave_days: dict[date, float] = {}
    for lv in db.scalars(
        select(LeaveRequest).where(
            LeaveRequest.employee_id == employee.id,
            LeaveRequest.status == "approved",
            LeaveRequest.from_date <= last,
            LeaveRequest.to_date >= first,
            LeaveRequest.leave_code.not_in(WORKING_LEAVE),
        )
    ):
        day = max(lv.from_date, first)
        while day <= min(lv.to_date, last):
            leave_days[day] = max(leave_days.get(day, 0), 0.5 if lv.half != "none" else 1.0)
            day += timedelta(days=1)

    # Days before the person's first ever check-in aren't tracked (no absences, not expected).
    tracked_from = db.scalar(
        select(func.min(AttendanceSession.work_date)).where(AttendanceSession.employee_id == employee.id)
    ) or (today + timedelta(days=1))
    working = present = absent = late = early = expected = 0
    on_leave = 0.0
    day = first
    while day <= last:
        is_working = day.weekday() not in weekly_off and day not in holidays
        if is_working:
            working += 1
            # days that should have been worked by now (past, or today once checked in), less full-day leave
            if day >= tracked_from and (day < today or (day == today and day in sessions)) and leave_days.get(day, 0) < 1:
                expected += 1
        if day in sessions:
            present += 1
        elif is_working and tracked_from <= day < today:
            if day in leave_days:
                on_leave += leave_days[day]
            else:
                absent += 1
        if is_working and day in leave_days and day in sessions:
            on_leave += leave_days[day]
        day += timedelta(days=1)
    minutes = overtime = complete = missing = late_total = break_total = 0
    for s in sessions.values():
        late += int(s.is_late)
        late_total += s.late_minutes or 0
        early += int(s.is_early_leave)
        minutes += s.worked_minutes or 0
        break_total += s.break_minutes or 0
        overtime += max(0, (s.worked_minutes or 0) - OVERTIME_AFTER_MINUTES)
        if s.check_out is not None:
            complete += 1
        elif s.work_date < today:
            missing += 1  # checked in, never checked out
    attended = min(present, expected) if expected else present
    return MonthSummary(
        employee_id=employee.id,
        month=f"{year:04d}-{month:02d}",
        working_days=working,
        present=present,
        absent=absent,
        on_leave=on_leave,
        late=late,
        early=early,
        hours=round(minutes / 60, 2),
        overtime_hours=round(overtime / 60, 2),
        expected_days=expected,
        attendance_pct=round(100 * attended / expected, 1) if expected else 0.0,
        avg_hours=round(minutes / 60 / complete, 2) if complete else 0.0,
        missing_punches=missing,
        late_minutes=late_total,
        break_minutes=break_total,
    )
