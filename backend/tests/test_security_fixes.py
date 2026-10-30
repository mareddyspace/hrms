"""Security fixes from the audit: docs behind sign-in in production, sign-in throttle, password age, sessions."""

from __future__ import annotations

import base64
import uuid
from datetime import timedelta

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal, utcnow
from app.models import Account
from app.security import hash_password
from app.services import login_throttle
from tests.conftest import PASSWORDS

API = "/api/v1"


def _basic(email: str, password: str) -> dict[str, str]:
    return {"Authorization": "Basic " + base64.b64encode(f"{email}:{password}".encode()).decode()}


def test_production_docs_need_a_portal_sign_in():
    from app import docs_auth

    app = FastAPI(title="docs test", docs_url=None, openapi_url=None)

    @app.get("/ping")
    def ping() -> dict[str, str]:
        return {"ok": "yes"}

    docs_auth.install(app)
    c = TestClient(app)
    for path in ("/docs", "/openapi.json"):
        res = c.get(path)
        assert res.status_code == 401 and res.headers["www-authenticate"].startswith("Basic")
        assert c.get(path, headers=_basic("babu.menon@timez.com", "wrong-password")).status_code == 401
        assert c.get(path, headers={"Authorization": "Basic !!notbase64"}).status_code == 401
    ok = _basic("babu.menon@timez.com", PASSWORDS["babu.menon@timez.com"])
    assert "swagger" in c.get("/docs", headers=ok).text.lower()
    assert "/ping" in c.get("/openapi.json", headers=ok).json()["paths"]
    with SessionLocal() as db:  # the two wrong tries counted toward the lockout; reset for other tests
        acc = db.scalar(select(Account).where(Account.email == "babu.menon@timez.com"))
        acc.failed_attempts, acc.locked_until = 0, None
        db.commit()


def test_docs_default_on_in_development():
    from app.config import Settings

    assert Settings(APP_ENV="development", JWT_SECRET="x" * 40, _env_file=None).docs_enabled is True
    assert Settings(APP_ENV="production", JWT_SECRET="x" * 40, DOCS_ENABLED="true", _env_file=None).docs_enabled is True


def test_ip_throttle_answers_429_with_retry_after(client):
    for _ in range(login_throttle.MAX_FAILURES):
        client.post(f"{API}/auth/login", json={"email": f"nobody-{uuid.uuid4().hex}@timez.example", "password": "x"})
    res = client.post(f"{API}/auth/login", json={"email": "babu.menon@timez.com", "password": PASSWORDS["babu.menon@timez.com"]})
    assert res.status_code == 429 and int(res.headers["retry-after"]) > 0
    login_throttle.reset()
    assert client.post(f"{API}/auth/login", json={"email": "babu.menon@timez.com",
                                                  "password": PASSWORDS["babu.menon@timez.com"]}).status_code == 200


def test_unknown_password_age_starts_the_clock_instead_of_forcing_a_change(client):
    email, password = f"audit.age-{uuid.uuid4().hex[:8]}@timez.example", "Age-Check-2026x"
    with SessionLocal() as db:
        db.add(Account(id=f"audit-age-{uuid.uuid4().hex[:8]}", email=email, password_hash=hash_password(password),
                       role="employee", active=True, last_login_at=utcnow() - timedelta(days=400)))
        db.commit()
    res = client.post(f"{API}/auth/login", json={"email": email, "password": password})
    assert res.status_code == 200 and res.json()["must_change_password"] is False
    with SessionLocal() as db:
        acc = db.scalar(select(Account).where(Account.email == email))
        assert acc.password_changed_at is not None
        acc.active = False
        db.commit()


def test_password_change_keeps_this_session(client):
    email, password = f"audit.keep-{uuid.uuid4().hex[:8]}@timez.example", "Keep-This-2026x"
    with SessionLocal() as db:
        db.add(Account(id=f"audit-keep-{uuid.uuid4().hex[:8]}", email=email, password_hash=hash_password(password),
                       role="employee", active=True))
        db.commit()
    a = client.post(f"{API}/auth/login", json={"email": email, "password": password}).json()
    b = client.post(f"{API}/auth/login", json={"email": email, "password": password}).json()
    h = {"Authorization": f"Bearer {a['access_token']}"}
    assert client.post(f"{API}/auth/change-password", headers=h,
                       json={"current_password": password, "new_password": "Brand-New-Pass-88"}).status_code == 204
    assert client.get(f"{API}/auth/me", headers=h).status_code == 200  # this device stays signed in
    assert client.post(f"{API}/auth/refresh", json={"refresh_token": a["refresh_token"]}).status_code == 200
    assert client.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {b['access_token']}"}).status_code == 401
    with SessionLocal() as db:
        db.scalar(select(Account).where(Account.email == email)).active = False
        db.commit()


def test_admin_and_executive_keep_org_wide_counts(client):
    """Admin / CEO lost HR data about strangers, but org-wide aggregates still work for them."""
    from app.security import create_access_token

    for account_id, role in (("demo-admin", "admin"), ("demo-ceo", "executive")):  # test_auth may lock Alex's sign-in
        h = {"Authorization": f"Bearer {create_access_token(account_id, role)[0]}"}
        res = client.get(f"{API}/onboarding/analytics", headers=h)
        assert res.status_code == 200, res.text
        people = client.get(f"{API}/people", headers=h, params={"page_size": 5}).json()
        assert people["total"] > 400  # the directory still lists everyone (basic fields)
