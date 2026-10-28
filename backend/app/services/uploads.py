"""Reading and storing uploaded evidence files (HR cases, service desk) under STORAGE_DIR.

Same rules as expense receipts (app/services/storage.py): raw request body, max 5 MB, PDF or image,
content checked from the bytes, file stored under a generated id.
"""

from __future__ import annotations

import re

from fastapi import HTTPException, Request

from app.services import storage

UPLOAD_OPENAPI = {"requestBody": {"required": True, "content": {t: {"schema": {"type": "string", "format": "binary"}}
                                                               for t in storage.ALLOWED_TYPES}}}


def clean_name(raw: str | None, content_type: str, fallback: str = "attachment") -> str:
    name = re.split(r"[\\/]", raw or "")[-1]
    name = re.sub(r"[^\w.\- ()]", "_", name).strip(" .")[:200]
    return name or f"{fallback}.{storage.ALLOWED_TYPES[content_type]}"


async def read_upload(request: Request) -> tuple[bytes, str, str]:
    """Returns (data, content type, sha256) or raises 413 / 415 / 422."""
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > storage.MAX_RECEIPT_BYTES:
        raise HTTPException(413, "The file is larger than 5 MB.")
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > storage.MAX_RECEIPT_BYTES:
            raise HTTPException(413, "The file is larger than 5 MB.")
    try:
        content_type, sha = storage.check_upload(bytes(data), request.headers.get("content-type"))
    except storage.StorageError as exc:
        msg = str(exc)
        raise HTTPException(413 if "5 MB" in msg else 415 if "accepted" in msg or "match" in msg else 422, msg) from exc
    return bytes(data), content_type, sha
