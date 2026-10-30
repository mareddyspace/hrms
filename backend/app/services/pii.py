"""Masking of sensitive personal details (phone, personal email, date of birth, address, ID / bank numbers).

API responses always carry the masked form. The full value comes only from a reveal endpoint, and only for the
person themselves or HR within their data scope (the HR reveal is audited, without the value). Not admin or executive.
"""

from __future__ import annotations

import re
from datetime import date
from typing import TYPE_CHECKING

from sqlalchemy.orm import Session

from app.services.activity import record_audit
from app.services.scope import HR_ROLES

if TYPE_CHECKING:
    from app.deps import CurrentUser
    from app.models import Employee

DOT = "•"
REVEAL_ROLES = HR_ROLES  # not admin / executive: a system admin or the CEO gets basic profiles, no PII (src/data/rbac.ts)


def mask_phone(value: str | None) -> str | None:
    """"+91 98450 22110" -> "+91 ••••• 22110" (country code + last 5 digits, or last 4 for short numbers)."""
    if not value or not value.strip():
        return None
    v = value.strip()
    if DOT in v:
        return v
    digits = re.sub(r"\D", "", v)
    country = re.match(r"^\+\d{1,3}(?=[\s\-(])", v)
    if country is None and v.startswith("+") and len(digits) > 10:  # "+919845022110"
        country = re.match(r"^\+\d{%d}" % (len(digits) - 10), v)
    local = digits[len(country.group(0)) - 1:] if country else digits
    if len(local) < 6:
        return DOT * 4
    keep = 5 if len(local) >= 10 else 4
    return f"{country.group(0) + ' ' if country else ''}{DOT * 5} {local[-keep:]}"


def mask_email(value: str | None) -> str | None:
    """"babu@gmail.com" -> "b•••@gmail.com"."""
    if not value or not value.strip():
        return None
    v = value.strip()
    if DOT in v:
        return v
    local, _, domain = v.partition("@")
    if not local or not domain:
        return DOT * 4
    return f"{local[0]}{DOT * 3}@{domain}"


def mask_dob(value: date | str | None) -> str | None:
    """Year only: "•• ••• 1990"."""
    if not value:
        return None
    if isinstance(value, str) and DOT in value:
        return value
    year = value.year if isinstance(value, date) else str(value)[:4]
    return f"{DOT * 2} {DOT * 3} {year}"


def mask_address(value: str | None) -> str | None:
    """City / country only (the last two comma parts), else "••••"."""
    if not value or not value.strip():
        return None
    if DOT in value:
        return value
    parts = [p.strip() for p in value.split(",") if p.strip()]
    return ", ".join(parts[-2:]) if len(parts) >= 3 else DOT * 4


def mask_id(value: str | None) -> str | None:
    """Tax / national ID or bank account: "•••• 1234"."""
    if not value or not value.strip():
        return None
    if DOT in value:
        return value
    v = re.sub(r"\s", "", value)
    return DOT * 4 if len(v) <= 4 else f"{DOT * 4} {v[-4:]}"


def is_masked(value: object) -> bool:
    return isinstance(value, str) and DOT in value


# Employee fields that are masked in responses and may be revealed.
EMPLOYEE_FIELDS = {"mobile": mask_phone, "personal_email": mask_email, "date_of_birth": mask_dob}


def can_reveal_employee(user: CurrentUser, emp: Employee) -> bool:
    """The person themselves, or HR / admin whose data scope covers them."""
    if user.employee_id and user.employee_id == emp.id:
        return True
    return user.account.role in REVEAL_ROLES and user.scope.can_see(emp)


def audit_reveal(db: Session, user: CurrentUser, *, entity: str, entity_id: str, field: str,
                 subject_id: str | None, ip: str | None) -> None:
    """Records who viewed which detail of whom. Never the value."""
    record_audit(db, actor_id=user.id, action="viewed personal detail", entity=entity, entity_id=entity_id,
                 subject_id=subject_id, after={"field": field}, ip=ip)


def mask_text(value: str | None) -> str | None:
    """Street line or postcode: fully hidden ("••••")."""
    if not value or not value.strip():
        return None
    return value if DOT in value else DOT * 4


# Profile fields added in migration 0008: masked in responses, revealable like the ones above.
EMPLOYEE_FIELDS.update({"address_line": mask_text, "address_postcode": mask_text, "emergency_phone": mask_phone})


def mask_for_audit(field: str, value: object) -> object:
    """The value written to audit_log for a profile change: sensitive fields are masked, never stored in full."""
    masker = EMPLOYEE_FIELDS.get(field)
    if masker is None or value in (None, ""):
        return value
    return masker(value)  # type: ignore[operator]
