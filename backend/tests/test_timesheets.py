from datetime import date

from sqlalchemy import select

from app.db import SessionLocal
from app.models import AuditLog, LeaveRequest
from tests.conftest import login

E = "/api/v1/timesheets/entries"


def _add(client, headers, day: str, hours: float, project: str = "prj-hrms", **extra):
    return client.post(E, headers=headers, json={"work_date": day, "project_id": project, "task": "Build", "hours": hours} | extra)


def test_projects_seeded_for_members(client, babu):
    codes = {p["code"] for p in client.get("/api/v1/timesheets/projects", headers=babu).json()}
    assert codes == {"TZ-INT", "TZ-HRMS", "ACME-PORTAL", "GLOBEX-MIG", "MAPLE-PORTAL", "NW-BILLING"}
    sophie = login(client, "sophie.clark@timez.com")
    assert {p["code"] for p in client.get("/api/v1/timesheets/projects", headers=sophie).json()} == {"TZ-INT", "GLOBEX-MIG"}


def test_entry_crud_and_validation(client, babu, ram):
    res = _add(client, babu, "2026-02-02", 8)
    assert res.status_code == 201, res.text
    entry = res.json()
    assert entry["billable"] is False  # TZ-HRMS is internal
    assert _add(client, babu, "2026-02-02", 1, "prj-acme").json()["billable"] is True
    assert _add(client, babu, "2026-02-02", 0.3).status_code == 422  # quarter hours only
    assert _add(client, babu, "2026-02-02", 25).status_code == 422
    assert _add(client, babu, "2026-02-02", 0).status_code == 422
    assert _add(client, babu, "2026-02-02", 2, "prj-nope").status_code == 422
    sophie = login(client, "sophie.clark@timez.com")
    assert _add(client, sophie, "2026-02-02", 2, "prj-acme").status_code == 422  # not a member

    res = client.put(f"{E}/{entry['id']}", headers=babu, json={"work_date": "2026-02-03", "project_id": "prj-acme",
                     "task": "Review", "hours": 7.75, "billable": False, "comment": "internal review"})
    assert res.status_code == 200 and res.json()["hours"] == 7.75 and res.json()["billable"] is False
    assert client.put(f"{E}/{entry['id']}", headers=ram, json={"work_date": "2026-02-03", "project_id": "prj-acme",
                      "task": "x", "hours": 1}).status_code == 404
    assert client.delete(f"{E}/{entry['id']}", headers=ram).status_code == 404
    assert client.delete(f"{E}/{entry['id']}", headers=babu).status_code == 204
    listed = client.get(E, headers=babu, params={"from": "2026-02-02", "to": "2026-02-08"}).json()
    assert entry["id"] not in {e["id"] for e in listed} and len(listed) == 1
    assert client.get(E, headers=ram, params={"employee_id": "emp-mahesh", "from": "2026-02-02"}).status_code == 200
    assert client.get(E, headers=sophie, params={"employee_id": "emp-mahesh"}).status_code == 404
    with SessionLocal() as db:
        actions = list(db.scalars(select(AuditLog.action).where(AuditLog.entity_id == entry["id"]).order_by(AuditLog.id)))
        assert actions == ["timesheet_entry_added", "timesheet_entry_updated", "timesheet_entry_deleted"]


def test_submit_validation_day_limit_and_leave(client, babu):
    # more than 24 h on one day
    a = _add(client, babu, "2026-02-10", 20).json()
    _add(client, babu, "2026-02-10", 8, "prj-acme")
    res = client.post("/api/v1/timesheets/weeks/2026-02-09/submit", headers=babu)
    assert res.status_code == 422 and "24 h" in res.json()["detail"]
    client.delete(f"{E}/{a['id']}", headers=babu)
    assert client.post("/api/v1/timesheets/weeks/2026-02-10/submit", headers=babu).status_code == 422  # not a Monday
    assert client.post("/api/v1/timesheets/weeks/2025-02-10/submit", headers=babu).status_code == 422  # nothing logged

    # approved full-day leave (seed: PTO 16-18 March 2026)
    full = _add(client, babu, "2026-03-17", 2).json()
    res = client.post("/api/v1/timesheets/weeks/2026-03-16/submit", headers=babu)
    assert res.status_code == 422 and "leave" in res.json()["detail"]
    client.delete(f"{E}/{full['id']}", headers=babu)

    # approved half-day leave: at most 4.5 h
    with SessionLocal() as db:
        db.add(LeaveRequest(id="lv-test-half", employee_id="emp-mahesh", leave_code="casual", from_date=date(2026, 3, 20),
                            to_date=date(2026, 3, 20), half="first", days=0.5, reason="test", status="approved"))
        db.commit()
    half = _add(client, babu, "2026-03-20", 5).json()
    res = client.post("/api/v1/timesheets/weeks/2026-03-16/submit", headers=babu)
    assert res.status_code == 422 and "half-day" in res.json()["detail"]
    client.put(f"{E}/{half['id']}", headers=babu, json={"work_date": "2026-03-20", "project_id": "prj-hrms", "task": "Build", "hours": 4.5})
    res = client.post("/api/v1/timesheets/weeks/2026-03-16/submit", headers=babu)
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "submitted" and res.json()["total_hours"] == 4.5
    # a submitted week is locked
    assert _add(client, babu, "2026-03-19", 1).status_code == 409
    assert client.delete(f"{E}/{half['id']}", headers=babu).status_code == 409


def test_decision_permissions_reject_resubmit_hr_approve(client, babu, ram, farhan):
    _add(client, babu, "2026-02-16", 8)
    week = client.post("/api/v1/timesheets/weeks/2026-02-16/submit", headers=babu).json()
    url = f"/api/v1/timesheets/weeks/{week['id']}/decision"
    assert week["id"] in {w["id"] for w in client.get("/api/v1/timesheets/weeks", headers=ram, params={"view": "team"}).json()}
    assert week["id"] in {w["id"] for w in client.get("/api/v1/timesheets/weeks", headers=babu).json()}
    assert client.get("/api/v1/timesheets/weeks", headers=babu, params={"view": "team"}).json() == []

    assert client.post(url, headers=babu, json={"decision": "approve"}).status_code == 403  # never self
    sophie = login(client, "sophie.clark@timez.com")
    assert client.post(url, headers=sophie, json={"decision": "approve"}).status_code == 404  # out of scope
    assert client.post(url, headers=ram, json={"decision": "reject"}).status_code == 422  # note needed
    res = client.post(url, headers=ram, json={"decision": "reject", "note": "Split the 8 h by task"})
    assert res.status_code == 200 and res.json()["status"] == "rejected"
    assert any(n["title"] == "Timesheet rejected" for n in client.get("/api/v1/notifications", headers=babu).json())

    # rejected weeks can be edited and resubmitted; HR can approve
    assert _add(client, babu, "2026-02-17", 1).status_code == 201
    assert client.post("/api/v1/timesheets/weeks/2026-02-16/submit", headers=babu).json()["status"] == "submitted"
    res = client.post(url, headers=farhan, json={"decision": "approve"})
    assert res.status_code == 200 and res.json()["status"] == "approved" and res.json()["decided_by"] == "demo-hr-admin"
    assert client.post(url, headers=ram, json={"decision": "approve"}).status_code == 409
    assert _add(client, babu, "2026-02-18", 1).status_code == 409
    with SessionLocal() as db:
        actions = list(db.scalars(select(AuditLog.action).where(AuditLog.entity_id == week["id"]).order_by(AuditLog.id)))
        assert actions == ["timesheet_submitted", "timesheet_rejected", "timesheet_submitted", "timesheet_approved"]


def test_no_manager_week_auto_approved(client):
    jordan = login(client, "jordan.blake@timez.com")
    assert _add(client, jordan, "2026-02-23", 3, "prj-internal").status_code == 201
    assert client.post("/api/v1/timesheets/weeks/2026-02-23/submit", headers=jordan).json()["status"] == "approved"


def test_utilization_is_scoped(client, babu, ram):
    params = {"from": "2026-01-12", "to": "2026-01-18"}
    _add(client, babu, "2026-01-12", 6, "prj-acme")
    _add(client, babu, "2026-01-13", 2, "prj-internal")
    _add(client, ram, "2026-01-12", 4, "prj-globex")
    mine = client.get("/api/v1/timesheets/utilization", headers=babu, params=params).json()
    assert [p["id"] for p in mine["people"]] == ["emp-mahesh"]
    assert mine["total_hours"] == 8 and mine["billable_hours"] == 6 and mine["billable_pct"] == 75.0
    team = client.get("/api/v1/timesheets/utilization", headers=ram, params=params).json()
    assert {p["id"] for p in team["people"]} == {"emp-mahesh", "emp-ram"}
    assert team["total_hours"] == 12 and team["billable_pct"] == round(100 * 10 / 12, 1)
    assert {p["name"] for p in team["projects"]} >= {"ACME-PORTAL - Acme customer portal", "GLOBEX-MIG - Globex cloud migration"}
    only_babu = client.get("/api/v1/timesheets/utilization", headers=ram, params=params | {"employee_id": "emp-mahesh"}).json()
    assert only_babu["total_hours"] == 8
    assert client.get("/api/v1/timesheets/utilization", headers=babu, params=params | {"employee_id": "emp-ram"}).status_code == 404
