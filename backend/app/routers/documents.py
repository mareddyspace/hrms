"""Employee documents (versioned uploads), letters (templates, requests, approval, PDF issue) and policy acknowledgments.

Uploads are the raw request body (Content-Type: the file's type), at most 10 MB: PDF, image or Word (.docx).
Rules: app/services/documents.py and app/services/letters.py.
"""

from __future__ import annotations

import uuid
from datetime import date, timedelta
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import FileResponse
from sqlalchemy import select

from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import (
    ApprovalInstance,
    DocumentVersion,
    Employee,
    EmployeeDocument,
    LetterIssue,
    LetterRequest,
    LetterTemplate,
    PolicyAcknowledgment,
)
from app.schemas import DecisionIn
from app.schemas.documents import (
    DocExpiryIn,
    DocRulesOut,
    DocVersionOut,
    EmployeeDocumentOut,
    LetterIssueOut,
    LetterPreviewOut,
    LetterRequestIn,
    LetterRequestOut,
    LetterTemplateIn,
    LetterTemplateNewIn,
    LetterTemplateOut,
    LetterTypeOut,
    PolicyAckIn,
    PolicyAckOut,
)
from app.services import approvals as engine
from app.services import documents as docs
from app.services import letters
from app.services import storage
from app.services.activity import record_audit
from app.services.approval_targets import start_about
from app.services.decisions import NOT_FOUND, can_view, me, target
from app.services.leave import today_for
from app.services.scope import HR_ROLES
from app.services.workflow_defaults import decide_http, waiting_entity_ids

router = APIRouter(prefix="/documents", tags=["documents"])
letters_router = APIRouter(prefix="/letters", tags=["letters"])

_UPLOAD_DOC = {"requestBody": {"required": True, "content": {t: {"schema": {"type": "string", "format": "binary"}}
                                                             for t in docs.DOCUMENT_TYPES}}}


def _today(user: CurrentUser) -> date:
    return today_for(user.employee) if user.employee else date.today()


# ---------- documents ----------
def _doc_outs(db: DbSession, rows: list[EmployeeDocument], today: date, with_versions: bool = False) -> list[EmployeeDocumentOut]:
    if not rows:
        return []
    names = dict(db.execute(select(Employee.id, Employee.full_name).where(Employee.id.in_({r.employee_id for r in rows}))).all())
    out = []
    for d in rows:
        item = EmployeeDocumentOut.model_validate(d)
        item.employee_name = names.get(d.employee_id)
        item.days_to_expiry = (d.expiry_date - today).days if d.expiry_date else None
        if with_versions:
            item.versions = [DocVersionOut.model_validate(v) for v in db.scalars(
                select(DocumentVersion).where(DocumentVersion.document_id == d.id).order_by(DocumentVersion.version.desc()))]
        out.append(item)
    return out


def _visible_doc(db: DbSession, user: CurrentUser, document_id: str) -> tuple[EmployeeDocument, Employee]:
    doc = db.get(EmployeeDocument, document_id)
    owner = db.get(Employee, doc.employee_id) if doc else None
    if doc is None or owner is None or not docs.can_see_document(db, user, doc, owner):
        raise NOT_FOUND
    return doc, owner


async def _read_upload(request: Request) -> tuple[bytes, str, str]:
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > docs.MAX_DOCUMENT_BYTES:
        raise HTTPException(413, "The file is larger than 10 MB.")
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > docs.MAX_DOCUMENT_BYTES:
            raise HTTPException(413, "The file is larger than 10 MB.")
    try:
        content_type, sha = docs.check_upload(bytes(data), request.headers.get("content-type"))
    except docs.DocumentError as exc:
        msg = str(exc)
        raise HTTPException(413 if "10 MB" in msg else 415 if "accepted" in msg or "match" in msg else 422, msg) from exc
    return bytes(data), content_type, sha


def _store_version(db: DbSession, user: CurrentUser, doc: EmployeeDocument, data: bytes, content_type: str,
                   filename: str | None) -> DocumentVersion:
    vid = f"dv-{uuid.uuid4().hex[:12]}"
    saved = docs.save_bytes(f"documents/{doc.employee_id}", vid, data, content_type)
    version = DocumentVersion(id=vid, document_id=doc.id, version=doc.current_version + 1,
                              file_name=docs.clean_name(filename, content_type), content_type=content_type,
                              size_bytes=saved.size_bytes, sha256=saved.sha256, storage_path=saved.relative_path,
                              uploaded_by=user.id)
    db.add(version)
    doc.current_version = version.version
    return version


@router.get("/rules", response_model=DocRulesOut)
def document_rules(user: CurrentUserDep) -> DocRulesOut:
    return DocRulesOut(categories=list(docs.DOCUMENT_CATEGORIES), manager_categories=sorted(docs.MANAGER_CATEGORIES),
                       max_bytes=docs.MAX_DOCUMENT_BYTES, content_types=sorted(docs.DOCUMENT_TYPES))


@router.get("", response_model=list[EmployeeDocumentOut])
def list_documents(db: DbSession, user: CurrentUserDep, employee_id: str | None = None,
                   category: Annotated[str | None, Query(max_length=32)] = None) -> list[EmployeeDocumentOut]:
    """One person's documents that you may see (yourself by default)."""
    emp = me(user) if not employee_id or employee_id == user.employee_id else db.get(Employee, employee_id)
    if emp is None or not can_view(db, user, emp):
        raise NOT_FOUND
    stmt = select(EmployeeDocument).where(EmployeeDocument.employee_id == emp.id)
    if category:
        stmt = stmt.where(EmployeeDocument.category == category)
    rows = [d for d in db.scalars(stmt.order_by(EmployeeDocument.created_at.desc())) if docs.can_see_document(db, user, d, emp)]
    return _doc_outs(db, rows, _today(user))


@router.get("/expiring", response_model=list[EmployeeDocumentOut])
def expiring_documents(db: DbSession, user: CurrentUserDep, days: Annotated[int, Query(ge=0, le=365)] = 30,
                       include_expired: bool = True) -> list[EmployeeDocumentOut]:
    """Documents expiring within `days` (and already expired): yours, your reports' manager-visible ones, HR's scope."""
    today = _today(user)
    stmt = select(EmployeeDocument).join(Employee, Employee.id == EmployeeDocument.employee_id).where(
        EmployeeDocument.expiry_date.is_not(None), EmployeeDocument.expiry_date <= today + timedelta(days=days))
    if not include_expired:
        stmt = stmt.where(EmployeeDocument.expiry_date >= today)
    stmt = stmt.where(user.scope.employee_filter())
    rows = []
    for d in db.scalars(stmt.order_by(EmployeeDocument.expiry_date)):
        owner = db.get(Employee, d.employee_id)
        if owner is not None and docs.can_see_document(db, user, d, owner):
            rows.append(d)
    return _doc_outs(db, rows, today)


@router.post("", response_model=EmployeeDocumentOut, status_code=status.HTTP_201_CREATED, openapi_extra=_UPLOAD_DOC)
async def upload_document(
    request: Request, db: DbSession, user: CurrentUserDep,
    category: Annotated[str, Query(max_length=32)],
    title: Annotated[str, Query(min_length=1, max_length=200)],
    employee_id: str | None = None,
    expiry_date: date | None = None,
    filename: Annotated[str | None, Query(max_length=255)] = None,
) -> EmployeeDocumentOut:
    """A new document (version 1) for yourself, or (HR) for someone in your scope."""
    if category not in docs.DOCUMENT_CATEGORIES:
        raise HTTPException(422, f"Choose a category: {', '.join(c for c in docs.DOCUMENT_CATEGORIES if c != docs.LETTERS_CATEGORY)}.")
    if category == docs.LETTERS_CATEGORY:
        raise HTTPException(422, "Letters are added when HR issues them.")
    owner = me(user) if not employee_id or employee_id == user.employee_id else db.get(Employee, employee_id)
    if owner is None or not can_view(db, user, owner):
        raise NOT_FOUND
    if not docs.can_upload_for(user, owner):
        raise HTTPException(403, "Only the employee or HR can add documents.")
    data, content_type, _sha = await _read_upload(request)
    doc = EmployeeDocument(id=f"doc-{uuid.uuid4().hex[:12]}", employee_id=owner.id, category=category, title=title.strip(),
                           current_version=0, expiry_date=expiry_date, uploaded_by=user.id)
    db.add(doc)
    db.flush()
    version = _store_version(db, user, doc, data, content_type, filename)
    record_audit(db, actor_id=user.id, action="document_uploaded", entity="employee_document", entity_id=doc.id,
                 subject_id=owner.id, after={"category": category, "title": doc.title, "version": 1, "expiry_date": expiry_date,
                                             "content_type": content_type, "sha256": version.sha256}, ip=client_ip(request))
    try:
        db.commit()
    except Exception:
        storage.delete_quietly(version.storage_path)
        raise
    return _doc_outs(db, [doc], _today(user), with_versions=True)[0]


@router.post("/{document_id}/versions", response_model=EmployeeDocumentOut, status_code=status.HTTP_201_CREATED,
             openapi_extra=_UPLOAD_DOC)
async def upload_version(
    document_id: str, request: Request, db: DbSession, user: CurrentUserDep,
    expiry_date: date | None = None, filename: Annotated[str | None, Query(max_length=255)] = None,
) -> EmployeeDocumentOut:
    """A new version of a document (older versions stay downloadable). expiry_date replaces the old one when given."""
    doc, owner = _visible_doc(db, user, document_id)
    if doc.category == docs.LETTERS_CATEGORY:
        raise HTTPException(422, "Letters get new versions only when HR regenerates them.")
    if not docs.can_upload_for(user, owner):
        raise HTTPException(403, "Only the employee or HR can add versions.")
    data, content_type, _sha = await _read_upload(request)
    version = _store_version(db, user, doc, data, content_type, filename)
    if expiry_date is not None:
        doc.expiry_date = expiry_date
    record_audit(db, actor_id=user.id, action="document_version_added", entity="employee_document", entity_id=doc.id,
                 subject_id=owner.id, after={"version": version.version, "expiry_date": doc.expiry_date, "sha256": version.sha256},
                 ip=client_ip(request))
    try:
        db.commit()
    except Exception:
        storage.delete_quietly(version.storage_path)
        raise
    return _doc_outs(db, [doc], _today(user), with_versions=True)[0]


@router.get("/policy-acks", response_model=list[PolicyAckOut])
def list_policy_acks(db: DbSession, user: CurrentUserDep, employee_id: str | None = None, policy_id: str | None = None,
                     ) -> list[PolicyAcknowledgment]:
    """Your acknowledgments; HR may pass employee_id (in scope) or policy_id alone (everyone in scope)."""
    stmt = select(PolicyAcknowledgment)
    if employee_id is None and policy_id and user.account.role in HR_ROLES:
        stmt = stmt.join(Employee, Employee.id == PolicyAcknowledgment.employee_id).where(user.scope.employee_filter())
    else:
        emp = target(db, user, employee_id)
        if emp.id != user.employee_id and user.account.role not in HR_ROLES:
            raise HTTPException(403, "Only HR can see someone else's acknowledgments.")
        stmt = stmt.where(PolicyAcknowledgment.employee_id == emp.id)
    if policy_id:
        stmt = stmt.where(PolicyAcknowledgment.policy_id == policy_id)
    return list(db.scalars(stmt.order_by(PolicyAcknowledgment.acknowledged_at.desc())))


@router.post("/policy-acks", response_model=PolicyAckOut, status_code=status.HTTP_201_CREATED)
def acknowledge_policy(body: PolicyAckIn, request: Request, db: DbSession, user: CurrentUserDep) -> PolicyAcknowledgment:
    emp = me(user)
    if db.scalar(select(PolicyAcknowledgment.id).where(PolicyAcknowledgment.employee_id == emp.id,
                                                       PolicyAcknowledgment.policy_id == body.policy_id,
                                                       PolicyAcknowledgment.policy_version == body.policy_version)):
        raise HTTPException(409, "You have already acknowledged this version of the policy.")
    ack = PolicyAcknowledgment(employee_id=emp.id, policy_id=body.policy_id.strip(), policy_version=body.policy_version.strip(),
                               ip=client_ip(request))
    db.add(ack)
    db.flush()
    record_audit(db, actor_id=user.id, action="policy_acknowledged", entity="policy", entity_id=ack.policy_id, subject_id=emp.id,
                 after={"version": ack.policy_version}, ip=client_ip(request))
    db.commit()
    return ack


@router.get("/{document_id}", response_model=EmployeeDocumentOut)
def get_document(document_id: str, db: DbSession, user: CurrentUserDep) -> EmployeeDocumentOut:
    doc, _ = _visible_doc(db, user, document_id)
    return _doc_outs(db, [doc], _today(user), with_versions=True)[0]


@router.patch("/{document_id}", response_model=EmployeeDocumentOut)
def set_expiry(document_id: str, body: DocExpiryIn, request: Request, db: DbSession, user: CurrentUserDep) -> EmployeeDocumentOut:
    doc, owner = _visible_doc(db, user, document_id)
    if not docs.can_upload_for(user, owner) or doc.category == docs.LETTERS_CATEGORY:
        raise HTTPException(403, "Only the employee or HR can change this document.")
    before = doc.expiry_date
    doc.expiry_date = body.expiry_date
    record_audit(db, actor_id=user.id, action="document_expiry_changed", entity="employee_document", entity_id=doc.id,
                 subject_id=owner.id, before={"expiry_date": before}, after={"expiry_date": body.expiry_date}, ip=client_ip(request))
    db.commit()
    return _doc_outs(db, [doc], _today(user), with_versions=True)[0]


def _file_response(db: DbSession, user: CurrentUser, version: DocumentVersion, subject_id: str, request: Request,
                   entity: str, entity_id: str) -> FileResponse:
    try:
        path = storage.resolve(version.storage_path)
    except storage.StorageError as exc:
        raise NOT_FOUND from exc
    if not path.is_file():
        raise HTTPException(410, "The file is no longer available.")
    record_audit(db, actor_id=user.id, action="document_downloaded", entity=entity, entity_id=entity_id, subject_id=subject_id,
                 after={"version": version.version, "file": version.id}, ip=client_ip(request))
    db.commit()
    return FileResponse(path, media_type=version.content_type, filename=version.file_name,
                        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store"})


@router.get("/{document_id}/download", response_class=FileResponse)
def download_document(document_id: str, request: Request, db: DbSession, user: CurrentUserDep,
                      version: Annotated[int | None, Query(ge=1)] = None) -> FileResponse:
    doc, owner = _visible_doc(db, user, document_id)
    row = db.scalar(select(DocumentVersion).where(DocumentVersion.document_id == doc.id,
                                                  DocumentVersion.version == (version or doc.current_version)))
    if row is None:
        raise NOT_FOUND
    return _file_response(db, user, row, owner.id, request, "employee_document", doc.id)


# ---------- letters ----------
def _is_letter_hr(user: CurrentUser, emp: Employee) -> bool:
    return user.account.role in HR_ROLES and user.scope.can_see(emp)


def _letter_instance(db: DbSession, req: LetterRequest) -> ApprovalInstance | None:
    return db.get(ApprovalInstance, req.approval_instance_id) if req.approval_instance_id else None


def _is_letter_approver(db: DbSession, req: LetterRequest, employee_id: str | None) -> bool:
    inst = _letter_instance(db, req)
    return bool(inst and employee_id and any(employee_id in ids for s in inst.steps for ids in s["groups"].values()))


def _can_see_letter(db: DbSession, user: CurrentUser, req: LetterRequest, emp: Employee) -> bool:
    if req.employee_id == user.employee_id and req.requested_by != user.employee_id:
        # Sensitive letters raised by someone else stay hidden from their subject until issued.
        return req.letter_type not in letters.SENSITIVE_TYPES or req.status == "issued"
    if req.employee_id == user.employee_id or req.requested_by == user.employee_id:
        return True
    return _is_letter_hr(user, emp) or _is_letter_approver(db, req, user.employee_id)


def _visible_letter(db: DbSession, user: CurrentUser, request_id: str) -> tuple[LetterRequest, Employee]:
    req = db.get(LetterRequest, request_id)
    emp = db.get(Employee, req.employee_id) if req else None
    if req is None or emp is None or not _can_see_letter(db, user, req, emp):
        raise NOT_FOUND
    return req, emp


def _letter_outs(db: DbSession, rows: list[LetterRequest]) -> list[LetterRequestOut]:
    if not rows:
        return []
    names = dict(db.execute(select(Employee.id, Employee.full_name).where(Employee.id.in_({r.employee_id for r in rows}))).all())
    out = []
    for r in rows:
        item = LetterRequestOut.model_validate(r)
        item.employee_name = names.get(r.employee_id)
        inst = _letter_instance(db, r)
        item.approval_status = inst.status if inst else None
        item.issues = [LetterIssueOut.model_validate(i) for i in db.scalars(
            select(LetterIssue).where(LetterIssue.request_id == r.id).order_by(LetterIssue.version))]
        out.append(item)
    return out


@letters_router.get("/types", response_model=list[LetterTypeOut])
def letter_types(user: CurrentUserDep) -> list[LetterTypeOut]:
    return [LetterTypeOut(type=t, label=i["label"], employee_can_request=i["employee"], pay_letter=i["pay"],
                          details_label=i.get("details"), effective_input=bool(i.get("effective")),
                          second_approval=bool(i.get("second")), sensitive=t in letters.SENSITIVE_TYPES)
            for t, i in letters.LETTER_TYPES.items()]


@letters_router.get("/templates", response_model=list[LetterTemplateOut])
def list_templates(db: DbSession, user: CurrentUserDep, letter_type: str | None = None,
                   country: Annotated[str | None, Query(pattern=r"^[A-Z]{2}$")] = None) -> list[LetterTemplate]:
    stmt = select(LetterTemplate)
    if letter_type:
        stmt = stmt.where(LetterTemplate.letter_type == letter_type)
    rows = list(db.scalars(stmt.order_by(LetterTemplate.letter_type, LetterTemplate.country_code)))
    if country:  # the template that applies in that country, per type
        by_type: dict[str, LetterTemplate] = {}
        for t in rows:
            if t.country_code == country or (t.country_code is None and t.letter_type not in by_type):
                by_type[t.letter_type] = t
        rows = list(by_type.values())
    return rows


def _require_template_hr(user: CurrentUser) -> None:
    if user.account.role not in HR_ROLES:
        raise HTTPException(403, "Only HR can change letter templates.")


@letters_router.post("/templates", response_model=LetterTemplateOut, status_code=status.HTTP_201_CREATED)
def create_country_template(body: LetterTemplateNewIn, request: Request, db: DbSession, user: CurrentUserDep) -> LetterTemplate:
    """A country version of a letter type (used instead of the default in that country)."""
    _require_template_hr(user)
    if db.scalar(select(LetterTemplate.id).where(LetterTemplate.letter_type == body.letter_type,
                                                 LetterTemplate.country_code == body.country_code)):
        raise HTTPException(409, "This country already has its own template for this letter. Edit it instead.")
    try:
        letters.check_template_text(body.paragraphs)
    except letters.LetterError as exc:
        raise HTTPException(422, str(exc)) from exc
    row = LetterTemplate(id=f"lt-{uuid.uuid4().hex[:12]}", letter_type=body.letter_type, country_code=body.country_code,
                         title=body.title.strip(), to_whom=body.to_whom, paragraphs=[p.strip() for p in body.paragraphs],
                         version=1, active=True, updated_by=user.id)
    db.add(row)
    record_audit(db, actor_id=user.id, action="letter_template_created", entity="letter_template", entity_id=row.id,
                 after=body.model_dump(), ip=client_ip(request))
    db.commit()
    return row


@letters_router.put("/templates/{template_id}", response_model=LetterTemplateOut)
def update_template(template_id: str, body: LetterTemplateIn, request: Request, db: DbSession, user: CurrentUserDep) -> LetterTemplate:
    """New wording (version + 1). Letters already issued keep their PDF."""
    _require_template_hr(user)
    row = db.get(LetterTemplate, template_id)
    if row is None:
        raise NOT_FOUND
    try:
        letters.check_template_text(body.paragraphs)
    except letters.LetterError as exc:
        raise HTTPException(422, str(exc)) from exc
    before = {"title": row.title, "to_whom": row.to_whom, "paragraphs": row.paragraphs, "version": row.version}
    row.title, row.to_whom, row.paragraphs = body.title.strip(), body.to_whom, [p.strip() for p in body.paragraphs]
    row.version, row.updated_by = row.version + 1, user.id
    record_audit(db, actor_id=user.id, action="letter_template_updated", entity="letter_template", entity_id=row.id,
                 before=before, after=body.model_dump() | {"version": row.version}, ip=client_ip(request))
    db.commit()
    return row


@letters_router.get("/requests", response_model=list[LetterRequestOut])
def list_letter_requests(
    db: DbSession, user: CurrentUserDep,
    view: Annotated[str, Query(pattern="^(mine|to_decide|all)$", description="mine = about me or raised by me")] = "mine",
    status_filter: Annotated[str | None, Query(alias="status")] = None,
) -> list[LetterRequestOut]:
    stmt = select(LetterRequest).join(Employee, Employee.id == LetterRequest.employee_id)
    me_id = user.employee_id or ""
    if view == "mine":
        stmt = stmt.where((LetterRequest.employee_id == me_id) | (LetterRequest.requested_by == me_id))
    elif view == "to_decide":
        stmt = stmt.where(LetterRequest.id.in_(waiting_entity_ids(db, "letter", user.employee_id) or [""]))
    else:
        if user.account.role not in HR_ROLES:
            raise HTTPException(403, "Only HR can list every letter request.")
        stmt = stmt.where(user.scope.employee_filter())
    if status_filter:
        stmt = stmt.where(LetterRequest.status == status_filter)
    rows = []
    for r in db.scalars(stmt.order_by(LetterRequest.created_at.desc())):
        emp = db.get(Employee, r.employee_id)
        if emp is not None and _can_see_letter(db, user, r, emp):
            rows.append(r)
    return _letter_outs(db, rows)


@letters_router.post("/requests", response_model=LetterRequestOut, status_code=status.HTTP_201_CREATED)
def request_letter(body: LetterRequestIn, request: Request, db: DbSession, user: CurrentUserDep) -> LetterRequestOut:
    requester = me(user)
    emp = requester if not body.employee_id or body.employee_id == requester.id else db.get(Employee, body.employee_id)
    if emp is None or not can_view(db, user, emp):
        raise NOT_FOUND
    info = letters.LETTER_TYPES[body.letter_type]
    label = info["label"]
    hr = _is_letter_hr(user, emp)
    if info.get("second"):
        if user.account.role not in HR_ROLES:
            raise HTTPException(403, f"{label}s are issued by HR.")
        if emp.id == requester.id:
            raise HTTPException(403, "You cannot raise this letter for yourself.")
        if not hr:
            raise NOT_FOUND
    elif not hr:  # HR may raise any type for anyone in scope; everyone else only some types, for themselves
        if emp.id != requester.id:
            raise HTTPException(403, "You can only request letters for yourself.")
        if not info["employee"]:
            raise HTTPException(403, f"{label}s are issued by HR.")
        if body.letter_type == "Experience" and emp.employment_status not in letters.EXITED_STATUSES:
            raise HTTPException(422, "An experience letter is available after your exit.")
    details = (body.details or "").strip()[:200] or None
    if info.get("details") and not details:
        raise HTTPException(422, f"Enter {info['details'].lower()}.")
    if db.scalar(select(LetterRequest.id).where(LetterRequest.employee_id == emp.id, LetterRequest.letter_type == body.letter_type,
                                                LetterRequest.status == "pending")):
        raise HTTPException(409, f"A {label.lower()} request for {emp.full_name} is already waiting for approval.")
    req = LetterRequest(id=f"ltr-{uuid.uuid4().hex[:12]}", employee_id=emp.id, letter_type=body.letter_type, status="pending",
                        requested_by=requester.id, note=body.note.strip() or "No reason given", details=details,
                        effective_date=body.effective_date if user.account.role in HR_ROLES else None)
    missing = letters.missing_fields(req.letter_type, letters.collect_fields(db, req, emp))
    if missing:
        raise HTTPException(422, letters.missing_message(missing))
    db.add(req)
    db.flush()
    record_audit(db, actor_id=user.id, action="letter_requested", entity="letter_request", entity_id=req.id, subject_id=emp.id,
                 after={"type": req.letter_type, "details": req.details, "effective_date": req.effective_date},
                 ip=client_ip(request))
    letters.ensure_workflow(db)
    try:
        instance = start_about(db, "letter", req.id, requester, emp, amount=None, actor_id=user.id,
                               title=f"{label} to approve", body=f"{requester.full_name} raised a {label.lower()} for {emp.full_name}.",
                               href=f"/letters/requests/{req.id}")
    except engine.ApprovalError as exc:
        db.rollback()
        raise HTTPException(422, str(exc)) from exc
    req.approval_instance_id = instance.id
    db.commit()
    return _letter_outs(db, [req])[0]


@letters_router.get("/requests/{request_id}", response_model=LetterRequestOut)
def get_letter_request(request_id: str, db: DbSession, user: CurrentUserDep) -> LetterRequestOut:
    req, _ = _visible_letter(db, user, request_id)
    return _letter_outs(db, [req])[0]


@letters_router.get("/requests/{request_id}/preview", response_model=LetterPreviewOut)
def preview_letter(request_id: str, db: DbSession, user: CurrentUserDep) -> LetterPreviewOut:
    """The fields that will go into the letter, what is missing, and the wording (no PDF)."""
    req, emp = _visible_letter(db, user, request_id)
    fields = letters.collect_fields(db, req, emp)
    try:
        title, _to_whom, paragraphs = letters.render(db, req.letter_type, fields)
    except letters.LetterError as exc:
        raise HTTPException(422, str(exc)) from exc
    return LetterPreviewOut(letter_type=req.letter_type, fields=fields, missing=letters.missing_fields(req.letter_type, fields),
                            title=title, paragraphs=paragraphs)


@letters_router.post("/requests/{request_id}/decision", response_model=LetterRequestOut)
def decide_letter(request_id: str, body: DecisionIn, request: Request, db: DbSession, user: CurrentUserDep) -> LetterRequestOut:
    """Approving issues the letter (PDF). Same as POST /approvals/{approval_instance_id}/decision."""
    req, emp = _visible_letter(db, user, request_id)
    if req.requested_by == user.employee_id and req.employee_id != user.employee_id:
        raise HTTPException(403, "Someone other than the person who raised this letter must approve it.")
    if req.employee_id == user.employee_id:
        raise HTTPException(403, "You cannot approve your own letter.")
    if body.decision == "approve":
        missing = letters.missing_fields(req.letter_type, letters.collect_fields(db, req, emp))
        if missing:
            raise HTTPException(422, letters.missing_message(missing))
    decide_http(db, _letter_instance(db, req), user.employee_id, body.decision, body.note, user.id, client_ip(request))
    db.commit()
    return _letter_outs(db, [req])[0]


@letters_router.post("/requests/{request_id}/issue", response_model=LetterRequestOut)
def reissue_letter(request_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> LetterRequestOut:
    """HR generates the letter again from current data: a new version (or the first one if generation failed)."""
    req, emp = _visible_letter(db, user, request_id)
    if not _is_letter_hr(user, emp) or emp.id == user.employee_id:
        raise HTTPException(403, "Only HR can generate letters (never their own).")
    if req.status not in ("approved", "issued"):
        raise HTTPException(409, f"Only approved letters can be generated; this one is {req.status}.")
    try:
        letters.issue(db, req, user.employee_id, user.employee_id)
    except letters.LetterError as exc:
        db.rollback()
        raise HTTPException(422, str(exc)) from exc
    db.commit()
    return _letter_outs(db, [req])[0]


@letters_router.post("/requests/{request_id}/cancel", response_model=LetterRequestOut)
def cancel_letter(request_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> LetterRequestOut:
    req = db.get(LetterRequest, request_id)
    if req is None or req.requested_by != user.employee_id:
        raise NOT_FOUND
    if req.status != "pending":
        raise HTTPException(409, f"Only pending requests can be cancelled; this one is {req.status}.")
    inst = _letter_instance(db, req)
    if inst is not None and inst.status == "pending":
        engine.cancel(db, inst, actor_id=user.id, ip=client_ip(request))
    req.status = "cancelled"
    record_audit(db, actor_id=user.id, action="letter_cancelled", entity="letter_request", entity_id=req.id,
                 subject_id=req.employee_id, before={"status": "pending"}, after={"status": "cancelled"}, ip=client_ip(request))
    db.commit()
    return _letter_outs(db, [req])[0]


@letters_router.get("/requests/{request_id}/download", response_class=FileResponse)
def download_letter(request_id: str, request: Request, db: DbSession, user: CurrentUserDep,
                    version: Annotated[int | None, Query(ge=1)] = None) -> FileResponse:
    """The issued PDF: the employee (once issued), HR in scope and the approvers."""
    req, emp = _visible_letter(db, user, request_id)
    allowed = (emp.id == user.employee_id or _is_letter_hr(user, emp) or _is_letter_approver(db, req, user.employee_id))
    if not allowed:
        raise HTTPException(403, "Only the employee, HR and the approvers can open this letter.")
    stmt = select(LetterIssue).where(LetterIssue.request_id == req.id)
    if req.status != "issued" or db.scalar(stmt.limit(1)) is None:
        raise HTTPException(409, "This letter hasn't been issued yet.")
    issue_row = db.scalar(stmt.where(LetterIssue.version == version) if version else stmt.order_by(LetterIssue.version.desc()))
    if issue_row is None:
        raise NOT_FOUND
    file_row = db.get(DocumentVersion, issue_row.document_version_id)
    if file_row is None:
        raise NOT_FOUND
    return _file_response(db, user, file_row, emp.id, request, "letter_request", req.id)
