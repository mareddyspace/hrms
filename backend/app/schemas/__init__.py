"""API request/response shapes. Pay fields are never part of v1 responses."""

from __future__ import annotations

import datetime as dt
from datetime import date, datetime
from typing import Annotated, Generic, Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.services.pii import mask_dob, mask_email, mask_phone, mask_text

T = TypeVar("T")


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    page: int
    page_size: int


# ---------- auth ----------
class LoginIn(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=1, max_length=256)


class RefreshIn(BaseModel):
    refresh_token: str


class ChangePasswordIn(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=1, max_length=256)


class TokenOut(BaseModel):
    access_token: str
    refresh_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int
    # On sign-in only: when this account signed in before now (None on a first sign-in and on refresh).
    last_login_at: datetime | None = None
    # True when the account must set a new password before using anything else.
    must_change_password: bool = False


class MeOut(BaseModel):
    account_id: str
    email: str
    role: str
    employee_id: str | None
    full_name: str | None
    country_code: str | None
    last_login_at: datetime | None
    must_change_password: bool = False
    scope: Literal["self", "team", "global"]
    scope_countries: list[str] | None


# ---------- people ----------
class PersonBasicOut(ORM):
    """Directory card: what anyone signed in may see about anyone."""

    view: Literal["basic"] = "basic"
    id: str
    full_name: str
    preferred_name: str | None
    job_title: str
    department: str
    location: str
    country_code: str
    email: str
    manager_id: str | None
    manager_name: str | None = None
    photo: str | None
    company: str = "TimeZ"


class PersonFullOut(ORM):
    """Full record: for yourself, your reporting line, or HR/admin/executive within scope. No pay fields."""

    view: Literal["full"] = "full"
    id: str
    full_name: str
    preferred_name: str | None
    job_title: str
    department: str
    location: str
    country_code: str
    email: str
    manager_id: str | None
    manager_name: str | None = None
    photo: str | None
    employee_code: str
    first_name: str | None
    middle_name: str | None
    last_name: str | None
    personal_email: str | None  # always masked; full value from GET /people/{id}/reveal
    mobile: str | None  # always masked
    legal_entity: str
    business_unit: str
    division: str | None
    cost_centre: str | None
    job_family: str | None
    position_id: str | None
    grade: str
    employment_type: str
    employment_status: str
    joining_date: date
    time_zone: str
    currency: str
    date_of_birth: str | None  # always masked ("•• ••• 1990")
    gender: str | None
    holiday_calendar: str | None
    leave_policy_name: str | None
    payroll_status: str | None
    ai_profile_status: str | None
    last_working_day: date | None = None  # set when an exit is approved (migration 0014)
    # Profile details (migration 0008). address_line, address_postcode and emergency_phone are always masked.
    company: str = "TimeZ"
    nationality: str | None = None
    address_line: str | None = None
    address_city: str | None = None
    address_postcode: str | None = None
    address_country: str | None = None
    emergency_name: str | None = None
    emergency_relationship: str | None = None
    emergency_phone: str | None = None
    work_arrangement: str | None = None
    preferred_language: str | None = None
    languages: list[str] = []
    education: list[dict[str, object]] = []
    experience: list[dict[str, object]] = []
    career_goals: str | None = None
    direct_report_count: int | None = None
    can_reveal: bool = False  # caller may call /people/{id}/reveal (self, or HR / admin in scope)

    @field_validator("address_line", "address_postcode", mode="before")
    @classmethod
    def _mask_address_part(cls, v: object) -> str | None:
        return mask_text(v) if isinstance(v, str) else None

    @field_validator("emergency_phone", mode="before")
    @classmethod
    def _mask_emergency_phone(cls, v: object) -> str | None:
        return mask_phone(v) if isinstance(v, str) else None

    @field_validator("languages", "education", "experience", mode="before")
    @classmethod
    def _list_or_empty(cls, v: object) -> object:
        return v if isinstance(v, list) else []

    @field_validator("company", mode="before")
    @classmethod
    def _company_default(cls, v: object) -> object:
        return v or "TimeZ"

    @field_validator("mobile", mode="before")
    @classmethod
    def _mask_mobile(cls, v: object) -> str | None:
        return mask_phone(v) if isinstance(v, str) else None

    @field_validator("personal_email", mode="before")
    @classmethod
    def _mask_personal_email(cls, v: object) -> str | None:
        return mask_email(v) if isinstance(v, str) else None

    @field_validator("date_of_birth", mode="before")
    @classmethod
    def _mask_dob(cls, v: object) -> str | None:
        return mask_dob(v) if isinstance(v, (date, str)) else None


PersonOut = Annotated[PersonBasicOut | PersonFullOut, Field(discriminator="view")]


# ---------- leave ----------
class LeavePolicyOut(BaseModel):
    code: str
    name: str
    country_code: str
    quota: float
    carry_forward_max: float
    accrual: str
    half_day_allowed: bool
    effective_from: date
    effective_to: date | None


class HolidayOut(ORM):
    id: str
    date: dt.date
    name: str
    country_code: str


class LeaveBalanceOut(BaseModel):
    code: str
    name: str
    quota: float
    carried_over: float
    used: float
    pending: float
    left: float
    available: float
    accrual: str


class LeaveBalancesOut(BaseModel):
    employee_id: str
    year: int
    balances: list[LeaveBalanceOut]


class LeaveRequestIn(BaseModel):
    leave_code: str = Field(min_length=1, max_length=32)
    from_date: date = Field(alias="from")
    to_date: date = Field(alias="to")
    half: Literal["none", "first", "second"] = "none"
    reason: str = Field(min_length=1, max_length=2000)

    model_config = ConfigDict(populate_by_name=True)


class LeaveDecisionIn(BaseModel):
    decision: Literal["approve", "reject"]
    note: str | None = Field(default=None, max_length=2000)


class LeaveRequestOut(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True, serialize_by_alias=True)

    id: str
    employee_id: str
    employee_name: str | None = None
    leave_code: str
    from_date: date = Field(serialization_alias="from")
    to_date: date = Field(serialization_alias="to")
    half: str
    days: float
    reason: str
    status: str
    decided_by: str | None
    decided_at: datetime | None
    decision_note: str | None
    created_at: datetime
    approval: dict | None = None  # approval steps and progress (app/services/time_approvals.py progress)


# ---------- notifications ----------
class NotificationOut(ORM):
    id: int
    title: str
    body: str
    href: str | None
    read_at: datetime | None
    created_at: datetime


# ---------- attendance ----------
class CheckInIn(BaseModel):
    work_mode: Literal["office", "wfh", "remote"] = "office"
    source: Literal["web", "mobile", "device"] = "web"
    note: str | None = Field(default=None, max_length=1000)


class CheckOutIn(BaseModel):
    break_minutes: int | None = Field(default=None, ge=0, le=720)
    note: str | None = Field(default=None, max_length=1000)


class AttendanceSessionOut(ORM):
    id: str
    employee_id: str
    work_date: date
    time_zone: str
    check_in: datetime
    check_out: datetime | None
    break_minutes: int
    worked_minutes: int | None
    work_mode: str
    source: str
    shift_start: str
    shift_end: str
    is_late: bool
    late_minutes: int
    is_early_leave: bool
    early_minutes: int
    corrected: bool
    note: str | None


class AttendanceSummaryOut(BaseModel):
    employee_id: str
    month: str
    working_days: int
    present: int
    absent: int
    on_leave: float
    late: int
    early: int
    hours: float
    overtime_hours: float


class CorrectionIn(BaseModel):
    work_date: date
    requested_check_in: datetime | None = None  # naive = the person's local time
    requested_check_out: datetime | None = None
    reason: str = Field(min_length=1, max_length=2000)


class DecisionIn(BaseModel):
    decision: Literal["approve", "reject"]
    note: str | None = Field(default=None, max_length=2000)


class CorrectionOut(ORM):
    id: str
    employee_id: str
    employee_name: str | None = None
    work_date: date
    session_id: str | None
    requested_check_in: datetime | None
    requested_check_out: datetime | None
    reason: str
    status: str
    decided_by: str | None
    decided_at: datetime | None
    decision_note: str | None
    created_at: datetime
    approval: dict | None = None


# ---------- timesheets ----------
class ProjectOut(ORM):
    id: str
    code: str
    name: str
    client: str | None
    billable_default: bool
    active: bool


class TimesheetEntryIn(BaseModel):
    work_date: date
    project_id: str = Field(min_length=1, max_length=64)
    task: str = Field(min_length=1, max_length=200)
    hours: float = Field(gt=0, le=24, multiple_of=0.25)
    billable: bool | None = None  # None = the project's default
    comment: str | None = Field(default=None, max_length=2000)


class TimesheetEntryOut(ORM):
    id: str
    employee_id: str
    week_id: str
    work_date: date
    project_id: str
    task: str
    hours: float
    billable: bool
    comment: str | None


class TimesheetWeekOut(ORM):
    id: str
    employee_id: str
    employee_name: str | None = None
    week_start: date
    status: str
    total_hours: float = 0
    submitted_at: datetime | None
    decided_by: str | None
    decided_at: datetime | None
    decision_note: str | None
    approval: dict | None = None


class UtilizationRow(BaseModel):
    id: str
    name: str
    total_hours: float
    billable_hours: float
    billable_pct: float


class UtilizationOut(BaseModel):
    from_date: date
    to_date: date
    total_hours: float
    billable_hours: float
    billable_pct: float
    people: list[UtilizationRow]
    projects: list[UtilizationRow]


# ---------- approvals ----------
class WorkflowStepCondition(BaseModel):
    """The step only applies when the requester's country / department / grade is one of the values."""

    field: Literal["country", "department", "grade"]
    values: list[Annotated[str, Field(min_length=1, max_length=200)]] = Field(min_length=1, max_length=50)


class WorkflowStep(BaseModel):
    roles: list[Literal["manager", "skip_manager", "hr", "finance", "admin", "executive"]] = Field(min_length=1)
    mode: Literal["all", "any"] = "any"
    min_amount: float | None = Field(default=None, ge=0)
    label: str | None = Field(default=None, max_length=100)
    sla_hours: float | None = Field(default=None, gt=0, le=24 * 90)
    condition: WorkflowStepCondition | None = None
    only_if: Literal["needs_hr", "via_manager"] | None = None


class WorkflowIn(BaseModel):
    steps: list[WorkflowStep] = Field(min_length=1, max_length=10)


class WorkflowOut(ORM):
    type: str
    version: int
    steps: list[WorkflowStep]
    active: bool
    created_by: str | None
    created_at: datetime


class ApprovalDecisionOut(ORM):
    step: int
    group: str
    approver_id: str
    decision: str
    note: str | None
    at: datetime
    on_behalf_of: str | None = None


class ApprovalInstanceOut(ORM):
    id: str
    type: str
    entity_id: str
    requester_id: str
    amount: float | None
    workflow_version: int | None
    steps: list[dict]
    current_step: int
    status: str
    completed_at: datetime | None
    created_at: datetime
    decisions: list[ApprovalDecisionOut] = []


class PendingItemOut(BaseModel):
    kind: str  # leave | attendance_correction | timesheet_week | approval
    type: str  # the request type, e.g. "casual" leave or "expense"
    id: str
    employee_id: str
    employee_name: str | None
    summary: str
    submitted_at: datetime | None
    href: str


# ---------- expenses, travel, lifecycle, organization (defined in their own modules) ----------
from app.schemas.expenses import (  # noqa: E402,F401
    ExpenseClaimIn, ExpenseClaimOut, ExpensePayIn, ExpenseRulesOut, ReceiptOut, TravelRequestIn, TravelRequestOut,
)
from app.schemas.org import (  # noqa: E402,F401
    ApplyDueOut, AssignmentOut, JobFamilyIn, JobFamilyOut, JobFamilyUpdate, JobProfileIn, JobProfileOut, JobProfileUpdate,
    LifecycleActionIn, LifecycleActionOut, OrgUnitIn, OrgUnitOut, OrgUnitUpdate, PositionIn, PositionOut, PositionUpdate,
)

# ---------- recruiting, onboarding, performance, learning (app/schemas/talent.py) ----------
from app.schemas import talent  # noqa: E402,F401  (names imported from app.schemas.talent; never shadows the ones above)

# ---------- compensation, benefits, documents & letters (app/schemas/compensation.py, benefits.py, documents.py) ----------
from app.schemas import benefits, compensation, documents  # noqa: E402,F401  (import names from those modules directly)

# ---------- HR cases & desk, engagement & shifts, admin platform (app/schemas/cases_desk.py, engagement_shifts.py, platform_admin.py) ----------
from app.schemas import cases_desk, engagement_shifts, platform_admin  # noqa: E402,F401  (import names from those modules directly)

# ---------- profile edits, profile corrections, AI action audit (app/schemas/profile.py) ----------
from app.schemas import profile  # noqa: E402,F401  (import names from app.schemas.profile directly)

# ---------- leave admin, leave eligibility, country config (app/schemas/leave_rules.py) ----------
from app.schemas import leave_rules  # noqa: E402,F401  (import names from app.schemas.leave_rules directly)

# ---------- approval chains: delegation (app/schemas/approval_chains.py) ----------
from app.schemas import approval_chains  # noqa: E402,F401  (import names from app.schemas.approval_chains directly)
