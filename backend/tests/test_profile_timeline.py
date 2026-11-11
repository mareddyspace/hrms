"""Every sample profile's dates fit together: born -> graduated (21+) -> previous job -> joined TimeZ."""
from datetime import date

from sqlalchemy import select

from app.db import SessionLocal
from app.models import Employee
from app.seed_profiles import _old_background, repair_backgrounds


def _ym(text: str) -> date:
    y, m = text[:7].split("-")
    return date(int(y), int(m), 1)


def test_education_and_previous_job_follow_each_other(database):
    bad = []
    with SessionLocal() as db:
        for e in db.scalars(select(Employee).where(Employee.source == "hcm_sample")):
            grad = max(int(x["year"]) for x in e.education or [])
            if e.date_of_birth and grad < e.date_of_birth.year + 20:
                bad.append((e.id, "graduated too young", e.date_of_birth, grad))
            for job in e.experience or []:
                start, end = _ym(job["from"]), _ym(job["to"])
                if not ("Intern" in job["title"]) and start.year < grad:
                    bad.append((e.id, "job before graduating", grad, job["from"]))
                if end < start or (e.joining_date and end > e.joining_date):
                    bad.append((e.id, "job dates", job["from"], job["to"], e.joining_date))
    assert not bad, bad[:10]


def test_repair_changes_only_untouched_generated_values(database):
    with SessionLocal() as db:
        e = db.get(Employee, "TZ0010")
        old_edu, old_exp = _old_background(e)
        mine = [{"degree": "MBA", "institution": "Somewhere", "year": 2001}]
        e.education, e.experience = mine, old_exp  # a person edited their education: leave the row alone
        db.flush()
        repair_backgrounds(db)
        assert e.education == mine and e.experience == old_exp
        db.rollback()


def test_everyone_was_old_enough_when_joining(database):
    from app.seed_profiles import min_joining_age

    with SessionLocal() as db:
        young = []
        # workbook people (other tests edit the sign-in people's own birth dates on purpose)
        for e in db.scalars(select(Employee).where(Employee.source == "hcm_sample", Employee.date_of_birth.is_not(None),
                                                   Employee.joining_date.is_not(None))):
            age = e.joining_date.year - e.date_of_birth.year - ((e.joining_date.month, e.joining_date.day) < (e.date_of_birth.month, e.date_of_birth.day))
            if age < min_joining_age(e):
                young.append((e.id, e.job_title, e.grade, age))
    assert not young, young[:10]


def test_sign_in_people_have_their_persona_background(database):
    from app.seed_profiles import _personas

    personas = _personas()
    assert len(personas) == 8
    with SessionLocal() as db:  # other tests edit these people on purpose: put back the old generated values first
        for pid in personas:
            e = db.get(Employee, pid)
            e.education, e.experience = _old_background(e)
        db.flush()
        repair_backgrounds(db)
        for pid, want in personas.items():
            e = db.get(Employee, pid)
            assert e.education == want["education"] and e.experience == want["experience"], pid
        db.rollback()
    with SessionLocal() as db:
        titles = [j["title"] for e in db.scalars(select(Employee)) for j in (e.experience or [])]
    assert not [t for t in titles if "Junior Senior" in t or t.startswith("Junior ") and "Director" in t]
