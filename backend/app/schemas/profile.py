"""Profile edits, profile correction requests and AI action audit (app/routers/profile.py)."""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

WorkArrangementValue = Literal["Office", "Hybrid", "Remote"]
CorrectionFieldValue = Literal[
    "full_name", "middle_name", "date_of_birth", "nationality", "job_title", "department", "manager_id", "work_arrangement",
]


class ProfileEducationItem(BaseModel):
    degree: str = Field(min_length=1, max_length=120)
    institution: str = Field(min_length=1, max_length=160)
    year: int = Field(ge=1950, le=2100)


class ProfileExperienceItem(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    employer: str = Field(min_length=1, max_length=160)
    title: str = Field(min_length=1, max_length=120)
    from_: str = Field(alias="from", pattern=r"^\d{4}-\d{2}(-\d{2})?$")
    to: str = Field(pattern=r"^\d{4}-\d{2}(-\d{2})?$")


class SelfProfileUpdateIn(BaseModel):
    """PATCH /people/me. Only the fields sent are changed; send null or "" to clear one.

    Changing mobile or personal_email needs otp_code from POST /people/me/otp (one of the two per request).
    """

    model_config = ConfigDict(extra="forbid")

    preferred_name: str | None = Field(default=None, max_length=40)
    mobile: str | None = Field(default=None, max_length=32)
    personal_email: str | None = Field(default=None, max_length=255)
    address_line: str | None = Field(default=None, max_length=300)
    address_city: str | None = Field(default=None, max_length=100)
    address_postcode: str | None = Field(default=None, max_length=20)
    address_country: str | None = Field(default=None, max_length=100)
    emergency_name: str | None = Field(default=None, max_length=200)
    emergency_relationship: str | None = Field(default=None, max_length=64)
    emergency_phone: str | None = Field(default=None, max_length=32)
    preferred_language: str | None = Field(default=None, max_length=64)
    languages: list[str] | None = Field(default=None, max_length=12)
    education: list[ProfileEducationItem] | None = Field(default=None, max_length=20)
    experience: list[ProfileExperienceItem] | None = Field(default=None, max_length=30)
    career_goals: str | None = Field(default=None, max_length=1000)
    otp_code: str | None = Field(default=None, max_length=12)


class ProfileOtpIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    field: Literal["mobile", "personal_email"]
    new_value: str = Field(min_length=1, max_length=255)


class ProfileOtpOut(BaseModel):
    field: str
    sent_to: str
    expires_at: datetime
    dev_code: str | None = None


class HrProfileUpdateIn(SelfProfileUpdateIn):
    """PATCH /people/{id} for HR / admin in scope: the employee fields plus the HR-owned ones."""

    first_name: str | None = Field(default=None, max_length=100)
    middle_name: str | None = Field(default=None, max_length=100)
    last_name: str | None = Field(default=None, max_length=100)
    nationality: str | None = Field(default=None, max_length=64)
    work_arrangement: WorkArrangementValue | None = None
    date_of_birth: date | None = None
    gender: str | None = Field(default=None, max_length=32)
    company: str | None = Field(default=None, max_length=100)


class ProfileCorrectionIn(BaseModel):
    field: CorrectionFieldValue
    requested_value: str = Field(default="", max_length=200)  # for manager_id: the manager's employee id
    reason: str = Field(min_length=1, max_length=300)


class ProfileCorrectionDecisionIn(BaseModel):
    decision: Literal["approve", "reject"]
    note: str | None = Field(default=None, max_length=300)


class ProfileCorrectionOut(BaseModel):
    id: str
    employee_id: str
    employee_name: str | None
    field: str
    current_value: str | None  # date of birth is masked
    requested_value: str | None  # date of birth is masked unless the caller may reveal it
    requested_label: str | None = None  # manager corrections: the manager's name
    reason: str
    status: str
    requested_by: str
    decided_by: str | None
    decided_at: datetime | None
    decision_note: str | None
    created_at: datetime
    can_decide: bool = False


class AiActionAuditIn(BaseModel):
    """A Copilot action the user was shown, confirmed or cancelled. The summary must not carry personal values."""

    action: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9_.\-]+$")
    status: Literal["proposed", "confirmed", "cancelled"]
    summary: str = Field(default="", max_length=200)


class AiActionAuditOut(BaseModel):
    id: int
    action: str
    status: str
