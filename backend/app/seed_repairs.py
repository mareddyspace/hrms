"""Correct sample data that contradicts itself (runs last in app.seed.run, after every other seeder).

The generators are fixed too, so a fresh database never needs these; this brings an existing database (the live one
included) in line. Rules, so nothing a person or HR entered is touched:
- A field on an employee is changed only while it still holds exactly the value the old generator wrote (the workbook
  value, or the value app/seed_profiles.py derives from the id).
- Sample rows with fixed seed ids (``*-seed-*``, ``gap-*``) may have their dates corrected in place.
- Nothing is deleted.

Contradictions corrected (each returns a ``fix_...`` count):
- gender: the workbook's Gender column was random ("Rahul ... Female"); the gender that goes with the first name wins.
- manager_grade: a workbook manager on a lower grade than the person (G3 "Controller" managing a G6) is replaced by the
  head of the person's department in their country.
- hiring_manager: the "hiring manager" was the current manager even when that manager joined years later.
- emergency_self / emergency_spouse: a person listed as their own emergency contact; an emergency "spouse" whose
  name differs from the spouse on the benefits dependents.
- tax_regime: Indian staff with old-regime declarations (80C, 80D, HRA) shown as on the new regime.
- visa_nationality: sample visa / work-permit holders whose nationality is the country they work in.
- probation: the sample probation review ending on joining + 182 days, not the country's probation months that the
  compliance calendar shows.
- praise_dates, enrollment_dates, cert_dates: praise, completed courses and certifications dated before the person
  (or the sender) joined.
- review_managers / reviewers_360: a closed review cycle rated by a manager, or answered by a 360 reviewer, who joined
  only after the cycle ended.
"""

from __future__ import annotations

import hashlib
from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Employee, EmployeeAssignment

CEO = "demo-ceo"


def _h(*parts: object) -> int:
    return int(hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest()[:8], 16)


def _day(value: Any) -> date | None:
    if value is None:
        return None
    return value.date() if isinstance(value, datetime) else value


def _sample_id(row_id: object) -> bool:
    text = str(row_id)
    return "-seed-" in text or text.startswith(("gap-", "hrp-"))


def generated_tax_regime(e: Employee) -> str | None:
    """The regime app/seed_profiles.py picks for a blank field (derived from the id)."""
    from app.seed_profiles import _pick

    return _pick(e.id + "tax", ["new", "new", "old"]) if e.country_code == "IN" else None


def align_tax_regime(e: Employee) -> bool:
    """Seeders that write old-regime declarations (80C, 80D, HRA) put the person on the old regime, unless the person
    chose a regime themself (a value other than blank or the generated one)."""
    if e.country_code != "IN" or e.tax_regime == "old":
        return False
    if e.tax_regime in (None, "", generated_tax_regime(e)):
        e.tax_regime = "old"
        return True
    return False


# ---------- people ----------
def _workbook_raw() -> dict[str, dict[str, str | None]]:
    from app.seed_hcm import WORKBOOK_RAW, load_employees

    if not WORKBOOK_RAW:
        load_employees()
    return WORKBOOK_RAW


def _gender(people: dict[str, Employee]) -> int:
    from app.seed_hcm import NAME_GENDER

    raw, fixed = _workbook_raw(), 0
    for e in people.values():
        want = NAME_GENDER.get(e.first_name or "")
        if e.source == "hcm_sample" and want and e.gender != want and e.gender == (raw.get(e.id) or {}).get("gender"):
            e.gender = want
            fixed += 1
    return fixed


def _seniority(grade: str | None) -> int:
    """G3-G9 by number; the sign-in people's L / M / E grades on the same scale (L4 ~ G4, M1 ~ G8, E1 above all)."""
    g = grade or ""
    if g.startswith("G") and g[1:].isdigit():
        return int(g[1:])
    return {"L3": 3, "L4": 4, "L5": 6, "L6": 7, "M1": 8, "M2": 9, "M3": 10, "E1": 12}.get(g, 0)


def _chain(people: dict[str, Employee], pid: str) -> set[str]:
    out: set[str] = set()
    cur = people.get(pid)
    while cur is not None and cur.manager_id and cur.manager_id not in out:
        out.add(cur.manager_id)
        cur = people.get(cur.manager_id)
    return out


def _manager_grade(db: Session, people: dict[str, Employee]) -> int:
    from app.seed_profiles import _rank

    raw, fixed = _workbook_raw(), 0
    sample = [x for x in people.values() if x.source == "hcm_sample" and x.employment_status not in ("Terminated", "Exited")]
    for e in sorted(people.values(), key=lambda x: x.id):
        boss = people.get(e.manager_id or "")
        if (e.source != "hcm_sample" or boss is None or e.manager_id != (raw.get(e.id) or {}).get("manager_id")
                or _seniority(boss.grade) >= _seniority(e.grade)):
            continue

        def ok(x: Employee) -> bool:
            return x.id != e.id and _seniority(x.grade) >= _seniority(e.grade) and e.id not in _chain(people, x.id) | {x.id}

        same_dept = sorted((x for x in sample if x.country_code == e.country_code and x.department == e.department and ok(x)), key=_rank)
        same_country = sorted((x for x in sample if x.country_code == e.country_code and ok(x)), key=_rank)
        new = (same_dept or same_country or [people[CEO]] if CEO in people else [None])[0]
        if new is None:
            continue
        old, e.manager_id = e.manager_id, new.id
        current = db.scalar(select(EmployeeAssignment).where(EmployeeAssignment.employee_id == e.id,
                                                             EmployeeAssignment.effective_to.is_(None)))
        if current is not None and current.manager_id == old:
            current.manager_id = new.id
        _move_sample_manager_rows(db, people, e, old, new.id)
        fixed += 1
    return fixed


def _move_sample_manager_rows(db: Session, people: dict[str, Employee], e: Employee, old: str, new: str) -> None:
    """The sample reviews and 1:1s of someone whose manager was corrected go with the corrected manager, as a fresh
    seed would write them (a manager who joined later than a date keeps the row unchanged)."""
    from app.models import CheckIn, PerfReview, ReviewCycle
    from app.seed_talent_activity import cycle_manager

    for r in db.scalars(select(PerfReview).where(PerfReview.employee_id == e.id, PerfReview.id.like("rev-seed-%"))):
        cycle = db.get(ReviewCycle, r.cycle_id)
        target = cycle_manager(people, e, cycle.end_date) if cycle is not None and cycle.status == "closed" and cycle.end_date else new
        if r.manager_id == old and target:
            r.manager_id = target
            if r.rating_proposed_by == old:
                r.rating_proposed_by = target
    for c in db.scalars(select(CheckIn).where(CheckIn.employee_id == e.id, CheckIn.id.like("chk-seed-%"))):
        if c.manager_id == old and people[new].joining_date <= c.meeting_date:
            c.manager_id = new
            if c.created_by == old:
                c.created_by = new


def _hiring_manager(people: dict[str, Employee]) -> int:
    from app.seed_profiles import hiring_manager_for

    fixed = 0
    for e in people.values():
        boss = people.get(e.manager_id or "")
        if (boss is None or e.hiring_manager != boss.full_name or not boss.joining_date or not e.joining_date
                or boss.joining_date <= e.joining_date):
            continue
        new = hiring_manager_for(e, people)
        if new != e.hiring_manager:
            e.hiring_manager = new
            fixed += 1
    return fixed


def _emergency_self(people: dict[str, Employee]) -> int:
    from app.seed_profiles import FIRST, _pick, _profile_values

    fixed = 0
    for e in people.values():
        cc, parts = e.country_code or "IN", (e.full_name or "").split()
        last = (e.last_name or (parts[-1] if len(parts) > 1 else "")).strip()
        old = f"{_pick(e.id + 'efn', FIRST.get(cc, FIRST['IN']))} {last or _pick(e.id + 'eln', ['Smith', 'Khan', 'Rao'])}"
        if e.emergency_name and e.emergency_name == old and old.lower() == (e.full_name or "").strip().lower():
            new = _profile_values(e)["emergency_name"]
            if new.lower() != e.emergency_name.lower():
                e.emergency_name = new
                fixed += 1
    return fixed


def _emergency_spouse(db: Session, people: dict[str, Employee]) -> int:
    """The emergency contact said "Spouse" with a generated name while the benefits dependents name another spouse."""
    from app.models import BenefitDependent
    from app.seed_profiles import _profile_values

    fixed = 0
    spouses: dict[str, BenefitDependent] = {}
    for d in db.scalars(select(BenefitDependent).where(BenefitDependent.relationship.in_(("Spouse", "Partner"))).order_by(BenefitDependent.id)):
        spouses.setdefault(d.employee_id, d)
    for pid, dep in spouses.items():
        e = people.get(pid)
        if e is None or e.emergency_relationship not in ("Spouse", "Partner") or e.emergency_name == dep.name:
            continue
        if e.emergency_name != _profile_values(e)["emergency_name"]:  # someone typed this contact in: keep it
            continue
        e.emergency_name, e.emergency_relationship = dep.name, dep.relationship
        fixed += 1
    return fixed


def _tax_regime(db: Session, people: dict[str, Employee]) -> int:
    from app.models import TaxDeclaration

    fixed = 0
    holders = set(db.scalars(select(TaxDeclaration.employee_id).where(TaxDeclaration.regime == "old", TaxDeclaration.country_code == "IN")))
    for pid in sorted(holders):
        e = people.get(pid)
        if e is not None and align_tax_regime(e):
            fixed += 1
    return fixed


def _visa_nationality(db: Session, people: dict[str, Employee]) -> int:
    from app.models import EmployeeDocument
    from app.seed_profiles import NATIONALITY
    from app.services.compliance_calendar import IMMIGRANT_NATIONALITY

    fixed = 0
    for doc in db.scalars(select(EmployeeDocument).where(EmployeeDocument.id.like("doc-seed-imm-%")).order_by(EmployeeDocument.id)):
        e = people.get(doc.employee_id)
        if e is None or e.nationality != NATIONALITY.get(e.country_code or ""):
            continue
        i = int(doc.id.rsplit("-", 1)[-1]) if doc.id.rsplit("-", 1)[-1].isdigit() else 0
        e.nationality = IMMIGRANT_NATIONALITY[i % len(IMMIGRANT_NATIONALITY)]
        fixed += 1
    return fixed


def _probation(db: Session, people: dict[str, Employee]) -> int:
    from app.models import Country, LifecycleAction
    from app.services.compliance_calendar import probation_end

    action = db.get(LifecycleAction, "lca-seed-probation")
    e = people.get(action.employee_id) if action is not None else None
    if action is None or e is None or not e.joining_date:
        return 0
    old_end = (e.joining_date + timedelta(days=182)).isoformat()
    country = db.get(Country, e.country_code)
    new_end = probation_end(e, country.probation_months if country else None)
    if new_end is None or (action.after or {}).get("probation_end_date") != old_end or new_end.isoformat() == old_end:
        return 0
    action.after = {**(action.after or {}), "probation_end_date": new_end.isoformat()}
    if action.effective_date and action.effective_date.isoformat() == old_end:
        action.effective_date = new_end
    return 1


# ---------- dates on sample rows ----------
def _praise_dates(db: Session, people: dict[str, Employee], today: date) -> int:
    from app.models import PerfFeedback

    fixed = 0
    for row in db.scalars(select(PerfFeedback).order_by(PerfFeedback.id)):
        a, b = people.get(row.from_id), people.get(row.to_id)
        if not _sample_id(row.id) or a is None or b is None:
            continue
        both = max(a.joining_date, b.joining_date)
        if _day(row.created_at) < both:
            day = min(today, both + timedelta(days=7 + _h(row.id) % 21))
            row.created_at = datetime.combine(day, row.created_at.time(), tzinfo=row.created_at.tzinfo)
            fixed += 1
    return fixed


def _enrollment_dates(db: Session, people: dict[str, Employee], today: date) -> int:
    from app.models import Enrollment

    fixed = 0
    for row in db.scalars(select(Enrollment).where(Enrollment.id.like("enr-seed-%")).order_by(Enrollment.id)):
        e = people.get(row.employee_id)
        if e is None or not e.joining_date:
            continue
        changed = False
        if row.completed_on and row.completed_on < e.joining_date:
            gap = (row.due - row.completed_on) if row.due else timedelta(0)
            row.completed_on = min(today, e.joining_date + timedelta(days=3 + _h(row.id) % 25))
            row.due = row.completed_on + gap if row.due else None
            changed = True
        if row.due and row.due < e.joining_date:
            row.due = e.joining_date + timedelta(days=14 + _h(row.id, "due") % 30)
            changed = True
        fixed += changed
    return fixed


def _cert_dates(db: Session, people: dict[str, Employee], today: date) -> int:
    from app.models import Certification

    fixed = 0
    for row in db.scalars(select(Certification).where(Certification.id.like("cert-seed-%")).order_by(Certification.id)):
        e = people.get(row.employee_id)
        if e is None or not e.joining_date or not row.issued_on or row.issued_on >= e.joining_date:
            continue
        new = min(today, e.joining_date + timedelta(days=20 + _h(row.id) % 60))
        if row.expires_on is not None:
            validity = row.expires_on - row.issued_on
            if validity >= timedelta(days=360):  # a fixed validity (1-3 years): keep it from the new issue date
                row.expires_on = new + validity
            elif row.expires_on < new:
                row.expires_on = new + timedelta(days=365)
        row.issued_on = new
        fixed += 1
    return fixed


def _reviews(db: Session, people: dict[str, Employee]) -> tuple[int, int]:
    from app.models import PerfReview, Reviewer360, ReviewCycle
    from app.seed_talent_activity import cycle_manager

    managers = reviewers = 0
    cycles = {c.id: c for c in db.scalars(select(ReviewCycle))}
    for r in db.scalars(select(PerfReview).where(PerfReview.id.like("rev-seed-%")).order_by(PerfReview.id)):
        cycle, e = cycles.get(r.cycle_id), people.get(r.employee_id)
        if cycle is None or e is None or cycle.end_date is None:
            continue
        m = people.get(r.manager_id or "")
        if m is not None and m.joining_date > cycle.end_date:
            new = cycle_manager(people, e, cycle.end_date)
            if new and new != r.manager_id:
                if r.rating_proposed_by == r.manager_id:
                    r.rating_proposed_by = new
                r.manager_id = new
                managers += 1
        rows = list(db.scalars(select(Reviewer360).where(Reviewer360.review_id == r.id).order_by(Reviewer360.id)))
        taken = {x.reviewer_id for x in rows}
        for x in rows:
            who = people.get(x.reviewer_id)
            if who is None or who.joining_date <= cycle.end_date:
                continue
            peers = [p.id for p in people.values() if p.manager_id and p.manager_id == e.manager_id and p.id != e.id]
            reports = [p.id for p in people.values() if p.manager_id == e.id]
            pool = sorted((i for i in peers + reports + [r.manager_id or ""] if i in people and i not in taken
                           and people[i].joining_date <= cycle.end_date and i != e.id), key=lambda i: _h(e.id, i))
            if not pool:  # nobody close by had joined yet: someone in their department and country who had
                pool = sorted((p.id for p in people.values() if p.id not in taken and p.id != e.id
                               and p.country_code == e.country_code and p.department == e.department
                               and p.joining_date <= cycle.end_date), key=lambda i: _h(e.id, i))
            if not pool:  # a small team: someone else in their country who had joined
                pool = sorted((p.id for p in people.values() if p.id not in taken and p.id != e.id
                               and p.country_code == e.country_code and p.joining_date <= cycle.end_date),
                              key=lambda i: _h(e.id, i))
            if not pool:
                continue
            taken.discard(x.reviewer_id)
            x.reviewer_id = pool[0]
            taken.add(pool[0])
            reviewers += 1
    return managers, reviewers


def seed(db: Session) -> dict[str, int]:
    today = date.today()
    people = {e.id: e for e in db.scalars(select(Employee).order_by(Employee.id))}
    if not people:
        return {}
    out = {"fix_gender": _gender(people)}
    out["fix_hiring_manager"] = _hiring_manager(people)  # judged against the manager the old generator used
    out["fix_manager_grade"] = _manager_grade(db, people)
    out["fix_emergency_self"] = _emergency_self(people)
    db.flush()
    out["fix_emergency_spouse"] = _emergency_spouse(db, people)
    out["fix_tax_regime"] = _tax_regime(db, people)
    out["fix_visa_nationality"] = _visa_nationality(db, people)
    out["fix_probation"] = _probation(db, people)
    out["fix_praise_dates"] = _praise_dates(db, people, today)
    out["fix_enrollment_dates"] = _enrollment_dates(db, people, today)
    out["fix_cert_dates"] = _cert_dates(db, people, today)
    out["fix_review_managers"], out["fix_reviewers_360"] = _reviews(db, people)
    db.flush()
    return out
