"""Admin platform: data scope and page access per account, AI settings, platform settings, integrations,
email outbox and background jobs. Admin only, except where noted (reading your own page access and the AI settings).
"""

from __future__ import annotations

import re
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request
from sqlalchemy import select

from app.db import utcnow
from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import (
    AccessScope, Account, AccountDataScope, AiSetting, EmailChannelSwitch, EmailOutboxItem, Employee, IntegrationConnector,
    IntegrationQuarantine, IntegrationRun, PageAccessOverride,
)
from app.schemas.platform_admin import (
    AdminAccountOut, AiSettingsIn, AiSettingsOut, ConnectorOut, ConnectorScheduleIn, DataScopeIn, DataScopeOut, EmailMarkSentIn,
    EmailMarkSentOut, EmailOutboxOut, EmailSwitchIn, EmailSwitchOut, IntegrationRunOut, JobsRunOut, PageAccessIn, PageAccessOut,
    PlatformSettingsIn, PlatformSettingsOut, QuarantineDismissIn, QuarantineFixIn, QuarantineOut, QuarantineOutcomeOut,
)
from app.services import integrations as conn
from app.services import jobs
from app.services.activity import record_audit
from app.services.data_scope import default_scope_name
from app.services.decisions import NOT_FOUND
from app.services.email_outbox import DEFAULT_SWITCHES
from app.services.platform_settings import all_settings, set_setting
from app.services.scope import HR_ROLES

router = APIRouter(prefix="/admin", tags=["admin platform"])

ADMIN_ROLES = frozenset({"admin", "super_admin"})
AI_FEATURES = ("employee360", "cvReading", "jdWriter", "documentAssistant", "plainAnalytics", "homeSummaries")
LOCKED_PAGES = ("home",)
_PAGE_ID = re.compile(r"^[a-z0-9_-]{1,64}$")


def _admin(user: CurrentUser) -> None:
    if user.account.role not in ADMIN_ROLES:
        raise HTTPException(403, "Only an administrator can do this.")


def _admin_or_hr(user: CurrentUser) -> None:
    """Read-only views HR also needs (integrations status, runs, quarantine)."""
    if user.account.role not in ADMIN_ROLES and user.account.role not in HR_ROLES:
        raise HTTPException(403, "Only an administrator or HR can see this.")


def _account(db: DbSession, account_id: str) -> Account:
    acc = db.get(Account, account_id)
    if acc is None:
        raise NOT_FOUND
    return acc


# ---------- data scope & page access ----------
def _scope_out(db: DbSession, acc: Account) -> DataScopeOut:
    row = db.get(AccountDataScope, acc.id)
    if row is None:
        legacy = db.get(AccessScope, acc.id)
        countries = [c.strip().upper() for c in (legacy.country_codes or "").split(",") if c.strip()] if legacy else []
        return DataScopeOut(account_id=acc.id, scope=default_scope_name(acc.role), countries=countries, custom=False)
    return DataScopeOut(account_id=acc.id, scope=row.scope, countries=list(row.country_codes or []), custom=True)


def _pages_out(db: DbSession, account_id: str) -> PageAccessOut:
    row = db.get(PageAccessOverride, account_id)
    if row is None:
        return PageAccessOut(account_id=account_id, grant=[], revoke=[], custom=False)
    return PageAccessOut(account_id=account_id, grant=list(row.grant_pages or []), revoke=list(row.revoke_pages or []), custom=True)


@router.get("/accounts", response_model=list[AdminAccountOut])
def list_accounts(db: DbSession, user: CurrentUserDep) -> list[AdminAccountOut]:
    _admin(user)
    out = []
    for acc in db.scalars(select(Account).order_by(Account.email)):
        emp = db.get(Employee, acc.employee_id) if acc.employee_id else None
        out.append(AdminAccountOut(account_id=acc.id, email=acc.email, role=acc.role, employee_id=acc.employee_id,
                                   full_name=emp.full_name if emp else None, data_scope=_scope_out(db, acc),
                                   page_access=_pages_out(db, acc.id)))
    return out


@router.get("/accounts/{account_id}/data-scope", response_model=DataScopeOut)
def get_data_scope(account_id: str, db: DbSession, user: CurrentUserDep) -> DataScopeOut:
    if account_id != user.id:
        _admin(user)
    return _scope_out(db, _account(db, account_id))


@router.put("/accounts/{account_id}/data-scope", response_model=DataScopeOut)
def put_data_scope(account_id: str, body: DataScopeIn, request: Request, db: DbSession, user: CurrentUserDep) -> DataScopeOut:
    """Saved in account_data_scopes and applied on every request (app/deps.py). Countries apply to HR only."""
    _admin(user)
    acc = _account(db, account_id)
    if acc.id == user.id:
        raise HTTPException(403, "You can't change the data scope of your own account.")
    countries = sorted({c.strip().upper() for c in body.countries if c.strip()}) if acc.role in HR_ROLES else []
    if any(not re.fullmatch(r"[A-Z]{2}", c) for c in countries):
        raise HTTPException(422, "Countries are two-letter codes.")
    before = _scope_out(db, acc)
    row = db.get(AccountDataScope, acc.id)
    if body.scope == default_scope_name(acc.role) and not countries:
        if row is not None:
            db.delete(row)
    elif row is None:
        db.add(AccountDataScope(account_id=acc.id, scope=body.scope, country_codes=countries, updated_by=user.id))
    else:
        row.scope, row.country_codes, row.updated_by = body.scope, countries, user.id
    if acc.role in HR_ROLES:  # keep the approvals engine's HR country routing in step
        legacy = db.get(AccessScope, acc.id)
        if countries and legacy is None:
            db.add(AccessScope(account_id=acc.id, country_codes=",".join(countries)))
        elif legacy is not None:
            legacy.country_codes = ",".join(countries) or None
    db.flush()
    after = _scope_out(db, acc)
    record_audit(db, actor_id=user.id, action="data_scope_changed", entity="account", entity_id=acc.id, subject_id=acc.employee_id,
                 before=before.model_dump(), after=after.model_dump(), ip=client_ip(request))
    db.commit()
    return after


@router.get("/page-access/me", response_model=PageAccessOut)
def my_page_access(db: DbSession, user: CurrentUserDep) -> PageAccessOut:
    """Anyone: the page grants / revokes on their own account (the portal applies them over the role default)."""
    return _pages_out(db, user.id)


@router.get("/accounts/{account_id}/page-access", response_model=PageAccessOut)
def get_page_access(account_id: str, db: DbSession, user: CurrentUserDep) -> PageAccessOut:
    _admin(user)
    return _pages_out(db, _account(db, account_id).id)


@router.put("/accounts/{account_id}/page-access", response_model=PageAccessOut)
def put_page_access(account_id: str, body: PageAccessIn, request: Request, db: DbSession, user: CurrentUserDep) -> PageAccessOut:
    _admin(user)
    acc = _account(db, account_id)
    if acc.id == user.id:
        raise HTTPException(403, "You can't change page access on your own account.")
    grant = sorted(set(body.grant))
    revoke = sorted(set(body.revoke) - set(LOCKED_PAGES))
    if any(not _PAGE_ID.match(p) for p in grant + revoke):
        raise HTTPException(422, "Unknown page id.")
    if set(grant) & set(revoke):
        raise HTTPException(422, "A page can't be both granted and revoked.")
    before = _pages_out(db, acc.id)
    row = db.get(PageAccessOverride, acc.id)
    if not grant and not revoke:
        if row is not None:
            db.delete(row)
    elif row is None:
        db.add(PageAccessOverride(account_id=acc.id, grant_pages=grant, revoke_pages=revoke, updated_by=user.id))
    else:
        row.grant_pages, row.revoke_pages, row.updated_by = grant, revoke, user.id
    db.flush()
    after = _pages_out(db, acc.id)
    record_audit(db, actor_id=user.id, action="page_access_changed", entity="account", entity_id=acc.id, subject_id=acc.employee_id,
                 before=before.model_dump(), after=after.model_dump(), ip=client_ip(request))
    db.commit()
    return after


@router.delete("/accounts/{account_id}/page-access", response_model=PageAccessOut)
def reset_page_access(account_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> PageAccessOut:
    return put_page_access(account_id, PageAccessIn(), request, db, user)


# ---------- AI settings ----------
def _ai_row(db: DbSession) -> AiSetting | None:
    return db.get(AiSetting, "default")


def _ai_out(row: AiSetting | None) -> AiSettingsOut:
    return AiSettingsOut(disabled_policies=list(row.disabled_policies or []) if row else [],
                         disabled_agents=list(row.disabled_agents or []) if row else [],
                         disabled_features=list(row.disabled_features or []) if row else [], features=list(AI_FEATURES))


@router.get("/ai-settings", response_model=AiSettingsOut)
def get_ai_settings(db: DbSession, user: CurrentUserDep) -> AiSettingsOut:
    """Anyone signed in (the portal hides switched-off AI features)."""
    return _ai_out(_ai_row(db))


@router.put("/ai-settings", response_model=AiSettingsOut)
def put_ai_settings(body: AiSettingsIn, request: Request, db: DbSession, user: CurrentUserDep) -> AiSettingsOut:
    _admin(user)
    if body.disabled_features is not None and set(body.disabled_features) - set(AI_FEATURES):
        raise HTTPException(422, "Unknown AI feature.")
    row = _ai_row(db)
    before = _ai_out(row).model_dump(exclude={"features"})
    if row is None:
        row = AiSetting(id="default", disabled_policies=[], disabled_agents=[], disabled_features=[])
        db.add(row)
    if body.disabled_policies is not None:
        row.disabled_policies = sorted(set(body.disabled_policies))
    if body.disabled_agents is not None:
        row.disabled_agents = sorted(set(body.disabled_agents))
    if body.disabled_features is not None:
        row.disabled_features = sorted(set(body.disabled_features))
    row.updated_by = user.id
    db.flush()
    out = _ai_out(row)
    record_audit(db, actor_id=user.id, action="ai_settings_changed", entity="ai_settings", entity_id="default", before=before,
                 after=out.model_dump(exclude={"features"}), ip=client_ip(request))
    db.commit()
    return out


# ---------- platform settings ----------
def _settings_access(user: CurrentUser) -> None:
    if user.account.role not in ADMIN_ROLES | {"hr_admin"}:
        raise HTTPException(403, "Only an administrator or HR admin can change platform settings.")


@router.get("/settings", response_model=PlatformSettingsOut)
def get_settings_(db: DbSession, user: CurrentUserDep) -> PlatformSettingsOut:
    _settings_access(user)
    return PlatformSettingsOut(**all_settings(db))


@router.put("/settings", response_model=PlatformSettingsOut)
def put_settings(body: PlatformSettingsIn, request: Request, db: DbSession, user: CurrentUserDep) -> PlatformSettingsOut:
    _settings_access(user)
    changes = body.model_dump(exclude_none=True)
    if "posh_committee" in changes:
        ids = list(dict.fromkeys(changes["posh_committee"]))
        if any(db.get(Employee, i) is None for i in ids):
            raise HTTPException(422, "Committee members must be employees.")
        changes["posh_committee"] = ids
    for key, value in changes.items():
        before = set_setting(db, key, value, user.id)
        record_audit(db, actor_id=user.id, action="platform_setting_changed", entity="platform_setting", entity_id=key,
                     before={"value": before}, after={"value": value}, ip=client_ip(request))
    db.commit()
    return PlatformSettingsOut(**all_settings(db))


# ---------- integrations ----------
def _connector(db: DbSession, connector_id: str) -> IntegrationConnector:
    c = db.get(IntegrationConnector, connector_id)
    if c is None:
        raise NOT_FOUND
    return c


def _conn_out(db: DbSession, c: IntegrationConnector) -> ConnectorOut:
    return ConnectorOut.model_validate(c).model_copy(update={"open_quarantine": conn.open_count(db, c.id),
                                                              "next_run_at": conn.next_run_at(c)})


@router.get("/integrations", response_model=list[ConnectorOut])
def list_connectors(db: DbSession, user: CurrentUserDep) -> list[ConnectorOut]:
    _admin_or_hr(user)
    return [_conn_out(db, c) for c in db.scalars(select(IntegrationConnector).order_by(IntegrationConnector.name))]


@router.put("/integrations/{connector_id}/schedule", response_model=ConnectorOut)
def set_schedule(connector_id: str, body: ConnectorScheduleIn, request: Request, db: DbSession, user: CurrentUserDep) -> ConnectorOut:
    _admin(user)
    c = _connector(db, connector_id)
    before = c.schedule
    c.schedule = body.schedule
    record_audit(db, actor_id=user.id, action="integration_schedule_changed", entity="integration", entity_id=c.id,
                 before={"schedule": before}, after={"schedule": c.schedule}, ip=client_ip(request))
    db.commit()
    return _conn_out(db, c)


@router.post("/integrations/{connector_id}/run", response_model=IntegrationRunOut)
def run_connector(connector_id: str, db: DbSession, user: CurrentUserDep) -> IntegrationRun:
    _admin(user)
    c = _connector(db, connector_id)
    try:
        run = conn.run_sync(db, c, user.id)
    except conn.IntegrationError as exc:
        raise HTTPException(409, str(exc)) from exc
    db.commit()
    return run


@router.get("/integrations/{connector_id}/runs", response_model=list[IntegrationRunOut])
def connector_runs(connector_id: str, db: DbSession, user: CurrentUserDep,
                   limit: Annotated[int, Query(ge=1, le=100)] = 10) -> list[IntegrationRun]:
    _admin_or_hr(user)
    _connector(db, connector_id)
    return list(db.scalars(select(IntegrationRun).where(IntegrationRun.connector_id == connector_id)
                           .order_by(IntegrationRun.id.desc()).limit(limit)))


@router.get("/integrations/{connector_id}/quarantine", response_model=list[QuarantineOut])
def quarantine(connector_id: str, db: DbSession, user: CurrentUserDep,
               status_filter: Annotated[str, Query(alias="status", pattern="^(open|resolved|dismissed|all)$")] = "open"
               ) -> list[IntegrationQuarantine]:
    _admin_or_hr(user)
    _connector(db, connector_id)
    stmt = select(IntegrationQuarantine).where(IntegrationQuarantine.connector_id == connector_id)
    if status_filter != "all":
        stmt = stmt.where(IntegrationQuarantine.status == status_filter)
    return list(db.scalars(stmt.order_by(IntegrationQuarantine.created_at.desc())))


def _open_record(db: DbSession, connector_id: str, record_id: str) -> IntegrationQuarantine:
    rec = db.get(IntegrationQuarantine, record_id)
    if rec is None or rec.connector_id != connector_id:
        raise NOT_FOUND
    if rec.status != "open":
        raise HTTPException(409, "That record is no longer in quarantine.")
    return rec


@router.post("/integrations/{connector_id}/quarantine/{record_id}/retry", response_model=QuarantineOutcomeOut)
def retry_record(connector_id: str, record_id: str, db: DbSession, user: CurrentUserDep) -> QuarantineOutcomeOut:
    _admin(user)
    rec = _open_record(db, connector_id, record_id)
    ok = conn.retry(db, rec, user.id)
    db.commit()
    return QuarantineOutcomeOut(ok=ok, record=QuarantineOut.model_validate(rec))


@router.post("/integrations/{connector_id}/quarantine/{record_id}/fix", response_model=QuarantineOutcomeOut)
def fix_record(connector_id: str, record_id: str, body: QuarantineFixIn, db: DbSession, user: CurrentUserDep) -> QuarantineOutcomeOut:
    _admin(user)
    rec = _open_record(db, connector_id, record_id)
    try:
        conn.fix(db, rec, body.value, user.id)
    except conn.IntegrationError as exc:
        raise HTTPException(422, str(exc)) from exc
    db.commit()
    return QuarantineOutcomeOut(ok=True, record=QuarantineOut.model_validate(rec))


@router.post("/integrations/{connector_id}/quarantine/{record_id}/dismiss", response_model=QuarantineOutcomeOut)
def dismiss_record(connector_id: str, record_id: str, body: QuarantineDismissIn, db: DbSession, user: CurrentUserDep
                   ) -> QuarantineOutcomeOut:
    _admin(user)
    rec = _open_record(db, connector_id, record_id)
    conn.dismiss(db, rec, body.reason, user.id)
    db.commit()
    return QuarantineOutcomeOut(ok=True, record=QuarantineOut.model_validate(rec))


# ---------- email outbox ----------
@router.get("/email-switches", response_model=list[EmailSwitchOut])
def email_switches(db: DbSession, user: CurrentUserDep) -> list[EmailSwitchOut]:
    _admin(user)
    rows = {r.channel: r for r in db.scalars(select(EmailChannelSwitch))}
    out = []
    for channel, (label, desc, on) in DEFAULT_SWITCHES.items():
        r = rows.get(channel)
        out.append(EmailSwitchOut(channel=channel, label=r.label if r else label, description=r.description if r else desc,
                                  email=r.email if r else on))
    return out


@router.put("/email-switches/{channel}", response_model=EmailSwitchOut)
def put_email_switch(channel: str, body: EmailSwitchIn, request: Request, db: DbSession, user: CurrentUserDep) -> EmailSwitchOut:
    _admin(user)
    if channel not in DEFAULT_SWITCHES:
        raise NOT_FOUND
    label, desc, on = DEFAULT_SWITCHES[channel]
    row = db.get(EmailChannelSwitch, channel)
    before = row.email if row else on
    if row is None:
        row = EmailChannelSwitch(channel=channel, label=label, description=desc, email=body.email)
        db.add(row)
    row.email, row.updated_by = body.email, user.id
    record_audit(db, actor_id=user.id, action="email_switch_changed", entity="email_channel", entity_id=channel,
                 before={"email": before}, after={"email": body.email}, ip=client_ip(request))
    db.commit()
    return EmailSwitchOut.model_validate(row)


@router.get("/email-outbox", response_model=list[EmailOutboxOut])
def email_outbox(db: DbSession, user: CurrentUserDep,
                 status_filter: Annotated[str | None, Query(alias="status", pattern="^(Queued|Sent)$")] = None,
                 recipient_id: str | None = None, channel: str | None = None,
                 limit: Annotated[int, Query(ge=1, le=500)] = 100) -> list[EmailOutboxItem]:
    _admin(user)
    stmt = select(EmailOutboxItem)
    if status_filter:
        stmt = stmt.where(EmailOutboxItem.status == status_filter)
    if recipient_id:
        stmt = stmt.where(EmailOutboxItem.recipient_id == recipient_id)
    if channel:
        stmt = stmt.where(EmailOutboxItem.channel == channel)
    return list(db.scalars(stmt.order_by(EmailOutboxItem.id.desc()).limit(limit)))


@router.post("/email-outbox/mark-sent", response_model=EmailMarkSentOut)
def mark_sent(body: EmailMarkSentIn, request: Request, db: DbSession, user: CurrentUserDep) -> EmailMarkSentOut:
    _admin(user)
    stmt = select(EmailOutboxItem).where(EmailOutboxItem.status == "Queued")
    if not body.all_queued:
        if not body.ids:
            raise HTTPException(422, "Pick the emails to mark as sent.")
        stmt = stmt.where(EmailOutboxItem.id.in_(body.ids))
    now = utcnow()
    count = 0
    for item in db.scalars(stmt):
        item.status, item.sent_at, item.sent_by = "Sent", now, user.id
        count += 1
    if count:
        record_audit(db, actor_id=user.id, action="emails_marked_sent", entity="email_outbox", entity_id=None,
                     after={"count": count}, ip=client_ip(request))
    db.commit()
    return EmailMarkSentOut(marked=count)


# ---------- jobs ----------
@router.post("/jobs/run", response_model=JobsRunOut)
def run_jobs(request: Request, db: DbSession, user: CurrentUserDep, include_syncs: bool = False) -> JobsRunOut:
    """Approval reminders, SLA escalation and case retention (also run at startup); optionally due connector syncs."""
    _admin(user)
    results = jobs.run_all(db)
    if include_syncs:
        results["integration_syncs"] = conn.run_due_syncs(db)
    record_audit(db, actor_id=user.id, action="jobs_run", entity="jobs", entity_id=None, after=results, ip=client_ip(request))
    db.commit()
    return JobsRunOut(results=results)


