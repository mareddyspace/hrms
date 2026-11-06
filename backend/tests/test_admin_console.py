"""Super admin control center: admin-only, real numbers from the database, no secrets."""

from __future__ import annotations

import pytest

from tests.conftest import login
from tests.talent_helpers import token_for

A = "/api/v1/admin"
PATHS = ("/overview", "/audit", "/security/sign-ins", "/security/sessions", "/monitoring")


@pytest.fixture(scope="module")
def alex():
    return token_for("demo-admin", "admin")


def test_only_super_admins(client, babu, ram, farhan):
    jordan = login(client, "jordan.blake@timez.com")
    for headers in (babu, ram, farhan, jordan):
        for path in PATHS:
            assert client.get(f"{A}{path}", headers=headers).status_code == 403, path
    for path in PATHS:
        assert client.get(f"{A}{path}").status_code == 401, path


def test_overview_numbers_come_from_the_database(client, alex):
    from sqlalchemy import func, select

    from app.db import SessionLocal
    from app.models import Account

    body = client.get(f"{A}/overview", headers=alex).json()
    with SessionLocal() as db:
        assert body["accounts_total"] == db.scalar(select(func.count()).select_from(Account))
        assert body["admins_active"] == db.scalar(select(func.count()).select_from(Account).where(
            Account.role.in_(("admin", "super_admin")), Account.active.is_(True)))
    assert body["countries"] >= 8 and body["legal_entities"] >= 1
    assert body["health"]["database"] == "ok" and body["active_sessions"] >= 1


def test_failed_sign_in_for_unknown_email_is_logged_masked(client, alex):
    before = client.get(f"{A}/security/sign-ins", headers=alex, params={"days": 1}).json()["failed"]
    assert client.post("/api/v1/auth/login", json={"email": "nobody.here@timez.com", "password": "Wrong@1234"}).status_code == 401
    after = client.get(f"{A}/security/sign-ins", headers=alex, params={"days": 1, "result": "failure"}).json()
    assert after["failed"] == before + 1
    row = next(r for r in after["items"] if r["action"] == "login_failed_unknown")
    assert "nobody.here@timez.com" not in str(row) and row["actor_id"] is None
    overview = client.get(f"{A}/overview", headers=alex).json()
    assert overview["failed_sign_ins_24h"] >= 1
    assert any(r["action"] == "login_failed_unknown" for r in overview["security_alerts"])


def test_audit_trail_filters_and_paging(client, alex, babu):
    page = client.get(f"{A}/audit", headers=alex, params={"limit": 5}).json()
    assert page["total"] >= len(page["items"]) and len(page["items"]) <= 5
    logins = client.get(f"{A}/audit", headers=alex, params={"action": "login", "limit": 50}).json()
    assert logins["items"] and all(r["action"] == "login" for r in logins["items"])
    assert client.get(f"{A}/audit", headers=alex, params={"limit": 501}).status_code == 422


def test_sessions_and_monitoring_hide_secrets(client, alex, babu):
    sessions = client.get(f"{A}/security/sessions", headers=alex).json()
    assert any(s["email"] == "babu.menon@timez.com" for s in sessions)
    mon = client.get(f"{A}/monitoring", headers=alex).json()
    assert mon["database"]["status"] == "ok" and mon["database"]["migration"]
    assert set(mon["configuration"].values()) <= {"set", "not set", "on", "off", "local disk", "cloud bucket"}
    assert "test-secret" not in str(mon) and "sqlite:///" not in str(mon)


def _qa_account(email: str, role: str = "employee") -> str:
    from app.db import SessionLocal
    from app.models import Account
    from app.security import hash_password

    acc_id = "acc-qa-" + email.split("@")[0].replace(".", "-")
    with SessionLocal() as db:
        if db.get(Account, acc_id) is None:
            db.add(Account(id=acc_id, email=email, password_hash=hash_password("Qa@Pass1234"), role=role,
                           employee_id=None, active=True, failed_attempts=0))
            db.commit()
    return acc_id


def test_user_list_has_status_and_no_secrets(client, alex):
    users = client.get(f"{A}/users", headers=alex).json()
    babu = next(u for u in users if u["email"] == "babu.menon@timez.com")
    assert babu["active"] is True and "password_hash" not in babu and "mfa_secret" not in str(users)


def test_deactivate_reactivate_unlock_and_force_reset(client, alex, babu):
    acc = _qa_account("qa.console@timez.com")
    reason = {"reason": "QA check of account actions"}
    session = client.post("/api/v1/auth/login", json={"email": "qa.console@timez.com", "password": "Qa@Pass1234"})
    assert session.status_code == 200, session.text
    me = {"Authorization": f"Bearer {session.json()['access_token']}"}
    assert client.get("/api/v1/auth/me", headers=me).status_code == 200

    assert client.post(f"{A}/users/{acc}/deactivate", headers=babu, json=reason).status_code == 403
    assert client.post(f"{A}/users/{acc}/deactivate", headers=alex, json={"reason": "x"}).status_code == 422
    res = client.post(f"{A}/users/{acc}/deactivate", headers=alex, json=reason)
    assert res.status_code == 200 and res.json()["active"] is False and res.json()["sessions"] == 0
    assert client.get("/api/v1/auth/me", headers=me).status_code == 401  # signed out at once
    assert client.post("/api/v1/auth/login", json={"email": "qa.console@timez.com", "password": "Qa@Pass1234"}).status_code == 401
    assert client.post(f"{A}/users/{acc}/deactivate", headers=alex, json=reason).status_code == 409
    assert client.post(f"{A}/users/{acc}/reactivate", headers=alex, json=reason).json()["active"] is True

    for _ in range(5):
        client.post("/api/v1/auth/login", json={"email": "qa.console@timez.com", "password": "Wrong@1234"})
    assert any(u["account_id"] == acc and u["locked_until"] for u in client.get(f"{A}/users", headers=alex).json())
    assert client.post(f"{A}/users/{acc}/unlock", headers=alex, json=reason).json()["locked_until"] is None
    assert client.post(f"{A}/users/{acc}/unlock", headers=alex, json=reason).status_code == 409

    res = client.post(f"{A}/users/{acc}/force-password-reset", headers=alex, json=reason)
    assert res.json()["must_change_password"] is True
    trail = client.get(f"{A}/audit", headers=alex, params={"entity": "account", "admins_only": True, "limit": 50}).json()
    done = {r["action"] for r in trail["items"] if r["entity_id"] == acc}
    assert {"account_deactivated", "account_reactivated", "account_unlocked", "password_reset_forced"} <= done


def test_no_action_on_own_account(client, alex):
    assert client.post(f"{A}/users/demo-admin/deactivate", headers=alex, json={"reason": "QA self check"}).status_code == 403
