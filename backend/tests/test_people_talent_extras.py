"""People & Organization / Performance & Learning additions: total rewards for others, directory documents,
continuous feedback, the anonymous 360 summary, the employee ID on basic cards and the AI assistants."""
import pytest

from app.db import SessionLocal
from app.models import AccessScope

COMP = "/api/v1/compensation"


def _set_comp_access(account_id: str, value: bool) -> None:
    with SessionLocal() as db:
        row = db.get(AccessScope, account_id) or AccessScope(account_id=account_id)
        row.comp_access = value
        db.add(row)
        db.commit()


# ---------- total rewards statement ----------
def test_statement_defaults_to_self(client, babu):
    res = client.get(f"{COMP}/statement", headers=babu)
    assert res.status_code == 200, res.text
    assert res.json()["employee_id"] == "emp-mahesh"


def test_hr_sees_someone_elses_statement(client, farhan):
    res = client.get(f"{COMP}/statement", headers=farhan, params={"employee_id": "emp-mahesh"})
    assert res.status_code == 200, res.text
    assert res.json()["employee_id"] == "emp-mahesh"


def test_manager_without_grant_gets_no_statement(client, ram, babu):
    assert client.get(f"{COMP}/statement", headers=ram, params={"employee_id": "emp-mahesh"}).status_code == 403
    # A peer / report cannot read their manager's statement either.
    assert client.get(f"{COMP}/statement", headers=babu, params={"employee_id": "emp-ram"}).status_code in (403, 404)


def test_explicit_comp_grant_opens_statement(client, ram):
    _set_comp_access("emp-ram", True)
    try:
        assert client.get(f"{COMP}/statement", headers=ram, params={"employee_id": "emp-mahesh"}).status_code == 200
    finally:
        _set_comp_access("emp-ram", False)


# ---------- directory profile documents ----------
def test_profile_documents_follow_viewer(client, farhan, ram, babu):
    hr = client.get("/api/v1/documents", headers=farhan, params={"employee_id": "emp-mahesh"})
    assert hr.status_code == 200 and len(hr.json()) >= 1
    mgr = client.get("/api/v1/documents", headers=ram, params={"employee_id": "emp-mahesh"})
    assert mgr.status_code == 200
    assert len(mgr.json()) <= len(hr.json())
    assert all(d["category"] not in ("Identity", "Payroll") for d in mgr.json())
    # A colleague who is not in the line sees nothing of someone else's file.
    assert client.get("/api/v1/documents", headers=babu, params={"employee_id": "emp-ram"}).status_code in (403, 404)


# ---------- continuous feedback ----------
PERF = "/api/v1/performance"


def test_praise_is_public_private_feedback_is_not(client, babu, ram, farhan):
    praise = client.post(f"{PERF}/feedback", headers=babu, json={"kind": "praise", "to_id": "emp-ram", "badge": "Ownership",
                                                                  "message": "Great sprint planning session this week, thanks."})
    assert praise.status_code == 201, praise.text
    private = client.post(f"{PERF}/feedback", headers=babu, json={"kind": "feedback", "to_id": "emp-ram",
                                                                   "message": "Private note: the design review ran a bit long."})
    assert private.status_code == 201
    hr_view = {f["id"] for f in client.get(f"{PERF}/feedback", headers=farhan).json()}
    assert praise.json()["id"] in hr_view and private.json()["id"] not in hr_view
    ram_view = {f["id"] for f in client.get(f"{PERF}/feedback", headers=ram).json()}
    assert private.json()["id"] in ram_view
    # Same message twice within 10 minutes is refused; too short is refused; not to yourself.
    again = client.post(f"{PERF}/feedback", headers=babu, json={"kind": "feedback", "to_id": "emp-ram",
                                                                 "message": "Private note: the design review ran a bit long."})
    assert again.status_code == 409
    assert client.post(f"{PERF}/feedback", headers=babu, json={"kind": "praise", "to_id": "emp-ram", "message": "short"}).status_code == 422
    assert client.post(f"{PERF}/feedback", headers=babu, json={"kind": "praise", "to_id": "emp-mahesh",
                                                                "message": "Praising myself is not allowed here."}).status_code == 422


def test_feedback_request_answered_only_by_the_person_asked(client, babu, ram, farhan):
    req = client.post(f"{PERF}/feedback", headers=babu, json={"kind": "request", "to_id": "emp-ram",
                                                               "message": "How did my demo on Friday come across?"})
    assert req.status_code == 201 and req.json()["status"] == "open"
    rid = req.json()["id"]
    assert client.post(f"{PERF}/feedback/{rid}/answer", headers=farhan, json={"message": "Not my request to answer."}).status_code == 404
    ans = client.post(f"{PERF}/feedback/{rid}/answer", headers=ram, json={"message": "Clear and well paced, add a summary slide."})
    assert ans.status_code == 201 and ans.json()["to_id"] == "emp-mahesh"
    assert client.post(f"{PERF}/feedback/{rid}/answer", headers=ram, json={"message": "Answering a second time here."}).status_code == 409
    mine = {f["id"]: f for f in client.get(f"{PERF}/feedback", headers=babu).json()}
    assert mine[rid]["status"] == "answered" and ans.json()["id"] in mine


def test_360_summary_is_anonymous_and_only_after_release(client, babu, ram):
    import uuid
    from datetime import date

    from app.db import utcnow
    from app.models import PerfReview, Reviewer360, ReviewCycle

    cid, rid = f"cyc-t{uuid.uuid4().hex[:6]}", f"rev-t{uuid.uuid4().hex[:6]}"
    with SessionLocal() as db:
        db.add(ReviewCycle(id=cid, name=f"Summary test {cid}", status="calibration", start_date=date(2026, 1, 1),
                           end_date=date(2026, 6, 30), self_review_due=date(2026, 6, 1), manager_review_due=date(2026, 6, 15)))
        db.flush()
        db.add(PerfReview(id=rid, cycle_id=cid, employee_id="emp-mahesh", self_status="submitted", manager_status="submitted",
                          rating="Strong", released=False))
        db.flush()
        for who, rating, comment in (("demo-recruiter", 4, "Helpful in panels."), ("demo-hr-admin", 5, "Great mentor.")):
            db.add(Reviewer360(review_id=rid, reviewer_id=who, nominated_by="emp-mahesh", nominated_at=utcnow(),
                               rating=rating, comment=comment, responded_at=utcnow()))
        db.commit()

    def mine(headers):
        return next(r for r in client.get(f"{PERF}/reviews", headers=headers, params={"cycle_id": cid}).json() if r["id"] == rid)

    before = mine(babu)
    assert before["summary_360"] is None and all(r["rating"] is None and r["comment"] is None for r in before["reviewers"])
    with SessionLocal() as db:
        db.get(PerfReview, rid).released = True
        db.commit()
    after = mine(babu)
    assert after["summary_360"] == {"responses": 2, "average_rating": 4.5, "comments": ["Great mentor.", "Helpful in panels."]}
    assert all(r["comment"] is None for r in after["reviewers"])
    # The manager sees who said what, and gets no "summary" (that is the employee's view).
    manager = mine(ram)
    assert manager["summary_360"] is None and {r["rating"] for r in manager["reviewers"]} == {4, 5}


def test_basic_directory_card_shows_employee_id(client, babu):
    """The employee ID is not sensitive: colleagues outside your line see it on the basic card (but nothing private)."""
    res = client.get("/api/v1/people/demo-recruiter", headers=babu)
    assert res.status_code == 200
    card = res.json()
    assert card["view"] == "basic" and card["employee_code"]
    assert "mobile" not in card and "date_of_birth" not in card


# ---------- AI assistants (agents) ----------
AI = "/api/v1/ai"


@pytest.fixture
def no_key_ai(monkeypatch):
    from app.config import get_settings
    from app.services import ai_copilot

    settings = get_settings()
    monkeypatch.setattr(settings, "openrouter_api_key", "")
    ai_copilot.reset_rate_limits()
    yield
    ai_copilot.reset_rate_limits()


def test_agents_list_follows_role_and_reports_builtin_mode(client, babu, ram, farhan, no_key_ai):
    mine = {a["id"]: a for a in client.get(f"{AI}/agents", headers=babu).json()}
    assert {"employee", "knowledge", "career", "document"} <= set(mine)
    assert not {"manager", "hr", "recruiter", "analytics"} & set(mine)
    assert all(a["mode"] == "builtin" for a in mine.values())
    assert "manager" in {a["id"] for a in client.get(f"{AI}/agents", headers=ram).json()}
    assert {"hr", "recruiter", "analytics"} <= {a["id"] for a in client.get(f"{AI}/agents", headers=farhan).json()}


def test_agent_question_is_role_checked_on_the_server(client, babu, ram, no_key_ai):
    q = {"question": "What approvals are waiting for me?"}
    assert client.post(f"{AI}/ask", headers=babu, json={**q, "agent": "manager"}).status_code == 403
    assert client.post(f"{AI}/ask", headers=babu, json={**q, "agent": "nope"}).status_code == 404
    ok = client.post(f"{AI}/ask", headers=ram, json={**q, "agent": "manager"})
    assert ok.status_code == 200 and ok.json()["used_ai"] is False  # no key: the portal shows its built-in answer
    career = client.post(f"{AI}/ask", headers=babu, json={"question": "Which skills should I build next?", "agent": "career"})
    assert career.status_code == 200
    # Other people's pay is refused whatever the assistant.
    denied = client.post(f"{AI}/ask", headers=babu, json={"question": "What is Ram's salary?", "agent": "career"})
    assert denied.json()["denied"] is True


def test_agent_focus_goes_into_the_prompt(monkeypatch):
    from app.services import ai_agents, ai_copilot

    msgs = ai_copilot._messages("CTX", "q", [], ai_agents.prompt_line(ai_agents.AGENTS["career"]))
    assert "Career coach" in msgs[0]["content"] and msgs[0]["content"].endswith("CONTEXT\nCTX")


def test_switched_off_agent_is_refused(client, babu, no_key_ai):
    from app.models import AiSetting

    with SessionLocal() as db:
        row = db.get(AiSetting, "default") or AiSetting(id="default", disabled_policies=[], disabled_agents=[], disabled_features=[])
        before = list(row.disabled_agents or [])
        row.disabled_agents = [*before, "career"]
        db.add(row)
        db.commit()
    try:
        assert client.post(f"{AI}/ask", headers=babu, json={"question": "next skills?", "agent": "career"}).status_code == 409
        assert next(a for a in client.get(f"{AI}/agents", headers=babu).json() if a["id"] == "career")["available"] is False
    finally:
        with SessionLocal() as db:
            db.get(AiSetting, "default").disabled_agents = before
            db.commit()
