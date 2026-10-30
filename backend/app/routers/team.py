"""Team overview for managers (today per person) and approval reminders.

- GET /team/today: for each person in the caller's reporting line — today's attendance, today's timesheet
  (hours logged, day status), approved leave or a holiday today, and the leave left per type.
- POST /approvals/remind: tells the person a request is waiting with that it is still open (a notification),
  at most once a day per request. Audited.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.deps import CurrentUserDep, DbSession, client_ip
from app.models import AttendanceSession, Employee, LeaveRequest, Notification, TimesheetDay, TimesheetEntry
from app.services import leave as leave_rules
from app.services.activity import notify, record_audit
from app.services.scope import GLOBAL_ROLES, manager_chain_ids

router = APIRouter(prefix="/team", tags=["team"])
reminders_router = APIRouter(prefix="/approvals", tags=["approvals"])

TEAM_LIMIT = 300
# Roles that decide steps outside the reporting line (finance, HR, admin) can be reminded too.
STEP_ROLES = GLOBAL_ROLES | {"finance", "payroll", "recruiter"}


class LeaveLeftOut(BaseModel):
    code: str
    name: str
    available: float


class TeamTodayOut(BaseModel):
    employee_id: str
    full_name: str
    direct: bool
    date: str
    check_in: datetime | None = None
    check_out: datetime | None = None
    worked_minutes: int | None = None
    work_mode: str | None = None
    timesheet_hours: float = 0
    timesheet_status: str = "draft"
    leave_code: str | None = None
    holiday: bool = False
    leave_left: list[LeaveLeftOut] = []


@router.get("/today", response_model=list[TeamTodayOut])
def team_today(db: DbSession, user: CurrentUserDep) -> list[TeamTodayOut]:
    """Today for everyone below the caller in the reporting line (managers; others get an empty list)."""
    if not user.employee_id or not user.scope.reports:
        return []
    people = list(db.scalars(
        select(Employee)
        .where(Employee.id.in_(user.scope.reports), Employee.employment_status != "Terminated")
        .order_by(Employee.full_name)
        .limit(TEAM_LIMIT)
    ))
    out: list[TeamTodayOut] = []
    for emp in people:
        today = leave_rules.today_for(emp)
        session = db.scalar(select(AttendanceSession).where(
            AttendanceSession.employee_id == emp.id, AttendanceSession.work_date == today))
        hours = db.scalar(select(func.coalesce(func.sum(TimesheetEntry.hours), 0)).where(
            TimesheetEntry.employee_id == emp.id, TimesheetEntry.work_date == today)) or 0
        day = db.scalar(select(TimesheetDay).where(TimesheetDay.employee_id == emp.id, TimesheetDay.work_date == today))
        leave = db.scalar(select(LeaveRequest).where(
            LeaveRequest.employee_id == emp.id, LeaveRequest.status == "approved",
            LeaveRequest.from_date <= today, LeaveRequest.to_date >= today))
        holiday = today in leave_rules.holiday_dates_for(db, emp, today, today)
        left = [
            LeaveLeftOut(code=b.code, name=b.name, available=round(b.available, 1))
            for b in leave_rules.balances(db, emp, today.year)
            if b.eligible and b.quota > 0 and b.code not in ("unpaid", "lop", "comp_off")
        ]
        out.append(TeamTodayOut(
            employee_id=emp.id, full_name=emp.full_name, direct=emp.manager_id == user.employee_id,
            date=today.isoformat(),
            check_in=session.check_in if session else None,
            check_out=session.check_out if session else None,
            worked_minutes=session.worked_minutes if session else None,
            work_mode=session.work_mode if session else None,
            timesheet_hours=round(float(hours), 2),
            timesheet_status=day.status if day else "draft",
            leave_code=leave.leave_code if leave else None,
            holiday=holiday,
            leave_left=left,
        ))
    return out


class RemindIn(BaseModel):
    approver_id: str = Field(min_length=1, max_length=64)
    requester_id: str = Field(min_length=1, max_length=64)
    kind: str = Field(min_length=1, max_length=80)
    summary: str = Field(default="", max_length=300)
    request_id: str = Field(default="", max_length=120)


class RemindOut(BaseModel):
    sent_to: str
    approver_name: str


@reminders_router.post("/remind", response_model=RemindOut)
def remind_approver(body: RemindIn, request: Request, db: DbSession, user: CurrentUserDep) -> RemindOut:
    """The requester (or anyone above them in the line, or HR) reminds whoever the request waits with."""
    if not user.employee_id:
        raise HTTPException(403, "Only employees can send reminders.")
    requester = db.get(Employee, body.requester_id)
    approver = db.get(Employee, body.approver_id)
    if requester is None or approver is None or approver.employment_status == "Terminated":
        raise HTTPException(404, "Not found.")
    if body.approver_id == user.employee_id:
        raise HTTPException(422, "This request is waiting with you.")
    chain = manager_chain_ids(db, requester.id)
    caller_ok = (
        requester.id == user.employee_id
        or user.employee_id in chain
        or user.account.role in GLOBAL_ROLES
    )
    if not caller_ok:
        raise HTTPException(403, "You can only remind approvers about your own or your team's requests.")
    from app.models import Account

    approver_role = db.scalar(select(Account.role).where(Account.employee_id == approver.id))
    if approver.id not in chain and approver_role not in STEP_ROLES:
        raise HTTPException(422, "That person doesn't approve this request.")
    title = f"Reminder: {body.kind} from {requester.full_name} is waiting for you"
    since = datetime.now(timezone.utc) - timedelta(hours=20)
    already = db.scalar(select(Notification.id).where(
        Notification.recipient_id == approver.id, Notification.title == title, Notification.created_at >= since))
    if already:
        raise HTTPException(429, f"{approver.full_name} was already reminded today.")
    notify(db, recipient_id=approver.id, title=title, body=body.summary.strip(), href="/approvals")
    record_audit(db, actor_id=user.id, action="approval_reminder_sent", entity="approval",
                 entity_id=body.request_id or requester.id, before=None,
                 after={"approver_id": approver.id, "requester_id": requester.id, "kind": body.kind},
                 ip=client_ip(request))
    db.commit()
    return RemindOut(sent_to=approver.id, approver_name=approver.full_name)
