"""Calendar events people create (/calendar/events): personal reminders and meetings with invitees.

A reminder is only its owner's. A meeting shows on the organiser's and each invitee's calendar; invitees get a
notification, can accept or decline, and hear when the organiser cancels it.
"""

from __future__ import annotations

import re
import uuid
from datetime import date, datetime

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import selectinload

from app.deps import CurrentUserDep, DbSession, client_ip
from app.models import CalendarAttendee, CalendarEvent
from app.services.activity import record_audit, short_date
from app.services.sharing import person_exists, person_name, tell

router = APIRouter(prefix="/calendar", tags=["calendar"])

HM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


class AttendeeOut(BaseModel):
    person_id: str
    name: str
    response: str


class EventOut(BaseModel):
    id: str
    kind: str
    title: str
    date: date
    time: str | None
    location: str | None
    description: str | None
    owner_id: str
    owner_name: str
    attendees: list[AttendeeOut]
    created_at: datetime


class EventIn(BaseModel):
    kind: str = Field(pattern="^(reminder|meeting)$")
    title: str = Field(min_length=1, max_length=200)
    date: date
    time: str | None = Field(default=None, max_length=5)
    location: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=4000)
    attendee_ids: list[str] = Field(default_factory=list, max_length=50)


class RespondIn(BaseModel):
    response: str = Field(pattern="^(accepted|declined)$")


def _me(user) -> str:  # type: ignore[no-untyped-def]
    if not user.employee_id:
        raise HTTPException(403, "The calendar needs an employee profile.")
    return user.employee_id


def _out(db, e: CalendarEvent) -> EventOut:  # type: ignore[no-untyped-def]
    return EventOut(id=e.id, kind=e.kind, title=e.title, date=e.day, time=e.time, location=e.location,
                    description=e.description, owner_id=e.owner_id, owner_name=person_name(db, e.owner_id),
                    attendees=[AttendeeOut(person_id=a.person_id, name=person_name(db, a.person_id), response=a.response)
                               for a in e.attendees],
                    created_at=e.created_at)


def _load(db, eid: str, me: str) -> CalendarEvent:  # type: ignore[no-untyped-def]
    e = db.scalar(select(CalendarEvent).where(CalendarEvent.id == eid).options(selectinload(CalendarEvent.attendees)))
    if e is None or (e.owner_id != me and all(a.person_id != me for a in e.attendees)):
        raise HTTPException(404, "Event not found.")
    return e


def _when(e: CalendarEvent) -> str:
    return short_date(e.day) + (f" at {e.time}" if e.time else "")


@router.get("/events", response_model=list[EventOut])
def list_events(db: DbSession, user: CurrentUserDep) -> list[EventOut]:
    me = _me(user)
    invited = select(CalendarAttendee.event_id).where(CalendarAttendee.person_id == me)
    rows = db.scalars(select(CalendarEvent).where(or_(CalendarEvent.owner_id == me, CalendarEvent.id.in_(invited)))
                      .order_by(CalendarEvent.day, CalendarEvent.time).options(selectinload(CalendarEvent.attendees))).all()
    return [_out(db, e) for e in rows]


@router.post("/events", response_model=EventOut, status_code=status.HTTP_201_CREATED)
def create_event(payload: EventIn, request: Request, db: DbSession, user: CurrentUserDep) -> EventOut:
    me = _me(user)
    time = (payload.time or "").strip() or None
    if time and not HM.match(time):
        raise HTTPException(422, "Time must be HH:MM between 00:00 and 23:59.")
    if payload.date < date.today():
        raise HTTPException(422, "Pick today or a later date.")
    invitees = [p for p in dict.fromkeys(payload.attendee_ids) if p and p != me] if payload.kind == "meeting" else []
    if payload.kind == "meeting":
        if not time:
            raise HTTPException(422, "Pick a time for the meeting.")
        if not invitees:
            raise HTTPException(422, "Invite at least one person.")
        for pid in invitees:
            if not person_exists(db, pid):
                raise HTTPException(422, "Pick people from the directory.")
    e = CalendarEvent(id=f"cal-{uuid.uuid4().hex[:12]}", kind=payload.kind, title=payload.title.strip(),
                      day=payload.date, time=time, location=(payload.location or "").strip() or None,
                      description=(payload.description or "").strip() or None, owner_id=me)
    e.attendees.extend(CalendarAttendee(person_id=p, response="pending") for p in invitees)
    db.add(e)
    if invitees:
        name = person_name(db, me)
        for pid in invitees:
            tell(db, pid, me, f"Meeting invite: {e.title}", f"{_when(e)} — from {name}", f"/calendar?date={e.day}")
        record_audit(db, actor_id=user.id, action="calendar.meeting", entity="calendar_event", entity_id=e.id,
                     after={"title": e.title, "date": e.day, "invitees": invitees}, ip=client_ip(request))
    db.commit()
    return _out(db, _load(db, e.id, me))


@router.post("/events/{eid}/respond", response_model=EventOut)
def respond(eid: str, payload: RespondIn, db: DbSession, user: CurrentUserDep) -> EventOut:
    me = _me(user)
    e = _load(db, eid, me)
    row = next((a for a in e.attendees if a.person_id == me), None)
    if row is None:
        raise HTTPException(409, "You organised this meeting — cancel it instead.")
    if row.response != payload.response:
        row.response = payload.response
        tell(db, e.owner_id, me, f"{person_name(db, me)} {payload.response} {e.title}", _when(e),
             f"/calendar?date={e.day}")
        db.commit()
    return _out(db, _load(db, eid, me))


@router.delete("/events/{eid}", status_code=status.HTTP_204_NO_CONTENT)
def delete_event(eid: str, request: Request, db: DbSession, user: CurrentUserDep) -> None:
    me = _me(user)
    e = _load(db, eid, me)
    if e.owner_id != me:
        raise HTTPException(403, "Only the organiser can cancel this meeting." if e.kind == "meeting"
                            else "You can only remove your own reminders.")
    for a in e.attendees:
        if a.response != "declined":
            tell(db, a.person_id, me, f"Meeting cancelled: {e.title}", _when(e), f"/calendar?date={e.day}")
    if e.kind == "meeting":
        record_audit(db, actor_id=user.id, action="calendar.cancel", entity="calendar_event", entity_id=e.id,
                     before={"title": e.title, "date": e.day}, ip=client_ip(request))
    db.delete(e)
    db.commit()
