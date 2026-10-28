"""Engagement surveys and recognition (same rules as src/features/talentplus/surveysStore.ts and
src/features/recognition/recognitionStore.ts).

Surveys: HR creates / publishes / closes. Employees in the audience answer once while the survey is open.
Anonymous surveys store no employee id with the answers (only a department and country bucket); who answered
is kept separately to stop double answers. Results (HR / admin / executive) show nothing below 5 responses,
and every department / country bucket below 5 is suppressed. Engagement = mean of 1-5 ratings scaled to 0-100;
eNPS = % promoters (9-10) - % detractors (0-6).

Recognition: kudos with a value and up to 50 points; each person can give 100 points a month. Points received
minus points held / spent on rewards is the balance. HR fulfils or declines redemptions (declined = refunded).
"""

from __future__ import annotations

import secrets
import uuid
from datetime import date
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import func, select

from app.db import utcnow
from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import (
    Account, EngagementParticipant, EngagementResponse, EngagementSurvey, Employee, Kudos, KudosLike, RewardItem,
    RewardRedemption,
)
from app.schemas.engagement_shifts import (
    KudosIn, KudosOut, PointsBalanceOut, RedemptionDecisionIn, RedemptionIn, RedemptionOut, RewardItemOut, SurveyAnswerIn,
    SurveyBucketOut, SurveyCreateIn, SurveyOut, SurveyResultsOut, SurveyTrendPointOut,
)
from app.services.activity import notify, record_audit
from app.services.decisions import NOT_FOUND, me
from app.services.headcount import started_clause
from app.services.scope import HR_ROLES

router = APIRouter(tags=["engagement"])

MIN_RESPONSES = 5
MONTHLY_ALLOWANCE = 100
MAX_POINTS_PER_KUDOS = 50
RESULT_ROLES = HR_ROLES | {"admin", "executive"}


def _hr(user: CurrentUser) -> None:
    if user.account.role not in HR_ROLES:
        raise HTTPException(403, "Only HR can manage surveys.")


# ---------- surveys ----------
def phase(s: EngagementSurvey, today: date | None = None) -> str:
    today = today or date.today()
    if not s.published:
        return "Draft"
    if s.closed_at is not None or today > s.close_date:
        return "Closed"
    if today < s.open_date:
        return "Scheduled"
    return "Open"


def in_audience(s: EngagementSurvey, emp: Employee) -> bool:
    if s.audience_type == "department":
        return emp.department == s.audience_value
    if s.audience_type == "country":
        return emp.country_code == s.audience_value
    return True


def audience_count(db: DbSession, s: EngagementSurvey) -> int:
    stmt = select(func.count()).select_from(Employee).where(Employee.employment_status == "Active", started_clause(date.today()))
    if s.audience_type == "department":
        stmt = stmt.where(Employee.department == s.audience_value)
    elif s.audience_type == "country":
        stmt = stmt.where(Employee.country_code == s.audience_value)
    return db.scalar(stmt) or 0


def _survey_out(db: DbSession, s: EngagementSurvey, emp_id: str | None) -> SurveyOut:
    out = SurveyOut.model_validate(s)
    out.phase = phase(s)
    out.responded = bool(emp_id) and db.scalar(select(EngagementParticipant.id).where(
        EngagementParticipant.survey_id == s.id, EngagementParticipant.employee_id == emp_id)) is not None
    return out


def enps(scores: list[int]) -> int:
    promoters = sum(1 for n in scores if n >= 9)
    detractors = sum(1 for n in scores if n <= 6)
    return round((promoters - detractors) * 100 / len(scores)) if scores else 0


def engagement_score(s: EngagementSurvey, rows: list[EngagementResponse]) -> int | None:
    ids = [q["id"] for q in s.questions if q["kind"] == "rating"]
    values = [r.answers[i] for r in rows for i in ids if isinstance(r.answers.get(i), int)]
    return round(((sum(values) / len(values)) - 1) / 4 * 100) if values else None


def enps_of(s: EngagementSurvey, rows: list[EngagementResponse]) -> int | None:
    q = next((q for q in s.questions if q["kind"] == "enps"), None)
    if q is None:
        return None
    scores = [r.answers[q["id"]] for r in rows if isinstance(r.answers.get(q["id"]), int)]
    return enps(scores) if scores else None


def _summaries(s: EngagementSurvey, rows: list[EngagementResponse]) -> list[dict[str, Any]]:
    out = []
    for q in s.questions:
        values = [r.answers.get(q["id"]) for r in rows if q["id"] in r.answers]
        if q["kind"] == "text":
            out.append({"id": q["id"], "kind": "text", "prompt": q["prompt"],
                        "comments": sorted(v for v in values if isinstance(v, str) and v)})
            continue
        nums = [v for v in values if isinstance(v, int)]
        if q["kind"] == "enps":
            out.append({"id": q["id"], "kind": "enps", "prompt": q["prompt"], "score": enps(nums), "answered": len(nums),
                        "promoters": sum(1 for n in nums if n >= 9), "detractors": sum(1 for n in nums if n <= 6)})
        else:
            out.append({"id": q["id"], "kind": "rating", "prompt": q["prompt"], "answered": len(nums),
                        "average": round(sum(nums) / len(nums), 1) if nums else 0,
                        "counts": [sum(1 for n in nums if n == k) for k in range(1, 6)]})
    return out


def _buckets(s: EngagementSurvey, rows: list[EngagementResponse], attr: str) -> list[SurveyBucketOut]:
    groups: dict[str, list[EngagementResponse]] = {}
    for r in rows:
        groups.setdefault(getattr(r, attr) or "Unknown", []).append(r)
    out = []
    for name, items in sorted(groups.items()):
        enough = len(items) >= MIN_RESPONSES
        out.append(SurveyBucketOut(name=name, responses=len(items), suppressed=not enough,
                                   engagement=engagement_score(s, items) if enough else None,
                                   enps=enps_of(s, items) if enough else None))
    return out


@router.get("/surveys", response_model=list[SurveyOut])
def list_surveys(db: DbSession, user: CurrentUserDep) -> list[SurveyOut]:
    """HR: every survey. Everyone else: published surveys open to them."""
    rows = list(db.scalars(select(EngagementSurvey).order_by(EngagementSurvey.open_date.desc())))
    if user.account.role not in HR_ROLES:
        emp = user.employee
        rows = [s for s in rows if s.published and emp is not None and in_audience(s, emp)]
    return [_survey_out(db, s, user.employee_id) for s in rows]


@router.post("/surveys", response_model=SurveyOut, status_code=status.HTTP_201_CREATED)
def create_survey(body: SurveyCreateIn, request: Request, db: DbSession, user: CurrentUserDep) -> SurveyOut:
    _hr(user)
    title = body.title.strip()
    if sum(1 for q in body.questions if q.kind == "enps") > 1:
        raise HTTPException(422, "Use only one eNPS question per survey.")
    if body.audience_type != "all" and not (body.audience_value or "").strip():
        raise HTTPException(422, "Choose who the survey is for.")
    if body.open_date < date.today():
        raise HTTPException(422, "The open date can't be in the past.")
    if body.close_date <= body.open_date:
        raise HTTPException(422, "The close date must be after the open date.")
    if db.scalar(select(EngagementSurvey.id).where(func.lower(EngagementSurvey.title) == title.lower())):
        raise HTTPException(409, "A survey with this title already exists.")
    s = EngagementSurvey(
        id=f"srv-{secrets.token_hex(6)}", title=title, kind=body.kind, anonymous=body.anonymous,
        questions=[{"id": f"q{i + 1}", "kind": q.kind, "prompt": q.prompt.strip()} for i, q in enumerate(body.questions)],
        audience_type=body.audience_type, audience_value=(body.audience_value or "").strip() or None,
        open_date=body.open_date, close_date=body.close_date, published=body.publish, created_by=user.employee_id,
    )
    db.add(s)
    db.flush()
    record_audit(db, actor_id=user.id, action="survey_created", entity="survey", entity_id=s.id,
                 after={"title": s.title, "kind": s.kind, "anonymous": s.anonymous, "published": s.published}, ip=client_ip(request))
    db.commit()
    return _survey_out(db, s, user.employee_id)


def _survey(db: DbSession, survey_id: str) -> EngagementSurvey:
    s = db.get(EngagementSurvey, survey_id)
    if s is None:
        raise NOT_FOUND
    return s


@router.post("/surveys/{survey_id}/publish", response_model=SurveyOut)
def publish_survey(survey_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> SurveyOut:
    _hr(user)
    s = _survey(db, survey_id)
    if s.published:
        raise HTTPException(409, "This survey is already published.")
    if s.open_date < date.today():
        raise HTTPException(409, "The open date has passed. Create the survey again with new dates.")
    s.published = True
    record_audit(db, actor_id=user.id, action="survey_published", entity="survey", entity_id=s.id, ip=client_ip(request))
    db.commit()
    return _survey_out(db, s, user.employee_id)


@router.post("/surveys/{survey_id}/close", response_model=SurveyOut)
def close_survey(survey_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> SurveyOut:
    _hr(user)
    s = _survey(db, survey_id)
    if phase(s) == "Closed":
        raise HTTPException(409, "This survey is already closed.")
    if not s.published:
        raise HTTPException(409, "Publish the survey first (or delete the draft).")
    s.closed_at = utcnow()
    record_audit(db, actor_id=user.id, action="survey_closed", entity="survey", entity_id=s.id, ip=client_ip(request))
    db.commit()
    return _survey_out(db, s, user.employee_id)


@router.post("/surveys/{survey_id}/responses", status_code=status.HTTP_201_CREATED)
def answer_survey(survey_id: str, body: SurveyAnswerIn, db: DbSession, user: CurrentUserDep) -> dict[str, str]:
    emp = me(user)
    s = _survey(db, survey_id)
    p = phase(s)
    if p != "Open":
        raise HTTPException(409, {"Draft": "This survey isn't published.", "Scheduled": "This survey isn't open yet.",
                                  "Closed": "This survey is closed."}[p])
    if not in_audience(s, emp):
        raise HTTPException(403, "This survey isn't open to you.")
    if db.scalar(select(EngagementParticipant.id).where(EngagementParticipant.survey_id == s.id,
                                                        EngagementParticipant.employee_id == emp.id)):
        raise HTTPException(409, "You've already answered this survey.")
    clean: dict[str, Any] = {}
    for i, q in enumerate(s.questions, start=1):
        value = body.answers.get(q["id"])
        if q["kind"] == "text":
            text = value.strip() if isinstance(value, str) else ""
            if len(text) > 1000:
                raise HTTPException(422, f"Answer {i} is too long (1000 characters max).")
            if text:
                clean[q["id"]] = text
            continue
        low, high = (0, 10) if q["kind"] == "enps" else (1, 5)
        if not isinstance(value, int) or isinstance(value, bool):
            raise HTTPException(422, f"Answer question {i}.")
        if not low <= value <= high:
            raise HTTPException(422, f"Question {i} needs a score from {low} to {high}.")
        clean[q["id"]] = value
    db.add(EngagementResponse(id=uuid.uuid4().hex, survey_id=s.id, employee_id=None if s.anonymous else emp.id,
                              department=emp.department or "Unknown", country_code=emp.country_code or "??", answers=clean))
    db.add(EngagementParticipant(survey_id=s.id, employee_id=emp.id))
    db.commit()  # no audit row: it would link the person to the answer time
    return {"status": "recorded"}


@router.get("/surveys/trend", response_model=list[SurveyTrendPointOut])
def survey_trend(db: DbSession, user: CurrentUserDep, kind: str | None = None) -> list[SurveyTrendPointOut]:
    """Engagement and eNPS for each closed company-wide survey, oldest first (suppressed below 5 responses)."""
    if user.account.role not in RESULT_ROLES:
        raise HTTPException(403, "Only HR can see survey results.")
    out = []
    stmt = select(EngagementSurvey).where(EngagementSurvey.published.is_(True), EngagementSurvey.audience_type == "all")
    if kind:
        stmt = stmt.where(EngagementSurvey.kind == kind)
    for s in db.scalars(stmt):
        if phase(s) != "Closed":
            continue
        rows = list(db.scalars(select(EngagementResponse).where(EngagementResponse.survey_id == s.id)))
        enough = len(rows) >= MIN_RESPONSES
        aud = audience_count(db, s)
        out.append(SurveyTrendPointOut(
            survey_id=s.id, title=s.title, kind=s.kind, closed_on=s.closed_at.date() if s.closed_at else s.close_date,
            responses=len(rows), participation_pct=round(len(rows) * 100 / aud, 1) if aud else 0.0,
            engagement=engagement_score(s, rows) if enough else None, enps=enps_of(s, rows) if enough else None))
    return sorted(out, key=lambda p: p.closed_on)


@router.get("/surveys/{survey_id}", response_model=SurveyOut)
def get_survey(survey_id: str, db: DbSession, user: CurrentUserDep) -> SurveyOut:
    s = _survey(db, survey_id)
    if user.account.role not in HR_ROLES and not (s.published and user.employee and in_audience(s, user.employee)):
        raise NOT_FOUND
    return _survey_out(db, s, user.employee_id)


@router.get("/surveys/{survey_id}/results", response_model=SurveyResultsOut)
def survey_results(survey_id: str, db: DbSession, user: CurrentUserDep) -> SurveyResultsOut:
    if user.account.role not in RESULT_ROLES:
        raise HTTPException(403, "Only HR can see survey results.")
    s = _survey(db, survey_id)
    rows = list(db.scalars(select(EngagementResponse).where(EngagementResponse.survey_id == s.id)))
    participants = db.scalar(select(func.count()).select_from(EngagementParticipant).where(EngagementParticipant.survey_id == s.id)) or 0
    aud = audience_count(db, s)
    out = SurveyResultsOut(survey_id=s.id, phase=phase(s), responses=len(rows), audience=aud,
                           participation_pct=round(participants * 100 / aud, 1) if aud else 0.0, threshold=MIN_RESPONSES,
                           suppressed=len(rows) < MIN_RESPONSES)
    if out.suppressed:
        return out
    out.engagement, out.enps = engagement_score(s, rows), enps_of(s, rows)
    out.questions = _summaries(s, rows)
    out.departments = _buckets(s, rows, "department")
    out.countries = _buckets(s, rows, "country_code")
    return out


# ---------- recognition ----------
def _month() -> str:
    return date.today().isoformat()[:7]


def given_this_month(db: DbSession, emp_id: str) -> int:
    return db.scalar(select(func.coalesce(func.sum(Kudos.points), 0)).where(Kudos.from_id == emp_id, Kudos.month == _month())) or 0


def _balance(db: DbSession, emp_id: str) -> PointsBalanceOut:
    received = db.scalar(select(func.coalesce(func.sum(Kudos.points), 0)).where(Kudos.to_id == emp_id)) or 0
    spent = db.scalar(select(func.coalesce(func.sum(RewardRedemption.points), 0)).where(
        RewardRedemption.employee_id == emp_id, RewardRedemption.status.in_(("Requested", "Fulfilled")))) or 0
    given = given_this_month(db, emp_id)
    return PointsBalanceOut(employee_id=emp_id, received=received, spent=spent, balance=received - spent, given_this_month=given,
                            allowance_left=max(0, MONTHLY_ALLOWANCE - given), monthly_allowance=MONTHLY_ALLOWANCE,
                            max_per_kudos=MAX_POINTS_PER_KUDOS)


def _kudos_outs(db: DbSession, rows: list[Kudos], viewer: str | None) -> list[KudosOut]:
    ids = {k.from_id for k in rows} | {k.to_id for k in rows}
    names = dict(db.execute(select(Employee.id, Employee.full_name).where(Employee.id.in_(ids))).all()) if ids else {}
    out = []
    for k in rows:
        likers = set(db.scalars(select(KudosLike.employee_id).where(KudosLike.kudos_id == k.id)))
        out.append(KudosOut.model_validate(k).model_copy(update={
            "from_name": names.get(k.from_id), "to_name": names.get(k.to_id), "likes": len(likers), "liked_by_me": viewer in likers}))
    return out


@router.get("/recognition/kudos", response_model=list[KudosOut])
def wall(db: DbSession, user: CurrentUserDep, person_id: str | None = None,
         limit: Annotated[int, Query(ge=1, le=200)] = 50) -> list[KudosOut]:
    stmt = select(Kudos)
    if person_id:
        stmt = stmt.where((Kudos.to_id == person_id) | (Kudos.from_id == person_id))
    return _kudos_outs(db, list(db.scalars(stmt.order_by(Kudos.created_at.desc()).limit(limit))), user.employee_id)


@router.post("/recognition/kudos", response_model=KudosOut, status_code=status.HTTP_201_CREATED)
def give_kudos(body: KudosIn, request: Request, db: DbSession, user: CurrentUserDep) -> KudosOut:
    emp = me(user)
    if body.to_id == emp.id:
        raise HTTPException(422, "You can't give kudos to yourself.")
    if db.get(Employee, body.to_id) is None:
        raise HTTPException(422, "Pick a colleague from the list.")
    if body.points > MAX_POINTS_PER_KUDOS:
        raise HTTPException(422, f"Up to {MAX_POINTS_PER_KUDOS} points per kudos.")
    message = " ".join(body.message.split())
    left = MONTHLY_ALLOWANCE - given_this_month(db, emp.id)
    if body.points > left:
        raise HTTPException(409, f"You have {max(left, 0)} points left this month." if left > 0 else
                            "You've used this month's points. You can still send kudos without points.")
    k = Kudos(id=f"kd-{secrets.token_hex(6)}", from_id=emp.id, to_id=body.to_id, value=body.value, message=message,
              points=body.points, month=_month(), created_at=utcnow())
    db.add(k)
    db.flush()
    notify(db, recipient_id=body.to_id, title="You received kudos",
           body=f"{emp.full_name} recognised you for {body.value}" + (f" (+{body.points} points)." if body.points else "."),
           href="/recognition")
    if body.points:
        record_audit(db, actor_id=user.id, action="recognition_points_given", entity="kudos", entity_id=k.id,
                     subject_id=body.to_id, after={"points": body.points, "value": body.value}, ip=client_ip(request))
    db.commit()
    return _kudos_outs(db, [k], user.employee_id)[0]


@router.post("/recognition/kudos/{kudos_id}/like", response_model=KudosOut)
def toggle_like(kudos_id: str, db: DbSession, user: CurrentUserDep) -> KudosOut:
    emp = me(user)
    k = db.get(Kudos, kudos_id)
    if k is None:
        raise NOT_FOUND
    row = db.scalar(select(KudosLike).where(KudosLike.kudos_id == k.id, KudosLike.employee_id == emp.id))
    if row is None:
        db.add(KudosLike(kudos_id=k.id, employee_id=emp.id))
    else:
        db.delete(row)
    db.commit()
    return _kudos_outs(db, [k], emp.id)[0]


@router.get("/recognition/points", response_model=PointsBalanceOut)
def points(db: DbSession, user: CurrentUserDep, employee_id: str | None = None) -> PointsBalanceOut:
    emp = me(user)
    if employee_id and employee_id != emp.id:
        if user.account.role not in HR_ROLES:
            raise NOT_FOUND
        if db.get(Employee, employee_id) is None:
            raise NOT_FOUND
        return _balance(db, employee_id)
    return _balance(db, emp.id)


@router.get("/recognition/rewards", response_model=list[RewardItemOut])
def rewards(db: DbSession, user: CurrentUserDep) -> list[RewardItem]:
    return list(db.scalars(select(RewardItem).where(RewardItem.active.is_(True)).order_by(RewardItem.points)))


def _redemption_outs(db: DbSession, rows: list[RewardRedemption]) -> list[RedemptionOut]:
    names = dict(db.execute(select(Employee.id, Employee.full_name).where(Employee.id.in_({r.employee_id for r in rows}))).all()) if rows else {}
    items = {r.id: r.name for r in db.scalars(select(RewardItem))}
    return [RedemptionOut.model_validate(r).model_copy(update={"employee_name": names.get(r.employee_id),
                                                               "reward_name": items.get(r.reward_id)}) for r in rows]


@router.get("/recognition/redemptions", response_model=list[RedemptionOut])
def list_redemptions(db: DbSession, user: CurrentUserDep,
                     view: Annotated[str, Query(pattern="^(mine|all)$")] = "mine",
                     status_filter: Annotated[str | None, Query(alias="status")] = None) -> list[RedemptionOut]:
    stmt = select(RewardRedemption)
    if view == "mine":
        stmt = stmt.where(RewardRedemption.employee_id == (user.employee_id or ""))
    elif user.account.role not in HR_ROLES:
        raise HTTPException(403, "Only HR can see every redemption.")
    if status_filter:
        stmt = stmt.where(RewardRedemption.status == status_filter)
    return _redemption_outs(db, list(db.scalars(stmt.order_by(RewardRedemption.created_at.desc()))))


@router.post("/recognition/redemptions", response_model=RedemptionOut, status_code=status.HTTP_201_CREATED)
def redeem(body: RedemptionIn, request: Request, db: DbSession, user: CurrentUserDep) -> RedemptionOut:
    emp = me(user)
    reward = db.get(RewardItem, body.reward_id)
    if reward is None or not reward.active:
        raise HTTPException(422, "That reward is no longer available.")
    note = body.note.strip()
    if reward.needs_date and len(note) < 3:
        raise HTTPException(422, "Add your preferred date.")
    balance = _balance(db, emp.id).balance
    if balance < reward.points:
        raise HTTPException(409, f"You need {reward.points} points — you have {balance}.")
    if db.scalar(select(RewardRedemption.id).where(RewardRedemption.employee_id == emp.id, RewardRedemption.reward_id == reward.id,
                                                   RewardRedemption.status == "Requested")):
        raise HTTPException(409, "You already have an open request for this reward.")
    r = RewardRedemption(id=f"rd-{secrets.token_hex(6)}", employee_id=emp.id, reward_id=reward.id, points=reward.points,
                         note=note, status="Requested")
    db.add(r)
    db.flush()
    for hr in db.scalars(select(Account.employee_id).where(Account.role.in_(HR_ROLES), Account.active.is_(True))):
        if hr and hr != emp.id:
            notify(db, recipient_id=hr, title="Reward request",
                   body=f"{emp.full_name} redeemed {reward.points} points for {reward.name}.", href="/recognition")
    record_audit(db, actor_id=user.id, action="reward_redeemed", entity="reward_redemption", entity_id=r.id, subject_id=emp.id,
                 after={"reward_id": reward.id, "points": reward.points}, ip=client_ip(request))
    db.commit()
    return _redemption_outs(db, [r])[0]


@router.post("/recognition/redemptions/{redemption_id}/cancel", response_model=RedemptionOut)
def cancel_redemption(redemption_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> RedemptionOut:
    r = db.get(RewardRedemption, redemption_id)
    if r is None or r.employee_id != user.employee_id:
        raise NOT_FOUND
    if r.status != "Requested":
        raise HTTPException(409, f"This request is already {r.status.lower()}.")
    r.status, r.decided_at = "Cancelled", utcnow()
    record_audit(db, actor_id=user.id, action="reward_cancelled", entity="reward_redemption", entity_id=r.id,
                 subject_id=r.employee_id, after={"status": r.status}, ip=client_ip(request))
    db.commit()
    return _redemption_outs(db, [r])[0]


@router.post("/recognition/redemptions/{redemption_id}/decision", response_model=RedemptionOut)
def decide_redemption(redemption_id: str, body: RedemptionDecisionIn, request: Request, db: DbSession,
                      user: CurrentUserDep) -> RedemptionOut:
    if user.account.role not in HR_ROLES:
        raise HTTPException(403, "Only HR can fulfil or decline rewards.")
    r = db.get(RewardRedemption, redemption_id)
    if r is None:
        raise NOT_FOUND
    if r.employee_id == user.employee_id:
        raise HTTPException(403, "You can't decide your own reward request.")
    if r.status != "Requested":
        raise HTTPException(409, f"This request is already {r.status.lower()}.")
    note = (body.note or "").strip()
    if body.decision == "decline" and len(note) < 3:
        raise HTTPException(422, "Add a reason for declining.")
    r.status = "Fulfilled" if body.decision == "fulfil" else "Declined"  # declined points go back to the balance
    r.decided_by, r.decided_at, r.decision_note = user.employee_id, utcnow(), note or None
    reward = db.get(RewardItem, r.reward_id)
    notify(db, recipient_id=r.employee_id, title=f"Reward {r.status.lower()}",
           body=f"{reward.name if reward else 'Your reward'}: {r.status.lower()}."
                + (f" {r.points} points were returned to your balance." if r.status == "Declined" else ""),
           href="/recognition")
    record_audit(db, actor_id=user.id, action=f"reward_{r.status.lower()}", entity="reward_redemption", entity_id=r.id,
                 subject_id=r.employee_id, before={"status": "Requested"}, after={"status": r.status}, ip=client_ip(request))
    db.commit()
    return _redemption_outs(db, [r])[0]
