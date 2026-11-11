"""A realistic roster for Ram's team (Babu, Priya, Oliver), so Shifts & roster makes sense in backend mode.

Runs at the end of app.seed.run(), after the plain General-shift roster (app/seed.py, app/seed_teammates.py):
- this week and next: the seeded rows ("rs-seed-…", still on General) of upcoming days are rotated weekly so each
  weekday has one person on Morning, General and Evening (the company coverage default); seeded rows on the person's
  public holiday or approved leave are removed. Past days and rows a manager changed are never touched.
- the week after next: a draft week with the same rotation, so a manager sees draft -> publish.
- weekend support isn't required for Ram's team (team rule 0 on Sat/Sun, only if Ram has no rule yet).
- swaps: the old Babu <-> Ram sample (Ram is Babu's manager) is cancelled while still open; Priya <-> Babu waits for
  Ram's decision and Oliver asks Babu (Babu responds). Insert-once by id, only when the roster rules allow.
"""

from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import CoverageMinimum, Employee, RosterShift, RosterWeek, ShiftSwap, ShiftType
from app.services import shifts as rules
from app.services.leave import holiday_dates

RAM, BABU, PRIYA, OLIVER = "emp-ram", "emp-mahesh", "emp-priya", "emp-oliver"
ORDER = (PRIYA, BABU, OLIVER)
ROTATION = ("sh-morning", "sh-general", "sh-evening")
SEED_PREFIX = "rs-seed-"


def _target(emp_id: str, week_start: date) -> str:
    """Shift for this person in this week: one shift Mon-Fri, rotating each week (stable for a given week)."""
    turn = (week_start.toordinal() // 7) % len(ROTATION)
    return ROTATION[(ORDER.index(emp_id) + turn) % len(ROTATION)]


def _off(db: Session, emp: Employee, d: date) -> bool:
    return d in holiday_dates(db, emp.country_code, d, d) or rules.on_leave(db, emp.id, d)


def _roster(db: Session, team: list[Employee], today: date) -> dict[str, int]:
    stats = {"roster_rotated": 0, "roster_removed": 0, "roster_draft_added": 0}
    shifts = {s.id: s for s in db.scalars(select(ShiftType))}
    if not all(s in shifts for s in ROTATION):
        return stats
    monday = rules.week_start_of(today)
    draft_start = monday + timedelta(days=14)
    draft_new = rules.roster_week(db, RAM, draft_start) is None
    for week_start in (monday, monday + timedelta(days=7), draft_start):
        for emp in team:
            want = shifts[_target(emp.id, week_start)]
            for offset in range(5):
                d = week_start + timedelta(days=offset)
                if d <= today:
                    continue
                row = db.scalar(select(RosterShift).where(RosterShift.employee_id == emp.id, RosterShift.work_date == d))
                if row is not None:
                    continue  # insert-only: an existing shift (seeded or real) is never changed or removed
                if week_start != draft_start or not draft_new or _off(db, emp, d) or rules.starts_after(db, emp.id, d):
                    continue
                if rules.rule_error(db, emp.id, d, want) is None:
                    db.add(RosterShift(id=f"{SEED_PREFIX}{emp.id}-{d.isoformat()}", employee_id=emp.id, work_date=d,
                                       shift_id=want.id, manager_id=RAM))
                    db.flush()
                    stats["roster_draft_added"] += 1
    if draft_new and stats["roster_draft_added"]:
        db.add(RosterWeek(manager_id=RAM, week_start=draft_start, status="draft"))
    # Weekend support isn't needed for this team (a team rule wins over the company default).
    for weekday in (0, 6):
        if db.scalar(select(CoverageMinimum.id).where(CoverageMinimum.scope == RAM, CoverageMinimum.shift_id == "sh-weekend",
                                                     CoverageMinimum.weekday == weekday)) is None and "sh-weekend" in shifts:
            db.add(CoverageMinimum(scope=RAM, shift_id="sh-weekend", weekday=weekday, minimum=0))
    db.flush()
    return stats


def _open_swap(db: Session, d: date, people: tuple[str, str]) -> bool:
    return db.scalar(select(ShiftSwap.id).where(
        ShiftSwap.work_date == d, ShiftSwap.status.in_(("awaiting_teammate", "awaiting_manager")),
        ShiftSwap.requester_id.in_(people) | ShiftSwap.teammate_id.in_(people))) is not None


def _swap(db: Session, sid: str, requester: str, teammate: str, status: str, reason: str, days: list[date]) -> int:
    if db.get(ShiftSwap, sid) is not None:
        return 0
    for d in days:
        mine = db.scalar(select(RosterShift).where(RosterShift.employee_id == requester, RosterShift.work_date == d))
        theirs = db.scalar(select(RosterShift).where(RosterShift.employee_id == teammate, RosterShift.work_date == d))
        if mine is None or theirs is None or mine.shift_id == theirs.shift_id or mine.manager_id != theirs.manager_id:
            continue
        if not rules.is_published(db, mine) or _open_swap(db, d, (requester, teammate)):
            continue
        a, b = db.get(ShiftType, theirs.shift_id), db.get(ShiftType, mine.shift_id)
        if a is None or b is None:
            continue
        if rules.rule_error(db, requester, d, a, {mine.id}, {theirs.id: b.id}) or \
                rules.rule_error(db, teammate, d, b, {theirs.id}, {mine.id: a.id}):
            continue
        db.add(ShiftSwap(id=sid, work_date=d, requester_id=requester, teammate_id=teammate, requester_shift_id=mine.shift_id,
                         teammate_shift_id=theirs.shift_id, reason=reason, status=status))
        db.flush()
        return 1
    return 0


def _swaps(db: Session, today: date) -> dict[str, int]:
    stats = {"swaps_cancelled": 0, "swaps_added": 0}
    next_week = rules.week_start_of(today) + timedelta(days=7)
    days = [next_week + timedelta(days=i) for i in range(5)]
    stats["swaps_added"] += _swap(db, "sw-seed-priya-babu", PRIYA, BABU, "awaiting_manager",
                                  "Dentist appointment in the morning; can work the later shift.", days[2:] + days[:2])
    stats["swaps_added"] += _swap(db, "sw-seed-oliver-babu", OLIVER, BABU, "awaiting_teammate",
                                  "Evening class that day; happy to swap back any time.", days[3:] + days[:3])
    return stats


def seed(db: Session) -> dict[str, int]:
    if db.get(Employee, RAM) is None:
        return {}
    team = [e for e in (db.get(Employee, i) for i in ORDER) if e is not None and e.manager_id == RAM]
    if not team:
        return {}
    today = date.today()
    stats = _roster(db, team, today)
    stats.update(_swaps(db, today))
    return {f"shift_{k}": v for k, v in stats.items()}
