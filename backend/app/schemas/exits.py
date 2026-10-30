from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field

ExitType = Literal["resignation", "termination", "retirement", "end_of_contract"]


class ExitIn(BaseModel):
    exit_type: ExitType = "resignation"
    employee_id: str | None = Field(default=None, description="Omit (or yourself) to raise your own resignation / retirement")
    requested_last_day: date
    reason: str = Field(min_length=1, max_length=500)
    note: str | None = Field(default=None, max_length=1000)
    early_release: bool = False
    early_release_reason: str | None = Field(default=None, max_length=1000)
    handover_plan: str | None = Field(default=None, max_length=2000)
    handover_to: str | None = Field(default=None, max_length=200)


class RetentionIn(BaseModel):
    note: str = Field(min_length=1, max_length=1000)
    meet_on: date | None = None


class RetentionOut(BaseModel):
    by_id: str
    by: str
    note: str
    on: str
    meet_on: str | None = None


class ExitDecisionIn(BaseModel):
    decision: Literal["approve", "reject"]
    note: str | None = Field(default=None, max_length=2000)
    approve_early_release: bool | None = Field(default=None, description="False = keep the standard notice date")


class ClearanceIn(BaseModel):
    done: bool


class InterviewIn(BaseModel):
    rating: int = Field(ge=1, le=5)
    reasons: list[str] = Field(min_length=1, max_length=8)
    would_return: Literal["Yes", "No", "Maybe"] = "Maybe"
    comments: str = Field(default="", max_length=2000)


class InterviewOut(BaseModel):
    rating: int
    reasons: list[str]
    would_return: str
    comments: str
    submitted_on: str


class SettlementIn(BaseModel):
    status: Literal["Pending", "In progress", "Paid"]


class SettlementOut(BaseModel):
    status: str
    unused_leave_days: float
    frozen: bool = False  # True once the exit completed (or it was paid): the days no longer change
    last_working_day: date | None = None
    updated_by: str | None = None
    updated_on: str | None = None


class ClearanceItemOut(BaseModel):
    key: str
    label: str
    owner: str
    done: bool
    done_by: str | None = None
    done_on: str | None = None
    can_tick: bool = False


class ExitStepOut(BaseModel):
    label: str
    approver_ids: list[str]
    decision: str | None = None  # approve | reject
    by: str | None = None
    note: str | None = None
    at: datetime | None = None


class ExitCaseOut(BaseModel):
    id: str
    employee_id: str
    employee_name: str | None = None
    country_code: str | None = None
    exit_type: str
    submitted_on: date
    requested_last_day: date
    standard_last_day: date
    approved_last_working_day: date | None
    notice_days: int
    early_release: bool
    early_release_approved: bool | None
    reason: str
    note: str | None
    status: str
    raised_by: str
    raised_by_name: str | None = None
    approval_instance_id: str | None
    steps: list[ExitStepOut] = []
    can_decide: bool = False
    can_withdraw: bool = False
    clearance: list[ClearanceItemOut] = []
    clearance_pending: bool = False  # completed (sign-in closed on the last day) with checklist items still open
    interview_submitted: bool = False
    interview: InterviewOut | None = None  # HR only
    settlement: SettlementOut | None = None  # the leaver and HR only
    completed_at: datetime | None = None
    created_at: datetime
    early_release_reason: str | None = None
    handover_plan: str | None = None
    handover_to: str | None = None
    retention: list[RetentionOut] = []
    can_add_retention: bool = False


class NoticeOut(BaseModel):
    notice_days: int
    today: date
    earliest_last_day: date
    has_manager: bool
