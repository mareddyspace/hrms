"""Swagger UI (/docs) and /openapi.json in production, behind a sign-in.

Only used when APP_ENV=production and DOCS_ENABLED=true (in development FastAPI serves the docs openly). The browser
asks for a portal account's e-mail and password (HTTP Basic); wrong passwords count toward the account lockout and
the per-IP sign-in throttle, like /auth/login. Two-step sign-in (MFA) is not asked here: these pages only show the
API description, never data. To call the API from Swagger, use "Authorize" with a bearer token as usual.

The routes are plain Starlette routes (not in the OpenAPI schema).
"""

from __future__ import annotations

import base64
import binascii

from fastapi import FastAPI, Request
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.responses import JSONResponse, Response
from sqlalchemy import func, select

from app.db import SessionLocal, utcnow
from app.deps import client_ip
from app.models import Account
from app.security import verify_password
from app.services import login_throttle

_CHALLENGE = {"WWW-Authenticate": 'Basic realm="TimeZ HRMS API docs", charset="UTF-8"'}
_NO_STORE = {"Cache-Control": "no-store"}


def _unauthorized() -> Response:
    return Response("Sign in with your TimeZ HRMS account to view the API docs.", status_code=401,
                    headers={**_CHALLENGE, **_NO_STORE}, media_type="text/plain")


def _credentials(request: Request) -> tuple[str, str] | None:
    header = request.headers.get("authorization") or ""
    if not header.lower().startswith("basic "):
        return None
    try:
        raw = base64.b64decode(header[6:].strip(), validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError):
        return None
    email, sep, password = raw.partition(":")
    return (email.strip().lower(), password) if sep and email.strip() and password else None


def check(request: Request) -> Response | None:
    """None when the request carries a valid portal sign-in; otherwise the response to send."""
    from app.routers.auth import _failed_attempt  # same lockout counter as sign-in

    ip = client_ip(request)
    wait = login_throttle.retry_after(ip)
    if wait is not None:
        return Response("Too many failed sign-in attempts. Try again later.", status_code=429,
                        headers={"Retry-After": str(wait), **_NO_STORE}, media_type="text/plain")
    creds = _credentials(request)
    if creds is None:
        return _unauthorized()
    email, password = creds
    with SessionLocal() as db:
        account = db.scalar(select(Account).where(func.lower(Account.email) == email))
        if account is None:
            verify_password(password, None)  # same work as a real check
            login_throttle.record_failure(ip)
            return _unauthorized()
        if account.locked_until and account.locked_until > utcnow():
            login_throttle.record_failure(ip)
            return _unauthorized()
        if not account.active or not verify_password(password, account.password_hash):
            _failed_attempt(db, account, request, "docs_login_failed")
            login_throttle.record_failure(ip)
            return _unauthorized()
    return None


def install(app: FastAPI) -> None:
    async def openapi_json(request: Request) -> Response:
        from starlette.concurrency import run_in_threadpool

        denied = await run_in_threadpool(check, request)
        if denied is not None:
            return denied
        return JSONResponse(app.openapi(), headers=_NO_STORE)

    async def swagger(request: Request) -> Response:
        from starlette.concurrency import run_in_threadpool

        denied = await run_in_threadpool(check, request)
        if denied is not None:
            return denied
        page = get_swagger_ui_html(openapi_url="/openapi.json", title=f"{app.title} - docs")
        page.headers.update(_NO_STORE)
        return page

    app.add_route("/openapi.json", openapi_json, include_in_schema=False)
    app.add_route("/docs", swagger, include_in_schema=False)
