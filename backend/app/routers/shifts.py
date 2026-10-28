"""Shift types, weekly rosters, swaps and coverage minimums (rules in app/services/shifts.py).

Managers roster their direct reports and publish weeks; HR manages shift types and the company coverage
defaults; a manager may set their own team's minimums. Employees see their published shifts and request swaps
with a teammate on the same roster; the teammate accepts, then the manager (or HR) approves.
"""

from __future__ import annotations

import secrets
from datetime import date
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import select

from app.db import utcnow
from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import CoverageMinimum, Employee, RosterShift, RosterWeek, ShiftSwap, ShiftType
from app.schemas.engagement_shifts import (
    CoverageMinimumIn, CoverageMinimumOut, CoverageSlotOut, RosterAssignIn, RosterPublishIn, RosterShiftOut, RosterWeekOut,
    ShiftSwapDecisionIn, ShiftSwapIn, ShiftSwapOut, ShiftSwapRespondIn, ShiftTypeIn, ShiftTypeOut,
)
from app.services import shifts as rules
from app.services.activity import notify, record_audit
from app.services.decisions import NOT_FOUND, can_decide, me
from app.services.leave import today_for
from app.services.scope import HR_ROLES

router = APIRouter(prefix="/shifts", tags=["shifts"])
ROUTE = "/workforce/shifts"


def _is_hr(user: CurrentUser) -> bool:
    return user.account.role in HR_ROLES


def _today(user: CurrentUser) -> date:
    return today_for(user.employee) if user.employee else date.today()


def _slot(s: rules.CoverageSlot) -> CoverageSlotOut:
    return CoverageSlotOut(date=s.date, shift_id=s.shift_id, shift_name=s.shift_name, required=s.required, assigned=s.assigned,
                           on_leave=s.on_leave, status=s.status)


# ---------- shift types ----------
@router.get("/types", response_model=list[ShiftTypeOut])
def list_types(db: DbSession, user: CurrentUserDep) -> list[ShiftType]:
    return list(db.scalars(select(ShiftType).order_by(ShiftType.start)))


@router.post("/types", response_model=ShiftTypeOut, status_code=status.HTTP_201_CREATED)
def save_type(body: ShiftTypeIn, request: Request, db: DbSession, user: CurrentUserDep) -> ShiftType:
    """Create (no id or a new id) or update a shift type. HR only."""
    if not _is_hr(user):
        raise HTTPException(403, "Only HR can manage shift types.")
    if body.start == body.end:
        raise HTTPException(422, "Start and end can't be the same.")
    row = db.get(ShiftType, body.id) if body.id else None
    clash = db.scalar(select(ShiftType).where(ShiftType.name == body.name.strip()))
    if clash is not None and (row is None or clash.id != row.id):
        raise HTTPException(409, "A shift with this name already exists.")
    before = None
    if row is None:
        row = ShiftType(id=body.id or f"sh-{secrets.token_hex(4)}")
        db.add(row)
    else:
        before = {"name": row.name, "start": row.start, "end": row.end, "active": row.active}
    row.name, row.start, row.end = body.name.strip(), body.start, body.end
    row.weekend_only, row.active = body.weekend_only, body.active
    db.flush()
    record_audit(db, actor_id=user.id, action="shift_type_saved", entity="shift_type", entity_id=row.id, before=before,
                 after={"name": row.name, "start": row.start, "end": row.end, "active": row.active}, ip=client_ip(request))
    db.commit()
    return row


# ---------- roster ----------
def _week_out(db: DbSession, manager_id: str, week_start: date, today: date) -> RosterWeekOut:
    week = rules.roster_week(db, manager_id, week_start)
    days = rules.week_dates(week_start)
    shifts = list(db.scalars(select(RosterShift).where(RosterShift.manager_id == manager_id, RosterShift.work_date >= days[0],
                                                       RosterShift.work_date <= days[-1]).order_by(RosterShift.work_date)))
    return RosterWeekOut(
        manager_id=manager_id, week_start=week_start, status=week.status if week else "draft",
        published_at=week.published_at if week else None, published_with_gaps=bool(week and week.published_with_gaps),
        shifts=[RosterShiftOut.model_validate(s) for s in shifts],
        coverage=[_slot(s) for s in rules.week_coverage(db, manager_id, week_start)],
        gaps=[_slot(s) for s in rules.coverage_gaps(db, manager_id, week_start, today)],
    )


def _monday(d: date) -> date:
    if d.weekday() != 0:
        raise HTTPException(422, "Pick a week starting on Monday.")
    return d


@router.get("/roster", response_model=RosterWeekOut)
def get_roster(db: DbSession, user: CurrentUserDep, week_start: date,
               manager_id: Annotated[str | None, Query(max_length=64)] = None) -> RosterWeekOut:
    mid = manager_id or user.employee_id or ""
    if mid != user.employee_id and not _is_hr(user):
        raise NOT_FOUND
    return _week_out(db, mid, _monday(week_start), _today(user))


@router.post("/roster/assign", response_model=RosterWeekOut)
def assign(body: RosterAssignIn, request: Request, db: DbSession, user: CurrentUserDep) -> RosterWeekOut:
    manager = me(user)
    if body.employee_id == manager.id:
        raise HTTPException(422, "You can't roster yourself.")
    if body.employee_id not in rules.team_ids(db, manager.id):
        raise HTTPException(403, "That person isn't in your team.")
    joiner = rules.starts_after(db, body.employee_id, body.work_date) if body.shift_id is not None else None
    if joiner is not None:
        raise HTTPException(422, f"{joiner.full_name} starts on {joiner.joining_date}.")
    if body.work_date <= _today(user):
        raise HTTPException(422, "Past days and today are locked.")
    existing = db.scalar(select(RosterShift).where(RosterShift.employee_id == body.employee_id, RosterShift.work_date == body.work_date))
    if existing is not None and existing.manager_id != manager.id:
        raise HTTPException(409, "That person is on another manager's roster that day.")
    ws = rules.week_start_of(body.work_date)
    week = rules.roster_week(db, manager.id, ws)
    published = week is not None and week.status == "published"
    if body.shift_id is None:
        if existing is not None:
            db.delete(existing)
            if published:
                notify(db, recipient_id=body.employee_id, title="Shift removed",
                       body=f"Your shift on {body.work_date} was removed from the roster.", href=ROUTE)
    else:
        shift = db.get(ShiftType, body.shift_id)
        if shift is None:
            raise HTTPException(422, "That shift no longer exists.")
        if not shift.active:
            raise HTTPException(422, f"{shift.name} is no longer in use.")
        error = rules.rule_error(db, body.employee_id, body.work_date, shift, {existing.id} if existing else set())
        if error:
            raise HTTPException(409, error)
        if existing is not None:
            existing.shift_id = shift.id
        else:
            db.add(RosterShift(id=f"rs-{secrets.token_hex(6)}", employee_id=body.employee_id, work_date=body.work_date,
                               shift_id=shift.id, manager_id=manager.id))
        if week is None:
            db.add(RosterWeek(manager_id=manager.id, week_start=ws, status="draft"))
        if published:
            notify(db, recipient_id=body.employee_id, title="Shift changed",
                   body=f"You're now on {shift.name} ({shift.start}-{shift.end}) on {body.work_date}.", href=ROUTE)
    record_audit(db, actor_id=user.id, action="roster_assigned", entity="roster_shift", entity_id=f"{body.employee_id}:{body.work_date}",
                 subject_id=body.employee_id, after={"shift_id": body.shift_id}, ip=client_ip(request))
    db.commit()
    return _week_out(db, manager.id, ws, _today(user))


@router.post("/roster/publish", response_model=RosterWeekOut)
def publish(body: RosterPublishIn, request: Request, db: DbSession, user: CurrentUserDep) -> RosterWeekOut:
    """Publish a week. Under-covered upcoming slots block publishing unless allow_gaps (409 lists the gaps)."""
    manager = me(user)
    ws = _monday(body.week_start)
    today = _today(user)
    days = rules.week_dates(ws)
    if days[-1] < today:
        raise HTTPException(409, "That week is over.")
    rows = list(db.scalars(select(RosterShift).where(RosterShift.manager_id == manager.id, RosterShift.work_date >= days[0],
                                                     RosterShift.work_date <= days[-1])))
    if not rows:
        raise HTTPException(409, "Add at least one shift before publishing.")
    week = rules.roster_week(db, manager.id, ws)
    if week is not None and week.status == "published":
        raise HTTPException(409, "This week is already published.")
    for r in rows:
        if r.work_date <= today:
            continue
        shift = db.get(ShiftType, r.shift_id)
        error = rules.rule_error(db, r.employee_id, r.work_date, shift, {r.id}) if shift else None
        if error:
            raise HTTPException(409, error)
    gaps = rules.coverage_gaps(db, manager.id, ws, today)
    if gaps and not body.allow_gaps:
        raise HTTPException(409, {"message": f"Under-covered: {rules.describe(gaps)}. Fill these shifts or publish anyway.",
                                  "gaps": [_slot(g).model_dump(mode="json") for g in gaps]})
    if week is None:
        week = RosterWeek(manager_id=manager.id, week_start=ws)
        db.add(week)
    week.status, week.published_at, week.published_by = "published", utcnow(), manager.id
    week.published_with_gaps = bool(gaps)
    for pid in sorted({r.employee_id for r in rows}):
        notify(db, recipient_id=pid, title="Roster published", body=f"Your shifts for the week of {ws} are ready.", href=ROUTE)
    record_audit(db, actor_id=user.id, action="roster_published", entity="roster_week", entity_id=f"{manager.id}:{ws}",
                 after={"gaps": rules.describe(gaps) if gaps else None, "shifts": len(rows)}, ip=client_ip(request))
    db.commit()
    return _week_out(db, manager.id, ws, today)


@router.get("/mine", response_model=list[RosterShiftOut])
def my_shifts(db: DbSession, user: CurrentUserDep, from_date: date | None = None) -> list[RosterShiftOut]:
    rows = db.scalars(select(RosterShift).where(RosterShift.employee_id == (user.employee_id or ""),
                                                RosterShift.work_date >= (from_date or date.min)).order_by(RosterShift.work_date))
    return [RosterShiftOut.model_validate(r) for r in rows if rules.is_published(db, r)]


# ---------- swaps ----------
def _row(db: DbSession, emp_id: str, d: date) -> RosterShift | None:
    return db.scalar(select(RosterShift).where(RosterShift.employee_id == emp_id, RosterShift.work_date == d))


def _swap_rule_error(db: DbSession, mine: RosterShift, theirs: RosterShift) -> str | None:
    a, b = db.get(ShiftType, theirs.shift_id), db.get(ShiftType, mine.shift_id)
    if a is None or b is None:
        return "One of the shifts no longer exists."
    return (rules.rule_error(db, mine.employee_id, mine.work_date, a, {mine.id}, {theirs.id: b.id})
            or rules.rule_error(db, theirs.employee_id, theirs.work_date, b, {theirs.id}, {mine.id: a.id}))


@router.get("/swaps", response_model=list[ShiftSwapOut])
def list_swaps(db: DbSession, user: CurrentUserDep,
               view: Annotated[str, Query(pattern="^(mine|to_decide)$")] = "mine") -> list[ShiftSwap]:
    emp_id = user.employee_id or ""
    if view == "mine":
        stmt = select(ShiftSwap).where((ShiftSwap.requester_id == emp_id) | (ShiftSwap.teammate_id == emp_id))
        return list(db.scalars(stmt.order_by(ShiftSwap.created_at.desc())))
    out = []
    for s in db.scalars(select(ShiftSwap).where(ShiftSwap.status == "awaiting_manager").order_by(ShiftSwap.created_at)):
        a, b = db.get(Employee, s.requester_id), db.get(Employee, s.teammate_id)
        if a and b and can_decide(db, user, a) and can_decide(db, user, b):
            out.append(s)
    return out


@router.get("/swaps/partners")
def swap_partners(db: DbSession, user: CurrentUserDep, work_date: date) -> list[dict[str, str]]:
    """Colleagues I can ask to swap with on this day: on the same published roster, on another shift, started,
    with a sign-in account (so they can respond). Only ids and names; their shifts stay hidden."""
    emp_id = user.employee_id or ""
    mine = _row(db, emp_id, work_date)
    if mine is None or not rules.is_published(db, mine) or work_date <= _today(user):
        return []
    rows = db.scalars(select(RosterShift).where(RosterShift.manager_id == mine.manager_id, RosterShift.work_date == work_date,
                                                RosterShift.employee_id != emp_id, RosterShift.shift_id != mine.shift_id))
    out = []
    for row in rows:
        if rules.swap_partner_error(db, row.employee_id, work_date, _today(user)) is None:
            other = db.get(Employee, row.employee_id)
            out.append({"id": row.employee_id, "full_name": other.full_name if other else row.employee_id})
    return sorted(out, key=lambda p: p["full_name"])


@router.post("/swaps", response_model=ShiftSwapOut, status_code=status.HTTP_201_CREATED)
def request_swap(body: ShiftSwapIn, request: Request, db: DbSession, user: CurrentUserDep) -> ShiftSwap:
    emp = me(user)
    if body.work_date <= _today(user):
        raise HTTPException(422, "Swaps are only for upcoming days.")
    if body.teammate_id == emp.id:
        raise HTTPException(422, "Pick someone other than yourself.")
    partner_error = rules.swap_partner_error(db, body.teammate_id, body.work_date, _today(user))
    if partner_error:
        raise HTTPException(422, partner_error)
    mine, theirs = _row(db, emp.id, body.work_date), _row(db, body.teammate_id, body.work_date)
    if mine is None or not rules.is_published(db, mine):
        raise HTTPException(409, f"You're not on the published roster on {body.work_date}.")
    if theirs is None or not rules.is_published(db, theirs):
        raise HTTPException(409, f"Your teammate isn't on the published roster on {body.work_date}.")
    if mine.manager_id != theirs.manager_id:
        raise HTTPException(409, "You can only swap with someone on the same team roster.")
    if mine.shift_id == theirs.shift_id:
        raise HTTPException(409, "You're both on the same shift that day.")
    open_ = db.scalar(select(ShiftSwap.id).where(
        ShiftSwap.work_date == body.work_date, ShiftSwap.status.in_(("awaiting_teammate", "awaiting_manager")),
        ShiftSwap.requester_id.in_((emp.id, body.teammate_id)) | ShiftSwap.teammate_id.in_((emp.id, body.teammate_id))))
    if open_:
        raise HTTPException(409, "There's already an open swap for one of you on that day.")
    error = _swap_rule_error(db, mine, theirs)
    if error:
        raise HTTPException(409, error)
    swap = ShiftSwap(id=f"sw-{secrets.token_hex(6)}", work_date=body.work_date, requester_id=emp.id, teammate_id=body.teammate_id,
                     requester_shift_id=mine.shift_id, teammate_shift_id=theirs.shift_id, reason=body.reason.strip(),
                     status="awaiting_teammate")
    db.add(swap)
    db.flush()
    notify(db, recipient_id=body.teammate_id, title="Shift swap request",
           body=f"{emp.full_name} wants to swap shifts with you on {body.work_date}.", href=ROUTE)
    record_audit(db, actor_id=user.id, action="shift_swap_requested", entity="shift_swap", entity_id=swap.id, subject_id=emp.id,
                 after={"date": body.work_date, "teammate_id": body.teammate_id}, ip=client_ip(request))
    db.commit()
    return swap


@router.post("/swaps/{swap_id}/respond", response_model=ShiftSwapOut)
def respond_swap(swap_id: str, body: ShiftSwapRespondIn, db: DbSession, user: CurrentUserDep) -> ShiftSwap:
    swap = db.get(ShiftSwap, swap_id)
    if swap is None or user.employee_id not in (swap.requester_id, swap.teammate_id):
        raise NOT_FOUND
    if swap.teammate_id != user.employee_id:
        raise HTTPException(403, "Only the teammate asked can respond.")
    if swap.status != "awaiting_teammate":
        raise HTTPException(409, "This request has already moved on.")
    swap.status = "awaiting_manager" if body.accept else "declined"
    if not body.accept:
        swap.decided_by, swap.decided_at = user.employee_id, utcnow()
    notify(db, recipient_id=swap.requester_id, title="Swap accepted" if body.accept else "Swap declined",
           body=f"Your swap on {swap.work_date} was {'accepted — waiting for manager approval' if body.accept else 'declined'}.",
           href=ROUTE)
    if body.accept:
        row = _row(db, swap.requester_id, swap.work_date)
        if row is not None and row.manager_id != user.employee_id:
            notify(db, recipient_id=row.manager_id, title="Shift swap request",
                   body=f"A shift swap on {swap.work_date} is waiting for your approval.", href=ROUTE)
    db.commit()
    return swap


@router.post("/swaps/{swap_id}/cancel", response_model=ShiftSwapOut)
def cancel_swap(swap_id: str, db: DbSession, user: CurrentUserDep) -> ShiftSwap:
    swap = db.get(ShiftSwap, swap_id)
    if swap is None or swap.requester_id != user.employee_id:
        raise NOT_FOUND
    if swap.status not in ("awaiting_teammate", "awaiting_manager"):
        raise HTTPException(409, "This request is already closed.")
    swap.status, swap.decided_at = "cancelled", utcnow()
    db.commit()
    return swap


@router.post("/swaps/{swap_id}/decision", response_model=ShiftSwapOut)
def decide_swap(swap_id: str, body: ShiftSwapDecisionIn, request: Request, db: DbSession, user: CurrentUserDep) -> ShiftSwap:
    """Approval re-checks the roster rules and coverage; a new gap is refused unless allow_gaps."""
    swap = db.get(ShiftSwap, swap_id)
    if swap is None:
        raise NOT_FOUND
    a, b = db.get(Employee, swap.requester_id), db.get(Employee, swap.teammate_id)
    if not (a and b and can_decide(db, user, a) and can_decide(db, user, b)):
        raise HTTPException(403, "Only the manager of both people (or HR) can decide this swap.")
    if swap.status != "awaiting_manager":
        raise HTTPException(409, "This swap isn't waiting for approval.")
    note = (body.note or "").strip()
    if body.decision == "reject" and len(note) < 3:
        raise HTTPException(422, "Add a reason for rejecting.")
    if body.decision == "approve":
        today = _today(user)
        if swap.work_date <= today:
            raise HTTPException(409, "That date has passed.")
        mine, theirs = _row(db, swap.requester_id, swap.work_date), _row(db, swap.teammate_id, swap.work_date)
        if (mine is None or theirs is None or mine.shift_id != swap.requester_shift_id
                or theirs.shift_id != swap.teammate_shift_id):
            raise HTTPException(409, "The roster changed since this request — ask for a new swap.")
        error = _swap_rule_error(db, mine, theirs)
        if error:
            raise HTTPException(409, error)
        ws = rules.week_start_of(swap.work_date)
        before = [g for g in rules.coverage_gaps(db, mine.manager_id, ws, today) if g.date == swap.work_date]
        after = [g for g in rules.coverage_gaps(db, mine.manager_id, ws, today,
                                                {mine.id: swap.teammate_shift_id, theirs.id: swap.requester_shift_id})
                 if g.date == swap.work_date]
        fresh = rules.new_gaps(before, after)
        if fresh and not body.allow_gaps:
            raise HTTPException(409, {"message": f"This swap leaves {rules.describe(fresh)} under-covered.",
                                      "gaps": [_slot(g).model_dump(mode="json") for g in fresh]})
        mine.shift_id, theirs.shift_id = swap.teammate_shift_id, swap.requester_shift_id
        if fresh and mine.manager_id != user.employee_id:
            notify(db, recipient_id=mine.manager_id, title="Coverage alert",
                   body=f"An approved swap leaves {rules.describe(fresh)} under-covered.", href=ROUTE)
    swap.status = "approved" if body.decision == "approve" else "rejected"
    swap.decided_by, swap.decided_at, swap.decision_note = user.employee_id, utcnow(), note or None
    for pid in (swap.requester_id, swap.teammate_id):
        notify(db, recipient_id=pid, title=f"Shift swap {swap.status}", body=f"The swap on {swap.work_date} was {swap.status}.",
               href=ROUTE)
    record_audit(db, actor_id=user.id, action=f"shift_swap_{swap.status}", entity="shift_swap", entity_id=swap.id,
                 subject_id=swap.requester_id, after={"status": swap.status}, ip=client_ip(request))
    db.commit()
    return swap


# ---------- coverage ----------
@router.get("/coverage", response_model=list[CoverageMinimumOut])
def list_coverage(db: DbSession, user: CurrentUserDep, scope: str | None = None) -> list[CoverageMinimum]:
    stmt = select(CoverageMinimum)
    if scope:
        stmt = stmt.where(CoverageMinimum.scope == scope)
    return list(db.scalars(stmt.order_by(CoverageMinimum.scope, CoverageMinimum.shift_id, CoverageMinimum.weekday)))


@router.put("/coverage", response_model=CoverageMinimumOut)
def set_coverage(body: CoverageMinimumIn, request: Request, db: DbSession, user: CurrentUserDep) -> CoverageMinimum:
    """HR sets any scope (including the company default "*"); a manager sets their own team's."""
    if not _is_hr(user):
        if body.scope == rules.COMPANY_SCOPE:
            raise HTTPException(403, "Only HR can set company minimums.")
        if body.scope != user.employee_id or not rules.team_ids(db, user.employee_id or ""):
            raise HTTPException(403, "You can set minimums for your own team only.")
    shift = db.get(ShiftType, body.shift_id)
    if shift is None:
        raise HTTPException(422, "That shift no longer exists.")
    if shift.weekend_only and body.weekday not in (0, 6) and body.minimum > 0:
        raise HTTPException(422, f"{shift.name} runs only on weekends.")
    before = rules.coverage_minimum(db, body.scope, shift, body.weekday)
    row = db.scalar(select(CoverageMinimum).where(CoverageMinimum.scope == body.scope, CoverageMinimum.shift_id == shift.id,
                                                  CoverageMinimum.weekday == body.weekday))
    if row is None:
        row = CoverageMinimum(scope=body.scope, shift_id=shift.id, weekday=body.weekday, minimum=body.minimum)
        db.add(row)
    else:
        row.minimum = body.minimum
    db.flush()
    record_audit(db, actor_id=user.id, action="coverage_minimum_set", entity="coverage_minimum",
                 entity_id=f"{body.scope}:{shift.id}:{body.weekday}", before={"minimum": before},
                 after={"minimum": body.minimum}, ip=client_ip(request))
    db.commit()
    return row
