"""Tests always run on a throwaway SQLite file, whatever DATABASE_URL says in backend/.env."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

_TMP = Path(tempfile.mkdtemp(prefix="timez-test-"))
os.environ["DATABASE_URL"] = f"sqlite:///{(_TMP / 'test.db').as_posix()}"  # environment wins over .env
os.environ.setdefault("JWT_SECRET", "test-secret-test-secret-test-secret")
os.environ["STORAGE_BACKEND"] = "local"  # never the real bucket, whatever backend/.env says
os.environ["RUN_MIGRATIONS_ON_START"] = "false"
os.environ["APP_ENV"] = "test"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.config import get_settings  # noqa: E402

assert get_settings().is_sqlite, "tests must never touch the real database"

from app import seed  # noqa: E402
from app.db_init import upgrade_to_head  # noqa: E402
from app.main import app  # noqa: E402

PASSWORDS = {
    "babu.menon@timez.com": "Employee@1184",
    "ram.krishnan@timez.com": "Manager@1001",
    "farhan.ali@timez.com": "HrAdmin@2001",
    "sophie.clark@timez.com": "Recruiter@3001",
    "jordan.blake@timez.com": "Executive@5001",
    "alex.morgan@timez.com": "Admin@8001",
}


@pytest.fixture(scope="session", autouse=True)
def database():
    upgrade_to_head()  # exercises the Alembic migration
    seed.run()
    seed.run()  # idempotent
    yield


@pytest.fixture(autouse=True)
def any_timesheet_day(monkeypatch):
    """Most tests log time on fixed dates; test_timesheet_today_only switches the today-only rule back on and
    the attendance tests switch the check-out-before-submit rule back on."""
    from app.routers import timesheets

    monkeypatch.setattr(timesheets, "TODAY_ONLY", False)
    monkeypatch.setattr(timesheets, "ATTENDANCE_REQUIRED", False)


@pytest.fixture(scope="session")
def client(database) -> TestClient:
    return TestClient(app)


def login(client: TestClient, email: str) -> dict[str, str]:
    res = client.post("/api/v1/auth/login", json={"email": email, "password": PASSWORDS[email]})
    assert res.status_code == 200, res.text
    return {"Authorization": f"Bearer {res.json()['access_token']}"}


@pytest.fixture(scope="session")
def babu(client):
    return login(client, "babu.menon@timez.com")


@pytest.fixture(scope="session")
def ram(client):
    return login(client, "ram.krishnan@timez.com")


@pytest.fixture(scope="session")
def farhan(client):
    return login(client, "farhan.ali@timez.com")
