"""Overtime and comp-off (migration 0023), approval type "overtime" (the manager).

Rules per country are kept in step with src/features/overtime/rules.ts (one table there, one here):
- a past date only, at most MAX_DAYS_BACK days ago; 0.5 to max_hours hours; one request per person and date;
- paid: hourly rate = annual pay / (weekly hours x 52), times the multiplier (1.5); paid with the payroll run of
  the work month (the next month when that run is already in review or locked);
- comp-off: one day per standard day of overtime, in half days (at least half a day); adds to the comp-off balance.
Annual pay: the current compensation record in the country's currency, else the country's standard package for the
role (src/countryPay.ts earnings x payScaleFor).
"""

from __future__ import annotations

import math
import uuid
from datetime import date, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import utcnow
from app.models import ApprovalInstance, AttendanceSession, CompensationRecord, Employee, OvertimeRequest, PayrollRun
from app.services import approvals as engine
from app.services import workflow_defaults
from app.services.activity import notify, record_audit
from app.services.leave import today_for
from app.services.self_service import ROLE_SCALE, RequestError, role_of

OVERTIME = "overtime"
PENDING = ("Submitted",)
MAX_DAYS_BACK = 30
OUTCOMES = ("pay", "comp_off")

# Standard monthly package by country (sum of src/countryPay.ts earnings at scale 1).
STANDARD_MONTHLY = {"IN": 54800, "US": 7000, "GB": 4500, "AU": 8500, "CA": 7500, "AE": 27000, "SA": 20250, "DE": 5200}

# weekly_hours: the normal week (hourly rate = annual / (weekly_hours * 52)); day_hours: one comp-off day.
RULES: dict[str, dict[str, Any]] = {
    "IN": {"weekly_hours": 48, "day_hours": 8, "multiplier": 1.5, "max_hours": 12, "comp_off": True},
    "US": {"weekly_hours": 40, "day_hours": 8, "multiplier": 1.5, "max_hours": 12, "comp_off": False},
    "GB": {"weekly_hours": 40, "day_hours": 8, "multiplier": 1.5, "max_hours": 12, "comp_off": True},
    "AU": {"weekly_hours": 38, "day_hours": 7.6, "multiplier": 1.5, "max_hours": 12, "comp_off": True},
    "CA": {"weekly_hours": 40, "day_hours": 8, "multiplier": 1.5, "max_hours": 12, "comp_off": True},
    "AE": {"weekly_hours": 48, "day_hours": 8, "multiplier": 1.5, "max_hours": 10, "comp_off": True},
    "SA": {"weekly_hours": 48, "day_hours": 8, "multiplier": 1.5, "max_hours": 12, "comp_off": True},
    "DE": {"weekly_hours": 40, "day_hours": 8, "multiplier": 1.5, "max_hours": 10, "comp_off": True},
}

workflow_defaults.DEFAULT_WORKFLOWS.setdefault(
    OVERTIME, [{"roles": ["manager"], "mode": "any", "min_amount": None, "label": "Manager"}])
workflow_defaults.WORKFLOW_LABELS.setdefault(OVERTIME, "Overtime")


def rules_for(country: str | None) -> dict[str, Any]:
    return RULES.get(country or "IN", RULES["IN"])


def annual_pay(db: Session, emp: Employee, on: date) -> float:
    rec = db.scalar(select(CompensationRecord).where(CompensationRecord.employee_id == emp.id,
                                                     CompensationRecord.effective_date <= on)
                    .order_by(CompensationRecord.effective_date.desc()).limit(1))
    if rec is not None and rec.base_salary and rec.currency == emp.currency:
        return float(rec.base_salary)
    monthly = STANDARD_MONTHLY.get(emp.country_code, STANDARD_MONTHLY["IN"])
    return monthly * ROLE_SCALE.get(role_of(db, emp), 1.15) * 12


def hourly_rate(db: Session, emp: Employee, on: date) -> float:
    return round(annual_pay(db, emp, on) / (rules_for(emp.country_code)["weekly_hours"] * 52), 2)


def comp_off_days(hours: float, country: str | None) -> float:
    half = rules_for(country)["day_hours"] / 2
    return math.floor(hours / half + 1e-9) * 0.5


def attendance_minutes(db: Session, employee_id: str, day: date) -> int | None:
    row = db.scalar(select(AttendanceSession).where(AttendanceSession.employee_id == employee_id,
                                                    AttendanceSession.work_date == day))
    if row is None:
        return None
    return int(row.worked_minutes or 0)


def _id() -> str:
    return f"ot-{uuid.uuid4().hex[:12]}"


def instance_of(db: Session, row: OvertimeRequest) -> ApprovalInstance | None:
    return db.get(ApprovalInstance, row.approval_instance_id) if row.approval_instance_id else None


def create(db: Session, emp: Employee, data: dict[str, Any], actor_id: str, ip: str | None) -> OvertimeRequest:
    today = today_for(emp)
    day: date = data["work_date"]
    hours = float(data["hours"])
    outcome = data.get("outcome") or "pay"
    rules = rules_for(emp.country_code)
    if day >= today:
        raise RequestError("Choose a past date.")
    if day < today - timedelta(days=MAX_DAYS_BACK):
        raise RequestError(f"Overtime can be claimed up to {MAX_DAYS_BACK} days back.")
    if hours < 0.5 or hours > rules["max_hours"]:
        raise RequestError(f"Enter 0.5 to {rules['max_hours']:g} hours.")
    if round(hours * 2) != hours * 2:
        raise RequestError("Use half hours, e.g. 2 or 2.5.")
    if outcome not in OUTCOMES:
        raise RequestError("Choose paid or comp-off.")
    if outcome == "comp_off" and not rules["comp_off"]:
        raise RequestError("Comp-off isn't offered in your country; overtime is paid.")
    days = comp_off_days(hours, emp.country_code) if outcome == "comp_off" else 0.0
    if outcome == "comp_off" and days <= 0:
        raise RequestError(f"Comp-off needs at least {rules['day_hours'] / 2:g} hours.")
    reason = (data.get("reason") or "").strip()
    if not reason:
        raise RequestError("Enter a reason.")
    taken = db.scalar(select(func.count()).select_from(OvertimeRequest).where(
        OvertimeRequest.employee_id == emp.id, OvertimeRequest.work_date == day,
        OvertimeRequest.status.in_(("Submitted", "Approved"))))
    if taken:
        raise RequestError("You already have overtime for that date.")
    rate = hourly_rate(db, emp, day)
    row = OvertimeRequest(
        id=_id(), employee_id=emp.id, work_date=day, hours=hours, reason=reason[:1000], outcome=outcome,
        status="Submitted", attendance_minutes=attendance_minutes(db, emp.id, day), hourly_rate=rate,
        multiplier=rules["multiplier"], amount=round(hours * rate * rules["multiplier"]) if outcome == "pay" else 0.0,
        currency=emp.currency, comp_off_days=days,
    )
    db.add(row)
    db.flush()
    record_audit(db, actor_id=actor_id, action="overtime_submitted", entity="overtime_requests", entity_id=row.id,
                 subject_id=emp.id, after={"work_date": day, "hours": hours, "outcome": outcome}, ip=ip)
    workflow_defaults.ensure_default(db, OVERTIME)
    try:
        instance = engine.start(db, OVERTIME, row.id, emp, None, actor_id=actor_id)
    except engine.ApprovalError as exc:
        raise RequestError(str(exc)) from exc
    row.approval_instance_id = instance.id
    return row


def withdraw(db: Session, row: OvertimeRequest, actor: Employee, actor_id: str, ip: str | None) -> None:
    if row.status not in PENDING:
        raise RequestError(f"This request is already {row.status.lower()}; it can only be withdrawn while waiting.")
    instance = instance_of(db, row)
    workflow_defaults.notify_withdrawn(db, instance, actor.full_name, "overtime request", "/overtime")
    if instance is not None and instance.status == "pending":
        engine.cancel(db, instance, actor_id=actor_id, ip=ip)
    row.status = "Withdrawn"
    record_audit(db, actor_id=actor_id, action="overtime_withdrawn", entity="overtime_requests", entity_id=row.id,
                 subject_id=row.employee_id, after={"status": "Withdrawn"}, ip=ip)


def payout_month_for(db: Session, emp: Employee, work_date: date) -> str:
    """The work month, or the first later month whose payroll run isn't in review or locked yet."""
    month = date(work_date.year, work_date.month, 1)
    for _ in range(24):
        key = f"{month:%Y-%m}"
        closed = db.scalar(select(PayrollRun.id).where(
            PayrollRun.month == key, PayrollRun.country_code == emp.country_code,
            PayrollRun.legal_entity == emp.legal_entity, PayrollRun.status.in_(("review", "locked"))))
        if not closed:
            return key
        month = date(month.year + (month.month == 12), month.month % 12 + 1, 1)
    return f"{month:%Y-%m}"


@engine.on_finish(OVERTIME)
def _finished(db: Session, instance: ApprovalInstance) -> None:
    row = db.get(OvertimeRequest, instance.entity_id)
    if row is None or row.status not in PENDING:
        return
    emp = db.get(Employee, row.employee_id)
    approved = instance.status == "approved"
    row.status = "Approved" if approved else "Rejected"
    row.decided_at = utcnow()
    from app.models import ApprovalDecision

    row.decided_by = db.scalar(select(ApprovalDecision.approver_id).where(ApprovalDecision.instance_id == instance.id)
                               .order_by(ApprovalDecision.id.desc()))
    if approved and row.outcome == "pay" and emp is not None:
        row.payout_month = payout_month_for(db, emp, row.work_date)
    record_audit(db, actor_id=row.decided_by or instance.requester_id, action=f"overtime_{row.status.lower()}",
                 entity="overtime_requests", entity_id=row.id, subject_id=row.employee_id,
                 after={"status": row.status, "payout_month": row.payout_month})
    if approved:
        body = (f"{row.comp_off_days:g} comp-off day(s) added to your leave balance." if row.outcome == "comp_off"
                else f"Paid with {date.fromisoformat(row.payout_month + '-01'):%B %Y} pay." if row.payout_month
                else "Paid with a coming month's pay.")
    else:
        body = "Open it to see the note."
    notify(db, recipient_id=row.employee_id, title=f"Overtime {row.status.lower()}", body=body, href="/overtime")


def earned_comp_off(db: Session, employee_id: str, year: int) -> float:
    """Approved comp-off days from overtime worked in the year (added to the comp_off balance)."""
    total = db.scalar(select(func.sum(OvertimeRequest.comp_off_days)).where(
        OvertimeRequest.employee_id == employee_id, OvertimeRequest.status == "Approved",
        OvertimeRequest.outcome == "comp_off", OvertimeRequest.work_date >= date(year, 1, 1),
        OvertimeRequest.work_date <= date(year, 12, 31)))
    return float(total or 0)


def comp_off_credit(db: Session, employee_id: str, year: int) -> tuple[float, float]:
    """(earned, taken before any earning): comp-off days from approved overtime in the year, and comp-off leave taken
    before the first of them (from before earnings were tracked; counted as earned so the balance never goes negative)."""
    from app.models import LeaveRequest

    first = db.scalar(select(func.min(OvertimeRequest.work_date)).where(
        OvertimeRequest.employee_id == employee_id, OvertimeRequest.status == "Approved",
        OvertimeRequest.outcome == "comp_off", OvertimeRequest.work_date >= date(year, 1, 1),
        OvertimeRequest.work_date <= date(year, 12, 31)))
    stmt = select(func.sum(LeaveRequest.days)).where(
        LeaveRequest.employee_id == employee_id, LeaveRequest.leave_code == "comp_off",
        LeaveRequest.status.in_(("pending", "approved")), LeaveRequest.from_date >= date(year, 1, 1),
        LeaveRequest.from_date <= date(year, 12, 31))
    if first is not None:
        stmt = stmt.where(LeaveRequest.from_date < first)
    return earned_comp_off(db, employee_id, year), float(db.scalar(stmt) or 0)


def payable(db: Session, employee_ids: list[str], month: str) -> dict[str, list[OvertimeRequest]]:
    """Approved paid overtime due by this month and not paid by a locked run yet, per person."""
    out: dict[str, list[OvertimeRequest]] = {}
    if not employee_ids:
        return out
    for row in db.scalars(select(OvertimeRequest).where(
            OvertimeRequest.employee_id.in_(employee_ids), OvertimeRequest.status == "Approved",
            OvertimeRequest.outcome == "pay", OvertimeRequest.payout_month <= month,
            OvertimeRequest.paid_run_id.is_(None)).order_by(OvertimeRequest.work_date)):
        out.setdefault(row.employee_id, []).append(row)
    return out


def summary_for(db: Session, inst: ApprovalInstance) -> str | None:
    if inst.type == OVERTIME and (row := db.get(OvertimeRequest, inst.entity_id)):
        how = f"comp-off {row.comp_off_days:g} day(s)" if row.outcome == "comp_off" else "paid"
        return f"Overtime {row.hours:g} h on {row.work_date:%d %b %Y}, {how}"
    return None


engine.NOTICE_LABELS.update({OVERTIME: "Overtime request"})
engine.OWN_FINISH_NOTICE.update({OVERTIME})
engine.ENTITY_HREFS.update({OVERTIME: "/overtime"})
