"""Blank details filled by app/seed_fill_gaps.py: every active person has praise, every demo sign-in a certification,
every active project posts; seeding again adds or changes nothing; it only fills what is missing."""

from __future__ import annotations

from datetime import date

from sqlalchemy import delete, select

from app import seed, seed_fill_gaps
from app.db import SessionLocal
from app.models import (
    CareerProfile, CashAdvance, Certification, Employee, EncashmentRequest, PerfFeedback, Project, ProjectDocument,
    ProjectPost,
)
from app.seed_fill_gaps import DEMO_IDS


def _active_ids(db) -> set[str]:
    today = date.today()
    return {e.id for e in db.scalars(select(Employee)) if e.employment_status in ("Active", "On Leave")
            and e.joining_date <= today and (e.last_working_day is None or e.last_working_day >= today)}


def test_first_run_added_rows():
    with SessionLocal() as db:
        assert db.scalars(select(PerfFeedback.id).where(PerfFeedback.id.like("gap-praise-%"))).first() is not None
        assert db.scalars(select(Certification.id).where(Certification.id.like("gap-cert-%"))).first() is not None
        assert db.scalars(select(CashAdvance.id).where(CashAdvance.id.like("ca-gap-%"))).first() is not None


def test_fills_only_what_is_missing_and_counts_are_positive():
    """On a session that is rolled back: take away some rows, and the seeder puts back exactly those kinds."""
    with SessionLocal() as db:
        project = db.scalars(select(Project).where(Project.active.is_(True)).order_by(Project.id)).first()
        target = "emp-oliver"
        db.execute(delete(PerfFeedback).where(PerfFeedback.to_id == target, PerfFeedback.kind == "praise"))
        db.execute(delete(Certification).where(Certification.employee_id == "demo-admin"))
        db.execute(delete(ProjectPost).where(ProjectPost.project_id == project.id))
        db.execute(delete(ProjectDocument).where(ProjectDocument.project_id == project.id))
        db.flush()
        stats = seed_fill_gaps.seed(db)
        assert all(k.startswith("gaps_") for k in stats)
        assert stats["gaps_praise_added"] >= 1 and stats["gaps_certifications_added"] >= 1
        assert stats["gaps_project_posts_added"] >= 2 and stats["gaps_project_documents_added"] >= 1
        assert db.scalar(select(PerfFeedback.id).where(PerfFeedback.to_id == target, PerfFeedback.kind == "praise").limit(1))
        assert stats["gaps_cash_advances_added"] == 0 and stats["gaps_encashments_added"] == 0  # those were left alone
        db.rollback()


def test_second_seed_adds_nothing():
    stats = seed.run()
    assert {k: v for k, v in stats.items() if k.startswith("gaps_") and v} == {}


def test_every_active_person_has_praise():
    with SessionLocal() as db:
        praised = set(db.scalars(select(PerfFeedback.to_id).where(PerfFeedback.kind == "praise")))
        active = _active_ids(db)
    assert active and active <= praised


def test_every_demo_sign_in_has_a_certification():
    with SessionLocal() as db:
        have = set(db.scalars(select(Certification.employee_id)))
    assert set(DEMO_IDS) <= have


def test_every_active_project_has_posts_and_documents():
    with SessionLocal() as db:
        active = set(db.scalars(select(Project.id).where(Project.active.is_(True))))
        posts = set(db.scalars(select(ProjectPost.project_id)))
        docs = set(db.scalars(select(ProjectDocument.project_id)))
    assert active and active <= posts and active <= docs


def test_claims_follow_menu_and_country_rules():
    with SessionLocal() as db:
        for pid in ("demo-admin", "demo-hr-admin", "demo-recruiter"):
            assert db.scalar(select(CashAdvance.id).where(CashAdvance.employee_id == pid).limit(1))
        assert db.scalar(select(CashAdvance.id).where(CashAdvance.id.like("ca-gap-demo-ceo%")).limit(1)) is None
        enc_people = set(db.scalars(select(EncashmentRequest.employee_id).where(EncashmentRequest.id.like("enc-gap-%"))))
        countries = dict(db.execute(select(Employee.id, Employee.country_code)).all())
    assert enc_people and all(countries[p] == "IN" for p in enc_people)


def test_mentors_are_someone_else():
    with SessionLocal() as db:
        rows = list(db.scalars(select(CareerProfile).where(CareerProfile.mentor_id.is_not(None))))
    assert rows and all(r.mentor_id != r.employee_id for r in rows)
