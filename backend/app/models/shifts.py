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
    # Migration 0025: unpaid break inside the shift and where it is worked.
    break_minutes: Mapped[int] = mapped_column(Integer, default=60, server_default="60")
    location: Mapped[str | None] = mapped_column(String(100))
    # Migration 0034: roster colour (palette name, see SHIFT_COLORS) and the country it applies to (None = any).
    color: Mapped[str | None] = mapped_column(String(16))
    country_code: Mapped[str | None] = mapped_column(String(2))

    @property
    def overnight(self) -> bool:
        return self.end <= self.start  # "HH:MM" strings compare in time order

    @property
    def paid_hours(self) -> float:
        """Length (overnight runs into the next day) minus the unpaid break."""
        sh, sm = (int(x) for x in self.start.split(":"))
        eh, em = (int(x) for x in self.end.split(":"))
        span = ((eh * 60 + em) - (sh * 60 + sm)) % 1440 or 1440
        return round(max(0, span - (self.break_minutes or 0)) / 60, 2)


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


class ShiftAvailability(TimestampMixin, Base):
    """An employee's availability (migration 0034): unavailable on a date or every given weekday, or a preferred shift.
    The roster warns the manager when they assign against it (it does not block)."""

    __tablename__ = "shift_availability"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    kind: Mapped[str] = mapped_column(String(16))  # unavailable | preferred
    work_date: Mapped[date | None] = mapped_column(Date)
    weekday: Mapped[int | None] = mapped_column(Integer)  # 0 = Sunday ... 6 = Saturday
    shift_id: Mapped[str | None] = mapped_column(String(64))
    note: Mapped[str | None] = mapped_column(String(300))
