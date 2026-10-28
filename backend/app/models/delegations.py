"""Approval delegation: someone who decides requests hands that authority to a colleague for a date window."""

from __future__ import annotations

from datetime import date

from sqlalchemy import JSON, Boolean, Date, ForeignKey, Index, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, TimestampMixin


class ApprovalDelegation(TimestampMixin, Base):
    """types: approval types handed over (e.g. ["leave", "expense"], "other" = every other type); NULL = all."""

    __tablename__ = "delegations"
    __table_args__ = (Index("ix_delegations_delegate_window", "delegate_id", "starts_on", "ends_on"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    delegator_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    delegate_id: Mapped[str] = mapped_column(ForeignKey("employees.id"))
    starts_on: Mapped[date] = mapped_column(Date)
    ends_on: Mapped[date] = mapped_column(Date)
    types: Mapped[list[str] | None] = mapped_column(JSON)
    note: Mapped[str | None] = mapped_column(Text)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_by: Mapped[str | None] = mapped_column(String(64))

