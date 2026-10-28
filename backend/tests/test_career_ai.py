"""Skills library & careers, the Employee 360 AI summary and the recruiting AI helpers. OpenRouter is never called."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import select

from app.config import get_settings
from app.db import SessionLocal
from app.deps import CurrentUser
from app.models import Account, AuditLog, CareerPath, CareerProfile, Employee, Interview, Skill
from app.services import ai_copilot, career
from app.services.ai_context import build_context
from app.services.data_scope import scope_for
from tests.conftest import login
from tests.talent_helpers import R, add_candidate

C = "/api/v1/career"


@pytest.fixture(autouse=True)
def no_real_ai(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "openrouter_api_key", "")
    monkeypatch.setattr(settings, "ai_model", "test/model-a")
    monkeypatch.setattr(settings, "ai_model_fallbacks", "")
    calls: list[dict] = []

    def refuse(url, **kwargs):  # noqa: ANN001
        calls.append(kwargs["payload"])
        raise AssertionError("OpenRouter must not be called in this test")

    monkeypatch.setattr(ai_copilot, "_post", refuse)
    ai_copilot.reset_rate_limits()
    yield calls
    ai_copilot.reset_rate_limits()


def _fake_ai(monkeypatch, reply: str) -> list[dict]:
    """AI switched on with a fake OpenRouter that records what it was sent."""
    monkeypatch.setattr(get_settings(), "openrouter_api_key", "test-key")
    sent: list[dict] = []

    def fake_post(url, *, headers, payload, timeout):  # noqa: ANN001
        sent.append(payload)
        return httpx.Response(200, json={"choices": [{"message": {"content": reply}}]})

    monkeypatch.setattr(ai_copilot, "_post", fake_post)
    return sent


@pytest.fixture(scope="module")
def sophie(client):
    return login(client, "sophie.clark@timez.com")


@pytest.fixture(scope="module")
def jordan(client):
    return login(client, "jordan.blake@timez.com")


def _user(db, email: str) -> CurrentUser:
    account = db.scalar(select(Account).where(Account.email == email))
    employee = db.get(Employee, account.employee_id) if account.employee_id else None
    return CurrentUser(account=account, employee=employee, scope=scope_for(db, account))


# ---------- seed ----------
def test_seed_library_paths_profiles_idempotent():
    with SessionLocal() as db:
        assert {s.id for s in db.scalars(select(Skill))} >= {f"sk-{i}" for i in range(1, 13)}
        react = db.get(Skill, "sk-1")
        assert react.category == "technical" and "crs-5" in react.related_course_ids
        assert db.get(Skill, "sk-3").category == "behavioural"
        assert len(list(db.scalars(select(CareerPath)))) >= 10
        assert db.get(CareerPath, "tr-1").required_skills == {"sk-1": "Advanced", "sk-2": "Advanced", "sk-7": "Intermediate"}
        babu = db.get(CareerProfile, "emp-mahesh")
        assert babu is not None and babu.target_role_ids == ["tr-1"]  # Software Engineer L4 -> Senior Engineer
        again = career.seed_career(db)
        assert again == {"skills_added": 0, "career_paths_added": 0, "career_profiles_added": 0}
        db.rollback()


# ---------- library ----------
def test_library_crud_hr_only(client, babu, farhan):
    assert any(s["name"] == "React" for s in client.get(f"{C}/skills", headers=babu).json())
    body = {"name": "Negotiation", "category": "behavioural", "area": "Business", "description": "Reaching agreement.",
            "related_course_ids": ["crs-4"], "certifications": ["CPN"]}
    assert client.post(f"{C}/skills", headers=babu, json=body).status_code == 403
    res = client.post(f"{C}/skills", headers=farhan, json=body)
    assert res.status_code == 201, res.text
    sid = res.json()["id"]
    assert client.post(f"{C}/skills", headers=farhan, json=body | {"name": "negotiation"}).status_code == 409
    assert client.post(f"{C}/skills", headers=farhan, json=body | {"name": "X skill", "related_course_ids": ["nope"]}).status_code == 422
    res = client.put(f"{C}/skills/{sid}", headers=farhan, json=body | {"description": "Getting to yes."})
    assert res.status_code == 200 and res.json()["description"] == "Getting to yes."
    assert client.put(f"{C}/skills/{sid}", headers=babu, json=body).status_code == 403
    assert client.delete(f"{C}/skills/{sid}", headers=farhan).json()["active"] is False
    assert all(s["id"] != sid for s in client.get(f"{C}/skills", headers=babu).json())
    assert any(s["id"] == sid for s in client.get(f"{C}/skills", headers=farhan, params={"include_inactive": True}).json())
    with SessionLocal() as db:
        actions = set(db.scalars(select(AuditLog.action).where(AuditLog.entity == "skill", AuditLog.entity_id == sid)))
        assert actions == {"skill_added", "skill_updated", "skill_retired"}


# ---------- career profile, team interests ----------
def test_my_career_profile_and_team_visibility(client, babu, ram, farhan, sophie):
    mine = client.get(f"{C}/me", headers=babu).json()
    assert mine["saved"] is True and mine["target_roles"] == ["Senior Engineer"]
    bad = {"target_role_ids": ["tr-1", "tr-2", "tr-3", "tr-4"], "interests": [], "timeframe": "1–2 years"}
    assert client.put(f"{C}/me", headers=babu, json=bad).status_code == 422
    assert client.put(f"{C}/me", headers=babu, json={"target_role_ids": [], "interests": [], "timeframe": "1–2 years"}).status_code == 422
    assert client.put(f"{C}/me", headers=babu, json={"target_role_ids": ["tr-2"], "interests": ["Cooking"],
                                                    "timeframe": "1–2 years"}).status_code == 422
    assert client.put(f"{C}/me", headers=babu, json={"target_role_ids": ["tr-2"], "interests": [], "timeframe": "soon"}).status_code == 422
    body = {"target_role_ids": ["tr-1", "tr-2"], "interests": ["Engineering"], "timeframe": "Next 6 months",
            "open_to_relocation": True, "mentor_id": "emp-ram", "note": "Keen on system design."}
    res = client.put(f"{C}/me", headers=babu, json=body)
    assert res.status_code == 200, res.text
    out = res.json()
    assert out["target_roles"] == ["Senior Engineer", "Tech Lead"] and out["mentor_name"] == "Ram Krishnan"
    assert out["current_role"] == "Software Engineer"
    # manager and HR see it; a recruiter outside the line does not
    assert client.get(f"{C}/profiles/emp-mahesh", headers=ram).json()["timeframe"] == "Next 6 months"
    assert client.get(f"{C}/profiles/emp-mahesh", headers=farhan).status_code == 200
    assert client.get(f"{C}/profiles/emp-mahesh", headers=sophie).status_code == 404
    assert client.get(f"{C}/profiles/emp-ram", headers=babu).status_code == 404
    team = client.get(f"{C}/team-interests", headers=ram).json()
    assert any(p["employee_id"] == "emp-mahesh" for p in team) and all(p["employee_id"] != "emp-ram" for p in team)
    assert any(p["employee_id"] == "emp-mahesh" for p in client.get(f"{C}/team-interests", headers=farhan).json())
    assert client.get(f"{C}/team-interests", headers=babu).status_code == 403
    with SessionLocal() as db:
        row = db.scalars(select(AuditLog).where(AuditLog.entity == "career_profile", AuditLog.entity_id == "emp-mahesh")
                         .order_by(AuditLog.id.desc())).first()
        assert row is not None and "Keen on system design" not in str(row.changes)


# ---------- role matches ----------
def test_role_matches_port(client, babu, ram, sophie):
    res = client.get(f"{C}/matches", headers=babu)
    assert res.status_code == 200, res.text
    body = res.json()
    matches = body["matches"]
    assert matches and all(m["title"].lower() != "software engineer" for m in matches)
    assert [m["score"] for m in matches] == sorted((m["score"] for m in matches), reverse=True)
    senior = next(m for m in matches if m["key"] == "tr-1")
    # starter skills for Babu: React Advanced, TypeScript Intermediate, System design Intermediate
    if not body["skills_saved"]:
        assert senior["match"] == round((1 + 3 / 4 + 1) / 3 * 100)
        assert [g["skill_id"] for g in senior["gaps"]] == ["sk-2"]
    assert "Your target role" in senior["reasons"]
    for m in matches:
        assert m["timeline"] and m["timeline"][-1]["to_week"] == m["total_weeks"]
        for g in m["gaps"]:
            assert g["levels"] > 0
    assert any(c["id"] == "crs-2" for m in matches for c in m["recommended_courses"])  # Secure coding builds TypeScript
    assert client.get(f"{C}/matches", headers=ram, params={"employee_id": "emp-mahesh"}).status_code == 200
    assert client.get(f"{C}/matches", headers=sophie, params={"employee_id": "emp-mahesh"}).status_code == 404


def test_rank_roles_relocation_rule():
    with SessionLocal() as db:
        user = _user(db, "babu.menon@timez.com")
        emp = user.employee
        profile = db.get(CareerProfile, emp.id)
        before = profile.open_to_relocation
        try:
            profile.open_to_relocation = False
            jobs = [m for m in career.rank_roles(db, user, emp, limit=50) if m.role.source == "Open job"]
            away = [m for m in jobs if "Needs relocation" in m.reasons]
            assert away and all(m.score <= m.match + 15 + 8 + 3 - 20 for m in away)
        finally:
            profile.open_to_relocation = before
            db.rollback()


# ---------- Copilot context ----------
def test_copilot_context_talent_blocks():
    with SessionLocal() as db:
        babu = _user(db, "babu.menon@timez.com")
        text = build_context(db, babu, "What are my goals and courses?").text()
        assert "YOUR GOALS" in text and "Ship timesheet calendar UX" in text
        assert "YOUR SKILLS" in text and "YOUR LEARNING" in text and "AWS Certified Developer" in text
        assert "YOUR BENEFITS" in text and "YOUR CAREER INTERESTS" in text
        assert "YOUR DIRECT REPORTS' GOALS" not in text and "CAREER INTERESTS IN YOUR HR SCOPE" not in text
        ram = _user(db, "ram.krishnan@timez.com")
        text = build_context(db, ram, "How is my team doing on goals?").text()
        assert "YOUR DIRECT REPORTS' GOALS" in text and "Babu Menon" in text
        assert "Ship timesheet calendar UX" not in text  # reports' goal titles stay out; progress only
        assert "YOUR TEAM'S CAREER INTERESTS (counts only)" in text
        farhan = _user(db, "farhan.ali@timez.com")
        assert "CAREER INTERESTS IN YOUR HR SCOPE (counts only)" in build_context(db, farhan, "career interests").text()


def test_copilot_shows_only_released_ratings():
    from app.models import PerfReview

    with SessionLocal() as db:
        rid = f"rev-test-{uuid.uuid4().hex[:6]}"
        db.add(PerfReview(id=rid, cycle_id="cyc-y26", employee_id="emp-mahesh", rating="Exceptional", released=False))
        db.commit()
        try:
            babu = _user(db, "babu.menon@timez.com")
            assert "Exceptional" not in build_context(db, babu, "my rating").text()
            db.get(PerfReview, rid).released = True
            db.commit()
            assert "FY2026 annual review: Exceptional" in build_context(db, babu, "my rating").text()
        finally:
            db.delete(db.get(PerfReview, rid))
            db.commit()


# ---------- Employee 360 summary ----------
def test_employee_summary_fallback_and_permissions(client, babu, ram, sophie, no_real_ai):
    res = client.post("/api/v1/ai/employee-summary", headers=ram, json={"employee_id": "emp-mahesh"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["summary"] is None and body["used_ai"] is False
    assert {"Profile", "Goals", "Skills"} <= set(body["sections"]) and "Benefits" not in body["sections"]
    assert no_real_ai == []
    assert client.post("/api/v1/ai/employee-summary", headers=sophie, json={"employee_id": "emp-mahesh"}).status_code == 404
    own = client.post("/api/v1/ai/employee-summary", headers=babu, json={"employee_id": "emp-mahesh"}).json()
    assert "Benefits" in own["sections"]  # own benefits only


def test_employee_summary_uses_only_visible_sections(client, ram, jordan, monkeypatch):
    sent = _fake_ai(monkeypatch, "<think>x</think>Babu is a Software Engineer in Engineering.")
    body = client.post("/api/v1/ai/employee-summary", headers=ram, json={"employee_id": "emp-mahesh"}).json()
    assert body["used_ai"] is True and body["summary"] == "Babu is a Software Engineer in Engineering."
    facts = sent[-1]["messages"][0]["content"]
    assert "GOALS" in facts and "YOUR BENEFITS" not in facts and "salary" not in facts.lower()
    assert "Do not" in facts or "Never" in facts
    # the CEO is above everyone, so the profile and talent sections are used; never someone else's benefits
    body = client.post("/api/v1/ai/employee-summary", headers=jordan, json={"employee_id": "demo-recruiter"}).json()
    assert body["sections"][0] == "Profile" and "Benefits" not in body["sections"]
    with SessionLocal() as db:
        row = db.scalars(select(AuditLog).where(AuditLog.entity == "AI employee summary").order_by(AuditLog.id.desc())).first()
        assert row is not None and "Software Engineer in Engineering" not in str(row.changes)


# ---------- recruiting helpers ----------
def _two_candidates(client, sophie) -> list[str]:
    ids = []
    for name in ("Compare One", "Compare Two"):
        res = add_candidate(client, sophie, name, f"{name.replace(' ', '.').lower()}.{uuid.uuid4().hex[:5]}@example.com",
                            skills=["React", "TypeScript"] if name.endswith("One") else ["Java"])
        assert res.status_code == 201, res.text
        ids.append(res.json()["id"])
    with SessionLocal() as db:
        when = datetime.now(UTC) - timedelta(days=1)
        for i, (score, notes) in enumerate(((4, "Strong React depth, clear communication."), (2, "Concern: limited system design."))):
            db.add(Interview(id=f"int-t{uuid.uuid4().hex[:8]}", candidate_id=ids[0], scheduled_at=when, kind=["Technical", "Panel"][i],
                             panel_ids=["emp-mahesh"], feedback_status="submitted", score=score, feedback=notes,
                             feedback_by="emp-mahesh", feedback_at=when))
        db.add(Interview(id=f"int-t{uuid.uuid4().hex[:8]}", candidate_id=ids[0], scheduled_at=when + timedelta(days=3),
                         kind="Hiring manager", panel_ids=["emp-ram"], feedback_status="pending"))
        db.commit()
    return ids


def test_compare_and_feedback_summary_rule_based(client, babu, ram, sophie, no_real_ai):
    ids = _two_candidates(client, sophie)
    res = client.post(f"{R}/compare", headers=sophie, json={"candidate_ids": ids, "requisition_id": "JOB-221"})
    assert res.status_code == 200, res.text
    body = res.json()
    one, two = body["rows"]
    assert one["interview_scores"] == [4, 2] and one["average_score"] == 3.0 and one["interviews_pending"] == 1
    assert "React" in one["matched_skills"] and two["interview_scores"] == []
    assert body["used_ai"] is False and "Compare One" in body["summary"] and "decisions" in body["note"].lower()
    assert no_real_ai == []
    # hiring manager may; an employee may not; candidates must belong to the job; 2-4 only
    assert client.post(f"{R}/compare", headers=ram, json={"candidate_ids": ids, "requisition_id": "JOB-221"}).status_code == 200
    assert client.post(f"{R}/compare", headers=babu, json={"candidate_ids": ids, "requisition_id": "JOB-221"}).status_code == 404
    assert client.post(f"{R}/compare", headers=sophie, json={"candidate_ids": ids[:1], "requisition_id": "JOB-221"}).status_code == 422
    assert client.post(f"{R}/compare", headers=sophie, json={"candidate_ids": [ids[0], "cand-2"],
                                                             "requisition_id": "JOB-221"}).status_code == 422
    res = client.post(f"{R}/candidates/{ids[0]}/feedback-summary", headers=sophie)
    assert res.status_code == 200, res.text
    fb = res.json()
    assert fb["used_ai"] is False and fb["interviews_done"] == 2 and fb["interviews_pending"] == 1
    assert "average score 3/5" in fb["summary"] and "Concerns raised in: Panel" in fb["summary"]
    assert "disagree" in fb["summary"]
    empty = client.post(f"{R}/candidates/{ids[1]}/feedback-summary", headers=sophie).json()
    assert empty["summary"] == "No interviews yet."
    assert client.post(f"{R}/candidates/{ids[0]}/feedback-summary", headers=babu).status_code == 404  # babu is on the panel only
    with SessionLocal() as db:
        entities = set(db.scalars(select(AuditLog.entity).where(AuditLog.entity.in_(("AI candidate comparison", "AI feedback summary")))))
        assert entities == {"AI candidate comparison", "AI feedback summary"}


def test_compare_with_ai(client, sophie, monkeypatch):
    ids = _two_candidates(client, sophie)
    sent = _fake_ai(monkeypatch, "Compare One has more React depth; Compare Two has no interviews yet.")
    body = client.post(f"{R}/compare", headers=sophie, json={"candidate_ids": ids, "requisition_id": "JOB-221"}).json()
    assert body["used_ai"] is True and body["model"] == "test/model-a" and body["summary"].startswith("Compare One")
    prompt = sent[-1]["messages"][0]["content"]
    assert "do not rank or recommend" in prompt and "@example.com" not in prompt  # no contact details sent
    fb = client.post(f"{R}/candidates/{ids[0]}/feedback-summary", headers=sophie).json()
    assert fb["used_ai"] is True and "Strong React depth" in sent[-1]["messages"][0]["content"]
