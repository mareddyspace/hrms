"""Profile edits (PATCH /people/me, PATCH /people/{id}), correction requests and the Copilot action audit."""

from __future__ import annotations

import pytest
from sqlalchemy import select

from app.db import SessionLocal
from app.models import AuditLog, Employee, Notification
from tests.conftest import login
from tests.talent_helpers import token_for

P = "/api/v1/people"
C = "/api/v1/profile-corrections"
DOT = "•"


@pytest.fixture(scope="module")
def alex(client):
    return token_for("demo-admin", "admin")  # the auth tests lock Alex's account on purpose


@pytest.fixture(scope="module")
def jordan(client):
    return login(client, "jordan.blake@timez.com")


def _audits(entity: str, entity_id: str) -> list[AuditLog]:
    with SessionLocal() as db:
        return list(db.scalars(select(AuditLog).where(AuditLog.entity == entity, AuditLog.entity_id == entity_id)
                               .order_by(AuditLog.id)))


def _raw(person_id: str) -> Employee:
    with SessionLocal() as db:
        emp = db.get(Employee, person_id)
        assert emp is not None
        db.expunge(emp)
        return emp


def test_excel_fields_and_company_are_returned(client, babu, farhan):
    me = client.get(f"{P}/emp-mahesh", headers=babu).json()
    assert me["company"] == "TimeZ"
    for key in ("holiday_calendar", "leave_policy_name", "payroll_status", "ai_profile_status"):
        assert key in me
    sample = client.get(f"{P}/TZ0001", headers=farhan).json()
    assert sample["company"] == "TimeZ" and sample["holiday_calendar"] and sample["leave_policy_name"]
    basic = client.get(f"{P}/TZ0001", headers=babu).json()
    assert basic["view"] == "basic" and basic["company"] == "TimeZ"


def test_owner_updates_own_profile_masked_and_audited(client, babu):
    body = {
        "preferred_name": "Babu",
        "address_line": "12 MG Road, Flat 4B",
        "address_city": "Kochi",
        "address_postcode": "682016",
        "address_country": "India",
        "emergency_name": "Lakshmi Menon",
        "emergency_relationship": "Spouse",
        "emergency_phone": "+91 98470 11223",
        "preferred_language": "Malayalam",
        "languages": ["English", "Hindi"],
        "education": [{"degree": "B.Tech", "institution": "CUSAT", "year": 2012}],
        "experience": [{"employer": "Acme", "title": "Engineer", "from": "2012-06", "to": "2016-03"}],
        "career_goals": "Lead a platform team.",
    }
    res = client.patch(f"{P}/me", headers=babu, json=body)
    assert res.status_code == 200, res.text
    out = res.json()
    assert out["address_line"] == DOT * 4 and out["address_postcode"] == DOT * 4
    assert out["address_city"] == "Kochi" and out["address_country"] == "India"
    assert out["emergency_phone"].startswith("+91 ") and "11223" in out["emergency_phone"] and "98470" not in out["emergency_phone"]
    assert out["languages"] == ["Malayalam", "English", "Hindi"]  # preferred language added
    assert out["experience"][0]["from"] == "2012-06"
    raw = _raw("emp-mahesh")
    assert raw.address_line == "12 MG Road, Flat 4B" and raw.emergency_phone == "+91 98470 11223"

    entry = _audits("employee", "emp-mahesh")[-1]
    assert entry.action == "updated own profile" and entry.actor_id == "emp-mahesh"
    after = entry.changes["after"]
    assert after["address_line"] == DOT * 4 and after["address_postcode"] == DOT * 4
    assert "98470" not in str(entry.changes) and "MG Road" not in str(entry.changes)
    assert after["address_city"] == "Kochi"

    # Same values again: nothing changes, nothing audited.
    count = len(_audits("employee", "emp-mahesh"))
    assert client.patch(f"{P}/me", headers=babu, json={"address_city": "Kochi"}).status_code == 200
    assert len(_audits("employee", "emp-mahesh")) == count


def test_owner_reveals_new_fields_and_others_cannot(client, babu, ram, farhan):
    res = client.get(f"{P}/emp-mahesh/reveal", headers=babu, params={"field": "address_line"})
    assert res.status_code == 200 and res.json()["value"] == "12 MG Road, Flat 4B"
    assert client.get(f"{P}/emp-mahesh/reveal", headers=farhan, params={"field": "emergency_phone"}).json()["value"] == "+91 98470 11223"
    assert client.get(f"{P}/emp-mahesh/reveal", headers=ram, params={"field": "address_postcode"}).status_code == 403
    # The manager sees the record, but masked.
    seen = client.get(f"{P}/emp-mahesh", headers=ram).json()
    assert seen["view"] == "full" and seen["address_line"] == DOT * 4


def test_owner_cannot_set_hr_owned_fields(client, babu):
    for body in ({"nationality": "British"}, {"work_arrangement": "Remote"}, {"first_name": "X"}, {"date_of_birth": "1990-01-01"}):
        assert client.patch(f"{P}/me", headers=babu, json=body).status_code == 422
    assert client.patch(f"{P}/me", headers=babu, json={"emergency_phone": "abc"}).status_code == 422
    assert client.patch(f"{P}/me", headers=babu, json={"personal_email": "not-an-email"}).status_code == 422
    bad_exp = {"experience": [{"employer": "A", "title": "B", "from": "2016-01", "to": "2015-01"}]}
    assert client.patch(f"{P}/me", headers=babu, json=bad_exp).status_code == 422


def test_hr_edits_in_scope_and_others_cannot(client, babu, ram, farhan, alex, jordan):
    for headers in (babu, ram, jordan):
        assert client.patch(f"{P}/TZ0001", headers=headers, json={"nationality": "Indian"}).status_code == 403
    res = client.patch(f"{P}/TZ0001", headers=farhan, json={"nationality": "Indian", "work_arrangement": "Hybrid",
                                                            "date_of_birth": "1991-05-06"})
    assert res.status_code == 200, res.text
    assert res.json()["nationality"] == "Indian" and res.json()["work_arrangement"] == "Hybrid"
    assert res.json()["date_of_birth"].endswith("1991") and "05" not in res.json()["date_of_birth"]
    entry = _audits("employee", "TZ0001")[-1]
    assert entry.actor_id == "demo-hr-admin" and entry.action == "updated profile"
    assert "1991-05-06" not in str(entry.changes) and entry.changes["after"]["work_arrangement"] == "Hybrid"
    # Admin may edit too; HR may not edit themselves through this route.
    assert client.patch(f"{P}/TZ0001", headers=alex, json={"work_arrangement": "Office"}).status_code == 200
    assert client.patch(f"{P}/demo-hr-admin", headers=farhan, json={"nationality": "Indian"}).status_code == 403
    assert client.patch(f"{P}/TZ0001", headers=farhan, json={"work_arrangement": "Moon"}).status_code == 422


def test_hr_outside_country_scope_cannot_edit(client, farhan):
    from app.models import AccessScope

    with SessionLocal() as db:
        db.merge(AccessScope(account_id="demo-hr-admin", country_codes="IN"))
        db.commit()
    try:
        uk = next(p for p in client.get(P, headers=farhan, params={"country": "GB"}).json()["items"])
        assert client.patch(f"{P}/{uk['id']}", headers=farhan, json={"nationality": "British"}).status_code == 403
    finally:
        with SessionLocal() as db:
            row = db.get(AccessScope, "demo-hr-admin")
            if row:
                db.delete(row)
            db.commit()


def test_correction_flow_approve_applies_field(client, babu, ram, farhan):
    res = client.post(f"{P}/emp-mahesh/corrections", headers=babu,
                      json={"field": "nationality", "requested_value": "Indian", "reason": "Passport"})
    assert res.status_code == 201, res.text
    row = res.json()
    assert row["status"] == "pending" and row["can_decide"] is False
    # One open request per field; only the owner may raise one.
    assert client.post(f"{P}/emp-mahesh/corrections", headers=babu,
                       json={"field": "nationality", "requested_value": "British", "reason": "x"}).status_code == 409
    assert client.post(f"{P}/emp-ram/corrections", headers=babu,
                       json={"field": "nationality", "requested_value": "Indian", "reason": "x"}).status_code == 403
    with SessionLocal() as db:
        assert db.scalar(select(Notification).where(Notification.recipient_id == "demo-hr-admin",
                                                    Notification.title == "Profile correction to review"))

    queue = client.get(C, headers=farhan, params={"status": "pending"}).json()
    mine = next(r for r in queue if r["id"] == row["id"])
    assert mine["can_decide"] is True and mine["employee_name"]
    assert [r["id"] for r in client.get(C, headers=ram).json()] == []  # managers don't see others' requests
    assert any(r["id"] == row["id"] for r in client.get(C, headers=babu).json())

    assert client.post(f"{C}/{row['id']}/decide", headers=ram, json={"decision": "approve"}).status_code == 403
    assert client.post(f"{C}/{row['id']}/decide", headers=babu, json={"decision": "approve"}).status_code == 403
    res = client.post(f"{C}/{row['id']}/decide", headers=farhan, json={"decision": "approve"})
    assert res.status_code == 200 and res.json()["status"] == "approved"
    assert _raw("emp-mahesh").nationality == "Indian"
    assert any(a.action == "updated profile" and a.changes["after"].get("nationality") == "Indian"
               for a in _audits("employee", "emp-mahesh"))
    assert [a.action for a in _audits("profile_correction", row["id"])] == ["requested profile correction", "decided profile correction"]
    assert client.post(f"{C}/{row['id']}/decide", headers=farhan, json={"decision": "reject", "note": "x"}).status_code == 409


def test_correction_reject_withdraw_and_masking(client, babu, farhan):
    res = client.post(f"{P}/emp-mahesh/corrections", headers=babu,
                      json={"field": "date_of_birth", "requested_value": "1990-02-03", "reason": "Typo"})
    assert res.status_code == 201
    cid = res.json()["id"]
    assert res.json()["requested_value"] == "1990-02-03"  # the owner may see their own value
    assert client.post(f"{C}/{cid}/decide", headers=farhan, json={"decision": "reject"}).status_code == 422  # note required
    res = client.post(f"{C}/{cid}/decide", headers=farhan, json={"decision": "reject", "note": "Send a document"})
    assert res.json()["status"] == "rejected"
    for entry in _audits("profile_correction", cid):
        assert "1990-02-03" not in str(entry.changes)

    res = client.post(f"{P}/emp-mahesh/corrections", headers=babu,
                      json={"field": "work_arrangement", "requested_value": "Remote", "reason": "Moved"})
    cid = res.json()["id"]
    assert client.post(f"{C}/{cid}/withdraw", headers=farhan).status_code == 403
    assert client.post(f"{C}/{cid}/withdraw", headers=babu).json()["status"] == "withdrawn"
    assert client.post(f"{P}/emp-mahesh/corrections", headers=babu,
                       json={"field": "work_arrangement", "requested_value": "Moon", "reason": "x"}).status_code == 422


def test_name_and_manager_corrections(client, babu, farhan):
    before = _raw("emp-mahesh")
    res = client.post(f"{P}/emp-mahesh/corrections", headers=babu,
                      json={"field": "middle_name", "requested_value": "Kumar", "reason": "Missing"})
    cid = res.json()["id"]
    client.post(f"{C}/{cid}/decide", headers=farhan, json={"decision": "approve"})
    after = _raw("emp-mahesh")
    assert after.middle_name == "Kumar" and after.full_name == f"{before.first_name} Kumar {before.last_name}"
    # Put it back (HR edit recomputes the full name).
    client.patch(f"{P}/emp-mahesh", headers=farhan, json={"middle_name": None})
    assert _raw("emp-mahesh").full_name == before.full_name

    # A manager who reports to this person is refused.
    assert client.post(f"{P}/emp-ram/corrections", headers=login(client, "ram.krishnan@timez.com"),
                       json={"field": "manager_id", "requested_value": "emp-mahesh", "reason": "x"}).status_code == 422


def test_ai_action_audit(client, babu):
    for status in ("proposed", "confirmed"):
        res = client.post("/api/v1/ai/actions/audit", headers=babu,
                          json={"action": "update_address", "status": status, "summary": "Change home address to 682016, call +91 98470 11223"})
        assert res.status_code == 201, res.text
    rows = _audits("ai_action", "update_address")
    assert [r.changes["after"]["status"] for r in rows[-2:]] == ["proposed", "confirmed"]
    assert all("682016" not in str(r.changes) and "98470" not in str(r.changes) for r in rows)
    assert client.post("/api/v1/ai/actions/audit", headers=babu, json={"action": "x", "status": "done"}).status_code == 422
    assert client.post("/api/v1/ai/actions/audit", json={"action": "x", "status": "proposed"}).status_code == 401
