"""HR Copilot answers through OpenRouter.

Flow (the portal's AI principle): understand the question -> check permissions -> retrieve only data the person
may see (app/services/ai_context.py) -> answer from that context -> audit.

- No OPENROUTER_API_KEY, or every model failed: answer=None, used_ai=False, and the portal uses its built-in answer.
- AI_MODEL is tried first, then AI_MODEL_FALLBACKS, moving on after 429, 5xx, timeouts, network errors or an
  empty reply.
- Questions about other people's pay or personal details are refused before anything is retrieved (denied=True).
- Every question is audited (entity "Copilot question"): the first 80 characters, sources, model, denied.
  Never the answer text or the context.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Any

import httpx
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.deps import CurrentUser
from app.models import Employee
from app.services.activity import record_audit
from app.services.ai_context import Source, build_context

log = logging.getLogger(__name__)
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
AUDIT_ENTITY = "Copilot question"
RATE_LIMIT = 20  # questions per user per minute
RATE_WINDOW_SECONDS = 60.0
MAX_HISTORY_TURNS = 6
MAX_ANSWER_TOKENS = 700

SYSTEM_PROMPT = """You are TimeZ Copilot, the HR assistant inside the TimeZ HRMS portal.
Rules:
- Answer ONLY from the CONTEXT below (the person's own data, what their role allows them to see, and policy sections).
- If the answer is not in the context, say you don't have that information and point to the right portal page
  (for example Leave, Attendance, Timesheet, Approvals, Policies, Payslips, Benefits, Expenses, Help desk).
- Never invent numbers, dates, names or policy rules. Quote numbers exactly as they appear in the context.
- Never make or promise decisions: no approvals, rejections, ratings, hiring, pay or disciplinary decisions.
  You can explain how to do something; the person or the right approver does it in the portal.
- Never reveal other people's pay or personal details.
- Keep answers short and plain: two to five sentences or a few bullet points, no tables, no headings.
- Reply in the same language as the question.
- When you use a policy section, mention the policy name."""

_SENSITIVE = re.compile(
    r"\b(salar(y|ies)|pay|paid|ctc|compensation|bonus|payslips?|bank|account number|tax id|pan|ssn|address|phone|"
    r"mobile|email|birthday|date of birth|dob|medical|health|disciplinary|grievance|complaint|case notes?|"
    r"rating|appraisal|performance review)\b",
    re.IGNORECASE,
)
_OTHER_PERSON = re.compile(
    r"\b(his|her|hers|their|colleague'?s?|co-?worker'?s?|manager'?s|boss'?s|team ?mate'?s?|everyone'?s|"
    r"employees'?|someone'?s|somebody'?s|other people'?s|others'?)\b",
    re.IGNORECASE,
)
_THINK_TAGS = re.compile(r"<(think|thinking|reasoning|reflection)>.*?</\1>", re.IGNORECASE | re.DOTALL)
_OPEN_THINK = re.compile(r"^\s*<(think|thinking|reasoning)>.*", re.IGNORECASE | re.DOTALL)

DENIED_ANSWER = (
    "I can't share other people's pay or personal details. If you need this for your work, ask HR or use the "
    "page your role gives you access to."
)


@dataclass
class CopilotResult:
    answer: str | None
    sources: list[Source] = field(default_factory=list)
    used_ai: bool = False
    model: str | None = None
    denied: bool = False


# ---------- rate limit (in memory, per process) ----------
_calls: dict[str, deque[float]] = defaultdict(deque)
_calls_lock = threading.Lock()


def allow_question(user_id: str, now: float | None = None) -> bool:
    """True when this user has asked fewer than RATE_LIMIT questions in the last minute (and counts this one)."""
    now = time.monotonic() if now is None else now
    with _calls_lock:
        q = _calls[user_id]
        while q and now - q[0] >= RATE_WINDOW_SECONDS:
            q.popleft()
        if len(q) >= RATE_LIMIT:
            return False
        q.append(now)
        return True


def reset_rate_limits() -> None:
    with _calls_lock:
        _calls.clear()


# ---------- permission check ----------
_COMMON_WORDS = frozenset(
    "may june april august will mark grace joy hope faith summer bill rich sunny the and what how much pay "
    "salary bonus can does who".split()
)


def _names_in(db: Session, question: str, me_id: str | None) -> bool:
    """Does the question name someone else (by first or full name)?"""
    words = {w.lower() for w in re.findall(r"[A-Za-z][A-Za-z'-]{2,}", question)}
    words = {w[:-2] if w.endswith("'s") else w for w in words} - _COMMON_WORDS
    if not words:
        return False
    hit = db.scalar(
        select(Employee.id).where(func.lower(Employee.first_name).in_(words), Employee.id != (me_id or "")).limit(1)
    )
    return hit is not None


def is_denied(db: Session, user: CurrentUser, question: str) -> bool:
    """Questions about someone else's pay or personal details are refused, whatever the role: the Copilot never
    has that data. (HR still sees it on the pages their role allows.)"""
    if not _SENSITIVE.search(question):
        return False
    return bool(_OTHER_PERSON.search(question)) or _names_in(db, question, user.employee_id)


# ---------- model call ----------
def clean_answer(text: str) -> str:
    text = _THINK_TAGS.sub("", text or "")
    text = _OPEN_THINK.sub("", text)
    return text.strip()


class _TryNext(Exception):
    pass


class _Stop(Exception):
    pass


def _post(url: str, *, headers: dict[str, str], payload: dict[str, Any], timeout: float) -> httpx.Response:
    """The one place that talks to OpenRouter (tests replace it)."""
    with httpx.Client(timeout=timeout) as client:
        return client.post(url, headers=headers, json=payload)


def _call_model(model: str, messages: list[dict[str, str]], key: str, timeout: float) -> str:
    headers = {
        "Authorization": f"Bearer {key}",
        "HTTP-Referer": "http://localhost:5173",
        "X-Title": "TimeZ HRMS",
        "Content-Type": "application/json",
    }
    payload = {
        "model": model, "messages": messages, "temperature": 0.2, "max_tokens": MAX_ANSWER_TOKENS,
        # Free "thinking" models are slow when they reason first; answers come from the given context anyway.
        "reasoning": {"enabled": False, "exclude": True},
    }
    try:
        res = _post(OPENROUTER_URL, headers=headers, payload=payload, timeout=timeout)
    except (httpx.TimeoutException, httpx.TransportError) as exc:
        raise _TryNext(type(exc).__name__) from None
    if res.status_code in (401, 402, 403):
        raise _Stop(f"HTTP {res.status_code}")  # bad key or no credit: other models won't work either
    if res.status_code == 429 or res.status_code >= 500 or res.status_code in (400, 404, 408):
        raise _TryNext(f"HTTP {res.status_code}")
    if res.status_code != 200:
        raise _TryNext(f"HTTP {res.status_code}")
    try:
        data = res.json()
        if data.get("error"):
            raise _TryNext("provider error")
        content = data["choices"][0]["message"].get("content") or ""
    except (ValueError, KeyError, IndexError, TypeError):
        raise _TryNext("bad response") from None
    answer = clean_answer(content)
    if not answer:
        raise _TryNext("empty answer")
    return answer


def _messages(context: str, question: str, history: list[dict[str, str]]) -> list[dict[str, str]]:
    msgs = [{"role": "system", "content": f"{SYSTEM_PROMPT}\n\nCONTEXT\n{context}"}]
    for turn in history[-MAX_HISTORY_TURNS:]:
        role = turn.get("role")
        content = (turn.get("content") or "").strip()
        if role in ("user", "assistant") and content:
            msgs.append({"role": role, "content": content[:1000]})
    msgs.append({"role": "user", "content": question})
    return msgs


def _ask_models(messages: list[dict[str, str]]) -> tuple[str | None, str | None]:
    settings = get_settings()
    if not settings.ai_enabled:
        return None, None
    key = settings.openrouter_api_key.strip()
    # The portal stops waiting after ~15 s, so keep the whole attempt (all models) close to that.
    deadline = time.monotonic() + settings.ai_timeout_seconds
    for model in settings.ai_models:
        remaining = deadline - time.monotonic()
        if remaining < 3:
            break
        try:
            return _call_model(model, messages, key, min(settings.ai_timeout_seconds, remaining)), model
        except _TryNext as exc:
            log.warning("Copilot model %s failed (%s); trying the next one", model, exc)
            continue
        except _Stop as exc:
            log.warning("Copilot AI stopped (%s); using built-in answers", exc)
            break
    return None, None


_DATA_TOPICS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\b(leave|leaves|holiday|vacation|day off|days off|sick|balance|pto|wfh)\b", re.I), "/leave"),
    (re.compile(r"\b(attendance|late|check.?in|check.?out|absent|present|overtime)\b", re.I), "/attendance"),
    (re.compile(r"\b(timesheets?|hours|logged)\b", re.I), "/timesheet"),
    (re.compile(r"\b(team|reports|reportees|direct)\b", re.I), "/team"),
    (re.compile(r"\b(headcount|employees|workforce|department|departments|countr(y|ies)|organi[sz]ation)\b", re.I), "/analytics"),
    (re.compile(r"\b(goals?|okrs?|kpis?|rating|review|performance)\b", re.I), "/performance"),
    (re.compile(r"\b(skills?|career|promotion|target role|next role|mentor)\b", re.I), "/skills"),
    (re.compile(r"\b(courses?|training|learning|certifications?|certificates?)\b", re.I), "/learning"),
    (re.compile(r"\b(benefits?|insurance|medical plan|pension|enrol(ment|led)?|enroll(ment|ed)?)\b", re.I), "/benefits"),
]


def _sources_for(question: str, ctx_sources: list[Source], data_refs: list[Source]) -> list[Source]:
    wanted = {ref for pattern, ref in _DATA_TOPICS if pattern.search(question)}
    return [*ctx_sources, *[s for s in data_refs if s.ref in wanted]]


def ask(
    db: Session,
    user: CurrentUser,
    question: str,
    history: list[dict[str, str]] | None = None,
    ip: str | None = None,
) -> CopilotResult:
    """Answer one Copilot question (the caller commits the audit row)."""
    question = question.strip()
    if is_denied(db, user, question):
        result = CopilotResult(answer=DENIED_ANSWER, denied=True)
    else:
        ctx = build_context(db, user, question)
        answer, model = _ask_models(_messages(ctx.text(), question, history or []))
        result = CopilotResult(
            answer=answer, sources=_sources_for(question, ctx.sources, ctx.data_refs) if answer else ctx.sources,
            used_ai=answer is not None, model=model,
        )
    record_audit(
        db, actor_id=user.id, action="asked", entity=AUDIT_ENTITY, entity_id=None, subject_id=user.employee_id,
        after={
            "question": question[:80],
            "sources": [s.ref for s in result.sources],
            "model": result.model,
            "used_ai": result.used_ai,
            "denied": result.denied,
        },
        ip=ip,
    )
    return result


def status() -> dict[str, Any]:
    settings = get_settings()
    return {"enabled": settings.ai_enabled, "model": settings.ai_models[0] if settings.ai_enabled else None}
