"""Onboarding: a hire becomes a joiner with a directory record (status Onboarding) and the country's checklist.

- Template: per key the most specific active row for the joiner's country / legal entity / employment type
  (built-in DEFAULT_TEMPLATE + COUNTRY_TEMPLATE + SCOPED_TEMPLATE when the table is empty).
- Pre-boarding form (joiner or HR): personal info, emergency contact, equipment and an IT request, kept on the joiner;
  each equipment item and the IT request becomes a checklist task.
- A task is updated by its owner (HR, IT = admin / it_admin, the joiner's manager, or the joiner); HR may update
  someone else's task with a reason. A task can't start until the tasks it depends on are done.
- The joiner acknowledges policies (or HR records it on their behalf).
- All tasks done + policies acknowledged = completed: the employee record becomes Active.
"""

from __future__ import annotations

import re
import uuid
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import utcnow
from app.deps import CurrentUser
from app.models import (
    Candidate,
    Country,
    Employee,
    EmployeeAssignment,
    Joiner,
    Offer,
    OnboardingTask,
    OnboardingTemplateTask,
    Requisition,
)
from app.services.activity import notify, record_audit
from app.services.leave import today_for
from app.services.scope import HR_ROLES

IT_ROLES = frozenset({"admin", "it_admin"})

# key, title, owner, category, due offset (days from start), depends on
DEFAULT_TEMPLATE: list[tuple[str, str, str, str, int, list[str]]] = [
    ("hr_docs", "HR documentation", "hr", "Documents", -5, []),
    ("it_account", "IT account creation", "it", "Accounts", -3, ["hr_docs"]),
    ("laptop", "Laptop assignment", "it", "Equipment", -2, []),
    ("access", "Access provisioning", "it", "Accounts", -1, ["it_account"]),
    ("manager_intro", "Manager introduction", "manager", "Orientation", 0, []),
    ("orientation", "Orientation", "hr", "Orientation", 1, ["access"]),
    ("policy_training", "Policy training", "employee", "Policy", 3, ["orientation"]),
    ("mandatory_learning", "Mandatory learning", "employee", "Training", 14, ["access"]),
    ("team_intro", "Team introduction", "manager", "Orientation", 2, ["manager_intro"]),
    ("first_week_review", "First-week review", "manager", "Review", 7, ["orientation", "team_intro"]),
]
COUNTRY_TEMPLATE: dict[str, list[tuple[str, str, str, str, int, list[str]]]] = {
    "US": [("hr_docs", "HR documentation: I-9 & tax forms", "hr", "Documents", -5, [])],
    "IN": [("hr_docs", "HR documentation: PAN, Aadhaar & tax", "hr", "Documents", -5, [])],
    "GB": [("hr_docs", "HR documentation: right to work & P45", "hr", "Documents", -5, [])],
    "AE": [("hr_docs", "HR documentation: visa & work permit", "hr", "Documents", -10, [])],
    "SA": [("hr_docs", "HR documentation: visa & Iqama", "hr", "Documents", -10, [])],
}
# (legal entity, employment type) -> rows; either may be None (= any)
SCOPED_TEMPLATE: dict[tuple[str | None, str | None], list[tuple[str, str, str, str, int, list[str]]]] = {
    (None, "Contract"): [("mandatory_learning", "Mandatory learning (contractor set)", "employee", "Training", 7, ["access"])],
    ("TimeZ India Pvt Ltd", None): [("policy_training", "Policy training: POSH & code of conduct", "employee", "Policy", 3,
                                     ["orientation"])],
}
LEGACY_KEYS = ("docs", "accounts", "security", "code_of_conduct")  # earlier checklist rows, switched off by the seed

# pre-boarding equipment -> task (laptop uses the checklist's own laptop task)
EQUIPMENT = {"laptop": "Laptop", "monitor": "Monitor", "keyboard": "Keyboard & mouse", "headset": "Headset",
             "phone": "Mobile phone", "docking_station": "Docking station"}


class RuleError(ValueError):
    pass


class Forbidden(ValueError):
    pass


def built_in_rows() -> list[dict]:
    rows = [(None, None, None, t) for t in DEFAULT_TEMPLATE]
    rows += [(cc, None, None, t) for cc, ts in COUNTRY_TEMPLATE.items() for t in ts]
    rows += [(None, le, et, t) for (le, et), ts in SCOPED_TEMPLATE.items() for t in ts]
    return [{"country_code": cc, "legal_entity": le, "employment_type": et, "key": k, "title": ti, "owner_role": o,
             "category": c, "due_offset_days": d, "depends_on": dep} for cc, le, et, (k, ti, o, c, d, dep) in rows]


def template_for(db: Session, country_code: str, legal_entity: str | None = None, employment_type: str | None = None) -> list[dict]:
    """Checklist for this country / legal entity / employment type: per key, the most specific matching row."""
    stored = list(db.scalars(select(OnboardingTemplateTask).order_by(OnboardingTemplateTask.sort, OnboardingTemplateTask.id)))
    rows = [{"country_code": r.country_code, "legal_entity": r.legal_entity, "employment_type": r.employment_type,
             "key": r.key, "title": r.title, "owner_role": r.owner_role, "category": r.category,
             "due_offset_days": r.due_offset_days, "depends_on": list(r.depends_on or [])}
            for r in stored if r.active is not False] if stored else built_in_rows()
    want = {"country_code": country_code, "legal_entity": legal_entity, "employment_type": employment_type}
    best: dict[str, tuple[int, dict]] = {}
    for r in rows:
        if any(r[f] is not None and r[f] != v for f, v in want.items()):
            continue
        rank = sum(r[f] is not None for f in want)
        if r["key"] not in best or rank > best[r["key"]][0]:
            best[r["key"]] = (rank, r)
    return [{k: r[k] for k in ("key", "title", "owner_role", "category", "due_offset_days", "depends_on")}
            for _, r in best.values()]


def next_employee_id(db: Session) -> str:
    nums = [int(m.group(1)) for eid in db.scalars(select(Employee.id).where(Employee.id.like("TZ%")))
            if (m := re.fullmatch(r"TZ(\d+)", eid))]
    n = max([500, *nums]) + 1
    while db.get(Employee, f"TZ{n:04d}") is not None or db.scalar(select(Employee.id).where(Employee.employee_code == f"TZ{n:04d}")):
        n += 1
    return f"TZ{n:04d}"


def _hr_ids(db: Session, country: str) -> list[str]:
    from app.services.approvals import _accounts_with_roles  # same HR lookup as the approvals engine

    return _accounts_with_roles(db, set(HR_ROLES), country)


def create_joiner(db: Session, cand: Candidate, req: Requisition, actor: CurrentUser | None) -> Joiner:
    """Hired: directory record (Onboarding) + joiner + checklist. HR and the hiring manager are told.

    actor is None when the candidate accepted through their offer link (no sign-in)."""
    actor_id = actor.id if actor else None
    actor_emp = actor.employee_id if actor else None
    offer = db.scalar(select(Offer).where(Offer.candidate_id == cand.id, Offer.status == "accepted").order_by(Offer.created_at.desc()))
    if offer is None:
        raise RuleError("A candidate can only be hired after accepting an offer.")
    email = cand.email.strip().lower()
    if db.scalar(select(Employee.id).where(Employee.email == email)):
        raise RuleError(f"{email} is already in the directory.")
    country = db.get(Country, req.country_code)
    manager = db.get(Employee, req.hiring_manager_id)
    ref = manager if manager and manager.country_code == req.country_code else db.scalar(
        select(Employee).where(Employee.country_code == req.country_code, Employee.employment_status == "Active").order_by(Employee.id)
    )
    emp_id = next_employee_id(db)
    parts = cand.name.split()
    emp = Employee(
        id=emp_id, employee_code=emp_id, full_name=cand.name, first_name=parts[0] if parts else None,
        last_name=" ".join(parts[1:]) or None, preferred_name=parts[0] if parts else None, email=email,
        personal_email=None, mobile=cand.phone, country_code=req.country_code,
        legal_entity=ref.legal_entity if ref else f"TimeZ {country.name if country else req.country_code}",
        business_unit=ref.business_unit if ref else f"TimeZ {country.name if country else req.country_code}",
        division=ref.division if ref else None, department=req.department, cost_centre=None, location=req.location,
        job_title=req.title, job_family=None, position_id=None, grade=offer.grade, employment_type="Full-Time",
        employment_status="Onboarding", joining_date=offer.start_date, manager_id=req.hiring_manager_id,
        time_zone=country.time_zone if country else (ref.time_zone if ref else "UTC"),
        currency=country.currency if country else offer.currency,
        holiday_calendar=ref.holiday_calendar if ref else None, leave_policy_name=ref.leave_policy_name if ref else None,
        payroll_status=None, ai_profile_status=None, source="recruiting",
    )
    db.add(emp)
    db.flush()
    db.add(EmployeeAssignment(
        employee_id=emp.id, effective_from=offer.start_date, manager_id=emp.manager_id, job_title=emp.job_title,
        grade=emp.grade, department=emp.department, location=emp.location, legal_entity=emp.legal_entity,
        employment_status="Onboarding",
    ))
    joiner = Joiner(
        id=f"ob-{uuid.uuid4().hex[:10]}", employee_id=emp.id, candidate_id=cand.id, requisition_id=req.id, offer_id=offer.id,
        name=cand.name, job_title=req.title, country_code=req.country_code, manager_id=req.hiring_manager_id,
        start_date=offer.start_date, policy_ack=False, policy_ack_by_hr=False, status="pre_boarding",
    )
    db.add(joiner)
    db.flush()
    for t in template_for(db, req.country_code, emp.legal_entity, emp.employment_type):
        db.add(OnboardingTask(
            id=f"ot-{uuid.uuid4().hex[:10]}", joiner_id=joiner.id, key=t["key"], title=t["title"], owner_role=t["owner_role"],
            category=t["category"], due_date=offer.start_date + timedelta(days=t["due_offset_days"]),
            depends_on=t["depends_on"], status="pending",
        ))
    db.flush()
    refresh_status(db, joiner)
    record_audit(db, actor_id=actor_id, action="employee_created", entity="employee", entity_id=emp.id, subject_id=emp.id,
                 after={"full_name": emp.full_name, "employment_status": "Onboarding", "joining_date": emp.joining_date,
                        "candidate_id": cand.id, "requisition_id": req.id})
    record_audit(db, actor_id=actor_id, action="joiner_created", entity="joiner", entity_id=joiner.id, subject_id=emp.id,
                 after={"start_date": joiner.start_date, "tasks": len(tasks_of(db, joiner))})
    for rid in {req.hiring_manager_id, *_hr_ids(db, req.country_code)} - {actor_emp, None}:
        notify(db, recipient_id=rid, title=f"New joiner: {cand.name}",
               body=f"{cand.name} joins as {req.title} on {offer.start_date}. Onboarding checklist created.",
               href=f"/onboarding/joiners/{joiner.id}")
    return joiner


def tasks_of(db: Session, joiner: Joiner) -> list[OnboardingTask]:
    return list(db.scalars(select(OnboardingTask).where(OnboardingTask.joiner_id == joiner.id).order_by(OnboardingTask.due_date, OnboardingTask.id)))


def progress_pct(tasks: list[OnboardingTask]) -> int:
    return round(100 * sum(t.status == "done" for t in tasks) / len(tasks)) if tasks else 0


# ---------- who ----------
def is_hr_for(user: CurrentUser, joiner: Joiner) -> bool:
    return user.scope.is_hr and (not user.scope.countries or joiner.country_code in user.scope.countries)


def is_joiner_self(user: CurrentUser, joiner: Joiner) -> bool:
    return user.employee_id is not None and user.employee_id == joiner.employee_id


def can_view(user: CurrentUser, joiner: Joiner) -> bool:
    return (is_hr_for(user, joiner) or is_joiner_self(user, joiner) or user.account.role in IT_ROLES | {"recruiter"}
            or (user.employee_id is not None and (user.employee_id == joiner.manager_id or joiner.employee_id in user.scope.reports)))


def is_task_owner(user: CurrentUser, task: OnboardingTask, joiner: Joiner) -> bool:
    if task.owner_role == "hr":
        return is_hr_for(user, joiner)
    if task.owner_role == "it":
        return user.account.role in IT_ROLES
    if task.owner_role == "manager":
        return user.employee_id is not None and user.employee_id == joiner.manager_id
    return is_joiner_self(user, joiner)


# ---------- changes ----------
def refresh_status(db: Session, joiner: Joiner, actor_id: str | None = None) -> None:
    """Status comes from the checklist; completing it makes the employee Active."""
    if joiner.status == "completed":
        return
    tasks = tasks_of(db, joiner)
    emp = db.get(Employee, joiner.employee_id)
    all_done = all(t.status == "done" for t in tasks)
    today = today_for(emp) if emp else joiner.start_date
    if all_done and joiner.policy_ack:
        joiner.status = "completed"
        joiner.completed_at = utcnow()
        if emp is not None:
            before = emp.employment_status
            emp.employment_status = "Active"
            current = db.scalar(select(EmployeeAssignment).where(EmployeeAssignment.employee_id == emp.id,
                                                                 EmployeeAssignment.effective_to.is_(None)))
            if current is not None:
                current.employment_status = "Active"
            record_audit(db, actor_id=actor_id, action="onboarding_completed", entity="joiner", entity_id=joiner.id,
                         subject_id=emp.id, before={"employment_status": before}, after={"employment_status": "Active"})
            for rid in {joiner.manager_id, emp.id} - {None}:
                notify(db, recipient_id=rid, title=f"Onboarding complete: {joiner.name}",
                       body=f"{joiner.name} is now an active employee.", href=f"/onboarding/joiners/{joiner.id}")
    elif joiner.start_date > today:
        joiner.status = "day1_ready" if all_done else "pre_boarding"
    else:
        joiner.status = "in_progress"


def update_task(db: Session, user: CurrentUser, task: OnboardingTask, joiner: Joiner, status: str, reason: str | None) -> dict:
    if joiner.status == "completed":
        raise RuleError("Onboarding is already complete.")
    owner = is_task_owner(user, task, joiner)
    if not owner and not is_hr_for(user, joiner):
        raise Forbidden("Only the task owner or HR can update this task.")
    note = (reason or "").strip()
    if not owner and len(note) < 5:
        raise RuleError("Give a reason for updating someone else's task.")
    if status in ("in_progress", "done"):
        by_key = {t.key: t for t in tasks_of(db, joiner)}
        waiting = [by_key[k].title for k in task.depends_on or [] if k in by_key and by_key[k].status != "done"]
        if waiting:
            raise RuleError(f"Finish first: {', '.join(waiting)}.")
    before = {"status": task.status}
    task.status = status
    task.done_at, task.done_by = (utcnow(), user.employee_id) if status == "done" else (None, None)
    if not owner:
        task.override_note = note
    return before


def acknowledge(db: Session, user: CurrentUser, joiner: Joiner) -> None:
    if not (is_joiner_self(user, joiner) or is_hr_for(user, joiner)):
        raise Forbidden("Only the new joiner or HR can record the policy acknowledgment.")
    if joiner.policy_ack:
        raise RuleError("Policies are already acknowledged.")
    joiner.policy_ack = True
    joiner.policy_ack_at = utcnow()
    joiner.policy_ack_by = user.employee_id
    joiner.policy_ack_by_hr = not is_joiner_self(user, joiner)


# ---------- pre-boarding form ----------
def submit_preboarding(db: Session, user: CurrentUser, joiner: Joiner, form: dict) -> list[str]:
    """Store the form on the joiner and add the matching IT tasks (once per item). Returns the keys added."""
    if not (is_joiner_self(user, joiner) or is_hr_for(user, joiner)):
        raise Forbidden("Only the new joiner or HR can fill in the pre-boarding form.")
    if joiner.status == "completed":
        raise RuleError("Onboarding is already complete.")
    joiner.preboarding = form
    joiner.preboarding_at = utcnow()
    joiner.preboarding_by = user.id
    existing = {t.key: t for t in tasks_of(db, joiner)}
    wanted: list[tuple[str, str, str, int, list[str]]] = []
    for item in form.get("equipment") or []:
        if item == "laptop" and "laptop" in existing:
            continue
        wanted.append((f"equip_{item}", f"Equipment: {EQUIPMENT.get(item, item)}", "Equipment", -2, []))
    it = form.get("it_request") or {}
    if it.get("systems") or (it.get("notes") or "").strip():
        what = ", ".join(it.get("systems") or []) or "see notes"
        deps = ["it_account"] if "it_account" in existing else []
        wanted.append(("it_request", f"IT provisioning: {what}"[:200], "Accounts", -1, deps))
    added: list[str] = []
    for key, title, category, offset, deps in wanted:
        task = existing.get(key)
        if task is None:
            db.add(OnboardingTask(id=f"ot-{uuid.uuid4().hex[:10]}", joiner_id=joiner.id, key=key[:32], title=title,
                                  owner_role="it", category=category, due_date=joiner.start_date + timedelta(days=offset),
                                  depends_on=deps, status="pending"))
            added.append(key)
        elif task.status != "done":
            task.title = title
    db.flush()
    return added


# ---------- analytics ----------
def analytics(db: Session, joiners: list[Joiner], today: date) -> dict:
    """Joiners by month / country, checklist completion, overdue tasks by owner, days to complete, stage counts."""
    ids = [j.id for j in joiners]
    tasks = list(db.scalars(select(OnboardingTask).where(OnboardingTask.joiner_id.in_(ids)))) if ids else []
    by_joiner = {j.id: j for j in joiners}
    months: dict[str, int] = {}
    countries: dict[str, int] = {}
    for j in joiners:
        m = j.start_date.strftime("%Y-%m")
        months[m] = months.get(m, 0) + 1
        countries[j.country_code] = countries.get(j.country_code, 0) + 1
    overdue: dict[str, int] = {}
    for t in tasks:
        if t.status != "done" and t.due_date < today and by_joiner[t.joiner_id].status != "completed":
            overdue[t.owner_role] = overdue.get(t.owner_role, 0) + 1
    durations = [max(0, (j.completed_at.date() - j.created_at.date()).days) for j in joiners if j.completed_at and j.created_at]
    status = {s: sum(j.status == s for j in joiners) for s in ("pre_boarding", "day1_ready", "in_progress", "completed")}
    return {
        "total_joiners": len(joiners),
        "joiners_by_month": [{"month": m, "count": n} for m, n in sorted(months.items())],
        "joiners_by_country": [{"country_code": c, "count": n} for c, n in sorted(countries.items(), key=lambda x: (-x[1], x[0]))],
        "tasks_total": len(tasks),
        "tasks_done": sum(t.status == "done" for t in tasks),
        "completion_pct": progress_pct(tasks),
        "overdue_by_owner": [{"owner_role": o, "count": n} for o, n in sorted(overdue.items(), key=lambda x: (-x[1], x[0]))],
        "overdue_total": sum(overdue.values()),
        "avg_days_to_complete": round(sum(durations) / len(durations), 1) if durations else None,
        "preboarding_count": status["pre_boarding"] + status["day1_ready"],
        "onboarding_count": status["in_progress"],
        "completed_count": status["completed"],
        "status_counts": status,
    }
