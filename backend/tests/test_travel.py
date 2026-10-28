from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import select

from app.db import SessionLocal
from app.models import AuditLog
from app.security import create_access_token

API = "/api/v1/travel"
DEFAULT_TRAVEL = [{"roles": ["manager"], "mode": "any"}, {"roles": ["hr"], "mode": "any"}]


def token_for(account_id: str, role: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(account_id, role)[0]}"}


def today_ist():
    return datetime.now(ZoneInfo("Asia/Kolkata")).date()


@pytest.fixture(scope="module")
def admin():
    return token_for("demo-admin", "admin")


@pytest.fixture(scope="module", autouse=True)
def default_workflow(client, admin):
    assert client.put("/api/v1/workflows/travel", headers=admin, json={"steps": DEFAULT_TRAVEL}).status_code == 200
    yield
    client.put("/api/v1/workflows/travel", headers=admin, json={"steps": DEFAULT_TRAVEL})


def trip(client, headers, to="Mumbai", start_in=10, days=2, cost=25000, **extra):
    start = today_ist() + timedelta(days=start_in)
    body = {"purpose": "Customer workshop", "from_location": "Bengaluru", "to_location": to, "start_date": start.isoformat(),
            "end_date": (start + timedelta(days=days)).isoformat(), "mode": "air", "estimated_cost": cost} | extra
    return client.post(API, headers=headers, json=body)


def test_validation(client, babu):
    assert trip(client, babu, days=-1).status_code == 422  # ends before it starts
    assert trip(client, babu, start_in=-40).status_code == 422  # too far back
    assert trip(client, babu, advance_amount=30000).status_code == 422  # more than the estimate
    assert trip(client, babu, cost=300000, advance_amount=150000).status_code == 422  # over the IN advance cap
    assert trip(client, babu, currency="USD").status_code == 422
    assert trip(client, babu, mode="rocket").status_code == 422
    assert trip(client, babu, cost=0).status_code == 422


def test_manager_then_hr_and_expense_link(client, babu, ram, farhan):
    res = trip(client, babu, to="Delhi", start_in=-5, days=2, advance_amount=5000)
    assert res.status_code == 201, res.text
    item = res.json()
    tid = item["id"]
    assert item["status"] == "submitted" and item["currency"] == "INR" and item["advance_amount"] == 5000
    assert trip(client, babu, to="Delhi", start_in=-4, days=1).status_code == 409  # overlapping trip, same place

    # an expense can't point at a trip that isn't approved yet
    expense = {"category": "Food", "amount": 321, "date": (today_ist() - timedelta(days=4)).isoformat(),
               "description": "Dinner", "trip_id": tid}
    assert client.post("/api/v1/expenses", headers=babu, json=expense).status_code == 422

    assert tid in {t["id"] for t in client.get(API, params={"view": "to_decide"}, headers=ram).json()}
    assert tid not in {t["id"] for t in client.get(API, params={"view": "to_decide"}, headers=farhan).json()}
    res = client.post(f"{API}/{tid}/decision", headers=ram, json={"decision": "approve"}).json()
    assert res["status"] == "submitted" and res["current_step"] == 1
    assert tid in {t["id"] for t in client.get(API, params={"view": "to_decide"}, headers=farhan).json()}
    res = client.post(f"{API}/{tid}/decision", headers=farhan, json={"decision": "approve"})
    assert res.status_code == 200 and res.json()["status"] == "approved"

    res = client.post("/api/v1/expenses", headers=babu, json=expense)
    assert res.status_code == 201, res.text
    assert res.json()["trip_id"] == tid
    # Ram can't link his expense to Babu's trip
    expense_ram = expense | {"amount": 99}
    assert client.post("/api/v1/expenses", headers=ram, json=expense_ram).status_code == 422
    # a started trip with claims can't be withdrawn
    assert client.post(f"{API}/{tid}/withdraw", headers=babu).status_code == 409
    with SessionLocal() as db:
        actions = set(db.scalars(select(AuditLog.action).where(AuditLog.entity_id == tid)))
        assert {"travel_submitted", "travel_approved"} <= actions


def test_parallel_all_and_any(client, admin, babu, ram, farhan):
    client.put("/api/v1/workflows/travel", headers=admin, json={"steps": [{"roles": ["manager", "hr"], "mode": "all"}]})
    tid = trip(client, babu, to="Chennai", start_in=20).json()["id"]
    assert tid in {t["id"] for t in client.get(API, params={"view": "to_decide"}, headers=ram).json()}
    assert tid in {t["id"] for t in client.get(API, params={"view": "to_decide"}, headers=farhan).json()}
    assert client.post(f"{API}/{tid}/decision", headers=farhan, json={"decision": "approve"}).json()["status"] == "submitted"
    assert client.post(f"{API}/{tid}/decision", headers=ram, json={"decision": "approve"}).json()["status"] == "approved"

    client.put("/api/v1/workflows/travel", headers=admin, json={"steps": [{"roles": ["manager", "hr"], "mode": "any"}]})
    tid = trip(client, babu, to="Pune", start_in=30).json()["id"]
    res = client.post(f"{API}/{tid}/decision", headers=farhan, json={"decision": "approve"}).json()
    assert res["status"] == "approved" and res["approval_status"] == "approved"
    assert client.post(f"{API}/{tid}/decision", headers=ram, json={"decision": "approve"}).status_code == 409
    client.put("/api/v1/workflows/travel", headers=admin, json={"steps": DEFAULT_TRAVEL})

    # an approved future trip can be withdrawn
    res = client.post(f"{API}/{tid}/withdraw", headers=babu)
    assert res.status_code == 200 and res.json()["status"] == "withdrawn"
    assert any("cancelled an approved trip" in n["title"] for n in client.get("/api/v1/notifications", headers=ram).json())


def test_reject_withdraw_and_visibility(client, babu, ram):
    sophie = token_for("demo-recruiter", "recruiter")
    tid = trip(client, babu, to="Kochi", start_in=40).json()["id"]
    assert client.get(f"{API}/{tid}", headers=sophie).status_code == 404
    assert client.get(f"{API}/{tid}", headers=ram).status_code == 200
    assert client.post(f"{API}/{tid}/decision", headers=sophie, json={"decision": "approve"}).status_code == 404
    res = client.post(f"{API}/{tid}/decision", headers=ram, json={"decision": "reject", "note": "Do it online"})
    assert res.json()["status"] == "rejected"
    assert client.post(f"{API}/{tid}/withdraw", headers=babu).status_code == 409

    tid = trip(client, babu, to="Goa", start_in=50).json()["id"]
    assert client.post(f"{API}/{tid}/withdraw", headers=ram).status_code == 404
    res = client.post(f"{API}/{tid}/withdraw", headers=babu).json()
    assert res["status"] == "withdrawn" and res["approval_status"] == "cancelled"
    assert any("withdrew a travel request" in n["title"] for n in client.get("/api/v1/notifications", headers=ram).json())
    mine = client.get(API, headers=babu).json()
    assert tid in {t["id"] for t in mine}
    assert tid not in {t["id"] for t in client.get(API, params={"view": "all"}, headers=sophie).json()}
