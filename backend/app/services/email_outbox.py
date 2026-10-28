"""Email outbox: every in-app notification also queues an email row (same rules as src/data/emailOutbox.ts).

Nothing is sent by the API. Rows wait as "Queued" until an admin marks them sent (or a mail relay picks them up).
The category comes from the notification's link (portal: inferNotifCategory); the category maps to an admin
channel, and a channel whose email switch is off queues nothing. Notifications outside every channel ("general")
always queue. People with no email address are skipped.

Installed once (install()) as a Session before_flush hook, so every module's notify() is covered without changes.
"""

from __future__ import annotations

import re

from sqlalchemy import event
from sqlalchemy.orm import Session

from app.models import EmailChannelSwitch, EmailOutboxItem, Employee, Notification

# channel -> (label, description, email on by default) — the portal's NOTIFICATION_PREF_SEED
DEFAULT_SWITCHES: dict[str, tuple[str, str, bool]] = {
    "approvals": ("Approvals", "Leave, expense, and workflow decisions", True),
    "announcements": ("Announcements", "Holidays and company announcements", True),
    "learning": ("Learning", "Course enrolments, reminders and certifications", False),
    "integrations": ("Integration alerts", "Connector sync failures and quarantine", True),
}

_PREFIXES: list[tuple[str, tuple[str, ...]]] = [
    ("Approvals", ("/approvals",)),
    ("Leave", ("/leave",)),
    ("Tasks", ("/tasks",)),
    ("Tickets", ("/tickets", "/help", "/desk")),
    ("Mail", ("/mail",)),
    ("Messages", ("/chat",)),
    ("Attendance", ("/attendance", "/timesheet", "/timesheets", "/workforce/shifts", "/shifts")),
    ("Holidays", ("/holidays", "/calendar", "/workforce/optional-holidays")),
    ("Pay", ("/payslips", "/pay-preview", "/expenses", "/benefits", "/compensation", "/tax")),
    ("Recruiting", ("/internal-jobs", "/recruiting", "/candidates", "/jobs", "/referrals")),
]
_DECISION_TITLE = re.compile(r"^(Approve |Shift swap request|Contract extension request)", re.IGNORECASE)


def infer_category(href: str | None, title: str | None) -> str:
    if _DECISION_TITLE.match(title or ""):
        return "Approvals"
    path = re.split(r"[?#]", href or "")[0]
    for category, prefixes in _PREFIXES:
        if any(path == p or path.startswith(f"{p}/") for p in prefixes):
            return category
    return "System"


def channel_for(category: str, href: str | None) -> str:
    """Admin channel for a notification; "general" when no channel covers it (always allowed)."""
    path = re.split(r"[?#]", href or "")[0]
    if category in ("Approvals", "Leave", "Attendance"):
        return "approvals"
    if category == "Holidays":
        return "announcements"
    if path == "/integrations" or path.startswith("/integrations/") or path.startswith("/admin/integrations"):
        return "integrations"
    if path == "/learning" or path.startswith("/learning/"):
        return "learning"
    return "general"


def email_allowed(db: Session, channel: str) -> bool:
    if channel == "general":
        return True
    row = db.get(EmailChannelSwitch, channel)
    if row is not None:
        return bool(row.email)
    default = DEFAULT_SWITCHES.get(channel)
    return default[2] if default else True


def _queue_for(session: Session, note: Notification) -> EmailOutboxItem | None:
    category = infer_category(note.href, note.title)
    channel = channel_for(category, note.href)
    if not email_allowed(session, channel):
        return None
    person = session.get(Employee, note.recipient_id) if note.recipient_id else None
    if person is None or not person.email:
        return None
    item = EmailOutboxItem(
        recipient_id=person.id, to_email=person.email, subject=(note.title or "").strip()[:200],
        body=(note.body or "").strip(), link=note.href, category=category, channel=channel, status="Queued",
    )
    session.add(item)
    return item


_PENDING_KEY = "timez_email_pending"


def _before_flush(session: Session, _ctx, _instances) -> None:  # type: ignore[no-untyped-def]
    new_notes = [o for o in session.new if isinstance(o, Notification) and not getattr(o, "_email_queued", False)]
    if not new_notes:
        return
    pending = session.info.setdefault(_PENDING_KEY, [])
    with session.no_autoflush:
        for note in new_notes:
            note._email_queued = True  # type: ignore[attr-defined]
            item = _queue_for(session, note)
            if item is not None:
                pending.append((note, item))


def _after_flush(session: Session, _ctx) -> None:  # type: ignore[no-untyped-def]
    pending = session.info.pop(_PENDING_KEY, None)
    for note, item in pending or []:
        if note.id is not None and item.notification_id is None:
            item.notification_id = note.id  # written by the next flush (commit flushes until clean)


_installed = False


def install() -> None:
    global _installed
    if _installed:
        return
    event.listen(Session, "before_flush", _before_flush)
    event.listen(Session, "after_flush_postexec", _after_flush)
    _installed = True
