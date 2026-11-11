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
    description: str | None = None
    verification_status: str | None = None
    verification_note: str | None = None
    verified_by: str | None = None
    verified_at: datetime | None = None


class DocExpiryIn(BaseModel):
    expiry_date: date | None


FileKind = Literal["pdf", "image", "docx"]


class DocCategoryOut(BaseModel):
    name: str
    label: str
    verification: bool
    employee_upload: bool
    manager_visible: bool = False
    requires_expiry: bool = False
    required: bool = False
    types: list[str] = []
    max_mb: int = 10


class DocCategoryIn(BaseModel):
    """Fields left out (None) keep their current value."""

    name: str = Field(max_length=32)
    label: str = Field(min_length=1, max_length=60)
    verification: bool
    employee_upload: bool
    manager_visible: bool | None = None
    requires_expiry: bool | None = None
    required: bool | None = None
    types: list[FileKind] | None = Field(default=None, min_length=1, max_length=3)
    max_mb: int | None = Field(default=None, ge=1, le=10)


class DocDeleteIn(BaseModel):
    reason: str = Field(default="", max_length=500)


class DocFolderOut(BaseModel):
    """One employee's folder in the HR / manager view."""

    employee_id: str
    employee_name: str
    employee_code: str
    department: str
    documents: int
    pending: int
    rejected: int
    expiring: int  # within 30 days
    expired: int
    missing: list[str]  # labels of required categories with no document


class DocVerifyIn(BaseModel):
    decision: Literal["verify", "reject"]
    note: str | None = Field(default=None, max_length=1000)


class DocRulesOut(BaseModel):
    categories: list[str]
    manager_categories: list[str]
    max_bytes: int
    content_types: list[str]
    category_config: list[DocCategoryOut] = []


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
    legal_entity: str | None = None
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
    active: bool | None = None  # None keeps it; an inactive template is skipped (the next one applies)


class LetterTemplateNewIn(LetterTemplateIn):
    """A country version (country_code) or a legal entity's version (legal_entity) of a letter type."""

    letter_type: LetterTypeName
    country_code: str | None = Field(default=None, pattern=r"^[A-Z]{2}$")
    legal_entity: str | None = Field(default=None, min_length=2, max_length=200)


class LetterTemplatePreviewIn(BaseModel):
    """Unsaved wording rendered with one employee's data (default: yourself)."""

    letter_type: LetterTypeName
    title: str = Field(min_length=3, max_length=200)
    to_whom: bool = False
    paragraphs: list[str] = Field(min_length=1, max_length=12)
    employee_id: str | None = Field(default=None, max_length=64)


class LetterPlaceholderOut(BaseModel):
    name: str
    description: str


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
