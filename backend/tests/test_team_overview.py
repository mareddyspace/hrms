"""Team overview (GET /team/today) and approval reminders (POST /approvals/remind)."""

from __future__ import annotations

from sqlalchemy import select

from app.db import SessionLocal
from app.models import AuditLog, Notification


def _me(client, headers) -> dict:
    return client.get("/api/v1/auth/me", headers=headers).json()


def test_team_today_lists_reporting_line(client, ram, babu):
    babu_id = _me(client, babu)["employee_id"]
    rows = client.get("/api/v1/team/today", headers=ram)
    assert rows.status_code == 200, rows.text
    by_id = {r["employee_id"]: r for r in rows.json()}
    assert babu_id in by_id
    row = by_id[babu_id]
    assert row["direct"] is True
    assert row["timesheet_status"] in {"draft", "submitted", "approved", "rejected", "reopened"}
    assert isinstance(row["leave_left"], list)
    assert all({"code", "name", "available"} <= set(b) for b in row["leave_left"])
    # Someone with no reports sees nobody.
    assert client.get("/api/v1/team/today", headers=babu).json() == []


def test_remind_approver_once_a_day(client, ram, babu):
    babu_id = _me(client, babu)["employee_id"]
    ram_id = _me(client, ram)["employee_id"]
    body = {"approver_id": ram_id, "requester_id": babu_id, "kind": "Leave", "summary": "Casual leave · 3 Nov",
            "request_id": "lv-test-remind"}
    res = client.post("/api/v1/approvals/remind", headers=babu, json=body)
    assert res.status_code == 200, res.text
    assert res.json()["sent_to"] == ram_id
    with SessionLocal() as db:
        note = db.scalar(select(Notification).where(Notification.recipient_id == ram_id,
                                                    Notification.title.like("Reminder: Leave from%")))
        assert note is not None and note.href == "/approvals"
        assert db.scalar(select(AuditLog).where(AuditLog.action == "approval_reminder_sent",
                                                AuditLog.entity_id == "lv-test-remind")) is not None
    again = client.post("/api/v1/approvals/remind", headers=babu, json=body)
    assert again.status_code == 429


def test_remind_rules(client, ram, babu, farhan):
    babu_id = _me(client, babu)["employee_id"]
    ram_id = _me(client, ram)["employee_id"]
    farhan_id = _me(client, farhan)["employee_id"]
    url = "/api/v1/approvals/remind"
    # Can't remind yourself.
    assert client.post(url, headers=ram, json={"approver_id": ram_id, "requester_id": babu_id, "kind": "Leave"}).status_code == 422
    # Babu can't chase requests of people he has nothing to do with.
    assert client.post(url, headers=babu, json={"approver_id": ram_id, "requester_id": farhan_id, "kind": "Leave"}).status_code == 403
    # Someone who neither manages the requester nor decides steps isn't an approver.
    res = client.post(url, headers=farhan, json={"approver_id": babu_id, "requester_id": ram_id, "kind": "Expense"})
    assert res.status_code == 422
    # HR steps can be reminded (Farhan is HR).
    res = client.post(url, headers=babu, json={"approver_id": farhan_id, "requester_id": babu_id, "kind": "Expense claim"})
    assert res.status_code == 200, res.text
    # Unknown people.
    assert client.post(url, headers=babu, json={"approver_id": "nobody", "requester_id": babu_id, "kind": "Leave"}).status_code == 404
