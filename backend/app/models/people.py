from __future__ import annotations

from datetime import date, datetime

from typing import Any

from sqlalchemy import JSON, Boolean, Date, ForeignKey, Index, Integer, Numeric, String, Text, false
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, TimestampMixin, UTCDateTime


class Country(TimestampMixin, Base):
    __tablename__ = "countries"

    code: Mapped[str] = mapped_column(String(2), primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    currency: Mapped[str] = mapped_column(String(3))
    time_zone: Mapped[str] = mapped_column(String(64))
    # Country config (migration 0011; defaults in app/services/leave_rules.py COUNTRY_DEFAULTS).
    languages: Mapped[list[Any] | None] = mapped_column(JSON)  # e.g. ["en", "hi"]
    work_week_days: Mapped[list[Any] | None] = mapped_column(JSON)  # e.g. ["Mon", "Tue", "Wed", "Thu", "Fri"]
    standard_daily_hours: Mapped[float | None] = mapped_column(Numeric(4, 2, asdecimal=False))
    probation_months: Mapped[int | None] = mapped_column(Integer)
    notice_days: Mapped[int | None] = mapped_column(Integer)
    required_documents: Mapped[list[Any] | None] = mapped_column(JSON)
    workflow_notes: Mapped[str | None] = mapped_column(Text)


class Employee(TimestampMixin, Base):
    """Current view of a person. The effective-dated history lives in employee_assignments."""

    __tablename__ = "employees"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_code: Mapped[str] = mapped_column(String(32), unique=True)
    full_name: Mapped[str] = mapped_column(String(200), index=True)
    first_name: Mapped[str | None] = mapped_column(String(100))
    middle_name: Mapped[str | None] = mapped_column(String(100))
    last_name: Mapped[str | None] = mapped_column(String(100))
    preferred_name: Mapped[str | None] = mapped_column(String(100))
    email: Mapped[str] = mapped_column(String(255), unique=True)
    personal_email: Mapped[str | None] = mapped_column(String(255))
    mobile: Mapped[str | None] = mapped_column(String(64))
    photo: Mapped[str | None] = mapped_column(String(500))
    country_code: Mapped[str] = mapped_column(ForeignKey("countries.code"), index=True)
    legal_entity: Mapped[str] = mapped_column(String(200))
    business_unit: Mapped[str] = mapped_column(String(200))
    division: Mapped[str | None] = mapped_column(String(200))
    department: Mapped[str] = mapped_column(String(200), index=True)
    cost_centre: Mapped[str | None] = mapped_column(String(64))
    location: Mapped[str] = mapped_column(String(200), index=True)
    job_title: Mapped[str] = mapped_column(String(200))
    job_family: Mapped[str | None] = mapped_column(String(200))
    position_id: Mapped[str | None] = mapped_column(String(64))
    grade: Mapped[str] = mapped_column(String(16))
    employment_type: Mapped[str] = mapped_column(String(32))
    employment_status: Mapped[str] = mapped_column(String(32), index=True)
    joining_date: Mapped[date] = mapped_column(Date)
    manager_id: Mapped[str | None] = mapped_column(ForeignKey("employees.id"), index=True)
    time_zone: Mapped[str] = mapped_column(String(64))
    currency: Mapped[str] = mapped_column(String(3))
    date_of_birth: Mapped[date | None] = mapped_column(Date)
    gender: Mapped[str | None] = mapped_column(String(32))
    holiday_calendar: Mapped[str | None] = mapped_column(String(100))
    leave_policy_name: Mapped[str | None] = mapped_column(String(100))
    payroll_status: Mapped[str | None] = mapped_column(String(64))
    ai_profile_status: Mapped[str | None] = mapped_column(String(64))
    source: Mapped[str] = mapped_column(String(32), default="hcm_sample")  # hcm_sample | portal_account
    # Personal shift ("HH:MM" local). NULL = the country default, else 09:30-18:30 (app/services/attendance.py).
    shift_start: Mapped[str | None] = mapped_column(String(5))
    shift_end: Mapped[str | None] = mapped_column(String(5))
    # Profile details (migration 0008). Address and emergency phone are masked in responses (app/services/pii.py).
    company: Mapped[str] = mapped_column(String(100), default="TimeZ", server_default="TimeZ")
    nationality: Mapped[str | None] = mapped_column(String(64))
    address_line: Mapped[str | None] = mapped_column(String(300))
    address_city: Mapped[str | None] = mapped_column(String(100))
    address_postcode: Mapped[str | None] = mapped_column(String(20))
    address_country: Mapped[str | None] = mapped_column(String(100))
    emergency_name: Mapped[str | None] = mapped_column(String(200))
    emergency_relationship: Mapped[str | None] = mapped_column(String(64))
    emergency_phone: Mapped[str | None] = mapped_column(String(64))
    work_arrangement: Mapped[str | None] = mapped_column(String(16))  # Office | Hybrid | Remote
    preferred_language: Mapped[str | None] = mapped_column(String(64))
    languages: Mapped[list[str] | None] = mapped_column(JSON)
    education: Mapped[list[dict] | None] = mapped_column(JSON)  # [{degree, institution, year}]
    experience: Mapped[list[dict] | None] = mapped_column(JSON)  # [{employer, title, from, to}]
    career_goals: Mapped[str | None] = mapped_column(Text)
    # Set when an exit is approved (migration 0014); status goes "Notice period", then "Exited" after this day.
    last_working_day: Mapped[date | None] = mapped_column(Date)
    # India income tax regime chosen by the employee: "new" (default when NULL) or "old" (migration 0015).
    tax_regime: Mapped[str | None] = mapped_column(String(8))
    # Celebrations and compliance calendar (migration 0023): hide my birthday from colleagues; fixed-term contract end.
    hide_birthday: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    contract_end_date: Mapped[date | None] = mapped_column(Date)


class EmployeeAssignment(TimestampMixin, Base):
    """Effective-dated job/org assignment. effective_to is NULL for the current row."""

    __tablename__ = "employee_assignments"
    __table_args__ = (Index("ix_assignment_employee_from", "employee_id", "effective_from"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id", ondelete="CASCADE"))
    effective_from: Mapped[date] = mapped_column(Date)
    effective_to: Mapped[date | None] = mapped_column(Date)
    manager_id: Mapped[str | None] = mapped_column(ForeignKey("employees.id"))
    job_title: Mapped[str] = mapped_column(String(200))
    grade: Mapped[str] = mapped_column(String(16))
    department: Mapped[str] = mapped_column(String(200))
    location: Mapped[str] = mapped_column(String(200))
    legal_entity: Mapped[str] = mapped_column(String(200))
    employment_status: Mapped[str] = mapped_column(String(32))
    # Full org placement (migration 0013); NULL on rows written before it.
    business_unit: Mapped[str | None] = mapped_column(String(200))
    division: Mapped[str | None] = mapped_column(String(200))
    cost_centre: Mapped[str | None] = mapped_column(String(64))
    job_profile_id: Mapped[str | None] = mapped_column(String(64))
    position_id: Mapped[str | None] = mapped_column(String(64))


class Account(TimestampMixin, Base):
    """A sign-in user. Ids match the front end (demo-ceo, emp-mahesh, ...)."""

    __tablename__ = "accounts"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(32))
    employee_id: Mapped[str | None] = mapped_column(ForeignKey("employees.id"), unique=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_login_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    failed_attempts: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(UTCDateTime())
    password_changed_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    # Set at sign-in after a long gap without signing in; cleared when the password is changed.
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    # Two-step sign-in (TOTP, migration 0013). The secret is never returned after set-up.
    mfa_enabled: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    mfa_secret: Mapped[str | None] = mapped_column(String(64))
    mfa_enabled_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    mfa_last_step: Mapped[int | None] = mapped_column(Integer)  # last TOTP time step used (no replay)
    mfa_backup_codes: Mapped[list[str] | None] = mapped_column(JSON)  # hashes of unused backup codes


class AccessScope(TimestampMixin, Base):
    """Optional data-scope limit for an account. country_codes NULL (default) = global within the role."""

    __tablename__ = "access_scopes"

    account_id: Mapped[str] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True)
    country_codes: Mapped[str | None] = mapped_column(String(255))  # comma-separated, e.g. "IN,AE"
    # Pay visibility for people who aren't HR / compensation (e.g. a manager allowed to see their line's pay).
    comp_access: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())


class RefreshToken(TimestampMixin, Base):
    __tablename__ = "refresh_tokens"

    jti: Mapped[str] = mapped_column(String(64), primary_key=True)
    account_id: Mapped[str] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime())
    revoked_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    # Session (signed-in device) details, migration 0013. session_id stays the same across refresh rotation.
    session_id: Mapped[str | None] = mapped_column(String(64), index=True)
    session_started_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    last_used_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    ip: Mapped[str | None] = mapped_column(String(64))
    user_agent: Mapped[str | None] = mapped_column(String(300))
