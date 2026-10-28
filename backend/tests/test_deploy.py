"""Hosting readiness: S3 storage backend (stubbed client, no network), production checks, headers, migrations."""

from __future__ import annotations

import io
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest
from botocore.exceptions import ClientError

from app.config import BACKEND_DIR, Settings, check_jwt_secret
from app.services import storage
from tests.conftest import login
from tests.talent_helpers import R, add_candidate

REPO_ROOT = BACKEND_DIR.parent


# ---------- a stand-in for boto3's S3 client ----------
class _Body:
    def __init__(self, data: bytes) -> None:
        self._io = io.BytesIO(data)
        self.closed = False

    def iter_chunks(self, size: int):
        while chunk := self._io.read(size):
            yield chunk

    def close(self) -> None:
        self.closed = True


class FakeS3:
    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], tuple[bytes, str]] = {}
        self.calls: list[str] = []

    def put_object(self, *, Bucket: str, Key: str, Body: bytes, ContentType: str) -> dict:
        self.calls.append(f"put {Key}")
        self.objects[(Bucket, Key)] = (Body, ContentType)
        return {}

    def get_object(self, *, Bucket: str, Key: str) -> dict:
        self.calls.append(f"get {Key}")
        if (Bucket, Key) not in self.objects:
            raise ClientError({"Error": {"Code": "NoSuchKey", "Message": "missing"},
                               "ResponseMetadata": {"HTTPStatusCode": 404}}, "GetObject")
        data, ctype = self.objects[(Bucket, Key)]
        return {"Body": _Body(data), "ContentLength": len(data), "ContentType": ctype}

    def delete_object(self, *, Bucket: str, Key: str) -> dict:
        self.calls.append(f"delete {Key}")
        self.objects.pop((Bucket, Key), None)
        return {}


@pytest.fixture
def fake_s3(monkeypatch):
    fake = FakeS3()
    made: list[storage._StorageSettings] = []

    def make(s):  # type: ignore[no-untyped-def]
        made.append(s)
        return fake

    monkeypatch.setenv("STORAGE_BACKEND", "s3")
    monkeypatch.setenv("S3_ENDPOINT_URL", "https://s3.us-east-005.backblazeb2.com")
    monkeypatch.delenv("S3_REGION", raising=False)
    monkeypatch.setenv("S3_ACCESS_KEY_ID", "test-key-id")
    monkeypatch.setenv("S3_SECRET_ACCESS_KEY", "test-secret-key")
    monkeypatch.setenv("S3_BUCKET", "timez-files-test")
    monkeypatch.setattr(storage, "_make_s3_client", make)
    monkeypatch.setattr(storage, "_client_cache", {})
    fake.made = made  # type: ignore[attr-defined]
    return fake


def test_s3_backend_put_stream_delete(fake_s3):
    assert isinstance(storage.get_backend(), storage.S3Backend)
    stored = storage.save("receipts/emp-1", "rcpt-1", b"%PDF-1.4 hello", "application/pdf", "abc")
    assert stored.relative_path == "receipts/emp-1/rcpt-1.pdf"
    assert fake_s3.objects[("timez-files-test", "receipts/emp-1/rcpt-1.pdf")] == (b"%PDF-1.4 hello", "application/pdf")
    assert fake_s3.made[0].region == "us-east-005"  # taken from the Backblaze endpoint

    res = storage.download(stored.relative_path, media_type="application/pdf", filename="taxi bill.pdf")
    assert res.headers["content-length"] == "14"
    assert res.headers["content-disposition"] == "attachment; filename*=utf-8''taxi%20bill.pdf"
    assert res.headers["cache-control"] == "private, no-store"

    with pytest.raises(storage.FileMissing):
        storage.download("receipts/emp-1/nope.pdf", media_type="application/pdf")
    with pytest.raises(storage.StorageError):
        storage.download("../etc/passwd", media_type="text/plain")

    storage.delete_quietly(stored.relative_path)
    assert not fake_s3.objects
    storage.delete_quietly("../bad")  # never raises


def test_s3_backend_needs_all_settings(monkeypatch):
    monkeypatch.setenv("STORAGE_BACKEND", "s3")
    for name in ("S3_ENDPOINT_URL", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET", "R2_ACCOUNT_ID", "R2_BUCKET",
                 "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ENDPOINT"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(storage._StorageSettings, "model_config", {**storage._StorageSettings.model_config, "env_file": None})
    with pytest.raises(RuntimeError, match="S3_ENDPOINT_URL"):
        storage.get_backend()


def test_r2_names_still_work(monkeypatch):
    monkeypatch.setenv("R2_ACCOUNT_ID", "abc123")
    monkeypatch.delenv("S3_ENDPOINT_URL", raising=False)
    monkeypatch.delenv("S3_REGION", raising=False)
    s = storage._StorageSettings(_env_file=None)
    assert s.endpoint == "https://abc123.r2.cloudflarestorage.com" and s.region == "auto"


def test_cv_round_trip_through_s3(client, fake_s3):
    """The API stores the file in the bucket (nothing on disk) and streams it back."""
    sophie = login(client, "sophie.clark@timez.com")
    made = add_candidate(client, sophie, "Storage Test", "storage.test@example.com")
    assert made.status_code == 201, made.text
    cid = made.json()["id"]
    url = f"{R}/candidates/{cid}/cv"
    text = b"Aisha Khan\naisha.khan@example.com\nReact and TypeScript"
    res = client.put(url, headers=sophie | {"Content-Type": "text/plain"}, params={"filename": "aisha.txt"}, content=text)
    assert res.status_code == 200, res.text
    assert fake_s3.objects[("timez-files-test", f"cvs/{cid}.txt")][0] == text
    got = client.get(url, headers=sophie)
    assert got.status_code == 200 and got.content == text
    assert "aisha.txt" in got.headers["content-disposition"]


# ---------- production settings ----------
def _settings(**env: str) -> Settings:
    return Settings(_env_file=None, **env)  # type: ignore[arg-type]


def test_production_refuses_weak_jwt_secret(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    for weak in ("", "short", "test-secret-test-secret-test-secret", "a" * 40):
        monkeypatch.setenv("JWT_SECRET", weak)
        with pytest.raises(RuntimeError):
            check_jwt_secret(_settings())
    monkeypatch.setenv("JWT_SECRET", "Zq7Lw2Kp9Xr4Tn6Vb1Hm8Jd3Fs5Gc0Ya-uE")
    check_jwt_secret(_settings())
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("JWT_SECRET", "test-secret-test-secret-test-secret")
    check_jwt_secret(_settings())  # fine outside production


def test_security_headers_and_no_stack_traces(client):
    res = client.get("/health")
    assert res.headers["x-content-type-options"] == "nosniff"
    assert res.headers["x-frame-options"] == "DENY"
    assert res.headers["referrer-policy"] == "strict-origin-when-cross-origin"
    assert "strict-transport-security" not in res.headers  # only in production
    assert client.get("/docs").status_code == 200


def test_unhandled_error_hides_details():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.main import _unhandled_error

    app = FastAPI()
    app.add_exception_handler(Exception, _unhandled_error)

    @app.get("/boom")
    def boom() -> None:
        raise ValueError("secret internals")

    res = TestClient(app, raise_server_exceptions=False).get("/boom")
    assert res.status_code == 500 and "secret" not in res.text and "Traceback" not in res.text


def test_docs_off_and_cors_regex_in_a_fresh_process(tmp_path):
    """DOCS_ENABLED / CORS_ORIGIN_REGEX are read when the app is built, so check them in a new interpreter."""
    code = (
        "from fastapi.testclient import TestClient\n"
        "from app.main import app\n"
        "c = TestClient(app)\n"
        "pre = lambda o: c.options('/health', headers={'Origin': o, 'Access-Control-Request-Method': 'GET'})\n"
        "print(c.get('/docs').status_code, c.get('/openapi.json').status_code,\n"
        "      pre('https://hrms-git-feature-x.vercel.app').headers.get('access-control-allow-origin'),\n"
        "      pre('https://evil.example.com').headers.get('access-control-allow-origin'),\n"
        "      c.get('/health').headers.get('strict-transport-security'), sep='|')\n"
    )
    env = {**os.environ, "DATABASE_URL": f"sqlite:///{(tmp_path / 'x.db').as_posix()}", "DOCS_ENABLED": "false",
           "CORS_ORIGINS": "https://hrms.vercel.app", "CORS_ORIGIN_REGEX": r"^https://hrms(-[a-z0-9-]+)?\.vercel\.app$",
           "APP_ENV": "production", "JWT_SECRET": "Zq7Lw2Kp9Xr4Tn6Vb1Hm8Jd3Fs5Gc0Ya-uE", "STORAGE_BACKEND": "local"}
    out = subprocess.run([sys.executable, "-c", code], cwd=BACKEND_DIR, env=env, capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr[-2000:]
    docs, openapi, preview, evil, hsts = out.stdout.strip().splitlines()[-1].split('|')
    assert docs == "404" and openapi == "404"
    assert preview == "https://hrms-git-feature-x.vercel.app" and evil == "None"
    assert hsts.startswith("max-age=")


# ---------- migrations on start ----------
def test_upgrade_with_lock_is_a_no_op_at_head(monkeypatch):
    from app import migrate

    before, after = migrate.upgrade_with_lock()
    assert before == after and after is not None
    monkeypatch.setenv("RUN_MIGRATIONS_ON_START", "false")
    migrate.run_if_enabled()  # disabled in tests: does nothing


# ---------- front end ----------
def test_login_page_passwords_match_seed():
    accounts = json.loads((BACKEND_DIR / "seed" / "accounts.json").read_text(encoding="utf-8"))
    src = (REPO_ROOT / "src" / "demoAccounts.ts").read_text(encoding="utf-8")
    pairs = dict(re.findall(r'email:\s*"([^"]+)",[\s\S]*?password:\s*"([^"]+)"', src))
    for a in accounts:
        assert pairs.get(a["email"]) == a["password"], a["email"]


def test_render_blueprint_lists_the_settings():
    text = Path(REPO_ROOT / "render.yaml").read_text(encoding="utf-8")
    for name in ("DATABASE_URL", "JWT_SECRET", "S3_ENDPOINT_URL", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY",
                 "S3_BUCKET", "STORAGE_BACKEND", "RUN_MIGRATIONS_ON_START", "APP_ENV", "OTP_DEV_ECHO", "CORS_ORIGINS",
                 "PYTHON_VERSION", "healthCheckPath: /health"):
        assert name in text, name
