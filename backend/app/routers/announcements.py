"""Announcements (/announcements): HR and admins publish to everyone, a country or a department; managers post to
their own team. Optional "must acknowledge" with read receipts for whoever manages the post.

HR limited to some countries (access scope) can only post to those countries and sees receipts for people there.
Scheduled posts go live the first time anyone lists announcements after their time.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.deps import CurrentUserDep, DbSession, client_ip
from app.models import Announcement, AnnouncementRead, Country, Employee
from app.services.activity import record_audit
from app.services.scope import report_ids
from app.services.sharing import is_admin, is_hr, now, person_name, tell

router = APIRouter(prefix="/announcements", tags=["announcements"])

SCOPES = {"Company", "Country", "Department", "Team"}
STATES = {"Draft", "Scheduled", "Published"}
MANAGER_ROLES = {"manager", "executive"}


class AnnouncementOut(BaseModel):
    id: str
    title: str
    body: str
    scope: str
    audience: str
    state: str
    published_at: datetime | None
    scheduled_for: datetime | None
    author_id: str | None
    author_name: str
    must_acknowledge: bool
    read: bool
    acknowledged: bool
    can_manage: bool
    # Only for people who manage the post.
    audience_count: int | None = None
    read_count: int | None = None
    ack_count: int | None = None


class AnnouncementIn(BaseModel):
    title: str = Field(min_length=3, max_length=200)
    body: str = Field(min_length=1, max_length=8000)
    scope: str
    audience: str = Field(default="", max_length=120)
    state: str = "Draft"
    scheduled_for: datetime | None = None
    must_acknowledge: bool = False


class StateIn(BaseModel):
    state: str
    scheduled_for: datetime | None = None


class ReceiptOut(BaseModel):
    person_id: str
    name: str
    department: str
    country_code: str
    read_at: datetime | None
    acknowledged_at: datetime | None


def _aware(value: datetime | None) -> datetime | None:
    return value.replace(tzinfo=timezone.utc) if value is not None and value.tzinfo is None else value


def _me(user) -> str:  # type: ignore[no-untyped-def]
    if not user.employee_id:
        raise HTTPException(403, "Announcements need an employee profile.")
    return user.employee_id


def _active(db: Session):  # type: ignore[no-untyped-def]
    return select(Employee).where(func.coalesce(Employee.employment_status, "") != "Exited")


def _country_code(db: Session, audience: str) -> str:
    text = audience.strip()
    if len(text) == 2:
        return text.upper()
    code = db.scalar(select(Country.code).where(func.lower(Country.name) == text.lower()))
    return code or text.upper()


def audience_ids(db: Session, a: Announcement) -> set[str]:
    q = _active(db)
    if a.scope == "Country":
        q = q.where(Employee.country_code == _country_code(db, a.audience))
    elif a.scope == "Department":
        q = q.where(func.lower(Employee.department) == a.audience.strip().lower())
    elif a.scope == "Team":
        team = ({a.author_id} | report_ids(db, a.author_id)) if a.author_id else set()
        q = q.where(Employee.id.in_(team))
    return {e.id for e in db.scalars(q)}


def _in_audience(db: Session, a: Announcement, emp: Employee | None) -> bool:
    if emp is None:
        return False
    if a.scope == "Company":
        return True
    if a.scope == "Country":
        return emp.country_code == _country_code(db, a.audience)
    if a.scope == "Department":
        return (emp.department or "").lower() == a.audience.strip().lower()
    return bool(a.author_id) and (emp.id == a.author_id or emp.id in report_ids(db, a.author_id))  # type: ignore[arg-type]


def _can_manage(a: Announcement | AnnouncementIn, user, me: str) -> bool:  # type: ignore[no-untyped-def]
    role = user.account.role
    countries = user.scope.countries
    if is_admin(role):
        return True
    if is_hr(role):
        if not countries:
            return True
        return a.scope == "Country" and len(a.audience.strip()) == 2 and a.audience.strip().upper() in countries
    author = getattr(a, "author_id", me)
    return role in MANAGER_ROLES and a.scope == "Team" and author == me


def _publish_due(db: Session) -> None:
    due = db.scalars(select(Announcement).where(Announcement.state == "Scheduled",
                                                Announcement.scheduled_for <= now())).all()
    for a in due:
        _go_live(db, a, None)
    if due:
        db.commit()


def _go_live(db: Session, a: Announcement, actor: str | None) -> None:
    a.state = "Published"
    a.published_at = now()
    a.scheduled_for = None
    title = ("Please acknowledge: " if a.must_acknowledge else "Announcement: ") + a.title
    for pid in audience_ids(db, a):
        tell(db, pid, actor, title, a.body[:140], f"/announcements?id={a.id}")


def _out(db: Session, a: Announcement, me: str, manage: bool) -> AnnouncementOut:
    mine = next((r for r in a.reads if r.person_id == me), None)
    out = AnnouncementOut(
        id=a.id, title=a.title, body=a.body, scope=a.scope, audience=a.audience, state=a.state,
        published_at=a.published_at, scheduled_for=a.scheduled_for, author_id=a.author_id, author_name=a.author_name,
        must_acknowledge=a.must_acknowledge, read=mine is not None, acknowledged=bool(mine and mine.acknowledged_at),
        can_manage=manage,
    )
    if manage and a.state == "Published":
        people = audience_ids(db, a)
        out.audience_count = len(people)
        out.read_count = sum(1 for r in a.reads if r.person_id in people)
        out.ack_count = sum(1 for r in a.reads if r.person_id in people and r.acknowledged_at)
    return out


def _load(db: Session, aid: str, user, me: str) -> tuple[Announcement, bool]:  # type: ignore[no-untyped-def]
    a = db.scalar(select(Announcement).where(Announcement.id == aid).options(selectinload(Announcement.reads)))
    if a is None:
        raise HTTPException(404, "Announcement not found.")
    manage = _can_manage(a, user, me)
    if not manage and not (a.state == "Published" and _in_audience(db, a, user.employee)):
        raise HTTPException(404, "Announcement not found.")
    return a, manage


@router.get("", response_model=list[AnnouncementOut])
def list_announcements(db: DbSession, user: CurrentUserDep) -> list[AnnouncementOut]:
    me = _me(user)
    _publish_due(db)
    rows = db.scalars(select(Announcement).options(selectinload(Announcement.reads))
                      .order_by(func.coalesce(Announcement.published_at, Announcement.created_at).desc())).all()
    out: list[AnnouncementOut] = []
    for a in rows:
        manage = _can_manage(a, user, me)
        if manage or (a.state == "Published" and _in_audience(db, a, user.employee)):
            out.append(_out(db, a, me, manage))
    return out


@router.post("", response_model=AnnouncementOut, status_code=status.HTTP_201_CREATED)
def create_announcement(payload: AnnouncementIn, request: Request, db: DbSession, user: CurrentUserDep) -> AnnouncementOut:
    me = _me(user)
    if payload.scope not in SCOPES or payload.state not in STATES:
        raise HTTPException(422, "Pick a scope and state from the list.")
    if payload.scope in {"Country", "Department"} and not payload.audience.strip():
        raise HTTPException(422, "Pick the country or department.")
    if not _can_manage(payload, user, me):
        raise HTTPException(403, "Only HR or admins publish announcements; managers post to their own team.")
    payload.scheduled_for = _aware(payload.scheduled_for)
    if payload.state == "Scheduled" and (payload.scheduled_for is None or payload.scheduled_for <= now()):
        raise HTTPException(422, "Pick a future time to schedule it.")
    audience = payload.audience.strip()
    if payload.scope == "Country":
        audience = _country_code(db, audience)
    a = Announcement(id=f"an-{uuid.uuid4().hex[:10]}", title=payload.title.strip(), body=payload.body.strip(),
                     scope=payload.scope, audience=audience or ("All TimeZ" if payload.scope == "Company" else "My team"),
                     state="Draft", scheduled_for=payload.scheduled_for if payload.state == "Scheduled" else None,
                     author_id=me, author_name=person_name(db, me), must_acknowledge=payload.must_acknowledge)
    db.add(a)
    if payload.state == "Published":
        db.flush()
        _go_live(db, a, me)
    elif payload.state == "Scheduled":
        a.state = "Scheduled"
    record_audit(db, actor_id=user.id, action="announcement.create", entity="announcement", entity_id=a.id,
                 after={"title": a.title, "scope": a.scope, "audience": a.audience, "state": a.state,
                        "must_acknowledge": a.must_acknowledge}, ip=client_ip(request))
    db.commit()
    a, manage = _load(db, a.id, user, me)
    return _out(db, a, me, manage)


@router.post("/{aid}/state", response_model=AnnouncementOut)
def set_state(aid: str, payload: StateIn, request: Request, db: DbSession, user: CurrentUserDep) -> AnnouncementOut:
    me = _me(user)
    a, manage = _load(db, aid, user, me)
    if not manage:
        raise HTTPException(403, "Only HR or admins publish this; managers manage only their own team posts.")
    if payload.state not in STATES:
        raise HTTPException(422, "Unknown state.")
    before = a.state
    if payload.state == "Published" and a.state != "Published":
        _go_live(db, a, me)
    elif payload.state == "Scheduled":
        when = _aware(payload.scheduled_for) or a.scheduled_for
        if when is None or when <= now():
            raise HTTPException(422, "Pick a future time to schedule it.")
        a.state, a.scheduled_for = "Scheduled", when
    elif payload.state == "Draft":
        a.state, a.scheduled_for = "Draft", None
    record_audit(db, actor_id=user.id, action="announcement.state", entity="announcement", entity_id=a.id,
                 before={"state": before}, after={"state": a.state}, ip=client_ip(request))
    db.commit()
    a, manage = _load(db, aid, user, me)
    return _out(db, a, me, manage)


def _mark(db: Session, a: Announcement, me: str, ack: bool) -> None:
    row = next((r for r in a.reads if r.person_id == me), None)
    if row is None:
        row = AnnouncementRead(person_id=me, read_at=now())
        a.reads.append(row)
    if ack and row.acknowledged_at is None:
        row.acknowledged_at = now()


@router.post("/{aid}/read", response_model=AnnouncementOut)
def mark_read(aid: str, db: DbSession, user: CurrentUserDep) -> AnnouncementOut:
    me = _me(user)
    a, manage = _load(db, aid, user, me)
    if a.state != "Published":
        raise HTTPException(409, "This announcement isn't published yet.")
    _mark(db, a, me, False)
    try:
        db.commit()
    except IntegrityError:  # two read calls at once: the other one already saved the receipt
        db.rollback()
    a, manage = _load(db, aid, user, me)
    return _out(db, a, me, manage)


@router.post("/{aid}/acknowledge", response_model=AnnouncementOut)
def acknowledge(aid: str, request: Request, db: DbSession, user: CurrentUserDep) -> AnnouncementOut:
    me = _me(user)
    a, manage = _load(db, aid, user, me)
    if a.state != "Published" or not a.must_acknowledge:
        raise HTTPException(409, "This announcement doesn't need an acknowledgement.")
    if not _in_audience(db, a, user.employee):
        raise HTTPException(403, "This announcement isn't addressed to you.")
    _mark(db, a, me, True)
    record_audit(db, actor_id=user.id, action="announcement.acknowledge", entity="announcement", entity_id=a.id,
                 subject_id=me, after={"acknowledged": True}, ip=client_ip(request))
    db.commit()
    a, manage = _load(db, aid, user, me)
    return _out(db, a, me, manage)


@router.get("/{aid}/receipts", response_model=list[ReceiptOut])
def receipts(aid: str, db: DbSession, user: CurrentUserDep) -> list[ReceiptOut]:
    me = _me(user)
    a, manage = _load(db, aid, user, me)
    if not manage:
        raise HTTPException(403, "Only whoever manages this announcement sees read receipts.")
    reads = {r.person_id: r for r in a.reads}
    people = audience_ids(db, a)
    rows = db.scalars(select(Employee).where(Employee.id.in_(people)).order_by(Employee.full_name)).all()
    return [ReceiptOut(person_id=e.id, name=e.full_name, department=e.department or "", country_code=e.country_code,
                       read_at=reads[e.id].read_at if e.id in reads else None,
                       acknowledged_at=reads[e.id].acknowledged_at if e.id in reads else None)
            # admin manages company-wide posts; read receipts are names and read times, not HR data
            for e in rows if user.scope.can_see(e) or is_admin(user.account.role)]
