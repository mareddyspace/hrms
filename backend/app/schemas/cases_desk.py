"""Shapes for HR cases (confidential) and the HR service desk. Class names are unique across app.schemas."""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

CaseCategory = Literal["Grievance", "Harassment/POSH", "Discrimination", "Ethics/whistleblowing", "Safety"]
CasePriority = Literal["Low", "Normal", "High", "Urgent"]
DeskCategory = Literal["Payroll provider", "Benefits", "Documents", "IT access", "Leave", "Profile correction", "Other"]
DeskStatus = Literal["Open", "In progress", "Waiting on you", "Resolved", "Closed"]


# ---------- HR cases ----------
class HrCaseCreateIn(BaseModel):
    category: CaseCategory
    description: str = Field(min_length=20, max_length=4000)
    against_id: str | None = Field(default=None, max_length=64)
    anonymous: bool = False


class HrCaseCreatedOut(BaseModel):
    id: str
    code: str
    status: str


class HrCaseStatusIn(BaseModel):
    status: Literal["Investigating", "Resolved", "Closed"]
    note: str = Field(default="", max_length=4000)


class HrCaseAssignIn(BaseModel):
    assignee_id: str | None = Field(default=None, max_length=64)  # None = unassign


class HrCasePriorityIn(BaseModel):
    priority: CasePriority


class HrCaseNoteIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    confidential: bool = False


class HrCaseCommentIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


class HrCaseEscalateIn(BaseModel):
    reason: str = Field(min_length=5, max_length=1000)


class HrCaseEntryOut(BaseModel):
    id: str
    kind: str
    text: str
    author: str  # "Reporter", "HR" or a name (managers' view)
    confidential: bool
    status: str | None
    created_at: datetime


class HrCaseFileOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    file_name: str
    content_type: str
    size_bytes: int
    confidential: bool
    by_reporter: bool
    created_at: datetime


class HrCaseOut(BaseModel):
    id: str
    code: str
    category: str
    description: str
    anonymous: bool
    status: str
    priority: str
    view: Literal["reporter", "manager"]
    reporter_id: str | None = None  # managers' view only, and never on anonymous cases
    reporter_name: str | None = None
    against_id: str | None = None  # managers' view only
    against_name: str | None = None
    assignee_id: str | None = None
    assignee_name: str | None = None
    resolution: str | None = None
    closed_on: date | None = None
    archived_on: date | None = None
    posh_due_on: date | None = None
    posh_overdue: bool = False
    escalated_at: datetime | None = None
    escalation_count: int = 0
    created_at: datetime
    timeline: list[HrCaseEntryOut] = []
    files: list[HrCaseFileOut] = []


# ---------- HR service desk ----------
class DeskTicketCreateIn(BaseModel):
    category: DeskCategory
    subject: str = Field(min_length=3, max_length=200)
    description: str = Field(min_length=1, max_length=4000)
    priority: CasePriority = "Normal"


class DeskTicketCommentIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


class DeskTicketStatusIn(BaseModel):
    status: DeskStatus


class DeskTicketAssignIn(BaseModel):
    assignee_id: str | None = Field(default=None, max_length=64)


class DeskTicketRatingIn(BaseModel):
    rating: int = Field(ge=1, le=5)
    comment: str | None = Field(default=None, max_length=1000)


class DeskTicketCommentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    author_id: str | None
    author_name: str | None = None
    text: str
    system: bool
    created_at: datetime


class DeskTicketFileOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    file_name: str
    content_type: str
    size_bytes: int
    uploaded_by: str | None
    created_at: datetime


class DeskTicketOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    requester_id: str
    requester_name: str | None = None
    category: str
    subject: str
    description: str
    priority: str
    status: str
    assignee_id: str | None
    assignee_name: str | None = None
    submitted_at: datetime
    due_at: datetime
    first_response_at: datetime | None
    resolved_at: datetime | None
    escalated_at: datetime | None
    escalation_level: int
    satisfaction: int | None
    satisfaction_comment: str | None
    overdue: bool = False
    comments: list[DeskTicketCommentOut] = []
    files: list[DeskTicketFileOut] = []


class DeskSlaCategoryOut(BaseModel):
    category: str
    owner_id: str
    working_days: int
    open: int
    overdue: int
    resolved: int
    resolved_on_time: int


class DeskSlaSummaryOut(BaseModel):
    open: int
    unassigned: int
    overdue: int
    escalated: int
    resolved: int
    resolved_on_time: int
    on_time_pct: float | None
    avg_first_response_hours: float | None
    avg_satisfaction: float | None
    ratings: int
    by_category: list[DeskSlaCategoryOut]
