"""Performance: review cycles, goals, check-ins, reviews (self / manager assessment, rating), 360 feedback, development plan.

Same rules as the front end (src/data/talentLocal.ts):
- HR creates cycles and moves them planning -> active -> calibration -> closed.
- Goals: the owner or anyone above them; weights 1-100 and one person's goals in a cycle total at most 100.
- Self-assessment: the employee, while the cycle is active. Manager assessment and rating: someone above the employee.
- The rating is proposed by the manager and released by HR during calibration; the employee sees it only once released.
- 360: the employee or their manager nominates up to 3 reviewers; answers are seen by the managers and HR, never the employee.
"""

from __future__ import annotations

import uuid
from datetime import date

from fastapi import APIRouter, HTTPException, Request, Response, status
from sqlalchemy import func, select

from app.db import utcnow
from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import CheckIn, DevAction, Employee, Goal, PerfReview, Reviewer360, ReviewCycle
from app.schemas.talent import (
    AssessmentIn,
    OneOnOneIn,
    OneOnOneOut,
    CycleIn,
    CycleOut,
    DevActionIn,
    DevActionOut,
    DevActionPatch,
    GoalIn,
    GoalOut,
    GoalProgressIn,
    NominateIn,
    Pending360Out,
    RatingIn,
    Response360In,
    Reviewer360Out,
    ReviewOut,
)
from app.services.activity import notify, record_audit
from app.services.decisions import NOT_FOUND, can_view, me, target
from app.services.headcount import has_started, started_clause
from app.services.scope import manager_chain_ids

router = APIRouter(prefix="/performance", tags=["performance"])

NEXT_STATUS = {"planning": "active", "active": "calibration", "calibration": "closed"}
MAX_360 = 3
MAX_DEV_ACTIONS = 12


# ---------- who ----------
def _above(db: DbSession, user: CurrentUser, employee_id: str) -> bool:
    return user.employee_id is not None and user.employee_id != employee_id and user.employee_id in manager_chain_ids(db, employee_id)


def _line_manager(user: CurrentUser, emp: Employee) -> bool:
    """Ratings and manager assessments: the direct manager only (skip-level managers and HR may view, not write)."""
    return user.employee_id is not None and emp.id != user.employee_id and emp.manager_id == user.employee_id


def _hr_for(user: CurrentUser, emp: Employee) -> bool:
    return user.scope.is_hr and (not user.scope.countries or emp.country_code in user.scope.countries)


def _emp(db: DbSession, employee_id: str) -> Employee:
    emp = db.get(Employee, employee_id)
    if emp is None:
        raise NOT_FOUND
    return emp


def _cycle(db: DbSession, cycle_id: str) -> ReviewCycle:
    cycle = db.get(ReviewCycle, cycle_id)
    if cycle is None:
        raise HTTPException(404, "Review cycle not found.")
    return cycle


def _not_closed(cycle: ReviewCycle) -> None:
    if cycle.status == "closed":
        raise HTTPException(409, "This cycle is closed.")


# ---------- cycles ----------
@router.get("/cycles", response_model=list[CycleOut])
def list_cycles(db: DbSession, user: CurrentUserDep) -> list[ReviewCycle]:
    return list(db.scalars(select(ReviewCycle).order_by(ReviewCycle.start_date.desc())))


@router.post("/cycles", response_model=CycleOut, status_code=status.HTTP_201_CREATED)
def create_cycle(body: CycleIn, request: Request, db: DbSession, user: CurrentUserDep) -> ReviewCycle:
    if not user.scope.is_hr:
        raise HTTPException(403, "Only HR can create review cycles.")
    name = body.name.strip()
    if db.scalar(select(ReviewCycle.id).where(func.lower(ReviewCycle.name) == name.lower())):
        raise HTTPException(409, "A cycle with this name already exists.")
    if body.end_date <= body.start_date:
        raise HTTPException(422, "The end date must be after the start date.")
    if not body.start_date <= body.self_review_due <= body.end_date:
        raise HTTPException(422, "Self-review due must fall within the cycle.")
    if not body.self_review_due <= body.manager_review_due <= body.end_date:
        raise HTTPException(422, "Manager review is due after self-review and before the cycle ends.")
    cycle = ReviewCycle(id=f"cyc-{uuid.uuid4().hex[:10]}", name=name, status="planning", start_date=body.start_date,
                        end_date=body.end_date, self_review_due=body.self_review_due, manager_review_due=body.manager_review_due,
                        created_by=user.employee_id)
    db.add(cycle)
    db.flush()
    record_audit(db, actor_id=user.id, action="review_cycle_created", entity="review_cycle", entity_id=cycle.id,
                 after=body.model_dump() | {"status": "planning"}, ip=client_ip(request))
    db.commit()
    return cycle


@router.post("/cycles/{cycle_id}/advance", response_model=CycleOut)
def advance_cycle(cycle_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> ReviewCycle:
    if not user.scope.is_hr:
        raise HTTPException(403, "Only HR can change the cycle status.")
    cycle = _cycle(db, cycle_id)
    nxt = NEXT_STATUS.get(cycle.status)
    if nxt is None:
        raise HTTPException(409, "This cycle is closed.")
    before = cycle.status
    cycle.status = nxt
    record_audit(db, actor_id=user.id, action="review_cycle_advanced", entity="review_cycle", entity_id=cycle.id,
                 before={"status": before}, after={"status": nxt}, ip=client_ip(request))
    db.commit()
    return cycle


# ---------- goals ----------
def _goal_snapshot(g: Goal) -> dict:
    return {"title": g.title, "target": g.target, "weight": g.weight, "progress": g.progress, "type": g.type, "cycle_id": g.cycle_id}


def _weight_total(db: DbSession, employee_id: str, cycle_id: str, skip_id: str | None = None) -> int:
    stmt = select(func.coalesce(func.sum(Goal.weight), 0)).where(Goal.employee_id == employee_id, Goal.cycle_id == cycle_id)
    if skip_id:
        stmt = stmt.where(Goal.id != skip_id)
    return int(db.scalar(stmt) or 0)


def _goal_owner_check(db: DbSession, user: CurrentUser, employee_id: str, verb: str) -> None:
    if employee_id != user.employee_id and not _above(db, user, employee_id):
        raise HTTPException(403, f"Only the goal owner or their managers can {verb}.")


def _check_weights(db: DbSession, emp: Employee, cycle_id: str, weight: int, skip_id: str | None = None) -> None:
    total = _weight_total(db, emp.id, cycle_id, skip_id) + weight
    if total > 100:
        raise HTTPException(422, f"Weights would total {total}%. Keep {emp.full_name}'s goals at 100%.")


@router.get("/goals", response_model=list[GoalOut])
def list_goals(db: DbSession, user: CurrentUserDep, employee_id: str | None = None, cycle_id: str | None = None) -> list[Goal]:
    emp = target(db, user, employee_id)
    stmt = select(Goal).where(Goal.employee_id == emp.id).order_by(Goal.created_at)
    if cycle_id:
        stmt = stmt.where(Goal.cycle_id == cycle_id)
    return list(db.scalars(stmt))


@router.post("/goals", response_model=GoalOut, status_code=status.HTTP_201_CREATED)
def add_goal(body: GoalIn, request: Request, db: DbSession, user: CurrentUserDep) -> Goal:
    me(user)
    emp = _emp(db, body.employee_id or user.employee_id)  # type: ignore[arg-type]
    if emp.id != user.employee_id and not _above(db, user, emp.id):
        raise HTTPException(403, "You can only set goals for yourself or people below you.")
    _not_closed(_cycle(db, body.cycle_id))
    _check_weights(db, emp, body.cycle_id, body.weight)
    goal = Goal(id=f"goal-{uuid.uuid4().hex[:10]}", employee_id=emp.id, cycle_id=body.cycle_id, type=body.type, title=body.title.strip(),
                target=body.target.strip(), period=(body.period or "").strip() or None, weight=body.weight, progress=0,
                created_by=user.employee_id)
    db.add(goal)
    db.flush()
    record_audit(db, actor_id=user.id, action="goal_added", entity="goal", entity_id=goal.id, subject_id=emp.id,
                 after=_goal_snapshot(goal), ip=client_ip(request))
    if emp.id != user.employee_id:
        notify(db, recipient_id=emp.id, title="A goal was set for you", body=goal.title, href="/performance/goals")
    db.commit()
    return goal


def _goal(db: DbSession, user: CurrentUser, goal_id: str) -> Goal:
    goal = db.get(Goal, goal_id)
    if goal is None or not can_view(db, user, _emp(db, goal.employee_id)):
        raise NOT_FOUND
    return goal


@router.put("/goals/{goal_id}", response_model=GoalOut)
def update_goal(goal_id: str, body: GoalIn, request: Request, db: DbSession, user: CurrentUserDep) -> Goal:
    goal = _goal(db, user, goal_id)
    _goal_owner_check(db, user, goal.employee_id, "edit this goal")
    if body.cycle_id != goal.cycle_id:
        raise HTTPException(422, "A goal can't move to another cycle.")
    _not_closed(_cycle(db, goal.cycle_id))
    _check_weights(db, _emp(db, goal.employee_id), goal.cycle_id, body.weight, goal.id)
    before = _goal_snapshot(goal)
    goal.type, goal.title, goal.target = body.type, body.title.strip(), body.target.strip()
    goal.period, goal.weight = (body.period or "").strip() or None, body.weight
    record_audit(db, actor_id=user.id, action="goal_updated", entity="goal", entity_id=goal.id, subject_id=goal.employee_id,
                 before=before, after=_goal_snapshot(goal), ip=client_ip(request))
    db.commit()
    return goal


@router.patch("/goals/{goal_id}/progress", response_model=GoalOut)
def goal_progress(goal_id: str, body: GoalProgressIn, request: Request, db: DbSession, user: CurrentUserDep) -> Goal:
    goal = _goal(db, user, goal_id)
    _goal_owner_check(db, user, goal.employee_id, "update progress")
    _not_closed(_cycle(db, goal.cycle_id))
    before = _goal_snapshot(goal)
    goal.progress = body.progress
    record_audit(db, actor_id=user.id, action="goal_progress_updated", entity="goal", entity_id=goal.id, subject_id=goal.employee_id,
                 before=before, after=_goal_snapshot(goal), ip=client_ip(request))
    db.commit()
    return goal


@router.delete("/goals/{goal_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_goal(goal_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> Response:
    goal = _goal(db, user, goal_id)
    _goal_owner_check(db, user, goal.employee_id, "remove this goal")
    _not_closed(_cycle(db, goal.cycle_id))
    record_audit(db, actor_id=user.id, action="goal_removed", entity="goal", entity_id=goal.id, subject_id=goal.employee_id,
                 before=_goal_snapshot(goal), ip=client_ip(request))
    db.delete(goal)
    db.commit()
    return Response(status_code=204)


# ---------- check-ins ----------
@router.get("/check-ins", response_model=list[OneOnOneOut])
def list_check_ins(db: DbSession, user: CurrentUserDep, employee_id: str | None = None) -> list[CheckIn]:
    emp = target(db, user, employee_id)
    return list(db.scalars(select(CheckIn).where(CheckIn.employee_id == emp.id).order_by(CheckIn.meeting_date.desc())))


@router.post("/check-ins", response_model=OneOnOneOut, status_code=status.HTTP_201_CREATED)
def add_check_in(body: OneOnOneIn, request: Request, db: DbSession, user: CurrentUserDep) -> CheckIn:
    me(user)
    emp = _emp(db, body.employee_id)
    is_self = emp.id == user.employee_id
    if not is_self and not _above(db, user, emp.id):
        raise HTTPException(403, "Only the employee or someone above them can record a check-in.")
    row = CheckIn(id=f"chk-{uuid.uuid4().hex[:10]}", employee_id=emp.id, manager_id=emp.manager_id if is_self else user.employee_id,
                  meeting_date=body.meeting_date, notes=body.notes.strip(), action_items=[a.model_dump() for a in body.action_items],
                  created_by=user.employee_id)
    db.add(row)
    db.flush()
    record_audit(db, actor_id=user.id, action="check_in_recorded", entity="check_in", entity_id=row.id, subject_id=emp.id,
                 after={"meeting_date": row.meeting_date, "action_items": len(row.action_items)}, ip=client_ip(request))
    other = row.manager_id if is_self else emp.id
    if other:
        notify(db, recipient_id=other, title=f"1:1 notes for {row.meeting_date}", href="/performance/check-ins")
    db.commit()
    return row


# ---------- reviews ----------
def _status_360(reviewers: list[Reviewer360]) -> str:
    if not reviewers:
        return "not_started"
    return "complete" if all(r.responded_at for r in reviewers) else "in_progress"


def _review_out(db: DbSession, user: CurrentUser, review: PerfReview) -> ReviewOut:
    emp = db.get(Employee, review.employee_id)
    is_self = review.employee_id == user.employee_id
    sees_360 = not is_self and emp is not None and (_hr_for(user, emp) or _above(db, user, emp.id))
    reviewers = list(db.scalars(select(Reviewer360).where(Reviewer360.review_id == review.id).order_by(Reviewer360.id)))
    names = dict(db.execute(select(Employee.id, Employee.full_name).where(Employee.id.in_([r.reviewer_id for r in reviewers]))).all()) if reviewers else {}
    rev_out = []
    for r in reviewers:
        item = Reviewer360Out(reviewer_id=r.reviewer_id, reviewer_name=names.get(r.reviewer_id), nominated_by=r.nominated_by,
                              nominated_at=r.nominated_at, responded=r.responded_at is not None, responded_at=r.responded_at)
        if sees_360:
            item.rating, item.comment = r.rating, r.comment
        rev_out.append(item)
    actions = list(db.scalars(select(DevAction).where(DevAction.review_id == review.id).order_by(DevAction.created_at)))
    return ReviewOut(
        id=review.id, cycle_id=review.cycle_id, employee_id=review.employee_id, employee_name=emp.full_name if emp else None,
        self_status=review.self_status,
        self_text=review.self_text if is_self or review.self_status == "submitted" else None,
        manager_status=review.manager_status,
        manager_text=review.manager_text if not is_self or review.manager_status == "submitted" else None,
        rating=(review.rating if review.released else None) if is_self else review.rating,
        released=review.released, released_at=review.released_at, feedback_360_status=_status_360(reviewers),
        reviewers=rev_out, dev_actions=[DevActionOut.model_validate(a) for a in actions],
    )


def _review(db: DbSession, user: CurrentUser, review_id: str) -> tuple[PerfReview, ReviewCycle, Employee]:
    review = db.get(PerfReview, review_id)
    if review is None:
        raise NOT_FOUND
    emp = _emp(db, review.employee_id)
    if not can_view(db, user, emp):
        raise NOT_FOUND
    return review, _cycle(db, review.cycle_id), emp


def _review_snapshot(r: PerfReview) -> dict:
    return {"self_status": r.self_status, "manager_status": r.manager_status, "rating": r.rating, "released": r.released}


@router.get("/reviews", response_model=list[ReviewOut])
def list_reviews(db: DbSession, user: CurrentUserDep, cycle_id: str | None = None) -> list[ReviewOut]:
    """Reviews of people in my scope (myself, my reporting line, HR's countries)."""
    stmt = select(PerfReview).join(Employee, Employee.id == PerfReview.employee_id).where(user.scope.employee_filter())
    stmt = stmt.where(started_clause(date.today()))  # pre-boarding joiners aren't reviewed until they start
    if cycle_id:
        stmt = stmt.where(PerfReview.cycle_id == cycle_id)
    return [_review_out(db, user, r) for r in db.scalars(stmt.order_by(Employee.full_name))]


@router.get("/cycles/{cycle_id}/reviews/{employee_id}", response_model=ReviewOut)
def get_or_open_review(cycle_id: str, employee_id: str, db: DbSession, user: CurrentUserDep) -> ReviewOut:
    """The person's review in this cycle (opened on first look)."""
    cycle = _cycle(db, cycle_id)
    emp = target(db, user, employee_id)
    review = db.scalar(select(PerfReview).where(PerfReview.cycle_id == cycle.id, PerfReview.employee_id == emp.id))
    if review is None:
        _not_closed(cycle)
        if not has_started(emp, date.today()):
            raise HTTPException(409, f"{emp.full_name} hasn't started yet.")
        review = PerfReview(id=f"rev-{uuid.uuid4().hex[:10]}", cycle_id=cycle.id, employee_id=emp.id, self_status="not_started",
                            manager_status="not_started", released=False)
        db.add(review)
        db.flush()
        record_audit(db, actor_id=user.id, action="review_opened", entity="perf_review", entity_id=review.id, subject_id=emp.id,
                     after={"cycle_id": cycle.id})
        db.commit()
    return _review_out(db, user, review)


@router.put("/reviews/{review_id}/self", response_model=ReviewOut)
def save_self(review_id: str, body: AssessmentIn, request: Request, db: DbSession, user: CurrentUserDep) -> ReviewOut:
    review, cycle, emp = _review(db, user, review_id)
    if emp.id != user.employee_id:
        raise HTTPException(403, "Only the employee can write their self-assessment.")
    if cycle.status != "active":
        raise HTTPException(409, "Self-assessments are only open while the cycle is active.")
    if review.self_status == "submitted":
        raise HTTPException(409, "Your self-assessment is already submitted.")
    text = body.text.strip()
    if body.submit and len(text) < 10:
        raise HTTPException(422, "Write at least 10 characters before submitting.")
    before = _review_snapshot(review)
    review.self_text, review.self_status = text, "submitted" if body.submit else "draft"
    if body.submit:
        review.self_submitted_at = utcnow()
        if emp.manager_id:
            notify(db, recipient_id=emp.manager_id, title=f"{emp.full_name} submitted their self-assessment", href=f"/performance/reviews/{review.id}")
    record_audit(db, actor_id=user.id, action="self_assessment_" + ("submitted" if body.submit else "saved"), entity="perf_review",
                 entity_id=review.id, subject_id=emp.id, before=before, after=_review_snapshot(review), ip=client_ip(request))
    db.commit()
    return _review_out(db, user, review)


@router.put("/reviews/{review_id}/manager", response_model=ReviewOut)
def save_manager(review_id: str, body: AssessmentIn, request: Request, db: DbSession, user: CurrentUserDep) -> ReviewOut:
    review, cycle, emp = _review(db, user, review_id)
    if not _line_manager(user, emp):
        raise HTTPException(403, "Only the employee's direct manager can write the manager assessment.")
    if cycle.status != "active":
        raise HTTPException(409, "Manager assessments are only open while the cycle is active.")
    if review.manager_status == "submitted":
        raise HTTPException(409, "The manager assessment is already submitted.")
    text = body.text.strip()
    if body.submit and len(text) < 10:
        raise HTTPException(422, "Write at least 10 characters before submitting.")
    before = _review_snapshot(review)
    review.manager_text, review.manager_status, review.manager_id = text, "submitted" if body.submit else "draft", user.employee_id
    if body.submit:
        review.manager_submitted_at = utcnow()
    record_audit(db, actor_id=user.id, action="manager_assessment_" + ("submitted" if body.submit else "saved"), entity="perf_review",
                 entity_id=review.id, subject_id=emp.id, before=before, after=_review_snapshot(review), ip=client_ip(request))
    db.commit()
    return _review_out(db, user, review)


@router.post("/reviews/{review_id}/rating", response_model=ReviewOut)
def propose_rating(review_id: str, body: RatingIn, request: Request, db: DbSession, user: CurrentUserDep) -> ReviewOut:
    review, cycle, emp = _review(db, user, review_id)
    if not _line_manager(user, emp):
        raise HTTPException(403, "Only the employee's direct manager can propose a rating.")
    if cycle.status not in ("active", "calibration"):
        raise HTTPException(409, "Ratings are proposed while the cycle is active or in calibration.")
    if review.released:
        raise HTTPException(409, "This rating is already released.")
    if body.rating and review.self_status != "submitted":
        raise HTTPException(409, "The employee must submit their self-assessment first.")
    if body.rating and review.manager_status != "submitted":
        raise HTTPException(409, "Submit the manager assessment first.")
    before = _review_snapshot(review)
    review.rating, review.rating_proposed_by, review.rating_proposed_at = body.rating, user.employee_id, utcnow()
    record_audit(db, actor_id=user.id, action="rating_proposed", entity="perf_review", entity_id=review.id, subject_id=emp.id,
                 before=before, after=_review_snapshot(review), ip=client_ip(request))
    db.commit()
    return _review_out(db, user, review)


@router.post("/reviews/{review_id}/release", response_model=ReviewOut)
def release_rating(review_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> ReviewOut:
    review, cycle, emp = _review(db, user, review_id)
    if not _hr_for(user, emp):
        raise HTTPException(403, "Only HR can release ratings.")
    if emp.id == user.employee_id:
        raise HTTPException(403, "Another HR person must release your own rating.")
    if cycle.status != "calibration":
        raise HTTPException(409, "Ratings are released during calibration.")
    if not review.rating:
        raise HTTPException(409, "There is no rating to release yet.")
    if review.released:
        raise HTTPException(409, "Already released.")
    before = _review_snapshot(review)
    review.released, review.released_by, review.released_at = True, user.employee_id, utcnow()
    record_audit(db, actor_id=user.id, action="rating_released", entity="perf_review", entity_id=review.id, subject_id=emp.id,
                 before=before, after=_review_snapshot(review), ip=client_ip(request))
    notify(db, recipient_id=emp.id, title="Your performance rating is available", body=cycle.name, href=f"/performance/reviews/{review.id}")
    db.commit()
    return _review_out(db, user, review)


# ---------- 360 ----------
def _can_nominate(db: DbSession, user: CurrentUser, emp: Employee) -> bool:
    return emp.id == user.employee_id or _above(db, user, emp.id)


@router.post("/reviews/{review_id}/reviewers", response_model=ReviewOut, status_code=status.HTTP_201_CREATED)
def nominate(review_id: str, body: NominateIn, request: Request, db: DbSession, user: CurrentUserDep) -> ReviewOut:
    review, cycle, emp = _review(db, user, review_id)
    if not _can_nominate(db, user, emp):
        raise HTTPException(403, "Only the employee or their manager can nominate reviewers.")
    if cycle.status in ("calibration", "closed"):
        raise HTTPException(409, "360 nominations are closed for this cycle.")
    existing = list(db.scalars(select(Reviewer360).where(Reviewer360.review_id == review.id)))
    if len(existing) >= MAX_360:
        raise HTTPException(409, f"Up to {MAX_360} reviewers.")
    reviewer = db.get(Employee, body.reviewer_id)
    if reviewer is None or reviewer.id == emp.id or any(r.reviewer_id == reviewer.id for r in existing):
        raise HTTPException(422, "Choose a reviewer.")
    db.add(Reviewer360(review_id=review.id, reviewer_id=reviewer.id, nominated_by=user.employee_id or user.id, nominated_at=utcnow()))
    db.flush()
    record_audit(db, actor_id=user.id, action="reviewer_360_nominated", entity="perf_review", entity_id=review.id, subject_id=emp.id,
                 after={"reviewer_id": reviewer.id}, ip=client_ip(request))
    notify(db, recipient_id=reviewer.id, title="360 feedback requested", body=f"Please give 360 feedback for {emp.full_name}.",
           href="/performance/360")
    db.commit()
    return _review_out(db, user, review)


@router.delete("/reviews/{review_id}/reviewers/{reviewer_id}", response_model=ReviewOut)
def remove_reviewer(review_id: str, reviewer_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> ReviewOut:
    review, cycle, emp = _review(db, user, review_id)
    if not _can_nominate(db, user, emp):
        raise HTTPException(403, "Only the employee or their manager can change reviewers.")
    row = db.scalar(select(Reviewer360).where(Reviewer360.review_id == review.id, Reviewer360.reviewer_id == reviewer_id))
    if row is None:
        raise HTTPException(404, "Reviewer not found.")
    if row.responded_at:
        raise HTTPException(409, "This reviewer has already answered.")
    db.delete(row)
    record_audit(db, actor_id=user.id, action="reviewer_360_removed", entity="perf_review", entity_id=review.id, subject_id=emp.id,
                 before={"reviewer_id": reviewer_id}, ip=client_ip(request))
    db.commit()
    return _review_out(db, user, review)


@router.get("/360/pending", response_model=list[Pending360Out])
def pending_360(db: DbSession, user: CurrentUserDep) -> list[Pending360Out]:
    """360 requests waiting on me."""
    if not user.employee_id:
        return []
    rows = db.execute(
        select(PerfReview, Employee.full_name)
        .join(Reviewer360, Reviewer360.review_id == PerfReview.id)
        .join(ReviewCycle, ReviewCycle.id == PerfReview.cycle_id)
        .join(Employee, Employee.id == PerfReview.employee_id)
        .where(Reviewer360.reviewer_id == user.employee_id, Reviewer360.responded_at.is_(None), ReviewCycle.status != "closed")
    ).all()
    return [Pending360Out(review_id=r.id, cycle_id=r.cycle_id, employee_id=r.employee_id, employee_name=name) for r, name in rows]


@router.post("/reviews/{review_id}/360", status_code=status.HTTP_204_NO_CONTENT)
def answer_360(review_id: str, body: Response360In, request: Request, db: DbSession, user: CurrentUserDep) -> Response:
    review = db.get(PerfReview, review_id)
    row = db.scalar(select(Reviewer360).where(Reviewer360.review_id == review_id, Reviewer360.reviewer_id == user.employee_id)) \
        if review is not None and user.employee_id else None
    if review is None or row is None:
        raise HTTPException(404, "You were not asked for 360 feedback on this review.")
    if row.responded_at:
        raise HTTPException(409, "You already answered.")
    if _cycle(db, review.cycle_id).status == "closed":
        raise HTTPException(409, "This cycle is closed.")
    row.rating, row.comment, row.responded_at = body.rating, body.comment.strip(), utcnow()
    # The answer itself stays out of the audit trail's readable fields: only that it was given.
    record_audit(db, actor_id=user.id, action="reviewer_360_answered", entity="perf_review", entity_id=review.id,
                 subject_id=review.employee_id, after={"reviewer_id": user.employee_id}, ip=client_ip(request))
    emp = db.get(Employee, review.employee_id)
    if emp and emp.manager_id and emp.manager_id != user.employee_id:
        notify(db, recipient_id=emp.manager_id, title=f"360 feedback received for {emp.full_name}", href=f"/performance/reviews/{review.id}")
    db.commit()
    return Response(status_code=204)


# ---------- development actions ----------
def _dev_check(db: DbSession, user: CurrentUser, emp: Employee, cycle: ReviewCycle) -> None:
    if not _can_nominate(db, user, emp):
        raise HTTPException(403, "Only the employee or their manager can edit the plan.")
    _not_closed(cycle)


@router.post("/reviews/{review_id}/actions", response_model=DevActionOut, status_code=status.HTTP_201_CREATED)
def add_action(review_id: str, body: DevActionIn, request: Request, db: DbSession, user: CurrentUserDep) -> DevAction:
    review, cycle, emp = _review(db, user, review_id)
    _dev_check(db, user, emp, cycle)
    if (db.scalar(select(func.count()).select_from(DevAction).where(DevAction.review_id == review.id)) or 0) >= MAX_DEV_ACTIONS:
        raise HTTPException(409, f"Up to {MAX_DEV_ACTIONS} actions.")
    row = DevAction(id=f"dev-{uuid.uuid4().hex[:10]}", review_id=review.id, title=body.title.strip(), due=body.due, status="not_started")
    db.add(row)
    db.flush()
    record_audit(db, actor_id=user.id, action="dev_action_added", entity="dev_action", entity_id=row.id, subject_id=emp.id,
                 after={"title": row.title, "due": row.due, "status": row.status}, ip=client_ip(request))
    db.commit()
    return row


def _action(db: DbSession, user: CurrentUser, action_id: str) -> tuple[DevAction, PerfReview, ReviewCycle, Employee]:
    row = db.get(DevAction, action_id)
    if row is None:
        raise NOT_FOUND
    review, cycle, emp = _review(db, user, row.review_id)
    _dev_check(db, user, emp, cycle)
    return row, review, cycle, emp


@router.patch("/actions/{action_id}", response_model=DevActionOut)
def update_action(action_id: str, body: DevActionPatch, request: Request, db: DbSession, user: CurrentUserDep) -> DevAction:
    row, _, _, emp = _action(db, user, action_id)
    before = {"title": row.title, "due": row.due, "status": row.status}
    for field, value in body.model_dump(exclude_unset=True).items():
        if value is None and field != "due":
            continue
        setattr(row, field, value.strip() if isinstance(value, str) and field == "title" else value)
    record_audit(db, actor_id=user.id, action="dev_action_updated", entity="dev_action", entity_id=row.id, subject_id=emp.id,
                 before=before, after={"title": row.title, "due": row.due, "status": row.status}, ip=client_ip(request))
    db.commit()
    return row


@router.delete("/actions/{action_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_action(action_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> Response:
    row, _, _, emp = _action(db, user, action_id)
    record_audit(db, actor_id=user.id, action="dev_action_removed", entity="dev_action", entity_id=row.id, subject_id=emp.id,
                 before={"title": row.title, "status": row.status}, ip=client_ip(request))
    db.delete(row)
    db.commit()
    return Response(status_code=204)

