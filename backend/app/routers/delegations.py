"""Approval delegation: hand your approvals to a colleague for a date window (GET / POST / DELETE /delegations).

Everyone manages their own; HR can see the delegations of people in their scope (view=all). While a delegation is
active the delegate can decide the delegator's waiting approvals (app/services/approvals.py); the decision is
recorded "on behalf of" the delegator.
"""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import or_, select

from app.deps import CurrentUserDep, DbSession, client_ip
from app.models import ApprovalDelegation, Employee
from app.schemas.approval_chains import DELEGATION_TYPES, DelegationIn, DelegationOut
from app.services.activity import notify, record_audit
from app.services.decisions import NOT_FOUND, me
from app.services.leave import today_for

router = APIRouter(prefix="/delegations", tags=["approvals"])

MAX_DAYS = 180


def _snapshot(d: ApprovalDelegation) -> dict:
    return {"delegate_id": d.delegate_id, "from": d.starts_on, "to": d.ends_on, "types": d.types, "active": d.active}


def _outs(db: DbSession, rows: list[ApprovalDelegation]) -> list[DelegationOut]:
    ids = {r.delegator_id for r in rows} | {r.delegate_id for r in rows}
    names = dict(db.execute(select(Employee.id, Employee.full_name).where(Employee.id.in_(ids))).all()) if ids else {}
    out = []
    for r in rows:
        item = DelegationOut.model_validate(r)
        item.delegator_name, item.delegate_name = names.get(r.delegator_id), names.get(r.delegate_id)
        out.append(item)
    return out


@router.get("", response_model=list[DelegationOut])
def list_delegations(
    db: DbSession, user: CurrentUserDep,
    view: Annotated[str, Query(pattern="^(mine|all)$")] = "mine",
    include_ended: bool = False,
) -> list[DelegationOut]:
    """mine: given by me or to me. all (HR): everyone in my scope."""
    stmt = select(ApprovalDelegation)
    if view == "all":
        if not user.scope.is_hr:
            raise HTTPException(403, "Only HR can see everyone's delegations.")
    else:
        emp_id = user.employee_id or ""
        stmt = stmt.where(or_(ApprovalDelegation.delegator_id == emp_id, ApprovalDelegation.delegate_id == emp_id))
    if not include_ended:
        stmt = stmt.where(ApprovalDelegation.active.is_(True))
    rows = list(db.scalars(stmt.order_by(ApprovalDelegation.starts_on.desc(), ApprovalDelegation.id)))
    if view == "all":
        people = {e.id: e for e in db.scalars(select(Employee).where(Employee.id.in_({r.delegator_id for r in rows})))}
        rows = [r for r in rows if r.delegator_id in people and user.scope.can_see(people[r.delegator_id])]
    return _outs(db, rows)


@router.post("", response_model=DelegationOut, status_code=status.HTTP_201_CREATED)
def create_delegation(body: DelegationIn, request: Request, db: DbSession, user: CurrentUserDep) -> DelegationOut:
    emp = me(user)
    delegate = db.get(Employee, body.delegate_id)
    if delegate is None or delegate.employment_status in ("Terminated", "Exited", "Inactive"):
        raise HTTPException(422, "Choose an active colleague.")
    if delegate.id == emp.id:
        raise HTTPException(422, "You can't delegate to yourself.")
    if body.ends_on < body.starts_on:
        raise HTTPException(422, "The end date is before the start date.")
    today = today_for(emp)
    if body.ends_on < today:
        raise HTTPException(422, "The end date is in the past.")
    if body.ends_on - body.starts_on > timedelta(days=MAX_DAYS):
        raise HTTPException(422, f"A delegation can last at most {MAX_DAYS} days.")
    types = sorted(set(body.types)) if body.types else None
    if types and any(t not in DELEGATION_TYPES for t in types):
        raise HTTPException(422, "Choose request types from the list.")
    # no chains: the delegate must not be handing their own approvals back to me in the same window
    loop = db.scalar(select(ApprovalDelegation.id).where(
        ApprovalDelegation.delegator_id == delegate.id, ApprovalDelegation.delegate_id == emp.id,
        ApprovalDelegation.active.is_(True), ApprovalDelegation.starts_on <= body.ends_on,
        ApprovalDelegation.ends_on >= body.starts_on,
    ))
    if loop:
        raise HTTPException(409, f"{delegate.full_name} has delegated to you for those dates.")
    for other in db.scalars(select(ApprovalDelegation).where(
        ApprovalDelegation.delegator_id == emp.id, ApprovalDelegation.active.is_(True),
        ApprovalDelegation.starts_on <= body.ends_on, ApprovalDelegation.ends_on >= body.starts_on,
    )):
        if other.types is None or types is None or set(other.types) & set(types):
            raise HTTPException(409, "You already have a delegation for those dates. End it first.")
    row = ApprovalDelegation(
        id=f"dlg-{uuid.uuid4().hex[:12]}", delegator_id=emp.id, delegate_id=delegate.id, starts_on=body.starts_on,
        ends_on=body.ends_on, types=types, note=(body.note or "").strip() or None, active=True, created_by=user.id,
    )
    db.add(row)
    db.flush()
    record_audit(db, actor_id=user.id, action="delegation_created", entity="delegation", entity_id=row.id,
                 subject_id=emp.id, after=_snapshot(row), ip=client_ip(request))
    notify(db, recipient_id=delegate.id, title=f"{emp.full_name} handed you their approvals",
           body=f"From {row.starts_on} to {row.ends_on}" + (f" ({', '.join(t.replace('_', ' ') for t in types)})" if types else "")
           + ".", href="/approvals")
    db.commit()
    return _outs(db, [row])[0]


@router.delete("/{delegation_id}", response_model=DelegationOut)
def end_delegation(delegation_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> DelegationOut:
    """Ends it now (kept for the audit trail)."""
    row = db.get(ApprovalDelegation, delegation_id)
    if row is None or row.delegator_id != user.employee_id:
        raise NOT_FOUND
    if not row.active:
        raise HTTPException(409, "This delegation has already ended.")
    before = _snapshot(row)
    row.active = False
    record_audit(db, actor_id=user.id, action="delegation_ended", entity="delegation", entity_id=row.id,
                 subject_id=row.delegator_id, before=before, after=_snapshot(row), ip=client_ip(request))
    db.commit()
    return _outs(db, [row])[0]
