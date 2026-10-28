"""Two-step sign-in (TOTP + backup codes), the admin MFA policy, signed-in devices and auth audit rows.

Uses its own throwaway accounts so other tests' sign-ins and sessions are never touched."""

import time

import pyotp
import pytest
from sqlalchemy import select

from app.db import SessionLocal
from app.models import Account, AuditLog, PlatformSetting, RefreshToken
from app.security import hash_password
from app.services import mfa

AUTH = "/api/v1/auth"
SEC = "/api/v1/security"
PASSWORD = "Tester@4242"


def _make_account(account_id: str, email: str, role: str) -> None:
    with SessionLocal() as db:
        if db.get(Account, account_id) is None:
            db.add(Account(id=account_id, email=email, password_hash=hash_password(PASSWORD), role=role, employee_id=None,
                           active=True, failed_attempts=0))
            db.commit()


def _login(client, email: str, ua: str = "pytest") -> dict:
    res = client.post(f"{AUTH}/login", json={"email": email, "password": PASSWORD}, headers={"User-Agent": ua})
    assert res.status_code == 200, res.text
    return res.json()


def _h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture(scope="module")
def mfa_user():
    _make_account("test-mfa-user", "mfa.tester@timez.com", "employee")
    return "mfa.tester@timez.com"


def test_mfa_setup_login_backup_and_disable(client, mfa_user):
    first = _login(client, mfa_user)
    assert first["mfa_required"] is False and first["access_token"]
    headers = _h(first["access_token"])
    assert client.get(f"{SEC}/mfa", headers=headers).json()["enabled"] is False

    setup = client.post(f"{SEC}/mfa/setup", headers=headers).json()
    assert setup["otpauth_uri"].startswith("otpauth://totp/") and "TimeZ" in setup["otpauth_uri"]
    totp = pyotp.TOTP(setup["secret"])
    assert client.post(f"{SEC}/mfa/enable", headers=headers, json={"code": "000000" if totp.now() != "000000" else "111111"}).status_code == 400
    code = totp.now()
    enabled = client.post(f"{SEC}/mfa/enable", headers=headers, json={"code": code})
    assert enabled.status_code == 200, enabled.text
    backup = enabled.json()["backup_codes"]
    assert len(backup) == 10 and len(set(backup)) == 10
    status_ = client.get(f"{SEC}/mfa", headers=headers).json()
    assert status_["enabled"] is True and status_["backup_codes_left"] == 10
    assert client.post(f"{SEC}/mfa/setup", headers=headers).status_code == 409
    with SessionLocal() as db:
        stored = db.scalar(select(Account).where(Account.email == mfa_user))
        assert all(c not in (stored.mfa_backup_codes or []) for c in backup)  # only hashes are kept

    # password step now asks for a code and issues no tokens
    step = _login(client, mfa_user)
    assert step["mfa_required"] is True and step["mfa_token"] and step["access_token"] == ""
    assert client.get(f"{AUTH}/me", headers=_h(step["mfa_token"])).status_code == 401  # not an access token
    # the code used to switch it on can't be replayed
    assert client.post(f"{AUTH}/mfa/verify", json={"mfa_token": step["mfa_token"], "code": code}).status_code == 401
    # a backup code works once
    ok = client.post(f"{AUTH}/mfa/verify", json={"mfa_token": step["mfa_token"], "code": backup[0].upper()})
    assert ok.status_code == 200, ok.text
    assert ok.json()["access_token"] and client.get(f"{AUTH}/me", headers=_h(ok.json()["access_token"])).status_code == 200
    again = _login(client, mfa_user)
    assert client.post(f"{AUTH}/mfa/verify", json={"mfa_token": again["mfa_token"], "code": backup[0]}).status_code == 401
    # a fresh TOTP code (next time step) works
    next_code = totp.generate_otp(int(time.time() // 30) + 1)
    res = client.post(f"{AUTH}/mfa/verify", json={"mfa_token": again["mfa_token"], "code": next_code})
    assert res.status_code == 200, res.text
    headers = _h(res.json()["access_token"])
    assert client.get(f"{SEC}/mfa", headers=headers).json()["backup_codes_left"] == 9
    assert client.post(f"{AUTH}/mfa/verify", json={"mfa_token": "x" * 20, "code": "123456"}).status_code == 401

    renewed = client.post(f"{SEC}/mfa/backup-codes", headers=headers, json={"password": PASSWORD}).json()["backup_codes"]
    assert len(renewed) == 10 and backup[1] not in renewed
    assert client.post(f"{SEC}/mfa/disable", headers=headers, json={"password": "wrong"}).status_code == 400
    off = client.post(f"{SEC}/mfa/disable", headers=headers, json={"password": PASSWORD})
    assert off.status_code == 200 and off.json()["enabled"] is False
    assert _login(client, mfa_user)["mfa_required"] is False  # back to one step

    with SessionLocal() as db:
        rows = list(db.scalars(select(AuditLog).where(AuditLog.actor_id == "test-mfa-user")))
        actions = {r.action for r in rows}
        assert {"mfa_enabled", "mfa_disabled", "login_mfa_challenge", "mfa_failed", "login"} <= actions
        failed = next(r for r in rows if r.action == "mfa_failed")
        assert failed.result == "failure" and failed.user_agent == "testclient"
        assert next(r for r in rows if r.action == "login").result == "success"


def test_failed_login_audit_has_result_and_user_agent(client, mfa_user):
    res = client.post(f"{AUTH}/login", json={"email": mfa_user, "password": "nope"}, headers={"User-Agent": "Audit Browser 1"})
    assert res.status_code == 401
    with SessionLocal() as db:
        row = db.scalar(select(AuditLog).where(AuditLog.actor_id == "test-mfa-user", AuditLog.action == "login_failed")
                        .order_by(AuditLog.id.desc()))
        assert row.result == "failure" and row.user_agent == "Audit Browser 1" and row.ip
        db.get(Account, "test-mfa-user").failed_attempts = 0
        db.commit()


def test_policy_requires_mfa_for_admin_and_hr(client, mfa_user):
    _make_account("test-mfa-admin", "mfa.admin@timez.com", "admin")
    admin = _h(_login(client, "mfa.admin@timez.com")["access_token"])
    employee = _h(_login(client, mfa_user)["access_token"])
    assert client.put(f"{SEC}/mfa-policy", headers=employee, json={"require_mfa_admin_hr": True}).status_code == 403
    try:
        assert client.put(f"{SEC}/mfa-policy", headers=admin, json={"require_mfa_admin_hr": True}).json() == {
            "require_mfa_admin_hr": True}
        res = _login(client, "mfa.admin@timez.com")
        assert res["mfa_setup_required"] is True
        headers = _h(res["access_token"])
        assert client.get("/api/v1/people", headers=headers).status_code == 403
        assert client.get(f"{SEC}/mfa", headers=headers).json()["setup_required"] is True
        assert client.get(f"{AUTH}/me", headers=headers).status_code == 200
        assert client.get("/api/v1/people", headers=employee).status_code == 200  # employees aren't affected
        # once set up, everything works again
        secret = client.post(f"{SEC}/mfa/setup", headers=headers).json()["secret"]
        assert client.post(f"{SEC}/mfa/enable", headers=headers, json={"code": pyotp.TOTP(secret).now()}).status_code == 200
        assert client.get("/api/v1/people", headers=headers).status_code == 200
        assert client.post(f"{SEC}/mfa/disable", headers=headers, json={"password": PASSWORD}).status_code == 409
    finally:
        with SessionLocal() as db:
            row = db.get(PlatformSetting, mfa.POLICY_KEY)
            if row is not None:
                row.value = False
            db.commit()


def test_sessions_list_and_revoke(client):
    _make_account("test-sess-user", "sess.tester@timez.com", "employee")
    a = _login(client, "sess.tester@timez.com", ua="Laptop Chrome")
    b = _login(client, "sess.tester@timez.com", ua="Phone Safari")
    sessions = client.get(f"{SEC}/sessions", headers=_h(a["access_token"])).json()
    assert len(sessions) == 2 and sessions[0]["current"] is True and sessions[0]["user_agent"] == "Laptop Chrome"
    assert {s["user_agent"] for s in sessions} == {"Laptop Chrome", "Phone Safari"}

    # a refresh keeps the same device
    rotated = client.post(f"{AUTH}/refresh", json={"refresh_token": a["refresh_token"]}, headers={"User-Agent": "Laptop Chrome"}).json()
    after = client.get(f"{SEC}/sessions", headers=_h(rotated["access_token"])).json()
    assert len(after) == 2 and {s["session_id"] for s in after} == {s["session_id"] for s in sessions}
    assert next(s for s in after if s["current"])["started_at"] == sessions[0]["started_at"]

    assert client.delete(f"{SEC}/sessions/nope", headers=_h(rotated["access_token"])).status_code == 404
    assert client.post(f"{SEC}/sessions/revoke-others", headers=_h(rotated["access_token"])).json() == {"revoked": 1}
    assert client.get(f"{AUTH}/me", headers=_h(b["access_token"])).status_code == 401  # ended at once
    assert client.post(f"{AUTH}/refresh", json={"refresh_token": b["refresh_token"]}).status_code == 401
    assert client.get(f"{AUTH}/me", headers=_h(rotated["access_token"])).status_code == 200

    # admin can see and end another account's sessions; others can't
    _make_account("test-sess-admin", "sess.admin@timez.com", "admin")
    admin = _h(_login(client, "sess.admin@timez.com")["access_token"])
    assert client.post(f"{SEC}/accounts/test-sess-user/sessions/revoke", headers=_h(rotated["access_token"])).status_code == 403
    listed = client.get(f"{SEC}/accounts/test-sess-user/sessions", headers=admin)
    assert listed.status_code == 200 and len(listed.json()) == 1
    assert client.post(f"{SEC}/accounts/test-sess-user/sessions/revoke", headers=admin).json() == {"revoked": 1}
    assert client.get(f"{AUTH}/me", headers=_h(rotated["access_token"])).status_code == 401

    # sign out ends that device only
    c = _login(client, "sess.tester@timez.com", ua="Tablet")
    d = _login(client, "sess.tester@timez.com", ua="Desktop")
    assert client.post(f"{AUTH}/logout", json={"refresh_token": c["refresh_token"]}).status_code == 204
    assert client.get(f"{AUTH}/me", headers=_h(c["access_token"])).status_code == 401
    assert [s["user_agent"] for s in client.get(f"{SEC}/sessions", headers=_h(d["access_token"])).json()] == ["Desktop"]
    with SessionLocal() as db:
        actions = set(db.scalars(select(AuditLog.action).where(AuditLog.entity_id == "test-sess-user")))
        assert {"sessions_revoked_others", "sessions_revoked_by_admin", "logout"} <= actions
        assert db.scalar(select(RefreshToken).where(RefreshToken.account_id == "test-sess-user",
                                                    RefreshToken.ip.is_not(None))) is not None
