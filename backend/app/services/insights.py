"""Leadership insights computed from the database: the director dashboard, drill-downs, contractors and the
server-side report builder.

Visibility (same rules as the rest of the API, app/services/scope.py):
- Directors / CEO (executive), HR and admins: organisation-wide aggregates (HR limited to its countries).
  Managers: their reporting line. Everyone else: no dashboard.
- Pay (cost, the compensation report source) only for HR / compensation roles (app/services/compensation.py).
- Drill-down lists and report rows never carry personal identifiers (date of birth, personal email, mobile,
  address, gender, nationality) unless the caller is HR; ratings are HR / the reporting line only, and only
  released ratings outside HR.
"""

from __future__ import annotations

import csv
import io
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Callable

from sqlalchemy import ColumnElement, select
from sqlalchemy.orm import Session

from app.deps import CurrentUser
from app.models import (
    Candidate,
    CompensationRecord,
    Country,
    Course,
    Employee,
    Enrollment,
    Joiner,
    Offer,
    OnboardingTask,
    PerfReview,
    Requisition,
    ReviewCycle,
)
from app.services import compensation as comp
from app.services.leave import today_for
from app.services.recruiting import CLOSED_STAGES

ROW_LIMIT = 5000
DRILL_LIMIT = 500
CONTRACT_ALERT_DAYS = 60


def today(user: CurrentUser) -> date:
    return today_for(user.employee) if user.employee else date.today()


def can_see_dashboard(user: CurrentUser) -> bool:
    return user.scope.org_wide or bool(user.scope.reports)


def can_see_cost(user: CurrentUser) -> bool:
    return comp.is_pay_role(user)


def is_contractor(emp: Employee) -> bool:
    return (emp.employment_type or "").lower().startswith("contract") or emp.employment_status == "Contractor"


def aggregate_filter(user: CurrentUser) -> ColumnElement[bool]:
    """Directors see like a top manager (organisation-wide aggregates); HR in its countries; managers their line."""
    return user.scope.org_filter()


def _people(db: Session, user: CurrentUser, country: str | None, department: str | None) -> list[Employee]:
    q = select(Employee).where(aggregate_filter(user))
    if user.scope.reports and not user.scope.org_wide:
        q = select(Employee).where(Employee.id.in_(user.scope.reports))  # managers: their team, not themselves
    if country:
        q = q.where(Employee.country_code == country.upper())
    if department:
        q = q.where(Employee.department == department)
    return list(db.scalars(q))


def _active_on(emp: Employee, on: date) -> bool:
    if emp.joining_date and emp.joining_date > on:
        return False
    if emp.employment_status == "Terminated":
        return emp.last_working_day is not None and emp.last_working_day >= on
    return True


def _exited_between(emp: Employee, start: date, end: date) -> bool:
    return emp.employment_status == "Terminated" and emp.last_working_day is not None and start <= emp.last_working_day <= end


def range_start(key: str, now: date) -> date:
    if key == "30d":
        return now - timedelta(days=30)
    if key == "90d":
        return now - timedelta(days=90)
    if key == "12m":
        return now - timedelta(days=365)
    return date(now.year, 1, 1)  # ytd


def _attrition(exits: int, start_count: int, end_count: int) -> float:
    avg = (start_count + end_count) / 2
    return round(exits * 100 / avg, 1) if avg else 0.0


@dataclass
class Window:
    start: date
    end: date


def _group(people: list[Employee], key: Callable[[Employee], str], win: Window) -> list[dict[str, Any]]:
    buckets: dict[str, list[Employee]] = defaultdict(list)
    for p in people:
        buckets[key(p) or "Not set"].append(p)
    out = []
    for name, rows in buckets.items():
        head = sum(1 for p in rows if _active_on(p, win.end))
        start_head = sum(1 for p in rows if _active_on(p, win.start))
        joiners = sum(1 for p in rows if p.joining_date and win.start <= p.joining_date <= win.end)
        exits = sum(1 for p in rows if _exited_between(p, win.start, win.end))
        if head or joiners or exits:
            out.append({"key": name, "headcount": head, "joiners": joiners, "exits": exits,
                        "attrition_pct": _attrition(exits, start_head, head)})
    return sorted(out, key=lambda r: (-r["headcount"], r["key"]))


def leadership(db: Session, user: CurrentUser, *, country: str | None, department: str | None, range_key: str) -> dict[str, Any]:
    now = today(user)
    win = Window(range_start(range_key, now), now)
    people = _people(db, user, country, department)
    ids = {p.id for p in people}
    head = sum(1 for p in people if _active_on(p, now))
    start_head = sum(1 for p in people if _active_on(p, win.start))
    joiners = sum(1 for p in people if p.joining_date and win.start <= p.joining_date <= now)
    exits = sum(1 for p in people if _exited_between(p, win.start, now))
    names = dict(db.execute(select(Country.code, Country.name)).all())
    by_country = _group(people, lambda p: p.country_code, win)
    for row in by_country:
        row["name"] = names.get(row["key"], row["key"])

    contractors = [p for p in people if is_contractor(p) and _active_on(p, now)]
    ending = [p for p in contractors if p.contract_end_date and p.contract_end_date <= now + timedelta(days=CONTRACT_ALERT_DAYS)]

    return {
        "as_of": now.isoformat(), "range": range_key, "from": win.start.isoformat(),
        "filters": {"country": country, "department": department},
        "scope": "organisation" if user.scope.org_wide else "team",
        "headcount": head, "joiners": joiners, "exits": exits, "net_growth": joiners - exits,
        "attrition_pct": _attrition(exits, start_head, head),
        "by_country": by_country,
        "by_department": _group(people, lambda p: p.department, win),
        "contractors": {"active": len(contractors), "ending_soon": len(ending),
                        "expired": sum(1 for p in ending if p.contract_end_date and p.contract_end_date < now)},
        "hiring": _hiring(db, user, country, department, win),
        "performance": _performance(db, user, ids),
        "learning": _learning(db, ids, now),
        "cost": _cost(db, user, people, now) if can_see_cost(user) else None,
        "cost_visible": can_see_cost(user),
        "countries": sorted({p.country_code for p in _people(db, user, None, None)}),
        "departments": sorted({p.department for p in _people(db, user, None, None) if p.department}),
    }


def _requisitions(db: Session, user: CurrentUser, country: str | None, department: str | None) -> list[Requisition]:
    q = select(Requisition)
    if not user.scope.org_wide:
        line = {user.employee_id, *user.scope.reports} - {None}
        q = q.where(Requisition.hiring_manager_id.in_(line))
    elif user.scope.countries:
        q = q.where(Requisition.country_code.in_(user.scope.countries))
    if country:
        q = q.where(Requisition.country_code == country.upper())
    if department:
        q = q.where(Requisition.department == department)
    return list(db.scalars(q))


def _hiring(db: Session, user: CurrentUser, country: str | None, department: str | None, win: Window) -> dict[str, Any]:
    reqs = _requisitions(db, user, country, department)
    req_ids = [r.id for r in reqs]
    cands = list(db.scalars(select(Candidate).where(Candidate.requisition_id.in_(req_ids)))) if req_ids else []
    offers = list(db.scalars(select(Offer).where(Offer.requisition_id.in_(req_ids)))) if req_ids else []
    stages = Counter(c.stage for c in cands if c.stage not in CLOSED_STAGES)
    open_reqs = [r for r in reqs if r.status in ("approved", "pending_approval", "on_hold")]
    return {
        "open_requisitions": sum(1 for r in reqs if r.status == "approved"),
        "awaiting_approval": sum(1 for r in reqs if r.status == "pending_approval"),
        "open_positions": sum(r.openings or 0 for r in open_reqs if r.status == "approved"),
        "active_candidates": sum(stages.values()),
        "by_stage": [{"stage": s, "count": stages.get(s, 0)} for s in
                     ("Applied", "Screening", "Shortlisted", "Interview", "Assessment", "Final Review", "Offer")],
        "offers_awaiting_approval": sum(1 for o in offers if o.status == "pending_approval"),
        "offers_out": sum(1 for o in offers if o.status == "sent"),
        "hires_in_range": sum(1 for o in offers if o.status == "accepted" and o.responded_on and win.start <= o.responded_on <= win.end),
    }


def _latest_cycle(db: Session, ids: set[str]) -> ReviewCycle | None:
    if not ids:
        return None
    cycle_ids = set(db.scalars(select(PerfReview.cycle_id).where(PerfReview.employee_id.in_(ids)).distinct()))
    if not cycle_ids:
        return None
    return db.scalar(select(ReviewCycle).where(ReviewCycle.id.in_(cycle_ids)).order_by(ReviewCycle.end_date.desc()))


def _performance(db: Session, user: CurrentUser, ids: set[str]) -> dict[str, Any] | None:
    cycle = _latest_cycle(db, ids)
    if cycle is None:
        return None
    reviews = list(db.scalars(select(PerfReview).where(PerfReview.cycle_id == cycle.id, PerfReview.employee_id.in_(ids))))
    # Aggregate counts only. Outside HR only released ratings count (proposed ratings are still in calibration).
    rated = [r for r in reviews if r.rating and (r.released or user.scope.is_hr)]
    dist_cycle = cycle
    if not rated:  # the current cycle is still open: show the last calibrated (released) distribution instead
        last = db.scalar(select(ReviewCycle).join(PerfReview, PerfReview.cycle_id == ReviewCycle.id).where(
            PerfReview.employee_id.in_(ids), PerfReview.released.is_(True), PerfReview.rating.is_not(None))
            .order_by(ReviewCycle.end_date.desc()).limit(1))
        if last is not None:
            dist_cycle = last
            rated = list(db.scalars(select(PerfReview).where(
                PerfReview.cycle_id == last.id, PerfReview.employee_id.in_(ids), PerfReview.released.is_(True),
                PerfReview.rating.is_not(None))))
    dist = Counter(r.rating for r in rated)
    return {
        "cycle_id": cycle.id, "cycle": cycle.name, "status": cycle.status, "reviews": len(reviews),
        "self_done": sum(1 for r in reviews if r.self_status == "submitted"),
        "manager_done": sum(1 for r in reviews if r.manager_status == "submitted"),
        "released": sum(1 for r in reviews if r.released),
        "distribution": [{"rating": k, "count": v} for k, v in sorted(dist.items(), key=lambda kv: -kv[1])],
        "distribution_cycle": dist_cycle.name,
        "includes_unreleased": user.scope.is_hr and dist_cycle is cycle,
    }


def _learning(db: Session, ids: set[str], now: date) -> dict[str, Any]:
    if not ids:
        return {"assigned": 0, "completed": 0, "overdue": 0, "compliance_pct": None, "courses": []}
    rows = db.execute(
        select(Enrollment, Course).join(Course, Course.id == Enrollment.course_id)
        .where(Enrollment.employee_id.in_(ids), Course.mandatory.is_(True))
    ).all()
    per_course: dict[str, dict[str, Any]] = {}
    done = overdue = 0
    for enr, course in rows:
        c = per_course.setdefault(course.id, {"course_id": course.id, "title": course.title, "assigned": 0, "completed": 0, "overdue": 0})
        c["assigned"] += 1
        if enr.status == "completed":
            c["completed"] += 1
            done += 1
        elif enr.due and enr.due < now:
            c["overdue"] += 1
            overdue += 1
    return {
        "assigned": len(rows), "completed": done, "overdue": overdue,
        "compliance_pct": round(done * 100 / len(rows), 1) if rows else None,
        "courses": sorted(per_course.values(), key=lambda c: (-c["overdue"], c["title"])),
    }


def _cost(db: Session, user: CurrentUser, people: list[Employee], now: date) -> dict[str, Any]:
    active = [p for p in people if _active_on(p, now) and p.id != user.employee_id]
    totals: dict[str, float] = defaultdict(float)
    missing = 0
    by_dept: dict[tuple[str, str], float] = defaultdict(float)
    for p in active:
        rec = comp.current_record(db, p.id, now)
        if rec is None:
            missing += 1
            continue
        totals[rec.currency] += rec.base_salary
        by_dept[(p.department, rec.currency)] += rec.base_salary
    return {
        "annual_base": [{"currency": c, "amount": round(v, 2)} for c, v in sorted(totals.items())],
        "by_department": [{"department": d, "currency": c, "amount": round(v, 2)} for (d, c), v in sorted(by_dept.items())],
        "without_record": missing,
    }


# ---------- drill-down ----------
DRILL_METRICS = ("headcount", "joiners", "exits", "contractors", "contracts_ending", "learning_overdue")


def _person_row(emp: Employee, names: dict[str, str]) -> dict[str, Any]:
    return {"id": emp.id, "name": emp.full_name, "job_title": emp.job_title, "department": emp.department,
            "country": names.get(emp.country_code, emp.country_code), "joining_date": emp.joining_date,
            "employment_type": emp.employment_type}


def drill(db: Session, user: CurrentUser, *, metric: str, country: str | None, department: str | None, range_key: str) -> list[dict[str, Any]]:
    now = today(user)
    start = range_start(range_key, now)
    people = _people(db, user, country, department)
    names = dict(db.execute(select(Country.code, Country.name)).all())
    out: list[dict[str, Any]] = []
    if metric == "learning_overdue":
        ids = {p.id: p for p in people}
        rows = db.execute(
            select(Enrollment, Course).join(Course, Course.id == Enrollment.course_id)
            .where(Enrollment.employee_id.in_(list(ids)), Course.mandatory.is_(True), Enrollment.status != "completed",
                   Enrollment.due < now)
        ).all() if ids else []
        for enr, course in rows:
            out.append(_person_row(ids[enr.employee_id], names) | {"detail": f"{course.title} · due {enr.due:%d %b %Y}"})
        return sorted(out, key=lambda r: r["name"])[:DRILL_LIMIT]
    for p in people:
        if metric == "headcount" and _active_on(p, now):
            out.append(_person_row(p, names))
        elif metric == "joiners" and p.joining_date and start <= p.joining_date <= now:
            out.append(_person_row(p, names) | {"detail": f"Joined {p.joining_date:%d %b %Y}"})
        elif metric == "exits" and _exited_between(p, start, now):
            out.append(_person_row(p, names) | {"detail": f"Last day {p.last_working_day:%d %b %Y}"})
        elif metric in ("contractors", "contracts_ending") and is_contractor(p) and _active_on(p, now):
            end = p.contract_end_date
            if metric == "contracts_ending" and not (end and end <= now + timedelta(days=CONTRACT_ALERT_DAYS)):
                continue
            out.append(_person_row(p, names) | {"detail": f"Contract ends {end:%d %b %Y}" if end else "No end date recorded"})
    return sorted(out, key=lambda r: r["name"])[:DRILL_LIMIT]


# ---------- contractors ----------
def contractor_alert(end: date | None, now: date) -> str:
    if end is None:
        return "no_end_date"
    if end < now:
        return "expired"
    if end <= now + timedelta(days=30):
        return "ending_30"
    if end <= now + timedelta(days=CONTRACT_ALERT_DAYS):
        return "ending_60"
    return "ok"


def contractors_in_scope(db: Session, user: CurrentUser) -> list[Employee]:
    if user.scope.is_hr:
        q = select(Employee).where(user.scope.employee_filter())
    elif user.scope.reports:
        q = select(Employee).where(Employee.id.in_(user.scope.reports))
    else:
        return []
    return [p for p in db.scalars(q.where(Employee.employment_status != "Terminated")) if is_contractor(p)]


# ---------- report builder ----------
@dataclass(frozen=True)
class Col:
    key: str
    label: str
    kind: str = "text"  # text | number | date | bool
    hr_only: bool = False


PEOPLE_COLUMNS = [
    Col("employee_code", "Employee ID"), Col("full_name", "Name"), Col("job_title", "Job title"),
    Col("department", "Department"), Col("country", "Country"), Col("location", "Location"),
    Col("business_unit", "Business unit"), Col("legal_entity", "Legal entity"), Col("grade", "Grade"),
    Col("employment_type", "Employment type"), Col("employment_status", "Status"),
    Col("joining_date", "Joining date", "date"), Col("tenure_years", "Tenure (years)", "number"),
    Col("manager", "Manager"), Col("contract_end_date", "Contract end", "date"),
    Col("last_working_day", "Last working day", "date"),
    Col("gender", "Gender", hr_only=True), Col("date_of_birth", "Date of birth", "date", hr_only=True),
    Col("nationality", "Nationality", hr_only=True), Col("personal_email", "Personal email", hr_only=True),
    Col("mobile", "Mobile", hr_only=True),
]
EMP_BASE = [Col("full_name", "Name"), Col("department", "Department"), Col("country", "Country")]
SOURCES: dict[str, dict[str, Any]] = {
    "people": {"label": "People", "columns": PEOPLE_COLUMNS},
    "learning": {"label": "Learning assignments", "columns": EMP_BASE + [
        Col("course", "Course"), Col("mandatory", "Mandatory", "bool"), Col("status", "Status"),
        Col("progress", "Progress %", "number"), Col("due", "Due", "date"), Col("completed_on", "Completed", "date"),
        Col("overdue", "Overdue", "bool")]},
    "performance": {"label": "Performance reviews", "columns": EMP_BASE + [
        Col("cycle", "Cycle"), Col("self_status", "Self review"), Col("manager_status", "Manager review"),
        Col("rating", "Rating"), Col("released", "Released", "bool"), Col("goals", "Goals", "number"),
        Col("goal_progress", "Avg goal progress %", "number")]},
    "recruiting": {"label": "Requisitions", "columns": [
        Col("title", "Role"), Col("department", "Department"), Col("country", "Country"), Col("status", "Status"),
        Col("openings", "Openings", "number"), Col("raised_on", "Raised", "date"), Col("candidates", "Candidates", "number"),
        Col("interviewing", "In interview", "number"), Col("offers", "Offers", "number"), Col("hired", "Hired", "number")]},
    "onboarding": {"label": "Onboarding", "columns": [
        Col("full_name", "Joiner"), Col("job_title", "Job title"), Col("country", "Country"),
        Col("start_date", "Start date", "date"), Col("status", "Status"), Col("tasks", "Tasks", "number"),
        Col("tasks_done", "Done", "number"), Col("tasks_overdue", "Overdue", "number")]},
    "compensation": {"label": "Compensation (pay roles only)", "pay": True, "columns": EMP_BASE + [
        Col("grade", "Grade"), Col("base_salary", "Base salary", "number"), Col("currency", "Currency"),
        Col("effective_date", "Effective", "date"), Col("reason", "Reason")]},
}


def sources_for(user: CurrentUser) -> list[dict[str, Any]]:
    out = []
    for key, src in SOURCES.items():
        if src.get("pay") and not can_see_cost(user):
            continue
        cols = [c for c in src["columns"] if not c.hr_only or user.scope.is_hr]
        out.append({"key": key, "label": src["label"],
                    "columns": [{"key": c.key, "label": c.label, "kind": c.kind} for c in cols]})
    return out


def _allowed_columns(user: CurrentUser, source: str) -> list[Col]:
    src = SOURCES[source]
    return [c for c in src["columns"] if not c.hr_only or user.scope.is_hr]


def _scoped_people(db: Session, user: CurrentUser, line_only: bool) -> dict[str, Employee]:
    """line_only: HR data (ratings, pay) - HR in scope, everyone else their reporting line. Otherwise aggregates scope."""
    cond = user.scope.employee_filter() if line_only else aggregate_filter(user)
    return {p.id: p for p in db.scalars(select(Employee).where(cond).limit(20000))}


def _rows_people(db: Session, user: CurrentUser, now: date) -> list[dict[str, Any]]:
    people = _scoped_people(db, user, line_only=False)
    names = dict(db.execute(select(Country.code, Country.name)).all())
    managers = dict(db.execute(select(Employee.id, Employee.full_name)).all())
    rows = []
    for p in people.values():
        rows.append({
            "employee_code": p.employee_code, "full_name": p.full_name, "job_title": p.job_title,
            "department": p.department, "country": names.get(p.country_code, p.country_code), "location": p.location,
            "business_unit": p.business_unit, "legal_entity": p.legal_entity, "grade": p.grade,
            "employment_type": p.employment_type, "employment_status": p.employment_status,
            "joining_date": p.joining_date,
            "tenure_years": round(((p.last_working_day or now) - p.joining_date).days / 365.25, 1) if p.joining_date else None,
            "manager": managers.get(p.manager_id) if p.manager_id else None, "contract_end_date": p.contract_end_date,
            "last_working_day": p.last_working_day, "gender": p.gender, "date_of_birth": p.date_of_birth,
            "nationality": p.nationality, "personal_email": p.personal_email, "mobile": p.mobile,
        })
    return rows


def _emp_base(p: Employee, names: dict[str, str]) -> dict[str, Any]:
    return {"full_name": p.full_name, "department": p.department, "country": names.get(p.country_code, p.country_code)}


def _rows_learning(db: Session, user: CurrentUser, now: date) -> list[dict[str, Any]]:
    people = _scoped_people(db, user, line_only=False)
    names = dict(db.execute(select(Country.code, Country.name)).all())
    rows = []
    for enr, course in db.execute(select(Enrollment, Course).join(Course, Course.id == Enrollment.course_id)
                                  .where(Enrollment.employee_id.in_(list(people)))).all():
        rows.append(_emp_base(people[enr.employee_id], names) | {
            "course": course.title, "mandatory": course.mandatory, "status": enr.status, "progress": enr.progress,
            "due": enr.due, "completed_on": enr.completed_on,
            "overdue": bool(enr.due and enr.due < now and enr.status != "completed")})
    return rows


def _rows_performance(db: Session, user: CurrentUser, now: date) -> list[dict[str, Any]]:
    from app.models import Goal

    people = _scoped_people(db, user, line_only=True)
    names = dict(db.execute(select(Country.code, Country.name)).all())
    cycles = dict(db.execute(select(ReviewCycle.id, ReviewCycle.name)).all())
    goals: dict[tuple[str, str], list[int]] = defaultdict(list)
    for g in db.scalars(select(Goal).where(Goal.employee_id.in_(list(people)))):
        goals[(g.employee_id, g.cycle_id)].append(g.progress or 0)
    rows = []
    for r in db.scalars(select(PerfReview).where(PerfReview.employee_id.in_(list(people)))):
        if r.employee_id == user.employee_id and not user.scope.is_hr:
            continue  # your own review is on the performance page, not in a report
        g = goals.get((r.employee_id, r.cycle_id), [])
        rows.append(_emp_base(people[r.employee_id], names) | {
            "cycle": cycles.get(r.cycle_id, r.cycle_id), "self_status": r.self_status, "manager_status": r.manager_status,
            "rating": r.rating if (r.released or user.scope.is_hr or r.employee_id in user.scope.reports) else None,
            "released": r.released, "goals": len(g), "goal_progress": round(sum(g) / len(g)) if g else None})
    return rows


def _rows_recruiting(db: Session, user: CurrentUser, now: date) -> list[dict[str, Any]]:
    reqs = _requisitions(db, user, None, None)
    names = dict(db.execute(select(Country.code, Country.name)).all())
    ids = [r.id for r in reqs]
    by_req: dict[str, list[Candidate]] = defaultdict(list)
    offers: Counter[str] = Counter()
    if ids:
        for c in db.scalars(select(Candidate).where(Candidate.requisition_id.in_(ids))):
            by_req[c.requisition_id].append(c)
        offers.update(db.scalars(select(Offer.requisition_id).where(Offer.requisition_id.in_(ids))))
    return [{
        "title": r.title, "department": r.department, "country": names.get(r.country_code, r.country_code),
        "status": r.status, "openings": r.openings, "raised_on": r.raised_on, "candidates": len(by_req[r.id]),
        "interviewing": sum(1 for c in by_req[r.id] if c.stage in ("Interview", "Assessment", "Final Review")),
        "offers": offers[r.id], "hired": sum(1 for c in by_req[r.id] if c.stage == "Hired"),
    } for r in reqs]


def _rows_onboarding(db: Session, user: CurrentUser, now: date) -> list[dict[str, Any]]:
    people = _scoped_people(db, user, line_only=False)
    names = dict(db.execute(select(Country.code, Country.name)).all())
    joiners = list(db.scalars(select(Joiner).where(Joiner.employee_id.in_(list(people)))))
    tasks: dict[str, list[OnboardingTask]] = defaultdict(list)
    if joiners:
        for t in db.scalars(select(OnboardingTask).where(OnboardingTask.joiner_id.in_([j.id for j in joiners]))):
            tasks[t.joiner_id].append(t)
    return [{
        "full_name": j.name, "job_title": j.job_title, "country": names.get(j.country_code, j.country_code),
        "start_date": j.start_date, "status": j.status, "tasks": len(tasks[j.id]),
        "tasks_done": sum(1 for t in tasks[j.id] if t.status == "done"),
        "tasks_overdue": sum(1 for t in tasks[j.id] if t.status != "done" and t.due_date < now),
    } for j in joiners]


def _rows_compensation(db: Session, user: CurrentUser, now: date) -> list[dict[str, Any]]:
    people = _scoped_people(db, user, line_only=True)
    people.pop(user.employee_id or "", None)  # never your own pay in a report
    names = dict(db.execute(select(Country.code, Country.name)).all())
    rows = []
    for p in people.values():
        rec: CompensationRecord | None = comp.current_record(db, p.id, now)
        if rec is None:
            continue
        rows.append(_emp_base(p, names) | {"grade": rec.grade, "base_salary": rec.base_salary, "currency": rec.currency,
                                           "effective_date": rec.effective_date, "reason": rec.reason})
    return rows


_BUILDERS: dict[str, Callable[[Session, CurrentUser, date], list[dict[str, Any]]]] = {
    "people": _rows_people, "learning": _rows_learning, "performance": _rows_performance,
    "recruiting": _rows_recruiting, "onboarding": _rows_onboarding, "compensation": _rows_compensation,
}


class ReportError(ValueError):
    pass


def _match(value: Any, wanted: Any, kind: str) -> bool:
    if isinstance(wanted, dict):  # range: {"from": .., "to": ..}
        if value is None:
            return False
        lo, hi = wanted.get("from"), wanted.get("to")
        v = value.isoformat() if isinstance(value, date) else value
        if kind == "number":
            try:
                return (lo in (None, "") or float(v) >= float(lo)) and (hi in (None, "") or float(v) <= float(hi))
            except (TypeError, ValueError):
                return False
        return (not lo or str(v) >= str(lo)) and (not hi or str(v) <= str(hi))
    if isinstance(wanted, list):
        return any(_match(value, w, kind) for w in wanted)
    if kind == "bool":
        return bool(value) == (str(wanted).lower() in ("true", "1", "yes"))
    return str(value if value is not None else "").lower() == str(wanted).lower()


def run_report(db: Session, user: CurrentUser, *, source: str, columns: list[str], filters: dict[str, Any],
               group_by: str | None, search: str | None = None, sort: str | None = None, desc: bool = False) -> dict[str, Any]:
    if source not in SOURCES:
        raise ReportError("Unknown report source.")
    if SOURCES[source].get("pay") and not can_see_cost(user):
        raise PermissionError("Only HR or compensation can report on pay.")
    allowed = {c.key: c for c in _allowed_columns(user, source)}
    cols = [c for c in columns if c in allowed] or list(allowed)[:8]
    unknown = [k for k in list(filters) + ([group_by] if group_by else []) + ([sort] if sort else []) if k not in allowed]
    if unknown:
        raise ReportError(f"You can't filter, group or sort on: {', '.join(unknown)}.")
    rows = _BUILDERS[source](db, user, today(user))
    for key, wanted in filters.items():
        if wanted in (None, "", [], {}):
            continue
        rows = [r for r in rows if _match(r.get(key), wanted, allowed[key].kind)]
    if search and search.strip():
        needle = search.strip().lower()
        rows = [r for r in rows if any(needle in str(r.get(c) or "").lower() for c in cols)]
    if sort:
        rows.sort(key=lambda r: (r.get(sort) is None, r.get(sort) if r.get(sort) is not None else ""), reverse=desc)
    total = len(rows)
    groups = None
    if group_by:
        counts: dict[str, dict[str, Any]] = {}
        numeric = [c for c in cols if allowed[c].kind == "number"]
        for r in rows:
            g = counts.setdefault(str(r.get(group_by) if r.get(group_by) not in (None, "") else "Not set"),
                                  {"value": None, "count": 0, "sums": defaultdict(float)})
            g["count"] += 1
            for n in numeric:
                if isinstance(r.get(n), (int, float)):
                    g["sums"][n] += r[n]
        groups = [{"value": k, "count": v["count"], "sums": {n: round(s, 2) for n, s in v["sums"].items()}}
                  for k, v in sorted(counts.items(), key=lambda kv: -kv[1]["count"])]
    shown = rows[:ROW_LIMIT]
    return {
        "source": source,
        "columns": [{"key": c, "label": allowed[c].label, "kind": allowed[c].kind} for c in cols],
        "rows": [{c: (r.get(c).isoformat() if isinstance(r.get(c), date) else r.get(c)) for c in cols} for r in shown],
        "total": total, "truncated": total > ROW_LIMIT, "groups": groups,
    }


def to_csv(result: dict[str, Any]) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([c["label"] for c in result["columns"]])
    for r in result["rows"]:
        out = []
        for c in result["columns"]:
            v = r.get(c["key"])
            text = "Yes" if v is True else "No" if v is False else "" if v is None else str(v)
            if text[:1] in ("=", "+", "-", "@") and c["kind"] != "number":
                text = "'" + text  # no formula injection when opened in a spreadsheet
            out.append(text)
        writer.writerow(out)
    return buf.getvalue()
