"""Engagement surveys and recognition (kudos, points, rewards). Migration 0006.

Anonymous survey responses store no employee id and no timestamp, only a department / country bucket.
Who answered is kept separately (engagement_participants) and only to stop double answers.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy import JSON, Boolean, Date, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, TimestampMixin, UTCDateTime, utcnow


class EngagementSurvey(TimestampMixin, Base):
    __tablename__ = "engagement_surveys"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    title: Mapped[str] = mapped_column(String(200), unique=True)
    kind: Mapped[str] = mapped_column(String(16), index=True)  # pulse | engagement | onboarding | exit
    questions: Mapped[list[dict[str, Any]]] = mapped_column(JSON)  # [{"id", "kind": rating|enps|text, "prompt"}]
    anonymous: Mapped[bool] = mapped_column(Boolean, default=True)
    audience_type: Mapped[str] = mapped_column(String(16), default="all")  # all | department | country
    audience_value: Mapped[str | None] = mapped_column(String(200))
    open_date: Mapped[date] = mapped_column(Date)
    close_date: Mapped[date] = mapped_column(Date)
    published: Mapped[bool] = mapped_column(Boolean, default=False)
    closed_at: Mapped[datetime | None] = mapped_column(UTCDateTime())  # closed early by HR
    created_by: Mapped[str | None] = mapped_column(String(64))


class EngagementResponse(Base):
    __tablename__ = "engagement_responses"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # random, so ids don't follow answer order
    survey_id: Mapped[str] = mapped_column(ForeignKey("engagement_surveys.id", ondelete="CASCADE"), index=True)
    employee_id: Mapped[str | None] = mapped_column(ForeignKey("employees.id"))  # NULL on anonymous surveys
    department: Mapped[str] = mapped_column(String(200))
    country_code: Mapped[str] = mapped_column(String(8))
    answers: Mapped[dict[str, Any]] = mapped_column(JSON)


class EngagementParticipant(Base):
    __tablename__ = "engagement_participants"
    __table_args__ = (UniqueConstraint("survey_id", "employee_id", name="uq_engagement_participant"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    survey_id: Mapped[str] = mapped_column(ForeignKey("engagement_surveys.id", ondelete="CASCADE"), index=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"))


class Kudos(Base):
    __tablename__ = "kudos"
    __table_args__ = (Index("ix_kudos_from_month", "from_id", "month"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    from_id: Mapped[str] = mapped_column(ForeignKey("employees.id"))
    to_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    value: Mapped[str] = mapped_column(String(32))
    message: Mapped[str] = mapped_column(Text)
    points: Mapped[int] = mapped_column(Integer, default=0)
    month: Mapped[str] = mapped_column(String(7))  # YYYY-MM, for the monthly allowance
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, index=True)


class KudosLike(Base):
    __tablename__ = "kudos_likes"
    __table_args__ = (UniqueConstraint("kudos_id", "employee_id", name="uq_kudos_like"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    kudos_id: Mapped[str] = mapped_column(ForeignKey("kudos.id", ondelete="CASCADE"), index=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"))


class RewardItem(TimestampMixin, Base):
    __tablename__ = "reward_items"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    points: Mapped[int] = mapped_column(Integer)
    needs_date: Mapped[bool] = mapped_column(Boolean, default=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class RewardRedemption(TimestampMixin, Base):
    __tablename__ = "reward_redemptions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    reward_id: Mapped[str] = mapped_column(ForeignKey("reward_items.id"))
    points: Mapped[int] = mapped_column(Integer)
    note: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(16), index=True)  # Requested | Fulfilled | Declined | Cancelled
    decided_by: Mapped[str | None] = mapped_column(String(64))
    decided_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    decision_note: Mapped[str | None] = mapped_column(Text)
