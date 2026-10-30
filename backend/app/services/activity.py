"""Audit trail and in-app notifications."""

from __future__ import annotations

import re
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


_ISO_DAY = re.compile(r"(?<![\w-])(\d{4})-(\d{2})-(\d{2})(?![\w-]|T\d)")
_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def short_date(value: date | str) -> str:
    """"2026-10-20" (or a date) → "20 Oct 2026", the way the portal shows dates."""
    d = value if isinstance(value, date) else date.fromisoformat(str(value)[:10])
    return f"{d.day:02d} {_MONTHS[d.month - 1]} {d.year}"


def readable_dates(text: str) -> str:
    """Rewrites plain ISO days in user-facing text ("was due 2026-10-20" → "was due 20 Oct 2026")."""
    def repl(m: re.Match[str]) -> str:
        try:
            return short_date(m.group(0))
        except ValueError:
            return m.group(0)
    return _ISO_DAY.sub(repl, text) if text else text


def notify(db: Session, *, recipient_id: str, title: str, body: str = "", href: str | None = None) -> Notification:
    # Notification text is read by people: dates are shown as "20 Oct 2026", not ISO.
    note = Notification(recipient_id=recipient_id, title=readable_dates(title), body=readable_dates(body), href=href)
    db.add(note)
    return note
