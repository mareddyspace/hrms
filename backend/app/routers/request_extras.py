"""Thread of any self-service request (/requests/{type}/{id}/...): comments, "more information" requests, supporting
files and the audit trail. Rules in app/services/request_extras.py.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from app.deps import CurrentUserDep, DbSession, client_ip
from app.models import Employee, RequestAttachment
from app.services import request_extras as rules
from app.services import storage
from app.services.activity import record_audit
from app.services.decisions import NOT_FOUND

router = APIRouter(prefix="/requests", tags=["request threads"])



class CommentIn(BaseModel):
    body: str = Field(min_length=1, max_length=2000)
    request_info: bool = False


class CommentOut(BaseModel):
    id: str
    author_id: str | None
    author_name: str
    kind: str
    body: str
    created_at: datetime


class AttachmentOut(BaseModel):
    id: str
    purpose: str
    file_name: str
    content_type: str
    size_bytes: int
    uploaded_by_name: str | None
    created_at: datetime


class AuditOut(BaseModel):
    action: str
    actor: str
    at: datetime


class ThreadOut(BaseModel):
    comments: list[CommentOut]
    attachments: list[AttachmentOut]
    audit: list[AuditOut]
    info_open: bool
    can_comment: bool
    can_request_info: bool
    can_attach: bool


def _check_type(entity_type: str) -> None:
    if entity_type not in rules.ENTITY_TYPES:
        raise NOT_FOUND


def _attachment_out(a: RequestAttachment) -> AttachmentOut:
    return AttachmentOut(id=a.id, purpose=a.purpose, file_name=a.file_name, content_type=a.content_type,
                         size_bytes=a.size_bytes, uploaded_by_name=a.uploaded_by_name, created_at=a.created_at)


def _thread(db: DbSession, user, target: rules.Target) -> ThreadOut:  # noqa: ANN001
    comments = rules.comments_of(db, target.entity_type, target.row.id)
    can_info = rules.can_request_info(db, user, target)
    delegate = target.instance is not None and bool(user.employee_id) and rules.engine.is_delegate_for(db, target.instance, user.employee_id)
    return ThreadOut(
        comments=[CommentOut(id=c.id, author_id=c.author_id, author_name=c.author_name, kind=c.kind, body=c.body,
                             created_at=c.created_at) for c in comments],
        attachments=[_attachment_out(a) for a in rules.attachments_of(db, target.entity_type, target.row.id)],
        audit=[AuditOut(**a) for a in rules.audit_trail(db, target)],
        info_open=rules.info_open(comments),
        can_comment=user.employee_id == target.owner.id or can_info or delegate,
        can_request_info=can_info,
        can_attach=rules.can_attach(user, target),
    )


@router.get("/{entity_type}/open-info", response_model=list[str])
def open_info(entity_type: str, db: DbSession, user: CurrentUserDep,
              ids: Annotated[list[str], Query(max_length=500)]) -> list[str]:
    """Of these request ids, the ones with an unanswered "more information" question (ids only, no content)."""
    _check_type(entity_type)
    return sorted(rules.open_info_ids(db, entity_type, ids))


@router.get("/{entity_type}/{entity_id}/thread", response_model=ThreadOut)
def get_thread(entity_type: str, entity_id: str, db: DbSession, user: CurrentUserDep) -> ThreadOut:
    _check_type(entity_type)
    return _thread(db, user, rules.resolve(db, user, entity_type, entity_id))


@router.post("/{entity_type}/{entity_id}/comments", response_model=ThreadOut, status_code=status.HTTP_201_CREATED)
def add_comment(entity_type: str, entity_id: str, body: CommentIn, db: DbSession, user: CurrentUserDep) -> ThreadOut:
    _check_type(entity_type)
    target = rules.resolve(db, user, entity_type, entity_id)
    try:
        rules.add_comment(db, user, target, body.body, body.request_info)
    except rules.ExtrasError as exc:
        db.rollback()
        raise HTTPException(403 if str(exc).startswith("Only") else 422, str(exc)) from exc
    db.commit()
    return _thread(db, user, target)


@router.post("/{entity_type}/{entity_id}/attachments", response_model=AttachmentOut, status_code=status.HTTP_201_CREATED,
             openapi_extra={"requestBody": {"required": True, "content": {t: {"schema": {"type": "string", "format": "binary"}}
                                                                         for t in storage.ALLOWED_TYPES}}})
async def add_attachment(
    entity_type: str, entity_id: str, request: Request, db: DbSession, user: CurrentUserDep,
    purpose: Annotated[str, Query(pattern="^(supporting|settlement|booking)$")] = "supporting",
    filename: Annotated[str | None, Query(max_length=255)] = None,
) -> AttachmentOut:
    """A PDF or image (up to 5 MB) as the raw request body."""
    _check_type(entity_type)
    target = rules.resolve(db, user, entity_type, entity_id)
    if not rules.can_attach(user, target):
        raise HTTPException(403, "Only the requester, HR or finance can add files.")
    if len(rules.attachments_of(db, entity_type, entity_id)) >= rules.MAX_FILES:
        raise HTTPException(422, f"Up to {rules.MAX_FILES} files per request.")
    from app.routers.expenses import _clean_name, _read_upload

    data, content_type, sha = await _read_upload(request)
    att_id = f"ratt-{uuid.uuid4().hex[:16]}"
    stored = storage.save(f"requests/{entity_type}/{target.owner.id}", att_id, data, content_type, sha)
    me = db.get(Employee, user.employee_id) if user.employee_id else None
    row = RequestAttachment(id=att_id, entity_type=entity_type, entity_id=entity_id, purpose=purpose,
                            employee_id=target.owner.id, file_name=_clean_name(filename, content_type),
                            content_type=stored.content_type, size_bytes=stored.size_bytes, sha256=stored.sha256,
                            storage_path=stored.relative_path, uploaded_by=user.id,
                            uploaded_by_name=me.full_name if me else user.account.email)
    db.add(row)
    record_audit(db, actor_id=user.id, action=f"{entity_type}_file_added", entity=rules.AUDIT_ENTITIES[entity_type],
                 entity_id=entity_id, subject_id=target.owner.id, after={"file": row.file_name, "purpose": purpose},
                 ip=client_ip(request))
    try:
        db.commit()
    except Exception:
        storage.delete_quietly(stored.relative_path)
        raise
    return _attachment_out(row)


@router.get("/attachments/{attachment_id}", response_class=FileResponse)
def download_attachment(attachment_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> Response:
    row = db.get(RequestAttachment, attachment_id)
    if row is None:
        raise NOT_FOUND
    rules.resolve(db, user, row.entity_type, row.entity_id)  # 404 unless the request is visible
    try:
        response = storage.download(row.storage_path, media_type=row.content_type, filename=row.file_name)
    except storage.FileMissing as exc:
        raise HTTPException(410, "The file is no longer available.") from exc
    except storage.StorageError as exc:
        raise NOT_FOUND from exc
    record_audit(db, actor_id=user.id, action=f"{row.entity_type}_file_downloaded",
                 entity=rules.AUDIT_ENTITIES[row.entity_type], entity_id=row.entity_id, subject_id=row.employee_id,
                 ip=client_ip(request))
    db.commit()
    return response
