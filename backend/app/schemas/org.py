"""Lifecycle actions, assignment history, organization units, job families/profiles and positions."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.schemas import ORM

LifecycleType = Literal[
    "transfer", "promotion", "manager_change", "location_change", "job_change", "leave_of_absence",
    "return_from_leave", "contract_extension", "probation_completion", "rehire",
]
OrgUnitType = Literal["company", "legal_entity", "country", "business_unit", "division", "department", "team",
                      "supervisory_org", "cost_centre", "location"]
CODE_PATTERN = r"^[A-Z0-9]+([-_][A-Z0-9]+)*$"


# ---------- lifecycle ----------
class LifecycleActionIn(BaseModel):
    employee_id: str = Field(min_length=1, max_length=64)
    action_type: LifecycleType
    effective_date: date
    after: dict[str, Any] = Field(default_factory=dict)
    reason: str = Field(min_length=1, max_length=2000)


class LifecycleActionOut(ORM):
    id: str
    employee_id: str
    employee_name: str | None = None
    action_type: str
    effective_date: date
    before: dict[str, Any]
    after: dict[str, Any]
    reason: str
    status: str
    requested_by: str
    approval_instance_id: str | None
    approval_status: str | None = None
    current_step: int | None = None
    applied_at: datetime | None
    created_at: datetime


class AssignmentOut(ORM):
    id: int
    employee_id: str
    effective_from: date
    effective_to: date | None
    manager_id: str | None
    manager_name: str | None = None
    job_title: str
    grade: str
    department: str
    location: str
    legal_entity: str
    employment_status: str
    business_unit: str | None = None
    division: str | None = None
    cost_centre: str | None = None
    job_profile_id: str | None = None
    position_id: str | None = None


class ApplyDueOut(BaseModel):
    applied: int
    ids: list[str]


# ---------- organization ----------
class OrgUnitIn(BaseModel):
    code: str = Field(min_length=1, max_length=64, pattern=CODE_PATTERN)
    name: str = Field(min_length=1, max_length=200)
    type: OrgUnitType
    parent_id: str | None = Field(default=None, max_length=64)
    country_code: str | None = Field(default=None, pattern=r"^[A-Z]{2}$")
    manager_id: str | None = Field(default=None, max_length=64)
    headcount: int | None = Field(default=None, ge=0, le=100000)
    effective_from: date | None = None  # None = today


class OrgUnitUpdate(BaseModel):
    code: str | None = Field(default=None, min_length=1, max_length=64, pattern=CODE_PATTERN)
    name: str | None = Field(default=None, min_length=1, max_length=200)
    parent_id: str | None = Field(default=None, max_length=64)
    country_code: str | None = Field(default=None, pattern=r"^[A-Z]{2}$")
    manager_id: str | None = Field(default=None, max_length=64)
    headcount: int | None = Field(default=None, ge=0, le=100000)
    active: bool | None = None
    effective_from: date | None = None  # the day the change takes effect; None = today (no future dates)
    reason: str | None = Field(default=None, max_length=500)


class OrgUnitOut(ORM):
    id: str
    code: str
    name: str
    type: str
    parent_id: str | None
    country_code: str | None
    active: bool
    manager_id: str | None = None
    headcount: int | None = None
    effective_from: date | None = None
    effective_to: date | None = None


class OrgVersionOut(ORM):
    """One effective-dated version of an org unit, job profile or position (newest first)."""

    id: int
    entity: str
    entity_id: str
    effective_from: date
    effective_to: date | None
    change: str
    changed_fields: list[str]
    snapshot: dict[str, Any]
    changed_by: str | None
    changed_by_name: str | None = None
    reason: str | None
    created_at: datetime


class EffectiveDateIn(BaseModel):
    effective_from: date | None = None
    reason: str | None = Field(default=None, max_length=500)


class JobFamilyIn(BaseModel):
    code: str = Field(min_length=1, max_length=64, pattern=CODE_PATTERN)
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=4000)


class JobFamilyUpdate(BaseModel):
    code: str | None = Field(default=None, min_length=1, max_length=64, pattern=CODE_PATTERN)
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=4000)
    active: bool | None = None


class JobFamilyOut(ORM):
    id: str
    code: str
    name: str
    description: str | None
    active: bool


Skills = Field(default_factory=list, max_length=50)


class JobProfileIn(BaseModel):
    code: str = Field(min_length=1, max_length=64, pattern=CODE_PATTERN)
    title: str = Field(min_length=1, max_length=200)
    family_id: str | None = Field(default=None, max_length=64)
    grade: str | None = Field(default=None, max_length=16)
    description: str | None = Field(default=None, max_length=8000)
    required_skills: list[str] = Skills
    preferred_skills: list[str] = Skills
    job_level: str | None = Field(default=None, max_length=32)
    experience_min_years: int | None = Field(default=None, ge=0, le=60)
    experience_max_years: int | None = Field(default=None, ge=0, le=60)
    education: str | None = Field(default=None, max_length=200)
    responsibilities: list[str] = Field(default_factory=list, max_length=30)
    effective_from: date | None = None


class JobProfileUpdate(BaseModel):
    code: str | None = Field(default=None, min_length=1, max_length=64, pattern=CODE_PATTERN)
    title: str | None = Field(default=None, min_length=1, max_length=200)
    family_id: str | None = Field(default=None, max_length=64)
    grade: str | None = Field(default=None, max_length=16)
    description: str | None = Field(default=None, max_length=8000)
    required_skills: list[str] | None = Field(default=None, max_length=50)
    preferred_skills: list[str] | None = Field(default=None, max_length=50)
    active: bool | None = None
    job_level: str | None = Field(default=None, max_length=32)
    experience_min_years: int | None = Field(default=None, ge=0, le=60)
    experience_max_years: int | None = Field(default=None, ge=0, le=60)
    education: str | None = Field(default=None, max_length=200)
    responsibilities: list[str] | None = Field(default=None, max_length=30)
    effective_from: date | None = None
    reason: str | None = Field(default=None, max_length=500)


class JobProfileOut(ORM):
    id: str
    code: str
    title: str
    family_id: str | None
    grade: str | None
    description: str | None
    required_skills: list[Any]
    preferred_skills: list[Any]
    active: bool
    job_level: str | None = None
    experience_min_years: int | None = None
    experience_max_years: int | None = None
    education: str | None = None
    responsibilities: list[Any] | None = None
    effective_from: date | None = None
    effective_to: date | None = None


class PositionIn(BaseModel):
    code: str | None = Field(default=None, max_length=64, pattern=CODE_PATTERN)  # None = generated
    profile_id: str = Field(min_length=1, max_length=64)
    department_id: str | None = Field(default=None, max_length=64)
    location_id: str | None = Field(default=None, max_length=64)
    country_code: str = Field(pattern=r"^[A-Z]{2}$")
    grade: str | None = Field(default=None, max_length=16)  # None = the profile's grade
    manager_id: str | None = Field(default=None, max_length=64)
    headcount: int = Field(default=1, ge=1, le=10000)
    filled: int = Field(default=0, ge=0, le=10000)
    status: Literal["open", "frozen"] = "open"
    effective_from: date | None = None


class PositionUpdate(BaseModel):
    profile_id: str | None = Field(default=None, max_length=64)
    department_id: str | None = Field(default=None, max_length=64)
    location_id: str | None = Field(default=None, max_length=64)
    grade: str | None = Field(default=None, max_length=16)
    manager_id: str | None = Field(default=None, max_length=64)
    headcount: int | None = Field(default=None, ge=1, le=10000)
    filled: int | None = Field(default=None, ge=0, le=10000)
    status: Literal["open", "frozen"] | None = None
    active: bool | None = None
    effective_from: date | None = None
    reason: str | None = Field(default=None, max_length=500)


class PositionOut(ORM):
    id: str
    code: str
    profile_id: str
    title: str | None = None
    department_id: str | None
    location_id: str | None
    country_code: str
    grade: str | None
    manager_id: str | None
    headcount: int
    filled: int
    status: str
    active: bool
    effective_from: date | None = None
    effective_to: date | None = None
