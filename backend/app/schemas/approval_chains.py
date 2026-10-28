"""Approval delegation and the workflow list (admin editor)."""

from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field

DELEGATION_TYPES = ("leave", "expense", "timesheet", "attendance_correction", "other")


class DelegationIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    delegate_id: str = Field(min_length=1, max_length=64)
    starts_on: date = Field(alias="from")
    ends_on: date = Field(alias="to")
    types: list[str] | None = Field(default=None, max_length=10)  # None = all
    note: str | None = Field(default=None, max_length=500)


class DelegationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True, serialize_by_alias=True)

    id: str
    delegator_id: str
    delegator_name: str | None = None
    delegate_id: str
    delegate_name: str | None = None
    starts_on: date = Field(serialization_alias="from")
    ends_on: date = Field(serialization_alias="to")
    types: list[str] | None
    note: str | None
    active: bool
    created_at: datetime
    updated_at: datetime


class WorkflowTypeOut(BaseModel):
    """One request type in the admin editor: its current steps (version 0 = the default, never saved)."""

    type: str
    label: str
    version: int
    steps: list[dict]
    default_steps: list[dict]
    created_by: str | None = None
    created_at: datetime | None = None
