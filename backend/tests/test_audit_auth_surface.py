"""Security audit: the authentication surface of every route, tokens, headers, CORS, error bodies, limits.

Walks the real route table of app.main, so a new router that forgets its auth dependency fails here.
"""

from __future__ import annotations

import re
import uuid
from datetime import timedelta

import jwt
import pytest
from fastapi.routing import APIRoute

from app.config import get_settings
from app.db import utcnow
from app.main import app
from tests.conftest import PASSWORDS, login

# Routes that are meant to work without a token.
PUBLIC = {
    ("POST", "/api/v1/auth/login"), ("POST", "/api/v1/auth/mfa/verify"), ("POST", "/api/v1/auth/refresh"),
    ("POST", "/api/v1/auth/logout"), ("GET", "/health"),
    ("GET", "/api/v1/public/careers"), ("GET", "/api/v1/public/careers/{posting_id}"),
    ("POST", "/api/v1/public/careers/{posting_id}/apply"),
    ("GET", "/api/v1/public/offers/{token}"), ("POST", "/api/v1/public/offers/{token}/respond"),
}


def _deps(dependant, acc: set[str]) -> set[str]:
    for sub in dependant.dependencies:
        if sub.call is not None:
            acc.add(getattr(sub.call, "__name__", type(sub.call).__name__))
        _deps(sub, acc)
    return acc


def _walk(routes, prefix: str = ""):
    for r in routes:
        if type(r).__name__ == "_IncludedRouter":  # FastAPI >= 0.16x keeps included routers lazily
            ctx = r.include_context
            p = getattr(ctx, "prefix", None)
            if p is None and isinstance(ctx, dict):
                p = ctx.get("prefix", "")
            yield from _walk(r.original_router.routes, prefix + (p or ""))
        elif hasattr(r, "routes") and not isinstance(r, APIRoute) and getattr(r, "path", None) is None:
            yield from _walk(r.routes, prefix)
        elif isinstance(r, APIRoute):
            yield prefix + r.path, r


def all_routes() -> list[tuple[str, str, APIRoute]]:
    out, seen = [], set()
    for path, route in _walk(app.routes):
        for method in sorted(route.methods - {"HEAD", "OPTIONS"}):
            if (method, path) not in seen:
                seen.add((method, path))
                out.append((method, path, route))
    return out


ROUTES = all_routes()


def _fill(path: str) -> str:
    return re.sub(r"\{[^}]+\}", "audit-x", path)


def test_inventory_is_large_and_mostly_authenticated():
    assert len(ROUTES) > 400
    public = {(m, p) for m, p, r in ROUTES if "get_current_user" not in _deps(r.dependant, set())}
    assert public == PUBLIC, f"unexpected public routes: {sorted(public - PUBLIC)}"


@pytest.mark.parametrize("method,path", [(m, p) for m, p, _ in ROUTES if (m, p) not in PUBLIC])
def test_no_token_is_rejected(client, method, path):
    res = client.request(method, _fill(path))
    assert res.status_code == 401, (method, path, res.status_code, res.text[:200])
    assert res.headers.get("www-authenticate") == "Bearer"


def _sample(routes, n=40):
    picked = [(m, p) for m, p, _ in routes if (m, p) not in PUBLIC and m == "GET" and "{" not in p]
    return picked[:n]


@pytest.mark.parametrize("method,path", _sample(ROUTES))
def test_bad_tokens_are_rejected(client, method, path):
    secret = get_settings().jwt_secret
    now = utcnow()
    base = {"sub": "emp-mahesh", "role": "admin", "type": "access", "iat": now, "exp": now + timedelta(minutes=5)}
    bad = [
        "not-a-token",
        jwt.encode(base, "wrong-secret-wrong-secret-wrong", algorithm="HS256"),             # forged signature
        jwt.encode(base | {"exp": now - timedelta(seconds=5)}, secret, algorithm="HS256"),   # expired
        jwt.encode(base | {"type": "refresh"}, secret, algorithm="HS256"),                    # wrong token type
        jwt.encode(base | {"type": "mfa"}, secret, algorithm="HS256"),                        # half-finished MFA
        jwt.encode(base | {"sub": "no-such-account"}, secret, algorithm="HS256"),             # unknown account
        jwt.encode(base, "", algorithm="none") if hasattr(jwt, "encode") else "x",            # alg=none
    ]
    for token in bad:
        res = client.request(method, path, headers={"Authorization": f"Bearer {token}"})
        assert res.status_code == 401, (path, token[:30], res.status_code)
    assert client.request(method, path, headers={"Authorization": "Basic YTpi"}).status_code == 401


def test_role_claim_in_token_is_not_trusted(client):
    """The role comes from the account row, not the JWT: an employee token re-signed as admin stays an employee."""
    secret = get_settings().jwt_secret
    now = utcnow()
    token = jwt.encode({"sub": "emp-mahesh", "role": "admin", "type": "access", "iat": now,
                        "exp": now + timedelta(minutes=5), "jti": uuid.uuid4().hex}, secret, algorithm="HS256")
    h = {"Authorization": f"Bearer {token}"}
    assert client.get("/api/v1/auth/me", headers=h).json()["role"] == "employee"
    assert client.get("/api/v1/admin/accounts", headers=h).status_code == 403


# ---------- tokens and sessions ----------
def _fresh_login(client, email):
    res = client.post("/api/v1/auth/login", json={"email": email, "password": PASSWORDS[email]})
    assert res.status_code == 200, res.text
    return res.json()


def test_access_token_expiry_matches_settings(client):
    out = _fresh_login(client, "babu.menon@timez.com")
    claims = jwt.decode(out["access_token"], options={"verify_signature": False})
    s = get_settings()
    assert claims["exp"] - claims["iat"] == s.access_token_minutes * 60 == out["expires_in"]
    assert s.access_token_minutes <= 60
    r = jwt.decode(out["refresh_token"], options={"verify_signature": False})
    assert r["type"] == "refresh" and r["exp"] - r["iat"] == s.refresh_token_days * 86400 and s.refresh_token_days <= 30
    assert jwt.get_unverified_header(out["access_token"])["alg"] == "HS256"


def test_refresh_rotates_and_old_refresh_dies(client):
    out = _fresh_login(client, "babu.menon@timez.com")
    first = client.post("/api/v1/auth/refresh", json={"refresh_token": out["refresh_token"]})
    assert first.status_code == 200
    assert first.json()["refresh_token"] != out["refresh_token"]
    assert client.post("/api/v1/auth/refresh", json={"refresh_token": out["refresh_token"]}).status_code == 401
    # an access token can't be used as a refresh token
    assert client.post("/api/v1/auth/refresh", json={"refresh_token": out["access_token"]}).status_code == 401


def test_refresh_reuse_revokes_the_session(client):
    out = _fresh_login(client, "babu.menon@timez.com")
    first = client.post("/api/v1/auth/refresh", json={"refresh_token": out["refresh_token"]}).json()
    # attacker replays the stolen, already-rotated token
    assert client.post("/api/v1/auth/refresh", json={"refresh_token": out["refresh_token"]}).status_code == 401
    # a reuse should end the whole session: the legitimate successor stops working too
    assert client.post("/api/v1/auth/refresh", json={"refresh_token": first["refresh_token"]}).status_code == 401


def test_logout_invalidates_refresh_and_access(client):
    out = _fresh_login(client, "babu.menon@timez.com")
    h = {"Authorization": f"Bearer {out['access_token']}"}
    assert client.get("/api/v1/auth/me", headers=h).status_code == 200
    assert client.post("/api/v1/auth/logout", json={"refresh_token": out["refresh_token"]}).status_code == 204
    assert client.post("/api/v1/auth/refresh", json={"refresh_token": out["refresh_token"]}).status_code == 401
    assert client.get("/api/v1/auth/me", headers=h).status_code == 401  # the session id in the access token is dead
    # other sessions of the same person are untouched
    assert client.get("/api/v1/auth/me", headers=login(client, "babu.menon@timez.com")).status_code == 200


def test_logout_with_garbage_is_harmless(client):
    assert client.post("/api/v1/auth/logout", json={"refresh_token": "garbage"}).status_code == 204


# ---------- password hashing ----------
def test_password_hash_is_argon2id_with_owasp_parameters():
    from argon2 import extract_parameters
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import Account
    from app.security import _hasher, hash_password

    h = hash_password("Audit-pass-123")
    assert h.startswith("$argon2id$")
    p = extract_parameters(h)
    assert p.memory_cost >= 19 * 1024 and p.time_cost >= 2 and p.parallelism >= 1
    assert _hasher.hash("same") != _hasher.hash("same")  # salted
    with SessionLocal() as db:
        stored = db.scalar(select(Account.password_hash).where(Account.id == "emp-mahesh"))
    assert stored.startswith("$argon2id$") and PASSWORDS["babu.menon@timez.com"] not in stored


# ---------- security headers, CORS, docs ----------
@pytest.mark.parametrize("path", ["/health", "/api/v1/people", "/api/v1/does-not-exist"])
def test_security_headers(client, path):
    res = client.get(path)
    assert res.headers["x-content-type-options"] == "nosniff"
    assert res.headers["x-frame-options"] == "DENY"
    assert "frame-ancestors 'none'" in res.headers["content-security-policy"]
    assert res.headers["referrer-policy"] == "strict-origin-when-cross-origin"
    assert "server" not in {k.lower() for k in res.headers} or "uvicorn" not in res.headers.get("server", "")


def test_cors_allows_only_configured_origins(client):
    allowed = get_settings().cors_origin_list[0]
    pre = {"Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization"}
    ok = client.options("/api/v1/people", headers={"Origin": allowed, **pre})
    assert ok.status_code == 200 and ok.headers["access-control-allow-origin"] == allowed
    for evil in ("https://evil.example", "http://localhost:5173.evil.example", "null", f"{allowed}.evil.example"):
        bad = client.options("/api/v1/people", headers={"Origin": evil, **pre})
        assert bad.headers.get("access-control-allow-origin") is None, evil
        simple = client.get("/health", headers={"Origin": evil})
        assert simple.headers.get("access-control-allow-origin") is None
    assert "*" not in get_settings().cors_origin_list


def test_cors_regex_from_env_example_is_anchored():
    """The documented CORS_ORIGIN_REGEX example must not match look-alike hosts."""
    rx = re.compile(r"^https://hrms(-[a-z0-9-]+)?\.vercel\.app$")
    assert rx.fullmatch("https://hrms-abc.vercel.app")
    assert not rx.fullmatch("https://hrms.vercel.app.evil.example")
    assert not rx.fullmatch("https://evilhrms.vercel.app")


def test_production_hides_docs_and_requires_strong_secret():
    from app.config import Settings, check_jwt_secret

    s = Settings(APP_ENV="production", JWT_SECRET="test-secret-test-secret-test-secret")
    with pytest.raises(RuntimeError):
        check_jwt_secret(s)
    s2 = Settings(APP_ENV="production", JWT_SECRET="short")
    with pytest.raises(RuntimeError):
        check_jwt_secret(s2)


def test_docs_default_off_in_production():
    from app.config import Settings

    assert Settings(APP_ENV="production", JWT_SECRET="x" * 40, _env_file=None).docs_enabled is False


# ---------- error bodies ----------
def test_unhandled_error_has_no_stack_trace(monkeypatch):
    from fastapi.testclient import TestClient

    from app.routers import auth

    def boom(**kwargs):  # noqa: ANN003
        raise RuntimeError("secret-internal-detail /srv/app/db.py line 42")

    monkeypatch.setattr(auth, "MeOut", boom)  # resolved at call time inside auth.me
    c = TestClient(app, raise_server_exceptions=False)
    h = login(c, "babu.menon@timez.com")
    res = c.get("/api/v1/auth/me", headers=h)
    assert res.status_code == 500
    assert "secret-internal-detail" not in res.text and "Traceback" not in res.text
    assert res.json() == {"detail": "Something went wrong on the server. Please try again."}


def test_404_and_405_bodies_are_plain(client, babu):
    assert client.get("/api/v1/nope", headers=babu).json() == {"detail": "Not Found"}
    res = client.delete("/api/v1/auth/me", headers=babu)
    assert res.status_code == 405 and "Traceback" not in res.text


# ---------- pagination limits ----------
def _limit_routes():
    out = []
    for m, p, r in ROUTES:
        if m != "GET" or (m, p) in PUBLIC:
            continue
        names = {q.name for q in r.dependant.query_params}
        for name in ("limit", "page_size"):
            if name in names:
                out.append((p, name))
    return out


LIMIT_ROUTES = _limit_routes()
UNCAPPED: set[tuple[str, str]] = set()  # AUD-10 fixed


@pytest.mark.parametrize("path,name", [x for x in LIMIT_ROUTES if x not in UNCAPPED])
def test_page_size_is_capped(client, farhan, path, name):
    res = client.get(_fill(path), headers=farhan, params={name: 1_000_000})
    assert res.status_code in (404, 422), (path, res.status_code)


def test_career_matches_limit_is_capped(client, farhan):
    res = client.get("/api/v1/career/matches", headers=farhan, params={"limit": 1_000_000})
    assert res.status_code == 422
