from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select

from app.db import SessionLocal
from app.models import AuditLog
from tests.conftest import login


def _workday(client, headers, days_ahead: int) -> date:
    """A weekday at least `days_ahead` days out that is not a holiday in the signed-in user's country."""
    day = datetime.now(ZoneInfo("Asia/Kolkata")).date() + timedelta(days=days_ahead)
    holidays: set[str] = set()
    for year in {day.year, day.year + 1}:
        holidays |= {h["date"] for h in client.get("/api/v1/leave/holidays", headers=headers, params={"year": year}).json()}
    while day.weekday() >= 5 or day.isoformat() in holidays:
        day += timedelta(days=1)
    return day


def _balance(client, headers, code: str, year: int, employee_id: str | None = None) -> dict:
    params = {"year": year} | ({"employee_id": employee_id} if employee_id else {})
    rows = client.get("/api/v1/leave/balances", headers=headers, params=params).json()["balances"]
    return next(r for r in rows if r["code"] == code)


def test_policies_for_own_country(client, babu):
    policies = client.get("/api/v1/leave/policies", headers=babu).json()
    by_code = {p["code"]: p for p in policies}
    assert by_code["pto"]["quota"] == 18 and by_code["pto"]["accrual"] == "monthly" and by_code["pto"]["carry_forward_max"] == 10
    assert by_code["casual"]["quota"] == 6
    assert all(p["country_code"] == "IN" for p in policies)
    sophie = login(client, "sophie.clark@timez.com")
    us = {p["code"]: p for p in client.get("/api/v1/leave/policies", headers=sophie).json()}
    assert us["pto"]["quota"] == 15 and "casual" not in us


def test_apply_approve_balance_notification_audit(client, babu, ram):
    day = _workday(client, babu, 10)
    before = _balance(client, babu, "casual", day.year)

    res = client.post(
        "/api/v1/leave/requests",
        headers=babu,
        json={"leave_code": "casual", "from": day.isoformat(), "to": day.isoformat(), "reason": "Personal work"},
    )
    assert res.status_code == 201, res.text
    req = res.json()
    assert req["status"] == "pending" and req["days"] == 1 and req["from"] == day.isoformat()

    pending = _balance(client, babu, "casual", day.year)
    assert pending["pending"] == before["pending"] + 1 and pending["left"] == before["left"]

    # the manager is told
    ram_notes = client.get("/api/v1/notifications", headers=ram).json()
    assert any("Babu Menon" in n["title"] for n in ram_notes)

    # Babu can't approve his own request
    assert client.post(f"/api/v1/leave/requests/{req['id']}/decision", headers=babu, json={"decision": "approve"}).status_code == 403

    res = client.post(f"/api/v1/leave/requests/{req['id']}/decision", headers=ram, json={"decision": "approve", "note": "Enjoy"})
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "approved" and res.json()["decided_by"] == "emp-ram"

    after = _balance(client, babu, "casual", day.year)
    assert after["used"] == before["used"] + 1
    assert after["left"] == before["left"] - 1
    assert after["pending"] == before["pending"]

    notes = client.get("/api/v1/notifications", headers=babu).json()
    approved = next(n for n in notes if n["title"] == "Leave approved")
    assert client.post(f"/api/v1/notifications/{approved['id']}/read", headers=babu).json()["read_at"] is not None
    assert client.post(f"/api/v1/notifications/{approved['id']}/read", headers=ram).status_code == 404

    with SessionLocal() as db:
        actions = list(db.scalars(select(AuditLog.action).where(AuditLog.entity_id == req["id"]).order_by(AuditLog.id)))
        assert actions == ["leave_applied", "leave_approved"]
        entry = db.scalar(select(AuditLog).where(AuditLog.entity_id == req["id"], AuditLog.action == "leave_approved"))
        assert entry.changes["before"]["status"] == "pending" and entry.changes["after"]["status"] == "approved"
        assert entry.actor_id == "emp-ram" and entry.subject_id == "emp-mahesh"

    # already decided
    assert client.post(f"/api/v1/leave/requests/{req['id']}/decision", headers=ram, json={"decision": "reject", "note": "x"}).status_code == 409

    # Babu cancels the approved future leave; balance goes back
    assert client.post(f"/api/v1/leave/requests/{req['id']}/cancel", headers=babu).json()["status"] == "cancelled"
    assert _balance(client, babu, "casual", day.year)["used"] == before["used"]


def test_self_approval_refused_even_for_hr(client, farhan):
    day = _workday(client, farhan, 20)
    res = client.post(
        "/api/v1/leave/requests",
        headers=farhan,
        json={"leave_code": "casual", "from": day.isoformat(), "to": day.isoformat(), "reason": "Errand"},
    )
    assert res.status_code == 201, res.text
    rid = res.json()["id"]
    assert client.post(f"/api/v1/leave/requests/{rid}/decision", headers=farhan, json={"decision": "approve"}).status_code == 403
    # someone else in Farhan's line (Jordan, his manager) can
    jordan = login(client, "jordan.blake@timez.com")
    assert client.post(f"/api/v1/leave/requests/{rid}/decision", headers=jordan, json={"decision": "approve"}).status_code == 200


def test_peer_cannot_decide_and_hr_can(client, babu, farhan):
    day = _workday(client, babu, 30)
    rid = client.post(
        "/api/v1/leave/requests",
        headers=babu,
        json={"leave_code": "casual", "from": day.isoformat(), "to": day.isoformat(), "half": "first", "reason": "Appointment"},
    ).json()["id"]
    sophie = login(client, "sophie.clark@timez.com")  # not above Babu, not HR
    assert client.post(f"/api/v1/leave/requests/{rid}/decision", headers=sophie, json={"decision": "approve"}).status_code == 404
    res = client.post(f"/api/v1/leave/requests/{rid}/decision", headers=farhan, json={"decision": "reject", "note": "Team offsite"})
    assert res.status_code == 200 and res.json()["status"] == "rejected"


def test_validation_rules(client, babu):
    day = _workday(client, babu, 40)
    post = lambda body: client.post("/api/v1/leave/requests", headers=babu, json={"reason": "x", "leave_code": "casual"} | body)  # noqa: E731
    # half day must be a single date
    assert post({"from": day.isoformat(), "to": (day + timedelta(days=3)).isoformat(), "half": "first"}).status_code == 422
    # end before start
    assert post({"from": day.isoformat(), "to": (day - timedelta(days=1)).isoformat()}).status_code == 422
    # past dates
    assert post({"from": "2020-01-06", "to": "2020-01-06"}).status_code == 422
    # more than the balance
    assert post({"leave_code": "bereavement", "from": day.isoformat(), "to": (day + timedelta(days=14)).isoformat()}).status_code == 422
    # half day counts 0.5, and the other half of the same day doesn't clash
    first = post({"from": day.isoformat(), "to": day.isoformat(), "half": "first"})
    assert first.status_code == 201 and first.json()["days"] == 0.5
    assert post({"from": day.isoformat(), "to": day.isoformat(), "half": "second"}).status_code == 201
    # overlap with own pending request
    overlap = post({"from": day.isoformat(), "to": day.isoformat()})
    assert overlap.status_code == 422 and "overlap" in overlap.json()["detail"]
    # withdraw a pending one
    assert client.post(f"/api/v1/leave/requests/{first.json()['id']}/cancel", headers=babu).json()["status"] == "withdrawn"


def test_no_manager_is_auto_approved(client):
    jordan = login(client, "jordan.blake@timez.com")
    day = _workday(client, jordan, 50)
    res = client.post(
        "/api/v1/leave/requests",
        headers=jordan,
        json={"leave_code": "pto", "from": day.isoformat(), "to": day.isoformat(), "reason": "Board travel"},
    )
    if res.status_code == 422:  # monthly accrual may leave nothing early in a year; sick is never in advance
        res = client.post(
            "/api/v1/leave/requests",
            headers=jordan,
            json={"leave_code": "wfh", "from": day.isoformat(), "to": day.isoformat(), "reason": "Board travel"},
        )
    assert res.status_code == 201, res.text
    assert res.json()["status"] == "approved"
