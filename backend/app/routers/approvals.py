"""Approvals inbox (everything waiting on me), generic approval instances, and workflow definitions (admin)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, Request
from sqlalchemy import and_, or_, select

from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import (
    ApprovalInstance,
    AttendanceCorrection,
    CompProposal,
    Employee,
    ExitCase,
    LeaveRequest,
    LetterRequest,
    LifecycleAction,
    TimesheetDay,
    TimesheetWeek,
)
from app.schemas import (
    ApprovalDecisionOut,
    ApprovalInstanceOut,
    DecisionIn,
    PendingItemOut,
    WorkflowIn,
    WorkflowOut,
)
from app.schemas.approval_chains import WorkflowTypeOut
from app.services import approvals as engine
from app.services import time_approvals as chain
from app.services.activity import record_audit
from app.services.decisions import NOT_FOUND, can_view, decidable_filter

router = APIRouter(prefix="/approvals", tags=["approvals"])
workflows_router = APIRouter(prefix="/workflows", tags=["approvals"])

WorkflowType = Annotated[str, Path(pattern=r"^[a-z][a-z0-9_]{1,63}$")]


def _instance_summary(db: DbSession, inst: ApprovalInstance) -> str:
    """Plain text for the inbox: what is asked and for whom (no pay amounts)."""
    step = f" (step {inst.current_step + 1} of {len(inst.steps)})" if len(inst.steps) > 1 else ""

    def name(emp_id: str | None) -> str:
        emp = db.get(Employee, emp_id) if emp_id else None
        return emp.full_name if emp else "an employee"

    if inst.type == "letter" and (lr := db.get(LetterRequest, inst.entity_id)):
        from app.services.letters import LETTER_TYPES

        label = LETTER_TYPES.get(lr.letter_type, {}).get("label", f"{lr.letter_type} letter")
        return f"{label} for {name(lr.employee_id)}{step}"
    if inst.type == "compensation" and (cp := db.get(CompProposal, inst.entity_id)):
        return f"Pay increase of {cp.increase_pct:g}% for {name(cp.employee_id)}{step}"
    if inst.type == "lifecycle" and (la := db.get(LifecycleAction, inst.entity_id)):
        return f"{la.action_type.replace('_', ' ').capitalize()} for {name(la.employee_id)}{step}"
    if inst.type == "exit" and (ec := db.get(ExitCase, inst.entity_id)):
        return (f"{ec.exit_type.replace('_', ' ').capitalize()} of {name(ec.employee_id)}, "
                f"last day {ec.requested_last_day:%d %b %Y}{step}")
    from app.services.self_service import summary_for

    if text := summary_for(db, inst):
        return f"{text}{step}"
    return (f"{inst.type.replace('_', ' ').capitalize()} {inst.entity_id}"
            + (f", amount {inst.amount:g}" if inst.amount is not None else "") + f" (step {inst.current_step + 1})")


def _instance_out(db: DbSession, instance: ApprovalInstance) -> ApprovalInstanceOut:
    out = ApprovalInstanceOut.model_validate(instance)
    out.decisions = [ApprovalDecisionOut.model_validate(d) for d in engine.decisions_of(db, instance)]
    return out


@router.get("/pending", response_model=list[PendingItemOut])
def pending(db: DbSession, user: CurrentUserDep) -> list[PendingItemOut]:
    """Everything waiting on me: leave, attendance corrections, timesheet weeks and generic approvals."""
    if not user.employee_id:
        return []
    who = decidable_filter(user)
    items: list[PendingItemOut] = []
    # Leave, corrections and timesheet weeks in an approval chain show when their current step waits on me (or on
    # someone I cover for); older ones without a chain keep the reporting-line / HR rule.
    mine = engine.pending_for(db, user.employee_id)
    waiting = {t: {i.entity_id: i for i in mine if i.type == t} for t in chain.AREA_TYPES}
    chained = {t: set(engine.pending_instances(db, t)) for t in chain.AREA_TYPES}

    def area_filter(col, type_):  # type: ignore[no-untyped-def]
        return or_(and_(who, col.not_in(chained[type_])), col.in_(set(waiting[type_])))

    def step_text(type_: str, entity_id: str) -> str:
        inst = waiting[type_].get(entity_id)
        live = [s for s in inst.steps if not s.get("skipped")] if inst else []
        if len(live) < 2 or inst is None:
            return ""
        position = sum(1 for i, s in enumerate(inst.steps) if not s.get("skipped") and i <= inst.current_step)
        return f" (step {position} of {len(live)})"

    for r, name in db.execute(
        select(LeaveRequest, Employee.full_name).join(Employee, Employee.id == LeaveRequest.employee_id)
        .where(LeaveRequest.status == "pending", area_filter(LeaveRequest.id, chain.LEAVE))
    ).all():
        items.append(PendingItemOut(
            kind="leave", type=r.leave_code, id=r.id, employee_id=r.employee_id, employee_name=name,
            summary=f"{r.days:g} day(s) of {r.leave_code}, {r.from_date} to {r.to_date}" + step_text(chain.LEAVE, r.id),
            submitted_at=r.created_at, href=f"/leave/requests/{r.id}",
        ))
    for c, name in db.execute(
        select(AttendanceCorrection, Employee.full_name).join(Employee, Employee.id == AttendanceCorrection.employee_id)
        .where(AttendanceCorrection.status == "pending", area_filter(AttendanceCorrection.id, chain.CORRECTION))
    ).all():
        items.append(PendingItemOut(
            kind="attendance_correction", type="attendance_correction", id=c.id, employee_id=c.employee_id,
            employee_name=name,
            summary=f"Attendance correction for {c.work_date}: {c.reason}" + step_text(chain.CORRECTION, c.id),
            submitted_at=c.created_at, href=f"/attendance/corrections/{c.id}",
        ))
    for w, name in db.execute(
        select(TimesheetWeek, Employee.full_name).join(Employee, Employee.id == TimesheetWeek.employee_id)
        .where(TimesheetWeek.status == "submitted", area_filter(TimesheetWeek.id, chain.TIMESHEET))
    ).all():
        items.append(PendingItemOut(
            kind="timesheet_week", type="timesheet", id=w.id, employee_id=w.employee_id, employee_name=name,
            summary=f"Timesheet for the week of {w.week_start}" + step_text(chain.TIMESHEET, w.id),
            submitted_at=w.submitted_at, href=f"/timesheets/weeks/{w.id}",
        ))
    # daily timesheets: same "timesheet" chain; someone with no one above them has no chain and goes to HR in scope
    from app.services.timesheets import day_total

    for d, name in db.execute(
        select(TimesheetDay, Employee.full_name).join(Employee, Employee.id == TimesheetDay.employee_id)
        .where(TimesheetDay.status == "submitted", area_filter(TimesheetDay.id, chain.TIMESHEET))
    ).all():
        items.append(PendingItemOut(
            kind="timesheet_day", type="timesheet", id=d.id, employee_id=d.employee_id, employee_name=name,
            summary=f"Timesheet for {d.work_date:%a %d %b %Y}, {day_total(db, d.employee_id, d.work_date):g} h"
            + step_text(chain.TIMESHEET, d.id),
            submitted_at=d.submitted_at, href=f"/timesheets/days/{d.id}",
        ))
    for inst in mine:
        if inst.type in chain.AREA_TYPES:
            continue  # listed above with the request's own details
        requester = db.get(Employee, inst.requester_id)
        items.append(PendingItemOut(
            kind="approval", type=inst.type, id=inst.id, employee_id=inst.requester_id,
            employee_name=requester.full_name if requester else None,
            summary=_instance_summary(db, inst),
            submitted_at=inst.created_at, href=f"/approvals/{inst.id}",
        ))
    items.sort(key=lambda i: (i.submitted_at is None, i.submitted_at))
    return items


def _visible_instance(db: DbSession, user: CurrentUser, instance_id: str) -> ApprovalInstance:
    instance = db.get(ApprovalInstance, instance_id)
    if instance is None:
        raise NOT_FOUND
    requester = db.get(Employee, instance.requester_id)
    involved = user.employee_id is not None and any(user.employee_id in ids for s in instance.steps for ids in s["groups"].values())
    if not involved:
        involved = engine.is_delegate_for(db, instance, user.employee_id)  # covering for an approver
    if not involved and instance.type == "lifecycle" and user.employee_id:
        # the person a lifecycle change is about may follow its steps
        action = db.get(LifecycleAction, instance.entity_id)
        involved = action is not None and action.employee_id == user.employee_id
    if requester is None or not (involved or can_view(db, user, requester)):
        raise NOT_FOUND
    return instance


@router.get("/{instance_id}", response_model=ApprovalInstanceOut)
def get_instance(instance_id: str, db: DbSession, user: CurrentUserDep) -> ApprovalInstanceOut:
    return _instance_out(db, _visible_instance(db, user, instance_id))


@router.post("/{instance_id}/decision", response_model=ApprovalInstanceOut)
def decide_instance(instance_id: str, body: DecisionIn, request: Request, db: DbSession, user: CurrentUserDep) -> ApprovalInstanceOut:
    instance = _visible_instance(db, user, instance_id)
    if not user.employee_id:
        raise HTTPException(403, "You can't decide this request.")
    try:
        engine.decide(db, instance, user.employee_id, body.decision, body.note, actor_id=user.id, ip=client_ip(request))
    except engine.NotAllowed as exc:
        raise HTTPException(403, str(exc)) from exc
    except engine.ApprovalError as exc:
        status_code = 409 if "already" in str(exc) else 422
        raise HTTPException(status_code, str(exc)) from exc
    db.commit()
    return _instance_out(db, instance)


def _require_admin(user: CurrentUser) -> None:
    if user.account.role != "admin":
        raise HTTPException(403, "Only an administrator can manage approval workflows.")


@workflows_router.get("", response_model=list[WorkflowTypeOut])
def list_workflows(db: DbSession, user: CurrentUserDep) -> list[WorkflowTypeOut]:
    """Every request type with a default or a saved workflow (the admin editor's tabs)."""
    from app.models import WorkflowDefinition
    from app.services.workflow_defaults import DEFAULT_WORKFLOWS, WORKFLOW_LABELS

    _require_admin(user)
    saved = {
        row.type: row for row in db.scalars(
            select(WorkflowDefinition).where(WorkflowDefinition.active.is_(True)).order_by(WorkflowDefinition.version)
        )
    }
    out = []
    for type_ in list(DEFAULT_WORKFLOWS) + sorted(t for t in saved if t not in DEFAULT_WORKFLOWS):
        row = saved.get(type_)
        default = DEFAULT_WORKFLOWS.get(type_, [])
        out.append(WorkflowTypeOut(
            type=type_, label=WORKFLOW_LABELS.get(type_, type_.replace("_", " ").capitalize()),
            version=row.version if row else 0, steps=row.steps if row else default, default_steps=default,
            created_by=row.created_by if row else None, created_at=row.created_at if row else None,
        ))
    return out


@workflows_router.get("/{workflow_type}", response_model=WorkflowOut)
def get_workflow(workflow_type: WorkflowType, db: DbSession, user: CurrentUserDep):  # type: ignore[no-untyped-def]
    _require_admin(user)
    row = engine.latest_definition(db, workflow_type)
    if row is None:
        raise HTTPException(404, "No workflow is set up for this type yet.")
    return row


@workflows_router.put("/{workflow_type}", response_model=WorkflowOut)
def put_workflow(workflow_type: WorkflowType, body: WorkflowIn, request: Request, db: DbSession, user: CurrentUserDep):  # type: ignore[no-untyped-def]
    """Saves a new version; requests already started keep the version they started with."""
    _require_admin(user)
    previous = engine.latest_definition(db, workflow_type)
    before = {"version": previous.version, "steps": previous.steps} if previous else None
    row = engine.save_definition(db, workflow_type, [s.model_dump() for s in body.steps], user.id)
    record_audit(
        db, actor_id=user.id, action="workflow_saved", entity="workflow_definition", entity_id=f"{workflow_type}:v{row.version}",
        before=before, after={"version": row.version, "steps": row.steps}, ip=client_ip(request),
    )
    db.commit()
    return row
