"""Shift types, weekly rosters, swaps and coverage minimums. Migration 0006."""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import Boolean, Date, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, TimestampMixin, UTCDateTime


class ShiftType(TimestampMixin, Base):
    __tablename__ = "shift_types"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)
    start: Mapped[str] = mapped_column(String(5))  # "HH:MM"
    end: Mapped[str] = mapped_column(String(5))
    weekend_only: Mapped[bool] = mapped_column(Boolean, default=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class RosterShift(TimestampMixin, Base):
    """One person on one shift on one day, on a manager's roster."""

    __tablename__ = "roster_shifts"
    __table_args__ = (
        UniqueConstraint("employee_id", "work_date", name="uq_roster_shift_employee_date"),
        Index("ix_roster_shift_manager_date", "manager_id", "work_date"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"))
    work_date: Mapped[date] = mapped_column(Date)
    shift_id: Mapped[str] = mapped_column(ForeignKey("shift_types.id"))
    manager_id: Mapped[str] = mapped_column(ForeignKey("employees.id"))


class RosterWeek(TimestampMixin, Base):
    __tablename__ = "roster_weeks"
    __table_args__ = (UniqueConstraint("manager_id", "week_start", name="uq_roster_week_manager_start"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    manager_id: Mapped[str] = mapped_column(ForeignKey("employees.id"))
    week_start: Mapped[date] = mapped_column(Date)  # Monday
    status: Mapped[str] = mapped_column(String(16), default="draft")  # draft | published
    published_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    published_by: Mapped[str | None] = mapped_column(String(64))
    published_with_gaps: Mapped[bool] = mapped_column(Boolean, default=False)


class ShiftSwap(TimestampMixin, Base):
    __tablename__ = "shift_swaps"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    work_date: Mapped[date] = mapped_column(Date)
    requester_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    teammate_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    requester_shift_id: Mapped[str] = mapped_column(String(64))
    teammate_shift_id: Mapped[str] = mapped_column(String(64))
    reason: Mapped[str] = mapped_column(Text)
    # awaiting_teammate | awaiting_manager | approved | declined | rejected | cancelled
    status: Mapped[str] = mapped_column(String(24), index=True)
    decided_by: Mapped[str | None] = mapped_column(String(64))
    decided_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    decision_note: Mapped[str | None] = mapped_column(Text)


class CoverageMinimum(TimestampMixin, Base):
    """Minimum people on a shift on a weekday. scope "*" = company default, else a manager id (their team)."""

    __tablename__ = "coverage_minimums"
    __table_args__ = (UniqueConstraint("scope", "shift_id", "weekday", name="uq_coverage_scope_shift_day"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    scope: Mapped[str] = mapped_column(String(64))
    shift_id: Mapped[str] = mapped_column(ForeignKey("shift_types.id"))
    weekday: Mapped[int] = mapped_column(Integer)  # 0 = Sunday ... 6 = Saturday (same as the portal)
    minimum: Mapped[int] = mapped_column(Integer)
