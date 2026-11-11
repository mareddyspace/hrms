"""Manager's team view: per person today's status, worked hours (attendance) against the shift target, late days,
overtime, timesheet gaps, pending approvals and open tasks / tickets.

Rules:
- Worked time comes from attendance sessions (check-out - check-in - breaks); a session still open counts up to now.
- Target = the person's normal day (timesheets.full_day_hours: shift minus break, pro-rated for part-time, at most
  9 h) for each working day so far in the period (not weekly offs, holidays or full-day leave; half on half-day
  leave), today included.
- Overtime = worked time above the day's target, per day (sessions stop themselves at 9 h, so for a 9 h day this is
  claimed overtime only); approved overtime requests in the month are reported separately.
- Late day = a session flagged late (checked in after the shift start).
- Timesheet days missing = past working days this week with no day submitted or approved.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import (
    AttendanceSession, Employee, LeaveRequest, OvertimeRequest, ProjectTask, SharedTask, Ticket, TimesheetDay,
    TimesheetEntry,
)
from app.services import attendance as att
from app.services import leave as leave_rules
from app.services import timesheets as ts_rules

TASK_DONE = ("done", "scheduled", "cancelled")
TICKET_DONE = ("Resolved", "Closed")


@dataclass
class DayRow:
    date: date
    kind: str | None  # None (working day) | weekend | holiday | leave | half-day leave
    leave_code: str | None
    check_in: datetime | None
    check_out: datetime | None
    work_mode: str | None
    worked_minutes: int
    target_minutes: int
    late_minutes: int
    overtime_minutes: int
    timesheet_hours: float
    timesheet_status: str


@dataclass
class PersonSummary:
    employee_id: str
    full_name: str
    designation: str
    department: str
    direct: bool
    date: date
    status: str  # checked_in | checked_out | remote | on_leave | holiday | weekly_off | not_in
    check_in: datetime | None = None
    check_out: datetime | None = None
    work_mode: str | None = None
    leave_code: str | None = None
    today_minutes: int = 0
    today_target_minutes: int = 0
    week_minutes: int = 0
    week_target_minutes: int = 0
    month_minutes: int = 0
    month_target_minutes: int = 0
    late_days_month: int = 0
    overtime_minutes_month: int = 0
    approved_overtime_hours_month: float = 0
    timesheet_submitted: int = 0
    timesheet_missing_days: int = 0
    pending_approvals: int = 0
    open_tasks: int = 0
    overdue_tasks: int = 0
    open_tickets: int = 0
    overdue_tickets: int = 0
    days: list[DayRow] = field(default_factory=list)


def _worked(s: AttendanceSession, now: datetime) -> int:
    if s.worked_minutes is not None:
        return int(s.worked_minutes)
    if s.check_out is None:  # still in: up to now, less breaks so far, at most the 9 h cap
        mins = int((now - s.check_in).total_seconds() // 60) - att.breaks_minutes(att.break_list(s), until=now)
        return max(0, min(att.MAX_WORK_MINUTES, mins))
    return 0


def _leave_days(db: Session, emp_ids: set[str], start: date, end: date) -> dict[tuple[str, date], tuple[str, str]]:
    """{(employee, day): (leave code, "full" | "half" | "working")} for approved leave."""
    out: dict[tuple[str, date], tuple[str, str]] = {}
    for lv in db.scalars(select(LeaveRequest).where(
            LeaveRequest.employee_id.in_(emp_ids), LeaveRequest.status == "approved",
            LeaveRequest.from_date <= end, LeaveRequest.to_date >= start)):
        kind = "working" if lv.leave_code in leave_rules.WORKING_LEAVE else ("half" if lv.half != "none" else "full")
        day = max(lv.from_date, start)
        while day <= min(lv.to_date, end):
            prev = out.get((lv.employee_id, day))
            if prev is None or prev[1] != "full":
                out[(lv.employee_id, day)] = (lv.leave_code, kind)
            day += timedelta(days=1)
    return out


def summarize(db: Session, viewer_id: str, people: list[Employee], with_days: bool = False) -> list[PersonSummary]:
    if not people:
        return []
    ids = {p.id for p in people}
    now = att.now()
    todays = {p.id: leave_rules.today_for(p) for p in people}
    latest = max(todays.values())
    earliest = min(min(t.replace(day=1), t - timedelta(days=t.weekday())) for t in todays.values())
    sessions = {(s.employee_id, s.work_date): s for s in db.scalars(select(AttendanceSession).where(
        AttendanceSession.employee_id.in_(ids), AttendanceSession.work_date >= earliest,
        AttendanceSession.work_date <= latest))}
    leave = _leave_days(db, ids, earliest, latest)
    ts_days = {(d.employee_id, d.work_date): d for d in db.scalars(select(TimesheetDay).where(
        TimesheetDay.employee_id.in_(ids), TimesheetDay.work_date >= earliest, TimesheetDay.work_date <= latest))}
    ts_hours: dict[tuple[str, date], float] = {
        (e, d): float(h) for e, d, h in db.execute(
            select(TimesheetEntry.employee_id, TimesheetEntry.work_date, func.sum(TimesheetEntry.hours))
            .where(TimesheetEntry.employee_id.in_(ids), TimesheetEntry.work_date >= earliest,
                   TimesheetEntry.work_date <= latest)
            .group_by(TimesheetEntry.employee_id, TimesheetEntry.work_date)).all()}
    ot_approved: dict[str, float] = {}
    for e, d, h in db.execute(select(OvertimeRequest.employee_id, OvertimeRequest.work_date, OvertimeRequest.hours)
                              .where(OvertimeRequest.employee_id.in_(ids), OvertimeRequest.status == "Approved",
                                     OvertimeRequest.work_date >= earliest, OvertimeRequest.work_date <= latest)).all():
        if d >= todays[e].replace(day=1):
            ot_approved[e] = ot_approved.get(e, 0) + float(h or 0)

    from app.services import approvals as engine

    pending: dict[str, int] = {}
    for inst in engine.pending_for(db, viewer_id):
        pending[inst.requester_id] = pending.get(inst.requester_id, 0) + 1

    tasks: dict[str, list[date | None]] = {}
    for assignee, due in db.execute(select(SharedTask.assignee_id, SharedTask.due).where(
            SharedTask.assignee_id.in_(ids), SharedTask.status.not_in(TASK_DONE))).all():
        tasks.setdefault(assignee, []).append(due)
    for assignee, due in db.execute(select(ProjectTask.assignee_id, ProjectTask.due_date).where(
            ProjectTask.assignee_id.in_(ids), ProjectTask.status != "done")).all():
        tasks.setdefault(assignee, []).append(due)
    tickets: dict[str, list[date | None]] = {}
    for assignee, due in db.execute(select(Ticket.assignee_id, Ticket.due).where(
            Ticket.assignee_id.in_(ids), Ticket.status.not_in(TICKET_DONE))).all():
        tickets.setdefault(assignee, []).append(due)

    out: list[PersonSummary] = []
    for emp in people:
        today = todays[emp.id]
        week_start = today - timedelta(days=today.weekday())
        month_start = today.replace(day=1)
        start = min(week_start, month_start)
        holidays = leave_rules.holiday_dates_for(db, emp, start, today)
        weekly_off = leave_rules.weekly_off_for_employee(db, emp)
        full_min = int(round(ts_rules.full_day_hours(db, emp) * 60))
        p = PersonSummary(employee_id=emp.id, full_name=emp.full_name, designation=emp.job_title or "",
                          department=emp.department or "", direct=emp.manager_id == viewer_id, date=today,
                          status="not_in")
        day = start
        while day <= today:
            s = sessions.get((emp.id, day))
            lv = leave.get((emp.id, day))
            if day.weekday() in weekly_off:
                kind, target = "weekend", 0
            elif day in holidays:
                kind, target = "holiday", 0
            elif lv and lv[1] == "full":
                kind, target = "leave", 0
            elif lv and lv[1] == "half":
                kind, target = "half-day leave", full_min // 2
            else:
                kind, target = None, full_min
            worked = _worked(s, now) if s else 0
            overtime = max(0, worked - target) if s and s.check_out is not None and target else 0
            if s and s.check_out is not None and not target:
                overtime = worked  # work on a day off is all extra
            row = ts_days.get((emp.id, day))
            if day >= week_start:
                p.week_minutes += worked
                p.week_target_minutes += target
                if day < today and target and (row is None or row.status not in ("submitted", "approved")):
                    p.timesheet_missing_days += 1
            if day >= month_start:
                p.month_minutes += worked
                p.month_target_minutes += target
                p.late_days_month += int(bool(s and s.is_late))
                p.overtime_minutes_month += overtime
                if with_days:
                    p.days.append(DayRow(
                        date=day, kind=kind, leave_code=lv[0] if lv else None,
                        check_in=s.check_in if s else None, check_out=s.check_out if s else None,
                        work_mode=s.work_mode if s else None, worked_minutes=worked, target_minutes=target,
                        late_minutes=(s.late_minutes or 0) if s else 0, overtime_minutes=overtime,
                        timesheet_hours=round(ts_hours.get((emp.id, day), 0.0), 2),
                        timesheet_status=row.status if row else "draft"))
            if day == today:
                p.today_minutes, p.today_target_minutes = worked, target
                p.leave_code = lv[0] if lv else None
                if s:
                    p.check_in, p.check_out, p.work_mode = s.check_in, s.check_out, s.work_mode
                    if s.check_out is not None:
                        p.status = "checked_out"
                    else:
                        p.status = "remote" if s.work_mode in ("wfh", "remote") else "checked_in"
                elif kind == "leave" or (lv and lv[1] == "half"):
                    p.status = "on_leave"
                elif lv and lv[1] == "working":
                    p.status = "remote"
                elif kind == "holiday":
                    p.status = "holiday"
                elif kind == "weekend":
                    p.status = "weekly_off"
            day += timedelta(days=1)
        p.timesheet_submitted = sum(1 for (e, _), r in ts_days.items() if e == emp.id and r.status == "submitted")
        p.approved_overtime_hours_month = round(ot_approved.get(emp.id, 0.0), 2)
        p.pending_approvals = pending.get(emp.id, 0)
        my_tasks, my_tickets = tasks.get(emp.id, []), tickets.get(emp.id, [])
        p.open_tasks, p.overdue_tasks = len(my_tasks), sum(1 for d in my_tasks if d and d < today)
        p.open_tickets, p.overdue_tickets = len(my_tickets), sum(1 for d in my_tickets if d and d < today)
        out.append(p)
    return out


def as_dict(p: PersonSummary) -> dict:
    return asdict(p)
