"""Organization units, job families/profiles and positions: code helpers and the seed derived from employees.

seed_org_from_employees() is idempotent: it only adds what is missing (matched by code), so HR edits are kept.
- one company (TIMEZ); legal entities, business units, divisions and departments under it
- cost centres under the department most of their people belong to; locations under their main legal entity
- job families: employees.job_family, or the department when that is empty
- job profiles: one per job title, in the family and grade most of its holders have
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Employee, JobFamily, JobProfile, OrgUnit, Position

COMPANY_CODE = "TIMEZ"
COMPANY_NAME = "TimeZ"
ISO3 = {"IN": "IND", "US": "USA", "GB": "GBR", "AU": "AUS", "CA": "CAN", "AE": "ARE", "SA": "SAU", "DE": "DEU"}
TYPE_PREFIX = {
    "company": "CO", "legal_entity": "LE", "business_unit": "BU", "division": "DIV", "department": "DEPT", "team": "TEAM",
    "cost_centre": "CC", "location": "LOC", "country": "CTRY", "supervisory_org": "SUP",
}


def slug(text: str, max_len: int = 48) -> str:
    return re.sub(r"[^A-Z0-9]+", "-", text.upper()).strip("-")[:max_len].strip("-") or "X"


def unit_code(type_: str, name: str) -> str:
    return f"{TYPE_PREFIX[type_]}-{slug(name, 60 - len(TYPE_PREFIX[type_]))}"


def unit_id(code: str) -> str:
    return "ou-" + code.lower()


def next_position_code(db: Session, department: str | None, country_code: str) -> str:
    """TIMEZ-<DEP>-<ISO3>-<5-digit running number>, e.g. TIMEZ-ENG-IND-00125."""
    dept = slug(department or "GEN").replace("-", "")[:3] or "GEN"
    country = ISO3.get(country_code, country_code)
    numbers = [int(m.group(1)) for code in db.scalars(select(Position.code))
               if (m := re.search(r"-(\d{5})$", code))]
    return f"{COMPANY_CODE}-{dept}-{country}-{(max(numbers, default=0) + 1):05d}"


def _most_common(values: list) -> object:
    return Counter(v for v in values if v).most_common(1)[0][0] if any(values) else None


def seed_org_from_employees(db: Session) -> dict[str, int]:
    existing_units = {u.code: u for u in db.scalars(select(OrgUnit))}
    added = Counter()

    def unit(type_: str, name: str, parent: OrgUnit | None, country: str | None = None, code: str | None = None) -> OrgUnit:
        code = code or unit_code(type_, name)
        row = existing_units.get(code)
        if row is None:
            row = OrgUnit(id=unit_id(code), code=code, name=name, type=type_, parent_id=parent.id if parent else None,
                          country_code=country, active=True)
            db.add(row)
            existing_units[code] = row
            added["org_units"] += 1
        return row

    people = list(db.execute(select(
        Employee.legal_entity, Employee.business_unit, Employee.division, Employee.department, Employee.cost_centre,
        Employee.location, Employee.country_code, Employee.job_family, Employee.job_title, Employee.grade,
    )).all())
    company = unit("company", COMPANY_NAME, None, code=COMPANY_CODE)
    db.flush()

    entity_country: dict[str, list[str]] = defaultdict(list)
    location_entity: dict[str, list[str]] = defaultdict(list)
    location_country: dict[str, list[str]] = defaultdict(list)
    cc_department: dict[str, list[str]] = defaultdict(list)
    for p in people:
        entity_country[p.legal_entity].append(p.country_code)
        location_entity[p.location].append(p.legal_entity)
        location_country[p.location].append(p.country_code)
        if p.cost_centre:
            cc_department[p.cost_centre].append(p.department)

    from app.models import Country

    for cc in sorted({p.country_code for p in people if p.country_code}):  # country units (migration 0013)
        country = db.get(Country, cc)
        unit("country", country.name if country else cc, company, cc, code=f"CTRY-{cc}")
    entities = {name: unit("legal_entity", name, company, _most_common(c)) for name, c in sorted(entity_country.items())}
    for name in sorted({p.business_unit for p in people if p.business_unit}):
        unit("business_unit", name, company)
    for name in sorted({p.division for p in people if p.division}):
        unit("division", name, company)
    departments = {name: unit("department", name, company) for name in sorted({p.department for p in people})}
    db.flush()
    for cc, depts in sorted(cc_department.items()):
        unit("cost_centre", cc, departments.get(_most_common(depts)), code=unit_code("cost_centre", cc.removeprefix("CC-")))
    for loc, ents in sorted(location_entity.items()):
        unit("location", loc, entities.get(_most_common(ents)), _most_common(location_country[loc]))

    families = {f.name: f for f in db.scalars(select(JobFamily))}
    family_codes = {f.code for f in families.values()}
    for name in sorted({p.job_family or p.department for p in people}):
        code = "JF-" + slug(name)
        if name not in families and code not in family_codes:
            families[name] = JobFamily(id="jf-" + code[3:].lower(), code=code, name=name, active=True)
            family_codes.add(code)
            db.add(families[name])
            added["job_families"] += 1
    db.flush()

    profile_codes = set(db.scalars(select(JobProfile.code)))
    by_title: dict[str, list] = defaultdict(list)
    for p in people:
        by_title[p.job_title].append(p)
    for title, holders in sorted(by_title.items()):
        code = "JP-" + slug(title)
        if code in profile_codes:
            continue
        family = families.get(_most_common([h.job_family or h.department for h in holders]))  # type: ignore[arg-type]
        db.add(JobProfile(id="jp-" + code[3:].lower(), code=code, title=title, family_id=family.id if family else None,
                          grade=_most_common([h.grade for h in holders]), description=None,  # type: ignore[arg-type]
                          required_skills=[], preferred_skills=[], active=True))
        profile_codes.add(code)
        added["job_profiles"] += 1
    db.flush()
    return {
        "org_units": db.scalar(select(func.count()).select_from(OrgUnit)) or 0,
        "job_families": db.scalar(select(func.count()).select_from(JobFamily)) or 0,
        "job_profiles": db.scalar(select(func.count()).select_from(JobProfile)) or 0,
    }
