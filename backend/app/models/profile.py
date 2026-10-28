from __future__ import annotations

from datetime import datetime

from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, TimestampMixin, UTCDateTime


class ProfileCorrection(TimestampMixin, Base):
    """An employee's request to change an HR-owned field on their record. HR approval applies the value."""

    __tablename__ = "profile_corrections"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id", ondelete="CASCADE"), index=True)
    field: Mapped[str] = mapped_column(String(32))
    current_value: Mapped[str | None] = mapped_column(Text)
    requested_value: Mapped[str | None] = mapped_column(Text)
    reason: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), index=True)  # pending | approved | rejected | withdrawn
    requested_by: Mapped[str] = mapped_column(String(64))  # account id
    decided_by: Mapped[str | None] = mapped_column(String(64))
    decided_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    decision_note: Mapped[str | None] = mapped_column(Text)
