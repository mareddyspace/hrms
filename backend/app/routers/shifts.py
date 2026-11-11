"""Shift types, weekly rosters, swaps and coverage minimums (rules in app/services/shifts.py).

Managers roster their direct reports and publish weeks; HR manages shift types and the company coverage
defaults; a manager may set their own team's minimums. Employees see their published shifts and request swaps
with a teammate on the same roster; the teammate accepts, then the manager (or HR) approves.
"""

from __future__ import annotations

import secrets
from datetime import date, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.db import utcnow
from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import (
    CompOffCredit, CoverageMinimum, Employee, RosterShift, RosterWeek, ShiftAvailability, ShiftSwap, ShiftType,
)
from app.schemas.engagement_shifts import (
    AvailabilityIn, AvailabilityOut, CoverageMinimumIn, CoverageMinimumOut, CoverageSlotOut, RosterAssignIn, RosterBulkIn,
    RosterBulkOut, RosterCopyIn, RosterPublishIn, RosterShiftOut, RosterSkipOut, RosterUnpublishIn, RosterWarningOut,
    RosterWeekOut, ShiftSwapDecisionIn, ShiftSwapIn, ShiftSwapOut, ShiftSwapRespondIn, ShiftTypeIn, ShiftTypeOut,
    TeamCalendarRowOut,
)
from app.services import shifts as rules
from app.services.activity import notify, record_audit
from app.services.decisions import NOT_FOUND, can_decide, me
from app.services.leave import today_for
from app.services.scope import HR_ACCESS_ROLES

router = APIRouter(prefix="/shifts", tags=["shifts"])
ROUTE = "/workforce/shifts"


def _is_hr(user: CurrentUser) -> bool:
    return user.account.role in HR_ACCESS_ROLES


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
    """Create (no id or a new id) or update a shift type. HR only. Hours can't change while it is on upcoming roster
    days (people were told those times); it can't be turned off while it is."""
    if not _is_hr(user):
        raise HTTPException(403, "Only HR can manage shift types.")
    color = (body.color or "").strip().lower() or None
    country = (body.country_code or "").strip().upper() or None
    error = rules.shift_type_error(body.start, body.end, body.break_minutes, color, country)
    if error:
        raise HTTPException(422, error)
    row = db.get(ShiftType, body.id) if body.id else None
    clash = db.scalar(select(ShiftType).where(ShiftType.name == body.name.strip()))
    if clash is not None and (row is None or clash.id != row.id):
        raise HTTPException(409, "A shift with this name already exists.")
    before = None
    if row is None:
        row = ShiftType(id=body.id or f"sh-{secrets.token_hex(4)}")
        db.add(row)
    else:
        before = {"name": row.name, "start": row.start, "end": row.end, "break_minutes": row.break_minutes,
                  "active": row.active, "color": row.color, "country_code": row.country_code}
        upcoming = db.scalar(select(func.count()).select_from(RosterShift).where(
            RosterShift.shift_id == row.id, RosterShift.work_date > _today(user))) or 0
        changed_hours = (row.start, row.end, row.weekend_only, row.break_minutes) != (
            body.start, body.end, body.weekend_only, body.break_minutes)
        if upcoming and changed_hours:
            raise HTTPException(409, f"{row.name} is on {upcoming} upcoming roster day(s). Clear those before changing its hours.")
        if upcoming and row.active and not body.active:
            raise HTTPException(409, f"{row.name} is on {upcoming} upcoming roster day(s). Clear those first.")
        if upcoming and country and country != (row.country_code or "").upper():
            raise HTTPException(409, f"{row.name} is on {upcoming} upcoming roster day(s). Clear those before changing its country.")
    row.name, row.start, row.end = body.name.strip(), body.start, body.end
    row.weekend_only, row.active = body.weekend_only, body.active
    row.break_minutes, row.location = body.break_minutes, (body.location or "").strip() or None
    row.color, row.country_code = color, country
    db.flush()
    record_audit(db, actor_id=user.id, action="shift_type_saved", entity="shift_type", entity_id=row.id, before=before,
                 after={"name": row.name, "start": row.start, "end": row.end, "break_minutes": row.break_minutes,
                        "active": row.active, "color": row.color, "country_code": row.country_code}, ip=client_ip(request))
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
        warnings=_warnings(db, shifts, today),
    )


def _warnings(db: DbSession, rows: list[RosterShift], today: date) -> list[RosterWarningOut]:
    out = []
    for r in rows:
        shift = db.get(ShiftType, r.shift_id)
        if shift is None or r.work_date <= today:
            continue
        out += [RosterWarningOut(employee_id=r.employee_id, date=r.work_date, message=m)
                for m in rules.assign_warnings(db, r.employee_id, r.work_date, shift)]
    return out


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


def _apply(db: DbSession, user: CurrentUser, manager: Employee, emp_id: str, d: date, shift_id: str | None,
           request: Request) -> tuple[int, str] | None:
    """Put one shift on (or clear) one person-day on the manager's roster. Returns (status, broken rule) or None."""
    if emp_id == manager.id:
        return 422, "You can't roster yourself."
    if emp_id not in rules.team_ids(db, manager.id):
        return 403, "That person isn't in your team."
    joiner = rules.starts_after(db, emp_id, d) if shift_id is not None else None
    if joiner is not None:
        return 422, f"{joiner.full_name} starts on {joiner.joining_date}."
    if d <= _today(user):
        return 422, "Past days and today are locked."
    existing = _row(db, emp_id, d)
    if existing is not None and existing.manager_id != manager.id:
        return 409, "That person is on another manager's roster that day."
    ws = rules.week_start_of(d)
    week = rules.roster_week(db, manager.id, ws)
    published = week is not None and week.status == "published"
    before = existing.shift_id if existing else None
    if shift_id is None:
        if existing is None:
            return None
        db.delete(existing)
        if published:
            notify(db, recipient_id=emp_id, title="Shift removed", body=f"Your shift on {d} was removed from the roster.", href=ROUTE)
    else:
        shift = db.get(ShiftType, shift_id)
        if shift is None:
            return 422, "That shift no longer exists."
        if not shift.active:
            return 422, f"{shift.name} is no longer in use."
        if existing is not None and existing.shift_id == shift_id:
            return None
        error = rules.rule_error(db, emp_id, d, shift, {existing.id} if existing else set())
        if error:
            return 409, error
        if existing is not None:
            existing.shift_id = shift.id
        else:
            db.add(RosterShift(id=f"rs-{secrets.token_hex(6)}", employee_id=emp_id, work_date=d, shift_id=shift.id,
                               manager_id=manager.id))
        if week is None:
            db.add(RosterWeek(manager_id=manager.id, week_start=ws, status="draft"))
        if published:
            notify(db, recipient_id=emp_id, title="Shift changed",
                   body=f"You're now on {shift.name} ({shift.start}-{shift.end}) on {d}.", href=ROUTE)
    db.flush()
    record_audit(db, actor_id=user.id, action="roster_assigned", entity="roster_shift", entity_id=f"{emp_id}:{d}",
                 subject_id=emp_id, before={"shift_id": before}, after={"shift_id": shift_id}, ip=client_ip(request))
    return None


@router.post("/roster/assign", response_model=RosterWeekOut)
def assign(body: RosterAssignIn, request: Request, db: DbSession, user: CurrentUserDep) -> RosterWeekOut:
    manager = me(user)
    error = _apply(db, user, manager, body.employee_id, body.work_date, body.shift_id, request)
    if error:
        db.rollback()
        raise HTTPException(*error)
    db.commit()
    return _week_out(db, manager.id, rules.week_start_of(body.work_date), _today(user))


def _bulk(db: DbSession, user: CurrentUser, manager: Employee, cells: list[tuple[str, date, str | None]],
          request: Request) -> RosterBulkOut:
    applied, skipped, warnings = 0, [], []
    for emp_id, d, shift_id in cells:
        error = _apply(db, user, manager, emp_id, d, shift_id, request)
        if error:
            skipped.append(RosterSkipOut(employee_id=emp_id, date=d, message=error[1]))
            continue
        applied += 1
        shift = db.get(ShiftType, shift_id) if shift_id else None
        if shift is not None:
            warnings += [RosterWarningOut(employee_id=emp_id, date=d, message=m)
                         for m in rules.assign_warnings(db, emp_id, d, shift)]
    db.commit()
    return RosterBulkOut(applied=applied, skipped=skipped, warnings=warnings)


@router.post("/roster/bulk", response_model=RosterBulkOut)
def bulk_assign(body: RosterBulkIn, request: Request, db: DbSession, user: CurrentUserDep) -> RosterBulkOut:
    """One shift (or clear) for several people on several days; each cell is checked on its own and skipped with its
    reason when a rule is broken."""
    manager = me(user)
    cells = [(e, d, body.shift_id) for e in dict.fromkeys(body.employee_ids) for d in sorted(set(body.dates))]
    return _bulk(db, user, manager, cells, request)


@router.post("/roster/copy-week", response_model=RosterBulkOut)
def copy_week(body: RosterCopyIn, request: Request, db: DbSession, user: CurrentUserDep) -> RosterBulkOut:
    """Copy a week's pattern into the following week(s) (repeat pattern). Only empty upcoming days are filled;
    days that already have a shift are kept."""
    manager = me(user)
    src, dst = _monday(body.from_week), _monday(body.to_week)
    if dst == src:
        raise HTTPException(422, "Pick a different week to copy into.")
    days = rules.week_dates(src)
    rows = list(db.scalars(select(RosterShift).where(RosterShift.manager_id == manager.id, RosterShift.work_date >= days[0],
                                                     RosterShift.work_date <= days[-1])))
    if not rows:
        raise HTTPException(409, "That week has no shifts to copy.")
    cells = []
    for n in range(body.weeks):
        offset = (dst - src).days + 7 * n
        for r in sorted(rows, key=lambda x: (x.work_date, x.employee_id)):
            d = r.work_date + timedelta(days=offset)
            if d > _today(user) and _row(db, r.employee_id, d) is None:
                cells.append((r.employee_id, d, r.shift_id))
    return _bulk(db, user, manager, cells, request)


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


@router.post("/roster/unpublish", response_model=RosterWeekOut)
def unpublish(body: RosterUnpublishIn, request: Request, db: DbSession, user: CurrentUserDep) -> RosterWeekOut:
    """Take an upcoming published week back to draft (with a reason). Open swaps in that week are cancelled and the
    team is told. A week that has started can't be unpublished: change single days instead."""
    manager = me(user)
    ws = _monday(body.week_start)
    today = _today(user)
    week = rules.roster_week(db, manager.id, ws)
    if week is None or week.status != "published":
        raise HTTPException(409, "This week isn't published.")
    if ws <= today:
        raise HTTPException(409, "This week has started. Change single days instead.")
    days = rules.week_dates(ws)
    rows = list(db.scalars(select(RosterShift).where(RosterShift.manager_id == manager.id, RosterShift.work_date >= days[0],
                                                     RosterShift.work_date <= days[-1])))
    people = sorted({r.employee_id for r in rows})
    reason = body.reason.strip()
    for swap in db.scalars(select(ShiftSwap).where(ShiftSwap.work_date >= days[0], ShiftSwap.work_date <= days[-1],
                                                   ShiftSwap.status.in_(("awaiting_teammate", "awaiting_manager")),
                                                   ShiftSwap.requester_id.in_(people))):
        swap.status, swap.decided_by, swap.decided_at = "cancelled", manager.id, utcnow()
        swap.decision_note = "Roster taken back to draft."
    week.status, week.published_at, week.published_by, week.published_with_gaps = "draft", None, None, False
    for pid in people:
        notify(db, recipient_id=pid, title="Roster being changed",
               body=f"Your shifts for the week of {ws} were taken back to draft: {reason}", href=ROUTE)
    record_audit(db, actor_id=user.id, action="roster_unpublished", entity="roster_week", entity_id=f"{manager.id}:{ws}",
                 before={"status": "published"}, after={"status": "draft", "reason": reason}, ip=client_ip(request))
    db.commit()
    return _week_out(db, manager.id, ws, today)


@router.get("/mine", response_model=list[RosterShiftOut])
def my_shifts(db: DbSession, user: CurrentUserDep, from_date: date | None = None,
              to_date: date | None = None) -> list[RosterShiftOut]:
    rows = db.scalars(select(RosterShift).where(RosterShift.employee_id == (user.employee_id or ""),
                                                RosterShift.work_date >= (from_date or date.min),
                                                RosterShift.work_date <= (to_date or date.max)).order_by(RosterShift.work_date))
    return [RosterShiftOut.model_validate(r) for r in rows if rules.is_published(db, r)]


@router.get("/team-calendar", response_model=list[TeamCalendarRowOut])
def team_calendar(db: DbSession, user: CurrentUserDep, from_date: date, to_date: date) -> list[TeamCalendarRowOut]:
    """Published shifts on my team roster(s): my manager's roster, any roster I'm on, and my own when I manage one.
    Only names and shift ids (no leave or other personal details)."""
    if to_date < from_date or (to_date - from_date).days > 62:
        raise HTTPException(422, "Pick up to two months.")
    emp_id = user.employee_id or ""
    managers = {emp_id} if rules.team_ids(db, emp_id) else set()
    if user.employee is not None and user.employee.manager_id:
        managers.add(user.employee.manager_id)
    managers |= set(db.scalars(select(RosterShift.manager_id).where(
        RosterShift.employee_id == emp_id, RosterShift.work_date >= from_date, RosterShift.work_date <= to_date)))
    if not managers:
        return []
    rows = db.scalars(select(RosterShift).where(RosterShift.manager_id.in_(managers), RosterShift.work_date >= from_date,
                                                RosterShift.work_date <= to_date).order_by(RosterShift.work_date))
    names: dict[str, str] = {}
    out = []
    for r in rows:
        if not rules.is_published(db, r):
            continue
        if r.employee_id not in names:
            names[r.employee_id] = _name(db, r.employee_id)
        out.append(TeamCalendarRowOut(employee_id=r.employee_id, full_name=names[r.employee_id], date=r.work_date,
                                      shift_id=r.shift_id))
    return out


# ---------- availability (migration 0034) ----------
MAX_AVAILABILITY = 60


@router.get("/availability", response_model=list[AvailabilityOut])
def list_availability(db: DbSession, user: CurrentUserDep,
                      employee_id: Annotated[str | None, Query(max_length=64)] = None) -> list[ShiftAvailability]:
    """My upcoming availability entries; a manager may read a team member's, or the whole team's with employee_id=team."""
    emp_id = user.employee_id or ""
    if employee_id == "team":
        ids = rules.team_ids(db, emp_id)
    elif employee_id and employee_id != emp_id:
        person = db.get(Employee, employee_id)
        if person is None or not (person.manager_id == emp_id or can_decide(db, user, person)):
            raise NOT_FOUND
        ids = [employee_id]
    else:
        ids = [emp_id]
    if not ids:
        return []
    today = _today(user)
    rows = db.scalars(select(ShiftAvailability).where(ShiftAvailability.employee_id.in_(ids))
                      .order_by(ShiftAvailability.employee_id, ShiftAvailability.created_at))
    return [r for r in rows if r.work_date is None or r.work_date > today]


@router.post("/availability", response_model=AvailabilityOut, status_code=status.HTTP_201_CREATED)
def add_availability(body: AvailabilityIn, request: Request, db: DbSession, user: CurrentUserDep) -> ShiftAvailability:
    """Mark a day (or a weekday every week) unavailable, or a preferred shift. The roster warns my manager when they
    assign against it; if I'm already rostered on that day, my manager is told."""
    emp = me(user)
    if (body.work_date is None) == (body.weekday is None):
        raise HTTPException(422, "Pick a date or a weekday.")
    today = _today(user)
    if body.work_date is not None and body.work_date <= today:
        raise HTTPException(422, "Pick an upcoming date.")
    if body.work_date is not None and body.work_date > today + timedelta(days=365):
        raise HTTPException(422, "Pick a date within the next year.")
    shift_id = None
    if body.kind == "preferred":
        shift = db.get(ShiftType, body.shift_id or "")
        if shift is None or not shift.active:
            raise HTTPException(422, "Pick the shift you prefer.")
        shift_id = shift.id
    mine = list(db.scalars(select(ShiftAvailability).where(ShiftAvailability.employee_id == emp.id)))
    if len(mine) >= MAX_AVAILABILITY:
        raise HTTPException(409, f"You can keep up to {MAX_AVAILABILITY} entries. Remove old ones first.")
    if any(m.work_date == body.work_date and m.weekday == body.weekday for m in mine):
        raise HTTPException(409, "You already have an entry for that day.")
    row = ShiftAvailability(id=f"av-{secrets.token_hex(6)}", employee_id=emp.id, kind=body.kind, work_date=body.work_date,
                            weekday=body.weekday, shift_id=shift_id, note=(body.note or "").strip() or None)
    db.add(row)
    db.flush()
    if body.kind == "unavailable":
        rostered = [r for r in db.scalars(select(RosterShift).where(RosterShift.employee_id == emp.id,
                                                                    RosterShift.work_date > today))
                    if (r.work_date == body.work_date if body.work_date else rules.portal_weekday(r.work_date) == body.weekday)]
        for mid in sorted({r.manager_id for r in rostered}):
            when = f"on {body.work_date.isoformat()}" if body.work_date else f"every {rules.DAY_NAMES[body.weekday or 0]}"
            notify(db, recipient_id=mid, title="Availability change",
                   body=f"{emp.full_name} is unavailable {when} but is on your roster then.", href=ROUTE)
    record_audit(db, actor_id=user.id, action="shift_availability_added", entity="shift_availability", entity_id=row.id,
                 subject_id=emp.id, after={"kind": row.kind, "date": row.work_date, "weekday": row.weekday,
                                           "shift_id": row.shift_id}, ip=client_ip(request))
    db.commit()
    return row


@router.delete("/availability/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_availability(entry_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> None:
    row = db.get(ShiftAvailability, entry_id)
    if row is None or row.employee_id != user.employee_id:
        raise NOT_FOUND
    record_audit(db, actor_id=user.id, action="shift_availability_removed", entity="shift_availability", entity_id=row.id,
                 subject_id=row.employee_id, before={"kind": row.kind, "date": row.work_date, "weekday": row.weekday},
                 ip=client_ip(request))
    db.delete(row)
    db.commit()


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
def respond_swap(swap_id: str, body: ShiftSwapRespondIn, request: Request, db: DbSession, user: CurrentUserDep) -> ShiftSwap:
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
    record_audit(db, actor_id=user.id, action="shift_swap_accepted" if body.accept else "shift_swap_declined",
                 entity="shift_swap", entity_id=swap.id, subject_id=swap.requester_id, after={"status": swap.status},
                 ip=client_ip(request))
    db.commit()
    return swap


@router.post("/swaps/{swap_id}/cancel", response_model=ShiftSwapOut)
def cancel_swap(swap_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> ShiftSwap:
    swap = db.get(ShiftSwap, swap_id)
    if swap is None or swap.requester_id != user.employee_id:
        raise NOT_FOUND
    if swap.status not in ("awaiting_teammate", "awaiting_manager"):
        raise HTTPException(409, "This request is already closed.")
    swap.status, swap.decided_at = "cancelled", utcnow()
    notify(db, recipient_id=swap.teammate_id, title="Swap cancelled", body=f"The swap request for {swap.work_date} was cancelled.",
           href=ROUTE)
    record_audit(db, actor_id=user.id, action="shift_swap_cancelled", entity="shift_swap", entity_id=swap.id,
                 subject_id=swap.requester_id, after={"status": "cancelled"}, ip=client_ip(request))
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
                 subject_id=swap.requester_id, after={"status": swap.status, "note": note or None}, ip=client_ip(request))
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


# ---------- comp-off (migration 0025) ----------
class CompOffCreditOut(BaseModel):
    id: str
    employee_id: str
    employee_name: str
    worked_date: date
    days: float
    reason: str
    granted_by_name: str
    granted_on: date
    expires_on: date
    expired: bool


class CompOffCandidateOut(BaseModel):
    employee_id: str
    employee_name: str
    work_date: date
    shift_name: str
    reason: str


class CompOffRequestOut(BaseModel):
    id: str
    from_date: date
    to_date: date
    days: float
    reason: str
    status: str
    decided_by_name: str | None = None
    decision_note: str | None = None
    created_at: datetime


class CompOffSummaryOut(BaseModel):
    earned: float = 0
    used: float = 0
    pending: float = 0
    available: float = 0
    from_roster: float = 0
    from_overtime: float = 0
    credits: list[CompOffCreditOut] = []
    requests: list[CompOffRequestOut] = []
    team_credits: list[CompOffCreditOut] = []
    candidates: list[CompOffCandidateOut] = []


class CompOffGrantIn(BaseModel):
    employee_id: str = Field(min_length=1, max_length=64)
    work_date: date


def _name(db: DbSession, emp_id: str | None) -> str:
    emp = db.get(Employee, emp_id) if emp_id else None
    return emp.full_name if emp else (emp_id or "")


def _credit_out(db: DbSession, c: CompOffCredit, today: date) -> CompOffCreditOut:
    return CompOffCreditOut(id=c.id, employee_id=c.employee_id, employee_name=_name(db, c.employee_id),
                            worked_date=c.worked_date, days=float(c.days), reason=c.reason,
                            granted_by_name=_name(db, c.granted_by), granted_on=c.created_at.date(),
                            expires_on=c.expires_on, expired=c.expires_on < today)


def _decides(db: DbSession, user: CurrentUser, emp: Employee) -> bool:
    return emp.id != user.employee_id and (emp.manager_id == user.employee_id or can_decide(db, user, emp))


@router.get("/comp-off", response_model=CompOffSummaryOut)
def comp_off(db: DbSession, user: CurrentUserDep) -> CompOffSummaryOut:
    """My comp-off: balance (earned / used / pending / available), credits and comp-off leave requests; for a manager
    also the team's credits and the off-day shifts still waiting to be credited."""
    from app.models import LeaveRequest
    from app.services.leave import balances
    from app.services.overtime import earned_comp_off

    emp = me(user)
    today = _today(user)
    out = CompOffSummaryOut()
    row = next((b for b in balances(db, emp, today.year) if b.code == "comp_off"), None)
    if row is not None:
        out.earned, out.used, out.pending, out.available = row.quota, row.used, row.pending, row.available
    out.from_roster = rules.roster_comp_off_days(db, emp.id, today.year, today)[0]
    out.from_overtime = earned_comp_off(db, emp.id, today.year)
    out.credits = [_credit_out(db, c, today) for c in db.scalars(
        select(CompOffCredit).where(CompOffCredit.employee_id == emp.id).order_by(CompOffCredit.worked_date.desc()))]
    out.requests = [
        CompOffRequestOut(id=r.id, from_date=r.from_date, to_date=r.to_date, days=float(r.days), reason=r.reason,
                          status=r.status, decided_by_name=_name(db, r.decided_by) if r.decided_by else None,
                          decision_note=r.decision_note, created_at=r.created_at)
        for r in db.scalars(select(LeaveRequest).where(LeaveRequest.employee_id == emp.id, LeaveRequest.leave_code == "comp_off")
                            .order_by(LeaveRequest.from_date.desc()).limit(50))
    ]
    team = list(db.scalars(select(Employee).where(Employee.manager_id == emp.id)))
    team_ids = {e.id for e in team}
    if team_ids:
        credits = list(db.scalars(select(CompOffCredit).where(CompOffCredit.employee_id.in_(team_ids))
                                  .order_by(CompOffCredit.worked_date.desc())))
        out.team_credits = [_credit_out(db, c, today) for c in credits]
        credited = {(c.employee_id, c.worked_date) for c in credits}
        since = today - timedelta(days=rules.COMP_OFF_VALID_DAYS)
        by_id = {e.id: e for e in team}
        for r in db.scalars(select(RosterShift).where(RosterShift.employee_id.in_(team_ids), RosterShift.work_date < today,
                                                      RosterShift.work_date >= since).order_by(RosterShift.work_date.desc())):
            if (r.employee_id, r.work_date) in credited or not rules.is_published(db, r) or rules.on_leave(db, r.employee_id, r.work_date):
                continue
            reason = rules.comp_off_reason(db, by_id[r.employee_id], r.work_date)
            if reason:
                shift = db.get(ShiftType, r.shift_id)
                out.candidates.append(CompOffCandidateOut(employee_id=r.employee_id, employee_name=by_id[r.employee_id].full_name,
                                                          work_date=r.work_date, shift_name=shift.name if shift else r.shift_id,
                                                          reason=reason))
    return out


@router.post("/comp-off/grant", response_model=CompOffCreditOut, status_code=status.HTTP_201_CREATED)
def grant_comp_off(body: CompOffGrantIn, request: Request, db: DbSession, user: CurrentUserDep) -> CompOffCreditOut:
    """The manager credits one comp-off day for a published shift worked on a weekly off or holiday."""
    me(user)
    person = db.get(Employee, body.employee_id)
    if person is None:
        raise NOT_FOUND
    if not _decides(db, user, person):
        raise HTTPException(403, "Only someone above them in the reporting line can grant comp-off.")
    today = _today(user)
    if body.work_date >= today:
        raise HTTPException(422, "Comp-off can be granted only after the day has passed.")
    if body.work_date < today - timedelta(days=rules.COMP_OFF_VALID_DAYS):
        raise HTTPException(422, f"Too late: that day is more than {rules.COMP_OFF_VALID_DAYS} days ago.")
    reason = rules.comp_off_reason(db, person, body.work_date)
    if not reason:
        raise HTTPException(422, f"{body.work_date} is a regular working day, so there is no comp-off.")
    row = _row(db, person.id, body.work_date)
    if row is None or not rules.is_published(db, row):
        raise HTTPException(422, f"{person.full_name} was not on the published roster on {body.work_date}.")
    if rules.on_leave(db, person.id, body.work_date):
        raise HTTPException(422, f"{person.full_name} was on approved leave that day.")
    if db.scalar(select(CompOffCredit.id).where(CompOffCredit.employee_id == person.id,
                                                CompOffCredit.worked_date == body.work_date)):
        raise HTTPException(409, "Comp-off for that day is already granted.")
    credit = CompOffCredit(id=f"co-{secrets.token_hex(6)}", employee_id=person.id, worked_date=body.work_date, days=1,
                           reason=reason, granted_by=user.employee_id or "",
                           expires_on=body.work_date + timedelta(days=rules.COMP_OFF_VALID_DAYS))
    db.add(credit)
    notify(db, recipient_id=person.id, title="Comp-off credited",
           body=f"1 comp-off day for working on {body.work_date}. Use it by {credit.expires_on}.", href=ROUTE)
    db.flush()
    record_audit(db, actor_id=user.id, action="comp_off_granted", entity="comp_off_credit", entity_id=credit.id,
                 subject_id=person.id, after={"worked_date": body.work_date, "reason": reason}, ip=client_ip(request))
    db.commit()
    db.refresh(credit)
    return _credit_out(db, credit, today)
