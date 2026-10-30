"""Recruiting: requisitions (approval workflow), candidates and stage moves, CVs, interviews, offers, my activity.

Who sees what: HR (within their country scope) every requisition; a recruiter the ones assigned to them; the hiring
manager their own; approvers of a requisition's workflow while it is with them. Rules: app/services/recruiting.py.
"""

from __future__ import annotations

import re
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, date, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import FileResponse, Response
from sqlalchemy import func, select

from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import (
    ApprovalInstance,
    AuditLog,
    Candidate,
    CandidateStage,
    Country,
    Employee,
    Interview,
    JobPosting,
    Offer,
    Requisition,
)
from app.schemas.talent import (
    ActivityOut,
    CandidateIn,
    CandidateOut,
    CandidatePatch,
    CvParseIn,
    CvParseOut,
    FeedbackIn,
    InternalApplyIn,
    InterviewIn,
    InterviewOut,
    MatchOut,
    NoteIn,
    OfferIn,
    OfferOut,
    OfferStatusIn,
    PostingIn,
    PostingOut,
    PublicApplyOut,
    RecruiterIn,
    RequisitionDecisionIn,
    RequisitionIn,
    RequisitionOut,
    SCORECARD_CRITERIA,
    ScreenIn,
    StageMoveIn,
    StageStepOut,
)
from app.services import approvals as engine
from app.services import onboarding
from app.services import recruiting as rules
from app.services import storage
from app.services.activity import notify, record_audit
from app.services.decisions import NOT_FOUND, me
from app.services.pii import audit_reveal, is_masked, mask_phone
from app.services.talent_ai import MatchInput, match_candidate, needs_for_role, read_cv

router = APIRouter(prefix="/recruiting", tags=["recruiting"])

MAX_CV_BYTES = 5 * 1024 * 1024
CV_TYPES = {"pdf": "application/pdf", "doc": "application/msword",
            "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "txt": "text/plain"}
ACTIVITY_ENTITIES = ("requisition", "candidate", "interview", "offer", "joiner", "employee")


@contextmanager
def _rules() -> Iterator[None]:
    try:
        yield
    except (rules.Forbidden, onboarding.Forbidden) as exc:
        raise HTTPException(403, str(exc)) from exc
    except (rules.RuleError, onboarding.RuleError) as exc:
        raise HTTPException(409, str(exc)) from exc
    except engine.NotAllowed as exc:
        raise HTTPException(403, str(exc)) from exc
    except engine.ApprovalError as exc:
        raise HTTPException(409 if "already" in str(exc) else 422, str(exc)) from exc


def _names(db: DbSession, ids: set[str | None]) -> dict[str, str]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    return dict(db.execute(select(Employee.id, Employee.full_name).where(Employee.id.in_(ids))).all())  # type: ignore[arg-type]


def _req_outs(db: DbSession, reqs: list[Requisition]) -> list[RequisitionOut]:
    names = _names(db, {r.hiring_manager_id for r in reqs} | {r.recruiter_id for r in reqs})
    ids = [r.id for r in reqs]
    by_stage: dict[str, dict[str, int]] = {}
    if reqs:
        for rid, stage, n in db.execute(select(Candidate.requisition_id, Candidate.stage, func.count())
                                        .where(Candidate.requisition_id.in_(ids)).group_by(Candidate.requisition_id, Candidate.stage)):
            by_stage.setdefault(rid, {})[stage] = n
    postings = {p.requisition_id: p for p in db.scalars(select(JobPosting).where(JobPosting.requisition_id.in_(ids)))} if reqs else {}
    out = []
    for r in reqs:
        item = RequisitionOut.model_validate(r)
        item.hiring_manager_name = names.get(r.hiring_manager_id)
        item.recruiter_name = names.get(r.recruiter_id) if r.recruiter_id else None
        item.stage_counts = by_stage.get(r.id, {})
        item.candidate_count = sum(item.stage_counts.values())
        if (post := postings.get(r.id)) is not None:
            item.posting = PostingOut.model_validate(post)
            item.posting.applications = item.candidate_count
        out.append(item)
    return out


def _req_snapshot(r: Requisition) -> dict:
    return {"status": r.status, "title": r.title, "openings": r.openings, "recruiter_id": r.recruiter_id}


def _visible_req(db: DbSession, user: CurrentUser, req_id: str) -> Requisition:
    req = db.get(Requisition, req_id)
    if req is None or not rules.can_view_requisition(db, user, req):
        raise NOT_FOUND
    return req


def _on_panel(db: DbSession, user: CurrentUser, cand_id: str) -> bool:
    if not user.employee_id:
        return False
    return any(user.employee_id in (i.panel_ids or []) for i in db.scalars(select(Interview).where(Interview.candidate_id == cand_id)))


def _visible_cand(db: DbSession, user: CurrentUser, cand_id: str) -> tuple[Candidate, Requisition]:
    cand = db.get(Candidate, cand_id)
    if cand is None:
        raise NOT_FOUND
    req = db.get(Requisition, cand.requisition_id)
    if req is None or not (rules.can_view_requisition(db, user, req) or _on_panel(db, user, cand.id)):
        raise NOT_FOUND
    return cand, req


def _cand_out(db: DbSession, cand: Candidate) -> CandidateOut:
    out = CandidateOut.model_validate(cand)
    out.phone = mask_phone(cand.phone)  # full number: GET /candidates/{id}/reveal (recruiter / HR, audited)
    out.has_cv = cand.cv_file is not None
    out.history = [StageStepOut.model_validate(s) for s in db.scalars(
        select(CandidateStage).where(CandidateStage.candidate_id == cand.id).order_by(CandidateStage.entered_at, CandidateStage.id))]
    return out


def _cand_snapshot(c: Candidate) -> dict:
    return {"stage": c.stage, "name": c.name, "email": c.email, "source": c.source, "experience_years": c.experience_years,
            "skills": c.skills}


# ---------- requisitions ----------
@router.get("/requisitions", response_model=list[RequisitionOut])
def list_requisitions(db: DbSession, user: CurrentUserDep, status_: Annotated[str | None, Query(alias="status")] = None):
    stmt = select(Requisition).order_by(Requisition.raised_on.desc(), Requisition.id.desc())
    if status_:
        stmt = stmt.where(Requisition.status == status_)
    return _req_outs(db, [r for r in db.scalars(stmt) if rules.can_view_requisition(db, user, r)])


@router.get("/postings", response_model=list[RequisitionOut])
def list_postings(db: DbSession, user: CurrentUserDep):
    """Internal job board: published job postings taking applications, for everyone signed in.
    Approval, budget and candidate details are left out."""
    today = date.today()
    stmt = (select(Requisition).join(JobPosting, JobPosting.requisition_id == Requisition.id)
            .where(Requisition.status == "approved", Requisition.recruiter_id.is_not(None), JobPosting.status == "open",
                   JobPosting.closing_date >= today))
    out = _req_outs(db, list(db.scalars(stmt.order_by(JobPosting.published_on.desc(), Requisition.id.desc()))))
    for item in out:
        item.approval_id = None
        item.candidate_count = 0
        item.stage_counts = {}
        item.budget = item.budget_currency = item.justification = None
        if item.posting:
            item.posting.applications = 0
    return out


@router.post("/requisitions", response_model=RequisitionOut, status_code=status.HTTP_201_CREATED)
def raise_requisition(body: RequisitionIn, request: Request, db: DbSession, user: CurrentUserDep):
    """The hiring manager raises it; a recruiter or HR may raise it for the hiring manager they name."""
    for_other = bool(body.hiring_manager_id) and body.hiring_manager_id != user.employee_id
    if for_other:
        if not rules.can_raise_for_others(user):
            raise HTTPException(403, "Only a recruiter or HR can raise a requisition for another manager.")
        hm = db.get(Employee, body.hiring_manager_id)
        if hm is None or hm.employment_status in ("Terminated", "Exited"):
            raise HTTPException(422, "Choose the hiring manager.")
    else:
        if not rules.can_raise(user):
            raise HTTPException(403, "Only the manager who needs the role can raise a requisition.")
        hm = me(user)
    country_code = body.country_code.upper()
    country = db.get(Country, country_code)
    if country is None:
        raise HTTPException(422, "Choose a country.")
    req = Requisition(
        id=rules.next_requisition_id(db), title=body.title.strip(), department=body.department.strip(), country_code=country_code,
        location=body.location.strip(), openings=body.openings, hiring_manager_id=hm.id, status="pending_approval",
        requirements=[r.strip() for r in body.requirements if r.strip()], description=(body.description or "").strip() or None,
        raised_on=date.today(), budget=body.budget, budget_currency=country.currency if body.budget is not None else None,
        reason=body.reason, justification=(body.justification or "").strip() or None, raised_by=user.employee_id,
    )
    if for_other and user.account.role == "recruiter":
        req.recruiter_id, req.recruiter_assigned_on = user.employee_id, date.today()  # they run it once approved
    db.add(req)
    db.flush()
    record_audit(db, actor_id=user.id, action="requisition_raised", entity="requisition", entity_id=req.id, subject_id=hm.id,
                 after=_req_snapshot(req) | {"department": req.department, "country_code": country_code, "budget": req.budget,
                                             "reason": req.reason}, ip=client_ip(request))
    with _rules():
        rules.start_approval(db, req, hm, user.id)
    if for_other:
        by = user.employee.full_name if user.employee else "Recruiting"
        notify(db, recipient_id=hm.id, title=f"Requisition {req.id} raised for you",
               body=f"{req.title} ({req.location}). Raised by {by}.", href=f"/recruiting/requisitions/{req.id}")
    db.commit()
    return _req_outs(db, [req])[0]


@router.get("/requisitions/{req_id}", response_model=RequisitionOut)
def get_requisition(req_id: str, db: DbSession, user: CurrentUserDep):
    return _req_outs(db, [_visible_req(db, user, req_id)])[0]


@router.post("/requisitions/{req_id}/decision", response_model=RequisitionOut)
def decide_requisition(req_id: str, body: RequisitionDecisionIn, request: Request, db: DbSession, user: CurrentUserDep):
    req = _visible_req(db, user, req_id)
    if rules.is_hiring_manager(user, req):
        raise HTTPException(403, "The hiring manager cannot decide their own requisition.")
    if req.status != "pending_approval" or not req.approval_id:
        raise HTTPException(409, f"This requisition is already {req.status.replace('_', ' ')}.")
    inst = db.get(ApprovalInstance, req.approval_id)
    if inst is None or not user.employee_id:
        raise HTTPException(403, "You can't decide this requisition.")
    with _rules():
        if body.recruiter_id:
            rules.check_recruiter(db, body.recruiter_id)
            db.info.setdefault("requisition_recruiter", {})[req.id] = body.recruiter_id
        db.info["requisition_actor"] = user.id
        engine.decide(db, inst, user.employee_id, body.decision, body.note, actor_id=user.id, ip=client_ip(request))
    db.info.pop("requisition_recruiter", None)
    db.info.pop("requisition_actor", None)
    db.commit()
    return _req_outs(db, [req])[0]


def _require_hr(user: CurrentUser, req: Requisition) -> None:
    if not rules.hr_covers(user, req.country_code) or rules.is_hiring_manager(user, req):
        raise HTTPException(403, "Only HR can do this.")


@router.post("/requisitions/{req_id}/hold", response_model=RequisitionOut)
def hold_requisition(req_id: str, body: NoteIn, request: Request, db: DbSession, user: CurrentUserDep):
    req = _visible_req(db, user, req_id)
    _require_hr(user, req)
    if req.status != "approved":
        raise HTTPException(409, "Only an approved requisition can be put on hold.")
    before = _req_snapshot(req)
    req.status = "on_hold"
    record_audit(db, actor_id=user.id, action="requisition_on_hold", entity="requisition", entity_id=req.id,
                 subject_id=req.hiring_manager_id, before=before, after=_req_snapshot(req) | {"note": body.note}, ip=client_ip(request))
    notify(db, recipient_id=req.hiring_manager_id, title=f"Requisition {req.id} on hold", body=body.note,
           href=f"/recruiting/requisitions/{req.id}")
    db.commit()
    return _req_outs(db, [req])[0]


@router.post("/requisitions/{req_id}/resume", response_model=RequisitionOut)
def resume_requisition(req_id: str, request: Request, db: DbSession, user: CurrentUserDep):
    req = _visible_req(db, user, req_id)
    _require_hr(user, req)
    if req.status != "on_hold":
        raise HTTPException(409, "This requisition is not on hold.")
    before = _req_snapshot(req)
    req.status = "approved"
    record_audit(db, actor_id=user.id, action="requisition_resumed", entity="requisition", entity_id=req.id,
                 subject_id=req.hiring_manager_id, before=before, after=_req_snapshot(req), ip=client_ip(request))
    notify(db, recipient_id=req.hiring_manager_id, title=f"Requisition {req.id} is open again", href=f"/recruiting/requisitions/{req.id}")
    db.commit()
    return _req_outs(db, [req])[0]


@router.put("/requisitions/{req_id}/recruiter", response_model=RequisitionOut)
def set_recruiter(req_id: str, body: RecruiterIn, db: DbSession, user: CurrentUserDep):
    req = _visible_req(db, user, req_id)
    _require_hr(user, req)
    if req.status not in ("approved", "on_hold"):
        raise HTTPException(409, "A recruiter is assigned once the requisition is approved.")
    try:
        rules.check_recruiter(db, body.recruiter_id)
    except rules.RuleError as exc:
        raise HTTPException(422, str(exc)) from exc
    if req.recruiter_id != body.recruiter_id:
        rules.assign_recruiter(db, req, body.recruiter_id, user.id)
    db.commit()
    return _req_outs(db, [req])[0]


# ---------- job postings ----------
@router.post("/requisitions/{req_id}/posting", response_model=RequisitionOut)
def publish_posting(req_id: str, body: PostingIn, request: Request, db: DbSession, user: CurrentUserDep):
    """The recruiter (or HR) publishes the approved requisition: internal jobs board, and the careers page when chosen.
    Publishing again updates the post (and reopens a closed one)."""
    req = _visible_req(db, user, req_id)
    if not rules.can_run_pipeline(user, req):
        raise HTTPException(403, "Only the assigned recruiter or HR publishes job posts.")
    if not rules.is_open(req):
        raise HTTPException(409, f"{req.id} can be posted once it is approved and has a recruiter.")
    if body.closing_date < date.today():
        raise HTTPException(422, "Choose a closing date that is not in the past.")
    post = rules.posting_of(db, req.id)
    first = post is None
    if post is None:
        post = JobPosting(id=rules.new_posting_id(), requisition_id=req.id, published_on=date.today())
        db.add(post)
    before = None if first else {"status": post.status, "title": post.title, "closing_date": post.closing_date}
    post.title, post.description, post.location = body.title.strip(), body.description.strip(), body.location.strip()
    post.employment_type, post.closing_date, post.on_careers_site = body.employment_type.strip(), body.closing_date, body.on_careers_site
    post.status, post.closed_on, post.published_by = "open", None, user.employee_id
    db.flush()
    record_audit(db, actor_id=user.id, action="posting_published" if first else "posting_updated", entity="requisition",
                 entity_id=req.id, subject_id=req.hiring_manager_id, before=before,
                 after={"posting_id": post.id, "title": post.title, "closing_date": post.closing_date,
                        "on_careers_site": post.on_careers_site}, ip=client_ip(request))
    if first and req.hiring_manager_id != user.employee_id:
        notify(db, recipient_id=req.hiring_manager_id, title=f"{post.title} is posted",
               body=f"Open for applications until {post.closing_date}{' (careers page too)' if post.on_careers_site else ''}.",
               href=f"/recruiting/requisitions/{req.id}")
    db.commit()
    return _req_outs(db, [req])[0]


@router.post("/requisitions/{req_id}/posting/close", response_model=RequisitionOut)
def close_posting(req_id: str, request: Request, db: DbSession, user: CurrentUserDep):
    req = _visible_req(db, user, req_id)
    if not rules.can_run_pipeline(user, req):
        raise HTTPException(403, "Only the assigned recruiter or HR closes job posts.")
    post = rules.posting_of(db, req.id)
    if post is None or post.status != "open":
        raise HTTPException(409, "This job post is not open.")
    post.status, post.closed_on = "closed", date.today()
    record_audit(db, actor_id=user.id, action="posting_closed", entity="requisition", entity_id=req.id,
                 subject_id=req.hiring_manager_id, before={"status": "open"}, after={"status": "closed", "posting_id": post.id},
                 ip=client_ip(request))
    db.commit()
    return _req_outs(db, [req])[0]


@router.post("/postings/{posting_id}/apply", response_model=PublicApplyOut, status_code=status.HTTP_201_CREATED)
def apply_internally(posting_id: str, body: InternalApplyIn, request: Request, db: DbSession, user: CurrentUserDep):
    """An employee applies from the internal jobs board; the application lands in the job's pipeline (source Internal)."""
    post = db.get(JobPosting, posting_id)
    req = db.get(Requisition, post.requisition_id) if post else None
    if post is None or not rules.posting_is_open(post, req):
        raise HTTPException(404, "This job is not open for applications.")
    assert req is not None
    emp = me(user)
    if req.hiring_manager_id == emp.id:
        raise HTTPException(409, "You're the hiring manager for this role.")
    if req.recruiter_id == emp.id:
        raise HTTPException(409, "You run this role's pipeline.")
    email = (emp.email or "").strip().lower()
    if db.scalar(select(Candidate.id).where(Candidate.requisition_id == req.id, (Candidate.employee_id == emp.id)
                                            | (func.lower(Candidate.email) == email))):
        raise HTTPException(409, "You've already applied.")
    cand = Candidate(
        id=f"cand-{uuid.uuid4().hex[:10]}", requisition_id=req.id, posting_id=post.id, employee_id=emp.id, name=emp.full_name,
        email=email, phone=emp.mobile, source="Internal", experience_years=0, skills=[],
        cover_note=(body.cover_note or "").strip() or None, cv_note=f"Internal: {emp.job_title or ''}, {emp.department or ''}".strip(", "),
        applied_on=date.today(), stage="Applied", created_by=emp.id,
    )
    db.add(cand)
    db.flush()
    rules.add_stage(db, cand, "Applied", None, "Applied on the internal jobs board")
    record_audit(db, actor_id=user.id, action="candidate_applied", entity="candidate", entity_id=cand.id,
                 subject_id=req.hiring_manager_id, after=_cand_snapshot(cand) | {"requisition_id": req.id, "posting_id": post.id},
                 ip=client_ip(request))
    if req.recruiter_id:
        notify(db, recipient_id=req.recruiter_id, title=f"Internal application: {emp.full_name}",
               body=f"{post.title} ({req.id}).", href=f"/recruiting/candidates/{cand.id}")
    if emp.manager_id and emp.manager_id not in (req.recruiter_id, emp.id):
        notify(db, recipient_id=emp.manager_id, title="Internal application",
               body=f"{emp.full_name} applied for {post.title}.", href="/internal-jobs")
    db.commit()
    return PublicApplyOut(reference=cand.id, title=post.title)


@router.get("/my-applications", response_model=list[dict])
def my_applications(db: DbSession, user: CurrentUserDep) -> list[dict]:
    """My internal applications and where they are (the stage is shown in plain words)."""
    if not user.employee_id:
        return []
    out = []
    for c in db.scalars(select(Candidate).where(Candidate.employee_id == user.employee_id).order_by(Candidate.applied_on.desc())):
        req = db.get(Requisition, c.requisition_id)
        post = db.get(JobPosting, c.posting_id) if c.posting_id else None
        out.append({"id": c.id, "requisition_id": c.requisition_id, "posting_id": c.posting_id,
                    "title": post.title if post else (req.title if req else c.requisition_id), "applied_on": c.applied_on.isoformat(),
                    "stage": c.stage, "cover_note": c.cover_note})
    return out


# ---------- candidates ----------
@router.get("/candidates", response_model=list[CandidateOut])
def list_candidates(db: DbSession, user: CurrentUserDep, requisition_id: str | None = None, stage: str | None = None):
    stmt = select(Candidate).order_by(Candidate.applied_on.desc(), Candidate.id)
    if requisition_id:
        stmt = stmt.where(Candidate.requisition_id == requisition_id)
    if stage:
        stmt = stmt.where(Candidate.stage == stage)
    visible: dict[str, bool] = {}
    out = []
    for c in db.scalars(stmt):
        if c.requisition_id not in visible:
            req = db.get(Requisition, c.requisition_id)
            visible[c.requisition_id] = req is not None and rules.can_view_requisition(db, user, req)
        if visible[c.requisition_id]:
            out.append(_cand_out(db, c))
    return out


@router.post("/candidates", response_model=CandidateOut, status_code=status.HTTP_201_CREATED)
def add_candidate(body: CandidateIn, request: Request, db: DbSession, user: CurrentUserDep):
    req = db.get(Requisition, body.requisition_id)
    if req is None or not rules.can_view_requisition(db, user, req):
        raise HTTPException(422, "Choose a requisition.")
    if not rules.can_run_pipeline(user, req):
        raise HTTPException(403, "Only the assigned recruiter or HR can add candidates.")
    if not rules.is_open(req):
        raise HTTPException(409, f"{req.id} is not open for candidates.")
    if body.applied_on > date.today():
        raise HTTPException(422, "Choose an applied date that is not in the future.")
    email = body.email.strip().lower()
    if db.scalar(select(Candidate.id).where(Candidate.requisition_id == req.id, func.lower(Candidate.email) == email)):
        raise HTTPException(409, "This candidate is already on the requisition.")
    cand = Candidate(
        id=f"cand-{uuid.uuid4().hex[:10]}", requisition_id=req.id, name=body.name.strip(), email=email,
        phone=(body.phone or "").strip() or None, source=body.source.strip(), experience_years=body.experience_years,
        skills=[s.strip() for s in body.skills if s.strip()], cv_note=(body.cv_note or "").strip() or None,
        applied_on=body.applied_on, stage="Applied", created_by=user.employee_id,
    )
    db.add(cand)
    db.flush()
    rules.add_stage(db, cand, "Applied", user.employee_id)
    record_audit(db, actor_id=user.id, action="candidate_added", entity="candidate", entity_id=cand.id,
                 subject_id=req.hiring_manager_id, after=_cand_snapshot(cand) | {"requisition_id": req.id}, ip=client_ip(request))
    db.commit()
    return _cand_out(db, cand)


@router.get("/candidates/{cand_id}", response_model=CandidateOut)
def get_candidate(cand_id: str, db: DbSession, user: CurrentUserDep):
    return _cand_out(db, _visible_cand(db, user, cand_id)[0])


@router.get("/candidates/{cand_id}/reveal")
def reveal_candidate_detail(cand_id: str, request: Request, db: DbSession, user: CurrentUserDep,
                            field: Annotated[str, Query(pattern="^phone$")] = "phone") -> dict[str, str | None]:
    """The candidate's full phone number, for the assigned recruiter or HR. Audited without the value."""
    cand, req = _visible_cand(db, user, cand_id)
    if not rules.can_run_pipeline(user, req):
        raise HTTPException(403, "Only the assigned recruiter or HR can view this detail.")
    audit_reveal(db, user, entity="candidate", entity_id=cand.id, field=field, subject_id=None, ip=client_ip(request))
    db.commit()
    return {"field": field, "value": cand.phone}


@router.patch("/candidates/{cand_id}", response_model=CandidateOut)
def update_candidate(cand_id: str, body: CandidatePatch, request: Request, db: DbSession, user: CurrentUserDep):
    cand, req = _visible_cand(db, user, cand_id)
    if not rules.can_run_pipeline(user, req):
        raise HTTPException(403, "Only the assigned recruiter or HR can edit candidates.")
    before = _cand_snapshot(cand)
    for field, value in body.model_dump(exclude_unset=True).items():
        if field == "phone" and is_masked(value):
            continue  # the masked copy came back unchanged
        if field == "skills" and value is not None:
            value = [s.strip() for s in value if s.strip()]
        setattr(cand, field, value)
    record_audit(db, actor_id=user.id, action="candidate_updated", entity="candidate", entity_id=cand.id,
                 subject_id=req.hiring_manager_id, before=before, after=_cand_snapshot(cand), ip=client_ip(request))
    db.commit()
    return _cand_out(db, cand)


def tell_applicant(db: DbSession, cand: Candidate, req: Requisition, text: str) -> None:
    """Internal applicants follow their application on the internal jobs board."""
    if cand.employee_id:
        notify(db, recipient_id=cand.employee_id, title=f"Your application: {req.title}", body=text, href="/internal-jobs")


APPLICANT_TEXT = {"Screening": "Recruiting is reviewing your application.", "Shortlisted": "You are shortlisted.",
                  "Interview": "You are invited to interview.", "Offer": "An offer is being prepared.",
                  "Rejected": "The team decided not to move forward this time.", "Hired": "Welcome to your new role."}


@router.post("/candidates/{cand_id}/stage", response_model=CandidateOut)
def move_stage(cand_id: str, body: StageMoveIn, request: Request, db: DbSession, user: CurrentUserDep):
    cand, req = _visible_cand(db, user, cand_id)
    if body.stage == cand.stage:
        return _cand_out(db, cand)
    if body.stage == "Rejected" and len((body.note or "").strip()) < 3:
        raise HTTPException(422, "Give a reason to reject.")
    before = _cand_snapshot(cand)
    with _rules():
        rules.check_stage_move(db, user, cand, req, body.stage)
        rules.add_stage(db, cand, body.stage, user.employee_id, body.note)
        db.flush()
        record_audit(db, actor_id=user.id, action="candidate_stage_moved", entity="candidate", entity_id=cand.id,
                     subject_id=req.hiring_manager_id, before=before, after=_cand_snapshot(cand) | {"note": body.note},
                     ip=client_ip(request))
        if body.stage == "Hired":
            onboarding.create_joiner(db, cand, req, user)
    if body.stage == "Final Review" and req.hiring_manager_id != user.employee_id:
        notify(db, recipient_id=req.hiring_manager_id, title=f"{cand.name} is ready for your decision",
               body=f"Final Review for {req.title} ({req.id}).", href=f"/recruiting/candidates/{cand.id}")
    elif body.stage == "Offer" and req.recruiter_id and req.recruiter_id != user.employee_id:
        notify(db, recipient_id=req.recruiter_id, title=f"Prepare an offer for {cand.name}",
               body=f"The hiring manager moved {cand.name} to Offer.", href=f"/recruiting/candidates/{cand.id}")
    if body.stage in APPLICANT_TEXT:
        tell_applicant(db, cand, req, APPLICANT_TEXT[body.stage])
    db.commit()
    return _cand_out(db, cand)


@router.post("/candidates/{cand_id}/screen", response_model=CandidateOut)
def screen_candidate(cand_id: str, body: ScreenIn, request: Request, db: DbSession, user: CurrentUserDep):
    """Screening decision: shortlist (Applied -> Screening -> Shortlisted) or reject with a reason.
    The rule-based match score is saved with the decision (a guide, not the decision)."""
    cand, req = _visible_cand(db, user, cand_id)
    reason = (body.reason or "").strip()
    if body.decision == "reject" and len(reason) < 3:
        raise HTTPException(422, "Give a reason to reject.")
    with _rules():
        rules.check_screen(user, cand, req)
    before = _cand_snapshot(cand)
    needs = needs_for_role(req.title, req.department, list(req.requirements or []))
    fit = match_candidate(MatchInput(cand.name, list(cand.skills or []), " ".join(filter(None, [cand.cv_note, cand.cover_note])),
                                     cand.experience_years or 0), needs)
    cand.match_score = int(fit["score"])
    if body.decision == "shortlist":
        if cand.stage == "Applied":
            rules.add_stage(db, cand, "Screening", user.employee_id, f"Match {cand.match_score}%")
        rules.add_stage(db, cand, "Shortlisted", user.employee_id, reason or None)
    else:
        if cand.stage == "Applied":
            rules.add_stage(db, cand, "Screening", user.employee_id, f"Match {cand.match_score}%")
        rules.add_stage(db, cand, "Rejected", user.employee_id, reason)
    db.flush()
    record_audit(db, actor_id=user.id, action="candidate_screened", entity="candidate", entity_id=cand.id,
                 subject_id=req.hiring_manager_id, before=before,
                 after=_cand_snapshot(cand) | {"decision": body.decision, "reason": reason or None, "match_score": cand.match_score},
                 ip=client_ip(request))
    if body.decision == "shortlist" and req.hiring_manager_id != user.employee_id:
        notify(db, recipient_id=req.hiring_manager_id, title=f"{cand.name} shortlisted for {req.title}",
               body=f"Match {cand.match_score}%. Interviews come next.", href=f"/recruiting/candidates/{cand.id}")
    tell_applicant(db, cand, req, APPLICANT_TEXT["Shortlisted" if body.decision == "shortlist" else "Rejected"])
    db.commit()
    return _cand_out(db, cand)


def _sniff_cv(data: bytes, ext: str) -> bool:
    if ext == "pdf":
        return data.startswith(b"%PDF-")
    if ext == "doc":
        return data.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1")
    if ext == "docx":
        return data.startswith(b"PK\x03\x04")
    try:
        return b"\x00" not in data and bool(data.decode("utf-8").strip())
    except UnicodeDecodeError:
        return False


@router.put("/candidates/{cand_id}/cv", response_model=CandidateOut)
async def upload_cv(
    cand_id: str, request: Request, db: DbSession, user: CurrentUserDep,
    filename: Annotated[str, Query(min_length=5, max_length=200, description="Original file name, e.g. aisha-khan.pdf")],
):
    """Send the file as the raw request body (PDF, DOC/DOCX or TXT, at most 5 MB)."""
    cand, req = _visible_cand(db, user, cand_id)
    if not rules.can_run_pipeline(user, req):
        raise HTTPException(403, "Only the assigned recruiter or HR can upload a CV.")
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext not in CV_TYPES:
        raise HTTPException(415, "Only PDF, DOC, DOCX or TXT files are accepted.")
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > MAX_CV_BYTES:
        raise HTTPException(413, "The file is larger than 5 MB.")
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > MAX_CV_BYTES:
            raise HTTPException(413, "The file is larger than 5 MB.")
    if not data:
        raise HTTPException(422, "The file is empty.")
    if not _sniff_cv(bytes(data), ext):
        raise HTTPException(415, "The file content doesn't match its type.")
    relative = f"cvs/{cand.id}.{ext}"
    old = cand.cv_file
    storage.put_bytes(relative, bytes(data), CV_TYPES[ext])
    if old and old != relative:
        storage.delete_quietly(old)
    clean = re.sub(r"[^\w.\- ()]", "_", re.split(r"[\\/]", filename)[-1]).strip(" .")[:200]
    cand.cv_file, cand.cv_filename, cand.cv_content_type = relative, clean, CV_TYPES[ext]
    record_audit(db, actor_id=user.id, action="candidate_cv_uploaded", entity="candidate", entity_id=cand.id,
                 subject_id=req.hiring_manager_id, after={"cv_filename": clean, "size_bytes": len(data)}, ip=client_ip(request))
    db.commit()
    return _cand_out(db, cand)


@router.get("/candidates/{cand_id}/cv")
def download_cv(cand_id: str, db: DbSession, user: CurrentUserDep) -> Response:
    cand, _ = _visible_cand(db, user, cand_id)
    if not cand.cv_file:
        raise HTTPException(404, "No CV uploaded.")
    try:
        return storage.download(cand.cv_file, media_type=cand.cv_content_type or "application/octet-stream",
                                filename=cand.cv_filename)
    except storage.StorageError as exc:  # includes FileMissing
        raise HTTPException(404, "No CV uploaded.") from exc


@router.get("/candidates/{cand_id}/match", response_model=MatchOut)
def match(cand_id: str, db: DbSession, user: CurrentUserDep, requisition_id: str | None = None) -> MatchOut:
    """Rule-based fit (front end: candidateMatch.ts). A draft for people to review, not a decision."""
    cand, req = _visible_cand(db, user, cand_id)
    if requisition_id and requisition_id != req.id:
        req = _visible_req(db, user, requisition_id)
    needs = needs_for_role(req.title, req.department, list(req.requirements or []))
    result = match_candidate(MatchInput(cand.name, list(cand.skills or []), cand.cv_note or "", cand.experience_years or 0), needs)
    return MatchOut(candidate_id=cand.id, requisition_id=req.id, **result)


@router.post("/cv/parse", response_model=CvParseOut)
def parse_cv(body: CvParseIn, user: CurrentUserDep) -> CvParseOut:
    """Pull candidate details out of pasted CV text (front end: cvReader.ts). Every field is a suggestion."""
    if not (user.account.role == "recruiter" or user.scope.is_hr or rules.can_raise(user)):
        raise HTTPException(403, "Only recruiting staff can use the CV reader.")
    return CvParseOut(**read_cv(body.text))


# ---------- interviews ----------
@router.get("/interviews", response_model=list[InterviewOut])
def list_interviews(db: DbSession, user: CurrentUserDep, candidate_id: str | None = None):
    stmt = select(Interview).order_by(Interview.scheduled_at)
    if candidate_id:
        stmt = stmt.where(Interview.candidate_id == candidate_id)
    out = []
    for i in db.scalars(stmt):
        if user.employee_id in (i.panel_ids or []):
            out.append(i)
            continue
        cand = db.get(Candidate, i.candidate_id)
        req = db.get(Requisition, cand.requisition_id) if cand else None
        if req is not None and rules.can_view_requisition(db, user, req):
            out.append(i)
    return out


@router.post("/candidates/{cand_id}/interviews", response_model=InterviewOut, status_code=status.HTTP_201_CREATED)
def schedule_interview(cand_id: str, body: InterviewIn, request: Request, db: DbSession, user: CurrentUserDep):
    cand, req = _visible_cand(db, user, cand_id)
    if not rules.can_run_pipeline(user, req):
        raise HTTPException(403, "Only the assigned recruiter or HR schedules interviews.")
    if cand.stage != "Interview":
        raise HTTPException(409, "Move the candidate to Interview first.")
    when = body.scheduled_at if body.scheduled_at.tzinfo else body.scheduled_at.replace(tzinfo=UTC)
    if when <= datetime.now(UTC):
        raise HTTPException(422, "Choose a future date and time.")
    panel = list(dict.fromkeys(body.panel_ids))
    if len(_names(db, set(panel))) != len(panel):
        raise HTTPException(422, "Add the panel (people in the directory).")
    row = Interview(id=f"int-{uuid.uuid4().hex[:10]}", candidate_id=cand.id, scheduled_at=when, duration_minutes=body.duration_minutes,
                    kind=body.kind.strip(), panel_ids=panel, feedback_status="pending", created_by=user.employee_id)
    db.add(row)
    db.flush()
    record_audit(db, actor_id=user.id, action="interview_scheduled", entity="interview", entity_id=row.id,
                 subject_id=req.hiring_manager_id, after={"candidate_id": cand.id, "scheduled_at": when, "panel_ids": panel,
                                                          "kind": row.kind}, ip=client_ip(request))
    for pid in panel:
        notify(db, recipient_id=pid, title=f"Interview: {cand.name}", body=f"{row.kind} for {req.title} on {when:%Y-%m-%d %H:%M} UTC.",
               href=f"/recruiting/interviews/{row.id}")
    db.commit()
    return row


@router.post("/interviews/{interview_id}/feedback", response_model=InterviewOut)
def interview_feedback(interview_id: str, body: FeedbackIn, request: Request, db: DbSession, user: CurrentUserDep):
    row = db.get(Interview, interview_id)
    if row is None:
        raise NOT_FOUND
    cand = db.get(Candidate, row.candidate_id)
    req = db.get(Requisition, cand.requisition_id) if cand else None
    on_panel = user.employee_id in (row.panel_ids or [])
    if req is None or not (on_panel or rules.can_view_requisition(db, user, req)):
        raise NOT_FOUND
    if not (on_panel or rules.is_hiring_manager(user, req)):
        raise HTTPException(403, "Only the panel or the hiring manager can submit feedback.")
    if row.feedback_status == "submitted":
        raise HTTPException(409, "Feedback for this interview was already submitted.")
    starts = row.scheduled_at if row.scheduled_at.tzinfo else row.scheduled_at.replace(tzinfo=UTC)
    if starts > datetime.now(UTC):
        raise HTTPException(409, "The scorecard opens once the interview has started.")
    ratings = None
    if body.ratings:
        unknown = set(body.ratings) - set(SCORECARD_CRITERIA)
        if unknown or any(not 1 <= v <= 5 for v in body.ratings.values()):
            raise HTTPException(422, f"Rate {', '.join(SCORECARD_CRITERIA)} from 1 to 5.")
        ratings = {k: int(v) for k, v in body.ratings.items()}
    score = round(sum(ratings.values()) / len(ratings)) if ratings else body.score
    if score is None:
        raise HTTPException(422, "Rate the candidate from 1 to 5.")
    row.feedback_status, row.score, row.feedback = "submitted", score, body.notes.strip()
    row.ratings, row.recommendation = ratings, body.recommendation
    row.feedback_by, row.feedback_at = user.employee_id, datetime.now(UTC)
    record_audit(db, actor_id=user.id, action="interview_feedback_submitted", entity="interview", entity_id=row.id,
                 subject_id=req.hiring_manager_id, before={"feedback_status": "pending"},
                 after={"feedback_status": "submitted", "score": score, "ratings": ratings, "recommendation": body.recommendation},
                 ip=client_ip(request))
    advice = {"strong_yes": "Strong yes", "yes": "Yes", "no": "No", "strong_no": "Strong no"}.get(body.recommendation or "", "")
    for rid in {req.recruiter_id, req.hiring_manager_id} - {user.employee_id, None}:
        notify(db, recipient_id=rid, title=f"Scorecard for {cand.name if cand else row.candidate_id}",  # type: ignore[arg-type]
               body=f"Score {score}/5{f' · {advice}' if advice else ''}.", href=f"/recruiting/candidates/{row.candidate_id}")
    db.commit()
    return row


# ---------- offers ----------
def _offer_outs(db: DbSession, offers: list[Offer], user: CurrentUser | None = None) -> list[OfferOut]:
    names = dict(db.execute(select(Candidate.id, Candidate.name).where(Candidate.id.in_([o.candidate_id for o in offers]))).all()) if offers else {}
    out = []
    for o in offers:
        item = OfferOut.model_validate(o)
        item.candidate_name = names.get(o.candidate_id)
        req = db.get(Requisition, o.requisition_id) if user is not None else None
        if user is None or req is None or not rules.can_run_pipeline(user, req) or o.status != "sent":
            item.response_token = None  # the answer link is for the recruiter / HR to pass on while it is open
        out.append(item)
    return out


def record_offer_answer(db: DbSession, offer: Offer, req: Requisition, cand: Candidate, accepted: bool, note: str,
                        user: CurrentUser | None, via: str, ip: str | None = None) -> None:
    """Accepted / declined. Accepted moves the candidate to Hired and starts onboarding (a new joiner); an internal
    applicant's move is handed to HR instead. user is None when the candidate answered through their link."""
    before = _offer_snapshot(offer)
    offer.status = "accepted" if accepted else "declined"
    offer.response_note, offer.responded_on = note or None, date.today()
    offer.response_recorded_by = user.employee_id if user else None
    offer.responded_via = via  # the link keeps working to show the answer, but cannot answer again
    record_audit(db, actor_id=user.id if user else None, action=f"offer_{offer.status}", entity="offer", entity_id=offer.id,
                 subject_id=req.hiring_manager_id, before=before,
                 after=_offer_snapshot(offer) | {"note": note or None, "via": via}, ip=ip)
    who = f"{cand.name} {offer.status} the offer"
    if accepted and cand.stage == "Offer":
        rules.add_stage(db, cand, "Hired", user.employee_id if user else None,
                        "Accepted the offer" + (" (answer link)" if via == "link" else ""))
        db.flush()
        if cand.employee_id:
            for rid in {req.hiring_manager_id, *onboarding._hr_ids(db, req.country_code)} - {None}:
                notify(db, recipient_id=rid, title=f"Internal move: {cand.name}",
                       body=f"{cand.name} accepted {req.title}. Record the transfer in Lifecycle actions.",
                       href=f"/recruiting/candidates/{cand.id}")
        else:
            onboarding.create_joiner(db, cand, req, user)
        tell_applicant(db, cand, req, APPLICANT_TEXT["Hired"])
    for rid in {req.hiring_manager_id, req.recruiter_id} - {user.employee_id if user else None, None}:
        notify(db, recipient_id=rid, title=who, body=note or ("Onboarding has started." if accepted else ""),  # type: ignore[arg-type]
               href=f"/recruiting/candidates/{cand.id}")


def _offer_snapshot(o: Offer) -> dict:
    return {"status": o.status, "grade": o.grade, "base_salary": o.base_salary, "currency": o.currency, "start_date": o.start_date,
            "approvals": [a["role"] for a in o.approvals or []]}


def _visible_offer(db: DbSession, user: CurrentUser, offer_id: str) -> tuple[Offer, Requisition, Candidate]:
    offer = db.get(Offer, offer_id)
    if offer is None:
        raise NOT_FOUND
    req = db.get(Requisition, offer.requisition_id)
    cand = db.get(Candidate, offer.candidate_id)
    if req is None or cand is None or not rules.can_act(user, req):
        raise NOT_FOUND
    return offer, req, cand


@router.get("/offers", response_model=list[OfferOut])
def list_offers(db: DbSession, user: CurrentUserDep, status_: Annotated[str | None, Query(alias="status")] = None,
                candidate_id: str | None = None):
    stmt = select(Offer).order_by(Offer.created_at.desc())
    if status_:
        stmt = stmt.where(Offer.status == status_)
    if candidate_id:
        stmt = stmt.where(Offer.candidate_id == candidate_id)
    rows = []
    for o in db.scalars(stmt):
        req = db.get(Requisition, o.requisition_id)
        if req is not None and rules.can_act(user, req):
            rows.append(o)
    return _offer_outs(db, rows, user)


@router.post("/offers", response_model=OfferOut, status_code=status.HTTP_201_CREATED)
def create_offer(body: OfferIn, request: Request, db: DbSession, user: CurrentUserDep):
    cand, req = _visible_cand(db, user, body.candidate_id)
    if not rules.can_run_pipeline(user, req):
        raise HTTPException(403, "Only the assigned recruiter or HR prepares offers.")
    if not rules.is_open(req):
        raise HTTPException(409, "The requisition is not approved.")
    if cand.stage != "Offer":
        raise HTTPException(409, "The hiring manager must move the candidate to Offer first.")
    if db.scalar(select(Offer.id).where(Offer.candidate_id == cand.id, Offer.status.in_(rules.OPEN_OFFER))):
        raise HTTPException(409, "This candidate already has an open offer.")
    if body.start_date <= date.today():
        raise HTTPException(422, "Choose a start date in the future.")
    country = db.get(Country, req.country_code)
    offer = Offer(
        id=f"off-{uuid.uuid4().hex[:10]}", candidate_id=cand.id, requisition_id=req.id, grade=body.grade.strip(),
        base_salary=body.base_salary, currency=body.currency or (country.currency if country else "USD"), start_date=body.start_date,
        package_note=(body.package_note or "").strip() or None, status="preparing", approvals=[], created_by=user.employee_id or user.id,
    )
    try:
        offer.letter = rules.offer_letter(db, offer, cand, req)
    except Exception:  # noqa: BLE001 - a broken HR template must not block the offer; the letter is shown when it renders
        offer.letter = None
    db.add(offer)
    db.flush()
    record_audit(db, actor_id=user.id, action="offer_created", entity="offer", entity_id=offer.id, subject_id=req.hiring_manager_id,
                 after=_offer_snapshot(offer) | {"candidate_id": cand.id}, ip=client_ip(request))
    db.commit()
    return _offer_outs(db, [offer], user)[0]


@router.post("/offers/{offer_id}/submit", response_model=OfferOut)
def submit_offer(offer_id: str, request: Request, db: DbSession, user: CurrentUserDep):
    offer, req, cand = _visible_offer(db, user, offer_id)
    if not rules.can_run_pipeline(user, req):
        raise HTTPException(403, "Only the assigned recruiter or HR submits offers.")
    if offer.status != "preparing":
        raise HTTPException(409, f"An offer cannot move from {offer.status} to pending approval.")
    before = _offer_snapshot(offer)
    offer.status, offer.approvals = "pending_approval", []
    record_audit(db, actor_id=user.id, action="offer_submitted", entity="offer", entity_id=offer.id, subject_id=req.hiring_manager_id,
                 before=before, after=_offer_snapshot(offer), ip=client_ip(request))
    notify(db, recipient_id=req.hiring_manager_id, title=f"Offer for {cand.name} needs your agreement",
           body=f"{offer.grade}, start {offer.start_date}.", href=f"/recruiting/offers/{offer.id}")
    db.commit()
    return _offer_outs(db, [offer], user)[0]


@router.post("/offers/{offer_id}/approve", response_model=OfferOut)
def approve_offer(offer_id: str, request: Request, db: DbSession, user: CurrentUserDep):
    offer, req, cand = _visible_offer(db, user, offer_id)
    before = _offer_snapshot(offer)
    with _rules():
        step = rules.check_offer_approver(user, offer, req)
    offer.approvals = [*(offer.approvals or []), {"role": step, "by_id": user.employee_id, "at": datetime.now(UTC).isoformat()}]
    if rules.offer_step(offer) is None:
        offer.status = "approved"
        notify(db, recipient_id=offer.created_by, title=f"Offer for {cand.name} approved", body="You can send it now.",
               href=f"/recruiting/offers/{offer.id}")
    else:
        for hr in onboarding._hr_ids(db, req.country_code):
            if hr not in (req.hiring_manager_id, offer.created_by):
                notify(db, recipient_id=hr, title=f"Offer for {cand.name} needs HR approval", href=f"/recruiting/offers/{offer.id}")
    record_audit(db, actor_id=user.id, action="offer_approved" if offer.status == "approved" else "offer_step_approved",
                 entity="offer", entity_id=offer.id, subject_id=req.hiring_manager_id, before=before,
                 after=_offer_snapshot(offer) | {"step": step}, ip=client_ip(request))
    db.commit()
    return _offer_outs(db, [offer], user)[0]


@router.post("/offers/{offer_id}/send-back", response_model=OfferOut)
def send_back_offer(offer_id: str, body: NoteIn, request: Request, db: DbSession, user: CurrentUserDep):
    """An approver returns the offer to Preparing (approvals so far are cleared)."""
    offer, req, cand = _visible_offer(db, user, offer_id)
    with _rules():
        rules.check_offer_approver(user, offer, req)
    before = _offer_snapshot(offer)
    offer.status, offer.approvals = "preparing", []
    record_audit(db, actor_id=user.id, action="offer_sent_back", entity="offer", entity_id=offer.id, subject_id=req.hiring_manager_id,
                 before=before, after=_offer_snapshot(offer) | {"note": body.note}, ip=client_ip(request))
    notify(db, recipient_id=offer.created_by, title=f"Offer for {cand.name} sent back", body=body.note, href=f"/recruiting/offers/{offer.id}")
    db.commit()
    return _offer_outs(db, [offer], user)[0]


@router.post("/offers/{offer_id}/status", response_model=OfferOut)
def set_offer_status(offer_id: str, body: OfferStatusIn, request: Request, db: DbSession, user: CurrentUserDep):
    """Send, record the candidate's answer (accepted / declined, with how it was received) or withdraw."""
    offer, req, cand = _visible_offer(db, user, offer_id)
    if not rules.can_run_pipeline(user, req):
        raise HTTPException(403, "You can't make this change to the offer.")
    if body.status not in rules.OFFER_TRANSITIONS[offer.status]:
        raise HTTPException(409, f"An offer cannot move from {offer.status} to {body.status}.")
    note = (body.note or "").strip()
    if body.status in ("accepted", "declined"):
        if len(note) < 5:
            raise HTTPException(422, "Say how the candidate's answer was received.")
        with _rules():
            record_offer_answer(db, offer, req, cand, body.status == "accepted", note, user, "recorded", client_ip(request))
        db.commit()
        return _offer_outs(db, [offer], user)[0]
    before = _offer_snapshot(offer)
    if body.status == "sent":
        offer.sent_on = offer.sent_on or date.today()
        offer.response_token = offer.response_token or rules.new_response_token()  # the candidate's answer link
    offer.status = body.status
    record_audit(db, actor_id=user.id, action=f"offer_{body.status}", entity="offer", entity_id=offer.id,
                 subject_id=req.hiring_manager_id, before=before, after=_offer_snapshot(offer) | {"note": note or None},
                 ip=client_ip(request))
    if body.status == "sent" and req.hiring_manager_id != user.employee_id:
        notify(db, recipient_id=req.hiring_manager_id, title=f"Offer sent to {cand.name}",
               body=f"{req.title}, start {offer.start_date}. Waiting for the answer.", href=f"/recruiting/candidates/{cand.id}")
    db.commit()
    return _offer_outs(db, [offer], user)[0]


# ---------- my activity ----------
@router.get("/my-activity", response_model=list[ActivityOut])
def my_activity(db: DbSession, user: CurrentUserDep, days: Annotated[int, Query(ge=1, le=366)] = 90,
                limit: Annotated[int, Query(ge=1, le=500)] = 200) -> list[ActivityOut]:
    """Recruiting actions I took (raised, decided, moved, scheduled, offered, hired), newest first."""
    since = datetime.now(UTC) - timedelta(days=days)
    rows = db.scalars(
        select(AuditLog).where(AuditLog.actor_id == user.id, AuditLog.at >= since,
                               AuditLog.entity.in_([*ACTIVITY_ENTITIES, "approval_instance"]))
        .order_by(AuditLog.at.desc(), AuditLog.id.desc())
    )
    out = []
    for r in rows:
        after = (r.changes or {}).get("after") or {}
        if r.entity == "approval_instance" and after.get("type") != rules.REQUISITION_WORKFLOW:
            continue
        out.append(ActivityOut(at=r.at, action=r.action, entity=r.entity, entity_id=r.entity_id, subject_id=r.subject_id, details=after))
        if len(out) >= limit:
            break
    return out
