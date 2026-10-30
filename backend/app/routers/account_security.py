"""My security settings: two-step sign-in (TOTP + backup codes) and signed-in devices. Admin: the MFA policy and
ending another account's sessions. Every change is audited."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import select

from app.db import utcnow
from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import Account, PlatformSetting, RefreshToken
from app.schemas.account_security import (
    MfaBackupCodesOut, MfaEnableIn, MfaPasswordIn, MfaPolicyIn, MfaPolicyOut, MfaSetupOut, MfaStatusOut, SessionOut,
    SessionsRevokedOut,
)
from app.security import decode_token, verify_password
from app.services import mfa
from app.services.activity import record_audit

router = APIRouter(prefix="/security", tags=["security"])


def _ua(request: Request) -> str | None:
    return (request.headers.get("user-agent") or "")[:300] or None


def _audit(db: DbSession, user: CurrentUser, request: Request, action: str, entity_id: str | None = None,
           after: dict | None = None, result: str = "success") -> None:
    record_audit(db, actor_id=user.id, action=action, entity="account", entity_id=entity_id or user.id, after=after,
                 ip=client_ip(request), result=result, user_agent=_ua(request))


def _check_password(db: DbSession, user: CurrentUser, request: Request, password: str) -> None:
    """Wrong passwords count toward the same lockout as sign-in (so a stolen session can't guess it)."""
    from app.db import utcnow
    from app.routers.auth import _failed_attempt

    if user.account.locked_until and user.account.locked_until > utcnow():
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many wrong passwords. Try again in a few minutes.")
    if not verify_password(password, user.account.password_hash):
        _failed_attempt(db, user.account, request, "mfa_password_check_failed")
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Password is not correct.")


# ---------- two-step sign-in ----------
def _status(db: DbSession, account: Account) -> MfaStatusOut:
    return MfaStatusOut(
        enabled=bool(account.mfa_enabled), enabled_at=account.mfa_enabled_at,
        backup_codes_left=len(account.mfa_backup_codes or []) if account.mfa_enabled else 0,
        required_by_policy=account.role in mfa.POLICY_ROLES and mfa.policy_on(db),
        setup_required=mfa.setup_required(db, account),
    )


@router.get("/mfa", response_model=MfaStatusOut)
def mfa_status(db: DbSession, user: CurrentUserDep) -> MfaStatusOut:
    return _status(db, user.account)


@router.post("/mfa/setup", response_model=MfaSetupOut)
def mfa_setup(request: Request, db: DbSession, user: CurrentUserDep) -> MfaSetupOut:
    """Start set-up: a new secret for the authenticator app. Nothing changes at sign-in until it is confirmed."""
    account = user.account
    if account.mfa_enabled:
        raise HTTPException(409, "Two-step sign-in is already on. Turn it off first to set it up again.")
    account.mfa_secret = mfa.new_secret()
    account.mfa_last_step = None
    _audit(db, user, request, "mfa_setup_started")
    db.commit()
    return MfaSetupOut(secret=account.mfa_secret, otpauth_uri=mfa.otpauth_uri(account.mfa_secret, account.email),
                       issuer=mfa.ISSUER, account_name=account.email)


@router.post("/mfa/enable", response_model=MfaBackupCodesOut)
def mfa_enable(body: MfaEnableIn, request: Request, db: DbSession, user: CurrentUserDep) -> MfaBackupCodesOut:
    account = user.account
    if account.mfa_enabled:
        raise HTTPException(409, "Two-step sign-in is already on.")
    if not account.mfa_secret:
        raise HTTPException(409, "Start set-up first.")
    step = mfa.totp_step(account.mfa_secret, body.code)
    if step is None:
        _audit(db, user, request, "mfa_enable_failed", result="failure")
        db.commit()
        raise HTTPException(400, "That code is not right. Check the time on your phone and try again.")
    codes, hashes = mfa.new_backup_codes()
    account.mfa_enabled, account.mfa_enabled_at = True, utcnow()
    account.mfa_last_step, account.mfa_backup_codes = step, hashes
    _audit(db, user, request, "mfa_enabled")
    db.commit()
    return MfaBackupCodesOut(backup_codes=codes)


@router.post("/mfa/disable", response_model=MfaStatusOut)
def mfa_disable(body: MfaPasswordIn, request: Request, db: DbSession, user: CurrentUserDep) -> MfaStatusOut:
    account = user.account
    if not account.mfa_enabled:
        raise HTTPException(409, "Two-step sign-in is already off.")
    _check_password(db, user, request, body.password)
    if account.role in mfa.POLICY_ROLES and mfa.policy_on(db):
        raise HTTPException(409, "Your role must use two-step sign-in. An administrator can change this rule.")
    account.mfa_enabled, account.mfa_enabled_at = False, None
    account.mfa_secret = account.mfa_last_step = account.mfa_backup_codes = None
    _audit(db, user, request, "mfa_disabled")
    db.commit()
    return _status(db, account)


@router.post("/mfa/backup-codes", response_model=MfaBackupCodesOut)
def mfa_new_backup_codes(body: MfaPasswordIn, request: Request, db: DbSession, user: CurrentUserDep) -> MfaBackupCodesOut:
    """New set of 10 backup codes; the old ones stop working."""
    if not user.account.mfa_enabled:
        raise HTTPException(409, "Turn on two-step sign-in first.")
    _check_password(db, user, request, body.password)
    codes, hashes = mfa.new_backup_codes()
    user.account.mfa_backup_codes = hashes
    _audit(db, user, request, "mfa_backup_codes_renewed")
    db.commit()
    return MfaBackupCodesOut(backup_codes=codes)


@router.get("/mfa-policy", response_model=MfaPolicyOut)
def get_mfa_policy(db: DbSession, user: CurrentUserDep) -> MfaPolicyOut:
    return MfaPolicyOut(require_mfa_admin_hr=mfa.policy_on(db))


@router.put("/mfa-policy", response_model=MfaPolicyOut)
def put_mfa_policy(body: MfaPolicyIn, request: Request, db: DbSession, user: CurrentUserDep) -> MfaPolicyOut:
    if user.account.role != "admin":
        raise HTTPException(403, "Only an administrator can change this rule.")
    before = mfa.policy_on(db)
    row = db.get(PlatformSetting, mfa.POLICY_KEY)
    if row is None:
        db.add(PlatformSetting(key=mfa.POLICY_KEY, value=body.require_mfa_admin_hr, updated_by=user.id))
    else:
        row.value, row.updated_by = body.require_mfa_admin_hr, user.id
    record_audit(db, actor_id=user.id, action="platform_setting_changed", entity="platform_setting", entity_id=mfa.POLICY_KEY,
                 before={"value": before}, after={"value": body.require_mfa_admin_hr}, ip=client_ip(request),
                 result="success", user_agent=_ua(request))
    db.commit()
    return MfaPolicyOut(require_mfa_admin_hr=body.require_mfa_admin_hr)


# ---------- signed-in devices ----------
def _current_session(request: Request) -> str | None:
    auth = request.headers.get("authorization") or ""
    claims = decode_token(auth[7:], "access") if auth.lower().startswith("bearer ") else None
    return claims.get("sid") if claims else None


def _active_rows(db: DbSession, account_id: str) -> list[RefreshToken]:
    now = utcnow()
    return [r for r in db.scalars(select(RefreshToken).where(RefreshToken.account_id == account_id,
                                                               RefreshToken.revoked_at.is_(None)))
            if r.expires_at > now]


def _sessions(db: DbSession, account_id: str, current: str | None) -> list[SessionOut]:
    latest: dict[str, RefreshToken] = {}
    for row in _active_rows(db, account_id):
        sid = row.session_id or row.jti
        if sid not in latest or (row.created_at or utcnow()) > (latest[sid].created_at or utcnow()):
            latest[sid] = row
    out = [SessionOut(session_id=sid, started_at=r.session_started_at or r.created_at, last_used_at=r.last_used_at or r.created_at,
                      expires_at=r.expires_at, ip=r.ip, user_agent=r.user_agent, current=sid == current)
           for sid, r in latest.items()]
    return sorted(out, key=lambda s: (not s.current, -(s.last_used_at.timestamp() if s.last_used_at else 0)))


def _revoke(db: DbSession, account_id: str, keep: str | None = None, only: str | None = None) -> int:
    now = utcnow()
    ended: set[str] = set()
    for row in _active_rows(db, account_id):
        sid = row.session_id or row.jti
        if (keep and sid == keep) or (only and sid != only):
            continue
        row.revoked_at = now
        ended.add(sid)
    return len(ended)


@router.get("/sessions", response_model=list[SessionOut])
def my_sessions(request: Request, db: DbSession, user: CurrentUserDep) -> list[SessionOut]:
    return _sessions(db, user.id, _current_session(request))


@router.delete("/sessions/{session_id}", response_model=SessionsRevokedOut)
def revoke_session(session_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> SessionsRevokedOut:
    count = _revoke(db, user.id, only=session_id)
    if count == 0:
        raise HTTPException(404, "That device is not signed in.")
    _audit(db, user, request, "session_revoked", after={"session_id": session_id})
    db.commit()
    return SessionsRevokedOut(revoked=count)


@router.post("/sessions/revoke-others", response_model=SessionsRevokedOut)
def revoke_other_sessions(request: Request, db: DbSession, user: CurrentUserDep) -> SessionsRevokedOut:
    current = _current_session(request)
    count = _revoke(db, user.id, keep=current)
    _audit(db, user, request, "sessions_revoked_others", after={"revoked": count})
    db.commit()
    return SessionsRevokedOut(revoked=count)


def _admin_target(db: DbSession, user: CurrentUser, account_id: str) -> Account:
    if user.account.role != "admin":
        raise HTTPException(403, "Only an administrator can see or end another account's sessions.")
    target = db.get(Account, account_id)
    if target is None:
        raise HTTPException(404, "Not found.")
    return target


@router.get("/accounts/{account_id}/sessions", response_model=list[SessionOut])
def account_sessions(account_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> list[SessionOut]:
    target = _admin_target(db, user, account_id)
    return _sessions(db, target.id, _current_session(request) if target.id == user.id else None)


@router.post("/accounts/{account_id}/sessions/revoke", response_model=SessionsRevokedOut)
def revoke_account_sessions(account_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> SessionsRevokedOut:
    target = _admin_target(db, user, account_id)
    keep = _current_session(request) if target.id == user.id else None
    count = _revoke(db, target.id, keep=keep)
    record_audit(db, actor_id=user.id, action="sessions_revoked_by_admin", entity="account", entity_id=target.id,
                 after={"revoked": count}, ip=client_ip(request), result="success", user_agent=_ua(request))
    db.commit()
    return SessionsRevokedOut(revoked=count)
