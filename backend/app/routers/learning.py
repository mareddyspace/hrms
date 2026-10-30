"""Learning: course catalog, enrollments, certifications (with an expiring list) and employee skills.

- HR keeps the catalog. People enroll themselves in courses open to them; their managers and HR may assign any course.
- The learner updates progress (up to 90%); HR confirms completion with the final score (never their own).
- Certifications: the employee or HR records them; /learning/expiring lists those expiring within N days (default 30)
  for the people in the caller's scope.
- Skills: everyone edits their own; managers and HR can read them.
"""

from __future__ import annotations

import uuid
from datetime import date, timedelta
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from sqlalchemy import func, select

from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import Certification, Course, Employee, EmployeeSkill, Enrollment
from app.schemas.talent import (
    CertificationIn,
    CertificationOut,
    CompleteIn,
    CourseIn,
    CourseOut,
    EnrollIn,
    EnrollmentOut,
    ProgressIn,
    SkillIn,
    SkillOut,
)
from app.services.activity import notify, record_audit
from app.services.decisions import NOT_FOUND, can_view, me, target
from app.services.leave import today_for
from app.services.scope import manager_chain_ids

router = APIRouter(prefix="/learning", tags=["learning"])

SELF_PROGRESS_CAP = 90


def _hr_for(user: CurrentUser, emp: Employee) -> bool:
    return user.scope.is_hr and (not user.scope.countries or emp.country_code in user.scope.countries)


def _above(db: DbSession, user: CurrentUser, employee_id: str) -> bool:
    return user.employee_id is not None and user.employee_id in manager_chain_ids(db, employee_id)


def _course_open_to(course: Course, user: CurrentUser, emp: Employee) -> bool:
    if course.audience == "Engineering":
        return emp.department == "Engineering"
    if course.audience == "Managers":
        return bool(user.scope.reports)
    if course.audience == "Hiring":
        return bool(user.scope.reports) or user.scope.is_hr or user.account.role == "recruiter"
    return True


# ---------- courses ----------
@router.get("/courses", response_model=list[CourseOut])
def list_courses(db: DbSession, user: CurrentUserDep, include_inactive: bool = False) -> list[Course]:
    stmt = select(Course).order_by(Course.mandatory.desc(), Course.title)
    if not include_inactive:
        stmt = stmt.where(Course.active.is_(True))
    return list(db.scalars(stmt))


@router.post("/courses", response_model=CourseOut, status_code=status.HTTP_201_CREATED)
def add_course(body: CourseIn, request: Request, db: DbSession, user: CurrentUserDep) -> Course:
    if not user.scope.is_hr:
        raise HTTPException(403, "Only HR manages the course catalog.")
    if db.scalar(select(Course.id).where(func.lower(Course.title) == body.title.strip().lower())):
        raise HTTPException(409, "A course with this title already exists.")
    course = Course(id=f"crs-{uuid.uuid4().hex[:10]}", **(body.model_dump() | {"title": body.title.strip()}))
    db.add(course)
    db.flush()
    record_audit(db, actor_id=user.id, action="course_added", entity="course", entity_id=course.id, after=body.model_dump(),
                 ip=client_ip(request))
    db.commit()
    return course


@router.put("/courses/{course_id}", response_model=CourseOut)
def update_course(course_id: str, body: CourseIn, request: Request, db: DbSession, user: CurrentUserDep) -> Course:
    if not user.scope.is_hr:
        raise HTTPException(403, "Only HR manages the course catalog.")
    course = db.get(Course, course_id)
    if course is None:
        raise NOT_FOUND
    if db.scalar(select(Course.id).where(func.lower(Course.title) == body.title.strip().lower(), Course.id != course.id)):
        raise HTTPException(409, "A course with this title already exists.")
    before = CourseIn.model_validate(course, from_attributes=True).model_dump()
    for k, v in (body.model_dump() | {"title": body.title.strip()}).items():
        setattr(course, k, v)
    record_audit(db, actor_id=user.id, action="course_updated", entity="course", entity_id=course.id, before=before,
                 after=body.model_dump(), ip=client_ip(request))
    db.commit()
    return course


# ---------- enrollments ----------
def _enrollment_outs(db: DbSession, rows: list[Enrollment]) -> list[EnrollmentOut]:
    titles = dict(db.execute(select(Course.id, Course.title).where(Course.id.in_([r.course_id for r in rows]))).all()) if rows else {}
    out = []
    for r in rows:
        item = EnrollmentOut.model_validate(r)
        item.course_title = titles.get(r.course_id)
        out.append(item)
    return out


def _snap(e: Enrollment) -> dict:
    return {"status": e.status, "progress": e.progress, "completed_on": e.completed_on, "score": e.score, "due": e.due}


@router.get("/enrollments", response_model=list[EnrollmentOut])
def list_enrollments(db: DbSession, user: CurrentUserDep, employee_id: str | None = None) -> list[EnrollmentOut]:
    emp = target(db, user, employee_id)
    return _enrollment_outs(db, list(db.scalars(select(Enrollment).where(Enrollment.employee_id == emp.id).order_by(Enrollment.created_at))))


@router.post("/enrollments", response_model=EnrollmentOut, status_code=status.HTTP_201_CREATED)
def enroll(body: EnrollIn, request: Request, db: DbSession, user: CurrentUserDep) -> EnrollmentOut:
    me(user)
    course = db.get(Course, body.course_id)
    if course is None or not course.active:
        raise HTTPException(404, "Course not found.")
    emp = db.get(Employee, body.employee_id or user.employee_id)
    if emp is None:
        raise NOT_FOUND
    is_self = emp.id == user.employee_id
    if is_self:
        if not _course_open_to(course, user, emp):
            raise HTTPException(403, "This course is not open to you.")
    elif not (_hr_for(user, emp) or _above(db, user, emp.id)):
        raise HTTPException(403, "Only the employee's managers or HR can assign courses.")
    if db.scalar(select(Enrollment.id).where(Enrollment.course_id == course.id, Enrollment.employee_id == emp.id)):
        raise HTTPException(409, "Already enrolled." if is_self else f"{emp.full_name} is already enrolled.")
    row = Enrollment(id=f"enr-{uuid.uuid4().hex[:10]}", course_id=course.id, employee_id=emp.id, status="assigned", progress=0,
                     due=body.due, assigned_by=user.employee_id)
    db.add(row)
    db.flush()
    record_audit(db, actor_id=user.id, action="course_enrolled" if is_self else "course_assigned", entity="enrollment", entity_id=row.id,
                 subject_id=emp.id, after=_snap(row) | {"course_id": course.id}, ip=client_ip(request))
    if not is_self:
        notify(db, recipient_id=emp.id, title=f"Course assigned: {course.title}",
               body=f"Due {body.due}." if body.due else "", href="/learning")
    db.commit()
    return _enrollment_outs(db, [row])[0]


def _enrollment(db: DbSession, user: CurrentUser, enrollment_id: str) -> tuple[Enrollment, Employee]:
    row = db.get(Enrollment, enrollment_id)
    if row is None:
        raise NOT_FOUND
    emp = db.get(Employee, row.employee_id)
    if emp is None or not can_view(db, user, emp):
        raise NOT_FOUND
    return row, emp


@router.patch("/enrollments/{enrollment_id}/progress", response_model=EnrollmentOut)
def update_progress(enrollment_id: str, body: ProgressIn, request: Request, db: DbSession, user: CurrentUserDep) -> EnrollmentOut:
    row, emp = _enrollment(db, user, enrollment_id)
    if emp.id != user.employee_id:
        raise HTTPException(403, "You can only update your own learning progress.")
    if row.status == "completed":
        raise HTTPException(409, "Completed courses can only be changed by HR.")
    before = _snap(row)
    row.progress = min(body.progress, SELF_PROGRESS_CAP)
    row.status = "in_progress" if row.progress > 0 else "assigned"
    record_audit(db, actor_id=user.id, action="learning_progress_updated", entity="enrollment", entity_id=row.id, subject_id=emp.id,
                 before=before, after=_snap(row), ip=client_ip(request))
    db.commit()
    return _enrollment_outs(db, [row])[0]


@router.post("/enrollments/{enrollment_id}/complete", response_model=EnrollmentOut)
def complete(enrollment_id: str, body: CompleteIn, request: Request, db: DbSession, user: CurrentUserDep) -> EnrollmentOut:
    row, emp = _enrollment(db, user, enrollment_id)
    if not _hr_for(user, emp) or emp.id == user.employee_id:
        raise HTTPException(403, "Only HR can confirm completion for someone else.")
    if row.status == "completed":
        raise HTTPException(409, "Already completed.")
    before = _snap(row)
    row.status, row.progress, row.completed_on, row.score = "completed", 100, today_for(emp), body.score
    record_audit(db, actor_id=user.id, action="course_completed", entity="enrollment", entity_id=row.id, subject_id=emp.id,
                 before=before, after=_snap(row), ip=client_ip(request))
    notify(db, recipient_id=emp.id, title="Course completed", body=f"Score {body.score}." if body.score is not None else "", href="/learning")
    db.commit()
    return _enrollment_outs(db, [row])[0]


# ---------- certifications ----------
def _cert_outs(db: DbSession, rows: list[Certification], today: date) -> list[CertificationOut]:
    names = dict(db.execute(select(Employee.id, Employee.full_name).where(Employee.id.in_({r.employee_id for r in rows}))).all()) if rows else {}
    out = []
    for r in rows:
        item = CertificationOut.model_validate(r)
        item.employee_name = names.get(r.employee_id)
        item.days_to_expiry = (r.expires_on - today).days if r.expires_on else None
        out.append(item)
    return out


@router.get("/certifications", response_model=list[CertificationOut])
def list_certifications(db: DbSession, user: CurrentUserDep, employee_id: str | None = None) -> list[CertificationOut]:
    emp = target(db, user, employee_id)
    rows = list(db.scalars(select(Certification).where(Certification.employee_id == emp.id).order_by(Certification.issued_on.desc())))
    return _cert_outs(db, rows, today_for(emp))


@router.post("/certifications", response_model=CertificationOut, status_code=status.HTTP_201_CREATED)
def add_certification(body: CertificationIn, request: Request, db: DbSession, user: CurrentUserDep) -> CertificationOut:
    me(user)
    emp = db.get(Employee, body.employee_id or user.employee_id)
    if emp is None:
        raise NOT_FOUND
    if emp.id != user.employee_id and not _hr_for(user, emp):
        raise HTTPException(403, "Only the employee or HR can record a certification.")
    if body.issued_on > today_for(emp):
        raise HTTPException(422, "The issue date can't be in the future.")
    if body.expires_on and body.expires_on <= body.issued_on:
        raise HTTPException(422, "The expiry date must be after the issue date.")
    row = Certification(id=f"cert-{uuid.uuid4().hex[:10]}", employee_id=emp.id, name=body.name.strip(),
                        issuer=(body.issuer or "").strip() or None, issued_on=body.issued_on, expires_on=body.expires_on,
                        credential_id=(body.credential_id or "").strip() or None)
    db.add(row)
    db.flush()
    record_audit(db, actor_id=user.id, action="certification_added", entity="certification", entity_id=row.id, subject_id=emp.id,
                 after=body.model_dump() | {"employee_id": emp.id}, ip=client_ip(request))
    db.commit()
    return _cert_outs(db, [row], today_for(emp))[0]


@router.delete("/certifications/{cert_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_certification(cert_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> Response:
    row = db.get(Certification, cert_id)
    emp = db.get(Employee, row.employee_id) if row else None
    if row is None or emp is None or not can_view(db, user, emp):
        raise NOT_FOUND
    if emp.id != user.employee_id and not _hr_for(user, emp):
        raise HTTPException(403, "Only the employee or HR can remove a certification.")
    record_audit(db, actor_id=user.id, action="certification_removed", entity="certification", entity_id=row.id, subject_id=emp.id,
                 before={"name": row.name, "issued_on": row.issued_on, "expires_on": row.expires_on}, ip=client_ip(request))
    db.delete(row)
    db.commit()
    return Response(status_code=204)


@router.get("/expiring", response_model=list[CertificationOut])
def expiring(db: DbSession, user: CurrentUserDep, days: Annotated[int, Query(ge=1, le=365)] = 30) -> list[CertificationOut]:
    """Certifications expiring within `days` (not yet expired) for me, my reporting line, or HR's countries."""
    today = date.today()
    rows = list(db.scalars(
        select(Certification).join(Employee, Employee.id == Certification.employee_id)
        .where(user.scope.employee_filter(), Certification.expires_on.is_not(None), Certification.expires_on >= today,
               Certification.expires_on <= today + timedelta(days=days))
        .order_by(Certification.expires_on)
    ))
    return _cert_outs(db, rows, today)


# ---------- skills ----------
@router.get("/skills", response_model=list[SkillOut])
def list_skills(db: DbSession, user: CurrentUserDep, employee_id: str | None = None) -> list[EmployeeSkill]:
    emp = target(db, user, employee_id)
    return list(db.scalars(select(EmployeeSkill).where(EmployeeSkill.employee_id == emp.id).order_by(EmployeeSkill.skill)))


@router.put("/skills/me", response_model=SkillOut)
def save_my_skill(body: SkillIn, request: Request, db: DbSession, user: CurrentUserDep) -> EmployeeSkill:
    """Add or update one of my skills (matched by name, ignoring case)."""
    emp = me(user)
    name = body.skill.strip()
    row = db.scalar(select(EmployeeSkill).where(EmployeeSkill.employee_id == emp.id, func.lower(EmployeeSkill.skill) == name.lower()))
    before = {"level": row.level, "target_level": row.target_level, "years": row.years, "last_used": row.last_used,
              "evidence_url": row.evidence_url} if row else None
    if row is None:
        row = EmployeeSkill(employee_id=emp.id, skill=name, level=body.level, target_level=body.target_level)
        db.add(row)
    else:
        row.level, row.target_level = body.level, body.target_level
    row.years, row.last_used = body.years, body.last_used
    row.evidence_url = (body.evidence_url or "").strip() or None
    db.flush()
    record_audit(db, actor_id=user.id, action="skill_saved", entity="employee_skill", entity_id=str(row.id), subject_id=emp.id,
                 before=before, after={"skill": row.skill, "level": row.level, "target_level": row.target_level,
                                       "years": row.years, "last_used": row.last_used, "evidence_url": row.evidence_url},
                 ip=client_ip(request))
    db.commit()
    return row


@router.delete("/skills/me/{skill_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_my_skill(skill_id: int, request: Request, db: DbSession, user: CurrentUserDep) -> Response:
    emp = me(user)
    row = db.get(EmployeeSkill, skill_id)
    if row is None or row.employee_id != emp.id:
        raise NOT_FOUND
    record_audit(db, actor_id=user.id, action="skill_removed", entity="employee_skill", entity_id=str(row.id), subject_id=emp.id,
                 before={"skill": row.skill, "level": row.level}, ip=client_ip(request))
    db.delete(row)
    db.commit()
    return Response(status_code=204)
