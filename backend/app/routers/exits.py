"""Exits (resignation, termination, retirement, end of contract). Rules in app/services/exits.py.

- POST /exits: an employee raises their own resignation / retirement; HR raises any exit for someone in their scope.
- GET /exits?scope=mine|team|all: about me; my reporting line plus what waits on me; everyone in scope (HR / admin).
  A termination raised by HR is hidden from the person and their managers until it is approved.
- Exit interview answers are private to HR; the final settlement is shown to the leaver and HR.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import select

from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import ApprovalDecision, ApprovalInstance, Employee, ExitCase
from app.schemas.exits import (
    ClearanceIn, ClearanceItemOut, ExitCaseOut, ExitDecisionIn, ExitIn, ExitStepOut, InterviewIn, InterviewOut, NoticeOut,
    RetentionIn, RetentionOut, SettlementIn, SettlementOut,
)
from app.services import approvals as engine
from app.services import exits as rules
from app.services.activity import record_audit
from app.services.decisions import NOT_FOUND, me
from app.services.leave import today_for
from app.services.scope import manager_chain_ids
from app.services.workflow_defaults import decide_http, is_approver, waiting_entity_ids

router = APIRouter(prefix="/exits", tags=["exits"])


def _hr(user: CurrentUser) -> bool:
    return user.scope.is_hr


def _hr_or_admin(user: CurrentUser) -> bool:
    return user.scope.is_hr or user.account.role in ("admin", "super_admin")


def _can_view(db: DbSession, user: CurrentUser, case: ExitCase, emp: Employee, instance: ApprovalInstance | None) -> bool:
    me_id = user.employee_id
    if me_id and case.raised_by == me_id:
        return True
    visible_to_line = rules.is_self_raised(case) or case.status in rules.DONE
    if me_id and emp.id == me_id:
        return visible_to_line
    if is_approver(instance, me_id) or (instance is not None and engine.is_delegate_for(db, instance, me_id)):
        return True
    if _hr_or_admin(user) and user.scope.can_see(emp):
        return True
    return bool(me_id) and me_id in manager_chain_ids(db, emp.id) and visible_to_line


def _steps(db: DbSession, instance: ApprovalInstance | None, names: dict[str, str]) -> list[ExitStepOut]:
    if instance is None:
        return []
    decisions = list(db.scalars(select(ApprovalDecision).where(ApprovalDecision.instance_id == instance.id)
                                .order_by(ApprovalDecision.id)))
    out = []
    for i, step in enumerate(instance.steps):
        if step.get("skipped"):
            continue
        ids = list(dict.fromkeys(x for g in step["groups"].values() for x in g))
        last = next((d for d in reversed(decisions) if d.step == i), None)
        out.append(ExitStepOut(
            label=step.get("label") or "/".join(step["roles"]).replace("_", " ").title(), approver_ids=ids,
            decision=last.decision if last else None, by=names.get(last.approver_id, last.approver_id) if last else None,
            note=last.note if last else None, at=last.at if last else None,
        ))
    return out


def _out(db: DbSession, user: CurrentUser, case: ExitCase) -> ExitCaseOut:
    emp = db.get(Employee, case.employee_id)
    assert emp is not None
    instance = rules.instance_of(db, case)
    ids = {case.employee_id, case.raised_by}
    if instance is not None:
        ids |= {d for d in db.scalars(select(ApprovalDecision.approver_id).where(ApprovalDecision.instance_id == instance.id))}
    names = dict(db.execute(select(Employee.id, Employee.full_name).where(Employee.id.in_(ids))).all())
    me_id = user.employee_id
    hr_view = _hr(user) and user.scope.can_see(emp) and me_id != emp.id
    in_chain = bool(me_id) and me_id in manager_chain_ids(db, emp.id)
    clearance = [
        ClearanceItemOut(**{k: item.get(k) for k in ("key", "label", "owner", "done", "done_by", "done_on")},
                         can_tick=rules.can_tick(case, item["owner"], actor_id=me_id, role=user.account.role, is_hr=hr_view,
                                                 in_chain=in_chain, subject_has_manager=bool(emp.manager_id)))
        for item in case.clearance or []
    ]
    settlement = None
    if case.status in rules.DONE and (me_id == emp.id or hr_view):
        raw = case.settlement or {}
        frozen = "unused_leave_days" in raw
        settlement = SettlementOut(
            status=raw.get("status", "Pending"),
            unused_leave_days=float(raw["unused_leave_days"]) if frozen else rules.unused_leave_days(db, emp),
            frozen=frozen, last_working_day=case.approved_last_working_day,
            updated_by=raw.get("updated_by"), updated_on=raw.get("updated_on"),
        )
    return ExitCaseOut(
        id=case.id, employee_id=emp.id, employee_name=emp.full_name, country_code=emp.country_code,
        exit_type=case.exit_type, submitted_on=case.submitted_on, requested_last_day=case.requested_last_day,
        standard_last_day=case.standard_last_day, approved_last_working_day=case.approved_last_working_day,
        notice_days=case.notice_days, early_release=case.early_release, early_release_approved=case.early_release_approved,
        reason=case.reason, note=case.note, status=rules.current_status(db, case, instance), raised_by=case.raised_by,
        raised_by_name=names.get(case.raised_by), approval_instance_id=case.approval_instance_id,
        steps=_steps(db, instance, names), can_decide=engine.can_act(db, instance, me_id),
        can_withdraw=case.status in rules.PENDING and case.raised_by == me_id,
        clearance=clearance, interview_submitted=bool(case.interview),
        interview=InterviewOut(**case.interview) if case.interview and hr_view else None,
        settlement=settlement, completed_at=case.completed_at, created_at=case.created_at,
        early_release_reason=(case.details or {}).get("early_release_reason"),
        handover_plan=(case.details or {}).get("handover_plan"), handover_to=(case.details or {}).get("handover_to"),
        retention=[RetentionOut(**r) for r in (case.details or {}).get("retention") or []],
        can_add_retention=_can_retain(db, user, case, instance),
    )


def _can_retain(db: DbSession, user: CurrentUser, case: ExitCase, instance: ApprovalInstance | None) -> bool:
    me_id = user.employee_id
    if not me_id or me_id == case.employee_id or case.status not in rules.PENDING or not rules.is_self_raised(case):
        return False
    return me_id in manager_chain_ids(db, case.employee_id) or is_approver(instance, me_id)


def _visible(db: DbSession, user: CurrentUser, exit_id: str) -> tuple[ExitCase, Employee]:
    case = db.get(ExitCase, exit_id)
    emp = db.get(Employee, case.employee_id) if case else None
    if case is None or emp is None or not _can_view(db, user, case, emp, rules.instance_of(db, case)):
        raise NOT_FOUND
    return case, emp


def _err(exc: rules.ExitError) -> HTTPException:
    text = str(exc)
    return HTTPException(409 if "already" in text else 422, text)


@router.get("/notice", response_model=NoticeOut)
def my_notice(db: DbSession, user: CurrentUserDep) -> NoticeOut:
    """My notice period (country config) and the earliest standard last day."""
    emp = me(user)
    from datetime import timedelta

    days = rules.notice_days_for(db, emp)
    today = today_for(emp)
    return NoticeOut(notice_days=days, today=today, earliest_last_day=today + timedelta(days=days),
                     has_manager=bool(emp.manager_id))


@router.get("", response_model=list[ExitCaseOut])
def list_exits(
    db: DbSession,
    user: CurrentUserDep,
    scope: Annotated[str, Query(pattern="^(mine|team|all)$")] = "mine",
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
) -> list[ExitCaseOut]:
    stmt = select(ExitCase).join(Employee, Employee.id == ExitCase.employee_id)
    me_id = user.employee_id or ""
    if scope == "mine":
        stmt = stmt.where(ExitCase.employee_id == me_id)
    elif scope == "team":
        waiting = waiting_entity_ids(db, rules.TYPE, user.employee_id)
        reports = list(user.scope.reports)
        if not reports and not waiting:
            return []
        stmt = stmt.where((ExitCase.employee_id.in_(reports or [""])) | (ExitCase.id.in_(waiting or [""])))
    else:
        if not _hr_or_admin(user):
            raise HTTPException(403, "Only HR or an administrator can see every exit.")
        stmt = stmt.where(user.scope.employee_filter())
    if status_filter:
        stmt = stmt.where(ExitCase.status == status_filter)
    rows = db.scalars(stmt.order_by(ExitCase.created_at.desc()).limit(limit))
    out = []
    for case in rows:
        emp = db.get(Employee, case.employee_id)
        if emp is not None and _can_view(db, user, case, emp, rules.instance_of(db, case)):
            out.append(_out(db, user, case))
    return out


@router.post("", response_model=ExitCaseOut, status_code=status.HTTP_201_CREATED)
def create_exit(body: ExitIn, request: Request, db: DbSession, user: CurrentUserDep) -> ExitCaseOut:
    raiser = me(user)
    if body.employee_id and body.employee_id != raiser.id:
        emp = db.get(Employee, body.employee_id)
        if emp is None or not user.scope.can_see(emp):
            raise NOT_FOUND
        if not _hr(user):
            raise HTTPException(403, "Only HR can raise an exit for someone else.")
    else:
        emp = raiser
    try:
        case = rules.create_case(db, emp, raiser, body.exit_type, body.requested_last_day, body.reason, body.note,
                                 body.early_release, user.id, client_ip(request),
                                 details={"early_release_reason": body.early_release_reason if body.early_release else None,
                                          "handover_plan": body.handover_plan, "handover_to": body.handover_to})
    except rules.ExitError as exc:
        db.rollback()
        raise _err(exc) from exc
    db.commit()
    return _out(db, user, case)


@router.get("/{exit_id}", response_model=ExitCaseOut)
def get_exit(exit_id: str, db: DbSession, user: CurrentUserDep) -> ExitCaseOut:
    return _out(db, user, _visible(db, user, exit_id)[0])


@router.post("/{exit_id}/withdraw", response_model=ExitCaseOut)
def withdraw_exit(exit_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> ExitCaseOut:
    case, _ = _visible(db, user, exit_id)
    if case.raised_by != user.employee_id:
        raise HTTPException(403, "Only the person who raised this exit can withdraw it.")
    try:
        rules.withdraw_case(db, case, user.id, user.employee.full_name if user.employee else user.id, client_ip(request))
    except rules.ExitError as exc:
        raise _err(exc) from exc
    db.commit()
    return _out(db, user, case)


@router.post("/{exit_id}/decision", response_model=ExitCaseOut)
def decide_exit(exit_id: str, body: ExitDecisionIn, request: Request, db: DbSession, user: CurrentUserDep) -> ExitCaseOut:
    """Approve or reject the current step (same as POST /approvals/{approval_instance_id}/decision). An approver may
    decline an early-release date (approve_early_release false): the standard notice date then applies."""
    case, _ = _visible(db, user, exit_id)
    instance = rules.instance_of(db, case)
    if body.decision == "approve" and body.approve_early_release is False and case.early_release:
        if not engine.can_act(db, instance, user.employee_id):
            raise HTTPException(403, "You are not an approver for this step.")
        case.early_release_approved = False
    decide_http(db, instance, user.employee_id, body.decision, body.note, user.id, client_ip(request))
    current = rules.current_status(db, case, instance)
    if case.status in rules.PENDING and current != case.status:
        case.status = current
    db.commit()
    return _out(db, user, case)


@router.post("/{exit_id}/retention", response_model=ExitCaseOut)
def add_retention(exit_id: str, body: RetentionIn, request: Request, db: DbSession, user: CurrentUserDep) -> ExitCaseOut:
    """The manager (anyone above the leaver) or an approver offers a retention conversation, shown to the leaver."""
    case, _ = _visible(db, user, exit_id)
    if not _can_retain(db, user, case, rules.instance_of(db, case)):
        if case.status not in rules.PENDING:
            raise HTTPException(409, "A retention conversation can only be offered while the resignation is waiting.")
        raise HTTPException(403, "Only the leaver's manager or an approver can do this.")
    try:
        rules.add_retention_note(db, case, me(user), body.note, body.meet_on, user.id, client_ip(request))
    except rules.ExitError as exc:
        raise _err(exc) from exc
    db.commit()
    return _out(db, user, case)


@router.post("/{exit_id}/clearance/{key}", response_model=ExitCaseOut)
def update_clearance(exit_id: str, key: str, body: ClearanceIn, request: Request, db: DbSession,
                     user: CurrentUserDep) -> ExitCaseOut:
    case, emp = _visible(db, user, exit_id)
    item = next((i for i in case.clearance or [] if i["key"] == key), None)
    if item is None:
        raise NOT_FOUND
    hr_view = _hr(user) and user.scope.can_see(emp) and user.employee_id != emp.id
    in_chain = bool(user.employee_id) and user.employee_id in manager_chain_ids(db, emp.id)
    if not rules.can_tick(case, item["owner"], actor_id=user.employee_id, role=user.account.role, is_hr=hr_view,
                          in_chain=in_chain, subject_has_manager=bool(emp.manager_id)):
        if case.status != "Approved":
            raise HTTPException(409, "The checklist is open only while the exit is approved and not yet completed.")
        raise HTTPException(403, "You can't update this item.")
    try:
        rules.set_clearance(db, case, key, body.done, me(user), user.id, client_ip(request))
    except rules.ExitError as exc:
        raise _err(exc) from exc
    db.commit()
    return _out(db, user, case)


@router.post("/{exit_id}/interview", response_model=ExitCaseOut)
def submit_interview(exit_id: str, body: InterviewIn, request: Request, db: DbSession, user: CurrentUserDep) -> ExitCaseOut:
    case, emp = _visible(db, user, exit_id)
    if emp.id != user.employee_id:
        raise HTTPException(403, "Only the person leaving can fill in the exit interview.")
    try:
        rules.submit_interview(db, case, emp, body.model_dump(), user.id, client_ip(request))
    except rules.ExitError as exc:
        raise _err(exc) from exc
    db.commit()
    return _out(db, user, case)


@router.get("/{exit_id}/interview", response_model=InterviewOut)
def read_interview(exit_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> InterviewOut:
    """HR only (never the manager). Each read is audited."""
    case, emp = _visible(db, user, exit_id)
    if not (_hr(user) and user.scope.can_see(emp) and user.employee_id != emp.id):
        raise HTTPException(403, "Exit interviews are private to HR.")
    if not case.interview:
        raise HTTPException(404, "No exit interview yet.")
    record_audit(db, actor_id=user.id, action="exit_interview_read", entity="exit_case", entity_id=case.id,
                 subject_id=emp.id, ip=client_ip(request))
    db.commit()
    return InterviewOut(**case.interview)


@router.get("/{exit_id}/settlement", response_model=SettlementOut)
def read_settlement(exit_id: str, db: DbSession, user: CurrentUserDep) -> SettlementOut:
    case, _ = _visible(db, user, exit_id)
    out = _out(db, user, case).settlement
    if out is None:
        raise HTTPException(403 if case.status in rules.DONE else 409,
                            "Only the leaver and HR can see the final settlement." if case.status in rules.DONE
                            else "The final settlement starts once the exit is approved.")
    return out


@router.post("/{exit_id}/settlement", response_model=ExitCaseOut)
def update_settlement(exit_id: str, body: SettlementIn, request: Request, db: DbSession, user: CurrentUserDep) -> ExitCaseOut:
    case, emp = _visible(db, user, exit_id)
    if not (_hr(user) and user.scope.can_see(emp) and user.employee_id != emp.id):
        raise HTTPException(403, "Only HR can update the final settlement.")
    try:
        rules.set_settlement(db, case, body.status, me(user), user.id, client_ip(request))
    except rules.ExitError as exc:
        raise _err(exc) from exc
    db.commit()
    return _out(db, user, case)
