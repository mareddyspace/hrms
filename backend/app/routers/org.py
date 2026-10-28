"""Organization structure and positions. Everyone signed in can read; HR and administrators can change.

Nothing is deleted: deactivate instead (refused while active children, profiles or filled seats depend on it).
Org units, job profiles and positions are effective-dated: every change keeps a version in org_change_history
(GET .../{id}/history) and GET /org/units?as_of=YYYY-MM-DD shows the structure on a past day.
"""

from __future__ import annotations

import uuid
from datetime import date
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.deps import CurrentUser, CurrentUserDep, DbSession, client_ip
from app.models import Account, Country, Employee, JobFamily, JobProfile, OrgUnit, Position
from app.schemas import (
    JobFamilyIn,
    JobFamilyOut,
    JobFamilyUpdate,
    JobProfileIn,
    JobProfileOut,
    JobProfileUpdate,
    OrgUnitIn,
    OrgUnitOut,
    OrgUnitUpdate,
    PositionIn,
    PositionOut,
    PositionUpdate,
)
from app.schemas.org import EffectiveDateIn, OrgVersionOut
from app.services import org as org_rules
from app.services import org_history as hist
from app.services.activity import record_audit

router = APIRouter(prefix="/org", tags=["organization"])

NOT_FOUND = HTTPException(404, "Not found.")
Active = Annotated[bool | None, Query(description="Omit for active only; false for inactive only")]


def _require_editor(user: CurrentUser) -> None:
    if not (user.scope.is_hr or user.account.role == "admin"):
        raise HTTPException(403, "Only HR or an administrator can change the organization.")


def _cols(row: Any, names: tuple[str, ...]) -> dict[str, Any]:
    return {n: getattr(row, n) for n in names}


def _audit(db: Session, user: CurrentUser, request: Request, action: str, entity: str, entity_id: str,
           before: dict | None, after: dict | None) -> None:
    record_audit(db, actor_id=user.id, action=action, entity=entity, entity_id=entity_id, before=before, after=after,
                 ip=client_ip(request))


def _unique_code(db: Session, model: type, code: str, own_id: str | None = None) -> None:
    clash = db.scalar(select(model.id).where(model.code == code))  # type: ignore[attr-defined]
    if clash and clash != own_id:
        raise HTTPException(409, f"The code {code} is already used.")


def _active_filter(model: type, active: bool | None):  # type: ignore[no-untyped-def]
    return model.active.is_(True if active is None else active)  # type: ignore[attr-defined]


def _effective(db: Session, entity: str, row: Any | None, effective: date | None) -> date:
    """The change date (default today), checked against the open version."""
    day = effective or hist.today()
    try:
        if row is None:
            if day > hist.today():
                raise hist.OrgHistoryError("Use today or an earlier date.")
        else:
            hist.check_date(db, entity, row, day)
    except hist.OrgHistoryError as exc:
        raise HTTPException(422, str(exc)) from exc
    return day


def _history_out(db: Session, entity: str, row: Any) -> list[OrgVersionOut]:
    versions = hist.history(db, entity, row)
    db.commit()  # keeps a baseline version written for a record that had none
    actors = {v.changed_by for v in versions if v.changed_by}
    names: dict[str, str] = {}
    if actors:  # changed_by is an account id; show the person's name
        names = {acc: name for acc, name in db.execute(
            select(Account.id, Employee.full_name).join(Employee, Employee.id == Account.employee_id)
            .where(Account.id.in_(actors))).all()}
    out = []
    for v in versions:
        item = OrgVersionOut.model_validate(v)
        item.changed_by_name = names.get(v.changed_by or "")
        out.append(item)
    return out


def _check_manager(db: Session, manager_id: str | None) -> None:
    if manager_id:
        manager = db.get(Employee, manager_id)
        if manager is None or manager.employment_status == "Terminated":
            raise HTTPException(422, "Choose a current employee as the manager.")


# ---------- org units ----------
UNIT_COLS = ("code", "name", "type", "parent_id", "country_code", "manager_id", "headcount", "active")


def _check_parent(db: Session, unit_id: str | None, unit_type: str, parent_id: str | None) -> None:
    if unit_type == "company":
        if parent_id:
            raise HTTPException(422, "A company can't have a parent.")
        return
    if parent_id is None:
        return
    parent = db.get(OrgUnit, parent_id)
    if parent is None or not parent.active:
        raise HTTPException(422, "Choose an active parent unit.")
    seen = set()
    node: OrgUnit | None = parent
    while node is not None and node.id not in seen:
        if node.id == unit_id:
            raise HTTPException(422, "That parent would create a loop.")
        seen.add(node.id)
        node = db.get(OrgUnit, node.parent_id) if node.parent_id else None


def _check_country(db: Session, code: str | None) -> None:
    if code and db.get(Country, code) is None:
        raise HTTPException(422, "Choose a valid country.")


@router.get("/units", response_model=list[OrgUnitOut])
def list_units(
    db: DbSession, user: CurrentUserDep,
    type_: Annotated[str | None, Query(alias="type")] = None,
    parent_id: str | None = None,
    q: Annotated[str | None, Query(max_length=100)] = None,
    active: Active = None,
    as_of: Annotated[date | None, Query(description="Show the structure as it was on this day")] = None,
) -> list[Any]:
    if as_of is not None:
        want_active = True if active is None else active
        rows = [r for r in hist.as_of(db, "org_unit", as_of) if bool(r.get("active")) == want_active]
        if type_:
            rows = [r for r in rows if r["type"] == type_]
        if parent_id:
            rows = [r for r in rows if r.get("parent_id") == parent_id]
        if q:
            needle = q.strip().lower()
            rows = [r for r in rows if needle in r["name"].lower() or needle in r["code"].lower()]
        return [OrgUnitOut.model_validate(r) for r in sorted(rows, key=lambda r: (r["type"], r["name"]))]
    stmt = select(OrgUnit).where(_active_filter(OrgUnit, active))
    if type_:
        stmt = stmt.where(OrgUnit.type == type_)
    if parent_id:
        stmt = stmt.where(OrgUnit.parent_id == parent_id)
    if q:
        like = f"%{q.strip().lower()}%"
        stmt = stmt.where(or_(func.lower(OrgUnit.name).like(like), func.lower(OrgUnit.code).like(like)))
    return list(db.scalars(stmt.order_by(OrgUnit.type, OrgUnit.name)))


@router.get("/units/{unit_id}", response_model=OrgUnitOut)
def get_unit(unit_id: str, db: DbSession, user: CurrentUserDep) -> OrgUnit:
    row = db.get(OrgUnit, unit_id)
    if row is None:
        raise NOT_FOUND
    return row


@router.get("/units/{unit_id}/history", response_model=list[OrgVersionOut])
def unit_history(unit_id: str, db: DbSession, user: CurrentUserDep) -> list[OrgVersionOut]:
    row = db.get(OrgUnit, unit_id)
    if row is None:
        raise NOT_FOUND
    return _history_out(db, "org_unit", row)


@router.post("/units", response_model=OrgUnitOut, status_code=status.HTTP_201_CREATED)
def create_unit(body: OrgUnitIn, request: Request, db: DbSession, user: CurrentUserDep) -> OrgUnit:
    _require_editor(user)
    _unique_code(db, OrgUnit, body.code)
    _check_parent(db, None, body.type, body.parent_id)
    _check_country(db, body.country_code)
    _check_manager(db, body.manager_id)
    effective = _effective(db, "org_unit", None, body.effective_from)
    row = OrgUnit(id=f"ou-{uuid.uuid4().hex[:12]}", **body.model_dump(exclude={"effective_from"}), active=True)
    db.add(row)
    db.flush()
    hist.record_created(db, "org_unit", row, effective, user.id)
    _audit(db, user, request, "org_unit_created", "org_unit", row.id, None, _cols(row, UNIT_COLS))
    db.commit()
    return row


def _deactivate_unit_check(db: Session, row: OrgUnit) -> None:
    if db.scalar(select(OrgUnit.id).where(OrgUnit.parent_id == row.id, OrgUnit.active.is_(True))):
        raise HTTPException(409, "Deactivate or move the units under it first.")
    if db.scalar(select(Position.id).where(or_(Position.department_id == row.id, Position.location_id == row.id),
                                           Position.active.is_(True))):
        raise HTTPException(409, "Active positions belong to this unit.")


@router.patch("/units/{unit_id}", response_model=OrgUnitOut)
def update_unit(unit_id: str, body: OrgUnitUpdate, request: Request, db: DbSession, user: CurrentUserDep) -> OrgUnit:
    _require_editor(user)
    row = db.get(OrgUnit, unit_id)
    if row is None:
        raise NOT_FOUND
    changes = body.model_dump(exclude_unset=True)
    effective_in, reason = changes.pop("effective_from", None), changes.pop("reason", None)
    if changes.get("code"):
        _unique_code(db, OrgUnit, changes["code"], row.id)
    if "parent_id" in changes:
        _check_parent(db, row.id, row.type, changes["parent_id"])
    if "country_code" in changes:
        _check_country(db, changes["country_code"])
    if "manager_id" in changes:
        _check_manager(db, changes["manager_id"])
    if changes.get("active") is False and row.active:
        _deactivate_unit_check(db, row)
    for key in ("code", "name", "active"):
        if key in changes and changes[key] is None:
            changes.pop(key)
    effective = _effective(db, "org_unit", row, effective_in)
    before = _cols(row, UNIT_COLS)
    snap = hist.snapshot("org_unit", row)
    for k, v in changes.items():
        setattr(row, k, v)
    hist.record_change(db, "org_unit", row, snap, effective, user.id, reason)
    _audit(db, user, request, "org_unit_updated", "org_unit", row.id, before,
           _cols(row, UNIT_COLS) | {"effective_from": effective})
    db.commit()
    return row


@router.post("/units/{unit_id}/deactivate", response_model=OrgUnitOut)
def deactivate_unit(unit_id: str, request: Request, db: DbSession, user: CurrentUserDep,
                    body: EffectiveDateIn | None = None) -> OrgUnit:
    dated = body or EffectiveDateIn()
    return update_unit(unit_id, OrgUnitUpdate(active=False, effective_from=dated.effective_from, reason=dated.reason),
                       request, db, user)


# ---------- job families ----------
FAMILY_COLS = ("code", "name", "description", "active")


@router.get("/job-families", response_model=list[JobFamilyOut])
def list_families(db: DbSession, user: CurrentUserDep, active: Active = None) -> list[JobFamily]:
    return list(db.scalars(select(JobFamily).where(_active_filter(JobFamily, active)).order_by(JobFamily.name)))


@router.post("/job-families", response_model=JobFamilyOut, status_code=status.HTTP_201_CREATED)
def create_family(body: JobFamilyIn, request: Request, db: DbSession, user: CurrentUserDep) -> JobFamily:
    _require_editor(user)
    _unique_code(db, JobFamily, body.code)
    if db.scalar(select(JobFamily.id).where(JobFamily.name == body.name.strip())):
        raise HTTPException(409, "A job family with this name already exists.")
    row = JobFamily(id=f"jf-{uuid.uuid4().hex[:12]}", code=body.code, name=body.name.strip(), description=body.description,
                    active=True)
    db.add(row)
    db.flush()
    _audit(db, user, request, "job_family_created", "job_family", row.id, None, _cols(row, FAMILY_COLS))
    db.commit()
    return row


@router.patch("/job-families/{family_id}", response_model=JobFamilyOut)
def update_family(family_id: str, body: JobFamilyUpdate, request: Request, db: DbSession, user: CurrentUserDep) -> JobFamily:
    _require_editor(user)
    row = db.get(JobFamily, family_id)
    if row is None:
        raise NOT_FOUND
    changes = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None or k == "description"}
    if "code" in changes:
        _unique_code(db, JobFamily, changes["code"], row.id)
    if "name" in changes:
        changes["name"] = changes["name"].strip()
        clash = db.scalar(select(JobFamily.id).where(JobFamily.name == changes["name"]))
        if clash and clash != row.id:
            raise HTTPException(409, "A job family with this name already exists.")
    if changes.get("active") is False and row.active and db.scalar(
            select(JobProfile.id).where(JobProfile.family_id == row.id, JobProfile.active.is_(True))):
        raise HTTPException(409, "Active job profiles belong to this family.")
    before = _cols(row, FAMILY_COLS)
    for k, v in changes.items():
        setattr(row, k, v)
    _audit(db, user, request, "job_family_updated", "job_family", row.id, before, _cols(row, FAMILY_COLS))
    db.commit()
    return row


@router.post("/job-families/{family_id}/deactivate", response_model=JobFamilyOut)
def deactivate_family(family_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> JobFamily:
    return update_family(family_id, JobFamilyUpdate(active=False), request, db, user)


# ---------- job profiles ----------
PROFILE_COLS = ("code", "title", "family_id", "grade", "job_level", "experience_min_years", "experience_max_years",
                "education", "description", "responsibilities", "required_skills", "preferred_skills", "active")


def _clean_skills(skills: list[str] | None) -> list[str] | None:
    if skills is None:
        return None
    out: list[str] = []
    for s in skills:
        s = s.strip()
        if not s or len(s) > 100:
            raise HTTPException(422, "Each skill must be 1 to 100 characters.")
        if s.lower() not in {x.lower() for x in out}:
            out.append(s)
    return out


def _clean_lines(lines: list[str] | None) -> list[str] | None:
    if lines is None:
        return None
    out = [s.strip() for s in lines if s and s.strip()]
    if any(len(s) > 500 for s in out):
        raise HTTPException(422, "Keep each responsibility under 500 characters.")
    return out


def _check_experience(low: int | None, high: int | None) -> None:
    if low is not None and high is not None and low > high:
        raise HTTPException(422, "Minimum experience can't be more than the maximum.")


def _check_family(db: Session, family_id: str | None) -> None:
    if family_id is not None:
        family = db.get(JobFamily, family_id)
        if family is None or not family.active:
            raise HTTPException(422, "Choose an active job family.")


@router.get("/job-profiles", response_model=list[JobProfileOut])
def list_profiles(
    db: DbSession, user: CurrentUserDep, family_id: str | None = None,
    q: Annotated[str | None, Query(max_length=100)] = None, active: Active = None,
) -> list[JobProfile]:
    stmt = select(JobProfile).where(_active_filter(JobProfile, active))
    if family_id:
        stmt = stmt.where(JobProfile.family_id == family_id)
    if q:
        stmt = stmt.where(func.lower(JobProfile.title).like(f"%{q.strip().lower()}%"))
    return list(db.scalars(stmt.order_by(JobProfile.title)))


@router.get("/job-profiles/{profile_id}", response_model=JobProfileOut)
def get_profile(profile_id: str, db: DbSession, user: CurrentUserDep) -> JobProfile:
    row = db.get(JobProfile, profile_id)
    if row is None:
        raise NOT_FOUND
    return row


@router.get("/job-profiles/{profile_id}/history", response_model=list[OrgVersionOut])
def profile_history(profile_id: str, db: DbSession, user: CurrentUserDep) -> list[OrgVersionOut]:
    row = db.get(JobProfile, profile_id)
    if row is None:
        raise NOT_FOUND
    return _history_out(db, "job_profile", row)


@router.post("/job-profiles", response_model=JobProfileOut, status_code=status.HTTP_201_CREATED)
def create_profile(body: JobProfileIn, request: Request, db: DbSession, user: CurrentUserDep) -> JobProfile:
    _require_editor(user)
    _unique_code(db, JobProfile, body.code)
    _check_family(db, body.family_id)
    _check_experience(body.experience_min_years, body.experience_max_years)
    effective = _effective(db, "job_profile", None, body.effective_from)
    row = JobProfile(id=f"jp-{uuid.uuid4().hex[:12]}", code=body.code, title=body.title.strip(), family_id=body.family_id,
                     grade=body.grade, description=body.description, required_skills=_clean_skills(body.required_skills),
                     preferred_skills=_clean_skills(body.preferred_skills), active=True, job_level=body.job_level,
                     experience_min_years=body.experience_min_years, experience_max_years=body.experience_max_years,
                     education=body.education, responsibilities=_clean_lines(body.responsibilities))
    db.add(row)
    db.flush()
    hist.record_created(db, "job_profile", row, effective, user.id)
    _audit(db, user, request, "job_profile_created", "job_profile", row.id, None, _cols(row, PROFILE_COLS))
    db.commit()
    return row


@router.patch("/job-profiles/{profile_id}", response_model=JobProfileOut)
def update_profile(profile_id: str, body: JobProfileUpdate, request: Request, db: DbSession, user: CurrentUserDep) -> JobProfile:
    _require_editor(user)
    row = db.get(JobProfile, profile_id)
    if row is None:
        raise NOT_FOUND
    changes = body.model_dump(exclude_unset=True)
    effective_in, reason = changes.pop("effective_from", None), changes.pop("reason", None)
    for key in ("code", "title", "active", "required_skills", "preferred_skills"):
        if key in changes and changes[key] is None:
            changes.pop(key)
    if "code" in changes:
        _unique_code(db, JobProfile, changes["code"], row.id)
    if "family_id" in changes:
        _check_family(db, changes["family_id"])
    for key in ("required_skills", "preferred_skills"):
        if key in changes:
            changes[key] = _clean_skills(changes[key])
    if "responsibilities" in changes:
        changes["responsibilities"] = _clean_lines(changes["responsibilities"])
    _check_experience(changes.get("experience_min_years", row.experience_min_years),
                      changes.get("experience_max_years", row.experience_max_years))
    if changes.get("active") is False and row.active and db.scalar(
            select(Position.id).where(Position.profile_id == row.id, Position.active.is_(True))):
        raise HTTPException(409, "Active positions use this job profile.")
    effective = _effective(db, "job_profile", row, effective_in)
    before = _cols(row, PROFILE_COLS)
    snap = hist.snapshot("job_profile", row)
    for k, v in changes.items():
        setattr(row, k, v)
    hist.record_change(db, "job_profile", row, snap, effective, user.id, reason)
    _audit(db, user, request, "job_profile_updated", "job_profile", row.id, before,
           _cols(row, PROFILE_COLS) | {"effective_from": effective})
    db.commit()
    return row


@router.post("/job-profiles/{profile_id}/deactivate", response_model=JobProfileOut)
def deactivate_profile(profile_id: str, request: Request, db: DbSession, user: CurrentUserDep,
                       body: EffectiveDateIn | None = None) -> JobProfile:
    dated = body or EffectiveDateIn()
    return update_profile(profile_id, JobProfileUpdate(active=False, effective_from=dated.effective_from, reason=dated.reason),
                          request, db, user)


# ---------- positions ----------
POSITION_COLS = ("code", "profile_id", "department_id", "location_id", "country_code", "grade", "manager_id", "headcount",
                 "filled", "status", "active")


def _position_out(db: Session, row: Position) -> PositionOut:
    out = PositionOut.model_validate(row)
    profile = db.get(JobProfile, row.profile_id)
    out.title = profile.title if profile else None
    return out


def _check_position_refs(db: Session, values: dict[str, Any]) -> None:
    if "profile_id" in values:
        profile = db.get(JobProfile, values["profile_id"]) if values["profile_id"] else None
        if profile is None or not profile.active:
            raise HTTPException(422, "Choose an active job profile.")
    for key, type_ in (("department_id", "department"), ("location_id", "location")):
        if values.get(key):
            unit = db.get(OrgUnit, values[key])
            if unit is None or not unit.active or unit.type != type_:
                raise HTTPException(422, f"Choose an active {type_}.")
    _check_manager(db, values.get("manager_id"))
    if "country_code" in values:
        _check_country(db, values["country_code"])


def _settle_status(row: Position) -> None:
    if row.filled > row.headcount:
        raise HTTPException(422, "Filled seats can't be more than the headcount.")
    if row.status != "frozen":
        row.status = "filled" if row.filled >= row.headcount else "open"


@router.get("/positions", response_model=list[PositionOut])
def list_positions(
    db: DbSession, user: CurrentUserDep,
    status_filter: Annotated[str | None, Query(alias="status", pattern="^(open|frozen|filled)$")] = None,
    department_id: str | None = None, country: str | None = None, profile_id: str | None = None, active: Active = None,
    limit: Annotated[int, Query(ge=1, le=1000)] = 500,
) -> list[PositionOut]:
    stmt = select(Position).where(_active_filter(Position, active))
    if status_filter:
        stmt = stmt.where(Position.status == status_filter)
    if department_id:
        stmt = stmt.where(Position.department_id == department_id)
    if country:
        stmt = stmt.where(Position.country_code == country.upper())
    if profile_id:
        stmt = stmt.where(Position.profile_id == profile_id)
    return [_position_out(db, r) for r in db.scalars(stmt.order_by(Position.code).limit(limit))]


@router.get("/positions/{position_id}", response_model=PositionOut)
def get_position(position_id: str, db: DbSession, user: CurrentUserDep) -> PositionOut:
    row = db.get(Position, position_id)
    if row is None:
        raise NOT_FOUND
    return _position_out(db, row)


@router.get("/positions/{position_id}/history", response_model=list[OrgVersionOut])
def position_history(position_id: str, db: DbSession, user: CurrentUserDep) -> list[OrgVersionOut]:
    row = db.get(Position, position_id)
    if row is None:
        raise NOT_FOUND
    return _history_out(db, "position", row)


@router.post("/positions", response_model=PositionOut, status_code=status.HTTP_201_CREATED)
def create_position(body: PositionIn, request: Request, db: DbSession, user: CurrentUserDep) -> PositionOut:
    _require_editor(user)
    values = body.model_dump(exclude={"effective_from"})
    _check_position_refs(db, values)
    effective = _effective(db, "position", None, body.effective_from)
    department = db.get(OrgUnit, body.department_id) if body.department_id else None
    code = body.code or org_rules.next_position_code(db, department.name if department else None, body.country_code)
    _unique_code(db, Position, code)
    profile = db.get(JobProfile, body.profile_id)
    values.update(code=code, grade=body.grade or (profile.grade if profile else None))
    row = Position(id=f"pos-{uuid.uuid4().hex[:12]}", active=True, **values)
    _settle_status(row)
    db.add(row)
    db.flush()
    hist.record_created(db, "position", row, effective, user.id)
    _audit(db, user, request, "position_created", "position", row.id, None, _cols(row, POSITION_COLS))
    db.commit()
    return _position_out(db, row)


@router.patch("/positions/{position_id}", response_model=PositionOut)
def update_position(position_id: str, body: PositionUpdate, request: Request, db: DbSession, user: CurrentUserDep) -> PositionOut:
    _require_editor(user)
    row = db.get(Position, position_id)
    if row is None:
        raise NOT_FOUND
    changes = body.model_dump(exclude_unset=True)
    effective_in, reason = changes.pop("effective_from", None), changes.pop("reason", None)
    for key in ("profile_id", "headcount", "filled", "status", "active"):
        if key in changes and changes[key] is None:
            changes.pop(key)
    _check_position_refs(db, changes)
    if changes.get("active") is False and row.active and (changes.get("filled", row.filled) or 0) > 0:
        raise HTTPException(409, "People still fill this position; move them first.")
    effective = _effective(db, "position", row, effective_in)
    before = _cols(row, POSITION_COLS)
    snap = hist.snapshot("position", row)
    for k, v in changes.items():
        setattr(row, k, v)
    if "status" in changes and changes["status"] == "open":
        row.status = "open"
    _settle_status(row)
    hist.record_change(db, "position", row, snap, effective, user.id, reason)
    _audit(db, user, request, "position_updated", "position", row.id, before,
           _cols(row, POSITION_COLS) | {"effective_from": effective})
    db.commit()
    return _position_out(db, row)


@router.post("/positions/{position_id}/deactivate", response_model=PositionOut)
def deactivate_position(position_id: str, request: Request, db: DbSession, user: CurrentUserDep,
                        body: EffectiveDateIn | None = None) -> PositionOut:
    dated = body or EffectiveDateIn()
    return update_position(position_id, PositionUpdate(active=False, effective_from=dated.effective_from, reason=dated.reason),
                           request, db, user)
