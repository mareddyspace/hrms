"""Skills library and careers.

- Library (GET everyone; add / change / retire: HR). Skills are retired (active=false), never deleted.
- Career paths: the next roles people can aim for (GET everyone).
- My career profile: current role, target roles (up to 3), interests, timeframe, relocation, mentor (self edits).
- Team interests: managers (their reporting line) and HR (their country scope).
- Role matches: careerMatch.ts on the server, with recommended courses and a suggested timeline. The person, people
  above them and HR may see them. Suggestions only.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import select

from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import CareerPath, CareerProfile, Course, Employee, JobProfile, Skill
from app.schemas.career import (
    CareerCourseOut,
    CareerGapOut,
    CareerMatchesOut,
    CareerPathOut,
    CareerProfileIn,
    CareerProfileOut,
    CareerRoleMatchOut,
    CareerSkillIn,
    CareerSkillOut,
    CareerTimelineStepOut,
)
from app.services import career
from app.services.activity import notify, record_audit
from app.services.decisions import NOT_FOUND, me

router = APIRouter(prefix="/career", tags=["career"])


def _require_hr(user: CurrentUser) -> None:
    if not user.scope.is_hr:
        raise HTTPException(403, "Only HR can change the skills library.")


def _check_refs(db: DbSession, body: CareerSkillIn) -> None:
    if body.related_profile_ids:
        found = set(db.scalars(select(JobProfile.id).where(JobProfile.id.in_(body.related_profile_ids))))
        if len(found) != len(set(body.related_profile_ids)):
            raise HTTPException(422, "Pick job profiles from the list.")
    if body.related_course_ids:
        found = set(db.scalars(select(Course.id).where(Course.id.in_(body.related_course_ids))))
        if len(found) != len(set(body.related_course_ids)):
            raise HTTPException(422, "Pick courses from the catalog.")


def _skill_values(body: CareerSkillIn) -> dict:
    return {
        "name": body.name.strip(), "category": body.category, "area": (body.area or "").strip() or None,
        "description": body.description.strip(), "related_profile_ids": list(dict.fromkeys(body.related_profile_ids)),
        "related_course_ids": list(dict.fromkeys(body.related_course_ids)),
        "certifications": [c.strip() for c in dict.fromkeys(body.certifications) if c.strip()], "active": body.active,
    }


def _skill_snap(s: Skill) -> dict:
    return {"name": s.name, "category": s.category, "active": s.active}


# ---------- library ----------
@router.get("/skills", response_model=list[CareerSkillOut])
def list_skills(db: DbSession, user: CurrentUserDep, include_inactive: bool = False) -> list[Skill]:
    return career.library(db, include_inactive=include_inactive and user.scope.is_hr)


@router.post("/skills", response_model=CareerSkillOut, status_code=status.HTTP_201_CREATED)
def add_skill(body: CareerSkillIn, request: Request, db: DbSession, user: CurrentUserDep) -> Skill:
    _require_hr(user)
    try:
        career.unique_skill_name(db, body.name)
    except career.CareerError as exc:
        raise HTTPException(409, str(exc)) from exc
    _check_refs(db, body)
    row = Skill(id=f"sk-{uuid.uuid4().hex[:8]}", updated_by=user.employee_id, **_skill_values(body))
    db.add(row)
    db.flush()
    record_audit(db, actor_id=user.id, action="skill_added", entity="skill", entity_id=row.id, after=_skill_snap(row),
                 ip=client_ip(request))
    db.commit()
    return row


@router.put("/skills/{skill_id}", response_model=CareerSkillOut)
def update_skill(skill_id: str, body: CareerSkillIn, request: Request, db: DbSession, user: CurrentUserDep) -> Skill:
    _require_hr(user)
    row = db.get(Skill, skill_id)
    if row is None:
        raise NOT_FOUND
    try:
        career.unique_skill_name(db, body.name, skill_id)
    except career.CareerError as exc:
        raise HTTPException(409, str(exc)) from exc
    _check_refs(db, body)
    before = _skill_snap(row)
    for k, v in _skill_values(body).items():
        setattr(row, k, v)
    row.updated_by = user.employee_id
    record_audit(db, actor_id=user.id, action="skill_updated", entity="skill", entity_id=row.id, before=before,
                 after=_skill_snap(row), ip=client_ip(request))
    db.commit()
    return row


@router.delete("/skills/{skill_id}", response_model=CareerSkillOut)
def retire_skill(skill_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> Skill:
    """Retire (hide) a skill. People's saved skills are kept."""
    _require_hr(user)
    row = db.get(Skill, skill_id)
    if row is None:
        raise NOT_FOUND
    if row.active:
        row.active, row.updated_by = False, user.employee_id
        record_audit(db, actor_id=user.id, action="skill_retired", entity="skill", entity_id=row.id,
                     before={"active": True}, after={"active": False}, ip=client_ip(request))
        db.commit()
    return row


@router.get("/paths", response_model=list[CareerPathOut])
def list_paths(db: DbSession, user: CurrentUserDep) -> list[CareerPath]:
    rows = list(db.scalars(select(CareerPath).where(CareerPath.active.is_(True))))
    rows.sort(key=lambda r: int(r.id.split("-")[-1]) if r.id.split("-")[-1].isdigit() else 999)
    return rows


# ---------- career profile ----------
def _profile_out(db: DbSession, emp: Employee, row: CareerProfile | None) -> CareerProfileOut:
    titles = dict(db.execute(select(CareerPath.id, CareerPath.title)).all())
    if row is None:
        return CareerProfileOut(employee_id=emp.id, employee_name=emp.full_name, current_role=emp.job_title, target_role_ids=[],
                                interests=[], timeframe="6–12 months", open_to_relocation=False, mentor_id=None, note="",
                                saved=False)
    mentor = db.get(Employee, row.mentor_id) if row.mentor_id else None
    return CareerProfileOut(
        employee_id=emp.id, employee_name=emp.full_name, current_role=row.current_role or emp.job_title,
        target_role_ids=list(row.target_role_ids or []), target_roles=[titles.get(i, i) for i in row.target_role_ids or []],
        interests=list(row.interests or []), timeframe=row.timeframe, open_to_relocation=row.open_to_relocation,
        mentor_id=row.mentor_id, mentor_name=mentor.full_name if mentor else None, note=row.note or "", saved=True,
        updated_at=row.updated_at,
    )


def _visible_employee(db: DbSession, user: CurrentUser, employee_id: str | None) -> Employee:
    if not employee_id or employee_id == user.employee_id:
        return me(user)
    emp = db.get(Employee, employee_id)
    if emp is None or not career.can_view_career(db, user, emp):
        raise NOT_FOUND
    return emp


@router.get("/me", response_model=CareerProfileOut)
def my_profile(db: DbSession, user: CurrentUserDep) -> CareerProfileOut:
    emp = me(user)
    return _profile_out(db, emp, db.get(CareerProfile, emp.id))


@router.put("/me", response_model=CareerProfileOut)
def save_my_profile(body: CareerProfileIn, request: Request, db: DbSession, user: CurrentUserDep) -> CareerProfileOut:
    emp = me(user)
    note = body.note.strip()
    try:
        roles, functions = career.check_profile(db, body.target_role_ids, body.interests, body.timeframe, note, body.mentor_id, emp.id)
    except career.CareerError as exc:
        raise HTTPException(422, str(exc)) from exc
    row = db.get(CareerProfile, emp.id)
    before = None if row is None else {"target_role_ids": row.target_role_ids, "interests": row.interests,
                                       "timeframe": row.timeframe, "open_to_relocation": row.open_to_relocation,
                                       "mentor_id": row.mentor_id}
    if row is None:
        row = CareerProfile(employee_id=emp.id)
        db.add(row)
    row.current_role = emp.job_title
    row.target_role_ids, row.interests, row.timeframe = roles, functions, body.timeframe
    row.open_to_relocation, row.mentor_id, row.note, row.updated_by = body.open_to_relocation, body.mentor_id, note, user.employee_id
    db.flush()
    record_audit(db, actor_id=user.id, action="career_profile_saved", entity="career_profile", entity_id=emp.id, subject_id=emp.id,
                 before=before, after={"target_role_ids": roles, "interests": functions, "timeframe": body.timeframe,
                                       "open_to_relocation": body.open_to_relocation, "mentor_id": body.mentor_id},
                 ip=client_ip(request))  # the note is not audited
    if emp.manager_id:
        notify(db, recipient_id=emp.manager_id, title="Career interests updated",
               body=f"{emp.full_name} updated their career interests ({body.timeframe}).", href="/skills")
    db.commit()
    return _profile_out(db, emp, row)


@router.get("/profiles/{employee_id}", response_model=CareerProfileOut)
def get_profile(employee_id: str, db: DbSession, user: CurrentUserDep) -> CareerProfileOut:
    emp = _visible_employee(db, user, employee_id)
    return _profile_out(db, emp, db.get(CareerProfile, emp.id))


@router.get("/team-interests", response_model=list[CareerProfileOut])
def team_interests(db: DbSession, user: CurrentUserDep) -> list[CareerProfileOut]:
    """Saved career profiles of the caller's reporting line (managers) or country scope (HR); never their own."""
    if not career.sees_team_interests(user):
        raise HTTPException(403, "Only managers and HR can see team career interests.")
    stmt = select(CareerProfile, Employee).join(Employee, Employee.id == CareerProfile.employee_id)
    if user.scope.is_hr:
        stmt = stmt.where(user.scope.employee_filter())
    else:
        stmt = stmt.where(Employee.id.in_(list(user.scope.reports) or [""]))
    rows = [(p, e) for p, e in db.execute(stmt.order_by(Employee.full_name)).all() if e.id != user.employee_id]
    return [_profile_out(db, e, p) for p, e in rows[:500]]


# ---------- role matches ----------
def _course_out(c: Course) -> CareerCourseOut:
    return CareerCourseOut(id=c.id, title=c.title, duration_hours=c.duration_hours)


@router.get("/matches", response_model=CareerMatchesOut)
def role_matches(db: DbSession, user: CurrentUserDep, employee_id: str | None = None, limit: int = 5) -> CareerMatchesOut:
    emp = _visible_employee(db, user, employee_id)
    _, saved = career.skills_of(db, emp)
    matches = career.rank_roles(db, user, emp, limit=max(1, min(limit, 20)))
    out = []
    for m in matches:
        seen: dict[str, Course] = {}
        for g in m.gaps:
            for c in g.courses:
                seen.setdefault(c.id, c)
        out.append(CareerRoleMatchOut(
            key=m.role.key, title=m.role.title, source=m.role.source, function=m.role.function,  # type: ignore[arg-type]
            target_role_id=m.role.target_role_id, location=m.role.location, posting_id=m.role.posting_id,
            match=m.match, score=m.score, reasons=m.reasons,
            gaps=[CareerGapOut(skill_id=g.skill_id, name=g.name, have=g.have, need=g.need, levels=g.levels,
                               courses=[_course_out(c) for c in g.courses]) for g in m.gaps],
            recommended_courses=[_course_out(c) for c in seen.values()],
            timeline=[CareerTimelineStepOut(**s) for s in m.timeline], total_weeks=m.total_weeks,
        ))
    return CareerMatchesOut(employee_id=emp.id, skills_saved=saved, matches=out)
