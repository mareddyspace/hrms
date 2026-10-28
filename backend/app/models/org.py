from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy import JSON, Boolean, Date, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, TimestampMixin, UTCDateTime, utcnow

ORG_UNIT_TYPES = ("company", "legal_entity", "country", "business_unit", "division", "department", "team",
                  "supervisory_org", "cost_centre", "location")


class OrgUnit(TimestampMixin, Base):
    __tablename__ = "org_units"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    code: Mapped[str] = mapped_column(String(64), unique=True)
    name: Mapped[str] = mapped_column(String(200), index=True)
    type: Mapped[str] = mapped_column(String(32), index=True)  # one of ORG_UNIT_TYPES
    parent_id: Mapped[str | None] = mapped_column(ForeignKey("org_units.id"), index=True)
    country_code: Mapped[str | None] = mapped_column(ForeignKey("countries.code"))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    # Effective dating (migration 0013): first day in force, last day (NULL = open). Versions in org_change_history.
    effective_from: Mapped[date | None] = mapped_column(Date)
    effective_to: Mapped[date | None] = mapped_column(Date)
    manager_id: Mapped[str | None] = mapped_column(String(64))  # employee who leads the unit
    headcount: Mapped[int | None] = mapped_column(Integer)  # budgeted headcount


class JobFamily(TimestampMixin, Base):
    __tablename__ = "job_families"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    code: Mapped[str] = mapped_column(String(64), unique=True)
    name: Mapped[str] = mapped_column(String(200), unique=True)
    description: Mapped[str | None] = mapped_column(Text)
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class JobProfile(TimestampMixin, Base):
    __tablename__ = "job_profiles"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    code: Mapped[str] = mapped_column(String(64), unique=True)
    title: Mapped[str] = mapped_column(String(200), index=True)
    family_id: Mapped[str | None] = mapped_column(ForeignKey("job_families.id"), index=True)
    grade: Mapped[str | None] = mapped_column(String(16))
    description: Mapped[str | None] = mapped_column(Text)
    required_skills: Mapped[list[Any]] = mapped_column(JSON, default=list)
    preferred_skills: Mapped[list[Any]] = mapped_column(JSON, default=list)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    # Migration 0013
    effective_from: Mapped[date | None] = mapped_column(Date)
    effective_to: Mapped[date | None] = mapped_column(Date)
    job_level: Mapped[str | None] = mapped_column(String(32))  # e.g. L3, Senior, Manager
    experience_min_years: Mapped[int | None] = mapped_column(Integer)
    experience_max_years: Mapped[int | None] = mapped_column(Integer)
    education: Mapped[str | None] = mapped_column(String(200))
    responsibilities: Mapped[list[Any] | None] = mapped_column(JSON)


class Position(TimestampMixin, Base):
    """A budgeted seat, e.g. TIMEZ-ENG-IND-00125. status: open | frozen | filled."""

    __tablename__ = "positions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    code: Mapped[str] = mapped_column(String(64), unique=True)
    profile_id: Mapped[str] = mapped_column(ForeignKey("job_profiles.id"), index=True)
    department_id: Mapped[str | None] = mapped_column(ForeignKey("org_units.id"), index=True)
    location_id: Mapped[str | None] = mapped_column(ForeignKey("org_units.id"))
    country_code: Mapped[str] = mapped_column(ForeignKey("countries.code"), index=True)
    grade: Mapped[str | None] = mapped_column(String(16))
    manager_id: Mapped[str | None] = mapped_column(ForeignKey("employees.id"))
    headcount: Mapped[int] = mapped_column(Integer, default=1)
    filled: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(16), index=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    # Migration 0013
    effective_from: Mapped[date | None] = mapped_column(Date)
    effective_to: Mapped[date | None] = mapped_column(Date)


class OrgChangeVersion(Base):
    """One effective-dated version of an org unit, job profile or position (migration 0013).

    effective_to is the last day the version was in force (inclusive); NULL for the current version.
    snapshot holds the full record as it was, so "as of" views and history never depend on the audit log.
    """

    __tablename__ = "org_change_history"
    __table_args__ = (Index("ix_org_history_entity_from", "entity", "entity_id", "effective_from"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    entity: Mapped[str] = mapped_column(String(32))  # org_unit | job_profile | position
    entity_id: Mapped[str] = mapped_column(String(64))
    effective_from: Mapped[date] = mapped_column(Date)
    effective_to: Mapped[date | None] = mapped_column(Date)
    change: Mapped[str] = mapped_column(String(32))  # created | updated | deactivated | reactivated | baseline
    changed_fields: Mapped[list[str]] = mapped_column(JSON, default=list)
    snapshot: Mapped[dict[str, Any]] = mapped_column(JSON)
    changed_by: Mapped[str | None] = mapped_column(String(64))
    reason: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
