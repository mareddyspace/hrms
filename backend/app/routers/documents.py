"""Employee documents (versioned uploads), letters (templates, requests, approval, PDF issue) and policy acknowledgments.

Uploads are the raw request body (Content-Type: the file's type), at most 10 MB: PDF, image or Word (.docx); each
category may narrow the kinds and size, and require an expiry date. Deleting is soft (the row and files stay).
Every upload, version, view, download, delete, verification and letter issue is written to the audit log.
Rules: app/services/documents.py and app/services/letters.py.
"""

from __future__ import annotations

import uuid
from datetime import date, timedelta
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import FileResponse, Response
from sqlalchemy import select

from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import (
    Account,
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
    DocCategoryIn,
    DocCategoryOut,
    DocDeleteIn,
    DocFolderOut,
    DocVerifyIn,
    DocExpiryIn,
    DocRulesOut,
    DocVersionOut,
    EmployeeDocumentOut,
    LetterDraftIn,
    LetterIssueOut,
    LetterPlaceholderOut,
    LetterPreviewOut,
    LetterRequestIn,
    LetterRequestOut,
    LetterTemplateIn,
    LetterTemplateNewIn,
    LetterTemplateOut,
    LetterTemplatePreviewIn,
    LetterTypeOut,
    LetterWordIn,
    LetterWordOut,
    PolicyAckIn,
    PolicyAckOut,
)
from app.services import approvals as engine
from app.services import documents as docs
from app.services import letters
from app.services import storage
from app.services.activity import notify, record_audit
from app.services.approval_targets import start_about
from app.services.decisions import NOT_FOUND, can_view, me, target
from app.services.leave import today_for
from app.services.scope import HR_ACCESS_ROLES, HR_ROLES
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
    if doc is not None and doc.deleted_at is not None:
        raise NOT_FOUND
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


def _category_outs(db: DbSession) -> list[DocCategoryOut]:
    return [DocCategoryOut(name=k, label=str(v["label"]), verification=bool(v["verification"]),
                           employee_upload=bool(v["employee_upload"]), manager_visible=bool(v["manager_visible"]),
                           requires_expiry=bool(v["requires_expiry"]), required=bool(v["required"]),
                           types=list(v["types"]), max_mb=int(v["max_mb"]))  # type: ignore[call-overload]
            for k, v in docs.category_config(db).items()]


def _check_file_for(db: DbSession, category: str, content_type: str, size: int) -> None:
    problem = docs.check_category_file(db, category, content_type, size)
    if problem:
        raise HTTPException(413 if "larger" in problem else 415, problem)


@router.get("/rules", response_model=DocRulesOut)
def document_rules(db: DbSession, user: CurrentUserDep) -> DocRulesOut:
    return DocRulesOut(categories=list(docs.DOCUMENT_CATEGORIES), manager_categories=sorted(docs.manager_categories(db)),
                       max_bytes=docs.MAX_DOCUMENT_BYTES, content_types=sorted(docs.DOCUMENT_TYPES),
                       category_config=_category_outs(db))


@router.put("/categories", response_model=list[DocCategoryOut])
def save_categories(body: list[DocCategoryIn], request: Request, db: DbSession, user: CurrentUserDep) -> list[DocCategoryOut]:
    """HR / admin: rename categories, and choose which need verification and which employees may upload."""
    if user.account.role not in (*HR_ACCESS_ROLES, "admin", "super_admin"):
        raise HTTPException(403, "Only HR or an administrator can change document categories.")
    from app.services.platform_settings import set_setting

    current = docs.category_config(db)
    saved = {}
    for row in body:
        if row.name not in docs.DOCUMENT_CATEGORIES:
            raise HTTPException(422, f"Unknown category {row.name}.")
        now = current[row.name]
        saved[row.name] = {"label": row.label.strip(), "verification": row.verification,
                           "employee_upload": row.employee_upload and row.name != docs.LETTERS_CATEGORY,
                           "manager_visible": now["manager_visible"] if row.manager_visible is None else row.manager_visible,
                           "requires_expiry": now["requires_expiry"] if row.requires_expiry is None else row.requires_expiry,
                           "required": (now["required"] if row.required is None else row.required)
                           and row.name != docs.LETTERS_CATEGORY,
                           "types": list(now["types"]) if row.types is None else sorted(set(row.types)),  # type: ignore[call-overload]
                           "max_mb": now["max_mb"] if row.max_mb is None else row.max_mb}
    before = set_setting(db, docs.CATEGORY_SETTING, saved, user.id)
    record_audit(db, actor_id=user.id, action="document_categories_changed", entity="platform_setting",
                 entity_id=docs.CATEGORY_SETTING, before={"value": before}, after={"value": saved}, ip=client_ip(request))
    db.commit()
    return _category_outs(db)


@router.get("/verification-queue", response_model=list[EmployeeDocumentOut])
def verification_queue(db: DbSession, user: CurrentUserDep) -> list[EmployeeDocumentOut]:
    """HR: documents waiting for verification in your scope."""
    if user.account.role not in HR_ACCESS_ROLES:
        return []
    rows = [d for d in db.scalars(select(EmployeeDocument).join(Employee, Employee.id == EmployeeDocument.employee_id)
                                  .where(EmployeeDocument.verification_status == "pending", EmployeeDocument.deleted_at.is_(None),
                                         user.scope.employee_filter())
                                  .order_by(EmployeeDocument.updated_at))]
    return _doc_outs(db, rows, _today(user))


@router.post("/{document_id}/verification", response_model=EmployeeDocumentOut)
def verify_document(document_id: str, body: DocVerifyIn, request: Request, db: DbSession,
                    user: CurrentUserDep) -> EmployeeDocumentOut:
    doc, owner = _visible_doc(db, user, document_id)
    if not docs.is_hr_for(user, owner) or owner.id == user.employee_id:
        raise HTTPException(403, "Only HR can verify someone else's documents.")
    if doc.verification_status != "pending":
        raise HTTPException(409, "This document isn't waiting for verification.")
    note = (body.note or "").strip()
    if body.decision == "reject" and not note:
        raise HTTPException(422, "Say why it is rejected, so they can upload a better copy.")
    before = {"verification_status": doc.verification_status}
    doc.verification_status = "verified" if body.decision == "verify" else "rejected"
    doc.verification_note = note or None
    doc.verified_by = (user.employee.full_name if user.employee else user.account.email)
    from app.db import utcnow

    doc.verified_at = utcnow()
    record_audit(db, actor_id=user.id, action=f"document_{doc.verification_status}", entity="employee_document",
                 entity_id=doc.id, subject_id=owner.id, before=before,
                 after={"verification_status": doc.verification_status, "note": note}, ip=client_ip(request))
    notify(db, recipient_id=owner.id, title=f"{doc.title} {doc.verification_status}",
           body=note or ("HR checked it." if body.decision == "verify" else ""), href="/documents")
    db.commit()
    return _doc_outs(db, [doc], _today(user), with_versions=True)[0]


def _ask_verification(db: DbSession, owner: Employee, doc: EmployeeDocument) -> None:
    for hr_id in db.scalars(select(Account.employee_id).where(Account.role.in_(tuple(HR_ROLES)),
                                                               Account.employee_id.is_not(None))):
        if hr_id and hr_id != owner.id:
            notify(db, recipient_id=hr_id, title=f"{owner.full_name} uploaded {doc.title}",
                   body="It is waiting for verification.", href="/documents")


@router.get("", response_model=list[EmployeeDocumentOut])
def list_documents(db: DbSession, user: CurrentUserDep, employee_id: str | None = None,
                   category: Annotated[str | None, Query(max_length=32)] = None) -> list[EmployeeDocumentOut]:
    """One person's documents that you may see (yourself by default)."""
    emp = me(user) if not employee_id or employee_id == user.employee_id else db.get(Employee, employee_id)
    if emp is None or not can_view(db, user, emp):
        raise NOT_FOUND
    stmt = select(EmployeeDocument).where(EmployeeDocument.employee_id == emp.id, EmployeeDocument.deleted_at.is_(None))
    if category:
        stmt = stmt.where(EmployeeDocument.category == category)
    rows = [d for d in db.scalars(stmt.order_by(EmployeeDocument.created_at.desc())) if docs.can_see_document(db, user, d, emp)]
    return _doc_outs(db, rows, _today(user))


@router.get("/expiring", response_model=list[EmployeeDocumentOut])
def expiring_documents(db: DbSession, user: CurrentUserDep, days: Annotated[int, Query(ge=0, le=365)] = 30,
                       include_expired: bool = True,
                       category: Annotated[str | None, Query(max_length=32)] = None) -> list[EmployeeDocumentOut]:
    """Documents expiring within `days` (and already expired): yours, your reports' manager-visible ones, HR's scope."""
    today = _today(user)
    stmt = select(EmployeeDocument).join(Employee, Employee.id == EmployeeDocument.employee_id).where(
        EmployeeDocument.expiry_date.is_not(None), EmployeeDocument.expiry_date <= today + timedelta(days=days),
        EmployeeDocument.deleted_at.is_(None))
    if not include_expired:
        stmt = stmt.where(EmployeeDocument.expiry_date >= today)
    if category:
        stmt = stmt.where(EmployeeDocument.category == category)
    stmt = stmt.where(user.scope.employee_filter())
    rows = []
    for d in db.scalars(stmt.order_by(EmployeeDocument.expiry_date)):
        owner = db.get(Employee, d.employee_id)
        if owner is not None and docs.can_see_document(db, user, d, owner):
            rows.append(d)
    return _doc_outs(db, rows, today)


_LEFT = ("terminated", "exited", "resigned", "inactive", "separated")


@router.get("/folders", response_model=list[DocFolderOut])
def employee_folders(db: DbSession, user: CurrentUserDep, q: Annotated[str | None, Query(max_length=100)] = None,
                     include_left: bool = False) -> list[DocFolderOut]:
    """One folder per person you may see documents for (HR: your scope; managers: your reports; else yourself), with
    counts of what needs attention and the required categories still missing. Managers only count the categories
    their policy lets them see."""
    from sqlalchemy import func, or_

    today = _today(user)
    stmt = select(Employee).where(user.scope.employee_filter())
    if not include_left:
        stmt = stmt.where(func.lower(Employee.employment_status).not_in(_LEFT))
    if q and q.strip():
        like = f"%{q.strip().lower()}%"
        stmt = stmt.where(or_(func.lower(Employee.full_name).like(like), func.lower(Employee.employee_code).like(like),
                              func.lower(Employee.department).like(like)))
    people = list(db.scalars(stmt.order_by(Employee.full_name).limit(500)))
    if not people:
        return []
    config = docs.category_config(db)
    mgr_cats = docs.manager_categories(db)
    rows: dict[str, list[EmployeeDocument]] = {p.id: [] for p in people}
    for d in db.scalars(select(EmployeeDocument).where(EmployeeDocument.employee_id.in_(list(rows)),
                                                       EmployeeDocument.deleted_at.is_(None))):
        rows[d.employee_id].append(d)
    out = []
    for p in people:
        full = p.id == user.employee_id or docs.is_hr_for(user, p)
        visible = [d for d in rows[p.id] if full or d.category in mgr_cats]
        have = {d.category for d in visible}
        missing = [str(c["label"]) for name, c in config.items()
                   if c.get("required") and name not in have and (full or name in mgr_cats)]
        days = [(d.expiry_date - today).days for d in visible if d.expiry_date]
        out.append(DocFolderOut(employee_id=p.id, employee_name=p.full_name, employee_code=p.employee_code,
                                department=p.department or "", documents=len(visible),
                                pending=sum(d.verification_status == "pending" for d in visible),
                                rejected=sum(d.verification_status == "rejected" for d in visible),
                                expiring=sum(0 <= n <= 30 for n in days), expired=sum(n < 0 for n in days),
                                missing=missing))
    return out


@router.post("", response_model=EmployeeDocumentOut, status_code=status.HTTP_201_CREATED, openapi_extra=_UPLOAD_DOC)
async def upload_document(
    request: Request, db: DbSession, user: CurrentUserDep,
    category: Annotated[str, Query(max_length=32)],
    title: Annotated[str, Query(min_length=1, max_length=200)],
    employee_id: str | None = None,
    expiry_date: date | None = None,
    filename: Annotated[str | None, Query(max_length=255)] = None,
    description: Annotated[str | None, Query(max_length=1000)] = None,
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
    if not docs.can_employee_upload(db, user, owner, category):
        raise HTTPException(403, f"HR adds {docs.category_config(db)[category]['label'].lower()} documents.")
    if expiry_date is None and docs.requires_expiry(db, category):
        raise HTTPException(422, f"Enter the expiry date: {docs.category_config(db)[category]['label'].lower()} need one.")
    data, content_type, _sha = await _read_upload(request)
    _check_file_for(db, category, content_type, len(data))
    pending = docs.needs_verification(db, user, owner, category)
    doc = EmployeeDocument(id=f"doc-{uuid.uuid4().hex[:12]}", employee_id=owner.id, category=category, title=title.strip(),
                           current_version=0, expiry_date=expiry_date, uploaded_by=user.id,
                           description=(description or "").strip()[:1000] or None,
                           verification_status="pending" if pending else None)
    db.add(doc)
    db.flush()
    version = _store_version(db, user, doc, data, content_type, filename)
    if pending:
        _ask_verification(db, owner, doc)
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
    if not docs.can_employee_upload(db, user, owner, doc.category):
        raise HTTPException(403, "HR updates documents in this category.")
    if expiry_date is None and doc.expiry_date is None and docs.requires_expiry(db, doc.category):
        raise HTTPException(422, "Enter the expiry date of the new copy.")
    data, content_type, _sha = await _read_upload(request)
    _check_file_for(db, doc.category, content_type, len(data))
    version = _store_version(db, user, doc, data, content_type, filename)
    if expiry_date is not None:
        doc.expiry_date = expiry_date
    if docs.needs_verification(db, user, owner, doc.category):
        doc.verification_status, doc.verification_note, doc.verified_by, doc.verified_at = "pending", None, None, None
        _ask_verification(db, owner, doc)
    elif docs.is_hr_for(user, owner) and doc.verification_status in ("pending", "rejected"):
        doc.verification_status = "verified"
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
    if employee_id is None and policy_id and user.account.role in HR_ACCESS_ROLES:
        stmt = stmt.join(Employee, Employee.id == PolicyAcknowledgment.employee_id).where(user.scope.employee_filter())
    else:
        emp = target(db, user, employee_id)
        if emp.id != user.employee_id and user.account.role not in HR_ACCESS_ROLES:
            raise HTTPException(403, "Only HR can see someone else's acknowledgments.")
        stmt = stmt.where(PolicyAcknowledgment.employee_id == emp.id)
    if policy_id:
        stmt = stmt.where(PolicyAcknowledgment.policy_id == policy_id)
    return list(db.scalars(stmt.order_by(PolicyAcknowledgment.acknowledged_at.desc())))


@router.post("/policy-acks", response_model=PolicyAckOut, status_code=status.HTTP_201_CREATED)
def acknowledge_policy(body: PolicyAckIn, request: Request, db: DbSession, user: CurrentUserDep) -> PolicyAcknowledgment:
    from app.services.policies import known_policy_version

    emp = me(user)
    if not known_policy_version(db, emp, body.policy_id.strip(), body.policy_version.strip()):
        raise HTTPException(422, "Unknown policy or version.")
    if db.scalar(select(PolicyAcknowledgment.id).where(PolicyAcknowledgment.employee_id == emp.id,
                                                       PolicyAcknowledgment.policy_id == body.policy_id,
                                                       PolicyAcknowledgment.policy_version == body.policy_version)):
        raise HTTPException(409, "You have already acknowledged this version of the policy.")
    ack = PolicyAcknowledgment(employee_id=emp.id, policy_id=body.policy_id.strip(), policy_version=body.policy_version.strip(),
                               ip=client_ip(request), comment=(body.comment or "").strip() or None)
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
    if body.expiry_date is None and docs.requires_expiry(db, doc.category):
        raise HTTPException(422, "Documents in this category need an expiry date.")
    before = doc.expiry_date
    doc.expiry_date = body.expiry_date
    # The employee changing the date of a document HR verified sends it back for verification.
    reverify = (before != body.expiry_date and doc.verification_status == "verified" and user.employee_id == owner.id
                and not docs.is_hr_for(user, owner))
    if reverify:
        doc.verification_status, doc.verified_by, doc.verified_at = "pending", None, None
    record_audit(db, actor_id=user.id, action="document_expiry_changed", entity="employee_document", entity_id=doc.id,
                 subject_id=owner.id, before={"expiry_date": before},
                 after={"expiry_date": body.expiry_date, "verification_status": doc.verification_status},
                 ip=client_ip(request))
    db.commit()
    return _doc_outs(db, [doc], _today(user), with_versions=True)[0]


_INLINE_TYPES = frozenset({"application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"})


def _file_response(db: DbSession, user: CurrentUser, version: DocumentVersion, subject_id: str, request: Request,
                   entity: str, entity_id: str, inline: bool = False) -> Response:
    try:
        response = storage.download(version.storage_path, media_type=version.content_type, filename=version.file_name)
    except storage.FileMissing as exc:
        raise HTTPException(410, "The file is no longer available.") from exc
    except storage.StorageError as exc:
        raise NOT_FOUND from exc
    inline = inline and version.content_type in _INLINE_TYPES
    if inline:
        disposition = response.headers.get("content-disposition", "")
        if disposition.startswith("attachment"):
            response.headers["content-disposition"] = "inline" + disposition[len("attachment"):]
    record_audit(db, actor_id=user.id, action="document_viewed" if inline else "document_downloaded", entity=entity,
                 entity_id=entity_id, subject_id=subject_id, after={"version": version.version, "file": version.id},
                 ip=client_ip(request))
    db.commit()
    return response


@router.get("/{document_id}/download", response_class=FileResponse)
def download_document(document_id: str, request: Request, db: DbSession, user: CurrentUserDep,
                      version: Annotated[int | None, Query(ge=1)] = None, inline: bool = False) -> Response:
    """The file (latest version unless one is given). inline=true: shown in the browser (preview), audited as a view."""
    doc, owner = _visible_doc(db, user, document_id)
    row = db.scalar(select(DocumentVersion).where(DocumentVersion.document_id == doc.id,
                                                  DocumentVersion.version == (version or doc.current_version)))
    if row is None:
        raise NOT_FOUND
    return _file_response(db, user, row, owner.id, request, "employee_document", doc.id, inline=inline)


@router.delete("/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_document(document_id: str, request: Request, db: DbSession, user: CurrentUserDep,
                    body: DocDeleteIn | None = None) -> Response:
    """Soft delete: the document disappears everywhere; the row, versions and files stay for the audit trail."""
    doc, owner = _visible_doc(db, user, document_id)
    reason = docs.can_delete(db, user, doc, owner)
    if reason:
        raise HTTPException(403, reason)
    note = ((body.reason if body else "") or "").strip()
    if owner.id != user.employee_id and not note:
        raise HTTPException(422, "Say why it is removed; the employee is told.")
    from app.db import utcnow

    doc.deleted_at, doc.deleted_by = utcnow(), user.id
    record_audit(db, actor_id=user.id, action="document_deleted", entity="employee_document", entity_id=doc.id,
                 subject_id=owner.id, before={"title": doc.title, "category": doc.category, "version": doc.current_version,
                                              "verification_status": doc.verification_status},
                 after={"deleted": True, "reason": note or None}, ip=client_ip(request))
    if owner.id != user.employee_id:
        notify(db, recipient_id=owner.id, title=f"{doc.title} was removed", body=note, href="/documents")
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------- letters ----------
def _is_letter_hr(user: CurrentUser, emp: Employee) -> bool:
    return user.account.role in HR_ACCESS_ROLES and user.scope.can_see(emp)


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


@letters_router.get("/placeholders", response_model=list[LetterPlaceholderOut])
def letter_placeholders(user: CurrentUserDep) -> list[LetterPlaceholderOut]:
    """What template wording may use, as {name}."""
    return [LetterPlaceholderOut(name=k, description=letters.PLACEHOLDER_HELP.get(k, k)) for k in letters.PLACEHOLDERS]


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
            if t.legal_entity or not t.active:
                continue
            if t.country_code == country or (t.country_code is None and t.letter_type not in by_type):
                by_type[t.letter_type] = t
        rows = list(by_type.values())
    return rows


def _require_template_hr(user: CurrentUser) -> None:
    if user.account.role not in HR_ACCESS_ROLES:
        raise HTTPException(403, "Only HR can change letter templates.")


@letters_router.post("/templates", response_model=LetterTemplateOut, status_code=status.HTTP_201_CREATED)
def create_country_template(body: LetterTemplateNewIn, request: Request, db: DbSession, user: CurrentUserDep) -> LetterTemplate:
    """A country version of a letter type (used instead of the default in that country)."""
    _require_template_hr(user)
    entity = (body.legal_entity or "").strip() or None
    if bool(entity) == bool(body.country_code):
        raise HTTPException(422, "Choose either a country or a legal entity for the new version.")
    if entity:
        taken = any((t or "").strip().lower() == entity.lower() for t in db.scalars(
            select(LetterTemplate.legal_entity).where(LetterTemplate.letter_type == body.letter_type)))
        if taken:
            raise HTTPException(409, "This legal entity already has its own template for this letter. Edit it instead.")
    elif db.scalar(select(LetterTemplate.id).where(LetterTemplate.letter_type == body.letter_type,
                                                   LetterTemplate.country_code == body.country_code,
                                                   LetterTemplate.legal_entity.is_(None))):
        raise HTTPException(409, "This country already has its own template for this letter. Edit it instead.")
    try:
        letters.check_template_text(body.paragraphs)
    except letters.LetterError as exc:
        raise HTTPException(422, str(exc)) from exc
    row = LetterTemplate(id=f"lt-{uuid.uuid4().hex[:12]}", letter_type=body.letter_type,
                         country_code=None if entity else body.country_code, legal_entity=entity,
                         title=body.title.strip(), to_whom=body.to_whom, paragraphs=[p.strip() for p in body.paragraphs],
                         version=1, active=True if body.active is None else body.active, updated_by=user.id)
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
    if body.active is False and row.country_code is None and not row.legal_entity:
        raise HTTPException(422, "The default wording can't be switched off; edit it instead.")
    before = {"title": row.title, "to_whom": row.to_whom, "paragraphs": row.paragraphs, "version": row.version,
              "active": row.active}
    row.title, row.to_whom, row.paragraphs = body.title.strip(), body.to_whom, [p.strip() for p in body.paragraphs]
    row.version, row.updated_by = row.version + 1, user.id
    if body.active is not None:
        row.active = body.active
    record_audit(db, actor_id=user.id, action="letter_template_updated", entity="letter_template", entity_id=row.id,
                 before=before, after=body.model_dump() | {"version": row.version}, ip=client_ip(request))
    db.commit()
    return row


@letters_router.post("/templates/preview", response_model=LetterPreviewOut)
def preview_template(body: LetterTemplatePreviewIn, db: DbSession, user: CurrentUserDep) -> LetterPreviewOut:
    """HR: unsaved wording filled in with one employee's data (yourself by default). Nothing is saved."""
    _require_template_hr(user)
    try:
        letters.check_template_text(body.paragraphs)
    except letters.LetterError as exc:
        raise HTTPException(422, str(exc)) from exc
    emp = me(user) if not body.employee_id or body.employee_id == user.employee_id else db.get(Employee, body.employee_id)
    if emp is None or not can_view(db, user, emp):
        raise NOT_FOUND
    req = LetterRequest(id="preview", employee_id=emp.id, letter_type=body.letter_type, status="pending",
                        requested_by=emp.id, note="", details="(details entered with the request)",
                        effective_date=_today(user))
    fields = letters.collect_fields(db, req, emp)
    try:
        paragraphs = letters.render_paragraphs([p.strip() for p in body.paragraphs], fields)
    except letters.LetterError as exc:
        raise HTTPException(422, str(exc)) from exc
    return LetterPreviewOut(letter_type=body.letter_type, fields=fields, missing=letters.missing_fields(body.letter_type, fields),
                            title=body.title.strip(), paragraphs=paragraphs)


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
        if user.account.role not in HR_ACCESS_ROLES:
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


def _checked_request(db: DbSession, user: CurrentUser, body: LetterRequestIn) -> tuple[Employee, Employee, LetterRequest]:
    """Who may raise this letter for whom; returns (requester, employee, an unsaved request)."""
    requester = me(user)
    emp = requester if not body.employee_id or body.employee_id == requester.id else db.get(Employee, body.employee_id)
    if emp is None or not can_view(db, user, emp):
        raise NOT_FOUND
    info = letters.LETTER_TYPES[body.letter_type]
    label = info["label"]
    hr = _is_letter_hr(user, emp)
    if info.get("second"):
        if user.account.role not in HR_ACCESS_ROLES:
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
    custom = " ".join((body.custom_text or "").split())[:1200] or None
    req = LetterRequest(id=f"ltr-{uuid.uuid4().hex[:12]}", employee_id=emp.id, letter_type=body.letter_type, status="pending",
                        requested_by=requester.id, note=body.note.strip() or "No reason given", details=details,
                        effective_date=body.effective_date if user.account.role in HR_ACCESS_ROLES else None, custom_text=custom)
    return requester, emp, req


@letters_router.post("/draft-preview", response_model=LetterPreviewOut)
def draft_preview(body: LetterDraftIn, db: DbSession, user: CurrentUserDep) -> LetterPreviewOut:
    """The letter as it would read if requested now, with the employee's data (nothing is saved)."""
    _requester, emp, req = _checked_request(db, user, body)
    fields = letters.collect_fields(db, req, emp)
    try:
        title, _to_whom, paragraphs = letters.render(db, req.letter_type, fields)
    except letters.LetterError as exc:
        raise HTTPException(422, str(exc)) from exc
    return LetterPreviewOut(letter_type=req.letter_type, fields=fields, missing=letters.missing_fields(req.letter_type, fields),
                            title=title, paragraphs=paragraphs)


@letters_router.post("/word-text", response_model=LetterWordOut)
def word_text(body: LetterWordIn, db: DbSession, user: CurrentUserDep) -> LetterWordOut:
    """Words "Add your own text" as a letter paragraph with the Copilot model. paragraph=None: no AI right now."""
    from app.services import ai_copilot

    emp = me(user) if not body.employee_id or body.employee_id == user.employee_id else db.get(Employee, body.employee_id)
    if emp is None or not can_view(db, user, emp):
        raise NOT_FOUND
    if not ai_copilot.allow_question(user.id):
        raise HTTPException(429, "Too many requests. Try again in a minute.")
    paragraph = letters.word_custom_text(body.letter_type, emp.full_name, body.text)
    return LetterWordOut(paragraph=paragraph, used_ai=paragraph is not None)


@letters_router.post("/requests", response_model=LetterRequestOut, status_code=status.HTTP_201_CREATED)
def request_letter(body: LetterRequestIn, request: Request, db: DbSession, user: CurrentUserDep) -> LetterRequestOut:
    requester, emp, req = _checked_request(db, user, body)
    label = letters.LETTER_TYPES[req.letter_type]["label"]
    if db.scalar(select(LetterRequest.id).where(LetterRequest.employee_id == emp.id, LetterRequest.letter_type == body.letter_type,
                                                LetterRequest.status == "pending")):
        raise HTTPException(409, f"A {label.lower()} request for {emp.full_name} is already waiting for approval.")
    missing = letters.missing_fields(req.letter_type, letters.collect_fields(db, req, emp))
    if missing:
        raise HTTPException(422, letters.missing_message(missing))
    db.add(req)
    db.flush()
    record_audit(db, actor_id=user.id, action="letter_requested", entity="letter_request", entity_id=req.id, subject_id=emp.id,
                 after={"type": req.letter_type, "details": req.details, "effective_date": req.effective_date,
                        "custom_text": bool(req.custom_text)},
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
                    version: Annotated[int | None, Query(ge=1)] = None) -> Response:
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
