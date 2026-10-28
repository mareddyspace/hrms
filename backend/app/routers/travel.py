"""Travel requests (pre-approval for business trips). Approval type "travel": manager, then HR.

Who sees a request: the traveller, their reporting line, HR/admin/executive within scope, and its approvers.
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import select

from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import ApprovalInstance, Employee, ExpenseClaim, TravelRequest
from app.schemas import DecisionIn, TravelRequestIn, TravelRequestOut
from app.services import approvals as engine
from app.services import expenses as rules
from app.services.activity import notify, record_audit
from app.services.decisions import NOT_FOUND, can_view, me
from app.services.leave import today_for
from app.services.workflow_defaults import decide_http, ensure_default, is_approver, notify_withdrawn, waiting_entity_ids

router = APIRouter(prefix="/travel", tags=["travel"])


def _snapshot(t: TravelRequest) -> dict:
    return {"status": t.status, "from": t.from_location, "to": t.to_location, "start_date": t.start_date,
            "end_date": t.end_date, "mode": t.mode, "estimated_cost": t.estimated_cost, "currency": t.currency,
            "advance_amount": t.advance_amount}


def _instance(db: DbSession, trip: TravelRequest) -> ApprovalInstance | None:
    return db.get(ApprovalInstance, trip.approval_instance_id) if trip.approval_instance_id else None


def _outs(db: DbSession, trips: list[TravelRequest]) -> list[TravelRequestOut]:
    if not trips:
        return []
    names = dict(db.execute(select(Employee.id, Employee.full_name).where(Employee.id.in_({t.employee_id for t in trips}))).all())
    instances = {i.id: i for i in db.scalars(select(ApprovalInstance).where(
        ApprovalInstance.id.in_([t.approval_instance_id for t in trips if t.approval_instance_id])))}
    out = []
    for t in trips:
        item = TravelRequestOut.model_validate(t)
        item.employee_name = names.get(t.employee_id)
        inst = instances.get(t.approval_instance_id or "")
        if inst is not None:
            item.approval_status, item.current_step = inst.status, inst.current_step
        out.append(item)
    return out


def _visible(db: DbSession, user: CurrentUser, trip_id: str) -> tuple[TravelRequest, Employee]:
    trip = db.get(TravelRequest, trip_id)
    emp = db.get(Employee, trip.employee_id) if trip else None
    if trip is None or emp is None or not (can_view(db, user, emp) or is_approver(_instance(db, trip), user.employee_id)):
        raise NOT_FOUND
    return trip, emp


@router.get("", response_model=list[TravelRequestOut])
def list_trips(
    db: DbSession,
    user: CurrentUserDep,
    view: Annotated[str, Query(pattern="^(mine|to_decide|all)$")] = "mine",
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    employee_id: str | None = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
) -> list[TravelRequestOut]:
    stmt = select(TravelRequest).join(Employee, Employee.id == TravelRequest.employee_id)
    if view == "mine":
        stmt = stmt.where(TravelRequest.employee_id == (user.employee_id or ""))
    elif view == "to_decide":
        stmt = stmt.where(TravelRequest.id.in_(waiting_entity_ids(db, "travel", user.employee_id) or [""]))
    else:
        stmt = stmt.where(user.scope.employee_filter())
    if employee_id:
        stmt = stmt.where(TravelRequest.employee_id == employee_id)
    if status_filter:
        stmt = stmt.where(TravelRequest.status == status_filter)
    return _outs(db, list(db.scalars(stmt.order_by(TravelRequest.created_at.desc()).limit(limit))))


@router.post("", response_model=TravelRequestOut, status_code=status.HTTP_201_CREATED)
def create_trip(body: TravelRequestIn, request: Request, db: DbSession, user: CurrentUserDep) -> TravelRequestOut:
    emp = me(user)
    try:
        currency = rules.check_currency(body.currency, emp.currency)
        rules.validate_travel(country_code=emp.country_code, currency=currency, start=body.start_date, end=body.end_date,
                              estimated_cost=body.estimated_cost, advance=body.advance_amount, today=today_for(emp))
    except rules.RequestError as exc:
        raise HTTPException(422, str(exc)) from exc
    overlap = db.scalar(select(TravelRequest.id).where(
        TravelRequest.employee_id == emp.id, TravelRequest.status.in_(("submitted", "approved")),
        TravelRequest.start_date <= body.end_date, TravelRequest.end_date >= body.start_date,
        TravelRequest.to_location == body.to_location.strip(),
    ))
    if overlap:
        raise HTTPException(409, f"You already have a trip to {body.to_location.strip()} on these dates ({overlap}).")
    trip = TravelRequest(
        id=f"trv-{uuid.uuid4().hex[:12]}", employee_id=emp.id, purpose=body.purpose.strip(),
        from_location=body.from_location.strip(), to_location=body.to_location.strip(), start_date=body.start_date,
        end_date=body.end_date, mode=body.mode, estimated_cost=round(body.estimated_cost, 2), currency=currency,
        advance_amount=round(body.advance_amount, 2), status="submitted",
    )
    db.add(trip)
    db.flush()
    record_audit(db, actor_id=user.id, action="travel_submitted", entity="travel_request", entity_id=trip.id,
                 subject_id=emp.id, after=_snapshot(trip), ip=client_ip(request))
    ensure_default(db, "travel")
    try:
        instance = engine.start(db, "travel", trip.id, emp, trip.estimated_cost, actor_id=user.id)
    except engine.ApprovalError as exc:
        db.rollback()
        raise HTTPException(422, str(exc)) from exc
    trip.approval_instance_id = instance.id
    db.commit()
    return _outs(db, [trip])[0]


@router.get("/{trip_id}", response_model=TravelRequestOut)
def get_trip(trip_id: str, db: DbSession, user: CurrentUserDep) -> TravelRequestOut:
    return _outs(db, [_visible(db, user, trip_id)[0]])[0]


@router.post("/{trip_id}/withdraw", response_model=TravelRequestOut)
def withdraw_trip(trip_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> TravelRequestOut:
    """Pending requests, or approved trips that haven't started and have no open expense claims."""
    trip = db.get(TravelRequest, trip_id)
    if trip is None or trip.employee_id != user.employee_id:
        raise NOT_FOUND
    emp = me(user)
    if trip.status == "approved":
        if trip.start_date <= today_for(emp):
            raise HTTPException(409, "This trip has already started.")
        if db.scalar(select(ExpenseClaim.id).where(ExpenseClaim.trip_id == trip.id,
                                                   ExpenseClaim.status.in_(rules.OPEN_CLAIM_STATUSES))):
            raise HTTPException(409, "Expense claims are linked to this trip.")
    elif trip.status != "submitted":
        raise HTTPException(409, f"This request is already {trip.status}.")
    before = _snapshot(trip)
    instance = _instance(db, trip)
    notify_withdrawn(db, instance, emp.full_name, "travel request", f"/travel/{trip.id}")
    if instance is not None and instance.status == "pending":
        engine.cancel(db, instance, actor_id=user.id, ip=client_ip(request))
    if before["status"] == "approved" and emp.manager_id:
        notify(db, recipient_id=emp.manager_id, title=f"{emp.full_name} cancelled an approved trip",
               body=f"{trip.from_location} to {trip.to_location}, {trip.start_date} to {trip.end_date}", href=f"/travel/{trip.id}")
    trip.status = "withdrawn"
    record_audit(db, actor_id=user.id, action="travel_withdrawn", entity="travel_request", entity_id=trip.id,
                 subject_id=emp.id, before=before, after=_snapshot(trip), ip=client_ip(request))
    db.commit()
    return _outs(db, [trip])[0]


@router.post("/{trip_id}/decision", response_model=TravelRequestOut)
def decide_trip(trip_id: str, body: DecisionIn, request: Request, db: DbSession, user: CurrentUserDep) -> TravelRequestOut:
    """Same as POST /approvals/{approval_instance_id}/decision."""
    trip, _ = _visible(db, user, trip_id)
    decide_http(db, _instance(db, trip), user.employee_id, body.decision, body.note, user.id, client_ip(request))
    db.commit()
    return _outs(db, [trip])[0]
