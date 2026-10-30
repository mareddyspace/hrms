"""Public pages (no sign-in): the careers page with open job posts and the application form, and the candidate's
offer page reached through the link the recruiter passes on.

Nothing here reveals people, budgets or the pipeline. An application lands in the job's pipeline at Applied and the
recruiter is told. The offer link is a long random token, valid while the offer is waiting for an answer.
"""

from __future__ import annotations

import base64
import binascii
import re
import uuid
from datetime import date

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import func, select

from app.deps import DbSession, client_ip
from app.models import Candidate, Country, JobPosting, Offer, Requisition
from app.routers.recruiting import CV_TYPES, MAX_CV_BYTES, _sniff_cv, record_offer_answer
from app.schemas.talent import PublicApplyIn, PublicApplyOut, PublicOfferAnswerIn, PublicOfferOut, PublicPostingOut
from app.services import onboarding
from app.services import recruiting as rules
from app.services import storage
from app.services.activity import notify, record_audit
from app.services.talent_ai import read_cv

router = APIRouter(prefix="/public", tags=["careers"])

NOT_OPEN = HTTPException(404, "This job is not open for applications.")


def _public(db: DbSession, post: JobPosting, req: Requisition) -> PublicPostingOut:
    country = db.get(Country, req.country_code)
    return PublicPostingOut(id=post.id, title=post.title, department=req.department, location=post.location,
                            country_name=country.name if country else req.country_code, employment_type=post.employment_type,
                            description=post.description, closing_date=post.closing_date, openings=req.openings)


def _open_post(db: DbSession, posting_id: str) -> tuple[JobPosting, Requisition]:
    post = db.get(JobPosting, posting_id)
    req = db.get(Requisition, post.requisition_id) if post else None
    if post is None or req is None or not post.on_careers_site or not rules.posting_is_open(post, req):
        raise NOT_OPEN
    return post, req


@router.get("/careers", response_model=list[PublicPostingOut])
def careers(db: DbSession) -> list[PublicPostingOut]:
    rows = db.execute(select(JobPosting, Requisition).join(Requisition, Requisition.id == JobPosting.requisition_id)
                      .where(JobPosting.status == "open", JobPosting.on_careers_site.is_(True), JobPosting.closing_date >= date.today())
                      .order_by(JobPosting.published_on.desc(), JobPosting.id)).all()
    return [_public(db, post, req) for post, req in rows if rules.posting_is_open(post, req)]


@router.get("/careers/{posting_id}", response_model=PublicPostingOut)
def career_post(posting_id: str, db: DbSession) -> PublicPostingOut:
    post, req = _open_post(db, posting_id)
    return _public(db, post, req)


@router.post("/careers/{posting_id}/apply", response_model=PublicApplyOut, status_code=status.HTTP_201_CREATED)
def apply(posting_id: str, body: PublicApplyIn, request: Request, db: DbSession) -> PublicApplyOut:
    """Name, email, phone, CV (PDF, DOC, DOCX or TXT, at most 5 MB, sent as base64) and an optional cover note."""
    post, req = _open_post(db, posting_id)
    if body.website:  # filled in only by bots: answer as if it worked, keep nothing
        return PublicApplyOut(reference="received", title=post.title)
    email = body.email.strip().lower()
    if db.scalar(select(Candidate.id).where(Candidate.requisition_id == req.id, func.lower(Candidate.email) == email)):
        raise HTTPException(409, "You've already applied for this job.")
    filename = re.split(r"[\\/]", body.cv_filename)[-1]
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext not in CV_TYPES:
        raise HTTPException(415, "Attach your CV as a PDF, DOC, DOCX or TXT file.")
    try:
        data = base64.b64decode(body.cv_base64.split(",", 1)[-1], validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(422, "The CV file could not be read. Attach it again.") from exc
    if not data:
        raise HTTPException(422, "The CV file is empty.")
    if len(data) > MAX_CV_BYTES:
        raise HTTPException(413, "The CV is larger than 5 MB.")
    if not _sniff_cv(data, ext):
        raise HTTPException(415, "The file content doesn't match its type.")
    # A text CV is read for skills and years (the recruiter checks them); other formats are kept as the file.
    found = read_cv(data.decode("utf-8", "ignore")) if ext == "txt" else {}
    cand = Candidate(
        id=f"cand-{uuid.uuid4().hex[:10]}", requisition_id=req.id, posting_id=post.id, name=body.name.strip(), email=email,
        phone=(body.phone or "").strip() or None, source="Careers site",
        experience_years=float(found.get("experience_years") or 0),
        skills=list(dict.fromkeys([*(found.get("library_skills") or []), *(found.get("other_skills") or [])]))[:50],
        cover_note=(body.cover_note or "").strip() or None, applied_on=date.today(), stage="Applied", created_by=None,
    )
    db.add(cand)
    db.flush()
    relative = f"cvs/{cand.id}.{ext}"
    storage.put_bytes(relative, data, CV_TYPES[ext])
    clean = re.sub(r"[^\w.\- ()]", "_", filename).strip(" .")[:200] or f"cv.{ext}"
    cand.cv_file, cand.cv_filename, cand.cv_content_type = relative, clean, CV_TYPES[ext]
    rules.add_stage(db, cand, "Applied", None, "Applied on the careers page")
    record_audit(db, actor_id=None, action="candidate_applied", entity="candidate", entity_id=cand.id, subject_id=req.hiring_manager_id,
                 after={"requisition_id": req.id, "posting_id": post.id, "source": cand.source, "cv_filename": clean},
                 ip=client_ip(request))
    if req.recruiter_id:
        notify(db, recipient_id=req.recruiter_id, title=f"New application: {cand.name}",
               body=f"{post.title} ({req.id}) from the careers page.", href=f"/recruiting/candidates/{cand.id}")
    db.commit()
    return PublicApplyOut(reference=cand.id, title=post.title)


# ---------- the candidate's offer page ----------
def _offer_by_token(db: DbSession, token: str) -> tuple[Offer, Requisition, Candidate]:
    if len(token) < 20:
        raise HTTPException(404, "This offer link is not valid.")
    offer = db.scalar(select(Offer).where(Offer.response_token == token))
    req = db.get(Requisition, offer.requisition_id) if offer else None
    cand = db.get(Candidate, offer.candidate_id) if offer else None
    if offer is None or req is None or cand is None:
        raise HTTPException(404, "This offer link is not valid or was already used.")
    return offer, req, cand


def _offer_page(db: DbSession, offer: Offer, req: Requisition, cand: Candidate) -> PublicOfferOut:
    return PublicOfferOut(candidate_name=cand.name, title=req.title, department=req.department, location=req.location,
                          grade=offer.grade, base_salary=offer.base_salary, currency=offer.currency, start_date=offer.start_date,
                          status=offer.status if offer.status in ("sent", "accepted", "declined", "withdrawn") else "withdrawn",
                          responded_on=offer.responded_on, letter=offer.letter)


@router.get("/offers/{token}", response_model=PublicOfferOut)
def offer_page(token: str, db: DbSession) -> PublicOfferOut:
    offer, req, cand = _offer_by_token(db, token)
    return _offer_page(db, offer, req, cand)


@router.post("/offers/{token}/respond", response_model=PublicOfferOut)
def respond(token: str, body: PublicOfferAnswerIn, request: Request, db: DbSession) -> PublicOfferOut:
    """Accept or decline. Accepting starts onboarding; the link stops working after the answer."""
    offer, req, cand = _offer_by_token(db, token)
    if offer.status != "sent":
        raise HTTPException(409, "This offer is no longer waiting for an answer.")
    try:
        record_offer_answer(db, offer, req, cand, body.decision == "accept", (body.note or "").strip(), None, "link",
                            client_ip(request))
    except (rules.RuleError, onboarding.RuleError) as exc:
        raise HTTPException(409, str(exc)) from exc
    db.commit()
    return _offer_page(db, offer, req, cand)
