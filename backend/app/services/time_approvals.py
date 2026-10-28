"""Leave requests, attendance corrections and timesheet weeks through the approvals engine.

Workflow types (defaults in app/services/workflow_defaults.py, editable by an administrator):
- "leave": Manager, then HR when the leave needs it (only_if "needs_hr"): leave types set to need HR
  (LeaveType.needs_hr_approval; by default maternity, paternity and unpaid) or leave longer than 5 working days.
- "attendance_correction": Manager.  "timesheet": Manager.

Started with fallback=False: a person with no one above them is approved straight away (as before). The area
endpoints (POST /leave/requests/{id}/decision, ...) and POST /approvals/{id}/decision both decide; the area
endpoints also let HR in scope and anyone above the person act on the current step (as they always could).
Requests raised before this change have no approval instance and keep the old single decision.
When an instance ends, the on_finish callbacks below update the request, audit it and tell the employee.
"""

from __future__ import annotations

from contextvars import ContextVar
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import utcnow
from app.deps import CurrentUser
from app.models import (
    Account, ApprovalDecision, ApprovalInstance, AttendanceCorrection, AttendanceSession, Employee, LeaveRequest, LeaveType,
    TimesheetWeek,
)
from app.services import approvals as engine
from app.services import attendance as attendance_rules
from app.services.activity import notify, record_audit
from app.services.decisions import can_decide
from app.services.workflow_defaults import ensure_default

LEAVE, CORRECTION, TIMESHEET = "leave", "attendance_correction", "timesheet"
AREA_TYPES = (LEAVE, CORRECTION, TIMESHEET)
HR_LEAVE_CODES = frozenset({"maternity", "paternity", "unpaid"})
LONG_LEAVE_DAYS = 5

engine.ENTITY_HREFS.update({
    LEAVE: "/leave/requests/{entity_id}",
    CORRECTION: "/attendance/corrections/{entity_id}",
    TIMESHEET: "/timesheets/weeks/{entity_id}",
})
engine.NOTICE_LABELS.update({LEAVE: "Leave request", CORRECTION: "Attendance correction", TIMESHEET: "Timesheet"})
engine.OWN_FINISH_NOTICE.update(AREA_TYPES)

_request_ip: ContextVar[str | None] = ContextVar("time_approvals_ip", default=None)


class Conflict(engine.ApprovalError):
    """The decision can't be applied to the request as it stands (409)."""


# ---------- start ----------
def leave_needs_hr(db: Session, code: str, days: float) -> bool:
    lt = db.get(LeaveType, code)
    configured = lt.needs_hr_approval if lt is not None else None
    by_type = code in HR_LEAVE_CODES if configured is None else bool(configured)
    return by_type or days > LONG_LEAVE_DAYS


def start(db: Session, type_: str, entity_id: str, emp: Employee, actor_id: str | None,
          context: dict[str, Any] | None = None) -> ApprovalInstance:
    ensure_default(db, type_)
    try:
        return engine.start(db, type_, entity_id, emp, None, actor_id=actor_id, context=context, fallback=False)
    except engine.ApprovalError as exc:
        raise HTTPException(422, str(exc)) from exc


def pending_instance(db: Session, type_: str, entity_id: str) -> ApprovalInstance | None:
    return engine.pending_instances(db, type_, [entity_id]).get(entity_id)


def withdraw(db: Session, type_: str, entity_id: str, actor_id: str | None, ip: str | None) -> None:
    instance = pending_instance(db, type_, entity_id)
    if instance is not None:
        engine.cancel(db, instance, actor_id=actor_id, ip=ip)


# ---------- decide ----------
def decide(db: Session, user: CurrentUser, instance: ApprovalInstance, emp: Employee, decision: str,
           note: str | None, ip: str | None) -> None:
    """Decide the current step from an area endpoint (HTTP errors like POST /approvals/{id}/decision)."""
    if not user.employee_id:
        raise HTTPException(403, "You can't decide this request.")
    token = _request_ip.set(ip)
    try:
        engine.decide(db, instance, user.employee_id, decision, note, actor_id=user.id, ip=ip,
                      authority=can_decide(db, user, emp))
    except engine.NotAllowed as exc:
        raise HTTPException(403, str(exc)) from exc
    except Conflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except engine.ApprovalError as exc:
        raise HTTPException(409 if "already" in str(exc) else 422, str(exc)) from exc
    finally:
        _request_ip.reset(token)


def may_follow(db: Session, user: CurrentUser, instance: ApprovalInstance | None) -> bool:
    """Named in the chain or covering for someone who is (may open and decide the request)."""
    if instance is None or not user.employee_id:
        return False
    named = any(user.employee_id in ids for s in instance.steps for ids in s["groups"].values())
    return named or engine.is_delegate_for(db, instance, user.employee_id)


# ---------- progress for the UI ----------
def _names(db: Session, ids: set[str]) -> dict[str, str]:
    if not ids:
        return {}
    return dict(db.execute(select(Employee.id, Employee.full_name).where(Employee.id.in_(ids))).all())


def progress(db: Session, instance: ApprovalInstance, viewer_id: str | None = None) -> dict[str, Any]:
    """Steps with who approves, who decided and where the request is now."""
    decisions = engine.decisions_of(db, instance)
    ids = {i for s in instance.steps for ids in s["groups"].values() for i in ids}
    ids |= {d.approver_id for d in decisions} | {d.on_behalf_of for d in decisions if d.on_behalf_of}
    names = _names(db, ids)
    steps = []
    live = [i for i, s in enumerate(instance.steps) if not s.get("skipped")]
    for i, s in enumerate(instance.steps):
        if s.get("skipped"):
            continue
        mine = [d for d in decisions if d.step == i]
        if any(d.decision == "reject" for d in mine):
            state = "rejected"
        elif instance.status == "pending" and i == instance.current_step:
            state = "current"
        elif i < instance.current_step or instance.status == "approved":
            state = "done"
        else:
            state = "waiting"
        roles = list(s.get("roles") or s["groups"].keys())
        steps.append({
            "index": i,
            "label": s.get("label") or " + ".join(r.replace("_", " ").capitalize() for r in roles),
            "roles": roles,
            "status": state,
            "approvers": [names.get(x, x) for g in s["groups"].values() for x in g],
            "decisions": [{
                "by": names.get(d.approver_id, d.approver_id),
                "on_behalf_of": names.get(d.on_behalf_of, d.on_behalf_of) if d.on_behalf_of else None,
                "decision": d.decision, "note": d.note, "at": d.at.isoformat() if d.at else None,
            } for d in mine],
            "sla_hours": s.get("sla_hours"),
            "escalated": bool(s.get("escalated_at")),
        })
    position = live.index(instance.current_step) + 1 if instance.current_step in live else len(live)
    return {
        "instance_id": instance.id,
        "status": instance.status,
        "step": position if instance.status == "pending" else len(live),
        "total_steps": len(live),
        "current_label": next((s["label"] for s in steps if s["status"] == "current"), None),
        "steps": steps,
        "waiting_on_me": engine.can_act(db, instance, viewer_id),
    }


def progress_map(db: Session, type_: str, entity_ids: list[str], viewer_id: str | None) -> dict[str, dict[str, Any]]:
    return {eid: progress(db, inst, viewer_id) for eid, inst in engine.latest_instances(db, type_, entity_ids).items()}


# ---------- when an instance ends ----------
def _last_decision(db: Session, instance: ApprovalInstance) -> ApprovalDecision | None:
    return db.scalar(select(ApprovalDecision).where(ApprovalDecision.instance_id == instance.id)
                     .order_by(ApprovalDecision.id.desc()))


def _decider(db: Session, instance: ApprovalInstance, emp: Employee) -> tuple[str, str | None, str | None, str]:
    """(decided_by employee id, note, account id for the audit, name for the message)."""
    last = _last_decision(db, instance)
    if last is None:  # approved at start: no one left to approve
        return emp.id, "Approved automatically - no one above you in the reporting line", emp.id, "TimeZ"
    account = db.scalar(select(Account.id).where(Account.employee_id == last.approver_id)) or last.approver_id
    person = db.get(Employee, last.approver_id)
    name = person.full_name if person else last.approver_id
    if last.on_behalf_of:
        other = db.get(Employee, last.on_behalf_of)
        name += f" (on behalf of {other.full_name if other else last.on_behalf_of})"
    return last.approver_id, last.note, account, name


@engine.on_finish(LEAVE)
def _leave_finished(db: Session, instance: ApprovalInstance) -> None:
    item = db.get(LeaveRequest, instance.entity_id)
    emp = db.get(Employee, item.employee_id) if item else None
    if item is None or emp is None or item.status != "pending" or instance.status not in ("approved", "rejected"):
        return
    before = {"status": item.status, "decided_by": item.decided_by, "decision_note": item.decision_note}
    by, note, actor, name = _decider(db, instance, emp)
    item.status, item.decided_by, item.decided_at, item.decision_note = instance.status, by, utcnow(), note
    if _last_decision(db, instance) is None:
        return  # approved on submit: the apply endpoint audits it
    record_audit(db, actor_id=actor, action=f"leave_{item.status}", entity="leave_request", entity_id=item.id,
                 subject_id=emp.id, before=before,
                 after={"status": item.status, "decided_by": by, "decision_note": note, "approval_instance": instance.id},
                 ip=_request_ip.get())
    notify(db, recipient_id=emp.id, title=f"Leave {item.status}",
           body=f"{name} {item.status} your leave {item.from_date} to {item.to_date}." + (f" Note: {note}" if note else ""),
           href=f"/leave/requests/{item.id}")


def apply_correction(db: Session, item: AttendanceCorrection, emp: Employee, actor_id: str | None, ip: str | None) -> None:
    """Write an approved correction to the day's attendance (raises Conflict when it can't be applied)."""
    session = db.scalar(select(AttendanceSession).where(AttendanceSession.employee_id == emp.id,
                                                         AttendanceSession.work_date == item.work_date))
    before = _session_snapshot(session) if session else None
    if session is None:
        if item.requested_check_in is None:
            raise Conflict("There is no attendance for that day and the request has no check-in time.")
        session = attendance_rules.new_session(emp, item.work_date, item.requested_check_in, "office", "web")
        db.add(session)
    elif item.requested_check_in is not None:
        session.check_in = item.requested_check_in
    if item.requested_check_out is not None:
        session.check_out = item.requested_check_out
    if session.check_out is not None and session.check_out <= session.check_in:
        raise Conflict("The corrected check-out would be before check-in.")
    session.corrected = True
    attendance_rules.apply_flags(session)
    db.flush()
    item.session_id = session.id
    record_audit(db, actor_id=actor_id, action="attendance_corrected", entity="attendance_session", entity_id=session.id,
                 subject_id=emp.id, before=before, after=_session_snapshot(session), ip=ip)


def _session_snapshot(s: AttendanceSession) -> dict:
    return {
        "work_date": s.work_date, "check_in": s.check_in, "check_out": s.check_out, "break_minutes": s.break_minutes,
        "work_mode": s.work_mode, "source": s.source, "is_late": s.is_late, "is_early_leave": s.is_early_leave,
        "worked_minutes": s.worked_minutes, "corrected": s.corrected,
    }


@engine.on_finish(CORRECTION)
def _correction_finished(db: Session, instance: ApprovalInstance) -> None:
    item = db.get(AttendanceCorrection, instance.entity_id)
    emp = db.get(Employee, item.employee_id) if item else None
    if item is None or emp is None or item.status != "pending" or instance.status not in ("approved", "rejected"):
        return
    before = {"status": item.status, "decided_by": item.decided_by, "decision_note": item.decision_note}
    by, note, actor, name = _decider(db, instance, emp)
    if instance.status == "approved":
        apply_correction(db, item, emp, actor, _request_ip.get())
    item.status, item.decided_by, item.decided_at, item.decision_note = instance.status, by, utcnow(), note
    if _last_decision(db, instance) is None:
        return
    record_audit(db, actor_id=actor, action=f"attendance_correction_{item.status}", entity="attendance_correction",
                 entity_id=item.id, subject_id=emp.id, before=before,
                 after={"status": item.status, "decided_by": by, "decision_note": note, "approval_instance": instance.id},
                 ip=_request_ip.get())
    notify(db, recipient_id=emp.id, title=f"Attendance correction {item.status}",
           body=f"{name} {item.status} your correction for {item.work_date}." + (f" Note: {note}" if note else ""),
           href=f"/attendance/corrections/{item.id}")


@engine.on_finish(TIMESHEET)
def _timesheet_finished(db: Session, instance: ApprovalInstance) -> None:
    week = db.get(TimesheetWeek, instance.entity_id)
    emp = db.get(Employee, week.employee_id) if week else None
    if week is None or emp is None or week.status != "submitted" or instance.status not in ("approved", "rejected"):
        return
    before = {"status": week.status, "week_start": week.week_start, "decided_by": week.decided_by,
              "decision_note": week.decision_note}
    by, note, actor, name = _decider(db, instance, emp)
    week.status, week.decided_by, week.decided_at, week.decision_note = instance.status, by, utcnow(), note
    if _last_decision(db, instance) is None:
        return
    record_audit(db, actor_id=actor, action=f"timesheet_{week.status}", entity="timesheet_week", entity_id=week.id,
                 subject_id=emp.id, before=before,
                 after={"status": week.status, "week_start": week.week_start, "decided_by": by, "decision_note": note,
                        "approval_instance": instance.id},
                 ip=_request_ip.get())
    notify(db, recipient_id=emp.id, title=f"Timesheet {week.status}",
           body=f"{name} {week.status} your timesheet for the week of {week.week_start}." + (f" Note: {note}" if note else ""),
           href=f"/timesheets/weeks/{week.id}")
