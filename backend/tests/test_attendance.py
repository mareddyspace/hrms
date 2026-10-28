from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select

from app.db import SessionLocal
from app.models import AuditLog
from app.services import attendance as rules
from tests.conftest import login

IST = ZoneInfo("Asia/Kolkata")
NY = ZoneInfo("America/New_York")


def _today_ist():
    return datetime.now(IST).date()


def _at(day, hh, mm, tz):
    return datetime.combine(day, time(hh, mm), tz).astimezone(UTC)


def test_check_in_late_check_out_and_scope(client, babu, ram, monkeypatch):
    today = _today_ist()
    monkeypatch.setattr(rules, "now", lambda: _at(today, 10, 0, IST))
    res = client.post("/api/v1/attendance/check-in", headers=babu, json={"work_mode": "wfh", "source": "mobile"})
    assert res.status_code == 201, res.text
    s = res.json()
    assert s["work_date"] == today.isoformat() and s["shift_start"] == "09:30" and s["shift_end"] == "18:30"
    assert s["is_late"] is True and s["late_minutes"] == 30 and s["work_mode"] == "wfh" and s["source"] == "mobile"
    assert client.post("/api/v1/attendance/check-in", headers=babu, json={}).status_code == 409
    assert any(n["title"] == "Babu Menon checked in late" for n in client.get("/api/v1/notifications", headers=ram).json())

    monkeypatch.setattr(rules, "now", lambda: _at(today, 19, 30, IST))
    res = client.post("/api/v1/attendance/check-out", headers=babu, json={"break_minutes": 60})
    assert res.status_code == 200, res.text
    s = res.json()
    assert s["worked_minutes"] == 9 * 60 + 30 - 60 and s["is_early_leave"] is False
    assert client.post("/api/v1/attendance/check-out", headers=babu, json={}).status_code == 409
    assert client.post("/api/v1/attendance/check-in", headers=babu, json={}).status_code == 409  # already checked out

    mine = client.get("/api/v1/attendance", headers=babu).json()
    assert today.isoformat() in {x["work_date"] for x in mine}
    assert client.get("/api/v1/attendance", headers=ram, params={"employee_id": "emp-mahesh"}).status_code == 200
    sophie = login(client, "sophie.clark@timez.com")
    assert client.get("/api/v1/attendance", headers=sophie, params={"employee_id": "emp-mahesh"}).status_code == 404
    assert client.get("/api/v1/attendance/summary", headers=sophie, params={"employee_id": "emp-mahesh"}).status_code == 404

    summary = client.get("/api/v1/attendance/summary", headers=ram, params={"employee_id": "emp-mahesh", "month": today.strftime("%Y-%m")}).json()
    assert summary["present"] >= 1 and summary["late"] >= 1 and summary["hours"] >= 8.5 and summary["overtime_hours"] == 0
    assert summary["working_days"] >= summary["present"] - 10  # sanity: shape is right

    with SessionLocal() as db:
        actions = set(db.scalars(select(AuditLog.action).where(AuditLog.entity_id == s["id"])))
        assert {"attendance_check_in", "attendance_check_out"} <= actions


def test_early_leave_uses_country_shift(client, monkeypatch):
    sophie = login(client, "sophie.clark@timez.com")  # US: 09:00-17:30
    day = datetime.now(NY).date()
    monkeypatch.setattr(rules, "now", lambda: _at(day, 8, 55, NY))
    s = client.post("/api/v1/attendance/check-in", headers=sophie, json={}).json()
    assert s["shift_start"] == "09:00" and s["is_late"] is False
    monkeypatch.setattr(rules, "now", lambda: _at(day, 16, 0, NY))
    s = client.post("/api/v1/attendance/check-out", headers=sophie, json={}).json()
    assert s["is_early_leave"] is True and s["early_minutes"] == 90


def test_overtime_in_summary(client, ram, monkeypatch):
    today = _today_ist()
    monkeypatch.setattr(rules, "now", lambda: _at(today, 9, 0, IST))
    assert client.post("/api/v1/attendance/check-in", headers=ram, json={}).status_code == 201
    monkeypatch.setattr(rules, "now", lambda: _at(today, 20, 0, IST))
    assert client.post("/api/v1/attendance/check-out", headers=ram, json={}).json()["worked_minutes"] == 11 * 60
    summary = client.get("/api/v1/attendance/summary", headers=ram, params={"month": today.strftime("%Y-%m")}).json()
    assert summary["overtime_hours"] >= 2


def test_correction_rules_and_manager_applies(client, babu, ram):
    day = _today_ist() - timedelta(days=3)
    body = {
        "work_date": day.isoformat(),
        "requested_check_in": f"{day}T09:15:00",  # naive = Babu's local time
        "requested_check_out": f"{day}T18:45:00",
        "reason": "Forgot to check in",
    }
    res = client.post("/api/v1/attendance/corrections", headers=babu, json=body)
    assert res.status_code == 201, res.text
    cid = res.json()["id"]
    assert res.json()["requested_check_in"].startswith(f"{day}T03:45:00")  # stored in UTC
    # one open request per date
    assert client.post("/api/v1/attendance/corrections", headers=babu, json=body).status_code == 409
    # 30-day window, no future dates, a check-in is needed when there is no session
    old = _today_ist() - timedelta(days=40)
    assert client.post("/api/v1/attendance/corrections", headers=babu, json=body | {"work_date": old.isoformat(),
           "requested_check_in": f"{old}T09:00:00", "requested_check_out": f"{old}T18:00:00"}).status_code == 422
    future = _today_ist() + timedelta(days=2)
    assert client.post("/api/v1/attendance/corrections", headers=babu, json=body | {"work_date": future.isoformat(),
           "requested_check_in": f"{future}T09:00:00", "requested_check_out": None}).status_code == 422
    other = _today_ist() - timedelta(days=4)
    assert client.post("/api/v1/attendance/corrections", headers=babu, json={"work_date": other.isoformat(),
           "requested_check_out": f"{other}T18:00:00", "reason": "x"}).status_code == 422

    assert cid in {c["id"] for c in client.get("/api/v1/attendance/corrections", headers=babu).json()}
    assert cid in {c["id"] for c in client.get("/api/v1/attendance/corrections", headers=ram, params={"view": "to-decide"}).json()}
    assert client.get("/api/v1/attendance/corrections", headers=babu, params={"view": "to-decide"}).json() == []

    # never self; out of scope is 404
    assert client.post(f"/api/v1/attendance/corrections/{cid}/decision", headers=babu, json={"decision": "approve"}).status_code == 403
    sophie = login(client, "sophie.clark@timez.com")
    assert client.post(f"/api/v1/attendance/corrections/{cid}/decision", headers=sophie, json={"decision": "approve"}).status_code == 404

    res = client.post(f"/api/v1/attendance/corrections/{cid}/decision", headers=ram, json={"decision": "approve"})
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "approved" and res.json()["session_id"]
    assert client.post(f"/api/v1/attendance/corrections/{cid}/decision", headers=ram, json={"decision": "approve"}).status_code == 409

    session = next(s for s in client.get("/api/v1/attendance", headers=babu).json() if s["work_date"] == day.isoformat())
    assert session["corrected"] is True and session["is_late"] is False and session["worked_minutes"] == 9 * 60 + 30

    # a later correction to the same day only moves check-out
    res = client.post("/api/v1/attendance/corrections", headers=babu, json={"work_date": day.isoformat(),
                      "requested_check_out": f"{day}T17:30:00", "reason": "Left early for a doctor visit"})
    assert res.status_code == 201, res.text
    assert client.post(f"/api/v1/attendance/corrections/{res.json()['id']}/decision", headers=ram, json={"decision": "approve"}).status_code == 200
    session = next(s for s in client.get("/api/v1/attendance", headers=babu).json() if s["work_date"] == day.isoformat())
    assert session["is_early_leave"] is True and session["early_minutes"] == 60 and session["check_in"].startswith(f"{day}T03:45")

    notes = client.get("/api/v1/notifications", headers=babu).json()
    assert any(n["title"] == "Attendance correction approved" for n in notes)
    with SessionLocal() as db:
        actions = list(db.scalars(select(AuditLog.action).where(AuditLog.entity_id == cid).order_by(AuditLog.id)))
        assert actions == ["attendance_correction_requested", "attendance_correction_approved"]
        assert db.scalar(select(AuditLog).where(AuditLog.action == "attendance_corrected", AuditLog.entity_id == session["id"]))


def test_hr_can_decide_correction(client, babu, farhan):
    day = _today_ist() - timedelta(days=5)
    cid = client.post("/api/v1/attendance/corrections", headers=babu, json={"work_date": day.isoformat(),
                      "requested_check_in": f"{day}T11:00:00", "reason": "Device was down"}).json()["id"]
    url = f"/api/v1/attendance/corrections/{cid}/decision"
    assert client.post(url, headers=farhan, json={"decision": "reject"}).status_code == 422  # note required
    res = client.post(url, headers=farhan, json={"decision": "reject", "note": "Badge logs show 11:40"})
    assert res.status_code == 200 and res.json()["status"] == "rejected" and res.json()["decided_by"] == "demo-hr-admin"
    assert day.isoformat() not in {s["work_date"] for s in client.get("/api/v1/attendance", headers=babu).json()}

    cid = client.post("/api/v1/attendance/corrections", headers=babu, json={"work_date": day.isoformat(),
                      "requested_check_in": f"{day}T11:40:00", "reason": "Device was down"}).json()["id"]
    res = client.post(f"/api/v1/attendance/corrections/{cid}/decision", headers=farhan, json={"decision": "approve"})
    assert res.status_code == 200
    session = next(s for s in client.get("/api/v1/attendance", headers=babu).json() if s["work_date"] == day.isoformat())
    assert session["is_late"] is True and session["late_minutes"] == 130 and session["check_out"] is None
