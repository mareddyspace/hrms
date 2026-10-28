from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import Boolean, Date, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, TimestampMixin, UTCDateTime


class AttendanceSession(TimestampMixin, Base):
    """One working day for one person. work_date is the date in the person's time zone; times are UTC."""

    __tablename__ = "attendance_sessions"
    __table_args__ = (UniqueConstraint("employee_id", "work_date", name="uq_attendance_employee_date"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    work_date: Mapped[date] = mapped_column(Date, index=True)
    time_zone: Mapped[str] = mapped_column(String(64))
    check_in: Mapped[datetime] = mapped_column(UTCDateTime())
    check_out: Mapped[datetime | None] = mapped_column(UTCDateTime())
    break_minutes: Mapped[int] = mapped_column(Integer, default=0)
    worked_minutes: Mapped[int | None] = mapped_column(Integer)
    work_mode: Mapped[str] = mapped_column(String(16), default="office")  # office | wfh | remote
    source: Mapped[str] = mapped_column(String(16), default="web")  # web | mobile | device
    shift_start: Mapped[str] = mapped_column(String(5))  # "HH:MM" local, snapshot at check-in
    shift_end: Mapped[str] = mapped_column(String(5))
    is_late: Mapped[bool] = mapped_column(Boolean, default=False)
    late_minutes: Mapped[int] = mapped_column(Integer, default=0)
    is_early_leave: Mapped[bool] = mapped_column(Boolean, default=False)
    early_minutes: Mapped[int] = mapped_column(Integer, default=0)
    corrected: Mapped[bool] = mapped_column(Boolean, default=False)
    note: Mapped[str | None] = mapped_column(Text)


class AttendanceCorrection(TimestampMixin, Base):
    __tablename__ = "attendance_corrections"
    __table_args__ = (Index("ix_correction_employee_date", "employee_id", "work_date"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"))
    work_date: Mapped[date] = mapped_column(Date)
    session_id: Mapped[str | None] = mapped_column(ForeignKey("attendance_sessions.id"))
    requested_check_in: Mapped[datetime | None] = mapped_column(UTCDateTime())
    requested_check_out: Mapped[datetime | None] = mapped_column(UTCDateTime())
    reason: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), index=True)  # pending | approved | rejected
    decided_by: Mapped[str | None] = mapped_column(ForeignKey("employees.id"))
    decided_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    decision_note: Mapped[str | None] = mapped_column(Text)
