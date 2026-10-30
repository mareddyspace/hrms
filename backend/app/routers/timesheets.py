from __future__ import annotations

import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from pydantic import BaseModel
from sqlalchemy import and_, exists, func, or_, select

from app.db import utcnow
from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import AttendanceSession, Employee, Project, ProjectMember, TimesheetDay, TimesheetEntry, TimesheetWeek
from app.schemas import (
    DecisionIn,
    ProjectOut,
    TimesheetEntryIn,
    TimesheetEntryOut,
    TimesheetWeekOut,
    UtilizationOut,
    UtilizationRow,
)
from app.services import time_approvals as chain
from app.services import timesheets as rules
from app.services.activity import notify, record_audit
from app.services.decisions import NOT_FOUND, can_decide, can_view, decidable_filter, me, target

router = APIRouter(prefix="/timesheets", tags=["timesheets"])


def _entry_snapshot(e: TimesheetEntry) -> dict:
    return {
        "work_date": e.work_date,
        "project_id": e.project_id,
        "task": e.task,
        "hours": e.hours,
        "billable": e.billable,
        "comment": e.comment,
    }


def _week_snapshot(w: TimesheetWeek) -> dict:
    return {"status": w.status, "week_start": w.week_start, "decided_by": w.decided_by, "decision_note": w.decision_note}


def _week_out(db: DbSession, w: TimesheetWeek, name: str | None, viewer_id: str | None = None) -> TimesheetWeekOut:
    out = TimesheetWeekOut.model_validate(w)
    out.employee_name = name
    out.total_hours = rules.week_total(db, w)
    if w.status != "draft":  # a reopened draft has no live approval
        out.approval = chain.progress_map(db, chain.TIMESHEET, [w.id], viewer_id).get(w.id)
    return out


def _project_for(db: DbSession, emp: Employee, project_id: str) -> Project:
    project = db.get(Project, project_id)
    if project is None or not project.active:
        raise HTTPException(422, "Choose an active project.")
    if db.get(ProjectMember, (project.id, emp.id)) is None:
        raise HTTPException(422, "You are not a member of that project.")
    return project


def _editable_week(db: DbSession, emp: Employee, day: date) -> TimesheetWeek:
    week = rules.get_or_create_week(db, emp, rules.week_start_of(day))
    # an old weekly submission only locks the days it was submitted with
    if day in rules.locked_week_dates(db, week):
        raise HTTPException(409, f"The week of {week.week_start} is {week.status} and can't be changed.")
    _check_day(db, week, emp.id, day)
    target, why = rules.day_target(db, emp, day)
    if target == 0 and why in ("leave", "holiday"):
        raise HTTPException(422, "You're on leave that day, so no hours can be logged." if why == "leave"
                            else "That day is a holiday, so no hours can be logged.")
    return week


TODAY_ONLY = True  # tests that log fixed past dates switch this off (tests/conftest.py)
ATTENDANCE_REQUIRED = True  # today's day needs a check-out first; tests with fixed dates switch this off (tests/conftest.py)


def _check_attendance(db: DbSession, emp: Employee, day: date) -> None:
    """Today's timesheet is submitted after checking out (days sent back or reopened don't need attendance)."""
    session = db.scalar(
        select(AttendanceSession).where(AttendanceSession.employee_id == emp.id, AttendanceSession.work_date == day)
    )
    if session is None or session.check_out is None:
        raise HTTPException(422, "Check out before submitting today's timesheet.")


def _today(db: DbSession, employee_id: str) -> date:
    """The person's own date (an IST employee just after midnight is already on the next day on a UTC server)."""
    from app.services.leave import today_for

    emp = db.get(Employee, employee_id)
    return today_for(emp) if emp else date.today()


def _check_day(db: DbSession, week: TimesheetWeek, employee_id: str, day: date) -> None:
    """Time is logged on the day itself and a submitted or approved day is locked. A day the manager sent back
    (or a week sent back before daily timesheets) can be corrected later."""
    row = rules.get_day(db, employee_id, day)
    if row is not None and row.status in rules.DAY_LOCKED:
        raise HTTPException(409, f"{day} is {row.status} and can't be changed.")
    sent_back = week.status == "rejected" or (row is not None and row.status in rules.DAY_FIXABLE)
    if TODAY_ONLY and day != _today(db, employee_id) and not sent_back:
        raise HTTPException(422, "You can only log time for today. For a missed day, ask your manager to reopen it.")


def _own_entry(db: DbSession, user: CurrentUser, entry_id: str) -> TimesheetEntry:
    entry = db.get(TimesheetEntry, entry_id)
    if entry is None or entry.employee_id != user.employee_id:
        raise NOT_FOUND
    return entry


@router.get("/projects", response_model=list[ProjectOut])
def my_projects(db: DbSession, user: CurrentUserDep, include_inactive: bool = False) -> list[Project]:
    emp = me(user)
    stmt = select(Project).join(ProjectMember, ProjectMember.project_id == Project.id).where(ProjectMember.employee_id == emp.id)
    if not include_inactive:
        stmt = stmt.where(Project.active.is_(True))
    return list(db.scalars(stmt.order_by(Project.code)))


@router.get("/entries", response_model=list[TimesheetEntryOut])
def list_entries(
    db: DbSession,
    user: CurrentUserDep,
    employee_id: str | None = None,
    from_date: Annotated[date | None, Query(alias="from")] = None,
    to_date: Annotated[date | None, Query(alias="to")] = None,
) -> list[TimesheetEntry]:
    emp = target(db, user, employee_id)
    from_date = from_date or rules.week_start_of(date.today())
    to_date = to_date or from_date + timedelta(days=6)
    if to_date < from_date or (to_date - from_date).days > 366:
        raise HTTPException(422, "Choose a date range of at most a year.")
    return list(
        db.scalars(
            select(TimesheetEntry)
            .where(TimesheetEntry.employee_id == emp.id, TimesheetEntry.work_date >= from_date, TimesheetEntry.work_date <= to_date)
            .order_by(TimesheetEntry.work_date, TimesheetEntry.created_at)
        )
    )


@router.post("/entries", response_model=TimesheetEntryOut, status_code=status.HTTP_201_CREATED)
def add_entry(body: TimesheetEntryIn, request: Request, db: DbSession, user: CurrentUserDep) -> TimesheetEntry:
    emp = me(user)
    project = _project_for(db, emp, body.project_id)
    week = _editable_week(db, emp, body.work_date)
    entry = TimesheetEntry(
        id=f"tse-{uuid.uuid4().hex[:12]}",
        employee_id=emp.id,
        week_id=week.id,
        work_date=body.work_date,
        project_id=project.id,
        task=body.task.strip(),
        hours=body.hours,
        billable=project.billable_default if body.billable is None else body.billable,
        comment=(body.comment or "").strip() or None,
    )
    db.add(entry)
    db.flush()
    record_audit(
        db, actor_id=user.id, action="timesheet_entry_added", entity="timesheet_entry", entity_id=entry.id,
        subject_id=emp.id, after=_entry_snapshot(entry), ip=client_ip(request),
    )
    db.commit()
    return entry


@router.put("/entries/{entry_id}", response_model=TimesheetEntryOut)
def update_entry(entry_id: str, body: TimesheetEntryIn, request: Request, db: DbSession, user: CurrentUserDep) -> TimesheetEntry:
    emp = me(user)
    entry = _own_entry(db, user, entry_id)
    old_week = db.get(TimesheetWeek, entry.week_id)
    if old_week is None or rules.entry_in_locked_week(old_week, entry):
        raise HTTPException(409, "That week can't be changed.")
    _check_day(db, old_week, emp.id, entry.work_date)
    project = _project_for(db, emp, body.project_id)
    week = _editable_week(db, emp, body.work_date)
    before = _entry_snapshot(entry)
    entry.week_id = week.id
    entry.work_date = body.work_date
    entry.project_id = project.id
    entry.task = body.task.strip()
    entry.hours = body.hours
    entry.billable = project.billable_default if body.billable is None else body.billable
    entry.comment = (body.comment or "").strip() or None
    record_audit(
        db, actor_id=user.id, action="timesheet_entry_updated", entity="timesheet_entry", entity_id=entry.id,
        subject_id=emp.id, before=before, after=_entry_snapshot(entry), ip=client_ip(request),
    )
    db.commit()
    return entry


@router.delete("/entries/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_entry(entry_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> Response:
    entry = _own_entry(db, user, entry_id)
    week = db.get(TimesheetWeek, entry.week_id)
    if week is None or rules.entry_in_locked_week(week, entry):
        raise HTTPException(409, "That week can't be changed.")
    _check_day(db, week, entry.employee_id, entry.work_date)
    record_audit(
        db, actor_id=user.id, action="timesheet_entry_deleted", entity="timesheet_entry", entity_id=entry.id,
        subject_id=entry.employee_id, before=_entry_snapshot(entry), ip=client_ip(request),
    )
    db.delete(entry)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/weeks/{week_start}/submit", response_model=TimesheetWeekOut)
def submit_week(week_start: date, db: DbSession, user: CurrentUserDep) -> TimesheetWeekOut:
    """Retired: timesheets are daily (today only, 9 h, after check-out; POST /timesheets/days/{date}/submit).
    Weeks submitted before the change can still be decided (POST /timesheets/weeks/{id}/decision)."""
    me(user)
    raise HTTPException(409, "Timesheets are submitted day by day.")


@router.get("/weeks", response_model=list[TimesheetWeekOut])
def list_weeks(
    db: DbSession,
    user: CurrentUserDep,
    view: Annotated[str, Query(pattern="^(mine|team)$")] = "mine",
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> list[TimesheetWeekOut]:
    stmt = select(TimesheetWeek, Employee.full_name).join(Employee, Employee.id == TimesheetWeek.employee_id)
    if view == "mine":
        stmt = stmt.where(TimesheetWeek.employee_id == (user.employee_id or ""))
    else:
        stmt = stmt.where(decidable_filter(user))
    if status_filter:
        stmt = stmt.where(TimesheetWeek.status == status_filter)
    rows = db.execute(stmt.order_by(TimesheetWeek.week_start.desc(), Employee.full_name).limit(limit)).all()
    return [_week_out(db, w, name, user.employee_id) for w, name in rows]


class WeekEntryOut(TimesheetEntryOut):
    project_code: str = ""
    project_name: str = ""


class WeekDetailOut(BaseModel):
    week: TimesheetWeekOut
    entries: list[WeekEntryOut]


@router.get("/weeks/{week_id}/detail", response_model=WeekDetailOut)
def week_detail(week_id: str, db: DbSession, user: CurrentUserDep) -> WeekDetailOut:
    """One week with its entries and project names: for the person, their reporting line, HR and chain approvers."""
    week = db.get(TimesheetWeek, week_id)
    emp = db.get(Employee, week.employee_id) if week else None
    if week is None or emp is None:
        raise NOT_FOUND
    own = emp.id == user.employee_id
    instance = chain.pending_instance(db, chain.TIMESHEET, week.id)
    if not (own or can_view(db, user, emp) or chain.may_follow(db, user, instance)):
        raise NOT_FOUND
    rows = db.execute(
        select(TimesheetEntry, Project.code, Project.name)
        .join(Project, Project.id == TimesheetEntry.project_id)
        .where(TimesheetEntry.id.in_([e.id for e in rules.week_entries(db, week)]))
        .order_by(TimesheetEntry.work_date, TimesheetEntry.created_at)
    ).all()
    entries = []
    for entry, code, name in rows:
        out = WeekEntryOut.model_validate(entry)
        out.project_code = code
        out.project_name = name
        entries.append(out)
    return WeekDetailOut(week=_week_out(db, week, emp.full_name, user.employee_id), entries=entries)


@router.post("/weeks/{week_id}/decision", response_model=TimesheetWeekOut)
def decide_week(week_id: str, body: DecisionIn, request: Request, db: DbSession, user: CurrentUserDep) -> TimesheetWeekOut:
    week = db.get(TimesheetWeek, week_id)
    emp = db.get(Employee, week.employee_id) if week else None
    instance = chain.pending_instance(db, chain.TIMESHEET, week.id) if week else None
    if week is None or emp is None or not (can_view(db, user, emp) or chain.may_follow(db, user, instance)):
        raise NOT_FOUND
    if instance is not None and week.status == "submitted":
        # through the approval chain; the week is updated when the last step is decided
        chain.decide(db, user, instance, emp, body.decision, body.note, client_ip(request))
        db.commit()
        return _week_out(db, week, emp.full_name, user.employee_id)
    if not can_decide(db, user, emp, "timesheet"):
        raise HTTPException(403, "You can't decide this timesheet.")
    if week.status != "submitted":
        raise HTTPException(409, f"This timesheet is {week.status}.")
    if body.decision == "reject" and not (body.note or "").strip():
        raise HTTPException(422, "Add a note saying why the timesheet is rejected.")
    before = _week_snapshot(week)
    week.status = "approved" if body.decision == "approve" else "rejected"
    week.decided_by = user.employee_id
    week.decided_at = utcnow()
    week.decision_note = (body.note or "").strip() or None
    record_audit(
        db, actor_id=user.id, action=f"timesheet_{week.status}", entity="timesheet_week", entity_id=week.id,
        subject_id=emp.id, before=before, after=_week_snapshot(week), ip=client_ip(request),
    )
    decider = user.employee.full_name if user.employee else user.id
    notify(
        db,
        recipient_id=emp.id,
        title=f"Timesheet {week.status}",
        body=f"{decider} {week.status} your timesheet for the week of {week.week_start}."
        + (f" Note: {week.decision_note}" if week.decision_note else ""),
        href=f"/timesheets/weeks/{week.id}",
    )
    db.commit()
    return _week_out(db, week, emp.full_name)


# ---------- daily timesheets ----------
class TimesheetDayOut(BaseModel):
    """One person's day. id is None for a day not submitted yet (draft)."""

    id: str | None = None
    employee_id: str
    employee_name: str | None = None
    work_date: date
    status: str = "draft"  # draft | submitted | approved | rejected (sent back) | reopened (missed day)
    total_hours: float = 0
    target_hours: float = rules.DAY_TARGET
    day_kind: str | None = None  # None (working day) | half-day leave | leave | weekend | holiday
    submitted_at: datetime | None = None
    decided_by: str | None = None
    decided_by_name: str | None = None
    decided_at: datetime | None = None
    decision_note: str | None = None
    approval: dict | None = None
    waiting_on_me: bool = False
    can_decide: bool = False
    entries: list[WeekEntryOut] = []


class TeamPersonOut(BaseModel):
    employee_id: str
    employee_name: str
    employee_code: str = ""
    department: str = ""
    week_total: float = 0
    projects: dict[str, float] = {}
    days: list[TimesheetDayOut] = []


def _day_snapshot(d: TimesheetDay) -> dict:
    return {"status": d.status, "work_date": d.work_date, "decided_by": d.decided_by, "decision_note": d.decision_note}


def _entries_with_projects(db: DbSession, employee_ids: set[str], start: date, end: date) -> list[WeekEntryOut]:
    if not employee_ids:
        return []
    rows = db.execute(
        select(TimesheetEntry, Project.code, Project.name)
        .join(Project, Project.id == TimesheetEntry.project_id)
        .where(TimesheetEntry.employee_id.in_(employee_ids), TimesheetEntry.work_date >= start, TimesheetEntry.work_date <= end)
        .order_by(TimesheetEntry.work_date, TimesheetEntry.created_at)
    ).all()
    out = []
    for entry, code, name in rows:
        item = WeekEntryOut.model_validate(entry)
        item.project_code, item.project_name = code, name
        out.append(item)
    return out


def _day_out(
    db: DbSession, user: CurrentUser, emp: Employee, day: date, row: TimesheetDay | None,
    entries: list[WeekEntryOut] | None = None, names: dict[str, str] | None = None,
) -> TimesheetDayOut:
    if entries is None:
        entries = _entries_with_projects(db, {emp.id}, day, day)
    target_hours, kind = rules.day_target(db, emp, day)
    out = TimesheetDayOut(
        employee_id=emp.id, employee_name=emp.full_name, work_date=day, target_hours=target_hours, day_kind=kind,
        total_hours=round(sum(e.hours for e in entries), 2), entries=entries,
    )
    if row is None:
        return out
    out.id, out.status, out.submitted_at = row.id, row.status, row.submitted_at
    out.decided_by, out.decided_at, out.decision_note = row.decided_by, row.decided_at, row.decision_note
    if row.decided_by:
        name = (names or {}).get(row.decided_by)
        if name is None:
            person = db.get(Employee, row.decided_by)
            name = person.full_name if person else row.decided_by
        out.decided_by_name = name
    if row.status != "draft":
        out.approval = chain.progress_map(db, chain.TIMESHEET, [row.id], user.employee_id).get(row.id)
    if row.status == "submitted" and emp.id != user.employee_id:
        instance = chain.pending_instance(db, chain.TIMESHEET, row.id)
        if instance is not None:
            out.waiting_on_me = bool(out.approval and out.approval.get("waiting_on_me"))
            out.can_decide = out.waiting_on_me or can_decide(db, user, emp, "timesheet")
        else:  # no one above the person (or submitted before a chain): HR in scope / the reporting line decides
            out.can_decide = can_decide(db, user, emp, "timesheet")
            out.waiting_on_me = out.can_decide
    return out


@router.post("/days/{work_date}/submit", response_model=TimesheetDayOut)
def submit_day(work_date: date, request: Request, db: DbSession, user: CurrentUserDep) -> TimesheetDayOut:
    """Send one day to the manager (or, for someone with no one above them, to HR). Needs 9 h (4.5 h on half-day leave)
    and, for today, a check-out."""
    emp = me(user)
    row = rules.get_day(db, emp.id, work_date)
    today = _today(db, emp.id)
    if work_date > today:
        raise HTTPException(422, "You can't submit a day that hasn't happened yet.")
    if TODAY_ONLY and work_date != today and not (row is not None and row.status in rules.DAY_FIXABLE):
        raise HTTPException(422, "You can only submit today's timesheet. For a missed day, ask your manager to send the day back.")
    if (ATTENDANCE_REQUIRED and work_date == today and not (row is not None and row.status in rules.DAY_FIXABLE)
            and rules.day_target(db, emp, work_date)[1] not in ("weekend", "holiday")):  # no check-in on days off
        _check_attendance(db, emp, work_date)
    try:
        rules.validate_day_submit(db, emp, work_date, row)
    except rules.TimesheetError as exc:
        raise HTTPException(422, str(exc)) from exc
    if row is None:
        row = TimesheetDay(id=f"tsd-{uuid.uuid4().hex[:12]}", employee_id=emp.id, work_date=work_date, status="draft")
        db.add(row)
        db.flush()
    before = _day_snapshot(row)
    row.status = "submitted"
    row.submitted_at = utcnow()
    row.decided_by = row.decided_at = row.decision_note = None
    db.flush()
    if emp.manager_id:
        # approval chain "timesheet" (manager); the engine tells the approvers, _timesheet_finished updates the day
        chain.start(db, chain.TIMESHEET, row.id, emp, user.id)
    else:
        # no one above this person: HR in their scope decides (approvals inbox, Team timesheets)
        from app.services.approvals import resolve_group

        for hr_id in resolve_group(db, "hr", emp):
            notify(db, recipient_id=hr_id, title=f"Timesheet from {emp.full_name}",
                   body=f"{emp.full_name} submitted the timesheet for {work_date}. Waiting for your approval.",
                   href=f"/timesheets/days/{row.id}")
    record_audit(
        db, actor_id=user.id, action="timesheet_day_submitted", entity="timesheet_day", entity_id=row.id,
        subject_id=emp.id, before=before, after=_day_snapshot(row), ip=client_ip(request),
    )
    db.commit()
    return _day_out(db, user, emp, work_date, row)


@router.get("/days", response_model=list[TimesheetDayOut])
def list_days(
    db: DbSession,
    user: CurrentUserDep,
    view: Annotated[str, Query(pattern="^(mine|waiting)$")] = "mine",
    from_date: Annotated[date | None, Query(alias="from")] = None,
    to_date: Annotated[date | None, Query(alias="to")] = None,
) -> list[TimesheetDayOut]:
    """mine: my submitted / approved / sent-back days in a range (a day with no row is a draft and isn't listed).
    waiting: everyone's submitted days the caller can approve or send back now (any date), oldest first."""
    if view == "waiting":
        if not user.employee_id:
            return []
        from app.services import approvals as engine

        chained = {i.entity_id for i in engine.pending_instances(db, chain.TIMESHEET).values()}
        mine = {i.entity_id for i in engine.pending_for(db, user.employee_id) if i.type == chain.TIMESHEET}
        stmt = (
            select(TimesheetDay, Employee).join(Employee, Employee.id == TimesheetDay.employee_id)
            .where(TimesheetDay.status == "submitted", TimesheetDay.employee_id != user.employee_id,
                   or_(TimesheetDay.id.in_(mine), and_(decidable_filter(user), TimesheetDay.id.not_in(chained))))
            .order_by(TimesheetDay.work_date, Employee.full_name)
        )
        out = []
        for row, emp in db.execute(stmt).all():
            item = _day_out(db, user, emp, row.work_date, row)
            if item.can_decide:
                out.append(item)
        return out
    emp = me(user)
    to_date = to_date or date.today() + timedelta(days=13)
    from_date = from_date or to_date - timedelta(days=200)
    if to_date < from_date or (to_date - from_date).days > 366:
        raise HTTPException(422, "Choose a date range of at most a year.")
    rows = list(db.scalars(select(TimesheetDay).where(
        TimesheetDay.employee_id == emp.id, TimesheetDay.work_date >= from_date, TimesheetDay.work_date <= to_date,
    ).order_by(TimesheetDay.work_date)))
    entries = _entries_with_projects(db, {emp.id}, from_date, to_date)
    return [_day_out(db, user, emp, r.work_date, r, [e for e in entries if e.work_date == r.work_date]) for r in rows]


@router.get("/team-days", response_model=list[TeamPersonOut])
def team_days(db: DbSession, user: CurrentUserDep, week_start: date | None = None) -> list[TeamPersonOut]:
    """Who logged how many hours in a week, per day and project, with each day's status: a manager's whole
    reporting line, HR's people in scope who logged or submitted time, and anyone whose day waits on the caller."""
    if not user.employee_id:
        return []
    start = rules.week_start_of(week_start or date.today())
    end = start + timedelta(days=6)
    ids: set[str] = set(user.scope.reports)
    if user.scope.is_hr:
        logged = select(TimesheetEntry.employee_id).where(TimesheetEntry.work_date >= start, TimesheetEntry.work_date <= end)
        submitted = select(TimesheetDay.employee_id).where(TimesheetDay.work_date >= start, TimesheetDay.work_date <= end)
        ids |= set(db.scalars(select(Employee.id).where(
            user.scope.employee_filter(), or_(Employee.id.in_(logged), Employee.id.in_(submitted)))))
    from app.services import approvals as engine

    for inst in engine.pending_for(db, user.employee_id):
        if inst.type == chain.TIMESHEET and inst.entity_id.startswith("tsd-"):
            ids.add(inst.requester_id)
    ids.discard(user.employee_id)
    if not ids:
        return []
    people = list(db.scalars(select(Employee).where(Employee.id.in_(ids)).order_by(Employee.full_name)))
    rows = {(r.employee_id, r.work_date): r for r in db.scalars(select(TimesheetDay).where(
        TimesheetDay.employee_id.in_(ids), TimesheetDay.work_date >= start, TimesheetDay.work_date <= end))}
    deciders = {r.decided_by for r in rows.values() if r.decided_by}
    names = dict(db.execute(select(Employee.id, Employee.full_name).where(Employee.id.in_(deciders))).all()) if deciders else {}
    entries = _entries_with_projects(db, ids, start, end)
    out = []
    for emp in people:
        mine = [e for e in entries if e.employee_id == emp.id]
        projects: dict[str, float] = defaultdict(float)
        for e in mine:
            projects[e.project_name or e.project_code] += e.hours
        days = []
        for i in range(7):
            day = start + timedelta(days=i)
            days.append(_day_out(db, user, emp, day, rows.get((emp.id, day)), [e for e in mine if e.work_date == day], names))
        out.append(TeamPersonOut(
            employee_id=emp.id, employee_name=emp.full_name, employee_code=emp.employee_code or "",
            department=emp.department or "", week_total=round(sum(e.hours for e in mine), 2),
            projects={k: round(v, 2) for k, v in sorted(projects.items(), key=lambda kv: -kv[1])}, days=days,
        ))
    return out


class ReopenIn(BaseModel):
    note: str


@router.post("/team/{employee_id}/days/{work_date}/reopen", response_model=TimesheetDayOut)
def reopen_day(employee_id: str, work_date: date, body: ReopenIn, request: Request, db: DbSession,
               user: CurrentUserDep) -> TimesheetDayOut:
    """A missed (or never submitted) past day: the person's manager - or HR for someone with no manager - opens it so
    they can log and submit it later."""
    emp = db.get(Employee, employee_id)
    if emp is None or not user.employee_id or emp.id == user.employee_id:
        raise NOT_FOUND
    if emp.manager_id:  # the line manager (or someone covering for them) - not a skip-level manager
        from app.services.approvals import delegators_for

        allowed = emp.manager_id == user.employee_id or emp.manager_id in delegators_for(db, user.employee_id, "timesheet")
    else:
        allowed = user.scope.is_hr and user.scope.can_see(emp)
    if not allowed:
        if not can_view(db, user, emp):
            raise NOT_FOUND
        raise HTTPException(403, "Only their manager can reopen a day (HR for someone with no manager).")
    note = body.note.strip()
    if not note:
        raise HTTPException(422, "Add a short reason.")
    if work_date >= _today(db, emp.id):
        raise HTTPException(422, "Choose a past day. Today is open already.")
    target_hours, kind = rules.day_target(db, emp, work_date)
    if target_hours <= 0:
        raise HTTPException(422, f"{work_date} is not a working day for them ({kind}).")
    week = db.scalar(select(TimesheetWeek).where(TimesheetWeek.employee_id == emp.id,
                                                 TimesheetWeek.week_start == rules.week_start_of(work_date)))
    if week is not None and work_date in rules.locked_week_dates(db, week):
        raise HTTPException(409, f"{work_date} is in a week that is already {week.status}.")
    row = rules.get_day(db, emp.id, work_date)
    if row is not None and row.status in rules.DAY_LOCKED:
        raise HTTPException(409, f"{work_date} is already {row.status}.")
    if row is None:
        row = TimesheetDay(id=f"tsd-{uuid.uuid4().hex[:12]}", employee_id=emp.id, work_date=work_date, status="draft")
        db.add(row)
        db.flush()
    before = _day_snapshot(row)
    row.status = "reopened"
    row.decided_by = user.employee_id
    row.decided_at = utcnow()
    row.decision_note = note
    record_audit(
        db, actor_id=user.id, action="timesheet_day_reopened", entity="timesheet_day", entity_id=row.id,
        subject_id=emp.id, before=before, after=_day_snapshot(row), ip=client_ip(request),
    )
    who = user.employee.full_name if user.employee else user.id
    notify(db, recipient_id=emp.id, title="Timesheet day reopened",
           body=f"{who} reopened {work_date:%a %d %b} so you can log and submit it. Note: {note}",
           href=f"/timesheets/days/{row.id}")
    db.commit()
    return _day_out(db, user, emp, work_date, row)


def _visible_day(db: DbSession, user: CurrentUser, day_id: str) -> tuple[TimesheetDay, Employee]:
    row = db.get(TimesheetDay, day_id)
    emp = db.get(Employee, row.employee_id) if row else None
    if row is None or emp is None:
        raise NOT_FOUND
    instance = chain.pending_instance(db, chain.TIMESHEET, row.id)
    if not (emp.id == user.employee_id or can_view(db, user, emp) or chain.may_follow(db, user, instance)):
        raise NOT_FOUND
    return row, emp


@router.get("/days/{day_id}/detail", response_model=TimesheetDayOut)
def day_detail(day_id: str, db: DbSession, user: CurrentUserDep) -> TimesheetDayOut:
    row, emp = _visible_day(db, user, day_id)
    return _day_out(db, user, emp, row.work_date, row)


@router.post("/days/{day_id}/decision", response_model=TimesheetDayOut)
def decide_day(day_id: str, body: DecisionIn, request: Request, db: DbSession, user: CurrentUserDep) -> TimesheetDayOut:
    """Approve, or send back ("reject", with a comment) a submitted day."""
    row, emp = _visible_day(db, user, day_id)
    if body.decision == "reject" and not (body.note or "").strip():
        raise HTTPException(422, "Add a comment saying what to change.")
    instance = chain.pending_instance(db, chain.TIMESHEET, row.id)
    if instance is not None and row.status == "submitted":
        # through the approval chain; the day is updated when the last step is decided (_timesheet_finished)
        chain.decide(db, user, instance, emp, body.decision, body.note, client_ip(request))
        db.commit()
        return _day_out(db, user, emp, row.work_date, row)
    if not can_decide(db, user, emp, "timesheet"):
        raise HTTPException(403, "You can't decide this timesheet.")
    if row.status != "submitted":
        raise HTTPException(409, f"This day is {row.status}.")
    before = _day_snapshot(row)
    row.status = "approved" if body.decision == "approve" else "rejected"
    row.decided_by = user.employee_id
    row.decided_at = utcnow()
    row.decision_note = (body.note or "").strip() or None
    record_audit(
        db, actor_id=user.id, action=f"timesheet_day_{row.status}", entity="timesheet_day", entity_id=row.id,
        subject_id=emp.id, before=before, after=_day_snapshot(row), ip=client_ip(request),
    )
    decider = user.employee.full_name if user.employee else user.id
    verb = "approved" if row.status == "approved" else "sent back"
    notify(db, recipient_id=emp.id, title=f"Timesheet {verb}",
           body=f"{decider} {verb} your timesheet for {row.work_date}." + (f" Note: {row.decision_note}" if row.decision_note else ""),
           href=f"/timesheets/days/{row.id}")
    db.commit()
    return _day_out(db, user, emp, row.work_date, row)


def _row(key: str, name: str, total: float, billable: float) -> UtilizationRow:
    return UtilizationRow(
        id=key, name=name, total_hours=round(total, 2), billable_hours=round(billable, 2),
        billable_pct=round(100 * billable / total, 1) if total else 0.0,
    )


@router.get("/utilization", response_model=UtilizationOut)
def utilization(
    db: DbSession,
    user: CurrentUserDep,
    from_date: Annotated[date | None, Query(alias="from")] = None,
    to_date: Annotated[date | None, Query(alias="to")] = None,
    employee_id: str | None = None,
    project_id: str | None = None,
    approved_only: bool = False,
) -> UtilizationOut:
    """Billable share of logged hours for everyone in the caller's data scope (or just yourself)."""
    to_date = to_date or date.today()
    from_date = from_date or to_date.replace(day=1)
    if to_date < from_date or (to_date - from_date).days > 366:
        raise HTTPException(422, "Choose a date range of at most a year.")
    stmt = (
        select(
            TimesheetEntry.employee_id, Employee.full_name, TimesheetEntry.project_id, Project.code, Project.name,
            TimesheetEntry.billable, func.sum(TimesheetEntry.hours),
        )
        .join(Employee, Employee.id == TimesheetEntry.employee_id)
        .join(Project, Project.id == TimesheetEntry.project_id)
        .where(user.scope.employee_filter(), TimesheetEntry.work_date >= from_date, TimesheetEntry.work_date <= to_date)
        .group_by(TimesheetEntry.employee_id, Employee.full_name, TimesheetEntry.project_id, Project.code, Project.name, TimesheetEntry.billable)
    )
    if employee_id:
        target(db, user, employee_id)  # 404 when out of scope
        stmt = stmt.where(TimesheetEntry.employee_id == employee_id)
    if project_id:
        stmt = stmt.where(TimesheetEntry.project_id == project_id)
    if approved_only:
        approved_day = exists().where(
            TimesheetDay.employee_id == TimesheetEntry.employee_id, TimesheetDay.work_date == TimesheetEntry.work_date,
            TimesheetDay.status == "approved",
        )
        approved_week = and_(TimesheetWeek.status == "approved", or_(
            TimesheetWeek.submitted_at.is_(None), TimesheetEntry.created_at <= TimesheetWeek.submitted_at))
        stmt = stmt.join(TimesheetWeek, TimesheetWeek.id == TimesheetEntry.week_id).where(or_(approved_week, approved_day))

    people: dict[str, list] = defaultdict(lambda: ["", 0.0, 0.0])
    projects: dict[str, list] = defaultdict(lambda: ["", 0.0, 0.0])
    for emp_id, emp_name, proj_id, code, proj_name, billable, hours in db.execute(stmt).all():
        hours = float(hours or 0)
        for bucket, key, name in ((people, emp_id, emp_name), (projects, proj_id, f"{code} - {proj_name}")):
            bucket[key][0] = name
            bucket[key][1] += hours
            if billable:
                bucket[key][2] += hours
    total = sum(v[1] for v in people.values())
    billable = sum(v[2] for v in people.values())
    overall = _row("all", "All", total, billable)
    return UtilizationOut(
        from_date=from_date,
        to_date=to_date,
        total_hours=overall.total_hours,
        billable_hours=overall.billable_hours,
        billable_pct=overall.billable_pct,
        people=sorted((_row(k, *v) for k, v in people.items()), key=lambda r: r.name),
        projects=sorted((_row(k, *v) for k, v in projects.items()), key=lambda r: r.name),
    )
