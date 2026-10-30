"""Cash advances (/cash-advances), leave encashment (/encashments) and software (/software). Rules in
app/services/self_service.py.

Each list takes scope=mine | team (my reporting line plus what waits on me) | all (HR or admin for cash and encashment;
IT / admin for software). Decisions go through the approval chain (same as POST /approvals/{id}/decision).
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import select

from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import ApprovalDecision, ApprovalInstance, CashAdvance, Employee, EncashmentRequest, SoftwareRequest, SoftwareTitle
from app.schemas.self_service import (
    CashIn, CashOut, CashPayIn, CashPolicyOut, DecisionIn, EncashIn, EncashOut, EncashPolicyOut, InstalmentOut, SoftwareIn,
    SoftwareOut, SoftwareTitleIn, SoftwareTitleOut, StepOut,
)
from app.services import approvals as engine
from app.services import self_service as rules
from app.services.activity import record_audit
from app.services.decisions import NOT_FOUND, me
from app.services.leave import today_for
from app.services.scope import manager_chain_ids
from app.services.workflow_defaults import decide_http, is_approver, waiting_entity_ids

cash_router = APIRouter(prefix="/cash-advances", tags=["cash advances"])
encash_router = APIRouter(prefix="/encashments", tags=["leave encashment"])
software_router = APIRouter(prefix="/software", tags=["software"])

Scope = Annotated[str, Query(pattern="^(mine|team|all)$")]


def _err(exc: rules.RequestError) -> HTTPException:
    text = str(exc)
    return HTTPException(409 if "already" in text else 422, text)


def _is_it(user: CurrentUser) -> bool:
    return user.account.role in rules.IT_ROLES


def _hr_or_admin(user: CurrentUser) -> bool:
    return user.scope.is_hr or user.account.role in ("admin", "super_admin", "finance")


def _steps(db: DbSession, instance: ApprovalInstance | None) -> list[StepOut]:
    if instance is None:
        return []
    decisions = list(db.scalars(select(ApprovalDecision).where(ApprovalDecision.instance_id == instance.id)
                                .order_by(ApprovalDecision.id)))
    ids = {d.approver_id for d in decisions} | {x for s in instance.steps for g in s["groups"].values() for x in g}
    names = dict(db.execute(select(Employee.id, Employee.full_name).where(Employee.id.in_(ids or {""}))).all())
    out = []
    for i, step in enumerate(instance.steps):
        if step.get("skipped"):
            continue
        approvers = list(dict.fromkeys(x for g in step["groups"].values() for x in g))
        last = next((d for d in reversed(decisions) if d.step == i), None)
        out.append(StepOut(
            label=step.get("label") or "/".join(step["roles"]).replace("_", " ").title(), approver_ids=approvers,
            approver_names=[names.get(a, a) for a in approvers], decision=last.decision if last else None,
            by=names.get(last.approver_id, last.approver_id) if last else None, note=last.note if last else None,
            at=last.at.isoformat() if last and last.at else None,
        ))
    return out


def _can_view(db: DbSession, user: CurrentUser, row: Any, emp: Employee, extra: bool = False) -> bool:
    me_id = user.employee_id
    if me_id and me_id in (emp.id, getattr(row, "raised_by", None)):
        return True
    instance = rules.instance_of(db, row)
    if is_approver(instance, me_id) or (instance is not None and engine.is_delegate_for(db, instance, me_id)):
        return True
    if extra and user.scope.can_see(emp):
        return True
    return bool(me_id) and me_id in manager_chain_ids(db, emp.id)


def _list(db: DbSession, user: CurrentUser, model: Any, type_: str, scope: str, all_ok: bool, limit: int) -> list[Any]:
    stmt = select(model).join(Employee, Employee.id == model.employee_id)
    me_id = user.employee_id or ""
    if scope == "mine":
        stmt = stmt.where(model.employee_id == me_id)
    elif scope == "team":
        waiting = waiting_entity_ids(db, type_, user.employee_id)
        reports = list(user.scope.reports)
        if not reports and not waiting:
            return []
        stmt = stmt.where((model.employee_id.in_(reports or [""])) | (model.id.in_(waiting or [""])))
    else:
        if not all_ok:
            raise HTTPException(403, "You can't see everyone's requests.")
        stmt = stmt.where(user.scope.employee_filter())
    return list(db.scalars(stmt.order_by(model.created_at.desc()).limit(limit)))


def _get(db: DbSession, user: CurrentUser, model: Any, row_id: str, extra: bool) -> tuple[Any, Employee]:
    row = db.get(model, row_id)
    emp = db.get(Employee, row.employee_id) if row else None
    if row is None or emp is None or not _can_view(db, user, row, emp, extra):
        raise NOT_FOUND
    return row, emp


def _decide(db: DbSession, user: CurrentUser, row: Any, body: DecisionIn, request: Request) -> None:
    decide_http(db, rules.instance_of(db, row), user.employee_id, body.decision, body.note, user.id, client_ip(request))
    current = rules.stage_status(db, row, "")
    if row.status in rules.PENDING and current != row.status:
        row.status = current


# ---------- cash advances ----------
def _cash_out(db: DbSession, user: CurrentUser, row: CashAdvance, emp: Employee) -> CashOut:
    today = today_for(emp)
    instance = rules.instance_of(db, row)
    return CashOut(
        id=row.id, employee_id=emp.id, employee_name=emp.full_name, amount=row.amount, currency=row.currency,
        category=row.category, purpose=row.purpose, needed_by=row.needed_by, instalments=row.instalments,
        status=rules.stage_status(db, row, "Approved"), submitted_on=row.created_at.date(), steps=_steps(db, instance),
        can_decide=engine.can_act(db, instance, user.employee_id),
        can_withdraw=row.status in rules.PENDING and emp.id == user.employee_id,
        can_pay=row.status == "Approved" and emp.id != user.employee_id and rules.can_pay(user.account.role, user.scope.is_hr)
        and user.scope.can_see(emp),
        paid_on=row.paid_on, paid_by=row.paid_by, reference=row.reference, outstanding=rules.outstanding(row, today),
        schedule=[InstalmentOut(**i) for i in rules.schedule(row, today)],
    )


@cash_router.get("/policy", response_model=CashPolicyOut)
def cash_policy(db: DbSession, user: CurrentUserDep) -> CashPolicyOut:
    emp = me(user)
    today = today_for(emp)
    open_row = next((r for r in db.scalars(select(CashAdvance).where(CashAdvance.employee_id == emp.id))
                     if rules.is_open(r, today)), None)
    return CashPolicyOut(**rules.cash_limit(db, emp), categories=list(rules.CASH_CATEGORIES),
                         open_id=open_row.id if open_row else None)


@cash_router.get("", response_model=list[CashOut])
def list_cash(db: DbSession, user: CurrentUserDep, scope: Scope = "mine",
              limit: Annotated[int, Query(ge=1, le=500)] = 200) -> list[CashOut]:
    out = []
    for row in _list(db, user, CashAdvance, rules.CASH, scope, _hr_or_admin(user), limit):
        emp = db.get(Employee, row.employee_id)
        if emp is not None and _can_view(db, user, row, emp, _hr_or_admin(user)):
            out.append(_cash_out(db, user, row, emp))
    return out


@cash_router.post("", response_model=CashOut, status_code=status.HTTP_201_CREATED)
def create_cash(body: CashIn, request: Request, db: DbSession, user: CurrentUserDep) -> CashOut:
    emp = me(user)
    try:
        row = rules.create_cash(db, emp, body.model_dump(), user.id, client_ip(request))
    except rules.RequestError as exc:
        db.rollback()
        raise _err(exc) from exc
    db.commit()
    return _cash_out(db, user, row, emp)


@cash_router.post("/{row_id}/decision", response_model=CashOut)
def decide_cash(row_id: str, body: DecisionIn, request: Request, db: DbSession, user: CurrentUserDep) -> CashOut:
    row, emp = _get(db, user, CashAdvance, row_id, _hr_or_admin(user))
    _decide(db, user, row, body, request)
    db.commit()
    return _cash_out(db, user, row, emp)


@cash_router.post("/{row_id}/withdraw", response_model=CashOut)
def withdraw_cash(row_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> CashOut:
    row, emp = _get(db, user, CashAdvance, row_id, False)
    if emp.id != user.employee_id:
        raise HTTPException(403, "Only the person who asked can withdraw it.")
    try:
        rules.withdraw_cash(db, row, emp, user.id, client_ip(request))
    except rules.RequestError as exc:
        raise _err(exc) from exc
    db.commit()
    return _cash_out(db, user, row, emp)


@cash_router.post("/{row_id}/pay", response_model=CashOut)
def pay_cash(row_id: str, body: CashPayIn, request: Request, db: DbSession, user: CurrentUserDep) -> CashOut:
    row, emp = _get(db, user, CashAdvance, row_id, _hr_or_admin(user))
    if not (rules.can_pay(user.account.role, user.scope.is_hr) and user.scope.can_see(emp)):
        raise HTTPException(403, "Only finance or HR can pay out an advance.")
    try:
        rules.mark_paid(db, row, me(user), user.id, body.reference, client_ip(request))
    except rules.RequestError as exc:
        raise _err(exc) from exc
    db.commit()
    return _cash_out(db, user, row, emp)


# ---------- leave encashment ----------
def _encash_out(db: DbSession, user: CurrentUser, row: EncashmentRequest, emp: Employee) -> EncashOut:
    instance = rules.instance_of(db, row)
    return EncashOut(
        id=row.id, employee_id=emp.id, employee_name=emp.full_name, leave_code=row.leave_code, days=row.days,
        per_day=row.per_day, amount=row.amount, currency=row.currency, status=rules.stage_status(db, row, "Approved"),
        submitted_on=row.created_at.date(), payout_month=row.payout_month, steps=_steps(db, instance),
        can_decide=engine.can_act(db, instance, user.employee_id),
        can_withdraw=row.status in rules.PENDING and emp.id == user.employee_id,
    )


@encash_router.get("/policy", response_model=EncashPolicyOut)
def encash_policy(db: DbSession, user: CurrentUserDep) -> EncashPolicyOut:
    return EncashPolicyOut(**rules.encash_policy(db, me(user)))


@encash_router.get("", response_model=list[EncashOut])
def list_encash(db: DbSession, user: CurrentUserDep, scope: Scope = "mine",
                limit: Annotated[int, Query(ge=1, le=500)] = 200) -> list[EncashOut]:
    out = []
    for row in _list(db, user, EncashmentRequest, rules.ENCASH, scope, _hr_or_admin(user), limit):
        emp = db.get(Employee, row.employee_id)
        if emp is not None and _can_view(db, user, row, emp, _hr_or_admin(user)):
            out.append(_encash_out(db, user, row, emp))
    return out


@encash_router.post("", response_model=EncashOut, status_code=status.HTTP_201_CREATED)
def create_encash(body: EncashIn, request: Request, db: DbSession, user: CurrentUserDep) -> EncashOut:
    emp = me(user)
    try:
        row = rules.create_encashment(db, emp, body.leave_code, body.days, user.id, client_ip(request))
    except rules.RequestError as exc:
        db.rollback()
        raise _err(exc) from exc
    db.commit()
    return _encash_out(db, user, row, emp)


@encash_router.post("/{row_id}/decision", response_model=EncashOut)
def decide_encash(row_id: str, body: DecisionIn, request: Request, db: DbSession, user: CurrentUserDep) -> EncashOut:
    row, emp = _get(db, user, EncashmentRequest, row_id, _hr_or_admin(user))
    _decide(db, user, row, body, request)
    db.commit()
    return _encash_out(db, user, row, emp)


@encash_router.post("/{row_id}/withdraw", response_model=EncashOut)
def withdraw_encash(row_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> EncashOut:
    row, emp = _get(db, user, EncashmentRequest, row_id, False)
    if emp.id != user.employee_id:
        raise HTTPException(403, "Only the person who asked can withdraw it.")
    try:
        rules.withdraw_encashment(db, row, emp, user.id, client_ip(request))
    except rules.RequestError as exc:
        raise _err(exc) from exc
    db.commit()
    return _encash_out(db, user, row, emp)


# ---------- software ----------
def _title_out(db: DbSession, t: SoftwareTitle, today: Any) -> SoftwareTitleOut:
    return SoftwareTitleOut(id=t.id, name=t.name, category=t.category, vendor=t.vendor, monthly_cost=t.monthly_cost,
                            currency=t.currency, needs_approval=t.needs_approval, seats=t.seats,
                            seats_used=rules.seats_used(db, t.id, today), active=t.active)


def _sw_out(db: DbSession, user: CurrentUser, row: SoftwareRequest, emp: Employee) -> SoftwareOut:
    today = today_for(emp)
    title = db.get(SoftwareTitle, row.title_id)
    instance = rules.instance_of(db, row)
    state = rules.software_status(row, today)
    if state in rules.PENDING:
        state = rules.stage_status(db, row, "Active")
    return SoftwareOut(
        id=row.id, employee_id=emp.id, employee_name=emp.full_name, title_id=row.title_id,
        title_name=title.name if title else row.title_id, category=title.category if title else "",
        monthly_cost=title.monthly_cost if title else 0, currency=title.currency if title else "USD", reason=row.reason,
        duration_months=row.duration_months, status=state, submitted_on=row.created_at.date(), assigned_on=row.assigned_on,
        expires_on=row.expires_on, ended_on=row.ended_on, ended_by=row.ended_by, licence_key=row.licence_key,
        direct=bool(row.raised_by and row.raised_by != emp.id), steps=_steps(db, instance),
        can_decide=engine.can_act(db, instance, user.employee_id),
        can_withdraw=row.status in rules.PENDING and emp.id == user.employee_id,
        can_return=state == "Active" and emp.id == user.employee_id,
        can_revoke=state == "Active" and _is_it(user) and emp.id != user.employee_id,
    )


@software_router.get("/catalogue", response_model=list[SoftwareTitleOut])
def catalogue(db: DbSession, user: CurrentUserDep) -> list[SoftwareTitleOut]:
    rules.ensure_catalogue(db)
    db.commit()
    today = today_for(me(user))
    titles = db.scalars(select(SoftwareTitle).order_by(SoftwareTitle.category, SoftwareTitle.name))
    return [_title_out(db, t, today) for t in titles if t.active or _is_it(user)]


@software_router.patch("/catalogue/{title_id}", response_model=SoftwareTitleOut)
def update_title(title_id: str, body: SoftwareTitleIn, request: Request, db: DbSession, user: CurrentUserDep) -> SoftwareTitleOut:
    if not _is_it(user):
        raise HTTPException(403, "Only IT can change the catalogue.")
    title = db.get(SoftwareTitle, title_id)
    if title is None:
        raise NOT_FOUND
    before = {"seats": title.seats, "needs_approval": title.needs_approval, "active": title.active}
    for key, value in body.model_dump(exclude_none=True).items():
        setattr(title, key, value)
    record_audit(db, actor_id=user.id, action="software_title_updated", entity="software_titles", entity_id=title.id,
                 before=before, after=body.model_dump(exclude_none=True), ip=client_ip(request))
    db.commit()
    return _title_out(db, title, today_for(me(user)))


@software_router.get("/requests", response_model=list[SoftwareOut])
def list_software(db: DbSession, user: CurrentUserDep, scope: Scope = "mine",
                  limit: Annotated[int, Query(ge=1, le=500)] = 300) -> list[SoftwareOut]:
    out = []
    for row in _list(db, user, SoftwareRequest, rules.SOFTWARE, scope, _is_it(user), limit):
        emp = db.get(Employee, row.employee_id)
        if emp is not None and _can_view(db, user, row, emp, _is_it(user)):
            out.append(_sw_out(db, user, row, emp))
    return out


@software_router.post("/requests", response_model=SoftwareOut, status_code=status.HTTP_201_CREATED)
def create_software(body: SoftwareIn, request: Request, db: DbSession, user: CurrentUserDep) -> SoftwareOut:
    raiser = me(user)
    rules.ensure_catalogue(db)
    title = db.get(SoftwareTitle, body.title_id)
    if title is None:
        raise NOT_FOUND
    emp = raiser
    if body.employee_id and body.employee_id != raiser.id:
        if not _is_it(user):
            raise HTTPException(403, "Only IT can assign software to someone else.")
        emp = db.get(Employee, body.employee_id)
        if emp is None or not user.scope.can_see(emp):
            raise NOT_FOUND
    try:
        row = rules.create_software(db, emp, title, body.reason, body.duration_months, raiser, user.id, client_ip(request))
    except rules.RequestError as exc:
        db.rollback()
        raise _err(exc) from exc
    db.commit()
    return _sw_out(db, user, row, emp)


@software_router.post("/requests/{row_id}/decision", response_model=SoftwareOut)
def decide_software(row_id: str, body: DecisionIn, request: Request, db: DbSession, user: CurrentUserDep) -> SoftwareOut:
    row, emp = _get(db, user, SoftwareRequest, row_id, _is_it(user))
    _decide(db, user, row, body, request)
    db.commit()
    return _sw_out(db, user, row, emp)


@software_router.post("/requests/{row_id}/withdraw", response_model=SoftwareOut)
def withdraw_software(row_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> SoftwareOut:
    row, emp = _get(db, user, SoftwareRequest, row_id, False)
    if emp.id != user.employee_id:
        raise HTTPException(403, "Only the person who asked can withdraw it.")
    try:
        rules.withdraw_software(db, row, emp, user.id, client_ip(request))
    except rules.RequestError as exc:
        raise _err(exc) from exc
    db.commit()
    return _sw_out(db, user, row, emp)


@software_router.post("/requests/{row_id}/return", response_model=SoftwareOut)
def return_software(row_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> SoftwareOut:
    row, emp = _get(db, user, SoftwareRequest, row_id, False)
    if emp.id != user.employee_id:
        raise HTTPException(403, "Only the licence holder can return it.")
    try:
        rules.end_licence(db, row, emp, user.id, "Returned", client_ip(request))
    except rules.RequestError as exc:
        raise _err(exc) from exc
    db.commit()
    return _sw_out(db, user, row, emp)


@software_router.post("/requests/{row_id}/revoke", response_model=SoftwareOut)
def revoke_software(row_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> SoftwareOut:
    row, emp = _get(db, user, SoftwareRequest, row_id, _is_it(user))
    if not _is_it(user) or emp.id == user.employee_id:
        raise HTTPException(403, "Only IT can revoke a licence.")
    try:
        rules.end_licence(db, row, me(user), user.id, "Revoked", client_ip(request))
    except rules.RequestError as exc:
        raise _err(exc) from exc
    db.commit()
    return _sw_out(db, user, row, emp)
