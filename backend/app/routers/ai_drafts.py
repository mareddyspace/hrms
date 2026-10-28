"""AI drafts: the Employee 360 summary (POST /ai/employee-summary) and recruiting helpers
(POST /recruiting/compare, POST /recruiting/candidates/{id}/feedback-summary). Drafts only; audited.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import Candidate, Employee, Requisition
from app.schemas.career import (
    EmployeeSummaryIn,
    EmployeeSummaryOut,
    RecruitCompareIn,
    RecruitCompareOut,
    RecruitCompareRowOut,
    RecruitFeedbackSummaryOut,
)
from app.services import ai_copilot, ai_drafts
from app.services import recruiting as rules
from app.services.activity import record_audit
from app.services.decisions import NOT_FOUND, can_view

ai_router = APIRouter(prefix="/ai", tags=["ai"])
recruiting_router = APIRouter(prefix="/recruiting", tags=["recruiting"])


def _limit(user: CurrentUser) -> None:
    if not ai_copilot.allow_question(user.id):
        raise HTTPException(429, "Too many AI requests. Try again in a minute.")


@ai_router.post("/employee-summary", response_model=EmployeeSummaryOut)
def employee_summary(body: EmployeeSummaryIn, request: Request, db: DbSession, user: CurrentUserDep) -> EmployeeSummaryOut:
    """summary=null / used_ai=false: show the portal's built-in summary."""
    emp = db.get(Employee, body.employee_id)
    if emp is None or not can_view(db, user, emp):
        raise NOT_FOUND
    _limit(user)
    result = ai_drafts.employee_summary(db, user, emp, ip=client_ip(request))
    db.commit()
    return EmployeeSummaryOut(employee_id=emp.id, summary=result.summary, used_ai=result.used_ai, model=result.model,
                              sections=result.sections)


def _requisition_for_ai(db: DbSession, user: CurrentUser, req_id: str) -> Requisition:
    req = db.get(Requisition, req_id)
    if req is None or not rules.can_view_requisition(db, user, req):
        raise NOT_FOUND
    if not rules.can_act(user, req):
        raise HTTPException(403, "Only the recruiter, HR or the hiring manager can use this.")
    return req


@recruiting_router.post("/compare", response_model=RecruitCompareOut)
def compare_candidates(body: RecruitCompareIn, request: Request, db: DbSession, user: CurrentUserDep) -> RecruitCompareOut:
    req = _requisition_for_ai(db, user, body.requisition_id)
    ids = list(dict.fromkeys(body.candidate_ids))
    if not 2 <= len(ids) <= 4:
        raise HTTPException(422, "Pick 2 to 4 different candidates.")
    cands = [db.get(Candidate, i) for i in ids]
    if any(c is None or c.requisition_id != req.id for c in cands):
        raise HTTPException(422, "Pick candidates for this job.")
    _limit(user)
    rows, summary, used_ai, model = ai_drafts.compare(db, req, cands)  # type: ignore[arg-type]
    record_audit(db, actor_id=user.id, action="compared", entity="AI candidate comparison", entity_id=req.id,
                 subject_id=req.hiring_manager_id, after={"candidate_ids": ids, "used_ai": used_ai, "model": model},
                 ip=client_ip(request))
    db.commit()
    return RecruitCompareOut(
        requisition_id=req.id, requisition_title=req.title, summary=summary, used_ai=used_ai, model=model,
        note=ai_drafts.DECISION_NOTE,
        rows=[RecruitCompareRowOut(
            candidate_id=f.candidate.id, name=f.candidate.name, stage=f.candidate.stage,
            experience_years=f.candidate.experience_years or 0, matched_skills=f.matched, missing_skills=f.missing,
            match_score=f.match_score, interview_scores=f.scores, average_score=f.average, interviews_done=f.done,
            interviews_pending=f.pending,
        ) for f in rows],
    )


@recruiting_router.post("/candidates/{cand_id}/feedback-summary", response_model=RecruitFeedbackSummaryOut)
def feedback_summary(cand_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> RecruitFeedbackSummaryOut:
    cand = db.get(Candidate, cand_id)
    if cand is None:
        raise NOT_FOUND
    req = _requisition_for_ai(db, user, cand.requisition_id)
    _limit(user)
    f, summary, used_ai, model = ai_drafts.feedback_summary(db, cand, req)
    record_audit(db, actor_id=user.id, action="summarised", entity="AI feedback summary", entity_id=cand.id,
                 subject_id=req.hiring_manager_id, after={"interviews": f.done, "used_ai": used_ai, "model": model},
                 ip=client_ip(request))
    db.commit()
    return RecruitFeedbackSummaryOut(candidate_id=cand.id, summary=summary, used_ai=used_ai, model=model, interviews_done=f.done,
                                     interviews_pending=f.pending, average_score=f.average, note=ai_drafts.DECISION_NOTE)
