"""Recruiting rules (same as the front end's src/data/talentLocal.ts).

Hiring flow: the hiring manager (or a recruiter / HR for them) raises a requisition -> the "requisition" approval
workflow (department head, then HR, then finance by default) -> a recruiter is assigned when it is approved -> the
recruiter publishes it as a job posting (internal jobs board, and the public careers page) -> people apply (careers
page, or employees from the internal board) -> the recruiter screens (shortlist / reject with a reason) -> interviews
-> the panel's scorecards -> the hiring manager decides at Final Review -> offer: recruiter prepares (the Offer
letter template), hiring manager agrees, HR approves -> recruiter sends: the candidate answers through a link (or the
recruiter records the answer) -> accepted: Hired, and the joiner is created. Nobody approves their own step.
"""

from __future__ import annotations

import re
import secrets
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import utcnow
from app.deps import CurrentUser
from app.models import Account, ApprovalInstance, Candidate, CandidateStage, Country, Employee, JobPosting, Offer, Requisition
from app.services import approvals as engine
from app.services.activity import notify, record_audit

PIPELINE_STAGES = ["Applied", "Screening", "Shortlisted", "Interview", "Assessment", "Final Review", "Offer", "Hired", "Rejected", "Withdrawn"]
EXIT_STAGES = ("Rejected", "Withdrawn")
CLOSED_STAGES = ("Hired", "Rejected", "Withdrawn")
RAISING_ROLES = frozenset({"manager", "executive"})
# Raise for a named hiring manager (the manager who needs the role).
RAISE_FOR_ROLES = frozenset({"recruiter"})
SCREEN_STAGES = ("Applied", "Screening")
OPEN_OFFER = ("preparing", "pending_approval", "approved", "sent", "accepted")

REQUISITION_WORKFLOW = "requisition"
# Default chain (front end: src/data/approvalWorkflows.ts). skip_manager = the person above the hiring manager.
DEFAULT_REQUISITION_STEPS = [
    {"roles": ["skip_manager"], "mode": "any", "min_amount": None},
    {"roles": ["hr"], "mode": "any", "min_amount": None},
    {"roles": ["finance"], "mode": "any", "min_amount": None},
]

OFFER_TRANSITIONS: dict[str, tuple[str, ...]] = {
    "preparing": ("pending_approval", "withdrawn"),
    "pending_approval": ("approved", "preparing", "withdrawn"),
    "approved": ("sent", "withdrawn"),
    "sent": ("accepted", "declined", "withdrawn"),
    "accepted": (),
    "declined": (),
    "withdrawn": (),
}


class RuleError(ValueError):
    """A rule was broken (409/422); the message is safe to show."""


class Forbidden(ValueError):
    """Not this person's step (403)."""


# ---------- who ----------
def hr_covers(user: CurrentUser, country_code: str) -> bool:
    return user.scope.is_hr and (not user.scope.countries or country_code in user.scope.countries)


def is_hiring_manager(user: CurrentUser, req: Requisition) -> bool:
    return user.employee_id is not None and req.hiring_manager_id == user.employee_id


def is_assigned_recruiter(user: CurrentUser, req: Requisition) -> bool:
    return user.account.role == "recruiter" and user.employee_id is not None and req.recruiter_id == user.employee_id


def can_run_pipeline(user: CurrentUser, req: Requisition) -> bool:
    """Screening, interviews, stage moves, offers: the assigned recruiter, or HR."""
    return is_assigned_recruiter(user, req) or hr_covers(user, req.country_code)


def can_act(user: CurrentUser, req: Requisition) -> bool:
    return can_run_pipeline(user, req) or is_hiring_manager(user, req)


def can_raise(user: CurrentUser) -> bool:
    return user.employee_id is not None and (user.account.role in RAISING_ROLES or bool(user.scope.reports))


def can_raise_for_others(user: CurrentUser) -> bool:
    """A recruiter or HR raises a requisition on behalf of the hiring manager they name."""
    return user.employee_id is not None and (user.account.role in RAISE_FOR_ROLES or user.scope.is_hr)


def _approver_on(db: Session, user: CurrentUser, req: Requisition) -> bool:
    if not req.approval_id or not user.employee_id:
        return False
    inst = db.get(ApprovalInstance, req.approval_id)
    return inst is not None and any(user.employee_id in ids for s in inst.steps for ids in s["groups"].values())


def can_view_requisition(db: Session, user: CurrentUser, req: Requisition) -> bool:
    """HR (within country scope) all; a recruiter the ones assigned to them; the hiring manager their own; approvers."""
    return can_act(user, req) or _approver_on(db, user, req)


def is_open(req: Requisition) -> bool:
    return req.status == "approved" and req.recruiter_id is not None


# ---------- ids ----------
def next_requisition_id(db: Session) -> str:
    nums = [int(m.group(1)) for rid in db.scalars(select(Requisition.id)) if (m := re.fullmatch(r"JOB-(\d+)", rid))]
    return f"JOB-{max([230, *nums]) + 1}"


# ---------- requisition approval ----------
def ensure_requisition_workflow(db: Session, actor_id: str | None = None) -> None:
    if engine.latest_definition(db, REQUISITION_WORKFLOW) is None:
        engine.save_definition(db, REQUISITION_WORKFLOW, DEFAULT_REQUISITION_STEPS, actor_id)


def recruiter_ids(db: Session) -> list[str]:
    return list(db.scalars(
        select(Account.employee_id).where(Account.role == "recruiter", Account.active.is_(True), Account.employee_id.is_not(None))
        .order_by(Account.employee_id)
    ))


def check_recruiter(db: Session, recruiter_id: str) -> str:
    if recruiter_id not in recruiter_ids(db):
        raise RuleError("Choose a recruiter.")
    return recruiter_id


def assign_recruiter(db: Session, req: Requisition, recruiter_id: str, actor_id: str | None) -> None:
    before = req.recruiter_id
    req.recruiter_id = recruiter_id
    req.recruiter_assigned_on = date.today()
    record_audit(db, actor_id=actor_id, action="requisition_recruiter_assigned", entity="requisition", entity_id=req.id,
                 subject_id=req.hiring_manager_id, before={"recruiter_id": before}, after={"recruiter_id": recruiter_id})
    notify(db, recipient_id=recruiter_id, title=f"Requisition {req.id} assigned to you",
           body=f"{req.title} ({req.location}) is approved. You run the pipeline.", href=f"/recruiting/requisitions/{req.id}")


def start_approval(db: Session, req: Requisition, hiring_manager: Employee, actor_id: str | None) -> ApprovalInstance:
    ensure_requisition_workflow(db, actor_id)
    inst = engine.start(db, REQUISITION_WORKFLOW, req.id, hiring_manager, actor_id=actor_id, line_from_requester=True)
    req.approval_id = inst.id
    if inst.status == "approved":  # no step applied
        apply_outcome(db, req, inst, actor_id)
    return inst


def apply_outcome(db: Session, req: Requisition, inst: ApprovalInstance, actor_id: str | None,
                  recruiter_id: str | None = None) -> None:
    """Copy a finished approval onto the requisition; approval assigns a recruiter (the chosen one, else the first)."""
    if req.status != "pending_approval" or inst.status == "pending":
        return
    before = {"status": req.status}
    req.status = {"approved": "approved", "rejected": "rejected"}.get(inst.status, "cancelled")
    req.decided_on = date.today()
    record_audit(db, actor_id=actor_id, action=f"requisition_{req.status}", entity="requisition", entity_id=req.id,
                 subject_id=req.hiring_manager_id, before=before, after={"status": req.status, "approval_id": inst.id})
    if req.status == "approved" and req.recruiter_id is None:
        pick = recruiter_id or next(iter(recruiter_ids(db)), None)
        if pick:
            assign_recruiter(db, req, pick, actor_id)


@engine.on_finish(REQUISITION_WORKFLOW)
def _on_requisition_finished(db: Session, inst: ApprovalInstance) -> None:
    """Whichever endpoint made the final decision (here or /approvals), the requisition follows."""
    db.flush()
    req = db.get(Requisition, inst.entity_id)
    if req is not None and req.approval_id == inst.id:
        chosen = db.info.get("requisition_recruiter", {}).get(req.id)  # set by POST /recruiting/requisitions/{id}/decision
        actor = db.info.get("requisition_actor")
        apply_outcome(db, req, inst, actor, chosen)


# ---------- candidates ----------
def add_stage(db: Session, cand: Candidate, stage: str, by_id: str | None, note: str | None = None) -> None:
    cand.stage = stage
    db.add(CandidateStage(candidate_id=cand.id, stage=stage, entered_at=utcnow(), by_id=by_id, note=(note or "").strip() or None))


def has_accepted_offer(db: Session, candidate_id: str) -> bool:
    return db.scalar(select(Offer.id).where(Offer.candidate_id == candidate_id, Offer.status == "accepted")) is not None


def allowed_moves(db: Session, cand: Candidate, req: Requisition) -> list[str]:
    """Next stage forward, or exit to Rejected / Withdrawn. Hired only once an offer is accepted."""
    if cand.stage in CLOSED_STAGES or not is_open(req):
        return []
    nxt = PIPELINE_STAGES[PIPELINE_STAGES.index(cand.stage) + 1]
    moves = []
    if nxt not in EXIT_STAGES and (nxt != "Hired" or has_accepted_offer(db, cand.id)):
        moves.append(nxt)
    if cand.stage == "Interview":
        moves.append("Final Review")  # the assessment is optional
    return [*moves, *EXIT_STAGES]


def moves_for(db: Session, user: CurrentUser, cand: Candidate, req: Requisition) -> list[str]:
    moves = allowed_moves(db, cand, req)
    if cand.stage == "Final Review":
        return [m for m in moves if (can_run_pipeline(user, req) if m == "Withdrawn" else is_hiring_manager(user, req))]
    return moves if can_run_pipeline(user, req) else []


def check_stage_move(db: Session, user: CurrentUser, cand: Candidate, req: Requisition, stage: str) -> None:
    if not can_act(user, req):
        raise Forbidden("Only the assigned recruiter, HR or the hiring manager can move candidates.")
    if req.status != "approved":
        raise RuleError(f"{req.id} is {req.status.replace('_', ' ')}. Candidates can't move until it is approved.")
    if not is_open(req):
        raise RuleError(f"{req.id} has no recruiter yet.")
    if stage == "Hired" and not has_accepted_offer(db, cand.id):
        raise RuleError("A candidate can only be hired after accepting an offer.")
    if stage not in allowed_moves(db, cand, req):
        if cand.stage in CLOSED_STAGES:
            raise RuleError(f"{cand.name} is already {cand.stage}.")
        raise RuleError("Candidates move forward one stage at a time (or to Rejected / Withdrawn).")
    if stage not in moves_for(db, user, cand, req):
        if cand.stage == "Final Review" and stage != "Withdrawn":
            raise Forbidden("The hiring manager makes the Final Review decision.")
        raise Forbidden("Only the assigned recruiter or HR runs the pipeline.")


# ---------- offers ----------
def offer_step(offer: Offer) -> str | None:
    """Next approval: the hiring manager agrees, then HR approves."""
    done = {a["role"] for a in offer.approvals or []}
    if "hiring_manager" not in done:
        return "hiring_manager"
    if "hr" not in done:
        return "hr"
    return None


def check_offer_approver(user: CurrentUser, offer: Offer, req: Requisition) -> str:
    if offer.status != "pending_approval":
        raise RuleError(f"This offer is {offer.status.replace('_', ' ')}.")
    if offer.created_by == user.employee_id:
        raise Forbidden("You can't approve an offer you created.")
    if any(a["by_id"] == user.employee_id for a in offer.approvals or []):
        raise Forbidden("You already approved a step of this offer.")
    step = offer_step(offer)
    if step == "hiring_manager" and is_hiring_manager(user, req):
        return step
    if step == "hr" and hr_covers(user, req.country_code) and not is_hiring_manager(user, req):
        return step
    raise Forbidden("The hiring manager agrees to the offer first, then HR approves it."
                    if step == "hiring_manager" else "HR approves the offer after the hiring manager.")


# ---------- job postings ----------
def posting_of(db: Session, req_id: str) -> JobPosting | None:
    return db.scalar(select(JobPosting).where(JobPosting.requisition_id == req_id))


def posting_is_open(posting: JobPosting | None, req: Requisition | None, today: date | None = None) -> bool:
    """Taking applications: published, not past its closing date, and the requisition is open (approved, staffed)."""
    return (posting is not None and req is not None and posting.status == "open" and is_open(req)
            and posting.closing_date >= (today or date.today()))


def new_posting_id() -> str:
    return f"post-{secrets.token_hex(5)}"


# ---------- screening ----------
def check_screen(user: CurrentUser, cand: Candidate, req: Requisition) -> None:
    if not can_run_pipeline(user, req):
        raise Forbidden("Only the assigned recruiter or HR screens candidates.")
    if not is_open(req):
        raise RuleError(f"{req.id} is not open.")
    if cand.stage not in SCREEN_STAGES:
        raise RuleError(f"{cand.name} is already past screening ({cand.stage}).")


# ---------- offer letter and answer link ----------
def offer_letter(db: Session, offer: Offer, cand: Candidate, req: Requisition) -> dict:
    """The Offer letter template (HR's wording for the country, else the default) filled for this candidate."""
    from app.services import letters

    country = db.get(Country, req.country_code)
    manager = db.get(Employee, req.hiring_manager_id)
    entity = (manager.legal_entity if manager and manager.country_code == req.country_code and manager.legal_entity
              else f"TimeZ {country.name if country else req.country_code}")
    fields = {
        "employee_name": cand.name, "employee_code": "", "title": req.title, "department": req.department, "grade": offer.grade,
        "joining_date": offer.start_date.isoformat(), "last_working_day": "", "manager": manager.full_name if manager else "",
        "country_code": req.country_code, "country_name": country.name if country else req.country_code, "legal_entity": entity,
        "address": "", "salary": letters.format_money(offer.base_salary, offer.currency), "previous_salary": "",
        "effective_date": "", "details": "", "custom_text": (offer.package_note or "").strip(), "nationality": "", "end_date": "",
    }
    title, _to_whom, paragraphs = letters.render(db, "Offer", fields)
    return {"type": "Offer", "title": title, "paragraphs": paragraphs, "date": date.today().isoformat(),
            "fields": {k: fields[k] for k in ("employee_name", "title", "department", "grade", "joining_date", "manager",
                                              "country_code", "country_name", "legal_entity", "salary")}}


def new_response_token() -> str:
    return secrets.token_urlsafe(24)
