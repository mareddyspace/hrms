"""Verification codes for own mobile / personal email changes (POST /people/me/otp, PATCH /people/me).

One open code per person and field, kept in platform_settings under "profile_otp:<employee id>:<field>":
the code and the new value are stored only as HMAC hashes, with an expiry (10 minutes) and an attempt count
(5 wrong tries end the code). The code is emailed through the email outbox: to the new address for a personal
email change, to the work email for a mobile change (no SMS gateway). OTP_DEV_ECHO=true also returns it in the
response for local testing; it is off by default.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import utcnow
from app.models import EmailOutboxItem, Employee, PlatformSetting

OTP_FIELDS = ("mobile", "personal_email")
OTP_MINUTES = 10
OTP_MAX_ATTEMPTS = 5
FIELD_LABEL = {"mobile": "mobile number", "personal_email": "personal email"}


def _key(employee_id: str, field: str) -> str:
    return f"profile_otp:{employee_id}:{field}"[:64]


def _hash(*parts: str) -> str:
    key = get_settings().jwt_secret.encode()
    return hmac.new(key, "\x1f".join(parts).encode(), hashlib.sha256).hexdigest()


def issue(db: Session, emp: Employee, field: str, value: str, actor_id: str) -> tuple[str, datetime, str]:
    """Creates (or replaces) the code. Returns (code, expires_at, address it was sent to). Caller commits."""
    code = f"{secrets.randbelow(1_000_000):06d}"
    expires = utcnow() + timedelta(minutes=OTP_MINUTES)
    row = db.get(PlatformSetting, _key(emp.id, field))
    data = {
        "code_hash": _hash(emp.id, field, code),
        "value_hash": _hash(emp.id, field, "value", value),
        "expires_at": expires.isoformat(),
        "attempts": 0,
    }
    if row is None:
        db.add(PlatformSetting(key=_key(emp.id, field), value=data, updated_by=actor_id))
    else:
        row.value = data
        row.updated_by = actor_id
    to = value if field == "personal_email" else emp.email
    if to:
        db.add(EmailOutboxItem(
            recipient_id=emp.id, to_email=to, subject="Your TimeZ verification code",
            body=f"Your code to change your {FIELD_LABEL[field]} is {code}. It expires in {OTP_MINUTES} minutes.",
            link="/profile", category="System", channel="general", status="Queued",
        ))
    return code, expires, to or ""


def check(db: Session, emp: Employee, field: str, value: str, code: str | None) -> None:
    """Raises 400 unless the code matches this field and value. A good code is used up. Caller commits."""
    row = db.get(PlatformSetting, _key(emp.id, field))
    label = FIELD_LABEL[field]
    if not code:
        raise HTTPException(400, f"Enter the verification code to change your {label}.")
    if row is None or not isinstance(row.value, dict):
        raise HTTPException(400, "Send a verification code first.")
    data = dict(row.value)
    if datetime.fromisoformat(data["expires_at"]) < utcnow():
        db.delete(row)
        db.commit()
        raise HTTPException(400, "That code has expired. Send a new one.")
    if not hmac.compare_digest(data["value_hash"], _hash(emp.id, field, "value", value)):
        raise HTTPException(400, f"The code was sent for a different {label}. Send a new one.")
    if not hmac.compare_digest(data["code_hash"], _hash(emp.id, field, code.strip())):
        attempts = int(data.get("attempts", 0)) + 1
        if attempts >= OTP_MAX_ATTEMPTS:
            db.delete(row)
            db.commit()
            raise HTTPException(400, "Too many wrong codes. Send a new code and try again.")
        row.value = {**data, "attempts": attempts}
        db.commit()
        raise HTTPException(400, f"That verification code is not correct. {OTP_MAX_ATTEMPTS - attempts} tries left.")
    db.delete(row)
