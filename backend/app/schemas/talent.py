"""Request/response shapes for recruiting, onboarding, performance and learning (re-exported by app.schemas)."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class _ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


PipelineStage = Literal[
    "Applied", "Screening", "Shortlisted", "Interview", "Assessment", "Final Review", "Offer", "Hired", "Rejected", "Withdrawn"
]
EMAIL_PATTERN = r"^[^\s@]+@[^\s@]+\.[^\s@]+$"


# ---------- recruiting ----------
class RequisitionIn(BaseModel):
    title: str = Field(min_length=2, max_length=200)
    department: str = Field(min_length=1, max_length=200)
    country_code: str = Field(pattern=r"^[A-Za-z]{2}$")
    location: str = Field(min_length=1, max_length=200)
    openings: int = Field(ge=1, le=50)
    requirements: list[str] = Field(default_factory=list, max_length=20)
    description: str | None = Field(default=None, max_length=5000)
    budget: float | None = Field(default=None, ge=0, le=1e10, description="Annual budget for the role, in the country currency")
    reason: Literal["new_role", "replacement"] | None = None
    justification: str | None = Field(default=None, max_length=2000)
    hiring_manager_id: str | None = Field(default=None, description="A recruiter or HR raising it for a manager names them here")


class PostingOut(_ORM):
    id: str
    requisition_id: str
    title: str
    description: str
    location: str
    employment_type: str
    closing_date: date
    on_careers_site: bool
    status: str
    published_by: str | None
    published_on: date
    closed_on: date | None
    applications: int = 0


class PostingIn(BaseModel):
    title: str = Field(min_length=2, max_length=200)
    description: str = Field(min_length=20, max_length=10_000)
    location: str = Field(min_length=1, max_length=200)
    employment_type: str = Field(default="Full-time", min_length=1, max_length=32)
    closing_date: date
    on_careers_site: bool = True


class PublicPostingOut(BaseModel):
    """What the public careers page shows: no people, budget or pipeline details."""

    id: str
    title: str
    department: str
    location: str
    country_name: str
    employment_type: str
    description: str
    closing_date: date
    openings: int


class PublicApplyIn(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    email: str = Field(pattern=EMAIL_PATTERN, max_length=255)
    phone: str | None = Field(default=None, max_length=64)
    cover_note: str | None = Field(default=None, max_length=3000)
    cv_filename: str = Field(min_length=5, max_length=200)
    cv_base64: str = Field(min_length=4, max_length=7_200_000)  # 5 MB file
    website: str | None = Field(default=None, max_length=200, description="Left empty by people (spam trap)")


class PublicApplyOut(BaseModel):
    reference: str
    title: str


class InternalApplyIn(BaseModel):
    cover_note: str | None = Field(default=None, max_length=3000)


class RequisitionOut(_ORM):
    id: str
    title: str
    department: str
    country_code: str
    location: str
    openings: int
    hiring_manager_id: str
    hiring_manager_name: str | None = None
    recruiter_id: str | None
    recruiter_name: str | None = None
    recruiter_assigned_on: date | None
    status: str
    approval_id: str | None
    requirements: list[str]
    description: str | None
    raised_on: date
    decided_on: date | None
    candidate_count: int = 0
    budget: float | None = None
    budget_currency: str | None = None
    reason: str | None = None
    justification: str | None = None
    raised_by: str | None = None
    posting: PostingOut | None = None
    stage_counts: dict[str, int] = {}


class RequisitionDecisionIn(BaseModel):
    decision: Literal["approve", "reject"]
    note: str | None = Field(default=None, max_length=1000)
    recruiter_id: str | None = Field(default=None, description="Recruiter to assign when this approval completes")


class NoteIn(BaseModel):
    note: str = Field(min_length=5, max_length=1000)


class RecruiterIn(BaseModel):
    recruiter_id: str


class CandidateIn(BaseModel):
    requisition_id: str
    name: str = Field(min_length=2, max_length=200)
    email: str = Field(pattern=EMAIL_PATTERN, max_length=255)
    phone: str | None = Field(default=None, max_length=64)
    source: str = Field(min_length=1, max_length=64)
    experience_years: float = Field(default=0, ge=0, le=60)
    skills: list[str] = Field(default_factory=list, max_length=50)
    cv_note: str | None = Field(default=None, max_length=5000)
    applied_on: date


class CandidatePatch(BaseModel):
    phone: str | None = Field(default=None, max_length=64)
    source: str | None = Field(default=None, min_length=1, max_length=64)
    experience_years: float | None = Field(default=None, ge=0, le=60)
    skills: list[str] | None = Field(default=None, max_length=50)
    cv_note: str | None = Field(default=None, max_length=5000)


class StageStepOut(_ORM):
    stage: str
    entered_at: datetime
    by_id: str | None
    note: str | None


class CandidateOut(_ORM):
    id: str
    requisition_id: str
    name: str
    email: str
    phone: str | None
    source: str
    experience_years: float
    skills: list[str]
    cv_note: str | None
    cv_filename: str | None
    has_cv: bool = False
    applied_on: date
    stage: str
    history: list[StageStepOut] = []
    posting_id: str | None = None
    employee_id: str | None = None
    cover_note: str | None = None
    match_score: int | None = None


class ScreenIn(BaseModel):
    decision: Literal["shortlist", "reject"]
    reason: str | None = Field(default=None, max_length=1000)


class StageMoveIn(BaseModel):
    stage: PipelineStage
    note: str | None = Field(default=None, max_length=1000)


class InterviewIn(BaseModel):
    scheduled_at: datetime
    kind: str = Field(default="Interview", min_length=1, max_length=64)
    panel_ids: list[str] = Field(min_length=1, max_length=8)
    duration_minutes: int = Field(default=60, ge=15, le=480)


class InterviewOut(_ORM):
    id: str
    candidate_id: str
    scheduled_at: datetime
    duration_minutes: int
    kind: str
    panel_ids: list[str]
    feedback_status: str
    score: int | None
    feedback: str | None
    feedback_by: str | None
    feedback_at: datetime | None
    ratings: dict[str, int] | None = None
    recommendation: str | None = None


SCORECARD_CRITERIA = ("Skills", "Experience", "Problem solving", "Communication", "Team fit")
Recommendation = Literal["strong_yes", "yes", "no", "strong_no"]


class FeedbackIn(BaseModel):
    """The interviewer's scorecard: a 1-5 rating per criterion (score = their average) or one overall score."""

    score: int | None = Field(default=None, ge=1, le=5)
    ratings: dict[str, int] | None = Field(default=None, description=f"1-5 for each of {', '.join(SCORECARD_CRITERIA)}")
    recommendation: Recommendation | None = None
    notes: str = Field(min_length=1, max_length=5000)


class OfferIn(BaseModel):
    candidate_id: str
    grade: str = Field(min_length=1, max_length=16)
    base_salary: float = Field(gt=0, le=1e10)
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    start_date: date
    package_note: str | None = Field(default=None, max_length=2000)


class OfferOut(_ORM):
    id: str
    candidate_id: str
    candidate_name: str | None = None
    requisition_id: str
    grade: str
    base_salary: float
    currency: str
    start_date: date
    package_note: str | None
    status: str
    approvals: list[dict[str, Any]]
    created_by: str
    sent_on: date | None
    response_note: str | None
    response_recorded_by: str | None = None
    responded_on: date | None
    letter: dict[str, Any] | None = None
    response_token: str | None = None  # recruiter / HR only: the candidate's answer link
    responded_via: str | None = None


class PublicOfferOut(BaseModel):
    """The candidate's offer page (no sign-in): what they are offered and the letter."""

    candidate_name: str
    title: str
    department: str
    location: str
    grade: str
    base_salary: float
    currency: str
    start_date: date
    status: Literal["sent", "accepted", "declined", "withdrawn"]
    responded_on: date | None
    letter: dict[str, Any] | None


class PublicOfferAnswerIn(BaseModel):
    decision: Literal["accept", "decline"]
    note: str | None = Field(default=None, max_length=1000)


class OfferStatusIn(BaseModel):
    status: Literal["sent", "accepted", "declined", "withdrawn"]
    note: str | None = Field(default=None, max_length=1000)


class CvParseIn(BaseModel):
    text: str = Field(min_length=1, max_length=100_000)


class CvParseOut(BaseModel):
    name: str
    email: str
    phone: str
    experience_years: int | None
    current_title: str
    current_company: str
    education: list[str]
    library_skills: list[str]
    other_skills: list[str]


class MatchOut(BaseModel):
    candidate_id: str
    requisition_id: str
    score: int
    band: Literal["Strong", "Partial", "Weak"]
    matched: list[str]
    missing: list[str]
    preferred_matched: list[str]
    years: float
    years_needed: float
    summary: str
    questions: list[str]
    required: list[str]
    preferred: list[str]
    source: str


class ActivityOut(BaseModel):
    at: datetime
    action: str
    entity: str
    entity_id: str | None
    subject_id: str | None
    details: dict[str, Any] | None


# ---------- onboarding ----------
class OnboardingTaskOut(_ORM):
    id: str
    joiner_id: str
    key: str
    title: str
    owner_role: str
    category: str
    due_date: date
    depends_on: list[str]
    status: str
    done_at: datetime | None
    done_by: str | None
    override_note: str | None


class JoinerOut(_ORM):
    id: str
    employee_id: str
    candidate_id: str | None
    requisition_id: str | None
    name: str
    job_title: str
    country_code: str
    manager_id: str | None
    start_date: date
    policy_ack: bool
    policy_ack_at: datetime | None
    policy_ack_by: str | None
    policy_ack_by_hr: bool
    status: str
    completed_at: datetime | None
    progress_pct: int = 0
    employment_status: str | None = None
    preboarding: dict[str, Any] | None = None  # pre-boarding form (personal, emergency_contact, equipment, it_request)
    preboarding_at: datetime | None = None
    tasks: list[OnboardingTaskOut] = []


class TaskUpdateIn(BaseModel):
    status: Literal["pending", "in_progress", "done"]
    reason: str | None = Field(default=None, max_length=1000)


# ---------- performance ----------
class CycleIn(BaseModel):
    name: str = Field(min_length=3, max_length=200)
    start_date: date
    end_date: date
    self_review_due: date
    manager_review_due: date


class CycleOut(_ORM):
    id: str
    name: str
    status: str
    start_date: date
    end_date: date
    self_review_due: date
    manager_review_due: date
    created_by: str | None


class GoalIn(BaseModel):
    employee_id: str | None = None
    cycle_id: str
    type: Literal["goal", "okr", "kpi"] = "goal"
    title: str = Field(min_length=1, max_length=200)
    target: str = Field(min_length=1, max_length=200)
    period: str | None = Field(default=None, max_length=64)
    weight: int = Field(ge=1, le=100)


class GoalProgressIn(BaseModel):
    progress: int = Field(ge=0, le=100)


class GoalOut(_ORM):
    id: str
    employee_id: str
    cycle_id: str
    type: str
    title: str
    target: str
    period: str | None
    weight: int
    progress: int


class ActionItem(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    done: bool = False


class OneOnOneIn(BaseModel):
    employee_id: str
    meeting_date: date
    notes: str = Field(default="", max_length=10_000)
    action_items: list[ActionItem] = Field(default_factory=list, max_length=30)


class OneOnOneOut(_ORM):
    id: str
    employee_id: str
    manager_id: str | None
    meeting_date: date
    notes: str
    action_items: list[dict[str, Any]]
    created_by: str | None
    created_at: datetime


class AssessmentIn(BaseModel):
    text: str = Field(max_length=10_000)
    submit: bool = False


class RatingIn(BaseModel):
    rating: Literal["Needs improvement", "Solid", "Strong", "Exceptional"] | None


class NominateIn(BaseModel):
    reviewer_id: str


class Response360In(BaseModel):
    rating: int = Field(ge=1, le=5)
    comment: str = Field(min_length=5, max_length=5000)


class Reviewer360Out(_ORM):
    reviewer_id: str
    reviewer_name: str | None = None
    nominated_by: str
    nominated_at: datetime
    responded: bool = False
    responded_at: datetime | None = None
    rating: int | None = None  # managers and HR only
    comment: str | None = None  # managers and HR only


class DevActionIn(BaseModel):
    title: str = Field(min_length=3, max_length=200)
    due: date | None = None


class DevActionPatch(BaseModel):
    title: str | None = Field(default=None, min_length=3, max_length=200)
    due: date | None = None
    status: Literal["not_started", "in_progress", "done"] | None = None


class DevActionOut(_ORM):
    id: str
    review_id: str
    title: str
    due: date | None
    status: str


class ReviewOut(BaseModel):
    id: str
    cycle_id: str
    employee_id: str
    employee_name: str | None
    self_status: str
    self_text: str | None
    manager_status: str
    manager_text: str | None
    rating: str | None
    released: bool
    released_at: datetime | None
    feedback_360_status: str
    reviewers: list[Reviewer360Out]
    dev_actions: list[DevActionOut]


class Pending360Out(BaseModel):
    review_id: str
    cycle_id: str
    employee_id: str
    employee_name: str | None


# ---------- learning ----------
class CourseIn(BaseModel):
    title: str = Field(min_length=3, max_length=200)
    provider: str = Field(min_length=1, max_length=200)
    url: str | None = Field(default=None, max_length=500, pattern=r"^https?://")
    category: str | None = Field(default=None, max_length=64)
    duration_hours: float = Field(gt=0, le=1000)
    mandatory: bool = False
    audience: Literal["All", "Engineering", "Managers", "Hiring"] = "All"
    skills: list[str] = Field(default_factory=list, max_length=20)
    active: bool = True


class CourseOut(_ORM):
    id: str
    title: str
    provider: str
    url: str | None
    category: str | None
    duration_hours: float
    mandatory: bool
    audience: str
    skills: list[str]
    active: bool


class EnrollIn(BaseModel):
    course_id: str
    employee_id: str | None = None
    due: date | None = None


class ProgressIn(BaseModel):
    progress: int = Field(ge=0, le=100)


class CompleteIn(BaseModel):
    score: int | None = Field(default=None, ge=0, le=100)


class EnrollmentOut(_ORM):
    id: str
    course_id: str
    course_title: str | None = None
    employee_id: str
    status: str
    progress: int
    due: date | None
    completed_on: date | None
    score: int | None


class CertificationIn(BaseModel):
    employee_id: str | None = None
    name: str = Field(min_length=2, max_length=200)
    issuer: str | None = Field(default=None, max_length=200)
    issued_on: date
    expires_on: date | None = None
    credential_id: str | None = Field(default=None, max_length=100)


class CertificationOut(_ORM):
    id: str
    employee_id: str
    employee_name: str | None = None
    name: str
    issuer: str | None
    issued_on: date
    expires_on: date | None
    credential_id: str | None
    days_to_expiry: int | None = None


class SkillIn(BaseModel):
    skill: str = Field(min_length=1, max_length=100)
    level: int = Field(ge=1, le=5)
    target_level: int | None = Field(default=None, ge=1, le=5)
    years: float | None = Field(default=None, ge=0, le=50)
    last_used: str | None = Field(default=None, pattern=r"^\d{4}-(0[1-9]|1[0-2])$")
    evidence_url: str | None = Field(default=None, max_length=500, pattern=r"^https?://\S+$")


class SkillOut(_ORM):
    id: int
    employee_id: str
    skill: str
    level: int
    target_level: int | None
    years: float | None = None
    last_used: str | None = None
    evidence_url: str | None = None


__all__ = [
    name for name, value in list(globals().items())
    if isinstance(value, type) and issubclass(value, BaseModel) and value.__module__ == __name__ and not name.startswith("_")
]
