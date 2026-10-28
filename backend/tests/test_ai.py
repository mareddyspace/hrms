"""HR Copilot: permission-limited context, fallbacks, audit, rate limit. OpenRouter is never called."""

from __future__ import annotations

import httpx
import pytest
from sqlalchemy import select

from app.config import get_settings
from app.db import SessionLocal
from app.deps import CurrentUser
from app.models import Account, AuditLog, Employee
from app.services import ai_copilot, policy_kb
from app.services.ai_context import build_context
from app.services.data_scope import scope_for

ASK = "/api/v1/ai/ask"


@pytest.fixture(autouse=True)
def no_real_ai(monkeypatch):
    """Whatever backend/.env says, tests run with no key and no network."""
    settings = get_settings()
    monkeypatch.setattr(settings, "openrouter_api_key", "")
    monkeypatch.setattr(settings, "ai_model", "test/model-a")
    monkeypatch.setattr(settings, "ai_model_fallbacks", "test/model-b")
    calls: list[str] = []

    def refuse(url, **kwargs):  # noqa: ANN001
        calls.append(kwargs["payload"]["model"])
        raise AssertionError("OpenRouter must not be called in this test")

    monkeypatch.setattr(ai_copilot, "_post", refuse)
    ai_copilot.reset_rate_limits()
    yield calls
    ai_copilot.reset_rate_limits()


def _user(db, email: str) -> CurrentUser:
    account = db.scalar(select(Account).where(Account.email == email))
    employee = db.get(Employee, account.employee_id) if account.employee_id else None
    return CurrentUser(account=account, employee=employee, scope=scope_for(db, account))


def _fake_response(status: int, content: str | None = None) -> httpx.Response:
    body = {"choices": [{"message": {"content": content}}]} if content is not None else {"error": {"message": "x"}}
    return httpx.Response(status, json=body)


def test_policies_exported():
    policies = policy_kb.load_policies()
    assert any(p["id"] == "leave-IN" for p in policies)
    assert all({"id", "title", "version", "effective", "sections"} <= p.keys() for p in policies)


def test_employee_context_has_only_own_data():
    with SessionLocal() as db:
        user = _user(db, "babu.menon@timez.com")
        ctx = build_context(db, user, "How many leave days do I have and what is the sick leave policy?")
        text = ctx.text()
        assert "YOUR LEAVE" in text and "YOUR ATTENDANCE" in text and "YOUR TIMESHEETS" in text
        assert "ORGANISATION" not in text and "YOUR TEAM" not in text
        me = user.employee
        allowed = {me.full_name}
        if me.manager_id:
            allowed.add(db.get(Employee, me.manager_id).full_name)
        others = [n for n in db.scalars(select(Employee.full_name)) if n not in allowed]
        assert not [n for n in others if n in text], "context names someone else"
        assert me.email not in text and (me.mobile or "@@") not in text  # no contact details, even own
        # policy sections are for India only
        by_id = {p["id"]: p for p in policy_kb.load_policies()}
        assert ctx.sources
        for s in ctx.sources:
            policy = by_id[s.ref.split("#")[0]]
            assert not policy["countries"] or policy["countries"] == [me.country_code]
        assert any(s.ref.startswith("leave-IN#") for s in ctx.sources)
        assert not any(s.ref.startswith("leave-US") for s in ctx.sources)


def test_hr_context_gets_org_aggregates_not_people():
    with SessionLocal() as db:
        user = _user(db, "farhan.ali@timez.com")
        text = build_context(db, user, "What is our headcount by country?").text()
        assert "ORGANISATION (counts only" in text and "Active headcount:" in text
        assert "By country:" in text


def test_disabled_policy_is_not_used():
    from app.models import AiSetting

    with SessionLocal() as db:
        row = db.get(AiSetting, "default")
        before = list(row.disabled_policies) if row else None
        if row is None:
            row = AiSetting(id="default", disabled_policies=[], disabled_agents=[], disabled_features=[])
            db.add(row)
        row.disabled_policies = ["leave-IN"]
        db.commit()
        try:
            user = _user(db, "babu.menon@timez.com")
            ctx = build_context(db, user, "sick leave policy")
            assert not any(s.ref.startswith("leave-IN#") for s in ctx.sources)
        finally:
            row.disabled_policies = before or []
            db.commit()


def test_status_has_no_secrets(client, babu):
    res = client.get("/api/v1/ai/status", headers=babu)
    assert res.status_code == 200
    assert res.json() == {"enabled": False, "model": None}


def test_no_key_falls_back_to_built_in(client, babu, no_real_ai):
    res = client.post(ASK, headers=babu, json={"question": "How many leave days do I have?"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["answer"] is None and body["used_ai"] is False and body["denied"] is False
    assert no_real_ai == []


def test_model_fallback_on_429(client, babu, monkeypatch):
    monkeypatch.setattr(get_settings(), "openrouter_api_key", "test-key")
    seen: list[tuple[str, dict]] = []

    def fake_post(url, *, headers, payload, timeout):  # noqa: ANN001
        seen.append((payload["model"], headers))
        if payload["model"] == "test/model-a":
            return _fake_response(429)
        return _fake_response(200, "<think>working it out</think>You have 6 days of casual leave left.")

    monkeypatch.setattr(ai_copilot, "_post", fake_post)
    res = client.post(ASK, headers=babu, json={
        "question": "How many leave days do I have?",
        "history": [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "Hello!"}],
    })
    body = res.json()
    assert res.status_code == 200, res.text
    assert [m for m, _ in seen] == ["test/model-a", "test/model-b"]
    assert body["used_ai"] is True and body["model"] == "test/model-b"
    assert body["answer"] == "You have 6 days of casual leave left."
    assert any(s["ref"] == "/leave" for s in body["sources"])
    headers = seen[0][1]
    assert headers["Authorization"] == "Bearer test-key" and headers["X-Title"] == "TimeZ HRMS"


def test_all_models_fail_falls_back(client, babu, monkeypatch):
    monkeypatch.setattr(get_settings(), "openrouter_api_key", "test-key")

    def fake_post(url, *, headers, payload, timeout):  # noqa: ANN001
        if payload["model"] == "test/model-a":
            raise httpx.ReadTimeout("slow")
        return _fake_response(503)

    monkeypatch.setattr(ai_copilot, "_post", fake_post)
    body = client.post(ASK, headers=babu, json={"question": "What is the sick leave policy?"}).json()
    assert body["used_ai"] is False and body["answer"] is None and body["model"] is None


def test_other_peoples_pay_is_denied(client, babu, no_real_ai):
    body = client.post(ASK, headers=babu, json={"question": "What is Ram's salary?"}).json()
    assert body["denied"] is True and body["used_ai"] is False and body["answer"]
    assert no_real_ai == []


def test_question_is_audited_without_answer(client, babu, monkeypatch):
    monkeypatch.setattr(get_settings(), "openrouter_api_key", "test-key")
    monkeypatch.setattr(ai_copilot, "_post", lambda url, **kw: _fake_response(200, "Secret answer text"))
    question = "Tell me about the remote work policy please " + "x" * 100
    client.post(ASK, headers=babu, json={"question": question})
    with SessionLocal() as db:
        babu_account = db.scalar(select(Account).where(Account.email == "babu.menon@timez.com"))
        row = db.scalars(
            select(AuditLog).where(AuditLog.entity == "Copilot question", AuditLog.actor_id == babu_account.id)
            .order_by(AuditLog.id.desc())
        ).first()
        assert row is not None
        after = row.changes["after"]
        assert after["question"] == question[:80]
        assert after["model"] == "test/model-a" and after["denied"] is False
        assert isinstance(after["sources"], list)
        assert "Secret answer text" not in str(row.changes)


def test_rate_limit(client, ram):
    for _ in range(ai_copilot.RATE_LIMIT):
        assert client.post(ASK, headers=ram, json={"question": "hello"}).status_code == 200
    assert client.post(ASK, headers=ram, json={"question": "hello"}).status_code == 429


def test_clean_answer_strips_reasoning():
    assert ai_copilot.clean_answer("<thinking>a\nb</thinking>\n Answer ") == "Answer"
    assert ai_copilot.clean_answer("<think>never closed") == ""
