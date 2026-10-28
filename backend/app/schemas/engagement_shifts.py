"""Shapes for engagement surveys, recognition and shift rosters. Class names are unique across app.schemas."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


# ---------- surveys ----------
class SurveyQuestionIn(BaseModel):
    kind: Literal["rating", "enps", "text"]
    prompt: str = Field(min_length=1, max_length=200)


class SurveyCreateIn(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    kind: Literal["pulse", "engagement", "onboarding", "exit"] = "pulse"
    questions: list[SurveyQuestionIn] = Field(min_length=1, max_length=20)
    anonymous: bool = True
    audience_type: Literal["all", "department", "country"] = "all"
    audience_value: str | None = Field(default=None, max_length=200)
    open_date: date
    close_date: date
    publish: bool = False


class SurveyAnswerIn(BaseModel):
    answers: dict[str, int | str]


class SurveyOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    title: str
    kind: str
    questions: list[dict[str, Any]]
    anonymous: bool
    audience_type: str
    audience_value: str | None
    open_date: date
    close_date: date
    published: bool
    closed_at: datetime | None
    phase: str = "Draft"
    responded: bool = False


class SurveyBucketOut(BaseModel):
    name: str
    responses: int
    suppressed: bool
    engagement: int | None = None
    enps: int | None = None


class SurveyResultsOut(BaseModel):
    survey_id: str
    phase: str
    responses: int
    audience: int
    participation_pct: float
    threshold: int
    suppressed: bool  # fewer responses than the threshold: no answers are shown
    engagement: int | None = None
    enps: int | None = None
    questions: list[dict[str, Any]] = []
    departments: list[SurveyBucketOut] = []
    countries: list[SurveyBucketOut] = []


class SurveyTrendPointOut(BaseModel):
    survey_id: str
    title: str
    kind: str
    closed_on: date
    responses: int
    participation_pct: float
    engagement: int | None
    enps: int | None


# ---------- recognition ----------
class KudosIn(BaseModel):
    to_id: str = Field(min_length=1, max_length=64)
    value: Literal["Teamwork", "Ownership", "Customer first", "Innovation", "Mentorship"]
    message: str = Field(min_length=10, max_length=500)
    points: int = Field(default=0, ge=0)


class KudosOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    from_id: str
    from_name: str | None = None
    to_id: str
    to_name: str | None = None
    value: str
    message: str
    points: int
    created_at: datetime
    likes: int = 0
    liked_by_me: bool = False


class PointsBalanceOut(BaseModel):
    employee_id: str
    received: int
    spent: int
    balance: int
    given_this_month: int
    allowance_left: int
    monthly_allowance: int
    max_per_kudos: int


class RewardItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str
    description: str
    points: int
    needs_date: bool
    active: bool


class RedemptionIn(BaseModel):
    reward_id: str = Field(min_length=1, max_length=64)
    note: str = Field(default="", max_length=300)


class RedemptionDecisionIn(BaseModel):
    decision: Literal["fulfil", "decline"]
    note: str | None = Field(default=None, max_length=1000)


class RedemptionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    employee_id: str
    employee_name: str | None = None
    reward_id: str
    reward_name: str | None = None
    points: int
    note: str
    status: str
    decided_by: str | None
    decided_at: datetime | None
    decision_note: str | None
    created_at: datetime


# ---------- shifts ----------
class ShiftTypeIn(BaseModel):
    id: str | None = Field(default=None, pattern=r"^sh-[a-z0-9-]{2,40}$")
    name: str = Field(min_length=1, max_length=100)
    start: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    end: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    weekend_only: bool = False
    active: bool = True


class ShiftTypeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str
    start: str
    end: str
    weekend_only: bool
    active: bool


class RosterAssignIn(BaseModel):
    employee_id: str = Field(min_length=1, max_length=64)
    work_date: date
    shift_id: str | None = None  # None clears the day


class RosterShiftOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    employee_id: str
    work_date: date
    shift_id: str
    manager_id: str


class CoverageSlotOut(BaseModel):
    date: date
    shift_id: str
    shift_name: str
    required: int
    assigned: int
    on_leave: list[str]
    status: str


class RosterWeekOut(BaseModel):
    manager_id: str
    week_start: date
    status: str
    published_at: datetime | None = None
    published_with_gaps: bool = False
    shifts: list[RosterShiftOut]
    coverage: list[CoverageSlotOut]
    gaps: list[CoverageSlotOut]


class RosterPublishIn(BaseModel):
    week_start: date
    allow_gaps: bool = False


class ShiftSwapIn(BaseModel):
    teammate_id: str = Field(min_length=1, max_length=64)
    work_date: date
    reason: str = Field(min_length=3, max_length=1000)


class ShiftSwapRespondIn(BaseModel):
    accept: bool


class ShiftSwapDecisionIn(BaseModel):
    decision: Literal["approve", "reject"]
    note: str | None = Field(default=None, max_length=1000)
    allow_gaps: bool = False


class ShiftSwapOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    work_date: date
    requester_id: str
    teammate_id: str
    requester_shift_id: str
    teammate_shift_id: str
    reason: str
    status: str
    decided_by: str | None
    decided_at: datetime | None
    decision_note: str | None
    created_at: datetime


class CoverageMinimumIn(BaseModel):
    scope: str = Field(min_length=1, max_length=64)  # "*" = company, else a manager id
    shift_id: str = Field(min_length=1, max_length=64)
    weekday: int = Field(ge=0, le=6)  # 0 = Sunday
    minimum: int = Field(ge=0, le=20)


class CoverageMinimumOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    scope: str
    shift_id: str
    weekday: int
    minimum: int
