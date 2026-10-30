"""In-portal mail between employees (/mail): to, cc, subject, body, category, read state and replies in a thread.

People see mail they sent or received. Recipients get a notification that opens the thread.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import selectinload

from app.deps import CurrentUserDep, DbSession
from app.models import MailMessage, MailRecipient, Notification
from app.services.sharing import now, person_exists, person_name, tell

router = APIRouter(prefix="/mail", tags=["mail"])

CATEGORIES = {"Leave", "Attendance", "Work from home", "Pay", "General"}


class MailOut(BaseModel):
    id: str
    thread_id: str
    from_id: str
    from_name: str
    to_ids: list[str]
    cc_ids: list[str]
    subject: str
    body: str
    category: str | None
    sent_at: datetime
    read_by: list[str]
    names: dict[str, str]


class MailIn(BaseModel):
    to_ids: list[str] = Field(min_length=1, max_length=20)
    cc_ids: list[str] = Field(default_factory=list, max_length=20)
    subject: str = Field(min_length=1, max_length=300)
    body: str = Field(min_length=1, max_length=20000)
    category: str | None = None
    thread_id: str | None = Field(default=None, max_length=64)


def _me(user) -> str:  # type: ignore[no-untyped-def]
    if not user.employee_id:
        raise HTTPException(403, "Mail needs an employee profile.")
    return user.employee_id


def _out(m: MailMessage, names: dict[str, str]) -> MailOut:
    return MailOut(
        id=m.id, thread_id=m.thread_id, from_id=m.from_id, from_name=m.from_name,
        to_ids=[r.person_id for r in m.recipients if r.kind == "to"],
        cc_ids=[r.person_id for r in m.recipients if r.kind == "cc"],
        subject=m.subject, body=m.body, category=m.category, sent_at=m.sent_at,
        read_by=[m.from_id, *(r.person_id for r in m.recipients if r.read_at)],
        names={p: names[p] for p in {m.from_id, *(r.person_id for r in m.recipients)} if p in names},
    )


def _visible(me: str):  # type: ignore[no-untyped-def]
    return or_(MailMessage.from_id == me,
               MailMessage.id.in_(select(MailRecipient.message_id).where(MailRecipient.person_id == me)))


@router.get("", response_model=list[MailOut])
def list_mail(db: DbSession, user: CurrentUserDep) -> list[MailOut]:
    me = _me(user)
    rows = db.scalars(select(MailMessage).where(_visible(me)).order_by(MailMessage.sent_at)
                      .options(selectinload(MailMessage.recipients))).all()
    people = {p for m in rows for p in (m.from_id, *(r.person_id for r in m.recipients))}
    names = {p: person_name(db, p) for p in people}
    return [_out(m, names) for m in rows]


@router.post("", response_model=MailOut, status_code=status.HTTP_201_CREATED)
def send_mail(payload: MailIn, db: DbSession, user: CurrentUserDep) -> MailOut:
    me = _me(user)
    to_ids = [p for p in dict.fromkeys(payload.to_ids) if p and p != me]
    cc_ids = [p for p in dict.fromkeys(payload.cc_ids) if p and p != me and p not in to_ids]
    if not to_ids:
        raise HTTPException(422, "Pick who it's to.")
    for pid in to_ids + cc_ids:
        if not person_exists(db, pid):
            raise HTTPException(422, "Pick people from the list.")
    if payload.category and payload.category not in CATEGORIES:
        raise HTTPException(422, "Pick a category from the list.")
    thread_id = payload.thread_id
    if thread_id:
        in_thread = db.scalar(select(MailMessage.id).where(MailMessage.thread_id == thread_id, _visible(me)).limit(1))
        if in_thread is None:
            raise HTTPException(404, "Thread not found.")
    else:
        thread_id = f"th-{uuid.uuid4().hex[:12]}"
    my_name = person_name(db, me)
    msg = MailMessage(id=f"ml-{uuid.uuid4().hex[:12]}", thread_id=thread_id, from_id=me, from_name=my_name,
                      subject=payload.subject.strip(), body=payload.body.strip(), category=payload.category,
                      sent_at=now())
    msg.recipients.extend([MailRecipient(person_id=p, kind="to") for p in to_ids])
    msg.recipients.extend([MailRecipient(person_id=p, kind="cc") for p in cc_ids])
    db.add(msg)
    for pid in to_ids + cc_ids:
        tell(db, pid, me, f"New mail from {my_name}", msg.subject, f"/mail?thread={thread_id}")
    db.commit()
    db.refresh(msg)
    return _out(msg, {p: person_name(db, p) for p in [me, *to_ids, *cc_ids]})


@router.post("/threads/{thread_id}/read")
def mark_thread_read(thread_id: str, db: DbSession, user: CurrentUserDep) -> dict[str, int]:
    me = _me(user)
    rows = db.scalars(select(MailRecipient).join(MailMessage).where(
        MailMessage.thread_id == thread_id, MailRecipient.person_id == me, MailRecipient.read_at.is_(None))).all()
    stamp = now()
    for r in rows:
        r.read_at = stamp
    for n in db.scalars(select(Notification).where(Notification.recipient_id == me, Notification.read_at.is_(None),
                                                   Notification.href == f"/mail?thread={thread_id}")):
        n.read_at = stamp
    db.commit()
    return {"marked": len(rows)}
