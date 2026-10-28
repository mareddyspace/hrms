"""Compensation rules (same as the portal: src/data/rewardLocal.ts, src/pages/RewardModules.tsx).

Pay visibility (highly restricted):
- everyone sees their own pay
- HR roles and the "compensation" role see pay of the people in their data scope
- anyone else (managers, admin, executives) sees NO pay unless access_scopes.comp_access is set for their account;
  then they see the pay of people they can view (their reporting line, or their scope for global roles)
- the approvers of a pay proposal see the amounts on that proposal while deciding it
Every read of someone else's pay writes an audit entry (action "pay_viewed", "viewed pay").

Proposals: a manager for people below them in the line; HR for anyone in scope but themselves. The current pay comes
from the history (latest record effective on or before today). Approval type "compensation": HR -> finance/admin
(any one) -> an executive when the increase is 10% or more. On approval a new compensation record is written, effective
on the cycle's effective date (and the proposed bonus is recorded as accrued).
"""

from __future__ import annotations

import uuid
from datetime import date
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import utcnow
from app.deps import CurrentUser
from app.models import (
    AccessScope,
    ApprovalDecision,
    ApprovalInstance,
    CompBonus,
    CompensationRecord,
    CompProposal,
    CompReviewCycle,
    Employee,
)
from app.services import approvals as engine
from app.services.activity import record_audit
from app.services.decisions import can_view
from app.services.scope import HR_ROLES

PAY_ROLES = HR_ROLES | {"compensation"}
EXEC_THRESHOLD_PCT = 10
COMP_WORKFLOW: list[dict[str, Any]] = [
    {"roles": ["hr"], "mode": "any", "min_amount": None},
    {"roles": ["finance", "admin"], "mode": "any", "min_amount": None},
    {"roles": ["executive"], "mode": "any", "min_amount": EXEC_THRESHOLD_PCT},
]
NO_PAY_ACCESS = "You don't have access to pay information."


def ensure_workflow(db: Session) -> None:
    if engine.latest_definition(db, "compensation") is None:
        engine.save_definition(db, "compensation", COMP_WORKFLOW, None)


def is_pay_role(user: CurrentUser) -> bool:
    return user.account.role in PAY_ROLES


def has_comp_flag(db: Session, user: CurrentUser) -> bool:
    row = db.get(AccessScope, user.id)
    return bool(row is not None and row.comp_access)


def can_view_pay(db: Session, user: CurrentUser, emp: Employee) -> bool:
    if emp.id == user.employee_id:
        return True
    if is_pay_role(user) and user.scope.can_see(emp):
        return True
    return has_comp_flag(db, user) and can_view(db, user, emp)


def require_pay_view(db: Session, user: CurrentUser, employee_id: str | None) -> Employee:
    """The person whose pay is asked for, if the caller may see it (404 when they can't see the person at all)."""
    emp = user.employee if not employee_id or employee_id == user.employee_id else db.get(Employee, employee_id)
    if emp is None:
        raise HTTPException(404, "Not found.")
    if can_view_pay(db, user, emp):
        return emp
    if can_view(db, user, emp):
        raise HTTPException(403, NO_PAY_ACCESS)
    raise HTTPException(404, "Not found.")


def can_manage_pay(user: CurrentUser, emp: Employee) -> bool:
    """HR / compensation roles change pay of people in scope, never their own."""
    return is_pay_role(user) and user.scope.can_see(emp) and emp.id != user.employee_id


def log_pay_view(db: Session, user: CurrentUser, emp_id: str, what: str, ip: str | None, entity_id: str | None = None) -> None:
    if emp_id == user.employee_id:
        return
    record_audit(db, actor_id=user.id, action="pay_viewed", entity="compensation", entity_id=entity_id or emp_id,
                 subject_id=emp_id, after={"viewed": "viewed pay", "what": what}, ip=ip)


def current_record(db: Session, employee_id: str, on: date) -> CompensationRecord | None:
    return db.scalar(
        select(CompensationRecord).where(CompensationRecord.employee_id == employee_id, CompensationRecord.effective_date <= on)
        .order_by(CompensationRecord.effective_date.desc())
    )


def history(db: Session, employee_id: str) -> list[CompensationRecord]:
    return list(db.scalars(select(CompensationRecord).where(CompensationRecord.employee_id == employee_id)
                           .order_by(CompensationRecord.effective_date.desc())))


def cycle_open_on(cycle: CompReviewCycle, today: date) -> bool:
    return cycle.status == "open" and cycle.opens_on <= today <= cycle.closes_on


def is_approver(instance: ApprovalInstance | None, employee_id: str | None) -> bool:
    return bool(instance and employee_id and any(employee_id in ids for s in instance.steps for ids in s["groups"].values()))


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def _last_decider(db: Session, instance: ApprovalInstance) -> str | None:
    return db.scalar(select(ApprovalDecision.approver_id).where(ApprovalDecision.instance_id == instance.id)
                     .order_by(ApprovalDecision.id.desc())) or instance.requester_id


@engine.on_finish("compensation")
def _proposal_finished(db: Session, instance: ApprovalInstance) -> None:
    proposal = db.get(CompProposal, instance.entity_id)
    if proposal is None or proposal.status != "pending" or instance.status not in ("approved", "rejected"):
        return
    decider = _last_decider(db, instance)
    proposal.status = instance.status
    proposal.decided_at = utcnow()
    after: dict[str, Any] = {"status": proposal.status}
    if instance.status == "approved":
        cycle = db.get(CompReviewCycle, proposal.cycle_id)
        effective = cycle.effective_date if cycle else date.today()
        existing = db.scalar(select(CompensationRecord).where(CompensationRecord.employee_id == proposal.employee_id,
                                                              CompensationRecord.effective_date == effective))
        record = existing or CompensationRecord(id=new_id("comp"), employee_id=proposal.employee_id, effective_date=effective)
        record.base_salary, record.currency, record.grade = proposal.proposed_base, proposal.currency, proposal.proposed_grade
        record.reason = (cycle.name if cycle else "Compensation review")[:200]
        record.proposal_id, record.created_by = proposal.id, decider
        if existing is None:
            db.add(record)
        proposal.record_id = record.id
        after |= {"record_id": record.id, "effective_date": effective}
        record_audit(db, actor_id=decider, action="comp_record_created", entity="compensation_record", entity_id=record.id,
                     subject_id=proposal.employee_id, after={"effective_date": effective, "base_salary": record.base_salary,
                                                             "currency": record.currency, "grade": record.grade,
                                                             "proposal_id": proposal.id})
        if proposal.bonus_amount:
            bonus = CompBonus(id=new_id("bonus"), employee_id=proposal.employee_id, bonus_type="Annual incentive",
                              period=(cycle.name.split(" ")[0] if cycle else str(effective.year))[:32],
                              amount=proposal.bonus_amount, currency=proposal.currency, status="accrued",
                              proposal_id=proposal.id, created_by=decider)
            db.add(bonus)
    record_audit(db, actor_id=decider, action=f"comp_proposal_{instance.status}", entity="comp_proposal", entity_id=proposal.id,
                 subject_id=proposal.employee_id, before={"status": "pending"}, after=after)
    # The engine already tells the proposer (the approval requester) the outcome.
