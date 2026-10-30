"""Document repository, letters and policy acknowledgment shapes."""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

LetterTypeName = Literal["Offer", "Appointment", "Employment", "Promotion", "Transfer", "Salary revision", "Experience",
                         "Relieving", "Confirmation", "NOC", "Visa/Travel", "Address proof", "Internship", "Warning",
                         "Termination", "Salary certificate", "Bonafide"]


class _DocORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class DocVersionOut(_DocORM):
    id: str
    version: int
    file_name: str
    content_type: str
    size_bytes: int
    sha256: str
    uploaded_by: str | None
    created_at: datetime


class EmployeeDocumentOut(_DocORM):
    id: str
    employee_id: str
    employee_name: str | None = None
    category: str
    title: str
    current_version: int
    expiry_date: date | None
    letter_request_id: str | None
    uploaded_by: str | None
    created_at: datetime
    updated_at: datetime
    days_to_expiry: int | None = None
    versions: list[DocVersionOut] = []


class DocExpiryIn(BaseModel):
    expiry_date: date | None


class DocRulesOut(BaseModel):
    categories: list[str]
    manager_categories: list[str]
    max_bytes: int
    content_types: list[str]


class LetterTypeOut(BaseModel):
    type: str
    label: str
    employee_can_request: bool
    pay_letter: bool
    details_label: str | None
    effective_input: bool
    second_approval: bool
    sensitive: bool


class LetterTemplateOut(_DocORM):
    id: str
    letter_type: str
    country_code: str | None
    title: str
    to_whom: bool
    paragraphs: list[str]
    version: int
    active: bool
    updated_at: datetime


class LetterTemplateIn(BaseModel):
    title: str = Field(min_length=3, max_length=200)
    to_whom: bool
    paragraphs: list[str] = Field(min_length=1, max_length=12)


class LetterTemplateNewIn(LetterTemplateIn):
    letter_type: LetterTypeName
    country_code: str = Field(pattern=r"^[A-Z]{2}$")


class LetterRequestIn(BaseModel):
    employee_id: str | None = Field(default=None, max_length=64)  # None = yourself
    letter_type: LetterTypeName
    note: str = Field(default="", max_length=2000)
    details: str | None = Field(default=None, max_length=200)
    effective_date: date | None = None  # HR only
    custom_text: str | None = Field(default=None, max_length=1200)  # "Add your own text": one paragraph in the letter


class LetterDraftIn(LetterRequestIn):
    """Preview a letter before requesting it (nothing is saved)."""


class LetterWordIn(BaseModel):
    letter_type: LetterTypeName
    employee_id: str | None = Field(default=None, max_length=64)
    text: str = Field(min_length=3, max_length=600)


class LetterWordOut(BaseModel):
    paragraph: str | None  # None = no AI available; the portal words it itself
    used_ai: bool


class LetterIssueOut(_DocORM):
    id: str
    version: int
    reference_no: str
    document_version_id: str
    approved_by: str | None
    created_at: datetime


class LetterRequestOut(_DocORM):
    id: str
    employee_id: str
    employee_name: str | None = None
    letter_type: str
    status: str
    requested_by: str
    note: str
    details: str | None
    effective_date: date | None
    custom_text: str | None = None
    approval_instance_id: str | None
    approval_status: str | None = None
    document_id: str | None
    issue_error: str | None
    issued_at: datetime | None
    created_at: datetime
    issues: list[LetterIssueOut] = []


class LetterPreviewOut(BaseModel):
    letter_type: str
    fields: dict[str, str]
    missing: list[str]
    title: str
    paragraphs: list[str]


class PolicyAckIn(BaseModel):
    policy_id: str = Field(min_length=1, max_length=64)
    policy_version: str = Field(min_length=1, max_length=32)
    comment: str | None = Field(default=None, max_length=1000)


class PolicyAckOut(_DocORM):
    id: int
    employee_id: str
    policy_id: str
    policy_version: str
    acknowledged_at: datetime
    comment: str | None = None
