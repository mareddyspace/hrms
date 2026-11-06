"""Super admin control center: platform KPIs, the real audit trail, sign-ins, live sessions, monitoring, and account
actions (deactivate, reactivate, unlock, force a password reset), each with a reason and an audit row.

Every endpoint is for SUPER_ADMIN_ROLES only, checked here on the server. Numbers come straight from PostgreSQL
(accounts, refresh_tokens, audit_log, integration_*, email_outbox, reminder_log); nothing is made up. Secrets
(database URL, API keys) are never returned: configuration shows only "set" / "not set".
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select, text
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import utcnow
from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import (
    Account, AuditLog, Country, EmailOutboxItem, Employee, IntegrationConnector, IntegrationQuarantine, IntegrationRun,
    RefreshToken, ReminderLog,
)
from app.services.activity import record_audit
from app.services.scope import SUPER_ADMIN_ROLES
from app.services.storage import backend_name

router = APIRouter(prefix="/admin", tags=["admin console"])

STARTED_AT = utcnow()  # this API process
# Sign-in events worth an administrator's attention.
ALERT_ACTIONS = ("account_locked", "refresh_token_reuse", "login_blocked_locked", "mfa_failed", "login_failed_unknown",
                 "password_change_blocked_locked")
FAILED_SIGN_IN_ACTIONS = ("login_failed", "login_failed_unknown", "mfa_failed", "login_blocked_locked", "docs_login_failed")
LEFT = ("Terminated", "Exited")


def storage_backend() -> str:
    """Where files go ("cloud bucket" or "local disk"), never the bucket or keys."""
    return "local disk" if backend_name() == "local" else "cloud bucket"


def _super_admin(user: CurrentUser) -> None:
    if user.account.role not in SUPER_ADMIN_ROLES:
        raise HTTPException(403, "Only a super admin can open the control center.")


# ---------- shapes ----------
class AuditRowOut(BaseModel):
    id: int
    at: datetime
    actor_id: str | None
    actor_email: str | None
    action: str
    entity: str
    entity_id: str | None
    subject_id: str | None
    result: str | None
    ip: str | None
    user_agent: str | None
    changes: dict[str, Any] | None


class AuditPageOut(BaseModel):
    total: int
    items: list[AuditRowOut]


class SignInSummaryOut(BaseModel):
    days: int
    successful: int
    failed: int
    locked_accounts: int
    alerts: int
    items: list[AuditRowOut]


class LiveSessionOut(BaseModel):
    session_id: str
    account_id: str
    email: str
    role: str
    started_at: datetime | None
    last_used_at: datetime | None
    ip: str | None
    user_agent: str | None


class HealthOut(BaseModel):
    database: str  # ok | unreachable
    database_ms: float | None
    email_queue: int
    integrations_failing: int


class OverviewOut(BaseModel):
    accounts_total: int
    accounts_active: int
    admins_active: int
    active_sessions: int
    failed_sign_ins_24h: int
    locked_accounts: int
    legal_entities: int
    countries: int
    health: HealthOut
    security_alerts: list[AuditRowOut]
    admin_actions: list[AuditRowOut]
    integration_failures: list[dict[str, Any]]


class MonitoringOut(BaseModel):
    database: dict[str, Any]
    api: dict[str, Any]
    jobs: dict[str, Any]
    email: dict[str, Any]
    integrations: list[dict[str, Any]]
    configuration: dict[str, str]


# ---------- helpers ----------
def _rows_out(db: Session, rows: list[AuditLog]) -> list[AuditRowOut]:
    ids = {r.actor_id for r in rows if r.actor_id}
    emails = dict(db.execute(select(Account.id, Account.email).where(Account.id.in_(ids or {""}))).all())
    return [AuditRowOut(id=r.id, at=r.at, actor_id=r.actor_id, actor_email=emails.get(r.actor_id or ""), action=r.action,
                        entity=r.entity, entity_id=r.entity_id, subject_id=r.subject_id, result=r.result, ip=r.ip,
                        user_agent=r.user_agent, changes=r.changes) for r in rows]


def _live_tokens(now: datetime):  # type: ignore[no-untyped-def]
    return select(RefreshToken).where(RefreshToken.revoked_at.is_(None), RefreshToken.expires_at > now)


def _db_ping(db: Session) -> tuple[str, float | None]:
    try:
        start = time.perf_counter()
        db.execute(text("SELECT 1"))
        return "ok", round((time.perf_counter() - start) * 1000, 1)
    except Exception:  # reported, not raised: this is the health check
        return "unreachable", None


def _admin_ids(db: Session) -> list[str]:
    return list(db.scalars(select(Account.id).where(Account.role.in_(SUPER_ADMIN_ROLES))))


def _failing_connectors(db: Session) -> list[IntegrationConnector]:
    open_q = select(IntegrationQuarantine.connector_id).where(IntegrationQuarantine.status == "open")
    return list(db.scalars(select(IntegrationConnector).where(
        or_(IntegrationConnector.status.in_(("Degraded", "Disconnected")), IntegrationConnector.id.in_(open_q)))
        .order_by(IntegrationConnector.name)))


# ---------- endpoints ----------
@router.get("/overview", response_model=OverviewOut)
def overview(db: DbSession, user: CurrentUserDep) -> OverviewOut:
    """Home page of the control center: KPIs, health and the latest alerts, admin actions and integration failures."""
    _super_admin(user)
    now = utcnow()
    count = lambda stmt: int(db.scalar(stmt) or 0)  # noqa: E731
    status, ms = _db_ping(db)
    failing = _failing_connectors(db)
    admin_ids = _admin_ids(db)
    alerts = list(db.scalars(select(AuditLog).where(AuditLog.action.in_(ALERT_ACTIONS))
                             .order_by(AuditLog.at.desc(), AuditLog.id.desc()).limit(5)))
    actions = list(db.scalars(select(AuditLog).where(AuditLog.actor_id.in_(admin_ids or [""]), AuditLog.result.is_(None))
                              .order_by(AuditLog.at.desc(), AuditLog.id.desc()).limit(5)))
    open_items = dict(db.execute(select(IntegrationQuarantine.connector_id, func.count())
                                 .where(IntegrationQuarantine.status == "open")
                                 .group_by(IntegrationQuarantine.connector_id)).all())
    return OverviewOut(
        accounts_total=count(select(func.count()).select_from(Account)),
        accounts_active=count(select(func.count()).select_from(Account).where(Account.active.is_(True))),
        admins_active=count(select(func.count()).select_from(Account).where(Account.active.is_(True),
                                                                             Account.role.in_(SUPER_ADMIN_ROLES))),
        active_sessions=count(select(func.count(func.distinct(func.coalesce(RefreshToken.session_id, RefreshToken.jti))))
                              .where(RefreshToken.revoked_at.is_(None), RefreshToken.expires_at > now)),
        failed_sign_ins_24h=count(select(func.count()).select_from(AuditLog).where(
            AuditLog.action.in_(FAILED_SIGN_IN_ACTIONS), AuditLog.at >= now - timedelta(hours=24))),
        locked_accounts=count(select(func.count()).select_from(Account).where(Account.locked_until > now)),
        legal_entities=count(select(func.count(func.distinct(Employee.legal_entity)))
                             .where(Employee.employment_status.not_in(LEFT))),
        countries=count(select(func.count()).select_from(Country)),
        health=HealthOut(database=status, database_ms=ms,
                         email_queue=count(select(func.count()).select_from(EmailOutboxItem)
                                           .where(EmailOutboxItem.status == "Queued")),
                         integrations_failing=len(failing)),
        security_alerts=_rows_out(db, alerts),
        admin_actions=_rows_out(db, actions),
        integration_failures=[{"id": c.id, "name": c.name, "status": c.status, "last_sync_at": c.last_sync_at,
                               "failed_count": c.failed_count, "open_items": int(open_items.get(c.id, 0))}
                              for c in failing[:5]],
    )


@router.get("/audit", response_model=AuditPageOut)
def audit_trail(
    db: DbSession,
    user: CurrentUserDep,
    actor_id: str | None = None,
    action: Annotated[str | None, Query(max_length=64)] = None,
    entity: Annotated[str | None, Query(max_length=64)] = None,
    subject_id: str | None = None,
    admins_only: bool = False,
    date_from: Annotated[datetime | None, Query(alias="from")] = None,
    date_to: Annotated[datetime | None, Query(alias="to")] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> AuditPageOut:
    """The server audit trail (newest first), filtered and paged."""
    _super_admin(user)
    conds = []
    if actor_id:
        conds.append(AuditLog.actor_id == actor_id)
    if action:
        conds.append(AuditLog.action == action)
    if entity:
        conds.append(AuditLog.entity == entity)
    if subject_id:
        conds.append(AuditLog.subject_id == subject_id)
    if admins_only:
        conds.append(AuditLog.actor_id.in_(_admin_ids(db) or [""]))
    if date_from:
        conds.append(AuditLog.at >= date_from)
    if date_to:
        conds.append(AuditLog.at <= date_to)
    total = int(db.scalar(select(func.count()).select_from(AuditLog).where(*conds)) or 0)
    rows = list(db.scalars(select(AuditLog).where(*conds).order_by(AuditLog.at.desc(), AuditLog.id.desc())
                           .offset(offset).limit(limit)))
    return AuditPageOut(total=total, items=_rows_out(db, rows))


@router.get("/security/sign-ins", response_model=SignInSummaryOut)
def sign_ins(
    db: DbSession,
    user: CurrentUserDep,
    days: Annotated[int, Query(ge=1, le=90)] = 7,
    result: Annotated[str | None, Query(pattern="^(success|failure)$")] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> SignInSummaryOut:
    """Sign-in events (success and failure) of the last `days` days, with totals."""
    _super_admin(user)
    now = utcnow()
    since = now - timedelta(days=days)
    base = [AuditLog.result.is_not(None), AuditLog.at >= since]
    count = lambda *c: int(db.scalar(select(func.count()).select_from(AuditLog).where(*base, *c)) or 0)  # noqa: E731
    stmt = select(AuditLog).where(*base, *([AuditLog.result == result] if result else []))
    rows = list(db.scalars(stmt.order_by(AuditLog.at.desc(), AuditLog.id.desc()).limit(limit)))
    return SignInSummaryOut(
        days=days, successful=count(AuditLog.result == "success"), failed=count(AuditLog.result == "failure"),
        locked_accounts=int(db.scalar(select(func.count()).select_from(Account).where(Account.locked_until > now)) or 0),
        alerts=count(AuditLog.action.in_(ALERT_ACTIONS)), items=_rows_out(db, rows),
    )


@router.get("/security/sessions", response_model=list[LiveSessionOut])
def live_sessions(db: DbSession, user: CurrentUserDep) -> list[LiveSessionOut]:
    """Signed-in devices across all accounts (one row per session, its latest token)."""
    _super_admin(user)
    accounts = {a.id: a for a in db.scalars(select(Account))}
    latest: dict[str, RefreshToken] = {}
    for t in db.scalars(_live_tokens(utcnow())):
        sid = t.session_id or t.jti
        if sid not in latest or (t.last_used_at or t.created_at) > (latest[sid].last_used_at or latest[sid].created_at):
            latest[sid] = t
    out = []
    for sid, t in latest.items():
        acc = accounts.get(t.account_id)
        if acc is None:
            continue
        out.append(LiveSessionOut(session_id=sid, account_id=acc.id, email=acc.email, role=acc.role,
                                  started_at=t.session_started_at, last_used_at=t.last_used_at, ip=t.ip,
                                  user_agent=t.user_agent))
    return sorted(out, key=lambda s: s.last_used_at or s.started_at or STARTED_AT, reverse=True)


@router.get("/monitoring", response_model=MonitoringOut)
def monitoring(db: DbSession, user: CurrentUserDep) -> MonitoringOut:
    """Database, API process, background jobs, email queue, integrations and which settings are present."""
    _super_admin(user)
    settings = get_settings()
    now = utcnow()
    status, ms = _db_ping(db)
    version = revision = None
    try:
        dialect = db.get_bind().dialect.name
        if dialect == "postgresql":
            version = db.scalar(text("SHOW server_version"))
        revision = db.scalar(text("SELECT version_num FROM alembic_version"))
    except Exception:  # missing table or no permission: shown as unknown
        db.rollback()
        dialect = db.get_bind().dialect.name
    oldest = db.scalar(select(func.min(EmailOutboxItem.created_at)).where(EmailOutboxItem.status == "Queued"))
    last_run = db.scalar(select(IntegrationRun).order_by(IntegrationRun.started_at.desc()).limit(1))
    connectors = list(db.scalars(select(IntegrationConnector).order_by(IntegrationConnector.name)))
    return MonitoringOut(
        database={"status": status, "response_ms": ms, "engine": dialect, "server_version": version,
                  "migration": revision},
        api={"status": "ok", "started_at": STARTED_AT, "uptime_seconds": int((now - STARTED_AT).total_seconds()),
             "environment": settings.app_env},
        jobs={"last_reminder_at": db.scalar(select(func.max(ReminderLog.created_at))),
              "reminders_24h": int(db.scalar(select(func.count()).select_from(ReminderLog)
                                             .where(ReminderLog.created_at >= now - timedelta(hours=24))) or 0),
              "last_integration_run_at": last_run.started_at if last_run else None,
              "last_integration_run_failed": last_run.failed if last_run else None},
        email={"queued": int(db.scalar(select(func.count()).select_from(EmailOutboxItem)
                                       .where(EmailOutboxItem.status == "Queued")) or 0),
               "oldest_queued_at": oldest},
        integrations=[{"id": c.id, "name": c.name, "status": c.status, "schedule": c.schedule,
                       "last_sync_at": c.last_sync_at, "failed_count": c.failed_count} for c in connectors],
        configuration={
            "jwt_secret": "set" if settings.jwt_secret.strip() else "not set",
            "ai_key": "set" if settings.openrouter_api_key.strip() else "not set",
            "file_storage": storage_backend(),
            "api_docs": "on" if settings.docs_enabled else "off",
        },
    )


# ---------- user & admin management ----------
class PlatformUserOut(BaseModel):
    account_id: str
    email: str
    role: str
    full_name: str | None
    active: bool
    locked_until: datetime | None
    failed_attempts: int
    last_login_at: datetime | None
    mfa_enabled: bool
    must_change_password: bool
    sessions: int


class AccountActionIn(BaseModel):
    reason: str = Field(min_length=5, max_length=300)


@router.get("/users", response_model=list[PlatformUserOut])
def platform_users(db: DbSession, user: CurrentUserDep) -> list[PlatformUserOut]:
    """Every sign-in account with its status (no password, MFA secret or backup codes)."""
    _super_admin(user)
    now = utcnow()
    names = dict(db.execute(select(Employee.id, Employee.full_name)).all())
    sessions = dict(db.execute(select(RefreshToken.account_id,
                                      func.count(func.distinct(func.coalesce(RefreshToken.session_id, RefreshToken.jti))))
                               .where(RefreshToken.revoked_at.is_(None), RefreshToken.expires_at > now)
                               .group_by(RefreshToken.account_id)).all())
    return [PlatformUserOut(account_id=a.id, email=a.email, role=a.role, full_name=names.get(a.employee_id or ""),
                            active=a.active, locked_until=a.locked_until if a.locked_until and a.locked_until > now else None,
                            failed_attempts=a.failed_attempts or 0, last_login_at=a.last_login_at,
                            mfa_enabled=bool(a.mfa_enabled), must_change_password=bool(a.must_change_password),
                            sessions=int(sessions.get(a.id, 0)))
            for a in db.scalars(select(Account).order_by(Account.email))]


def _target(db: Session, user: CurrentUser, account_id: str) -> Account:
    acc = db.get(Account, account_id)
    if acc is None:
        raise HTTPException(404, "Not found.")
    if acc.id == user.id:
        raise HTTPException(403, "You can't do this to your own account.")
    return acc


def _end_sessions(db: Session, account_id: str) -> int:
    from app.routers.auth import _revoke_sessions

    return _revoke_sessions(db, account_id)


def _done(db: Session, user: CurrentUser, request: Request, acc: Account, action: str, before: dict[str, Any],
          after: dict[str, Any]) -> PlatformUserOut:
    record_audit(db, actor_id=user.id, action=action, entity="account", entity_id=acc.id, subject_id=acc.employee_id,
                 before=before, after=after, ip=client_ip(request))
    db.commit()
    return next(u for u in platform_users(db, user) if u.account_id == acc.id)


@router.post("/users/{account_id}/deactivate", response_model=PlatformUserOut)
def deactivate(account_id: str, body: AccountActionIn, request: Request, db: DbSession, user: CurrentUserDep) -> PlatformUserOut:
    """Turns sign-in off and ends every session of the account at once."""
    _super_admin(user)
    acc = _target(db, user, account_id)
    if not acc.active:
        raise HTTPException(409, "This account is already deactivated.")
    if acc.role in SUPER_ADMIN_ROLES and int(db.scalar(select(func.count()).select_from(Account).where(
            Account.active.is_(True), Account.role.in_(SUPER_ADMIN_ROLES))) or 0) <= 1:
        raise HTTPException(409, "This is the last active super admin.")
    acc.active = False
    ended = _end_sessions(db, acc.id)
    return _done(db, user, request, acc, "account_deactivated", {"active": True},
                 {"active": False, "reason": body.reason.strip(), "sessions_ended": ended})


@router.post("/users/{account_id}/reactivate", response_model=PlatformUserOut)
def reactivate(account_id: str, body: AccountActionIn, request: Request, db: DbSession, user: CurrentUserDep) -> PlatformUserOut:
    _super_admin(user)
    acc = _target(db, user, account_id)
    if acc.active:
        raise HTTPException(409, "This account is already active.")
    acc.active, acc.failed_attempts, acc.locked_until = True, 0, None
    return _done(db, user, request, acc, "account_reactivated", {"active": False},
                 {"active": True, "reason": body.reason.strip()})


@router.post("/users/{account_id}/unlock", response_model=PlatformUserOut)
def unlock(account_id: str, body: AccountActionIn, request: Request, db: DbSession, user: CurrentUserDep) -> PlatformUserOut:
    """Ends a lockout after too many wrong passwords."""
    _super_admin(user)
    acc = _target(db, user, account_id)
    if not (acc.locked_until and acc.locked_until > utcnow()) and not acc.failed_attempts:
        raise HTTPException(409, "This account isn't locked.")
    before = {"locked_until": acc.locked_until, "failed_attempts": acc.failed_attempts}
    acc.failed_attempts, acc.locked_until = 0, None
    return _done(db, user, request, acc, "account_unlocked", before,
                 {"locked_until": None, "failed_attempts": 0, "reason": body.reason.strip()})


@router.post("/users/{account_id}/force-password-reset", response_model=PlatformUserOut)
def force_password_reset(account_id: str, body: AccountActionIn, request: Request, db: DbSession,
                         user: CurrentUserDep) -> PlatformUserOut:
    """Account recovery: signs the account out everywhere; the next sign-in must set a new password."""
    _super_admin(user)
    acc = _target(db, user, account_id)
    acc.must_change_password = True
    ended = _end_sessions(db, acc.id)
    return _done(db, user, request, acc, "password_reset_forced", {"must_change_password": False},
                 {"must_change_password": True, "reason": body.reason.strip(), "sessions_ended": ended})
