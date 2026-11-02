"""Group chat members, mail drafts and grammar check, announcement category / pin, help desk subcategory,
contact preference and FAQ votes (migration 0027)."""

from __future__ import annotations

from app.db import SessionLocal
from app.services import announcement_samples, desk_samples, tickets
from app.services.writing_check import rule_suggestions


def test_extra_samples_are_idempotent():
    with SessionLocal() as db:
        assert announcement_samples.seed(db) == 0
        assert desk_samples.seed(db) == 0
        assert tickets.seed_samples(db) == 0


def test_group_members_add_remove_leave_rename(client, babu, ram):
    cid = client.post("/api/v1/chat/conversations", headers=ram,
                      json={"kind": "group", "title": "QA sync", "member_ids": ["emp-mahesh"]}).json()["id"]
    res = client.post(f"/api/v1/chat/conversations/{cid}/members", headers=ram, json={"member_ids": ["emp-priya"]})
    assert res.status_code == 200 and "emp-priya" in res.json()["participant_ids"]
    # Only the creator removes others; anyone can leave.
    assert client.delete(f"/api/v1/chat/conversations/{cid}/members/emp-priya", headers=babu).status_code == 403
    assert client.delete(f"/api/v1/chat/conversations/{cid}/members/emp-priya", headers=ram).status_code == 200
    res = client.put(f"/api/v1/chat/conversations/{cid}", headers=ram, json={"title": "QA daily"})
    assert res.json()["title"] == "QA daily"
    assert client.delete(f"/api/v1/chat/conversations/{cid}/members/emp-mahesh", headers=babu).status_code == 200
    assert cid not in [c["id"] for c in client.get("/api/v1/chat/conversations", headers=babu).json()]


def test_mail_drafts_are_private(client, babu, ram):
    res = client.post("/api/v1/mail/drafts", headers=babu, json={"to_ids": ["emp-ram"], "subject": "Draft", "body": "Hi"})
    assert res.status_code == 201
    did = res.json()["id"]
    assert client.put(f"/api/v1/mail/drafts/{did}", headers=babu,
                      json={"to_ids": ["emp-ram"], "subject": "Draft 2", "body": "Hi"}).json()["subject"] == "Draft 2"
    assert client.get("/api/v1/mail/drafts", headers=ram).json() == []
    assert client.delete(f"/api/v1/mail/drafts/{did}", headers=ram).status_code == 404
    assert client.delete(f"/api/v1/mail/drafts/{did}", headers=babu).status_code == 204
    assert client.post("/api/v1/mail/drafts", headers=babu, json={}).status_code == 422


def test_grammar_check_rules(client, babu, monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "openrouter_api_key", "")
    res = client.post("/api/v1/mail/check", headers=babu, json={"text": "i recieve teh payslip. could of been sooner"})
    assert res.status_code == 200
    body = res.json()
    assert body["source"] == "rules"
    fixes = {(s["original"], s["replacement"]) for s in body["suggestions"]}
    assert {("i", "I"), ("recieve", "receive"), ("teh", "the"), ("could of", "could have")} <= fixes
    assert not rule_suggestions("e.g. this is fine.")[1:]


def test_grammar_check_uses_the_model_when_set(client, babu, monkeypatch):
    from app.config import get_settings
    from app.services import ai_copilot

    monkeypatch.setattr(get_settings(), "openrouter_api_key", "test-key")
    ai_copilot.reset_rate_limits()
    monkeypatch.setattr(ai_copilot, "_ask_models", lambda messages: (
        '[{"original": "recieve", "replacement": "receive", "message": "Spelling"}]', "m"))
    body = client.post("/api/v1/mail/check", headers=babu, json={"text": "I recieve it"}).json()
    assert body["source"] == "ai"
    assert body["suggestions"] == [{"start": 2, "end": 9, "original": "recieve", "replacement": "receive",
                                    "message": "Spelling"}]
    # A model failure falls back to the rules.
    monkeypatch.setattr(ai_copilot, "_ask_models", lambda messages: (None, None))
    assert client.post("/api/v1/mail/check", headers=babu, json={"text": "I recieve it"}).json()["source"] == "rules"


def test_announcements_have_categories_and_pin(client, babu, farhan):
    rows = client.get("/api/v1/announcements", headers=babu).json()
    assert len(rows) >= 10 and all(r["category"] for r in rows)
    assert any(r["pinned"] for r in rows)
    aid = rows[0]["id"]
    assert client.post(f"/api/v1/announcements/{aid}/pin", headers=babu, json={"pinned": True}).status_code == 403
    res = client.post("/api/v1/announcements", headers=farhan,
                      json={"title": "Fire drill", "body": "Friday 11:00", "scope": "Company", "state": "Published",
                            "category": "Event", "pinned": True})
    assert res.status_code == 201 and res.json()["category"] == "Event" and res.json()["pinned"]
    assert client.post("/api/v1/announcements", headers=farhan,
                       json={"title": "Bad", "body": "x", "scope": "Company", "category": "Nope"}).status_code == 422


def test_desk_subcategory_contact_and_faq_votes(client, babu, ram):
    res = client.post("/api/v1/desk/requests", headers=babu,
                      json={"category": "IT access", "subject": "VPN drops", "description": "Every hour",
                            "priority": "Urgent", "subcategory": "VPN / network", "contact_preference": "chat"})
    assert res.status_code == 201
    assert res.json()["subcategory"] == "VPN / network" and res.json()["contact_preference"] == "chat"
    assert client.post("/api/v1/desk/requests", headers=babu,
                       json={"category": "IT access", "subject": "VPN drops", "description": "x",
                             "subcategory": "Health insurance"}).status_code == 422
    assert client.post("/api/v1/desk/faq/faq-1/vote", headers=babu, json={"helpful": True}).json()["helpful"] >= 1
    out = client.post("/api/v1/desk/faq/faq-1/vote", headers=babu, json={"helpful": False}).json()
    assert out["mine"] is False
    votes = client.get("/api/v1/desk/faq-votes", headers=ram).json()
    assert votes["faq-1"]["mine"] is None and votes["faq-1"]["not_helpful"] >= 1
