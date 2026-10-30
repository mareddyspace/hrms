"""Onboarding: joiners (created when a candidate is Hired), checklist tasks and the policy acknowledgment.

Rules: app/services/onboarding.py. Completing every task and the acknowledgment makes the employee Active.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from sqlalchemy import select

from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import Employee, Joiner, OnboardingTask
from app.schemas.talent import JoinerOut, OnboardingTaskOut, TaskUpdateIn
from app.services import onboarding as rules
from app.services.activity import notify, record_audit
from app.services.decisions import NOT_FOUND

router = APIRouter(prefix="/onboarding", tags=["onboarding"])


def _out(db: DbSession, joiner: Joiner) -> JoinerOut:
    tasks = rules.tasks_of(db, joiner)
    out = JoinerOut.model_validate(joiner)
    out.tasks = [OnboardingTaskOut.model_validate(t) for t in tasks]
    out.progress_pct = rules.progress_pct(tasks)
    emp = db.get(Employee, joiner.employee_id)
    out.employment_status = emp.employment_status if emp else None
    return out


def _visible(db: DbSession, user: CurrentUser, joiner_id: str) -> Joiner:
    joiner = db.get(Joiner, joiner_id)
    if joiner is None or not rules.can_view(user, joiner):
        raise NOT_FOUND
    return joiner


@router.get("/joiners", response_model=list[JoinerOut])
def list_joiners(db: DbSession, user: CurrentUserDep, status: str | None = None) -> list[JoinerOut]:
    stmt = select(Joiner).order_by(Joiner.start_date.desc(), Joiner.id)
    if status:
        stmt = stmt.where(Joiner.status == status)
    return [_out(db, j) for j in db.scalars(stmt) if rules.can_view(user, j)]


@router.get("/joiners/{joiner_id}", response_model=JoinerOut)
def get_joiner(joiner_id: str, db: DbSession, user: CurrentUserDep) -> JoinerOut:
    return _out(db, _visible(db, user, joiner_id))


@router.patch("/tasks/{task_id}", response_model=JoinerOut)
def update_task(task_id: str, body: TaskUpdateIn, request: Request, db: DbSession, user: CurrentUserDep) -> JoinerOut:
    task = db.get(OnboardingTask, task_id)
    if task is None:
        raise NOT_FOUND
    joiner = _visible(db, user, task.joiner_id)
    if body.status == task.status:
        return _out(db, joiner)
    try:
        before = rules.update_task(db, user, task, joiner, body.status, body.reason)
    except rules.Forbidden as exc:
        raise HTTPException(403, str(exc)) from exc
    except rules.RuleError as exc:
        raise HTTPException(409 if "complete" in str(exc) or "Finish first" in str(exc) else 422, str(exc)) from exc
    db.flush()
    record_audit(db, actor_id=user.id, action="onboarding_task_updated", entity="onboarding_task", entity_id=task.id,
                 subject_id=joiner.employee_id, before=before,
                 after={"status": task.status, "override_note": task.override_note, "joiner_id": joiner.id}, ip=client_ip(request))
    if task.override_note and user.employee_id != joiner.employee_id:
        owner = {"manager": joiner.manager_id, "employee": joiner.employee_id}.get(task.owner_role)
        if owner and owner != user.employee_id:
            notify(db, recipient_id=owner, title=f"HR updated your onboarding task: {task.title}", body=task.override_note,
                   href=f"/onboarding/joiners/{joiner.id}")
    rules.refresh_status(db, joiner, user.id)
    db.commit()
    return _out(db, joiner)


@router.post("/joiners/{joiner_id}/acknowledge", response_model=JoinerOut)
def acknowledge_policies(joiner_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> JoinerOut:
    """The joiner acknowledges the company policies, or HR records it on their behalf."""
    joiner = _visible(db, user, joiner_id)
    try:
        rules.acknowledge(db, user, joiner)
    except rules.Forbidden as exc:
        raise HTTPException(403, str(exc)) from exc
    except rules.RuleError as exc:
        raise HTTPException(409, str(exc)) from exc
    record_audit(db, actor_id=user.id, action="onboarding_policies_acknowledged", entity="joiner", entity_id=joiner.id,
                 subject_id=joiner.employee_id, before={"policy_ack": False},
                 after={"policy_ack": True, "by_hr": joiner.policy_ack_by_hr}, ip=client_ip(request))
    if joiner.policy_ack_by_hr:
        notify(db, recipient_id=joiner.employee_id, title="HR recorded your policy acknowledgment",
               href=f"/onboarding/joiners/{joiner.id}")
    rules.refresh_status(db, joiner, user.id)
    db.commit()
    return _out(db, joiner)


# ---------- analytics & pre-boarding form (migration 0010) ----------
from datetime import date as _date  # noqa: E402

from app.schemas.onboarding_payroll import OnboardingAnalyticsOut, PreboardingFormIn  # noqa: E402
from app.services.scope import GLOBAL_ROLES  # noqa: E402

ANALYTICS_ROLES = GLOBAL_ROLES  # HR, admin, executive


@router.get("/analytics", response_model=OnboardingAnalyticsOut)
def onboarding_analytics(db: DbSession, user: CurrentUserDep, country: str | None = None) -> OnboardingAnalyticsOut:
    """Joiners in this user's data scope: by month and country, checklist completion, overdue tasks by owner."""
    if user.account.role not in ANALYTICS_ROLES:
        raise HTTPException(403, "Onboarding analytics is for HR, admins and executives.")
    # Aggregates only: admin / executive see the whole organisation, HR its countries (Scope.org_filter).
    stmt = select(Joiner).join(Employee, Employee.id == Joiner.employee_id).where(user.scope.org_filter())
    if country:
        stmt = stmt.where(Joiner.country_code == country.upper())
    joiners = list(db.scalars(stmt))
    return OnboardingAnalyticsOut(**rules.analytics(db, joiners, _date.today()))


@router.put("/joiners/{joiner_id}/preboarding", response_model=JoinerOut)
def submit_preboarding(joiner_id: str, body: PreboardingFormIn, request: Request, db: DbSession,
                       user: CurrentUserDep) -> JoinerOut:
    """The joiner (or HR) fills in the pre-boarding form; equipment and the IT request become IT tasks."""
    joiner = _visible(db, user, joiner_id)
    before = joiner.preboarding
    try:
        added = rules.submit_preboarding(db, user, joiner, body.model_dump())
    except rules.Forbidden as exc:
        raise HTTPException(403, str(exc)) from exc
    except rules.RuleError as exc:
        raise HTTPException(409, str(exc)) from exc
    record_audit(db, actor_id=user.id, action="onboarding_preboarding_submitted", entity="joiner", entity_id=joiner.id,
                 subject_id=joiner.employee_id, before={"submitted": before is not None},
                 after={"equipment": body.equipment, "it_systems": body.it_request.systems, "tasks_added": added},
                 ip=client_ip(request))
    if not rules.is_joiner_self(user, joiner):
        notify(db, recipient_id=joiner.employee_id, title="HR updated your pre-boarding form",
               href=f"/onboarding/joiners/{joiner.id}")
    rules.refresh_status(db, joiner, user.id)
    db.commit()
    return _out(db, joiner)
