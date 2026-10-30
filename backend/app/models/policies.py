"""Policies HR writes and publishes in the portal (migration 0018): versions, audience, acknowledgement.

Acknowledgements are policy_acknowledgments rows (policy_version = the version number as text, e.g. "2").
A policy with the same id as a built-in library policy (src/data/policyLibrary.ts) replaces it once published.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy import JSON, Boolean, Date, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, TimestampMixin, UTCDateTime, utcnow


class HrPolicy(TimestampMixin, Base):
    """status: draft (never published) | published | archived. current_version = the latest published version."""

    __tablename__ = "hr_policies"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    title: Mapped[str] = mapped_column(String(200))
    category: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(16), index=True, default="draft")
    audience_type: Mapped[str] = mapped_column(String(16), default="all")  # all | country | department
    audience_values: Mapped[list[str]] = mapped_column(JSON, default=list)
    requires_ack: Mapped[bool] = mapped_column(Boolean, default=True)
    current_version: Mapped[int] = mapped_column(Integer, default=0)
    created_by: Mapped[str | None] = mapped_column(String(64))
    updated_by: Mapped[str | None] = mapped_column(String(64))


class HrPolicyVersion(Base):
    """One version of a policy. status: draft (at most one, the next version) | published."""

    __tablename__ = "hr_policy_versions"
    __table_args__ = (UniqueConstraint("policy_id", "version", name="uq_hr_policy_version"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    policy_id: Mapped[str] = mapped_column(ForeignKey("hr_policies.id", ondelete="CASCADE"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16), default="draft")
    summary: Mapped[str] = mapped_column(Text, default="")
    sections: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)  # [{heading, rules: [str]}]
    change_summary: Mapped[str] = mapped_column(Text, default="")
    effective_date: Mapped[date | None] = mapped_column(Date)
    published_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    published_by: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
