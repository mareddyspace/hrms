from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import Boolean, Date, ForeignKey, Index, Numeric, String, Text, UniqueConstraint
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


class ProjectMember(TimestampMixin, Base):
    __tablename__ = "project_members"

    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id", ondelete="CASCADE"), primary_key=True, index=True)
    role: Mapped[str] = mapped_column(String(64), default="member")


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
