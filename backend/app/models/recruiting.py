"""Recruiting: requisitions, candidates and their stage history, interviews, offers."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy import JSON, Date, ForeignKey, Index, Integer, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, TimestampMixin, UTCDateTime, utcnow


class Requisition(TimestampMixin, Base):
    """Raised by the hiring manager; approved through the "requisition" workflow (approval_instances)."""

    __tablename__ = "requisitions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)  # JOB-231
    title: Mapped[str] = mapped_column(String(200))
    department: Mapped[str] = mapped_column(String(200))
    country_code: Mapped[str] = mapped_column(ForeignKey("countries.code"), index=True)
    location: Mapped[str] = mapped_column(String(200))
    openings: Mapped[int] = mapped_column(Integer, default=1)
    hiring_manager_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    recruiter_id: Mapped[str | None] = mapped_column(ForeignKey("employees.id"), index=True)
    recruiter_assigned_on: Mapped[date | None] = mapped_column(Date)
    # pending_approval | approved | rejected | on_hold | cancelled
    status: Mapped[str] = mapped_column(String(24), index=True)
    approval_id: Mapped[str | None] = mapped_column(String(64))  # approval_instances.id (NULL for older rows)
    requirements: Mapped[list[str]] = mapped_column(JSON, default=list)  # skills / "5+ years React" lines for matching
    description: Mapped[str | None] = mapped_column(Text)
    raised_on: Mapped[date] = mapped_column(Date)
    decided_on: Mapped[date | None] = mapped_column(Date)


class Candidate(TimestampMixin, Base):
    __tablename__ = "candidates"
    __table_args__ = (Index("ix_candidate_requisition_stage", "requisition_id", "stage"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    requisition_id: Mapped[str] = mapped_column(ForeignKey("requisitions.id"))
    name: Mapped[str] = mapped_column(String(200))
    email: Mapped[str] = mapped_column(String(255), index=True)
    phone: Mapped[str | None] = mapped_column(String(64))
    source: Mapped[str] = mapped_column(String(64))
    experience_years: Mapped[float] = mapped_column(Numeric(4, 1, asdecimal=False), default=0)
    skills: Mapped[list[str]] = mapped_column(JSON, default=list)
    cv_note: Mapped[str | None] = mapped_column(Text)
    cv_file: Mapped[str | None] = mapped_column(String(500))  # path relative to STORAGE_DIR
    cv_filename: Mapped[str | None] = mapped_column(String(255))
    cv_content_type: Mapped[str | None] = mapped_column(String(100))
    applied_on: Mapped[date] = mapped_column(Date)
    # Applied | Screening | Shortlisted | Interview | Assessment | Final Review | Offer | Hired | Rejected | Withdrawn
    stage: Mapped[str] = mapped_column(String(24))
    created_by: Mapped[str | None] = mapped_column(String(64))


class CandidateStage(Base):
    """One stage move, oldest first."""

    __tablename__ = "candidate_stages"
    __table_args__ = (Index("ix_candidate_stage_candidate", "candidate_id", "entered_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    candidate_id: Mapped[str] = mapped_column(ForeignKey("candidates.id", ondelete="CASCADE"))
    stage: Mapped[str] = mapped_column(String(24))
    entered_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    by_id: Mapped[str | None] = mapped_column(String(64))  # employee id of the person who moved it
    note: Mapped[str | None] = mapped_column(Text)


class Interview(TimestampMixin, Base):
    __tablename__ = "interviews"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    candidate_id: Mapped[str] = mapped_column(ForeignKey("candidates.id", ondelete="CASCADE"), index=True)
    scheduled_at: Mapped[datetime] = mapped_column(UTCDateTime())
    duration_minutes: Mapped[int] = mapped_column(Integer, default=60)
    kind: Mapped[str] = mapped_column(String(64))  # Technical, Panel, Hiring manager, ...
    panel_ids: Mapped[list[str]] = mapped_column(JSON, default=list)  # employee ids
    feedback_status: Mapped[str] = mapped_column(String(16), default="pending")  # pending | submitted
    score: Mapped[int | None] = mapped_column(Integer)  # 1-5
    feedback: Mapped[str | None] = mapped_column(Text)
    feedback_by: Mapped[str | None] = mapped_column(String(64))
    feedback_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    created_by: Mapped[str | None] = mapped_column(String(64))


class Offer(TimestampMixin, Base):
    """Recruiter prepares -> hiring manager agrees -> HR approves -> recruiter sends and records the answer.

    approvals: [{"role": "hiring_manager" | "hr", "by_id": "emp-ram", "at": "2026-10-28T10:00:00+00:00"}]
    """

    __tablename__ = "offers"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    candidate_id: Mapped[str] = mapped_column(ForeignKey("candidates.id", ondelete="CASCADE"), index=True)
    requisition_id: Mapped[str] = mapped_column(ForeignKey("requisitions.id"), index=True)
    grade: Mapped[str] = mapped_column(String(16))
    base_salary: Mapped[float] = mapped_column(Numeric(14, 2, asdecimal=False))
    currency: Mapped[str] = mapped_column(String(3))
    start_date: Mapped[date] = mapped_column(Date)
    package_note: Mapped[str | None] = mapped_column(Text)
    # preparing | pending_approval | approved | sent | accepted | declined | withdrawn
    status: Mapped[str] = mapped_column(String(24), index=True)
    approvals: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    created_by: Mapped[str] = mapped_column(String(64))  # employee id
    sent_on: Mapped[date | None] = mapped_column(Date)
    response_note: Mapped[str | None] = mapped_column(Text)
    responded_on: Mapped[date | None] = mapped_column(Date)
    response_recorded_by: Mapped[str | None] = mapped_column(String(64))
