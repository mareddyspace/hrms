"""Breaks saved on the session, the richer month summary, leave handover / attachment, the private team calendar
and optional-holiday pick deadlines (migration 0024)."""

from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from app.services import attendance as rules
from tests.conftest import login
from tests.test_leave import _workday

IST = ZoneInfo("Asia/Kolkata")
PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"


def _at(day, hh, mm):
    return datetime.combine(day, time(hh, mm), IST).astimezone(UTC)


def test_breaks_are_saved_and_counted(client, monkeypatch):
    farhan = login(client, "farhan.ali@timez.com")
    day = datetime.now(IST).date()
    monkeypatch.setattr(rules, "now", lambda: _at(day, 9, 30))
    res = client.post("/api/v1/attendance/check-in", headers=farhan, json={})
    assert res.status_code == 201, res.text
    assert client.post("/api/v1/attendance/break/end", headers=farhan).status_code == 409
    monkeypatch.setattr(rules, "now", lambda: _at(day, 13, 0))
    s = client.post("/api/v1/attendance/break/start", headers=farhan).json()
    assert len(s["breaks"]) == 1 and s["breaks"][0]["end"] is None
    assert client.post("/api/v1/attendance/break/start", headers=farhan).status_code == 409
    monkeypatch.setattr(rules, "now", lambda: _at(day, 13, 45))
    s = client.post("/api/v1/attendance/break/end", headers=farhan).json()
    assert s["break_minutes"] == 45
    monkeypatch.setattr(rules, "now", lambda: _at(day, 15, 0))
    client.post("/api/v1/attendance/break/start", headers=farhan)
    monkeypatch.setattr(rules, "now", lambda: _at(day, 18, 30))
    s = client.post("/api/v1/attendance/check-out", headers=farhan, json={"break_minutes": 5}).json()
    # the open break is closed at check-out and the saved breaks win over the typed total
    assert s["break_minutes"] == 45 + 210 and s["worked_minutes"] == 9 * 60 - 255
    summary = client.get("/api/v1/attendance/summary", headers=farhan, params={"month": day.strftime("%Y-%m")}).json()
    for key in ("attendance_pct", "avg_hours", "missing_punches", "expected_days", "late_minutes", "break_minutes"):
        assert key in summary
    assert summary["avg_hours"] > 0 and 0 <= summary["attendance_pct"] <= 100


def test_handover_attachment_and_team_calendar_privacy(client, babu, ram):
    farhan = login(client, "farhan.ali@timez.com")
    day = _workday(client, babu, 120)
    bad = client.post("/api/v1/leave/requests", headers=babu,
                      json={"leave_code": "casual", "from": day.isoformat(), "to": day.isoformat(), "reason": "Trip",
                            "handover_to": "emp-mahesh"})
    assert bad.status_code == 422
    res = client.post("/api/v1/leave/requests", headers=babu,
                      json={"leave_code": "casual", "from": day.isoformat(), "to": day.isoformat(), "reason": "Family trip",
                            "handover_to": "emp-ram"})
    assert res.status_code == 201, res.text
    req = res.json()
    assert req["handover_to"] == "emp-ram" and req["handover_name"]
    rid = req["id"]

    up = client.post(f"/api/v1/leave/requests/{rid}/attachment", headers={**babu, "content-type": "application/pdf"},
                     params={"filename": "ticket.pdf"}, content=PDF)
    assert up.status_code == 200, up.text and up.json()["attachment_name"] == "ticket.pdf"
    assert client.get(f"/api/v1/leave/requests/{rid}/attachment", headers=babu).content == PDF
    assert client.get(f"/api/v1/leave/requests/{rid}/attachment", headers=ram).status_code == 200
    sophie = login(client, "sophie.clark@timez.com")
    assert client.get(f"/api/v1/leave/requests/{rid}/attachment", headers=sophie).status_code == 404
    assert client.post(f"/api/v1/leave/requests/{rid}/attachment", headers={**ram, "content-type": "application/pdf"},
                       content=PDF).status_code == 404

    # approved, then seen by a teammate (same manager) only as "On leave"
    assert client.post(f"/api/v1/leave/requests/{rid}/decision", headers=ram, json={"decision": "approve"}).status_code == 200
    params = {"from": (day - timedelta(days=1)).isoformat(), "to": (day + timedelta(days=1)).isoformat()}
    mine = [r for r in client.get("/api/v1/leave/team-calendar", headers=babu, params=params).json() if r["employee_id"] == "emp-mahesh"]
    assert mine and mine[0]["leave_code"] == "casual" and mine[0]["reason"] == "Family trip"
    by_manager = [r for r in client.get("/api/v1/leave/team-calendar", headers=ram, params=params).json() if r["employee_id"] == "emp-mahesh"]
    assert by_manager and by_manager[0]["detail"] is True
    with_hr = client.get("/api/v1/leave/team-calendar", headers=farhan, params=params)
    assert with_hr.status_code == 200
    assert client.get("/api/v1/leave/team-calendar", headers=babu,
                      params={"from": "2026-01-01", "to": "2026-12-31"}).status_code == 422
    client.post(f"/api/v1/leave/requests/{rid}/cancel", headers=babu)


def test_teammate_sees_on_leave_only(client):
    from app.db import SessionLocal
    from app.models import Employee, LeaveRequest

    babu = login(client, "babu.menon@timez.com")
    day = _workday(client, babu, 140)
    with SessionLocal() as db:
        mate = db.query(Employee).filter(Employee.manager_id == "emp-ram", Employee.id != "emp-mahesh").first()
        assert mate is not None, "the seed has another report of emp-ram"
        db.add(LeaveRequest(id="lv-privacy-test", employee_id=mate.id, leave_code="sick", from_date=day, to_date=day,
                            half="none", days=1, reason="Private reason", status="approved"))
        db.commit()
    rows = client.get("/api/v1/leave/team-calendar", headers=babu,
                      params={"from": day.isoformat(), "to": day.isoformat()}).json()
    theirs = [r for r in rows if r["employee_id"] == mate.id]
    assert theirs and theirs[0]["label"] == "On leave" and theirs[0]["leave_code"] is None and theirs[0]["reason"] is None
    with SessionLocal() as db:
        db.delete(db.get(LeaveRequest, "lv-privacy-test"))
        db.commit()


def test_optional_holiday_deadline_and_details(client, babu):
    farhan = login(client, "farhan.ali@timez.com")
    day = _workday(client, babu, 200)
    while day.isoformat() in {h["date"] for h in client.get("/api/v1/leave/optional-holidays", headers=babu,
                                                              params={"year": day.year}).json()}:
        day = _workday(client, babu, (day - datetime.now(IST).date()).days + 1)
    bad = client.post("/api/v1/leave/optional-holidays", headers=farhan,
                      json={"country_code": "IN", "date": day.isoformat(), "name": "Late", "select_by": day.isoformat()})
    assert bad.status_code == 422
    res = client.post("/api/v1/leave/optional-holidays", headers=farhan,
                      json={"country_code": "IN", "date": day.isoformat(), "name": "Deadline test",
                            "description": "Local festival", "select_by": (date.today() + timedelta(days=1)).isoformat()})
    assert res.status_code == 201, res.text
    row = res.json()
    assert row["description"] == "Local festival" and row["select_by"]
    listed = {h["id"]: h for h in client.get("/api/v1/leave/optional-holidays", headers=babu, params={"year": day.year}).json()}
    assert listed[row["id"]]["select_by"] == row["select_by"]
    # region-only holidays are hidden from people in other regions
    other = _workday(client, babu, 230)
    reg = client.post("/api/v1/leave/optional-holidays", headers=farhan,
                      json={"country_code": "IN", "date": other.isoformat(), "name": "Region only", "region": "Nowhere"})
    if reg.status_code == 201:
        assert reg.json()["id"] not in {h["id"] for h in client.get("/api/v1/leave/optional-holidays", headers=babu,
                                                                     params={"year": other.year}).json()}
        client.delete(f"/api/v1/leave/optional-holidays/{reg.json()['id']}", headers=farhan)
    client.delete(f"/api/v1/leave/optional-holidays/{row['id']}", headers=farhan)


def test_closed_pick_is_refused(client, babu):
    from app.db import SessionLocal
    from app.models import OptionalHoliday

    farhan = login(client, "farhan.ali@timez.com")
    day = _workday(client, babu, 260)
    res = client.post("/api/v1/leave/optional-holidays", headers=farhan,
                      json={"country_code": "IN", "date": day.isoformat(), "name": "Closed pick"})
    if res.status_code != 201:
        return
    with SessionLocal() as db:
        db.get(OptionalHoliday, res.json()["id"]).select_by = date.today() - timedelta(days=1)
        db.commit()
    pick = client.post("/api/v1/leave/requests", headers=babu,
                       json={"leave_code": "optional", "from": day.isoformat(), "to": day.isoformat(), "reason": "Optional"})
    assert pick.status_code == 422 and "closed" in pick.json()["detail"]
    client.delete(f"/api/v1/leave/optional-holidays/{res.json()['id']}", headers=farhan)
