"""Skills library, careers (/career), Employee 360 AI summary (/ai/employee-summary) and recruiting AI helpers."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class _CareerORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ---------- skills library ----------
class CareerSkillIn(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    category: Literal["technical", "behavioural"]
    area: str | None = Field(default=None, max_length=64)
    description: str = Field(default="", max_length=1000)
    related_profile_ids: list[str] = Field(default_factory=list, max_length=50)
    related_course_ids: list[str] = Field(default_factory=list, max_length=50)
    certifications: list[str] = Field(default_factory=list, max_length=20)
    active: bool = True


class CareerSkillOut(_CareerORM):
    id: str
    name: str
    category: str
    area: str | None
    description: str
    related_profile_ids: list[str]
    related_course_ids: list[str]
    certifications: list[str]
    active: bool


class CareerPathOut(_CareerORM):
    id: str
    title: str
    track: str
    function: str
    from_profile_id: str | None
    to_profile_id: str | None
    required_skills: dict[str, str]
    active: bool


# ---------- career profile ----------
class CareerProfileIn(BaseModel):
    target_role_ids: list[str] = Field(default_factory=list, max_length=10)
    interests: list[str] = Field(default_factory=list, max_length=10)
    timeframe: str = Field(max_length=32)
    open_to_relocation: bool = False
    mentor_id: str | None = Field(default=None, max_length=64)
    note: str = Field(default="", max_length=2000)


class CareerProfileOut(BaseModel):
    employee_id: str
    employee_name: str | None = None
    current_role: str | None
    target_role_ids: list[str]
    target_roles: list[str] = []
    interests: list[str]
    timeframe: str
    open_to_relocation: bool
    mentor_id: str | None
    mentor_name: str | None = None
    note: str
    saved: bool  # False = nothing shared yet (defaults shown)
    updated_at: datetime | None = None


# ---------- role matches ----------
class CareerCourseOut(BaseModel):
    id: str
    title: str
    duration_hours: float


class CareerGapOut(BaseModel):
    skill_id: str
    name: str
    have: str
    need: str
    levels: int
    courses: list[CareerCourseOut]


class CareerTimelineStepOut(BaseModel):
    from_week: int
    to_week: int
    skill: str | None
    text: str


class CareerRoleMatchOut(BaseModel):
    key: str
    title: str
    source: Literal["Career path", "Open job"]
    function: str
    target_role_id: str | None
    location: str | None
    posting_id: str | None
    match: int
    score: int
    reasons: list[str]
    gaps: list[CareerGapOut]
    recommended_courses: list[CareerCourseOut]
    timeline: list[CareerTimelineStepOut]
    total_weeks: int


class CareerMatchesOut(BaseModel):
    employee_id: str
    skills_saved: bool  # False = matched on the starting skills list
    matches: list[CareerRoleMatchOut]


# ---------- Employee 360 AI summary ----------
class EmployeeSummaryIn(BaseModel):
    employee_id: str = Field(min_length=1, max_length=64)


class EmployeeSummaryOut(BaseModel):
    employee_id: str
    summary: str | None  # None = use the portal's built-in summary
    used_ai: bool
    model: str | None
    sections: list[str]  # what the summary was built from


# ---------- recruiting AI helpers ----------
class RecruitCompareIn(BaseModel):
    candidate_ids: list[str] = Field(min_length=2, max_length=4)
    requisition_id: str = Field(min_length=1, max_length=32)


class RecruitCompareRowOut(BaseModel):
    candidate_id: str
    name: str
    stage: str
    experience_years: float
    matched_skills: list[str]
    missing_skills: list[str]
    match_score: int
    interview_scores: list[int]
    average_score: float | None
    interviews_done: int
    interviews_pending: int


class RecruitCompareOut(BaseModel):
    requisition_id: str
    requisition_title: str
    rows: list[RecruitCompareRowOut]
    summary: str
    used_ai: bool
    model: str | None
    note: str


class RecruitFeedbackSummaryOut(BaseModel):
    candidate_id: str
    summary: str
    used_ai: bool
    model: str | None
    interviews_done: int
    interviews_pending: int
    average_score: float | None
    note: str
