"""Work tickets (IT support, HR query, bug, client issue, access request) shared between people. Migration 0020.

Not the HR helpdesk (desk_tickets). People ids are plain strings: owners and task owners can be engineering teammates
who are directory-only in the portal (see app/services/tickets.py TEAMMATES), so there is no foreign key on them.
"""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import JSON, Boolean, Date, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base, TimestampMixin, UTCDateTime, utcnow


class Ticket(TimestampMixin, Base):
    __tablename__ = "tickets"
    __table_args__ = (Index("ix_ticket_assignee_status", "assignee_id", "status"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True)  # TCK-1043
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    type: Mapped[str] = mapped_column(String(32), index=True)  # IT support | HR query | Bug | Client issue | Access request
    priority: Mapped[str] = mapped_column(String(16))  # low | medium | high | urgent
    status: Mapped[str] = mapped_column(String(16), index=True)  # Open | In progress | Waiting | Resolved | Closed
    project_id: Mapped[str | None] = mapped_column(String(64))
    project_name: Mapped[str | None] = mapped_column(String(200))
    requester_id: Mapped[str] = mapped_column(String(64), index=True)
    assignee_id: Mapped[str | None] = mapped_column(String(64))  # the owner
    sub_owner_id: Mapped[str | None] = mapped_column(String(64))
    watcher_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    due: Mapped[date | None] = mapped_column(Date)

    tasks: Mapped[list[TicketTask]] = relationship(
        back_populates="ticket", cascade="all, delete-orphan", order_by="TicketTask.position"
    )
    events: Mapped[list[TicketEvent]] = relationship(
        back_populates="ticket", cascade="all, delete-orphan", order_by="TicketEvent.id"
    )


class TicketTask(Base):
    __tablename__ = "ticket_tasks"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    ticket_id: Mapped[str] = mapped_column(ForeignKey("tickets.id", ondelete="CASCADE"), index=True)
    position: Mapped[int] = mapped_column(Integer, default=0)
    title: Mapped[str] = mapped_column(String(200))
    owner_id: Mapped[str | None] = mapped_column(String(64), index=True)
    due: Mapped[date | None] = mapped_column(Date)
    done: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)

    ticket: Mapped[Ticket] = relationship(back_populates="tasks")


class TicketEvent(Base):
    __tablename__ = "ticket_events"
    __table_args__ = (Index("ix_ticket_event_ticket_at", "ticket_id", "at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ticket_id: Mapped[str] = mapped_column(ForeignKey("tickets.id", ondelete="CASCADE"))
    at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    by_id: Mapped[str] = mapped_column(String(64))
    kind: Mapped[str] = mapped_column(String(16))  # created | assigned | status | comment | watcher | task
    text: Mapped[str] = mapped_column(Text)

    ticket: Mapped[Ticket] = relationship(back_populates="events")
