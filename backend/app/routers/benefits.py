"""Benefits: plans, eligibility, enrollment windows and life events, enrollments, dependents and cover, nominees.

Rules: app/services/benefits.py. Changes to elections and cover are blocked outside a window (409, with the reason).
"""

from __future__ import annotations

import uuid
from datetime import date
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import delete, select

from app.db import utcnow
from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import (
    Beneficiary,
    BenefitDependent,
    BenefitDependentCoverage,
    BenefitEnrollment,
    BenefitPlan,
    BenefitWindow,
    Country,
    Employee,
    LifeEvent,
)
from app.schemas.benefits import (
    BenefitEnrollDecisionIn,
    BenefitEnrollIn,
    BenefitEnrollmentOut,
    BenefitPlanIn,
    BenefitPlanOut,
    BenefitPlanPatch,
    BenefitWindowIn,
    BenefitWindowOut,
    BenefitWindowPatch,
    ChangeWindowOut,
    CoverageIn,
    DependentIn,
    DependentOut,
    DependentVerifyIn,
    EligibilityCheckOut,
    LifeEventIn,
    LifeEventOut,
    NominationIn,
    NomineeOut,
)
from app.services import approvals as engine
from app.services import benefits as rules
from app.services.activity import notify, record_audit
from app.services.decisions import NOT_FOUND, me, target
from app.services.leave import today_for
from app.services.pii import mask_dob

router = APIRouter(prefix="/benefits", tags=["benefits"])


def _today(user: CurrentUser) -> date:
    return today_for(user.employee) if user.employee else date.today()


def _new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def _require_hr(user: CurrentUser, what: str) -> None:
    if not rules.is_benefits_hr(user):
        raise HTTPException(403, f"Only HR can {what}.")


def _alert_hr(db: DbSession, emp: Employee, title: str, body: str, href: str) -> None:
    for hr_id in engine.resolve_group(db, "hr", emp):
        notify(db, recipient_id=hr_id, title=title, body=body, href=href)


def _rule_error(exc: rules.BenefitError) -> HTTPException:
    return HTTPException(409 if isinstance(exc, rules.BenefitConflict) else 422, str(exc))


# ---------- plans & eligibility ----------
def _plan_out(plan: BenefitPlan) -> BenefitPlanOut:
    out = BenefitPlanOut.model_validate(plan)
    out.rules = rules.eligibility_rules(plan)
    return out


@router.get("/plans", response_model=list[BenefitPlanOut])
def list_plans(db: DbSession, user: CurrentUserDep, country: Annotated[str | None, Query(pattern=r"^[A-Z]{2}$")] = None,
               include_inactive: bool = False) -> list[BenefitPlanOut]:
    """Your country's plans; HR may ask for any country."""
    code = country if country and rules.is_benefits_hr(user) else me(user).country_code
    stmt = select(BenefitPlan).where(BenefitPlan.country_code == code)
    if not include_inactive:
        stmt = stmt.where(BenefitPlan.active.is_(True))
    return [_plan_out(p) for p in db.scalars(stmt.order_by(BenefitPlan.plan_type, BenefitPlan.name))]


@router.post("/plans", response_model=BenefitPlanOut, status_code=status.HTTP_201_CREATED)
def create_plan(body: BenefitPlanIn, request: Request, db: DbSession, user: CurrentUserDep) -> BenefitPlanOut:
    _require_hr(user, "set up benefit plans")
    country = db.get(Country, body.country_code)
    if country is None:
        raise HTTPException(422, "Unknown country.")
    plan_id = body.id or f"bp-{body.country_code.lower()}-{uuid.uuid4().hex[:6]}"
    if db.get(BenefitPlan, plan_id) is not None:
        raise HTTPException(409, "A plan with this id already exists.")
    plan = BenefitPlan(id=plan_id, country_code=country.code, name=body.name.strip(), plan_type=body.plan_type,
                       provider=body.provider.strip(), summary=body.summary.strip(), employee_cost=body.employee_cost.strip(),
                       employer_annual_cost=body.employer_annual_cost, currency=country.currency,
                       covers_dependents=body.covers_dependents, mandatory=body.mandatory, auto_enrolled=body.auto_enrolled,
                       eligibility=body.eligibility.model_dump(), active=True)
    db.add(plan)
    record_audit(db, actor_id=user.id, action="benefit_plan_created", entity="benefit_plan", entity_id=plan.id,
                 after=body.model_dump() | {"id": plan.id}, ip=client_ip(request))
    db.commit()
    return _plan_out(plan)


@router.patch("/plans/{plan_id}", response_model=BenefitPlanOut)
def update_plan(plan_id: str, body: BenefitPlanPatch, request: Request, db: DbSession, user: CurrentUserDep) -> BenefitPlanOut:
    _require_hr(user, "change benefit plans")
    plan = db.get(BenefitPlan, plan_id)
    if plan is None:
        raise NOT_FOUND
    changes = body.model_dump(exclude_unset=True)
    if not changes:
        raise HTTPException(422, "Nothing changed.")
    before = {k: getattr(plan, k) for k in changes}
    for key, value in changes.items():
        setattr(plan, key, value.strip() if isinstance(value, str) else value)
    record_audit(db, actor_id=user.id, action="benefit_plan_updated", entity="benefit_plan", entity_id=plan.id,
                 before=before, after=changes, ip=client_ip(request))
    db.commit()
    return _plan_out(plan)


@router.get("/plans/{plan_id}/eligibility", response_model=EligibilityCheckOut)
def check_eligibility(plan_id: str, db: DbSession, user: CurrentUserDep, employee_id: str | None = None) -> EligibilityCheckOut:
    """Can this person join the plan, and can they make changes today?"""
    emp = target(db, user, employee_id)
    if emp.id != user.employee_id and not rules.is_benefits_hr(user):
        raise HTTPException(403, "Only HR can check eligibility for someone else.")
    plan = db.get(BenefitPlan, plan_id)
    if plan is None:
        raise NOT_FOUND
    today = today_for(emp)
    ok, reason = rules.check_eligibility(plan, emp, today)
    if ok and plan.mandatory:
        reason = "Statutory plan: everyone eligible is enrolled automatically."
    window = rules.change_window(db, emp, today)
    return EligibilityCheckOut(plan_id=plan.id, employee_id=emp.id, eligible=ok, reason=reason,
                               rules=rules.eligibility_rules(plan), window_open=window.open, window_text=window.text)


# ---------- windows & life events ----------
@router.get("/windows", response_model=list[BenefitWindowOut])
def list_windows(db: DbSession, user: CurrentUserDep) -> list[BenefitWindowOut]:
    today = _today(user)
    stmt = select(BenefitWindow).order_by(BenefitWindow.start_date.desc())
    if not rules.is_benefits_hr(user):
        return [_window_out(w, today) for w in rules.windows_for(db, me(user).country_code)]
    return [_window_out(w, today) for w in db.scalars(stmt)]


def _window_out(win: BenefitWindow, today: date) -> BenefitWindowOut:
    out = BenefitWindowOut.model_validate(win)
    out.is_open = rules.window_is_open(win, today)
    return out


@router.post("/windows", response_model=BenefitWindowOut, status_code=status.HTTP_201_CREATED)
def create_window(body: BenefitWindowIn, request: Request, db: DbSession, user: CurrentUserDep) -> BenefitWindowOut:
    _require_hr(user, "change the enrollment window")
    if body.end_date < body.start_date:
        raise HTTPException(422, "The end date must be after the start date.")
    if body.country_code and db.get(Country, body.country_code) is None:
        raise HTTPException(422, "Unknown country.")
    win = BenefitWindow(id=_new_id("bw"), name=body.name.strip(), country_code=body.country_code, start_date=body.start_date,
                        end_date=body.end_date, override=None, updated_by=user.id)
    db.add(win)
    record_audit(db, actor_id=user.id, action="benefit_window_created", entity="benefit_window", entity_id=win.id,
                 after=body.model_dump(), ip=client_ip(request))
    db.commit()
    return _window_out(win, _today(user))


@router.patch("/windows/{window_id}", response_model=BenefitWindowOut)
def update_window(window_id: str, body: BenefitWindowPatch, request: Request, db: DbSession, user: CurrentUserDep) -> BenefitWindowOut:
    """Change the dates, or open / close the window now ("dates" goes back to the dates)."""
    _require_hr(user, "open or close enrollment")
    win = db.get(BenefitWindow, window_id)
    if win is None:
        raise NOT_FOUND
    before = {"start_date": win.start_date, "end_date": win.end_date, "override": win.override}
    start, end = body.start_date or win.start_date, body.end_date or win.end_date
    if end < start:
        raise HTTPException(422, "The end date must be after the start date.")
    win.start_date, win.end_date = start, end
    if body.override is not None:
        win.override = None if body.override == "dates" else body.override
    win.updated_by = user.id
    record_audit(db, actor_id=user.id, action="benefit_window_updated", entity="benefit_window", entity_id=win.id, before=before,
                 after={"start_date": win.start_date, "end_date": win.end_date, "override": win.override}, ip=client_ip(request))
    db.commit()
    return _window_out(win, _today(user))


@router.get("/change-window", response_model=ChangeWindowOut)
def my_change_window(db: DbSession, user: CurrentUserDep) -> ChangeWindowOut:
    emp = me(user)
    w = rules.change_window(db, emp, today_for(emp))
    return ChangeWindowOut(open=w.open, text=w.text, window_id=w.window_id, life_event_id=w.life_event_id, until=w.until)


@router.get("/life-events", response_model=list[LifeEventOut])
def list_life_events(db: DbSession, user: CurrentUserDep, employee_id: str | None = None) -> list[LifeEvent]:
    emp = target(db, user, employee_id)
    if emp.id != user.employee_id and not rules.is_benefits_hr(user):
        raise HTTPException(403, "Only HR can see someone else's life events.")
    return list(db.scalars(select(LifeEvent).where(LifeEvent.employee_id == emp.id).order_by(LifeEvent.event_date.desc())))


@router.post("/life-events", response_model=LifeEventOut, status_code=status.HTTP_201_CREATED)
def report_life_event(body: LifeEventIn, request: Request, db: DbSession, user: CurrentUserDep) -> LifeEvent:
    """Opens a 30-day window (from the event date) to change benefits outside open enrollment."""
    emp = me(user)
    today = today_for(emp)
    if body.event_date > today:
        raise HTTPException(422, "The event date can't be in the future.")
    ends = rules.life_event_window_end(body.event_date)
    if ends < today:
        raise HTTPException(422, f"Life events must be reported within {rules.LIFE_EVENT_WINDOW_DAYS} days.")
    if db.scalar(select(LifeEvent.id).where(LifeEvent.employee_id == emp.id, LifeEvent.event_type == body.event_type,
                                            LifeEvent.event_date == body.event_date)):
        raise HTTPException(409, "You have already reported this event.")
    event = LifeEvent(id=_new_id("le"), employee_id=emp.id, event_type=body.event_type, event_date=body.event_date,
                      window_ends=ends, status="open")
    db.add(event)
    record_audit(db, actor_id=user.id, action="life_event_reported", entity="benefit_life_event", entity_id=event.id,
                 subject_id=emp.id, after={"type": event.event_type, "event_date": event.event_date, "window_ends": ends},
                 ip=client_ip(request))
    _alert_hr(db, emp, f"Life event: {emp.full_name}",
              f"{event.event_type} on {event.event_date}. Benefit changes open until {ends}.", "/benefits")
    db.commit()
    return event


@router.post("/life-events/{event_id}/close", response_model=LifeEventOut)
def close_life_event(event_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> LifeEvent:
    event = db.get(LifeEvent, event_id)
    emp = db.get(Employee, event.employee_id) if event else None
    if event is None or emp is None:
        raise NOT_FOUND
    if not rules.can_decide_for(db, user, emp):
        raise HTTPException(403, "Only HR can close a life event window.")
    if event.status != "open":
        raise HTTPException(409, "This window is already closed.")
    event.status, event.closed_by = "closed", user.id
    record_audit(db, actor_id=user.id, action="life_event_closed", entity="benefit_life_event", entity_id=event.id,
                 subject_id=emp.id, before={"status": "open"}, after={"status": "closed"}, ip=client_ip(request))
    db.commit()
    return event


# ---------- dependents ----------
def _covered(db: DbSession, dependent_ids: list[str]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    if not dependent_ids:
        return out
    for dep_id, plan_id in db.execute(
        select(BenefitDependentCoverage.dependent_id, BenefitEnrollment.plan_id)
        .join(BenefitEnrollment, BenefitEnrollment.id == BenefitDependentCoverage.enrollment_id)
        .where(BenefitDependentCoverage.dependent_id.in_(dependent_ids))
    ).all():
        out.setdefault(dep_id, []).append(plan_id)
    return out


def _dependent_outs(db: DbSession, user: CurrentUser, rows: list[BenefitDependent]) -> list[DependentOut]:
    """Date of birth is masked (year only) for anyone but the employee who added the dependent."""
    covered = _covered(db, [d.id for d in rows])
    outs = []
    for d in rows:
        item = DependentOut.model_validate(d)
        item.covered_plan_ids = sorted(covered.get(d.id, []))
        if d.employee_id != user.employee_id:
            item.date_of_birth = mask_dob(d.date_of_birth) or ""
        outs.append(item)
    return outs


@router.get("/dependents", response_model=list[DependentOut])
def list_dependents(db: DbSession, user: CurrentUserDep, employee_id: str | None = None,
                    verification: Annotated[str | None, Query(pattern="^(pending|verified|rejected)$")] = None) -> list[DependentOut]:
    """Yours, or (HR) someone's in your scope; HR may pass verification=pending without employee_id for the queue."""
    stmt = select(BenefitDependent)
    if employee_id is None and verification and rules.is_benefits_hr(user):
        stmt = stmt.join(Employee, Employee.id == BenefitDependent.employee_id).where(
            user.scope.employee_filter(), BenefitDependent.employee_id != (user.employee_id or ""))
    else:
        emp = target(db, user, employee_id)
        if emp.id != user.employee_id and not rules.is_benefits_hr(user):
            raise HTTPException(403, "Only HR can see someone else's dependents.")
        stmt = stmt.where(BenefitDependent.employee_id == emp.id)
    if verification:
        stmt = stmt.where(BenefitDependent.verification == verification)
    return _dependent_outs(db, user, list(db.scalars(stmt.order_by(BenefitDependent.created_at))))


@router.post("/dependents", response_model=DependentOut, status_code=status.HTTP_201_CREATED)
def add_dependent(body: DependentIn, request: Request, db: DbSession, user: CurrentUserDep) -> DependentOut:
    emp = me(user)
    if body.date_of_birth > today_for(emp):
        raise HTTPException(422, "Date of birth can't be in the future.")
    name = body.name.strip()
    existing = db.scalars(select(BenefitDependent.name).where(BenefitDependent.employee_id == emp.id)).all()
    if any(n.lower() == name.lower() for n in existing):
        raise HTTPException(409, f"{name} is already on file.")
    dep = BenefitDependent(id=_new_id("dep"), employee_id=emp.id, name=name, relationship=body.relationship,
                           date_of_birth=body.date_of_birth, gender=(body.gender or "").strip() or None, verification="pending")
    db.add(dep)
    record_audit(db, actor_id=user.id, action="dependent_added", entity="benefit_dependent", entity_id=dep.id, subject_id=emp.id,
                 after={"name": name, "relationship": dep.relationship, "date_of_birth": dep.date_of_birth}, ip=client_ip(request))
    _alert_hr(db, emp, f"Verify dependent: {emp.full_name}", f"{name} ({dep.relationship}) was added.", "/benefits")
    db.commit()
    return _dependent_outs(db, user, [dep])[0]


def _own_dependent(db: DbSession, user: CurrentUser, dependent_id: str) -> BenefitDependent:
    dep = db.get(BenefitDependent, dependent_id)
    if dep is None or dep.employee_id != user.employee_id:
        raise NOT_FOUND
    return dep


@router.put("/dependents/{dependent_id}", response_model=DependentOut)
def update_dependent(dependent_id: str, body: DependentIn, request: Request, db: DbSession, user: CurrentUserDep) -> DependentOut:
    """Changing the name, relationship or date of birth sends the dependent back to HR for verification."""
    dep = _own_dependent(db, user, dependent_id)
    if body.date_of_birth > today_for(me(user)):
        raise HTTPException(422, "Date of birth can't be in the future.")
    before = {"name": dep.name, "relationship": dep.relationship, "date_of_birth": dep.date_of_birth, "gender": dep.gender}
    after = {"name": body.name.strip(), "relationship": body.relationship, "date_of_birth": body.date_of_birth,
             "gender": (body.gender or "").strip() or None}
    if before == after:
        raise HTTPException(422, "Nothing changed.")
    key_change = any(before[k] != after[k] for k in ("name", "relationship", "date_of_birth"))
    for k, v in after.items():
        setattr(dep, k, v)
    if key_change:
        dep.verification, dep.verified_by, dep.verified_at = "pending", None, None
        _alert_hr(db, me(user), f"Verify dependent: {me(user).full_name}", f"{dep.name} was edited.", "/benefits")
    record_audit(db, actor_id=user.id, action="dependent_updated", entity="benefit_dependent", entity_id=dep.id,
                 subject_id=dep.employee_id, before=before, after=after | {"verification": dep.verification}, ip=client_ip(request))
    db.commit()
    return _dependent_outs(db, user, [dep])[0]


@router.delete("/dependents/{dependent_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_dependent(dependent_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> None:
    dep = _own_dependent(db, user, dependent_id)
    covered = _covered(db, [dep.id]).get(dep.id)
    if covered:
        raise HTTPException(409, f"{dep.name} is covered under {', '.join(covered)}. Remove them from cover first.")
    record_audit(db, actor_id=user.id, action="dependent_removed", entity="benefit_dependent", entity_id=dep.id,
                 subject_id=dep.employee_id, before={"name": dep.name, "relationship": dep.relationship}, ip=client_ip(request))
    db.delete(dep)
    db.commit()


@router.post("/dependents/{dependent_id}/verification", response_model=DependentOut)
def verify_dependent(dependent_id: str, body: DependentVerifyIn, request: Request, db: DbSession, user: CurrentUserDep) -> DependentOut:
    dep = db.get(BenefitDependent, dependent_id)
    emp = db.get(Employee, dep.employee_id) if dep else None
    if dep is None or emp is None:
        raise NOT_FOUND
    if not rules.can_decide_for(db, user, emp):
        raise HTTPException(403, "Only HR can verify dependents (HR's own go to their line manager).")
    if dep.verification == body.status:
        raise HTTPException(409, f"Already {body.status}.")
    if body.status == "rejected" and _covered(db, [dep.id]).get(dep.id):
        raise HTTPException(409, f"{dep.name} is covered under a plan. Remove cover first.")
    before = dep.verification
    dep.verification, dep.verified_by, dep.verified_at = body.status, user.employee_id or user.id, utcnow()
    record_audit(db, actor_id=user.id, action=f"dependent_{body.status}", entity="benefit_dependent", entity_id=dep.id,
                 subject_id=emp.id, before={"verification": before}, after={"verification": body.status, "note": body.note},
                 ip=client_ip(request))
    notify(db, recipient_id=emp.id, title=f"Dependent {body.status}", body=f"{dep.name} was {body.status}.", href="/benefits")
    db.commit()
    return _dependent_outs(db, user, [dep])[0]


# ---------- enrollments & cover ----------
def _enrollment_outs(db: DbSession, rows: list[BenefitEnrollment]) -> list[BenefitEnrollmentOut]:
    if not rows:
        return []
    names = dict(db.execute(select(Employee.id, Employee.full_name).where(Employee.id.in_({r.employee_id for r in rows}))).all())
    plans = dict(db.execute(select(BenefitPlan.id, BenefitPlan.name).where(BenefitPlan.id.in_({r.plan_id for r in rows}))).all())
    cover: dict[str, list[str]] = {}
    for enr_id, dep_id in db.execute(select(BenefitDependentCoverage.enrollment_id, BenefitDependentCoverage.dependent_id)
                                     .where(BenefitDependentCoverage.enrollment_id.in_([r.id for r in rows]))).all():
        cover.setdefault(enr_id, []).append(dep_id)
    out = []
    for r in rows:
        item = BenefitEnrollmentOut.model_validate(r)
        item.employee_name, item.plan_name = names.get(r.employee_id), plans.get(r.plan_id)
        item.dependent_ids = sorted(cover.get(r.id, []))
        out.append(item)
    return out


@router.get("/enrollments", response_model=list[BenefitEnrollmentOut])
def list_enrollments(
    db: DbSession, user: CurrentUserDep,
    view: Annotated[str, Query(pattern="^(mine|to_decide|all)$")] = "mine",
    employee_id: str | None = None,
) -> list[BenefitEnrollmentOut]:
    stmt = select(BenefitEnrollment).join(Employee, Employee.id == BenefitEnrollment.employee_id)
    if view == "mine":
        stmt = stmt.where(BenefitEnrollment.employee_id == (user.employee_id or ""))
    else:
        if not rules.is_benefits_hr(user) and view == "all":
            raise HTTPException(403, "Only HR can list everyone's enrollments.")
        if view == "to_decide":
            stmt = stmt.where(BenefitEnrollment.status == "requested")
        stmt = stmt.where(BenefitEnrollment.employee_id != (user.employee_id or ""))
        rows = [r for r in db.scalars(stmt.order_by(BenefitEnrollment.created_at))
                if (employee_id is None or r.employee_id == employee_id)
                and rules.can_decide_for(db, user, db.get(Employee, r.employee_id))]  # type: ignore[arg-type]
        return _enrollment_outs(db, rows)
    return _enrollment_outs(db, list(db.scalars(stmt.order_by(BenefitEnrollment.created_at))))


def _set_cover(db: DbSession, enrollment: BenefitEnrollment, emp: Employee, plan: BenefitPlan, dependent_ids: list[str],
               only_check_new: bool) -> tuple[list[str], list[str]]:
    wanted = list(dict.fromkeys(dependent_ids))
    if wanted and not plan.covers_dependents:
        raise rules.BenefitError("This plan doesn't cover dependents.")
    deps = {d.id: d for d in db.scalars(select(BenefitDependent).where(BenefitDependent.employee_id == emp.id))}
    current = set(db.scalars(select(BenefitDependentCoverage.dependent_id).where(
        BenefitDependentCoverage.enrollment_id == enrollment.id)))
    for dep_id in wanted:
        dep = deps.get(dep_id)
        if dep is None:
            raise rules.BenefitError("Choose your own dependents.")
        if dep.verification != "verified" and (dep_id not in current or not only_check_new):
            raise rules.BenefitError(f"{dep.name} must be verified by HR before they can be covered.")
    added = [d for d in wanted if d not in current]
    removed = [d for d in current if d not in wanted]
    for d in added:
        db.add(BenefitDependentCoverage(enrollment_id=enrollment.id, dependent_id=d))
    if removed:
        db.execute(delete(BenefitDependentCoverage).where(BenefitDependentCoverage.enrollment_id == enrollment.id,
                                                          BenefitDependentCoverage.dependent_id.in_(removed)))
    return added, removed


@router.post("/enrollments", response_model=BenefitEnrollmentOut, status_code=status.HTTP_201_CREATED)
def request_enrollment(body: BenefitEnrollIn, request: Request, db: DbSession, user: CurrentUserDep) -> BenefitEnrollmentOut:
    """Ask to join a plan in your country. Only inside open enrollment or a life-event window; HR decides."""
    emp = me(user)
    plan = db.get(BenefitPlan, body.plan_id)
    if plan is None or not plan.active:
        raise HTTPException(422, "Plan not found.")
    if plan.country_code != emp.country_code:
        raise HTTPException(422, "You can only enroll in plans for your own country.")
    if plan.mandatory:
        raise HTTPException(409, "You are enrolled in this plan automatically.")
    today = today_for(emp)
    ok, reason = rules.check_eligibility(plan, emp, today)
    if not ok:
        raise HTTPException(422, f"Not eligible: {reason}.")
    try:
        window = rules.require_window(db, emp, today)
    except rules.BenefitError as exc:
        raise _rule_error(exc) from exc
    row = db.scalar(select(BenefitEnrollment).where(BenefitEnrollment.employee_id == emp.id, BenefitEnrollment.plan_id == plan.id))
    if row is not None and row.status == "requested":
        raise HTTPException(409, "A request for this plan is already pending.")
    if row is not None and row.status == "approved":
        raise HTTPException(409, "You are already enrolled in this plan.")
    if row is None:
        row = BenefitEnrollment(id=_new_id("be"), employee_id=emp.id, plan_id=plan.id, status="requested")
        db.add(row)
    row.status, row.effective_date, row.life_event_id = "requested", None, window.life_event_id
    row.decided_by, row.decided_at, row.note = None, None, None
    db.flush()
    try:
        _set_cover(db, row, emp, plan, body.dependent_ids, only_check_new=False)
    except rules.BenefitError as exc:
        db.rollback()
        raise _rule_error(exc) from exc
    record_audit(db, actor_id=user.id, action="benefit_enrollment_requested", entity="benefit_enrollment", entity_id=row.id,
                 subject_id=emp.id, after={"plan_id": plan.id, "life_event_id": row.life_event_id,
                                           "dependents": body.dependent_ids}, ip=client_ip(request))
    _alert_hr(db, emp, f"Benefit enrollment: {emp.full_name}", f"Requested {plan.name}.", "/benefits")
    db.commit()
    return _enrollment_outs(db, [row])[0]


@router.post("/enrollments/{enrollment_id}/decision", response_model=BenefitEnrollmentOut)
def decide_enrollment(enrollment_id: str, body: BenefitEnrollDecisionIn, request: Request, db: DbSession,
                      user: CurrentUserDep) -> BenefitEnrollmentOut:
    row = db.get(BenefitEnrollment, enrollment_id)
    emp = db.get(Employee, row.employee_id) if row else None
    if row is None or emp is None:
        raise NOT_FOUND
    if emp.id == user.employee_id:
        raise HTTPException(403, "Someone else must decide your own request.")
    if not rules.can_decide_for(db, user, emp):
        raise HTTPException(403, "Only HR can decide enrollment requests (HR's own go to their line manager).")
    if row.status != "requested":
        raise HTTPException(409, "Only requested enrollments can be decided.")
    plan = db.get(BenefitPlan, row.plan_id)
    assert plan is not None
    if body.decision == "waive" and plan.mandatory:
        raise HTTPException(409, "Statutory plans cannot be waived.")
    row.status = "approved" if body.decision == "approve" else "waived"
    row.effective_date = today_for(emp) if row.status == "approved" else None
    row.decided_by, row.decided_at, row.note = user.employee_id or user.id, utcnow(), (body.note or "").strip() or None
    if row.status == "waived":
        db.execute(delete(BenefitDependentCoverage).where(BenefitDependentCoverage.enrollment_id == row.id))
    record_audit(db, actor_id=user.id, action=f"benefit_enrollment_{row.status}", entity="benefit_enrollment", entity_id=row.id,
                 subject_id=emp.id, before={"status": "requested"}, after={"status": row.status, "note": row.note},
                 ip=client_ip(request))
    notify(db, recipient_id=emp.id, title=f"Benefit enrollment {row.status}", body=f"{plan.name}: {row.status}.", href="/benefits")
    db.commit()
    return _enrollment_outs(db, [row])[0]


@router.put("/enrollments/{enrollment_id}/dependents", response_model=BenefitEnrollmentOut)
def set_coverage(enrollment_id: str, body: CoverageIn, request: Request, db: DbSession, user: CurrentUserDep) -> BenefitEnrollmentOut:
    """Which of your verified dependents the plan covers. Only inside a change window."""
    row = db.get(BenefitEnrollment, enrollment_id)
    if row is None or row.employee_id != user.employee_id:
        raise NOT_FOUND
    emp = me(user)
    plan = db.get(BenefitPlan, row.plan_id)
    assert plan is not None
    if not plan.covers_dependents:
        raise HTTPException(422, "This plan doesn't cover dependents.")
    if row.status not in ("requested", "approved"):
        raise HTTPException(409, "Join the plan first.")
    try:
        rules.require_window(db, emp, today_for(emp))
        added, removed = _set_cover(db, row, emp, plan, body.dependent_ids, only_check_new=True)
    except rules.BenefitError as exc:
        db.rollback()
        raise _rule_error(exc) from exc
    if not added and not removed:
        db.rollback()
        raise HTTPException(422, "Nothing changed.")
    record_audit(db, actor_id=user.id, action="benefit_cover_changed", entity="benefit_enrollment", entity_id=row.id,
                 subject_id=emp.id, after={"added": added, "removed": removed}, ip=client_ip(request))
    db.commit()
    return _enrollment_outs(db, [row])[0]


# ---------- nominees ----------
@router.get("/beneficiaries", response_model=list[NomineeOut])
def list_nominees(db: DbSession, user: CurrentUserDep, employee_id: str | None = None,
                  nomination_for: str | None = None) -> list[NomineeOut]:
    emp = target(db, user, employee_id)
    if emp.id != user.employee_id and not rules.is_benefits_hr(user):
        raise HTTPException(403, "Only HR can see someone else's nominees.")
    stmt = select(Beneficiary).where(Beneficiary.employee_id == emp.id)
    if nomination_for:
        stmt = stmt.where(Beneficiary.nomination_for == nomination_for)
    rows = [NomineeOut.model_validate(b) for b in db.scalars(stmt.order_by(Beneficiary.nomination_for, Beneficiary.id))]
    if emp.id != user.employee_id:  # HR sees the year only
        for r in rows:
            r.date_of_birth = mask_dob(r.date_of_birth)
    return rows


@router.put("/beneficiaries", response_model=list[NomineeOut])
def set_nominees(body: NominationIn, request: Request, db: DbSession, user: CurrentUserDep) -> list[Beneficiary]:
    """Replaces your nominees for one nomination (e.g. "Provident Fund"). Shares must total exactly 100%."""
    emp = me(user)
    purpose = body.nomination_for.strip()
    names = [n.name.strip().lower() for n in body.nominees]
    if len(set(names)) != len(names):
        raise HTTPException(422, "Each nominee can be listed only once.")
    total = round(sum(n.share_pct for n in body.nominees), 2)
    if body.nominees and abs(total - 100) > 0.001:
        raise HTTPException(422, f"Nominee shares must total 100% (now {total:g}%).")
    old = list(db.scalars(select(Beneficiary).where(Beneficiary.employee_id == emp.id, Beneficiary.nomination_for == purpose)))
    before = [{"name": b.name, "share_pct": b.share_pct} for b in old]
    for b in old:
        db.delete(b)
    db.flush()
    rows = [Beneficiary(employee_id=emp.id, nomination_for=purpose, name=n.name.strip(), relationship=n.relationship.strip(),
                        share_pct=round(n.share_pct, 2), date_of_birth=n.date_of_birth) for n in body.nominees]
    db.add_all(rows)
    record_audit(db, actor_id=user.id, action="nominees_updated", entity="benefit_beneficiary", entity_id=f"{emp.id}:{purpose}"[:64],
                 subject_id=emp.id, before={"nominees": before},
                 after={"nominees": [{"name": r.name, "share_pct": r.share_pct} for r in rows]}, ip=client_ip(request))
    db.commit()
    return rows
