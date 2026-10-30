from __future__ import annotations

from datetime import date

from sqlalchemy import Boolean, Date, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, TimestampMixin


class CashAdvance(TimestampMixin, Base):
    """A salary advance (migration 0015), approval type "cash_advance": manager, then finance / HR, then paid out.

    status: Submitted -> Manager approved -> Approved -> Paid (recovered from pay in `instalments` months, starting the
    month after it is paid); or Rejected / Withdrawn.
    """

    __tablename__ = "cash_advances"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    amount: Mapped[float] = mapped_column(Float)
    currency: Mapped[str] = mapped_column(String(8))
    category: Mapped[str] = mapped_column(String(64))
    purpose: Mapped[str] = mapped_column(Text)
    needed_by: Mapped[date] = mapped_column(Date)
    instalments: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[str] = mapped_column(String(32))
    approval_instance_id: Mapped[str | None] = mapped_column(String(64))
    paid_on: Mapped[date | None] = mapped_column(Date)
    paid_by: Mapped[str | None] = mapped_column(String(64))
    reference: Mapped[str | None] = mapped_column(String(64))


class EncashmentRequest(TimestampMixin, Base):
    """Leave days paid out instead of taken (migration 0015), approval type "encashment": manager, then HR.

    status: Submitted -> Manager approved -> Approved (paid with `payout_month` pay); or Rejected / Withdrawn.
    The days count as used leave while pending or approved.
    """

    __tablename__ = "encashment_requests"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    leave_code: Mapped[str] = mapped_column(String(32))
    year: Mapped[int] = mapped_column(Integer)
    days: Mapped[float] = mapped_column(Float)
    per_day: Mapped[float] = mapped_column(Float)
    amount: Mapped[float] = mapped_column(Float)
    currency: Mapped[str] = mapped_column(String(8))
    status: Mapped[str] = mapped_column(String(32))
    approval_instance_id: Mapped[str | None] = mapped_column(String(64))
    payout_month: Mapped[str | None] = mapped_column(String(7))


class SoftwareTitle(TimestampMixin, Base):
    """Company software catalogue (migration 0015). needs_approval False: granted straight away while seats last."""

    __tablename__ = "software_titles"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    category: Mapped[str] = mapped_column(String(64))
    vendor: Mapped[str] = mapped_column(String(120), default="")
    monthly_cost: Mapped[float] = mapped_column(Float, default=0)
    currency: Mapped[str] = mapped_column(String(8), default="USD")
    needs_approval: Mapped[bool] = mapped_column(Boolean, default=True)
    seats: Mapped[int] = mapped_column(Integer, default=0)  # 0 = unlimited
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class SoftwareRequest(TimestampMixin, Base):
    """A request for a licence, and the licence once granted (migration 0015), approval type "software":
    manager, then IT. status: Submitted -> Manager approved -> Active -> Returned / Revoked / Expired; or Rejected /
    Withdrawn. duration_months None = ongoing."""

    __tablename__ = "software_requests"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    title_id: Mapped[str] = mapped_column(ForeignKey("software_titles.id"), index=True)
    reason: Mapped[str] = mapped_column(Text)
    duration_months: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(32))
    approval_instance_id: Mapped[str | None] = mapped_column(String(64))
    assigned_on: Mapped[date | None] = mapped_column(Date)
    expires_on: Mapped[date | None] = mapped_column(Date)
    ended_on: Mapped[date | None] = mapped_column(Date)
    ended_by: Mapped[str | None] = mapped_column(String(64))
    licence_key: Mapped[str | None] = mapped_column(String(64))
    raised_by: Mapped[str | None] = mapped_column(String(64))
