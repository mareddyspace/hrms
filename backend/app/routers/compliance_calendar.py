"""HR compliance calendar (/compliance-calendar): statutory due dates (sample, configurable) plus visa / permit,
document, probation and contract end dates within 30 / 60 / 90 days. HR roles and admins only. Rules in
app/services/compliance_calendar.py."""

from __future__ import annotations

import uuid
from datetime import date
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import ComplianceDueDate, Country
from app.services import compliance_calendar as rules
from app.services.activity import record_audit
from app.services.leave import today_for
from app.services.scope import HR_ROLES

router = APIRouter(prefix="/compliance-calendar", tags=["compliance calendar"])

ALLOWED = HR_ROLES | {"admin", "super_admin"}


class ItemOut(BaseModel):
    id: str
    kind: str
    title: str
    date: date
    country_code: str
    days_left: int
    href: str
    employee_id: str | None = None
    employee_name: str | None = None
    sample: bool = False


class DueDateIn(BaseModel):
    country_code: str = Field(min_length=2, max_length=2)
    name: str = Field(min_length=1, max_length=200)
    frequency: Literal["monthly", "quarterly", "annual"]
    day: int = Field(ge=1, le=31)
    months: list[int] = Field(default_factory=list, max_length=12)
    href: str | None = Field(default=None, max_length=200)
    active: bool = True


class DueDateOut(BaseModel):
    id: str
    country_code: str
    name: str
    frequency: str
    day: int
    months: list[int]
    href: str | None
    note: str | None
    active: bool


def _check(user: CurrentUser) -> None:
    if user.account.role not in ALLOWED:
        raise HTTPException(403, "The compliance calendar is for HR and admins.")


def _out(row: ComplianceDueDate) -> DueDateOut:
    return DueDateOut(id=row.id, country_code=row.country_code, name=row.name, frequency=row.frequency, day=row.day,
                      months=list(row.months or []), href=row.href, note=row.note, active=row.active)


@router.get("", response_model=list[ItemOut])
def calendar_items(db: DbSession, user: CurrentUserDep, days: Annotated[int, Query(ge=1, le=366)] = 90,
                   country: Annotated[str | None, Query(max_length=2)] = None,
                   kind: Annotated[str | None, Query(pattern="^(statutory|visa|document|probation|contract)$")] = None,
                   start: date | None = None) -> list[ItemOut]:
    _check(user)
    today = start or (today_for(user.employee) if user.employee else date.today())
    if user.scope.countries and country and country.upper() not in user.scope.countries:
        return []
    found = rules.items(db, today, days, user.scope.employee_filter(), country.upper() if country else None, kind)
    if user.scope.countries:
        found = [i for i in found if i.country_code in user.scope.countries]
    return [ItemOut(**i.out()) for i in found]


@router.get("/due-dates", response_model=list[DueDateOut])
def list_due_dates(db: DbSession, user: CurrentUserDep) -> list[DueDateOut]:
    _check(user)
    rows = db.scalars(select(ComplianceDueDate).order_by(ComplianceDueDate.country_code, ComplianceDueDate.name))
    return [_out(r) for r in rows]


def _countries(db: DbSession) -> set[str]:
    return set(db.scalars(select(Country.code)))


@router.post("/due-dates", response_model=DueDateOut, status_code=201)
def create_due_date(body: DueDateIn, request: Request, db: DbSession, user: CurrentUserDep) -> DueDateOut:
    _check(user)
    try:
        data = rules.validate(body.model_dump(), _countries(db))
    except rules.ComplianceError as exc:
        raise HTTPException(422, str(exc)) from exc
    row = ComplianceDueDate(id=f"cd-{uuid.uuid4().hex[:10]}", note=None, **data)
    db.add(row)
    record_audit(db, actor_id=user.id, action="compliance_due_date_added", entity="compliance_due_dates", entity_id=row.id,
                 after=data, ip=client_ip(request))
    db.commit()
    return _out(row)


@router.put("/due-dates/{row_id}", response_model=DueDateOut)
def update_due_date(row_id: str, body: DueDateIn, request: Request, db: DbSession, user: CurrentUserDep) -> DueDateOut:
    _check(user)
    row = db.get(ComplianceDueDate, row_id)
    if row is None:
        raise HTTPException(404, "Not found.")
    try:
        data = rules.validate(body.model_dump(), _countries(db))
    except rules.ComplianceError as exc:
        raise HTTPException(422, str(exc)) from exc
    before = {k: getattr(row, k) for k in data}
    for k, v in data.items():
        setattr(row, k, v)
    row.note = None  # edited by HR: no longer a sample date
    record_audit(db, actor_id=user.id, action="compliance_due_date_updated", entity="compliance_due_dates",
                 entity_id=row.id, before=before, after=data, ip=client_ip(request))
    db.commit()
    return _out(row)
