from tests.conftest import PASSWORDS, login


def test_health(client):
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json()["database"] == "ok"


def test_login_success_and_me(client):
    headers = login(client, "babu.menon@timez.com")
    me = client.get("/api/v1/auth/me", headers=headers).json()
    assert me["account_id"] == "emp-mahesh"
    assert me["employee_id"] == "emp-mahesh"
    assert me["role"] == "employee"
    assert me["scope"] == "self"
    assert me["last_login_at"] is not None


def test_login_is_case_insensitive_on_email(client):
    res = client.post(
        "/api/v1/auth/login", json={"email": "Ram.Krishnan@TimeZ.com", "password": PASSWORDS["ram.krishnan@timez.com"]}
    )
    assert res.status_code == 200


def test_login_failure_is_generic(client):
    wrong = client.post("/api/v1/auth/login", json={"email": "jordan.blake@timez.com", "password": "nope"})
    unknown = client.post("/api/v1/auth/login", json={"email": "nobody@timez.com", "password": "nope"})
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json()["detail"] == unknown.json()["detail"] == "Invalid email or password."
    login(client, "jordan.blake@timez.com")  # a correct login afterwards still works and resets the counter


def test_lockout_after_five_failures(client):
    email = "alex.morgan@timez.com"
    for _ in range(5):
        assert client.post("/api/v1/auth/login", json={"email": email, "password": "bad"}).status_code == 401
    locked = client.post("/api/v1/auth/login", json={"email": email, "password": PASSWORDS[email]})
    assert locked.status_code == 401
    assert locked.json()["detail"] == "Invalid email or password."


def test_requires_token(client):
    assert client.get("/api/v1/people").status_code == 401
    assert client.get("/api/v1/leave/balances").status_code == 401
    assert client.get("/api/v1/notifications").status_code == 401
    assert client.get("/api/v1/auth/me", headers={"Authorization": "Bearer not-a-token"}).status_code == 401


def test_refresh_rotates(client):
    res = client.post(
        "/api/v1/auth/login", json={"email": "sophie.clark@timez.com", "password": PASSWORDS["sophie.clark@timez.com"]}
    )
    refresh = res.json()["refresh_token"]
    first = client.post("/api/v1/auth/refresh", json={"refresh_token": refresh})
    assert first.status_code == 200
    headers = {"Authorization": f"Bearer {first.json()['access_token']}"}
    assert client.get("/api/v1/auth/me", headers=headers).status_code == 200
    # the old refresh token is spent, and an access token is not a refresh token
    assert client.post("/api/v1/auth/refresh", json={"refresh_token": refresh}).status_code == 401
    assert client.post("/api/v1/auth/refresh", json={"refresh_token": first.json()["access_token"]}).status_code == 401


def test_login_returns_previous_sign_in_time(client):
    body = {"email": "farhan.ali@timez.com", "password": PASSWORDS["farhan.ali@timez.com"]}
    client.post("/api/v1/auth/login", json=body)
    second = client.post("/api/v1/auth/login", json=body).json()
    assert second["last_login_at"] is not None


def test_password_change_required_after_90_days(client):
    from datetime import timedelta

    from app.db import SessionLocal, utcnow
    from app.models import Account
    from app.security import hash_password

    email = "jordan.blake@timez.com"
    with SessionLocal() as db:
        acc = db.query(Account).filter(Account.email == email).one()
        acc.last_login_at = utcnow() - timedelta(days=91)
        db.commit()
    try:
        res = client.post("/api/v1/auth/login", json={"email": email, "password": PASSWORDS[email]})
        assert res.status_code == 200 and res.json()["must_change_password"] is True
        headers = {"Authorization": f"Bearer {res.json()['access_token']}"}
        # Everything else is blocked until the password is changed; /auth/me still works.
        assert client.get("/api/v1/people", headers=headers).status_code == 403
        assert client.get("/api/v1/auth/me", headers=headers).json()["must_change_password"] is True
        same = client.post(
            "/api/v1/auth/change-password",
            json={"current_password": PASSWORDS[email], "new_password": PASSWORDS[email]},
            headers=headers,
        )
        assert same.status_code == 400
        weak = client.post(
            "/api/v1/auth/change-password", json={"current_password": PASSWORDS[email], "new_password": "short"}, headers=headers
        )
        assert weak.status_code == 400
        ok = client.post(
            "/api/v1/auth/change-password",
            json={"current_password": PASSWORDS[email], "new_password": "NewPass2026x"},
            headers=headers,
        )
        assert ok.status_code == 204
        assert client.get("/api/v1/people", headers=headers).status_code == 200
        # A recent sign-in doesn't ask again.
        again = client.post("/api/v1/auth/login", json={"email": email, "password": "NewPass2026x"})
        assert again.json()["must_change_password"] is False
    finally:
        with SessionLocal() as db:
            acc = db.query(Account).filter(Account.email == email).one()
            acc.password_hash = hash_password(PASSWORDS[email])
            acc.must_change_password = False
            db.commit()
