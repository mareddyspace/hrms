"""Migration 0033: ticket categories with service targets, internal notes, resolution / reopen / rating and
escalation; task and ticket attachments; task mentions, dates and due reminders; project members with allocation,
status / health, milestone progress and the hours report (JSON and CSV)."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select

from app.db import SessionLocal
from app.models import AuditLog, Notification, ReminderLog, SharedTask, Ticket
from app.security import create_access_token
from app.services import jobs
from app.services.task_reminders import send_task_reminders
from app.services.tickets import escalate_overdue

TASKS = "/api/v1/tasks"
TICKETS = "/api/v1/tickets"
P = "/api/v1/projects"
PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def _token(account_id: str, role: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(account_id, role)[0]}"}


def _dt(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def _titles(person: str) -> set[str]:
    with SessionLocal() as db:
        return set(db.scalars(select(Notification.title).where(Notification.recipient_id == person)))


# ---------- tickets ----------
def test_ticket_categories_and_targets(client, babu, farhan):
    cats = client.get(f"{TICKETS}/categories", headers=babu).json()
    assert {c["name"] for c in cats} == {"IT support", "HR query", "Bug", "Client issue", "Access request"}
    it = next(c for c in cats if c["name"] == "IT support")
    assert it["queue_owner_id"] == "demo-admin" and it["resolve_hours"] >= it["response_hours"]
    body = {"response_hours": 3, "resolve_hours": 30, "queue_owner_id": "demo-admin", "active": True}
    assert client.put(f"{TICKETS}/categories/IT support", headers=babu, json=body).status_code == 403
    assert client.put(f"{TICKETS}/categories/IT support", headers=farhan,
                      json={**body, "resolve_hours": 2}).status_code == 422
    res = client.put(f"{TICKETS}/categories/IT support", headers=farhan, json=body)
    assert res.status_code == 200 and res.json()["resolve_hours"] == 30

    # High priority = half the medium hours; stored on the ticket when raised.
    res = client.post(TICKETS, headers=babu, json={"title": "Docking station dead", "type": "IT support", "priority": "high"})
    assert res.status_code == 201, res.text
    t = res.json()
    created = _dt(t["created_at"]) if _dt(t["created_at"]).tzinfo else _dt(t["created_at"]).replace(tzinfo=timezone.utc)
    assert abs((_dt(t["resolve_due_at"]) - created) - timedelta(hours=15)) < timedelta(minutes=1)
    assert abs((_dt(t["response_due_at"]) - created) - timedelta(hours=1.5)) < timedelta(minutes=1)
    assert t["sla_state"] in ("ok", "soon") and t["assignee_id"] == "demo-admin"
    with SessionLocal() as db:
        assert db.scalar(select(AuditLog.id).where(AuditLog.action == "ticket_category_updated"))


def test_internal_notes_resolution_reopen_and_rating(client, babu, ram):
    res = client.post(TICKETS, headers=ram, json={"title": "Export misses the footer", "type": "Bug",
                                                  "assignee_id": "emp-mahesh"})
    tid = res.json()["id"]
    assert res.json()["is_agent"] is False  # Ram raised it: he is the requester
    # Internal notes: only the people working it write and see them.
    assert client.post(f"{TICKETS}/{tid}/comments", headers=ram, json={"text": "psst", "internal": True}).status_code == 403
    res = client.post(f"{TICKETS}/{tid}/comments", headers=babu, json={"text": "Footer row is off by one.", "internal": True})
    assert res.status_code == 200 and res.json()["is_agent"] is True
    assert any(e["internal"] and e["text"] == "Footer row is off by one." for e in res.json()["activity"])
    assert res.json()["first_response_at"] is None  # an internal note is not a reply to the requester
    seen_by_ram = next(t for t in client.get(TICKETS, headers=ram).json() if t["id"] == tid)
    assert not any(e["text"] == "Footer row is off by one." for e in seen_by_ram["activity"])
    res = client.post(f"{TICKETS}/{tid}/comments", headers=babu, json={"text": "Looking at it now."})
    assert res.json()["first_response_at"]

    # Resolve with a note; the requester can't reopen without saying why.
    assert client.post(f"{TICKETS}/{tid}/status", headers=babu, json={"status": "Resolved"}).status_code == 422
    res = client.post(f"{TICKETS}/{tid}/status", headers=babu, json={"status": "Resolved", "note": "Fixed the range."})
    assert res.json()["resolution_note"] == "Fixed the range." and res.json()["resolved_at"]
    assert client.post(f"{TICKETS}/{tid}/status", headers=ram, json={"status": "In progress"}).status_code == 422
    res = client.post(f"{TICKETS}/{tid}/status", headers=ram, json={"status": "In progress", "note": "Still missing on PDF."})
    assert res.status_code == 200 and res.json()["reopen_count"] == 1 and res.json()["resolved_at"] is None
    assert client.post(f"{TICKETS}/{tid}/rating", headers=ram, json={"score": 4}).status_code == 409  # not resolved
    client.post(f"{TICKETS}/{tid}/status", headers=babu, json={"status": "Resolved", "note": "PDF too."})
    res = client.post(f"{TICKETS}/{tid}/status", headers=ram, json={"status": "Closed"})
    assert res.json()["status"] == "Closed" and res.json()["can_rate"] is True
    assert client.post(f"{TICKETS}/{tid}/rating", headers=babu, json={"score": 5}).status_code == 403
    assert client.post(f"{TICKETS}/{tid}/rating", headers=ram, json={"score": 6}).status_code == 422
    res = client.post(f"{TICKETS}/{tid}/rating", headers=ram, json={"score": 5, "note": "Quick fix"})
    assert res.json()["satisfaction"] == 5 and res.json()["satisfaction_note"] == "Quick fix"
    assert f"{tid} rated 5/5" in _titles("emp-mahesh")


def test_escalation_when_resolve_target_passes(client, babu, ram):
    res = client.post(TICKETS, headers=ram, json={"title": "Invoices stuck in draft", "type": "Client issue",
                                                  "assignee_id": "emp-mahesh", "priority": "urgent"})
    tid = res.json()["id"]
    with SessionLocal() as db:
        t = db.get(Ticket, tid)
        t.resolve_due_at = datetime.now(timezone.utc) - timedelta(hours=1)
        db.commit()
    row = next(t for t in client.get(TICKETS, headers=babu).json() if t["id"] == tid)
    assert row["escalated_at"] and row["sla_state"] == "breached"
    assert any("escalated to Ram" in e["text"] for e in row["activity"])
    assert f"{tid} missed its resolve target" in _titles("emp-ram")
    # Escalated once only.
    with SessionLocal() as db:
        assert tid not in {t.id for t in escalate_overdue(db)}
        db.rollback()
    again = next(t for t in client.get(TICKETS, headers=babu).json() if t["id"] == tid)
    assert sum("escalated" in e["text"] for e in again["activity"]) == 1


def test_ticket_attachments_public_and_internal(client, babu, ram):
    tid = client.post(TICKETS, headers=ram, json={"title": "Login page typo", "type": "Bug",
                                                  "assignee_id": "emp-mahesh"}).json()["id"]
    res = client.post(f"{TICKETS}/{tid}/attachments?filename=screen.png", headers={**ram, "Content-Type": "image/png"},
                      content=PNG)
    assert res.status_code == 201, res.text
    public = res.json()["attachments"][0]
    assert public["file_name"] == "screen.png" and public["internal"] is False
    # Babu (owner) adds an internal file; Ram (requester) can't see or fetch it.
    res = client.post(f"{TICKETS}/{tid}/attachments?filename=trace.pdf&internal=true",
                      headers={**babu, "Content-Type": "application/pdf"}, content=PDF)
    assert res.status_code == 201 and len(res.json()["attachments"]) == 2
    internal = next(a for a in res.json()["attachments"] if a["internal"])
    ram_view = next(t for t in client.get(TICKETS, headers=ram).json() if t["id"] == tid)
    assert [a["id"] for a in ram_view["attachments"]] == [public["id"]]
    assert client.get(f"{TICKETS}/{tid}/attachments/{internal['id']}/file", headers=ram).status_code == 404
    got = client.get(f"{TICKETS}/{tid}/attachments/{public['id']}/file", headers=babu)
    assert got.status_code == 200 and got.content == PNG
    # Wrong type and someone who can't see the ticket.
    bad = client.post(f"{TICKETS}/{tid}/attachments?filename=x.txt", headers={**babu, "Content-Type": "text/plain"},
                      content=b"hello")
    assert bad.status_code == 415
    sophie = _token("demo-recruiter", "recruiter")
    assert client.get(f"{TICKETS}/{tid}/attachments/{public['id']}/file", headers=sophie).status_code == 404
    res = client.delete(f"{TICKETS}/{tid}/attachments/{public['id']}", headers=babu)
    assert res.status_code == 200 and all(a["id"] != public["id"] for a in res.json()["attachments"])


# ---------- tasks ----------
def _task(tid: str, code: str, assignee: str, **extra):  # type: ignore[no-untyped-def]
    data = {"id": tid, "code": code, "employeeId": assignee, "subject": "Prepare the release notes", "priority": "high",
            "status": "open", "due": (date.today() + timedelta(days=3)).isoformat(), "comments": [], "activity": []}
    data.update(extra)
    return data


def test_task_attachments_and_mentions(client, babu, ram):
    tid = "task-attach-1"
    res = client.put(f"{TASKS}/{tid}", headers=ram, json={"data": _task(tid, "TSK-9301", "emp-mahesh")})
    assert res.status_code == 200, res.text
    res = client.post(f"{TASKS}/{tid}/attachments?filename=spec.pdf", headers={**babu, "Content-Type": "application/pdf"},
                      content=PDF)
    assert res.status_code == 201, res.text
    task = res.json()
    files = task["data"]["attachments"]
    assert len(files) == 1 and files[0]["name"] == "spec.pdf" and task["version"] == 2
    assert task["data"]["activity"][-1]["action"] == "File attached"
    assert client.get(f"{TASKS}/{tid}/attachments/{files[0]['id']}/file", headers=ram).content == PDF
    sophie = _token("demo-recruiter", "recruiter")
    assert client.get(f"{TASKS}/{tid}/attachments/{files[0]['id']}/file", headers=sophie).status_code == 404
    # A stale save can't drop the file from the task.
    stale = dict(task["data"], attachments=[], notes="edited")
    res = client.put(f"{TASKS}/{tid}", headers=babu, json={"data": stale})
    assert len(res.json()["data"]["attachments"]) == 1

    # @mention: Oliver hears about it and is added to cc so he can open the task.
    comment = {"id": "c-m1", "author": "Babu", "text": "@Oliver can you review?", "at": "2026-11-11T10:00:00Z",
               "mentions": ["emp-oliver"]}
    data = dict(res.json()["data"], comments=[comment])
    res = client.put(f"{TASKS}/{tid}", headers=babu, json={"data": data, "base_version": res.json()["version"]})
    assert res.status_code == 200 and "emp-oliver" in res.json()["data"]["ccIds"]
    assert "TSK-9301: Babu Menon mentioned you" in _titles("emp-oliver")
    oliver = _token("emp-oliver", "employee")
    assert tid in {t["id"] for t in client.get(TASKS, headers=oliver).json()}

    res = client.delete(f"{TASKS}/{tid}/attachments/{files[0]['id']}", headers=sophie)
    assert res.status_code == 404
    res = client.delete(f"{TASKS}/{tid}/attachments/{files[0]['id']}", headers=ram)
    assert res.status_code == 200 and res.json()["data"]["attachments"] == []


def test_task_dates_and_due_reminders(client, babu):
    bad = _task("task-dates", "TSK-9302", "emp-mahesh", startDate=(date.today() + timedelta(days=5)).isoformat())
    assert client.put(f"{TASKS}/task-dates", headers=babu, json={"data": bad}).status_code == 422
    late = _task("task-late", "TSK-9303", "emp-mahesh", due=(date.today() - timedelta(days=3)).isoformat())
    assert client.put(f"{TASKS}/task-late", headers=babu, json={"data": late}).status_code == 200
    with SessionLocal() as db:
        sent = send_task_reminders(db, date.today(), jobs._send)
        db.commit()
        assert sent >= 1
        assert db.scalar(select(ReminderLog.id).where(ReminderLog.item_key == "task:task-late"))
        # Once a day only.
        assert send_task_reminders(db, date.today(), jobs._send) == 0
        assert db.get(SharedTask, "task-late") is not None
    assert "Task overdue · TSK-9303" in _titles("emp-mahesh")


# ---------- projects ----------
def test_project_members_allocation_and_permissions(client, babu, ram, farhan):
    add = {"employee_id": "demo-recruiter", "role": "member", "title": "Recruiting partner", "allocation_pct": 50}
    assert client.post(f"{P}/p-north/members", headers=babu, json=add).status_code == 403
    res = client.post(f"{P}/p-north/members", headers=ram, json=add)
    assert res.status_code == 201, res.text
    m = next(x for x in res.json()["members"] if x["employee_id"] == "demo-recruiter")
    assert m["allocation_pct"] == 50
    assert client.post(f"{P}/p-north/members", headers=ram, json=add).status_code == 409
    # Over 100% across active projects is refused.
    res = client.post(f"{P}/p-maple/members", headers=farhan, json={**add, "allocation_pct": 60})
    assert res.status_code == 422 and "50%" in res.json()["detail"]
    # Editing the same membership doesn't count itself.
    res = client.put(f"{P}/p-north/members/demo-recruiter", headers=ram, json={"title": "Recruiter", "allocation_pct": 100})
    assert res.status_code == 200
    # A task for the new member, then removing them unassigns it.
    res = client.post(f"{P}/p-north/tasks", headers=ram, json={"title": "Plan hiring for Q1", "assignee_id": "demo-recruiter",
                                                               "priority": "urgent", "estimate_hours": 4})
    task = next(t for t in res.json()["tasks"] if t["title"] == "Plan hiring for Q1")
    assert task["priority"] == "urgent"
    assert client.delete(f"{P}/p-north/members/emp-ram", headers=ram).status_code == 422  # the manager stays
    res = client.delete(f"{P}/p-north/members/demo-recruiter", headers=ram)
    assert res.status_code == 200
    assert all(x["employee_id"] != "demo-recruiter" for x in res.json()["members"])
    assert next(t for t in res.json()["tasks"] if t["id"] == task["id"])["assignee_id"] is None
    assert "Removed from Northwind Billing" in _titles("demo-recruiter") or any(
        "Removed from" in t for t in _titles("demo-recruiter"))


def test_project_status_health_progress_and_report(client, babu, ram):
    res = client.put(f"{P}/p-north", headers=ram, json={"status": "on_hold", "health": "at_risk", "client": "Northwind Ltd"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["status"] == "on_hold" and body["health"] == "at_risk" and body["client"] == "Northwind Ltd"
    assert body["active"] is True and 0 <= body["progress_pct"] <= 100
    for m in body["milestones"]:
        assert 0 <= m["progress_pct"] <= 100 and m["done_count"] <= m["task_count"]
        if m["completed_on"]:
            assert m["progress_pct"] == 100
    assert client.put(f"{P}/p-north", headers=babu, json={"health": "on_track"}).status_code == 403
    res = client.put(f"{P}/p-north", headers=ram, json={"status": "active", "health": None})
    assert res.json()["status"] == "active" and res.json()["health"] is None

    full = client.get(f"{P}/p-north/report", headers=ram).json()
    assert full["full_team"] is True and full["weeks"] and full["tasks"]["total"] > 0
    assert full["logged_hours"] == round(sum(w["hours"] for w in full["weeks"]), 2)
    assert full["weeks"][-1]["cumulative_hours"] == full["logged_hours"]
    if full["budget_hours"]:
        assert full["weeks"][-1]["remaining_budget"] == round(full["budget_hours"] - full["logged_hours"], 2)
    mine = client.get(f"{P}/p-north/report", headers=babu).json()
    assert mine["full_team"] is False and {m["employee_id"] for m in mine["members"]} <= {"emp-mahesh"}
    assert mine["logged_hours"] == full["logged_hours"]
    csv = client.get(f"{P}/p-north/report.csv", headers=ram)
    assert csv.status_code == 200 and csv.headers["content-type"].startswith("text/csv")
    assert "attachment" in csv.headers["content-disposition"] and "Week starting" in csv.text
    sophie = _token("demo-recruiter", "recruiter")
    assert client.get(f"{P}/p-north/report", headers=sophie).status_code == 404
