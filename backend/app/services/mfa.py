"""Two-step sign-in: TOTP codes (authenticator apps), one-use backup codes and the admin policy.

The policy setting "require_mfa_admin_hr" (platform_settings, default off) makes administrators and HR set up
two-step sign-in before they can use anything other than sign-in and security settings.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import time

import pyotp
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import Account, PlatformSetting
from app.services.scope import HR_ROLES

ISSUER = "TimeZ HRMS"
POLICY_KEY = "require_mfa_admin_hr"
POLICY_ROLES = HR_ROLES | {"admin"}
BACKUP_CODE_COUNT = 10


def new_secret() -> str:
    return pyotp.random_base32()


def otpauth_uri(secret: str, email: str) -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=email, issuer_name=ISSUER)


def _clean(code: str) -> str:
    return "".join(ch for ch in (code or "") if ch.isalnum()).lower()


def totp_step(secret: str, code: str, last_step: int | None = None, now: float | None = None) -> int | None:
    """The time step a 6-digit code matches (30 s window either side), or None. A step already used is refused."""
    code = _clean(code)
    if len(code) != 6 or not code.isdigit():
        return None
    totp = pyotp.TOTP(secret)
    current = int((now if now is not None else time.time()) // totp.interval)
    for step in (current, current - 1, current + 1):
        if hmac.compare_digest(totp.generate_otp(step), code):
            if last_step is not None and step <= last_step:
                return None
            return step
    return None


def _hash_backup(code: str) -> str:
    key = get_settings().jwt_secret.encode()
    return hmac.new(key, _clean(code).encode(), hashlib.sha256).hexdigest()


def new_backup_codes() -> tuple[list[str], list[str]]:
    """(codes to show once, hashes to store)."""
    codes = [f"{secrets.token_hex(2)}-{secrets.token_hex(2)}-{secrets.token_hex(2)}" for _ in range(BACKUP_CODE_COUNT)]
    return codes, [_hash_backup(c) for c in codes]


def use_backup_code(account: Account, code: str) -> bool:
    if len(_clean(code)) != 12:
        return False
    wanted = _hash_backup(code)
    hashes = list(account.mfa_backup_codes or [])
    for h in hashes:
        if hmac.compare_digest(h, wanted):
            hashes.remove(h)
            account.mfa_backup_codes = hashes  # new list so the JSON column is saved
            return True
    return False


def check_code(account: Account, code: str) -> str | None:
    """'totp' or 'backup' when the code is right (and marks it used), else None."""
    if not account.mfa_enabled or not account.mfa_secret:
        return None
    step = totp_step(account.mfa_secret, code, account.mfa_last_step)
    if step is not None:
        account.mfa_last_step = step
        return "totp"
    if use_backup_code(account, code):
        return "backup"
    return None


def policy_on(db: Session) -> bool:
    row = db.get(PlatformSetting, POLICY_KEY)
    return bool(row.value) if row is not None else False


def setup_required(db: Session, account: Account) -> bool:
    """True when the policy applies to this account and it has not set up two-step sign-in yet."""
    return account.role in POLICY_ROLES and not account.mfa_enabled and policy_on(db)
