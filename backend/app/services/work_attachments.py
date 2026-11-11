"""Files attached to tasks and tickets (work_attachments, migration 0033).

Stored with app/services/storage.py under "work/<task|ticket>/<id>/<file id>.<ext>", same limits as every other
upload (app/services/uploads.py): raw request body, at most 5 MB, PDF / PNG / JPEG / GIF / WebP checked from the
bytes. At most MAX_PER_ITEM files on one task or ticket. Routers decide who may see, add and remove them.
"""

from __future__ import annotations

import secrets
from datetime import datetime

from fastapi import HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import WorkAttachment
from app.services import storage
from app.services.uploads import clean_name, read_upload

MAX_PER_ITEM = 20


class AttachmentOut(BaseModel):
    id: str
    file_name: str
    content_type: str
    size_bytes: int
    uploaded_by: str
    uploaded_by_name: str = ""
    internal: bool = False
    created_at: datetime


def out(row: WorkAttachment, name: str = "") -> AttachmentOut:
    return AttachmentOut(id=row.id, file_name=row.file_name, content_type=row.content_type, size_bytes=row.size_bytes,
                         uploaded_by=row.uploaded_by, uploaded_by_name=name, internal=bool(row.internal),
                         created_at=row.created_at)


def list_for(db: Session, entity_type: str, entity_id: str) -> list[WorkAttachment]:
    return list(db.scalars(select(WorkAttachment).where(WorkAttachment.entity_type == entity_type,
                                                        WorkAttachment.entity_id == entity_id)
                           .order_by(WorkAttachment.created_at)))


def get(db: Session, entity_type: str, entity_id: str, file_id: str) -> WorkAttachment:
    row = db.get(WorkAttachment, file_id)
    if row is None or row.entity_type != entity_type or row.entity_id != entity_id:
        raise HTTPException(404, "File not found.")
    return row


async def add(db: Session, request: Request, entity_type: str, entity_id: str, uploader: str,
              filename: str | None, internal: bool = False) -> WorkAttachment:
    """Validates and stores the upload; the caller commits (and calls storage.delete_quietly on failure)."""
    count = db.scalar(select(func.count()).select_from(WorkAttachment).where(
        WorkAttachment.entity_type == entity_type, WorkAttachment.entity_id == entity_id)) or 0
    if count >= MAX_PER_ITEM:
        raise HTTPException(409, f"Up to {MAX_PER_ITEM} files can be attached.")
    data, content_type, sha = await read_upload(request)
    file_id = f"wa-{secrets.token_hex(8)}"
    stored = storage.save(f"work/{entity_type}/{entity_id}", file_id, data, content_type, sha)
    row = WorkAttachment(id=file_id, entity_type=entity_type, entity_id=entity_id,
                         file_name=clean_name(filename, content_type), content_type=stored.content_type,
                         size_bytes=stored.size_bytes, storage_path=stored.relative_path, uploaded_by=uploader,
                         internal=internal)
    db.add(row)
    return row


def download(row: WorkAttachment) -> Response:
    try:
        return storage.download(row.storage_path, media_type=row.content_type, filename=row.file_name)
    except storage.FileMissing as exc:
        raise HTTPException(410, "The file is no longer available.") from exc
    except storage.StorageError as exc:
        raise HTTPException(404, "File not found.") from exc
