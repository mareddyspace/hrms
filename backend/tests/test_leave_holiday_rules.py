"""Holiday applicability by type / office / entity (migration 0032) and leave balance bookkeeping end to end."""

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import delete, select

from app.db import SessionLocal
from app.models import AuditLog, EncashmentRequest, Employee, Holiday, LeaveCarryForward, OptionalHoliday
from app.services import holiday_rules
from app.services.leave import balances, holiday_dates_for, working_days, weekly_off_for_employee
from app.services.leave_rules import run_carry_forward

L = "/api/v1/admin/leave"


def _names(rows) -> set[str]:
    return {h.name for h in rows}


# ---------- holiday data ----------
def test_india_offices_get_about_twelve_days_off():
    with SessionLocal() as db:
        y0, y1 = date(2026, 1, 1), date(2026, 12, 31)
        counts = {loc: len(holiday_rules.rows_for(db, "IN", y0, y1, location=loc)) for loc in ("Bengaluru", "Hyderabad", "Mumbai")}
        assert counts == {"Bengaluru": 12, "Hyderabad": 12, "Mumbai": 12}, counts
        common = holiday_rules.rows_for(db, "IN", y0, y1)  # no office: national + company only
        assert {holiday_rules.kind(h) for h in common} == {"national", "company"} and len(common) == 9
        blr = _names(holiday_rules.rows_for(db, "IN", y0, y1, location="Bengaluru"))
        mum = _names(holiday_rules.rows_for(db, "IN", y0, y1, location="Mumbai"))
        assert {"Republic Day", "Independence Day", "Gandhi Jayanti", "Ugadi / Gudi Padwa"} <= blr
        assert "Ganesh Chaturthi" in mum and "Ganesh Chaturthi" not in blr
        assert "Holi" not in blr and "Holi" not in mum  # optional now: picked, not given to everyone
        chennai = _names(holiday_rules.rows_for(db, "IN", y0, y1, location="Chennai"))
        kochi = _names(holiday_rules.rows_for(db, "IN", y0, y1, location="Kochi"))
        assert "Thai Pongal" in chennai and "Thiruvonam (Onam)" in kochi and "Thiruvonam (Onam)" not in blr
        # the festivals taken off the common list are offered as optional picks, nothing deleted
        optional = list(db.scalars(select(Holiday).where(Holiday.country_code == "IN", Holiday.holiday_type == "optional",
                                                         Holiday.date <= y1)))
        assert len(optional) == 13 and all(h.active for h in optional)
        picks = {o.date for o in db.scalars(select(OptionalHoliday).where(OptionalHoliday.country_code == "IN"))}
        assert {h.date for h in optional} <= picks
        # other countries: state holidays by office
        assert "Melbourne Cup Day" in _names(holiday_rules.rows_for(db, "AU", y0, y1, location="Melbourne"))
        assert "Melbourne Cup Day" not in _names(holiday_rules.rows_for(db, "AU", y0, y1, location="Sydney"))
        assert "Fronleichnam" in _names(holiday_rules.rows_for(db, "DE", y0, y1, location="Munich"))
        assert "Fronleichnam" not in _names(holiday_rules.rows_for(db, "DE", y0, y1, location="Berlin"))
        assert len(holiday_rules.rows_for(db, "US", y0, y1, location="Austin")) == 10


def test_classification_is_fill_blank_and_idempotent():
    with SessionLocal() as db:
        again = holiday_rules.classify_seeded(db)
        assert again == {"holidays_typed": 0, "regional_holidays_added": 0, "optional_picks_added": 0}
        row = db.get(Holiday, "h-holi")
        row.holiday_type = "company"  # HR's choice is kept
        db.flush()
        holiday_rules.classify_seeded(db)
        assert db.get(Holiday, "h-holi").holiday_type == "company"
        db.rollback()


def test_my_holidays_and_working_days_follow_my_office(client, babu):
    listed = client.get("/api/v1/leave/holidays", headers=babu, params={"year": 2026}).json()
    assert len(listed) == 12 and all(h["applies"] for h in listed)
    assert {h["holiday_type"] for h in listed} == {"national", "company", "regional"}
    ugadi = next(h for h in listed if h["name"].startswith("Ugadi"))
    assert "Karnataka" in ugadi["regions"]
    every = client.get("/api/v1/leave/holidays", headers=babu, params={"year": 2026, "all_locations": True}).json()
    ganesh = next(h for h in every if h["name"] == "Ganesh Chaturthi")
    assert ganesh["applies"] is False and not any(h["holiday_type"] == "optional" for h in every)
    with SessionLocal() as db:
        emp = db.get(Employee, "emp-mahesh")
        off = holiday_dates_for(db, emp, date(2026, 3, 1), date(2026, 3, 31))
        week = weekly_off_for_employee(db, emp)
        assert date(2026, 3, 19) in off and date(2026, 3, 3) not in off  # Ugadi off, Holi a working day
        assert working_days(date(2026, 3, 16), date(2026, 3, 20), off, "none", week) == 4
        assert working_days(date(2026, 3, 3), date(2026, 3, 3), off, "first", week) == 0.5
        assert working_days(date(2026, 3, 19), date(2026, 3, 19), off, "first", week) == 0  # half day on a holiday


def test_admin_holiday_types_validation_and_audit(client, babu, farhan):
    day = date(2031, 7, 15)
    bad = client.post(f"{L}/holidays", headers=farhan, json={"country_code": "IN", "date": day.isoformat(),
                                                             "name": "State day", "holiday_type": "regional"})
    assert bad.status_code == 422 and "state or location" in bad.json()["detail"]
    bad = client.post(f"{L}/holidays", headers=farhan, json={"country_code": "IN", "date": day.isoformat(), "name": "X",
                                                             "holiday_type": "national", "regions": ["Kerala"]})
    assert bad.status_code == 422
    ka = client.post(f"{L}/holidays", headers=farhan, json={"country_code": "IN", "date": day.isoformat(), "name": "KA day",
                                                            "holiday_type": "regional", "regions": ["Karnataka"]})
    mh = client.post(f"{L}/holidays", headers=farhan, json={"country_code": "IN", "date": day.isoformat(), "name": "MH day",
                                                            "holiday_type": "regional", "regions": ["Maharashtra", " "]})
    assert ka.status_code == 201 and mh.status_code == 201, (ka.text, mh.text)
    assert mh.json()["regions"] == ["Maharashtra"]
    dup = client.post(f"{L}/holidays", headers=farhan, json={"country_code": "IN", "date": day.isoformat(), "name": "Again",
                                                             "holiday_type": "regional", "regions": ["karnataka"]})
    assert dup.status_code == 409
    try:
        mine = client.get("/api/v1/leave/holidays", headers=babu, params={"year": 2031}).json()
        assert {h["name"] for h in mine if h["date"] == day.isoformat()} == {"KA day"}  # Babu works in Bengaluru
        by_type = client.get(f"{L}/holidays", headers=farhan, params={"country": "IN", "year": 2031, "holiday_type": "regional"}).json()
        assert {h["name"] for h in by_type} >= {"KA day", "MH day"}
        at_mumbai = client.get(f"{L}/holidays", headers=farhan, params={"country": "IN", "year": 2031, "location": "Mumbai"}).json()
        assert "MH day" in {h["name"] for h in at_mumbai} and "KA day" not in {h["name"] for h in at_mumbai}
        res = client.put(f"{L}/holidays/{ka.json()['id']}", headers=farhan, json={"holiday_type": "optional"})
        assert res.status_code == 200 and res.json()["holiday_type"] == "optional"
        with SessionLocal() as db:
            assert db.get(OptionalHoliday, f"oh-{ka.json()['id']}") is not None  # offered as a pick
            audit = db.scalar(select(AuditLog).where(AuditLog.entity_id == ka.json()["id"], AuditLog.action == "holiday_updated"))
            assert audit.changes["after"]["holiday_type"] == "optional"
        assert client.get(f"{L}/holiday-locations", headers=babu).status_code == 403
        offices = client.get(f"{L}/holiday-locations", headers=farhan, params={"country": "IN", "year": 2026}).json()
        blr = next(o for o in offices if o["location"] == "Bengaluru")
        assert blr["region"] == "Karnataka" and blr["days_off"] == 12 and blr["by_type"]["regional"] == 3
    finally:
        for h in (ka, mh):
            client.delete(f"{L}/holidays/{h.json()['id']}", headers=farhan)
        with SessionLocal() as db:
            db.execute(delete(OptionalHoliday).where(OptionalHoliday.id == f"oh-{ka.json()['id']}"))
            db.commit()


# ---------- balances ----------
def _bal(client, headers, code: str, year: int) -> dict:
    rows = client.get("/api/v1/leave/balances", headers=headers, params={"year": year}).json()["balances"]
    return next(r for r in rows if r["code"] == code)


def _free_day(client, headers, start: date) -> date:
    hols = {h["date"] for h in client.get("/api/v1/leave/holidays", headers=headers, params={"year": start.year}).json()}
    day = start
    while day.weekday() >= 5 or day.isoformat() in hols:
        day += timedelta(days=1)
    return day


def _apply(client, headers, code, start, end=None, half="none"):
    return client.post("/api/v1/leave/requests", headers=headers, json={
        "leave_code": code, "from": start.isoformat(), "to": (end or start).isoformat(), "half": half, "reason": "Balance test"})


def test_balance_moves_with_every_decision(client, babu, ram):
    today = datetime.now(ZoneInfo("Asia/Kolkata")).date()
    year = today.year + 1
    day = _free_day(client, babu, date(year, 6, 8))
    base = _bal(client, babu, "casual", year)

    half = _apply(client, babu, "casual", day, half="first")
    assert half.status_code == 201 and half.json()["days"] == 0.5
    b = _bal(client, babu, "casual", year)
    assert b["pending"] == base["pending"] + 0.5 and b["available"] == base["available"] - 0.5 and b["used"] == base["used"]
    rej = client.post(f"/api/v1/leave/requests/{half.json()['id']}/decision", headers=ram, json={"decision": "reject", "note": "Busy"})
    assert rej.json()["status"] == "rejected"
    assert _bal(client, babu, "casual", year) == base  # reject gives the pending days back

    monday = day - timedelta(days=day.weekday()) + timedelta(days=7)
    friday_to_monday = _apply(client, babu, "casual", monday - timedelta(days=3), monday)
    assert friday_to_monday.status_code == 201 and friday_to_monday.json()["days"] == 2  # the weekend isn't counted
    wd = client.post(f"/api/v1/leave/requests/{friday_to_monday.json()['id']}/cancel", headers=babu)
    assert wd.json()["status"] == "withdrawn" and _bal(client, babu, "casual", year) == base

    one = _apply(client, babu, "casual", day)
    ok = client.post(f"/api/v1/leave/requests/{one.json()['id']}/decision", headers=ram, json={"decision": "approve"})
    assert ok.json()["status"] == "approved"
    b = _bal(client, babu, "casual", year)
    assert b["used"] == base["used"] + 1 and b["left"] == base["left"] - 1 and b["pending"] == base["pending"]
    cancelled = client.post(f"/api/v1/leave/requests/{one.json()['id']}/cancel", headers=babu)
    assert cancelled.json()["status"] == "cancelled"
    assert _bal(client, babu, "casual", year) == base  # cancelling approved future leave restores it
    too_many = _apply(client, babu, "casual", day, day + timedelta(days=30))
    assert too_many.status_code == 422 and "available" in too_many.json()["detail"]


def test_encashment_reduces_available_and_carry_forward(client, babu):
    year = 2032
    with SessionLocal() as db:
        db.add(EncashmentRequest(id="enc-test-2032", employee_id="emp-mahesh", leave_code="pto", year=year, days=4,
                                 per_day=100, amount=400, currency="INR", status="Submitted"))
        db.commit()
    try:
        pending = _bal(client, babu, "pto", year)
        assert pending["pending"] == 4 and pending["available"] == pending["left"] - 4
        with SessionLocal() as db:
            db.get(EncashmentRequest, "enc-test-2032").status = "Approved"
            db.commit()
        paid = _bal(client, babu, "pto", year)
        assert paid["used"] == 4 and paid["pending"] == 0 and paid["available"] == pending["available"]
        with SessionLocal() as db:  # year-end job: encashed days are not carried as well
            out = run_carry_forward(db, year + 1)
            assert out["created"] > 0
            row = db.scalar(select(LeaveCarryForward).where(LeaveCarryForward.employee_id == "emp-mahesh",
                                                            LeaveCarryForward.leave_code == "pto",
                                                            LeaveCarryForward.to_year == year + 1))
            assert row.unused == 14 and row.days == 10  # 18 - 4 encashed, capped at 10
            db.rollback()
        with SessionLocal() as db:
            db.get(EncashmentRequest, "enc-test-2032").status = "Withdrawn"
            db.commit()
        assert _bal(client, babu, "pto", year)["used"] == 0
    finally:
        with SessionLocal() as db:
            db.execute(delete(EncashmentRequest).where(EncashmentRequest.id == "enc-test-2032"))
            db.commit()


def test_no_carry_forward_before_joining():
    with SessionLocal() as db:
        emp = db.get(Employee, "emp-mahesh")
        joined = emp.joining_date
        try:
            carried = {b.code: b.carried_over for b in balances(db, emp, 2035)}
            assert carried["pto"] == 10  # worked all of 2034: capped carry-forward
            emp.joining_date = date(2035, 2, 1)
            db.flush()
            assert {b.code: b.carried_over for b in balances(db, emp, 2035)}["pto"] == 0
        finally:
            emp.joining_date = joined
            db.rollback()


def test_policy_encashable_flag_and_validation(client, babu, farhan):
    year = datetime.now(ZoneInfo("Asia/Kolkata")).date().year
    bal = {r["code"]: r for r in client.get("/api/v1/leave/balances", headers=babu, params={"year": year}).json()["balances"]}
    assert bal["pto"]["encashable"] is True and bal["casual"]["encashable"] is False  # default: privilege leave only
    pid = "casual-IN-2026"
    assert client.put(f"{L}/policies/{pid}", headers=babu, json={"encashable": True}).status_code == 403
    bad = client.put(f"{L}/policies/{pid}", headers=farhan, json={"carry_forward_max": 50})
    assert bad.status_code == 422 and "Carry-forward" in bad.json()["detail"]
    assert client.put(f"{L}/policies/{pid}", headers=farhan, json={"quota": -1}).status_code == 422
    try:
        res = client.put(f"{L}/policies/{pid}", headers=farhan, json={"encashable": True})
        assert res.status_code == 200 and res.json()["encashable"] is True
        bal = {r["code"]: r for r in client.get("/api/v1/leave/balances", headers=babu, params={"year": year}).json()["balances"]}
        assert bal["casual"]["encashable"] is True
        with SessionLocal() as db:
            from app.services.self_service import encash_policy

            casual = next(t for t in encash_policy(db, db.get(Employee, "emp-mahesh"))["types"] if t["code"] == "casual")
            assert casual["why_not"] != "Not encashable"
            audit = db.scalar(select(AuditLog).where(AuditLog.entity_id == pid, AuditLog.action == "leave_policy_updated")
                              .order_by(AuditLog.id.desc()))
            assert audit.changes["after"]["encashable"] is True
    finally:
        client.put(f"{L}/policies/{pid}", headers=farhan, json={"encashable": None})
    with SessionLocal() as db:
        from app.models import LeavePolicy

        assert db.get(LeavePolicy, pid).encashable is None
