"""Effective-dated history for org units, job profiles and positions (table org_change_history, migration 0013).

Each change closes the open version the day before its effective date and opens a new one holding a full snapshot.
A change dated the same day as the open version replaces that version. Changes can be dated today or earlier
(back-dated), but not before the open version starts. Records that existed before history was kept get a
"baseline" version starting on their effective_from (or the earliest joining date in the company).
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Employee, JobProfile, OrgChangeVersion, OrgUnit, Position

COLUMNS: dict[str, tuple[str, ...]] = {
    "org_unit": ("code", "name", "type", "parent_id", "country_code", "manager_id", "headcount", "active"),
    "job_profile": ("code", "title", "family_id", "grade", "job_level", "experience_min_years", "experience_max_years",
                    "education", "description", "responsibilities", "required_skills", "preferred_skills", "active"),
    "position": ("code", "profile_id", "department_id", "location_id", "country_code", "grade", "manager_id", "headcount",
                 "filled", "status", "active"),
}
MODELS: dict[str, type] = {"org_unit": OrgUnit, "job_profile": JobProfile, "position": Position}


class OrgHistoryError(ValueError):
    """A dating rule was broken (422); the message is safe to show."""


def _plain(value: Any) -> Any:
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    return value


def snapshot(entity: str, row: Any) -> dict[str, Any]:
    return {c: _plain(getattr(row, c)) for c in COLUMNS[entity]}


def today() -> date:
    return date.today()


def baseline_date(db: Session) -> date:
    first = db.scalar(select(func.min(Employee.joining_date)))
    return first or today()


def _open_version(db: Session, entity: str, entity_id: str) -> OrgChangeVersion | None:
    return db.scalar(select(OrgChangeVersion).where(
        OrgChangeVersion.entity == entity, OrgChangeVersion.entity_id == entity_id, OrgChangeVersion.effective_to.is_(None),
    ).order_by(OrgChangeVersion.effective_from.desc(), OrgChangeVersion.id.desc()))


def check_date(db: Session, entity: str, row: Any, effective: date) -> None:
    """Call before changing the row."""
    if effective > today():
        raise OrgHistoryError("Use today or an earlier date.")
    current = _open_version(db, entity, row.id)
    start = current.effective_from if current is not None else (row.effective_from or None)
    if start is not None and effective < start:
        raise OrgHistoryError(f"The change date can't be before {start.isoformat()}, when the current version starts.")


def record_created(db: Session, entity: str, row: Any, effective: date, actor_id: str | None) -> None:
    row.effective_from = effective
    db.add(OrgChangeVersion(entity=entity, entity_id=row.id, effective_from=effective, effective_to=None, change="created",
                            changed_fields=[], snapshot=snapshot(entity, row), changed_by=actor_id))


def ensure_baseline(db: Session, entity: str, row: Any, snap: dict[str, Any] | None = None) -> OrgChangeVersion:
    current = _open_version(db, entity, row.id)
    if current is not None:
        return current
    start = row.effective_from or baseline_date(db)
    if row.effective_from is None:
        row.effective_from = start
    version = OrgChangeVersion(entity=entity, entity_id=row.id, effective_from=start, effective_to=None, change="baseline",
                               changed_fields=[], snapshot=snap or snapshot(entity, row), changed_by=None)
    db.add(version)
    db.flush()
    return version


def record_change(db: Session, entity: str, row: Any, before: dict[str, Any], effective: date, actor_id: str | None,
                  reason: str | None = None) -> OrgChangeVersion | None:
    """After the row was changed: write the new version. Returns None when nothing changed."""
    after = snapshot(entity, row)
    changed = [c for c in COLUMNS[entity] if before.get(c) != after.get(c)]
    if not changed:
        return None
    current = ensure_baseline(db, entity, row, before)
    if before.get("active") and not after.get("active"):
        change = "deactivated"
        row.effective_to = effective - timedelta(days=1)
    elif not before.get("active") and after.get("active"):
        change = "reactivated"
        row.effective_to = None
    else:
        change = "updated"
    if current.effective_from >= effective:
        current.snapshot = after
        current.changed_fields = sorted(set(current.changed_fields or []) | set(changed))
        current.change = change if current.change != "created" else "created"
        current.changed_by, current.reason = actor_id, reason or current.reason
        return current
    current.effective_to = effective - timedelta(days=1)
    version = OrgChangeVersion(entity=entity, entity_id=row.id, effective_from=effective, effective_to=None, change=change,
                               changed_fields=changed, snapshot=after, changed_by=actor_id, reason=reason)
    db.add(version)
    return version


def history(db: Session, entity: str, row: Any) -> list[OrgChangeVersion]:
    ensure_baseline(db, entity, row)
    return list(db.scalars(select(OrgChangeVersion).where(
        OrgChangeVersion.entity == entity, OrgChangeVersion.entity_id == row.id,
    ).order_by(OrgChangeVersion.effective_from.desc(), OrgChangeVersion.id.desc())))


def as_of(db: Session, entity: str, day: date) -> list[dict[str, Any]]:
    """Every record as it stood on `day` (records with no history yet use their current values)."""
    model = MODELS[entity]
    versions: dict[str, OrgChangeVersion] = {}
    for v in db.scalars(select(OrgChangeVersion).where(
            OrgChangeVersion.entity == entity, OrgChangeVersion.effective_from <= day,
    ).order_by(OrgChangeVersion.effective_from, OrgChangeVersion.id)):
        if v.effective_to is None or v.effective_to >= day:
            versions[v.entity_id] = v
    with_history = set(db.scalars(select(OrgChangeVersion.entity_id).where(OrgChangeVersion.entity == entity)))
    base = baseline_date(db)
    out: list[dict[str, Any]] = []
    for row in db.scalars(select(model)):
        v = versions.get(row.id)
        if v is not None:
            out.append({**v.snapshot, "id": row.id, "effective_from": v.effective_from, "effective_to": v.effective_to})
        elif row.id not in with_history and (row.effective_from or base) <= day:
            out.append({**snapshot(entity, row), "id": row.id, "effective_from": row.effective_from or base,
                        "effective_to": row.effective_to})
    return out


def backfill_baselines(db: Session) -> int:
    """Seed helper: a baseline version (and effective_from) for every record that has none. Idempotent."""
    have = {(e, i) for e, i in db.execute(select(OrgChangeVersion.entity, OrgChangeVersion.entity_id))}
    base = baseline_date(db)
    added = 0
    for entity, model in MODELS.items():
        for row in db.scalars(select(model)):
            if row.effective_from is None:
                row.effective_from = base
            if (entity, row.id) not in have:
                db.add(OrgChangeVersion(entity=entity, entity_id=row.id, effective_from=row.effective_from, effective_to=None,
                                        change="baseline", changed_fields=[], snapshot=snapshot(entity, row)))
                added += 1
    db.flush()
    return added


# ---------- employee assignments: full org placement ----------
def placement_for(db: Session, emp: Employee) -> dict[str, Any]:
    """business_unit, division, cost_centre, job_profile_id and position_id for an assignment row."""
    position = None
    if emp.position_id:
        position = db.get(Position, emp.position_id) or db.scalar(select(Position).where(Position.code == emp.position_id))
    profile_id = position.profile_id if position is not None else db.scalar(
        select(JobProfile.id).where(JobProfile.title == emp.job_title, JobProfile.active.is_(True)).limit(1))
    return {
        "business_unit": emp.business_unit, "division": emp.division, "cost_centre": emp.cost_centre,
        "job_profile_id": profile_id, "position_id": position.id if position is not None else emp.position_id,
    }


def backfill_assignments(db: Session) -> int:
    """Seed helper: fill the placement columns on open assignment rows written before migration 0013."""
    from app.models import EmployeeAssignment

    filled = 0
    from sqlalchemy import or_

    for row in db.scalars(select(EmployeeAssignment).where(
            EmployeeAssignment.effective_to.is_(None),
            or_(EmployeeAssignment.business_unit.is_(None), EmployeeAssignment.job_profile_id.is_(None)))):
        emp = db.get(Employee, row.employee_id)
        if emp is None:
            continue
        for k, v in placement_for(db, emp).items():
            setattr(row, k, v)
        filled += 1
    db.flush()
    return filled


def seed_history(db: Session) -> dict[str, int]:
    return {"org_history_baselines": backfill_baselines(db), "assignments_placed": backfill_assignments(db)}
