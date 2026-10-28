"""Pre-boarding joiners stay out of headcount, review lists and rosters until they start; swaps only with
colleagues who can sign in and respond."""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from sqlalchemy import delete, select

from app.db import SessionLocal
from app.deps import CurrentUser
from app.models import Account, EmailOutboxItem, Employee, EmployeeAssignment, Notification, PerfReview, RosterShift
from app.services.ai_context import build_context
from app.services.data_scope import scope_for
from tests.conftest import login

SH = "/api/v1/shifts"
P = "/api/v1/performance"
JOINER, NO_ACCOUNT = "emp-qa-joiner", "emp-qa-noacct"


def _next_weekday(d: date) -> date:
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d


START = _next_weekday(date.today() + timedelta(days=21))


def _clone(db, emp_id: str, **values) -> None:
    ref = db.get(Employee, "emp-ram")
    cols = {c.key: getattr(ref, c.key) for c in Employee.__table__.columns}
    cols.update(id=emp_id, employee_code=emp_id, email=f"{emp_id}@timez.com", manager_id="demo-ceo", **values)
    db.add(Employee(**cols))


@pytest.fixture(scope="module", autouse=True)
def people():
    with SessionLocal() as db:
        _clone(db, JOINER, full_name="Quinn Joiner", employment_status="Onboarding", joining_date=START)
        _clone(db, NO_ACCOUNT, full_name="Nora NoLogin", employment_status="Active", joining_date=date(2020, 1, 6))
        db.commit()
    yield
    with SessionLocal() as db:
        ids = (JOINER, NO_ACCOUNT)
        for model, col in ((EmailOutboxItem, EmailOutboxItem.recipient_id), (Notification, Notification.recipient_id),
                           (RosterShift, RosterShift.employee_id),
                           (PerfReview, PerfReview.employee_id), (EmployeeAssignment, EmployeeAssignment.employee_id)):
            db.execute(delete(model).where(col.in_(ids)))
        db.execute(delete(Employee).where(Employee.id.in_(ids)))
        db.commit()


def _user(db, email: str) -> CurrentUser:
    account = db.scalar(select(Account).where(Account.email == email))
    return CurrentUser(account=account, employee=db.get(Employee, account.employee_id), scope=scope_for(db, account))


def _line(text: str, prefix: str) -> str:
    return next(line for line in text.splitlines() if line.startswith(prefix))


def test_joiner_not_in_copilot_headcount():
    with SessionLocal() as db:
        user = _user(db, "jordan.blake@timez.com")
        text = build_context(db, user, "What is our headcount?").text()
        total = int(_line(text, "- Active headcount:").split(":")[1])
        direct = _line(text, "- Direct reports:")
        db.get(Employee, JOINER).employment_status = "Active"
        db.get(Employee, JOINER).joining_date = date.today() - timedelta(days=1)
        db.flush()
        after = build_context(db, user, "What is our headcount?").text()
        assert int(_line(after, "- Active headcount:").split(":")[1]) == total + 1  # counted once started
        assert _line(after, "- Direct reports:") != direct
        db.rollback()


def test_joiner_not_in_review_lists(client):
    jordan = login(client, "jordan.blake@timez.com")
    res = client.get(f"{P}/cycles/cyc-h2/reviews/{JOINER}", headers=jordan)
    assert res.status_code == 409 and "hasn't started" in res.json()["detail"]
    with SessionLocal() as db:
        db.add(PerfReview(id="rev-qa-joiner", cycle_id="cyc-h2", employee_id=JOINER, self_status="not_started",
                          manager_status="not_started", released=False))
        db.commit()
    ids = {r["employee_id"] for r in client.get(f"{P}/reviews", headers=jordan, params={"cycle_id": "cyc-h2"}).json()}
    assert JOINER not in ids


def test_joiner_not_rostered_before_start(client):
    jordan = login(client, "jordan.blake@timez.com")
    before = _next_weekday(date.today() + timedelta(days=2))
    res = client.post(f"{SH}/roster/assign", headers=jordan,
                      json={"employee_id": JOINER, "work_date": before.isoformat(), "shift_id": "sh-general"})
    assert res.status_code == 422 and "starts on" in res.json()["detail"]
    res = client.post(f"{SH}/roster/assign", headers=jordan,
                      json={"employee_id": JOINER, "work_date": START.isoformat(), "shift_id": "sh-general"})
    assert res.status_code == 200, res.text
    # removing is always allowed
    res = client.post(f"{SH}/roster/assign", headers=jordan, json={"employee_id": JOINER, "work_date": START.isoformat(), "shift_id": None})
    assert res.status_code == 200, res.text


def test_swap_only_with_someone_who_can_respond(client):
    ram = login(client, "ram.krishnan@timez.com")
    day = _next_weekday(START + timedelta(days=1)).isoformat()
    res = client.post(f"{SH}/swaps", headers=ram, json={"teammate_id": NO_ACCOUNT, "work_date": day, "reason": "Dentist"})
    assert res.status_code == 422 and "no sign-in account" in res.json()["detail"]
    res = client.post(f"{SH}/swaps", headers=ram, json={"teammate_id": JOINER, "work_date": day, "reason": "Dentist"})
    assert res.status_code == 422 and "hasn't started" in res.json()["detail"]


def test_swap_partners_lists_only_people_who_can_respond(client):
    jordan = login(client, "jordan.blake@timez.com")
    ram = login(client, "ram.krishnan@timez.com")
    monday = START - timedelta(days=START.weekday()) + timedelta(weeks=1)
    day = monday + timedelta(days=2)
    for emp, shift in (("emp-ram", "sh-morning"), ("demo-hr-admin", "sh-general"), (NO_ACCOUNT, "sh-evening"), (JOINER, "sh-evening")):
        res = client.post(f"{SH}/roster/assign", headers=jordan, json={"employee_id": emp, "work_date": day.isoformat(), "shift_id": shift})
        assert res.status_code == 200, (emp, res.text)
    assert client.post(f"{SH}/roster/publish", headers=jordan, json={"week_start": monday.isoformat(), "allow_gaps": True}).status_code == 200
    partners = client.get(f"{SH}/swaps/partners", headers=ram, params={"work_date": day.isoformat()}).json()
    assert [p["id"] for p in partners] == ["demo-hr-admin"]
    assert client.get(f"{SH}/swaps/partners", headers=ram, params={"work_date": (day + timedelta(days=1)).isoformat()}).json() == []
