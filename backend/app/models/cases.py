"""Confidential HR cases (grievance, POSH, discrimination, ethics, safety). Migration 0006.

Only the reporter, HR and (for POSH) the Internal Committee can see a case; the person named never can.
Archived cases (retention rule) keep a stub: notes, files and the description are removed.
"""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import Boolean, Date, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, TimestampMixin, UTCDateTime, utcnow


class HrCase(TimestampMixin, Base):
    __tablename__ = "hr_cases"
    __table_args__ = (Index("ix_hr_case_status_category", "status", "category"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True)  # private code the reporter follows the case with
    category: Mapped[str] = mapped_column(String(32))
    description: Mapped[str] = mapped_column(Text)
    anonymous: Mapped[bool] = mapped_column(Boolean, default=False)
    reporter_id: Mapped[str | None] = mapped_column(ForeignKey("employees.id"), index=True)  # never shown when anonymous
    against_id: Mapped[str | None] = mapped_column(ForeignKey("employees.id"), index=True)  # the person named
    priority: Mapped[str] = mapped_column(String(16), default="Normal")  # Low | Normal | High | Urgent
    status: Mapped[str] = mapped_column(String(16), index=True)  # Open | Investigating | Resolved | Closed | Archived
    assignee_id: Mapped[str | None] = mapped_column(ForeignKey("employees.id"), index=True)
    resolution: Mapped[str | None] = mapped_column(Text)
    closed_on: Mapped[date | None] = mapped_column(Date)
    archived_on: Mapped[date | None] = mapped_column(Date)
    escalated_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    escalated_by: Mapped[str | None] = mapped_column(String(64))
    escalation_count: Mapped[int] = mapped_column(Integer, default=0)


class HrCaseNote(Base):
    """Timeline entry. confidential notes are never shown to the reporter."""

    __tablename__ = "hr_case_notes"
    __table_args__ = (Index("ix_hr_case_note_case_at", "case_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    case_id: Mapped[str] = mapped_column(ForeignKey("hr_cases.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(16))  # filed | status | note | comment | escalation | archived
    text: Mapped[str] = mapped_column(Text)
    author_id: Mapped[str | None] = mapped_column(String(64))
    by_reporter: Mapped[bool] = mapped_column(Boolean, default=False)
    confidential: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str | None] = mapped_column(String(16))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class HrCaseFile(TimestampMixin, Base):
    """Evidence file on local disk (STORAGE_DIR/cases/...)."""

    __tablename__ = "hr_case_files"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    case_id: Mapped[str] = mapped_column(ForeignKey("hr_cases.id", ondelete="CASCADE"), index=True)
    uploaded_by: Mapped[str | None] = mapped_column(String(64))
    by_reporter: Mapped[bool] = mapped_column(Boolean, default=False)
    confidential: Mapped[bool] = mapped_column(Boolean, default=False)
    file_name: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(100))
    size_bytes: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64))
    storage_path: Mapped[str] = mapped_column(String(500))
