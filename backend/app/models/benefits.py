"""Benefits: plans per country, enrollment windows and life events, enrollments, dependents, cover, nominees."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy import JSON, Boolean, Date, ForeignKey, Index, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, TimestampMixin, UTCDateTime


class BenefitPlan(TimestampMixin, Base):
    """eligibility: {"exclude_employment_types": ["Contract"], "min_service_months": 3, "grades": ["L5", ...]}"""

    __tablename__ = "benefit_plans"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    country_code: Mapped[str] = mapped_column(ForeignKey("countries.code"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    plan_type: Mapped[str] = mapped_column(String(32))  # Medical | Retirement | Life | Dental | Wellness | Other
    provider: Mapped[str] = mapped_column(String(200))
    summary: Mapped[str] = mapped_column(Text, default="")
    employee_cost: Mapped[str] = mapped_column(String(100), default="")
    employer_annual_cost: Mapped[float] = mapped_column(Numeric(14, 2, asdecimal=False), default=0)
    currency: Mapped[str] = mapped_column(String(3))
    covers_dependents: Mapped[bool] = mapped_column(Boolean, default=False)
    mandatory: Mapped[bool] = mapped_column(Boolean, default=False)  # statutory: can't be waived or requested
    auto_enrolled: Mapped[bool] = mapped_column(Boolean, default=False)
    eligibility: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class BenefitWindow(TimestampMixin, Base):
    """Open enrollment window. country_code NULL = every country. override forces it open / closed."""

    __tablename__ = "benefit_windows"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    country_code: Mapped[str | None] = mapped_column(String(2), index=True)
    start_date: Mapped[date] = mapped_column(Date)
    end_date: Mapped[date] = mapped_column(Date)
    override: Mapped[str | None] = mapped_column(String(8))  # open | closed | NULL
    updated_by: Mapped[str | None] = mapped_column(String(64))


class LifeEvent(TimestampMixin, Base):
    """A life event opens a 30-day change window from the event date."""

    __tablename__ = "benefit_life_events"
    __table_args__ = (UniqueConstraint("employee_id", "event_type", "event_date", name="uq_life_event"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    event_type: Mapped[str] = mapped_column(String(64))
    event_date: Mapped[date] = mapped_column(Date)
    window_ends: Mapped[date] = mapped_column(Date)
    status: Mapped[str] = mapped_column(String(16))  # open | closed
    closed_by: Mapped[str | None] = mapped_column(String(64))


class BenefitEnrollment(TimestampMixin, Base):
    __tablename__ = "benefit_enrollments"
    __table_args__ = (UniqueConstraint("employee_id", "plan_id", name="uq_benefit_enrollment_employee_plan"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    plan_id: Mapped[str] = mapped_column(ForeignKey("benefit_plans.id"), index=True)
    status: Mapped[str] = mapped_column(String(16), index=True)  # requested | approved | waived
    effective_date: Mapped[date | None] = mapped_column(Date)
    life_event_id: Mapped[str | None] = mapped_column(String(64))
    decided_by: Mapped[str | None] = mapped_column(String(64))
    decided_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    note: Mapped[str | None] = mapped_column(Text)


class BenefitDependent(TimestampMixin, Base):
    __tablename__ = "benefit_dependents"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    relationship: Mapped[str] = mapped_column(String(32))
    date_of_birth: Mapped[date] = mapped_column(Date)
    gender: Mapped[str | None] = mapped_column(String(32))
    verification: Mapped[str] = mapped_column(String(16))  # pending | verified | rejected
    verified_by: Mapped[str | None] = mapped_column(String(64))
    verified_at: Mapped[datetime | None] = mapped_column(UTCDateTime())


class BenefitDependentCoverage(Base):
    """Which dependents an enrollment covers."""

    __tablename__ = "benefit_dependent_coverage"

    enrollment_id: Mapped[str] = mapped_column(ForeignKey("benefit_enrollments.id", ondelete="CASCADE"), primary_key=True)
    dependent_id: Mapped[str] = mapped_column(ForeignKey("benefit_dependents.id", ondelete="CASCADE"), primary_key=True, index=True)


class Beneficiary(TimestampMixin, Base):
    """Nominee for a benefit (e.g. PF, life cover). Shares per employee + nomination_for must total 100."""

    __tablename__ = "benefit_beneficiaries"
    __table_args__ = (Index("ix_beneficiary_employee_for", "employee_id", "nomination_for"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"))
    nomination_for: Mapped[str] = mapped_column(String(64))
    name: Mapped[str] = mapped_column(String(200))
    relationship: Mapped[str] = mapped_column(String(32))
    share_pct: Mapped[float] = mapped_column(Numeric(5, 2, asdecimal=False))
    date_of_birth: Mapped[date | None] = mapped_column(Date)
