"""Task and ticket rules added with the Tasks / Tickets redesign: who a task may be given to (self, reports, project
colleagues, HR for anyone), followers commenting, ticket priority changes, taking a ticket and withdrawing one."""

from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import select

from app.db import SessionLocal
from app.models import AuditLog, Notification
from app.security import create_access_token

TASKS = "/api/v1/tasks"
TICKETS = "/api/v1/tickets"


def _token(account_id: str, role: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(account_id, role)[0]}"}


def _task(tid: str, code: str, assignee: str, **extra):  # type: ignore[no-untyped-def]
    data = {"id": tid, "code": code, "employeeId": assignee, "subject": "Check the export totals", "priority": "medium",
            "status": "open", "due": (date.today() + timedelta(days=4)).isoformat(), "accepted": False,
            "comments": [], "activity": [{"id": "a1", "action": "Assigned", "actor": "Babu"}]}
    data.update(extra)
    return data


def test_task_assignment_rules(client, babu, ram, farhan):
    # Yourself: always.
    res = client.put(f"{TASKS}/task-rule-self", headers=babu, json={"data": _task("task-rule-self", "TSK-9101", "emp-mahesh")})
    assert res.status_code == 200, res.text
    # A colleague on one of my projects (Babu and Oliver are both on Northwind): allowed.
    res = client.put(f"{TASKS}/task-rule-peer", headers=babu, json={"data": _task("task-rule-peer", "TSK-9102", "emp-oliver")})
    assert res.status_code == 200, res.text
    assert "task-rule-peer" in {t["id"] for t in client.get(TASKS, headers=babu).json()}
    # Not up the reporting line, even though Ram is on the same projects.
    res = client.put(f"{TASKS}/task-rule-up", headers=babu, json={"data": _task("task-rule-up", "TSK-9103", "emp-ram")})
    assert res.status_code == 403 and "colleagues on your projects" in res.json()["detail"]
    # HR can give a task to anyone.
    res = client.put(f"{TASKS}/task-rule-hr", headers=farhan, json={"data": _task("task-rule-hr", "TSK-9104", "emp-ram")})
    assert res.status_code == 200, res.text
    # A recruiter can't hand work to an engineer she shares no project with and who is not below her.
    sophie = _token("demo-recruiter", "recruiter")
    res = client.put(f"{TASKS}/task-rule-x", headers=sophie, json={"data": _task("task-rule-x", "TSK-9105", "emp-anu")})
    assert res.status_code == 403


def test_followers_comment_but_do_not_change(client, babu, ram):
    tid = "task-rule-follow"
    data = _task(tid, "TSK-9110", "emp-mahesh", ccIds=["emp-priya"])
    assert client.put(f"{TASKS}/{tid}", headers=ram, json={"data": data}).status_code == 200
    priya = _token("emp-priya", "employee")
    seen = next(t for t in client.get(TASKS, headers=priya).json() if t["id"] == tid)
    # Changing the status is refused for someone on cc.
    changed = dict(seen["data"], status="done")
    res = client.put(f"{TASKS}/{tid}", headers=priya, json={"data": changed, "base_version": seen["version"]})
    assert res.status_code == 403
    # Adding a comment is fine, and the owner and the assigner hear about it.
    comment = {"id": "c-f1", "author": "Priya", "text": "I can pair on this tomorrow.", "at": "2026-11-11T10:00:00Z"}
    commented = dict(seen["data"], comments=[comment], lastActivityAt="2026-11-11T10:00:00Z")
    res = client.put(f"{TASKS}/{tid}", headers=priya, json={"data": commented, "base_version": seen["version"]})
    assert res.status_code == 200, res.text
    assert res.json()["data"]["comments"][0]["text"] == "I can pair on this tomorrow."
    with SessionLocal() as db:
        for person in ("emp-mahesh", "emp-ram"):
            titles = set(db.scalars(select(Notification.title).where(Notification.recipient_id == person,
                                                                     Notification.href == f"/tasks?task={tid}")))
            assert "TSK-9110: comment from Priya Nair" in titles
    # Editing an earlier comment is not "only adding" one.
    edited = dict(res.json()["data"], comments=[dict(comment, text="edited"), {**comment, "id": "c-f2"}])
    assert client.put(f"{TASKS}/{tid}", headers=priya, json={"data": edited}).status_code == 403


def test_ticket_priority_take_and_withdraw(client, babu, ram, farhan):
    # Babu raises an unassigned bug: he can withdraw it but not take it; his manager Ram can take it.
    res = client.post(TICKETS, headers=babu, json={"title": "Report page shows wrong totals", "type": "Bug", "priority": "low"})
    assert res.status_code == 201, res.text
    t = res.json()
    tid = t["id"]
    assert t["can_take"] is False and "Closed" in t["next_statuses"]  # requester may withdraw while Open

    ram_row = next(x for x in client.get(TICKETS, headers=ram).json() if x["id"] == tid)
    assert ram_row["can_take"] is True
    # Babu (no team) can't take or assign; priority can be changed by the requester (a planner).
    assert client.post(f"{TICKETS}/{tid}/assign", headers=babu, json={"assignee_id": "emp-mahesh"}).status_code == 403
    res = client.put(f"{TICKETS}/{tid}/priority", headers=babu, json={"priority": "high"})
    assert res.status_code == 200 and res.json()["priority"] == "high"
    assert client.put(f"{TICKETS}/{tid}/priority", headers=babu, json={"priority": "high"}).status_code == 409
    assert client.put(f"{TICKETS}/{tid}/priority", headers=babu, json={"priority": "critical"}).status_code == 422
    # HR can't change a ticket it can't see.
    assert client.put(f"{TICKETS}/{tid}/priority", headers=farhan, json={"priority": "low"}).status_code == 404

    res = client.post(f"{TICKETS}/{tid}/assign", headers=ram, json={"assignee_id": "emp-ram"})
    assert res.status_code == 200 and res.json()["assignee_id"] == "emp-ram"
    assert res.json()["can_take"] is False
    # Once someone is working on it, the requester can no longer withdraw it.
    assert client.post(f"{TICKETS}/{tid}/status", headers=ram, json={"status": "In progress"}).status_code == 200
    assert client.post(f"{TICKETS}/{tid}/status", headers=babu, json={"status": "Closed"}).status_code == 403

    # A fresh ticket can be withdrawn by its requester.
    res = client.post(TICKETS, headers=babu, json={"title": "Second monitor request", "type": "Bug"})
    wid = res.json()["id"]
    res = client.post(f"{TICKETS}/{wid}/status", headers=babu, json={"status": "Closed", "note": "Not needed now."})
    assert res.status_code == 200 and res.json()["status"] == "Closed"

    # HR takes an HR query it can see in its queue.
    res = client.post(TICKETS, headers=babu, json={"title": "Question on gratuity", "type": "HR query", "assignee_id": None})
    hid = res.json()["id"]
    assert res.json()["assignee_id"] == "demo-hr-admin"
    with SessionLocal() as db:
        actions = set(db.scalars(select(AuditLog.action).where(AuditLog.entity == "ticket", AuditLog.entity_id == tid)))
        assert {"ticket_priority", "ticket_assigned"} <= actions
    assert hid
