from __future__ import annotations

from datetime import date

from sqlalchemy import Date, ForeignKey, Index, Integer, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, TimestampMixin


class ExpenseClaim(TimestampMixin, Base):
    """One reimbursement claim (approval type "expense")."""

    __tablename__ = "expense_claims"
    __table_args__ = (Index("ix_expense_employee_date", "employee_id", "expense_date"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"))
    category: Mapped[str] = mapped_column(String(32))
    amount: Mapped[float] = mapped_column(Numeric(14, 2, asdecimal=False))
    currency: Mapped[str] = mapped_column(String(3))
    expense_date: Mapped[date] = mapped_column(Date)
    description: Mapped[str] = mapped_column(Text)
    trip_id: Mapped[str | None] = mapped_column(ForeignKey("travel_requests.id"), index=True)
    status: Mapped[str] = mapped_column(String(16), index=True)  # submitted | approved | rejected | withdrawn | paid
    approval_instance_id: Mapped[str | None] = mapped_column(String(64))
    paid_on: Mapped[date | None] = mapped_column(Date)
    payment_reference: Mapped[str | None] = mapped_column(String(100))
    paid_by: Mapped[str | None] = mapped_column(String(64))


class ExpenseReceipt(TimestampMixin, Base):
    """A receipt file on local disk (STORAGE_DIR/receipts/...). claim_id is NULL until attached to a claim."""

    __tablename__ = "expense_receipts"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    claim_id: Mapped[str | None] = mapped_column(ForeignKey("expense_claims.id", ondelete="CASCADE"), index=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    file_name: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(100))
    size_bytes: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    storage_path: Mapped[str] = mapped_column(String(500))  # relative to STORAGE_DIR, forward slashes
    uploaded_by: Mapped[str | None] = mapped_column(String(64))
