from __future__ import annotations

import uuid
from collections import defaultdict
from datetime import date, timedelta
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from sqlalchemy import func, select

from app.db import utcnow
from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import Employee, Project, ProjectMember, TimesheetEntry, TimesheetWeek
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
    if week.status not in rules.EDITABLE:
        raise HTTPException(409, f"The week of {week.week_start} is {week.status} and can't be changed.")
    return week


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
    if old_week is None or old_week.status not in rules.EDITABLE:
        raise HTTPException(409, "That week can't be changed.")
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
    if week is None or week.status not in rules.EDITABLE:
        raise HTTPException(409, "That week can't be changed.")
    record_audit(
        db, actor_id=user.id, action="timesheet_entry_deleted", entity="timesheet_entry", entity_id=entry.id,
        subject_id=entry.employee_id, before=_entry_snapshot(entry), ip=client_ip(request),
    )
    db.delete(entry)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/weeks/{week_start}/submit", response_model=TimesheetWeekOut)
def submit_week(week_start: date, request: Request, db: DbSession, user: CurrentUserDep) -> TimesheetWeekOut:
    emp = me(user)
    if week_start.weekday() != 0:
        raise HTTPException(422, "A timesheet week starts on a Monday.")
    week = db.scalar(select(TimesheetWeek).where(TimesheetWeek.employee_id == emp.id, TimesheetWeek.week_start == week_start))
    if week is None:
        raise HTTPException(422, "Add at least one entry before submitting.")
    try:
        rules.validate_submit(db, week)
    except rules.TimesheetError as exc:
        raise HTTPException(422, str(exc)) from exc
    before = _week_snapshot(week)
    week.status = "submitted"
    week.submitted_at = utcnow()
    week.decided_by = week.decided_at = week.decision_note = None
    db.flush()
    # approval chain "timesheet" (manager); nobody above this person: approved straight away. The engine tells the approvers.
    chain.start(db, chain.TIMESHEET, week.id, emp, user.id)
    record_audit(
        db, actor_id=user.id, action="timesheet_submitted", entity="timesheet_week", entity_id=week.id,
        subject_id=emp.id, before=before, after=_week_snapshot(week), ip=client_ip(request),
    )
    db.commit()
    return _week_out(db, week, emp.full_name, user.employee_id)


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
    if not can_decide(db, user, emp):
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
        stmt = stmt.join(TimesheetWeek, TimesheetWeek.id == TimesheetEntry.week_id).where(TimesheetWeek.status == "approved")

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
