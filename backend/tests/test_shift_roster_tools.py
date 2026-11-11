"""Shift templates (colour, country, paid hours), availability warnings, bulk assign, copy / repeat week, weekly hours,
unpublish, team calendar, and attendance / timesheet using the published rostered shift."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace

from tests.conftest import login

SH = "/api/v1/shifts"


def _monday(weeks_ahead: int) -> date:
    today = date.today()
    return today - timedelta(days=today.weekday()) + timedelta(weeks=weeks_ahead)


def _type(client, headers, **kw):
    body = {"name": "Test", "start": "09:00", "end": "17:00", "break_minutes": 60, **kw}
    return client.post(f"{SH}/types", headers=headers, json=body)


def test_shift_type_validation_and_paid_hours(client, farhan, ram):
    assert _type(client, ram, name="Nope").status_code == 403  # HR only
    assert _type(client, farhan, name="Short", end="11:00").status_code == 422  # under 4 h
    assert _type(client, farhan, name="Long", start="06:00", end="20:00").status_code == 422  # over 12 h
    assert _type(client, farhan, name="Bad colour", color="pink").status_code == 422
    assert _type(client, farhan, name="Bad country", country_code="1N").status_code == 422
    res = _type(client, farhan, id="sh-test-late", name="Test late night", start="20:00", end="04:00", break_minutes=30,
                color="violet", country_code="in")
    assert res.status_code == 201, res.text
    out = res.json()
    assert out["overnight"] is True and out["paid_hours"] == 7.5 and out["color"] == "violet" and out["country_code"] == "IN"
    # HR can turn it off while it is on no upcoming roster day
    again = _type(client, farhan, id="sh-test-late", name="Test late night", start="20:00", end="04:00", break_minutes=30,
                  color="violet", country_code="IN", active=False)
    assert again.status_code == 201 and again.json()["active"] is False


def test_country_shift_only_for_that_country(client, farhan, ram):
    assert _type(client, farhan, id="sh-test-uk", name="Test UK only", start="09:00", end="17:30",
                 country_code="GB").status_code == 201
    tue = _monday(40) + timedelta(days=1)
    res = client.post(f"{SH}/roster/assign", headers=ram, json={"employee_id": "emp-mahesh", "work_date": tue.isoformat(),
                                                                "shift_id": "sh-test-uk"})
    assert res.status_code == 409 and "GB" in res.json()["detail"]
    res = client.post(f"{SH}/roster/assign", headers=ram, json={"employee_id": "emp-oliver", "work_date": tue.isoformat(),
                                                                "shift_id": "sh-test-uk"})
    assert res.status_code == 200, res.text


def test_availability_warns_manager_and_permissions(client, babu, ram):
    week = _monday(41)
    wed = week + timedelta(days=2)
    res = client.post(f"{SH}/availability", headers=babu, json={"kind": "unavailable", "work_date": wed.isoformat(),
                                                                "note": "Exam"})
    assert res.status_code == 201, res.text
    entry = res.json()["id"]
    assert client.post(f"{SH}/availability", headers=babu, json={"kind": "unavailable", "work_date": wed.isoformat()}).status_code == 409
    assert client.post(f"{SH}/availability", headers=babu, json={"kind": "unavailable"}).status_code == 422
    assert client.post(f"{SH}/availability", headers=babu,
                       json={"kind": "unavailable", "work_date": date.today().isoformat()}).status_code == 422
    assert client.post(f"{SH}/availability", headers=babu, json={"kind": "preferred", "weekday": 1}).status_code == 422
    # the manager sees it and gets a warning (not a block) when rostering against it
    team = client.get(f"{SH}/availability", headers=ram, params={"employee_id": "team"}).json()
    assert any(a["id"] == entry for a in team)
    res = client.post(f"{SH}/roster/assign", headers=ram, json={"employee_id": "emp-mahesh", "work_date": wed.isoformat(),
                                                                "shift_id": "sh-general"})
    assert res.status_code == 200, res.text
    warnings = [w for w in res.json()["warnings"] if w["employee_id"] == "emp-mahesh" and w["date"] == wed.isoformat()]
    assert warnings and "unavailable" in warnings[0]["message"]
    # employees can't read or remove someone else's entries
    priya = login(client, "priya.nair@timez.com")
    assert client.get(f"{SH}/availability", headers=priya, params={"employee_id": "emp-mahesh"}).status_code == 404
    assert client.delete(f"{SH}/availability/{entry}", headers=ram).status_code == 404
    assert client.delete(f"{SH}/availability/{entry}", headers=babu).status_code == 204
    assert all(a["id"] != entry for a in client.get(f"{SH}/availability", headers=babu).json())


def test_bulk_assign_copy_and_repeat_week(client, ram, babu):
    week = _monday(42)
    days = [(week + timedelta(days=i)).isoformat() for i in range(5)]
    res = client.post(f"{SH}/roster/bulk", headers=ram, json={"employee_ids": ["emp-mahesh", "emp-ram"], "dates": days,
                                                              "shift_id": "sh-general"})
    assert res.status_code == 200, res.text
    out = res.json()
    assert out["applied"] == 5 and len(out["skipped"]) == 5  # nobody rosters themselves
    assert client.post(f"{SH}/roster/bulk", headers=babu, json={"employee_ids": ["emp-priya"], "dates": days[:1],
                                                                "shift_id": "sh-general"}).json()["applied"] == 0
    # copy into the next two weeks (repeat pattern); a day already filled is kept
    nxt = week + timedelta(days=7)
    kept = next(d for d in (nxt + timedelta(days=i) for i in range(5)) if client.post(
        f"{SH}/roster/assign", headers=ram, json={"employee_id": "emp-mahesh", "work_date": d.isoformat(),
                                                  "shift_id": "sh-morning"}).status_code == 200)
    res = client.post(f"{SH}/roster/copy-week", headers=ram, json={"from_week": week.isoformat(), "to_week": nxt.isoformat(),
                                                                   "weeks": 2})
    assert res.status_code == 200, res.text
    out = res.json()
    assert out["applied"] + len(out["skipped"]) == 9 and out["applied"] >= 7  # 4 + 5 empty days; other suites may book a day
    roster = client.get(f"{SH}/roster", headers=ram, params={"week_start": nxt.isoformat()}).json()
    mine = {r["work_date"]: r["shift_id"] for r in roster["shifts"] if r["employee_id"] == "emp-mahesh"}
    assert mine[kept.isoformat()] == "sh-morning"
    assert all(v == "sh-general" for k, v in mine.items() if k != kept.isoformat())
    assert client.post(f"{SH}/roster/copy-week", headers=ram, json={"from_week": _monday(60).isoformat(),
                                                                    "to_week": _monday(61).isoformat()}).status_code == 409
    # clearing in bulk
    res = client.post(f"{SH}/roster/bulk", headers=ram, json={"employee_ids": ["emp-mahesh"], "dates": days, "shift_id": None})
    assert res.json()["applied"] == 5


def test_weekly_paid_hours_limit(client, farhan, ram):
    assert _type(client, farhan, id="sh-test-long", name="Test long day", start="07:00", end="19:00",
                 break_minutes=0).status_code == 201
    week = _monday(45)
    codes = [client.post(f"{SH}/roster/assign", headers=ram, json={"employee_id": "emp-priya",
                                                                   "work_date": (week + timedelta(days=i)).isoformat(),
                                                                   "shift_id": "sh-test-long"}) for i in range(5)]
    assert [c.status_code for c in codes[:4]] == [200, 200, 200, 200]
    assert codes[4].status_code == 409 and "Weekly hours" in codes[4].json()["detail"]
    # a shift type on upcoming roster days can't change its hours
    res = _type(client, farhan, id="sh-test-long", name="Test long day", start="08:00", end="19:00", break_minutes=0)
    assert res.status_code == 409


def test_unpublish_week(client, ram):
    week = _monday(46)
    client.post(f"{SH}/roster/assign", headers=ram, json={"employee_id": "emp-mahesh", "work_date": week.isoformat(),
                                                          "shift_id": "sh-general"})
    assert client.post(f"{SH}/roster/unpublish", headers=ram, json={"week_start": week.isoformat(),
                                                                    "reason": "Fixing"}).status_code == 409  # still a draft
    assert client.post(f"{SH}/roster/publish", headers=ram, json={"week_start": week.isoformat(),
                                                                  "allow_gaps": True}).status_code == 200
    assert client.post(f"{SH}/roster/unpublish", headers=ram, json={"week_start": week.isoformat(), "reason": ""}).status_code == 422
    res = client.post(f"{SH}/roster/unpublish", headers=ram, json={"week_start": week.isoformat(), "reason": "Client moved go-live"})
    assert res.status_code == 200 and res.json()["status"] == "draft"
    this_week = _monday(0)
    assert client.post(f"{SH}/roster/unpublish", headers=ram, json={"week_start": this_week.isoformat(),
                                                                    "reason": "Started"}).status_code == 409


def test_team_calendar_shows_published_teammates(client, ram, babu):
    week = _monday(47)
    for emp in ("emp-mahesh", "emp-priya"):
        client.post(f"{SH}/roster/assign", headers=ram, json={"employee_id": emp, "work_date": week.isoformat(),
                                                              "shift_id": "sh-general"})
    params = {"from_date": week.isoformat(), "to_date": (week + timedelta(days=6)).isoformat()}
    assert client.get(f"{SH}/team-calendar", headers=babu, params=params).json() == []  # draft: not shown
    client.post(f"{SH}/roster/publish", headers=ram, json={"week_start": week.isoformat(), "allow_gaps": True})
    rows = client.get(f"{SH}/team-calendar", headers=babu, params=params).json()
    assert {r["employee_id"] for r in rows} >= {"emp-mahesh", "emp-priya"}
    too_long = {"from_date": week.isoformat(), "to_date": (week + timedelta(days=90)).isoformat()}
    assert client.get(f"{SH}/team-calendar", headers=babu, params=too_long).status_code == 422


def test_attendance_and_timesheet_use_published_rostered_shift():
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import Employee, RosterShift, RosterWeek
    from app.services import attendance, shifts as rules
    from app.services.timesheets import full_day_hours

    day = _monday(48) + timedelta(days=1)
    with SessionLocal() as db:
        emp = db.get(Employee, "emp-mahesh")
        if db.scalar(select(RosterShift).where(RosterShift.employee_id == emp.id, RosterShift.work_date == day)) is None:
            db.add(RosterShift(id=f"rs-test-att-{day}", employee_id=emp.id, work_date=day, shift_id="sh-evening",
                               manager_id="emp-ram"))
        if rules.roster_week(db, "emp-ram", rules.week_start_of(day)) is None:
            db.add(RosterWeek(manager_id="emp-ram", week_start=rules.week_start_of(day), status="draft"))
        db.flush()
        moment = datetime(day.year, day.month, day.day, 9, 0, tzinfo=UTC)
        draft = attendance.new_session(emp, day, moment, "office", "web", db)
        assert (draft.shift_start, draft.shift_end) == attendance.shift_for(emp)  # a draft roster doesn't count
        rules.roster_week(db, "emp-ram", rules.week_start_of(day)).status = "published"
        db.flush()
        session = attendance.new_session(emp, day, moment, "office", "web", db)
        assert (session.shift_start, session.shift_end) == ("14:00", "22:00")
        assert full_day_hours(db, emp, day) == 7  # 8 h shift less the 1 h break
        db.rollback()


def test_overnight_shift_early_leave():
    from app.services.attendance import apply_flags

    tz = "UTC"
    s = SimpleNamespace(time_zone=tz, work_date=date(2030, 1, 7), shift_start="22:00", shift_end="06:00",
                        check_in=datetime(2030, 1, 7, 22, 10, tzinfo=UTC), check_out=datetime(2030, 1, 8, 5, 0, tzinfo=UTC),
                        break_minutes=0, late_minutes=0, is_late=False, early_minutes=0, is_early_leave=False,
                        worked_minutes=None)
    apply_flags(s)
    assert s.is_late and s.late_minutes == 10
    assert s.is_early_leave and s.early_minutes == 60 and s.worked_minutes == 410
