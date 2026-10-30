"""Default approval chains for expense, travel and lifecycle requests (same as the portal's DEFAULT_WORKFLOWS,
src/data/approvalWorkflows.ts), plus small helpers shared by those request modules.

A default is saved only when the type has no workflow yet, so an administrator's edits are never overwritten.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.models import ApprovalInstance
from app.services import approvals as engine

EXPENSE_FINANCE_THRESHOLD = 10000

DEFAULT_WORKFLOWS: dict[str, list[dict[str, Any]]] = {
    "expense": [
        {"roles": ["manager"], "mode": "any", "min_amount": None},
        {"roles": ["finance"], "mode": "any", "min_amount": EXPENSE_FINANCE_THRESHOLD},
    ],
    "travel": [
        {"roles": ["manager"], "mode": "any", "min_amount": None},
        {"roles": ["hr"], "mode": "any", "min_amount": None},
    ],
    "lifecycle": [
        {"roles": ["manager"], "mode": "any", "min_amount": None},
        {"roles": ["hr"], "mode": "any", "min_amount": None},
    ],
    # leave, attendance corrections, timesheet weeks (app/services/time_approvals.py): HR only when the leave needs it
    "leave": [
        {"roles": ["manager"], "mode": "any", "min_amount": None, "label": "Manager"},
        {"roles": ["hr"], "mode": "any", "min_amount": None, "label": "HR", "only_if": "needs_hr"},
    ],
    # exits (app/services/exits.py): the manager step only when the employee raised it themselves and has a manager
    "exit": [
        {"roles": ["manager"], "mode": "any", "min_amount": None, "label": "Manager", "only_if": "via_manager"},
        {"roles": ["hr"], "mode": "any", "min_amount": None, "label": "HR"},
    ],
    "attendance_correction": [{"roles": ["manager"], "mode": "any", "min_amount": None, "label": "Manager"}],
    "timesheet": [{"roles": ["manager"], "mode": "any", "min_amount": None, "label": "Manager"}],
    # cash advances, leave encashment, software (app/services/self_service.py)
    "cash_advance": [
        {"roles": ["manager"], "mode": "any", "min_amount": None, "label": "Manager", "only_if": "via_manager"},
        {"roles": ["hr"], "mode": "any", "min_amount": None, "label": "Finance / HR"},
    ],
    "encashment": [
        {"roles": ["manager"], "mode": "any", "min_amount": None, "label": "Manager", "only_if": "via_manager"},
        {"roles": ["hr"], "mode": "any", "min_amount": None, "label": "HR"},
    ],
    "software": [
        {"roles": ["manager"], "mode": "any", "min_amount": None, "label": "Manager", "only_if": "via_manager"},
        {"roles": ["admin"], "mode": "any", "min_amount": None, "label": "IT"},
    ],
}

WORKFLOW_LABELS = {
    "expense": "Expenses", "travel": "Travel", "lifecycle": "Job changes", "leave": "Leave",
    "attendance_correction": "Attendance corrections", "timesheet": "Timesheets",
    "exit": "Exits",
    "cash_advance": "Cash advances", "encashment": "Leave encashment", "software": "Software",
}


def ensure_default(db: Session, type_: str) -> None:
    if engine.latest_definition(db, type_) is None and type_ in DEFAULT_WORKFLOWS:
        engine.save_definition(db, type_, DEFAULT_WORKFLOWS[type_], None)


def ensure_all(db: Session) -> int:
    for type_ in DEFAULT_WORKFLOWS:
        ensure_default(db, type_)
    return len(DEFAULT_WORKFLOWS)


def is_approver(instance: ApprovalInstance | None, employee_id: str | None) -> bool:
    """Named in any step of the instance (past, current or later)."""
    if instance is None or not employee_id:
        return False
    return any(employee_id in ids for step in instance.steps for ids in step["groups"].values())


def waiting_entity_ids(db: Session, type_: str, employee_id: str | None) -> list[str]:
    """Entity ids of this type whose current approval step waits on this person."""
    if not employee_id:
        return []
    return [i.entity_id for i in engine.pending_for(db, employee_id) if i.type == type_]


def decide_http(db: Session, instance: ApprovalInstance | None, approver_id: str | None, decision: str, note: str | None,
                actor_id: str, ip: str | None) -> None:
    """engine.decide with the same HTTP errors as POST /approvals/{id}/decision."""
    from fastapi import HTTPException

    if instance is None:
        raise HTTPException(409, "This request has no approval in progress.")
    if not approver_id:
        raise HTTPException(403, "You can't decide this request.")
    try:
        engine.decide(db, instance, approver_id, decision, note, actor_id=actor_id, ip=ip)
    except engine.NotAllowed as exc:
        raise HTTPException(403, str(exc)) from exc
    except engine.ApprovalError as exc:
        raise HTTPException(409 if "already" in str(exc) else 422, str(exc)) from exc


def notify_withdrawn(db: Session, instance: ApprovalInstance | None, who: str, what: str, href: str) -> None:
    """Tell the approvers still waiting that the request was withdrawn."""
    from app.services.activity import notify

    if instance is None:
        return
    for ids in engine.open_groups(db, instance).values():
        for approver in ids:
            notify(db, recipient_id=approver, title=f"{who} withdrew a {what}", body="No action is needed any more.", href=href)
