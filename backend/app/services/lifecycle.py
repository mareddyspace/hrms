"""Employment lifecycle actions: transfer, promotion, manager/location/job change, leave of absence and return,
contract extension, probation completion, rehire.

Approval type "lifecycle" (default: manager, then HR; the person who raises it is the requester and never approves).
On final approval the action is applied straight away when its effective date has come (in the employee's time
zone), otherwise it is "scheduled" and apply_due_lifecycle_actions() applies it later (called at API startup and
from POST /lifecycle/apply-due). Applying updates the employees row and writes an effective-dated
employee_assignments row (the open row is closed the day before).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import utcnow
from app.models import ApprovalDecision, ApprovalInstance, Country, Employee, EmployeeAssignment, LifecycleAction
from app.services import approvals as engine
from app.services.activity import notify, record_audit
from app.services.leave import today_for
from app.services.scope import report_ids

log = logging.getLogger(__name__)

OPEN_STATUSES = ("submitted", "scheduled")
EMPLOYMENT_TYPES = ("Full-Time", "Part-Time", "Contract")
INFO_DATE_FIELDS = ("contract_end_date", "probation_end_date", "leave_end_date")
STRING_FIELDS = ("department", "location", "legal_entity", "business_unit", "division", "cost_centre", "job_title",
                 "grade", "job_family", "position_id")
# Exits set "Exited" (services/exits.py); older records may say "Terminated". Either way the person has left.
LEFT_STATUSES = ("Exited", "Terminated")
ASSIGNMENT_FIELDS = ("manager_id", "job_title", "grade", "department", "location", "legal_entity", "employment_status")


@dataclass(frozen=True)
class ActionSpec:
    allowed: frozenset[str]
    required: frozenset[str] = frozenset()
    fixed: dict[str, str] = field(default_factory=dict)  # employee fields the action always sets
    needs_status: str | tuple[str, ...] | None = None  # current employment_status the person must have (one of)
    self_service: bool = False  # the employee may raise it for themselves
    must_change: bool = True  # at least one employee field must actually change


SPECS: dict[str, ActionSpec] = {
    "transfer": ActionSpec(frozenset({"department", "location", "legal_entity", "business_unit", "division", "cost_centre",
                                      "manager_id", "country_code"})),
    "promotion": ActionSpec(frozenset({"job_title", "grade", "job_family", "position_id"}), frozenset({"grade"})),
    "manager_change": ActionSpec(frozenset({"manager_id"}), frozenset({"manager_id"})),
    "location_change": ActionSpec(frozenset({"location", "country_code", "cost_centre", "legal_entity"}), frozenset({"location"})),
    "job_change": ActionSpec(frozenset({"job_title", "job_family", "grade", "position_id", "department"}), frozenset({"job_title"})),
    "leave_of_absence": ActionSpec(frozenset({"leave_end_date"}), fixed={"employment_status": "On Leave"},
                                   needs_status="Active", self_service=True),
    "return_from_leave": ActionSpec(frozenset(), fixed={"employment_status": "Active"}, needs_status="On Leave", self_service=True),
    "contract_extension": ActionSpec(frozenset({"contract_end_date", "employment_type"}), frozenset({"contract_end_date"}),
                                     must_change=False),
    "probation_completion": ActionSpec(frozenset({"probation_end_date"}), must_change=False),
    "rehire": ActionSpec(frozenset({"job_title", "grade", "department", "location", "legal_entity", "manager_id"}),
                         fixed={"employment_status": "Active"}, needs_status=("Exited", "Terminated")),
}


class LifecycleError(ValueError):
    """A rule was broken (422); the message is safe to show the user."""


def _label(action_type: str) -> str:
    return action_type.replace("_", " ")


def validate(db: Session, emp: Employee, action_type: str, effective: date, after: dict[str, Any]) -> tuple[dict, dict]:
    """Check the requested changes. Returns (clean after, before) with values as stored."""
    spec = SPECS[action_type]
    unknown = set(after) - spec.allowed
    if unknown:
        raise LifecycleError(f"A {_label(action_type)} can't change: {', '.join(sorted(unknown))}. "
                             f"Allowed: {', '.join(sorted(spec.allowed)) or 'nothing'}.")
    missing = [k for k in spec.required if after.get(k) in (None, "")]
    if missing:
        raise LifecycleError(f"A {_label(action_type)} needs: {', '.join(sorted(missing))}.")
    wanted = (spec.needs_status,) if isinstance(spec.needs_status, str) else spec.needs_status
    if wanted and emp.employment_status not in wanted:
        raise LifecycleError(f"A {_label(action_type)} needs the person to be {' or '.join(wanted)}; "
                             f"they are {emp.employment_status}.")
    if not wanted and emp.employment_status in LEFT_STATUSES:
        raise LifecycleError("This person has left; use a rehire first.")
    clean: dict[str, Any] = {}
    for key, value in after.items():
        if key in STRING_FIELDS:
            if not isinstance(value, str) or not value.strip() or len(value.strip()) > (64 if key == "position_id" else 200):
                raise LifecycleError(f"Enter a valid {key.replace('_', ' ')}.")
            clean[key] = value.strip()
        elif key == "manager_id":
            manager = db.get(Employee, value) if isinstance(value, str) else None
            if manager is None or manager.employment_status in LEFT_STATUSES:
                raise LifecycleError("Choose a current employee as the manager.")
            if manager.id == emp.id or manager.id in report_ids(db, emp.id):
                raise LifecycleError("That manager would create a loop in the reporting line.")
            clean[key] = manager.id
        elif key == "country_code":
            if not isinstance(value, str) or db.get(Country, value.upper()) is None:
                raise LifecycleError("Choose a valid country.")
            clean[key] = value.upper()
        elif key == "employment_type":
            if value not in EMPLOYMENT_TYPES:
                raise LifecycleError(f"Employment type must be one of: {', '.join(EMPLOYMENT_TYPES)}.")
            clean[key] = value
        elif key in INFO_DATE_FIELDS:
            try:
                day = date.fromisoformat(str(value))
            except ValueError as exc:
                raise LifecycleError(f"{key.replace('_', ' ').capitalize()} must be a date (YYYY-MM-DD).") from exc
            if day < effective:
                raise LifecycleError(f"{key.replace('_', ' ').capitalize()} can't be before the effective date.")
            clean[key] = day.isoformat()
    # Informational dates stay out of the job record (employees.contract_end_date is set on its own in apply_action).
    employee_changes = {k: v for k, v in {**clean, **spec.fixed}.items() if hasattr(Employee, k) and k not in INFO_DATE_FIELDS}
    if spec.must_change and not any(getattr(emp, k) != v for k, v in employee_changes.items()):
        raise LifecycleError("Nothing would change; enter the new values.")
    before = {k: getattr(emp, k) for k in employee_changes}
    return clean, before


def _close_and_add_assignment(db: Session, emp: Employee, effective: date) -> None:
    from app.services.org_history import placement_for

    # Full placement (business unit, division, cost centre, job profile, position; migration 0013).
    values = {k: getattr(emp, k) for k in ASSIGNMENT_FIELDS} | placement_for(db, emp)
    current = db.scalar(
        select(EmployeeAssignment).where(EmployeeAssignment.employee_id == emp.id, EmployeeAssignment.effective_to.is_(None))
        .order_by(EmployeeAssignment.effective_from.desc())
    )
    if current is not None and current.effective_from >= effective:
        for k, v in values.items():
            setattr(current, k, v)
        return
    if current is not None:
        current.effective_to = effective - timedelta(days=1)
    db.add(EmployeeAssignment(employee_id=emp.id, effective_from=effective, effective_to=None, **values))


def _reopen_sign_in(db: Session, emp: Employee, actor_id: str | None) -> None:
    """A rehire gets back the sign-in account the exit closed (and is no longer on a last working day). An account
    switched off for any other reason (by an administrator) stays off."""
    from app.models import Account, AuditLog

    emp.last_working_day = None
    account = db.scalar(select(Account).where(Account.employee_id == emp.id))
    if account is None or account.active:
        return
    last = db.scalar(select(AuditLog).where(AuditLog.entity == "account", AuditLog.entity_id == account.id,
                                            AuditLog.action.in_(("account_deactivated", "account_reactivated")))
                     .order_by(AuditLog.id.desc()))
    closed_by_exit = last is not None and last.action == "account_deactivated" and         ((last.changes or {}).get("after") or {}).get("reason") == "exit completed"
    if closed_by_exit:
        account.active = True
        record_audit(db, actor_id=actor_id, action="account_reactivated", entity="account", entity_id=account.id,
                     subject_id=emp.id, before={"active": False}, after={"active": True, "reason": "rehired"})


def apply_action(db: Session, action: LifecycleAction, actor_id: str | None = None) -> None:
    emp = db.get(Employee, action.employee_id)
    assert emp is not None
    spec = SPECS[action.action_type]
    changes = {k: v for k, v in {**action.after, **spec.fixed}.items() if hasattr(Employee, k) and k not in INFO_DATE_FIELDS}
    if isinstance(action.after.get("contract_end_date"), str):  # compliance calendar reads it (migration 0023)
        emp.contract_end_date = date.fromisoformat(action.after["contract_end_date"])
    before = {k: getattr(emp, k) for k in changes}
    for k, v in changes.items():
        setattr(emp, k, v)
    if "country_code" in changes and before.get("country_code") != changes["country_code"]:
        country = db.get(Country, changes["country_code"])
        if country is not None:
            emp.currency, emp.time_zone = country.currency, country.time_zone
    if action.action_type == "rehire":
        _reopen_sign_in(db, emp, actor_id)
    db.flush()
    if any(before[k] != changes[k] for k in changes):
        _close_and_add_assignment(db, emp, action.effective_date)
        record_audit(db, actor_id=actor_id, action="employee_updated", entity="employee", entity_id=emp.id, subject_id=emp.id,
                     before=before, after=changes | {"lifecycle_action_id": action.id})
    action.status, action.applied_at = "applied", utcnow()
    record_audit(db, actor_id=actor_id, action="lifecycle_applied", entity="lifecycle_action", entity_id=action.id,
                 subject_id=emp.id, before={"status": "scheduled"}, after={"status": "applied", "changes": changes})
    title = f"{_label(action.action_type).capitalize()} applied"
    body = f"Effective {action.effective_date}."
    notify(db, recipient_id=emp.id, title=title, body=body, href=f"/lifecycle/actions/{action.id}")
    if action.requested_by != emp.id:
        notify(db, recipient_id=action.requested_by, title=f"{title} for {emp.full_name}", body=body,
               href=f"/lifecycle/actions/{action.id}")


@engine.on_finish("lifecycle")
def _lifecycle_finished(db: Session, instance: ApprovalInstance) -> None:
    action = db.get(LifecycleAction, instance.entity_id)
    if action is None or action.status != "submitted" or instance.status not in ("approved", "rejected"):
        return
    actor = db.scalar(select(ApprovalDecision.approver_id).where(ApprovalDecision.instance_id == instance.id)
                      .order_by(ApprovalDecision.id.desc())) or instance.requester_id
    emp = db.get(Employee, action.employee_id)
    assert emp is not None
    if instance.status == "rejected":
        action.status = "rejected"
        record_audit(db, actor_id=actor, action="lifecycle_rejected", entity="lifecycle_action", entity_id=action.id,
                     subject_id=emp.id, before={"status": "submitted"}, after={"status": "rejected"})
        return
    action.status = "scheduled"
    record_audit(db, actor_id=actor, action="lifecycle_approved", entity="lifecycle_action", entity_id=action.id,
                 subject_id=emp.id, before={"status": "submitted"}, after={"status": "scheduled", "effective_date": action.effective_date})
    if action.effective_date <= today_for(emp):
        apply_action(db, action, actor)
    else:
        notify(db, recipient_id=emp.id, title=f"{_label(action.action_type).capitalize()} scheduled",
               body=f"Takes effect on {action.effective_date}.", href=f"/lifecycle/actions/{action.id}")


def apply_due_lifecycle_actions(db: Session, today: date | None = None, actor_id: str | None = None) -> list[str]:
    """Apply approved actions whose effective date has come (each employee's local date unless `today` is given).
    The caller commits."""
    horizon = today or (date.today() + timedelta(days=1))
    applied = []
    due = db.scalars(select(LifecycleAction).where(LifecycleAction.status == "scheduled", LifecycleAction.effective_date <= horizon)
                     .order_by(LifecycleAction.effective_date, LifecycleAction.created_at))
    for action in list(due):
        emp = db.get(Employee, action.employee_id)
        if emp is None or action.effective_date > (today or today_for(emp)):
            continue
        apply_action(db, action, actor_id)
        applied.append(action.id)
    return applied


def run_due_at_startup() -> int:
    """Called when the API starts. Never stops the API from starting (e.g. before migrations have run)."""
    from app.db import SessionLocal

    try:
        with SessionLocal() as db:
            applied = apply_due_lifecycle_actions(db)
            db.commit()
            if applied:
                log.info("Applied %d scheduled lifecycle action(s) at startup.", len(applied))
            return len(applied)
    except Exception as exc:  # noqa: BLE001
        log.warning("Could not apply scheduled lifecycle actions at startup (%s). Run python -m app.db_init?",
                    exc.__class__.__name__)
        return 0
