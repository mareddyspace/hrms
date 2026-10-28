"""Compensation request/response shapes (pay fields: only ever returned to people allowed to see them)."""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

CurrencyCode = Field(default=None, pattern=r"^[A-Z]{3}$")


class _CompORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class GradeBandIn(BaseModel):
    grade: str = Field(min_length=1, max_length=16)
    country_code: str = Field(pattern=r"^[A-Z]{2}$")
    currency: str | None = CurrencyCode  # None = the country's currency
    min_amount: float = Field(gt=0, le=1_000_000_000)
    mid_amount: float = Field(gt=0, le=1_000_000_000)
    max_amount: float = Field(gt=0, le=1_000_000_000)


class GradeBandUpdateIn(BaseModel):
    min_amount: float = Field(gt=0, le=1_000_000_000)
    mid_amount: float = Field(gt=0, le=1_000_000_000)
    max_amount: float = Field(gt=0, le=1_000_000_000)


class GradeBandOut(_CompORM):
    id: str
    grade: str
    country_code: str
    currency: str
    min_amount: float
    mid_amount: float
    max_amount: float
    updated_at: datetime


class CompRecordIn(BaseModel):
    employee_id: str = Field(min_length=1, max_length=64)
    effective_date: date
    base_salary: float = Field(gt=0, le=1_000_000_000)
    currency: str | None = CurrencyCode  # None = the employee's currency (the only one accepted)
    grade: str | None = Field(default=None, max_length=16)  # None = the employee's current grade
    reason: str = Field(min_length=1, max_length=200)


class CompRecordOut(_CompORM):
    id: str
    employee_id: str
    effective_date: date
    base_salary: float
    currency: str
    grade: str
    reason: str
    proposal_id: str | None
    created_at: datetime
    is_current: bool = False


class CompHistoryOut(BaseModel):
    employee_id: str
    employee_name: str
    current: CompRecordOut | None
    records: list[CompRecordOut]


class CompBonusIn(BaseModel):
    employee_id: str = Field(min_length=1, max_length=64)
    bonus_type: str = Field(min_length=1, max_length=100)
    period: str = Field(min_length=1, max_length=32)
    amount: float = Field(gt=0, le=1_000_000_000)


class CompBonusStatusIn(BaseModel):
    status: Literal["paid", "forfeited"]


class CompBonusOut(_CompORM):
    id: str
    employee_id: str
    bonus_type: str
    period: str
    amount: float
    currency: str
    status: str
    proposal_id: str | None
    created_at: datetime


class CompCycleIn(BaseModel):
    name: str = Field(min_length=3, max_length=200)
    effective_date: date
    budget_pct: float = Field(gt=0, le=50)
    opens_on: date
    closes_on: date
    countries: list[str] | None = Field(default=None, max_length=50)
    status: Literal["planning", "open"] = "planning"


class CompCycleStatusIn(BaseModel):
    status: Literal["planning", "open", "closed"]


class CompCycleOut(_CompORM):
    id: str
    name: str
    effective_date: date
    budget_pct: float
    opens_on: date
    closes_on: date
    status: str
    countries: list[str] | None
    accepting_proposals: bool = False
    # HR / compensation only: increase spent so far as % of the current base of the people proposed for.
    budget_used_pct: float | None = None
    proposals: int | None = None


class CompProposalIn(BaseModel):
    cycle_id: str = Field(min_length=1, max_length=64)
    employee_id: str = Field(min_length=1, max_length=64)
    increase_pct: float = Field(ge=0, le=100)
    proposed_grade: str | None = Field(default=None, max_length=16)  # None = keep the current grade
    bonus_amount: float | None = Field(default=None, ge=0, le=1_000_000_000)
    justification: str | None = Field(default=None, max_length=2000)


class CompProposalOut(_CompORM):
    id: str
    cycle_id: str
    employee_id: str
    employee_name: str | None = None
    proposed_by: str
    currency: str
    current_grade: str
    proposed_grade: str
    increase_pct: float
    # Amounts are null for viewers without pay access (e.g. a manager without comp_access).
    current_base: float | None
    proposed_base: float | None
    bonus_amount: float | None
    pay_visible: bool = True
    justification: str | None
    status: str
    approval_instance_id: str | None
    approval_status: str | None = None
    current_step: int | None = None
    executive_step: bool = False
    record_id: str | None
    decided_at: datetime | None
    created_at: datetime


class StatementBenefitLine(BaseModel):
    plan_id: str
    plan_name: str
    plan_type: str
    employer_annual_cost: float
    currency: str


class CompStatementOut(BaseModel):
    employee_id: str
    year: int
    currency: str
    grade: str | None
    base_salary: float
    base_effective_date: date | None
    bonus_total: float
    bonuses: list[CompBonusOut]
    benefits_employer_cost: float
    benefits: list[StatementBenefitLine]
    total_rewards: float
