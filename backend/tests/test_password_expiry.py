"""Password age: seeded demo passwords start fresh, every demo account can change its password, and a password
older than 90 days forces a change at the next sign-in."""

from __future__ import annotations

from datetime import timedelta

from app import seed
from app.db import SessionLocal, utcnow
from app.models import Account
from app.routers import auth
from app.security import hash_password
from tests.conftest import PASSWORDS


def _account(db, email: str) -> Account:
    return db.query(Account).filter(Account.email == email).one()


def _aware(dt):
    from datetime import timezone

    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def test_seeded_demo_passwords_are_not_expired(client):
    # Re-seed (as a deploy does), then every demo password must be fresh. Other tests may have locked an account.
    with SessionLocal() as db:
        seed.seed_accounts(db, reset_passwords=True)
        db.commit()
    with SessionLocal() as db:
        for email in PASSWORDS:
            acc = _account(db, email)
            assert acc.password_changed_at is not None, email
            assert utcnow() - _aware(acc.password_changed_at) < timedelta(days=90), email
    for email, password in PASSWORDS.items():
        res = client.post("/api/v1/auth/login", json={"email": email, "password": password})
        assert res.status_code == 200, (email, res.text)
        assert res.json()["must_change_password"] is False, email


def test_reseeding_with_reset_restarts_the_password_clock():
    email = "oliver.hughes@timez.com"
    with SessionLocal() as db:
        _account(db, email).password_changed_at = utcnow() - timedelta(days=400)
        db.commit()
    with SessionLocal() as db:
        seed.seed_accounts(db, reset_passwords=True)
        db.commit()
    with SessionLocal() as db:
        assert utcnow() - _aware(_account(db, email).password_changed_at) < timedelta(minutes=5)


def test_seeding_fills_a_missing_change_date():
    email = "priya.nair@timez.com"
    with SessionLocal() as db:
        _account(db, email).password_changed_at = None
        db.commit()
    with SessionLocal() as db:
        seed.seed_accounts(db, reset_passwords=False)
        db.commit()
    with SessionLocal() as db:
        assert _account(db, email).password_changed_at is not None


def test_every_demo_account_can_change_its_password(client, monkeypatch):
    # Other tests hold session-wide tokens for these accounts: keep them signed in.
    monkeypatch.setattr(auth, "_revoke_sessions", lambda *args, **kwargs: 0)
    for email, password in PASSWORDS.items():
        res = client.post("/api/v1/auth/login", json={"email": email, "password": password})
        headers = {"Authorization": f"Bearer {res.json()['access_token']}"}
        wrong = client.post("/api/v1/auth/change-password", headers=headers,
                            json={"current_password": "not-it-1", "new_password": "Fresh2026pass"})
        assert wrong.status_code == 400, email
        no_digit = client.post("/api/v1/auth/change-password", headers=headers,
                               json={"current_password": password, "new_password": "OnlyLettersHere"})
        assert no_digit.status_code == 400, email
        try:
            ok = client.post("/api/v1/auth/change-password", headers=headers,
                             json={"current_password": password, "new_password": "Fresh2026pass"})
            assert ok.status_code == 204, (email, ok.text)
            again = client.post("/api/v1/auth/login", json={"email": email, "password": "Fresh2026pass"})
            assert again.status_code == 200 and again.json()["must_change_password"] is False, email
        finally:
            with SessionLocal() as db:
                acc = _account(db, email)
                acc.password_hash = hash_password(password)
                acc.password_changed_at = utcnow()
                acc.must_change_password = False
                acc.failed_attempts, acc.locked_until = 0, None
                db.commit()


def test_password_older_than_90_days_forces_a_change(client, monkeypatch):
    monkeypatch.setattr(auth, "_revoke_sessions", lambda *args, **kwargs: 0)
    email = "sophie.clark@timez.com"
    with SessionLocal() as db:
        _account(db, email).password_changed_at = utcnow() - timedelta(days=95)
        db.commit()
    try:
        res = client.post("/api/v1/auth/login", json={"email": email, "password": PASSWORDS[email]})
        assert res.json()["must_change_password"] is True
        headers = {"Authorization": f"Bearer {res.json()['access_token']}"}
        assert client.get("/api/v1/celebrations", headers=headers).status_code == 403
        ok = client.post("/api/v1/auth/change-password", headers=headers,
                         json={"current_password": PASSWORDS[email], "new_password": "Renewed2026x"})
        assert ok.status_code == 204
        assert client.get("/api/v1/celebrations", headers=headers).status_code == 200
    finally:
        with SessionLocal() as db:
            acc = _account(db, email)
            acc.password_hash = hash_password(PASSWORDS[email])
            acc.password_changed_at = utcnow()
            acc.must_change_password = False
            db.commit()
