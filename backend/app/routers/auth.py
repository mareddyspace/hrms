from __future__ import annotations

import uuid
from datetime import timedelta

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import func, select

from app.config import get_settings
from app.db import utcnow
from app.deps import CurrentUserDep, DbSession, client_ip
from app.models import Account, RefreshToken
from app.schemas import ChangePasswordIn, LoginIn, MeOut, RefreshIn, TokenOut
from app.schemas.account_security import MfaLoginOut, MfaVerifyIn
from app.security import (
    create_access_token, create_mfa_token, create_refresh_token, decode_token, hash_password, password_needs_rehash,
    verify_password,
)
from app.services import login_throttle, mfa
from app.services.activity import record_audit

router = APIRouter(prefix="/auth", tags=["auth"])

LOGIN_FAILED = "Invalid email or password."
CODE_FAILED = "That code is not right. Try again."
TOO_MANY = "Too many failed sign-in attempts from this device. Try again in a few minutes."


def _throttle(request: Request) -> None:
    """429 once this client (IP) has failed too many sign-ins recently (services/login_throttle.py)."""
    wait = login_throttle.retry_after(client_ip(request))
    if wait is not None:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, TOO_MANY, headers={"Retry-After": str(wait)})


def _fail(request: Request, detail: str) -> HTTPException:
    login_throttle.record_failure(client_ip(request))
    return HTTPException(status.HTTP_401_UNAUTHORIZED, detail)


def user_agent(request: Request) -> str | None:
    return (request.headers.get("user-agent") or "")[:300] or None


def _issue_tokens(db: DbSession, account: Account, request: Request | None = None,
                  previous: RefreshToken | None = None) -> TokenOut:
    """New access + refresh token. A refresh keeps the session (signed-in device) of the token it replaces."""
    now = utcnow()
    session_id = (previous.session_id or previous.jti) if previous is not None else uuid.uuid4().hex
    started = (previous.session_started_at or previous.created_at) if previous is not None else now
    access, expires_in = create_access_token(account.id, account.role, session_id)
    refresh, jti, expires_at = create_refresh_token(account.id)
    db.add(RefreshToken(
        jti=jti, account_id=account.id, expires_at=expires_at, session_id=session_id, session_started_at=started,
        last_used_at=now,
        ip=(client_ip(request) if request is not None else None) or (previous.ip if previous is not None else None),
        user_agent=(user_agent(request) if request is not None else None) or (previous.user_agent if previous is not None else None),
    ))
    return TokenOut(access_token=access, refresh_token=refresh, expires_in=expires_in)


def _audit_auth(db: DbSession, account: Account, request: Request, action: str, result: str,
                after: dict | None = None) -> None:
    record_audit(db, actor_id=account.id, action=action, entity="account", entity_id=account.id, ip=client_ip(request),
                 result=result, user_agent=user_agent(request), after=after)


def _failed_attempt(db: DbSession, account: Account, request: Request, action: str) -> None:
    settings = get_settings()
    account.failed_attempts = (account.failed_attempts or 0) + 1
    if account.failed_attempts >= settings.max_failed_logins:
        account.locked_until = utcnow() + timedelta(minutes=settings.lockout_minutes)
        account.failed_attempts = 0
        action = "account_locked"
    _audit_auth(db, account, request, action, "failure")
    db.commit()


def _finish_login(db: DbSession, account: Account, request: Request, method: str) -> MfaLoginOut:
    settings = get_settings()
    now = utcnow()
    previous_login = account.last_login_at
    # The 90-day rule measures the password's age, not the time since the last sign-in. Accounts with no recorded
    # change date (older rows, seeded accounts) start the clock now, so nobody is forced to change at once.
    if account.password_changed_at is None:
        account.password_changed_at = now
    elif now - account.password_changed_at > timedelta(days=settings.password_stale_days):
        account.must_change_password = True
    account.failed_attempts = 0
    account.locked_until = None
    account.last_login_at = now
    tokens = MfaLoginOut(**_issue_tokens(db, account, request).model_dump())
    tokens.last_login_at = previous_login
    tokens.must_change_password = bool(account.must_change_password)
    tokens.mfa_setup_required = mfa.setup_required(db, account)
    _audit_auth(db, account, request, "login_password_change_required" if account.must_change_password else "login",
                "success", after={"method": method})
    db.commit()
    return tokens


@router.post("/login", response_model=MfaLoginOut)
def login(body: LoginIn, request: Request, db: DbSession) -> MfaLoginOut:
    _throttle(request)
    now = utcnow()
    account = db.scalar(select(Account).where(func.lower(Account.email) == body.email.strip().lower()))

    if account is None:
        verify_password(body.password, None)  # same work as a real check
        raise _fail(request, LOGIN_FAILED)

    if account.locked_until and account.locked_until > now:
        _audit_auth(db, account, request, "login_blocked_locked", "failure")
        db.commit()
        raise _fail(request, LOGIN_FAILED)

    if not account.active or not verify_password(body.password, account.password_hash):
        _failed_attempt(db, account, request, "login_failed")
        raise _fail(request, LOGIN_FAILED)
    if password_needs_rehash(account.password_hash):
        # Upgrade older hashes to the current settings now that we have the plain password.
        account.password_hash = hash_password(body.password)

    if account.mfa_enabled and account.mfa_secret:
        account.failed_attempts = 0
        _audit_auth(db, account, request, "login_mfa_challenge", "success")
        db.commit()
        return MfaLoginOut(mfa_required=True, mfa_token=create_mfa_token(account.id))

    return _finish_login(db, account, request, "password")


@router.post("/mfa/verify", response_model=MfaLoginOut)
def mfa_verify(body: MfaVerifyIn, request: Request, db: DbSession) -> MfaLoginOut:
    """Second sign-in step: the code from the authenticator app, or a backup code."""
    expired = HTTPException(status.HTTP_401_UNAUTHORIZED, "Sign-in timed out. Enter your password again.")
    _throttle(request)
    claims = decode_token(body.mfa_token, "mfa")
    if claims is None:
        raise expired
    account = db.get(Account, claims["sub"])
    if account is None or not account.active or not account.mfa_enabled:
        raise expired
    if account.locked_until and account.locked_until > utcnow():
        _audit_auth(db, account, request, "login_blocked_locked", "failure")
        db.commit()
        raise _fail(request, CODE_FAILED)
    method = mfa.check_code(account, body.code)
    if method is None:
        _failed_attempt(db, account, request, "mfa_failed")
        raise _fail(request, CODE_FAILED)
    return _finish_login(db, account, request, method)


def _revoke_sessions(db: DbSession, account_id: str, *, only_session: str | None = None,
                     keep_session: str | None = None) -> int:
    """Revoke live refresh tokens of an account: one session (only_session), or all but one (keep_session).
    Access tokens of a revoked session stop working at once (deps._check_session_and_mfa). Returns tokens revoked."""
    now = utcnow()
    count = 0
    for row in db.scalars(select(RefreshToken).where(RefreshToken.account_id == account_id,
                                                      RefreshToken.revoked_at.is_(None))):
        sid = row.session_id or row.jti
        if (only_session is not None and sid != only_session) or (keep_session is not None and sid == keep_session):
            continue
        row.revoked_at = now
        count += 1
    return count


@router.post("/refresh", response_model=TokenOut)
def refresh(body: RefreshIn, request: Request, db: DbSession) -> TokenOut:
    invalid = HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired. Sign in again.")
    claims = decode_token(body.refresh_token, "refresh")
    if claims is None:
        raise invalid
    stored = db.get(RefreshToken, claims.get("jti", ""))
    if stored is not None and stored.revoked_at is not None and stored.account_id == claims["sub"]:
        # Reuse of a spent (rotated or revoked) refresh token: it may have been stolen, so end the whole session
        # (every token of this signed-in device), including a successor an attacker or the user already holds.
        ended = _revoke_sessions(db, stored.account_id, only_session=stored.session_id or stored.jti)
        account = db.get(Account, stored.account_id)
        if account is not None and ended:
            _audit_auth(db, account, request, "refresh_token_reuse", "failure", after={"tokens_revoked": ended})
        db.commit()
        raise invalid
    if stored is None or stored.expires_at <= utcnow() or stored.account_id != claims["sub"]:
        raise invalid
    account = db.get(Account, stored.account_id)
    if account is None or not account.active:
        raise invalid
    stored.revoked_at = utcnow()  # rotate: each refresh token works once
    tokens = _issue_tokens(db, account, request, previous=stored)
    db.commit()
    return tokens


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(body: RefreshIn, request: Request, db: DbSession) -> None:
    """Ends this device's session (its refresh token stops working). Always succeeds."""
    claims = decode_token(body.refresh_token, "refresh")
    stored = db.get(RefreshToken, claims.get("jti", "")) if claims else None
    if stored is None or stored.revoked_at is not None:
        return
    _revoke_sessions(db, stored.account_id, only_session=stored.session_id or stored.jti)
    account = db.get(Account, stored.account_id)
    if account is not None:
        _audit_auth(db, account, request, "logout", "success")
    db.commit()


@router.get("/me", response_model=MeOut)
def me(user: CurrentUserDep) -> MeOut:
    scope = user.scope
    kind = "global" if scope.is_global else ("team" if scope.reports else "self")
    return MeOut(
        account_id=user.account.id,
        email=user.account.email,
        role=user.account.role,
        employee_id=user.account.employee_id,
        full_name=user.employee.full_name if user.employee else None,
        country_code=user.employee.country_code if user.employee else None,
        last_login_at=user.account.last_login_at,
        must_change_password=bool(user.account.must_change_password),
        scope=kind,
        scope_countries=scope.countries,
    )


def password_problem(new: str, current: str, email: str) -> str | None:
    """Plain-language reason a new password isn't allowed, or None."""
    if len(new) < 8:
        return "Use at least 8 characters."
    if not any(c.isalpha() for c in new) or not any(c.isdigit() for c in new):
        return "Use letters and at least one number."
    if new == current:
        return "Choose a password different from your current one."
    if email.split("@")[0].lower() in new.lower():
        return "Don't use your email name in the password."
    return None


@router.post("/change-password", status_code=status.HTTP_204_NO_CONTENT)
def change_password(body: ChangePasswordIn, request: Request, user: CurrentUserDep, db: DbSession) -> None:
    """Sets a new password and signs the account out on every other device (this session stays signed in).
    Wrong current passwords count toward the same lockout as sign-in."""
    account = user.account
    if account.locked_until and account.locked_until > utcnow():
        _audit_auth(db, account, request, "password_change_blocked_locked", "failure")
        db.commit()
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many wrong passwords. Try again in a few minutes.")
    if not verify_password(body.current_password, account.password_hash):
        _failed_attempt(db, account, request, "password_change_failed")
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Current password is not correct.")
    problem = password_problem(body.new_password, body.current_password, account.email)
    if problem:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, problem)
    account.password_hash = hash_password(body.new_password)
    account.password_changed_at = utcnow()
    account.must_change_password = False
    account.failed_attempts = 0
    ended = _revoke_sessions(db, account.id, keep_session=_current_session(request))
    _audit_auth(db, account, request, "password_changed", "success", after={"other_sessions_ended": ended})
    db.commit()


def _current_session(request: Request) -> str | None:
    """The session id (sid claim) of the access token on this request."""
    header = request.headers.get("authorization") or ""
    token = header[7:] if header.lower().startswith("bearer ") else ""
    claims = decode_token(token, "access") if token else None
    return claims.get("sid") if claims else None
