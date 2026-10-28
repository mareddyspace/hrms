"""TimeZ HRMS API. Run: uvicorn app.main:app --reload  (docs at /docs)."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app.config import get_settings
from app.db import engine
from app.routers import approvals, attendance, auth, leave, notifications, people, timesheets

settings = get_settings()

app = FastAPI(title="TimeZ HRMS API", version="1.0.0", docs_url="/docs", redoc_url=None)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

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
