"""HR Copilot coverage: the AI context now answers far more questions (profile, attendance, payslips, holidays, tax,
claims, tasks, directory, org, recruiting, navigation), and every new block keeps to the person's permissions."""

from __future__ import annotations

from datetime import date

import httpx
import pytest
from sqlalchemy import delete, select

from app.config import get_settings
from app.db import SessionLocal
from app.deps import CurrentUser
from app.models import Account, Candidate, Employee, PayrollRun, PayrollRunLine, Requisition
from app.services import ai_copilot
from app.services.ai_context import build_context
from app.services.data_scope import scope_for

ASK = "/api/v1/ai/ask"


@pytest.fixture(autouse=True)
def no_real_ai(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "openrouter_api_key", "")
    monkeypatch.setattr(settings, "ai_model", "test/model-a")
    monkeypatch.setattr(settings, "ai_model_fallbacks", "")

    def refuse(url, **kwargs):  # noqa: ANN001
        raise AssertionError("OpenRouter must not be called in this test")

    monkeypatch.setattr(ai_copilot, "_post", refuse)
    ai_copilot.reset_rate_limits()
    yield
    ai_copilot.reset_rate_limits()


def _user(db, email: str) -> CurrentUser:
    account = db.scalar(select(Account).where(Account.email == email))
    employee = db.get(Employee, account.employee_id) if account.employee_id else None
    return CurrentUser(account=account, employee=employee, scope=scope_for(db, account))


def _text(email: str, question: str) -> str:
    with SessionLocal() as db:
        return build_context(db, _user(db, email), question).text()


def _block(text: str, heading: str) -> str:
    """One context block (from its heading to the next blank line)."""
    start = text.index(heading)
    end = text.find("\n\n", start)
    return text[start:] if end == -1 else text[start:end]


# ---------- coverage: an employee's own data ----------
def test_employee_context_covers_own_records():
    text = _text("babu.menon@timez.com", "Tell me about me")
    for heading in (
        "ABOUT THE PERSON ASKING", "YOUR UPCOMING LEAVE", "YOUR ATTENDANCE TODAY", "YOUR PAYSLIPS (your own pay only)",
        "YOUR HOLIDAYS (IN", "YOUR TAX DECLARATIONS", "YOUR CLAIMS, TRIPS AND ADVANCES", "YOUR TASKS AND TICKETS",
        "PORTAL PAGES",
    ):
        assert heading in text, heading
    profile = _block(text, "ABOUT THE PERSON ASKING")
    for fact in ("employee ID:", "joined:", "years of service", "Location:", "Manager:", "Hired by:"):
        assert fact in profile, fact
    assert "Late days this month:" in text and "Next pay date:" in text


def test_employee_does_not_get_manager_hr_or_recruiting_blocks():
    text = _text("babu.menon@timez.com", "headcount by department, department heads and open requisitions")
    for heading in ("ORGANISATION", "DEPARTMENT HEADS", "YOUR REPORTING LINE", "RECRUITING", "YOUR TEAM\n"):
        assert heading not in text, heading
    pages = _block(text, "PORTAL PAGES")
    assert "/leave:" in pages and "/payslips:" in pages and "/help:" in pages
    for hidden in ("/recruiting:", "/compensation:", "/payroll:", "/people/cases:", "/admin:", "/analytics:"):
        assert hidden not in pages, hidden


def test_holidays_are_for_the_persons_country_only():
    with SessionLocal() as db:
        me = _user(db, "babu.menon@timez.com").employee
        from app.models import Holiday

        foreign = {n for (n,) in db.execute(select(Holiday.name).where(Holiday.country_code != me.country_code))}
        own = {n for (n,) in db.execute(select(Holiday.name).where(Holiday.country_code == me.country_code))}
    block = _block(_text("babu.menon@timez.com", "next holiday"), "YOUR HOLIDAYS")
    assert not [n for n in foreign - own if n in block]


def test_tasks_and_tickets_are_only_the_persons_own():
    from app.models import SharedTask, Ticket

    with SessionLocal() as db:
        me = _user(db, "babu.menon@timez.com").employee
        others_tasks = [t.code for t in db.scalars(select(SharedTask).where(SharedTask.assignee_id != me.id))]
        others_tickets = [t.id for t in db.scalars(select(Ticket)) if me.id not in (t.assignee_id, t.sub_owner_id)]
    block = _block(_text("babu.menon@timez.com", "what tasks and tickets are assigned to me"), "YOUR TASKS AND TICKETS")
    assert not [c for c in others_tasks if f" {c} " in block]
    assert not [i for i in others_tickets if f" {i} " in block]


# ---------- payslips: own pay only ----------
def test_payslips_show_own_net_pay_never_a_colleagues():
    with SessionLocal() as db:
        babu = _user(db, "babu.menon@timez.com").employee
        priya = db.scalar(select(Employee).where(Employee.email == "priya.nair@timez.com"))
        run = PayrollRun(id="test-ai-run", month="1999-12", country_code=babu.country_code, legal_entity="AI test entity",
                         currency="INR", status="locked", payday=date(1999, 12, 31))
        db.add(run)
        db.flush()
        for emp, net in ((babu, 12345.67), (priya, 76543.21)):
            db.add(PayrollRunLine(run_id=run.id, employee_id=emp.id, employee_name=emp.full_name, employee_code=emp.employee_code,
                                  days_in_month=31, paid_days=31, gross=net + 1000, deductions_total=1000, net=net))
        db.commit()
    try:
        text = _text("babu.menon@timez.com", "When was I paid and what was my net pay?")
        block = _block(text, "YOUR PAYSLIPS")
        assert "1999-12: paid on 1999-12-31, net pay INR 12,345.67" in block
        assert "76,543.21" not in text and "76543" not in text
    finally:
        with SessionLocal() as db:
            db.execute(delete(PayrollRunLine).where(PayrollRunLine.run_id == "test-ai-run"))
            db.execute(delete(PayrollRun).where(PayrollRun.id == "test-ai-run"))
            db.commit()


# ---------- directory facts about colleagues ----------
def test_named_colleague_gets_directory_card_only():
    text = _text("babu.menon@timez.com", "Who does Priya Nair report to and when did she join?")
    block = _block(text, "PEOPLE NAMED IN THE QUESTION")
    with SessionLocal() as db:
        priya = db.scalar(select(Employee).where(Employee.email == "priya.nair@timez.com"))
        manager = db.get(Employee, priya.manager_id)
        line = next(x for x in block.splitlines() if x.startswith(f"- {priya.full_name}:"))
        assert f"reports to {manager.full_name}" in line and priya.joining_date.isoformat() in line
        # never contact or personal details
        for private in (priya.email, priya.mobile, priya.personal_email, priya.address_line, priya.emergency_phone):
            assert not private or private not in text
        if priya.date_of_birth:
            assert priya.date_of_birth.isoformat() not in block


def test_people_block_only_when_someone_is_named():
    assert "PEOPLE NAMED IN THE QUESTION" not in _text("babu.menon@timez.com", "what is my leave balance?")


def test_colleague_pay_and_personal_questions_still_refused(client, babu):
    for q in ("What is Priya's salary?", "What is Priya Nair's phone number?", "her bank account number"):
        body = client.post(ASK, headers=babu, json={"question": q}).json()
        assert body["denied"] is True, q


# ---------- managers, HR, executives, recruiters ----------
def test_manager_gets_own_reporting_line_not_org():
    with SessionLocal() as db:
        ram = _user(db, "ram.krishnan@timez.com")
        today = date.today()
        direct = [e.full_name for e in db.scalars(select(Employee).where(Employee.manager_id == ram.employee_id))
                  if e.joining_date <= today]  # pre-boarding joiners aren't in the team yet
        text = build_context(db, ram, "who reports to me, by department").text()
        hm_reqs = set(db.scalars(select(Requisition.id).where(Requisition.hiring_manager_id == ram.employee_id)))
    block = _block(text, "YOUR REPORTING LINE")
    assert direct and all(n in block for n in direct)
    assert "DEPARTMENT HEADS" not in text and "ORGANISATION" not in text
    if "RECRUITING" in text:  # only the roles Ram is hiring for
        listed = {ln.split()[1] for ln in _block(text, "RECRUITING").splitlines() if ln.startswith("  - ")}
        assert listed <= hm_reqs


def test_hr_and_executive_get_department_heads():
    for email in ("farhan.ali@timez.com", "jordan.blake@timez.com"):
        assert "DEPARTMENT HEADS" in _text(email, "who are the department heads?"), email


def test_hr_country_scope_limits_department_heads_and_org():
    from app.models import OrgUnit

    with SessionLocal() as db:
        hr = _user(db, "farhan.ali@timez.com")
        hr.scope.countries = ["GB"]
        text = build_context(db, hr, "department heads").text()
        allowed = {u.name for u in db.scalars(select(OrgUnit).where(OrgUnit.type == "department"))
                   if u.country_code in (None, "GB")}
    assert "limited to GB" in text
    if "DEPARTMENT HEADS" in text:
        body = _block(text, "DEPARTMENT HEADS").removeprefix("DEPARTMENT HEADS\n- ")
        listed = {part.split(":")[0].strip() for part in body.split(";")}
        assert listed <= allowed


def test_recruiter_gets_pipeline_counts_without_candidate_details():
    with SessionLocal() as db:
        cands = list(db.scalars(select(Candidate)))
    text = _text("sophie.clark@timez.com", "How many candidates are in the pipeline?")
    block = _block(text, "RECRUITING")
    assert "Candidates by stage:" in block and "Assigned to you as recruiter:" in block
    assert cands
    for c in cands:
        assert c.email not in text and c.name not in text
    assert "/recruiting:" in _block(text, "PORTAL PAGES")


# ---------- AI answers carry the right page links ----------
def _fake(status: int, content: str) -> httpx.Response:
    return httpx.Response(status, json={"choices": [{"message": {"content": content}}]})


@pytest.mark.parametrize(("question", "ref"), [
    ("When is the next holiday?", "/holidays"),
    ("When is payday?", "/payslips"),
    ("What is the status of my tax declarations?", "/investment"),
    ("What tasks are assigned to me?", "/tasks"),
    ("Who does Priya Nair report to?", "/directory"),
])
def test_ai_answer_sources_point_to_the_page(client, babu, monkeypatch, question, ref):
    monkeypatch.setattr(get_settings(), "openrouter_api_key", "test-key")
    seen: list[str] = []

    def fake_post(url, *, headers, payload, timeout):  # noqa: ANN001
        seen.append(payload["messages"][0]["content"])
        return _fake(200, "Here you go.")

    monkeypatch.setattr(ai_copilot, "_post", fake_post)
    body = client.post(ASK, headers=babu, json={"question": question}).json()
    assert body["used_ai"] is True
    assert any(s["ref"] == ref for s in body["sources"]), body["sources"]
    assert "PORTAL PAGES" in seen[0] and "own payslips may be shared" in seen[0].lower()


def test_audit_lists_the_new_data_pages(client, babu):
    client.post(ASK, headers=babu, json={"question": "my attendance today"})
    with SessionLocal() as db:
        acc = db.scalar(select(Account).where(Account.email == "babu.menon@timez.com"))
        from app.models import AuditLog

        row = db.scalars(select(AuditLog).where(AuditLog.entity == "Copilot question", AuditLog.actor_id == acc.id)
                         .order_by(AuditLog.id.desc())).first()
        accessed = row.changes["after"]["data_accessed"]
    for ref in ("/payslips", "/holidays", "/tasks", "/expenses"):
        assert ref in accessed, ref
