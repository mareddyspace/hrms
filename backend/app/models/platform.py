"""Admin platform: data scope and page access per account, AI settings, settings, integrations, email outbox,
reminder log. Migration 0006."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy import JSON, Boolean, Date, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, TimestampMixin, UTCDateTime, utcnow


class AccountDataScope(TimestampMixin, Base):
    """Saved data scope for an account (no row = the role default). Read by app/services/data_scope.py."""

    __tablename__ = "account_data_scopes"

    account_id: Mapped[str] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True)
    scope: Mapped[str] = mapped_column(String(16))  # own | direct | line | department | country | entity | business_unit | location | global
    country_codes: Mapped[list[str]] = mapped_column(JSON, default=list)  # HR only; empty = no country limit
    updated_by: Mapped[str | None] = mapped_column(String(64))


class PageAccessOverride(TimestampMixin, Base):
    """Pages granted / revoked for one account on top of its role's default pages."""

    __tablename__ = "page_access_overrides"

    account_id: Mapped[str] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True)
    grant_pages: Mapped[list[str]] = mapped_column(JSON, default=list)
    revoke_pages: Mapped[list[str]] = mapped_column(JSON, default=list)
    updated_by: Mapped[str | None] = mapped_column(String(64))


class AiSetting(TimestampMixin, Base):
    """Single row (id "default"). Stored as "off" lists so new policies / agents / features start on."""

    __tablename__ = "ai_settings"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    disabled_policies: Mapped[list[str]] = mapped_column(JSON, default=list)
    disabled_agents: Mapped[list[str]] = mapped_column(JSON, default=list)
    disabled_features: Mapped[list[str]] = mapped_column(JSON, default=list)
    updated_by: Mapped[str | None] = mapped_column(String(64))


class PlatformSetting(TimestampMixin, Base):
    """Key / JSON value settings (case_retention_years, posh_committee, ...)."""

    __tablename__ = "platform_settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON)
    updated_by: Mapped[str | None] = mapped_column(String(64))


class IntegrationConnector(TimestampMixin, Base):
    __tablename__ = "integration_connectors"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    category: Mapped[str] = mapped_column(String(64), default="")
    status: Mapped[str] = mapped_column(String(32))  # Connected | Degraded | Disconnected | Not configured
    schedule: Mapped[str] = mapped_column(String(16), default="hourly")  # 15m | hourly | daily | manual
    last_sync_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    run_count: Mapped[int] = mapped_column(Integer, default=0)
    records_processed: Mapped[int] = mapped_column(Integer, default=0)
    success_count: Mapped[int] = mapped_column(Integer, default=0)
    failed_count: Mapped[int] = mapped_column(Integer, default=0)


class IntegrationRun(Base):
    __tablename__ = "integration_runs"
    __table_args__ = (Index("ix_integration_run_connector_at", "connector_id", "started_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    connector_id: Mapped[str] = mapped_column(ForeignKey("integration_connectors.id", ondelete="CASCADE"))
    started_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    trigger: Mapped[str] = mapped_column(String(16))  # manual | schedule
    processed: Mapped[int] = mapped_column(Integer)
    succeeded: Mapped[int] = mapped_column(Integer)
    failed: Mapped[int] = mapped_column(Integer)
    run_by: Mapped[str | None] = mapped_column(String(64))


class IntegrationQuarantine(TimestampMixin, Base):
    """A record a sync rejected. status: open | resolved (retry/fix passed) | dismissed."""

    __tablename__ = "integration_quarantine"
    __table_args__ = (Index("ix_quarantine_connector_status", "connector_id", "status"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    connector_id: Mapped[str] = mapped_column(ForeignKey("integration_connectors.id", ondelete="CASCADE"))
    run_id: Mapped[int | None] = mapped_column(ForeignKey("integration_runs.id", ondelete="SET NULL"))
    record: Mapped[str] = mapped_column(String(200))
    field: Mapped[str] = mapped_column(String(32))  # bankAccount | taxId | costCentre | workEmail
    value: Mapped[str] = mapped_column(String(200), default="")
    reason: Mapped[str] = mapped_column(String(200))
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(16), default="open")
    resolved_by: Mapped[str | None] = mapped_column(String(64))
    resolved_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    resolution_note: Mapped[str | None] = mapped_column(Text)


class EmailChannelSwitch(TimestampMixin, Base):
    """Admin switch per notification channel (approvals, announcements, learning, integrations)."""

    __tablename__ = "email_channel_switches"

    channel: Mapped[str] = mapped_column(String(32), primary_key=True)
    label: Mapped[str] = mapped_column(String(100))
    description: Mapped[str] = mapped_column(String(255), default="")
    email: Mapped[bool] = mapped_column(Boolean, default=True)
    updated_by: Mapped[str | None] = mapped_column(String(64))


class EmailOutboxItem(Base):
    """Email queued alongside an in-app notification. Nothing is sent by the API: an admin (or a relay) marks it sent."""

    __tablename__ = "email_outbox"
    __table_args__ = (Index("ix_email_outbox_status_created", "status", "created_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    notification_id: Mapped[int | None] = mapped_column(Integer)
    recipient_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    to_email: Mapped[str] = mapped_column(String(255))
    subject: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(Text, default="")
    link: Mapped[str | None] = mapped_column(String(500))
    category: Mapped[str] = mapped_column(String(32))
    channel: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(16), default="Queued")  # Queued | Sent
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    sent_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    sent_by: Mapped[str | None] = mapped_column(String(64))


class ReminderLog(Base):
    """One row per reminder sent, so an item is reminded at most once per day per recipient."""

    __tablename__ = "reminder_log"
    __table_args__ = (UniqueConstraint("item_key", "recipient_id", "sent_on", name="uq_reminder_item_recipient_day"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    item_key: Mapped[str] = mapped_column(String(128), index=True)
    recipient_id: Mapped[str] = mapped_column(String(64))
    sent_on: Mapped[date] = mapped_column(Date)
    kind: Mapped[str] = mapped_column(String(32))  # approval_reminder | sla_escalation | posh_deadline
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
