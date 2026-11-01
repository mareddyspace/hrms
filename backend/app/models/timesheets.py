from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import Boolean, Date, ForeignKey, Index, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, TimestampMixin, UTCDateTime


class Project(TimestampMixin, Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True)
    name: Mapped[str] = mapped_column(String(200))
    client: Mapped[str | None] = mapped_column(String(200))
    billable_default: Mapped[bool] = mapped_column(Boolean, default=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    # Project details (migration 0025): what it is, when it runs, the hours budget and who runs it.
    description: Mapped[str | None] = mapped_column(Text)
    start_date: Mapped[date | None] = mapped_column(Date)
    end_date: Mapped[date | None] = mapped_column(Date)
    budget_hours: Mapped[float | None] = mapped_column(Numeric(8, 2, asdecimal=False))
    manager_id: Mapped[str | None] = mapped_column(String(64))  # employees.id


class ProjectMember(TimestampMixin, Base):
    __tablename__ = "project_members"

    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id", ondelete="CASCADE"), primary_key=True, index=True)
    role: Mapped[str] = mapped_column(String(64), default="member")
    # Migration 0025: the person's job on the project, what they look after and their hours budget.
    title: Mapped[str | None] = mapped_column(String(100))
    responsibilities: Mapped[str | None] = mapped_column(Text)
    budget_hours: Mapped[float | None] = mapped_column(Numeric(8, 2, asdecimal=False))


class TimesheetWeek(TimestampMixin, Base):
    __tablename__ = "timesheet_weeks"
    __table_args__ = (UniqueConstraint("employee_id", "week_start", name="uq_timesheet_week_employee_start"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    week_start: Mapped[date] = mapped_column(Date)  # Monday
    status: Mapped[str] = mapped_column(String(16), index=True)  # draft | submitted | approved | rejected
    submitted_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    decided_by: Mapped[str | None] = mapped_column(ForeignKey("employees.id"))
    decided_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    decision_note: Mapped[str | None] = mapped_column(Text)


class TimesheetEntry(TimestampMixin, Base):
    __tablename__ = "timesheet_entries"
    __table_args__ = (Index("ix_timesheet_entry_employee_date", "employee_id", "work_date"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"))
    week_id: Mapped[str] = mapped_column(ForeignKey("timesheet_weeks.id"), index=True)
    work_date: Mapped[date] = mapped_column(Date)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    task: Mapped[str] = mapped_column(String(200))
    hours: Mapped[float] = mapped_column(Numeric(5, 2, asdecimal=False))
    billable: Mapped[bool] = mapped_column(Boolean, default=True)
    comment: Mapped[str | None] = mapped_column(Text)
    # Migration 0025: when the block ran (minutes after midnight), the break inside it and what it was for.
    start_minute: Mapped[int | None] = mapped_column(Integer)
    break_minutes: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    work_type: Mapped[str | None] = mapped_column(String(16))  # project | ticket | task
    work_id: Mapped[str | None] = mapped_column(String(64))
    work_label: Mapped[str | None] = mapped_column(String(200))


class TimesheetDay(TimestampMixin, Base):
    """One person's day of time, submitted on its own for approval (daily timesheets).

    No row = draft. submitted -> approved | rejected (sent back: can be corrected and submitted again later)."""

    __tablename__ = "timesheet_days"
    __table_args__ = (UniqueConstraint("employee_id", "work_date", name="uq_timesheet_day_employee_date"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    work_date: Mapped[date] = mapped_column(Date, index=True)
    status: Mapped[str] = mapped_column(String(16), index=True)  # draft | submitted | approved | rejected
    submitted_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    decided_by: Mapped[str | None] = mapped_column(ForeignKey("employees.id"))
    decided_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    decision_note: Mapped[str | None] = mapped_column(Text)
