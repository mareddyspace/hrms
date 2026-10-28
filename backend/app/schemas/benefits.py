"""Benefits request/response shapes."""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

LifeEventType = Literal["Marriage", "Birth or adoption", "Divorce", "Death of a dependent", "Spouse lost coverage"]
DependentRelationship = Literal["Spouse", "Partner", "Child", "Parent", "Parent-in-law"]
BenefitPlanType = Literal["Medical", "Dental", "Vision", "Life", "Retirement", "Wellness", "Other"]


class _BenefitORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class PlanEligibilityRules(BaseModel):
    exclude_employment_types: list[str] = Field(default_factory=list, max_length=10)
    min_service_months: int = Field(default=0, ge=0, le=600)
    grades: list[str] = Field(default_factory=list, max_length=50)


class BenefitPlanIn(BaseModel):
    id: str | None = Field(default=None, pattern=r"^[a-z0-9-]{3,64}$")
    country_code: str = Field(pattern=r"^[A-Z]{2}$")
    name: str = Field(min_length=2, max_length=200)
    plan_type: BenefitPlanType
    provider: str = Field(min_length=1, max_length=200)
    summary: str = Field(default="", max_length=2000)
    employee_cost: str = Field(default="", max_length=100)
    employer_annual_cost: float = Field(default=0, ge=0, le=100_000_000)
    covers_dependents: bool = False
    mandatory: bool = False
    auto_enrolled: bool = False
    eligibility: PlanEligibilityRules = Field(default_factory=PlanEligibilityRules)


class BenefitPlanPatch(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=200)
    provider: str | None = Field(default=None, min_length=1, max_length=200)
    summary: str | None = Field(default=None, max_length=2000)
    employee_cost: str | None = Field(default=None, max_length=100)
    employer_annual_cost: float | None = Field(default=None, ge=0, le=100_000_000)
    covers_dependents: bool | None = None
    eligibility: PlanEligibilityRules | None = None
    active: bool | None = None


class BenefitPlanOut(_BenefitORM):
    id: str
    country_code: str
    name: str
    plan_type: str
    provider: str
    summary: str
    employee_cost: str
    employer_annual_cost: float
    currency: str
    covers_dependents: bool
    mandatory: bool
    auto_enrolled: bool
    eligibility: dict
    active: bool
    rules: list[str] = []


class EligibilityCheckOut(BaseModel):
    plan_id: str
    employee_id: str
    eligible: bool
    reason: str
    rules: list[str]
    window_open: bool
    window_text: str


class BenefitWindowIn(BaseModel):
    name: str = Field(min_length=3, max_length=200)
    country_code: str | None = Field(default=None, pattern=r"^[A-Z]{2}$")  # None = every country
    start_date: date
    end_date: date


class BenefitWindowPatch(BaseModel):
    start_date: date | None = None
    end_date: date | None = None
    # "open" / "closed" force the window; "dates" goes back to the dates.
    override: Literal["open", "closed", "dates"] | None = None


class BenefitWindowOut(_BenefitORM):
    id: str
    name: str
    country_code: str | None
    start_date: date
    end_date: date
    override: str | None
    is_open: bool = False


class ChangeWindowOut(BaseModel):
    open: bool
    text: str
    window_id: str | None
    life_event_id: str | None
    until: date | None


class LifeEventIn(BaseModel):
    event_type: LifeEventType
    event_date: date


class LifeEventOut(_BenefitORM):
    id: str
    employee_id: str
    event_type: str
    event_date: date
    window_ends: date
    status: str
    created_at: datetime


class BenefitEnrollIn(BaseModel):
    plan_id: str = Field(min_length=1, max_length=64)
    dependent_ids: list[str] = Field(default_factory=list, max_length=20)


class BenefitEnrollDecisionIn(BaseModel):
    decision: Literal["approve", "waive"]
    note: str | None = Field(default=None, max_length=2000)


class CoverageIn(BaseModel):
    dependent_ids: list[str] = Field(default_factory=list, max_length=20)


class BenefitEnrollmentOut(_BenefitORM):
    id: str
    employee_id: str
    employee_name: str | None = None
    plan_id: str
    plan_name: str | None = None
    status: str
    effective_date: date | None
    life_event_id: str | None
    decided_by: str | None
    decided_at: datetime | None
    note: str | None
    dependent_ids: list[str] = []
    created_at: datetime


class DependentIn(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    relationship: DependentRelationship
    date_of_birth: date
    gender: str | None = Field(default=None, max_length=32)


class DependentVerifyIn(BaseModel):
    status: Literal["verified", "rejected"]
    note: str | None = Field(default=None, max_length=2000)


class DependentOut(_BenefitORM):
    id: str
    employee_id: str
    name: str
    relationship: str
    date_of_birth: date | str  # masked ("•• ••• 1990") for anyone but the employee
    gender: str | None
    verification: str
    verified_by: str | None
    verified_at: datetime | None
    covered_plan_ids: list[str] = []


class NomineeIn(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    relationship: str = Field(min_length=2, max_length=32)
    share_pct: float = Field(gt=0, le=100)
    date_of_birth: date | None = None


class NominationIn(BaseModel):
    nomination_for: str = Field(default="General", min_length=1, max_length=64)
    nominees: list[NomineeIn] = Field(default_factory=list, max_length=10)


class NomineeOut(_BenefitORM):
    id: int
    employee_id: str
    nomination_for: str
    name: str
    relationship: str
    share_pct: float
    date_of_birth: date | str | None  # masked for anyone but the employee
