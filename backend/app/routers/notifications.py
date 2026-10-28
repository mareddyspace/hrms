from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import select

from app.db import utcnow
from app.deps import CurrentUserDep, DbSession
from app.models import Notification
from app.schemas import NotificationOut

router = APIRouter(prefix="/notifications", tags=["notifications"])


@router.get("", response_model=list[NotificationOut])
def list_notifications(
    db: DbSession,
    user: CurrentUserDep,
    unread_only: bool = False,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> list[Notification]:
    stmt = select(Notification).where(Notification.recipient_id == (user.employee_id or ""))
    if unread_only:
        stmt = stmt.where(Notification.read_at.is_(None))
    return list(db.scalars(stmt.order_by(Notification.created_at.desc(), Notification.id.desc()).limit(limit)))


@router.post("/{notification_id}/read", response_model=NotificationOut)
def mark_read(notification_id: int, db: DbSession, user: CurrentUserDep) -> Notification:
    note = db.get(Notification, notification_id)
    if note is None or note.recipient_id != user.employee_id:
        raise HTTPException(404, "Not found.")
    if note.read_at is None:
        note.read_at = utcnow()
        db.commit()
    return note
