"""Timesheet rules.

- Weeks start on Monday. Entries can be added, changed or removed while the week is draft or rejected.
- Submitting checks: at least one entry, at most 24 h per day, nothing logged on a day of approved full-day leave,
  and at most 4.5 h on a day of approved half-day leave (work-from-home "leave" is a working day).
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Employee, LeaveRequest, TimesheetEntry, TimesheetWeek
from app.services.leave import WORKING_LEAVE

EDITABLE = ("draft", "rejected")
MAX_DAY_HOURS = 24.0
HALF_DAY_MAX_HOURS = 4.5


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
    return list(db.scalars(select(TimesheetEntry).where(TimesheetEntry.week_id == week.id).order_by(TimesheetEntry.work_date)))


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
