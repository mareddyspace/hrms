from __future__ import annotations

import datetime as dt
from datetime import date, datetime

from typing import Any

from sqlalchemy import JSON, Boolean, Date, ForeignKey, Index, Integer, Numeric, String, Text, UniqueConstraint, false, true
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, TimestampMixin, UTCDateTime


class LeaveType(TimestampMixin, Base):
    __tablename__ = "leave_types"

    code: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    half_day_allowed: Mapped[bool] = mapped_column(Boolean, default=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    # HR approves after the manager (migration 0009). NULL = default rule (maternity, paternity, unpaid).
    needs_hr_approval: Mapped[bool | None] = mapped_column(Boolean, nullable=True)


class LeavePolicy(TimestampMixin, Base):
    """Effective-dated rule for one leave type in one country. quota 0 = not offered there."""

    __tablename__ = "leave_policies"
    __table_args__ = (UniqueConstraint("leave_code", "country_code", "effective_from", name="uq_policy_code_country_from"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    leave_code: Mapped[str] = mapped_column(ForeignKey("leave_types.code"))
    country_code: Mapped[str] = mapped_column(ForeignKey("countries.code"), index=True)
    name: Mapped[str] = mapped_column(String(100))
    quota: Mapped[float] = mapped_column(Numeric(6, 1, asdecimal=False))
    carry_forward_max: Mapped[float] = mapped_column(Numeric(6, 1, asdecimal=False), default=0)
    accrual: Mapped[str] = mapped_column(String(16), default="annual")  # annual | monthly
    effective_from: Mapped[date] = mapped_column(Date)
    effective_to: Mapped[date | None] = mapped_column(Date)
    # Eligibility (migration 0011; app/services/leave_rules.py). NULL = no limit. gender NULL = defaults not seeded yet.
    gender: Mapped[str | None] = mapped_column(String(8))  # any | female | male
    min_service_months: Mapped[int | None] = mapped_column(Integer)
    employment_types: Mapped[list[Any] | None] = mapped_column(JSON)  # e.g. ["Full-Time"]; NULL/empty = all
    not_in_probation: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    max_per_request: Mapped[float | None] = mapped_column(Numeric(6, 1, asdecimal=False))
    min_notice_days: Mapped[int | None] = mapped_column(Integer)
    active: Mapped[bool] = mapped_column(Boolean, default=True, server_default=true())


class Holiday(TimestampMixin, Base):
    __tablename__ = "holidays"
    __table_args__ = (UniqueConstraint("country_code", "calendar", "date", name="uq_holiday_country_calendar_date"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    country_code: Mapped[str] = mapped_column(ForeignKey("countries.code"), index=True)
    date: Mapped[dt.date] = mapped_column(Date)
    name: Mapped[str] = mapped_column(String(200))
    # NULL = every calendar in the country; else only people whose employees.holiday_calendar matches (migration 0011).
    calendar: Mapped[str | None] = mapped_column(String(100))
    active: Mapped[bool] = mapped_column(Boolean, default=True, server_default=true())


class LeaveRequest(TimestampMixin, Base):
    __tablename__ = "leave_requests"
    __table_args__ = (Index("ix_leave_employee_from", "employee_id", "from_date"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"))
    leave_code: Mapped[str] = mapped_column(ForeignKey("leave_types.code"))
    from_date: Mapped[date] = mapped_column(Date)
    to_date: Mapped[date] = mapped_column(Date)
    half: Mapped[str] = mapped_column(String(8), default="none")  # none | first | second
    days: Mapped[float] = mapped_column(Numeric(6, 1, asdecimal=False))
    reason: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), index=True)  # pending|approved|rejected|cancelled|withdrawn
    decided_by: Mapped[str | None] = mapped_column(ForeignKey("employees.id"))
    decided_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    decision_note: Mapped[str | None] = mapped_column(Text)


class LeaveCarryForward(TimestampMixin, Base):
    """Days carried from one year into the next, written once per person, type and year by the year-end job."""

    __tablename__ = "leave_carry_forwards"
    __table_args__ = (UniqueConstraint("employee_id", "leave_code", "to_year", name="uq_carry_employee_code_year"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id", ondelete="CASCADE"), index=True)
    leave_code: Mapped[str] = mapped_column(ForeignKey("leave_types.code"))
    policy_id: Mapped[str | None] = mapped_column(String(64))
    to_year: Mapped[int] = mapped_column(Integer, index=True)
    unused: Mapped[float] = mapped_column(Numeric(6, 1, asdecimal=False))
    days: Mapped[float] = mapped_column(Numeric(6, 1, asdecimal=False))
