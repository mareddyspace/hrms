"""Migration 0025: project details (members see, managers edit), timesheet blocks with start / end / break and no
overlaps, and comp-off credits for working a rostered weekly off."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from app.db import SessionLocal
from app.models import RosterShift, RosterWeek
from tests.conftest import login

P = "/api/v1/projects"
E = "/api/v1/timesheets/entries"
SH = "/api/v1/shifts"


# ---------- projects ----------
def test_projects_seeded_with_details(client, babu):
    rows = client.get(P, headers=babu).json()
    ids = {p["id"] for p in rows}
    assert {"prj-internal", "prj-hrms", "prj-acme", "prj-globex", "p-maple", "p-north"} <= ids
    north = next(p for p in rows if p["id"] == "p-north")
    assert north["manager_id"] == "emp-ram" and north["budget_hours"] == 2400
    assert north["my_title"] == "Frontend developer" and north["my_budget_hours"] == 320
    assert len(north["milestones"]) == 5 and any(m["completed_on"] for m in north["milestones"])
    assert any(t["code"] == "NW-412" and t["assignee_id"] == "emp-mahesh" for t in north["tasks"])
    assert north["can_edit"] is False
    detail = client.get(f"{P}/p-north", headers=babu).json()
    assert detail["activity"] and detail["posts"][0]["kind"] == "update"


def test_project_visibility_and_edit_rights(client, babu, ram):
    sophie = login(client, "sophie.clark@timez.com")  # not on Northwind
    assert client.get(f"{P}/p-north", headers=sophie).status_code == 404
    body = {"name": "UAT sign-off", "due_date": "2026-12-01", "description": "Client tests the release."}
    assert client.post(f"{P}/p-north/milestones", headers=babu, json=body).status_code == 403
    res = client.post(f"{P}/p-north/milestones", headers=ram, json=body)
    assert res.status_code == 201, res.text
    ms = next(m for m in res.json()["milestones"] if m["name"] == "UAT sign-off")
    res = client.put(f"{P}/p-north/milestones/{ms['id']}", headers=ram, json={**body, "completed": True})
    assert next(m for m in res.json()["milestones"] if m["id"] == ms["id"])["completed_on"]
    notes = client.get("/api/v1/notifications", headers=babu).json()
    items = notes["items"] if isinstance(notes, dict) else notes
    assert any("milestone" in n["title"].lower() for n in items)
    # Status updates are the manager's; comments are anyone's.
    assert client.post(f"{P}/p-north/posts", headers=babu, json={"kind": "update", "body": "x"}).status_code == 403
    res = client.post(f"{P}/p-north/posts", headers=babu, json={"kind": "comment", "body": "Export is ready for review."})
    assert res.status_code == 201 and res.json()["posts"][0]["body"] == "Export is ready for review."


def test_task_status_by_assignee_only(client, babu, ram):
    detail = client.get(f"{P}/p-north", headers=babu).json()
    mine = next(t for t in detail["tasks"] if t["code"] == "NW-418")
    res = client.post(f"{P}/p-north/tasks/{mine['id']}/status", headers=babu, json={"status": "in_progress"})
    assert res.status_code == 200
    assert next(t for t in res.json()["tasks"] if t["id"] == mine["id"])["status"] == "in_progress"
    ram_task = next(t for t in detail["tasks"] if t["code"] == "NW-420")
    assert client.post(f"{P}/p-north/tasks/{ram_task['id']}/status", headers=babu, json={"status": "done"}).status_code == 403
    # Babu can't edit task details; Ram can.
    edit = {"title": "Payment status timeline", "estimate_hours": 9, "status": "in_progress", "assignee_id": "emp-mahesh"}
    assert client.put(f"{P}/p-north/tasks/{mine['id']}", headers=babu, json=edit).status_code == 403
    assert client.put(f"{P}/p-north/tasks/{mine['id']}", headers=ram, json=edit).status_code == 200


def test_project_link_document(client, babu):
    res = client.post(f"{P}/p-maple/documents/link", headers=babu, json={"title": "Design", "url": "https://example.com/d"})
    assert res.status_code == 201
    doc = next(d for d in res.json()["documents"] if d["title"] == "Design")
    assert client.delete(f"{P}/p-maple/documents/{doc['id']}", headers=babu).status_code == 200


# ---------- timesheet blocks ----------
def test_entry_times_break_and_overlap(client, babu):
    day = "2026-02-10"
    base = {"work_date": day, "project_id": "prj-hrms", "task": "Roster grid"}
    res = client.post(E, headers=babu, json={**base, "start_minute": 9 * 60, "end_minute": 13 * 60, "break_minutes": 30,
                                             "work_type": "project"})
    assert res.status_code == 201, res.text
    first = res.json()
    assert first["hours"] == 3.5 and first["start_minute"] == 540 and first["break_minutes"] == 30
    clash = client.post(E, headers=babu, json={**base, "start_minute": 12 * 60, "end_minute": 14 * 60})
    assert clash.status_code == 409 and "overlaps" in clash.json()["detail"]
    ok = client.post(E, headers=babu, json={**base, "start_minute": 13 * 60, "end_minute": 15 * 60})
    assert ok.status_code == 201 and ok.json()["hours"] == 2
    # Editing a block into another one is refused too; editing it in place is fine.
    moved = client.put(f"{E}/{ok.json()['id']}", headers=babu, json={**base, "start_minute": 10 * 60, "end_minute": 11 * 60})
    assert moved.status_code == 409
    same = client.put(f"{E}/{first['id']}", headers=babu, json={**base, "start_minute": 9 * 60, "end_minute": 13 * 60})
    assert same.status_code == 200 and same.json()["hours"] == 4
    bad = client.post(E, headers=babu, json={**base, "start_minute": 16 * 60, "end_minute": 16 * 60 + 30, "break_minutes": 30})
    assert bad.status_code == 422


# ---------- comp-off ----------
def _past_saturday() -> date:
    today = date.today()
    return today - timedelta(days=(today.weekday() - 5) % 7 or 7)


def test_comp_off_grant_and_balance(client, babu, ram):
    sat = _past_saturday()
    week_start = sat - timedelta(days=sat.weekday())
    with SessionLocal() as db:
        if db.get(RosterShift, f"rs-test-{sat}") is None:
            db.query(RosterShift).filter(RosterShift.employee_id == "emp-mahesh", RosterShift.work_date == sat).delete()
            db.add(RosterShift(id=f"rs-test-{sat}", employee_id="emp-mahesh", work_date=sat, shift_id="sh-weekend",
                               manager_id="emp-ram"))
        week = db.query(RosterWeek).filter(RosterWeek.manager_id == "emp-ram", RosterWeek.week_start == week_start).first()
        if week is None:
            db.add(RosterWeek(manager_id="emp-ram", week_start=week_start, status="published",
                              published_at=datetime.now(timezone.utc), published_by="emp-ram"))
        else:
            week.status = "published"
        db.commit()
    before = client.get(f"{SH}/comp-off", headers=babu).json()
    team = client.get(f"{SH}/comp-off", headers=ram).json()
    assert any(c["employee_id"] == "emp-mahesh" and c["work_date"] == sat.isoformat() for c in team["candidates"])
    body = {"employee_id": "emp-mahesh", "work_date": sat.isoformat()}
    assert client.post(f"{SH}/comp-off/grant", headers=babu, json=body).status_code == 403
    res = client.post(f"{SH}/comp-off/grant", headers=ram, json=body)
    assert res.status_code == 201, res.text
    assert client.post(f"{SH}/comp-off/grant", headers=ram, json=body).status_code == 409
    after = client.get(f"{SH}/comp-off", headers=babu).json()
    assert after["available"] == before["available"] + 1
    assert any(c["worked_date"] == sat.isoformat() for c in after["credits"])
