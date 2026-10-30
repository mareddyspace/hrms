"""Compliance calendar: sample statutory dates, people items within 30/60/90 days, HR-only, 7-day alerts."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from app.db import SessionLocal
from app.models import ComplianceDueDate, Employee, Notification, ReminderLog
from app.services import compliance_calendar as rules
from app.services.jobs import _send


def test_sample_dates_seeded_and_occurrences():
    with SessionLocal() as db:
        pf = db.get(ComplianceDueDate, "cd-in-pf")
        assert pf is not None and pf.day == 15 and pf.frequency == "monthly"
        assert rules.occurrences(pf, date(2026, 10, 1), date(2026, 12, 31)) == [date(2026, 10, 15), date(2026, 11, 15), date(2026, 12, 15)]
        f941 = db.get(ComplianceDueDate, "cd-us-941")
        assert rules.occurrences(f941, date(2026, 1, 1), date(2026, 12, 31)) == [
            date(2026, 1, 31), date(2026, 4, 30), date(2026, 7, 31), date(2026, 10, 31)]
        assert db.get(ComplianceDueDate, "cd-gb-paye").day == 22


def test_calendar_items_and_filters(client, farhan, babu):
    assert client.get("/api/v1/compliance-calendar", headers=babu).status_code == 403
    res = client.get("/api/v1/compliance-calendar", params={"days": 90}, headers=farhan)
    assert res.status_code == 200, res.text
    items = res.json()
    kinds = {i["kind"] for i in items}
    assert {"statutory", "visa", "contract"} <= kinds
    assert all(0 <= i["days_left"] <= 90 for i in items)
    assert [i["date"] for i in items] == sorted(i["date"] for i in items)
    assert any(i["sample"] for i in items if i["kind"] == "statutory")
    person = next(i for i in items if i["kind"] == "contract")
    assert person["href"] == f"/people/{person['employee_id']}"
    india = client.get("/api/v1/compliance-calendar", params={"country": "IN", "kind": "statutory", "days": 30}, headers=farhan).json()
    assert india and all(i["country_code"] == "IN" and i["kind"] == "statutory" for i in india)
    short = client.get("/api/v1/compliance-calendar", params={"days": 30}, headers=farhan).json()
    assert len(short) <= len(items)


def test_probation_end_item(client, farhan):
    with SessionLocal() as db:
        emp = db.get(Employee, "emp-mahesh")
        original = emp.joining_date
        today = date.today()
        emp.joining_date = date(today.year if today.month > 6 else today.year - 1, (today.month - 6 - 1) % 12 + 1, min(today.day, 28)) + timedelta(days=20)
        db.commit()
    try:
        items = client.get("/api/v1/compliance-calendar", params={"kind": "probation", "days": 60}, headers=farhan).json()
        assert any(i["employee_id"] == "emp-mahesh" for i in items)
    finally:
        with SessionLocal() as db:
            db.get(Employee, "emp-mahesh").joining_date = original
            db.commit()


def test_due_date_crud(client, farhan, ram):
    body = {"country_code": "IN", "name": "LWF contribution", "frequency": "annual", "day": 15, "months": [1]}
    assert client.post("/api/v1/compliance-calendar/due-dates", json=body, headers=ram).status_code == 403
    bad = client.post("/api/v1/compliance-calendar/due-dates", json={**body, "months": []}, headers=farhan)
    assert bad.status_code == 422
    res = client.post("/api/v1/compliance-calendar/due-dates", json=body, headers=farhan)
    assert res.status_code == 201, res.text
    row = res.json()
    upd = client.put(f"/api/v1/compliance-calendar/due-dates/{row['id']}", json={**body, "active": False}, headers=farhan)
    assert upd.status_code == 200 and upd.json()["active"] is False
    assert any(r["id"] == row["id"] for r in client.get("/api/v1/compliance-calendar/due-dates", headers=farhan).json())


def test_hr_alert_seven_days_before_once():
    with SessionLocal() as db:
        today = date.today()
        emp = db.get(Employee, "emp-ram")
        before = emp.contract_end_date
        emp.contract_end_date = today + timedelta(days=7)
        db.flush()
        sent = rules.run_alerts(db, today, _send)
        assert sent >= 1
        assert rules.run_alerts(db, today, _send) == 0  # once per day per HR person
        note = db.query(Notification).filter(Notification.recipient_id == "demo-hr-admin",
                                             Notification.title.like("Due in 7 days: Contract ends%")).first()
        assert note is not None and note.href == "/people/emp-ram"
        assert db.query(ReminderLog).filter(ReminderLog.item_key == "compliance:contract:emp-ram").count() >= 1
        emp.contract_end_date = before
        db.rollback()
