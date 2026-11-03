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
from app.services.scope import HR_ACCESS_ROLES, manager_chain_ids

MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
DOCUMENT_TYPES = {**storage.ALLOWED_TYPES, DOCX: "docx"}
DOCUMENT_CATEGORIES = ("Personal", "Identity", "Education", "Employment", "Contracts", "Certifications", "Compliance",
                       "Medical", "Payroll", "Policies", "Letters", "Other")
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
    return user.account.role in HR_ACCESS_ROLES and user.scope.can_see(emp)


def can_see_document(db: Session, user: CurrentUser, doc: EmployeeDocument, owner: Employee) -> bool:
    if owner.id == user.employee_id or is_hr_for(user, owner):
        return True
    return doc.category in MANAGER_CATEGORIES and user.employee_id is not None and user.employee_id in manager_chain_ids(db, owner.id)


def can_upload_for(user: CurrentUser, owner: Employee) -> bool:
    return owner.id == user.employee_id or is_hr_for(user, owner)


# ---------- category configuration and verification (migration 0028) ----------
CATEGORY_SETTING = "document_categories"
# Defaults: what each category is called on screen, whether an employee's own upload waits for HR verification, and
# whether employees may upload it themselves (company policies and salary documents come from HR / payroll).
DEFAULT_CATEGORY_CONFIG: dict[str, dict[str, object]] = {
    "Personal": {"label": "Personal", "verification": False, "employee_upload": True},
    "Identity": {"label": "Identity proofs", "verification": True, "employee_upload": True},
    "Education": {"label": "Education certificates", "verification": True, "employee_upload": True},
    "Employment": {"label": "Employment", "verification": True, "employee_upload": True},
    "Contracts": {"label": "Contracts", "verification": False, "employee_upload": False},
    "Certifications": {"label": "Certifications", "verification": True, "employee_upload": True},
    "Compliance": {"label": "Compliance", "verification": False, "employee_upload": True},
    "Medical": {"label": "Medical", "verification": False, "employee_upload": True},
    "Payroll": {"label": "Salary documents", "verification": False, "employee_upload": False},
    "Policies": {"label": "Company policies", "verification": False, "employee_upload": False},
    "Letters": {"label": "Letters", "verification": False, "employee_upload": False},
    "Other": {"label": "Other", "verification": False, "employee_upload": True},
}
EXPIRY_REMINDER_DAYS = (30, 7, 0)


def category_config(db: Session) -> dict[str, dict[str, object]]:
    """Defaults overlaid with what HR / admin saved (platform setting document_categories)."""
    from app.services.platform_settings import get_setting

    saved = get_setting(db, CATEGORY_SETTING) or {}
    out: dict[str, dict[str, object]] = {}
    for name, base in DEFAULT_CATEGORY_CONFIG.items():
        mine = saved.get(name) if isinstance(saved, dict) else None
        row = dict(base)
        if isinstance(mine, dict):
            if isinstance(mine.get("label"), str) and mine["label"].strip():
                row["label"] = mine["label"].strip()[:60]
            for key in ("verification", "employee_upload"):
                if isinstance(mine.get(key), bool):
                    row[key] = mine[key]
        if name == LETTERS_CATEGORY:
            row["employee_upload"] = False
        out[name] = row
    return out


def needs_verification(db: Session, user: CurrentUser, owner: Employee, category: str) -> bool:
    """An employee's own upload in a category that HR verifies (HR's own uploads count as verified)."""
    return owner.id == user.employee_id and not is_hr_for(user, owner) and bool(category_config(db).get(category, {}).get("verification"))


def can_employee_upload(db: Session, user: CurrentUser, owner: Employee, category: str) -> bool:
    if is_hr_for(user, owner):
        return category != LETTERS_CATEGORY
    return bool(category_config(db).get(category, {}).get("employee_upload"))


def send_expiry_reminders(db: Session, today, send) -> int:  # noqa: ANN001
    """Documents expiring in 30 / 7 / 0 days (or already expired): one reminder to the owner per threshold."""
    from datetime import timedelta

    from sqlalchemy import select

    from app.models import ReminderLog

    sent = 0
    for doc in db.scalars(select(EmployeeDocument).where(EmployeeDocument.expiry_date.is_not(None),
                                                         EmployeeDocument.expiry_date <= today + timedelta(days=30))):
        days = (doc.expiry_date - today).days
        threshold = next((t for t in sorted(EXPIRY_REMINDER_DAYS) if days <= t), None)
        if threshold is None:
            continue
        key = f"doc-expiry:{doc.id}:{doc.expiry_date}:{threshold}"
        if db.scalar(select(ReminderLog.id).where(ReminderLog.item_key == key)) is not None:
            continue
        when = "has expired" if days < 0 else "expires today" if days == 0 else f"expires in {days} day{'s' if days != 1 else ''}"
        if send(db, key, doc.employee_id, today, "document_expiry", f"{doc.title} {when}",
                "Upload a renewed copy in Documents & letters.", "/documents"):
            sent += 1
    return sent
