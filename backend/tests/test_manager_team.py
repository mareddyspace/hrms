"""Manager team view (GET /team/summary, /team/{id}/summary) and timesheet review: attendance vs logged hours,
bulk decisions with comments, notifications and audit."""

from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import select

from app.db import SessionLocal
from app.models import AttendanceSession, AuditLog, Employee, Notification, TimesheetDay
from app.services import attendance as att

BABU = "emp-mahesh"
RAM = "emp-ram"


def _free_weekday(emp_id: str, start_back: int) -> date:
    """A past weekday with no attendance and no timesheet day yet for the person."""
    with SessionLocal() as db:
        day = att.local_today(db.get(Employee, emp_id)) - timedelta(days=start_back)
        while day.weekday() >= 5 or db.scalar(select(AttendanceSession.id).where(
                AttendanceSession.employee_id == emp_id, AttendanceSession.work_date == day)) or db.scalar(
                select(TimesheetDay.id).where(TimesheetDay.employee_id == emp_id, TimesheetDay.work_date == day)):
            day -= timedelta(days=1)
        return day


def _attend(emp_id: str, day: date, hours: float) -> None:
    from datetime import datetime, time
    from zoneinfo import ZoneInfo

    with SessionLocal() as db:
        emp = db.get(Employee, emp_id)
        start = datetime.combine(day, time(9, 30), ZoneInfo(emp.time_zone or "UTC"))
        s = att.new_session(emp, day, start, "office", "web")
        s.check_out = start + timedelta(hours=hours)
        att.apply_flags(s)
        db.add(s)
        db.commit()


def _submit(client, headers, day: date, hours: float, client_holidays: set[str] | None = None) -> dict:
    res = client.post("/api/v1/timesheets/entries", headers=headers,
                      json={"work_date": day.isoformat(), "project_id": "prj-hrms", "task": "Build", "hours": hours})
    assert res.status_code in (200, 201), res.text
    res = client.post(f"/api/v1/timesheets/days/{day.isoformat()}/submit", headers=headers)
    assert res.status_code == 200, res.text
    return res.json()


def _working_day(client, headers, start_back: int) -> date:
    day = _free_weekday(BABU, start_back)
    years = {day.year, day.year - 1}
    holidays = {h["date"] for y in years for h in client.get("/api/v1/leave/holidays", headers=headers, params={"year": y}).json()}
    leave = client.get("/api/v1/leave/requests", headers=headers).json()
    busy = {(r.get("from_date"), r.get("to_date")) for r in leave if r.get("status") in ("approved", "pending")}

    def on_leave(d: date) -> bool:
        return any(f and t and f <= d.isoformat() <= t for f, t in busy)

    while day.isoformat() in holidays or on_leave(day) or day.weekday() >= 5:
        day = _free_weekday(BABU, (date.today() - day).days + 1)
    return day


def test_team_summary_lists_reports_with_hours_and_counts(client, ram, babu):
    rows = client.get("/api/v1/team/summary", headers=ram)
    assert rows.status_code == 200, rows.text
    by_id = {r["employee_id"]: r for r in rows.json()}
    assert BABU in by_id and RAM not in by_id
    row = by_id[BABU]
    assert row["direct"] is True
    assert row["status"] in {"checked_in", "checked_out", "remote", "on_leave", "holiday", "weekly_off", "not_in"}
    for key in ("today_minutes", "week_minutes", "week_target_minutes", "month_minutes", "month_target_minutes",
                "late_days_month", "overtime_minutes_month", "pending_approvals", "open_tasks", "overdue_tasks",
                "open_tickets", "overdue_tickets", "timesheet_missing_days"):
        assert isinstance(row[key], int) and row[key] >= 0, key
    assert row["month_target_minutes"] >= row["week_target_minutes"] or date.today().day < 7
    assert row["days"] == []  # the list has no day-by-day detail
    direct = client.get("/api/v1/team/summary", headers=ram, params={"view": "direct"}).json()
    assert all(r["direct"] for r in direct)
    # someone with no reports sees nobody
    assert client.get("/api/v1/team/summary", headers=babu).json() == []


def test_person_summary_drill_in_and_permissions(client, ram, babu):
    res = client.get(f"/api/v1/team/{BABU}/summary", headers=ram)
    assert res.status_code == 200, res.text
    data = res.json()
    today = date.fromisoformat(data["date"])
    assert data["days"] and data["days"][0]["date"] == today.replace(day=1).isoformat()
    assert data["days"][-1]["date"] == today.isoformat()
    assert sum(d["worked_minutes"] for d in data["days"]) == data["month_minutes"]
    assert sum(d["target_minutes"] for d in data["days"]) == data["month_target_minutes"]
    assert data["late_days_month"] <= len(data["days"])
    # Babu can't drill into his manager, nor anyone into themselves via the team view.
    assert client.get(f"/api/v1/team/{RAM}/summary", headers=babu).status_code == 404
    assert client.get(f"/api/v1/team/{RAM}/summary", headers=ram).status_code == 404
    assert client.get("/api/v1/team/nobody/summary", headers=ram).status_code == 404


def test_worked_hours_count_attendance(client, ram):
    day = _free_weekday(BABU, 1)
    if day.month != date.today().month:  # the month figure only covers this month
        return
    before = client.get(f"/api/v1/team/{BABU}/summary", headers=ram).json()
    _attend(BABU, day, 5)
    after = client.get(f"/api/v1/team/{BABU}/summary", headers=ram).json()
    assert after["month_minutes"] - before["month_minutes"] == 5 * 60
    row = next(d for d in after["days"] if d["date"] == day.isoformat())
    assert row["worked_minutes"] == 300 and row["check_in"] is not None


def test_review_flags_mismatch_and_bulk_decides_with_comment(client, ram, babu):
    d1 = _working_day(client, babu, 40)
    _attend(BABU, d1, 4)  # attended 4 h, logs 9 h -> mismatch
    day1 = _submit(client, babu, d1, 9)
    assert day1["attendance_minutes"] == 240 and day1["hours_mismatch"] is True
    d2 = _working_day(client, babu, (date.today() - d1).days + 1)
    _attend(BABU, d2, 9)
    day2 = _submit(client, babu, d2, 9)
    assert day2["hours_mismatch"] is False

    waiting = {d["id"]: d for d in client.get("/api/v1/timesheets/days", headers=ram, params={"view": "waiting"}).json()}
    assert day1["id"] in waiting and waiting[day1["id"]]["hours_mismatch"] is True

    url = "/api/v1/timesheets/days/bulk-decision"
    # sending back needs a comment; the employee can't decide their own days
    assert client.post(url, headers=ram, json={"ids": [day1["id"]], "decision": "reject"}).status_code == 422
    own = client.post(url, headers=babu, json={"ids": [day1["id"]], "decision": "approve"}).json()
    assert own["decided"] == [] and own["failed"][0]["id"] == day1["id"]
    assert client.post(url, headers=ram, json={"ids": [], "decision": "approve"}).status_code == 422

    res = client.post(url, headers=ram, json={"ids": [day1["id"]], "decision": "reject",
                                               "note": "Attendance shows 4 h; please correct."})
    assert res.status_code == 200, res.text
    assert res.json()["decided"][0]["status"] == "rejected"
    res = client.post(url, headers=ram, json={"ids": [day2["id"], day1["id"], "tsd-missing"], "decision": "approve"})
    body = res.json()
    assert [d["id"] for d in body["decided"]] == [day2["id"]] and body["decided"][0]["status"] == "approved"
    assert {f["id"] for f in body["failed"]} == {day1["id"], "tsd-missing"}

    # the employee sees the status and the comment, gets a notification; all of it is audited
    mine = {d["id"]: d for d in client.get("/api/v1/timesheets/days", headers=babu,
                                           params={"from": min(d1, d2).isoformat(), "to": max(d1, d2).isoformat()}).json()}
    assert mine[day1["id"]]["status"] == "rejected"
    assert mine[day1["id"]]["decision_note"] == "Attendance shows 4 h; please correct."
    assert mine[day2["id"]]["status"] == "approved"
    with SessionLocal() as db:
        assert db.scalar(select(Notification).where(Notification.recipient_id == BABU,
                                                    Notification.body.like("%Attendance shows 4 h%"))) is not None
        assert db.scalar(select(AuditLog).where(AuditLog.action == "timesheet_day_rejected",
                                                AuditLog.entity_id == day1["id"])) is not None
        assert db.scalar(select(AuditLog).where(AuditLog.action == "timesheet_days_bulk_decision")) is not None
