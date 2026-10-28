from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy import JSON, Date, ForeignKey, Index, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, TimestampMixin, UTCDateTime


class LifecycleAction(TimestampMixin, Base):
    """An employment change (transfer, promotion, ...) with approval type "lifecycle".

    status: submitted -> scheduled (approved, effective later) -> applied; or rejected / withdrawn.
    before/after hold only the fields the action changes (after may also carry informational keys such as
    contract_end_date that have no column on employees).
    """

    __tablename__ = "lifecycle_actions"
    __table_args__ = (Index("ix_lifecycle_status_effective", "status", "effective_date"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    action_type: Mapped[str] = mapped_column(String(32))
    effective_date: Mapped[date] = mapped_column(Date)
    before: Mapped[dict[str, Any]] = mapped_column(JSON)
    after: Mapped[dict[str, Any]] = mapped_column(JSON)
    reason: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16))
    requested_by: Mapped[str] = mapped_column(ForeignKey("employees.id"))
    approval_instance_id: Mapped[str | None] = mapped_column(String(64))
    applied_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
