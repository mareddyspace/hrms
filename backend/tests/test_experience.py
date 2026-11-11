"""Employee experience: assets (request → manager → IT, repair / return), immigration documents (holder adds, HR
verifies, managers see masked numbers) and the privacy centre (consents, data requests, retention, my-data export)."""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from sqlalchemy import select

from app.db import SessionLocal
from app.models import Asset, AuditLog, Notification
from tests.conftest import login

API = "/api/v1"


@pytest.fixture
def priya(client):
    return login(client, "priya.nair@timez.com")


@pytest.fixture
def oliver(client):
    return login(client, "oliver.hughes@timez.com")


@pytest.fixture
def alex(client):
    return login(client, "alex.morgan@timez.com")


def _notes(recipient: str, text: str) -> int:
    with SessionLocal() as db:
        return len([n for n in db.scalars(select(Notification).where(Notification.recipient_id == recipient))
                    if text in n.title])


def _audited(action: str, entity_id: str) -> bool:
    with SessionLocal() as db:
        return db.scalar(select(AuditLog.id).where(AuditLog.action == action, AuditLog.entity_id == entity_id)) is not None


def test_seeded_samples(client, babu, farhan):
    mine = client.get(f"{API}/assets", headers=babu).json()
    assert {a["tag"] for a in mine} >= {"LT-4821", "HS-1190"}
    docs = client.get(f"{API}/immigration/documents", headers=babu).json()
    assert any(d["doc_type"] == "Passport" and d["number"] == "Z4821937" for d in docs)
    assert client.get(f"{API}/privacy/retention", headers=babu).status_code == 200
    queue = client.get(f"{API}/privacy/requests", params={"view": "queue"}, headers=farhan).json()
    assert any(r["id"] == "dsr-2" for r in queue)


def test_new_asset_request_manager_then_it(client, babu, ram, alex):
    res = client.post(f"{API}/assets/requests", json={"kind": "new", "category": "Keyboard and mouse", "item": "",
                                                       "reason": "short"}, headers=babu)
    assert res.status_code == 422  # reason too short
    res = client.post(f"{API}/assets/requests", json={"kind": "new", "category": "Keyboard and mouse", "item": "Ergonomic set",
                                                       "reason": "Wrist strain from the laptop keyboard."}, headers=babu)
    assert res.status_code == 201, res.text
    req = res.json()
    assert req["status"] == "Pending manager" and req["can_cancel"] and req["history"][0]["action"] == "Requested"
    assert client.post(f"{API}/assets/requests", json={"kind": "new", "category": "Keyboard and mouse",
                                                        "reason": "Wrist strain from the laptop keyboard."},
                       headers=babu).status_code == 409
    assert _notes("emp-ram", "New asset request") >= 1

    # Babu can't approve his own; IT can't skip the manager.
    assert client.post(f"{API}/assets/requests/{req['id']}/manager-decision", json={"approve": True}, headers=babu).status_code == 403
    assert client.post(f"{API}/assets/requests/{req['id']}/complete", json={"action": "fulfil", "asset_id": "asset-stock-7"},
                       headers=alex).status_code == 422
    team = client.get(f"{API}/assets/requests", params={"view": "manage"}, headers=ram).json()
    assert any(r["id"] == req["id"] and r["can_approve"] for r in team)
    res = client.post(f"{API}/assets/requests/{req['id']}/manager-decision", json={"approve": True, "note": "OK"}, headers=ram)
    assert res.status_code == 200 and res.json()["status"] == "Pending IT"

    # Babu (employee) can't see the inventory or complete; IT fulfils with a matching in-stock asset.
    assert client.get(f"{API}/assets", params={"view": "all"}, headers=babu).status_code == 403
    assert client.post(f"{API}/assets/requests/{req['id']}/complete", json={"action": "fulfil", "asset_id": "asset-stock-3"},
                       headers=alex).status_code == 422  # a monitor for a keyboard request
    res = client.post(f"{API}/assets/requests/{req['id']}/complete", json={"action": "fulfil", "asset_id": "asset-stock-7"},
                      headers=alex)
    assert res.status_code == 200, res.text
    out = res.json()
    assert out["status"] == "Fulfilled" and [h["status"] for h in out["history"]][-1] == "Fulfilled"
    assert any(a["tag"] == "KB-1001" for a in client.get(f"{API}/assets", headers=babu).json())
    assert _notes("emp-mahesh", "has been issued to you") >= 1
    assert _audited("asset_request_fulfil", req["id"])

    # Return it: straight to IT, IT receives it back into stock.
    res = client.post(f"{API}/assets/requests", json={"kind": "return", "asset_id": "asset-stock-7",
                                                       "reason": "No longer needed after the desk change."}, headers=babu)
    assert res.status_code == 201 and res.json()["status"] == "Pending IT"
    res = client.post(f"{API}/assets/requests/{res.json()['id']}/complete", json={"action": "receive", "condition": "Good"},
                      headers=alex)
    assert res.status_code == 200 and res.json()["status"] == "Returned"
    with SessionLocal() as db:
        a = db.get(Asset, "asset-stock-7")
        assert a.status == "in_stock" and a.employee_id is None


def test_asset_repair_cancel_and_inventory(client, babu, priya, alex):
    # Reporting someone else's asset is refused.
    assert client.post(f"{API}/assets/requests", json={"kind": "repair", "asset_id": "asset-priya-1",
                                                        "reason": "Battery drains in an hour."}, headers=babu).status_code == 422
    res = client.post(f"{API}/assets/requests", json={"kind": "repair", "asset_id": "asset-priya-1",
                                                       "reason": "Battery drains in an hour."}, headers=priya)
    assert res.status_code == 201
    rid = res.json()["id"]
    assert client.post(f"{API}/assets/requests/{rid}/cancel", headers=babu).status_code == 404  # not visible to a peer
    assert client.post(f"{API}/assets/requests/{rid}/complete", json={"action": "reject", "note": "no"},
                       headers=alex).status_code == 422  # reason too short
    res = client.post(f"{API}/assets/requests/{rid}/complete", json={"action": "resolve", "condition": "Good",
                                                                      "note": "Battery replaced."}, headers=alex)
    assert res.status_code == 200 and res.json()["status"] == "Resolved"

    # IT inventory: add, duplicate tag refused, assign, take back, retire.
    body = {"tag": "tb-9001", "name": "Galaxy Tab", "category": "Other", "condition": "New"}
    res = client.post(f"{API}/assets", json=body, headers=alex)
    assert res.status_code == 201 and res.json()["tag"] == "TB-9001"
    aid = res.json()["id"]
    assert client.post(f"{API}/assets", json=body, headers=alex).status_code == 409
    assert client.post(f"{API}/assets", json=body, headers=babu).status_code == 403
    assert client.post(f"{API}/assets/{aid}/assign", json={"employee_id": "emp-priya"}, headers=alex).status_code == 200
    assert client.post(f"{API}/assets/{aid}/retire", json={"note": "End of life"}, headers=alex).status_code == 422
    res = client.post(f"{API}/assets/{aid}/recover", json={"condition": "Damaged", "note": "Cracked screen"}, headers=alex)
    assert res.status_code == 200 and res.json()["status"] == "in_repair"
    assert client.post(f"{API}/assets/{aid}/retire", json={"note": "Cracked screen, not worth fixing"}, headers=alex).json()["status"] == "retired"


def test_immigration_documents(client, babu, ram, farhan):
    today = date.today()
    body = {"doc_type": "Work permit", "number": "wp-778812", "issuing_country": "United Arab Emirates",
            "issue_date": (today - timedelta(days=100)).isoformat(), "expiry_date": (today + timedelta(days=40)).isoformat()}
    res = client.post(f"{API}/immigration/documents", json=body, headers=babu)
    assert res.status_code == 422 and "sponsor" in res.json()["detail"]
    res = client.post(f"{API}/immigration/documents", json={**body, "sponsor": "TimeZ FZ-LLC"}, headers=babu)
    assert res.status_code == 201, res.text
    doc = res.json()
    assert doc["verification"] == "pending" and doc["status"] == "Expiring" and doc["number"] == "WP-778812"
    assert client.post(f"{API}/immigration/documents", json={**body, "sponsor": "X"}, headers=babu).status_code == 409
    assert _notes("demo-hr-admin", "Verify") >= 1

    # Ram (manager) sees the team document masked, can't verify or change it.
    team = client.get(f"{API}/immigration/documents", params={"view": "team"}, headers=ram).json()
    row = next(d for d in team if d["id"] == doc["id"])
    assert row["number_masked"] and "778812" not in row["number"] and row["number"].endswith("8812")
    assert client.post(f"{API}/immigration/documents/{doc['id']}/verify", json={"approve": True}, headers=ram).status_code == 403
    assert client.get(f"{API}/immigration/documents", params={"view": "all"}, headers=ram).status_code == 403
    # Holder can't verify their own; HR returns it with a reason, then the holder fixes it and HR verifies.
    assert client.post(f"{API}/immigration/documents/{doc['id']}/verify", json={"approve": False, "note": "x"},
                       headers=farhan).status_code == 422
    res = client.post(f"{API}/immigration/documents/{doc['id']}/verify",
                      json={"approve": False, "note": "Scan the page with the stamp."}, headers=farhan)
    assert res.json()["verification"] == "rejected"
    res = client.put(f"{API}/immigration/documents/{doc['id']}", json={**body, "sponsor": "TimeZ FZ-LLC"}, headers=babu)
    assert res.json()["verification"] == "pending"
    res = client.post(f"{API}/immigration/documents/{doc['id']}/verify", json={"approve": True}, headers=farhan)
    assert res.json()["verification"] == "verified" and _notes("emp-mahesh", "was verified") >= 1
    res = client.post(f"{API}/immigration/documents/{doc['id']}/renewal", json={"value": True}, headers=babu)
    assert res.json()["status"] == "Renewal in progress"
    assert [h["action"] for h in res.json()["history"]][-1] == "Renewal started"
    # Verified: only HR can remove it.
    assert client.delete(f"{API}/immigration/documents/{doc['id']}", headers=babu).status_code == 403
    cal = client.get(f"{API}/compliance-calendar", params={"days": 90}, headers=farhan)
    assert cal.status_code == 200 and any(i["id"] == f"imm:{doc['id']}" for i in cal.json())
    assert client.delete(f"{API}/immigration/documents/{doc['id']}", headers=farhan).status_code == 204
    assert _audited("immigration_doc_removed", doc["id"])


def test_immigration_reminders():
    from app.services import experience
    from app.services.jobs import _send

    with SessionLocal() as db:
        sent = experience.send_expiry_reminders(db, date.today(), _send)
        again = experience.send_expiry_reminders(db, date.today(), _send)
        db.rollback()
    assert sent >= 0 and again == 0


def test_privacy_centre(client, babu, oliver, farhan):
    res = client.put(f"{API}/privacy/consents/ai-recommendations", json={"granted": True}, headers=oliver)
    assert res.status_code == 200
    cur = {c["topic"]: c["granted"] for c in res.json()["current"]}
    assert cur["ai-recommendations"] is True and cur["comms-emails"] is False
    assert client.put(f"{API}/privacy/consents/nope", json={"granted": True}, headers=oliver).status_code == 422

    assert client.post(f"{API}/privacy/requests", json={"kind": "Deletion", "details": "old"}, headers=oliver).status_code == 422
    res = client.post(f"{API}/privacy/requests", json={"kind": "Deletion", "details": "Remove my old mobile number please."},
                      headers=oliver)
    assert res.status_code == 201
    rid = res.json()["id"]
    assert client.post(f"{API}/privacy/requests", json={"kind": "Deletion", "details": "Another one to remove."},
                       headers=oliver).status_code == 409
    assert client.get(f"{API}/privacy/requests", params={"view": "queue"}, headers=babu).status_code == 403
    assert client.post(f"{API}/privacy/requests/{rid}/move", json={"status": "In progress"}, headers=babu).status_code == 404
    assert client.post(f"{API}/privacy/requests/{rid}/move", json={"status": "Completed", "outcome": "Done here"},
                       headers=farhan).status_code == 422  # start first
    assert client.post(f"{API}/privacy/requests/{rid}/move", json={"status": "In progress"}, headers=farhan).status_code == 200
    res = client.post(f"{API}/privacy/requests/{rid}/move", json={"status": "Completed", "outcome": "Removed from profile."},
                      headers=farhan)
    assert res.json()["status"] == "Closed (manual)" and len(res.json()["history"]) == 3
    assert _notes("emp-oliver", "Closed (manual)") >= 1
    assert client.post(f"{API}/privacy/requests/{rid}/withdraw", headers=oliver).status_code == 409

    # Retention: HR only, duplicates refused.
    body = {"category": "Expense receipts", "period": 7, "unit": "years", "legal_basis": "Legal obligation"}
    assert client.post(f"{API}/privacy/retention", json=body, headers=babu).status_code == 403
    res = client.post(f"{API}/privacy/retention", json=body, headers=farhan)
    assert res.status_code == 201
    assert client.post(f"{API}/privacy/retention", json=body, headers=farhan).status_code == 409
    assert client.delete(f"{API}/privacy/retention/{res.json()['id']}", headers=farhan).status_code == 204

    data = client.get(f"{API}/privacy/my-data", headers=oliver)
    assert data.status_code == 200
    body = data.json()
    assert body["profile"]["id"] == "emp-oliver" and any(s["section"] == "assets" for s in body["summary"])
    assert "password_hash" not in data.text and "hashed" not in data.text
    assert _audited("privacy_data_exported", "emp-oliver")


# ---------- fixes in the existing experience modules ----------
def test_internal_application_timeline_and_withdraw(client, priya, oliver):
    from app.models import JobPosting, Requisition

    with SessionLocal() as db:
        posts = [p.id for p in db.scalars(select(JobPosting).where(JobPosting.status == "open"))
                 if p.closing_date >= date.today() and (req := db.get(Requisition, p.requisition_id)) is not None
                 and req.status == "approved"]
    applied = None
    for headers in (oliver, priya):
        for pid in posts:
            res = client.post(f"{API}/recruiting/postings/{pid}/apply", headers=headers, json={"cover_note": "Keen"})
            if res.status_code == 201:
                applied = (headers, res.json()["reference"])
                break
        if applied:
            break
    if applied is None:
        pytest.skip("no open internal job these people can apply for in the sample data")
    headers, cid = applied
    app = next(a for a in client.get(f"{API}/recruiting/my-applications", headers=headers).json() if a["id"] == cid)
    assert app["can_withdraw"] and app["timeline"][0]["stage"] == "Applied"
    res = client.post(f"{API}/recruiting/my-applications/{cid}/withdraw", headers=headers)
    assert res.status_code == 200 and res.json()["stage"] == "Withdrawn"
    assert client.post(f"{API}/recruiting/my-applications/{cid}/withdraw", headers=headers).status_code == 409
    app = next(a for a in client.get(f"{API}/recruiting/my-applications", headers=headers).json() if a["id"] == cid)
    assert [t["stage"] for t in app["timeline"]][-1] == "Withdrawn" and not app["can_withdraw"]
    assert _audited("candidate_withdrew", cid)


def test_kudos_rules(client, babu):
    from app.models import Employee

    with SessionLocal() as db:
        left = db.scalar(select(Employee.id).where(Employee.employment_status.in_(("Exited", "Terminated"))))
    if left:
        res = client.post(f"{API}/recognition/kudos", headers=babu,
                          json={"to_id": left, "value": "Teamwork", "message": "Thanks for the help!", "points": 0})
        assert res.status_code == 422
    res = client.post(f"{API}/recognition/kudos", headers=babu,
                      json={"to_id": "emp-priya", "value": "Teamwork", "message": "Thanks for covering the release.", "points": 0})
    assert res.status_code == 201, res.text
    assert _audited("recognition_kudos_given", res.json()["id"])
    assert _notes("emp-ram", "Priya") >= 1 or _notes("emp-ram", "was recognised") >= 1


def test_survey_publish_tells_the_audience(client, farhan):
    today = date.today()
    res = client.post(f"{API}/surveys", headers=farhan, json={
        "title": "Experience pulse " + today.isoformat(), "kind": "pulse", "anonymous": True,
        "questions": [{"kind": "rating", "prompt": "How supported do you feel?"}],
        "audience_type": "all", "open_date": today.isoformat(), "close_date": (today + timedelta(days=7)).isoformat(),
        "publish": True})
    assert res.status_code == 201, res.text
    assert _notes("emp-mahesh", "Experience pulse") >= 1


def test_referral_lands_in_pipeline(client, babu):
    from app.models import JobPosting, Requisition

    with SessionLocal() as db:
        reqs = [p.requisition_id for p in db.scalars(select(JobPosting).where(JobPosting.status == "open"))
                if p.closing_date >= date.today() and (r := db.get(Requisition, p.requisition_id)) is not None
                and r.status == "approved"]
    if not reqs:
        pytest.skip("no open job in the sample data")
    body = {"name": "Asha Rao", "email": "asha.rao.ref@example.com", "relationship": "Classmate"}
    assert client.post(f"{API}/recruiting/requisitions/{reqs[0]}/refer", json={**body, "relationship": "x"},
                       headers=babu).status_code == 422
    res = client.post(f"{API}/recruiting/requisitions/{reqs[0]}/refer", json=body, headers=babu)
    assert res.status_code == 201, res.text
    assert client.post(f"{API}/recruiting/requisitions/{reqs[0]}/refer", json=body, headers=babu).status_code == 409
    mine = client.get(f"{API}/recruiting/my-referrals", headers=babu).json()
    assert any(r["id"] == res.json()["id"] and r["stage"] == "Applied" for r in mine)
    assert _audited("candidate_referred", res.json()["id"])
