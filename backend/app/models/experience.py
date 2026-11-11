"""Employee experience records (migration 0037): company assets and asset requests, immigration / ID documents,
privacy consents, data-subject requests and the retention policy.

Each request-like row keeps a `history` list of {at, action, by, by_name, note, status} entries — the status timeline
shown to the requester. Rules live in app/services/experience.py.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy import JSON, Boolean, Date, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, TimestampMixin, UTCDateTime, utcnow


class Asset(TimestampMixin, Base):
    """One company asset (laptop, phone, ID card...). status: in_stock | assigned | in_repair | lost | retired."""

    __tablename__ = "assets"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    tag: Mapped[str] = mapped_column(String(40), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    category: Mapped[str] = mapped_column(String(40), index=True)
    serial_no: Mapped[str | None] = mapped_column(String(80))
    status: Mapped[str] = mapped_column(String(16), index=True)
    employee_id: Mapped[str | None] = mapped_column(ForeignKey("employees.id"), index=True)
    assigned_on: Mapped[date | None] = mapped_column(Date)
    condition: Mapped[str] = mapped_column(String(16), default="Good")
    country_code: Mapped[str | None] = mapped_column(String(2))
    notes: Mapped[str | None] = mapped_column(Text)
    history: Mapped[list[Any] | None] = mapped_column(JSON)


class AssetRequest(TimestampMixin, Base):
    """kind: new (needs the manager, then IT) | repair | lost | return (straight to IT).

    status: Pending manager | Pending IT | Fulfilled | Resolved | Returned | Rejected | Cancelled."""

    __tablename__ = "asset_requests"
    __table_args__ = (Index("ix_asset_request_status", "status"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    kind: Mapped[str] = mapped_column(String(16))
    category: Mapped[str] = mapped_column(String(40))
    item: Mapped[str] = mapped_column(String(120))
    reason: Mapped[str] = mapped_column(Text)
    needed_by: Mapped[date | None] = mapped_column(Date)
    asset_id: Mapped[str | None] = mapped_column(String(64))  # the asset reported / returned / issued
    status: Mapped[str] = mapped_column(String(20))
    manager_id: Mapped[str | None] = mapped_column(String(64))
    decided_by: Mapped[str | None] = mapped_column(String(64))
    decision_note: Mapped[str | None] = mapped_column(Text)
    closed_on: Mapped[date | None] = mapped_column(Date)
    history: Mapped[list[Any] | None] = mapped_column(JSON)


class ImmigrationDocument(TimestampMixin, Base):
    """Passport / visa / work permit / residence ID. verification: pending | verified | rejected."""

    __tablename__ = "immigration_documents"
    __table_args__ = (Index("ix_immigration_document_expiry", "expiry_date"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    doc_type: Mapped[str] = mapped_column(String(40))
    number: Mapped[str] = mapped_column(String(40))
    issuing_country: Mapped[str] = mapped_column(String(80))
    issue_date: Mapped[date] = mapped_column(Date)
    expiry_date: Mapped[date] = mapped_column(Date)
    sponsor: Mapped[str | None] = mapped_column(String(120))
    renewal_in_progress: Mapped[bool] = mapped_column(Boolean, default=False)
    verification: Mapped[str] = mapped_column(String(16), default="pending")
    verification_note: Mapped[str | None] = mapped_column(Text)
    verified_by: Mapped[str | None] = mapped_column(String(64))
    verified_on: Mapped[date | None] = mapped_column(Date)
    updated_by: Mapped[str | None] = mapped_column(String(64))
    history: Mapped[list[Any] | None] = mapped_column(JSON)


class PrivacyConsent(Base):
    """One consent choice (an event log: the latest row per employee and topic is the current choice)."""

    __tablename__ = "privacy_consents"
    __table_args__ = (Index("ix_privacy_consent_person_topic", "employee_id", "topic"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"))
    topic: Mapped[str] = mapped_column(String(40))
    granted: Mapped[bool] = mapped_column(Boolean)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class PrivacyRequest(TimestampMixin, Base):
    """Data-subject request. kind: Access | Correction | Deletion.

    status: Open | In progress | Completed | Closed (manual) | Rejected | Withdrawn."""

    __tablename__ = "privacy_requests"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    kind: Mapped[str] = mapped_column(String(16))
    details: Mapped[str] = mapped_column(Text)
    due_on: Mapped[date] = mapped_column(Date)
    status: Mapped[str] = mapped_column(String(20), index=True)
    handled_by: Mapped[str | None] = mapped_column(String(64))
    closed_on: Mapped[date | None] = mapped_column(Date)
    outcome: Mapped[str | None] = mapped_column(Text)
    history: Mapped[list[Any] | None] = mapped_column(JSON)


class RetentionRule(TimestampMixin, Base):
    __tablename__ = "privacy_retention_rules"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    category: Mapped[str] = mapped_column(String(160), unique=True)
    period: Mapped[int] = mapped_column(Integer)
    unit: Mapped[str] = mapped_column(String(8))  # months | years
    legal_basis: Mapped[str] = mapped_column(String(80))
