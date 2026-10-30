from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import BaseModel, Field


class StepOut(BaseModel):
    label: str
    approver_ids: list[str] = []
    approver_names: list[str] = []
    decision: str | None = None  # approve | reject
    by: str | None = None
    note: str | None = None
    at: str | None = None


class DecisionIn(BaseModel):
    decision: Literal["approve", "reject"]
    note: str | None = Field(default=None, max_length=2000)


# ---------- cash advances ----------
class CashIn(BaseModel):
    amount: float = Field(gt=0, le=100_000_000)
    category: str = Field(min_length=1, max_length=64)
    purpose: str = Field(default="", max_length=1000)
    needed_by: date
    instalments: int = Field(default=1, ge=1, le=12)


class CashPayIn(BaseModel):
    reference: str | None = Field(default=None, max_length=64)


class InstalmentOut(BaseModel):
    month: str
    amount: float
    recovered: bool


class CashOut(BaseModel):
    id: str
    employee_id: str
    employee_name: str | None = None
    amount: float
    currency: str
    category: str
    purpose: str
    needed_by: date
    instalments: int
    status: str
    submitted_on: date
    steps: list[StepOut] = []
    can_decide: bool = False
    can_withdraw: bool = False
    can_pay: bool = False
    paid_on: date | None = None
    paid_by: str | None = None
    reference: str | None = None
    outstanding: float = 0
    schedule: list[InstalmentOut] = []


class CashPolicyOut(BaseModel):
    limit: float
    basic_monthly: float
    country_cap: float
    currency: str
    max_instalments: int
    categories: list[str]
    open_id: str | None = None


# ---------- leave encashment ----------
class EncashIn(BaseModel):
    leave_code: str = Field(default="pto", max_length=32)
    days: float = Field(gt=0, le=60)


class EncashTypeOut(BaseModel):
    code: str
    name: str
    available: float
    encashable: float
    used_this_year: float
    eligible: bool
    why_not: str | None = None


class EncashPolicyOut(BaseModel):
    per_day: float
    currency: str
    max_days_a_year: float
    keep_days: float
    cutoff_day: int
    types: list[EncashTypeOut]


class EncashOut(BaseModel):
    id: str
    employee_id: str
    employee_name: str | None = None
    leave_code: str
    days: float
    per_day: float
    amount: float
    currency: str
    status: str
    submitted_on: date
    payout_month: str | None = None
    steps: list[StepOut] = []
    can_decide: bool = False
    can_withdraw: bool = False


# ---------- software ----------
class SoftwareTitleOut(BaseModel):
    id: str
    name: str
    category: str
    vendor: str
    monthly_cost: float
    currency: str
    needs_approval: bool
    seats: int
    seats_used: int
    active: bool


class SoftwareTitleIn(BaseModel):
    seats: int | None = Field(default=None, ge=0, le=100000)
    needs_approval: bool | None = None
    active: bool | None = None


class SoftwareIn(BaseModel):
    title_id: str = Field(min_length=1, max_length=64)
    reason: str = Field(default="", max_length=1000)
    duration_months: int | None = Field(default=None, ge=1, le=24)
    employee_id: str | None = Field(default=None, description="IT only: assign to someone directly")


class SoftwareOut(BaseModel):
    id: str
    employee_id: str
    employee_name: str | None = None
    title_id: str
    title_name: str
    category: str
    monthly_cost: float
    currency: str
    reason: str
    duration_months: int | None
    status: str
    submitted_on: date
    assigned_on: date | None = None
    expires_on: date | None = None
    ended_on: date | None = None
    ended_by: str | None = None
    licence_key: str | None = None
    direct: bool = False
    steps: list[StepOut] = []
    can_decide: bool = False
    can_withdraw: bool = False
    can_return: bool = False
    can_revoke: bool = False
