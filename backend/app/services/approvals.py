"""Generic approvals engine (foundation for expenses, travel, lifecycle changes...). Leave keeps its own logic.

A workflow definition is a versioned list of steps; each step names role groups and a mode:
- mode "all": every group in the step must approve (one person from each group is enough)
- mode "any": one approval from any group completes the step
- min_amount: the step only applies when the request amount is at least this much

Approvers are resolved when the request starts and stored on the instance (later org changes don't move it):
manager, skip_manager (the manager's manager), hr (HR whose country scope covers the requester),
finance (falls back to admin when nobody holds the finance role), admin, executive.
The requester is never an approver; a group left empty by that falls back to admin, then executive
(except skip_manager: with no skip-level manager, e.g. the CEO's own request, that group stays empty).
Nobody approves two steps of one request: whoever approved an earlier step (or is certain to, being its only
approver) is dropped from the later steps, with the same admin -> executive fallback.
A step whose groups are all empty is skipped; when no step is left the request is approved straight away.

Optional per step (stored on the definition and copied to the instance):
- label: the step's name; sla_hours: hours the step may wait before it is escalated (escalate_overdue_steps)
- condition {"field": "country" | "department" | "grade", "values": [...]}: the step only applies when the requester
  matches one of the values; only_if "needs_hr": only when the request says it needs HR (e.g. long or unpaid leave)
Conditions are evaluated when the request starts. start(fallback=False) leaves an empty manager group empty (no
admin fallback), so a person with no one above them is approved straight away (leave, attendance, timesheets).

Delegation (table delegations): during its window a delegate may act for the delegator on the types handed over;
the decision row and the audit say "on behalf of". The delegate is never the requester.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from datetime import date, datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import utcnow
from app.models import (
    AccessScope, Account, ApprovalDecision, ApprovalDelegation, ApprovalInstance, Employee, Notification, WorkflowDefinition,
)
from app.services.activity import notify, record_audit
from app.services.scope import HR_ROLES

ROLE_GROUPS = ("manager", "skip_manager", "hr", "finance", "admin", "executive")
CONDITION_FIELDS = ("country", "department", "grade")
# Delegation types with their own name; "other" covers every other approval type.
NAMED_DELEGATION_TYPES = ("leave", "expense", "timesheet", "attendance_correction")

# Request modules can point notifications at their own page and send their own "approved / rejected" notice.
ENTITY_HREFS: dict[str, str] = {}  # type -> "/leave/requests/{entity_id}"
NOTICE_LABELS: dict[str, str] = {}  # type -> "Leave request" (title "<label> from <name>")
OWN_FINISH_NOTICE: set[str] = set()
# The requester's "your request was approved / rejected" notice opens the requester's own page for the item (the
# approver inbox /approvals/{id} is the wrong place for them). Modules may add their own.
REQUESTER_HREFS: dict[str, str] = {
    "expense": "/expenses/{entity_id}",
    "travel": "/travel/{entity_id}",
    "lifecycle": "/lifecycle/actions/{entity_id}",
    "compensation": "/compensation/proposals/{entity_id}",
    "letter": "/letters/requests/{entity_id}",
    "requisition": "/recruiting/requisitions/{entity_id}",
}


class ApprovalError(ValueError):
    """A rule was broken; the message is safe to show the user."""


class NotAllowed(ApprovalError):
    """The person is not an approver of the current step."""


def latest_definition(db: Session, type_: str) -> WorkflowDefinition | None:
    return db.scalar(
        select(WorkflowDefinition)
        .where(WorkflowDefinition.type == type_, WorkflowDefinition.active.is_(True))
        .order_by(WorkflowDefinition.version.desc())
    )


def save_definition(db: Session, type_: str, steps: list[dict[str, Any]], actor_id: str | None) -> WorkflowDefinition:
    """Create the next version and retire the previous ones (instances already started keep their snapshot)."""
    current = db.scalar(select(func.max(WorkflowDefinition.version)).where(WorkflowDefinition.type == type_)) or 0
    for old in db.scalars(select(WorkflowDefinition).where(WorkflowDefinition.type == type_, WorkflowDefinition.active.is_(True))):
        old.active = False
    row = WorkflowDefinition(type=type_, version=current + 1, steps=steps, active=True, created_by=actor_id)
    db.add(row)
    db.flush()
    return row


def _accounts_with_roles(db: Session, roles: set[str], country: str | None = None) -> list[str]:
    rows = db.execute(
        select(Account.employee_id, AccessScope.country_codes)
        .outerjoin(AccessScope, AccessScope.account_id == Account.id)
        .where(Account.role.in_(roles), Account.active.is_(True), Account.employee_id.is_not(None))
        .order_by(Account.employee_id)
    ).all()
    out = []
    for emp_id, countries in rows:
        allowed = [c.strip().upper() for c in (countries or "").split(",") if c.strip()]
        if country is None or not allowed or country in allowed:
            out.append(emp_id)
    return out


def resolve_group(
    db: Session, role: str, requester: Employee, line_from_requester: bool = False, fallback: bool = True
) -> list[str]:
    """line_from_requester: the requester is the "manager" (e.g. a requisition's hiring manager), so
    skip_manager is the person directly above them (the department head).
    fallback=False: a group nobody holds (no manager) stays empty instead of falling back to admin."""
    if role == "manager":
        ids = [requester.manager_id] if requester.manager_id else []
    elif role == "skip_manager" and line_from_requester:
        ids = [requester.manager_id] if requester.manager_id else []
    elif role == "skip_manager":
        manager = db.get(Employee, requester.manager_id) if requester.manager_id else None
        ids = [manager.manager_id] if manager and manager.manager_id else []
    elif role == "hr":
        ids = _accounts_with_roles(db, set(HR_ROLES), requester.country_code)
    elif role == "finance":
        ids = _accounts_with_roles(db, {"finance"}) or _accounts_with_roles(db, {"admin"})
    elif role == "admin":
        ids = _accounts_with_roles(db, {"admin"})
    elif role == "executive":
        ids = _accounts_with_roles(db, {"executive"})
    else:
        raise ApprovalError(f"Unknown approver group: {role}")
    if not fallback and not any(ids):
        return []
    ids = [i for i in ids if i and i != requester.id]
    if role == "skip_manager" and not ids:
        # Nobody above the line (e.g. the CEO's own request): the skip-level step is skipped, not sent to admin.
        return []
    if not ids and role not in ("admin", "executive"):
        ids = [i for i in _accounts_with_roles(db, {"admin"}) if i != requester.id]
    if not ids and role != "executive":
        ids = [i for i in _accounts_with_roles(db, {"executive"}) if i != requester.id]
    return ids


def _fallback(db: Session, role: str, excluded: set[str]) -> list[str]:
    for alt in ("admin", "executive"):
        if alt == role or (role == "executive" and alt == "admin"):
            continue
        ids = [i for i in _accounts_with_roles(db, {alt}) if i not in excluded]
        if ids:
            return ids
    return []


def _certain_approvers(step: dict[str, Any]) -> set[str]:
    """People who will have approved this step if it completes (the only person in a group that must approve)."""
    groups = [ids for ids in step["groups"].values() if ids]
    everyone = {i for ids in groups for i in ids}
    if len(everyone) == 1:
        return everyone
    if step.get("mode", "any") == "all":
        return {ids[0] for ids in groups if len(ids) == 1}
    return set()


def retarget(
    db: Session, steps: list[dict[str, Any]], start_at: int, approved: set[str], amount: float | None,
    excluded: set[str] | None = None,
) -> list[dict[str, Any]]:
    """Steps from start_at on without anyone who approved (or surely approves) an earlier step. A group emptied
    that way falls back to admin, then executive (never the requester, subject or earlier approvers); a step left
    with no one is skipped."""
    out = [dict(s) for s in steps]
    earlier = set(approved)
    for i in range(start_at, len(out)):
        step = out[i]
        if not _step_applies(step, amount):
            continue
        blocked = earlier | set(step.get("exclude") or []) | (excluded or set())
        groups = {}
        for role, ids in step["groups"].items():
            kept = [x for x in ids if x not in blocked]
            if not kept and ids:
                kept = _fallback(db, role, blocked)
            groups[role] = kept
        step["groups"] = groups
        if excluded:
            step["exclude"] = sorted(set(step.get("exclude") or []) | excluded)
        step["skipped"] = not any(groups.values())
        if not step["skipped"]:
            earlier |= _certain_approvers(step)
    return out


def _approved_before(db: Session, instance: ApprovalInstance, step: int) -> set[str]:
    """Who approved an earlier step (a delegate and the person they acted for both count)."""
    out: set[str] = set()
    for approver, behalf in db.execute(
        select(ApprovalDecision.approver_id, ApprovalDecision.on_behalf_of).where(
            ApprovalDecision.instance_id == instance.id, ApprovalDecision.step < step, ApprovalDecision.decision == "approve"
        )
    ):
        out.add(approver)
        if behalf:
            out.add(behalf)
    return out


def condition_matches(raw: dict[str, Any], requester: Employee, context: dict[str, Any] | None = None) -> bool:
    """A step's condition (country / department / grade) and only_if flag, for this requester and request."""
    context = context or {}
    cond = raw.get("condition")
    if cond and cond.get("values"):
        field = cond.get("field")
        if field not in CONDITION_FIELDS:
            raise ApprovalError(f"Unknown condition: {field}")
        actual = context.get(field)
        if actual is None:
            actual = {"country": requester.country_code, "department": requester.department, "grade": requester.grade}[field]
        wanted = {str(v).strip().lower() for v in cond["values"]}
        if str(actual or "").strip().lower() not in wanted:
            return False
    flag = raw.get("only_if")
    return not flag or bool(context.get(flag))


# ---------- delegation ----------
def _covers(types: list[str] | None, type_: str) -> bool:
    if not types:
        return True
    return type_ in types or ("other" in types and type_ not in NAMED_DELEGATION_TYPES)


def _active_delegations(db: Session, on: date | None, *where: Any) -> list[ApprovalDelegation]:
    """Active delegations whose window covers `on` (default: today in the delegator's own time zone)."""
    from app.services.leave import today_for

    day = on or utcnow().date()
    rows = db.scalars(select(ApprovalDelegation).where(
        ApprovalDelegation.active.is_(True), ApprovalDelegation.starts_on <= day + timedelta(days=1),
        ApprovalDelegation.ends_on >= day - timedelta(days=1), *where,
    ))
    out = []
    for row in rows:
        local = on
        if local is None:
            person = db.get(Employee, row.delegator_id)
            local = today_for(person) if person else day
        if row.starts_on <= local <= row.ends_on:
            out.append(row)
    return out


def delegators_for(db: Session, delegate_id: str, type_: str | None = None, on: date | None = None) -> dict[str, list[str] | None]:
    """People this person may act for today: {delegator_id: types (None = all)}; only those covering type_ when given."""
    out: dict[str, list[str] | None] = {}
    for row in _active_delegations(db, on, ApprovalDelegation.delegate_id == delegate_id):
        if type_ is not None and not _covers(row.types, type_):
            continue
        if row.delegator_id in out and out[row.delegator_id] is None:
            continue
        out[row.delegator_id] = None if not row.types else sorted(set(out.get(row.delegator_id) or []) | set(row.types))
    return out


def delegates_of(db: Session, delegator_id: str, type_: str, on: date | None = None) -> list[str]:
    rows = _active_delegations(db, on, ApprovalDelegation.delegator_id == delegator_id)
    return [row.delegate_id for row in rows if _covers(row.types, type_)]


def _acting_as(db: Session, instance: ApprovalInstance, employee_id: str) -> tuple[str, str | None] | None:
    """(group, on_behalf_of) this person may decide in the current step, or None. Never the requester or someone the
    step excludes (e.g. the subject of a request raised by someone else) - not even as somebody's delegate."""
    if employee_id in _barred(instance):
        return None
    groups = open_groups(db, instance)
    for g, ids in groups.items():
        if employee_id in ids:
            return g, None
    delegators = delegators_for(db, employee_id, instance.type)
    for g, ids in groups.items():
        hit = next((i for i in ids if i in delegators), None)
        if hit:
            return g, hit
    return None


def _barred(instance: ApprovalInstance) -> set[str]:
    """People who may never decide this request: the requester and the current step's exclude list."""
    out = {instance.requester_id}
    if instance.current_step < len(instance.steps or []):
        out |= set(instance.steps[instance.current_step].get("exclude") or [])
    return out


def can_act(db: Session, instance: ApprovalInstance | None, employee_id: str | None) -> bool:
    """The current step waits on this person (directly or as someone's delegate)."""
    if instance is None or not employee_id or instance.status != "pending":
        return False
    return _acting_as(db, instance, employee_id) is not None


def is_delegate_for(db: Session, instance: ApprovalInstance, employee_id: str | None) -> bool:
    """A delegate of anyone named in the instance (may follow it)."""
    if not employee_id:
        return False
    named = {i for s in instance.steps for ids in s["groups"].values() for i in ids}
    return bool(named & set(delegators_for(db, employee_id, instance.type)))


def _step_applies(step: dict[str, Any], amount: float | None) -> bool:
    if step.get("applies") is False:  # its condition did not match when the request started
        return False
    if "min_amount_met" in step:  # decided when the request started (amount compared in the threshold's terms)
        return bool(step["min_amount_met"])
    minimum = step.get("min_amount")
    return minimum is None or (amount is not None and amount >= float(minimum))


def _approvals_in_step(db: Session, instance: ApprovalInstance, step: int) -> list[ApprovalDecision]:
    return list(
        db.scalars(
            select(ApprovalDecision).where(
                ApprovalDecision.instance_id == instance.id, ApprovalDecision.step == step, ApprovalDecision.decision == "approve"
            )
        )
    )


def open_groups(db: Session, instance: ApprovalInstance) -> dict[str, list[str]]:
    """Groups of the current step still waiting, with their approvers."""
    if instance.status != "pending" or instance.current_step >= len(instance.steps):
        return {}
    step = instance.steps[instance.current_step]
    done = {d.group for d in _approvals_in_step(db, instance, instance.current_step)}
    if step["mode"] == "any" and done:
        return {}
    return {g: ids for g, ids in step["groups"].items() if ids and g not in done}


def _step_complete(db: Session, instance: ApprovalInstance) -> bool:
    step = instance.steps[instance.current_step]
    done = {d.group for d in _approvals_in_step(db, instance, instance.current_step)}
    live = {g for g, ids in step["groups"].items() if ids}
    return bool(done) if step["mode"] == "any" else live <= done


def _next_step(instance: ApprovalInstance, start: int) -> int:
    i = start
    while i < len(instance.steps) and instance.steps[i]["skipped"]:
        i += 1
    return i


def _snapshot(instance: ApprovalInstance) -> dict[str, Any]:
    return {"status": instance.status, "current_step": instance.current_step, "type": instance.type, "entity_id": instance.entity_id}


def _href(instance: ApprovalInstance) -> str:
    template = ENTITY_HREFS.get(instance.type)
    return template.format(entity_id=instance.entity_id) if template else f"/approvals/{instance.id}"


def requester_href(instance: ApprovalInstance) -> str:
    """Where the requester follows their own request (never the approver inbox)."""
    template = REQUESTER_HREFS.get(instance.type) or ENTITY_HREFS.get(instance.type)
    return template.format(entity_id=instance.entity_id) if template else "/notifications"


def _label(instance: ApprovalInstance) -> str:
    return NOTICE_LABELS.get(instance.type) or f"{instance.type.replace('_', ' ').capitalize()} request"


def _resolve_waiting(db: Session, instance: ApprovalInstance) -> None:
    """Earlier "Waiting for your approval" notices for this request no longer need action: mark them read."""
    db.flush()
    stale = db.scalars(select(Notification).where(
        Notification.href == _href(instance),
        Notification.read_at.is_(None),
        Notification.body.like("Waiting for your approval%"),
        Notification.title.like(f"{_label(instance)} from %"),
    ))
    now = utcnow()
    for note in stale:
        note.read_at = now


def _notify_step(db: Session, instance: ApprovalInstance, requester: Employee) -> None:
    _resolve_waiting(db, instance)  # the previous step's approvers have nothing left to do
    sent: set[str] = set()
    for ids in open_groups(db, instance).values():
        for approver in ids:
            for recipient, covering in [(approver, False)] + [(d, True) for d in delegates_of(db, approver, instance.type)]:
                if recipient in sent or recipient == instance.requester_id:
                    continue
                sent.add(recipient)
                notify(
                    db,
                    recipient_id=recipient,
                    title=f"{_label(instance)} from {requester.full_name}",
                    body=f"Waiting for your approval (step {instance.current_step + 1})."
                    + (" You are covering for a colleague." if covering else "")
                    # 18000 -> "18,000", 450.5 -> "450.5" (":g" printed large amounts as 1.8e+06).
                    + (f" Amount: {f'{instance.amount:,.2f}'.rstrip('0').rstrip('.')}" if instance.amount is not None else ""),
                    href=_href(instance),
                )


def _mark_started(instance: ApprovalInstance) -> None:
    """Note when the current step began waiting (per-step SLA)."""
    if instance.current_step < len(instance.steps):
        steps = [dict(s) for s in instance.steps]
        steps[instance.current_step]["started_at"] = utcnow().isoformat()
        instance.steps = steps


def _finish(db: Session, instance: ApprovalInstance, requester: Employee, outcome: str) -> None:
    instance.status = outcome
    instance.completed_at = utcnow()
    _resolve_waiting(db, instance)
    if instance.type not in OWN_FINISH_NOTICE:
        notify(
            db,
            recipient_id=requester.id,
            title=f"{instance.type.replace('_', ' ').capitalize()} request {outcome}",
            body=f"Your {instance.type.replace('_', ' ')} request was {outcome}.",  # no internal ids in user text
            href=requester_href(instance),
        )
    for handler in _FINISH_HANDLERS.get(instance.type, []):
        handler(db, instance)


# Request modules (expenses, travel, lifecycle, ...) register a callback that updates their own row when an
# instance of their type ends approved or rejected, whichever endpoint made the final decision.
FinishHandler = Callable[[Session, ApprovalInstance], None]
_FINISH_HANDLERS: dict[str, list[FinishHandler]] = {}


def on_finish(type_: str) -> Callable[[FinishHandler], FinishHandler]:
    def register(fn: FinishHandler) -> FinishHandler:
        handlers = _FINISH_HANDLERS.setdefault(type_, [])
        if fn not in handlers:
            handlers.append(fn)
        return fn

    return register


def cancel(db: Session, instance: ApprovalInstance, actor_id: str | None = None, ip: str | None = None) -> ApprovalInstance:
    """The requester withdrew the request: close a pending instance without notifying anyone."""
    if instance.status != "pending":
        raise ApprovalError(f"This request is already {instance.status}.")
    before = _snapshot(instance)
    instance.status = "cancelled"
    instance.completed_at = utcnow()
    _resolve_waiting(db, instance)
    record_audit(db, actor_id=actor_id, action="approval_cancelled", entity="approval_instance", entity_id=instance.id,
                 subject_id=instance.requester_id, before=before, after=_snapshot(instance), ip=ip)
    return instance


def start(
    db: Session, type_: str, entity_id: str, requester: Employee, amount: float | None = None, actor_id: str | None = None,
    line_from_requester: bool = False, context: dict[str, Any] | None = None, fallback: bool = True,
    exclude: set[str] | None = None, compare_amount: float | None = None,
) -> ApprovalInstance:
    """context: facts step conditions may use (country / department / grade override the requester's; flags such as
    needs_hr / via_manager for only_if). exclude: people who may never approve it besides the requester (e.g. the
    subject of a request raised by someone else). compare_amount: the amount to test step thresholds (min_amount)
    against when it differs from the amount shown (e.g. an expense in another currency, scaled to the threshold's)."""
    definition = latest_definition(db, type_)
    threshold_amount = amount if compare_amount is None else compare_amount
    if definition is None:
        raise ApprovalError(f"No approval workflow is set up for {type_}.")
    steps = []
    for raw in definition.steps:
        groups = {role: resolve_group(db, role, requester, line_from_requester, fallback) for role in raw["roles"]}
        matched = condition_matches(raw, requester, context)
        applies = matched and _step_applies(raw, threshold_amount)
        step = {
            "roles": list(raw["roles"]),
            "mode": raw.get("mode", "any"),
            "min_amount": raw.get("min_amount"),
            "groups": groups,
            "skipped": not applies or not any(groups.values()),
        }
        for key in ("label", "sla_hours", "condition", "only_if"):
            if raw.get(key) is not None:
                step[key] = raw[key]
        if not matched:
            step["applies"] = False
        if raw.get("min_amount") is not None:
            step["min_amount_met"] = _step_applies({"min_amount": raw["min_amount"]}, threshold_amount)
        steps.append(step)
    steps = retarget(db, steps, 0, set(), amount, {requester.id} | (exclude or set()))
    instance = ApprovalInstance(
        id=f"apr-{uuid.uuid4().hex[:12]}",
        type=type_,
        entity_id=entity_id,
        requester_id=requester.id,
        amount=amount,
        workflow_version=definition.version,
        steps=steps,
        current_step=0,
        status="pending",
    )
    instance.current_step = _next_step(instance, 0)
    _mark_started(instance)
    db.add(instance)
    db.flush()
    record_audit(
        db, actor_id=actor_id or requester.id, action="approval_started", entity="approval_instance", entity_id=instance.id,
        subject_id=requester.id, after=_snapshot(instance) | {"amount": amount, "workflow_version": definition.version},
    )
    if instance.current_step >= len(steps):
        _finish(db, instance, requester, "approved")
        record_audit(db, actor_id=actor_id or requester.id, action="approval_approved", entity="approval_instance",
                     entity_id=instance.id, subject_id=requester.id, after=_snapshot(instance))
    else:
        _notify_step(db, instance, requester)
    return instance


def decide(
    db: Session, instance: ApprovalInstance, approver_id: str, decision: str, note: str | None = None,
    actor_id: str | None = None, ip: str | None = None, authority: bool = False,
) -> ApprovalInstance:
    """authority: the person may decide this kind of request anyway (HR in scope or anyone above the requester, as the
    leave / attendance / timesheet endpoints always allowed); they act for the first group still waiting."""
    if instance.requester_id == approver_id:
        raise NotAllowed("You can't decide your own request.")
    if instance.status != "pending":
        raise ApprovalError(f"This request is already {instance.status}.")
    if decision not in ("approve", "reject"):
        raise ApprovalError("Choose approve or reject.")
    if decision == "reject" and not (note or "").strip():
        raise ApprovalError("Add a note saying why the request is rejected.")
    if any(approver_id in (d.approver_id, d.on_behalf_of) for d in _approvals_in_step(db, instance, instance.current_step)):
        raise NotAllowed("You have already approved this step.")
    if approver_id in _barred(instance):
        raise NotAllowed("You can't decide a request about yourself.")
    acting = _acting_as(db, instance, approver_id)
    if acting is None and authority:
        waiting = list(open_groups(db, instance))
        acting = (waiting[0], None) if waiting else None
    if acting is None:
        raise NotAllowed("You are not an approver for this step.")
    group, on_behalf_of = acting
    if decision == "approve" and approver_id in _approved_before(db, instance, instance.current_step):
        raise NotAllowed("You approved an earlier step of this request.")
    requester = db.get(Employee, instance.requester_id)
    assert requester is not None
    before = _snapshot(instance)
    db.add(ApprovalDecision(instance_id=instance.id, step=instance.current_step, group=group, approver_id=approver_id,
                            decision=decision, note=(note or "").strip() or None, on_behalf_of=on_behalf_of))
    db.flush()
    if decision == "reject":
        _finish(db, instance, requester, "rejected")
    elif _step_complete(db, instance):
        following = instance.current_step + 1
        instance.steps = retarget(db, instance.steps, following, _approved_before(db, instance, following), instance.amount,
                                  {instance.requester_id})
        instance.current_step = _next_step(instance, following)
        if instance.current_step >= len(instance.steps):
            _finish(db, instance, requester, "approved")
        else:
            _mark_started(instance)
            _notify_step(db, instance, requester)
    action = "approval_" + ({"approved": "approved", "rejected": "rejected"}.get(instance.status, "step_decided"))
    record_audit(
        db, actor_id=actor_id or approver_id, action=action, entity="approval_instance", entity_id=instance.id,
        subject_id=requester.id, before=before,
        after=_snapshot(instance) | {"group": group, "decision": decision}
        | ({"on_behalf_of": on_behalf_of} if on_behalf_of else {}), ip=ip,
    )
    return instance


def pending_for(db: Session, employee_id: str) -> list[ApprovalInstance]:
    """Pending instances whose current step waits on this person (or on someone they are covering for)."""
    out = []
    delegators = delegators_for(db, employee_id)
    for instance in db.scalars(select(ApprovalInstance).where(ApprovalInstance.status == "pending").order_by(ApprovalInstance.created_at)):
        if employee_id in _barred(instance):
            continue
        waiting = {i for ids in open_groups(db, instance).values() for i in ids}
        if employee_id in waiting or any(_covers(delegators[d], instance.type) for d in waiting & set(delegators)):
            out.append(instance)
    return out


def pending_instances(db: Session, type_: str, entity_ids: list[str] | set[str] | None = None) -> dict[str, ApprovalInstance]:
    """{entity_id: pending instance} for one type (all of them, or only these entities)."""
    stmt = select(ApprovalInstance).where(ApprovalInstance.type == type_, ApprovalInstance.status == "pending")
    if entity_ids is not None:
        if not entity_ids:
            return {}
        stmt = stmt.where(ApprovalInstance.entity_id.in_(list(entity_ids)))
    return {i.entity_id: i for i in db.scalars(stmt.order_by(ApprovalInstance.created_at))}


def latest_instances(db: Session, type_: str, entity_ids: list[str] | set[str]) -> dict[str, ApprovalInstance]:
    """{entity_id: newest instance} (any status) for these entities."""
    if not entity_ids:
        return {}
    out: dict[str, ApprovalInstance] = {}
    for inst in db.scalars(
        select(ApprovalInstance).where(ApprovalInstance.type == type_, ApprovalInstance.entity_id.in_(list(entity_ids)))
        .order_by(ApprovalInstance.created_at, ApprovalInstance.id)
    ):
        out[inst.entity_id] = inst
    return out


def step_started_at(db: Session, instance: ApprovalInstance) -> datetime:
    """When the current step began waiting (older instances: the last earlier decision, or the start)."""
    raw = instance.steps[instance.current_step].get("started_at") if instance.current_step < len(instance.steps) else None
    if raw:
        moment = datetime.fromisoformat(raw)
    else:
        moment = db.scalar(
            select(func.max(ApprovalDecision.at)).where(
                ApprovalDecision.instance_id == instance.id, ApprovalDecision.step < instance.current_step
            )
        ) or instance.created_at
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def escalate_overdue_steps(db: Session, now: datetime | None = None) -> int:
    """Steps with sla_hours that waited longer: once per step, tell the approvers' managers (admin when there is
    none) and the approvers, and audit it. Returns how many steps were escalated."""
    now = now or utcnow()
    count = 0
    for instance in db.scalars(select(ApprovalInstance).where(ApprovalInstance.status == "pending").order_by(ApprovalInstance.created_at)):
        if instance.current_step >= len(instance.steps):
            continue
        step = instance.steps[instance.current_step]
        hours = step.get("sla_hours")
        if not hours or step.get("escalated_at"):
            continue
        if now - step_started_at(db, instance) <= timedelta(hours=float(hours)):
            continue
        waiting = list(dict.fromkeys(i for ids in open_groups(db, instance).values() for i in ids))
        targets: list[str] = []
        for approver in waiting:
            emp = db.get(Employee, approver)
            if emp and emp.manager_id and emp.manager_id not in waiting and emp.manager_id != instance.requester_id:
                targets.append(emp.manager_id)
        if not targets:
            targets = [i for i in _accounts_with_roles(db, {"admin"}) if i not in waiting and i != instance.requester_id]
        targets = list(dict.fromkeys(targets))
        requester = db.get(Employee, instance.requester_id)
        who = requester.full_name if requester else "an employee"
        for rid in targets:
            notify(db, recipient_id=rid, title=f"Overdue approval · {_label(instance)} from {who}",
                   body=f"Step {instance.current_step + 1} has waited more than {float(hours):g} hours. Please follow up.",
                   href=_href(instance))
        for rid in waiting:
            notify(db, recipient_id=rid, title=f"Approval overdue · {_label(instance)} from {who}",
                   body=f"This step is past its {float(hours):g}-hour limit.", href=_href(instance))
        steps = [dict(s) for s in instance.steps]
        steps[instance.current_step]["escalated_at"] = now.isoformat()
        steps[instance.current_step]["escalated_to"] = targets
        instance.steps = steps
        record_audit(db, actor_id=None, action="approval_escalated", entity="approval_instance", entity_id=instance.id,
                     subject_id=instance.requester_id,
                     after={"step": instance.current_step, "sla_hours": hours, "escalated_to": targets})
        count += 1
    db.flush()
    return count


def decisions_of(db: Session, instance: ApprovalInstance) -> list[ApprovalDecision]:
    return list(db.scalars(select(ApprovalDecision).where(ApprovalDecision.instance_id == instance.id).order_by(ApprovalDecision.id)))
