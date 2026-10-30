"""Policies HR publishes and employees acknowledge; letter preview with own text; skill details (migration 0018)."""

from __future__ import annotations

API = "/api/v1"


# ---------- skills ----------
def test_skill_details_saved_and_listed(client, babu):
    body = {"skill": "Kubernetes", "level": 3, "target_level": 4, "years": 2.5, "last_used": "2026-09",
            "evidence_url": "https://example.com/cka-certificate"}
    res = client.put(f"{API}/learning/skills/me", json=body, headers=babu)
    assert res.status_code == 200, res.text
    row = res.json()
    assert row["years"] == 2.5 and row["last_used"] == "2026-09" and row["evidence_url"].startswith("https://")
    listed = client.get(f"{API}/learning/skills", headers=babu).json()
    assert any(s["skill"] == "Kubernetes" and s["years"] == 2.5 for s in listed)
    bad = client.put(f"{API}/learning/skills/me", json={**body, "evidence_url": "javascript:alert(1)"}, headers=babu)
    assert bad.status_code == 422
    client.delete(f"{API}/learning/skills/me/{row['id']}", headers=babu)


# ---------- letters ----------
def test_salary_certificate_and_bonafide_preview(client, babu):
    for letter_type, needle in (("Salary certificate", "annual base salary"), ("Bonafide", "bonafide employee")):
        res = client.post(f"{API}/letters/draft-preview", json={"letter_type": letter_type}, headers=babu)
        assert res.status_code == 200, res.text
        out = res.json()
        assert any(needle in p for p in out["paragraphs"]), out
        assert out["fields"]["employee_name"] == "Babu Menon"


def test_own_text_goes_into_the_letter(client, babu, monkeypatch):
    from app.services import ai_copilot

    asked: list[list[dict]] = []
    monkeypatch.setattr(ai_copilot, "_ask_models", lambda m: (asked.append(m), (None, None))[1])
    worded = client.post(f"{API}/letters/word-text", json={"letter_type": "Visa/Travel", "text": "I'm going to Germany"},
                         headers=babu)
    assert worded.status_code == 200
    assert worded.json() == {"paragraph": None, "used_ai": False}  # no AI: the portal words it itself
    assert "Germany" in asked[0][-1]["content"]
    monkeypatch.setattr(ai_copilot, "_ask_models", lambda m: ("**Babu Menon will travel to Germany.**", "test-model"))
    worded = client.post(f"{API}/letters/word-text", json={"letter_type": "Visa/Travel", "text": "I'm going to Germany"},
                         headers=babu).json()
    assert worded == {"paragraph": "Babu Menon will travel to Germany.", "used_ai": True}
    own = "Babu Menon is travelling to Germany for a conference from 10 to 15 November."
    preview = client.post(f"{API}/letters/draft-preview", headers=babu, json={
        "letter_type": "Visa/Travel", "details": "Germany, 10-15 Nov", "custom_text": own}).json()
    assert preview["paragraphs"][-2] == own  # before the closing "issued at the employee's request"
    req = client.post(f"{API}/letters/requests", headers=babu, json={
        "letter_type": "Visa/Travel", "details": "Germany, 10-15 Nov", "note": "Conference", "custom_text": own})
    assert req.status_code == 201, req.text
    assert req.json()["custom_text"] == own
    rid = req.json()["id"]
    paragraphs = client.get(f"{API}/letters/requests/{rid}/preview", headers=babu).json()["paragraphs"]
    assert own in paragraphs
    assert paragraphs.index(own) == len(paragraphs) - 2  # before the closing "issued at the employee's request"
    client.post(f"{API}/letters/requests/{rid}/cancel", headers=babu)


# ---------- policies ----------
def test_seeded_pf_change_waits_for_babu(client, babu, farhan):
    rows = client.get(f"{API}/policies", headers=babu).json()
    pf = next(p for p in rows if p["id"] == "pf-contribution-change")
    assert pf["targets_me"] and pf["requires_ack"] and pf["current_version"] == 1 and pf["my_ack"] is None
    assert "12% to 13%" in pf["versions"][0]["change_summary"]
    notes = client.get(f"{API}/notifications", headers=babu, params={"limit": 100}).json()
    assert any("Provident Fund" in n["title"] for n in notes)

    before = client.get(f"{API}/policies/pf-contribution-change/tracking", headers=farhan).json()
    assert any(p["employee_id"] == "emp-mahesh" for p in before["pending"])

    ack = client.post(f"{API}/policies/pf-contribution-change/acknowledge", json={"comment": "Does this change my CTC?"},
                      headers=babu)
    assert ack.status_code == 200, ack.text
    assert ack.json()["my_ack"]["version"] == "1"
    again = client.post(f"{API}/policies/pf-contribution-change/acknowledge", json={}, headers=babu)
    assert again.status_code == 409

    after = client.get(f"{API}/policies/pf-contribution-change/tracking", headers=farhan).json()
    done = next(p for p in after["done"] if p["employee_id"] == "emp-mahesh")
    assert done["comment"] == "Does this change my CTC?"
    assert after["acknowledged"] == before["acknowledged"] + 1


def test_hr_creates_edits_publishes_and_archives(client, babu, farhan):
    body = {
        "title": "Travel booking rule", "category": "Travel & expenses", "audience_type": "country", "audience_values": ["IN"],
        "requires_ack": True, "summary": "How to book work travel.",
        "sections": [{"heading": "Booking", "rules": ["Book flights at least 14 days ahead.", " "]}],
        "effective_date": "2026-12-01",
    }
    assert client.post(f"{API}/policies", json=body, headers=babu).status_code == 403
    created = client.post(f"{API}/policies", json=body, headers=farhan)
    assert created.status_code == 201, created.text
    pid = created.json()["id"]
    assert created.json()["status"] == "draft" and created.json()["versions"][0]["version"] == 1
    assert created.json()["versions"][0]["sections"][0]["rules"] == ["Book flights at least 14 days ahead."]
    assert all(p["id"] != pid for p in client.get(f"{API}/policies", headers=babu).json())  # drafts stay hidden

    pub = client.post(f"{API}/policies/{pid}/publish", headers=farhan)
    assert pub.status_code == 200, pub.text
    assert pub.json()["notified"] >= 1 and pub.json()["policy"]["current_version"] == 1
    mine = next(p for p in client.get(f"{API}/policies", headers=babu).json() if p["id"] == pid)
    assert mine["targets_me"] and mine["my_ack"] is None

    # v2 needs a change summary; until published, employees still see v1.
    v2 = {**body, "sections": [{"heading": "Booking", "rules": ["Book flights at least 21 days ahead."]}]}
    assert client.put(f"{API}/policies/{pid}", json=v2, headers=farhan).status_code == 200
    assert client.post(f"{API}/policies/{pid}/publish", headers=farhan).status_code == 422
    client.put(f"{API}/policies/{pid}", json={**v2, "change_summary": "Book 21 days ahead (was 14)."}, headers=farhan)
    seen = next(p for p in client.get(f"{API}/policies", headers=babu).json() if p["id"] == pid)
    assert [v["version"] for v in seen["versions"]] == [1]
    assert client.post(f"{API}/policies/{pid}/publish", headers=farhan).status_code == 200
    seen = next(p for p in client.get(f"{API}/policies", headers=babu).json() if p["id"] == pid)
    assert [v["version"] for v in seen["versions"]] == [2, 1]

    reminded = client.post(f"{API}/policies/{pid}/remind", headers=farhan)
    assert reminded.status_code == 200 and reminded.json()["reminded"] >= 1

    assert client.post(f"{API}/policies/{pid}/archive", headers=farhan).status_code == 200
    assert all(p["id"] != pid for p in client.get(f"{API}/policies", headers=babu).json())
    assert client.post(f"{API}/policies/{pid}/restore", headers=farhan).json()["status"] == "published"


def test_department_audience_needs_values(client, farhan):
    res = client.post(f"{API}/policies", headers=farhan, json={
        "title": "Lab safety", "category": "Code of conduct", "audience_type": "department", "audience_values": []})
    assert res.status_code == 422
