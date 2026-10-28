"""HR service desk tickets with category routing and SLA. Migration 0006."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, TimestampMixin, UTCDateTime, utcnow


class DeskTicket(TimestampMixin, Base):
    __tablename__ = "desk_tickets"
    __table_args__ = (Index("ix_desk_ticket_status_due", "status", "due_at"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    requester_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    category: Mapped[str] = mapped_column(String(32), index=True)
    subject: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text)
    priority: Mapped[str] = mapped_column(String(16), default="Normal")  # Low | Normal | High | Urgent
    status: Mapped[str] = mapped_column(String(16), index=True)  # Open | In progress | Waiting on you | Resolved | Closed
    assignee_id: Mapped[str | None] = mapped_column(ForeignKey("employees.id"), index=True)  # NULL = unassigned
    submitted_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    due_at: Mapped[datetime] = mapped_column(UTCDateTime())
    first_response_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    resolved_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    escalated_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    escalation_level: Mapped[int] = mapped_column(Integer, default=0)
    satisfaction: Mapped[int | None] = mapped_column(Integer)  # 1-5, from the requester once resolved
    satisfaction_comment: Mapped[str | None] = mapped_column(Text)


class DeskTicketComment(Base):
    __tablename__ = "desk_ticket_comments"
    __table_args__ = (Index("ix_desk_comment_ticket_at", "ticket_id", "created_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ticket_id: Mapped[str] = mapped_column(ForeignKey("desk_tickets.id", ondelete="CASCADE"))
    author_id: Mapped[str | None] = mapped_column(String(64))
    text: Mapped[str] = mapped_column(Text)
    system: Mapped[bool] = mapped_column(Boolean, default=False)  # routing / status lines written by the system
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class DeskTicketFile(TimestampMixin, Base):
    __tablename__ = "desk_ticket_files"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    ticket_id: Mapped[str] = mapped_column(ForeignKey("desk_tickets.id", ondelete="CASCADE"), index=True)
    uploaded_by: Mapped[str | None] = mapped_column(String(64))
    file_name: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(100))
    size_bytes: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64))
    storage_path: Mapped[str] = mapped_column(String(500))
