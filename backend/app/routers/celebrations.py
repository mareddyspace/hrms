"""Celebrations: birthdays, work anniversaries and new joiners (/celebrations), and wishes sent as kudos.

Privacy: a birthday is returned only as this year's date (day and month; never the year of birth or an age), and not
at all for people who chose "Hide my birthday" (employees.hide_birthday, migration 0023).
Wishes are kudos rows with value "Celebration" and no points, so they show on the recognition wall and never use the
monthly points allowance.
"""

from __future__ import annotations

import calendar
import secrets
from datetime import date, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import utcnow
from app.deps import CurrentUserDep, DbSession, client_ip
from app.models import AuditLog, Employee, Kudos
from app.services.activity import notify, record_audit
from app.services.decisions import me
from app.services.headcount import has_started
from app.services.leave import today_for

router = APIRouter(prefix="/celebrations", tags=["celebrations"])

WISH_VALUE = "Celebration"
LEFT = ("Terminated", "Exited")
Kind = Literal["birthday", "anniversary", "new_joiner"]
DEFAULT_WISH = {"birthday": "Happy birthday! Have a great day.",
                "anniversary": "Happy work anniversary! Thank you for everything.",
                "new_joiner": "Welcome to the team! Glad to have you here."}


class CelebrationOut(BaseModel):
    employee_id: str
    name: str
    job_title: str
    department: str
    location: str
    kind: Kind
    date: date  # this year's occurrence (birthday: day and month only matter)
    years: int | None = None  # work anniversaries
    wished_by_me: bool = False


class WishIn(BaseModel):
    to_id: str = Field(min_length=1, max_length=64)
    kind: Kind
    message: str = Field(default="", max_length=500)


class PreferencesOut(BaseModel):
    hide_birthday: bool


class PreferencesIn(BaseModel):
    hide_birthday: bool


def _occurrence(month: int, day: int, year: int) -> date:
    return date(year, month, min(day, calendar.monthrange(year, month)[1]))  # 29 Feb -> 28 Feb


def _next_in(d: date, start: date, end: date) -> date | None:
    for year in (start.year, start.year + 1):
        occ = _occurrence(d.month, d.day, year)
        if start <= occ <= end:
            return occ
    return None


def is_milestone(years: int) -> bool:
    """Work anniversaries worth a calendar entry: 1, 3 and 5 years, then every five (10, 15, 20, ...)."""
    return years in (1, 3, 5) or (years >= 10 and years % 5 == 0)


def circle_ids(db: Session, viewer_id: str | None) -> set[str]:
    """The people around the viewer: themselves, their manager, teammates under the same manager and their direct
    reports. The calendar shows only these, not the whole company (nor everyone who happens to have a sign-in)."""
    ids: set[str] = set()
    me_row = db.get(Employee, viewer_id) if viewer_id else None
    if me_row is not None:
        ids.add(me_row.id)
        ids |= set(db.scalars(select(Employee.id).where(Employee.manager_id == me_row.id)))
        if me_row.manager_id:
            ids.add(me_row.manager_id)
            ids |= set(db.scalars(select(Employee.id).where(Employee.manager_id == me_row.manager_id)))
    return ids


def celebrations(db: Session, today: date, days: int, viewer_id: str | None, year: int | None = None,
                 circle: bool = False) -> list[CelebrationOut]:
    """From today - 1 (yesterday's wishes still count) to today + days - 1; with `year`, every day of that year
    (the calendar's month and year views). New joiners are only listed for the rolling window."""
    start, end = today - timedelta(days=1), today + timedelta(days=days - 1)
    if year is not None:
        start, end = date(year, 1, 1), date(year, 12, 31)
    # (person, kind) pairs this viewer wished in the last 14 days. The kind is in the wish's audit row; an older wish
    # without one counts for every kind (None).
    wished: set[tuple[str, str | None]] = set()
    if viewer_id:
        recent = dict(db.execute(
            select(Kudos.id, Kudos.to_id).where(Kudos.from_id == viewer_id, Kudos.value == WISH_VALUE,
                                                Kudos.created_at >= utcnow() - timedelta(days=14))).all())
        kinds: dict[str, str] = {}
        if recent:
            for entity_id, changes in db.execute(select(AuditLog.entity_id, AuditLog.changes).where(
                    AuditLog.action == "celebration_wish_sent", AuditLog.entity_id.in_(list(recent)))):
                kind = ((changes or {}).get("after") or {}).get("kind")
                if entity_id and kind:
                    kinds[entity_id] = kind
        wished = {(to, kinds.get(kid)) for kid, to in recent.items()}

    def wished_for(emp_id: str, kind: str) -> bool:
        return (emp_id, kind) in wished or (emp_id, None) in wished

    out: list[CelebrationOut] = []
    people = select(Employee).where(Employee.employment_status.not_in(LEFT))
    if circle:
        people = people.where(Employee.id.in_(circle_ids(db, viewer_id)))
    for emp in db.scalars(people):
        base = dict(employee_id=emp.id, name=emp.full_name, job_title=emp.job_title,
                    department=emp.department, location=emp.location)
        if emp.date_of_birth and not emp.hide_birthday and has_started(emp, today):
            if occ := _next_in(emp.date_of_birth, start, end):
                out.append(CelebrationOut(**base, kind="birthday", date=occ, wished_by_me=wished_for(emp.id, "birthday")))
        if emp.joining_date and has_started(emp, today):
            occ = _next_in(emp.joining_date, start, end)
            years = occ.year - emp.joining_date.year if occ else 0
            if occ and years >= 1 and (not circle or is_milestone(years)):
                out.append(CelebrationOut(**base, kind="anniversary", date=occ, years=years,
                                          wished_by_me=wished_for(emp.id, "anniversary")))
            elif year is None and today - timedelta(days=7) <= emp.joining_date <= today:
                out.append(CelebrationOut(**base, kind="new_joiner", date=emp.joining_date,
                                          wished_by_me=wished_for(emp.id, "new_joiner")))
    out.sort(key=lambda c: (c.date, c.kind, c.name))
    return out


@router.get("", response_model=list[CelebrationOut])
def list_celebrations(db: DbSession, user: CurrentUserDep,
                      days: Annotated[int, Query(ge=1, le=31)] = 7,
                      year: Annotated[int | None, Query(ge=2000, le=2100)] = None,
                      circle: bool = False) -> list[CelebrationOut]:
    """circle=true: only the people around you (circle_ids), for the calendar, with milestone work anniversaries
    only (is_milestone); otherwise the whole company."""
    emp = user.employee
    today = today_for(emp) if emp else date.today()
    return celebrations(db, today, days, user.employee_id, year, circle)


@router.post("/wishes", response_model=CelebrationOut, status_code=201)
def send_wish(body: WishIn, request: Request, db: DbSession, user: CurrentUserDep) -> CelebrationOut:
    sender = me(user)
    if body.to_id == sender.id:
        raise HTTPException(422, "You can't send wishes to yourself.")
    today = today_for(sender)
    match = next((c for c in celebrations(db, today, 8, sender.id) if c.employee_id == body.to_id and c.kind == body.kind), None)
    if match is None:
        raise HTTPException(404, "Nothing to celebrate for them right now.")
    if match.wished_by_me:
        raise HTTPException(409, "You already sent them wishes.")
    message = " ".join(body.message.split()) or DEFAULT_WISH[body.kind]
    k = Kudos(id=f"kd-{secrets.token_hex(6)}", from_id=sender.id, to_id=body.to_id, value=WISH_VALUE, message=message[:500],
              points=0, month=utcnow().strftime("%Y-%m"), created_at=utcnow())
    db.add(k)
    what = {"birthday": "birthday wishes", "anniversary": "work anniversary wishes", "new_joiner": "a welcome"}[body.kind]
    notify(db, recipient_id=body.to_id, title=f"{sender.full_name} sent you {what}", body=message, href="/recognition")
    record_audit(db, actor_id=user.id, action="celebration_wish_sent", entity="kudos", entity_id=k.id,
                 subject_id=body.to_id, after={"kind": body.kind}, ip=client_ip(request))
    db.commit()
    match.wished_by_me = True
    return match


@router.get("/me/preferences", response_model=PreferencesOut)
def get_preferences(user: CurrentUserDep) -> PreferencesOut:
    return PreferencesOut(hide_birthday=bool(me(user).hide_birthday))


@router.put("/me/preferences", response_model=PreferencesOut)
def put_preferences(body: PreferencesIn, request: Request, db: DbSession, user: CurrentUserDep) -> PreferencesOut:
    emp = me(user)
    before = bool(emp.hide_birthday)
    if before != body.hide_birthday:
        emp.hide_birthday = body.hide_birthday
        record_audit(db, actor_id=user.id, action="changed birthday privacy", entity="employee", entity_id=emp.id,
                     before={"hide_birthday": before}, after={"hide_birthday": body.hide_birthday}, ip=client_ip(request))
        db.commit()
    return PreferencesOut(hide_birthday=body.hide_birthday)
