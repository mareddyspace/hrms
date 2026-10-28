"""HR service desk: routing, SLA due date, first response, overdue + escalation, rating, queues, SLA summary."""

from __future__ import annotations

from datetime import timedelta

from app.db import SessionLocal, utcnow
from app.models import DeskTicket
from app.services.desk import add_working_days
from tests.talent_helpers import token_for

D = "/api/v1/desk"


def _ticket(client, headers, category="Benefits", subject="Insurance card missing"):
    res = client.post(f"{D}/requests", headers=headers, json={"category": category, "subject": subject,
                                                             "description": "I have not received my card yet."})
    assert res.status_code == 201, res.text
    return res.json()


def test_working_days_skip_weekends():
    from datetime import datetime
    friday = datetime(2026, 10, 30, 10, 0)
    assert add_working_days(friday, 1) == datetime(2026, 11, 2, 10, 0)
    assert add_working_days(friday, 3) == datetime(2026, 11, 4, 10, 0)


def test_routing_first_response_and_rating(client, babu, farhan):
    t = _ticket(client, babu)
    assert t["assignee_id"] == "demo-hr-admin" and t["status"] == "Open" and t["first_response_at"] is None
    assert t["due_at"] > t["submitted_at"]
    it = _ticket(client, babu, "IT access", "Laptop VPN access")
    assert it["assignee_id"] == "demo-admin"
    # HR raising a ticket routed to themselves: left unassigned
    own = _ticket(client, farhan, "Leave", "Leave balance looks wrong")
    assert own["assignee_id"] is None
    assert own["id"] in {x["id"] for x in client.get(f"{D}/requests", headers=farhan, params={"queue": "unassigned"}).json()}
    assert client.post(f"{D}/requests/{own['id']}/status", headers=farhan, json={"status": "Resolved"}).status_code == 403
    # employees can't see the queue or other people's tickets
    assert client.get(f"{D}/requests", headers=babu, params={"queue": "all"}).status_code == 403
    ram_ticket = client.get(f"{D}/requests/{own['id']}", headers=babu)
    assert ram_ticket.status_code == 404
    # first HR reply sets first response and moves the ticket on
    res = client.post(f"{D}/requests/{t['id']}/comments", headers=farhan, json={"text": "Requested a new card."})
    body = res.json()
    assert body["status"] == "In progress" and body["first_response_at"]
    assert t["id"] in {x["id"] for x in client.get(f"{D}/requests", headers=farhan, params={"queue": "mine"}).json()}
    # rating only once resolved, only by the requester, only once
    assert client.post(f"{D}/requests/{t['id']}/rating", headers=babu, json={"rating": 5}).status_code == 409
    assert client.post(f"{D}/requests/{t['id']}/status", headers=farhan, json={"status": "Resolved"}).json()["resolved_at"]
    assert client.post(f"{D}/requests/{t['id']}/rating", headers=babu, json={"rating": 6}).status_code == 422
    assert client.post(f"{D}/requests/{t['id']}/rating", headers=farhan, json={"rating": 4}).status_code == 403
    assert client.post(f"{D}/requests/{t['id']}/rating", headers=babu, json={"rating": 4}).json()["satisfaction"] == 4
    assert client.post(f"{D}/requests/{t['id']}/rating", headers=babu, json={"rating": 5}).status_code == 409
    summary = client.get(f"{D}/sla-summary", headers=farhan).json()
    assert summary["ratings"] >= 1 and summary["resolved"] >= 1 and summary["avg_first_response_hours"] is not None
    assert client.get(f"{D}/sla-summary", headers=babu).status_code == 403


def test_overdue_is_escalated_once(client, babu, farhan):
    t = _ticket(client, babu, "Documents", "Employment letter")
    assert client.post(f"{D}/requests/{t['id']}/escalate", headers=babu).status_code == 409  # not overdue yet
    with SessionLocal() as db:
        db.get(DeskTicket, t["id"]).due_at = utcnow() - timedelta(hours=3)
        db.commit()
    got = client.get(f"{D}/requests/{t['id']}", headers=babu).json()
    assert got["overdue"] is True
    assert t["id"] in {x["id"] for x in client.get(f"{D}/requests", headers=farhan, params={"queue": "overdue"}).json()}
    admin = token_for("demo-admin", "admin")
    assert client.post("/api/v1/admin/jobs/run", headers=babu).status_code == 403
    first = client.post("/api/v1/admin/jobs/run", headers=admin).json()["results"]
    assert first["desk_escalated"] >= 1
    after = client.get(f"{D}/requests/{t['id']}", headers=farhan).json()
    assert after["escalated_at"] and after["escalation_level"] == 1 and after["priority"] == "High"
    notes = client.get("/api/v1/notifications", headers=farhan).json()
    assert any(n["title"].startswith("HR request escalated") for n in notes)
    client.post("/api/v1/admin/jobs/run", headers=admin)
    assert client.get(f"{D}/requests/{t['id']}", headers=farhan).json()["escalation_level"] == 1
    assert client.post(f"{D}/requests/{t['id']}/escalate", headers=babu).status_code == 409  # already escalated
    # "Waiting on you" pauses the clock
    client.post(f"{D}/requests/{t['id']}/status", headers=farhan, json={"status": "Waiting on you"})
    assert client.get(f"{D}/requests/{t['id']}", headers=babu).json()["overdue"] is False


def test_reassign_rules(client, babu, farhan):
    t = _ticket(client, babu, "Other", "General question")
    assert client.post(f"{D}/requests/{t['id']}/assign", headers=babu, json={"assignee_id": "demo-admin"}).status_code == 403
    assert client.post(f"{D}/requests/{t['id']}/assign", headers=farhan, json={"assignee_id": "emp-mahesh"}).status_code == 422
    res = client.post(f"{D}/requests/{t['id']}/assign", headers=farhan, json={"assignee_id": "demo-admin"})
    assert res.status_code == 200 and res.json()["assignee_id"] == "demo-admin"
