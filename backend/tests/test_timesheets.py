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

    # approved full-day leave (seed: PTO 16-18 March 2026): no hours can be logged that day
    res = _add(client, babu, "2026-03-17", 2)
    assert res.status_code == 422 and "on leave" in res.json()["detail"]

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
    # a submitted week locks the days it was submitted with (other days are logged day by day)
    assert _add(client, babu, "2026-03-20", 1).status_code == 409
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
    assert _add(client, babu, "2026-02-17", 1).status_code == 409
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


def test_week_detail_for_manager_with_project_names(client, babu, ram):
    _add(client, babu, "2025-09-08", 6)
    _add(client, babu, "2025-09-09", 2, "prj-acme")
    res = client.post("/api/v1/timesheets/weeks/2025-09-08/submit", headers=babu)
    assert res.status_code == 200, res.text
    week = res.json()
    url = f"/api/v1/timesheets/weeks/{week['id']}/detail"
    res = client.get(url, headers=ram)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["week"]["status"] == "submitted" and body["week"]["total_hours"] == 8
    assert sorted((e["work_date"], e["project_code"], e["hours"]) for e in body["entries"]) == [
        ("2025-09-08", "TZ-HRMS", 6.0), ("2025-09-09", "ACME-PORTAL", 2.0)]
    assert client.get(url, headers=babu).status_code == 200
    sophie = login(client, "sophie.clark@timez.com")
    assert client.get(url, headers=sophie).status_code == 404
    client.post(f"/api/v1/timesheets/weeks/{week['id']}/decision", headers=ram, json={"decision": "reject", "note": "Add task names"})
    mine = client.get("/api/v1/timesheets/weeks", headers=babu).json()
    sent_back = next(w for w in mine if w["id"] == week["id"])
    assert sent_back["status"] == "rejected" and sent_back["decision_note"] == "Add task names"


def test_timesheet_today_only(client, babu, ram, monkeypatch):
    from datetime import date, timedelta

    from app.routers import timesheets

    monkeypatch.setattr(timesheets, "TODAY_ONLY", True)
    today = date.today()
    past = today - timedelta(days=1)
    res = _add(client, babu, past.isoformat(), 1)
    assert res.status_code == 422 and "only log time for today" in res.json()["detail"]
    assert _add(client, babu, (today + timedelta(days=1)).isoformat(), 1).status_code == 422
    entry = _add(client, babu, today.isoformat(), 1)
    assert entry.status_code == 201, entry.text
    assert client.delete(f"{E}/{entry.json()['id']}", headers=babu).status_code == 204



D = "/api/v1/timesheets/days"


def test_day_submit_needs_nine_hours(client, babu):
    _add(client, babu, "2025-11-03", 6)
    entry = _add(client, babu, "2025-11-03", 0.5, "prj-acme").json()
    res = client.post(f"{D}/2025-11-03/submit", headers=babu)
    assert res.status_code == 422 and "Log at least 9 h to submit (2.5 h to go)" in res.json()["detail"]
    assert client.post(f"{D}/2025-11-08/submit", headers=babu).status_code == 422  # Saturday, nothing logged
    _add(client, babu, "2025-11-03", 2.5, "prj-acme")
    res = client.post(f"{D}/2025-11-03/submit", headers=babu)
    assert res.status_code == 200, res.text
    day = res.json()
    assert day["status"] == "submitted" and day["total_hours"] == 9 and day["target_hours"] == 9
    assert day["approval"]["current_label"] == "Manager"
    # a submitted day is locked
    assert _add(client, babu, "2025-11-03", 1).status_code == 409
    assert client.delete(f"{E}/{entry['id']}", headers=babu).status_code == 409
    assert client.post(f"{D}/2025-11-03/submit", headers=babu).status_code == 422  # already submitted
    # other days of the week stay open
    assert _add(client, babu, "2025-11-04", 1).status_code == 201
    mine = client.get(D, headers=babu, params={"from": "2025-11-03", "to": "2025-11-09"}).json()
    assert [(d["work_date"], d["status"]) for d in mine] == [("2025-11-03", "submitted")]


def test_day_half_day_leave_minimum(client, babu):
    with SessionLocal() as db:
        db.add(LeaveRequest(id="lv-test-half-day", employee_id="emp-mahesh", leave_code="casual", from_date=date(2025, 11, 12),
                            to_date=date(2025, 11, 12), half="second", days=0.5, reason="test", status="approved"))
        db.commit()
    _add(client, babu, "2025-11-12", 4)
    res = client.post(f"{D}/2025-11-12/submit", headers=babu)
    assert res.status_code == 422 and "Log at least 4.5 h" in res.json()["detail"]
    _add(client, babu, "2025-11-12", 0.5)
    res = client.post(f"{D}/2025-11-12/submit", headers=babu)
    assert res.status_code == 200 and res.json()["target_hours"] == 4.5 and res.json()["day_kind"] == "half-day leave"


def test_day_manager_sees_approves_and_sends_back(client, babu, ram, farhan):
    _add(client, babu, "2025-11-17", 9)
    _add(client, babu, "2025-11-18", 5, "prj-acme")
    _add(client, babu, "2025-11-18", 4)
    first = client.post(f"{D}/2025-11-17/submit", headers=babu).json()
    second = client.post(f"{D}/2025-11-18/submit", headers=babu).json()

    # the manager is notified, then sees both days in the inbox and team view
    notes = client.get("/api/v1/notifications", headers=ram, params={"limit": 100}).json()
    assert any(n["title"] == "Timesheet from Babu Menon" and n["href"].startswith("/timesheets/") for n in notes)
    pending = {p["id"]: p for p in client.get("/api/v1/approvals/pending", headers=ram).json()}
    assert first["id"] in pending and second["id"] in pending
    assert pending[first["id"]]["kind"] == "timesheet_day" and "9 h" in pending[first["id"]]["summary"]
    team = client.get("/api/v1/timesheets/team-days", headers=ram, params={"week_start": "2025-11-17"}).json()
    babu_row = next(p for p in team if p["employee_id"] == "emp-mahesh")
    assert babu_row["week_total"] == 18 and babu_row["projects"]["Acme customer portal"] == 5
    tue = babu_row["days"][1]
    assert tue["status"] == "submitted" and tue["can_decide"] and tue["waiting_on_me"] and tue["total_hours"] == 9
    assert {e["project_code"] for e in tue["entries"]} == {"ACME-PORTAL", "TZ-HRMS"}
    assert client.get("/api/v1/timesheets/team-days", headers=babu).json() == []
    assert client.get(f"{D}/{first['id']}/detail", headers=ram).json()["total_hours"] == 9
    waiting = client.get(D, headers=ram, params={"view": "waiting"}).json()
    assert {first["id"], second["id"]} <= {d["id"] for d in waiting} and all(d["can_decide"] for d in waiting)
    assert client.get(D, headers=babu, params={"view": "waiting"}).json() == []

    # never self; send back needs a comment
    assert client.post(f"{D}/{first['id']}/decision", headers=babu, json={"decision": "approve"}).status_code == 403
    assert client.post(f"{D}/{second['id']}/decision", headers=ram, json={"decision": "reject"}).status_code == 422
    res = client.post(f"{D}/{first['id']}/decision", headers=ram, json={"decision": "approve"})
    assert res.status_code == 200 and res.json()["status"] == "approved" and res.json()["decided_by"] == "emp-ram"
    res = client.post(f"{D}/{second['id']}/decision", headers=ram, json={"decision": "reject", "note": "Split the Acme time"})
    assert res.status_code == 200 and res.json()["status"] == "rejected" and res.json()["decision_note"] == "Split the Acme time"
    assert client.post(f"{D}/{first['id']}/decision", headers=ram, json={"decision": "approve"}).status_code == 409
    assert not {first["id"], second["id"]} & {p["id"] for p in client.get("/api/v1/approvals/pending", headers=ram).json()}
    titles = [n["title"] for n in client.get("/api/v1/notifications", headers=babu).json()]
    assert "Timesheet approved" in titles and "Timesheet sent back" in titles
    # approved day locked; approved hours count in utilization
    assert _add(client, babu, "2025-11-17", 1).status_code == 409
    util = client.get("/api/v1/timesheets/utilization", headers=babu,
                      params={"from": "2025-11-17", "to": "2025-11-17", "approved_only": True}).json()
    assert util["total_hours"] == 9
    with SessionLocal() as db:
        actions = list(db.scalars(select(AuditLog.action).where(AuditLog.entity_id == second["id"]).order_by(AuditLog.id)))
        assert actions == ["timesheet_day_submitted", "timesheet_day_rejected"]


def test_sent_back_day_editable_later(client, babu, ram, monkeypatch):
    from datetime import timedelta

    from app.routers import timesheets

    today = date.today()
    past = today - timedelta(days=1)
    while past.weekday() >= 5:
        past -= timedelta(days=1)
    entry = _add(client, babu, past.isoformat(), 9).json()  # logged on the day (rule off while setting up)
    day = client.post(f"{D}/{past.isoformat()}/submit", headers=babu).json()
    monkeypatch.setattr(timesheets, "TODAY_ONLY", True)
    # submitted: locked
    assert _add(client, babu, past.isoformat(), 1).status_code == 409
    res = client.post(f"{D}/{day['id']}/decision", headers=ram, json={"decision": "reject", "note": "Add the review hour"})
    assert res.status_code == 200
    # sent back: can be corrected and submitted again on a later date
    assert _add(client, babu, past.isoformat(), 1).status_code == 201
    assert client.delete(f"{E}/{entry['id']}", headers=babu).status_code == 204
    assert client.post(f"{D}/{past.isoformat()}/submit", headers=babu).status_code == 422  # only 1 h now
    _add(client, babu, past.isoformat(), 8)
    res = client.post(f"{D}/{past.isoformat()}/submit", headers=babu)
    assert res.status_code == 200 and res.json()["status"] == "submitted" and res.json()["id"] == day["id"]
    # a day that was never sent back stays closed
    other = past - timedelta(days=7)
    assert _add(client, babu, other.isoformat(), 1).status_code == 422
    assert client.post(f"{D}/{other.isoformat()}/submit", headers=babu).status_code == 422


def test_day_without_manager_goes_to_hr(client, farhan):
    jordan = login(client, "jordan.blake@timez.com")
    assert _add(client, jordan, "2025-11-24", 9, "prj-internal").status_code == 201
    day = client.post(f"{D}/2025-11-24/submit", headers=jordan).json()
    assert day["status"] == "submitted"
    assert day["id"] in {p["id"] for p in client.get("/api/v1/approvals/pending", headers=farhan).json()}
    res = client.post(f"{D}/{day['id']}/decision", headers=farhan, json={"decision": "approve"})
    assert res.status_code == 200 and res.json()["status"] == "approved"


def test_old_weekly_submission_still_listed_and_decidable(client, babu, ram):
    """Weeks submitted under the weekly flow keep showing for the manager after the switch to daily timesheets."""
    _add(client, babu, "2025-12-01", 8)
    week = client.post("/api/v1/timesheets/weeks/2025-12-01/submit", headers=babu).json()
    assert week["status"] == "submitted"
    pending = {p["id"]: p for p in client.get("/api/v1/approvals/pending", headers=ram).json()}
    assert pending[week["id"]]["kind"] == "timesheet_week"
    team = client.get("/api/v1/timesheets/weeks", headers=ram, params={"view": "team", "status": "submitted"}).json()
    assert week["id"] in {w["id"] for w in team}
    assert client.get(f"/api/v1/timesheets/weeks/{week['id']}/detail", headers=ram).json()["week"]["total_hours"] == 8
    # the daily lists don't hide or double it
    assert week["id"] not in {d["id"] for d in client.get(D, headers=ram, params={"view": "waiting"}).json()}
    res = client.post(f"/api/v1/timesheets/weeks/{week['id']}/decision", headers=ram, json={"decision": "approve"})
    assert res.status_code == 200 and res.json()["status"] == "approved"
    assert week["id"] not in {p["id"] for p in client.get("/api/v1/approvals/pending", headers=ram).json()}
    # the approved week keeps the days it was submitted with locked
    assert _add(client, babu, "2025-12-01", 1).status_code == 409


def test_old_week_does_not_block_other_days(client, babu, ram):
    """A pending old weekly submission doesn't stop logging and submitting another day of that week."""
    _add(client, babu, "2025-12-08", 6)
    week = client.post("/api/v1/timesheets/weeks/2025-12-08/submit", headers=babu).json()
    assert week["status"] == "submitted"
    assert _add(client, babu, "2025-12-08", 1).status_code == 409  # covered by the week
    assert _add(client, babu, "2025-12-10", 5).status_code == 201
    entry = _add(client, babu, "2025-12-10", 4).json()
    res = client.post(f"{D}/2025-12-10/submit", headers=babu)
    assert res.status_code == 200, res.text
    assert res.json()["total_hours"] == 9
    # the old week still shows only what it was submitted with
    detail = client.get(f"/api/v1/timesheets/weeks/{week['id']}/detail", headers=ram).json()
    assert detail["week"]["total_hours"] == 6 and {e["work_date"] for e in detail["entries"]} == {"2025-12-08"}
    assert client.delete(f"{E}/{entry['id']}", headers=babu).status_code == 409  # the day is submitted now


def test_manager_reopens_missed_day(client, babu, ram, farhan, monkeypatch):
    from datetime import timedelta

    from app.routers import timesheets

    monkeypatch.setattr(timesheets, "TODAY_ONLY", True)
    missed = date.today() - timedelta(days=14)
    while missed.weekday() >= 5:
        missed -= timedelta(days=1)
    url = f"/api/v1/timesheets/team/emp-mahesh/days/{missed.isoformat()}/reopen"
    assert _add(client, babu, missed.isoformat(), 1).status_code == 422  # missed: closed
    assert client.post(url, headers=babu, json={"note": "x"}).status_code == 404  # not for yourself
    assert client.post(url, headers=farhan, json={"note": "Forgot"}).status_code == 403  # HR: only for no-manager people
    assert client.post(url, headers=ram, json={"note": " "}).status_code == 422
    future = f"/api/v1/timesheets/team/emp-mahesh/days/{date.today().isoformat()}/reopen"
    assert client.post(future, headers=ram, json={"note": "x"}).status_code == 422
    res = client.post(url, headers=ram, json={"note": "Client workshop, log it please"})
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "reopened" and res.json()["decision_note"] == "Client workshop, log it please"
    assert any(n["title"] == "Timesheet day reopened" for n in client.get("/api/v1/notifications", headers=babu).json())
    mine = {d["work_date"]: d for d in client.get(D, headers=babu, params={"from": missed.isoformat(), "to": missed.isoformat()}).json()}
    assert mine[missed.isoformat()]["status"] == "reopened"
    # now it can be logged and submitted later
    assert _add(client, babu, missed.isoformat(), 9).status_code == 201
    res = client.post(f"{D}/{missed.isoformat()}/submit", headers=babu)
    assert res.status_code == 200 and res.json()["status"] == "submitted"
    assert client.post(url, headers=ram, json={"note": "again"}).status_code == 409  # submitted: locked


def test_hr_reopens_day_for_no_manager_person(client, farhan, ram):
    url = "/api/v1/timesheets/team/emp-jordan/days/2025-12-15/reopen"
    with SessionLocal() as db:
        from app.models import Employee

        jordan = db.scalar(select(Employee).where(Employee.manager_id.is_(None), Employee.full_name == "Jordan Blake"))
        url = f"/api/v1/timesheets/team/{jordan.id}/days/2025-12-15/reopen"
    assert client.post(url, headers=ram, json={"note": "x"}).status_code in (403, 404)
    res = client.post(url, headers=farhan, json={"note": "Missed Monday"})
    assert res.status_code == 200 and res.json()["status"] == "reopened"


def _clear_today(employee_id: str, day: date) -> None:
    """A clean today for one person: no attendance, no timesheet day, no entries (other tests may have used it)."""
    from sqlalchemy import delete

    from app.models import AttendanceSession, TimesheetDay, TimesheetEntry

    with SessionLocal() as db:
        for model in (AttendanceSession, TimesheetDay, TimesheetEntry):
            db.execute(delete(model).where(model.employee_id == employee_id, model.work_date == day))
        db.commit()


def test_today_submit_needs_check_out(client, babu, ram, monkeypatch):
    from datetime import UTC, datetime, timedelta

    from app.models import AttendanceSession, Employee
    from app.routers import timesheets
    from app.services import attendance as att

    from app.services import timesheets as ts_rules

    monkeypatch.setattr(timesheets, "ATTENDANCE_REQUIRED", True)
    monkeypatch.setattr(ts_rules, "day_target", lambda db, emp, day: (9.0, None))  # a working day, whatever today is
    today = date.today()
    _clear_today("emp-mahesh", today)
    assert _add(client, babu, today.isoformat(), 9).status_code == 201
    # not checked in
    res = client.post(f"{D}/{today.isoformat()}/submit", headers=babu)
    assert res.status_code == 422 and res.json()["detail"] == "Check out before submitting today's timesheet."
    # checked in, not out
    start = datetime.now(UTC) - timedelta(hours=9, minutes=30)
    with SessionLocal() as db:
        emp = db.get(Employee, "emp-mahesh")
        session = att.new_session(emp, today, start, "office", "web")
        att.apply_flags(session)
        db.add(session)
        db.commit()
    res = client.post(f"{D}/{today.isoformat()}/submit", headers=babu)
    assert res.status_code == 422 and "Check out" in res.json()["detail"]
    # checked out with 9 h logged
    with SessionLocal() as db:
        session = db.scalar(select(AttendanceSession).where(AttendanceSession.employee_id == "emp-mahesh",
                                                            AttendanceSession.work_date == today))
        session.check_out = start + timedelta(hours=9, minutes=15)
        att.apply_flags(session)
        db.commit()
    res = client.post(f"{D}/{today.isoformat()}/submit", headers=babu)
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "submitted"
    assert res.json()["id"] in {d["id"] for d in client.get(D, headers=ram, params={"view": "waiting"}).json()}
    _clear_today("emp-mahesh", today)


def test_reopened_past_day_needs_no_attendance(client, babu, ram, monkeypatch):
    from datetime import timedelta

    from app.routers import timesheets

    monkeypatch.setattr(timesheets, "TODAY_ONLY", True)
    monkeypatch.setattr(timesheets, "ATTENDANCE_REQUIRED", True)
    missed = date.today() - timedelta(days=21)
    while missed.weekday() >= 5:
        missed -= timedelta(days=1)
    _clear_today("emp-mahesh", missed)
    res = client.post(f"/api/v1/timesheets/team/emp-mahesh/days/{missed.isoformat()}/reopen", headers=ram,
                      json={"note": "Log the workshop"})
    assert res.status_code == 200, res.text
    assert _add(client, babu, missed.isoformat(), 9).status_code == 201
    res = client.post(f"{D}/{missed.isoformat()}/submit", headers=babu)
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "submitted"
