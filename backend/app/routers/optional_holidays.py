"""Optional holidays: the list for the caller's country (anyone), and HR's add / remove. Picks are leave requests
with leave_code "optional" (POST /leave/requests), so they follow the normal approval flow and balance."""

from __future__ import annotations

import uuid
from datetime import date
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.deps import CurrentUserDep, DbSession, client_ip
from app.models import Country, LeaveRequest, OptionalHoliday
from app.services import leave as leave_rules
from app.services import optional_holidays as optional
from app.services.activity import record_audit

router = APIRouter(prefix="/leave/optional-holidays", tags=["leave"])


class OptionalHolidayOut(BaseModel):
    id: str
    country_code: str
    date: date
    name: str
    picked_by: int = 0  # open (pending or approved) picks, for HR


class OptionalHolidayIn(BaseModel):
    country_code: str = Field(min_length=2, max_length=2)
    date: date
    name: str = Field(min_length=2, max_length=60)


def _picks(db: DbSession, rows: list[OptionalHoliday]) -> dict[tuple[str, date], int]:
    if not rows:
        return {}
    from app.models import Employee

    stmt = (
        select(Employee.country_code, LeaveRequest.from_date, func.count())
        .join(Employee, Employee.id == LeaveRequest.employee_id)
        .where(LeaveRequest.leave_code == optional.CODE, LeaveRequest.status.in_(("pending", "approved")),
               LeaveRequest.from_date.in_([r.date for r in rows]))
        .group_by(Employee.country_code, LeaveRequest.from_date)
    )
    return {(cc, d): n for cc, d, n in db.execute(stmt).all()}


def _out(rows: list[OptionalHoliday], picks: dict[tuple[str, date], int]) -> list[OptionalHolidayOut]:
    return [
        OptionalHolidayOut(id=r.id, country_code=r.country_code, date=r.date, name=r.name, picked_by=picks.get((r.country_code, r.date), 0))
        for r in rows
    ]


@router.get("", response_model=list[OptionalHolidayOut])
def list_optional(
    db: DbSession,
    user: CurrentUserDep,
    year: Annotated[int | None, Query(ge=2000, le=2100)] = None,
    country: Annotated[str | None, Query(min_length=2, max_length=2)] = None,
) -> list[OptionalHolidayOut]:
    """The caller's country by default; HR may ask for any country."""
    emp = user.employee
    if country and not user.scope.is_hr and (emp is None or country != emp.country_code):
        raise HTTPException(403, "Only HR can see other countries.")
    code = country or (emp.country_code if emp else None)
    if not code:
        return []
    year = year or (leave_rules.today_for(emp).year if emp else date.today().year)
    rows = optional.list_for(db, code, year)
    return _out(rows, _picks(db, rows) if user.scope.is_hr else {})


@router.post("", response_model=OptionalHolidayOut, status_code=status.HTTP_201_CREATED)
def add_optional(body: OptionalHolidayIn, request: Request, db: DbSession, user: CurrentUserDep) -> OptionalHolidayOut:
    if not user.scope.is_hr:
        raise HTTPException(403, "Only HR can manage optional holidays.")
    cc = body.country_code.upper()
    if db.get(Country, cc) is None:
        raise HTTPException(422, "Pick a country.")
    if body.date < date.today():
        raise HTTPException(422, "Pick a date that hasn't passed.")
    if body.date.weekday() >= 5:
        raise HTTPException(422, "That date is a weekend. Pick a working day.")
    if body.date in leave_rules.holiday_dates(db, cc, body.date, body.date):
        raise HTTPException(422, "That date is already a public holiday.")
    existing = db.scalar(select(OptionalHoliday).where(OptionalHoliday.country_code == cc, OptionalHoliday.date == body.date))
    if existing is not None and existing.active:
        raise HTTPException(409, "There's already an optional holiday on that date.")
    if existing is not None:
        existing.active, existing.name = True, body.name.strip()
        row = existing
    else:
        row = OptionalHoliday(id=f"oh-{uuid.uuid4().hex[:12]}", country_code=cc, date=body.date, name=body.name.strip(), active=True)
        db.add(row)
    db.flush()
    record_audit(db, actor_id=user.id, action="optional_holiday_added", entity="optional_holiday", entity_id=row.id,
                 after={"country": cc, "date": row.date, "name": row.name}, ip=client_ip(request))
    db.commit()
    return _out([row], {})[0]


@router.delete("/{holiday_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_optional(holiday_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> Response:
    if not user.scope.is_hr:
        raise HTTPException(403, "Only HR can manage optional holidays.")
    row = db.get(OptionalHoliday, holiday_id)
    if row is None or not row.active:
        raise HTTPException(404, "Not found.")
    picked = _picks(db, [row]).get((row.country_code, row.date), 0)
    if picked:
        raise HTTPException(409, f"{picked} {'person has' if picked == 1 else 'people have'} picked {row.name}. It can't be removed.")
    row.active = False
    record_audit(db, actor_id=user.id, action="optional_holiday_removed", entity="optional_holiday", entity_id=row.id,
                 before={"country": row.country_code, "date": row.date, "name": row.name}, ip=client_ip(request))
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
