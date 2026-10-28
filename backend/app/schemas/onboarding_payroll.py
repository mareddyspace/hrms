"""Shapes for onboarding analytics, the pre-boarding form and the payroll integration status (migration 0010)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

EquipmentItem = Literal["laptop", "monitor", "keyboard", "headset", "phone", "docking_station"]


class PreboardingPersonalIn(BaseModel):
    confirmed: bool = False  # the joiner checked their details
    preferred_name: str | None = Field(default=None, max_length=200)
    personal_email: str | None = Field(default=None, max_length=200)
    mobile: str | None = Field(default=None, max_length=40)
    address: str | None = Field(default=None, max_length=500)


class PreboardingEmergencyIn(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    relationship: str = Field(min_length=2, max_length=60)
    phone: str = Field(min_length=5, max_length=40)


class PreboardingItRequestIn(BaseModel):
    systems: list[str] = Field(default_factory=list, max_length=20)  # e.g. Email, VPN, Jira
    notes: str | None = Field(default=None, max_length=1000)


class PreboardingFormIn(BaseModel):
    personal: PreboardingPersonalIn
    emergency_contact: PreboardingEmergencyIn
    equipment: list[EquipmentItem] = Field(default_factory=list)
    it_request: PreboardingItRequestIn = Field(default_factory=PreboardingItRequestIn)


class OnbMonthCount(BaseModel):
    month: str
    count: int


class OnbCountryCount(BaseModel):
    country_code: str
    count: int


class OnbOwnerCount(BaseModel):
    owner_role: str
    count: int


class OnboardingAnalyticsOut(BaseModel):
    total_joiners: int
    joiners_by_month: list[OnbMonthCount]
    joiners_by_country: list[OnbCountryCount]
    tasks_total: int
    tasks_done: int
    completion_pct: int
    overdue_by_owner: list[OnbOwnerCount]
    overdue_total: int
    avg_days_to_complete: float | None
    preboarding_count: int
    onboarding_count: int
    completed_count: int
    status_counts: dict[str, int]


class PayrollEntityStatusOut(BaseModel):
    country_code: str
    country_name: str | None
    legal_entity: str
    provider: str
    connection_status: str  # Connected | Degraded | Disconnected | Not configured
    integration_status: str  # Active | Paused | Not started
    last_sync_at: datetime | None
    payroll_period: str  # YYYY-MM (current month)
    payroll_period_label: str  # e.g. Oct 2026
    integration_health: str  # Healthy | Warning | Down
    configuration_status: str  # Configured | Incomplete
    employees: int
    payroll_status_counts: dict[str, int]


class PayrollStatusOut(BaseModel):
    period: str
    period_label: str
    connector_status: str
    rows: list[PayrollEntityStatusOut]
    totals: dict[str, int]
