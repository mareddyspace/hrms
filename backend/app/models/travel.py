from __future__ import annotations

from datetime import date

from sqlalchemy import Date, ForeignKey, Index, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, TimestampMixin


class TravelRequest(TimestampMixin, Base):
    """Pre-approval for a business trip (approval type "travel"). Expense claims can point at an approved trip."""

    __tablename__ = "travel_requests"
    __table_args__ = (Index("ix_travel_employee_start", "employee_id", "start_date"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"))
    purpose: Mapped[str] = mapped_column(Text)
    from_location: Mapped[str] = mapped_column(String(200))
    to_location: Mapped[str] = mapped_column(String(200))
    start_date: Mapped[date] = mapped_column(Date)
    end_date: Mapped[date] = mapped_column(Date)
    mode: Mapped[str] = mapped_column(String(16))  # air | rail | road | sea | other
    estimated_cost: Mapped[float] = mapped_column(Numeric(14, 2, asdecimal=False))
    currency: Mapped[str] = mapped_column(String(3))
    advance_amount: Mapped[float] = mapped_column(Numeric(14, 2, asdecimal=False), default=0)
    status: Mapped[str] = mapped_column(String(16), index=True)  # submitted | approved | rejected | withdrawn
    approval_instance_id: Mapped[str | None] = mapped_column(String(64))
