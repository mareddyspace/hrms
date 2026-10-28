"""Shapes for leave admin (types, policies, holidays), leave eligibility in balances, country config and the
carry-forward job (app/routers/leave_admin.py, migration 0011). Names are unique across app.schemas."""

from __future__ import annotations

import datetime as dt
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.schemas import LeaveBalanceOut

GenderRule = Literal["any", "female", "male"]
Accrual = Literal["annual", "monthly"]
WeekDay = Literal["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


class LeaveBalanceRuleOut(LeaveBalanceOut):
    eligible: bool = True
    not_eligible_reason: str | None = None


class LeaveBalancesRuleOut(BaseModel):
    employee_id: str
    year: int
    balances: list[LeaveBalanceRuleOut]


class LeaveTypeAdminOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    code: str
    name: str
    half_day_allowed: bool
    active: bool


class LeaveTypeAdminIn(BaseModel):
    code: str = Field(pattern=r"^[a-z][a-z0-9_]{1,31}$")
    name: str = Field(min_length=1, max_length=100)
    half_day_allowed: bool = True


class LeaveTypeAdminUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    half_day_allowed: bool | None = None
    active: bool | None = None


class LeaveRuleFields(BaseModel):
    gender: GenderRule = "any"
    min_service_months: int | None = Field(default=None, ge=0, le=600)
    employment_types: list[str] = Field(default_factory=list, max_length=10)
    not_in_probation: bool = False
    max_per_request: float | None = Field(default=None, gt=0, le=365)
    min_notice_days: int | None = Field(default=None, ge=0, le=365)


class LeavePolicyAdminIn(LeaveRuleFields):
    leave_code: str = Field(min_length=1, max_length=32)
    country_code: str = Field(pattern=r"^[A-Z]{2}$")
    name: str = Field(min_length=1, max_length=100)
    quota: float = Field(ge=0, le=365)
    carry_forward_max: float = Field(default=0, ge=0, le=365)
    accrual: Accrual = "annual"
    effective_from: dt.date
    effective_to: dt.date | None = None


class LeavePolicyAdminUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    quota: float | None = Field(default=None, ge=0, le=365)
    carry_forward_max: float | None = Field(default=None, ge=0, le=365)
    accrual: Accrual | None = None
    effective_from: dt.date | None = None
    effective_to: dt.date | None = None
    gender: GenderRule | None = None
    min_service_months: int | None = Field(default=None, ge=0, le=600)
    employment_types: list[str] | None = Field(default=None, max_length=10)
    not_in_probation: bool | None = None
    max_per_request: float | None = Field(default=None, gt=0, le=365)
    min_notice_days: int | None = Field(default=None, ge=0, le=365)
    active: bool | None = None


class LeavePolicyAdminOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    leave_code: str
    country_code: str
    name: str
    quota: float
    carry_forward_max: float
    accrual: str
    effective_from: dt.date
    effective_to: dt.date | None
    gender: str | None
    min_service_months: int | None
    employment_types: list[str] | None
    not_in_probation: bool
    max_per_request: float | None
    min_notice_days: int | None
    active: bool


class HolidayAdminIn(BaseModel):
    country_code: str = Field(pattern=r"^[A-Z]{2}$")
    date: dt.date
    name: str = Field(min_length=1, max_length=200)
    calendar: str | None = Field(default=None, max_length=100)


class HolidayAdminUpdate(BaseModel):
    date: dt.date | None = None
    name: str | None = Field(default=None, min_length=1, max_length=200)
    calendar: str | None = Field(default=None, max_length=100)
    active: bool | None = None


class HolidayAdminOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    country_code: str
    date: dt.date
    name: str
    calendar: str | None
    active: bool


class HolidayCalendarOut(BaseModel):
    country_code: str
    calendar: str
    employees: int


class CarryForwardRunOut(BaseModel):
    year: int
    created: int
    skipped: int


class CountryConfigOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    code: str
    name: str
    currency: str
    time_zone: str
    languages: list[str] | None
    work_week_days: list[str] | None
    standard_daily_hours: float | None
    probation_months: int | None
    notice_days: int | None
    required_documents: list[str] | None
    workflow_notes: str | None


class CountryConfigIn(BaseModel):
    languages: list[Literal["en", "hi", "de", "ar"]] | None = Field(default=None, max_length=4)
    work_week_days: list[WeekDay] | None = Field(default=None, min_length=1, max_length=7)
    standard_daily_hours: float | None = Field(default=None, gt=0, le=24)
    probation_months: int | None = Field(default=None, ge=0, le=24)
    notice_days: int | None = Field(default=None, ge=0, le=365)
    required_documents: list[str] | None = Field(default=None, max_length=30)
    workflow_notes: str | None = Field(default=None, max_length=4000)
