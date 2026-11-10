"""app/seed_admin_data.py: org detail, holidays, integration history, audit samples, payroll providers; insert-only."""

from __future__ import annotations

from sqlalchemy import func, select

from app import seed_admin_data
from app.db import SessionLocal
from app.models import (
    AuditLog, Employee, EmployeeAssignment, Holiday, IntegrationConnector, IntegrationRun, JobProfile, OrgUnit, Position,
)
from tests.talent_helpers import token_for

API = "/api/v1"


def test_positions_and_org_details_are_filled(client):
    with SessionLocal() as db:
        alex = db.get(Employee, "demo-admin")
        seat = db.get(Position, alex.position_id)
        assert seat is not None and seat.status == "filled" and seat.filled == 1
        assert db.scalar(select(func.count()).select_from(Position).where(Position.status == "open")) >= 1
        working = db.scalar(select(func.count()).select_from(Employee).where(Employee.employment_status == "Active"))
        placed = db.scalar(select(func.count()).select_from(Employee).where(Employee.employment_status == "Active",
                                                                            Employee.position_id.is_not(None)))
        assert placed >= working * 0.95
        open_row = db.scalar(select(EmployeeAssignment).where(EmployeeAssignment.employee_id == "demo-admin",
                                                              EmployeeAssignment.effective_to.is_(None)))
        assert open_row.position_id == alex.position_id
        profile = db.scalar(select(JobProfile).where(JobProfile.title == "Software Engineer"))
        assert profile.description and profile.required_skills and profile.job_level and profile.education
        assert profile.responsibilities and profile.experience_min_years < profile.experience_max_years
        company = db.scalar(select(OrgUnit).where(OrgUnit.type == "company"))
        assert company.manager_id == "demo-ceo" and company.headcount >= 500
        eng = db.scalar(select(OrgUnit).where(OrgUnit.code == "DEPT-ENGINEERING"))
        assert eng.manager_id and eng.headcount
    admin = token_for("demo-admin", "admin")
    seats = client.get(f"{API}/org/positions", headers=admin).json()
    assert len(seats) >= 400 and all(s["title"] for s in seats[:20])


def test_holidays_next_year_and_descriptions(client):
    with SessionLocal() as db:
        for cc in ("IN", "US", "GB", "AU", "CA", "AE", "SA", "DE"):
            assert db.scalar(select(func.count()).select_from(Holiday).where(
                Holiday.country_code == cc, Holiday.date >= seed_admin_data.date(2027, 1, 1))) >= 5, cc
        assert db.get(Holiday, "h-diwali").description
    oliver = token_for("emp-oliver", "employee")
    assert client.get(f"{API}/leave/optional-holidays", headers=oliver, params={"year": 2027}).json()


def test_admin_screens_have_history(client):
    with SessionLocal() as db:
        payroll = db.get(IntegrationConnector, "payroll")
        assert payroll.last_sync_at is not None and payroll.run_count >= 1
        assert db.scalar(select(func.count()).select_from(IntegrationRun)) >= 20
        assert db.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.entity == "Copilot question")) >= 5
    admin = token_for("demo-admin", "admin")
    signins = client.get(f"{API}/admin/security/sign-ins", headers=admin, params={"days": 30}).json()
    assert signins["successful"] > 10 and signins["failed"] >= 1
    assert client.get(f"{API}/admin/overview", headers=admin).json()["security_alerts"]
    assert any(e["status"] == "Sent" for e in client.get(f"{API}/admin/email-outbox", headers=admin,
                                                                     params={"status": "Sent"}).json())
    accounts = {a["account_id"]: a for a in client.get(f"{API}/admin/accounts", headers=admin).json()}
    assert accounts["emp-ram"]["page_access"]["custom"] and accounts["demo-recruiter"]["data_scope"]["custom"]


def test_seed_is_insert_only_and_idempotent():
    """A run fills only blanks; the run right after it adds and changes nothing (rolled back: shared test database)."""
    with SessionLocal() as db:
        seed_admin_data.seed(db)
        db.flush()
        again = seed_admin_data.seed(db)
        assert set(again.values()) == {0}, again
        assert not db.new and not [o for o in db.dirty if db.is_modified(o)]
        db.rollback()
