"""Attendance rules.

- A session belongs to the date in the person's time zone at check-in; check-in/out are stored in UTC.
- Shift hours: the person's own (employees.shift_start/shift_end), else the country default, else 09:30-18:30.
- Late: checked in after shift start. Early leave: checked out before shift end on the same local date.
- Worked minutes = check-out - check-in - breaks. Overtime = anything over 9 hours in a day.
- Corrections: for a date in the last 30 days (not the future), one pending request per date.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import utcnow
from app.models import AttendanceSession, Employee, LeaveRequest
from app.services.leave import WORKING_LEAVE, holiday_dates, weekly_off_for_employee

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


def shift_for(employee: Employee) -> tuple[str, str]:
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


def apply_flags(session: AttendanceSession) -> None:
    """Recompute late/early flags and worked minutes from the session's times and shift snapshot."""
    tz = ZoneInfo(session.time_zone) if session.time_zone else ZoneInfo("UTC")
    start = datetime.combine(session.work_date, _hm(session.shift_start), tz)
    end = datetime.combine(session.work_date, _hm(session.shift_end), tz)
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


def new_session(employee: Employee, work_date: date, check_in: datetime, work_mode: str, source: str) -> AttendanceSession:
    shift_start, shift_end = shift_for(employee)
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
    holidays = holiday_dates(db, employee.country_code, first, last, employee.holiday_calendar)
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

    working = present = absent = late = early = 0
    on_leave = 0.0
    day = first
    while day <= last:
        is_working = day.weekday() not in weekly_off and day not in holidays
        if is_working:
            working += 1
        if day in sessions:
            present += 1
        elif is_working and day < today:
            if day in leave_days:
                on_leave += leave_days[day]
            else:
                absent += 1
        if is_working and day in leave_days and day in sessions:
            on_leave += leave_days[day]
        day += timedelta(days=1)
    minutes = overtime = 0
    for s in sessions.values():
        late += int(s.is_late)
        early += int(s.is_early_leave)
        minutes += s.worked_minutes or 0
        overtime += max(0, (s.worked_minutes or 0) - OVERTIME_AFTER_MINUTES)
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
    )
