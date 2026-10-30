"""Per-client (IP) throttle for failed sign-ins: stops password spraying across many accounts from one client.

In memory, so it covers one server process (Render free runs a single instance); a restart clears it. The
per-account lockout (auth._failed_attempt) still applies on top of this.

The client IP is request.client.host. Behind Render's proxy uvicorn takes it from X-Forwarded-For
(FORWARDED_ALLOW_IPS="*"), so a client hitting the server directly could spoof it; the per-account lockout
remains the backstop.
"""

from __future__ import annotations

import math
import threading
import time
from collections import deque

MAX_FAILURES = 20
WINDOW_SECONDS = 15 * 60

_lock = threading.Lock()
_failures: dict[str, deque[float]] = {}


def _key(ip: str | None) -> str:
    return ip or "unknown"


def _trim(q: deque[float], now: float) -> None:
    while q and q[0] <= now - WINDOW_SECONDS:
        q.popleft()


def retry_after(ip: str | None) -> int | None:
    """Seconds until this client may try again, or None when it isn't throttled."""
    now = time.monotonic()
    with _lock:
        q = _failures.get(_key(ip))
        if not q:
            return None
        _trim(q, now)
        if len(q) < MAX_FAILURES:
            if not q:
                _failures.pop(_key(ip), None)
            return None
        return max(1, math.ceil(q[0] + WINDOW_SECONDS - now))


def record_failure(ip: str | None) -> None:
    now = time.monotonic()
    with _lock:
        if len(_failures) > 50_000:  # keep memory bounded under a flood of addresses
            for k in [k for k, q in _failures.items() if not q or q[-1] <= now - WINDOW_SECONDS]:
                del _failures[k]
        q = _failures.setdefault(_key(ip), deque())
        _trim(q, now)
        q.append(now)


def reset() -> None:
    """Tests only."""
    with _lock:
        _failures.clear()
