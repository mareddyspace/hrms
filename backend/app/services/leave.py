"""Leave rules, kept in line with the front end (src/model.ts: workingDays, leaveRows, validateLeave).

- Working days skip Saturdays, Sundays and the person's country holidays; a half day counts 0.5.
- Quota per calendar year; "monthly" accrual earns quota/12 per month (rounded down to 0.5) in the current year.
- Carry-forward: up to carry_forward_max of last year's unused days.
- left = quota - used (approved); pending is shown separately; a new request must fit in left - pending.
- Eligibility (gender, service, employment type, probation, max per request, notice): app/services/leave_rules.py.
  Types for the other gender are hidden; other ineligible types stay in balances with eligible = False.
- Holidays: the country's common ones (calendar NULL) plus those of the person's holiday_calendar.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.models import Employee, Holiday, LeavePolicy, LeaveRequest, LeaveType
from app.services import leave_rules as eligibility

WEEKLY_OFF = {5, 6}  # Python weekday(): Saturday, Sunday
WORKING_LEAVE = {"wfh", "emergency_wfh"}  # no half days
SICK_LEAVE_GRACE_DAYS = 7
OPEN_STATUSES = ("pending", "approved")


class LeaveError(ValueError):
    """A rule was broken; the message is safe to show the user."""


def today_for(employee: Employee) -> date:
    try:
        return datetime.now(ZoneInfo(employee.time_zone)).date()
    except Exception:  # unknown zone name
        return datetime.now(ZoneInfo("UTC")).date()


def holiday_dates(db: Session, country_code: str, start: date, end: date, calendar: str | None = None) -> set[date]:
    """Active holidays in the country: common ones (no calendar) plus those of `calendar` when given."""
    in_calendar = Holiday.calendar.is_(None) if not calendar else or_(Holiday.calendar.is_(None), Holiday.calendar == calendar)
    rows = db.scalars(
        select(Holiday.date).where(Holiday.country_code == country_code, Holiday.date >= start, Holiday.date <= end,
                                   Holiday.active.is_(True), in_calendar)
    )
    return set(rows)


def holiday_dates_for(db: Session, employee: Employee, start: date, end: date) -> set[date]:
    return holiday_dates(db, employee.country_code, start, end, employee.holiday_calendar)


def working_days(start: date, end: date, holidays: set[date], half: str = "none") -> float:
    if end < start:
        return 0
    if half in ("first", "second") and start == end:
        return 0 if start.weekday() in WEEKLY_OFF or start in holidays else 0.5
    count = 0
    day = start
    while day <= end:
        if day.weekday() not in WEEKLY_OFF and day not in holidays:
            count += 1
        day += timedelta(days=1)
    return float(count)


def accrued_quota(quota: float, year: int, today: date) -> float:
    if year < today.year:
        return quota
    if year > today.year:
        return math.floor((quota / 12) * 2) / 2
    return math.floor(((quota * today.month) / 12) * 2) / 2


def policies_for(db: Session, country_code: str, on: date) -> list[tuple[LeavePolicy, LeaveType]]:
    stmt = (
        select(LeavePolicy, LeaveType)
        .join(LeaveType, LeaveType.code == LeavePolicy.leave_code)
        .where(
            LeavePolicy.country_code == country_code,
            LeaveType.active.is_(True),
            LeavePolicy.active.is_(True),
            LeavePolicy.effective_from <= on,
            or_(LeavePolicy.effective_to.is_(None), LeavePolicy.effective_to >= on),
        )
        .order_by(LeavePolicy.leave_code)
    )
    return [(p, t) for p, t in db.execute(stmt).all()]


@dataclass
class BalanceRow:
    code: str
    name: str
    quota: float
    carried_over: float
    used: float
    pending: float
    left: float
    available: float
    accrual: str
    eligible: bool = True
    not_eligible_reason: str | None = None


def _used_and_pending(db: Session, employee_id: str, code: str, year: int) -> tuple[float, float]:
    rows = db.execute(
        select(LeaveRequest.status, LeaveRequest.days).where(
            LeaveRequest.employee_id == employee_id,
            LeaveRequest.leave_code == code,
            LeaveRequest.from_date >= date(year, 1, 1),
            LeaveRequest.from_date <= date(year, 12, 31),
            LeaveRequest.status.in_(OPEN_STATUSES),
        )
    ).all()
    used = sum(float(d) for s, d in rows if s == "approved")
    pending = sum(float(d) for s, d in rows if s == "pending")
    return used, pending


def balances(db: Session, employee: Employee, year: int | None = None) -> list[BalanceRow]:
    today = today_for(employee)
    year = year or today.year
    rows: list[BalanceRow] = []
    on = date(year, 12, 31) if year < today.year else max(today, date(year, 1, 1))
    for policy, _type in policies_for(db, employee.country_code, on):
        if eligibility.hidden_for(policy, employee):
            continue
        quota = float(policy.quota)
        yearly = accrued_quota(quota, year, today) if policy.accrual == "monthly" else quota
        carried = 0.0
        if policy.carry_forward_max:
            saved = eligibility.saved_carry(db, employee.id, policy.leave_code, year)  # year-end job, when it has run
            if saved is not None:
                carried = saved
            else:
                last_used, _ = _used_and_pending(db, employee.id, policy.leave_code, year - 1)
                carried = min(float(policy.carry_forward_max), max(0.0, quota - last_used))
        total = yearly + carried
        used, pending = _used_and_pending(db, employee.id, policy.leave_code, year)
        if total <= 0 and used == 0 and pending == 0 and policy.leave_code != "comp_off":
            continue  # not offered in this country
        if policy.leave_code == "comp_off":
            # Earned comp-off days aren't tracked yet, so days already taken count as earned; never below zero.
            total = max(total, used + pending)
        left = total - used
        reason = eligibility.ineligible_reason(db, employee, policy, on)
        rows.append(
            BalanceRow(
                code=policy.leave_code,
                name=policy.name,
                quota=total,
                carried_over=carried,
                used=used,
                pending=pending,
                left=left,
                available=left - pending,
                accrual=policy.accrual,
                eligible=reason is None,
                not_eligible_reason=reason,
            )
        )
    return rows


def validate_new_request(
    db: Session, employee: Employee, code: str, start: date, end: date, half: str, reason: str
) -> float:
    """Return the number of days, or raise LeaveError."""
    today = today_for(employee)
    if not reason.strip():
        raise LeaveError("Enter a reason.")
    if end < start:
        raise LeaveError("The end date is before the start date.")
    if start.year != end.year:
        raise LeaveError("Leave can't cross into the next year - split it into two requests.")
    if half not in ("none", "first", "second"):
        raise LeaveError("Choose first half or second half.")
    if half != "none":
        if start != end:
            raise LeaveError("A half day must start and end on the same date.")
        if code in WORKING_LEAVE:
            raise LeaveError("Work from home can't be taken as a half day.")
    if code == "sick" and start > today:
        raise LeaveError("Sick leave can't be booked in advance.")
    if start < today and not (code == "sick" and start >= today - timedelta(days=SICK_LEAVE_GRACE_DAYS)):
        raise LeaveError("Leave for past dates needs approval from your manager first.")

    days = working_days(start, end, holiday_dates_for(db, employee, start, end), half)
    if days <= 0:
        raise LeaveError("That range has no working days (weekends and holidays are skipped).")

    found = next(((p, t) for p, t in policies_for(db, employee.country_code, start) if p.leave_code == code), None)
    if found is not None:
        policy, leave_type = found
        if half != "none" and not leave_type.half_day_allowed:
            raise LeaveError(f"{policy.name} can't be taken as a half day.")
        problem = eligibility.check_request(db, employee, policy, start, days, today)
        if problem:
            raise LeaveError(problem)

    row = next((r for r in balances(db, employee, start.year) if r.code == code), None)
    if row is None:
        raise LeaveError("Choose a leave type.")
    if days > row.available:
        raise LeaveError(f"Only {row.available:g} day(s) available for {row.name}.")

    overlapping = db.scalars(
        select(LeaveRequest).where(
            LeaveRequest.employee_id == employee.id,
            LeaveRequest.status.in_(OPEN_STATUSES),
            and_(LeaveRequest.from_date <= end, LeaveRequest.to_date >= start),
        )
    ).all()
    for other in overlapping:
        # Two different halves of the same single day don't clash.
        same_day_other_half = (
            other.half != "none" and half != "none" and other.half != half and other.from_date == other.to_date == start == end
        )
        if not same_day_other_half:
            raise LeaveError("Those dates overlap an existing leave request.")
    return days
