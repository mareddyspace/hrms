"""Verification codes for changes to your own personal details (POST /people/me/otp, PATCH /people/me).

Any self-edit that changes a field in OTP_FIELDS (name, date of birth, mobile, personal email, address, emergency
contact) needs a 6-digit code. Preferences (languages, education, experience, career goals) do not.

One open code per person, kept in platform_settings under "profile_otp:<employee id>": the code and the exact new
values are stored only as HMAC hashes, with an expiry (10 minutes) and an attempt count. A good code is used once.
5 wrong tries end the code and lock new codes and checks for 15 minutes ("profile_otp_lock:<employee id>").
A new code can be sent 30 seconds after the last one.

Delivery: the person's in-portal inbox (app/services/security_mail.py) and the email outbox (work email, or the
new personal email when that changes). OTP_DEV_ECHO=true also returns the code in the response; off by default.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
from datetime import date, datetime, timedelta
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import utcnow
from app.models import EmailOutboxItem, Employee, PlatformSetting
from app.services.activity import record_audit
from app.services.security_mail import deliver_security_mail

OTP_FIELDS = (
    "first_name", "middle_name", "last_name", "full_name", "preferred_name", "date_of_birth",
    "mobile", "personal_email",
    "address_line", "address_city", "address_postcode", "address_country",
    "emergency_name", "emergency_relationship", "emergency_phone",
)
OTP_MINUTES = 10
OTP_MAX_ATTEMPTS = 5
LOCK_MINUTES = 15
RESEND_SECONDS = 30


def _key(employee_id: str) -> str:
    return f"profile_otp:{employee_id}"[:64]


def _lock_key(employee_id: str) -> str:
    return f"profile_otp_lock:{employee_id}"[:64]


def _hash(*parts: str) -> str:
    key = get_settings().jwt_secret.encode()
    return hmac.new(key, "\x1f".join(parts).encode(), hashlib.sha256).hexdigest()


def _plain(value: Any) -> Any:
    return value.isoformat() if isinstance(value, (date, datetime)) else value


def _changes_hash(employee_id: str, changes: dict[str, Any]) -> str:
    canon = json.dumps({k: _plain(v) for k, v in sorted(changes.items())}, sort_keys=True, ensure_ascii=False)
    return _hash(employee_id, "changes", canon)


def sensitive_changes(emp: Employee, values: dict[str, Any]) -> dict[str, Any]:
    """The OTP fields in `values` whose new value differs from the record (clearing one counts)."""
    return {f: values[f] for f in OTP_FIELDS if f in values and values[f] != getattr(emp, f, None)}


def _locked_until(db: Session, emp: Employee) -> datetime | None:
    row = db.get(PlatformSetting, _lock_key(emp.id))
    if row is None or not isinstance(row.value, dict):
        return None
    until = datetime.fromisoformat(row.value["until"])
    if until <= utcnow():
        db.delete(row)
        return None
    return until


def _raise_if_locked(db: Session, emp: Employee) -> None:
    until = _locked_until(db, emp)
    if until is not None:
        minutes = max(1, -(-int((until - utcnow()).total_seconds()) // 60))
        raise HTTPException(429, f"Too many wrong codes. Try again in {minutes} minute{'s' if minutes != 1 else ''}.")


def _save(db: Session, key: str, value: dict[str, Any], actor_id: str) -> None:
    row = db.get(PlatformSetting, key)
    if row is None:
        db.add(PlatformSetting(key=key, value=value, updated_by=actor_id))
    else:
        row.value = value
        row.updated_by = actor_id


def issue(db: Session, emp: Employee, changes: dict[str, Any], actor_id: str) -> tuple[str, datetime, str, str]:
    """Creates (or replaces) the code for exactly these changes.

    Returns (code, expires_at, outbox address, inbox href). Raises 429 while locked or within 30 s of the last code.
    Caller commits.
    """
    _raise_if_locked(db, emp)
    now = utcnow()
    old = db.get(PlatformSetting, _key(emp.id))
    if old is not None and isinstance(old.value, dict) and old.value.get("issued_at"):
        wait = RESEND_SECONDS - int((now - datetime.fromisoformat(old.value["issued_at"])).total_seconds())
        if wait > 0:
            raise HTTPException(429, f"Wait {wait} seconds before sending another code.")
    code = f"{secrets.randbelow(1_000_000):06d}"
    expires = now + timedelta(minutes=OTP_MINUTES)
    _save(db, _key(emp.id), {
        "code_hash": _hash(emp.id, "code", code),
        "changes_hash": _changes_hash(emp.id, changes),
        "fields": sorted(changes),
        "issued_at": now.isoformat(),
        "expires_at": expires.isoformat(),
        "attempts": 0,
    }, actor_id)
    text = f"Your code is {code}. It expires in {OTP_MINUTES} minutes."
    href = deliver_security_mail(db, emp.id, "Your TimeZ verification code", text, code=code)
    new_email = changes.get("personal_email")
    to = new_email if isinstance(new_email, str) and new_email else emp.email
    if to:
        db.add(EmailOutboxItem(
            recipient_id=emp.id, to_email=to, subject="Your TimeZ verification code",
            body=f"{text} Use it to save the changes to your profile.",
            link="/profile", category="System", channel="general", status="Queued",
        ))
    return code, expires, to or "", href


def check(db: Session, emp: Employee, changes: dict[str, Any], code: str | None, *, actor_id: str, ip: str | None) -> None:
    """Raises unless the code matches these exact changes. A good code is used up. Caller commits."""
    _raise_if_locked(db, emp)
    if not code or not code.strip():
        raise HTTPException(400, "Enter the verification code to save these changes.")
    row = db.get(PlatformSetting, _key(emp.id))
    if row is None or not isinstance(row.value, dict) or "changes_hash" not in row.value:
        raise HTTPException(400, "Send a verification code first.")
    data = dict(row.value)
    if datetime.fromisoformat(data["expires_at"]) < utcnow():
        db.delete(row)
        db.commit()
        raise HTTPException(400, "That code has expired. Send a new one.")
    if not hmac.compare_digest(data["code_hash"], _hash(emp.id, "code", code.strip())):
        attempts = int(data.get("attempts", 0)) + 1
        if attempts >= OTP_MAX_ATTEMPTS:
            db.delete(row)
            until = utcnow() + timedelta(minutes=LOCK_MINUTES)
            _save(db, _lock_key(emp.id), {"until": until.isoformat()}, actor_id)
            record_audit(db, actor_id=actor_id, action="locked profile verification", entity="employee", entity_id=emp.id,
                         subject_id=emp.id, before=None, after={"minutes": LOCK_MINUTES}, ip=ip)
            db.commit()
            raise HTTPException(429, f"Too many wrong codes. Try again in {LOCK_MINUTES} minutes.")
        row.value = {**data, "attempts": attempts}
        db.commit()
        left = OTP_MAX_ATTEMPTS - attempts
        raise HTTPException(400, f"That code is not correct. {left} {'try' if left == 1 else 'tries'} left.")
    if not hmac.compare_digest(data["changes_hash"], _changes_hash(emp.id, changes)):
        raise HTTPException(400, "The code was sent for different details. Send a new one.")
    db.delete(row)
