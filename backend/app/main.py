"""TimeZ HRMS API. Run: uvicorn app.main:app --reload  (docs at /docs)."""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.config import get_settings
from app.db import engine
from app.routers import approvals, attendance, auth, leave, notifications, people, timesheets
from app.security_headers import SecurityHeadersMiddleware

settings = get_settings()

logging.basicConfig(level=settings.log_level.upper(), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("timez")
for _noisy in ("httpx", "httpcore", "botocore", "boto3", "urllib3"):
    logging.getLogger(_noisy).setLevel(logging.WARNING)

# API docs: open in development; in production off unless DOCS_ENABLED=true, and then only after signing in with a
# portal account (app/docs_auth.py).
_open_docs = bool(settings.docs_enabled) and not settings.is_production
app = FastAPI(
    title="TimeZ HRMS API", version="1.0.0", redoc_url=None,
    docs_url="/docs" if _open_docs else None,
    openapi_url="/openapi.json" if _open_docs else None,
)
if settings.docs_enabled and settings.is_production:
    from app import docs_auth

    docs_auth.install(app)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_origin_regex=settings.cors_origin_regex.strip() or None,
    allow_credentials=False,  # bearer tokens only, no cookies: a future cookie can never become CSRF-able by accident
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)
# Added last = outermost, so every response (errors and CORS preflights too) gets the headers.
app.add_middleware(SecurityHeadersMiddleware, hsts=settings.is_production)


@app.exception_handler(Exception)
async def _unhandled_error(request: Request, exc: Exception) -> JSONResponse:
    """Log the stack trace on the server; the client only gets a plain message."""
    log.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"detail": "Something went wrong on the server. Please try again."})

API_PREFIX = "/api/v1"
for module in (auth, people, leave, attendance, timesheets, approvals, notifications):
    app.include_router(module.router, prefix=API_PREFIX)
app.include_router(approvals.workflows_router, prefix=API_PREFIX)


@app.get("/health", tags=["health"])
def health() -> dict[str, str]:
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        db_state = "ok"
    except Exception:
        db_state = "unreachable"
    return {"status": "ok" if db_state == "ok" else "degraded", "database": db_state, "dialect": engine.dialect.name}


# ---------- expenses, travel, lifecycle actions, organization & positions ----------
from contextlib import asynccontextmanager  # noqa: E402

from app.routers import expenses, lifecycle, org, travel  # noqa: E402
from app.services.lifecycle import run_due_at_startup  # noqa: E402

for module in (expenses, travel, lifecycle, org):
    app.include_router(module.router, prefix=API_PREFIX)
app.include_router(lifecycle.history_router, prefix=API_PREFIX)

_previous_lifespan = app.router.lifespan_context


@asynccontextmanager
async def _lifespan_apply_due(app_: FastAPI):  # type: ignore[no-untyped-def]
    """At startup, apply approved lifecycle actions whose effective date has come (chains any earlier lifespan)."""
    run_due_at_startup()
    async with _previous_lifespan(app_) as state:
        yield state


app.router.lifespan_context = _lifespan_apply_due


# ---------- recruiting, onboarding, performance, learning ----------
from app.routers import learning, onboarding, performance, recruiting  # noqa: E402

for module in (recruiting, onboarding, performance, learning):
    app.include_router(module.router, prefix=API_PREFIX)


# ---------- compensation, benefits, documents & letters ----------
from app.routers import benefits, compensation, documents  # noqa: E402

for module in (compensation, benefits, documents):
    app.include_router(module.router, prefix=API_PREFIX)
app.include_router(documents.letters_router, prefix=API_PREFIX)

# ---------- HR cases, service desk, engagement & recognition, shifts, admin platform (migration 0006) ----------
from app.routers import cases, desk, engagement, platform_admin, shifts  # noqa: E402
from app.services import email_outbox as _email_outbox  # noqa: E402
from app.services.jobs import run_at_startup as _run_jobs_at_startup  # noqa: E402

_email_outbox.install()  # every notification also queues an email row (respecting the admin email switches)
for module in (cases, desk, engagement, shifts, platform_admin):
    app.include_router(module.router, prefix=API_PREFIX)

_lifespan_before_jobs = app.router.lifespan_context


@asynccontextmanager
async def _lifespan_jobs(app_: FastAPI):  # type: ignore[no-untyped-def]
    """At startup, send due approval reminders, escalate overdue SLAs and archive expired cases (chains earlier hooks)."""
    async with _lifespan_before_jobs(app_) as state:
        _run_jobs_at_startup()
        yield state


app.router.lifespan_context = _lifespan_jobs

# ---------- HR Copilot (OpenRouter) ----------
from app.routers import ai  # noqa: E402

app.include_router(ai.router, prefix=API_PREFIX)

# ---------- payroll tab: integration status only (migration 0010) ----------
from app.routers import payroll  # noqa: E402

app.include_router(payroll.router, prefix=API_PREFIX)

# ---------- profile edits, profile corrections, Copilot action audit (migration 0008) ----------
from app.routers import profile  # noqa: E402

app.include_router(profile.router, prefix=API_PREFIX)

# ---------- two-step sign-in, signed-in devices (migration 0013) ----------
from app.routers import account_security  # noqa: E402

app.include_router(account_security.router, prefix=API_PREFIX)

# ---------- leave admin (types, policies, holidays, carry-forward) and country config (migration 0011) ----------
from app.routers import leave_admin  # noqa: E402

app.include_router(leave_admin.router, prefix=API_PREFIX)
app.include_router(leave_admin.countries_router, prefix=API_PREFIX)

# ---------- skills library & careers, Employee 360 AI summary, recruiting AI helpers (migration 0012) ----------
from app.routers import ai_drafts, career  # noqa: E402

app.include_router(career.router, prefix=API_PREFIX)
app.include_router(ai_drafts.ai_router, prefix=API_PREFIX)
app.include_router(ai_drafts.recruiting_router, prefix=API_PREFIX)

# ---------- approval chains: delegation (migration 0009) ----------
from app.routers import delegations  # noqa: E402

app.include_router(delegations.router, prefix=API_PREFIX)

# ---------- exits: resignation, termination, retirement, end of contract (migration 0014) ----------
from app.routers import exits as exits_router  # noqa: E402

app.include_router(exits_router.router, prefix=API_PREFIX)

# ---------- cash advances, leave encashment, software licences (migration 0016) ----------
from app.routers import optional_holidays as optional_holidays_router  # noqa: E402

app.include_router(optional_holidays_router.router, prefix=API_PREFIX)

from app.routers import self_service as self_service_router  # noqa: E402

for _r in (self_service_router.cash_router, self_service_router.encash_router, self_service_router.software_router):
    app.include_router(_r, prefix=API_PREFIX)

# ---------- policies HR writes, versions, acknowledgement tracking (migration 0018) ----------
from app.routers import policies as policies_router  # noqa: E402

app.include_router(policies_router.router, prefix=API_PREFIX)

# ---------- work tickets shared between people: owner, sub-owner, deadline, tasks (migration 0020) ----------
from app.routers import tickets as tickets_router  # noqa: E402

app.include_router(tickets_router.router, prefix=API_PREFIX)

# ---------- hiring chain, public pages: careers page and the candidate's offer link (migration 0021) ----------
from app.routers import careers as careers_router  # noqa: E402

app.include_router(careers_router.router, prefix=API_PREFIX)

# ---------- team overview (today per person) and approval reminders (no new tables) ----------
from app.routers import team as team_router  # noqa: E402

app.include_router(team_router.router, prefix=API_PREFIX)
app.include_router(team_router.reminders_router, prefix=API_PREFIX)

# ---------- shared chat, mail, tasks, announcements and calendar events (migration 0022) ----------
from app.routers import announcements as announcements_router  # noqa: E402
from app.routers import calendar as calendar_router  # noqa: E402
from app.routers import chat as chat_router  # noqa: E402
from app.routers import mail as mail_router  # noqa: E402
from app.routers import shared_tasks as shared_tasks_router  # noqa: E402

for _r in (chat_router, mail_router, shared_tasks_router, announcements_router, calendar_router):
    app.include_router(_r.router, prefix=API_PREFIX)

# ---------- celebrations (birthdays, anniversaries, new joiners) and the HR compliance calendar (migration 0023) ----------
from app.routers import celebrations as celebrations_router, compliance_calendar as compliance_router  # noqa: E402

app.include_router(celebrations_router.router, prefix=API_PREFIX)
app.include_router(compliance_router.router, prefix=API_PREFIX)

# ---------- monthly payroll runs, bank details, overtime and comp-off (migration 0023) ----------
from app.routers import overtime as overtime_router, payroll_runs as payroll_runs_router  # noqa: E402

app.include_router(payroll_runs_router.router, prefix=API_PREFIX)
app.include_router(overtime_router.router, prefix=API_PREFIX)

# ---------- start-up: optional migrations (outermost hook, so it runs before the jobs above touch the database) ----------
from app import migrate as _migrate  # noqa: E402
from app.services import storage as _storage  # noqa: E402

_lifespan_before_migrations = app.router.lifespan_context


@asynccontextmanager
async def _lifespan_migrate(app_: FastAPI):  # type: ignore[no-untyped-def]
    log.info("Starting TimeZ HRMS API (env=%s, database=%s, docs=%s)", settings.app_env, engine.dialect.name,
             "on" if settings.docs_enabled else "off")
    _migrate.run_if_enabled()
    log.info("File storage: %s", _storage.check_configuration())
    async with _lifespan_before_migrations(app_) as state:
        yield state


app.router.lifespan_context = _lifespan_migrate
