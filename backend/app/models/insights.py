"""Leadership insights: saved reports (server-side report builder) and contract extension requests (migration 0038)."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy import JSON, Boolean, Date, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, TimestampMixin, UTCDateTime


class SavedReport(TimestampMixin, Base):
    """A report definition (source, columns, filters, grouping) saved by its owner; optionally shared with HR."""

    __tablename__ = "saved_reports"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    source: Mapped[str] = mapped_column(String(32))
    columns: Mapped[list[str]] = mapped_column(JSON, default=list)
    filters: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    group_by: Mapped[str | None] = mapped_column(String(64))
    shared: Mapped[bool] = mapped_column(Boolean, default=False)


class ContractExtension(TimestampMixin, Base):
    """A request to extend a contractor's contract end date: raised by the manager or HR, decided by HR with a comment."""

    __tablename__ = "contract_extensions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    requested_by: Mapped[str] = mapped_column(ForeignKey("employees.id"))
    current_end: Mapped[date | None] = mapped_column(Date)
    new_end: Mapped[date] = mapped_column(Date)
    reason: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), default="pending")  # pending | approved | rejected | withdrawn
    decided_by: Mapped[str | None] = mapped_column(ForeignKey("employees.id"))
    decided_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    decision_comment: Mapped[str | None] = mapped_column(Text)
