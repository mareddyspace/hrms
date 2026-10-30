"""Security audit: input validation (422 not 500), injection-style strings, login lockout and throttling, password
change and sessions. Uses throwaway accounts with real passwords so the demo accounts are never locked."""

from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal, utcnow
from app.main import app
from app.models import Account, AuditLog
from app.security import hash_password
from tests.test_audit_auth_surface import PUBLIC, ROUTES, _fill
from tests.test_audit_rbac import audit_accounts_cleanup, real_account, sample_employee  # noqa: F401

API = "/api/v1"
SQLI = ["' OR '1'='1", "\" OR 1=1 --", "'; DROP TABLE employees; --", "%' UNION SELECT password_hash FROM accounts --",
        "\\x00\\x27", "admin'--", "1; SELECT pg_sleep(5)", "${jndi:ldap://x}", "{{7*7}}", "<script>alert(1)</script>"]


@pytest.fixture(scope="module")
def raw_client():
    return TestClient(app, raise_server_exceptions=False)


@pytest.fixture(scope="module")
def fuzz_hr(client):
    return real_account(client, sample_employee("IN", offset=31), "hr_admin")


@pytest.fixture(scope="module")
def fuzz_admin(client):
    return real_account(client, sample_employee("IN", offset=32), "admin")


def _body_routes():
    return [(m, p) for m, p, r in ROUTES if (m, p) not in PUBLIC and m in ("POST", "PUT", "PATCH") and r.dependant.body_params]


@pytest.mark.parametrize("method,path", _body_routes())
def test_wrong_body_types_give_422_not_500(raw_client, fuzz_hr, fuzz_admin, method, path):
    url = _fill(path)
    for h in (fuzz_hr, fuzz_admin):
        for body in ([1, 2, 3], "just a string", 12345, None):
            res = raw_client.request(method, url, headers=h, json=body)
            assert res.status_code in (403, 404, 409, 422), (method, path, body, res.status_code, res.text[:200])
        res = raw_client.request(method, url, headers={**h, "Content-Type": "application/json"}, content=b"{not json")
        assert res.status_code in (403, 404, 409, 422), (method, path, "malformed json", res.status_code)
        assert "Traceback" not in res.text


def _typed_query_routes():
    out = []
    for m, p, r in ROUTES:
        if m != "GET" or (m, p) in PUBLIC:
            continue
        for q in r.dependant.query_params:
            out.append((p, q.name))
    return out


OVERFLOW = pytest.mark.xfail(strict=True, reason="AUD-04: an integer query parameter without an upper bound (people ?page=, "
                                                  "leave/holidays ?year=) overflows the database integer and returns 500")
UNBOUNDED_INTS: set[tuple[str, str]] = set()  # AUD-04 fixed: people ?page= and leave/holidays ?year= are bounded


@pytest.mark.parametrize("path,name", [pytest.param(p, n, marks=OVERFLOW) if (p, n) in UNBOUNDED_INTS else (p, n)
                                       for p, n in _typed_query_routes()])
def test_injection_strings_in_query_params_never_500(raw_client, fuzz_hr, path, name):
    url = _fill(path)
    for payload in SQLI[:4] + ["9" * 40, "-1", "2026-13-45"]:
        res = raw_client.get(url, headers=fuzz_hr, params={name: payload})
        assert res.status_code != 500, (path, name, payload, res.text[:200])
        assert "sqlalchemy" not in res.text.lower() and "psycopg" not in res.text.lower() and "sqlite" not in res.text.lower()


@pytest.mark.parametrize("payload", SQLI)
def test_people_search_injection_matches_nothing(client, fuzz_hr, payload):
    res = client.get(f"{API}/people", headers=fuzz_hr, params={"q": payload})
    assert res.status_code == 200
    body = res.json()
    rows = body["items"] if isinstance(body, dict) else body
    assert rows == [], payload
    assert "$argon2" not in res.text


def test_huge_and_negative_paging(raw_client, fuzz_hr):
    for params in ({"page": 0}, {"page": -1}, {"page_size": 0}, {"page_size": 201}, {"page_size": 10 ** 30}):
        res = raw_client.get(f"{API}/people", headers=fuzz_hr, params=params)
        assert res.status_code in (200, 422), (params, res.status_code)


def test_login_body_validation(raw_client):
    for body in ({}, {"email": "a"}, {"email": "x" * 300, "password": "y"}, {"email": ["a"], "password": 1},
                 {"email": "a@b.c", "password": "p" * 300}):
        assert raw_client.post(f"{API}/auth/login", json=body).status_code == 422, body


# ---------- lockout ----------
def _throwaway(email_prefix="audit.lock") -> tuple[str, str]:
    email, password = f"{email_prefix}.{uuid.uuid4().hex[:8]}@timez.example", "Audit-Lock-2026x"
    with SessionLocal() as db:
        db.add(Account(id=f"audit-{uuid.uuid4().hex[:10]}", email=email, password_hash=hash_password(password),
                       role="employee", employee_id=None, active=True))
        db.commit()
    return email, password


def test_lockout_after_five_wrong_passwords(client):
    email, password = _throwaway()
    for _ in range(5):
        assert client.post(f"{API}/auth/login", json={"email": email, "password": "wrong"}).status_code == 401
    locked = client.post(f"{API}/auth/login", json={"email": email, "password": password})
    assert locked.status_code == 401 and locked.json()["detail"] == "Invalid email or password."  # no lock oracle
    with SessionLocal() as db:
        acc = db.scalar(select(Account).where(Account.email == email))
        assert acc.locked_until is not None and acc.locked_until > utcnow() + timedelta(minutes=10)
        assert db.scalar(select(AuditLog).where(AuditLog.entity_id == acc.id, AuditLog.action == "account_locked"))
        acc.locked_until = utcnow() - timedelta(seconds=1)  # lock over
        db.commit()
    assert client.post(f"{API}/auth/login", json={"email": email, "password": password}).status_code == 200


def test_unknown_and_wrong_password_look_the_same(client):
    email, _ = _throwaway()
    a = client.post(f"{API}/auth/login", json={"email": email, "password": "wrong"})
    b = client.post(f"{API}/auth/login", json={"email": f"nobody-{uuid.uuid4().hex}@timez.example", "password": "wrong"})
    assert a.status_code == b.status_code == 401 and a.json() == b.json()


def test_password_spraying_from_one_client_is_throttled(client):
    statuses = []
    for _ in range(30):
        email, _ = _throwaway("audit.spray")
        statuses.append(client.post(f"{API}/auth/login", json={"email": email, "password": "Summer2026!"}).status_code)
    assert 429 in statuses


# ---------- password change and sessions ----------
def test_password_change_ends_other_sessions(client):
    email, password = _throwaway("audit.pwd")
    a = client.post(f"{API}/auth/login", json={"email": email, "password": password}).json()
    b = client.post(f"{API}/auth/login", json={"email": email, "password": password}).json()
    res = client.post(f"{API}/auth/change-password", headers={"Authorization": f"Bearer {a['access_token']}"},
                      json={"current_password": password, "new_password": "Brand-New-Pass-77"})
    assert res.status_code == 204, res.text
    assert client.post(f"{API}/auth/refresh", json={"refresh_token": b["refresh_token"]}).status_code == 401


def test_change_password_guessing_locks(client):
    email, password = _throwaway("audit.guess")
    a = client.post(f"{API}/auth/login", json={"email": email, "password": password}).json()
    h = {"Authorization": f"Bearer {a['access_token']}"}
    for _ in range(6):
        client.post(f"{API}/auth/change-password", headers=h, json={"current_password": "guess", "new_password": "Xyz-12345"})
    with SessionLocal() as db:
        acc = db.scalar(select(Account).where(Account.email == email))
        assert acc.locked_until is not None


def test_weak_new_passwords_are_refused(client):
    email, password = _throwaway("audit.weak")
    a = client.post(f"{API}/auth/login", json={"email": email, "password": password}).json()
    h = {"Authorization": f"Bearer {a['access_token']}"}
    for new in ("short1", "allletters", "12345678", password, email.split("@")[0] + "-1234"):
        res = client.post(f"{API}/auth/change-password", headers=h, json={"current_password": password, "new_password": new})
        assert res.status_code == 400, new


def test_disabled_account_token_stops_working(client):
    email, password = _throwaway("audit.off")
    a = client.post(f"{API}/auth/login", json={"email": email, "password": password}).json()
    h = {"Authorization": f"Bearer {a['access_token']}"}
    assert client.get(f"{API}/auth/me", headers=h).status_code == 200
    with SessionLocal() as db:
        db.scalar(select(Account).where(Account.email == email)).active = False
        db.commit()
    assert client.get(f"{API}/auth/me", headers=h).status_code == 401
    assert client.post(f"{API}/auth/refresh", json={"refresh_token": a["refresh_token"]}).status_code == 401
