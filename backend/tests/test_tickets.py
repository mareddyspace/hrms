"""Work tickets shared through the backend (/tickets): scoping, assignment, planning, tasks, status rules, audit."""

from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import select

from app.db import SessionLocal
from app.models import AuditLog, Notification, Ticket
from app.security import create_access_token

BASE = "/api/v1/tickets"


def _soon(days: int = 5) -> str:
    return (date.today() + timedelta(days=days)).isoformat()


def _ids(client, headers) -> set[str]:
    res = client.get(BASE, headers=headers)
    assert res.status_code == 200, res.text
    return {t["id"] for t in res.json()}


def test_seeded_samples_are_idempotent_and_scoped(client, babu, ram, farhan):
    with SessionLocal() as db:
        ids = set(db.scalars(select(Ticket.id).where(Ticket.id.like("TCK-10%"))))
        assert {"TCK-1035", "TCK-1042"} <= ids
        seeded = db.get(Ticket, "TCK-1042")
        assert seeded is not None and len(seeded.tasks) == 3 and seeded.sub_owner_id == "emp-priya"

    mine = _ids(client, babu)
    assert {"TCK-1042", "TCK-1039", "TCK-1036", "TCK-1035", "TCK-1040"} <= mine  # owner, requester, watcher
    assert "TCK-1037" not in mine  # Priya's HR query
    assert {"TCK-1042", "TCK-1040", "TCK-1037"} <= _ids(client, ram)  # his team's tickets
    hr = _ids(client, farhan)
    assert "TCK-1037" in hr and "TCK-1040" not in hr
    # A token, not a sign-in: test_auth locks this account on purpose.
    alex = {"Authorization": f"Bearer {create_access_token('demo-admin', 'admin')[0]}"}
    it = _ids(client, alex)
    assert {"TCK-1041", "TCK-1038", "TCK-1036"} <= it and "TCK-1039" not in it

    row = next(t for t in client.get(BASE, headers=babu).json() if t["id"] == "TCK-1042")
    assert row["names"]["emp-priya"] == "Priya Nair" and row["names"]["emp-mahesh"] == "Babu Menon"
    assert row["can_plan"] is True and "In progress" in row["next_statuses"]


def test_manager_assigns_and_owner_works_the_ticket(client, babu, ram):
    res = client.post(BASE, headers=ram, json={"title": "Payment page times out", "type": "Bug", "priority": "high",
                                               "project_id": "p-north", "project_name": "Northwind Billing",
                                               "description": "Spinner never stops."})
    assert res.status_code == 201, res.text
    t = res.json()
    assert t["assignee_id"] is None and t["status"] == "Open"
    tid = t["id"]
    assert tid not in _ids(client, babu)

    res = client.post(f"{BASE}/{tid}/assign", headers=ram, json={"assignee_id": "emp-mahesh"})
    assert res.status_code == 200 and res.json()["assignee_id"] == "emp-mahesh"
    assert client.put(f"{BASE}/{tid}/sub-owner", headers=ram, json={"person_id": "emp-mahesh"}).status_code == 422
    res = client.put(f"{BASE}/{tid}/sub-owner", headers=ram, json={"person_id": "emp-priya"})
    assert res.status_code == 200 and res.json()["sub_owner_id"] == "emp-priya"
    res = client.put(f"{BASE}/{tid}/due", headers=ram, json={"due": _soon(5)})
    assert res.json()["due"] == _soon(5)
    late = client.post(f"{BASE}/{tid}/tasks", headers=ram, json={"title": "Too late", "owner_id": "emp-mahesh", "due": _soon(9)})
    assert late.status_code == 422
    res = client.post(f"{BASE}/{tid}/tasks", headers=ram, json={"title": "Find the slow query", "owner_id": "emp-mahesh", "due": _soon(3)})
    assert res.status_code == 201
    task_id = res.json()["tasks"][0]["id"]

    # Babu, in his own session, sees everything Ram set.
    seen = next(x for x in client.get(BASE, headers=babu).json() if x["id"] == tid)
    assert seen["sub_owner_id"] == "emp-priya" and seen["due"] == _soon(5)
    assert [k["title"] for k in seen["tasks"]] == ["Find the slow query"]
    assert seen["next_statuses"] == ["In progress", "Waiting", "Resolved"]

    res = client.post(f"{BASE}/{tid}/tasks/{task_id}/toggle", headers=babu)
    assert res.status_code == 200 and res.json()["tasks"][0]["done"] is True
    assert client.post(f"{BASE}/{tid}/status", headers=babu, json={"status": "Closed"}).status_code == 403
    res = client.post(f"{BASE}/{tid}/status", headers=babu, json={"status": "In progress"})
    assert res.status_code == 200 and res.json()["status"] == "In progress"
    assert client.post(f"{BASE}/{tid}/status", headers=babu, json={"status": "Resolved"}).status_code == 422  # needs a note
    assert client.post(f"{BASE}/{tid}/comments", headers=babu, json={"text": "Index added on staging."}).status_code == 200

    # Ram sees Babu's updates.
    back = next(x for x in client.get(BASE, headers=ram).json() if x["id"] == tid)
    assert back["status"] == "In progress" and back["tasks"][0]["done"] is True
    assert any(e["kind"] == "comment" and "Index added" in e["text"] for e in back["activity"])

    res = client.post(f"{BASE}/{tid}/status", headers=babu, json={"status": "Resolved", "note": "Query fixed."})
    assert res.status_code == 200
    res = client.post(f"{BASE}/{tid}/status", headers=ram, json={"status": "Closed"})
    assert res.status_code == 200 and res.json()["status"] == "Closed"
    assert client.post(f"{BASE}/{tid}/tasks/{task_id}/toggle", headers=babu).status_code == 409

    with SessionLocal() as db:
        actions = set(db.scalars(select(AuditLog.action).where(AuditLog.entity == "ticket", AuditLog.entity_id == tid)))
        assert {"ticket_created", "ticket_assigned", "ticket_sub_owner", "ticket_due", "ticket_task_added",
                "ticket_task_toggled", "ticket_status", "ticket_comment"} <= actions
        titles = set(db.scalars(select(Notification.title).where(Notification.recipient_id == "emp-mahesh")))
        assert f"Ticket assigned: {tid}" in titles and f"Task on {tid}" in titles
        assert f"{tid} is now In progress" in set(db.scalars(select(Notification.title).where(Notification.recipient_id == "emp-ram")))


def test_assignment_and_planning_rules(client, babu, ram, farhan):
    # Babu has no team: he can't assign to Ram, and an IT ticket routes to the IT desk.
    assert client.post(BASE, headers=babu, json={"title": "Need access", "type": "Bug", "assignee_id": "emp-ram"}).status_code == 403
    assert client.post(BASE, headers=babu, json={"title": "No", "type": "Bug"}).status_code == 422
    assert client.post(BASE, headers=babu, json={"title": "Old date", "type": "Bug", "due": "2020-01-01"}).status_code == 422
    res = client.post(BASE, headers=babu, json={"title": "Keyboard keys stick", "type": "IT support"})
    assert res.status_code == 201 and res.json()["assignee_id"] == "demo-admin"
    tid = res.json()["id"]
    assert tid not in _ids(client, farhan)  # HR doesn't see the IT queue
    assert client.post(f"{BASE}/{tid}/assign", headers=babu, json={"assignee_id": "emp-mahesh"}).status_code == 403

    # Watch toggles; a stranger can't touch the ticket.
    assert "emp-mahesh" in client.post(f"{BASE}/{tid}/watch", headers=babu, json={}).json()["watcher_ids"]
    assert "emp-mahesh" not in client.post(f"{BASE}/{tid}/watch", headers=babu, json={}).json()["watcher_ids"]
    assert client.post(f"{BASE}/{tid}/comments", headers=farhan, json={"text": "hi"}).status_code == 404

    # Ram (Babu's manager) sees it and, as manager of the requester only, can't plan the IT desk's ticket.
    assert tid in _ids(client, ram)
    assert client.put(f"{BASE}/{tid}/due", headers=ram, json={"due": _soon()}).status_code == 403
    # The requester can plan; a task can be removed.
    res = client.post(f"{BASE}/{tid}/tasks", headers=babu, json={"title": "Try another keyboard"})
    task_id = res.json()["tasks"][0]["id"]
    assert client.delete(f"{BASE}/{tid}/tasks/{task_id}", headers=babu).json()["tasks"] == []

    # Ram assigns within his team, including portal-only teammates.
    res = client.post(BASE, headers=ram, json={"title": "Review the GST export", "type": "Bug", "assignee_id": "emp-kabir"})
    assert res.status_code == 201 and res.json()["names"]["emp-kabir"] == "Kabir Sharma"
    assert client.post(f"{BASE}/{res.json()['id']}/assign", headers=ram, json={"assignee_id": "nobody"}).status_code == 422
