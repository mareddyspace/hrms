"""File storage for uploads (receipts, CVs, employee documents, letter PDFs, HR case and service desk files).

Two backends, picked by STORAGE_BACKEND (environment or backend/.env):
- "local" (default): files under STORAGE_DIR, default ./storage relative to backend/. git ignores backend/storage/.
- "s3": any S3-compatible bucket (Backblaze B2, Cloudflare R2, AWS S3, MinIO) via boto3. Needs S3_ENDPOINT_URL,
  S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY and S3_BUCKET. Downloads are streamed, never buffered whole.
  ("r2" and the R2_* names are accepted as aliases; R2_ACCOUNT_ID builds the R2 endpoint.)

Every caller works with a relative key such as "receipts/emp-1/rcpt-123.pdf" (forward slashes), which is what the
database stores; the backend decides where the bytes live. Files are named by a generated id, never by the
uploaded file name.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import quote

from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.config import BACKEND_DIR

MAX_RECEIPT_BYTES = 5 * 1024 * 1024
ALLOWED_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "application/pdf": "pdf"}
DOWNLOAD_HEADERS = {"X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store"}
_CHUNK = 64 * 1024


class _StorageSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", env_file_encoding="utf-8", extra="ignore")
    storage_backend: str = "local"
    storage_dir: str = "./storage"
    s3_endpoint_url: str = Field(default="", validation_alias=AliasChoices("S3_ENDPOINT_URL", "R2_ENDPOINT"))
    s3_region: str = Field(default="", validation_alias=AliasChoices("S3_REGION", "R2_REGION"))
    s3_access_key_id: str = Field(default="", repr=False, validation_alias=AliasChoices("S3_ACCESS_KEY_ID", "R2_ACCESS_KEY_ID"))
    s3_secret_access_key: str = Field(default="", repr=False,
                                      validation_alias=AliasChoices("S3_SECRET_ACCESS_KEY", "R2_SECRET_ACCESS_KEY"))
    s3_bucket: str = Field(default="", validation_alias=AliasChoices("S3_BUCKET", "R2_BUCKET"))
    r2_account_id: str = Field(default="", validation_alias="R2_ACCOUNT_ID")  # alias only: builds the R2 endpoint

    @property
    def endpoint(self) -> str:
        if self.s3_endpoint_url.strip():
            return self.s3_endpoint_url.strip().rstrip("/")
        if self.r2_account_id.strip():
            return f"https://{self.r2_account_id.strip()}.r2.cloudflarestorage.com"
        return ""

    @property
    def region(self) -> str:
        """S3_REGION, else the region inside a Backblaze endpoint (s3.<region>.backblazeb2.com), else 'auto' (R2)."""
        if self.s3_region.strip():
            return self.s3_region.strip()
        host = self.endpoint.split("://", 1)[-1].split("/", 1)[0]
        parts = host.split(".")
        if len(parts) >= 4 and parts[0] == "s3" and host.endswith(".backblazeb2.com"):
            return parts[1]
        return "auto" if "r2.cloudflarestorage.com" in host else "us-east-1"


def _settings() -> _StorageSettings:
    """Read on every call so tests (and a changed environment) take effect without a restart."""
    return _StorageSettings()


def storage_root() -> Path:
    raw = Path(_settings().storage_dir)
    return raw if raw.is_absolute() else (BACKEND_DIR / raw).resolve()


class StorageError(ValueError):
    """The upload was refused or the key is invalid; the message is safe to show the user."""


class FileMissing(StorageError):
    """The key is valid but no file is stored under it."""


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


def check_key(relative_path: str) -> str:
    """A safe relative key: forward slashes, no '..', not absolute, no empty parts."""
    key = (relative_path or "").replace("\\", "/")
    parts = key.split("/")
    if not key or key.startswith("/") or ":" in parts[0] or any(p in ("", ".", "..") for p in parts):
        raise StorageError("Invalid file path.")
    return key


# ---------- backends ----------
class _Backend(Protocol):
    def put(self, key: str, data: bytes, content_type: str) -> None: ...
    def response(self, key: str, media_type: str, filename: str | None, headers: dict[str, str]) -> Response: ...
    def delete(self, key: str) -> None: ...


class LocalBackend:
    def __init__(self, root: Path) -> None:
        self.root = root

    def path(self, key: str) -> Path:
        path = (self.root / check_key(key)).resolve()
        if self.root not in path.parents:
            raise StorageError("Invalid file path.")
        return path

    def put(self, key: str, data: bytes, content_type: str) -> None:
        path = self.path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def response(self, key: str, media_type: str, filename: str | None, headers: dict[str, str]) -> Response:
        path = self.path(key)
        if not path.is_file():
            raise FileMissing("The file is no longer available.")
        return FileResponse(path, media_type=media_type, filename=filename, headers=headers)

    def delete(self, key: str) -> None:
        self.path(key).unlink(missing_ok=True)


def _content_disposition(filename: str) -> str:
    """Same format Starlette's FileResponse uses."""
    quoted = quote(filename)
    if quoted != filename:
        return f"attachment; filename*=utf-8''{quoted}"
    return f'attachment; filename="{filename}"'


def _make_s3_client(s: _StorageSettings) -> Any:
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3",
        endpoint_url=s.endpoint,
        aws_access_key_id=s.s3_access_key_id.strip(),
        aws_secret_access_key=s.s3_secret_access_key.strip(),
        region_name=s.region,
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path"},  # works on every S3-compatible service
            retries={"max_attempts": 3, "mode": "standard"},
            connect_timeout=10,
            read_timeout=60,
            # Some S3-compatible services reject the newer default checksum headers; send them only when required.
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
        ),
    )


_client_cache: dict[tuple[str, str, str, str], Any] = {}


def _s3_client(s: _StorageSettings) -> Any:
    cache_key = (s.endpoint, s.region, s.s3_access_key_id, s.s3_secret_access_key)
    client = _client_cache.get(cache_key)
    if client is None:
        client = _client_cache[cache_key] = _make_s3_client(s)
    return client


def _is_missing(exc: Exception) -> bool:
    response = getattr(exc, "response", None) or {}
    code = str(response.get("Error", {}).get("Code", ""))
    status = response.get("ResponseMetadata", {}).get("HTTPStatusCode")
    return code in ("NoSuchKey", "404", "NotFound") or status == 404


class S3Backend:
    def __init__(self, client: Any, bucket: str) -> None:
        self.client = client
        self.bucket = bucket

    def put(self, key: str, data: bytes, content_type: str) -> None:
        self.client.put_object(Bucket=self.bucket, Key=check_key(key), Body=data, ContentType=content_type)

    def response(self, key: str, media_type: str, filename: str | None, headers: dict[str, str]) -> Response:
        try:
            obj = self.client.get_object(Bucket=self.bucket, Key=check_key(key))
        except Exception as exc:
            if _is_missing(exc):
                raise FileMissing("The file is no longer available.") from exc
            raise
        body = obj["Body"]

        def chunks() -> Iterator[bytes]:
            try:
                yield from body.iter_chunks(_CHUNK)
            finally:
                body.close()

        out = dict(headers)
        if obj.get("ContentLength") is not None:
            out["Content-Length"] = str(obj["ContentLength"])
        if filename:
            out["Content-Disposition"] = _content_disposition(filename)
        return StreamingResponse(chunks(), media_type=media_type, headers=out)

    def delete(self, key: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=check_key(key))


def backend_name() -> str:
    return (_settings().storage_backend or "local").strip().lower()


def get_backend() -> _Backend:
    s = _settings()
    name = (s.storage_backend or "local").strip().lower()
    if name == "local":
        return LocalBackend(storage_root())
    if name in ("s3", "r2"):
        missing = [n for n, v in (("S3_ENDPOINT_URL", s.endpoint), ("S3_ACCESS_KEY_ID", s.s3_access_key_id),
                                  ("S3_SECRET_ACCESS_KEY", s.s3_secret_access_key), ("S3_BUCKET", s.s3_bucket)) if not v.strip()]
        if missing:
            raise RuntimeError(f"STORAGE_BACKEND=s3 needs {', '.join(missing)}.")
        return S3Backend(_s3_client(s), s.s3_bucket.strip())
    raise RuntimeError(f"Unknown STORAGE_BACKEND {name!r} (use 'local' or 's3').")


def check_configuration() -> str:
    """Called at startup: fails fast on a half-configured bucket. Returns a log-safe description."""
    backend = get_backend()
    if isinstance(backend, S3Backend):
        s = _settings()
        return f"s3 bucket {backend.bucket!r} at {s.endpoint} (region {s.region})"
    return f"local folder {storage_root()}"


# ---------- the API the routers use ----------
def put_bytes(relative_path: str, data: bytes, content_type: str) -> None:
    """Store bytes under a relative key (overwrites)."""
    get_backend().put(check_key(relative_path), data, content_type)


def save(folder: str, file_id: str, data: bytes, content_type: str, sha256: str) -> StoredFile:
    relative = f"{folder}/{file_id}.{ALLOWED_TYPES[content_type]}"
    put_bytes(relative, data, content_type)
    return StoredFile(relative_path=relative, content_type=content_type, size_bytes=len(data), sha256=sha256)


def download(relative_path: str, *, media_type: str, filename: str | None = None,
             headers: dict[str, str] | None = None) -> Response:
    """A response that sends the stored file. Raises StorageError (bad key) or FileMissing (nothing stored)."""
    return get_backend().response(check_key(relative_path), media_type, filename,
                                  DOWNLOAD_HEADERS if headers is None else headers)


def resolve(relative_path: str) -> Path:
    """Local backend only: the file's path on disk (used by tests and local tooling)."""
    return LocalBackend(storage_root()).path(relative_path)


def delete_quietly(relative_path: str) -> None:
    try:
        get_backend().delete(check_key(relative_path))
    except Exception:  # noqa: BLE001 - clean-up must never mask the original error
        pass
