"""Server-side verification codes for own mobile / personal email changes (POST /people/me/otp, PATCH /people/me)."""

from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import select

from app.config import get_settings
from app.db import SessionLocal, utcnow
from app.models import EmailOutboxItem, Employee, PlatformSetting
from tests.conftest import login

P = "/api/v1/people"


@pytest.fixture(scope="module")
def jordan(client):
    return login(client, "jordan.blake@timez.com")


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


def test_code_is_not_returned_unless_dev_echo(client, jordan):
    res = client.post(f"{P}/me/otp", headers=jordan, json={"field": "mobile", "new_value": "+44 7700 900111"})
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["dev_code"] is None and body["field"] == "mobile" and "•" in body["sent_to"]
    emp = _me(client, jordan)
    with SessionLocal() as db:
        mail = db.scalars(select(EmailOutboxItem).where(EmailOutboxItem.recipient_id == emp.id)
                          .order_by(EmailOutboxItem.id.desc())).first()
        assert mail is not None and mail.subject == "Your TimeZ verification code" and mail.to_email == emp.email
        stored = db.get(PlatformSetting, f"profile_otp:{emp.id}:mobile")
        assert stored is not None and "+44 7700 900111" not in str(stored.value)


def test_mobile_change_needs_a_valid_code(client, jordan, echo):
    new = "+44 7700 900222"
    assert client.patch(f"{P}/me", headers=jordan, json={"mobile": new}).status_code == 400
    code = client.post(f"{P}/me/otp", headers=jordan, json={"field": "mobile", "new_value": new}).json()["dev_code"]
    assert code and len(code) == 6
    wrong = "000000" if code != "000000" else "111111"
    res = client.patch(f"{P}/me", headers=jordan, json={"mobile": new, "otp_code": wrong})
    assert res.status_code == 400 and "4 tries left" in res.json()["detail"]
    # The code belongs to the number it was sent for.
    assert client.patch(f"{P}/me", headers=jordan, json={"mobile": "+44 7700 900333", "otp_code": code}).status_code == 400
    res = client.patch(f"{P}/me", headers=jordan, json={"mobile": new, "otp_code": code})
    assert res.status_code == 200, res.text
    assert _me(client, jordan).mobile == new
    # Used up.
    assert client.patch(f"{P}/me", headers=jordan, json={"mobile": "+44 7700 900444", "otp_code": code}).status_code == 400
    # Other fields still save without a code.
    assert client.patch(f"{P}/me", headers=jordan, json={"address_city": "London"}).status_code == 200


def test_personal_email_code_goes_to_the_new_address(client, jordan, echo):
    new = "Jordan.Home@example.com"
    res = client.post(f"{P}/me/otp", headers=jordan, json={"field": "personal_email", "new_value": new})
    assert res.status_code == 201
    emp = _me(client, jordan)
    with SessionLocal() as db:
        mail = db.scalars(select(EmailOutboxItem).where(EmailOutboxItem.recipient_id == emp.id)
                          .order_by(EmailOutboxItem.id.desc())).first()
        assert mail is not None and mail.to_email == new.lower()
    res = client.patch(f"{P}/me", headers=jordan, json={"personal_email": new, "otp_code": res.json()["dev_code"]})
    assert res.status_code == 200, res.text
    assert _me(client, jordan).personal_email == new.lower()


def test_five_wrong_codes_end_it_and_expiry(client, jordan, echo):
    new = "+44 7700 900555"
    code = client.post(f"{P}/me/otp", headers=jordan, json={"field": "mobile", "new_value": new}).json()["dev_code"]
    wrong = "000000" if code != "000000" else "111111"
    for _ in range(5):
        res = client.patch(f"{P}/me", headers=jordan, json={"mobile": new, "otp_code": wrong})
    assert res.status_code == 400 and "Too many" in res.json()["detail"]
    assert client.patch(f"{P}/me", headers=jordan, json={"mobile": new, "otp_code": code}).status_code == 400

    code = client.post(f"{P}/me/otp", headers=jordan, json={"field": "mobile", "new_value": new}).json()["dev_code"]
    emp = _me(client, jordan)
    with SessionLocal() as db:
        row = db.get(PlatformSetting, f"profile_otp:{emp.id}:mobile")
        row.value = {**row.value, "expires_at": (utcnow() - timedelta(minutes=1)).isoformat()}
        db.commit()
    res = client.patch(f"{P}/me", headers=jordan, json={"mobile": new, "otp_code": code})
    assert res.status_code == 400 and "expired" in res.json()["detail"]


def test_bad_requests(client, jordan):
    assert client.post(f"{P}/me/otp", headers=jordan, json={"field": "mobile", "new_value": "abc"}).status_code == 422
    assert client.post(f"{P}/me/otp", headers=jordan, json={"field": "first_name", "new_value": "X"}).status_code == 422
    both = {"mobile": "+44 7700 900666", "personal_email": "x@example.com", "otp_code": "123456"}
    assert client.patch(f"{P}/me", headers=jordan, json=both).status_code == 422
