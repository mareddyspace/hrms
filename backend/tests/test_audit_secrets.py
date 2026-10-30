"""Security audit: no secrets in git-tracked files or the front-end source / bundle. Never reads backend/.env."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
PATTERNS = {
    "OpenRouter key": re.compile(r"sk-or-v1-[A-Za-z0-9]{20,}"),
    "OpenAI-style key": re.compile(r"\bsk-[A-Za-z0-9]{32,}"),
    "AWS access key": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "Postgres URL with password": re.compile(r"postgres(?:ql)?(?:\+\w+)?://[^\s:'\"<>/]+:[^\s@'\"<>]{6,}@"),
    "Neon password": re.compile(r"\bnpg_[A-Za-z0-9]{10,}"),
    "private key": re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    "GitHub token": re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}"),
    "Slack token": re.compile(r"\bxox[abps]-[A-Za-z0-9-]{10,}"),
    "JWT secret assignment": re.compile(r"JWT_SECRET\s*=\s*['\"]?[A-Za-z0-9_\-+/=]{24,}"),
    "S3 secret assignment": re.compile(r"S3_SECRET_ACCESS_KEY\s*=\s*['\"]?[A-Za-z0-9/+]{30,}"),
}
ALLOWED = {"test-secret-test-secret-test-secret"}  # the test-only secret in tests/conftest.py


def _tracked() -> list[Path]:
    try:
        out = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        pytest.skip("git not available")
    return [ROOT / p for p in out.decode("utf-8", "replace").split("\0") if p]


def _scan(paths) -> list[str]:
    hits = []
    for p in paths:
        if not p.is_file() or p.suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".xlsx",
                                                   ".docx", ".woff", ".woff2", ".pyc", ".db"}:
            continue
        try:
            text = p.read_text("utf-8", errors="ignore")
        except OSError:
            continue
        for name, rx in PATTERNS.items():
            for m in rx.finditer(text):
                if not any(a in m.group(0) for a in ALLOWED):
                    hits.append(f"{p.relative_to(ROOT)}: {name}")
    return hits


def test_no_env_files_with_secrets_are_tracked():
    tracked = {p.relative_to(ROOT).as_posix() for p in _tracked()}
    assert "backend/.env" not in tracked and ".env" not in tracked
    example = ROOT / "backend" / ".env.example"
    if example.exists():
        for line in example.read_text("utf-8").splitlines():
            key, _, value = line.partition("=")
            if key.strip() in {"DATABASE_URL", "JWT_SECRET", "OPENROUTER_API_KEY", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"}:
                assert not value.strip(), f"{key} has a value in .env.example"


def test_no_secrets_in_tracked_files():
    assert _scan(_tracked()) == []


def test_no_secrets_in_front_end_source_or_bundle():
    paths = list((ROOT / "src").rglob("*")) + list((ROOT / "dist").rglob("*.js")) + list((ROOT / "public").rglob("*"))
    assert _scan(paths) == []
    for p in (ROOT / "src").rglob("*.ts*"):
        text = p.read_text("utf-8", errors="ignore")
        assert "OPENROUTER_API_KEY" not in text and "DATABASE_URL" not in text, p
        assert not re.search(r"VITE_[A-Z_]*(SECRET|KEY|TOKEN|PASSWORD)", text), p  # VITE_* is shipped to browsers


@pytest.mark.xfail(strict=True, reason="AUD-13: working passwords for the admin and HR demo accounts are committed "
                                       "(src/demoAccounts.ts, backend/seed/accounts.json) and shipped in the built bundle; "
                                       "if the hosted database is seeded with them anyone can sign in as admin / HR")
def test_privileged_demo_passwords_not_shipped():
    bundle = "".join(p.read_text("utf-8", errors="ignore") for p in (ROOT / "dist").rglob("*.js"))
    source = (ROOT / "src" / "demoAccounts.ts").read_text("utf-8", errors="ignore")
    for pw in ("Admin@8001", "HrAdmin@2001"):
        assert pw not in bundle and pw not in source


def test_render_blueprint_hides_docs():
    text = (ROOT / "render.yaml").read_text("utf-8")
    m = re.search(r"key:\s*DOCS_ENABLED\s*\n\s*value:\s*\"?(\w+)", text)
    assert m is None or m.group(1).lower() == "false"


def test_render_blueprint_keeps_otp_echo_off():
    text = (ROOT / "render.yaml").read_text("utf-8")
    m = re.search(r"key:\s*OTP_DEV_ECHO\s*\n\s*value:\s*\"?(\w+)", text)
    assert m is None or m.group(1).lower() == "false"
