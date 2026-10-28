"""Start an approval about someone other than the requester (a pay proposal, a letter raised by HR).

The engine (app/services/approvals.py) resolves approvers around the requester and only keeps the requester out.
Here the approver groups are resolved again around the subject (HR whose scope covers the subject's country, the
subject's manager...) and both the subject and the requester are dropped, with the engine's admin -> executive
fallback; as in the engine, nobody approves two steps of one request. The engine's step notifications are replaced by ones that don't reveal pay.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.models import ApprovalInstance, Employee, Notification
from app.services import approvals as engine
from app.services.activity import notify

_SUBJECT_ROLES = ("manager", "skip_manager", "hr")


def _ids_for(db: Session, role: str, subject: Employee, resolved: list[str], excluded: set[str]) -> list[str]:
    ids = engine.resolve_group(db, role, subject) if role in _SUBJECT_ROLES else list(resolved)
    ids = [i for i in ids if i not in excluded]
    if not ids and role not in ("admin", "executive"):
        ids = [i for i in engine.resolve_group(db, "admin", subject) if i not in excluded]
    if not ids and role != "executive":
        ids = [i for i in engine.resolve_group(db, "executive", subject) if i not in excluded]
    return list(dict.fromkeys(ids))


def start_about(
    db: Session, type_: str, entity_id: str, requester: Employee, subject: Employee, *, amount: float | None,
    actor_id: str, title: str, body: str, href: str,
) -> ApprovalInstance:
    """engine.start, then re-target the steps. Raises engine.ApprovalError when nobody is left to approve."""
    instance = engine.start(db, type_, entity_id, requester, amount, actor_id=actor_id)
    if instance.status != "pending":
        return instance
    for obj in list(db.new):
        if isinstance(obj, Notification) and obj.href == f"/approvals/{instance.id}":
            db.expunge(obj)
    excluded = {requester.id, subject.id}
    steps: list[dict[str, Any]] = []
    for step in instance.steps:
        minimum = step.get("min_amount")
        applies = minimum is None or (amount is not None and amount >= float(minimum))
        groups = {role: _ids_for(db, role, subject, step["groups"].get(role, []), excluded) for role in step["roles"]}
        steps.append({**step, "groups": groups, "skipped": not applies or not any(groups.values())})
    # nobody approves two steps: drop whoever surely approves an earlier one (same fallback, still not them)
    steps = engine.retarget(db, steps, 0, set(), amount, excluded)
    current = 0
    while current < len(steps) and steps[current]["skipped"]:
        current += 1
    if current >= len(steps):
        raise engine.ApprovalError("No one can approve this request.")
    instance.steps = steps
    instance.current_step = current
    db.flush()
    notify_waiting(db, instance, title, body, href)
    return instance


def notify_waiting(db: Session, instance: ApprovalInstance, title: str, body: str, href: str) -> None:
    for ids in engine.open_groups(db, instance).values():
        for approver in ids:
            notify(db, recipient_id=approver, title=title, body=body, href=href)
