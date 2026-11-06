from __future__ import annotations

import uuid
from datetime import date
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from fastapi.responses import FileResponse
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
from app.services import storage
from app.services.scope import manager_chain_ids
from app.services.uploads import UPLOAD_OPENAPI, clean_name, read_upload

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


def _out(r: LeaveRequest, name: str | None, approval: dict | None = None, handover_name: str | None = None) -> LeaveRequestOut:
    out = LeaveRequestOut.model_validate(r)
    out.employee_name = name
    out.approval = approval
    out.handover_name = handover_name
    return out


def _handover_names(db: DbSession, rows: list[LeaveRequest]) -> dict[str, str]:
    ids = {r.handover_to for r in rows if r.handover_to}
    if not ids:
        return {}
    return dict(db.execute(select(Employee.id, Employee.full_name).where(Employee.id.in_(ids))).all())


def _out_one(db: DbSession, user: CurrentUser, r: LeaveRequest, name: str | None) -> LeaveRequestOut:
    return _out(r, name, chain.progress_map(db, chain.LEAVE, [r.id], user.employee_id).get(r.id),
                _handover_names(db, [r]).get(r.handover_to or ""))


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
    handovers = _handover_names(db, [r for r, _ in rows])
    return [_out(r, name, approvals.get(r.id), handovers.get(r.handover_to or "")) for r, name in rows]


@router.post("/requests", response_model=LeaveRequestOut, status_code=status.HTTP_201_CREATED)
def apply_leave(body: LeaveRequestIn, request: Request, db: DbSession, user: CurrentUserDep) -> LeaveRequestOut:
    emp = _me(user)
    try:
        days = rules.validate_new_request(db, emp, body.leave_code, body.from_date, body.to_date, body.half, body.reason)
    except rules.LeaveError as exc:
        raise HTTPException(422, str(exc)) from exc
    handover = (body.handover_to or "").strip() or None
    if handover:
        cover = db.get(Employee, handover)
        if handover == emp.id:
            raise HTTPException(422, "Choose someone else to cover your work.")
        if cover is None or cover.employment_status in ("Terminated", "Exited"):
            raise HTTPException(422, "Choose a colleague to cover your work.")

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
        handover_to=handover,
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
    if handover:
        notify(
            db,
            recipient_id=handover,
            title=f"{emp.full_name} asked you to cover",
            body=f"Leave {item.from_date} to {item.to_date} (waiting for approval).",
            href="/leave",
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


@router.post("/requests/{request_id}/change", response_model=LeaveRequestOut, status_code=status.HTTP_201_CREATED)
def change_request(request_id: str, body: LeaveRequestIn, request: Request, db: DbSession,
                   user: CurrentUserDep) -> LeaveRequestOut:
    """Leave correction: new dates, type or reason for a pending request, or approved leave that hasn't started.
    The old request is withdrawn (or cancelled) and a new one goes through approval again, all in one step."""
    item = db.get(LeaveRequest, request_id)
    if item is None or item.employee_id != user.employee_id:
        raise NOT_FOUND
    emp = _me(user)
    if not (item.status == "pending" or (item.status == "approved" and item.from_date > rules.today_for(emp))):
        raise HTTPException(409, "Only pending requests or approved leave that hasn't started can be changed.")
    before = _snapshot(item)
    was_pending = item.status == "pending"
    item.status = "withdrawn" if was_pending else "cancelled"
    if was_pending:
        chain.withdraw(db, chain.LEAVE, item.id, user.id, client_ip(request))
    db.flush()  # the old days no longer count for balance and overlap checks
    try:
        days = rules.validate_new_request(db, emp, body.leave_code, body.from_date, body.to_date, body.half, body.reason)
    except rules.LeaveError as exc:
        db.rollback()  # nothing changes when the new dates don't work
        raise HTTPException(422, str(exc)) from exc
    new = LeaveRequest(
        id=f"lv-{uuid.uuid4().hex[:12]}", employee_id=emp.id, leave_code=body.leave_code, from_date=body.from_date,
        to_date=body.to_date, half=body.half, days=days, reason=body.reason.strip(), status="pending",
        handover_to=(body.handover_to or "").strip() or item.handover_to,
    )
    db.add(new)
    db.flush()
    chain.start(db, chain.LEAVE, new.id, emp, user.id,
                {"needs_hr": chain.leave_needs_hr(db, body.leave_code, days), "leave_type": body.leave_code})
    record_audit(db, actor_id=user.id, action="leave_changed", entity="leave_request", entity_id=new.id,
                 subject_id=emp.id, before=before, after=_snapshot(new) | {"replaces": item.id}, ip=client_ip(request))
    if emp.manager_id and not was_pending:
        notify(db, recipient_id=emp.manager_id, title=f"{emp.full_name} changed approved leave",
               body=f"Was {item.from_date} to {item.to_date}; now {new.from_date} to {new.to_date} (needs approval again).",
               href=f"/leave/requests/{new.id}")
    db.commit()
    return _out_one(db, user, new, emp.full_name)


# ---------- supporting file (one per request) ----------
@router.post("/requests/{request_id}/attachment", response_model=LeaveRequestOut, openapi_extra=UPLOAD_OPENAPI)
async def upload_attachment(
    request_id: str, request: Request, db: DbSession, user: CurrentUserDep,
    filename: Annotated[str | None, Query(max_length=255)] = None,
) -> LeaveRequestOut:
    """The requester adds (or replaces) a PDF or image, e.g. a medical certificate. Max 5 MB."""
    item = db.get(LeaveRequest, request_id)
    if item is None or item.employee_id != user.employee_id:
        raise NOT_FOUND
    if item.status not in ("pending", "approved"):
        raise HTTPException(409, f"This request is {item.status}.")
    data, content_type, sha = await read_upload(request)
    stored = storage.save(f"leave/{item.employee_id}", f"{item.id}-{sha[:8]}", data, content_type, sha)
    old = item.attachment_path
    item.attachment_path = stored.relative_path
    item.attachment_type = stored.content_type
    item.attachment_name = clean_name(filename, content_type)
    record_audit(
        db, actor_id=user.id, action="leave_attachment_added", entity="leave_request", entity_id=item.id,
        subject_id=item.employee_id, after={"file_name": item.attachment_name, "sha256": sha}, ip=client_ip(request),
    )
    try:
        db.commit()
    except Exception:
        storage.delete_quietly(stored.relative_path)
        raise
    if old and old != stored.relative_path:
        storage.delete_quietly(old)
    emp = db.get(Employee, item.employee_id)
    return _out_one(db, user, item, emp.full_name if emp else None)


@router.get("/requests/{request_id}/attachment", response_class=FileResponse)
def download_attachment(request_id: str, db: DbSession, user: CurrentUserDep) -> Response:
    item = db.get(LeaveRequest, request_id)
    emp = db.get(Employee, item.employee_id) if item else None
    if item is None or emp is None or not item.attachment_path:
        raise NOT_FOUND
    instance = chain.pending_instance(db, chain.LEAVE, item.id)
    if not (item.employee_id == user.employee_id or user.scope.can_see(emp)
            or user.employee_id in manager_chain_ids(db, emp.id) or chain.may_follow(db, user, instance)):
        raise NOT_FOUND
    try:
        return storage.download(item.attachment_path, media_type=item.attachment_type or "application/octet-stream",
                                filename=item.attachment_name)
    except storage.FileMissing as exc:
        raise HTTPException(410, "The file is no longer available.") from exc
    except storage.StorageError as exc:
        raise NOT_FOUND from exc


# ---------- team calendar (privacy: teammates only see "On leave") ----------
@router.get("/team-calendar")
def team_calendar(
    db: DbSession, user: CurrentUserDep,
    from_date: Annotated[date, Query(alias="from")],
    to_date: Annotated[date, Query(alias="to")],
) -> list[dict]:
    """Approved leave of the caller's teammates (same manager), reports and own, for [from, to] (max 92 days).
    The type and reason are shown only for the caller's own leave, people in their reporting line, or to HR;
    teammates appear as "On leave". Working from home is left out for teammates."""
    emp = _me(user)
    if to_date < from_date or (to_date - from_date).days > 92:
        raise HTTPException(422, "Choose a range of at most three months.")
    ids = {emp.id}
    if emp.manager_id:
        ids |= set(db.scalars(select(Employee.id).where(Employee.manager_id == emp.manager_id)))
    ids |= set(user.scope.reports or ())
    rows = db.execute(
        select(LeaveRequest, Employee.full_name, Employee.manager_id)
        .join(Employee, Employee.id == LeaveRequest.employee_id)
        .where(LeaveRequest.employee_id.in_(ids), LeaveRequest.status.in_(("approved", "pending")),
               LeaveRequest.from_date <= to_date, LeaveRequest.to_date >= from_date,
               Employee.employment_status != "Terminated")
        .order_by(LeaveRequest.from_date)
    ).all()
    out: list[dict] = []
    reports = set(user.scope.reports or ())
    for r, name, _mgr in rows:
        detail = r.employee_id == emp.id or r.employee_id in reports or user.scope.is_hr
        if not detail and (r.status != "approved" or r.leave_code in rules.WORKING_LEAVE):
            continue
        out.append({
            "id": r.id if detail else f"away-{r.id[-8:]}",
            "employee_id": r.employee_id,
            "employee_name": name,
            "from": r.from_date.isoformat(),
            "to": r.to_date.isoformat(),
            "half": r.half,
            "status": r.status,
            "detail": detail,
            "leave_code": r.leave_code if detail else None,
            "reason": r.reason if detail else None,
            "label": "On leave" if not detail else None,
        })
    return out
