"""Talent sample data (front end: src/data/talentData.ts): requisitions, candidates, a review cycle with goals, the
course catalog, a few certifications, the onboarding checklist templates and the default requisition workflow.

Called from app.seed.run() via seed_talent(). Rows are inserted once (matched by id); courses and templates are
updated in place. Nothing here is ever deleted.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    Candidate,
    CandidateStage,
    Certification,
    Course,
    Employee,
    Goal,
    OnboardingTemplateTask,
    Requisition,
    ReviewCycle,
)
from app.services import recruiting
from app.services.onboarding import LEGACY_KEYS, built_in_rows

RECRUITER = "demo-recruiter"

# id, title, department, country, location, openings, hiring manager, status, raised, decided, requirements
REQUISITIONS: list[tuple[Any, ...]] = [
    ("JOB-221", "Senior React Engineer", "Engineering", "IN", "Bengaluru", 3, "emp-ram", "approved", "2026-08-12", "2026-08-14",
     ["5+ years React", "TypeScript", "System design"]),
    ("JOB-218", "HR Business Partner", "People", "GB", "London", 1, "demo-ceo", "approved", "2026-07-28", "2026-07-30",
     ["Employee relations", "Workforce planning", "Stakeholder management"]),
    ("JOB-205", "Product Analyst", "Product", "CA", "Toronto", 1, "demo-ceo", "on_hold", "2026-06-18", "2026-06-22",
     ["SQL", "Data analysis"]),
    ("JOB-230", "Product Manager", "Product", "IN", "Bengaluru", 1, "emp-ram", "approved", "2026-10-01", "2026-10-03",
     ["Product management", "Stakeholder management", "User research"]),
    ("JOB-210", "Talent Sourcer", "People", "US", "New York", 2, "demo-ceo", "pending_approval", "2026-09-05", None,
     ["Recruiting", "Boolean search"]),
]

# id, requisition, name, email, phone, source, years, skills, note, applied, stage path (Applied first)
CANDIDATES: list[tuple[Any, ...]] = [
    ("cand-1", "JOB-221", "Aisha Khan", "aisha.khan@example.com", "+91 98xxx x2144", "LinkedIn", 7,
     ["React", "TypeScript", "Design systems"], "Strong frontend portfolio; hybrid Bengaluru preference.", "2026-08-20",
     ["Applied", "Screening", "Shortlisted", "Interview"]),
    ("cand-2", "JOB-218", "Lucas Meyer", "lucas.meyer@example.com", "+44 20 xxx 0881", "Agency", 9,
     ["Employee relations", "Workforce planning"], "EMEA HRBP background; offer in preparation.", "2026-08-02",
     ["Applied", "Screening", "Shortlisted", "Interview", "Assessment", "Final Review", "Offer"]),
    ("cand-4", "JOB-205", "Jonas Weber", "jonas.weber@example.com", "+49 30 xxx 4412", "Careers site", 5,
     ["SQL", "Product analytics", "Experimentation"], "Open to Toronto relocation. Requisition is on hold.", "2026-06-25",
     ["Applied", "Screening"]),
    ("cand-5", "JOB-230", "Priya Desai", "priya.desai@example.com", "+91 98xxx x3301", "Careers site", 6,
     ["Roadmapping", "Discovery", "Analytics"], "B2B SaaS PM.", "2026-10-05", ["Applied", "Screening", "Shortlisted", "Interview"]),
    ("cand-6", "JOB-221", "Karthik Rao", "karthik.rao@example.com", "+91 98xxx x7710", "LinkedIn", 8,
     ["React", "Node", "System design"], "Completed take-home; panel review next.", "2026-08-22",
     ["Applied", "Screening", "Shortlisted", "Interview", "Assessment"]),
    ("cand-8", "JOB-218", "Tom Hughes", "tom.hughes@example.com", "+44 20 xxx 2210", "Referral", 8,
     ["HRBP", "Change management"], "Final panel complete; hiring manager decision pending.", "2026-08-05",
     ["Applied", "Screening", "Shortlisted", "Interview", "Assessment", "Final Review"]),
    ("cand-11", "JOB-230", "Vikram Nair", "vikram.nair@example.com", "+91 98xxx x6120", "LinkedIn", 4,
     ["Roadmapping", "Stakeholder management"], "Consumer PM; light on B2B.", "2026-10-06", ["Applied", "Screening", "Rejected"]),
    ("cand-12", "JOB-221", "Meera Iyer", "meera.iyer@example.com", "+91 98xxx x4408", "Careers site", 6,
     ["React", "GraphQL"], "Took another offer.", "2026-08-25", ["Applied", "Screening", "Shortlisted", "Withdrawn"]),
]

CYCLES = [
    ("cyc-h2", "H2 2026 review", "active", "2026-07-01", "2026-10-31", "2026-10-15", "2026-10-25"),
    ("cyc-y26", "FY2026 annual review", "planning", "2026-11-01", "2027-02-28", "2027-01-31", "2027-02-15"),
]

# id, owner, type, title, target, weight, progress
GOALS = [
    ("g1", "emp-mahesh", "goal", "Ship timesheet calendar UX", "Live for all users", 40, 70),
    ("g2", "emp-mahesh", "okr", "Reduce PR cycle time", "-20%", 30, 55),
    ("g3", "emp-mahesh", "kpi", "Sprint predictability", ">= 85%", 30, 82),
    ("g4", "emp-ram", "okr", "Team delivery on roadmap", "90% of committed items", 60, 68),
    ("g6", "emp-ram", "goal", "Hire two senior engineers", "2 hires", 40, 50),
]

# id, title, provider, category, hours, mandatory, audience, skills
COURSES = [
    ("crs-1", "Workplace safety", "TimeZ Academy", "Compliance", 1, True, "All", []),
    ("crs-2", "Secure coding fundamentals", "TimeZ Academy", "Engineering", 4, True, "Engineering", ["TypeScript", "System design"]),
    ("crs-3", "Manager essentials", "TimeZ Academy", "Leadership", 6, False, "Managers", ["People leadership"]),
    ("crs-4", "Inclusive hiring", "TimeZ Academy", "People", 2, False, "Hiring", ["Recruiting"]),
    ("crs-5", "React performance patterns", "Frontend Masters", "Engineering", 3, False, "Engineering", ["React"]),
    ("crs-6", "Data privacy basics", "TimeZ Academy", "Compliance", 1.5, True, "All", []),
    ("crs-7", "Cloud architecture foundations", "AWS Skill Builder", "Engineering", 5, False, "Engineering",
     ["Cloud architecture", "System design"]),
    ("crs-8", "Employee relations essentials", "CIPD", "People", 3, False, "All", ["Employee relations"]),
    ("crs-9", "Product discovery in practice", "Reforge", "Product", 4, False, "All", ["Product management"]),
    ("crs-10", "Financial analysis for managers", "Coursera", "Finance", 5, False, "Managers", ["Financial analysis"]),
]

# id, employee, name, issuer, issued, expires
CERTIFICATIONS = [
    ("cert-1", "emp-mahesh", "Professional Scrum Master", "Scrum.org", "2023-06-01", None),
    ("cert-3", "emp-mahesh", "AWS Certified Developer - Associate", "Amazon Web Services", "2023-11-20", "2026-11-20"),
    ("cert-4", "emp-ram", "First Aid at Work", "St John Ambulance", "2023-09-01", "2026-09-01"),
    ("cert-5", "demo-recruiter", "Certified Diversity Recruiter", "AIRS", "2025-02-10", "2028-02-10"),
]


def _d(value: str | None) -> date | None:
    return date.fromisoformat(value) if value else None


def _templates(db: Session) -> int:
    """Built-in checklist rows (default, per country, per legal entity / employment type) are inserted or updated in
    place; rows of the earlier checklist (LEGACY_KEYS) are switched off, never deleted."""
    rows = built_in_rows()
    existing = {(r.country_code, r.legal_entity, r.employment_type, r.key): r for r in db.scalars(select(OnboardingTemplateTask))}
    fields = ("title", "owner_role", "category", "due_offset_days", "depends_on")
    for sort, t in enumerate(rows):
        row = existing.get((t["country_code"], t["legal_entity"], t["employment_type"], t["key"]))
        if row is None:
            db.add(OnboardingTemplateTask(**t, active=True, sort=sort))
        else:
            for f in fields:
                if getattr(row, f) != t[f]:
                    setattr(row, f, t[f])
            row.sort, row.active = sort, True
    for (cc, le, et, key), row in existing.items():
        if key in LEGACY_KEYS and row.active is not False:
            row.active = False
    return len(rows)


def _requisitions(db: Session) -> int:
    added = 0
    for rid, title, dept, cc, loc, openings, hm, status, raised, decided, reqs in REQUISITIONS:
        if db.get(Requisition, rid) is not None or db.get(Employee, hm) is None:
            continue
        approved = status in ("approved", "on_hold")
        req = Requisition(id=rid, title=title, department=dept, country_code=cc, location=loc, openings=openings,
                          hiring_manager_id=hm, recruiter_id=RECRUITER if approved else None,
                          recruiter_assigned_on=_d(decided) if approved else None, status=status, requirements=reqs,
                          raised_on=_d(raised), decided_on=_d(decided))  # type: ignore[arg-type]
        db.add(req)
        db.flush()
        if status == "pending_approval":
            recruiting.start_approval(db, req, db.get(Employee, hm), None)  # type: ignore[arg-type]
        added += 1
    return added


def _candidates(db: Session) -> int:
    added = 0
    for cid, rid, name, email, phone, source, years, skills, note, applied, path in CANDIDATES:
        if db.get(Candidate, cid) is not None or db.get(Requisition, rid) is None:
            continue
        req = db.get(Requisition, rid)
        db.add(Candidate(id=cid, requisition_id=rid, name=name, email=email, phone=phone, source=source, experience_years=years,
                         skills=skills, cv_note=note, applied_on=_d(applied), stage=path[-1], created_by=RECRUITER))
        db.flush()
        start = datetime.combine(_d(applied), time(9, 30), tzinfo=UTC)  # type: ignore[arg-type]
        for i, stage in enumerate(path):
            by = req.hiring_manager_id if stage == "Offer" else RECRUITER  # type: ignore[union-attr]
            db.add(CandidateStage(candidate_id=cid, stage=stage, entered_at=start + timedelta(days=3 * i), by_id=by))
        added += 1
    return added


def _performance(db: Session) -> int:
    added = 0
    for cid, name, status, start, end, self_due, mgr_due in CYCLES:
        if db.get(ReviewCycle, cid) is None:
            db.add(ReviewCycle(id=cid, name=name, status=status, start_date=_d(start), end_date=_d(end),
                               self_review_due=_d(self_due), manager_review_due=_d(mgr_due), created_by="demo-hr-admin"))
            added += 1
    db.flush()
    for gid, owner, type_, title, target, weight, progress in GOALS:
        if db.get(Goal, gid) is None and db.get(Employee, owner) is not None:
            db.add(Goal(id=gid, employee_id=owner, cycle_id="cyc-h2", type=type_, title=title, target=target, period="Jul-Oct 2026",
                        weight=weight, progress=progress, created_by=owner))
    return added


def _learning(db: Session) -> int:
    for cid, title, provider, category, hours, mandatory, audience, skills in COURSES:
        values = {"id": cid, "title": title, "provider": provider, "category": category, "duration_hours": hours,
                  "mandatory": mandatory, "audience": audience, "skills": skills, "active": True,
                  "url": f"https://learn.timez.example/courses/{cid}"}
        row = db.get(Course, cid)
        if row is None:
            db.add(Course(**values))
        else:
            for k, v in values.items():
                setattr(row, k, v)
    for cid, emp, name, issuer, issued, expires in CERTIFICATIONS:
        if db.get(Certification, cid) is None and db.get(Employee, emp) is not None:
            db.add(Certification(id=cid, employee_id=emp, name=name, issuer=issuer, issued_on=_d(issued), expires_on=_d(expires)))
    return len(COURSES)


def seed(db: Session) -> dict[str, int]:
    recruiting.ensure_requisition_workflow(db)
    stats = {"onboarding_template_tasks": _templates(db)}
    db.flush()
    stats["requisitions_added"] = _requisitions(db)
    stats["candidates_added"] = _candidates(db)
    stats["review_cycles_added"] = _performance(db)
    stats["courses"] = _learning(db)
    return stats
