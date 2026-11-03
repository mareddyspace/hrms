"""SEED_ON_START: the seed runs once in the background at start-up; off by default."""

from __future__ import annotations

import threading
from types import SimpleNamespace

from app import migrate, seed


def test_seed_on_start_off_by_default(monkeypatch):
    calls = []
    monkeypatch.setattr(seed, "run", lambda **kw: calls.append(kw) or {})
    migrate.seed_if_enabled()
    assert calls == []


def test_seed_on_start_runs_once_in_background(monkeypatch):
    done = threading.Event()
    calls = []

    def fake_run(**kw):
        calls.append(kw)
        done.set()
        return {"teammate_requests_added": 2}

    monkeypatch.setattr(migrate, "get_settings", lambda: SimpleNamespace(seed_on_start=True))
    monkeypatch.setattr(seed, "run", fake_run)
    migrate.seed_if_enabled()
    assert done.wait(10)
    assert calls == [{"only_if_free": True}]


def test_failed_seed_does_not_raise(monkeypatch):
    done = threading.Event()

    def broken(**kw):
        done.set()
        raise RuntimeError("connection dropped")

    monkeypatch.setattr(migrate, "get_settings", lambda: SimpleNamespace(seed_on_start=True))
    monkeypatch.setattr(seed, "run", broken)
    migrate.seed_if_enabled()  # must not raise: the server keeps starting
    assert done.wait(10)
