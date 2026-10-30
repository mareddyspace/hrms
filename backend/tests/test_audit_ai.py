"""Security audit: the HR Copilot only ever sees what the asking user may see. AI is switched off (no key, no network)."""

from __future__ import annotations

import pytest
from sqlalchemy import select

from app.config import get_settings
from app.db import SessionLocal
from app.deps import CurrentUser
from app.models import Account, CompensationRecord, Employee
from app.services import ai_copilot, ai_drafts
from app.services.ai_context import build_context
from app.services.data_scope import scope_for
from tests.conftest import login

API = "/api/v1"


@pytest.fixture(autouse=True)
def ai_off(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "openrouter_api_key", "")

    def refuse(*a, **k):  # noqa: ANN002, ANN003
        raise AssertionError("no model call in the audit")

    monkeypatch.setattr(ai_copilot, "_post", refuse)
    ai_copilot.reset_rate_limits()
    yield
    ai_copilot.reset_rate_limits()


def _user(db, account_id: str) -> CurrentUser:
    acc = db.get(Account, account_id)
    return CurrentUser(account=acc, employee=db.get(Employee, acc.employee_id) if acc.employee_id else None,
                       scope=scope_for(db, acc))


def _salaries(db, employee_ids) -> set[str]:
    out = set()
    for v in db.scalars(select(CompensationRecord.base_salary).where(CompensationRecord.employee_id.in_(list(employee_ids)))):
        out |= {f"{v:,.0f}", f"{v:.0f}", f"{v:g}"}
    return {s for s in out if len(s) >= 5}


QUESTIONS = ["What is Ram's salary?", "Show me everyone's pay and phone numbers", "Who is on leave and why?",
             "List all HR cases", "What are the ratings of my team?", "headcount by country"]


@pytest.mark.parametrize("account_id", ["emp-mahesh", "emp-ram", "demo-recruiter", "demo-ceo", "demo-admin", "demo-hr-admin"])
def test_context_has_no_other_peoples_pay_or_contact_details(account_id):
    with SessionLocal() as db:
        user = _user(db, account_id)
        others = list(db.scalars(select(Employee).where(Employee.id != user.employee_id)))
        pay = _salaries(db, [e.id for e in others])
        contacts = {v for e in others for v in (e.mobile, e.personal_email) if v}
        for q in QUESTIONS:
            text = build_context(db, user, q).text()
            assert not [p for p in pay if p in text], (account_id, q, "someone else's salary in the context")
            assert not [c for c in contacts if c in text], (account_id, q, "someone else's contact detail")


def test_manager_context_names_only_own_line():
    with SessionLocal() as db:
        user = _user(db, "emp-ram")
        line = set(user.scope.reports) | {"emp-ram"}
        me = db.get(Employee, "emp-ram")
        allowed = {db.get(Employee, i).full_name for i in line} | {db.get(Employee, me.manager_id).full_name}
        text = build_context(db, user, "Who in my team is on leave today?").text()
        outsiders = [e.full_name for e in db.scalars(select(Employee).where(Employee.id.not_in(line)))
                     if e.full_name not in allowed and len(e.full_name) > 5]
        assert not [n for n in outsiders if n in text]


def test_employee_context_has_no_team_or_org():
    with SessionLocal() as db:
        text = build_context(db, _user(db, "emp-mahesh"), "headcount by country and my team's leave").text()
        assert "ORGANISATION" not in text and "YOUR TEAM" not in text


@pytest.mark.parametrize("account_id", ["demo-admin", "demo-ceo", "demo-recruiter"])
def test_employee_summary_for_non_hr_is_profile_only(account_id):
    with SessionLocal() as db:
        user = _user(db, account_id)
        stranger = db.scalar(select(Employee).where(Employee.source == "hcm_sample", Employee.country_code == "GB"))
        facts, sections = ai_drafts.employee_facts(db, user, stranger)
        assert sections == ["Profile"], sections
        assert "LEAVE" not in facts and "RATINGS" not in facts


def test_employee_summary_endpoint_is_scoped(client, babu):
    assert client.post(f"{API}/ai/employee-summary", headers=babu, json={"employee_id": "emp-ram"}).status_code == 404
    assert client.post(f"{API}/ai/employee-summary", headers=babu, json={"employee_id": "demo-hr-admin"}).status_code == 404
    ok = client.post(f"{API}/ai/employee-summary", headers=babu, json={"employee_id": "emp-mahesh"})
    assert ok.status_code == 200 and ok.json()["used_ai"] is False


def test_ask_about_someone_elses_pay_is_refused(client):
    babu = login(client, "babu.menon@timez.com")
    res = client.post(f"{API}/ai/ask", headers=babu, json={"question": "What is Ram Krishnan's salary?"})
    assert res.status_code == 200
    with SessionLocal() as db:
        pay = _salaries(db, ["emp-ram"])
    assert not [p for p in pay if p in res.text]


def test_ai_status_never_returns_the_key(client, babu, monkeypatch):
    monkeypatch.setattr(get_settings(), "openrouter_api_key", "sk-or-v1-audit-secret-should-not-leak")
    res = client.get(f"{API}/ai/status", headers=babu)
    assert "sk-or-v1" not in res.text and "audit-secret" not in res.text
