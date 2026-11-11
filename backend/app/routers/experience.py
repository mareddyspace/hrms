"""Employee experience: company assets (/assets), immigration and ID documents (/immigration) and the privacy centre
(/privacy). Rules, notices and audit in app/services/experience.py.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import or_, select

from app.db import utcnow
from app.deps import CurrentUserDep, DbSession, client_ip
from app.models import (
    Asset, AssetRequest, AuditLog, Employee, HrCase, ImmigrationDocument, LeaveRequest, PrivacyConsent, PrivacyRequest,
    RetentionRule,
)
from app.services import experience as rules
from app.services.activity import record_audit
from app.services.decisions import NOT_FOUND

assets_router = APIRouter(prefix="/assets", tags=["assets"])
immigration_router = APIRouter(prefix="/immigration", tags=["immigration"])
privacy_router = APIRouter(prefix="/privacy", tags=["privacy"])
routers = (assets_router, immigration_router, privacy_router)


def _fail(db: DbSession, exc: rules.RuleError) -> HTTPException:
    db.rollback()
    text = str(exc)
    code = 403 if text.startswith("Only") else 409 if "already" in text else 422
    return HTTPException(code, text)


def _me(user) -> Employee:  # noqa: ANN001
    if user.employee is None:
        raise HTTPException(403, "Only people in the directory can use this.")
    return user.employee


class HistoryOut(BaseModel):
    at: str
    action: str
    by_name: str
    note: str | None = None
    status: str | None = None


def _history(rows: list[Any] | None) -> list[HistoryOut]:
    return [HistoryOut(at=h.get("at", ""), action=h.get("action", ""), by_name=h.get("by_name") or "System",
                       note=h.get("note"), status=h.get("status")) for h in (rows or [])]


# ============================== assets ==============================
class AssetOut(BaseModel):
    id: str
    tag: str
    name: str
    category: str
    serial_no: str | None
    status: str
    employee_id: str | None
    employee_name: str | None
    assigned_on: date | None
    condition: str
    country_code: str | None
    notes: str | None
    history: list[HistoryOut]


class AssetRequestOut(BaseModel):
    id: str
    employee_id: str
    employee_name: str
    kind: str
    category: str
    item: str
    reason: str
    needed_by: date | None
    asset_id: str | None
    status: str
    manager_name: str | None
    decision_note: str | None
    created_at: datetime
    closed_on: date | None
    history: list[HistoryOut]
    can_cancel: bool
    can_approve: bool
    can_complete: bool


class AssetMetaOut(BaseModel):
    categories: list[str]
    conditions: list[str]
    is_it: bool
    is_hr: bool
    has_team: bool


class AssetRequestIn(BaseModel):
    kind: Literal["new", "repair", "lost", "return"]
    category: str = Field(default="", max_length=40)
    item: str = Field(default="", max_length=120)
    reason: str = Field(min_length=1, max_length=1000)
    asset_id: str | None = Field(default=None, max_length=64)
    needed_by: date | None = None


class ManagerDecisionIn(BaseModel):
    approve: bool
    note: str = Field(default="", max_length=1000)


class CompleteIn(BaseModel):
    action: Literal["fulfil", "resolve", "receive", "reject"]
    note: str = Field(default="", max_length=1000)
    asset_id: str | None = Field(default=None, max_length=64)
    condition: str | None = Field(default=None, max_length=16)


class AssetIn(BaseModel):
    tag: str = Field(max_length=40)
    name: str = Field(max_length=120)
    category: str = Field(max_length=40)
    serial_no: str | None = Field(default=None, max_length=80)
    condition: str = Field(default="Good", max_length=16)
    country_code: str | None = Field(default=None, max_length=2)
    notes: str | None = Field(default=None, max_length=1000)


class AssignIn(BaseModel):
    employee_id: str = Field(max_length=64)
    note: str = Field(default="", max_length=500)


class RecoverIn(BaseModel):
    condition: str = Field(default="Good", max_length=16)
    note: str = Field(default="", max_length=500)


class NoteIn(BaseModel):
    note: str = Field(default="", max_length=500)


def _asset_out(db: DbSession, a: Asset, full: bool = True) -> AssetOut:
    return AssetOut(id=a.id, tag=a.tag, name=a.name, category=a.category, serial_no=a.serial_no if full else None,
                    status=a.status, employee_id=a.employee_id, employee_name=rules.name_of(db, a.employee_id) or None,
                    assigned_on=a.assigned_on, condition=a.condition, country_code=a.country_code,
                    notes=a.notes if full else None, history=_history(a.history) if full else [])


def _request_out(db: DbSession, user, r: AssetRequest) -> AssetRequestOut:  # noqa: ANN001
    me = user.employee_id
    return AssetRequestOut(
        id=r.id, employee_id=r.employee_id, employee_name=rules.name_of(db, r.employee_id), kind=r.kind,
        category=r.category, item=r.item, reason=r.reason, needed_by=r.needed_by, asset_id=r.asset_id, status=r.status,
        manager_name=rules.name_of(db, r.manager_id) or None, decision_note=r.decision_note, created_at=r.created_at,
        closed_on=r.closed_on, history=_history(r.history),
        can_cancel=r.employee_id == me and r.status in rules.OPEN_REQUEST,
        can_approve=r.status == "Pending manager" and r.manager_id == me and r.employee_id != me,
        can_complete=r.status == "Pending IT" and rules.is_it(user.account.role) and r.employee_id != me,
    )


def _require_it(user) -> None:  # noqa: ANN001
    if not rules.is_it(user.account.role):
        raise HTTPException(403, "Only IT can manage the asset inventory.")


@assets_router.get("/meta", response_model=AssetMetaOut)
def asset_meta(user: CurrentUserDep) -> AssetMetaOut:
    return AssetMetaOut(categories=list(rules.ASSET_CATEGORIES), conditions=list(rules.CONDITIONS),
                        is_it=rules.is_it(user.account.role), is_hr=user.scope.is_hr, has_team=bool(user.scope.reports))


@assets_router.get("", response_model=list[AssetOut])
def list_assets(db: DbSession, user: CurrentUserDep,
                view: Literal["mine", "team", "all"] = "mine") -> list[AssetOut]:
    """mine: assigned to me. team: assigned to my reporting line (managers) or people in scope (HR).
    all: the whole inventory (IT only)."""
    if view == "all":
        _require_it(user)
        rows = db.scalars(select(Asset).order_by(Asset.category, Asset.tag)).all()
        return [_asset_out(db, a) for a in rows]
    if view == "team":
        if not user.scope.reports and not user.scope.is_hr:
            return []
        stmt = (select(Asset).join(Employee, Employee.id == Asset.employee_id)
                .where(user.scope.employee_filter(), Asset.employee_id != user.employee_id).order_by(Employee.full_name, Asset.tag))
        return [_asset_out(db, a, full=user.scope.is_hr or rules.is_it(user.account.role)) for a in db.scalars(stmt)]
    if not user.employee_id:
        return []
    return [_asset_out(db, a) for a in db.scalars(select(Asset).where(Asset.employee_id == user.employee_id)
                                                  .order_by(Asset.assigned_on.desc(), Asset.tag))]


@assets_router.get("/requests", response_model=list[AssetRequestOut])
def list_asset_requests(db: DbSession, user: CurrentUserDep,
                        view: Literal["mine", "manage"] = "mine") -> list[AssetRequestOut]:
    """mine: my requests. manage: waiting on me as manager, my reporting line's, HR scope, or everything for IT."""
    me = user.employee_id
    if view == "mine":
        rows = db.scalars(select(AssetRequest).where(AssetRequest.employee_id == me).order_by(AssetRequest.created_at.desc())) if me else []
        return [_request_out(db, user, r) for r in rows]
    stmt = select(AssetRequest).join(Employee, Employee.id == AssetRequest.employee_id)
    if not rules.is_it(user.account.role):
        stmt = stmt.where(or_(user.scope.employee_filter(), AssetRequest.manager_id == me))
    stmt = stmt.where(AssetRequest.employee_id != me).order_by(AssetRequest.created_at.desc()).limit(500)
    return [_request_out(db, user, r) for r in db.scalars(stmt)]


def _get_request(db: DbSession, user, request_id: str) -> AssetRequest:  # noqa: ANN001
    row = db.get(AssetRequest, request_id)
    emp = db.get(Employee, row.employee_id) if row else None
    if row is None or emp is None or not rules.can_see_request(user.scope, user.account.role, emp, row):
        raise NOT_FOUND
    return row


@assets_router.post("/requests", response_model=AssetRequestOut, status_code=status.HTTP_201_CREATED)
def create_asset_request(body: AssetRequestIn, db: DbSession, user: CurrentUserDep) -> AssetRequestOut:
    emp = _me(user)
    try:
        row = rules.create_asset_request(db, emp, emp.id, body.kind, body.category, body.item, body.reason,
                                         body.asset_id, body.needed_by)
    except rules.RuleError as exc:
        raise _fail(db, exc) from exc
    db.commit()
    return _request_out(db, user, row)


@assets_router.post("/requests/{request_id}/manager-decision", response_model=AssetRequestOut)
def manager_decision(request_id: str, body: ManagerDecisionIn, db: DbSession, user: CurrentUserDep) -> AssetRequestOut:
    row = _get_request(db, user, request_id)
    try:
        rules.manager_decide(db, row, user.employee_id or "", body.approve, body.note)
    except rules.RuleError as exc:
        raise _fail(db, exc) from exc
    db.commit()
    return _request_out(db, user, row)


@assets_router.post("/requests/{request_id}/complete", response_model=AssetRequestOut)
def complete_request(request_id: str, body: CompleteIn, db: DbSession, user: CurrentUserDep) -> AssetRequestOut:
    _require_it(user)
    row = _get_request(db, user, request_id)
    try:
        rules.it_complete(db, row, user.employee_id or user.id, body.action, body.note, body.asset_id, body.condition)
    except rules.RuleError as exc:
        raise _fail(db, exc) from exc
    db.commit()
    return _request_out(db, user, row)


@assets_router.post("/requests/{request_id}/cancel", response_model=AssetRequestOut)
def cancel_request(request_id: str, db: DbSession, user: CurrentUserDep) -> AssetRequestOut:
    row = _get_request(db, user, request_id)
    try:
        rules.cancel_request(db, row, user.employee_id or "")
    except rules.RuleError as exc:
        raise _fail(db, exc) from exc
    db.commit()
    return _request_out(db, user, row)


@assets_router.post("", response_model=AssetOut, status_code=status.HTTP_201_CREATED)
def add_asset(body: AssetIn, db: DbSession, user: CurrentUserDep) -> AssetOut:
    _require_it(user)
    try:
        asset = rules.save_asset(db, user.employee_id or user.id, body.model_dump())
    except rules.RuleError as exc:
        raise _fail(db, exc) from exc
    db.commit()
    return _asset_out(db, asset)


def _get_asset(db: DbSession, asset_id: str) -> Asset:
    asset = db.get(Asset, asset_id)
    if asset is None:
        raise NOT_FOUND
    return asset


@assets_router.put("/{asset_id}", response_model=AssetOut)
def update_asset(asset_id: str, body: AssetIn, db: DbSession, user: CurrentUserDep) -> AssetOut:
    _require_it(user)
    asset = _get_asset(db, asset_id)
    try:
        rules.save_asset(db, user.employee_id or user.id, body.model_dump(), asset)
    except rules.RuleError as exc:
        raise _fail(db, exc) from exc
    db.commit()
    return _asset_out(db, asset)


@assets_router.post("/{asset_id}/assign", response_model=AssetOut)
def assign_asset(asset_id: str, body: AssignIn, db: DbSession, user: CurrentUserDep) -> AssetOut:
    _require_it(user)
    asset = _get_asset(db, asset_id)
    emp = db.get(Employee, body.employee_id)
    if emp is None:
        raise HTTPException(422, "Choose who gets the asset.")
    try:
        rules.assign_asset(db, asset, emp, user.employee_id or user.id, body.note)
    except rules.RuleError as exc:
        raise _fail(db, exc) from exc
    db.commit()
    return _asset_out(db, asset)


@assets_router.post("/{asset_id}/recover", response_model=AssetOut)
def recover_asset(asset_id: str, body: RecoverIn, db: DbSession, user: CurrentUserDep) -> AssetOut:
    _require_it(user)
    asset = _get_asset(db, asset_id)
    try:
        rules.recover_asset(db, asset, user.employee_id or user.id, body.condition, body.note)
    except rules.RuleError as exc:
        raise _fail(db, exc) from exc
    db.commit()
    return _asset_out(db, asset)


@assets_router.post("/{asset_id}/retire", response_model=AssetOut)
def retire_asset(asset_id: str, body: NoteIn, db: DbSession, user: CurrentUserDep) -> AssetOut:
    _require_it(user)
    asset = _get_asset(db, asset_id)
    try:
        rules.retire_asset(db, asset, user.employee_id or user.id, body.note)
    except rules.RuleError as exc:
        raise _fail(db, exc) from exc
    db.commit()
    return _asset_out(db, asset)


# ============================== immigration documents ==============================
class DocumentOut(BaseModel):
    id: str
    employee_id: str
    employee_name: str
    country_code: str
    doc_type: str
    number: str
    number_masked: bool
    issuing_country: str
    issue_date: date
    expiry_date: date
    days_left: int
    status: str
    sponsor: str | None
    renewal_in_progress: bool
    verification: str
    verification_note: str | None
    verified_by_name: str | None
    verified_on: date | None
    updated_on: date
    history: list[HistoryOut]
    can_edit: bool
    can_verify: bool
    can_remove: bool


class DocumentIn(BaseModel):
    employee_id: str | None = Field(default=None, max_length=64)
    doc_type: str = Field(max_length=40)
    number: str = Field(max_length=40)
    issuing_country: str = Field(max_length=80)
    issue_date: date
    expiry_date: date
    sponsor: str | None = Field(default=None, max_length=120)
    record_expired: bool = False


class VerifyIn(BaseModel):
    approve: bool
    note: str = Field(default="", max_length=1000)


class RenewalIn(BaseModel):
    value: bool
    note: str = Field(default="", max_length=500)


class ImmigrationMetaOut(BaseModel):
    doc_types: list[str]
    sponsor_countries: list[str]
    sponsored_types: list[str]
    expiring_days: int
    is_hr: bool
    has_team: bool


def _doc_out(db: DbSession, user, d: ImmigrationDocument, emp: Employee) -> DocumentOut:  # noqa: ANN001
    me = user.employee_id
    own = d.employee_id == me
    hr = user.scope.is_hr and user.scope.can_see(emp)
    full = own or hr
    today = date.today()
    return DocumentOut(
        id=d.id, employee_id=d.employee_id, employee_name=emp.full_name, country_code=emp.country_code,
        doc_type=d.doc_type, number=d.number if full else rules.mask(d.number), number_masked=not full,
        issuing_country=d.issuing_country, issue_date=d.issue_date, expiry_date=d.expiry_date,
        days_left=(d.expiry_date - today).days, status=rules.doc_status(d, today), sponsor=d.sponsor,
        renewal_in_progress=d.renewal_in_progress, verification=d.verification,
        verification_note=d.verification_note if full else None,
        verified_by_name=rules.name_of(db, d.verified_by) or None, verified_on=d.verified_on,
        updated_on=d.updated_at.date() if d.updated_at else today, history=_history(d.history) if full else [],
        can_edit=own or hr, can_verify=hr and not own and d.verification == "pending",
        can_remove=(own and d.verification != "verified") or (hr and not own),
    )


def _get_doc(db: DbSession, user, doc_id: str) -> tuple[ImmigrationDocument, Employee]:  # noqa: ANN001
    doc = db.get(ImmigrationDocument, doc_id)
    emp = db.get(Employee, doc.employee_id) if doc else None
    if doc is None or emp is None or not user.scope.can_see(emp):
        raise NOT_FOUND
    return doc, emp


def _can_change(user, emp: Employee) -> bool:  # noqa: ANN001
    return emp.id == user.employee_id or (user.scope.is_hr and user.scope.can_see(emp))


@immigration_router.get("/meta", response_model=ImmigrationMetaOut)
def immigration_meta(user: CurrentUserDep) -> ImmigrationMetaOut:
    return ImmigrationMetaOut(doc_types=list(rules.DOC_TYPES), sponsor_countries=list(rules.SPONSOR_COUNTRIES),
                              sponsored_types=list(rules.SPONSORED_TYPES), expiring_days=rules.EXPIRING_DAYS,
                              is_hr=user.scope.is_hr, has_team=bool(user.scope.reports))


@immigration_router.get("/documents", response_model=list[DocumentOut])
def list_documents(db: DbSession, user: CurrentUserDep,
                   view: Literal["mine", "team", "all"] = "mine") -> list[DocumentOut]:
    """mine: my documents. team: my reporting line (number masked). all: everyone in HR scope."""
    stmt = select(ImmigrationDocument, Employee).join(Employee, Employee.id == ImmigrationDocument.employee_id)
    if view == "mine":
        stmt = stmt.where(ImmigrationDocument.employee_id == (user.employee_id or ""))
    elif view == "team":
        stmt = stmt.where(Employee.id.in_(user.scope.reports or {""}), Employee.employment_status.not_in(rules.LEFT))
    else:
        if not user.scope.is_hr:
            raise HTTPException(403, "Only HR can see everyone's documents.")
        stmt = stmt.where(user.scope.employee_filter(), Employee.employment_status.not_in(rules.LEFT))
    rows = db.execute(stmt.order_by(ImmigrationDocument.expiry_date)).all()
    return [_doc_out(db, user, d, e) for d, e in rows]


@immigration_router.post("/documents", response_model=DocumentOut, status_code=status.HTTP_201_CREATED)
def add_document(body: DocumentIn, db: DbSession, user: CurrentUserDep) -> DocumentOut:
    target = body.employee_id or user.employee_id
    emp = db.get(Employee, target) if target else None
    if emp is None or not user.scope.can_see(emp):
        raise HTTPException(422, "Choose the person the document belongs to.")
    if not _can_change(user, emp):
        raise HTTPException(403, "Only HR can add documents for someone else.")
    try:
        doc = rules.save_document(db, user.employee_id or user.id, user.scope.is_hr, emp, body.model_dump())
    except rules.RuleError as exc:
        raise _fail(db, exc) from exc
    db.commit()
    return _doc_out(db, user, doc, emp)


@immigration_router.put("/documents/{doc_id}", response_model=DocumentOut)
def update_document(doc_id: str, body: DocumentIn, db: DbSession, user: CurrentUserDep) -> DocumentOut:
    doc, emp = _get_doc(db, user, doc_id)
    if not _can_change(user, emp):
        raise HTTPException(403, "Only the holder or HR can update this document.")
    if body.employee_id and body.employee_id != doc.employee_id:
        raise HTTPException(422, "A document cannot be moved to another person.")
    try:
        rules.save_document(db, user.employee_id or user.id, user.scope.is_hr, emp, body.model_dump(), doc)
    except rules.RuleError as exc:
        raise _fail(db, exc) from exc
    db.commit()
    return _doc_out(db, user, doc, emp)


@immigration_router.post("/documents/{doc_id}/verify", response_model=DocumentOut)
def verify_document(doc_id: str, body: VerifyIn, db: DbSession, user: CurrentUserDep) -> DocumentOut:
    doc, emp = _get_doc(db, user, doc_id)
    if not user.scope.is_hr:
        raise HTTPException(403, "Only HR can verify documents.")
    try:
        rules.verify_document(db, doc, user.employee_id or user.id, body.approve, body.note)
    except rules.RuleError as exc:
        raise _fail(db, exc) from exc
    db.commit()
    return _doc_out(db, user, doc, emp)


@immigration_router.post("/documents/{doc_id}/renewal", response_model=DocumentOut)
def mark_renewal(doc_id: str, body: RenewalIn, db: DbSession, user: CurrentUserDep) -> DocumentOut:
    doc, emp = _get_doc(db, user, doc_id)
    if not _can_change(user, emp):
        raise HTTPException(403, "Only the holder or HR can mark a renewal.")
    try:
        rules.set_renewal(db, doc, user.employee_id or user.id, body.value, body.note)
    except rules.RuleError as exc:
        raise _fail(db, exc) from exc
    db.commit()
    return _doc_out(db, user, doc, emp)


@immigration_router.delete("/documents/{doc_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_document(doc_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> None:
    doc, emp = _get_doc(db, user, doc_id)
    own = emp.id == user.employee_id
    if not ((own and doc.verification != "verified") or (user.scope.is_hr and not own)):
        raise HTTPException(403, "Only HR can remove a verified document.")
    record_audit(db, actor_id=user.id, action="immigration_doc_removed", entity="immigration_document", entity_id=doc.id,
                 subject_id=emp.id, before=rules._doc_audit(doc), ip=client_ip(request))
    if not own:
        rules.tell(db, [emp.id], f"HR removed your {doc.doc_type} record", "", rules.IMMIGRATION_HREF)
    db.delete(doc)
    db.commit()


# ============================== privacy ==============================
class ConsentOut(BaseModel):
    topic: str
    granted: bool
    at: datetime | None


class ConsentsOut(BaseModel):
    current: list[ConsentOut]
    history: list[ConsentOut]


class ConsentIn(BaseModel):
    granted: bool


class PrivacyRequestOut(BaseModel):
    id: str
    employee_id: str
    employee_name: str
    country_code: str
    kind: str
    details: str
    created_on: date
    due_on: date
    status: str
    handled_by_name: str | None
    closed_on: date | None
    outcome: str | None
    history: list[HistoryOut]
    can_handle: bool
    can_withdraw: bool


class PrivacyRequestIn(BaseModel):
    kind: Literal["Access", "Correction", "Deletion"]
    details: str = Field(default="", max_length=1000)


class MoveIn(BaseModel):
    status: Literal["In progress", "Completed", "Rejected"]
    outcome: str = Field(default="", max_length=1000)


class RetentionOut(BaseModel):
    id: str
    category: str
    period: int
    unit: str
    legal_basis: str
    updated_on: date


class RetentionIn(BaseModel):
    category: str = Field(max_length=160)
    period: int
    unit: Literal["months", "years"]
    legal_basis: str = Field(max_length=80)


@privacy_router.get("/consents", response_model=ConsentsOut)
def my_consents(db: DbSession, user: CurrentUserDep) -> ConsentsOut:
    emp = _me(user)
    current = rules.current_consents(db, emp.id)
    history = db.scalars(select(PrivacyConsent).where(PrivacyConsent.employee_id == emp.id)
                         .order_by(PrivacyConsent.created_at.desc())).all()
    return ConsentsOut(
        current=[ConsentOut(topic=t, granted=current[t].granted if t in current else False,
                            at=current[t].created_at if t in current else None) for t in rules.CONSENT_TOPICS],
        history=[ConsentOut(topic=h.topic, granted=h.granted, at=h.created_at) for h in history],
    )


@privacy_router.put("/consents/{topic}", response_model=ConsentsOut)
def set_consent(topic: str, body: ConsentIn, db: DbSession, user: CurrentUserDep) -> ConsentsOut:
    emp = _me(user)
    try:
        rules.set_consent(db, emp, topic, body.granted)
    except rules.RuleError as exc:
        raise _fail(db, exc) from exc
    db.commit()
    return my_consents(db, user)


def _privacy_out(db: DbSession, user, r: PrivacyRequest, emp: Employee) -> PrivacyRequestOut:  # noqa: ANN001
    me = user.employee_id
    return PrivacyRequestOut(
        id=r.id, employee_id=r.employee_id, employee_name=emp.full_name, country_code=emp.country_code, kind=r.kind,
        details=r.details, created_on=r.created_at.date(), due_on=r.due_on, status=r.status,
        handled_by_name=rules.name_of(db, r.handled_by) or None, closed_on=r.closed_on, outcome=r.outcome,
        history=_history(r.history),
        can_handle=user.scope.is_hr and r.employee_id != me and r.status not in rules.PRIVACY_CLOSED,
        can_withdraw=r.employee_id == me and r.status not in rules.PRIVACY_CLOSED,
    )


@privacy_router.get("/requests", response_model=list[PrivacyRequestOut])
def list_privacy_requests(db: DbSession, user: CurrentUserDep,
                          view: Literal["mine", "queue"] = "mine") -> list[PrivacyRequestOut]:
    stmt = select(PrivacyRequest, Employee).join(Employee, Employee.id == PrivacyRequest.employee_id)
    if view == "mine":
        stmt = stmt.where(PrivacyRequest.employee_id == (user.employee_id or ""))
    else:
        if not user.scope.is_hr:
            raise HTTPException(403, "Only HR can see the request queue.")
        stmt = stmt.where(user.scope.employee_filter(), PrivacyRequest.employee_id != (user.employee_id or ""))
    rows = db.execute(stmt.order_by(PrivacyRequest.created_at.desc())).all()
    return [_privacy_out(db, user, r, e) for r, e in rows]


@privacy_router.post("/requests", response_model=PrivacyRequestOut, status_code=status.HTTP_201_CREATED)
def raise_privacy_request(body: PrivacyRequestIn, db: DbSession, user: CurrentUserDep) -> PrivacyRequestOut:
    emp = _me(user)
    try:
        row = rules.raise_privacy_request(db, emp, body.kind, body.details)
    except rules.RuleError as exc:
        raise _fail(db, exc) from exc
    db.commit()
    return _privacy_out(db, user, row, emp)


def _get_privacy(db: DbSession, user, request_id: str) -> tuple[PrivacyRequest, Employee]:  # noqa: ANN001
    row = db.get(PrivacyRequest, request_id)
    emp = db.get(Employee, row.employee_id) if row else None
    if row is None or emp is None or not (row.employee_id == user.employee_id or (user.scope.is_hr and user.scope.can_see(emp))):
        raise NOT_FOUND
    return row, emp


@privacy_router.post("/requests/{request_id}/withdraw", response_model=PrivacyRequestOut)
def withdraw_privacy_request(request_id: str, db: DbSession, user: CurrentUserDep) -> PrivacyRequestOut:
    row, emp = _get_privacy(db, user, request_id)
    try:
        rules.withdraw_privacy_request(db, row, user.employee_id or "")
    except rules.RuleError as exc:
        raise _fail(db, exc) from exc
    db.commit()
    return _privacy_out(db, user, row, emp)


@privacy_router.post("/requests/{request_id}/move", response_model=PrivacyRequestOut)
def move_privacy_request(request_id: str, body: MoveIn, db: DbSession, user: CurrentUserDep) -> PrivacyRequestOut:
    row, emp = _get_privacy(db, user, request_id)
    if not user.scope.is_hr:
        raise HTTPException(403, "Only HR can handle data requests.")
    try:
        rules.move_privacy_request(db, row, user.employee_id or user.id, body.status, body.outcome)
    except rules.RuleError as exc:
        raise _fail(db, exc) from exc
    db.commit()
    return _privacy_out(db, user, row, emp)


def _rule_out(r: RetentionRule) -> RetentionOut:
    return RetentionOut(id=r.id, category=r.category, period=r.period, unit=r.unit, legal_basis=r.legal_basis,
                        updated_on=r.updated_at.date())


@privacy_router.get("/retention", response_model=list[RetentionOut])
def list_retention(db: DbSession, user: CurrentUserDep) -> list[RetentionOut]:
    return [_rule_out(r) for r in db.scalars(select(RetentionRule).order_by(RetentionRule.category))]


def _require_hr(user) -> None:  # noqa: ANN001
    if not user.scope.is_hr:
        raise HTTPException(403, "Only HR can change retention policy.")


@privacy_router.post("/retention", response_model=RetentionOut, status_code=status.HTTP_201_CREATED)
def add_retention(body: RetentionIn, db: DbSession, user: CurrentUserDep) -> RetentionOut:
    _require_hr(user)
    try:
        rule = rules.save_retention(db, user.employee_id or user.id, body.model_dump())
    except rules.RuleError as exc:
        raise _fail(db, exc) from exc
    db.commit()
    return _rule_out(rule)


@privacy_router.put("/retention/{rule_id}", response_model=RetentionOut)
def update_retention(rule_id: str, body: RetentionIn, db: DbSession, user: CurrentUserDep) -> RetentionOut:
    _require_hr(user)
    rule = db.get(RetentionRule, rule_id)
    if rule is None:
        raise NOT_FOUND
    try:
        rules.save_retention(db, user.employee_id or user.id, body.model_dump(), rule)
    except rules.RuleError as exc:
        raise _fail(db, exc) from exc
    db.commit()
    return _rule_out(rule)


@privacy_router.delete("/retention/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_retention(rule_id: str, db: DbSession, user: CurrentUserDep) -> None:
    _require_hr(user)
    rule = db.get(RetentionRule, rule_id)
    if rule is None:
        raise NOT_FOUND
    record_audit(db, actor_id=user.id, action="retention_rule_removed", entity="retention_rule", entity_id=rule.id,
                 before={"category": rule.category, "period": rule.period, "unit": rule.unit})
    db.delete(rule)
    db.commit()


_PROFILE_FIELDS = ("id", "employee_code", "full_name", "preferred_name", "email", "personal_email", "mobile",
                   "country_code", "legal_entity", "department", "location", "job_title", "grade", "employment_type",
                   "employment_status", "joining_date", "date_of_birth", "gender", "nationality")


@privacy_router.get("/my-data")
def my_data(request: Request, db: DbSession, user: CurrentUserDep,
            sections: str | None = Query(default=None, max_length=200)) -> dict[str, Any]:
    """Everything the server holds about the caller that they may see (the data-access right). Audited."""
    emp = _me(user)
    data: dict[str, Any] = {
        "generated_at": utcnow().isoformat(),
        "profile": {f: getattr(emp, f, None) for f in _PROFILE_FIELDS},
        "consents": [{"topic": c.topic, "granted": c.granted, "at": c.created_at}
                     for c in db.scalars(select(PrivacyConsent).where(PrivacyConsent.employee_id == emp.id)
                                         .order_by(PrivacyConsent.created_at))],
        "privacy_requests": [{"kind": r.kind, "details": r.details, "status": r.status, "raised": r.created_at,
                              "due_on": r.due_on, "outcome": r.outcome}
                             for r in db.scalars(select(PrivacyRequest).where(PrivacyRequest.employee_id == emp.id))],
        "immigration_documents": [{"type": d.doc_type, "number": d.number, "issuing_country": d.issuing_country,
                                   "issue_date": d.issue_date, "expiry_date": d.expiry_date, "sponsor": d.sponsor,
                                   "verification": d.verification}
                                  for d in db.scalars(select(ImmigrationDocument).where(ImmigrationDocument.employee_id == emp.id))],
        "assets": [{"tag": a.tag, "name": a.name, "category": a.category, "assigned_on": a.assigned_on,
                    "condition": a.condition} for a in db.scalars(select(Asset).where(Asset.employee_id == emp.id))],
        "asset_requests": [{"kind": r.kind, "item": r.item, "reason": r.reason, "status": r.status, "raised": r.created_at}
                           for r in db.scalars(select(AssetRequest).where(AssetRequest.employee_id == emp.id))],
        "leave_requests": [{"type": r.leave_code, "from": r.from_date, "to": r.to_date, "days": r.days, "status": r.status,
                            "reason": r.reason}
                           for r in db.scalars(select(LeaveRequest).where(LeaveRequest.employee_id == emp.id))],
        "cases_raised": [{"code": c.code, "category": c.category, "status": c.status, "raised": c.created_at}
                         for c in db.scalars(select(HrCase).where(HrCase.reporter_id == emp.id))],
        "sign_in_activity": [{"action": a.action, "at": a.at, "result": a.result, "ip": a.ip}
                             for a in db.scalars(select(AuditLog).where(AuditLog.actor_id == user.id,
                                                                        AuditLog.entity == "account")
                                                 .order_by(AuditLog.at.desc()).limit(50))],
    }
    data["summary"] = [{"section": k, "count": len(v)} for k, v in data.items() if isinstance(v, list)]
    record_audit(db, actor_id=user.id, action="privacy_data_exported", entity="privacy_export", entity_id=emp.id,
                 subject_id=emp.id, ip=client_ip(request))
    db.commit()
    return data
