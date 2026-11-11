"""Employee document repository rules and file storage (STORAGE_DIR/documents/..., same root as expense receipts).

- upload: PDF, PNG, JPEG, GIF, WebP or Word (.docx), at most 10 MB; the content is sniffed, the declared type must match
- every upload of an existing document is a new version; older versions stay downloadable
- who sees a document: the owner, HR whose scope covers the owner, and the owner's managers (anyone above them in
  the line) for the categories HR marks "managers can see" (defaults: MANAGER_CATEGORIES)
- per-category rules (HR / admin, platform setting document_categories): label, HR verification, employee upload,
  manager visibility, expiry date required, required for every employee, allowed file kinds and maximum size
- "Letters" documents are created only by issuing a letter (app/services/letters.py) and are never deleted
- delete is soft (deleted_at): the owner while their own upload is unverified, HR in scope otherwise
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
DOCUMENT_CATEGORIES = ("Personal", "Identity", "Immigration", "Education", "Employment", "Contracts", "Certifications",
                       "Compliance", "Medical", "Payroll", "Policies", "Letters", "Other")
MANAGER_CATEGORIES = frozenset({"Education", "Employment", "Certifications", "Compliance"})
# File kinds a category may allow (HR picks a subset per category) -> the content types they cover.
FILE_KINDS: dict[str, frozenset[str]] = {
    "pdf": frozenset({"application/pdf"}),
    "image": frozenset({"image/png", "image/jpeg", "image/gif", "image/webp"}),
    "docx": frozenset({DOCX}),
}
KIND_LABELS = {"pdf": "PDF", "image": "image", "docx": "Word (.docx)"}
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
    if doc.deleted_at is not None:
        return False
    if owner.id == user.employee_id or is_hr_for(user, owner):
        return True
    return (doc.category in manager_categories(db) and user.employee_id is not None
            and user.employee_id in manager_chain_ids(db, owner.id))


def can_delete(db: Session, user: CurrentUser, doc: EmployeeDocument, owner: Employee) -> str | None:
    """None when this user may delete the document, else the reason (403)."""
    if doc.category == LETTERS_CATEGORY or doc.letter_request_id:
        return "Issued letters stay on record and can't be deleted."
    if is_hr_for(user, owner):
        return None
    if owner.id != user.employee_id:
        return "Only the employee or HR can delete documents."
    if not category_config(db).get(doc.category, {}).get("employee_upload"):
        return "HR manages documents in this category."
    if doc.uploaded_by and doc.uploaded_by != user.id:
        return "HR added this document; ask HR to remove it."
    if doc.verification_status == "verified":
        return "HR has verified this document; ask HR to remove it, or upload a new version."
    return None


def can_upload_for(user: CurrentUser, owner: Employee) -> bool:
    return owner.id == user.employee_id or is_hr_for(user, owner)


# ---------- category configuration and verification (migration 0028) ----------
CATEGORY_SETTING = "document_categories"
# Defaults: what each category is called on screen, whether an employee's own upload waits for HR verification, whether
# employees may upload it themselves (company policies and salary documents come from HR / payroll), whether their
# managers can see it, whether an expiry date is required, whether every employee should have one (folder checklist),
# the file kinds allowed and the maximum size in MB (never above the 10 MB platform limit).
_ALL_KINDS = ["pdf", "image", "docx"]
MAX_MB = MAX_DOCUMENT_BYTES // (1024 * 1024)
DEFAULT_CATEGORY_CONFIG: dict[str, dict[str, object]] = {
    "Personal": {"label": "Personal", "verification": False, "employee_upload": True},
    "Identity": {"label": "Identity proofs", "verification": True, "employee_upload": True, "required": True},
    "Immigration": {"label": "Visas & work permits", "verification": True, "employee_upload": True, "requires_expiry": True},
    "Education": {"label": "Education", "verification": True, "employee_upload": True, "manager_visible": True},
    "Employment": {"label": "Employment", "verification": True, "employee_upload": True, "manager_visible": True},
    "Contracts": {"label": "Contracts", "verification": False, "employee_upload": False},
    "Certifications": {"label": "Certificates", "verification": True, "employee_upload": True, "manager_visible": True},
    "Compliance": {"label": "Compliance", "verification": False, "employee_upload": True, "manager_visible": True},
    "Medical": {"label": "Medical", "verification": False, "employee_upload": True},
    "Payroll": {"label": "Payroll & tax", "verification": False, "employee_upload": False},
    "Policies": {"label": "Company policies", "verification": False, "employee_upload": False},
    "Letters": {"label": "Letters", "verification": False, "employee_upload": False, "types": ["pdf"]},
    "Other": {"label": "Other", "verification": False, "employee_upload": True},
}
_RULE_DEFAULTS: dict[str, object] = {"manager_visible": False, "requires_expiry": False, "required": False,
                                     "types": _ALL_KINDS, "max_mb": MAX_MB}
EXPIRY_REMINDER_DAYS = (30, 7, 0)


def category_config(db: Session) -> dict[str, dict[str, object]]:
    """Defaults overlaid with what HR / admin saved (platform setting document_categories)."""
    from app.services.platform_settings import get_setting

    saved = get_setting(db, CATEGORY_SETTING) or {}
    out: dict[str, dict[str, object]] = {}
    for name, base in DEFAULT_CATEGORY_CONFIG.items():
        mine = saved.get(name) if isinstance(saved, dict) else None
        row = _RULE_DEFAULTS | dict(base)
        if isinstance(mine, dict):
            if isinstance(mine.get("label"), str) and mine["label"].strip():
                row["label"] = mine["label"].strip()[:60]
            for key in ("verification", "employee_upload", "manager_visible", "requires_expiry", "required"):
                if isinstance(mine.get(key), bool):
                    row[key] = mine[key]
            kinds = mine.get("types")
            if isinstance(kinds, list) and any(k in FILE_KINDS for k in kinds):
                row["types"] = [k for k in _ALL_KINDS if k in kinds]
            size = mine.get("max_mb")
            if isinstance(size, int) and not isinstance(size, bool):
                row["max_mb"] = max(1, min(size, MAX_MB))
        if name == LETTERS_CATEGORY:
            row["employee_upload"], row["required"] = False, False
        out[name] = row
    return out


def manager_categories(db: Session) -> frozenset[str]:
    return frozenset(name for name, row in category_config(db).items() if row.get("manager_visible"))


def check_category_file(db: Session, category: str, content_type: str, size: int) -> str | None:
    """None when the file fits the category's rules, else the reason."""
    row = category_config(db).get(category, {})
    label = str(row.get("label", category))
    kinds = [k for k in row.get("types", _ALL_KINDS) if k in FILE_KINDS]  # type: ignore[union-attr]
    if not any(content_type in FILE_KINDS[k] for k in kinds):
        return f"{label} accepts {' or '.join(KIND_LABELS[k] for k in kinds)} files only."
    max_mb = int(row.get("max_mb", MAX_MB))  # type: ignore[call-overload]
    if size > max_mb * 1024 * 1024:
        return f"The file is larger than {max_mb} MB, the limit for {label.lower()}."
    return None


def requires_expiry(db: Session, category: str) -> bool:
    return bool(category_config(db).get(category, {}).get("requires_expiry"))


def needs_verification(db: Session, user: CurrentUser, owner: Employee, category: str) -> bool:
    """An employee's own upload in a category that HR verifies (HR's own uploads count as verified)."""
    return owner.id == user.employee_id and not is_hr_for(user, owner) and bool(category_config(db).get(category, {}).get("verification"))


def can_employee_upload(db: Session, user: CurrentUser, owner: Employee, category: str) -> bool:
    if is_hr_for(user, owner):
        return category != LETTERS_CATEGORY
    return bool(category_config(db).get(category, {}).get("employee_upload"))


def send_expiry_reminders(db: Session, today, send) -> int:  # noqa: ANN001
    """Documents expiring in 30 / 7 / 0 days (or already expired): one reminder to the owner per threshold, and one
    digest a day to the HR team when any document crossed the 7-day or expiry line."""
    from datetime import timedelta

    from sqlalchemy import select

    from app.models import Account, ReminderLog
    from app.services.scope import HR_ROLES

    sent = 0
    urgent = 0
    for doc in db.scalars(select(EmployeeDocument).where(EmployeeDocument.expiry_date.is_not(None),
                                                         EmployeeDocument.deleted_at.is_(None),
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
            urgent += threshold <= 7
    if urgent:
        for hr_id in db.scalars(select(Account.employee_id).where(Account.role.in_(tuple(HR_ROLES)),
                                                                   Account.employee_id.is_not(None))):
            if send(db, f"doc-expiry-hr:{today}", hr_id, today, "document_expiry_hr",
                    f"{urgent} document{'s' if urgent != 1 else ''} expiring within 7 days or expired",
                    "Open Documents & letters > Expiring documents to follow up.", "/documents"):
                sent += 1
    return sent
