from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy import JSON, Boolean, Date, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, TimestampMixin, UTCDateTime


class ExitCase(TimestampMixin, Base):
    """A resignation, termination, retirement or end of contract (migration 0014), approval type "exit".

    status: Submitted -> Manager approved -> Approved -> Completed (after the last working day);
    or Withdrawn / Rejected. clearance: [{key, label, owner, done, done_by, done_on}];
    interview (private to HR): {rating, reasons, would_return, comments, submitted_on};
    settlement: {status: Pending | In progress | Paid, unused_leave_days (frozen at completion), updated_by, updated_on}.
    """

    __tablename__ = "exit_cases"
    __table_args__ = (Index("ix_exit_cases_status_lwd", "status", "approved_last_working_day"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    exit_type: Mapped[str] = mapped_column(String(32))  # resignation | termination | retirement | end_of_contract
    submitted_on: Mapped[date] = mapped_column(Date)
    requested_last_day: Mapped[date] = mapped_column(Date)
    standard_last_day: Mapped[date] = mapped_column(Date)  # submitted_on + notice_days
    approved_last_working_day: Mapped[date | None] = mapped_column(Date)
    notice_days: Mapped[int] = mapped_column(Integer)
    early_release: Mapped[bool] = mapped_column(Boolean, default=False)
    early_release_approved: Mapped[bool | None] = mapped_column(Boolean)
    reason: Mapped[str] = mapped_column(Text)
    note: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(32))
    raised_by: Mapped[str] = mapped_column(ForeignKey("employees.id"))
    approval_instance_id: Mapped[str | None] = mapped_column(String(64))
    clearance: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    interview: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    settlement: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
