"""Security messages to a person's in-portal inbox, sent as "TimeZ Security" (verification codes and the like).

deliver_security_mail is the one place that decides delivery:
- With the shared Mail store (app/models/sharing.py: mail_messages / mail_recipients), the message lands in the
  person's TimeZ Mail inbox from "TimeZ Security", plus a bell note pointing at it. Returns "/mail?thread=…".
- Without it (older schema), it falls back to a notification that carries the code. Returns "/notifications".
No email is queued here; callers queue their own outbox row.
"""

from __future__ import annotations

import uuid

from sqlalchemy import inspect
from sqlalchemy.orm import Session

from app.db import utcnow
from app.services.activity import notify

SENDER = "TimeZ Security"
SENDER_ID = "timez-security"

try:  # the shared Mail store; absent on older schemas
    from app.models.sharing import MailMessage, MailRecipient
except ImportError:  # pragma: no cover
    MailMessage = MailRecipient = None  # type: ignore[assignment,misc]


def _has_mail(db: Session) -> bool:
    if MailMessage is None:
        return False
    try:
        return inspect(db.get_bind()).has_table("mail_messages")
    except Exception:  # pragma: no cover
        return False


def _quiet(note) -> None:  # type: ignore[no-untyped-def]
    note._email_queued = True  # callers queue their own email (app/services/email_outbox.py)


def deliver_security_mail(db: Session, employee_id: str, subject: str, body: str, *, code: str | None = None) -> str:
    """Puts the message in the person's portal inbox. Returns the page that shows it. Caller commits."""
    if _has_mail(db):
        thread = f"th-sec-{uuid.uuid4().hex[:12]}"
        msg = MailMessage(id=f"ml-{uuid.uuid4().hex[:12]}", thread_id=thread, from_id=SENDER_ID, from_name=SENDER,
                          subject=subject, body=body, category="General", sent_at=utcnow())
        msg.recipients.append(MailRecipient(person_id=employee_id, kind="to"))
        db.add(msg)
        href = f"/mail?thread={thread}"
        _quiet(notify(db, recipient_id=employee_id, title=f"New mail from {SENDER}", body=subject, href=href))
        return href
    title = f"Your verification code is {code}" if code else subject
    _quiet(notify(db, recipient_id=employee_id, title=title, body=f"{SENDER}: {body}", href="/notifications"))
    return "/notifications"
