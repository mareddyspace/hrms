"""Chat, mail, tasks, announcements and calendar shared through the backend (migration 0022)."""

from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import select

from app.db import SessionLocal
from app.models import AuditLog, ChatConversation, Notification
from app.security import create_access_token
from app.services.sharing import seed_samples


def _token(account_id: str, role: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(account_id, role)[0]}"}


def _notes(person: str, href_start: str) -> list[Notification]:
    with SessionLocal() as db:
        return list(db.scalars(select(Notification).where(Notification.recipient_id == person,
                                                          Notification.href.like(f"{href_start}%"))))


def test_seed_is_idempotent():
    with SessionLocal() as db:
        assert seed_samples(db) == 0
        assert db.get(ChatConversation, "cv-hr-1").restricted == "hr_confidential"


# ---------- chat ----------

def test_chat_between_two_sign_ins(client, babu, ram):
    res = client.post("/api/v1/chat/conversations", headers=ram, json={"kind": "direct", "member_ids": ["emp-mahesh"]})
    assert res.status_code == 201, res.text
    cid = res.json()["id"]
    assert cid == "cv-1"  # the existing direct chat is reused
    res = client.post(f"/api/v1/chat/conversations/{cid}/messages", headers=ram, json={"text": "Lunch at 1?"})
    assert res.status_code == 201
    sent = res.json()["messages"][-1]
    assert sent["read_by"] == ["emp-ram"]
    assert any(n.title == "Message from Ram Krishnan" for n in _notes("emp-mahesh", f"/chat?c={cid}"))

    convs = {c["id"]: c for c in client.get("/api/v1/chat/conversations", headers=babu).json()}
    assert "cv-hr-1" not in convs
    assert convs[cid]["messages"][-1]["text"] == "Lunch at 1?"
    client.post(f"/api/v1/chat/conversations/{cid}/read", headers=babu)
    res = client.post(f"/api/v1/chat/conversations/{cid}/messages", headers=babu, json={"text": "Sure."})
    msgs = res.json()["messages"]
    assert "emp-mahesh" in msgs[-2]["read_by"]
    ram_view = next(c for c in client.get("/api/v1/chat/conversations", headers=ram).json() if c["id"] == cid)
    assert ram_view["messages"][-1]["text"] == "Sure."
    # A second message in the same thread updates one bell item instead of adding another.
    client.post(f"/api/v1/chat/conversations/{cid}/messages", headers=babu, json={"text": "See you there."})
    assert len([n for n in _notes("emp-ram", f"/chat?c={cid}") if n.read_at is None]) == 1


def test_group_and_restricted_threads(client, babu, ram, farhan):
    res = client.post("/api/v1/chat/conversations", headers=ram,
                      json={"kind": "group", "title": "Release crew", "member_ids": ["emp-mahesh", "emp-priya"]})
    assert res.status_code == 201
    group = res.json()
    assert set(group["participant_ids"]) == {"emp-ram", "emp-mahesh", "emp-priya"}
    assert group["id"] in {c["id"] for c in client.get("/api/v1/chat/conversations", headers=babu).json()}

    # Confidential threads must include HR; HR sees them even without being a member.
    bad = client.post("/api/v1/chat/conversations", headers=babu,
                      json={"kind": "direct", "member_ids": ["emp-ram"], "restricted": "hr_confidential"})
    assert bad.status_code == 403
    res = client.post("/api/v1/chat/conversations", headers=babu,
                      json={"kind": "direct", "member_ids": ["demo-hr-admin"], "restricted": "hr_confidential"})
    assert res.status_code == 201
    hr_ids = {c["id"] for c in client.get("/api/v1/chat/conversations", headers=farhan).json()}
    assert {"cv-hr-1", res.json()["id"]} <= hr_ids
    assert client.get("/api/v1/chat/conversations", headers=ram).json() and \
        "cv-hr-1" not in {c["id"] for c in client.get("/api/v1/chat/conversations", headers=ram).json()}
    assert client.post("/api/v1/chat/conversations/cv-hr-1/messages", headers=ram, json={"text": "hi"}).status_code == 404
    with SessionLocal() as db:
        assert db.scalar(select(AuditLog).where(AuditLog.action == "chat.restricted_thread")) is not None


# ---------- mail ----------

def test_mail_send_read_and_reply(client, babu, ram):
    res = client.post("/api/v1/mail", headers=ram, json={"to_ids": ["emp-mahesh"], "cc_ids": ["demo-hr-admin"],
                                                          "subject": "Release checklist", "body": "Please update it.",
                                                          "category": "General"})
    assert res.status_code == 201, res.text
    mail = res.json()
    assert mail["to_ids"] == ["emp-mahesh"] and mail["cc_ids"] == ["demo-hr-admin"]
    thread = mail["thread_id"]
    assert any(n.title == "New mail from Ram Krishnan" for n in _notes("emp-mahesh", f"/mail?thread={thread}"))
    inbox = [m for m in client.get("/api/v1/mail", headers=babu).json() if m["thread_id"] == thread]
    assert inbox and "emp-mahesh" not in inbox[0]["read_by"]
    assert client.post(f"/api/v1/mail/threads/{thread}/read", headers=babu).json()["marked"] == 1
    res = client.post("/api/v1/mail", headers=babu, json={"to_ids": ["emp-ram"], "subject": "Re: Release checklist",
                                                           "body": "Done.", "thread_id": thread})
    assert res.status_code == 201
    ram_thread = [m for m in client.get("/api/v1/mail", headers=ram).json() if m["thread_id"] == thread]
    assert [m["body"] for m in ram_thread] == ["Please update it.", "Done."]
    assert "emp-mahesh" in ram_thread[0]["read_by"]
    # Someone outside the thread can neither read nor reply into it.
    sophie = _token("demo-recruiter", "recruiter")
    assert thread not in {m["thread_id"] for m in client.get("/api/v1/mail", headers=sophie).json()}
    assert client.post("/api/v1/mail", headers=sophie, json={"to_ids": ["emp-ram"], "subject": "x", "body": "y",
                                                              "thread_id": thread}).status_code == 404


# ---------- tasks ----------

def _task(tid: str, assignee: str, **extra):  # type: ignore[no-untyped-def]
    data = {"id": tid, "code": "TSK-9001", "employeeId": assignee, "subject": "Write the release notes",
            "priority": "high", "status": "open", "due": (date.today() + timedelta(days=3)).isoformat(),
            "accepted": False, "comments": [], "activity": [{"id": "a1", "action": "Assigned", "actor": "Ram"}]}
    data.update(extra)
    return data


def test_manager_assigns_and_report_accepts(client, babu, ram):
    tid = "task-test-1"
    assert client.put(f"/api/v1/tasks/{tid}", headers=babu, json={"data": _task(tid, "emp-ram")}).status_code == 403
    res = client.put(f"/api/v1/tasks/{tid}", headers=ram, json={"data": _task(tid, "emp-mahesh")})
    assert res.status_code == 200, res.text
    assert res.json()["version"] == 1
    assert any(n.title == "Task assigned: TSK-9001" for n in _notes("emp-mahesh", f"/tasks?task={tid}"))

    seen = next(t for t in client.get("/api/v1/tasks", headers=babu).json() if t["id"] == tid)
    data = dict(seen["data"], accepted=True, activity=[*seen["data"]["activity"], {"id": "a2", "action": "Accepted"}])
    res = client.put(f"/api/v1/tasks/{tid}", headers=babu, json={"data": data, "base_version": 1})
    assert res.status_code == 200 and res.json()["version"] == 2
    assert any("accepted" in n.title for n in _notes("emp-ram", f"/tasks?task={tid}"))
    # A stale copy is refused.
    assert client.put(f"/api/v1/tasks/{tid}", headers=ram, json={"data": data, "base_version": 1}).status_code == 409

    data = dict(data, status="progress", comments=[{"id": "c1", "author": "Babu", "text": "Half done", "at": "x"}])
    client.put(f"/api/v1/tasks/{tid}", headers=babu, json={"data": data, "base_version": 2})
    ram_copy = next(t for t in client.get("/api/v1/tasks", headers=ram).json() if t["id"] == tid)
    assert ram_copy["data"]["status"] == "progress" and ram_copy["data"]["comments"][0]["text"] == "Half done"
    # Someone outside the reporting line doesn't see it.
    sophie = _token("demo-recruiter", "recruiter")
    assert tid not in {t["id"] for t in client.get("/api/v1/tasks", headers=sophie).json()}
    assert client.put(f"/api/v1/tasks/{tid}", headers=sophie, json={"data": data}).status_code == 404
    with SessionLocal() as db:
        assert db.scalar(select(AuditLog).where(AuditLog.action == "task.create", AuditLog.entity_id == tid))


def test_seeded_tasks_visible_to_both(client, babu, ram):
    assert "task-srv-2" in {t["id"] for t in client.get("/api/v1/tasks", headers=babu).json()}
    assert "task-srv-2" in {t["id"] for t in client.get("/api/v1/tasks", headers=ram).json()}


# ---------- announcements ----------

def test_announcements_publish_acknowledge_and_receipts(client, babu, ram, farhan):
    titles = {a["title"] for a in client.get("/api/v1/announcements", headers=babu).json()}
    assert {"Q4 All-hands", "India Dussehra holiday calendar", "Engineering on-call rotation update"} <= titles

    assert client.post("/api/v1/announcements", headers=babu, json={
        "title": "Hello all", "body": "x", "scope": "Company", "state": "Published"}).status_code == 403
    assert client.post("/api/v1/announcements", headers=ram, json={
        "title": "Company news", "body": "x", "scope": "Company", "state": "Published"}).status_code == 403
    res = client.post("/api/v1/announcements", headers=ram, json={
        "title": "Team offsite", "body": "Friday at 4.", "scope": "Team", "state": "Published"})
    assert res.status_code == 201, res.text
    assert res.json()["id"] in {a["id"] for a in client.get("/api/v1/announcements", headers=babu).json()}

    res = client.post("/api/v1/announcements", headers=farhan, json={
        "title": "Security training", "body": "Finish the module.", "scope": "Department", "audience": "Engineering",
        "state": "Published", "must_acknowledge": True})
    assert res.status_code == 201
    aid = res.json()["id"]
    assert any(n.title == "Please acknowledge: Security training" for n in _notes("emp-mahesh", f"/announcements?id={aid}"))
    res = client.post(f"/api/v1/announcements/{aid}/acknowledge", headers=babu)
    assert res.status_code == 200 and res.json()["acknowledged"] is True
    assert client.get(f"/api/v1/announcements/{aid}/receipts", headers=babu).status_code == 403
    receipts = {r["person_id"]: r for r in client.get(f"/api/v1/announcements/{aid}/receipts", headers=farhan).json()}
    assert receipts["emp-mahesh"]["acknowledged_at"] and receipts["emp-ram"]["acknowledged_at"] is None
    hr_row = next(a for a in client.get("/api/v1/announcements", headers=farhan).json() if a["id"] == aid)
    assert hr_row["ack_count"] == 1 and hr_row["audience_count"] >= 2

    # A draft stays with whoever manages it until published.
    res = client.post("/api/v1/announcements", headers=farhan, json={
        "title": "Draft benefits note", "body": "Soon.", "scope": "Company", "state": "Draft"})
    did = res.json()["id"]
    assert did not in {a["id"] for a in client.get("/api/v1/announcements", headers=babu).json()}
    client.post(f"/api/v1/announcements/{did}/state", headers=farhan, json={"state": "Published"})
    assert did in {a["id"] for a in client.get("/api/v1/announcements", headers=babu).json()}


# ---------- calendar ----------

def test_meeting_invite_respond_and_cancel(client, babu, ram):
    day = (date.today() + timedelta(days=2)).isoformat()
    bad = client.post("/api/v1/calendar/events", headers=ram, json={"kind": "meeting", "title": "1:1", "date": day,
                                                                     "time": "10:00", "attendee_ids": []})
    assert bad.status_code == 422
    res = client.post("/api/v1/calendar/events", headers=ram, json={
        "kind": "meeting", "title": "Design review", "date": day, "time": "11:30", "attendee_ids": ["emp-mahesh"]})
    assert res.status_code == 201, res.text
    eid = res.json()["id"]
    assert any(n.title == "Meeting invite: Design review" for n in _notes("emp-mahesh", "/calendar"))
    assert eid in {e["id"] for e in client.get("/api/v1/calendar/events", headers=babu).json()}
    res = client.post(f"/api/v1/calendar/events/{eid}/respond", headers=babu, json={"response": "accepted"})
    assert res.json()["attendees"][0]["response"] == "accepted"
    assert client.delete(f"/api/v1/calendar/events/{eid}", headers=babu).status_code == 403
    reminder = client.post("/api/v1/calendar/events", headers=babu, json={"kind": "reminder", "title": "Pay bill",
                                                                          "date": day})
    assert reminder.status_code == 201
    assert reminder.json()["id"] not in {e["id"] for e in client.get("/api/v1/calendar/events", headers=ram).json()}
    assert client.delete(f"/api/v1/calendar/events/{eid}", headers=ram).status_code == 204
    assert eid not in {e["id"] for e in client.get("/api/v1/calendar/events", headers=babu).json()}
