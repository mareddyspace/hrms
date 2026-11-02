"""Comments, "more information" requests and supporting files on any self-service request (migration 0028).

entity_type: expense | travel | cash_advance | encashment | overtime | document. kind: comment | info_request |
info_reply. Files live in storage under requests/<entity_type>/<employee>/ (app/services/storage.py).
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, UTCDateTime, utcnow


class RequestComment(Base):
    __tablename__ = "request_comments"
    __table_args__ = (Index("ix_request_comment_entity", "entity_type", "entity_id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    entity_type: Mapped[str] = mapped_column(String(32))
    entity_id: Mapped[str] = mapped_column(String(64))
    author_id: Mapped[str | None] = mapped_column(String(64))
    author_name: Mapped[str] = mapped_column(String(200))
    kind: Mapped[str] = mapped_column(String(16))
    body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class RequestAttachment(Base):
    __tablename__ = "request_attachments"
    __table_args__ = (Index("ix_request_attachment_entity", "entity_type", "entity_id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    entity_type: Mapped[str] = mapped_column(String(32))
    entity_id: Mapped[str] = mapped_column(String(64))
    purpose: Mapped[str] = mapped_column(String(32))  # supporting | settlement | booking
    employee_id: Mapped[str] = mapped_column(String(64), index=True)
    file_name: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(100))
    size_bytes: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64))
    storage_path: Mapped[str] = mapped_column(String(500))
    uploaded_by: Mapped[str | None] = mapped_column(String(64))
    uploaded_by_name: Mapped[str | None] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
