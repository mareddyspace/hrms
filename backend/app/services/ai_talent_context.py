"""Talent and benefits blocks for AI context (Copilot and the Employee 360 summary). Permission-checked:

- goals: the person's own; for managers, their direct reports' goal progress (no ratings)
- ratings: released ones only, and only the person's own (the 360 summary: viewer self / above / HR)
- skills, learning (enrollments, certifications, expiring ones), career profile: own; managers and HR get their team's
  (counts and target roles only for career interests)
- benefits enrolment: own only, never someone else's

Never pay, review text, 360 comments or case notes.
"""

from __future__ import annotations

from collections import Counter
from datetime import date, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import (
    BenefitEnrollment,
    BenefitPlan,
    CareerPath,
    CareerProfile,
    Certification,
    Course,
    Employee,
    EmployeeSkill,
    Enrollment,
    Goal,
    PerfReview,
    ReviewCycle,
)
from app.models.career import SKILL_LEVELS

EXPIRING_DAYS = 60


def _level(n: int | None) -> str:
    return SKILL_LEVELS[max(1, min(5, n)) - 1] if n else "not set"


def _open_cycle_ids(db: Session) -> list[str]:
    return list(db.scalars(select(ReviewCycle.id).where(ReviewCycle.status != "closed")))


def goals_block(db: Session, emp: Employee, heading: str = "YOUR GOALS") -> str | None:
    cycles = _open_cycle_ids(db)
    if not cycles:
        return None
    goals = list(db.scalars(select(Goal).where(Goal.employee_id == emp.id, Goal.cycle_id.in_(cycles)).order_by(Goal.weight.desc())))
    if not goals:
        return f"{heading}\n- No goals in an open review cycle"
    lines = [f"{heading} (open review cycles)"]
    for g in goals[:10]:
        lines.append(f"- {g.title} ({g.type.upper()}, weight {g.weight}%): target {g.target}; progress {g.progress}%")
    return "\n".join(lines)


def team_goals_block(db: Session, manager: Employee) -> str | None:
    cycles = _open_cycle_ids(db)
    direct = list(db.scalars(select(Employee).where(Employee.manager_id == manager.id).order_by(Employee.full_name)))
    if not cycles or not direct:
        return None
    rows = db.execute(
        select(Goal.employee_id, func.count(), func.avg(Goal.progress))
        .where(Goal.employee_id.in_([e.id for e in direct]), Goal.cycle_id.in_(cycles)).group_by(Goal.employee_id)
    ).all()
    by_emp = {eid: (n, avg) for eid, n, avg in rows}
    without = sum(1 for e in direct if e.id not in by_emp)
    lines = ["YOUR DIRECT REPORTS' GOALS (open review cycles; progress only)"]
    for e in direct:
        if e.id in by_emp:
            n, avg = by_emp[e.id]
            lines.append(f"- {e.full_name}: {n} goal(s), average progress {round(avg or 0)}%")
        if len(lines) > 15:
            break
    lines.append(f"- Direct reports with no goals yet: {without} of {len(direct)}")
    return "\n".join(lines)


def ratings_block(db: Session, emp: Employee, heading: str = "YOUR PERFORMANCE RATINGS (released by HR)") -> str | None:
    rows = db.execute(
        select(ReviewCycle.name, PerfReview.rating)
        .join(ReviewCycle, ReviewCycle.id == PerfReview.cycle_id)
        .where(PerfReview.employee_id == emp.id, PerfReview.released.is_(True), PerfReview.rating.is_not(None))
        .order_by(ReviewCycle.start_date.desc())
    ).all()
    if not rows:
        return None
    return heading + "\n" + "\n".join(f"- {name}: {rating}" for name, rating in rows[:5])


def skills_block(db: Session, emp: Employee, heading: str = "YOUR SKILLS") -> str | None:
    rows = list(db.scalars(select(EmployeeSkill).where(EmployeeSkill.employee_id == emp.id).order_by(EmployeeSkill.level.desc())))
    if not rows:
        return f"{heading}\n- None saved yet (the Skills page shows a starting list)"
    lines = [heading]
    for s in rows[:15]:
        target = f", aiming for {_level(s.target_level)}" if s.target_level and s.target_level != s.level else ""
        lines.append(f"- {s.skill}: {_level(s.level)}{target}")
    return "\n".join(lines)


def learning_block(db: Session, emp: Employee, today: date, heading: str = "YOUR LEARNING") -> str | None:
    enrollments = db.execute(
        select(Course.title, Enrollment.status, Enrollment.progress, Enrollment.due)
        .join(Course, Course.id == Enrollment.course_id).where(Enrollment.employee_id == emp.id).order_by(Enrollment.due)
    ).all()
    certs = list(db.scalars(select(Certification).where(Certification.employee_id == emp.id).order_by(Certification.expires_on)))
    if not enrollments and not certs:
        return None
    lines = [heading]
    for title, status, progress, due in enrollments[:10]:
        when = f", due {due.isoformat()}" if due and status != "completed" else ""
        overdue = " (overdue)" if due and status != "completed" and due < today else ""
        lines.append(f"- Course {title}: {status.replace('_', ' ')}, {progress}%{when}{overdue}")
    for c in certs[:10]:
        if c.expires_on is None:
            state = "no expiry"
        elif c.expires_on < today:
            state = f"expired {c.expires_on.isoformat()}"
        elif c.expires_on <= today + timedelta(days=EXPIRING_DAYS):
            state = f"expires soon, {c.expires_on.isoformat()}"
        else:
            state = f"valid until {c.expires_on.isoformat()}"
        lines.append(f"- Certification {c.name}: {state}")
    return "\n".join(lines)


def team_learning_block(db: Session, report_ids: set[str], today: date) -> str | None:
    if not report_ids:
        return None
    ids = list(report_ids)
    expiring = db.scalar(select(func.count()).select_from(Certification).where(
        Certification.employee_id.in_(ids), Certification.expires_on.is_not(None),
        Certification.expires_on >= today, Certification.expires_on <= today + timedelta(days=EXPIRING_DAYS))) or 0
    overdue = db.scalar(select(func.count()).select_from(Enrollment).where(
        Enrollment.employee_id.in_(ids), Enrollment.status != "completed", Enrollment.due.is_not(None), Enrollment.due < today)) or 0
    return (f"YOUR TEAM'S LEARNING (counts only)\n- Certifications expiring in the next {EXPIRING_DAYS} days: {expiring}\n"
            f"- Overdue course assignments: {overdue}")


def benefits_block(db: Session, emp: Employee) -> str | None:
    """Own enrolment only."""
    rows = db.execute(
        select(BenefitPlan.name, BenefitPlan.plan_type, BenefitEnrollment.status, BenefitEnrollment.effective_date)
        .join(BenefitPlan, BenefitPlan.id == BenefitEnrollment.plan_id).where(BenefitEnrollment.employee_id == emp.id)
        .order_by(BenefitPlan.plan_type, BenefitPlan.name)
    ).all()
    if not rows:
        return "YOUR BENEFITS\n- No benefit enrolments on record (see the Benefits page)"
    lines = ["YOUR BENEFITS (enrolment status only)"]
    for name, kind, status, eff in rows[:12]:
        label = {"approved": "enrolled", "requested": "requested, waiting for HR", "waived": "waived"}.get(status, status)
        lines.append(f"- {name} ({kind}): {label}" + (f" from {eff.isoformat()}" if eff and status == "approved" else ""))
    return "\n".join(lines)


def career_block(db: Session, emp: Employee, heading: str = "YOUR CAREER INTERESTS") -> str | None:
    row = db.get(CareerProfile, emp.id)
    if row is None:
        return f"{heading}\n- Not shared yet (add them on the Skills page)"
    titles = dict(db.execute(select(CareerPath.id, CareerPath.title)).all())
    targets = ", ".join(titles.get(i, i) for i in row.target_role_ids or []) or "none picked"
    return (f"{heading}\n- Current role: {row.current_role or emp.job_title}\n- Target roles: {targets}\n"
            f"- Preferred functions: {', '.join(row.interests or []) or 'none'}\n- Timeframe: {row.timeframe}; "
            f"open to relocation: {'yes' if row.open_to_relocation else 'no'}")


def team_career_block(db: Session, label: str, report_ids: set[str] | None = None, employee_filter=None) -> str | None:  # type: ignore[no-untyped-def]
    """Counts of shared career interests by target role: for report_ids, or everyone matching employee_filter (HR)."""
    stmt = select(CareerProfile.target_role_ids, CareerProfile.timeframe)
    if report_ids is not None:
        if not report_ids:
            return None
        stmt = stmt.where(CareerProfile.employee_id.in_(list(report_ids)))
    elif employee_filter is not None:
        stmt = stmt.join(Employee, Employee.id == CareerProfile.employee_id).where(employee_filter)
    else:
        return None
    rows = db.execute(stmt).all()
    if not rows:
        return f"{label}\n- Nobody has shared career interests yet"
    titles = dict(db.execute(select(CareerPath.id, CareerPath.title)).all())
    roles = Counter(titles.get(r, r) for ids, _ in rows for r in ids or [])
    soon = sum(1 for _, tf in rows if tf == "Next 6 months")
    top = ", ".join(f"{t}: {n}" for t, n in roles.most_common(6)) or "none"
    return f"{label}\n- People who shared interests: {len(rows)}; looking to move in the next 6 months: {soon}\n- Target roles: {top}"


def copilot_blocks(db: Session, user) -> list[tuple[str, str | None, str | None]]:  # type: ignore[no-untyped-def]
    """(block text, data source title, portal page) for the HR Copilot, from what this user may see."""
    from app.services.attendance import local_today

    me = user.employee
    out: list[tuple[str, str | None, str | None]] = []

    def add(text: str | None, title: str | None = None, ref: str | None = None) -> None:
        if text:
            out.append((text, title, ref))

    if me is not None:
        today = local_today(me)
        add(goals_block(db, me), "Your goals", "/performance")
        add(ratings_block(db, me), "Your released ratings", "/performance")
        add(skills_block(db, me), "Your skills", "/skills")
        add(learning_block(db, me, today), "Your learning", "/learning")
        add(benefits_block(db, me), "Your benefits", "/benefits")
        add(career_block(db, me), "Your career interests", "/skills")
        if user.scope.reports:
            add(team_goals_block(db, me), "Your team's goals", "/team")
            add(team_learning_block(db, user.scope.reports, today), "Your team's learning", "/learning")
            if not user.scope.is_hr:
                add(team_career_block(db, "YOUR TEAM'S CAREER INTERESTS (counts only)", report_ids=user.scope.reports),
                    "Team career interests", "/skills")
    if user.scope.is_hr:
        add(team_career_block(db, "CAREER INTERESTS IN YOUR HR SCOPE (counts only)", employee_filter=user.scope.employee_filter()),
            "Career interests", "/skills")
    return out
