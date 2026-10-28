"""Employee document repository (versioned files), letter templates / requests / issued letters, policy acknowledgments."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy import JSON, Boolean, Date, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, TimestampMixin, UTCDateTime, utcnow


class EmployeeDocument(TimestampMixin, Base):
    """A document about one employee. The file content lives in document_versions (STORAGE_DIR/documents/...)."""

    __tablename__ = "employee_documents"
    __table_args__ = (Index("ix_employee_document_expiry", "expiry_date"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    category: Mapped[str] = mapped_column(String(32), index=True)
    title: Mapped[str] = mapped_column(String(200))
    current_version: Mapped[int] = mapped_column(Integer, default=1)
    expiry_date: Mapped[date | None] = mapped_column(Date)
    letter_request_id: Mapped[str | None] = mapped_column(String(64), index=True)
    uploaded_by: Mapped[str | None] = mapped_column(String(64))


class DocumentVersion(Base):
    __tablename__ = "document_versions"
    __table_args__ = (UniqueConstraint("document_id", "version", name="uq_document_version"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    document_id: Mapped[str] = mapped_column(ForeignKey("employee_documents.id", ondelete="CASCADE"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    file_name: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(100))
    size_bytes: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64))
    storage_path: Mapped[str] = mapped_column(String(500))  # relative to STORAGE_DIR, forward slashes
    uploaded_by: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class LetterTemplate(TimestampMixin, Base):
    """Wording for one letter type; country_code NULL = the default used where no country version exists.

    paragraphs hold {placeholders} (see app/services/letters.py PLACEHOLDERS) and <b>bold</b> markup.
    """

    __tablename__ = "letter_templates"
    __table_args__ = (UniqueConstraint("letter_type", "country_code", name="uq_letter_template_type_country"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    letter_type: Mapped[str] = mapped_column(String(32), index=True)
    country_code: Mapped[str | None] = mapped_column(String(2))
    title: Mapped[str] = mapped_column(String(200))
    to_whom: Mapped[bool] = mapped_column(Boolean, default=False)
    paragraphs: Mapped[list[str]] = mapped_column(JSON)
    version: Mapped[int] = mapped_column(Integer, default=1)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    updated_by: Mapped[str | None] = mapped_column(String(64))


class LetterRequest(TimestampMixin, Base):
    """status: pending (approval type "letter") -> issued (PDF generated) | approved (generation failed) | rejected |
    cancelled."""

    __tablename__ = "letter_requests"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    letter_type: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(16), index=True)
    requested_by: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    note: Mapped[str] = mapped_column(Text, default="")
    details: Mapped[str | None] = mapped_column(String(200))
    effective_date: Mapped[date | None] = mapped_column(Date)
    approval_instance_id: Mapped[str | None] = mapped_column(String(64))
    document_id: Mapped[str | None] = mapped_column(String(64))
    issue_error: Mapped[str | None] = mapped_column(Text)
    issued_at: Mapped[datetime | None] = mapped_column(UTCDateTime())


class LetterIssue(Base):
    """One generated version of a letter (the PDF is a document_versions row)."""

    __tablename__ = "letter_issues"
    __table_args__ = (UniqueConstraint("request_id", "version", name="uq_letter_issue_version"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # DOC-YYYYMMDD-XXXXXX
    request_id: Mapped[str] = mapped_column(ForeignKey("letter_requests.id", ondelete="CASCADE"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    reference_no: Mapped[str] = mapped_column(String(64), unique=True)
    document_version_id: Mapped[str] = mapped_column(String(64))
    approved_by: Mapped[str | None] = mapped_column(String(64))
    generated_by: Mapped[str | None] = mapped_column(String(64))
    fields: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class PolicyAcknowledgment(Base):
    __tablename__ = "policy_acknowledgments"
    __table_args__ = (UniqueConstraint("employee_id", "policy_id", "policy_version", name="uq_policy_ack"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    policy_id: Mapped[str] = mapped_column(String(64), index=True)
    policy_version: Mapped[str] = mapped_column(String(32))
    acknowledged_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    ip: Mapped[str | None] = mapped_column(String(64))
