"""Lifecycle actions (transfer, promotion, ...) and the effective-dated assignment history.

Raise an action: HR/admin for anyone in their scope, or anyone above the person in the reporting line.
Employees may raise a leave of absence / return from leave for themselves. Never decide what you raised.
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import or_, select
from sqlalchemy.orm import aliased

from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import ApprovalInstance, Employee, EmployeeAssignment, LifecycleAction
from app.schemas import ApplyDueOut, AssignmentOut, DecisionIn, LifecycleActionIn, LifecycleActionOut
from app.services import approvals as engine
from app.services import lifecycle as rules
from app.services.activity import record_audit
from app.services.decisions import NOT_FOUND, can_view, me
from app.services.scope import manager_chain_ids
from app.services.workflow_defaults import decide_http, ensure_default, is_approver, notify_withdrawn, waiting_entity_ids

router = APIRouter(prefix="/lifecycle", tags=["lifecycle"])
history_router = APIRouter(prefix="/people", tags=["people"])


def _is_hr_or_admin(user: CurrentUser) -> bool:
    return user.scope.is_hr or user.account.role == "admin"


def _can_raise(db: DbSession, user: CurrentUser, emp: Employee, action_type: str) -> bool:
    if not user.employee_id:
        return False
    if emp.id == user.employee_id:
        return rules.SPECS[action_type].self_service
    if _is_hr_or_admin(user) and user.scope.can_see(emp):
        return True
    return user.employee_id in manager_chain_ids(db, emp.id)


def _snapshot(a: LifecycleAction) -> dict:
    return {"status": a.status, "action_type": a.action_type, "effective_date": a.effective_date, "before": a.before, "after": a.after}


def _instance(db: DbSession, action: LifecycleAction) -> ApprovalInstance | None:
    return db.get(ApprovalInstance, action.approval_instance_id) if action.approval_instance_id else None


def _outs(db: DbSession, actions: list[LifecycleAction]) -> list[LifecycleActionOut]:
    if not actions:
        return []
    names = dict(db.execute(select(Employee.id, Employee.full_name).where(Employee.id.in_({a.employee_id for a in actions}))).all())
    instances = {i.id: i for i in db.scalars(select(ApprovalInstance).where(
        ApprovalInstance.id.in_([a.approval_instance_id for a in actions if a.approval_instance_id])))}
    out = []
    for a in actions:
        item = LifecycleActionOut.model_validate(a)
        item.employee_name = names.get(a.employee_id)
        inst = instances.get(a.approval_instance_id or "")
        if inst is not None:
            item.approval_status, item.current_step = inst.status, inst.current_step
        out.append(item)
    return out


def _visible(db: DbSession, user: CurrentUser, action_id: str) -> tuple[LifecycleAction, Employee]:
    action = db.get(LifecycleAction, action_id)
    emp = db.get(Employee, action.employee_id) if action else None
    if action is None or emp is None:
        raise NOT_FOUND
    if not (action.requested_by == user.employee_id or can_view(db, user, emp)
            or is_approver(_instance(db, action), user.employee_id)):
        raise NOT_FOUND
    return action, emp


@router.get("/actions", response_model=list[LifecycleActionOut])
def list_actions(
    db: DbSession,
    user: CurrentUserDep,
    view: Annotated[str, Query(pattern="^(mine|to_decide|all)$", description="mine = about me or raised by me")] = "mine",
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    employee_id: str | None = None,
    action_type: str | None = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
) -> list[LifecycleActionOut]:
    stmt = select(LifecycleAction).join(Employee, Employee.id == LifecycleAction.employee_id)
    me_id = user.employee_id or ""
    if view == "mine":
        stmt = stmt.where(or_(LifecycleAction.employee_id == me_id, LifecycleAction.requested_by == me_id))
    elif view == "to_decide":
        stmt = stmt.where(LifecycleAction.id.in_(waiting_entity_ids(db, "lifecycle", user.employee_id) or [""]))
    else:
        stmt = stmt.where(user.scope.employee_filter())
    if employee_id:
        stmt = stmt.where(LifecycleAction.employee_id == employee_id)
    if status_filter:
        stmt = stmt.where(LifecycleAction.status == status_filter)
    if action_type:
        stmt = stmt.where(LifecycleAction.action_type == action_type)
    return _outs(db, list(db.scalars(stmt.order_by(LifecycleAction.created_at.desc()).limit(limit))))


@router.post("/actions", response_model=LifecycleActionOut, status_code=status.HTTP_201_CREATED)
def create_action(body: LifecycleActionIn, request: Request, db: DbSession, user: CurrentUserDep) -> LifecycleActionOut:
    requester = me(user)
    emp = db.get(Employee, body.employee_id)
    if emp is None or not (can_view(db, user, emp) or user.scope.can_see(emp)):
        raise NOT_FOUND
    if not _can_raise(db, user, emp, body.action_type):
        raise HTTPException(403, "You can't raise this change for this person.")
    try:
        after, before = rules.validate(db, emp, body.action_type, body.effective_date, body.after)
    except rules.LifecycleError as exc:
        raise HTTPException(422, str(exc)) from exc
    clash = db.scalar(select(LifecycleAction.id).where(
        LifecycleAction.employee_id == emp.id, LifecycleAction.action_type == body.action_type,
        LifecycleAction.status.in_(rules.OPEN_STATUSES),
    ))
    if clash:
        raise HTTPException(409, f"An open {body.action_type.replace('_', ' ')} already exists for this person ({clash}).")
    action = LifecycleAction(
        id=f"lca-{uuid.uuid4().hex[:12]}", employee_id=emp.id, action_type=body.action_type,
        effective_date=body.effective_date, before=before, after=after, reason=body.reason.strip(), status="submitted",
        requested_by=requester.id,
    )
    db.add(action)
    db.flush()
    record_audit(db, actor_id=user.id, action="lifecycle_submitted", entity="lifecycle_action", entity_id=action.id,
                 subject_id=emp.id, after=_snapshot(action), ip=client_ip(request))
    ensure_default(db, "lifecycle")
    try:
        instance = engine.start(db, "lifecycle", action.id, requester, None, actor_id=user.id)
    except engine.ApprovalError as exc:
        db.rollback()
        raise HTTPException(422, str(exc)) from exc
    action.approval_instance_id = instance.id
    db.commit()
    return _outs(db, [action])[0]


@router.post("/apply-due", response_model=ApplyDueOut)
def apply_due(request: Request, db: DbSession, user: CurrentUserDep) -> ApplyDueOut:
    """Apply scheduled actions whose effective date has come (also runs when the API starts)."""
    if not _is_hr_or_admin(user):
        raise HTTPException(403, "Only HR or an administrator can run this.")
    ids = rules.apply_due_lifecycle_actions(db, actor_id=user.id)
    db.commit()
    return ApplyDueOut(applied=len(ids), ids=ids)


@router.get("/actions/{action_id}", response_model=LifecycleActionOut)
def get_action(action_id: str, db: DbSession, user: CurrentUserDep) -> LifecycleActionOut:
    return _outs(db, [_visible(db, user, action_id)[0]])[0]


@router.post("/actions/{action_id}/withdraw", response_model=LifecycleActionOut)
def withdraw_action(action_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> LifecycleActionOut:
    """The person who raised it (or HR/admin in scope) can withdraw it until it is applied."""
    action, emp = _visible(db, user, action_id)
    if not (action.requested_by == user.employee_id or (_is_hr_or_admin(user) and user.scope.can_see(emp))):
        raise HTTPException(403, "Only the person who raised this change, HR or an administrator can withdraw it.")
    if action.status not in rules.OPEN_STATUSES:
        raise HTTPException(409, f"This change is already {action.status}.")
    before = _snapshot(action)
    instance = _instance(db, action)
    who = user.employee.full_name if user.employee else user.id
    notify_withdrawn(db, instance, who, f"{action.action_type.replace('_', ' ')} for {emp.full_name}", f"/lifecycle/actions/{action.id}")
    if instance is not None and instance.status == "pending":
        engine.cancel(db, instance, actor_id=user.id, ip=client_ip(request))
    action.status = "withdrawn"
    record_audit(db, actor_id=user.id, action="lifecycle_withdrawn", entity="lifecycle_action", entity_id=action.id,
                 subject_id=emp.id, before=before, after=_snapshot(action), ip=client_ip(request))
    db.commit()
    return _outs(db, [action])[0]


@router.post("/actions/{action_id}/decision", response_model=LifecycleActionOut)
def decide_action(action_id: str, body: DecisionIn, request: Request, db: DbSession, user: CurrentUserDep) -> LifecycleActionOut:
    """Same as POST /approvals/{approval_instance_id}/decision."""
    action, _ = _visible(db, user, action_id)
    decide_http(db, _instance(db, action), user.employee_id, body.decision, body.note, user.id, client_ip(request))
    db.commit()
    return _outs(db, [action])[0]


@history_router.get("/{person_id}/history", response_model=list[AssignmentOut])
def assignment_history(person_id: str, db: DbSession, user: CurrentUserDep) -> list[AssignmentOut]:
    """Effective-dated job/org history, newest first (yourself, your reporting line, or HR/admin/executive in scope)."""
    emp = db.get(Employee, person_id)
    if emp is None or not can_view(db, user, emp):
        raise HTTPException(404, "Person not found.")
    manager = aliased(Employee)
    rows = db.execute(
        select(EmployeeAssignment, manager.full_name).outerjoin(manager, manager.id == EmployeeAssignment.manager_id)
        .where(EmployeeAssignment.employee_id == emp.id)
        .order_by(EmployeeAssignment.effective_from.desc(), EmployeeAssignment.id.desc())
    ).all()
    out = []
    for row, manager_name in rows:
        item = AssignmentOut.model_validate(row)
        item.manager_name = manager_name
        out.append(item)
    return out
