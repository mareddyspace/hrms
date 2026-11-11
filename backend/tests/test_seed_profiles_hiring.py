"""Who hired each person (migration 0030): every active employee has a recruiter and a hiring manager, the fill is
idempotent, and the profile API returns both to HR and to the person."""

from __future__ import annotations

from sqlalchemy import select

from app.db import SessionLocal
from app.models import Employee
from app.seed_profiles import fill_hiring

P = "/api/v1/people"
LEFT = ("Terminated", "Exited")


def test_every_active_employee_has_hired_by_and_hiring_manager(client):
    with SessionLocal() as db:
        active = [e for e in db.scalars(select(Employee)) if e.employment_status not in LEFT]
        assert active
        missing = [e.id for e in active if not (e.hired_by or "").strip() or not (e.hiring_manager or "").strip()]
        assert missing == []


def test_second_run_changes_nothing(client):
    with SessionLocal() as db:
        before = {e.id: (e.hired_by, e.hiring_manager) for e in db.scalars(select(Employee))}
        assert fill_hiring(db) == 0
        db.flush()
        after = {e.id: (e.hired_by, e.hiring_manager) for e in db.scalars(select(Employee))}
        db.rollback()
    assert before == after


def test_api_returns_hiring_to_hr_and_self(client, babu, farhan):
    for headers in (farhan, babu):
        me = client.get(f"{P}/emp-mahesh", headers=headers).json()
        assert me["hired_by"] and me["hiring_manager"]
