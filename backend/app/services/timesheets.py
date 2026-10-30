"""Timesheet rules.

- Weeks start on Monday. Entries can be added, changed or removed while the week is draft or rejected.
- Submitting checks: at least one entry, at most 24 h per day, nothing logged on a day of approved full-day leave,
  and at most 4.5 h on a day of approved half-day leave (work-from-home "leave" is a working day).
- Daily timesheets (TimesheetDay): each working day is submitted on its own and needs at least DAY_TARGET (9 h),
  or HALF_DAY_TARGET (4.5 h) on approved half-day leave. A day of approved full-day leave has nothing to submit;
  time logged on a weekend or holiday can be submitted with no minimum. A submitted or approved day is locked;
  a day sent back (rejected) or reopened by the manager for a missed day ("reopened") can be corrected and submitted
  again, also on a later date.
- A week submitted the old (weekly) way only locks the entries it was submitted with (created up to submitted_at):
  other days of that week are logged and submitted day by day.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Employee, LeaveRequest, TimesheetDay, TimesheetEntry, TimesheetWeek
from app.services.leave import WEEKLY_OFF, WORKING_LEAVE, holiday_dates_for

EDITABLE = ("draft", "rejected")
MAX_DAY_HOURS = 24.0
HALF_DAY_MAX_HOURS = 4.5
DAY_TARGET = 9.0
HALF_DAY_TARGET = 4.5
DAY_LOCKED = ("submitted", "approved")
DAY_FIXABLE = ("rejected", "reopened")  # sent back / reopened: can be logged and submitted later


class TimesheetError(ValueError):
    """A rule was broken; the message is safe to show the user."""


def week_start_of(day: date) -> date:
    return day - timedelta(days=day.weekday())


def get_or_create_week(db: Session, employee: Employee, week_start: date) -> TimesheetWeek:
    week = db.scalar(
        select(TimesheetWeek).where(TimesheetWeek.employee_id == employee.id, TimesheetWeek.week_start == week_start)
    )
    if week is None:
        week = TimesheetWeek(id=f"tsw-{uuid.uuid4().hex[:12]}", employee_id=employee.id, week_start=week_start, status="draft")
        db.add(week)
        db.flush()
    return week


def week_entries(db: Session, week: TimesheetWeek) -> list[TimesheetEntry]:
    """The week's entries; for a submitted / approved week only those it was submitted with (later ones are daily)."""
    stmt = select(TimesheetEntry).where(TimesheetEntry.week_id == week.id)
    if week.status not in EDITABLE and week.submitted_at is not None:
        stmt = stmt.where(TimesheetEntry.created_at <= week.submitted_at)
    return list(db.scalars(stmt.order_by(TimesheetEntry.work_date)))


def entry_in_locked_week(week: TimesheetWeek | None, entry: TimesheetEntry) -> bool:
    """The entry belongs to an old weekly submission that is pending or approved."""
    if week is None or week.status in EDITABLE:
        return False
    return week.submitted_at is None or entry.created_at <= week.submitted_at


def locked_week_dates(db: Session, week: TimesheetWeek) -> set[date]:
    """Dates an old weekly submission (pending / approved) covers; other days of the week stay open."""
    if week.status in EDITABLE:
        return set()
    return {e.work_date for e in week_entries(db, week)}


def week_total(db: Session, week: TimesheetWeek) -> float:
    return round(sum(float(e.hours) for e in week_entries(db, week)), 2)


def leave_on(db: Session, employee_id: str, start: date, end: date) -> dict[date, str]:
    """Approved leave per day in [start, end]: "full" or "half"."""
    out: dict[date, str] = {}
    for lv in db.scalars(
        select(LeaveRequest).where(
            LeaveRequest.employee_id == employee_id,
            LeaveRequest.status == "approved",
            LeaveRequest.from_date <= end,
            LeaveRequest.to_date >= start,
            LeaveRequest.leave_code.not_in(WORKING_LEAVE),
        )
    ):
        day = max(lv.from_date, start)
        while day <= min(lv.to_date, end):
            kind = "half" if lv.half != "none" else "full"
            if out.get(day) != "full":
                out[day] = kind
            day += timedelta(days=1)
    return out


def validate_submit(db: Session, week: TimesheetWeek) -> None:
    if week.status not in EDITABLE:
        raise TimesheetError(f"This week is already {week.status}.")
    entries = week_entries(db, week)
    if not entries:
        raise TimesheetError("Add at least one entry before submitting.")
    per_day: dict[date, float] = defaultdict(float)
    for e in entries:
        per_day[e.work_date] += float(e.hours)
    leave = leave_on(db, week.employee_id, week.week_start, week.week_start + timedelta(days=6))
    for day in sorted(per_day):
        hours = per_day[day]
        if hours > MAX_DAY_HOURS:
            raise TimesheetError(f"{day}: {hours:g} h logged - a day can't have more than 24 h.")
        if leave.get(day) == "full":
            raise TimesheetError(f"{day}: you were on approved leave, so no hours can be logged.")
        if leave.get(day) == "half" and hours > HALF_DAY_MAX_HOURS:
            raise TimesheetError(f"{day}: half-day leave - at most {HALF_DAY_MAX_HOURS:g} h can be logged.")


# ---------- daily timesheets ----------
def get_day(db: Session, employee_id: str, day: date) -> TimesheetDay | None:
    return db.scalar(select(TimesheetDay).where(TimesheetDay.employee_id == employee_id, TimesheetDay.work_date == day))


def day_entries(db: Session, employee_id: str, day: date) -> list[TimesheetEntry]:
    return list(db.scalars(select(TimesheetEntry).where(TimesheetEntry.employee_id == employee_id, TimesheetEntry.work_date == day)
                           .order_by(TimesheetEntry.created_at)))


def day_total(db: Session, employee_id: str, day: date) -> float:
    return round(sum(float(e.hours) for e in day_entries(db, employee_id, day)), 2)


def day_target(db: Session, employee: Employee, day: date) -> tuple[float, str | None]:
    """(minimum hours to submit, why the day is different): 9 h, 4.5 h on half-day leave, 0 on leave / off days."""
    leave = leave_on(db, employee.id, day, day).get(day)
    if leave == "full":
        return 0.0, "leave"
    if day.weekday() in WEEKLY_OFF:
        return 0.0, "weekend"
    if day in holiday_dates_for(db, employee, day, day):
        return 0.0, "holiday"
    if leave == "half":
        return HALF_DAY_TARGET, "half-day leave"
    return DAY_TARGET, None


def validate_day_submit(db: Session, employee: Employee, day: date, row: TimesheetDay | None) -> float:
    """Checks one day can be submitted; returns its total hours."""
    if row is not None and row.status in DAY_LOCKED:
        raise TimesheetError(f"{day} is already {row.status}.")
    week = db.scalar(select(TimesheetWeek).where(TimesheetWeek.employee_id == employee.id,
                                                 TimesheetWeek.week_start == week_start_of(day)))
    if week is not None and day in locked_week_dates(db, week):
        raise TimesheetError(f"{day} is in the week of {week.week_start}, which is already {week.status}.")
    total = day_total(db, employee.id, day)
    target, why = day_target(db, employee, day)
    if total > MAX_DAY_HOURS:
        raise TimesheetError(f"{day}: {total:g} h logged - a day can't have more than 24 h.")
    if why == "leave":
        raise TimesheetError(f"{day}: you are on approved leave, so there is nothing to submit.")
    if why == "half-day leave" and total > HALF_DAY_MAX_HOURS:
        raise TimesheetError(f"{day}: half-day leave - at most {HALF_DAY_MAX_HOURS:g} h can be logged.")
    if total <= 0:
        raise TimesheetError("Log your time for the day before submitting.")
    if total < target:
        raise TimesheetError(f"Log at least {target:g} h to submit ({target - total:g} h to go).")
    return total
