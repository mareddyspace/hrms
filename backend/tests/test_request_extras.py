"""Request threads (comments, more-information requests, files, audit trail), cash advance settlement, pay-based
limits, expense edits, travel bookings, overtime date checks and document verification (migration 0028).
Uses sample employees (accounts made here) so the demo people's data stays as the other tests expect."""

from datetime import date, timedelta

import pytest
from sqlalchemy import exists, select
from sqlalchemy.orm import aliased

from app.db import SessionLocal
from app.models import Account, CashAdvance, CompensationRecord, Employee, ReminderLog
from app.security import create_access_token
from app.services import jobs, self_service
from app.services.leave import today_for

API = "/api/v1"
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c63f8cfc0f01f0005000201a5f1d6a20000000049454e44ae426082"
)


def token_for(account_id: str, role: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(account_id, role)[0]}"}


def account_for(employee_id: str, role: str = "employee") -> dict[str, str]:
    with SessionLocal() as db:
        acc = db.scalar(select(Account).where(Account.employee_id == employee_id))
        if acc is None:
            acc = Account(id=f"t-rx-{employee_id}", email=f"rx.{employee_id.lower()}@timez.example", password_hash="x",
                          role=role, employee_id=employee_id, active=True)
            db.add(acc)
            db.commit()
        return token_for(acc.id, acc.role)


@pytest.fixture(scope="module")
def pairs() -> list[tuple[str, str]]:
    """(employee, manager) pairs of active Indian sample employees with no reports, unused by other tests."""
    report = aliased(Employee)
    manager = aliased(Employee)
    with SessionLocal() as db:
        rows = db.execute(
            select(Employee.id, Employee.manager_id).join(manager, manager.id == Employee.manager_id).where(
                Employee.source == "hcm_sample", Employee.country_code == "IN", Employee.employment_status == "Active",
                manager.source == "hcm_sample", ~exists().where(report.manager_id == Employee.id),
            ).order_by(Employee.id.desc()).limit(80)
        ).all()
    seen, out = set(), []
    for emp_id, mgr_id in rows:
        if mgr_id not in seen:
            seen.add(mgr_id)
            out.append((emp_id, mgr_id))
    assert len(out) >= 4
    return out


@pytest.fixture(scope="module")
def hr():
    return token_for("demo-hr-admin", "hr_admin")


def _cash(client, who, **extra):
    today = date.today()
    body = {"amount": 1000, "category": "Travel", "purpose": "Site visit", "needed_by": str(today + timedelta(days=3)),
            "instalments": 1} | extra
    return client.post(f"{API}/cash-advances", headers=who, json=body)


def test_cash_limit_follows_the_pay_record(client, pairs):
    emp_id, _ = pairs[0]
    who = account_for(emp_id)
    with SessionLocal() as db:
        emp = db.get(Employee, emp_id)
        standard = self_service.pay_basis(db, emp)[0]
        db.add(CompensationRecord(id=f"comp-rx-{emp_id}", employee_id=emp_id, effective_date=today_for(emp) - timedelta(days=1),
                                  base_salary=1_200_000, currency=emp.currency, grade="L2", reason="Test"))
        db.commit()
        basic, source, annual = self_service.pay_basis(db, emp)
    assert source == "compensation" and annual == 1_200_000
    # Basic is the first pay line's share of the annual pay (same as payslips): 38000 x 1.2M / (54800 x 12).
    assert basic == round(38000 * 1_200_000 / (54800 * 12)) and basic != standard
    policy = client.get(f"{API}/cash-advances/policy", headers=who).json()
    assert policy["pay_source"] == "compensation" and policy["basic_monthly"] == basic
    enc = client.get(f"{API}/encashments/policy", headers=who).json()
    assert enc["per_day"] == round(basic / 22, 2) and enc["pay_source"] == "compensation"


def test_cash_advance_thread_settlement_and_reminders(client, pairs, hr):
    emp_id, mgr_id = pairs[1]
    who, mgr = account_for(emp_id), account_for(mgr_id, "manager")
    today = date.today()
    assert _cash(client, who, currency="USD").status_code == 422
    bad = _cash(client, who, expected_settlement=str(today))
    assert bad.status_code == 422 and "settlement date" in bad.json()["detail"]
    res = _cash(client, who, expected_settlement=str(today + timedelta(days=10)), project="Platform")
    assert res.status_code == 201, res.text
    cid = res.json()["id"]
    assert res.json()["project"] == "Platform"

    # The manager asks for more information; the employee is notified and answers; the flag clears.
    assert client.post(f"{API}/requests/cash_advance/{cid}/comments", headers=who,
                       json={"body": "x", "request_info": True}).status_code == 403
    asked = client.post(f"{API}/requests/cash_advance/{cid}/comments", headers=mgr,
                        json={"body": "Which site?", "request_info": True})
    assert asked.status_code == 201 and asked.json()["info_open"] is True
    assert client.get(f"{API}/cash-advances/{cid}", headers=who).json()["info_requested"] is True
    notes = client.get(f"{API}/notifications?limit=20", headers=who).json()
    assert any("More information needed" in n["title"] for n in notes)
    answered = client.post(f"{API}/requests/cash_advance/{cid}/comments", headers=who, json={"body": "Pune plant"})
    assert answered.json()["comments"][-1]["kind"] == "info_reply" and answered.json()["info_open"] is False
    # Someone unrelated can't see the thread.
    outsider = account_for(pairs[3][0])
    assert client.get(f"{API}/requests/cash_advance/{cid}/thread", headers=outsider).status_code == 404

    # Decline needs a comment; then approve, approve, pay.
    assert client.post(f"{API}/cash-advances/{cid}/decision", headers=mgr, json={"decision": "reject"}).status_code == 422
    assert client.post(f"{API}/cash-advances/{cid}/decision", headers=mgr, json={"decision": "approve"}).status_code == 200
    assert client.post(f"{API}/cash-advances/{cid}/decision", headers=hr, json={"decision": "approve"}).status_code == 200
    paid = client.post(f"{API}/cash-advances/{cid}/pay", headers=hr, json={"reference": "NEFT-1"}).json()
    assert paid["status"] == "Paid" and paid["can_pay"] is False and paid["settlement_due"] == 1000

    # Settlement: receipts first, amounts must add up, a return needs a reference.
    body = {"spent": 700, "returned": 300, "reference": "RET-1"}
    assert "receipts" in client.post(f"{API}/cash-advances/{cid}/settlement", headers=who, json=body).json()["detail"]
    up = client.post(f"{API}/requests/cash_advance/{cid}/attachments?purpose=settlement&filename=bill.png",
                     headers=who | {"Content-Type": "image/png"}, content=PNG)
    assert up.status_code == 201, up.text
    assert client.get(f"{API}/requests/attachments/{up.json()['id']}", headers=hr).status_code == 200
    assert client.get(f"{API}/requests/attachments/{up.json()['id']}", headers=outsider).status_code == 404
    assert client.post(f"{API}/cash-advances/{cid}/settlement", headers=who,
                       json={"spent": 700, "returned": 200, "reference": "R"}).status_code == 422
    assert client.post(f"{API}/cash-advances/{cid}/settlement", headers=who,
                       json={"spent": 700, "returned": 300}).status_code == 422
    settled = client.post(f"{API}/cash-advances/{cid}/settlement", headers=who, json=body)
    assert settled.status_code == 200 and settled.json()["settlement_status"] == "Submitted"
    assert client.post(f"{API}/cash-advances/{cid}/settlement/decision", headers=who,
                       json={"decision": "verify"}).status_code == 403
    done = client.post(f"{API}/cash-advances/{cid}/settlement/decision", headers=hr, json={"decision": "verify"}).json()
    assert done["status"] == "Settled" and done["outstanding"] == 0
    # Settled: the next advance can be asked for.
    assert client.get(f"{API}/cash-advances/policy", headers=who).json()["open_id"] is None
    trail = client.get(f"{API}/requests/cash_advance/{cid}/thread", headers=who).json()["audit"]
    actions = [a["action"] for a in trail]
    assert "cash_advance_submitted" in actions and "cash_advance_settlement_verified" in actions

    # Overdue settlement reminder: once a day.
    with SessionLocal() as db:
        row = CashAdvance(id="cash-rx-overdue", employee_id=emp_id, amount=500, currency="INR", category="Travel",
                          purpose="x", needed_by=today - timedelta(days=20), instalments=1, status="Paid",
                          paid_on=today - timedelta(days=15), expected_settlement=today - timedelta(days=2))
        db.add(row)
        db.commit()
        assert self_service.settlement_overdue(row, today)
        assert self_service.send_settlement_reminders(db, today, jobs._send) == 1
        assert self_service.send_settlement_reminders(db, today, jobs._send) == 0
        assert db.scalar(select(ReminderLog.id).where(ReminderLog.item_key == "cash-settle:cash-rx-overdue")) is not None
        db.delete(row)
        db.commit()


def test_expense_details_edit_and_mandatory_decline_comment(client, pairs):
    emp_id, mgr_id = pairs[2]
    who, mgr = account_for(emp_id), account_for(mgr_id, "manager")
    day = str(date.today() - timedelta(days=2))
    res = client.post(f"{API}/expenses", headers=who, json={
        "category": "Internet", "amount": 400, "date": day, "description": "Home broadband",
        "details": {"provider": "ACT", "billing_period": "Oct 2026"}})
    assert res.status_code == 201, res.text
    claim = res.json()
    assert claim["details"]["provider"] == "ACT" and claim["can_edit"] is True
    cid = claim["id"]
    assert client.patch(f"{API}/expenses/{cid}", headers=who, json={"amount": 450}).status_code == 422  # more: refile
    edited = client.patch(f"{API}/expenses/{cid}", headers=who, json={"amount": 350, "description": "Broadband (Oct)"})
    assert edited.status_code == 200 and edited.json()["amount"] == 350
    assert client.patch(f"{API}/expenses/{cid}", headers=mgr, json={"amount": 300}).status_code == 404
    assert client.post(f"{API}/expenses/{cid}/decision", headers=mgr, json={"decision": "reject"}).status_code == 422
    out = client.post(f"{API}/expenses/{cid}/decision", headers=mgr, json={"decision": "reject", "note": "Personal plan"})
    assert out.status_code == 200 and out.json()["status"] == "rejected" and out.json()["can_edit"] is False
    assert client.patch(f"{API}/expenses/{cid}", headers=who, json={"amount": 300}).status_code == 409


def test_travel_details_and_booking(client, pairs, hr):
    emp_id, mgr_id = pairs[3]
    who, mgr = account_for(emp_id), account_for(mgr_id, "manager")
    start = date.today() + timedelta(days=20)
    res = client.post(f"{API}/travel", headers=who, json={
        "purpose": "Client workshop", "from_location": "Pune", "to_location": "Delhi", "start_date": str(start),
        "end_date": str(start + timedelta(days=1)), "mode": "road", "estimated_cost": 5000,
        "details": {"mode": "Bus", "seat": "Sleeper"}})
    assert res.status_code == 201, res.text
    tid = res.json()["id"]
    assert res.json()["details"]["mode"] == "Bus"
    assert client.put(f"{API}/travel/{tid}/booking", headers=who, json={"booking": {"ticket": "X"}}).status_code == 409
    client.post(f"{API}/travel/{tid}/decision", headers=mgr, json={"decision": "approve"})
    trip = client.get(f"{API}/travel/{tid}", headers=who).json()
    if trip["status"] != "approved":
        client.post(f"{API}/travel/{tid}/decision", headers=hr, json={"decision": "approve"})
    booked = client.put(f"{API}/travel/{tid}/booking", headers=hr, json={"booking": {"ticket": "PNR 1", "reference": " B-9 "}})
    assert booked.status_code == 200 and booked.json()["booking"] == {"ticket": "PNR 1", "reference": "B-9"}
    assert client.put(f"{API}/travel/{tid}/booking", headers=mgr, json={"booking": {"ticket": "Y"}}).status_code == 403


def test_overtime_day_check(client, pairs):
    emp_id, _ = pairs[0]
    who = account_for(emp_id)
    day = date.today() - timedelta(days=3)
    check = client.get(f"{API}/overtime/attendance", headers=who, params={"work_date": str(day)}).json()
    assert check["eligible"] is True and check["shift_start"] and check["day_type"] in ("working", "weekend", "holiday", "leave")
    assert client.get(f"{API}/overtime/attendance", headers=who, params={"work_date": str(date.today())}).json()["eligible"] is False
    res = client.post(f"{API}/overtime", headers=who, json={"work_date": str(day), "hours": 2, "reason": "Release"})
    assert res.status_code == 201, res.text
    again = client.get(f"{API}/overtime/attendance", headers=who, params={"work_date": str(day)}).json()
    assert again["eligible"] is False and again["existing_id"] == res.json()["id"]
    assert client.post(f"{API}/overtime", headers=who, json={"work_date": str(day), "hours": 13, "reason": "x"}).status_code in (409, 422)


def test_document_verification_categories_and_expiry_reminders(client, pairs, hr):
    emp_id, _ = pairs[1]
    who = account_for(emp_id)
    rules = client.get(f"{API}/documents/rules", headers=who).json()
    labels = {c["name"]: c["label"] for c in rules["category_config"]}
    assert labels["Identity"] == "Identity proofs" and labels["Payroll"] == "Payroll & tax"
    up = client.post(f"{API}/documents", headers=who | {"Content-Type": "image/png"}, content=PNG,
                     params={"category": "Education", "title": "Degree", "filename": "degree.png", "description": "B.Tech"})
    assert up.status_code == 201, up.text
    doc = up.json()
    assert doc["verification_status"] == "pending" and doc["description"] == "B.Tech"
    # Employees can't upload HR-only categories.
    assert client.post(f"{API}/documents", headers=who | {"Content-Type": "image/png"}, content=PNG,
                       params={"category": "Payroll", "title": "Slip", "filename": "s.png"}).status_code == 403
    assert any(d["id"] == doc["id"] for d in client.get(f"{API}/documents/verification-queue", headers=hr).json())
    assert client.post(f"{API}/documents/{doc['id']}/verification", headers=who, json={"decision": "verify"}).status_code == 403
    assert client.post(f"{API}/documents/{doc['id']}/verification", headers=hr, json={"decision": "reject"}).status_code == 422
    rejected = client.post(f"{API}/documents/{doc['id']}/verification", headers=hr,
                           json={"decision": "reject", "note": "Blurred"}).json()
    assert rejected["verification_status"] == "rejected" and rejected["verification_note"] == "Blurred"
    # A new version goes back to pending.
    again = client.post(f"{API}/documents/{doc['id']}/versions", headers=who | {"Content-Type": "image/png"}, content=PNG,
                        params={"filename": "degree2.png"})
    assert again.status_code == 201 and again.json()["verification_status"] == "pending"
    # Category configuration is HR / admin only.
    config = [{"name": c["name"], "label": c["label"], "verification": c["verification"],
               "employee_upload": c["employee_upload"]} for c in rules["category_config"]]
    assert client.put(f"{API}/documents/categories", headers=who, json=config).status_code == 403
    assert client.put(f"{API}/documents/categories", headers=hr, json=config).status_code == 200
    # Expiry reminders: one per threshold.
    client.patch(f"{API}/documents/{doc['id']}", headers=who, json={"expiry_date": str(date.today() + timedelta(days=5))})
    from app.services.documents import send_expiry_reminders

    with SessionLocal() as db:
        first = send_expiry_reminders(db, date.today(), jobs._send)
        db.commit()
        assert first >= 1
        assert send_expiry_reminders(db, date.today(), jobs._send) == 0
