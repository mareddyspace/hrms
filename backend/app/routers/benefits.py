"""Benefits: plans, eligibility, enrollment windows and life events, enrollments, dependents and cover, nominees.

Rules: app/services/benefits.py. Changes to elections and cover are blocked outside a window (409, with the reason).
"""

from __future__ import annotations

import uuid
from datetime import date, timedelta
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import Response
from sqlalchemy import delete, select

from app.db import utcnow
from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import (
    Account,
    AuditLog,
    Beneficiary,
    BenefitPlanDocument,
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
from app.services import storage
from app.services.uploads import UPLOAD_OPENAPI, clean_name, read_upload

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
def _plan_out(plan: BenefitPlan, docs: list[BenefitPlanDocument] | None = None) -> BenefitPlanOut:
    out = BenefitPlanOut.model_validate(plan)
    out.rules = rules.eligibility_rules(plan)
    out.documents = [{"id": d.id, "title": d.title, "file_name": d.file_name, "content_type": d.content_type,
                      "size_bytes": d.size_bytes} for d in docs or []]
    return out


def _plan_docs(db: DbSession, plan_ids: list[str]) -> dict[str, list[BenefitPlanDocument]]:
    out: dict[str, list[BenefitPlanDocument]] = {}
    if plan_ids:
        for d in db.scalars(select(BenefitPlanDocument).where(BenefitPlanDocument.plan_id.in_(plan_ids)).order_by(BenefitPlanDocument.title)):
            out.setdefault(d.plan_id, []).append(d)
    return out


@router.get("/plans", response_model=list[BenefitPlanOut])
def list_plans(db: DbSession, user: CurrentUserDep, country: Annotated[str | None, Query(pattern=r"^[A-Z]{2}$")] = None,
               include_inactive: bool = False) -> list[BenefitPlanOut]:
    """Your country's plans by default; anyone may browse another country's plans (plans hold no personal data).
    Inactive plans are for HR only."""
    code = country or me(user).country_code
    stmt = select(BenefitPlan).where(BenefitPlan.country_code == code)
    if not include_inactive or not rules.is_benefits_hr(user):
        stmt = stmt.where(BenefitPlan.active.is_(True))
    plans = list(db.scalars(stmt.order_by(BenefitPlan.plan_type, BenefitPlan.name)))
    docs = _plan_docs(db, [p.id for p in plans])
    return [_plan_out(p, docs.get(p.id)) for p in plans]


@router.get("/plan-countries")
def plan_countries(db: DbSession, user: CurrentUserDep) -> list[dict[str, object]]:
    """Countries (and legal entities) that have active plans, for the country picker; yours first."""
    own = me(user).country_code
    names = {c.code: c.name for c in db.scalars(select(Country))}
    rows: dict[str, set[str]] = {}
    for code, entity in db.execute(select(BenefitPlan.country_code, BenefitPlan.legal_entity).where(BenefitPlan.active.is_(True))).all():
        rows.setdefault(code, set())
        if entity:
            rows[code].add(entity)
    for code, entity in db.execute(select(Employee.country_code, Employee.legal_entity).where(Employee.legal_entity.is_not(None))
                                   .group_by(Employee.country_code, Employee.legal_entity)).all():
        if code in rows and entity:
            rows[code].add(entity)
    out = [{"code": c, "name": names.get(c, c), "own": c == own, "legal_entities": sorted(rows[c])} for c in rows]
    return sorted(out, key=lambda r: (not r["own"], str(r["name"])))


@router.get("/plans/{plan_id}/summary.pdf")
def plan_summary_pdf(plan_id: str, db: DbSession, user: CurrentUserDep) -> Response:
    from app.services.payslip_pdf import plan_pdf

    plan = db.get(BenefitPlan, plan_id)
    if plan is None or (not plan.active and not rules.is_benefits_hr(user)):
        raise NOT_FOUND
    country = db.get(Country, plan.country_code)
    data = plan_pdf(plan=plan, eligibility=rules.eligibility_rules(plan), country_name=country.name if country else plan.country_code)
    name = f"{plan.name.replace(' ', '-').replace('/', '-')}-summary.pdf"
    return Response(data, media_type="application/pdf", headers={"Content-Disposition": f'attachment; filename="{name}"',
                                                                 "Cache-Control": "private, no-store"})


@router.post("/plans/{plan_id}/documents", response_model=BenefitPlanOut, status_code=status.HTTP_201_CREATED,
             openapi_extra=UPLOAD_OPENAPI)
async def upload_plan_document(plan_id: str, request: Request, db: DbSession, user: CurrentUserDep,
                               title: Annotated[str, Query(min_length=2, max_length=200)],
                               filename: Annotated[str | None, Query(max_length=255)] = None) -> BenefitPlanOut:
    _require_hr(user, "add plan documents")
    plan = db.get(BenefitPlan, plan_id)
    if plan is None:
        raise NOT_FOUND
    data, content_type, sha = await read_upload(request)
    doc_id = _new_id("bpd")
    stored = storage.save(f"benefits/plans/{plan.id}", doc_id, data, content_type, sha)
    db.add(BenefitPlanDocument(id=doc_id, plan_id=plan.id, title=title.strip(), file_name=clean_name(filename, content_type, "policy"),
                               content_type=stored.content_type, size_bytes=stored.size_bytes, sha256=stored.sha256,
                               storage_path=stored.relative_path, uploaded_by=user.employee_id, uploaded_at=utcnow()))
    record_audit(db, actor_id=user.id, action="benefit_plan_document_added", entity="benefit_plan", entity_id=plan.id,
                 after={"document_id": doc_id, "title": title.strip()}, ip=client_ip(request))
    try:
        db.commit()
    except Exception:
        storage.delete_quietly(stored.relative_path)
        raise
    return _plan_out(plan, _plan_docs(db, [plan.id]).get(plan.id))


@router.get("/plans/{plan_id}/documents/{doc_id}")
def download_plan_document(plan_id: str, doc_id: str, db: DbSession, user: CurrentUserDep) -> Response:
    doc = db.get(BenefitPlanDocument, doc_id)
    plan = db.get(BenefitPlan, plan_id)
    if doc is None or plan is None or doc.plan_id != plan.id or (not plan.active and not rules.is_benefits_hr(user)):
        raise NOT_FOUND
    try:
        return storage.download(doc.storage_path, media_type=doc.content_type, filename=doc.file_name)
    except storage.FileMissing as exc:
        raise HTTPException(410, "The file is no longer available.") from exc
    except storage.StorageError as exc:
        raise NOT_FOUND from exc


@router.delete("/plans/{plan_id}/documents/{doc_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_plan_document(plan_id: str, doc_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> None:
    _require_hr(user, "remove plan documents")
    doc = db.get(BenefitPlanDocument, doc_id)
    if doc is None or doc.plan_id != plan_id:
        raise NOT_FOUND
    path = doc.storage_path
    record_audit(db, actor_id=user.id, action="benefit_plan_document_removed", entity="benefit_plan", entity_id=plan_id,
                 before={"document_id": doc.id, "title": doc.title}, ip=client_ip(request))
    db.delete(doc)
    db.commit()
    storage.delete_quietly(path)


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
                       eligibility=body.eligibility.model_dump(), active=True, coverage=(body.coverage or "").strip() or None,
                       terms=(body.terms or "").strip() or None, legal_entity=(body.legal_entity or "").strip() or None)
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
    today = today_for(emp)
    w = rules.change_window(db, emp, today)
    if w.open and w.until and 0 <= (w.until - today).days <= 7:
        # One reminder per window: changes close within a week.
        from app.models import Notification

        title = f"Benefit enrollment closes on {w.until.isoformat()}"
        if not db.scalar(select(Notification.id).where(Notification.recipient_id == emp.id,
                                                       Notification.title.like("Benefit enrollment closes on%"),
                                                       Notification.created_at >= utcnow() - timedelta(days=8))):
            notify(db, recipient_id=emp.id, title=title, body="Review your plans and dependents before then.", href="/benefits")
            db.commit()
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
        owner = db.get(Employee, d.employee_id)
        item.cover_eligible, item.cover_note = rules.dependent_cover(d, today_for(owner) if owner else date.today())
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


@router.post("/dependents/{dependent_id}/document", response_model=DependentOut, openapi_extra=UPLOAD_OPENAPI)
async def upload_dependent_document(dependent_id: str, request: Request, db: DbSession, user: CurrentUserDep,
                                    filename: Annotated[str | None, Query(max_length=255)] = None) -> DependentOut:
    """Proof of relationship (birth or marriage certificate...). Replaces the previous file; a rejected dependent goes
    back to HR for verification."""
    dep = _own_dependent(db, user, dependent_id)
    data, content_type, sha = await read_upload(request)
    old = dep.doc_path
    stored = storage.save(f"benefits/dependents/{dep.employee_id}", _new_id("depdoc"), data, content_type, sha)
    dep.doc_name, dep.doc_type, dep.doc_size, dep.doc_path = (clean_name(filename, content_type, "proof"), stored.content_type,
                                                              stored.size_bytes, stored.relative_path)
    resend = dep.verification == "rejected"
    if resend:
        dep.verification, dep.verified_by, dep.verified_at = "pending", None, None
    record_audit(db, actor_id=user.id, action="dependent_document_added", entity="benefit_dependent", entity_id=dep.id,
                 subject_id=dep.employee_id, after={"file": dep.doc_name, "verification": dep.verification}, ip=client_ip(request))
    if resend or dep.verification == "pending":
        _alert_hr(db, me(user), f"Verify dependent: {me(user).full_name}", f"Proof added for {dep.name}.", "/benefits")
    try:
        db.commit()
    except Exception:
        storage.delete_quietly(stored.relative_path)
        raise
    if old:
        storage.delete_quietly(old)
    return _dependent_outs(db, user, [dep])[0]


@router.get("/dependents/{dependent_id}/document")
def download_dependent_document(dependent_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> Response:
    dep = db.get(BenefitDependent, dependent_id)
    emp = db.get(Employee, dep.employee_id) if dep else None
    if dep is None or emp is None or not dep.doc_path:
        raise NOT_FOUND
    if dep.employee_id != user.employee_id and not rules.can_decide_for(db, user, emp):
        raise NOT_FOUND
    try:
        response = storage.download(dep.doc_path, media_type=dep.doc_type or "application/octet-stream", filename=dep.doc_name)
    except storage.FileMissing as exc:
        raise HTTPException(410, "The file is no longer available.") from exc
    except storage.StorageError as exc:
        raise NOT_FOUND from exc
    if dep.employee_id != user.employee_id:
        record_audit(db, actor_id=user.id, action="dependent_document_viewed", entity="benefit_dependent", entity_id=dep.id,
                     subject_id=emp.id, after={"file": dep.doc_name}, ip=client_ip(request))
        db.commit()
    return response


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
        age_ok, age_note = rules.dependent_cover(dep, today_for(emp), check_verification=False)
        if not age_ok and dep_id not in current:
            raise rules.BenefitError(f"{dep.name} can't be covered: {age_note}")
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


@router.post("/enrollments/{enrollment_id}/cancel", response_model=BenefitEnrollmentOut)
def cancel_enrollment(enrollment_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> BenefitEnrollmentOut:
    """Withdraw a pending request (any time) or leave a plan (inside a change window). Statutory plans can't be left."""
    row = db.get(BenefitEnrollment, enrollment_id)
    if row is None or row.employee_id != user.employee_id:
        raise NOT_FOUND
    emp = me(user)
    plan = db.get(BenefitPlan, row.plan_id)
    assert plan is not None
    if row.status not in ("requested", "approved"):
        raise HTTPException(409, "Only a pending request or an active enrollment can be cancelled.")
    if plan.mandatory:
        raise HTTPException(409, "Statutory plans can't be cancelled.")
    before = row.status
    if row.status == "approved":
        try:
            rules.require_window(db, emp, today_for(emp))
        except rules.BenefitError as exc:
            raise _rule_error(exc) from exc
    row.status, row.effective_date = "cancelled", today_for(emp) if before == "approved" else None
    row.decided_by, row.decided_at, row.note = emp.id, utcnow(), "Cancelled by the employee"
    db.execute(delete(BenefitDependentCoverage).where(BenefitDependentCoverage.enrollment_id == row.id))
    record_audit(db, actor_id=user.id, action="benefit_enrollment_cancelled", entity="benefit_enrollment", entity_id=row.id,
                 subject_id=emp.id, before={"status": before}, after={"status": "cancelled", "plan_id": plan.id}, ip=client_ip(request))
    _alert_hr(db, emp, f"Benefit cancelled: {emp.full_name}",
              f"{plan.name}: {'request withdrawn' if before == 'requested' else 'enrollment cancelled'}.", "/benefits")
    db.commit()
    return _enrollment_outs(db, [row])[0]


HISTORY_TEXT = {
    "benefit_enrollment_requested": "Enrollment requested", "benefit_enrollment_approved": "Enrollment approved",
    "benefit_enrollment_waived": "Enrollment waived", "benefit_enrollment_cancelled": "Enrollment cancelled",
    "benefit_cover_changed": "Dependents covered changed", "dependent_added": "Dependent added",
    "dependent_updated": "Dependent edited", "dependent_removed": "Dependent removed", "dependent_verified": "Dependent verified",
    "dependent_rejected": "Dependent rejected", "dependent_document_added": "Dependent proof uploaded",
    "life_event_reported": "Life event reported", "life_event_closed": "Life event window closed",
    "nominees_updated": "Nominees updated",
}


@router.get("/history")
def benefit_history(db: DbSession, user: CurrentUserDep, employee_id: str | None = None) -> list[dict[str, object]]:
    """Enrollments, changes, cancellations, approvals and dependents, newest first (yours; HR: someone in scope)."""
    emp = target(db, user, employee_id)
    if emp.id != user.employee_id and not rules.is_benefits_hr(user):
        raise HTTPException(403, "Only HR can see someone else's benefit history.")
    rows = db.scalars(select(AuditLog).where(AuditLog.subject_id == emp.id, AuditLog.action.in_(list(HISTORY_TEXT)))
                      .order_by(AuditLog.at.desc(), AuditLog.id.desc()).limit(300)).all()
    plans = dict(db.execute(select(BenefitPlan.id, BenefitPlan.name)).all())
    enrol_plan = dict(db.execute(select(BenefitEnrollment.id, BenefitEnrollment.plan_id).where(BenefitEnrollment.employee_id == emp.id)).all())
    deps = dict(db.execute(select(BenefitDependent.id, BenefitDependent.name).where(BenefitDependent.employee_id == emp.id)).all())
    actors = {a.id: a.employee_id for a in db.scalars(select(Account).where(Account.id.in_({r.actor_id for r in rows if r.actor_id})))}
    names = dict(db.execute(select(Employee.id, Employee.full_name).where(Employee.id.in_({v for v in actors.values() if v} or {""}))).all())
    out = []
    for r in rows:
        after = (r.changes or {}).get("after") or {}
        before = (r.changes or {}).get("before") or {}
        detail = ""
        if r.entity == "benefit_enrollment":
            detail = plans.get(after.get("plan_id") or enrol_plan.get(r.entity_id or ""), "") or ""
            if after.get("note"):
                detail += f" · {after['note']}"
        elif r.entity == "benefit_dependent":
            detail = after.get("name") or before.get("name") or deps.get(r.entity_id or "", "")
        elif r.entity == "benefit_life_event":
            detail = str(after.get("type") or "")
        elif r.entity == "benefit_beneficiary":
            detail = (r.entity_id or "").split(":", 1)[-1]
        by = names.get(actors.get(r.actor_id or "") or "", "")
        out.append({"id": r.id, "date": r.at.date().isoformat(), "at": r.at.isoformat(), "event": HISTORY_TEXT.get(r.action, r.action),
                    "action": r.action, "detail": detail, "by": by, "by_self": actors.get(r.actor_id or "") == emp.id})
    # Enrollments made before the history was kept (automatic / statutory ones): show when they took effect.
    logged = {r.entity_id for r in rows if r.entity == "benefit_enrollment"}
    for e in db.scalars(select(BenefitEnrollment).where(BenefitEnrollment.employee_id == emp.id, BenefitEnrollment.status == "approved")):
        if e.id not in logged and e.effective_date:
            out.append({"id": f"enr-{e.id}", "date": e.effective_date.isoformat(), "at": f"{e.effective_date.isoformat()}T00:00:00",
                        "event": "Enrolled", "action": "benefit_enrollment_approved", "detail": plans.get(e.plan_id, e.plan_id),
                        "by": "", "by_self": False})
    return sorted(out, key=lambda x: str(x["at"]), reverse=True)


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
