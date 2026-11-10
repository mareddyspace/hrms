"""Sample HR queues and the sign-in people's own records (app/seed_hr_activity.py): present, decided, insert-once."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

from sqlalchemy import func, select

from app import seed_hr_activity
from app.db import SessionLocal
from app.models import (
    ApprovalDelegation, BenefitEnrollment, CompProposal, DeskTicket, Employee, EmployeeDocument, ExitCase,
    ExpenseClaim, Joiner, LeaveRequest, LetterRequest, PolicyAcknowledgment, TaxDeclaration, TravelRequest,
)
from app.models.cases import HrCase
from tests.conftest import login

API = "/api/v1"
OWN = ("emp-ram", "demo-hr-admin", "demo-recruiter", "demo-ceo", "demo-admin")


def _count(db, model, *where) -> int:
    return db.scalar(select(func.count()).select_from(model).where(*where)) or 0


def test_second_run_adds_nothing(database):
    with SessionLocal() as db:
        stats = seed_hr_activity.seed(db)
        db.rollback()
    assert stats and all(v == 0 for v in stats.values()), stats


def test_own_records_for_every_sign_in(database):
    with SessionLocal() as db:
        for who in OWN:
            for model in (LeaveRequest, EmployeeDocument, ExpenseClaim, TravelRequest, BenefitEnrollment):
                assert _count(db, model, model.employee_id == who) > 0, (who, model.__name__)
        # the CEO's own requests are all decided (nobody above him to wait for)
        assert _count(db, LeaveRequest, LeaveRequest.employee_id == "demo-ceo", LeaveRequest.status == "pending") == 0
        assert _count(db, ExpenseClaim, ExpenseClaim.employee_id == "demo-ceo", ExpenseClaim.status == "submitted") == 0
        # seeded own leave is decided, and each person has an upcoming day off
        seeded = list(db.scalars(select(LeaveRequest).where(LeaveRequest.id.like("lv-seed-%"),
                                                            LeaveRequest.employee_id.in_(OWN))))
        assert seeded and all(r.status == "approved" and r.days > 0 for r in seeded)
        assert any(r.from_date > date.today() for r in seeded)
        # tax declarations use the person's own country sections
        for t in db.scalars(select(TaxDeclaration).where(TaxDeclaration.id.like("td-seed-%"))):
            assert t.country_code == db.get(Employee, t.employee_id).country_code


def test_hr_queues_have_work(database):
    with SessionLocal() as db:
        assert _count(db, ExitCase, ExitCase.id.like("exit-seed-%")) == 2
        assert _count(db, HrCase, HrCase.id.like("case-seed-%")) == 2
        assert _count(db, LetterRequest, LetterRequest.id.like("ltr-seed-%"), LetterRequest.status == "pending") == 2
        assert _count(db, LetterRequest, LetterRequest.id == "ltr-seed-ram-employment", LetterRequest.status == "issued") == 1
        assert _count(db, EmployeeDocument, EmployeeDocument.verification_status == "pending") >= 3
        assert _count(db, PolicyAcknowledgment, PolicyAcknowledgment.policy_id == "pf-contribution-change") > 10
        # the sign-ins acknowledge for themselves (Babu's pending acknowledgement is part of the demo)
        assert _count(db, PolicyAcknowledgment, PolicyAcknowledgment.employee_id.in_(OWN + ("emp-mahesh",)),
                      PolicyAcknowledgment.ip.is_(None), PolicyAcknowledgment.acknowledged_at < datetime.now(UTC)
                      - timedelta(days=1)) == 0
        assert _count(db, DeskTicket, DeskTicket.status.in_(("Resolved", "Closed")), DeskTicket.satisfaction.is_(None)) == 0
        joiner = db.get(Joiner, "ob-seed-done")
        assert joiner is not None and joiner.status == "completed"
        # the delegation is for a future window, so it changes nobody's approvals today
        d = db.get(ApprovalDelegation, "dlg-seed-ram")
        assert d is None or d.starts_on > date.today()
        # the pay proposal is for a permanent employee past probation
        p = db.get(CompProposal, "prop-seed-priya")
        if p is not None:
            emp = db.get(Employee, p.employee_id)
            assert emp.employment_type.lower().startswith("full")
            assert emp.joining_date <= date.today() - timedelta(days=365)
        # the sign-ins other than Priya (pay proposal) are never used for the queue samples
        for model in (ExitCase, LetterRequest):
            assert _count(db, model, model.id.like("%-seed-%"), model.employee_id.in_(
                ("emp-mahesh", "emp-priya", "emp-oliver", "demo-hr-admin", "demo-ceo", "demo-admin", "demo-recruiter"))) == 0


def test_screens_show_the_samples(client, farhan):
    alex = login(client, "alex.morgan@timez.com")
    jordan = login(client, "jordan.blake@timez.com")
    assert client.get(f"{API}/exits", headers=farhan, params={"scope": "all"}).json()
    assert client.get(f"{API}/cases", headers=farhan, params={"view": "manage"}).json()
    assert client.get(f"{API}/documents/verification-queue", headers=farhan).json()
    for headers in (alex, jordan):
        assert client.get(f"{API}/leave/requests", headers=headers).json()
        assert client.get(f"{API}/expenses", headers=headers).json()
        assert client.get(f"{API}/benefits/enrollments", headers=headers).json()
