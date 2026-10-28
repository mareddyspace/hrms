"""Performance: review cycles, goals, check-ins (1:1 notes), reviews with 360 feedback and development actions."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy import JSON, Boolean, Date, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, TimestampMixin, UTCDateTime


class ReviewCycle(TimestampMixin, Base):
    __tablename__ = "review_cycles"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(200), unique=True)
    status: Mapped[str] = mapped_column(String(16), index=True)  # planning | active | calibration | closed
    start_date: Mapped[date] = mapped_column(Date)
    end_date: Mapped[date] = mapped_column(Date)
    self_review_due: Mapped[date] = mapped_column(Date)
    manager_review_due: Mapped[date] = mapped_column(Date)
    created_by: Mapped[str | None] = mapped_column(String(64))


class Goal(TimestampMixin, Base):
    __tablename__ = "goals"
    __table_args__ = (Index("ix_goal_employee_cycle", "employee_id", "cycle_id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"))
    cycle_id: Mapped[str] = mapped_column(ForeignKey("review_cycles.id"))
    type: Mapped[str] = mapped_column(String(8))  # goal | okr | kpi
    title: Mapped[str] = mapped_column(String(200))
    target: Mapped[str] = mapped_column(String(200))
    period: Mapped[str | None] = mapped_column(String(64))
    weight: Mapped[int] = mapped_column(Integer)  # percent; one person's goals in a cycle total at most 100
    progress: Mapped[int] = mapped_column(Integer, default=0)
    created_by: Mapped[str | None] = mapped_column(String(64))


class CheckIn(TimestampMixin, Base):
    """A 1:1 / check-in note between an employee and someone above them."""

    __tablename__ = "check_ins"
    __table_args__ = (Index("ix_check_in_employee_date", "employee_id", "meeting_date"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"))
    manager_id: Mapped[str | None] = mapped_column(ForeignKey("employees.id"))
    meeting_date: Mapped[date] = mapped_column(Date)
    notes: Mapped[str] = mapped_column(Text, default="")
    action_items: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)  # [{"text": "...", "done": false}]
    created_by: Mapped[str | None] = mapped_column(String(64))


class PerfReview(TimestampMixin, Base):
    __tablename__ = "perf_reviews"
    __table_args__ = (UniqueConstraint("cycle_id", "employee_id", name="uq_perf_review_cycle_employee"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    cycle_id: Mapped[str] = mapped_column(ForeignKey("review_cycles.id"), index=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    self_status: Mapped[str] = mapped_column(String(16), default="not_started")  # not_started | draft | submitted
    self_text: Mapped[str | None] = mapped_column(Text)
    self_submitted_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    manager_status: Mapped[str] = mapped_column(String(16), default="not_started")
    manager_text: Mapped[str | None] = mapped_column(Text)
    manager_id: Mapped[str | None] = mapped_column(String(64))
    manager_submitted_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    # Needs improvement | Solid | Strong | Exceptional; the employee sees it only once HR releases it
    rating: Mapped[str | None] = mapped_column(String(32))
    rating_proposed_by: Mapped[str | None] = mapped_column(String(64))
    rating_proposed_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    released: Mapped[bool] = mapped_column(Boolean, default=False)
    released_by: Mapped[str | None] = mapped_column(String(64))
    released_at: Mapped[datetime | None] = mapped_column(UTCDateTime())


class Reviewer360(Base):
    """A nominee's answer is visible to the employee's managers and HR only."""

    __tablename__ = "review_360_reviewers"
    __table_args__ = (UniqueConstraint("review_id", "reviewer_id", name="uq_360_review_reviewer"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    review_id: Mapped[str] = mapped_column(ForeignKey("perf_reviews.id", ondelete="CASCADE"), index=True)
    reviewer_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    nominated_by: Mapped[str] = mapped_column(String(64))
    nominated_at: Mapped[datetime] = mapped_column(UTCDateTime())
    rating: Mapped[int | None] = mapped_column(Integer)  # 1-5
    comment: Mapped[str | None] = mapped_column(Text)
    responded_at: Mapped[datetime | None] = mapped_column(UTCDateTime())


class DevAction(TimestampMixin, Base):
    __tablename__ = "dev_actions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    review_id: Mapped[str] = mapped_column(ForeignKey("perf_reviews.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(200))
    due: Mapped[date | None] = mapped_column(Date)
    status: Mapped[str] = mapped_column(String(16), default="not_started")  # not_started | in_progress | done
