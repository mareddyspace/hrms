"""Recent HR activity for the HR / admin / CEO home cards that look at "this period" (runs after app.seed_fill_gaps).

Insert-only and idempotent, so it is safe on the live database: every row has a fixed id (``hrp-...``), is added only
when that id is missing, and nothing existing is ever updated or deleted. No Employee row is added or changed (the
directory total and headcount stay as they are). People are picked deterministically (ordered by id) and dates are
relative to the day the seed runs.

1. Offers in the last 30 days on open requisitions (Offer acceptance, Time to hire): two internal applicants who
   accepted (internal moves need no new directory record; HR records the transfer), one external candidate who
   declined, and one offer sent and waiting for an answer. Each candidate gets a stage history and the offer the
   hiring manager and HR approved, as in app/routers/recruiting.py.
2. A resignation with early release (last working day in about two weeks), approved by the manager and waiting for
   HR (Exits). Status "Submitted" with the manager's step done, as app/services/exits.py leaves it; the employee's
   status only changes when HR approves.
3. Approved leave this week (Team absence & cover) for three workbook people in different teams, from today (or the
   next working day) for one to three working days. Ids carry the ISO week, so each new week gets its own rows; a
   person with leave or a check-in on those days is skipped.

New joiners are not added here: a joiner needs a directory record (joiners.employee_id), see app/seed_demo.py.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    AttendanceSession,
    Candidate,
    CandidateStage,
    Employee,
    ExitCase,
    LeaveRequest,
    LifecycleAction,
    Offer,
    Requisition,
)

HR, RECRUITER = "demo-hr-admin", "demo-recruiter"
SIGN_INS = ("emp-mahesh", "emp-priya", "emp-oliver", "emp-ram", HR, RECRUITER, "demo-ceo", "demo-admin")
NOT_SAMPLED = set(SIGN_INS) | {"TZ0901"}
CURRENCY = {"IN": "INR", "GB": "GBP", "US": "USD", "CA": "CAD", "AU": "AUD", "DE": "EUR", "AE": "AED", "SA": "SAR"}
PATH = ["Applied", "Screening", "Shortlisted", "Interview", "Assessment", "Final Review", "Offer"]


def _at(day: date, hour: int = 10) -> datetime:
    return datetime.combine(day, time(hour, 0), tzinfo=UTC)


def _workday(day: date, step: int = 1) -> date:
    while day.weekday() >= 5:
        day += timedelta(days=step)
    return day


def _pool(db: Session, today: date, country: str, department: str | None = None) -> list[Employee]:
    """Active, permanent workbook people with a manager, joined over a year ago, with no exit, lifecycle action or
    application of their own (ordered by id, newest ids first so the HR activity samples are not reused)."""
    busy = {*db.scalars(select(ExitCase.employee_id)), *db.scalars(select(LifecycleAction.employee_id)),
            *db.scalars(select(Candidate.employee_id).where(Candidate.employee_id.is_not(None)))}
    stmt = select(Employee).where(
        Employee.id.not_in(NOT_SAMPLED), Employee.country_code == country, Employee.employment_status == "Active",
        Employee.manager_id.is_not(None), Employee.manager_id.not_in(NOT_SAMPLED),
        Employee.joining_date <= today - timedelta(days=400), Employee.id.not_in(busy or {""}),
    )
    if department:
        stmt = stmt.where(Employee.department == department)
    rows = db.scalars(stmt.order_by(Employee.id.desc()).limit(200))
    return [e for e in rows if (e.employment_type or "").lower().replace("-", " ").startswith("full")]


# ---------- 1. offers ----------
# id suffix, requisition, internal (from that department) or (name, email, source), years, skills,
# sent (days ago), answer: (status, days ago, note) or None (still open), grade, base salary
OFFERS: list[tuple[Any, ...]] = [
    ("1", "JOB-221", "Engineering", 7.0, ["React", "TypeScript", "Design systems"], 20,
     ("accepted", 14, "Happy to move across; can start after handing over the current sprint."), "L6", 3_400_000.0),
    ("2", "JOB-235", "Engineering", 5.0, ["Python", "SQL", "Airflow"], 11,
     ("accepted", 6, "Accepted. Agreed a two-week handover with my current manager."), "L5", 2_600_000.0),
    ("3", "JOB-238", ("Hannah Brooks", "hannah.brooks@example.com", "LinkedIn"), 6.0,
     ["Customer onboarding", "Renewals", "Gainsight"], 18,
     ("declined", 11, "Thank you for the offer; I have accepted a counter-offer from my current employer."), "L5", 52_000.0),
    ("4", "JOB-221", ("Rahul Menon", "rahul.menon@example.com", "Referral"), 8.0,
     ["React", "Node.js", "GraphQL"], 3, None, "L6", 3_600_000.0),
]


def _offers(db: Session, today: date) -> int:
    added = 0
    for suffix, rid, who, years, skills, sent_ago, answer, grade, salary in OFFERS:
        oid, cid = f"hrp-offer-{suffix}", f"hrp-cand-{suffix}"
        req = db.get(Requisition, rid)
        if db.get(Offer, oid) is not None or db.get(Candidate, cid) is not None or req is None or req.status != "approved":
            continue
        approved_on = req.decided_on or req.raised_on
        sent = max(today - timedelta(days=sent_ago), approved_on + timedelta(days=14))
        if sent > today:
            continue
        applied = max(approved_on + timedelta(days=1), sent - timedelta(days=21))
        if isinstance(who, str):  # internal applicant from the requisition's department
            emp = next((e for e in _pool(db, today, req.country_code, who)
                        if e.id != req.hiring_manager_id and e.manager_id != req.hiring_manager_id), None)
            if emp is None:
                continue
            name, email, source, emp_id = emp.full_name, emp.email, "Internal", emp.id
        else:
            name, email, source = who
            emp_id = None
            if db.scalar(select(Candidate.id).where(Candidate.email == email)) is not None:
                continue
        status, answered_ago, note = answer if answer else ("sent", None, None)
        responded = max(sent + timedelta(days=1), today - timedelta(days=answered_ago)) if answered_ago is not None else None
        if responded is not None and responded > today:
            responded = today
        stage = "Hired" if status == "accepted" else "Offer"  # a declined offer leaves the candidate at Offer
        db.add(Candidate(id=cid, requisition_id=rid, name=name, email=email, phone=None, source=source,
                         experience_years=years, skills=skills,
                         cv_note=f"{years:g} years; {', '.join(skills[:2])}." + (" Internal applicant." if emp_id else ""),
                         applied_on=applied, stage=stage, created_by=RECRUITER, employee_id=emp_id))
        db.flush()
        steps = PATH + ([stage] if stage != "Offer" else [])
        span = max((sent - applied).days, 1)
        for i, s in enumerate(steps):
            if s == "Offer":
                on = sent - timedelta(days=2)
            elif s == "Hired":
                on = responded or sent
            else:
                on = applied + timedelta(days=round(i * (span - 3) / 6))
            by = req.hiring_manager_id if s in ("Final Review", "Offer") else RECRUITER
            db.add(CandidateStage(candidate_id=cid, stage=s, entered_at=_at(on, 9 + i % 6), by_id=by,
                                  note="Accepted the offer" if s == "Hired" else None))
        start = _workday(today + timedelta(days=21 if emp_id else 35))
        approvals = [{"role": "hiring_manager", "by_id": req.hiring_manager_id, "at": _at(sent - timedelta(days=2), 11).isoformat()},
                     {"role": "hr", "by_id": HR, "at": _at(sent - timedelta(days=1), 15).isoformat()}]
        db.add(Offer(id=oid, candidate_id=cid, requisition_id=rid, grade=grade, base_salary=salary,
                     currency=CURRENCY.get(req.country_code, "USD"), start_date=start,
                     package_note=("Internal move; current benefits continue." if emp_id else "Standard benefits; hybrid working."),
                     status=status, approvals=approvals, created_by=RECRUITER, sent_on=sent,
                     response_note=note, responded_on=responded,
                     response_recorded_by=RECRUITER if responded else None,
                     responded_via="recorded" if responded else None,
                     created_at=_at(sent - timedelta(days=3)), updated_at=_at(responded or sent, 16)))
        added += 1
    return added


# ---------- 2. exit in progress ----------
def _exit(db: Session, today: date) -> int:
    from app.seed_hr_activity import _past_manager
    from app.services import approvals as engine
    from app.services.exits import notice_days_for, open_case_for
    from app.services.workflow_defaults import ensure_default

    if db.get(ExitCase, "hrp-exit-early") is not None:
        return 0
    emp = next((e for e in _pool(db, today, "IN") if open_case_for(db, e.id) is None), None)
    if emp is None:
        return 0
    notice = notice_days_for(db, emp)
    submitted = _workday(today - timedelta(days=18), -1)
    standard = submitted + timedelta(days=notice)
    last = _workday(today + timedelta(days=12))
    if last >= standard:  # short notice: no early release needed
        last = standard
    case = ExitCase(id="hrp-exit-early", employee_id=emp.id, exit_type="resignation", submitted_on=submitted,
                    requested_last_day=last, standard_last_day=standard, notice_days=notice,
                    early_release=last < standard, reason="Relocating abroad with my family at the end of the month.",
                    note="Requesting early release; handover can be completed in two weeks.", status="Submitted",
                    raised_by=emp.id, clearance=[], settlement={"status": "Pending"},
                    details={"early_release_reason": "Visa date for the move is fixed." if last < standard else None,
                             "handover_plan": "Hand over the open tickets and runbooks to the team over the next two weeks."},
                    created_at=_at(submitted, 9), updated_at=_at(submitted, 9))
    db.add(case)
    db.flush()
    ensure_default(db, "exit")
    inst = engine.start(db, "exit", case.id, emp, None, actor_id=emp.id, context={"via_manager": True}, fallback=False)
    case.approval_instance_id = inst.id
    _past_manager(db, inst, "Discussed the move; supporting the early release once handover is planned.")
    return 1


# ---------- 3. approved leave this week ----------
LEAVE = [  # (department, leave code, working days, reason)
    ("Engineering", "pto", 3, "Family function out of town"),
    ("Sales", "sick", 1, "Fever; resting at home"),
    ("Customer Success", "pto", 2, "Moving house"),
]


def _leave(db: Session, today: date) -> int:
    from app.services.leave import holiday_dates, working_days

    year, week, _ = today.isocalendar()
    added, teams = 0, set()
    for n, (dept, code, length, reason) in enumerate(LEAVE, start=1):
        lid = f"hrp-lv-{year}w{week:02d}-{n}"
        if db.get(LeaveRequest, lid) is not None:
            continue
        start = _workday(today)
        for emp in _pool(db, today, "IN", dept) or _pool(db, today, "IN"):
            if emp.manager_id in teams:
                continue
            holidays = holiday_dates(db, emp.country_code, start, start + timedelta(days=10))
            begin = start
            while begin in holidays or begin.weekday() >= 5:
                begin += timedelta(days=1)
            end = begin
            for _ in range(length - 1):
                end += timedelta(days=1)
                while end in holidays or end.weekday() >= 5:
                    end += timedelta(days=1)
            days = working_days(begin, end, holidays)
            overlap = db.scalar(select(LeaveRequest.id).where(
                LeaveRequest.employee_id == emp.id, LeaveRequest.status.in_(("pending", "approved")),
                LeaveRequest.from_date <= end, LeaveRequest.to_date >= begin))
            worked = db.scalar(select(AttendanceSession.id).where(
                AttendanceSession.employee_id == emp.id, AttendanceSession.work_date.between(begin, end)))
            if days <= 0 or overlap is not None or worked is not None:
                continue
            decided = _at(today - timedelta(days=0 if code == "sick" else 4), 9)
            db.add(LeaveRequest(id=lid, employee_id=emp.id, leave_code=code, from_date=begin, to_date=end, half="none",
                                days=days, reason=reason, status="approved", decided_by=emp.manager_id,
                                decided_at=decided, decision_note=None, handover_to=None,
                                created_at=decided - timedelta(hours=2 if code == "sick" else 26), updated_at=decided))
            teams.add(emp.manager_id)
            added += 1
            break
    return added


def seed(db: Session) -> dict[str, int]:
    db.flush()
    today = date.today()
    stats = {"hrp_offers_added": _offers(db, today)}
    db.flush()
    stats["hrp_exits_added"] = _exit(db, today)
    db.flush()
    stats["hrp_leave_added"] = _leave(db, today)
    db.flush()
    return stats
