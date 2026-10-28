"""Shapes for the admin platform (data scope, page access, AI settings, settings, integrations, email outbox, jobs).
Class names are unique across app.schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

DataScopeName = Literal["own", "direct", "line", "department", "country", "entity", "business_unit", "location", "global"]


class DataScopeIn(BaseModel):
    scope: DataScopeName
    countries: list[str] = Field(default_factory=list, max_length=50)


class DataScopeOut(BaseModel):
    account_id: str
    scope: str
    countries: list[str]
    custom: bool


class PageAccessIn(BaseModel):
    grant: list[str] = Field(default_factory=list, max_length=200)
    revoke: list[str] = Field(default_factory=list, max_length=200)


class PageAccessOut(BaseModel):
    account_id: str
    grant: list[str]
    revoke: list[str]
    custom: bool


class AdminAccountOut(BaseModel):
    account_id: str
    email: str
    role: str
    employee_id: str | None
    full_name: str | None
    data_scope: DataScopeOut
    page_access: PageAccessOut


class AiSettingsIn(BaseModel):
    disabled_policies: list[str] | None = Field(default=None, max_length=500)
    disabled_agents: list[str] | None = Field(default=None, max_length=100)
    disabled_features: list[str] | None = Field(default=None, max_length=20)


class AiSettingsOut(BaseModel):
    disabled_policies: list[str]
    disabled_agents: list[str]
    disabled_features: list[str]
    features: list[str]


class PlatformSettingsIn(BaseModel):
    case_retention_years: int | None = Field(default=None, ge=1, le=50)
    posh_committee: list[str] | None = Field(default=None, max_length=20)


class PlatformSettingsOut(BaseModel):
    case_retention_years: int
    posh_committee: list[str]


class ConnectorOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str
    category: str
    status: str
    schedule: str
    last_sync_at: datetime | None
    run_count: int
    records_processed: int
    success_count: int
    failed_count: int
    open_quarantine: int = 0
    next_run_at: datetime | None = None


class ConnectorScheduleIn(BaseModel):
    schedule: Literal["15m", "hourly", "daily", "manual"]


class IntegrationRunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    connector_id: str
    started_at: datetime
    trigger: str
    processed: int
    succeeded: int
    failed: int
    run_by: str | None


class QuarantineOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    connector_id: str
    run_id: int | None
    record: str
    field: str
    value: str
    reason: str
    attempts: int
    status: str
    resolved_by: str | None
    resolved_at: datetime | None
    resolution_note: str | None
    created_at: datetime


class QuarantineFixIn(BaseModel):
    value: str = Field(min_length=1, max_length=200)


class QuarantineDismissIn(BaseModel):
    reason: str = Field(min_length=1, max_length=500)


class QuarantineOutcomeOut(BaseModel):
    ok: bool
    record: QuarantineOut


class EmailSwitchOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    channel: str
    label: str
    description: str
    email: bool


class EmailSwitchIn(BaseModel):
    email: bool


class EmailOutboxOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    notification_id: int | None
    recipient_id: str
    to_email: str
    subject: str
    body: str
    link: str | None
    category: str
    channel: str
    status: str
    created_at: datetime
    sent_at: datetime | None


class EmailMarkSentIn(BaseModel):
    ids: list[int] = Field(default_factory=list, max_length=1000)
    all_queued: bool = False


class EmailMarkSentOut(BaseModel):
    marked: int


class JobsRunOut(BaseModel):
    results: dict[str, Any]
