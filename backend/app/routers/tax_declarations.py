"""Tax-saving declarations with proofs (rules: app/services/tax_declarations.py).

GET    /tax-declarations/config                 my country's sections, tax years, deadlines, regime; am I a verifier
GET    /tax-declarations/mine?financial_year=   my declarations (every year when no year is given)
POST   /tax-declarations                        {financial_year, section, title, amount, note, submit}
PUT    /tax-declarations/{id}                   edit a draft / rejected item before the deadline
DELETE /tax-declarations/{id}                   delete a draft / rejected item before the deadline
POST   /tax-declarations/{id}/submit            send for verification (needs a proof file)
POST   /tax-declarations/{id}/withdraw          pull a submitted item back to draft before the deadline
POST   /tax-declarations/{id}/documents?filename=   raw-body proof upload (PDF / image, 5 MB)
GET    /tax-declarations/{id}/documents/{doc}   download a proof (owner or a verifier in scope)
DELETE /tax-declarations/{id}/documents/{doc}   remove a proof from an editable item
GET    /tax-declarations/queue?status=&financial_year=&q=   Finance / HR: items of people in scope (never mine)
POST   /tax-declarations/{id}/decision          {decision: verify|reject, note, verified_amount}
PUT    /tax-declarations/admin/window             Finance / HR: set a year's dates {country_code, financial_year, ...}
GET    /tax-declarations/verified?employee_ids=  payroll: verified totals per section (payroll roles only)
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import or_, select

from app.db import utcnow
from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import Employee, TaxDeclaration, TaxDeclarationDocument, TaxDeclarationWindow
from app.services import storage
from app.services import tax_declarations as rules
from app.services.activity import notify, record_audit
from app.services.decisions import NOT_FOUND, me
from app.services.leave import today_for
from app.services.uploads import UPLOAD_OPENAPI, clean_name, read_upload

router = APIRouter(prefix="/tax-declarations", tags=["tax declarations"])
MAX_DOCS = 5


class SectionOut(BaseModel):
    code: str
    label: str
    cap: float | None
    proof: str


class WindowOut(BaseModel):
    financial_year: str
    opens_on: date
    deadline: date
    proof_deadline: date | None
    locked: bool
    open: bool
    days_left: int
    configured: bool


class ConfigOut(BaseModel):
    country_code: str
    currency: str
    has_declarations: bool
    sections: list[SectionOut]
    years: list[WindowOut]
    regime: str | None
    regime_editable: bool
    regime_note: str
    verifier: bool


class DocOut(BaseModel):
    id: str
    file_name: str
    content_type: str
    size_bytes: int
    uploaded_at: datetime


class HistoryOut(BaseModel):
    at: str
    by: str | None
    by_name: str | None = None
    action: str
    note: str | None = None


class DeclarationOut(BaseModel):
    id: str
    employee_id: str
    employee_name: str | None = None
    employee_code: str | None = None
    country_code: str
    financial_year: str
    regime: str | None
    section: str
    section_label: str
    title: str
    amount: float
    verified_amount: float | None
    currency: str
    status: str
    employee_note: str | None
    submitted_at: datetime | None
    decided_by: str | None
    decided_by_name: str | None = None
    decided_at: datetime | None
    decision_note: str | None
    created_at: datetime
    updated_at: datetime
    editable: bool
    documents: list[DocOut]
    history: list[HistoryOut]


class DeclarationIn(BaseModel):
    financial_year: str = Field(min_length=4, max_length=32)
    section: str = Field(min_length=1, max_length=32)
    title: str = Field(min_length=1, max_length=200)
    amount: float = Field(gt=0, le=100_000_000)
    note: str | None = Field(default=None, max_length=1000)
    submit: bool = False


class DecisionIn(BaseModel):
    decision: str = Field(pattern="^(verify|reject)$")
    note: str | None = Field(default=None, max_length=1000)
    verified_amount: float | None = Field(default=None, ge=0, le=100_000_000)


class WindowIn(BaseModel):
    country_code: str = Field(pattern=r"^[A-Z]{2}$")
    financial_year: str = Field(min_length=4, max_length=32)
    opens_on: date
    deadline: date
    proof_deadline: date | None = None
    locked: bool = False


class VerifiedOut(BaseModel):
    employee_id: str
    financial_year: str
    section: str
    amount: float


def _err(exc: rules.DeclarationError) -> HTTPException:
    return HTTPException(422, str(exc))


def _names(db: DbSession, ids: set[str | None]) -> dict[str, tuple[str, str]]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    return {e.id: (e.full_name, e.employee_code) for e in db.scalars(select(Employee).where(Employee.id.in_(ids)))}


def _today(user: CurrentUser) -> date:
    return today_for(user.employee) if user.employee else date.today()


def _window(db: DbSession, country: str, fy: str, today: date) -> rules.Window | None:
    start = rules.start_for_label(country, fy, today)
    return None if start is None else rules.window_for(db, country, fy, start)


def _editable(db: DbSession, item: TaxDeclaration, today: date) -> bool:
    if item.status not in rules.EDITABLE:
        return False
    win = _window(db, item.country_code, item.financial_year, today)
    return bool(win and win.open(today))


def _outs(db: DbSession, user: CurrentUser, rows: list[TaxDeclaration]) -> list[DeclarationOut]:
    if not rows:
        return []
    today = _today(user)
    docs: dict[str, list[DocOut]] = {}
    for d in db.scalars(select(TaxDeclarationDocument).where(TaxDeclarationDocument.declaration_id.in_([r.id for r in rows]))
                        .order_by(TaxDeclarationDocument.uploaded_at)):
        docs.setdefault(d.declaration_id, []).append(DocOut(id=d.id, file_name=d.file_name, content_type=d.content_type,
                                                            size_bytes=d.size_bytes, uploaded_at=d.uploaded_at))
    people = {r.employee_id for r in rows} | {r.decided_by for r in rows}
    people |= {h.get("by") for r in rows for h in (r.history or [])}
    names = _names(db, people)
    labels = {(c, s.code): s.label for c, secs in rules.SECTIONS.items() for s in secs}
    out = []
    for r in rows:
        mine = r.employee_id == user.employee_id
        out.append(DeclarationOut(
            id=r.id, employee_id=r.employee_id, employee_name=names.get(r.employee_id, (None, None))[0],
            employee_code=names.get(r.employee_id, (None, None))[1], country_code=r.country_code,
            financial_year=r.financial_year, regime=r.regime, section=r.section,
            section_label=labels.get((r.country_code, r.section), r.section), title=r.title, amount=r.amount,
            verified_amount=r.verified_amount, currency=r.currency, status=r.status, employee_note=r.employee_note,
            submitted_at=r.submitted_at, decided_by=r.decided_by,
            decided_by_name=names.get(r.decided_by or "", (None, None))[0], decided_at=r.decided_at,
            decision_note=r.decision_note, created_at=r.created_at, updated_at=r.updated_at,
            editable=mine and _editable(db, r, today), documents=docs.get(r.id, []),
            history=[HistoryOut(at=h.get("at", ""), by=h.get("by"), by_name=names.get(h.get("by") or "", (None, None))[0],
                                action=h.get("action", ""), note=h.get("note")) for h in (r.history or [])],
        ))
    return out


def _own(db: DbSession, user: CurrentUser, item_id: str) -> TaxDeclaration:
    item = db.get(TaxDeclaration, item_id)
    if item is None or item.employee_id != user.employee_id:
        raise NOT_FOUND
    return item


def _require_open(db: DbSession, item_country: str, fy: str, today: date, what: str) -> rules.Window:
    win = _window(db, item_country, fy, today)
    if win is None:
        raise HTTPException(422, "Choose the current or next tax year.")
    if win.locked:
        raise HTTPException(409, f"Declarations for {fy} are closed by Finance.")
    if today < win.opens_on:
        raise HTTPException(409, f"Declarations for {fy} open on {win.opens_on:%d %b %Y}.")
    if today > win.deadline:
        raise HTTPException(409, f"The deadline to {what} for {fy} was {win.deadline:%d %b %Y}.")
    return win


def _section(emp: Employee, code: str) -> rules.Section:
    for s in rules.sections_for(emp.country_code):
        if s.code == code:
            return s
    raise HTTPException(422, "Choose a section from the list.")


def _check_regime(emp: Employee) -> None:
    if emp.country_code == "IN" and (emp.tax_regime or "new") != "old":
        raise HTTPException(409, "The new tax regime has no deductions to declare. Switch to the old regime first.")


def _audit(db: DbSession, user: CurrentUser, request: Request, action: str, item: TaxDeclaration, extra: dict[str, Any] | None = None) -> None:
    # Amounts stay out of the audit log: the section, year and status say what happened.
    record_audit(db, actor_id=user.id, action=action, entity="tax_declaration", entity_id=item.id, subject_id=item.employee_id,
                 after={"section": item.section, "financial_year": item.financial_year, "status": item.status, **(extra or {})},
                 ip=client_ip(request))


def _verifiers(db: DbSession, emp: Employee) -> list[str]:
    from app.models import Account
    from app.services.scope import build_scope

    out = []
    for acc in db.scalars(select(Account).where(Account.role.in_(sorted(rules.VERIFY_ROLES)), Account.employee_id.is_not(None))):
        if acc.employee_id == emp.id:
            continue
        if acc.role in rules.HR_ROLES and not build_scope(db, acc).can_see(emp):
            continue
        out.append(acc.employee_id)
    return out


# ---------- config ----------
@router.get("/config", response_model=ConfigOut)
def config(db: DbSession, user: CurrentUserDep) -> ConfigOut:
    emp = me(user)
    today = today_for(emp)
    years = []
    for label, start in rules.declarable_years(emp.country_code, today):
        w = rules.window_for(db, emp.country_code, label, start)
        years.append(WindowOut(financial_year=label, opens_on=w.opens_on, deadline=w.deadline, proof_deadline=w.proof_deadline,
                               locked=w.locked, open=w.open(today), days_left=max(0, (w.deadline - today).days),
                               configured=w.configured))
    regime = (emp.tax_regime or "new") if emp.country_code == "IN" else None
    current = years[0] if years else None
    editable = bool(regime and current and current.open)
    note = ("" if not regime else
            f"You can change the regime until {current.deadline:%d %b %Y}." if editable and current else
            "The regime for this tax year is closed; Finance can reopen it.")
    rules.remind_deadline(db, emp, today)
    return ConfigOut(country_code=emp.country_code, currency=rules.CURRENCY.get(emp.country_code, emp.currency),
                     has_declarations=bool(rules.sections_for(emp.country_code)),
                     sections=[SectionOut(code=s.code, label=s.label, cap=s.cap, proof=s.proof) for s in rules.sections_for(emp.country_code)],
                     years=years, regime=regime, regime_editable=editable, regime_note=note, verifier=rules.is_verifier(user))


# ---------- mine ----------
@router.get("/mine", response_model=list[DeclarationOut])
def mine(db: DbSession, user: CurrentUserDep, financial_year: Annotated[str | None, Query(max_length=32)] = None) -> list[DeclarationOut]:
    emp = me(user)
    stmt = select(TaxDeclaration).where(TaxDeclaration.employee_id == emp.id)
    if financial_year:
        stmt = stmt.where(TaxDeclaration.financial_year == financial_year)
    return _outs(db, user, list(db.scalars(stmt.order_by(TaxDeclaration.created_at.desc()))))


@router.post("", response_model=DeclarationOut, status_code=status.HTTP_201_CREATED)
def create(body: DeclarationIn, request: Request, db: DbSession, user: CurrentUserDep) -> DeclarationOut:
    emp = me(user)
    today = today_for(emp)
    if not rules.sections_for(emp.country_code):
        raise HTTPException(422, "There are no tax declarations in your country.")
    _check_regime(emp)
    fy = body.financial_year.strip()
    if fy not in [label for label, _ in rules.declarable_years(emp.country_code, today)]:
        raise HTTPException(422, "Choose the current or next tax year.")
    _require_open(db, emp.country_code, fy, today, "declare")
    section = _section(emp, body.section)
    amount = round(body.amount, 2)
    try:
        rules.check_amount(emp.country_code, section, amount, rules.declared_elsewhere(db, emp.id, fy, section.code, None))
    except rules.DeclarationError as exc:
        raise _err(exc) from exc
    if body.submit:
        raise HTTPException(422, "Save the item, add a proof file, then submit it.")
    item = TaxDeclaration(id=rules.new_id("td"), employee_id=emp.id, country_code=emp.country_code, financial_year=fy,
                          regime=emp.tax_regime if emp.country_code == "IN" else None, section=section.code,
                          title=body.title.strip(), amount=amount, currency=rules.CURRENCY.get(emp.country_code, emp.currency),
                          status="draft", employee_note=(body.note or "").strip() or None, history=[])
    rules.log(item, emp.id, "Saved as draft")
    db.add(item)
    db.flush()
    _audit(db, user, request, "tax_declaration_created", item)
    db.commit()
    return _outs(db, user, [item])[0]


@router.put("/{item_id}", response_model=DeclarationOut)
def update(item_id: str, body: DeclarationIn, request: Request, db: DbSession, user: CurrentUserDep) -> DeclarationOut:
    item = _own(db, user, item_id)
    emp = me(user)
    today = today_for(emp)
    if item.status not in rules.EDITABLE:
        raise HTTPException(409, "Only drafts and rejected items can be changed. Withdraw a submitted item first.")
    _check_regime(emp)
    _require_open(db, item.country_code, item.financial_year, today, "change declarations")
    if body.financial_year.strip() != item.financial_year:
        raise HTTPException(422, "The tax year of an item can't change; add a new item instead.")
    section = _section(emp, body.section)
    amount = round(body.amount, 2)
    try:
        rules.check_amount(emp.country_code, section, amount, rules.declared_elsewhere(db, emp.id, item.financial_year, section.code, item.id))
    except rules.DeclarationError as exc:
        raise _err(exc) from exc
    item.section, item.title, item.amount = section.code, body.title.strip(), amount
    item.employee_note = (body.note or "").strip() or None
    if item.status == "rejected":
        item.status = "draft"
    rules.log(item, emp.id, "Edited")
    _audit(db, user, request, "tax_declaration_updated", item)
    db.commit()
    return _outs(db, user, [item])[0]


@router.delete("/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove(item_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> None:
    item = _own(db, user, item_id)
    if item.status not in rules.EDITABLE:
        raise HTTPException(409, "Only drafts and rejected items can be deleted. Withdraw a submitted item first.")
    _require_open(db, item.country_code, item.financial_year, today_for(me(user)), "delete declarations")
    paths = [d.storage_path for d in db.scalars(select(TaxDeclarationDocument).where(TaxDeclarationDocument.declaration_id == item.id))]
    _audit(db, user, request, "tax_declaration_deleted", item)
    db.delete(item)
    db.commit()
    for p in paths:
        storage.delete_quietly(p)


@router.post("/{item_id}/submit", response_model=DeclarationOut)
def submit(item_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> DeclarationOut:
    item = _own(db, user, item_id)
    emp = me(user)
    if item.status not in rules.EDITABLE:
        raise HTTPException(409, "This item has already been submitted.")
    _check_regime(emp)
    _require_open(db, item.country_code, item.financial_year, today_for(emp), "submit declarations")
    if not db.scalar(select(TaxDeclarationDocument.id).where(TaxDeclarationDocument.declaration_id == item.id)):
        raise HTTPException(422, "Attach a proof file before submitting.")
    item.status, item.submitted_at = "submitted", utcnow()
    item.decided_by = item.decided_at = item.decision_note = None
    item.verified_amount = None
    item.regime = emp.tax_regime if emp.country_code == "IN" else None
    rules.log(item, emp.id, "Submitted for verification")
    _audit(db, user, request, "tax_declaration_submitted", item)
    for vid in _verifiers(db, emp):
        notify(db, recipient_id=vid, title=f"Verify tax proof: {emp.full_name}",
               body=f"{item.section} · {item.financial_year}", href="/investment?tab=verify")
    db.commit()
    return _outs(db, user, [item])[0]


@router.post("/{item_id}/withdraw", response_model=DeclarationOut)
def withdraw(item_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> DeclarationOut:
    item = _own(db, user, item_id)
    if item.status != "submitted":
        raise HTTPException(409, "Only items waiting for verification can be withdrawn.")
    _require_open(db, item.country_code, item.financial_year, today_for(me(user)), "withdraw declarations")
    item.status, item.submitted_at = "draft", None
    rules.log(item, item.employee_id, "Withdrawn to draft")
    _audit(db, user, request, "tax_declaration_withdrawn", item)
    db.commit()
    return _outs(db, user, [item])[0]


# ---------- proofs ----------
@router.post("/{item_id}/documents", response_model=DeclarationOut, status_code=status.HTTP_201_CREATED, openapi_extra=UPLOAD_OPENAPI)
async def upload(item_id: str, request: Request, db: DbSession, user: CurrentUserDep,
                 filename: Annotated[str | None, Query(max_length=255)] = None) -> DeclarationOut:
    item = _own(db, user, item_id)
    if item.status not in rules.EDITABLE:
        raise HTTPException(409, "Proofs can be added to drafts and rejected items. Withdraw a submitted item first.")
    _require_open(db, item.country_code, item.financial_year, today_for(me(user)), "add proofs")
    count = len(db.scalars(select(TaxDeclarationDocument.id).where(TaxDeclarationDocument.declaration_id == item.id)).all())
    if count >= MAX_DOCS:
        raise HTTPException(422, f"Up to {MAX_DOCS} files per item.")
    data, content_type, sha = await read_upload(request)
    doc_id = rules.new_id("tdd")
    stored = storage.save(f"tax-declarations/{item.employee_id}", doc_id, data, content_type, sha)
    db.add(TaxDeclarationDocument(id=doc_id, declaration_id=item.id, file_name=clean_name(filename, content_type, "proof"),
                                  content_type=stored.content_type, size_bytes=stored.size_bytes, sha256=stored.sha256,
                                  storage_path=stored.relative_path, uploaded_by=user.employee_id, uploaded_at=utcnow()))
    rules.log(item, user.employee_id, "Proof added", clean_name(filename, content_type, "proof"))
    _audit(db, user, request, "tax_declaration_proof_added", item, {"file_id": doc_id})
    try:
        db.commit()
    except Exception:
        storage.delete_quietly(stored.relative_path)
        raise
    return _outs(db, user, [item])[0]


def _doc(db: DbSession, item: TaxDeclaration, doc_id: str) -> TaxDeclarationDocument:
    doc = db.get(TaxDeclarationDocument, doc_id)
    if doc is None or doc.declaration_id != item.id:
        raise NOT_FOUND
    return doc


@router.get("/{item_id}/documents/{doc_id}")
def download(item_id: str, doc_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> Response:
    item = db.get(TaxDeclaration, item_id)
    emp = db.get(Employee, item.employee_id) if item else None
    if item is None or emp is None or (item.employee_id != user.employee_id and not rules.can_verify(db, user, emp)):
        raise NOT_FOUND
    doc = _doc(db, item, doc_id)
    try:
        response = storage.download(doc.storage_path, media_type=doc.content_type, filename=doc.file_name)
    except storage.FileMissing as exc:
        raise HTTPException(410, "The file is no longer available.") from exc
    except storage.StorageError as exc:
        raise NOT_FOUND from exc
    if item.employee_id != user.employee_id:
        record_audit(db, actor_id=user.id, action="tax_declaration_proof_viewed", entity="tax_declaration", entity_id=item.id,
                     subject_id=item.employee_id, after={"file_id": doc.id}, ip=client_ip(request))
        db.commit()
    return response


@router.delete("/{item_id}/documents/{doc_id}", response_model=DeclarationOut)
def remove_doc(item_id: str, doc_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> DeclarationOut:
    item = _own(db, user, item_id)
    if item.status not in rules.EDITABLE:
        raise HTTPException(409, "Proofs of a submitted item can't be removed. Withdraw it first.")
    _require_open(db, item.country_code, item.financial_year, today_for(me(user)), "change proofs")
    doc = _doc(db, item, doc_id)
    path = doc.storage_path
    rules.log(item, user.employee_id, "Proof removed", doc.file_name)
    db.delete(doc)
    _audit(db, user, request, "tax_declaration_proof_removed", item, {"file_id": doc_id})
    db.commit()
    storage.delete_quietly(path)
    return _outs(db, user, [item])[0]


# ---------- verification ----------
@router.get("/queue", response_model=list[DeclarationOut])
def queue(db: DbSession, user: CurrentUserDep,
          status_: Annotated[str, Query(alias="status", pattern="^(submitted|verified|rejected|decided|all)$")] = "submitted",
          financial_year: Annotated[str | None, Query(max_length=32)] = None,
          q: Annotated[str | None, Query(max_length=100)] = None) -> list[DeclarationOut]:
    if not rules.is_verifier(user):
        raise HTTPException(403, "Only Finance or HR can verify tax declarations.")
    stmt = (select(TaxDeclaration).join(Employee, Employee.id == TaxDeclaration.employee_id)
            .where(TaxDeclaration.employee_id != (user.employee_id or ""), TaxDeclaration.status != "draft"))
    if status_ == "decided":
        stmt = stmt.where(TaxDeclaration.status.in_(("verified", "rejected")))
    elif status_ != "all":
        stmt = stmt.where(TaxDeclaration.status == status_)
    if financial_year:
        stmt = stmt.where(TaxDeclaration.financial_year == financial_year)
    if q and q.strip():
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(Employee.full_name.ilike(like), Employee.employee_code.ilike(like),
                              TaxDeclaration.section.ilike(like), TaxDeclaration.title.ilike(like)))
    rows = [r for r, e in db.execute(stmt.add_columns(Employee).order_by(TaxDeclaration.submitted_at.desc()).limit(500)).all()
            if rules.can_verify(db, user, e)]
    return _outs(db, user, rows)


@router.post("/{item_id}/decision", response_model=DeclarationOut)
def decide(item_id: str, body: DecisionIn, request: Request, db: DbSession, user: CurrentUserDep) -> DeclarationOut:
    item = db.get(TaxDeclaration, item_id)
    emp = db.get(Employee, item.employee_id) if item else None
    if item is None or emp is None:
        raise NOT_FOUND
    if emp.id == user.employee_id:
        raise HTTPException(403, "You can't verify your own declarations.")
    if not rules.can_verify(db, user, emp):
        raise HTTPException(403, "Only Finance or HR in this person's scope can verify their declarations.")
    if item.status != "submitted":
        raise HTTPException(409, "This item has already been reviewed." if item.status in ("verified", "rejected") else "This item isn't submitted.")
    note = (body.note or "").strip() or None
    if body.decision == "reject":
        if not note:
            raise HTTPException(422, "Say why the proof is rejected.")
        item.status, item.verified_amount = "rejected", None
    else:
        allowed = body.verified_amount if body.verified_amount is not None else item.amount
        if allowed <= 0 or allowed > item.amount:
            raise HTTPException(422, "The verified amount must be above zero and no more than the amount declared.")
        item.status, item.verified_amount = "verified", round(allowed, 2)
    item.decided_by, item.decided_at, item.decision_note = user.employee_id or user.id, utcnow(), note
    rules.log(item, user.employee_id or user.id, "Verified" if item.status == "verified" else "Rejected", note)
    _audit(db, user, request, f"tax_declaration_{item.status}", item, {"note": note} if note else None)
    notify(db, recipient_id=emp.id, title=f"Tax proof {item.status}: {item.section} · {item.financial_year}",
           body=(note or "It now counts toward your tax (old regime)." if item.status == "verified" else note or ""),
           href=f"/investment?item={item.id}")
    db.commit()
    return _outs(db, user, [item])[0]


@router.put("/admin/window", response_model=WindowOut)
def set_window(body: WindowIn, request: Request, db: DbSession, user: CurrentUserDep) -> WindowOut:
    if not rules.is_verifier(user):
        raise HTTPException(403, "Only Finance or HR can set declaration deadlines.")
    if body.deadline < body.opens_on:
        raise HTTPException(422, "The deadline must be after the opening date.")
    if body.proof_deadline and body.proof_deadline < body.deadline:
        raise HTTPException(422, "The proof deadline can't be before the declaration deadline.")
    row = db.scalar(select(TaxDeclarationWindow).where(TaxDeclarationWindow.country_code == body.country_code,
                                                       TaxDeclarationWindow.financial_year == body.financial_year))
    before = None if row is None else {"opens_on": row.opens_on, "deadline": row.deadline, "locked": row.locked}
    if row is None:
        row = TaxDeclarationWindow(id=rules.new_id("tdw"), country_code=body.country_code, financial_year=body.financial_year,
                                   opens_on=body.opens_on, deadline=body.deadline)
        db.add(row)
    row.opens_on, row.deadline, row.proof_deadline, row.locked, row.updated_by = (
        body.opens_on, body.deadline, body.proof_deadline, body.locked, user.id)
    record_audit(db, actor_id=user.id, action="tax_declaration_window_set", entity="tax_declaration_window", entity_id=row.id,
                 before=before, after={"opens_on": row.opens_on, "deadline": row.deadline, "locked": row.locked}, ip=client_ip(request))
    db.commit()
    today = _today(user)
    w = rules.Window(row.financial_year, row.opens_on, row.deadline, row.proof_deadline, row.locked, True)
    return WindowOut(financial_year=w.financial_year, opens_on=w.opens_on, deadline=w.deadline, proof_deadline=w.proof_deadline,
                     locked=w.locked, open=w.open(today), days_left=max(0, (w.deadline - today).days), configured=True)


def verified_for(db: DbSession, employee_ids: list[str]) -> list[VerifiedOut]:
    """Verified amounts per person, year and section (payroll inputs)."""
    if not employee_ids:
        return []
    rows = db.scalars(select(TaxDeclaration).where(TaxDeclaration.employee_id.in_(employee_ids), TaxDeclaration.status == "verified"))
    return [VerifiedOut(employee_id=r.employee_id, financial_year=r.financial_year, section=r.section,
                        amount=r.verified_amount if r.verified_amount is not None else r.amount) for r in rows]
