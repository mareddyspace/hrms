"""Recent HR activity from app/seed_hr_period.py: what the HR home's period cards read is not empty (offers sent,
accepted and declined in the last 30 days; an exit in progress; approved leave this week), the directory is
untouched, and seeding again adds nothing."""

from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import func, select

from app import seed_hr_period
from app.db import SessionLocal
from app.models import Candidate, Employee, ExitCase, LeaveRequest, Offer


def test_offer_cards_have_data(client, farhan):
    since = (date.today() - timedelta(days=30)).isoformat()
    offers = client.get("/api/v1/recruiting/offers", headers=farhan).json()
    recent = [o for o in offers if o["id"].startswith("hrp-offer-") and o["sent_on"] and o["sent_on"] >= since]
    statuses = {o["status"] for o in recent}
    assert {"accepted", "declined", "sent"} <= statuses
    accepted = [o for o in recent if o["status"] == "accepted"]
    assert all(o["responded_on"] and o["responded_on"] >= o["sent_on"] for o in accepted)
    with SessionLocal() as db:
        # internal moves: the accepted candidates are existing people, marked Hired; no new directory record
        for o in accepted:
            cand = db.get(Candidate, o["candidate_id"])
            assert cand.stage == "Hired" and cand.employee_id and db.get(Employee, cand.employee_id) is not None


def test_exit_in_progress_without_changing_the_employee(client, farhan):
    rows = client.get("/api/v1/exits", headers=farhan, params={"scope": "all"}).json()
    case = next(r for r in rows if r["id"] == "hrp-exit-early")
    assert case["status"] == "Manager approved"
    assert date.fromisoformat(case["requested_last_day"]) <= date.today() + timedelta(days=30)
    with SessionLocal() as db:
        emp = db.get(Employee, db.get(ExitCase, "hrp-exit-early").employee_id)
        assert emp.employment_status == "Active" and emp.last_working_day is None


def test_approved_leave_this_week(client, farhan):
    today = date.today()
    week_end = today + timedelta(days=(6 - today.weekday()))
    rows = client.get("/api/v1/leave/requests", headers=farhan, params={"view": "all", "limit": 500}).json()
    mine = [r for r in rows if r["id"].startswith("hrp-lv-") and r["status"] == "approved"]
    assert len(mine) >= 2
    if today.weekday() < 5:  # on a weekend the leave starts next week
        assert any(r["from"] <= week_end.isoformat() and r["to"] >= today.isoformat() for r in mine)
    assert len({r["employee_id"] for r in mine}) == len(mine)


def test_second_run_adds_nothing_and_directory_unchanged():
    with SessionLocal() as db:
        before = db.scalar(select(func.count()).select_from(Employee))
        stats = seed_hr_period.seed(db)
        assert stats and all(k.startswith("hrp_") for k in stats)
        assert all(v == 0 for v in stats.values()), stats
        assert db.scalar(select(func.count()).select_from(Employee)) == before
        assert db.scalar(select(func.count()).select_from(LeaveRequest).where(LeaveRequest.id.like("hrp-lv-%"))) >= 2
        db.rollback()
