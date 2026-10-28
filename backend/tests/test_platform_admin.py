"""Admin platform: data scope read from the database, page access, AI settings, email outbox switches,
reminders once per day, integrations quarantine."""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import func, select

from app.db import SessionLocal, utcnow
from app.models import EmailOutboxItem, Employee, ReminderLog, TimesheetWeek
from app.services.activity import notify
from app.services.jobs import send_due_reminders
from tests.talent_helpers import token_for

A = "/api/v1/admin"


def admin():
    return token_for("demo-admin", "admin")


def test_data_scope_is_read_from_the_database(client, babu, ram):
    # default: Babu (employee) can't open Ram's leave balances
    assert client.get("/api/v1/leave/balances", headers=babu, params={"employee_id": "emp-ram"}).status_code == 404
    assert client.put(f"{A}/accounts/emp-mahesh/data-scope", headers=babu, json={"scope": "global"}).status_code == 403
    try:
        res = client.put(f"{A}/accounts/emp-mahesh/data-scope", headers=admin(), json={"scope": "department"})
        assert res.status_code == 200 and res.json() == {"account_id": "emp-mahesh", "scope": "department", "countries": [],
                                                         "custom": True}
        # same department (Engineering): now visible; another department still not
        assert client.get("/api/v1/leave/balances", headers=babu, params={"employee_id": "emp-ram"}).status_code == 200
        assert client.get("/api/v1/leave/balances", headers=babu, params={"employee_id": "demo-hr-admin"}).status_code == 404
        # Ram limited to his own record loses his team
        assert client.put(f"{A}/accounts/emp-ram/data-scope", headers=admin(), json={"scope": "own"}).status_code == 200
        assert client.get("/api/v1/leave/balances", headers=ram, params={"employee_id": "emp-mahesh"}).status_code == 404
    finally:
        client.put(f"{A}/accounts/emp-mahesh/data-scope", headers=admin(), json={"scope": "line"})
        client.put(f"{A}/accounts/emp-ram/data-scope", headers=admin(), json={"scope": "line"})
    assert client.get(f"{A}/accounts/emp-mahesh/data-scope", headers=babu).json()["custom"] is False
    assert client.get("/api/v1/leave/balances", headers=babu, params={"employee_id": "emp-ram"}).status_code == 404
    assert client.get("/api/v1/leave/balances", headers=ram, params={"employee_id": "emp-mahesh"}).status_code == 200


def test_hr_country_limit_from_database(client, farhan):
    try:
        res = client.put(f"{A}/accounts/demo-hr-admin/data-scope", headers=admin(), json={"scope": "global", "countries": ["in"]})
        assert res.json()["countries"] == ["IN"]
        assert client.get("/api/v1/auth/me", headers=farhan).json()["scope_countries"] == ["IN"]
        assert client.get("/api/v1/leave/balances", headers=farhan, params={"employee_id": "demo-ceo"}).status_code == 404  # US
    finally:
        client.put(f"{A}/accounts/demo-hr-admin/data-scope", headers=admin(), json={"scope": "global", "countries": []})
    assert client.get("/api/v1/auth/me", headers=farhan).json()["scope_countries"] is None


def test_page_access_and_ai_settings(client, babu):
    assert client.put(f"{A}/accounts/demo-admin/page-access", headers=admin(), json={"grant": ["payslips"]}).status_code == 403
    res = client.put(f"{A}/accounts/emp-mahesh/page-access", headers=admin(), json={"grant": ["reports"], "revoke": ["home", "learning"]})
    assert res.status_code == 200 and res.json()["revoke"] == ["learning"]  # Home can't be removed
    assert client.get(f"{A}/page-access/me", headers=babu).json()["grant"] == ["reports"]
    assert client.delete(f"{A}/accounts/emp-mahesh/page-access", headers=admin()).json()["custom"] is False
    assert client.put(f"{A}/ai-settings", headers=babu, json={"disabled_features": ["jdWriter"]}).status_code == 403
    assert client.put(f"{A}/ai-settings", headers=admin(), json={"disabled_features": ["nope"]}).status_code == 422
    res = client.put(f"{A}/ai-settings", headers=admin(), json={"disabled_features": ["jdWriter"], "disabled_agents": ["agent-x"]})
    assert res.json()["disabled_features"] == ["jdWriter"]
    assert client.get(f"{A}/ai-settings", headers=babu).json()["disabled_agents"] == ["agent-x"]
    client.put(f"{A}/ai-settings", headers=admin(), json={"disabled_features": [], "disabled_agents": []})


def _queued(db, recipient: str, title: str) -> int:
    return db.scalar(select(func.count()).select_from(EmailOutboxItem).where(
        EmailOutboxItem.recipient_id == recipient, EmailOutboxItem.subject == title)) or 0


def test_email_outbox_respects_channel_switches(client):
    switches = {s["channel"]: s for s in client.get(f"{A}/email-switches", headers=admin()).json()}
    assert switches["approvals"]["email"] is True and switches["learning"]["email"] is False
    with SessionLocal() as db:
        notify(db, recipient_id="emp-mahesh", title="Outbox check A", body="b", href="/leave/requests/x")
        notify(db, recipient_id="emp-mahesh", title="Outbox check B", body="b", href="/learning/courses/1")
        notify(db, recipient_id="emp-mahesh", title="Outbox check C", body="b", href="/cases/1")
        db.commit()
        assert _queued(db, "emp-mahesh", "Outbox check A") == 1  # approvals channel on
        assert _queued(db, "emp-mahesh", "Outbox check B") == 0  # learning email off
        assert _queued(db, "emp-mahesh", "Outbox check C") == 1  # general: always
        row = db.scalar(select(EmailOutboxItem).where(EmailOutboxItem.subject == "Outbox check A"))
        assert row.channel == "approvals" and row.category == "Leave" and row.to_email == "babu.menon@timez.com"
        assert row.notification_id is not None
    assert client.put(f"{A}/email-switches/approvals", headers=admin(), json={"email": False}).status_code == 200
    try:
        with SessionLocal() as db:
            notify(db, recipient_id="emp-mahesh", title="Outbox check D", body="b", href="/approvals/apr-1")
            db.commit()
            assert _queued(db, "emp-mahesh", "Outbox check D") == 0
    finally:
        client.put(f"{A}/email-switches/approvals", headers=admin(), json={"email": True})
    queued = client.get(f"{A}/email-outbox", headers=admin(), params={"status": "Queued", "recipient_id": "emp-mahesh"}).json()
    ids = [e["id"] for e in queued if e["subject"].startswith("Outbox check")]
    assert len(ids) == 2
    assert client.post(f"{A}/email-outbox/mark-sent", headers=admin(), json={"ids": ids}).json()["marked"] == 2
    assert client.post(f"{A}/email-outbox/mark-sent", headers=admin(), json={"ids": ids}).json()["marked"] == 0


def test_reminders_once_per_day(client):
    with SessionLocal() as db:
        emp = db.scalar(select(Employee).where(Employee.source == "hcm_sample", Employee.manager_id.is_not(None)).order_by(Employee.id))
        week = TimesheetWeek(id="tsw-reminder-test", employee_id=emp.id, week_start=(utcnow() - timedelta(days=14)).date(),
                             status="submitted", submitted_at=utcnow() - timedelta(days=3))
        db.add(week)
        db.commit()
        now = utcnow()
        send_due_reminders(db, now)
        db.commit()
        key = "timesheet:tsw-reminder-test"
        count = lambda: db.scalar(select(func.count()).select_from(ReminderLog).where(ReminderLog.item_key == key))  # noqa: E731
        assert count() == 1
        send_due_reminders(db, now + timedelta(hours=2))  # same day: nothing new for this item
        db.commit()
        assert count() == 1
        send_due_reminders(db, now + timedelta(days=1))  # next day: reminded again
        db.commit()
        assert count() == 2
        log = db.scalar(select(ReminderLog).where(ReminderLog.item_key == key))
        assert log.recipient_id == emp.manager_id
        db.delete(db.get(TimesheetWeek, "tsw-reminder-test"))
        db.commit()


def test_integrations_quarantine_flow(client, babu, farhan):
    assert client.get(f"{A}/integrations", headers=babu).status_code == 403
    # HR can read connectors, runs and quarantine, but not act
    assert client.get(f"{A}/integrations", headers=farhan).status_code == 200
    assert client.get(f"{A}/integrations/payroll/runs", headers=farhan).status_code == 200
    assert client.get(f"{A}/integrations/payroll/quarantine", headers=farhan).status_code == 200
    assert client.post(f"{A}/integrations/payroll/run", headers=farhan).status_code == 403
    assert client.put(f"{A}/integrations/payroll/schedule", headers=farhan, json={"schedule": "manual"}).status_code == 403
    connectors = {c["id"]: c for c in client.get(f"{A}/integrations", headers=admin()).json()}
    assert {"payroll", "benefits", "sso", "slack"} <= set(connectors)
    assert client.post(f"{A}/integrations/slack/run", headers=admin()).status_code == 409  # not configured
    run = client.post(f"{A}/integrations/payroll/run", headers=admin()).json()
    assert run["processed"] == 24 and run["failed"] >= 1
    open_ = client.get(f"{A}/integrations/payroll/quarantine", headers=admin()).json()
    assert len(open_) == run["failed"]
    rec = open_[0]
    fix = {"bankAccount": "123456789012", "taxId": "ABCDE1234F", "costCentre": "CC-100", "workEmail": "x@timez.com"}[rec["field"]]
    assert client.post(f"{A}/integrations/payroll/quarantine/{rec['id']}/fix", headers=admin(), json={"value": "bad"}).status_code == 422
    res = client.post(f"{A}/integrations/payroll/quarantine/{rec['id']}/fix", headers=admin(), json={"value": fix})
    assert res.json()["ok"] is True and res.json()["record"]["status"] == "resolved"
    if rec["field"] in ("bankAccount", "taxId"):
        assert res.json()["record"]["value"] != fix  # masked
    if len(open_) > 1:
        other = open_[1]["id"]
        res = client.post(f"{A}/integrations/payroll/quarantine/{other}/dismiss", headers=admin(), json={"reason": "Left the company"})
        assert res.json()["record"]["status"] == "dismissed"
    assert client.put(f"{A}/integrations/payroll/schedule", headers=admin(), json={"schedule": "manual"}).json()["next_run_at"] is None
    assert client.get(f"{A}/integrations/payroll/runs", headers=admin()).json()[0]["id"] == run["id"]
    with SessionLocal() as db:  # failures alert admin (and HR for payroll) -> integrations emails
        assert db.scalar(select(func.count()).select_from(EmailOutboxItem).where(EmailOutboxItem.channel == "integrations")) >= 1
