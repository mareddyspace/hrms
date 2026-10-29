"""Exits: resignation, termination, retirement and end of contract (approval type "exit").

- The employee raises a resignation or retirement for themselves: their manager approves, then HR. Someone with no
  manager (the CEO / top of the org) goes to HR only (only_if "via_manager" in the default chain).
- HR raises a termination (or any exit) for someone else: a second HR person approves, else an administrator, then an
  executive. The HR person who raised it, and the leaver, never approve it. Exits are never raised by the AI assistant.
- Notice comes from the country config (countries.notice_days; contractors 7 days). A date inside the notice period
  needs an early-release request, which an approver may decline (the standard date then applies).
- On final approval: status "Approved", employees.employment_status "Notice period" and employees.last_working_day set,
  the clearance checklist starts and the final settlement is "Pending".
- complete_due_exits() (jobs.run_all, at startup and from the admin jobs run): once the last working day has passed in
  the leaver's time zone the case is "Completed", the person "Exited", their sign-in account deactivated and their
  sessions revoked, and the unused leave days for the final settlement frozen.
"""

from __future__ import annotations

import uuid
from datetime import date, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import utcnow
from app.models import Account, ApprovalDecision, ApprovalInstance, Country, Employee, ExitCase, RefreshToken
from app.services import approvals as engine
from app.services.activity import notify, record_audit
from app.services.leave import balances, today_for
from app.services.workflow_defaults import ensure_default

TYPE = "exit"
EXIT_TYPES = ("resignation", "termination", "retirement", "end_of_contract")
SELF_TYPES = ("resignation", "retirement")
TYPE_LABELS = {"resignation": "Resignation", "termination": "Termination", "retirement": "Retirement",
               "end_of_contract": "End of contract"}
OPEN = ("Submitted", "Manager approved", "Approved")
PENDING = ("Submitted", "Manager approved")
DONE = ("Approved", "Completed")
LEFT_STATUSES = ("Exited", "Terminated")
CONTRACTOR_NOTICE_DAYS = 7
DEFAULT_NOTICE_DAYS = 30
MAX_AHEAD_DAYS = 365
SETTLEMENT_STEPS = ("Pending", "In progress", "Paid")
CLEARANCE = (
    ("assets_returned", "Company assets returned", "it"),
    ("it_access", "IT access removed (email, VPN, apps)", "it"),
    ("finance_dues", "Finance dues settled (advances, expenses, loans)", "finance"),
    ("knowledge_transfer", "Knowledge transfer done", "manager"),
)
INTERVIEW_REASONS = (
    "Better role elsewhere", "Pay and benefits", "Manager relationship", "Team culture", "Workload", "Limited growth",
    "Commute or location", "Personal circumstances",
)


class ExitError(ValueError):
    """A rule was broken (422); the message is safe to show the user."""


def label(exit_type: str) -> str:
    return TYPE_LABELS.get(exit_type, exit_type.replace("_", " ").capitalize())


def notice_days_for(db: Session, emp: Employee) -> int:
    if (emp.employment_type or "").lower().startswith("contract") or emp.employment_status == "Contractor":
        return CONTRACTOR_NOTICE_DAYS
    country = db.get(Country, emp.country_code)
    if country is not None and country.notice_days:
        return int(country.notice_days)
    from app.services.leave_rules import COUNTRY_DEFAULTS, COUNTRY_FALLBACK

    return int(COUNTRY_DEFAULTS.get(emp.country_code, COUNTRY_FALLBACK).get("notice_days") or DEFAULT_NOTICE_DAYS)


def unused_leave_days(db: Session, emp: Employee) -> float:
    """Privilege leave ("pto") left this year, paid out in the final settlement (same rule as the portal)."""
    try:
        row = next((b for b in balances(db, emp) if b.code == "pto"), None)
    except Exception:  # noqa: BLE001  (no leave policies for the country)
        return 0.0
    return max(0.0, float(row.left)) if row else 0.0


def open_case_for(db: Session, employee_id: str) -> ExitCase | None:
    return db.scalar(select(ExitCase).where(ExitCase.employee_id == employee_id, ExitCase.status.in_(OPEN))
                     .order_by(ExitCase.created_at.desc()))


def is_self_raised(case: ExitCase) -> bool:
    return case.raised_by == case.employee_id


def instance_of(db: Session, case: ExitCase) -> ApprovalInstance | None:
    return db.get(ApprovalInstance, case.approval_instance_id) if case.approval_instance_id else None


def current_status(db: Session, case: ExitCase, instance: ApprovalInstance | None = None) -> str:
    """Submitted becomes "Manager approved" once an earlier step (the manager) has approved and HR is next."""
    if case.status not in PENDING:
        return case.status
    instance = instance or instance_of(db, case)
    if instance is None or instance.status != "pending":
        return case.status
    approved_before = db.scalar(select(ApprovalDecision.id).where(
        ApprovalDecision.instance_id == instance.id, ApprovalDecision.decision == "approve",
        ApprovalDecision.step < instance.current_step))
    return "Manager approved" if approved_before else "Submitted"


def _snapshot(case: ExitCase) -> dict[str, Any]:
    return {"status": case.status, "exit_type": case.exit_type, "requested_last_day": case.requested_last_day,
            "approved_last_working_day": case.approved_last_working_day, "early_release": case.early_release}


def create_case(db: Session, emp: Employee, raiser: Employee, exit_type: str, requested_last_day: date, reason: str,
                note: str | None, early_release: bool, actor_id: str, ip: str | None = None) -> ExitCase:
    if exit_type not in EXIT_TYPES:
        raise ExitError(f"Exit type must be one of: {', '.join(EXIT_TYPES)}.")
    self_raised = emp.id == raiser.id
    if self_raised and exit_type not in SELF_TYPES:
        raise ExitError("You can raise a resignation or retirement for yourself.")
    if emp.employment_status in LEFT_STATUSES:
        raise ExitError("This person has already left.")
    if open_case_for(db, emp.id) is not None:
        raise ExitError("An exit is already open for this person." if not self_raised else "You already have an open exit request.")
    reason = (reason or "").strip()
    if not reason:
        raise ExitError("Give a reason.")
    today = today_for(emp)
    notice = notice_days_for(db, emp)
    standard = today + timedelta(days=notice)
    if requested_last_day < today:
        raise ExitError("The last working day can't be in the past.")
    if requested_last_day > today + timedelta(days=MAX_AHEAD_DAYS):
        raise ExitError(f"The last working day must be within {MAX_AHEAD_DAYS} days.")
    if self_raised:
        if requested_last_day < standard and not early_release:
            raise ExitError(f"Your notice period is {notice} days. Choose {standard.isoformat()} or later, or ask for early release.")
        if early_release and requested_last_day >= standard:
            raise ExitError("Early release is only needed for a date inside your notice period.")
    else:
        early_release = False  # HR sets the date; no early-release request
    case = ExitCase(
        id=f"exit-{uuid.uuid4().hex[:12]}", employee_id=emp.id, exit_type=exit_type, submitted_on=today,
        requested_last_day=requested_last_day, standard_last_day=standard, notice_days=notice,
        early_release=bool(early_release), reason=reason[:500], note=(note or "").strip()[:1000] or None,
        status="Submitted", raised_by=raiser.id, clearance=[], settlement={"status": "Pending"},
    )
    db.add(case)
    db.flush()
    record_audit(db, actor_id=actor_id, action="exit_submitted", entity="exit_case", entity_id=case.id, subject_id=emp.id,
                 after=_snapshot(case), ip=ip)
    ensure_default(db, TYPE)
    has_manager = bool(emp.manager_id and db.get(Employee, emp.manager_id) is not None)
    try:
        if self_raised:
            instance = engine.start(db, TYPE, case.id, emp, None, actor_id=actor_id,
                                    context={"via_manager": has_manager}, fallback=False)
        else:
            instance = engine.start(db, TYPE, case.id, raiser, None, actor_id=actor_id,
                                    context={"via_manager": False}, exclude={emp.id})
    except engine.ApprovalError as exc:
        raise ExitError(str(exc)) from exc
    if instance.status != "pending" and not any(not s["skipped"] for s in instance.steps):
        raise ExitError("No HR approver is set up for this country. Ask an administrator.")
    case.approval_instance_id = instance.id
    if not self_raised:
        notify(db, recipient_id=raiser.id, title=f"{label(exit_type)} raised for {emp.full_name}",
               body="It now needs a second approver.", href="/people/exits")
    return case


def withdraw_case(db: Session, case: ExitCase, actor_id: str, who: str, ip: str | None = None) -> None:
    from app.services.workflow_defaults import notify_withdrawn

    if case.status not in PENDING:
        raise ExitError(f"This exit is already {case.status.lower()}; it can only be withdrawn before approval.")
    before = _snapshot(case)
    instance = instance_of(db, case)
    emp = db.get(Employee, case.employee_id)
    notify_withdrawn(db, instance, who, f"{label(case.exit_type).lower()}{'' if is_self_raised(case) else f' for {emp.full_name if emp else case.employee_id}'}",
                     "/team/exits")
    if instance is not None and instance.status == "pending":
        engine.cancel(db, instance, actor_id=actor_id, ip=ip)
    case.status = "Withdrawn"
    record_audit(db, actor_id=actor_id, action="exit_withdrawn", entity="exit_case", entity_id=case.id,
                 subject_id=case.employee_id, before=before, after=_snapshot(case), ip=ip)


def final_last_day(case: ExitCase, today: date) -> date:
    if case.early_release and case.early_release_approved is False:
        day = case.standard_last_day
    else:
        day = case.requested_last_day
    return max(day, today)


@engine.on_finish(TYPE)
def _exit_finished(db: Session, instance: ApprovalInstance) -> None:
    case = db.get(ExitCase, instance.entity_id)
    if case is None or case.status not in PENDING or instance.status not in ("approved", "rejected"):
        return
    emp = db.get(Employee, case.employee_id)
    assert emp is not None
    actor = db.scalar(select(ApprovalDecision.approver_id).where(ApprovalDecision.instance_id == instance.id)
                      .order_by(ApprovalDecision.id.desc())) or instance.requester_id
    before = _snapshot(case)
    what = label(case.exit_type)
    if instance.status == "rejected":
        case.status = "Rejected"
        record_audit(db, actor_id=actor, action="exit_rejected", entity="exit_case", entity_id=case.id,
                     subject_id=emp.id, before=before, after=_snapshot(case))
        notify(db, recipient_id=case.raised_by, title=f"{what} not approved",
               body="Open it to see the note.", href="/me/exit" if is_self_raised(case) else "/people/exits")
        return
    if case.early_release and case.early_release_approved is None:
        case.early_release_approved = True
    lwd = final_last_day(case, today_for(emp))
    case.approved_last_working_day = lwd
    case.status = "Approved"
    case.clearance = [{"key": k, "label": text, "owner": owner, "done": False} for k, text, owner in CLEARANCE]
    case.settlement = {"status": "Pending"}
    emp_before = {"employment_status": emp.employment_status, "last_working_day": emp.last_working_day}
    emp.employment_status = "Notice period"
    emp.last_working_day = lwd
    record_audit(db, actor_id=actor, action="exit_approved", entity="exit_case", entity_id=case.id, subject_id=emp.id,
                 before=before, after=_snapshot(case))
    record_audit(db, actor_id=actor, action="employee_updated", entity="employee", entity_id=emp.id, subject_id=emp.id,
                 before=emp_before, after={"employment_status": "Notice period", "last_working_day": lwd, "exit_case_id": case.id})
    body = f"Last working day: {lwd.isoformat()}."
    notify(db, recipient_id=emp.id, title=f"{what} approved", body=body, href="/me/exit")
    if emp.manager_id:
        notify(db, recipient_id=emp.manager_id, title=f"{what} approved for {emp.full_name}", body=body, href="/team/exits")
    if case.raised_by not in (emp.id, emp.manager_id):
        notify(db, recipient_id=case.raised_by, title=f"{what} approved for {emp.full_name}", body=body, href="/people/exits")


def complete_case(db: Session, case: ExitCase, actor_id: str | None = None) -> None:
    emp = db.get(Employee, case.employee_id)
    assert emp is not None
    before = _snapshot(case)
    settlement = dict(case.settlement or {})
    settlement.setdefault("status", "Pending")
    settlement["unused_leave_days"] = unused_leave_days(db, emp)
    case.settlement = settlement
    case.status = "Completed"
    case.completed_at = utcnow()
    emp_before = {"employment_status": emp.employment_status}
    emp.employment_status = "Exited"
    if case.approved_last_working_day:
        emp.last_working_day = case.approved_last_working_day
    db.flush()
    try:
        from app.services.lifecycle import _close_and_add_assignment

        _close_and_add_assignment(db, emp, (emp.last_working_day or today_for(emp)) + timedelta(days=1))
    except Exception:  # noqa: BLE001  (history row is best effort)
        pass
    account = db.scalar(select(Account).where(Account.employee_id == emp.id))
    if account is not None and account.active:
        account.active = False
        now = utcnow()
        for token in db.scalars(select(RefreshToken).where(RefreshToken.account_id == account.id, RefreshToken.revoked_at.is_(None))):
            token.revoked_at = now
        record_audit(db, actor_id=actor_id, action="account_deactivated", entity="account", entity_id=account.id,
                     subject_id=emp.id, before={"active": True}, after={"active": False, "reason": "exit completed"})
    record_audit(db, actor_id=actor_id, action="exit_completed", entity="exit_case", entity_id=case.id, subject_id=emp.id,
                 before=before, after=_snapshot(case) | {"unused_leave_days": settlement["unused_leave_days"]})
    record_audit(db, actor_id=actor_id, action="employee_updated", entity="employee", entity_id=emp.id, subject_id=emp.id,
                 before=emp_before, after={"employment_status": "Exited", "exit_case_id": case.id})


def complete_due_exits(db: Session, today: date | None = None) -> list[str]:
    """Close approved exits whose last working day has passed (each leaver's local date unless `today` is given).
    Only people with an approved exit are touched. The caller commits."""
    horizon = today or (date.today() + timedelta(days=1))
    done = []
    for case in list(db.scalars(select(ExitCase).where(ExitCase.status == "Approved",
                                                       ExitCase.approved_last_working_day < horizon))):
        emp = db.get(Employee, case.employee_id)
        if emp is None or case.approved_last_working_day is None:
            continue
        if case.approved_last_working_day >= (today or today_for(emp)):
            continue
        complete_case(db, case)
        done.append(case.id)
    return done


# ---------- who may do what ----------
def can_tick(case: ExitCase, owner: str, *, actor_id: str | None, role: str, is_hr: bool, in_chain: bool,
             subject_has_manager: bool) -> bool:
    if case.status != "Approved" or not actor_id or actor_id == case.employee_id:
        return False
    if is_hr:
        return True
    if owner == "manager":
        return in_chain and subject_has_manager
    if owner == "it":
        return role in ("admin", "super_admin", "it_admin")
    if owner == "finance":
        return role == "finance"
    return False


def set_clearance(db: Session, case: ExitCase, key: str, done: bool, actor: Employee, actor_id: str, ip: str | None) -> None:
    items = [dict(i) for i in case.clearance or []]
    item = next((i for i in items if i["key"] == key), None)
    if item is None:
        raise ExitError("Checklist item not found.")
    before = dict(item)
    item["done"] = bool(done)
    item["done_by"] = actor.full_name if done else None
    item["done_by_id"] = actor.id if done else None
    item["done_on"] = today_for(actor).isoformat() if done else None
    case.clearance = items
    record_audit(db, actor_id=actor_id, action="exit_clearance_updated", entity="exit_case", entity_id=case.id,
                 subject_id=case.employee_id, before=before, after=item, ip=ip)


def submit_interview(db: Session, case: ExitCase, emp: Employee, data: dict[str, Any], actor_id: str, ip: str | None) -> None:
    if case.status not in DONE:
        raise ExitError("The exit interview opens once your exit is approved.")
    if case.interview:
        raise ExitError("You have already sent your exit interview.")
    reasons = list(dict.fromkeys(data.get("reasons") or []))
    if not reasons:
        raise ExitError("Pick at least one reason.")
    if any(r not in INTERVIEW_REASONS for r in reasons):
        raise ExitError("One of the reasons is not recognised.")
    case.interview = {"rating": int(data["rating"]), "reasons": reasons, "would_return": data["would_return"],
                      "comments": (data.get("comments") or "").strip()[:2000], "submitted_on": today_for(emp).isoformat()}
    # The answers are private to HR: the audit row records only that it was sent.
    record_audit(db, actor_id=actor_id, action="exit_interview_submitted", entity="exit_case", entity_id=case.id,
                 subject_id=emp.id, after={"submitted": True}, ip=ip)
    hr_ids = engine.resolve_group(db, "hr", emp)
    for rid in hr_ids:
        notify(db, recipient_id=rid, title=f"Exit interview from {emp.full_name}", body="Confidential to HR.",
               href="/people/exits")


def set_settlement(db: Session, case: ExitCase, status: str, actor: Employee, actor_id: str, ip: str | None) -> None:
    if case.status not in DONE:
        raise ExitError("Settlement starts once the exit is approved.")
    current = (case.settlement or {}).get("status", "Pending")
    if status not in SETTLEMENT_STEPS:
        raise ExitError("Unknown settlement status.")
    if SETTLEMENT_STEPS.index(status) != SETTLEMENT_STEPS.index(current) + 1:
        nxt = SETTLEMENT_STEPS[SETTLEMENT_STEPS.index(current) + 1] if current != "Paid" else None
        raise ExitError(f"Settlement can only move from {current} to {nxt}." if nxt else "Settlement is already paid.")
    before = dict(case.settlement or {})
    after = before | {"status": status, "updated_by": actor.full_name, "updated_on": today_for(actor).isoformat()}
    if status == "Paid" and "unused_leave_days" not in after:
        emp = db.get(Employee, case.employee_id)
        after["unused_leave_days"] = unused_leave_days(db, emp) if emp else 0.0
    case.settlement = after
    record_audit(db, actor_id=actor_id, action="exit_settlement_updated", entity="exit_case", entity_id=case.id,
                 subject_id=case.employee_id, before=before, after=after, ip=ip)
    notify(db, recipient_id=case.employee_id, title=f"Final settlement: {status.lower()}", body="", href="/me/exit")


engine.NOTICE_LABELS[TYPE] = "Exit request"
engine.OWN_FINISH_NOTICE.add(TYPE)
