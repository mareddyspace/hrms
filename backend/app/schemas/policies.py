"""Policies HR writes, versions and publishes; acknowledgement tracking (app/routers/policies.py)."""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class PolicySectionIn(BaseModel):
    heading: str = Field(min_length=1, max_length=200)
    rules: list[str] = Field(default_factory=list, max_length=40)


class PolicyIn(BaseModel):
    id: str | None = Field(default=None, max_length=64, pattern=r"^[a-z0-9][a-z0-9-]*$")  # a built-in id replaces it
    title: str = Field(min_length=3, max_length=200)
    category: str = Field(min_length=2, max_length=64)
    audience_type: Literal["all", "country", "department"] = "all"
    audience_values: list[str] = Field(default_factory=list, max_length=50)
    requires_ack: bool = True
    base_version: int = Field(default=0, ge=0, le=999)  # editing a built-in at v2 -> the first version here is v3
    summary: str = Field(default="", max_length=4000)
    sections: list[PolicySectionIn] = Field(default_factory=list, max_length=30)
    change_summary: str = Field(default="", max_length=1000)
    effective_date: date | None = None


class PolicyVersionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    version: int
    status: str
    summary: str
    sections: list[dict]
    change_summary: str
    effective_date: date | None
    published_at: datetime | None
    published_by: str | None = None
    published_by_name: str | None = None


class PolicyMyAckOut(BaseModel):
    version: str
    acknowledged_at: datetime
    comment: str | None = None


class PolicyOut(BaseModel):
    id: str
    title: str
    category: str
    status: str
    audience_type: str
    audience_values: list[str]
    requires_ack: bool
    current_version: int
    updated_at: datetime
    targets_me: bool
    my_ack: PolicyMyAckOut | None = None
    versions: list[PolicyVersionOut] = []  # newest first; employees see published ones only


class PolicyAckBody(BaseModel):
    comment: str | None = Field(default=None, max_length=1000)


class PolicyPersonOut(BaseModel):
    employee_id: str
    name: str
    department: str | None = None
    country_code: str | None = None
    acknowledged_at: datetime | None = None
    comment: str | None = None


class PolicyTrackingOut(BaseModel):
    policy_id: str
    version: int
    targeted: int
    acknowledged: int
    percent: int
    pending: list[PolicyPersonOut]
    done: list[PolicyPersonOut]


class PolicyRemindOut(BaseModel):
    reminded: int


class PolicyPublishOut(BaseModel):
    policy: PolicyOut
    notified: int


class PolicyAudienceOptionsOut(BaseModel):
    countries: list[dict[str, str]]
    departments: list[str]
