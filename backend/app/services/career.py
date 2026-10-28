"""Skills library, career paths, career profiles and role matching.

Role matching is a straight port of the front end's src/data/careerMatch.ts (rankRoles) and the starting-skills /
next-role rules of src/data/careerProfile.ts, so both give the same answers. Deterministic; every result is a
suggestion for the person and their manager to talk about.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.deps import CurrentUser
from app.models import (
    CareerPath,
    CareerProfile,
    Country,
    Course,
    Employee,
    EmployeeSkill,
    Enrollment,
    JobProfile,
    Requisition,
    Skill,
)
from app.models.career import CAREER_FUNCTIONS, CAREER_TIMEFRAMES, SKILL_LEVELS
from app.services.scope import manager_chain_ids

LEVEL_RANK = {name: i + 1 for i, name in enumerate(SKILL_LEVELS)}
MAX_TARGET_ROLES = 3


def level_name(level: int | None) -> str:
    return SKILL_LEVELS[max(1, min(5, level)) - 1] if level else "None"


# ---------- seed data (src/data/talentData.ts SKILL_LIBRARY, TARGET_ROLES; careerProfile.ts) ----------
# id, name, area, category, description, certifications
SKILLS: list[tuple[str, str, str, str, str, list[str]]] = [
    ("sk-1", "React", "Engineering", "technical", "Building web interfaces with React and its ecosystem.", []),
    ("sk-2", "TypeScript", "Engineering", "technical", "Writing typed, maintainable JavaScript.", []),
    ("sk-3", "People leadership", "Leadership", "behavioural", "Leading, coaching and growing a team.", []),
    ("sk-4", "Cloud architecture", "Engineering", "technical", "Designing systems on AWS, Azure or GCP.",
     ["AWS Certified Developer - Associate"]),
    ("sk-5", "Recruiting", "People", "technical", "Sourcing, screening and closing candidates.", ["Certified Diversity Recruiter"]),
    ("sk-6", "Financial analysis", "Finance", "technical", "Budgets, forecasts and financial models.", []),
    ("sk-7", "System design", "Engineering", "technical", "Designing scalable, reliable software systems.", []),
    ("sk-8", "Employee relations", "People", "behavioural", "Handling concerns, investigations and workplace relations.", []),
    ("sk-9", "Reward and pay", "People", "technical", "Pay, bonus and benefits planning.", []),
    ("sk-10", "Product management", "Product", "technical", "Discovery, roadmaps and product delivery.", []),
    ("sk-11", "Business strategy", "Leadership", "behavioural", "Setting direction and making trade-offs for the business.", []),
    ("sk-12", "Platform administration", "IT", "technical", "Running identity, devices and internal platforms.", []),
]

TRACK_FUNCTION = {
    "engineering": "Engineering", "people": "People", "recruiting": "Talent Acquisition", "reward": "Total Rewards",
    "product": "Product", "it": "IT", "executive": "Leadership",
}

# id, title, track, required {skill id: level}
TARGET_ROLES: list[tuple[str, str, str, dict[str, str]]] = [
    ("tr-1", "Senior Engineer", "engineering", {"sk-1": "Advanced", "sk-2": "Advanced", "sk-7": "Intermediate"}),
    ("tr-2", "Tech Lead", "engineering", {"sk-1": "Advanced", "sk-3": "Intermediate", "sk-7": "Advanced"}),
    ("tr-3", "Engineering Manager", "engineering", {"sk-3": "Advanced", "sk-7": "Intermediate", "sk-4": "Working"}),
    ("tr-4", "Director of Engineering", "engineering", {"sk-3": "Expert", "sk-11": "Advanced", "sk-4": "Intermediate"}),
    ("tr-5", "Chief People Officer", "people", {"sk-8": "Expert", "sk-3": "Expert", "sk-11": "Advanced"}),
    ("tr-6", "Talent Acquisition Manager", "recruiting", {"sk-5": "Expert", "sk-3": "Intermediate", "sk-8": "Working"}),
    ("tr-7", "HR Business Partner", "recruiting", {"sk-8": "Advanced", "sk-5": "Intermediate", "sk-9": "Working"}),
    ("tr-8", "Head of Total Rewards", "reward", {"sk-9": "Expert", "sk-6": "Advanced", "sk-3": "Intermediate"}),
    ("tr-9", "VP Product", "product", {"sk-10": "Expert", "sk-11": "Advanced", "sk-3": "Advanced"}),
    ("tr-10", "IT Manager", "it", {"sk-12": "Expert", "sk-4": "Advanced", "sk-3": "Intermediate"}),
]

# Named people's hand-written starting skills and track (talentData.ts STARTER_SKILLS): {skill id: level}
STARTER_SKILLS: dict[str, tuple[str, dict[str, str]]] = {
    "emp-mahesh": ("engineering", {"sk-1": "Advanced", "sk-2": "Intermediate", "sk-7": "Intermediate", "sk-4": "Working"}),
    "emp-ram": ("engineering", {"sk-3": "Advanced", "sk-7": "Advanced", "sk-1": "Intermediate", "sk-4": "Working", "sk-11": "Working"}),
    "demo-hr-admin": ("people", {"sk-8": "Expert", "sk-3": "Advanced", "sk-5": "Intermediate", "sk-9": "Working", "sk-11": "Intermediate"}),
    "demo-recruiter": ("recruiting", {"sk-5": "Advanced", "sk-8": "Working", "sk-3": "Awareness"}),
    "demo-ceo": ("executive", {"sk-11": "Expert", "sk-3": "Expert", "sk-6": "Advanced", "sk-10": "Advanced"}),
    "demo-admin": ("it", {"sk-12": "Advanced", "sk-4": "Intermediate", "sk-7": "Working"}),
    "emp-priya": ("engineering", {"sk-3": "Working", "sk-8": "Intermediate", "sk-2": "Working"}),
    "emp-anu": ("engineering", {"sk-3": "Intermediate", "sk-7": "Working", "sk-2": "Working"}),
    "emp-kabir": ("engineering", {"sk-7": "Advanced", "sk-4": "Advanced", "sk-2": "Advanced", "sk-1": "Intermediate"}),
    "emp-diya": ("engineering", {"sk-2": "Intermediate", "sk-1": "Working", "sk-7": "Awareness"}),
}

TRACK_BY_DEPARTMENT = {
    "Engineering": "engineering", "Product": "product", "People": "people", "Talent Acquisition": "recruiting",
    "Total Rewards": "reward", "IT": "it", "Executive": "executive",
}
SKILLS_BY_DEPARTMENT = {
    "Engineering": ["sk-2", "sk-7", "sk-1", "sk-4"], "Product": ["sk-10", "sk-11", "sk-7"], "People": ["sk-8", "sk-5", "sk-9"],
    "Talent Acquisition": ["sk-5", "sk-8"], "Total Rewards": ["sk-9", "sk-6"], "Finance": ["sk-6", "sk-11"],
    "Sales": ["sk-11", "sk-10"], "Operations": ["sk-11", "sk-6"], "Customer Success": ["sk-10", "sk-11"],
    "Legal": ["sk-8", "sk-11"], "Executive": ["sk-11", "sk-6", "sk-10"], "IT": ["sk-12", "sk-4"],
}
GRADE_LEVEL = {"L3": 1, "L4": 1, "L5": 2, "L6": 3, "M1": 3, "M2": 3, "M3": 4, "E1": 4}
GRADE_INDEX = {"L3": 0, "L4": 0, "L5": 0, "L6": 1, "M1": 2, "M2": 3, "M3": 3, "E1": 3}
LEADER_GRADES = {"L6", "M1", "M2", "M3", "E1"}

# careerMatch.ts: requisitions carry no library skills, so each department gets a typical requirement
DEPARTMENT_SKILLS = {
    "Engineering": {"sk-1": "Intermediate", "sk-2": "Intermediate", "sk-7": "Working"},
    "IT": {"sk-12": "Advanced", "sk-4": "Intermediate"},
    "People": {"sk-8": "Intermediate", "sk-5": "Working"},
    "Talent Acquisition": {"sk-5": "Advanced", "sk-8": "Working"},
    "Total Rewards": {"sk-9": "Advanced", "sk-6": "Intermediate"},
    "Finance": {"sk-6": "Advanced", "sk-11": "Working"},
    "Product": {"sk-10": "Advanced", "sk-11": "Intermediate"},
}
FALLBACK_SKILLS = {"sk-11": "Working", "sk-3": "Working"}
DEPARTMENT_FUNCTION = {
    "Engineering": "Engineering", "IT": "IT", "People": "People", "Talent Acquisition": "Talent Acquisition",
    "Total Rewards": "Total Rewards", "Finance": "Total Rewards", "Product": "Product",
}
WEEKS_PER_LEVEL = 8  # suggested timeline: about two months of practice per skill level


# ---------- who ----------
def is_hr_for(user: CurrentUser, emp: Employee) -> bool:
    return user.scope.is_hr and (not user.scope.countries or emp.country_code in user.scope.countries)


def can_view_career(db: Session, user: CurrentUser, emp: Employee) -> bool:
    """The person, anyone above them, and HR (within country scope)."""
    if emp.id == user.employee_id:
        return True
    if is_hr_for(user, emp):
        return True
    return user.employee_id is not None and (emp.id in user.scope.reports or user.employee_id in manager_chain_ids(db, emp.id))


def sees_team_interests(user: CurrentUser) -> bool:
    return user.scope.is_hr or bool(user.scope.reports)


# ---------- seed ----------
def seed_career(db: Session) -> dict[str, int]:
    """Insert-once by id (rows HR changed are never overwritten)."""
    db.flush()
    added = {"skills_added": 0, "career_paths_added": 0, "career_profiles_added": 0}
    courses = list(db.scalars(select(Course)))
    profiles = list(db.scalars(select(JobProfile)))
    profile_by_title = {p.title.strip().lower(): p.id for p in profiles}
    for sid, name, area, category, desc, certs in SKILLS:
        if db.get(Skill, sid) is not None:
            continue
        related_paths = [title for _, title, _, req in TARGET_ROLES if sid in req]
        db.add(Skill(
            id=sid, name=name, area=area, category=category, description=desc, certifications=certs, active=True,
            related_course_ids=[c.id for c in courses if any(s.lower() == name.lower() for s in (c.skills or []))],
            related_profile_ids=sorted(
                {profile_by_title[t.lower()] for t in related_paths if t.lower() in profile_by_title}
                | {p.id for p in profiles if any(str(s).lower() == name.lower() for s in (p.required_skills or []))}
            ),
        ))
        added["skills_added"] += 1
    previous: dict[str, str | None] = {}
    for pid, title, track, req in TARGET_ROLES:
        to_profile = profile_by_title.get(title.lower())
        if db.get(CareerPath, pid) is None:
            db.add(CareerPath(id=pid, title=title, track=track, function=TRACK_FUNCTION[track], required_skills=dict(req),
                              from_profile_id=previous.get(track), to_profile_id=to_profile, active=True))
            added["career_paths_added"] += 1
        previous[track] = to_profile
    db.flush()
    for emp_id in STARTER_SKILLS:
        emp = db.get(Employee, emp_id)
        if emp is None or db.get(CareerProfile, emp_id) is not None:
            continue
        nxt = next_role(db, emp)
        if nxt is None:
            continue
        db.add(CareerProfile(employee_id=emp_id, current_role=emp.job_title, target_role_ids=[nxt.id],
                             interests=[nxt.function], timeframe="1–2 years", open_to_relocation=False, note="",
                             updated_by=None))
        added["career_profiles_added"] += 1
    db.flush()
    return added


# ---------- skills of a person ----------
def library(db: Session, include_inactive: bool = False) -> list[Skill]:
    stmt = select(Skill).order_by(Skill.name)
    if not include_inactive:
        stmt = stmt.where(Skill.active.is_(True))
    return list(db.scalars(stmt))


def _skill_id_by_name(db: Session) -> dict[str, str]:
    return {s.name.lower(): s.id for s in db.scalars(select(Skill))}


def track_for(emp: Employee) -> str | None:
    if emp.id in STARTER_SKILLS:
        return STARTER_SKILLS[emp.id][0]
    return TRACK_BY_DEPARTMENT.get(emp.department)


def starter_skills(emp: Employee) -> dict[str, str]:
    """careerProfile.ts starterSkills (named people: talentData STARTER_SKILLS)."""
    if emp.id in STARTER_SKILLS:
        return dict(STARTER_SKILLS[emp.id][1])
    base = GRADE_LEVEL.get(emp.grade, 1)
    ids = SKILLS_BY_DEPARTMENT.get(emp.department, ["sk-11"])
    out = {sid: level_name(max(1, min(5, base - (1 if i >= 2 else 0) + 1))) for i, sid in enumerate(ids)}
    if emp.grade in LEADER_GRADES and "sk-3" not in ids:
        out["sk-3"] = level_name(max(1, base))
    return out


def skills_of(db: Session, emp: Employee) -> tuple[dict[str, str], bool]:
    """{library skill id: level name}, and whether these are the person's saved skills (else the starting list)."""
    rows = list(db.scalars(select(EmployeeSkill).where(EmployeeSkill.employee_id == emp.id)))
    if not rows:
        return starter_skills(emp), False
    by_name = _skill_id_by_name(db)
    out: dict[str, str] = {}
    for r in rows:
        sid = by_name.get(r.skill.strip().lower())
        if sid:
            out[sid] = level_name(r.level)
    return out, True


def next_role(db: Session, emp: Employee) -> CareerPath | None:
    """careerProfile.ts careerTarget: the next role on the person's track."""
    track = track_for(emp)
    if not track:
        return None
    roles = list(db.scalars(select(CareerPath).where(CareerPath.track == track, CareerPath.active.is_(True)).order_by(CareerPath.id)))
    roles.sort(key=lambda r: int(r.id.split("-")[-1]) if r.id.split("-")[-1].isdigit() else 999)
    if not roles:
        return None
    title = (emp.job_title or "").strip().lower()
    current = next((i for i, r in enumerate(roles) if r.title.lower() == title), -1)
    index = current + 1 if current >= 0 else GRADE_INDEX.get(emp.grade, 0)
    role = roles[min(index, len(roles) - 1)]
    return None if role.title.lower() == title else role


# ---------- matching (careerMatch.ts rankRoles) ----------
@dataclass
class RoleOption:
    key: str
    title: str
    source: str  # Career path | Open job
    function: str
    required: dict[str, str]
    target_role_id: str | None = None
    location: str | None = None
    posting_id: str | None = None


@dataclass
class Gap:
    skill_id: str
    name: str
    have: str
    need: str
    levels: int
    courses: list[Course] = field(default_factory=list)


@dataclass
class RoleMatch:
    role: RoleOption
    match: int
    score: int
    reasons: list[str]
    gaps: list[Gap]
    timeline: list[dict[str, Any]]
    total_weeks: int


def _rank(level: str | None) -> int:
    return LEVEL_RANK.get(level or "", 0)


def role_options(db: Session, openings: list[Requisition]) -> list[RoleOption]:
    paths = list(db.scalars(select(CareerPath).where(CareerPath.active.is_(True))))
    paths.sort(key=lambda r: int(r.id.split("-")[-1]) if r.id.split("-")[-1].isdigit() else 999)
    out = [RoleOption(p.id, p.title, "Career path", p.function, dict(p.required_skills or {}), p.id) for p in paths]
    countries = dict(db.execute(select(Country.code, Country.name)).all())
    for req in openings:
        t = req.title.lower()
        from_title = next((p for p in paths if p.title.lower() in t), None)
        out.append(RoleOption(
            req.id, req.title, "Open job", DEPARTMENT_FUNCTION.get(req.department, req.department),
            dict(from_title.required_skills) if from_title else dict(DEPARTMENT_SKILLS.get(req.department, FALLBACK_SKILLS)),
            from_title.id if from_title else None,
            ", ".join(x for x in (req.location, countries.get(req.country_code, req.country_code)) if x), req.id,
        ))
    return out


def course_open_to(course: Course, user: CurrentUser, emp: Employee) -> bool:
    """Same audience rule as the learning router."""
    if course.audience == "Engineering":
        return emp.department == "Engineering"
    if course.audience == "Managers":
        return bool(user.scope.reports) if emp.id == user.employee_id else True
    if course.audience == "Hiring":
        return bool(user.scope.reports) or user.scope.is_hr or user.account.role == "recruiter" if emp.id == user.employee_id else True
    return True


def _timeline(gaps: list[Gap], role: RoleOption) -> tuple[list[dict[str, Any]], int]:
    steps: list[dict[str, Any]] = []
    week = 0
    for g in gaps:
        weeks = g.levels * WEEKS_PER_LEVEL
        course = g.courses[0].title if g.courses else None
        steps.append({
            "from_week": week + 1, "to_week": week + weeks, "skill": g.name,
            "text": f"Build {g.name} from {g.have} to {g.need}" + (f" (start with \"{course}\")" if course else " (practice on the job)"),
        })
        week += weeks
    steps.append({
        "from_week": week + 1, "to_week": week + 4, "skill": None,
        "text": "Apply for the job" if role.posting_id else "Review progress with your manager and plan the move",
    })
    return steps, week + 4


def rank_roles(
    db: Session, user: CurrentUser, emp: Employee, *, include_openings: bool = True, limit: int = 5,
) -> list[RoleMatch]:
    skills, _ = skills_of(db, emp)
    profile = db.get(CareerProfile, emp.id)
    current = (emp.job_title or "").strip().lower()
    home = db.get(Country, emp.country_code)
    home_location = home.name if home else emp.country_code
    openings = list(db.scalars(select(Requisition).where(Requisition.status == "approved").order_by(Requisition.id))) if include_openings else []
    names = {s.id: s.name for s in db.scalars(select(Skill))}
    courses = list(db.scalars(select(Course).where(Course.active.is_(True)).order_by(Course.id)))
    completed = set(db.scalars(select(Enrollment.course_id).where(Enrollment.employee_id == emp.id, Enrollment.status == "completed")))
    out: list[RoleMatch] = []
    for role in role_options(db, openings):
        if role.title.strip().lower() == current:
            continue
        gaps: list[Gap] = []
        total = 0.0
        for sid, need in role.required.items():
            have = skills.get(sid)
            total += min(1.0, _rank(have) / max(1, _rank(need)))
            levels = _rank(need) - _rank(have)
            if levels > 0:
                name = names.get(sid, sid)
                gaps.append(Gap(sid, name, have or "None", need, levels, [
                    c for c in courses
                    if any(s.lower() == name.lower() for s in (c.skills or [])) and course_open_to(c, user, emp) and c.id not in completed
                ]))
        match = round(total / len(role.required) * 100) if role.required else 0
        score = match
        reasons: list[str] = []
        if profile and role.target_role_id and role.target_role_id in (profile.target_role_ids or []):
            score += 15
            reasons.append("Your target role")
        if profile and role.function in (profile.interests or []):
            score += 8
            reasons.append("Preferred function")
        if role.source == "Open job":
            score += 3
            reasons.append("Open now")
            away = role.location and home_location and home_location.lower() not in role.location.lower()
            if away:
                if profile and not profile.open_to_relocation:
                    score -= 20
                reasons.append("Relocation (you're open to it)" if profile and profile.open_to_relocation else "Needs relocation")
        gaps.sort(key=lambda g: -g.levels)
        timeline, weeks = _timeline(gaps, role)
        out.append(RoleMatch(role, match, score, reasons, gaps, timeline, weeks))
    out.sort(key=lambda m: (-m.score, -m.match, m.role.title))
    return out[:limit]


# ---------- validation ----------
class CareerError(ValueError):
    pass


def check_profile(db: Session, target_role_ids: list[str], interests: list[str], timeframe: str, note: str,
                  mentor_id: str | None, me_id: str) -> tuple[list[str], list[str]]:
    roles = list(dict.fromkeys(target_role_ids))
    functions = list(dict.fromkeys(interests))
    if not roles and not functions:
        raise CareerError("Pick at least one target role or function.")
    if len(roles) > MAX_TARGET_ROLES:
        raise CareerError("Pick up to 3 target roles.")
    if roles:
        valid = set(db.scalars(select(CareerPath.id).where(CareerPath.id.in_(roles), CareerPath.active.is_(True))))
        if len(valid) != len(roles):
            raise CareerError("One of the roles is no longer available.")
    if any(f not in CAREER_FUNCTIONS for f in functions):
        raise CareerError("Choose functions from the list.")
    if timeframe not in CAREER_TIMEFRAMES:
        raise CareerError("Choose a timeframe.")
    if len(note) > 500:
        raise CareerError("Keep the note under 500 characters.")
    if mentor_id is not None:
        if mentor_id == me_id:
            raise CareerError("Choose someone else as your mentor.")
        if db.get(Employee, mentor_id) is None:
            raise CareerError("Choose a mentor from the directory.")
    return roles, functions


def unique_skill_name(db: Session, name: str, skill_id: str | None = None) -> None:
    hit = db.scalar(select(Skill.id).where(func.lower(Skill.name) == name.strip().lower()))
    if hit is not None and hit != skill_id:
        raise CareerError("A skill with this name already exists.")
