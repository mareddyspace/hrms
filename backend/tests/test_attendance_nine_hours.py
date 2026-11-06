"""Attendance stops at 9 hours of work; that day's timesheet can be added when the person next signs in."""

from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import select

from app.db import SessionLocal
from app.models import AttendanceSession, AuditLog, Employee, Notification
from app.routers import timesheets
from app.services import attendance as rules

BABU = "emp-mahesh"


def _free_weekday(db, emp_id: str, days_back: int) -> date:
    """A past weekday with no attendance yet for this person (other tests use fixed 2025 dates)."""
    day = rules.local_today(db.get(Employee, emp_id)) - timedelta(days=days_back)
    while day.weekday() >= 5 or db.scalar(select(AttendanceSession.id).where(
            AttendanceSession.employee_id == emp_id, AttendanceSession.work_date == day)):
        day -= timedelta(days=1)
    return day


def _open_session(emp_id: str, day: date, hours_ago: float, breaks: list[dict] | None = None) -> str:
    with SessionLocal() as db:
        emp = db.get(Employee, emp_id)
        s = rules.new_session(emp, day, rules.now() - timedelta(hours=hours_ago), "office", "web")
        s.breaks = breaks
        rules.apply_flags(s)
        db.add(s)
        db.commit()
        return s.id


def test_cap_moment_counts_breaks_and_pauses_on_a_break():
    base = rules.now()
    at = lambda h: (base - timedelta(hours=h)).isoformat()  # noqa: E731
    with SessionLocal() as db:
        emp = db.get(Employee, BABU)
        s = rules.new_session(emp, date(2026, 1, 5), base - timedelta(hours=11), "office", "web")
    s.breaks = [{"start": at(10), "end": at(9)}]  # one hour off: the 9-hour mark moves an hour later
    assert rules.cap_moment(s) == s.check_in + timedelta(hours=10)
    s.breaks = [{"start": at(10), "end": None}]  # still on a break that began before the mark: paused
    assert rules.cap_moment(s) is None
    assert rules.auto_checkout(s) is False


def test_session_past_nine_hours_is_closed_audited_and_announced(client, babu):
    with SessionLocal() as db:
        day = _free_weekday(db, BABU, 61)
    sid = _open_session(BABU, day, hours_ago=12)
    rows = client.get("/api/v1/attendance", headers=babu, params={"from": day.isoformat(), "to": day.isoformat()}).json()
    s = next(r for r in rows if r["id"] == sid)
    assert s["check_out"] and s["worked_minutes"] == 540 and s["note"].startswith(rules.AUTO_CHECKOUT_NOTE)
    with SessionLocal() as db:
        row = db.get(AttendanceSession, sid)
        assert row.check_out - row.check_in == timedelta(hours=9)
        assert db.scalar(select(AuditLog).where(AuditLog.entity_id == sid, AuditLog.action == "attendance_auto_checkout"))
        note = db.scalar(select(Notification).where(Notification.recipient_id == BABU,
                                                    Notification.title == "Checked out after 9 hours")
                         .order_by(Notification.id.desc()))
        assert note is not None and day.isoformat() in (note.href or "")
        # an open session under 9 hours is left alone
        assert rules.close_overdue(db, BABU, at=row.check_in + timedelta(hours=8)) == []


def test_auto_closed_day_timesheet_can_be_submitted_later(client, babu, monkeypatch):
    monkeypatch.setattr(timesheets, "TODAY_ONLY", True)
    monkeypatch.setattr(timesheets, "ATTENDANCE_REQUIRED", True)
    with SessionLocal() as db:
        auto_day = _free_weekday(db, BABU, 75)
    holidays = {h["date"] for y in {auto_day.year} for h in
                client.get("/api/v1/leave/holidays", headers=babu, params={"year": y}).json()}
    while auto_day.isoformat() in holidays:
        auto_day -= timedelta(days=7)
    _open_session(BABU, auto_day, hours_ago=(rules.now().date() - auto_day).days * 24 + 10)

    # a normal past day is still locked
    with SessionLocal() as db:
        locked_day = _free_weekday(db, BABU, 90)
    res = client.post("/api/v1/timesheets/entries", headers=babu,
                      json={"work_date": locked_day.isoformat(), "project_id": "prj-hrms", "task": "QA", "hours": 9})
    assert res.status_code == 422

    # the auto-closed day takes time and can be submitted on a later day
    res = client.post("/api/v1/timesheets/entries", headers=babu,
                      json={"work_date": auto_day.isoformat(), "project_id": "prj-hrms", "task": "Build", "hours": 9})
    assert res.status_code in (200, 201), res.text
    res = client.post(f"/api/v1/timesheets/days/{auto_day.isoformat()}/submit", headers=babu)
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "submitted"


def test_check_out_after_nine_hours_says_so(client):
    from tests.conftest import login

    priya = login(client, "priya.nair@timez.com")
    with SessionLocal() as db:
        today = rules.local_today(db.get(Employee, "emp-priya"))
        if db.scalar(select(AttendanceSession.id).where(AttendanceSession.employee_id == "emp-priya",
                                                        AttendanceSession.work_date == today)):
            return  # another test already used Priya's today
    _open_session("emp-priya", today, hours_ago=9.5)
    res = client.post("/api/v1/attendance/check-out", headers=priya, json={})
    assert res.status_code == 409 and "automatically after 9 hours" in res.json()["detail"]
