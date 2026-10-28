from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Boolean, ForeignKey, Index, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, TimestampMixin, UTCDateTime, utcnow


class WorkflowDefinition(TimestampMixin, Base):
    """Versioned approval chain for one request type. Editing creates a new version; instances keep a snapshot.

    steps: [{"roles": ["manager", "hr"], "mode": "all" | "any", "min_amount": 1000 | null, "label": str | null,
             "sla_hours": 48 | null, "condition": {"field": "country" | "department" | "grade", "values": [...]} | null,
             "only_if": "needs_hr" | null}, ...]
    """

    __tablename__ = "workflow_definitions"
    __table_args__ = (UniqueConstraint("type", "version", name="uq_workflow_type_version"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    type: Mapped[str] = mapped_column(String(64), index=True)
    version: Mapped[int] = mapped_column(Integer)
    steps: Mapped[list[dict[str, Any]]] = mapped_column(JSON)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_by: Mapped[str | None] = mapped_column(String(64))


class ApprovalInstance(TimestampMixin, Base):
    __tablename__ = "approval_instances"
    __table_args__ = (Index("ix_approval_type_entity", "type", "entity_id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    type: Mapped[str] = mapped_column(String(64))
    entity_id: Mapped[str] = mapped_column(String(64))
    requester_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    amount: Mapped[float | None] = mapped_column(Numeric(14, 2, asdecimal=False))
    workflow_version: Mapped[int | None] = mapped_column(Integer)
    # Resolved at start: [{"roles", "mode", "min_amount", "skipped", "groups": {"manager": ["emp-ram"], ...}}]
    steps: Mapped[list[dict[str, Any]]] = mapped_column(JSON)
    current_step: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(16), index=True)  # pending | approved | rejected | cancelled
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime())


class ApprovalDecision(Base):
    __tablename__ = "approval_decisions"
    __table_args__ = (Index("ix_approval_decision_instance_step", "instance_id", "step"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    instance_id: Mapped[str] = mapped_column(ForeignKey("approval_instances.id", ondelete="CASCADE"))
    step: Mapped[int] = mapped_column(Integer)
    group: Mapped[str] = mapped_column(String(32))
    approver_id: Mapped[str] = mapped_column(ForeignKey("employees.id"))
    decision: Mapped[str] = mapped_column(String(16))  # approve | reject
    note: Mapped[str | None] = mapped_column(Text)
    # set when a delegate decided for the named approver (migration 0009)
    on_behalf_of: Mapped[str | None] = mapped_column(String(64))
    at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
