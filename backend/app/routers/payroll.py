"""Payroll tab: integration status only (no payroll processing, tax, payslips or payments in this version).

Per country + legal entity: provider, connection / integration status, last sync, current payroll period, health,
configuration status and how many employees sit in each payroll_status. Connection data comes from the
"payroll" integration connector (Integration Center). The provider per country is admin configuration
(GET / PUT /payroll/providers, stored in platform_settings "payroll_providers"); a country with none shows "Not set".
"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.deps import CurrentUserDep, DbSession, client_ip
from app.models import Country, Employee, IntegrationConnector, PlatformSetting
from app.schemas.onboarding_payroll import PayrollEntityStatusOut, PayrollStatusOut
from app.services.activity import record_audit
from app.services.scope import HR_ROLES

router = APIRouter(prefix="/payroll", tags=["payroll"])

PAYROLL_ROLES = HR_ROLES | {"admin", "finance"}
PAYROLL_CONNECTOR = "payroll"
PROVIDERS_KEY = "payroll_providers"  # platform_settings: {"IN": "Provider name", ...}
ADMIN_ROLES = frozenset({"admin", "super_admin"})
NOT_SET = "Not set"


class PayrollProvidersIn(BaseModel):
    """Country code -> provider name. A blank name removes the country (it shows "Not set")."""

    providers: dict[str, str] = Field(max_length=100)


class PayrollProvidersOut(BaseModel):
    providers: dict[str, str]
    countries: list[str]


def providers(db: DbSession) -> dict[str, str]:
    row = db.get(PlatformSetting, PROVIDERS_KEY)
    value = row.value if row is not None and isinstance(row.value, dict) else {}
    return {str(k).upper(): str(v) for k, v in value.items() if str(v).strip()}


def _health(connection: str, failed: int, processed: int) -> str:
    if connection in ("Disconnected", "Not configured"):
        return "Down"
    if connection == "Degraded" or (processed and failed / processed > 0.05):
        return "Warning"
    return "Healthy"


@router.get("/status", response_model=PayrollStatusOut)
def payroll_status(db: DbSession, user: CurrentUserDep) -> PayrollStatusOut:
    if user.account.role not in PAYROLL_ROLES:
        raise HTTPException(403, "The payroll tab is for HR, finance and admins.")
    today = date.today()
    period, label = today.strftime("%Y-%m"), today.strftime("%b %Y")
    conn = db.get(IntegrationConnector, PAYROLL_CONNECTOR)
    connection = conn.status if conn else "Not configured"
    health_base = _health(connection, conn.failed_count if conn else 0, conn.records_processed if conn else 0)
    countries = {c.code: c.name for c in db.scalars(select(Country))}
    stmt = (select(Employee.country_code, Employee.legal_entity, Employee.payroll_status, func.count())
            .where(user.scope.employee_filter())
            .group_by(Employee.country_code, Employee.legal_entity, Employee.payroll_status))
    groups: dict[tuple[str, str], dict[str, int]] = {}
    for cc, entity, status, n in db.execute(stmt):
        counts = groups.setdefault((cc, entity or NOT_SET), {})
        key = status or NOT_SET
        counts[key] = counts.get(key, 0) + n
    configured_providers = providers(db)
    rows: list[PayrollEntityStatusOut] = []
    totals: dict[str, int] = {}
    for (cc, entity), counts in sorted(groups.items()):
        provider = configured_providers.get(cc)
        configured = provider is not None and entity != NOT_SET and NOT_SET not in counts
        if connection == "Connected":
            integration = "Active" if configured else "Paused"
        elif connection == "Degraded":
            integration = "Paused"
        else:
            integration = "Not started"
        health = health_base if configured else ("Down" if health_base == "Down" else "Warning")
        for k, v in counts.items():
            totals[k] = totals.get(k, 0) + v
        rows.append(PayrollEntityStatusOut(
            country_code=cc, country_name=countries.get(cc), legal_entity=entity, provider=provider or NOT_SET,
            connection_status=connection if provider else "Not configured", integration_status=integration,
            last_sync_at=conn.last_sync_at if conn and provider else None, payroll_period=period,
            payroll_period_label=label, integration_health=health,
            configuration_status="Configured" if configured else "Incomplete",
            employees=sum(counts.values()), payroll_status_counts=counts,
        ))
    return PayrollStatusOut(period=period, period_label=label, connector_status=connection, rows=rows, totals=totals)


@router.get("/providers", response_model=PayrollProvidersOut)
def get_providers(db: DbSession, user: CurrentUserDep) -> PayrollProvidersOut:
    if user.account.role not in PAYROLL_ROLES:
        raise HTTPException(403, "The payroll tab is for HR, finance and admins.")
    return PayrollProvidersOut(providers=providers(db), countries=sorted(c.code for c in db.scalars(select(Country))))


@router.put("/providers", response_model=PayrollProvidersOut)
def put_providers(body: PayrollProvidersIn, request: Request, db: DbSession, user: CurrentUserDep) -> PayrollProvidersOut:
    if user.account.role not in ADMIN_ROLES:
        raise HTTPException(403, "Only an admin can set payroll providers.")
    known = {c.code for c in db.scalars(select(Country))}
    clean: dict[str, str] = {}
    for code, name in body.providers.items():
        cc = code.strip().upper()
        if cc not in known:
            raise HTTPException(422, f"Unknown country: {code}.")
        name = name.strip()
        if len(name) > 100:
            raise HTTPException(422, "Provider names are up to 100 characters.")
        if name:
            clean[cc] = name
    before = providers(db)
    row = db.get(PlatformSetting, PROVIDERS_KEY)
    if row is None:
        db.add(PlatformSetting(key=PROVIDERS_KEY, value=clean, updated_by=user.id))
    else:
        row.value = clean
        row.updated_by = user.id
    if before != clean:
        record_audit(db, actor_id=user.id, action="updated payroll providers", entity="platform_setting",
                     entity_id=PROVIDERS_KEY, before=before, after=clean, ip=client_ip(request))
    db.commit()
    return PayrollProvidersOut(providers=clean, countries=sorted(known))
