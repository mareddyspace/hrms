"""Compensation (highly restricted): grade bands, effective-dated pay history, bonuses, review cycles and proposals.

Who may read pay is decided in app/services/compensation.py; every read of someone else's pay is audited.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy import JSON, Date, ForeignKey, Index, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, TimestampMixin, UTCDateTime


class GradeBand(TimestampMixin, Base):
    """Salary range for one grade in one country (annual base, local currency)."""

    __tablename__ = "grade_bands"
    __table_args__ = (UniqueConstraint("grade", "country_code", name="uq_grade_band_grade_country"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    grade: Mapped[str] = mapped_column(String(16))
    country_code: Mapped[str] = mapped_column(ForeignKey("countries.code"), index=True)
    currency: Mapped[str] = mapped_column(String(3))
    min_amount: Mapped[float] = mapped_column(Numeric(14, 2, asdecimal=False))
    mid_amount: Mapped[float] = mapped_column(Numeric(14, 2, asdecimal=False))
    max_amount: Mapped[float] = mapped_column(Numeric(14, 2, asdecimal=False))
    updated_by: Mapped[str | None] = mapped_column(String(64))


class CompensationRecord(TimestampMixin, Base):
    """One row of effective-dated pay history. Current pay = the latest row effective on or before today."""

    __tablename__ = "compensation_records"
    __table_args__ = (
        UniqueConstraint("employee_id", "effective_date", name="uq_comp_record_employee_date"),
        Index("ix_comp_record_employee_date", "employee_id", "effective_date"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"))
    effective_date: Mapped[date] = mapped_column(Date)
    base_salary: Mapped[float] = mapped_column(Numeric(14, 2, asdecimal=False))  # annual
    currency: Mapped[str] = mapped_column(String(3))
    grade: Mapped[str] = mapped_column(String(16))
    reason: Mapped[str] = mapped_column(String(200))
    proposal_id: Mapped[str | None] = mapped_column(String(64))
    created_by: Mapped[str | None] = mapped_column(String(64))


class CompBonus(TimestampMixin, Base):
    __tablename__ = "comp_bonuses"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    bonus_type: Mapped[str] = mapped_column(String(100))
    period: Mapped[str] = mapped_column(String(32))
    amount: Mapped[float] = mapped_column(Numeric(14, 2, asdecimal=False))
    currency: Mapped[str] = mapped_column(String(3))
    status: Mapped[str] = mapped_column(String(16), index=True)  # accrued | paid | forfeited
    proposal_id: Mapped[str | None] = mapped_column(String(64))
    created_by: Mapped[str | None] = mapped_column(String(64))
    decided_by: Mapped[str | None] = mapped_column(String(64))


class CompReviewCycle(TimestampMixin, Base):
    """A compensation review cycle HR runs. Proposals are taken while it is open and between opens_on and closes_on."""

    __tablename__ = "comp_review_cycles"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(200), unique=True)
    effective_date: Mapped[date] = mapped_column(Date)
    budget_pct: Mapped[float] = mapped_column(Numeric(5, 2, asdecimal=False))
    opens_on: Mapped[date] = mapped_column(Date)
    closes_on: Mapped[date] = mapped_column(Date)
    status: Mapped[str] = mapped_column(String(16), index=True)  # planning | open | closed
    countries: Mapped[list[str] | None] = mapped_column(JSON)  # NULL = every country
    created_by: Mapped[str | None] = mapped_column(String(64))


class CompProposal(TimestampMixin, Base):
    """A pay change proposed in a cycle (approval type "compensation"). On approval a compensation record is written."""

    __tablename__ = "comp_proposals"
    __table_args__ = (Index("ix_comp_proposal_cycle_employee", "cycle_id", "employee_id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    cycle_id: Mapped[str] = mapped_column(ForeignKey("comp_review_cycles.id"))
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    proposed_by: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    currency: Mapped[str] = mapped_column(String(3))
    current_base: Mapped[float] = mapped_column(Numeric(14, 2, asdecimal=False))
    current_grade: Mapped[str] = mapped_column(String(16))
    increase_pct: Mapped[float] = mapped_column(Numeric(6, 2, asdecimal=False))
    proposed_base: Mapped[float] = mapped_column(Numeric(14, 2, asdecimal=False))
    proposed_grade: Mapped[str] = mapped_column(String(16))
    bonus_amount: Mapped[float | None] = mapped_column(Numeric(14, 2, asdecimal=False))
    justification: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), index=True)  # pending | approved | rejected | withdrawn
    approval_instance_id: Mapped[str | None] = mapped_column(String(64))
    record_id: Mapped[str | None] = mapped_column(String(64))
    decided_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    extra: Mapped[dict[str, Any] | None] = mapped_column(JSON)
