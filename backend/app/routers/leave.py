from __future__ import annotations

import uuid
from datetime import date
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import or_, select

from app.db import utcnow
from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import Employee, Holiday, LeaveRequest
from app.schemas import (
    HolidayOut,
    LeaveDecisionIn,
    LeavePolicyOut,
    LeaveRequestIn,
    LeaveRequestOut,
)
from app.schemas.leave_rules import LeaveBalanceRuleOut, LeaveBalancesRuleOut
from app.services import leave as rules
from app.services import leave_rules as eligibility
from app.services import time_approvals as chain
from app.services.activity import notify, record_audit
from app.services.scope import manager_chain_ids

router = APIRouter(prefix="/leave", tags=["leave"])

NOT_FOUND = HTTPException(404, "Not found.")


def _me(user: CurrentUser) -> Employee:
    if user.employee is None:
        raise HTTPException(400, "This account is not linked to an employee record.")
    return user.employee


def _target(db: DbSession, user: CurrentUser, employee_id: str | None) -> Employee:
    """The caller, or someone in the caller's data scope (404 otherwise)."""
    if not employee_id or employee_id == user.employee_id:
        return _me(user)
    emp = db.get(Employee, employee_id)
    if emp is None or not user.scope.can_see(emp):
        raise NOT_FOUND
    return emp


def _snapshot(r: LeaveRequest) -> dict:
    return {
        "status": r.status,
        "leave_code": r.leave_code,
        "from": r.from_date,
        "to": r.to_date,
        "half": r.half,
        "days": r.days,
        "decided_by": r.decided_by,
        "decision_note": r.decision_note,
    }


def _out(r: LeaveRequest, name: str | None, approval: dict | None = None) -> LeaveRequestOut:
    out = LeaveRequestOut.model_validate(r)
    out.employee_name = name
    out.approval = approval
    return out


def _out_one(db: DbSession, user: CurrentUser, r: LeaveRequest, name: str | None) -> LeaveRequestOut:
    return _out(r, name, chain.progress_map(db, chain.LEAVE, [r.id], user.employee_id).get(r.id))


@router.get("/policies", response_model=list[LeavePolicyOut])
def list_policies(db: DbSession, user: CurrentUserDep, employee_id: str | None = None) -> list[LeavePolicyOut]:
    emp = _target(db, user, employee_id)
    return [
        LeavePolicyOut(
            code=p.leave_code,
            name=p.name,
            country_code=p.country_code,
            quota=p.quota,
            carry_forward_max=p.carry_forward_max or 0,
            accrual=p.accrual,
            half_day_allowed=t.half_day_allowed,
            effective_from=p.effective_from,
            effective_to=p.effective_to,
        )
        for p, t in rules.policies_for(db, emp.country_code, rules.today_for(emp))
        if (p.quota > 0 or p.leave_code == "comp_off") and not eligibility.hidden_for(p, emp)
    ]


@router.get("/holidays", response_model=list[HolidayOut])
def list_holidays(db: DbSession, user: CurrentUserDep,
                  year: Annotated[int | None, Query(ge=2000, le=2100)] = None) -> list[Holiday]:
    emp = _me(user)
    year = year or rules.today_for(emp).year
    return list(
        db.scalars(
            select(Holiday)
            .where(Holiday.country_code == emp.country_code, Holiday.date >= date(year, 1, 1), Holiday.date <= date(year, 12, 31),
                   Holiday.active.is_(True),
                   or_(Holiday.calendar.is_(None), Holiday.calendar == (emp.holiday_calendar or "")))
            .order_by(Holiday.date)
        )
    )


@router.get("/balances", response_model=LeaveBalancesRuleOut)
def get_balances(
    db: DbSession, user: CurrentUserDep, employee_id: str | None = None, year: Annotated[int | None, Query(ge=2000, le=2100)] = None
) -> LeaveBalancesRuleOut:
    emp = _target(db, user, employee_id)
    year = year or rules.today_for(emp).year
    rows = rules.balances(db, emp, year)
    return LeaveBalancesRuleOut(employee_id=emp.id, year=year, balances=[LeaveBalanceRuleOut(**vars(r)) for r in rows])


@router.get("/requests", response_model=list[LeaveRequestOut])
def list_requests(
    db: DbSession,
    user: CurrentUserDep,
    view: Annotated[str, Query(pattern="^(mine|team|all)$")] = "mine",
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    employee_id: str | None = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
) -> list[LeaveRequestOut]:
    stmt = select(LeaveRequest, Employee.full_name).join(Employee, Employee.id == LeaveRequest.employee_id)
    if view == "mine":
        stmt = stmt.where(LeaveRequest.employee_id == (user.employee_id or ""))
    elif view == "team":
        stmt = stmt.where(LeaveRequest.employee_id.in_(user.scope.reports or {""}))
    else:
        stmt = stmt.where(user.scope.employee_filter())
    if employee_id:
        stmt = stmt.where(LeaveRequest.employee_id == employee_id)
    if status_filter:
        stmt = stmt.where(LeaveRequest.status == status_filter)
    rows = db.execute(stmt.order_by(LeaveRequest.created_at.desc()).limit(limit)).all()
    approvals = chain.progress_map(db, chain.LEAVE, [r.id for r, _ in rows], user.employee_id)
    return [_out(r, name, approvals.get(r.id)) for r, name in rows]


@router.post("/requests", response_model=LeaveRequestOut, status_code=status.HTTP_201_CREATED)
def apply_leave(body: LeaveRequestIn, request: Request, db: DbSession, user: CurrentUserDep) -> LeaveRequestOut:
    emp = _me(user)
    try:
        days = rules.validate_new_request(db, emp, body.leave_code, body.from_date, body.to_date, body.half, body.reason)
    except rules.LeaveError as exc:
        raise HTTPException(422, str(exc)) from exc

    item = LeaveRequest(
        id=f"lv-{uuid.uuid4().hex[:12]}",
        employee_id=emp.id,
        leave_code=body.leave_code,
        from_date=body.from_date,
        to_date=body.to_date,
        half=body.half,
        days=days,
        reason=body.reason.strip(),
        status="pending",
    )
    db.add(item)
    db.flush()
    # Approval chain "leave": manager, then HR when the leave needs it. Nobody above this person and no HR step:
    # approved straight away (same as the portal). The approvers are told by the engine.
    chain.start(db, chain.LEAVE, item.id, emp, user.id,
                {"needs_hr": chain.leave_needs_hr(db, body.leave_code, days), "leave_type": body.leave_code})
    record_audit(
        db, actor_id=user.id, action="leave_applied", entity="leave_request", entity_id=item.id,
        subject_id=emp.id, after=_snapshot(item), ip=client_ip(request),
    )
    db.commit()
    return _out_one(db, user, item, emp.full_name)


def _can_decide(db: DbSession, user: CurrentUser, emp: Employee) -> bool:
    """Line manager (or their delegate) or HR in scope; never skip-level, never your own request."""
    from app.services.decisions import can_decide

    return can_decide(db, user, emp, "leave")


@router.post("/requests/{request_id}/decision", response_model=LeaveRequestOut)
def decide(request_id: str, body: LeaveDecisionIn, request: Request, db: DbSession, user: CurrentUserDep) -> LeaveRequestOut:
    item = db.get(LeaveRequest, request_id)
    emp = db.get(Employee, item.employee_id) if item else None
    instance = chain.pending_instance(db, chain.LEAVE, item.id) if item else None
    if item is None or emp is None or not (user.scope.can_see(emp) or user.employee_id in manager_chain_ids(db, emp.id)
                                           or chain.may_follow(db, user, instance)):
        raise NOT_FOUND
    if instance is not None and item.status == "pending":
        # through the approval chain; the request is updated when the last step is decided
        chain.decide(db, user, instance, emp, body.decision, body.note, client_ip(request))
        db.commit()
        return _out_one(db, user, item, emp.full_name)
    if not _can_decide(db, user, emp):
        raise HTTPException(403, "You can't decide this request.")
    if item.status != "pending":
        raise HTTPException(409, f"This request is already {item.status}.")
    if body.decision == "reject" and not (body.note or "").strip():
        raise HTTPException(422, "Add a note saying why the request is rejected.")

    before = _snapshot(item)
    item.status = "approved" if body.decision == "approve" else "rejected"
    item.decided_by = user.employee_id
    item.decided_at = utcnow()
    item.decision_note = (body.note or "").strip() or None
    record_audit(
        db, actor_id=user.id, action=f"leave_{item.status}", entity="leave_request", entity_id=item.id,
        subject_id=emp.id, before=before, after=_snapshot(item), ip=client_ip(request),
    )
    decider = user.employee.full_name if user.employee else user.id
    notify(
        db,
        recipient_id=emp.id,
        title=f"Leave {item.status}",
        body=f"{decider} {item.status} your leave {item.from_date} to {item.to_date}."
        + (f" Note: {item.decision_note}" if item.decision_note else ""),
        href=f"/leave/requests/{item.id}",
    )
    db.commit()
    return _out(item, emp.full_name)


@router.post("/requests/{request_id}/cancel", response_model=LeaveRequestOut)
def cancel(request_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> LeaveRequestOut:
    item = db.get(LeaveRequest, request_id)
    if item is None or item.employee_id != user.employee_id:
        raise NOT_FOUND
    emp = _me(user)
    today = rules.today_for(emp)
    before = _snapshot(item)
    if item.status == "pending":
        item.status = "withdrawn"
        chain.withdraw(db, chain.LEAVE, item.id, user.id, client_ip(request))
    elif item.status == "approved" and item.from_date > today:
        item.status = "cancelled"
    else:
        raise HTTPException(409, "Only pending requests or approved leave that hasn't started can be cancelled.")
    record_audit(
        db, actor_id=user.id, action=f"leave_{item.status}", entity="leave_request", entity_id=item.id,
        subject_id=emp.id, before=before, after=_snapshot(item), ip=client_ip(request),
    )
    if emp.manager_id and before["status"] == "approved":
        notify(
            db,
            recipient_id=emp.manager_id,
            title=f"{emp.full_name} cancelled approved leave",
            body=f"{item.from_date} to {item.to_date}",
            href=f"/leave/requests/{item.id}",
        )
    db.commit()
    return _out(item, emp.full_name)
