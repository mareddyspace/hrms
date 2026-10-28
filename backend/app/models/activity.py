from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, UTCDateTime, utcnow


class AuditLog(Base):
    __tablename__ = "audit_log"
    __table_args__ = (Index("ix_audit_entity", "entity", "entity_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    actor_id: Mapped[str | None] = mapped_column(String(64), index=True)
    action: Mapped[str] = mapped_column(String(64))
    entity: Mapped[str] = mapped_column(String(64))
    entity_id: Mapped[str | None] = mapped_column(String(64))
    subject_id: Mapped[str | None] = mapped_column(String(64), index=True)
    changes: Mapped[dict[str, Any] | None] = mapped_column(JSON)  # {"before": {...}, "after": {...}}
    at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, index=True)
    ip: Mapped[str | None] = mapped_column(String(64))
    # Sign-in events (migration 0013): success | failure, and the browser that made the request.
    result: Mapped[str | None] = mapped_column(String(16))
    user_agent: Mapped[str | None] = mapped_column(String(300))


class Notification(Base):
    __tablename__ = "notifications"
    __table_args__ = (Index("ix_notification_recipient_created", "recipient_id", "created_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    recipient_id: Mapped[str] = mapped_column(ForeignKey("employees.id"))
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(Text, default="")
    href: Mapped[str | None] = mapped_column(String(500))
    read_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
