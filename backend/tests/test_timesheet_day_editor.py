"""Day editor: PUT /timesheets/days/{date}/entries replaces a day's blocks in one go, with the add-a-block rules."""

from sqlalchemy import select

from app.db import SessionLocal
from app.models import AuditLog

DAY = "/api/v1/timesheets/days/2026-07-15/entries"
E = "/api/v1/timesheets/entries"


def _block(start: str, end: str, project: str = "prj-hrms", task: str = "Build", **extra) -> dict:
    sh, sm = (int(x) for x in start.split(":"))
    eh, em = (int(x) for x in end.split(":"))
    return {"work_date": "2026-07-15", "project_id": project, "task": task,
            "start_minute": sh * 60 + sm, "end_minute": eh * 60 + em} | extra


def _day(client, headers) -> list[dict]:
    return client.get(E, headers=headers, params={"from": "2026-07-15", "to": "2026-07-15"}).json()


def test_save_day_replaces_blocks(client, babu):
    res = client.put(DAY, headers=babu, json={"entries": [
        _block("09:00", "13:00", task="API work", comment="morning"),
        _block("14:00", "18:30", "prj-acme", task="Client call", break_minutes=30),
    ]})
    assert res.status_code == 200, res.text
    saved = res.json()
    assert [e["hours"] for e in saved] == [4, 4]
    assert saved[1]["billable"] is True and saved[0]["billable"] is False  # project defaults
    assert saved[0]["comment"] == "morning"

    # Save again with the times swapped around: no overlap with the blocks being replaced.
    res = client.put(DAY, headers=babu, json={"entries": [
        _block("09:00", "12:00", "prj-acme", task="Client call"),
        _block("12:00", "18:00", task="API work", billable=True),
    ]})
    assert res.status_code == 200, res.text
    listed = _day(client, babu)
    assert sorted(e["hours"] for e in listed) == [3, 6]
    assert {e["id"] for e in listed} == {e["id"] for e in res.json()}

    # An empty list clears the day.
    assert client.put(DAY, headers=babu, json={"entries": []}).status_code == 200
    assert _day(client, babu) == []
    with SessionLocal() as db:
        assert db.scalar(select(AuditLog.id).where(AuditLog.action == "timesheet_day_saved")) is not None


def test_save_day_is_all_or_nothing(client, babu):
    assert client.put(DAY, headers=babu, json={"entries": [_block("09:00", "17:00")]}).status_code == 200
    before = _day(client, babu)

    overlap = client.put(DAY, headers=babu, json={"entries": [_block("09:00", "12:00"), _block("11:00", "13:00")]})
    assert overlap.status_code == 409 and "overlaps" in overlap.json()["detail"]
    bad_project = client.put(DAY, headers=babu, json={"entries": [_block("09:00", "12:00"), _block("13:00", "14:00", "prj-nope")]})
    assert bad_project.status_code == 422
    wrong_day = client.put(DAY, headers=babu, json={"entries": [_block("09:00", "12:00") | {"work_date": "2026-07-16"}]})
    assert wrong_day.status_code == 422
    backwards = client.put(DAY, headers=babu, json={"entries": [_block("12:00", "09:00")]})
    assert backwards.status_code == 422

    assert [e["id"] for e in _day(client, babu)] == [e["id"] for e in before]  # nothing changed


def test_nine_hour_stop_leaves_the_day_for_the_person_to_submit(client, babu, monkeypatch):
    """Attendance stops at 9 h but never submits the timesheet: the person saves the blocks and submits by hand."""
    from datetime import timedelta

    from app.models import AttendanceSession, Employee, TimesheetDay
    from app.routers import timesheets
    from app.services import attendance

    monkeypatch.setattr(timesheets, "TODAY_ONLY", True)
    with SessionLocal() as db:
        emp = db.get(Employee, "emp-mahesh")
        day = attendance.local_today(emp) - timedelta(days=70)
        while day.weekday() >= 5 or db.scalar(select(AttendanceSession.id).where(
                AttendanceSession.employee_id == emp.id, AttendanceSession.work_date == day)):
            day -= timedelta(days=1)
        s = attendance.new_session(emp, day, attendance.now() - timedelta(hours=12), "office", "web")
        attendance.apply_flags(s)
        db.add(s)
        db.commit()
    url = f"/api/v1/timesheets/days/{day}/entries"
    block = _block("09:00", "18:00") | {"work_date": day.isoformat()}
    assert client.put(url, headers=babu, json={"entries": [block]}).status_code == 200  # auto-closed day stays open
    with SessionLocal() as db:
        assert db.scalar(select(TimesheetDay).where(TimesheetDay.employee_id == "emp-mahesh", TimesheetDay.work_date == day)) is None
    res = client.post(f"/api/v1/timesheets/days/{day}/submit", headers=babu)
    assert res.status_code == 200 and res.json()["status"] in ("submitted", "approved")


def test_save_day_refused_on_leave_and_submitted_day(client, babu):
    # approved full-day leave (seed: PTO 16-18 March 2026)
    res = client.put("/api/v1/timesheets/days/2026-03-17/entries", headers=babu,
                     json={"entries": [_block("09:00", "10:00") | {"work_date": "2026-03-17"}]})
    assert res.status_code == 422 and "on leave" in res.json()["detail"]

    assert client.put(DAY, headers=babu, json={"entries": [_block("09:00", "18:00")]}).status_code == 200
    assert client.post("/api/v1/timesheets/days/2026-07-15/submit", headers=babu).status_code == 200
    locked = client.put(DAY, headers=babu, json={"entries": [_block("09:00", "10:00")]})
    assert locked.status_code == 409
