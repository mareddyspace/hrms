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
from fastapi.responses import FileResponse
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
    InterviewIn,
    InterviewOut,
    MatchOut,
    NoteIn,
    OfferIn,
    OfferOut,
    OfferStatusIn,
    RecruiterIn,
    RequisitionDecisionIn,
    RequisitionIn,
    RequisitionOut,
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
    counts = dict(db.execute(select(Candidate.requisition_id, func.count()).where(Candidate.requisition_id.in_([r.id for r in reqs]))
                             .group_by(Candidate.requisition_id)).all()) if reqs else {}
    out = []
    for r in reqs:
        item = RequisitionOut.model_validate(r)
        item.hiring_manager_name = names.get(r.hiring_manager_id)
        item.recruiter_name = names.get(r.recruiter_id) if r.recruiter_id else None
        item.candidate_count = counts.get(r.id, 0)
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
    """Internal job board: open requisitions (approved, recruiter assigned) for everyone signed in.
    Approval and candidate details are left out."""
    stmt = select(Requisition).where(Requisition.status == "approved", Requisition.recruiter_id.is_not(None))
    out = _req_outs(db, list(db.scalars(stmt.order_by(Requisition.raised_on.desc(), Requisition.id.desc()))))
    for item in out:
        item.approval_id = None
        item.candidate_count = 0
    return out


@router.post("/requisitions", response_model=RequisitionOut, status_code=status.HTTP_201_CREATED)
def raise_requisition(body: RequisitionIn, request: Request, db: DbSession, user: CurrentUserDep):
    if not rules.can_raise(user):
        raise HTTPException(403, "Only the manager who needs the role can raise a requisition.")
    hm = me(user)
    country = body.country_code.upper()
    if db.get(Country, country) is None:
        raise HTTPException(422, "Choose a country.")
    req = Requisition(
        id=rules.next_requisition_id(db), title=body.title.strip(), department=body.department.strip(), country_code=country,
        location=body.location.strip(), openings=body.openings, hiring_manager_id=hm.id, status="pending_approval",
        requirements=[r.strip() for r in body.requirements if r.strip()], description=(body.description or "").strip() or None,
        raised_on=date.today(),
    )
    db.add(req)
    db.flush()
    record_audit(db, actor_id=user.id, action="requisition_raised", entity="requisition", entity_id=req.id, subject_id=hm.id,
                 after=_req_snapshot(req) | {"department": req.department, "country_code": country}, ip=client_ip(request))
    with _rules():
        rules.start_approval(db, req, hm, user.id)
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


@router.post("/candidates/{cand_id}/stage", response_model=CandidateOut)
def move_stage(cand_id: str, body: StageMoveIn, request: Request, db: DbSession, user: CurrentUserDep):
    cand, req = _visible_cand(db, user, cand_id)
    if body.stage == cand.stage:
        return _cand_out(db, cand)
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
    path = storage.storage_root() / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    old = cand.cv_file
    path.write_bytes(bytes(data))
    if old and old != relative:
        storage.delete_quietly(old)
    clean = re.sub(r"[^\w.\- ()]", "_", re.split(r"[\\/]", filename)[-1]).strip(" .")[:200]
    cand.cv_file, cand.cv_filename, cand.cv_content_type = relative, clean, CV_TYPES[ext]
    record_audit(db, actor_id=user.id, action="candidate_cv_uploaded", entity="candidate", entity_id=cand.id,
                 subject_id=req.hiring_manager_id, after={"cv_filename": clean, "size_bytes": len(data)}, ip=client_ip(request))
    db.commit()
    return _cand_out(db, cand)


@router.get("/candidates/{cand_id}/cv")
def download_cv(cand_id: str, db: DbSession, user: CurrentUserDep) -> FileResponse:
    cand, _ = _visible_cand(db, user, cand_id)
    if not cand.cv_file:
        raise HTTPException(404, "No CV uploaded.")
    try:
        path = storage.resolve(cand.cv_file)
    except storage.StorageError as exc:
        raise HTTPException(404, "No CV uploaded.") from exc
    if not path.exists():
        raise HTTPException(404, "No CV uploaded.")
    return FileResponse(path, media_type=cand.cv_content_type or "application/octet-stream", filename=cand.cv_filename)


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
    row.feedback_status, row.score, row.feedback = "submitted", body.score, body.notes.strip()
    row.feedback_by, row.feedback_at = user.employee_id, datetime.now(UTC)
    record_audit(db, actor_id=user.id, action="interview_feedback_submitted", entity="interview", entity_id=row.id,
                 subject_id=req.hiring_manager_id, before={"feedback_status": "pending"},
                 after={"feedback_status": "submitted", "score": body.score}, ip=client_ip(request))
    for rid in {req.recruiter_id, req.hiring_manager_id} - {user.employee_id, None}:
        notify(db, recipient_id=rid, title=f"Interview feedback for {cand.name if cand else row.candidate_id}",  # type: ignore[arg-type]
               body=f"Score {body.score}/5.", href=f"/recruiting/interviews/{row.id}")
    db.commit()
    return row


# ---------- offers ----------
def _offer_outs(db: DbSession, offers: list[Offer]) -> list[OfferOut]:
    names = dict(db.execute(select(Candidate.id, Candidate.name).where(Candidate.id.in_([o.candidate_id for o in offers]))).all()) if offers else {}
    out = []
    for o in offers:
        item = OfferOut.model_validate(o)
        item.candidate_name = names.get(o.candidate_id)
        out.append(item)
    return out


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
    return _offer_outs(db, rows)


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
    db.add(offer)
    db.flush()
    record_audit(db, actor_id=user.id, action="offer_created", entity="offer", entity_id=offer.id, subject_id=req.hiring_manager_id,
                 after=_offer_snapshot(offer) | {"candidate_id": cand.id}, ip=client_ip(request))
    db.commit()
    return _offer_outs(db, [offer])[0]


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
    return _offer_outs(db, [offer])[0]


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
    return _offer_outs(db, [offer])[0]


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
    return _offer_outs(db, [offer])[0]


@router.post("/offers/{offer_id}/status", response_model=OfferOut)
def set_offer_status(offer_id: str, body: OfferStatusIn, request: Request, db: DbSession, user: CurrentUserDep):
    """Send, record the candidate's answer (accepted / declined, with how it was received) or withdraw."""
    offer, req, cand = _visible_offer(db, user, offer_id)
    if not rules.can_run_pipeline(user, req):
        raise HTTPException(403, "You can't make this change to the offer.")
    if body.status not in rules.OFFER_TRANSITIONS[offer.status]:
        raise HTTPException(409, f"An offer cannot move from {offer.status} to {body.status}.")
    note = (body.note or "").strip()
    before = _offer_snapshot(offer)
    if body.status in ("accepted", "declined"):
        if len(note) < 5:
            raise HTTPException(422, "Say how the candidate's answer was received.")
        offer.response_note, offer.responded_on, offer.response_recorded_by = note, date.today(), user.employee_id
    if body.status == "sent" and not offer.sent_on:
        offer.sent_on = date.today()
    offer.status = body.status
    record_audit(db, actor_id=user.id, action=f"offer_{body.status}", entity="offer", entity_id=offer.id,
                 subject_id=req.hiring_manager_id, before=before, after=_offer_snapshot(offer) | {"note": note or None},
                 ip=client_ip(request))
    if body.status in ("accepted", "declined"):
        notify(db, recipient_id=req.hiring_manager_id, title=f"{cand.name} {body.status} the offer", body=note,
               href=f"/recruiting/offers/{offer.id}")
    db.commit()
    return _offer_outs(db, [offer])[0]


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
