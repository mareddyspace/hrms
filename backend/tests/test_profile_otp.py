"""Verification codes for changes to your own personal details (POST /people/me/otp, PATCH /people/me)."""

from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import select

from app.config import get_settings
from app.db import SessionLocal, utcnow
from app.models import AuditLog, EmailOutboxItem, Employee, Notification, PlatformSetting
from app.services import profile_otp
from tests.conftest import login

P = "/api/v1/people"


@pytest.fixture(scope="module")
def jordan(client):
    return login(client, "jordan.blake@timez.com")


@pytest.fixture(autouse=True)
def no_resend_wait(monkeypatch):
    monkeypatch.setattr(profile_otp, "RESEND_SECONDS", 0)


@pytest.fixture()
def echo(monkeypatch):
    monkeypatch.setattr(get_settings(), "otp_dev_echo", True)


def _me(client, headers) -> Employee:
    me_id = client.get("/api/v1/auth/me", headers=headers).json()["employee_id"]
    with SessionLocal() as db:
        emp = db.get(Employee, me_id)
        assert emp is not None
        db.expunge(emp)
        return emp


def _send(client, headers, changes):
    res = client.post(f"{P}/me/otp", headers=headers, json={"changes": changes})
    assert res.status_code == 201, res.text
    return res.json()


def _wrong(code: str) -> str:
    return "000000" if code != "000000" else "111111"


def _clear_lock(emp_id: str) -> None:
    with SessionLocal() as db:
        row = db.get(PlatformSetting, f"profile_otp_lock:{emp_id}")
        if row:
            db.delete(row)
            db.commit()


def test_code_goes_to_the_portal_inbox_and_outbox_not_the_response(client, jordan):
    out = _send(client, jordan, {"mobile": "+44 7700 900111"})
    assert out["required"] is True and out["fields"] == ["mobile"] and out["dev_code"] is None
    assert out["inbox_href"].startswith("/mail?thread=") and out["resend_after"] == 0 and "•" in out["sent_to"]
    emp = _me(client, jordan)
    # The code is in the person's TimeZ Mail inbox, from TimeZ Security.
    inbox = [m for m in client.get("/api/v1/mail", headers=jordan).json() if m["from_name"] == "TimeZ Security"]
    assert inbox and inbox[-1]["to_ids"] == [emp.id] and inbox[-1]["subject"] == "Your TimeZ verification code"
    code = inbox[-1]["body"].split("Your code is ")[1][:6]
    assert code.isdigit() and inbox[-1]["body"] == f"Your code is {code}. It expires in 10 minutes."
    with SessionLocal() as db:
        note = db.scalars(select(Notification).where(Notification.recipient_id == emp.id)
                          .order_by(Notification.id.desc())).first()
        assert note is not None and note.title == "New mail from TimeZ Security" and code not in note.title
        mail = db.scalars(select(EmailOutboxItem).where(EmailOutboxItem.recipient_id == emp.id)
                          .order_by(EmailOutboxItem.id.desc())).first()
        assert mail is not None and mail.to_email == emp.email and code in mail.body
        stored = db.get(PlatformSetting, f"profile_otp:{emp.id}")
        assert stored is not None and "+44 7700 900111" not in str(stored.value) and code not in str(stored.value)
    # The code from the inbox saves the change.
    res = client.patch(f"{P}/me", headers=jordan, json={"mobile": "+44 7700 900111", "otp_code": code})
    assert res.status_code == 200, res.text


def test_change_without_code_is_rejected_and_preferences_need_none(client, jordan):
    for body in ({"mobile": "+44 7700 900999"}, {"address_city": "Leeds"}, {"emergency_name": "Sam"},
                 {"preferred_name": "JB"}, {"personal_email": None}):
        res = client.patch(f"{P}/me", headers=jordan, json=body)
        assert res.status_code == 400 and "verification code" in res.json()["detail"], body
    assert _me(client, jordan).mobile != "+44 7700 900999"
    assert client.patch(f"{P}/me", headers=jordan, json={"career_goals": "Grow.", "languages": ["English"]}).status_code == 200
    assert _send(client, jordan, {"career_goals": "Grow more."}) == {
        "required": False, "fields": [], "sent_to": "", "inbox_href": None, "expires_at": None, "resend_after": 0,
        "dev_code": None}


def test_success_is_tied_to_the_values_single_use_and_audited(client, jordan, echo):
    changes = {"mobile": "+44 7700 900222", "address_city": "Bristol", "emergency_phone": "+44 7700 900777"}
    code = _send(client, jordan, changes)["dev_code"]
    # Different values with the right code are refused.
    res = client.patch(f"{P}/me", headers=jordan, json={**changes, "address_city": "Bath", "otp_code": code})
    assert res.status_code == 400 and "different details" in res.json()["detail"]
    res = client.patch(f"{P}/me", headers=jordan, json={**changes, "career_goals": "Lead.", "otp_code": code})
    assert res.status_code == 200, res.text
    emp = _me(client, jordan)
    assert emp.mobile == "+44 7700 900222" and emp.address_city == "Bristol"
    # Used up.
    res = client.patch(f"{P}/me", headers=jordan, json={"address_city": "Leeds", "otp_code": code})
    assert res.status_code == 400
    with SessionLocal() as db:
        actions = list(db.scalars(select(AuditLog.action).where(AuditLog.entity_id == emp.id).order_by(AuditLog.id.desc()).limit(3)))
    assert actions[:2] == ["updated own profile", "verified profile code"]


def test_wrong_code(client, jordan, echo):
    code = _send(client, jordan, {"address_city": "York"})["dev_code"]
    res = client.patch(f"{P}/me", headers=jordan, json={"address_city": "York", "otp_code": _wrong(code)})
    assert res.status_code == 400 and res.json()["detail"] == "That code is not correct. 4 tries left."
    assert client.patch(f"{P}/me", headers=jordan, json={"address_city": "York", "otp_code": code}).status_code == 200


def test_expired_code(client, jordan, echo):
    code = _send(client, jordan, {"address_city": "Hull"})["dev_code"]
    emp = _me(client, jordan)
    with SessionLocal() as db:
        row = db.get(PlatformSetting, f"profile_otp:{emp.id}")
        row.value = {**row.value, "expires_at": (utcnow() - timedelta(minutes=1)).isoformat()}
        db.commit()
    res = client.patch(f"{P}/me", headers=jordan, json={"address_city": "Hull", "otp_code": code})
    assert res.status_code == 400 and "expired" in res.json()["detail"]
    assert client.patch(f"{P}/me", headers=jordan, json={"address_city": "Hull", "otp_code": code}).status_code == 400


def test_five_wrong_codes_lock_for_fifteen_minutes(client, jordan, echo):
    emp = _me(client, jordan)
    code = _send(client, jordan, {"address_city": "Derby"})["dev_code"]
    for _ in range(4):
        assert client.patch(f"{P}/me", headers=jordan, json={"address_city": "Derby", "otp_code": _wrong(code)}).status_code == 400
    res = client.patch(f"{P}/me", headers=jordan, json={"address_city": "Derby", "otp_code": _wrong(code)})
    assert res.status_code == 429 and res.json()["detail"] == "Too many wrong codes. Try again in 15 minutes."
    # Locked: the right code and a new code are both refused.
    assert client.patch(f"{P}/me", headers=jordan, json={"address_city": "Derby", "otp_code": code}).status_code == 429
    res = client.post(f"{P}/me/otp", headers=jordan, json={"changes": {"address_city": "Derby"}})
    assert res.status_code == 429 and "Try again in 15 minutes" in res.json()["detail"]
    with SessionLocal() as db:
        assert db.scalar(select(AuditLog.id).where(AuditLog.entity_id == emp.id, AuditLog.action == "locked profile verification"))
        row = db.get(PlatformSetting, f"profile_otp_lock:{emp.id}")
        row.value = {"until": (utcnow() - timedelta(seconds=1)).isoformat()}
        db.commit()
    # After the lock ends a new code works.
    code = _send(client, jordan, {"address_city": "Derby"})["dev_code"]
    assert client.patch(f"{P}/me", headers=jordan, json={"address_city": "Derby", "otp_code": code}).status_code == 200
    _clear_lock(emp.id)


def test_resend_waits_thirty_seconds(client, jordan, monkeypatch):
    monkeypatch.setattr(profile_otp, "RESEND_SECONDS", 30)
    _send(client, jordan, {"address_city": "Wells"})
    res = client.post(f"{P}/me/otp", headers=jordan, json={"changes": {"address_city": "Wells"}})
    assert res.status_code == 429 and "seconds before sending another code" in res.json()["detail"]


def test_personal_email_code_also_goes_to_the_new_address(client, jordan, echo):
    new = "Jordan.Otp@example.com"
    out = _send(client, jordan, {"personal_email": new})
    assert out["required"] is True
    emp = _me(client, jordan)
    with SessionLocal() as db:
        mail = db.scalars(select(EmailOutboxItem).where(EmailOutboxItem.recipient_id == emp.id)
                          .order_by(EmailOutboxItem.id.desc())).first()
        assert mail is not None and mail.to_email == new.lower()
    res = client.patch(f"{P}/me", headers=jordan, json={"personal_email": new, "otp_code": out["dev_code"]})
    assert res.status_code == 200, res.text
    assert _me(client, jordan).personal_email == new.lower()


def test_bad_requests_and_hr_needs_no_code(client, jordan, farhan):
    assert client.post(f"{P}/me/otp", headers=jordan, json={"changes": {"mobile": "abc"}}).status_code == 422
    assert client.post(f"{P}/me/otp", headers=jordan, json={"changes": {"first_name": "X"}}).status_code == 422
    assert client.post(f"{P}/me/otp", headers=jordan, json={"field": "mobile", "new_value": "+44 7700 900111"}).status_code == 422
    # HR editing someone else keeps the HR flow.
    target = _me(client, jordan).id
    assert client.patch(f"{P}/{target}", headers=farhan, json={"address_city": "Oxford"}).status_code == 200
