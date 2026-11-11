"""Sample skills, learning, performance, recognition, engagement, career and recruiting detail.

Insert-only and idempotent: adds rows only where none exist yet and never changes a value that is already set,
so it is safe to run again on a database that already holds real data.

- Skills: 3-8 library skills per active person who has none, matched to their department and grade.
- Learning: enrollments for people with none, only in courses meant for them (mandatory courses follow the course
  audience; executives get leadership courses, never employee compliance courses); certifications for people with none.
- Performance: a closed "H1 2026 review" cycle with self + manager reviews (none manager-rated for someone without a
  manager), 360 answers and development actions; reviews in progress in the current cycle for workbook employees;
  1:1 check-ins; goals in the current cycle for people who have none.
- Recognition: kudos between colleagues (demo sign-ins only in past months, so their monthly allowance is untouched),
  reward redemptions within each person's points; answers to the pulse survey and three closed past pulses.
- Career: mentor and note where empty; a profile for the CEO with board / advisory interests.
- Recruiting: blank requisition, posting, candidate and past-interview fields filled; Sophie's recent activity.

Every value is derived from ids (no randomness), dates are relative to today, and rows are added in bulk.
"""

from __future__ import annotations

import hashlib
from collections import defaultdict
from datetime import UTC, date, datetime, time, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import (
    AuditLog,
    Candidate,
    CandidateStage,
    CareerPath,
    CareerProfile,
    Certification,
    CheckIn,
    Course,
    DevAction,
    Employee,
    EmployeeSkill,
    EngagementParticipant,
    EngagementResponse,
    EngagementSurvey,
    Enrollment,
    Goal,
    Interview,
    JobPosting,
    Kudos,
    PerfReview,
    Requisition,
    Reviewer360,
    ReviewCycle,
    RewardItem,
    RewardRedemption,
    Skill,
)

HR = "demo-hr-admin"
RECRUITER = "demo-recruiter"
CEO = "demo-ceo"
DEMO_IDS = {"emp-mahesh", "emp-priya", "emp-oliver", "emp-ram", HR, RECRUITER, CEO, "demo-admin"}
PAST_CYCLE = ("cyc-seed-h1-2026", "H1 2026 review", "2026-01-01", "2026-06-30", "2026-07-10", "2026-07-20")
CURRENT_CYCLE = "cyc-h2"


def _h(*parts: object) -> int:
    return int(hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest()[:12], 16)


def _pick(seq: list[Any] | tuple[Any, ...], *parts: object) -> Any:
    return seq[_h(*parts) % len(seq)]


def _at(day: date, hour: int = 10, minute: int = 0) -> datetime:
    return datetime.combine(day, time(hour, minute), tzinfo=UTC)


def _weekday(day: date) -> date:
    while day.weekday() >= 5:
        day -= timedelta(days=1)
    return day


def _is_exec(emp: Employee) -> bool:
    return (emp.grade or "").startswith("E") or emp.department == "Executive" or "chief" in (emp.job_title or "").lower()


def _base_level(emp: Employee) -> int:
    grade = emp.grade or ""
    if grade.startswith("G") and grade[1:].isdigit():
        return {3: 2, 4: 2, 5: 3, 6: 3, 7: 3, 8: 4, 9: 4}.get(int(grade[1:]), 3)
    return {"L3": 2, "L4": 2, "L5": 3, "L6": 3, "M1": 4, "M2": 4, "M3": 4, "E1": 5}.get(grade, 3)


class _Ctx:
    """Employees and reporting lines loaded once."""

    def __init__(self, db: Session, today: date) -> None:
        self.today = today
        everyone = list(db.scalars(select(Employee).order_by(Employee.id)))
        self.by_id = {e.id: e for e in everyone}
        self.active = [e for e in everyone if e.employment_status in ("Active", "On Leave") and e.joining_date <= today
                       and (e.last_working_day is None or e.last_working_day >= today)]
        self.active_ids = {e.id for e in self.active}
        self.reports: dict[str, list[str]] = defaultdict(list)
        for e in self.active:
            if e.manager_id:
                self.reports[e.manager_id].append(e.id)

    def peers(self, emp: Employee) -> list[str]:
        return [i for i in self.reports.get(emp.manager_id or "", []) if i != emp.id] if emp.manager_id else []

    def colleagues(self, emp: Employee) -> list[str]:
        """Peers, direct reports and the manager: people who work with this person."""
        out = self.peers(emp) + self.reports.get(emp.id, [])
        if emp.manager_id and emp.manager_id in self.active_ids:
            out.append(emp.manager_id)
        return out

    def is_manager(self, emp: Employee) -> bool:
        return bool(self.reports.get(emp.id))


def _have(db: Session, column: Any) -> set[str]:
    return set(db.scalars(select(column).distinct()))


# ---------- skills ----------
DEPT_SKILLS = {
    "Engineering": ["sk-2", "sk-7", "sk-1", "sk-4"], "IT": ["sk-12", "sk-4", "sk-7", "sk-2"],
    "Human Resources": ["sk-8", "sk-5", "sk-9"], "People": ["sk-8", "sk-5", "sk-9"], "Talent Acquisition": ["sk-5", "sk-8"],
    "Learning & Development": ["sk-8", "sk-3", "sk-11"], "Finance": ["sk-6", "sk-11", "sk-9"],
    "Legal & Compliance": ["sk-8", "sk-11", "sk-6"], "Customer Success": ["sk-10", "sk-11", "sk-8"],
    "Operations": ["sk-11", "sk-6", "sk-12"], "Marketing": ["sk-10", "sk-11", "sk-6"], "Sales": ["sk-11", "sk-10", "sk-6"],
    "Executive": ["sk-11", "sk-3", "sk-6", "sk-10"], "Product": ["sk-10", "sk-11", "sk-7"],
}
EXTRA_SKILLS = ["sk-11", "sk-3", "sk-10", "sk-6", "sk-8", "sk-7"]
LEVEL_NUM = {"Awareness": 1, "Working": 2, "Intermediate": 3, "Advanced": 4, "Expert": 5}


def _skills(db: Session, ctx: _Ctx) -> int:
    from app.services.career import STARTER_SKILLS

    library = {s.id: s.name for s in db.scalars(select(Skill).where(Skill.active.is_(True)))}
    if not library:
        return 0
    have = _have(db, EmployeeSkill.employee_id)
    rows = []
    for emp in ctx.active:
        if emp.id in have:
            continue
        base = _base_level(emp)
        levels: dict[str, int] = {}
        if emp.id in STARTER_SKILLS:
            levels = {sid: LEVEL_NUM[name] for sid, name in STARTER_SKILLS[emp.id][1].items()}
        else:
            for i, sid in enumerate(DEPT_SKILLS.get(emp.department, ["sk-11", "sk-3"])):
                levels[sid] = max(1, min(5, base + (1 if i == 0 and _h(emp.id, "top") % 3 == 0 else 0) - (1 if i >= 2 else 0)))
            if ctx.is_manager(emp) or base >= 4:
                levels.setdefault("sk-3", max(2, base - (0 if ctx.is_manager(emp) else 1)))
        want = min(8, max(3, len(levels) + _h(emp.id, "n") % 3))
        for sid in EXTRA_SKILLS:
            if len(levels) >= want:
                break
            if sid not in levels and _h(emp.id, sid) % 2 == 0:
                levels[sid] = max(1, base - 1 - _h(emp.id, sid, "l") % 2)
        for sid in EXTRA_SKILLS:  # still short: fill in order
            if len(levels) >= 3:
                break
            levels.setdefault(sid, max(1, base - 2))
        tenure = max(0.5, (ctx.today - emp.joining_date).days / 365)
        for i, (sid, level) in enumerate(levels.items()):
            if sid not in library:
                continue
            hv = _h(emp.id, sid, "detail")
            last = ctx.today.replace(day=1) - timedelta(days=31 * (0 if i < 2 else hv % 6))
            rows.append(EmployeeSkill(
                employee_id=emp.id, skill=library[sid], level=level,
                target_level=min(5, level + 1) if level < 5 and hv % 5 < 3 else None,
                years=round(min(tenure + 1 + hv % 6, 1 + level * 2.5 + (hv % 10) / 10), 1), last_used=last.strftime("%Y-%m"),
                evidence_url=None))
    db.add_all(rows)
    return len(rows)


# ---------- learning ----------
LEADERSHIP_COURSES = ("crs-3", "crs-10", "crs-9")  # executives: leadership courses only, no employee compliance
DEPT_CERTS: dict[str, list[tuple[str, str, int | None]]] = {
    "Engineering": [("AWS Certified Developer - Associate", "Amazon Web Services", 3), ("Professional Scrum Master", "Scrum.org", None)],
    "IT": [("ITIL 4 Foundation", "PeopleCert", None), ("Microsoft Certified: Azure Administrator Associate", "Microsoft", 1)],
    "Human Resources": [("CIPD Level 5 Associate Diploma", "CIPD", None), ("SHRM Certified Professional", "SHRM", 3)],
    "People": [("CIPD Level 5 Associate Diploma", "CIPD", None)],
    "Talent Acquisition": [("Certified Diversity Recruiter", "AIRS", 3)],
    "Learning & Development": [("Certified Professional in Talent Development", "ATD", 3)],
    "Finance": [("ACCA Qualification", "ACCA", None), ("Certified Management Accountant", "IMA", None)],
    "Legal & Compliance": [("Certified Compliance and Ethics Professional", "SCCE", 2), ("CIPP/E", "IAPP", 2)],
    "Customer Success": [("Certified Customer Success Manager", "SuccessCOACHING", None)],
    "Operations": [("Lean Six Sigma Green Belt", "IASSC", None), ("Project Management Professional", "PMI", 3)],
    "Marketing": [("Google Analytics Certification", "Google", 1), ("Inbound Marketing Certification", "HubSpot", 2)],
    "Sales": [("Certified Sales Professional", "NASP", 3)],
    "Executive": [("Chartered Director", "Institute of Directors", None)],
}


def _course_for(course: Course, emp: Employee, ctx: _Ctx) -> bool:
    """The router's own rule (learning._course_open_to) seen from the employee's side."""
    if course.audience == "Engineering":
        return emp.department == "Engineering"
    if course.audience == "Managers":
        return ctx.is_manager(emp)
    if course.audience == "Hiring":
        return ctx.is_manager(emp) or emp.department in ("Human Resources", "People", "Talent Acquisition")
    return True


def _learning(db: Session, ctx: _Ctx) -> dict[str, int]:
    today = ctx.today
    courses = list(db.scalars(select(Course).where(Course.active.is_(True)).order_by(Course.id)))
    have = _have(db, Enrollment.employee_id)
    rows = []
    for emp in ctx.active:
        if emp.id in have or not courses:
            continue
        if _is_exec(emp):
            picks = [c for c in courses if c.id in LEADERSHIP_COURSES or (c.category == "Leadership" and not c.mandatory)]
        else:
            open_ = [c for c in courses if _course_for(c, emp, ctx)]
            mandatory = [c for c in open_ if c.mandatory]
            optional = [c for c in open_ if not c.mandatory]
            optional.sort(key=lambda c: _h(emp.id, c.id))
            if _h(emp.id, "skipmand") % 10 == 0:  # a few people not yet assigned their mandatory courses
                mandatory = mandatory[:1]
            picks = mandatory + optional[: 1 + _h(emp.id, "opt") % 2]
        for c in picks:
            hv = _h(emp.id, c.id, "enr")
            kind = hv % 10
            assigned_by = HR if c.mandatory else (emp.manager_id if hv % 3 == 0 and emp.manager_id else emp.id)
            if kind < 5:  # completed (never before the person joined)
                done = today - timedelta(days=10 + hv % 200)
                if done < emp.joining_date:
                    done = min(today, emp.joining_date + timedelta(days=3 + hv % 25))
                rows.append(Enrollment(id=f"enr-seed-{emp.id}-{c.id}"[:64], course_id=c.id, employee_id=emp.id, status="completed",
                                       progress=100, due=done + timedelta(days=hv % 20), completed_on=done,
                                       score=70 + hv % 29, assigned_by=assigned_by))
            elif kind < 8:  # in progress
                rows.append(Enrollment(id=f"enr-seed-{emp.id}-{c.id}"[:64], course_id=c.id, employee_id=emp.id, status="in_progress",
                                       progress=15 + hv % 70, due=today + timedelta(days=7 + hv % 50), assigned_by=assigned_by))
            else:  # not started
                rows.append(Enrollment(id=f"enr-seed-{emp.id}-{c.id}"[:64], course_id=c.id, employee_id=emp.id, status="assigned",
                                       progress=0, due=today + timedelta(days=14 + hv % 60), assigned_by=assigned_by))
    db.add_all(rows)
    have_cert = _have(db, Certification.employee_id)
    certs = []
    for emp in ctx.active:
        if emp.id in have_cert or _h(emp.id, "cert") % 10 >= 7:
            continue
        options = DEPT_CERTS.get(emp.department, [])
        for i, (name, issuer, years) in enumerate(options[: 1 + _h(emp.id, "certs") % 2]):
            hv = _h(emp.id, name)
            issued = today - timedelta(days=60 + hv % 1000)
            if issued < emp.joining_date:  # earned while working here, so not before joining
                issued = min(today, emp.joining_date + timedelta(days=20 + hv % 60))
            expires = None
            if years:
                expires = issued.replace(year=issued.year + years) if not (issued.month == 2 and issued.day == 29) else issued + timedelta(days=365 * years)
                if hv % 12 == 0:  # a few about to expire, so the expiring list has entries
                    expires = today + timedelta(days=5 + hv % 25)
            certs.append(Certification(id=f"cert-seed-{emp.id}-{i}"[:64], employee_id=emp.id, name=name, issuer=issuer,
                                       issued_on=issued, expires_on=expires, credential_id=f"{issuer[:3].upper()}-{hv % 900000 + 100000}"))
    db.add_all(certs)
    return {"talent_enrollments_added": len(rows), "talent_certifications_added": len(certs)}


# ---------- performance ----------
FOCUS = {
    "Engineering": ("delivery of the roadmap features", "shipped my items on time with good test coverage", "take on more design work"),
    "IT": ("platform reliability", "cut ticket resolution time and kept uptime above target", "lead the device refresh"),
    "Human Resources": ("employee experience", "ran the policy refresh and handled cases quickly", "build my workforce planning skills"),
    "People": ("people strategy", "kept the HR calendar on track across countries", "grow the HR business partner team"),
    "Talent Acquisition": ("hiring for open roles", "filled most roles within the target time", "improve our sourcing data"),
    "Learning & Development": ("learning programmes", "launched two new courses with good feedback", "measure learning impact better"),
    "Finance": ("month-end close and reporting", "closed every month on time with no restatements", "automate more of the forecast"),
    "Legal & Compliance": ("contract and compliance reviews", "cleared the review backlog and updated our policies", "lead a privacy audit"),
    "Customer Success": ("customer renewals", "kept renewals above target and reduced escalations", "own a larger portfolio"),
    "Operations": ("process improvements", "simplified two operating processes and cut handoffs", "run a cross-team project"),
    "Marketing": ("campaigns and pipeline", "delivered campaigns that beat the lead target", "get better at attribution"),
    "Sales": ("new business", "closed new accounts above my quota", "move into larger deals"),
    "Executive": ("company strategy", "set the strategy and kept the leadership team aligned", "spend more time with customers"),
}
MANAGER_NOTES = (
    "Consistent and reliable; delivered what was agreed and helped others.",
    "Strong half: took ownership of a hard problem and saw it through.",
    "Good progress. Needs to share updates earlier when work slips.",
    "Excellent impact this half and a role model for the team.",
    "Solid work. Next step is leading a small piece end to end.",
)
RATINGS = ["Solid"] * 10 + ["Strong"] * 6 + ["Exceptional"] * 2 + ["Needs improvement"] * 2
DEV_ACTIONS = ("Lead one design review this quarter", "Complete the course linked to my growth skill",
               "Present team work at the monthly all-hands", "Mentor a newer colleague", "Shadow a senior colleague for a week",
               "Write a short guide for a process I own")
COMMENTS_360 = ("Always willing to help and easy to work with.", "Clear communicator; keeps everyone informed.",
                "Very reliable on deadlines.", "Brings good ideas to team discussions.", "Could delegate a little more.")


def cycle_manager(by_id: dict[str, Employee], emp: Employee, cycle_end: date) -> str | None:
    """The manager who reviews emp for a cycle that ended on cycle_end: the current manager, or the first one up the
    reporting line who had joined by then (a manager who joined after the cycle closed cannot have rated it)."""
    seen: set[str] = set()
    mid = emp.manager_id if emp.manager_id in by_id else None
    while mid and mid not in seen and by_id[mid].joining_date > cycle_end:
        seen.add(mid)
        nxt = by_id[mid].manager_id
        mid = nxt if nxt in by_id else None
    return None if mid in seen else mid


def _cycle(db: Session) -> ReviewCycle | None:
    cid, name, start, end, self_due, mgr_due = PAST_CYCLE
    row = db.get(ReviewCycle, cid) or db.scalar(select(ReviewCycle).where(ReviewCycle.name == name))
    if row is None:
        row = ReviewCycle(id=cid, name=name, status="closed", start_date=date.fromisoformat(start), end_date=date.fromisoformat(end),
                          self_review_due=date.fromisoformat(self_due), manager_review_due=date.fromisoformat(mgr_due), created_by=HR)
        db.add(row)
        db.flush()
    return row


def _self_text(emp: Employee, cycle: ReviewCycle) -> str:
    focus, did, nxt = FOCUS.get(emp.department, FOCUS["Operations"])
    return f"In {cycle.name} I focused on {focus}. I {did}. Next I want to {nxt}."


def _performance(db: Session, ctx: _Ctx) -> dict[str, int]:
    today = ctx.today
    out = {"talent_reviews_added": 0, "talent_360_added": 0, "talent_dev_actions_added": 0, "talent_check_ins_added": 0, "talent_goals_added": 0}
    past = _cycle(db)
    current = db.get(ReviewCycle, CURRENT_CYCLE)
    reviews, reviewers, actions = [], [], []
    for cycle in (past, current):
        if cycle is None:
            continue
        is_past = cycle is past
        have = set(db.scalars(select(PerfReview.employee_id).where(PerfReview.cycle_id == cycle.id)))
        for emp in ctx.active:
            if emp.id in have or emp.joining_date > cycle.end_date or (not is_past and emp.id in DEMO_IDS):
                continue
            hv = _h(emp.id, cycle.id)
            rid = f"rev-seed-{cycle.id}-{emp.id}"[:64]
            mgr = emp.manager_id if emp.manager_id in ctx.by_id else None
            if is_past:  # the manager who rates a closed cycle must have been here during it
                mgr = cycle_manager(ctx.by_id, emp, cycle.end_date)
            self_at = _at(cycle.self_review_due - timedelta(days=1 + hv % 6), 11)
            mgr_at = _at(cycle.manager_review_due - timedelta(days=1 + hv % 5), 15)
            r = PerfReview(id=rid, cycle_id=cycle.id, employee_id=emp.id, self_status="submitted", self_text=_self_text(emp, cycle),
                           self_submitted_at=self_at, manager_status="not_started", released=False)
            if is_past:
                if mgr:  # someone without a manager (the CEO) has no manager-rated review
                    r.manager_status, r.manager_text, r.manager_id, r.manager_submitted_at = (
                        "submitted", _pick(MANAGER_NOTES, emp.id, "mn"), mgr, mgr_at)
                    r.rating, r.rating_proposed_by, r.rating_proposed_at = _pick(RATINGS, emp.id, "rating"), mgr, mgr_at
                    r.released, r.released_by, r.released_at = True, HR, _at(cycle.manager_review_due + timedelta(days=10), 9)
            else:  # current cycle: a mix of states
                stage = hv % 10
                if stage < 2:
                    r.self_status, r.self_text, r.self_submitted_at = "not_started", None, None
                elif stage < 4:
                    r.self_status, r.self_submitted_at = "draft", None
                elif stage < 7 and mgr:
                    r.manager_status, r.manager_text, r.manager_id = "draft", _pick(MANAGER_NOTES, emp.id, "mn2"), mgr
                elif mgr:
                    r.manager_status, r.manager_text, r.manager_id, r.manager_submitted_at = (
                        "submitted", _pick(MANAGER_NOTES, emp.id, "mn2"), mgr, mgr_at)
                    r.rating, r.rating_proposed_by, r.rating_proposed_at = _pick(RATINGS, emp.id, "rating2"), mgr, mgr_at
            reviews.append(r)
            if is_past and (emp.id in DEMO_IDS or hv % 3 == 0):
                pool = sorted((i for i in set(ctx.colleagues(emp)) - {emp.id} if ctx.by_id[i].joining_date <= cycle.end_date),
                              key=lambda i: _h(emp.id, i))
                for i, rev_id in enumerate(pool[: 2 + hv % 2]):
                    reviewers.append(Reviewer360(review_id=rid, reviewer_id=rev_id, nominated_by=emp.id,
                                                 nominated_at=self_at - timedelta(days=10), rating=3 + _h(rid, rev_id) % 3,
                                                 comment=_pick(COMMENTS_360, rid, rev_id),
                                                 responded_at=self_at - timedelta(days=3 - i % 3)))
            if is_past and (emp.id in DEMO_IDS or hv % 2 == 0):
                for i in range(1 + hv % 2):
                    title = DEV_ACTIONS[(hv + i) % len(DEV_ACTIONS)]
                    due = today + timedelta(days=-30 + 45 * i + hv % 40)
                    status = "done" if due < today else ("in_progress" if i == 0 else "not_started")
                    actions.append(DevAction(id=f"dev-seed-{cycle.id}-{emp.id}-{i}"[:64], review_id=rid, title=title, due=due,
                                             status=status))
    db.add_all(reviews)
    db.flush()
    db.add_all(reviewers)
    db.add_all(actions)
    out["talent_reviews_added"], out["talent_360_added"], out["talent_dev_actions_added"] = len(reviews), len(reviewers), len(actions)
    out["talent_check_ins_added"] = _check_ins(db, ctx)
    out["talent_goals_added"] = _goals(db, ctx, current)
    return out


CHECK_IN_NOTES = (
    "Went through current priorities and blockers. Workload is fine; agreed to flag risks earlier.",
    "Talked about growth goals and which course to take next. Good progress on this quarter's goals.",
    "Reviewed the last project: what went well and what to change. Planning time off next month.",
    "Discussed feedback from colleagues and how to share updates with the wider team.",
)
CHECK_IN_ACTIONS = ("Share a weekly status note", "Book the next course", "Pair with a teammate on the next task",
                    "Draft the plan for next quarter", "Update goal progress in the portal")


def _check_ins(db: Session, ctx: _Ctx) -> int:
    have = _have(db, CheckIn.employee_id)
    rows = []
    for emp in ctx.active:
        mgr = emp.manager_id
        if emp.id in have or not mgr or mgr not in ctx.by_id:
            continue
        hv = _h(emp.id, "1on1")
        for i in range(1 + hv % 3):
            day = _weekday(ctx.today - timedelta(days=7 + 21 * i + hv % 9))
            if day < emp.joining_date:
                break
            items = [{"text": CHECK_IN_ACTIONS[(hv + i + j) % len(CHECK_IN_ACTIONS)], "done": i > 0 or j == 0} for j in range(1 + (hv + i) % 2)]
            rows.append(CheckIn(id=f"chk-seed-{emp.id}-{i}"[:64], employee_id=emp.id, manager_id=mgr, meeting_date=day,
                                notes=CHECK_IN_NOTES[(hv + i) % len(CHECK_IN_NOTES)], action_items=items, created_by=mgr))
    db.add_all(rows)
    return len(rows)


GOALS_BY_DEPT: dict[str, list[tuple[str, str, str]]] = {
    "Engineering": [("goal", "Deliver committed roadmap items", "90% on time"), ("okr", "Improve code review turnaround", "< 1 day"),
                    ("kpi", "Production incidents caused", "0 high severity")],
    "IT": [("kpi", "Ticket first-response time", "< 4 hours"), ("goal", "Complete laptop refresh", "100% of due devices"),
           ("okr", "Raise SSO adoption", "All apps behind SSO")],
    "Finance": [("kpi", "Month-end close", "Within 5 working days"), ("goal", "Automate the expense reconciliation", "Live by quarter end"),
                ("okr", "Forecast accuracy", "Within 3%")],
    "Sales": [("kpi", "Quarterly bookings", "100% of quota"), ("goal", "Open new logos", "5 new accounts"),
              ("okr", "Pipeline coverage", "3x quota")],
    "Customer Success": [("kpi", "Gross renewal rate", ">= 92%"), ("goal", "Run quarterly business reviews", "All top accounts"),
                         ("okr", "Reduce escalations", "-25%")],
    "Marketing": [("kpi", "Marketing qualified leads", "+20% vs last half"), ("goal", "Launch the product campaign", "Live in 3 countries"),
                  ("okr", "Website conversion", "2.5%")],
    "Executive": [("okr", "Grow annual recurring revenue", "+30% year on year"), ("goal", "Open the next market", "Entity set up and first hires"),
                  ("kpi", "Employee engagement score", ">= 75")],
}
DEFAULT_GOALS = [("goal", "Deliver the team plan for the half", "All agreed items"), ("okr", "Improve a process I own", "One change live"),
                 ("kpi", "Complete assigned training", "100% by due date")]
HR_GOALS = [("goal", "Run the policy refresh", "Published in every country"), ("kpi", "Case resolution time", "< 10 working days"),
            ("okr", "Raise survey participation", ">= 70%")]


def _goals(db: Session, ctx: _Ctx, cycle: ReviewCycle | None) -> int:
    if cycle is None:
        return 0
    have = set(db.scalars(select(Goal.employee_id).where(Goal.cycle_id == cycle.id)))
    period = f"{cycle.start_date:%b}-{cycle.end_date:%b %Y}"
    rows = []
    for emp in ctx.active:
        if emp.id in have or emp.joining_date > cycle.end_date:
            continue
        hv = _h(emp.id, "goals")
        templates = GOALS_BY_DEPT.get(emp.department) or (HR_GOALS if emp.department in ("Human Resources", "People", "Talent Acquisition",
                                                                                           "Learning & Development") else DEFAULT_GOALS)
        for i, ((type_, title, target), weight) in enumerate(zip(templates, (40, 30, 30))):
            rows.append(Goal(id=f"g-seed-{emp.id}-{i}"[:64], employee_id=emp.id, cycle_id=cycle.id, type=type_, title=title,
                             target=target, period=period, weight=weight, progress=min(100, 30 + (hv >> (4 * i)) % 70),
                             created_by=emp.id))
    db.add_all(rows)
    return len(rows)


# ---------- recognition and surveys ----------
KUDOS_TEXT = {
    "Teamwork": "Thanks for jumping in to help the team finish on time.",
    "Ownership": "Took full ownership of a tricky problem and saw it through.",
    "Customer first": "Went the extra mile for a customer this month. Great work.",
    "Innovation": "Loved the new idea you brought to how we work.",
    "Mentorship": "Thank you for the patient guidance and time you gave me.",
}
POINTS = (10, 20, 25, 30, 50)


def _recognition(db: Session, ctx: _Ctx) -> dict[str, int]:
    today = ctx.today
    first = today.replace(day=1)
    givers = _have(db, Kudos.from_id)
    now = datetime.now(UTC)
    rows = []
    for emp in ctx.active:
        pool = sorted(set(ctx.colleagues(emp)) - {emp.id}, key=lambda i: _h(emp.id, i, "kd"))
        if emp.id in givers or not pool:
            continue
        hv = _h(emp.id, "kudos")
        for i, to in enumerate(pool[: 1 + hv % 2]):
            if emp.id in DEMO_IDS or i > 0:  # earlier months only, so nobody's allowance for this month is used up
                month_start = (first - timedelta(days=1 + 30 * ((hv + i) % 3))).replace(day=1)
                day = month_start + timedelta(days=(hv >> 3) % 25)
            else:
                day = max(first, today - timedelta(days=hv % 10))
            value = list(KUDOS_TEXT)[(hv + i) % len(KUDOS_TEXT)]
            at = min(_at(day, 9 + hv % 8, (hv >> 7) % 60), now - timedelta(minutes=30 + hv % 120))
            rows.append(Kudos(id=f"kd-seed-{emp.id}-{i}"[:64], from_id=emp.id, to_id=to, value=value, message=KUDOS_TEXT[value],
                              points=POINTS[(hv >> 5) % len(POINTS)] if (hv + i) % 4 else 0, month=at.strftime("%Y-%m"),
                              created_at=at))
    # Every demo sign-in receives some recognition (from a colleague, in an earlier month).
    receivers = set(db.scalars(select(Kudos.to_id).where(Kudos.points > 0).distinct())) | {k.to_id for k in rows if k.points}
    for demo_id in sorted(DEMO_IDS - receivers):
        emp = ctx.by_id.get(demo_id)
        near = [i for i in ctx.colleagues(emp) if i not in DEMO_IDS] if emp else []
        if emp and not near:  # e.g. Babu: everyone around him is a demo sign-in; a colleague from the department
            near = [e.id for e in ctx.active if e.department == emp.department and e.id not in DEMO_IDS]
        pool = sorted(near, key=lambda i: _h(demo_id, i, "to"))
        if emp is None or demo_id not in ctx.active_ids or not pool or db.get(Kudos, f"kd-seed-to-{demo_id}") is not None:
            continue
        hv = _h(demo_id, "to-kudos")
        day = (first - timedelta(days=1)).replace(day=1) + timedelta(days=hv % 25)
        value = list(KUDOS_TEXT)[hv % len(KUDOS_TEXT)]
        rows.append(Kudos(id=f"kd-seed-to-{demo_id}", from_id=pool[0], to_id=demo_id, value=value, message=KUDOS_TEXT[value],
                          points=POINTS[3 + hv % 2], month=day.strftime("%Y-%m"), created_at=_at(day, 11)))
    db.add_all(rows)
    db.flush()
    received = dict(db.execute(select(Kudos.to_id, func.sum(Kudos.points)).group_by(Kudos.to_id)).all())
    have_red = _have(db, RewardRedemption.employee_id)
    items = sorted(db.scalars(select(RewardItem).where(RewardItem.active.is_(True), RewardItem.needs_date.is_(False))),
                   key=lambda r: -r.points)
    redemptions = []
    for emp in ctx.active:
        points = int(received.get(emp.id) or 0)
        hv = _h(emp.id, "redeem")
        if emp.id in have_red or hv % 3 or not items:
            continue
        item = next((r for r in items if r.points <= points), None)
        if item is None:
            continue
        done = hv % 4 != 0
        when = _at(today - timedelta(days=3 + hv % 40), 12)
        redemptions.append(RewardRedemption(
            id=f"rr-seed-{emp.id}"[:64], employee_id=emp.id, reward_id=item.id, points=item.points, note="",
            status="Fulfilled" if done else "Requested", decided_by=HR if done else None, decided_at=when + timedelta(days=2) if done else None,
            decision_note="Sent by email." if done else None))
    db.add_all(redemptions)
    return {"talent_kudos_added": len(rows), "talent_redemptions_added": len(redemptions)}


PULSE_QUESTIONS = [
    {"id": "q1", "kind": "rating", "prompt": "I have the tools I need to do my job well"},
    {"id": "q2", "kind": "rating", "prompt": "My manager gives me useful feedback"},
    {"id": "q3", "kind": "enps", "prompt": "How likely are you to recommend us as a place to work?"},
    {"id": "q4", "kind": "text", "prompt": "What one thing would make work better?"},
]
PULSE_COMMENTS = ("More focus time without meetings.", "Clearer priorities across teams.", "Faster laptop replacements.",
                  "More learning budget.", "Better onboarding documents.", "More chances to meet other offices.")


def _answers(survey: EngagementSurvey, emp_id: str, mood: int) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for q in survey.questions or []:
        hv = _h(survey.id, emp_id, q.get("id"))
        if q.get("kind") == "rating":
            out[q["id"]] = max(1, min(5, 2 + mood + hv % 3))
        elif q.get("kind") == "enps":
            out[q["id"]] = max(0, min(10, 5 + mood + hv % 5))
        elif q.get("kind") == "text" and hv % 3 == 0:
            out[q["id"]] = _pick(PULSE_COMMENTS, survey.id, emp_id)
    return out


def _surveys(db: Session, ctx: _Ctx) -> dict[str, int]:
    today = ctx.today
    added_surveys = 0
    for i, months in enumerate((9, 6, 3)):  # three closed quarterly pulses, mood improving over time
        sid = f"srv-seed-past-{i + 1}"
        if db.get(EngagementSurvey, sid) is not None:
            continue
        opened = today - timedelta(days=30 * months)
        title = f"Quarterly pulse - {opened:%b %Y}"
        if db.scalar(select(EngagementSurvey.id).where(EngagementSurvey.title == title)):
            continue
        db.add(EngagementSurvey(id=sid, title=title, kind="pulse", questions=PULSE_QUESTIONS, anonymous=True, audience_type="all",
                                audience_value=None, open_date=opened, close_date=opened + timedelta(days=14), published=True,
                                created_by=HR))
        added_surveys += 1
    db.flush()
    responses, participants = [], []
    surveys = [s for s in db.scalars(select(EngagementSurvey).where(EngagementSurvey.published.is_(True),
                                                                    EngagementSurvey.audience_type == "all"))
               if s.id.startswith("srv-seed-past-") or s.id == "srv-pulse-seed"]
    for s in surveys:
        if db.scalar(select(func.count()).select_from(EngagementResponse).where(EngagementResponse.survey_id == s.id)):
            continue
        answered = set(db.scalars(select(EngagementParticipant.employee_id).where(EngagementParticipant.survey_id == s.id)))
        is_open = s.id == "srv-pulse-seed"
        mood = {"srv-seed-past-1": 0, "srv-seed-past-2": 1, "srv-seed-past-3": 1}.get(s.id, 1)
        for emp in ctx.active:
            if emp.id in answered or emp.joining_date > s.open_date and not is_open:
                continue
            if is_open and emp.id in DEMO_IDS:  # demo sign-ins can still answer the open pulse themselves
                continue
            hv = _h(s.id, emp.id, "takes")
            if hv % 100 >= (40 if is_open else 72):
                continue
            ans = _answers(s, emp.id, mood if s.id != "srv-seed-past-1" or hv % 2 else mood + 1)
            responses.append(EngagementResponse(id=hashlib.sha256(f"resp|{s.id}|{emp.id}".encode()).hexdigest()[:32], survey_id=s.id,
                                                employee_id=None if s.anonymous else emp.id, department=emp.department,
                                                country_code=emp.country_code, answers=ans))
            participants.append(EngagementParticipant(survey_id=s.id, employee_id=emp.id))
    responses.sort(key=lambda r: r.id)  # stored in id order, not the order people answered
    db.add_all(responses)
    db.add_all(participants)
    return {"talent_past_surveys_added": added_surveys, "talent_survey_responses_added": len(responses)}


# ---------- career ----------
BOARD_PATH = ("tr-seed-board", "Board Chair / Non-Executive Director", "executive", {"sk-11": "Expert", "sk-6": "Advanced", "sk-3": "Expert"})
CAREER_NOTES = {
    "engineering": "Keen to grow into system design and to lead larger pieces of work.",
    "people": "Wants broader exposure to workforce planning across countries.",
    "recruiting": "Interested in employee relations work alongside recruiting.",
    "it": "Would like to own cloud platform decisions end to end.",
    "executive": "Interested in board and advisory roles; mentoring founders.",
}


def _career(db: Session, ctx: _Ctx) -> int:
    changed = 0
    if db.get(Employee, CEO) is not None:
        if db.get(CareerPath, BOARD_PATH[0]) is None:
            pid, title, track, req = BOARD_PATH
            db.add(CareerPath(id=pid, title=title, track=track, function="Leadership", required_skills=dict(req), active=True))
            db.flush()
            changed += 1
        row = db.get(CareerProfile, CEO)
        if row is None:
            ceo = ctx.by_id[CEO]
            db.add(CareerProfile(employee_id=CEO, current_role=ceo.job_title, target_role_ids=[BOARD_PATH[0]], interests=["Leadership"],
                                 timeframe="2+ years", open_to_relocation=False, mentor_id=None, note=CAREER_NOTES["executive"],
                                 updated_by=None))
            changed += 1
        else:
            if not row.target_role_ids:
                row.target_role_ids = [BOARD_PATH[0]]
                changed += 1
            if not row.interests:
                row.interests = ["Leadership"]
                changed += 1
    from app.services.career import track_for

    from app.services.career import STARTER_SKILLS

    for row in db.scalars(select(CareerProfile).where(CareerProfile.employee_id.in_([*STARTER_SKILLS, CEO]))):
        emp = ctx.by_id.get(row.employee_id)
        if emp is None:
            continue
        if row.mentor_id is None and emp.manager_id:
            # A more senior colleague in the same department (not the line manager), else the skip-level manager.
            seniors = sorted((e.id for e in ctx.active if e.department == emp.department and e.id not in (emp.id, emp.manager_id)
                              and _base_level(e) > _base_level(emp)), key=lambda i: _h(emp.id, i, "mentor"))
            mgr = ctx.by_id.get(emp.manager_id)
            mentor = seniors[0] if seniors else (mgr.manager_id if mgr is not None and mgr.manager_id else emp.manager_id)
            if mentor and mentor != emp.id:
                row.mentor_id = mentor
                changed += 1
        if not (row.note or "").strip():
            row.note = CAREER_NOTES.get(track_for(emp) or "", "Wants to keep growing in the current function.")
            changed += 1
    return changed


# ---------- recruiting ----------
REASONS_TEXT = {
    "new_role": "New role to support growth in {dept}; the team cannot take on the planned work without it.",
    "replacement": "Backfill for a team member who moved on; the work is ongoing and the team is at capacity.",
}
COVER_NOTES = ("I have followed TimeZ for a while and would love to help build people software.",
               "My recent work matches this role closely and I am ready to move quickly.",
               "I am looking for a team where I can own outcomes and keep learning.")
BUDGET_PER_OPENING = {"INR": 3_200_000, "GBP": 75_000, "USD": 120_000, "CAD": 110_000, "EUR": 80_000, "AED": 300_000}
STAGE_ORDER = ["Applied", "Screening", "Shortlisted", "Interview", "Assessment", "Final Review", "Offer", "Hired"]


def _recruiting(db: Session, ctx: _Ctx) -> dict[str, int]:
    from app.services.talent_ai import MatchInput, match_candidate, needs_for_role

    from app.seed_talent import CANDIDATES, POSTINGS, REQUISITIONS

    filled = 0
    sample_reqs = {r[0] for r in REQUISITIONS}
    sample_cands = {c[0] for c in CANDIDATES}
    sample_posts = {p[1] for p in POSTINGS}
    reqs = {r.id: r for r in db.scalars(select(Requisition).where(Requisition.id.in_(sample_reqs)))}
    currencies = {e.country_code: e.currency for e in ctx.active}
    for r in reqs.values():
        hv = _h(r.id, "req")
        if not (r.description or "").strip():
            r.description = (f"{r.title} in {r.location}, part of the {r.department} team. "
                             f"Looking for: {', '.join(r.requirements or []) or 'relevant experience'}.")
            filled += 1
        if r.budget_currency is None:
            r.budget_currency = currencies.get(r.country_code, "USD")
            filled += 1
        if r.budget is None:
            r.budget = float(BUDGET_PER_OPENING.get(r.budget_currency or "USD", 100_000) * max(1, r.openings))
            filled += 1
        if r.reason is None:
            r.reason = "replacement" if hv % 3 == 0 else "new_role"
            filled += 1
        if not (r.justification or "").strip():
            r.justification = REASONS_TEXT[r.reason if r.reason in REASONS_TEXT else "new_role"].format(dept=r.department)
            filled += 1
        if r.raised_by is None:
            r.raised_by = r.hiring_manager_id
            filled += 1
    postings = {p.requisition_id: p for p in db.scalars(select(JobPosting).where(JobPosting.id.in_(sample_posts)))}
    for p in postings.values():
        if not (p.description or "").strip():
            req = reqs.get(p.requisition_id)
            p.description = req.description if req is not None and req.description else f"Join TimeZ as {p.title} in {p.location}."
            filled += 1
    now = datetime.now(UTC)
    cands = list(db.scalars(select(Candidate).where(Candidate.id.in_(sample_cands))))
    for c in cands:
        req = reqs.get(c.requisition_id)
        if c.posting_id is None and c.requisition_id in postings:
            c.posting_id = postings[c.requisition_id].id
            filled += 1
        if c.cv_filename is None:
            c.cv_filename = f"{c.name.replace(' ', '_')}_CV.pdf"
            filled += 1
        if not (c.cover_note or "").strip():
            c.cover_note = _pick(COVER_NOTES, c.id)
            filled += 1
        if c.match_score is None and req is not None:
            try:
                needs = needs_for_role(req.title, req.department, list(req.requirements or []))
                fit = match_candidate(MatchInput(c.name, list(c.skills or []), " ".join(filter(None, [c.cv_note, c.cover_note])),
                                                 c.experience_years or 0), needs)
                c.match_score = int(fit["score"])
            except Exception:  # noqa: BLE001 - a sample score is fine if the matcher changes
                c.match_score = 55 + _h(c.id) % 40
            filled += 1
    # A past interview for candidates who reached Interview but have none yet.
    with_interview = _have(db, Interview.candidate_id)
    new_interviews = []
    for c in cands:
        req = reqs.get(c.requisition_id)
        reached = c.stage in STAGE_ORDER and STAGE_ORDER.index(c.stage) >= STAGE_ORDER.index("Interview")
        if c.id in with_interview or not reached or req is None or req.hiring_manager_id not in ctx.by_id:
            continue
        hv = _h(c.id, "int")
        when = _at(_weekday(ctx.today - timedelta(days=5 + hv % 12)), 6)
        new_interviews.append(Interview(id=f"int-seed-ta-{c.id}"[:64], candidate_id=c.id, scheduled_at=when, duration_minutes=60,
                                        kind=_pick(("Technical", "Panel", "Hiring manager"), c.id), panel_ids=[req.hiring_manager_id],
                                        feedback_status="submitted", score=3 + hv % 3, created_by=RECRUITER,
                                        feedback="Good fit for the role; clear examples from recent work.", feedback_by=req.hiring_manager_id,
                                        feedback_at=when + timedelta(hours=3)))
    db.add_all(new_interviews)
    db.flush()
    for i in db.scalars(select(Interview).where(Interview.id.like("int-seed-%"))):
        when = i.scheduled_at if i.scheduled_at.tzinfo else i.scheduled_at.replace(tzinfo=UTC)
        if when >= now or i.feedback_status != "submitted":
            continue
        score = i.score or 3 + _h(i.id) % 3
        if i.ratings is None:
            i.ratings = {"Skills": score, "Experience": max(1, score - _h(i.id, "e") % 2), "Communication": min(5, score + _h(i.id, "c") % 2),
                         "Culture add": max(1, min(5, score + _h(i.id, "x") % 3 - 1))}
            filled += 1
        if i.recommendation is None:
            i.recommendation = {5: "strong_yes", 4: "yes", 3: "yes"}.get(score, "no")
            filled += 1
        if not (i.feedback or "").strip():
            i.feedback = "Solid interview; strengths match the role. See scorecard."
            filled += 1
    return {"talent_recruiting_fields_filled": filled, "talent_interviews_added": len(new_interviews),
            "talent_recruiter_activity_added": _recruiter_activity(db, ctx, reqs, postings)}


def _recruiter_activity(db: Session, ctx: _Ctx, reqs: dict[str, Requisition], postings: dict[str, JobPosting]) -> int:
    """Sophie's recent recruiting actions (her "My activity" page), from the pipeline rows she owns. Once only."""
    if RECRUITER not in ctx.by_id or db.scalar(select(AuditLog.id).where(
            AuditLog.actor_id == RECRUITER, AuditLog.entity.in_(("requisition", "candidate", "interview", "offer"))).limit(1)):
        return 0
    now = datetime.now(UTC)
    since = now - timedelta(days=85)
    names = {c.id: (c.name, c.requisition_id) for c in db.scalars(select(Candidate))}
    rows = []
    for p in postings.values():
        if p.published_by == RECRUITER and _at(p.published_on, 10) >= since:
            req = reqs.get(p.requisition_id)
            rows.append(AuditLog(actor_id=RECRUITER, action="posting_published", entity="requisition", entity_id=p.requisition_id,
                                 subject_id=req.hiring_manager_id if req else None, at=_at(p.published_on, 10),
                                 changes={"before": None, "after": {"posting_id": p.id, "title": p.title}}))
    for st in db.scalars(select(CandidateStage).where(CandidateStage.by_id == RECRUITER)):
        at = st.entered_at if st.entered_at.tzinfo else st.entered_at.replace(tzinfo=UTC)
        if not since <= at <= now or st.candidate_id not in names:
            continue
        name, rid = names[st.candidate_id]
        req = reqs.get(rid)
        action = "candidate_added" if st.stage == "Applied" else "candidate_stage_moved"
        rows.append(AuditLog(actor_id=RECRUITER, action=action, entity="candidate", entity_id=st.candidate_id,
                             subject_id=req.hiring_manager_id if req else None, at=at,
                             changes={"before": None, "after": {"stage": st.stage, "name": name}}))
    for i in db.scalars(select(Interview).where(Interview.created_by == RECRUITER)):
        when = i.scheduled_at if i.scheduled_at.tzinfo else i.scheduled_at.replace(tzinfo=UTC)
        at = min(now - timedelta(hours=1), when - timedelta(days=3))
        if at < since or i.candidate_id not in names:
            continue
        name, rid = names[i.candidate_id]
        req = reqs.get(rid)
        rows.append(AuditLog(actor_id=RECRUITER, action="interview_scheduled", entity="interview", entity_id=i.id,
                             subject_id=req.hiring_manager_id if req else None, at=at,
                             changes={"before": None, "after": {"candidate": name, "kind": i.kind, "scheduled_at": when.isoformat()}}))
    rows.sort(key=lambda r: r.at)
    db.add_all(rows)
    return len(rows)


def seed(db: Session) -> dict[str, int]:
    db.flush()
    ctx = _Ctx(db, date.today())
    stats: dict[str, int] = {"talent_skills_added": _skills(db, ctx)}
    stats.update(_learning(db, ctx))
    db.flush()
    stats.update(_performance(db, ctx))
    db.flush()
    stats.update(_recognition(db, ctx))
    stats.update(_surveys(db, ctx))
    db.flush()
    stats["talent_career_filled"] = _career(db, ctx)
    stats.update(_recruiting(db, ctx))
    db.flush()
    return stats
