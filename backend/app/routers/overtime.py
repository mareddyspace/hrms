"""Overtime and comp-off requests (/overtime). Rules in app/services/overtime.py.

scope=mine | team (my reporting line plus what waits on me) | all (HR, finance, admin). Decisions go through the
approval chain (same as POST /approvals/{id}/decision).
"""

from __future__ import annotations

from datetime import date
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import Employee, OvertimeRequest
from app.routers.self_service import _can_view, _list, _steps
from app.schemas.self_service import DecisionIn, StepOut
from app.services import approvals as engine
from app.services import overtime as rules
from app.services.decisions import NOT_FOUND, me
from app.services.leave import today_for
from app.services.self_service import RequestError
from app.services.workflow_defaults import decide_http

router = APIRouter(prefix="/overtime", tags=["overtime"])

Scope = Annotated[str, Query(pattern="^(mine|team|all)$")]


class OvertimeIn(BaseModel):
    work_date: date
    hours: float = Field(gt=0, le=24)
    reason: str = Field(min_length=1, max_length=1000)
    outcome: str = Field(default="pay", pattern="^(pay|comp_off)$")


class OvertimeOut(BaseModel):
    id: str
    employee_id: str
    employee_name: str
    work_date: date
    hours: float
    reason: str
    outcome: str
    status: str
    submitted_on: date
    attendance_minutes: int | None
    hourly_rate: float
    multiplier: float
    amount: float
    currency: str
    comp_off_days: float
    payout_month: str | None
    paid: bool
    steps: list[StepOut]
    can_decide: bool
    can_withdraw: bool


class OvertimePolicyOut(BaseModel):
    country_code: str
    weekly_hours: float
    day_hours: float
    multiplier: float
    max_hours: float
    comp_off: bool
    max_days_back: int
    hourly_rate: float
    currency: str


class AttendanceDayOut(BaseModel):
    work_date: date
    worked_minutes: int | None


def _all_ok(user: CurrentUser) -> bool:
    return user.scope.is_hr or user.account.role in ("admin", "super_admin", "finance")


def _err(exc: RequestError) -> HTTPException:
    text = str(exc)
    return HTTPException(409 if "already" in text else 422, text)


def _out(db: DbSession, user: CurrentUser, row: OvertimeRequest, emp: Employee) -> OvertimeOut:
    instance = rules.instance_of(db, row)
    return OvertimeOut(
        id=row.id, employee_id=emp.id, employee_name=emp.full_name, work_date=row.work_date, hours=row.hours,
        reason=row.reason, outcome=row.outcome, status=row.status, submitted_on=row.created_at.date(),
        attendance_minutes=row.attendance_minutes, hourly_rate=row.hourly_rate, multiplier=row.multiplier,
        amount=row.amount, currency=row.currency, comp_off_days=row.comp_off_days, payout_month=row.payout_month,
        paid=bool(row.paid_run_id), steps=_steps(db, instance), can_decide=engine.can_act(db, instance, user.employee_id),
        can_withdraw=row.status in rules.PENDING and emp.id == user.employee_id,
    )


def _get(db: DbSession, user: CurrentUser, row_id: str) -> tuple[OvertimeRequest, Employee]:
    row = db.get(OvertimeRequest, row_id)
    emp = db.get(Employee, row.employee_id) if row else None
    if row is None or emp is None or not _can_view(db, user, row, emp, _all_ok(user)):
        raise NOT_FOUND
    return row, emp


@router.get("/policy", response_model=OvertimePolicyOut)
def policy(db: DbSession, user: CurrentUserDep) -> OvertimePolicyOut:
    emp = me(user)
    r = rules.rules_for(emp.country_code)
    return OvertimePolicyOut(country_code=emp.country_code, weekly_hours=r["weekly_hours"], day_hours=r["day_hours"],
                             multiplier=r["multiplier"], max_hours=r["max_hours"], comp_off=r["comp_off"],
                             max_days_back=rules.MAX_DAYS_BACK, hourly_rate=rules.hourly_rate(db, emp, today_for(emp)),
                             currency=emp.currency)


@router.get("/attendance", response_model=AttendanceDayOut)
def attendance_day(work_date: date, db: DbSession, user: CurrentUserDep) -> AttendanceDayOut:
    """My worked minutes on a date (null = no attendance that day), so the form can warn before sending."""
    emp = me(user)
    return AttendanceDayOut(work_date=work_date, worked_minutes=rules.attendance_minutes(db, emp.id, work_date))


@router.get("", response_model=list[OvertimeOut])
def list_overtime(db: DbSession, user: CurrentUserDep, scope: Scope = "mine",
                  limit: Annotated[int, Query(ge=1, le=500)] = 200) -> list[OvertimeOut]:
    out = []
    for row in _list(db, user, OvertimeRequest, rules.OVERTIME, scope, _all_ok(user), limit):
        emp = db.get(Employee, row.employee_id)
        if emp is not None and _can_view(db, user, row, emp, _all_ok(user)):
            out.append(_out(db, user, row, emp))
    return out


@router.post("", response_model=OvertimeOut, status_code=status.HTTP_201_CREATED)
def create_overtime(body: OvertimeIn, request: Request, db: DbSession, user: CurrentUserDep) -> OvertimeOut:
    emp = me(user)
    try:
        row = rules.create(db, emp, body.model_dump(), user.id, client_ip(request))
    except RequestError as exc:
        db.rollback()
        raise _err(exc) from exc
    db.commit()
    return _out(db, user, row, emp)


@router.post("/{row_id}/decision", response_model=OvertimeOut)
def decide_overtime(row_id: str, body: DecisionIn, request: Request, db: DbSession, user: CurrentUserDep) -> OvertimeOut:
    row, emp = _get(db, user, row_id)
    decide_http(db, rules.instance_of(db, row), user.employee_id, body.decision, body.note, user.id, client_ip(request))
    db.commit()
    return _out(db, user, row, emp)


@router.post("/{row_id}/withdraw", response_model=OvertimeOut)
def withdraw_overtime(row_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> OvertimeOut:
    row, emp = _get(db, user, row_id)
    if emp.id != user.employee_id:
        raise HTTPException(403, "Only the person who asked can withdraw it.")
    try:
        rules.withdraw(db, row, emp, user.id, client_ip(request))
    except RequestError as exc:
        db.rollback()
        raise _err(exc) from exc
    db.commit()
    return _out(db, user, row, emp)
