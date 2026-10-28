"""Onboarding: checklist templates per country, joiners (created on Hired) and their tasks."""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import JSON, Boolean, Date, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, TimestampMixin, UTCDateTime


class OnboardingTemplateTask(TimestampMixin, Base):
    """Scope fields NULL = applies to all. country_code / legal_entity / employment_type narrow a row; for each key the
    most specific matching row wins (so a country row replaces the default one). active=False rows are ignored."""

    __tablename__ = "onboarding_template_tasks"
    __table_args__ = (UniqueConstraint("country_code", "legal_entity", "employment_type", "key",
                                       name="uq_onboarding_template_scope_key"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    country_code: Mapped[str | None] = mapped_column(ForeignKey("countries.code"), index=True)
    legal_entity: Mapped[str | None] = mapped_column(String(200))
    employment_type: Mapped[str | None] = mapped_column(String(32))  # Full-Time | Part-Time | Contract ...
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    key: Mapped[str] = mapped_column(String(32))
    title: Mapped[str] = mapped_column(String(200))
    owner_role: Mapped[str] = mapped_column(String(16))  # hr | it | manager | employee
    category: Mapped[str] = mapped_column(String(32))  # Documents | Equipment | Accounts | Orientation | Training | Policy
    due_offset_days: Mapped[int] = mapped_column(Integer, default=0)  # relative to the start date
    depends_on: Mapped[list[str]] = mapped_column(JSON, default=list)  # keys of tasks that must be done first
    sort: Mapped[int] = mapped_column(Integer, default=0)


class Joiner(TimestampMixin, Base):
    __tablename__ = "joiners"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), unique=True)
    candidate_id: Mapped[str | None] = mapped_column(ForeignKey("candidates.id"), unique=True)
    requisition_id: Mapped[str | None] = mapped_column(ForeignKey("requisitions.id"))
    offer_id: Mapped[str | None] = mapped_column(String(64))
    name: Mapped[str] = mapped_column(String(200))
    job_title: Mapped[str] = mapped_column(String(200))
    country_code: Mapped[str] = mapped_column(ForeignKey("countries.code"), index=True)
    manager_id: Mapped[str | None] = mapped_column(ForeignKey("employees.id"), index=True)
    start_date: Mapped[date] = mapped_column(Date)
    policy_ack: Mapped[bool] = mapped_column(Boolean, default=False)
    policy_ack_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    policy_ack_by: Mapped[str | None] = mapped_column(String(64))  # employee id
    policy_ack_by_hr: Mapped[bool] = mapped_column(Boolean, default=False)
    # pre_boarding | day1_ready | in_progress | completed
    status: Mapped[str] = mapped_column(String(16), index=True)
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    # pre-boarding form: {"personal": {...}, "emergency_contact": {...}, "equipment": [...], "it_request": {...}}
    preboarding: Mapped[dict | None] = mapped_column(JSON)
    preboarding_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    preboarding_by: Mapped[str | None] = mapped_column(String(64))  # account id


class OnboardingTask(TimestampMixin, Base):
    __tablename__ = "onboarding_tasks"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    joiner_id: Mapped[str] = mapped_column(ForeignKey("joiners.id", ondelete="CASCADE"), index=True)
    key: Mapped[str] = mapped_column(String(32))
    title: Mapped[str] = mapped_column(String(200))
    owner_role: Mapped[str] = mapped_column(String(16))
    category: Mapped[str] = mapped_column(String(32))
    due_date: Mapped[date] = mapped_column(Date)
    depends_on: Mapped[list[str]] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(16), default="pending")  # pending | in_progress | done
    done_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    done_by: Mapped[str | None] = mapped_column(String(64))
    override_note: Mapped[str | None] = mapped_column(Text)  # HR updating a task someone else owns
