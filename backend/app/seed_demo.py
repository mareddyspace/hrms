"""Small open requests so the request pages aren't empty for the demo sign-ins (called from app.seed.run()).

Insert-once by fixed id: a row that exists (or was decided, withdrawn, ...) is never touched again, and nothing is
deleted. Dates are relative to the day the seed first runs.

- Babu: a pending expense claim and a travel request, both waiting for Ram.
- HR: a joiner (Neha Kapoor, India, starts on the first Monday of next month) in pre-boarding with the India checklist.
- A probation completion past the manager step, waiting for HR; a job change Ram raised for Babu (waiting for Jordan).
- A shift swap Babu asked Ram for (next week, waiting for Ram to accept).
- Recruiting (Sophie): interviews for Aisha, Priya and Karthik (two with feedback) and an offer for Lucas waiting for HR.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    Candidate, Country, Employee, EmployeeAssignment, ExpenseClaim, Interview, Joiner, LifecycleAction, Offer,
    OnboardingTask, Requisition, RosterShift, ShiftSwap, TravelRequest,
)
from app.services import approvals as engine
from app.services.onboarding import refresh_status, template_for
from app.services.workflow_defaults import ensure_default

BABU, RAM, HR = "emp-mahesh", "emp-ram", "demo-hr-admin"
JOINER_EMP = "TZ0901"


def _first_of_next_month(today: date) -> date:
    return (today.replace(day=1) + timedelta(days=32)).replace(day=1)


def _first_monday_of_next_month(today: date) -> date:
    first = _first_of_next_month(today)
    return first + timedelta(days=(7 - first.weekday()) % 7)


def _start(db: Session, type_: str, entity_id: str, requester: Employee, amount: float | None) -> str:
    ensure_default(db, type_)
    return engine.start(db, type_, entity_id, requester, amount, actor_id=requester.id).id


def _expense_and_trip(db: Session, today: date) -> int:
    babu = db.get(Employee, BABU)
    if babu is None or babu.manager_id != RAM:
        return 0
    added = 0
    if db.get(ExpenseClaim, "exp-seed-babu-1") is None:
        claim = ExpenseClaim(id="exp-seed-babu-1", employee_id=BABU, category="Food", amount=450.0, currency=babu.currency,
                             expense_date=today - timedelta(days=3), description="Lunch with the release team",
                             status="submitted")
        db.add(claim)
        db.flush()
        claim.approval_instance_id = _start(db, "expense", claim.id, babu, claim.amount)
        added += 1
    if db.get(TravelRequest, "trv-seed-babu-1") is None:
        start = today + timedelta(days=14)
        trip = TravelRequest(id="trv-seed-babu-1", employee_id=BABU, purpose="Platform planning workshop",
                             from_location="Kochi", to_location="Bengaluru", start_date=start, end_date=start + timedelta(days=2),
                             mode="air", estimated_cost=18000.0, currency=babu.currency, advance_amount=0, status="submitted")
        db.add(trip)
        db.flush()
        trip.approval_instance_id = _start(db, "travel", trip.id, babu, trip.estimated_cost)
        added += 1
    return added


def _joiner(db: Session, today: date) -> int:
    if db.get(Joiner, "ob-seed-neha") is not None or db.get(Employee, JOINER_EMP) is not None:
        return 0
    ram = db.get(Employee, RAM)
    if ram is None:
        return 0
    country = db.get(Country, "IN")
    start = _first_monday_of_next_month(today)
    emp = Employee(
        id=JOINER_EMP, employee_code=JOINER_EMP, full_name="Neha Kapoor", first_name="Neha", last_name="Kapoor",
        preferred_name="Neha", email="neha.kapoor@timez.com", country_code="IN", legal_entity=ram.legal_entity,
        business_unit=ram.business_unit, division=ram.division, department="Engineering", location=ram.location,
        job_title="Software Engineer", grade=ram.grade, employment_type="Full-Time", employment_status="Onboarding",
        joining_date=start, manager_id=RAM, time_zone=country.time_zone if country else ram.time_zone,
        currency=country.currency if country else ram.currency, holiday_calendar=ram.holiday_calendar,
        leave_policy_name=ram.leave_policy_name, payroll_status=ram.payroll_status, source="recruiting",
    )
    db.add(emp)
    db.flush()
    db.add(EmployeeAssignment(employee_id=emp.id, effective_from=start, manager_id=RAM, job_title=emp.job_title,
                              grade=emp.grade, department=emp.department, location=emp.location,
                              legal_entity=emp.legal_entity, employment_status="Onboarding"))
    joiner = Joiner(id="ob-seed-neha", employee_id=emp.id, name=emp.full_name, job_title=emp.job_title, country_code="IN",
                    manager_id=RAM, start_date=start, policy_ack=False, policy_ack_by_hr=False, status="pre_boarding")
    db.add(joiner)
    db.flush()
    for t in template_for(db, "IN", emp.legal_entity, emp.employment_type):
        db.add(OnboardingTask(id=f"ot-seed-neha-{t['key']}"[:64], joiner_id=joiner.id, key=t["key"], title=t["title"],
                              owner_role=t["owner_role"], category=t["category"],
                              due_date=start + timedelta(days=t["due_offset_days"]), depends_on=t["depends_on"],
                              status="pending"))
    db.flush()
    refresh_status(db, joiner)
    return 1


def _lifecycle(db: Session, today: date) -> int:
    added = 0
    babu, ram = db.get(Employee, BABU), db.get(Employee, RAM)
    if babu is not None and ram is not None and db.get(LifecycleAction, "lca-seed-babu-job") is None:
        action = LifecycleAction(id="lca-seed-babu-job", employee_id=BABU, action_type="job_change",
                                 effective_date=_first_of_next_month(today), before={"job_title": babu.job_title},
                                 after={"job_title": "Senior Software Engineer"},
                                 reason="Leads the timesheet module and mentors two engineers.", status="submitted",
                                 requested_by=RAM)
        db.add(action)
        db.flush()
        action.approval_instance_id = _start(db, "lifecycle", action.id, ram, None)
        added += 1
    if db.get(LifecycleAction, "lca-seed-probation") is None:
        # Someone in India still in probation (joined 4-6 months ago) with a manager, reviewed by that manager.
        person = db.scalar(select(Employee).where(
            Employee.country_code == "IN", Employee.employment_status == "Active", Employee.manager_id.is_not(None),
            Employee.joining_date.between(today - timedelta(days=183), today - timedelta(days=120)),
        ).order_by(Employee.joining_date, Employee.id))
        manager = db.get(Employee, person.manager_id) if person and person.manager_id else None
        if person is not None and manager is not None:
            end = person.joining_date + timedelta(days=182)
            action = LifecycleAction(id="lca-seed-probation", employee_id=person.id, action_type="probation_completion",
                                     effective_date=max(end, today), before={}, after={"probation_end_date": end.isoformat()},
                                     reason="Met all probation goals; recommend confirmation.", status="submitted",
                                     requested_by=manager.id)
            db.add(action)
            db.flush()
            inst = engine.start(db, "lifecycle", action.id, manager, None, actor_id=manager.id)
            action.approval_instance_id = inst.id
            first = next((ids for s in inst.steps if not s["skipped"] for ids in s["groups"].values() if ids), [])
            if inst.status == "pending" and first:
                engine.decide(db, inst, first[0], "approve", note="Manager review done.", actor_id=first[0])
            added += 1
    return added


def _shift_swap(db: Session, today: date) -> int:
    if db.get(ShiftSwap, "sw-seed-babu-ram") is not None or db.get(Employee, BABU) is None or db.get(Employee, RAM) is None:
        return 0
    monday = today - timedelta(days=today.weekday()) + timedelta(days=7)
    day = monday + timedelta(days=2)  # next Wednesday
    mine = db.scalar(select(RosterShift).where(RosterShift.employee_id == BABU, RosterShift.work_date == day))
    if mine is None or mine.manager_id != RAM:
        return 0
    theirs = db.scalar(select(RosterShift).where(RosterShift.employee_id == RAM, RosterShift.work_date == day))
    if theirs is None:
        theirs = RosterShift(id=f"rs-seed-ram-{day.isoformat()}", employee_id=RAM, work_date=day, shift_id="sh-evening",
                             manager_id=RAM)
        db.add(theirs)
    elif theirs.manager_id != RAM:
        return 0
    db.add(ShiftSwap(id="sw-seed-babu-ram", work_date=day, requester_id=BABU, teammate_id=RAM,
                     requester_shift_id=mine.shift_id, teammate_shift_id=theirs.shift_id,
                     reason="School event in the morning; happy to take the evening.", status="awaiting_teammate"))
    return 1


def _recruiting(db: Session, today: date) -> int:
    added = 0
    now = datetime.now(UTC)

    def at(days: int, hour: int) -> datetime:
        day = today + timedelta(days=days)
        while day.weekday() >= 5:  # weekdays only: past ones move earlier, upcoming ones later
            day += timedelta(days=-1 if days < 0 else 1)
        return datetime.combine(day, time(hour, 0), tzinfo=UTC)

    # id, candidate, when, kind, panel, feedback (score, text, by) or None
    interviews: list[tuple[str, str, datetime, str, list[str], tuple[int, str, str] | None]] = [
        ("int-seed-aisha-1", "cand-1", at(-6, 5), "Technical", [RAM],
         (4, "Strong React and TypeScript; clear on trade-offs.", RAM)),
        ("int-seed-aisha-2", "cand-1", at(2, 5), "Hiring manager", [RAM], None),
        ("int-seed-priya-1", "cand-5", at(3, 6), "Hiring manager", [RAM], None),
        ("int-seed-karthik-1", "cand-6", at(-4, 6), "Panel", [RAM],
         (4, "Good system design; take-home was well tested.", RAM)),
    ]
    for iid, cid, when, kind, panel, fb in interviews:
        if db.get(Interview, iid) is not None or db.get(Candidate, cid) is None:
            continue
        if not all(db.get(Employee, p) for p in panel):
            continue
        row = Interview(id=iid, candidate_id=cid, scheduled_at=when, duration_minutes=60, kind=kind, panel_ids=panel,
                        feedback_status="pending", created_by="demo-recruiter")
        if fb:
            row.feedback_status, row.score, row.feedback, row.feedback_by = "submitted", fb[0], fb[1], fb[2]
            row.feedback_at = when + timedelta(hours=2)
        db.add(row)
        added += 1
    cand = db.get(Candidate, "cand-2")
    req = db.get(Requisition, "JOB-218")
    if db.get(Offer, "off-seed-lucas") is None and cand is not None and req is not None and cand.stage == "Offer":
        open_offer = db.scalar(select(Offer.id).where(Offer.candidate_id == cand.id,
                                                      Offer.status.in_(("preparing", "pending_approval", "approved", "sent"))))
        if open_offer is None:
            approvals: list[dict[str, Any]] = [{"role": "hiring_manager", "by_id": req.hiring_manager_id,
                                                "at": (now - timedelta(days=1)).isoformat()}]
            db.add(Offer(id="off-seed-lucas", candidate_id=cand.id, requisition_id=req.id, grade="L6", base_salary=78000.0,
                         currency="GBP", start_date=_first_of_next_month(_first_of_next_month(today)),
                         package_note="Hybrid, London office. 25 days annual leave.", status="pending_approval",
                         approvals=approvals, created_by="demo-recruiter"))
            added += 1
    return added


def seed(db: Session) -> dict[str, int]:
    db.flush()
    today = date.today()
    stats = {
        "demo_expense_travel_added": _expense_and_trip(db, today),
        "demo_joiners_added": _joiner(db, today),
        "demo_lifecycle_added": _lifecycle(db, today),
    }
    db.flush()
    stats["demo_shift_swaps_added"] = _shift_swap(db, today)
    stats["demo_recruiting_added"] = _recruiting(db, today)
    db.flush()
    return stats

