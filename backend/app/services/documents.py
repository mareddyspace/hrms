"""Employee document repository rules and file storage (STORAGE_DIR/documents/..., same root as expense receipts).

- upload: PDF, PNG, JPEG, GIF, WebP or Word (.docx), at most 10 MB; the content is sniffed, the declared type must match
- every upload of an existing document is a new version; older versions stay downloadable
- who sees a document: the owner, HR whose scope covers the owner, and the owner's managers (anyone above them in
  the line) for the categories in MANAGER_CATEGORIES only
- "Letters" documents are created only by issuing a letter (app/services/letters.py)
"""

from __future__ import annotations

import hashlib
import io
import re
import zipfile
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.deps import CurrentUser
from app.models import Employee, EmployeeDocument
from app.services import storage
from app.services.scope import HR_ROLES, manager_chain_ids

MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
DOCUMENT_TYPES = {**storage.ALLOWED_TYPES, DOCX: "docx"}
DOCUMENT_CATEGORIES = ("Identity", "Education", "Employment", "Certifications", "Compliance", "Medical", "Payroll", "Letters",
                       "Other")
MANAGER_CATEGORIES = frozenset({"Education", "Employment", "Certifications", "Compliance"})
LETTERS_CATEGORY = "Letters"


class DocumentError(ValueError):
    """The upload was refused; the message is safe to show the user."""


def sniff(data: bytes) -> str | None:
    found = storage.sniff(data)
    if found:
        return found
    if data.startswith(b"PK\x03\x04"):
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                if "word/document.xml" in zf.namelist():
                    return DOCX
        except zipfile.BadZipFile:
            return None
    return None


def check_upload(data: bytes, declared_type: str | None) -> tuple[str, str]:
    """Returns (content type, sha256)."""
    if not data:
        raise DocumentError("The file is empty.")
    if len(data) > MAX_DOCUMENT_BYTES:
        raise DocumentError("The file is larger than 10 MB.")
    actual = sniff(data)
    if actual is None:
        raise DocumentError("Only PDF, image (PNG, JPEG, GIF, WebP) or Word (.docx) files are accepted.")
    declared = (declared_type or "").split(";")[0].strip().lower()
    if declared == "image/jpg":
        declared = "image/jpeg"
    if declared and declared != "application/octet-stream" and declared != actual:
        raise DocumentError("The file content doesn't match its type.")
    return actual, hashlib.sha256(data).hexdigest()


@dataclass
class SavedFile:
    relative_path: str
    size_bytes: int
    sha256: str


def save_bytes(folder: str, file_id: str, data: bytes, content_type: str) -> SavedFile:
    relative = f"{folder}/{file_id}.{DOCUMENT_TYPES[content_type]}"
    storage.put_bytes(relative, data, content_type)
    return SavedFile(relative_path=relative, size_bytes=len(data), sha256=hashlib.sha256(data).hexdigest())


def clean_name(raw: str | None, content_type: str, fallback: str = "document") -> str:
    name = re.split(r"[\\/]", raw or "")[-1]
    name = re.sub(r"[^\w.\- ()]", "_", name).strip(" .")[:200]
    return name or f"{fallback}.{DOCUMENT_TYPES[content_type]}"


def is_hr_for(user: CurrentUser, emp: Employee) -> bool:
    return user.account.role in HR_ROLES and user.scope.can_see(emp)


def can_see_document(db: Session, user: CurrentUser, doc: EmployeeDocument, owner: Employee) -> bool:
    if owner.id == user.employee_id or is_hr_for(user, owner):
        return True
    return doc.category in MANAGER_CATEGORIES and user.employee_id is not None and user.employee_id in manager_chain_ids(db, owner.id)


def can_upload_for(user: CurrentUser, owner: Employee) -> bool:
    return owner.id == user.employee_id or is_hr_for(user, owner)
