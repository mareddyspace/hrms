"""Local file storage for uploads (expense receipts).

Root directory: STORAGE_DIR (environment or backend/.env), default ./storage relative to backend/.
Files are named by a generated id, never by the uploaded file name. git ignores backend/storage/.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

from app.config import BACKEND_DIR

MAX_RECEIPT_BYTES = 5 * 1024 * 1024
ALLOWED_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "application/pdf": "pdf"}


class _StorageSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", env_file_encoding="utf-8", extra="ignore")
    storage_dir: str = "./storage"


def storage_root() -> Path:
    """Read on every call so tests (and a changed environment) take effect without a restart."""
    raw = Path(_StorageSettings().storage_dir)
    return raw if raw.is_absolute() else (BACKEND_DIR / raw).resolve()


class StorageError(ValueError):
    """The upload was refused; the message is safe to show the user."""


def sniff(data: bytes) -> str | None:
    """Content type from the file's first bytes (the declared type is never trusted on its own)."""
    if data.startswith(b"%PDF-"):
        return "application/pdf"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


@dataclass
class StoredFile:
    relative_path: str
    content_type: str
    size_bytes: int
    sha256: str


def check_upload(data: bytes, declared_type: str | None) -> tuple[str, str]:
    """Validate a receipt upload. Returns (content type, sha256)."""
    if not data:
        raise StorageError("The file is empty.")
    if len(data) > MAX_RECEIPT_BYTES:
        raise StorageError("The file is larger than 5 MB.")
    actual = sniff(data)
    if actual is None:
        raise StorageError("Only PDF, PNG, JPEG, GIF or WebP files are accepted.")
    declared = (declared_type or "").split(";")[0].strip().lower()
    if declared == "image/jpg":
        declared = "image/jpeg"
    if declared and declared != "application/octet-stream" and declared != actual:
        raise StorageError("The file content doesn't match its type.")
    return actual, hashlib.sha256(data).hexdigest()


def save(folder: str, file_id: str, data: bytes, content_type: str, sha256: str) -> StoredFile:
    relative = f"{folder}/{file_id}.{ALLOWED_TYPES[content_type]}"
    path = storage_root() / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return StoredFile(relative_path=relative, content_type=content_type, size_bytes=len(data), sha256=sha256)


def resolve(relative_path: str) -> Path:
    root = storage_root()
    path = (root / relative_path).resolve()
    if root not in path.parents:
        raise StorageError("Invalid file path.")
    return path


def delete_quietly(relative_path: str) -> None:
    try:
        resolve(relative_path).unlink(missing_ok=True)
    except (OSError, StorageError):
        pass
