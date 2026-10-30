"""Shared collaboration records (migration 0022): chat, in-portal mail, tasks, announcements and calendar events.

Until 0022 these lived only in each browser. People ids are plain strings (no foreign key) because chat members and
task owners can be engineering teammates who are directory-only in the portal (app/services/tickets.py TEAMMATES).
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy import JSON, Boolean, Date, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base, TimestampMixin, UTCDateTime, utcnow


# ---------- chat ----------

class ChatConversation(TimestampMixin, Base):
    __tablename__ = "chat_conversations"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    kind: Mapped[str] = mapped_column(String(8))  # direct | group
    title: Mapped[str] = mapped_column(String(200))
    restricted: Mapped[str | None] = mapped_column(String(24))  # hr_confidential | compensation
    created_by: Mapped[str] = mapped_column(String(64))

    members: Mapped[list[ChatMember]] = relationship(back_populates="conversation", cascade="all, delete-orphan",
                                                     order_by="ChatMember.id")
    messages: Mapped[list[ChatMessage]] = relationship(back_populates="conversation", cascade="all, delete-orphan",
                                                       order_by="ChatMessage.at")


class ChatMember(Base):
    __tablename__ = "chat_members"
    __table_args__ = (UniqueConstraint("conversation_id", "person_id", name="uq_chat_member"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    conversation_id: Mapped[str] = mapped_column(ForeignKey("chat_conversations.id", ondelete="CASCADE"), index=True)
    person_id: Mapped[str] = mapped_column(String(64), index=True)
    name: Mapped[str] = mapped_column(String(200))
    last_read_at: Mapped[datetime | None] = mapped_column(UTCDateTime())

    conversation: Mapped[ChatConversation] = relationship(back_populates="members")


class ChatMessage(Base):
    __tablename__ = "chat_messages"
    __table_args__ = (Index("ix_chat_message_conv_at", "conversation_id", "at"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(ForeignKey("chat_conversations.id", ondelete="CASCADE"))
    from_id: Mapped[str] = mapped_column(String(64))
    from_name: Mapped[str] = mapped_column(String(200))
    text: Mapped[str] = mapped_column(Text)
    attachment_name: Mapped[str | None] = mapped_column(String(200))
    at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)

    conversation: Mapped[ChatConversation] = relationship(back_populates="messages")


# ---------- mail ----------

class MailMessage(Base):
    __tablename__ = "mail_messages"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    thread_id: Mapped[str] = mapped_column(String(64), index=True)
    from_id: Mapped[str] = mapped_column(String(64), index=True)
    from_name: Mapped[str] = mapped_column(String(200))
    subject: Mapped[str] = mapped_column(String(300))
    body: Mapped[str] = mapped_column(Text)
    category: Mapped[str | None] = mapped_column(String(32))
    sent_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)

    recipients: Mapped[list[MailRecipient]] = relationship(back_populates="message", cascade="all, delete-orphan",
                                                           order_by="MailRecipient.id")


class MailRecipient(Base):
    __tablename__ = "mail_recipients"
    __table_args__ = (UniqueConstraint("message_id", "person_id", name="uq_mail_recipient"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    message_id: Mapped[str] = mapped_column(ForeignKey("mail_messages.id", ondelete="CASCADE"), index=True)
    person_id: Mapped[str] = mapped_column(String(64), index=True)
    kind: Mapped[str] = mapped_column(String(4))  # to | cc
    read_at: Mapped[datetime | None] = mapped_column(UTCDateTime())

    message: Mapped[MailMessage] = relationship(back_populates="recipients")


# ---------- tasks ----------

class SharedTask(TimestampMixin, Base):
    """A portal task (src/model.ts Task) kept as a JSON document; the columns are what access checks need."""

    __tablename__ = "shared_tasks"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    code: Mapped[str] = mapped_column(String(32))
    assignee_id: Mapped[str] = mapped_column(String(64), index=True)
    created_by: Mapped[str] = mapped_column(String(64), index=True)
    people_ids: Mapped[list[str]] = mapped_column(JSON, default=list)  # extra people and cc
    status: Mapped[str] = mapped_column(String(16))
    due: Mapped[date | None] = mapped_column(Date)
    data: Mapped[dict[str, Any]] = mapped_column(JSON)
    version: Mapped[int] = mapped_column(Integer, default=1)


# ---------- announcements ----------

class Announcement(TimestampMixin, Base):
    __tablename__ = "announcements"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(Text)
    scope: Mapped[str] = mapped_column(String(16))  # Company | Country | Department | Team
    audience: Mapped[str] = mapped_column(String(120))  # country code or name, department, team label
    state: Mapped[str] = mapped_column(String(16), index=True)  # Draft | Scheduled | Published
    published_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    scheduled_for: Mapped[datetime | None] = mapped_column(UTCDateTime())
    author_id: Mapped[str | None] = mapped_column(String(64))
    author_name: Mapped[str] = mapped_column(String(200))
    must_acknowledge: Mapped[bool] = mapped_column(Boolean, default=False)

    reads: Mapped[list[AnnouncementRead]] = relationship(back_populates="announcement", cascade="all, delete-orphan")


class AnnouncementRead(Base):
    __tablename__ = "announcement_reads"
    __table_args__ = (UniqueConstraint("announcement_id", "person_id", name="uq_announcement_read"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    announcement_id: Mapped[str] = mapped_column(ForeignKey("announcements.id", ondelete="CASCADE"), index=True)
    person_id: Mapped[str] = mapped_column(String(64), index=True)
    read_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    acknowledged_at: Mapped[datetime | None] = mapped_column(UTCDateTime())

    announcement: Mapped[Announcement] = relationship(back_populates="reads")


# ---------- calendar ----------

class CalendarEvent(TimestampMixin, Base):
    __tablename__ = "calendar_events"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    kind: Mapped[str] = mapped_column(String(16))  # reminder | meeting
    title: Mapped[str] = mapped_column(String(200))
    day: Mapped[date] = mapped_column(Date, index=True)
    time: Mapped[str | None] = mapped_column(String(5))
    location: Mapped[str | None] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text)
    owner_id: Mapped[str] = mapped_column(String(64), index=True)

    attendees: Mapped[list[CalendarAttendee]] = relationship(back_populates="event", cascade="all, delete-orphan",
                                                             order_by="CalendarAttendee.id")


class CalendarAttendee(Base):
    __tablename__ = "calendar_attendees"
    __table_args__ = (UniqueConstraint("event_id", "person_id", name="uq_calendar_attendee"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    event_id: Mapped[str] = mapped_column(ForeignKey("calendar_events.id", ondelete="CASCADE"), index=True)
    person_id: Mapped[str] = mapped_column(String(64), index=True)
    response: Mapped[str] = mapped_column(String(12), default="pending")  # pending | accepted | declined

    event: Mapped[CalendarEvent] = relationship(back_populates="attendees")
