"""Tax-saving declarations with proofs, verified by Finance / HR (migration 0026).

tax_declaration_windows: per country + financial year, when declarations open and the deadline for them (and for
proofs). tax_declarations: one item per section (80C, 80D, ... or the country's reliefs) with an amount and status
draft -> submitted -> verified | rejected (rejected items can be corrected and sent again). Proof files sit in
storage (app/services/storage.py) and are listed in tax_declaration_documents.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy import JSON, Boolean, Date, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, TimestampMixin, UTCDateTime, utcnow


class TaxDeclarationWindow(TimestampMixin, Base):
    __tablename__ = "tax_declaration_windows"
    __table_args__ = (UniqueConstraint("country_code", "financial_year", name="uq_tax_decl_window"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    country_code: Mapped[str] = mapped_column(String(2), index=True)
    financial_year: Mapped[str] = mapped_column(String(32))
    opens_on: Mapped[date] = mapped_column(Date)
    deadline: Mapped[date] = mapped_column(Date)  # last day to add, change or submit declarations
    proof_deadline: Mapped[date | None] = mapped_column(Date)
    locked: Mapped[bool] = mapped_column(Boolean, default=False)  # Finance closed the year early
    updated_by: Mapped[str | None] = mapped_column(String(64))


class TaxDeclaration(TimestampMixin, Base):
    __tablename__ = "tax_declarations"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    country_code: Mapped[str] = mapped_column(String(2), index=True)
    financial_year: Mapped[str] = mapped_column(String(32), index=True)
    regime: Mapped[str | None] = mapped_column(String(8))  # India: regime when last submitted
    section: Mapped[str] = mapped_column(String(32))
    title: Mapped[str] = mapped_column(String(200))
    amount: Mapped[float] = mapped_column(Numeric(14, 2, asdecimal=False))
    verified_amount: Mapped[float | None] = mapped_column(Numeric(14, 2, asdecimal=False))
    currency: Mapped[str] = mapped_column(String(3))
    status: Mapped[str] = mapped_column(String(16), index=True)  # draft | submitted | verified | rejected
    employee_note: Mapped[str | None] = mapped_column(Text)
    submitted_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    decided_by: Mapped[str | None] = mapped_column(String(64))
    decided_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    decision_note: Mapped[str | None] = mapped_column(Text)
    # [{at, by, action, note}] newest last; no amounts are written here twice (the row has them).
    history: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)


class TaxDeclarationDocument(Base):
    __tablename__ = "tax_declaration_documents"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    declaration_id: Mapped[str] = mapped_column(ForeignKey("tax_declarations.id", ondelete="CASCADE"), index=True)
    file_name: Mapped[str] = mapped_column(String(200))
    content_type: Mapped[str] = mapped_column(String(100))
    size_bytes: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64))
    storage_path: Mapped[str] = mapped_column(String(300))
    uploaded_by: Mapped[str | None] = mapped_column(String(64))
    uploaded_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
