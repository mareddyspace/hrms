"""Audit trail and in-app notifications."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy.orm import Session

from app.models import AuditLog, Notification


def _jsonable(value: Any) -> Any:
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    return value


def record_audit(
    db: Session,
    *,
    actor_id: str | None,
    action: str,
    entity: str,
    entity_id: str | None,
    subject_id: str | None = None,
    before: dict[str, Any] | None = None,
    after: dict[str, Any] | None = None,
    ip: str | None = None,
    result: str | None = None,  # success | failure (sign-in and security events)
    user_agent: str | None = None,
) -> AuditLog:
    entry = AuditLog(
        actor_id=actor_id,
        action=action,
        entity=entity,
        entity_id=entity_id,
        subject_id=subject_id,
        changes={"before": _jsonable(before), "after": _jsonable(after)},
        ip=ip,
        result=result,
        user_agent=(user_agent or "")[:300] or None,
    )
    db.add(entry)
    return entry


def notify(db: Session, *, recipient_id: str, title: str, body: str = "", href: str | None = None) -> Notification:
    note = Notification(recipient_id=recipient_id, title=title, body=body, href=href)
    db.add(note)
    return note
