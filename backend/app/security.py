"""Password hashing (argon2id) and JWT tokens."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from typing import Any

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from app.config import get_settings
from app.db import utcnow

_hasher = PasswordHasher()
ALGORITHM = "HS256"
# Used to spend the same time on unknown emails as on wrong passwords.
_DUMMY_HASH = _hasher.hash("timez-dummy-password")


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str | None) -> bool:
    try:
        return _hasher.verify(password_hash or _DUMMY_HASH, password) and password_hash is not None
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def _encode(claims: dict[str, Any]) -> str:
    return jwt.encode(claims, get_settings().jwt_secret, algorithm=ALGORITHM)


def create_access_token(account_id: str, role: str, session_id: str | None = None) -> tuple[str, int]:
    settings = get_settings()
    now = utcnow()
    ttl = timedelta(minutes=settings.access_token_minutes)
    claims = {"sub": account_id, "role": role, "type": "access", "iat": now, "exp": now + ttl, "jti": uuid.uuid4().hex}
    if session_id:
        claims["sid"] = session_id  # the signed-in device (refresh_tokens.session_id)
    token = _encode(claims)
    return token, int(ttl.total_seconds())


def create_mfa_token(account_id: str, minutes: int = 5) -> str:
    """Short-lived token between the password step and the code step of a two-step sign-in."""
    now = utcnow()
    return _encode({"sub": account_id, "type": "mfa", "iat": now, "exp": now + timedelta(minutes=minutes), "jti": uuid.uuid4().hex})


def create_refresh_token(account_id: str) -> tuple[str, str, datetime]:
    settings = get_settings()
    now = utcnow()
    jti = uuid.uuid4().hex
    expires = now + timedelta(days=settings.refresh_token_days)
    token = _encode({"sub": account_id, "type": "refresh", "iat": now, "exp": expires, "jti": jti})
    return token, jti, expires


def decode_token(token: str, expected_type: str) -> dict[str, Any] | None:
    try:
        claims = jwt.decode(token, get_settings().jwt_secret, algorithms=[ALGORITHM], options={"require": ["exp", "sub", "type"]})
    except jwt.PyJWTError:
        return None
    if claims.get("type") != expected_type:
        return None
    return claims
