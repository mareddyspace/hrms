"""Shared steps for the recruiting / onboarding tests."""

from __future__ import annotations

from datetime import date, timedelta

from app.security import create_access_token

R = "/api/v1/recruiting"
FORWARD = ["Screening", "Shortlisted", "Interview", "Assessment", "Final Review"]


def token_for(account_id: str, role: str) -> dict[str, str]:
    """Signed token without a login (the auth tests lock Alex's account on purpose)."""
    return {"Authorization": f"Bearer {create_access_token(account_id, role)[0]}"}


def add_candidate(client, headers, name: str, email: str, req: str = "JOB-221", **extra):
    body = {"requisition_id": req, "name": name, "email": email, "source": "Referral", "experience_years": 6,
            "skills": ["React", "TypeScript"], "applied_on": date.today().isoformat()} | extra
    return client.post(f"{R}/candidates", headers=headers, json=body)


def move(client, headers, cand_id: str, stage: str, note: str | None = None):
    return client.post(f"{R}/candidates/{cand_id}/stage", headers=headers, json={"stage": stage, "note": note})


def to_offer_stage(client, sophie, ram, cand_id: str) -> None:
    for stage in FORWARD:
        res = move(client, sophie, cand_id, stage)
        assert res.status_code == 200, res.text
    res = move(client, ram, cand_id, "Offer", "Go ahead")
    assert res.status_code == 200, res.text


def accepted_offer(client, sophie, ram, farhan, cand_id: str, start_in_days: int = 14) -> dict:
    start = (date.today() + timedelta(days=start_in_days)).isoformat()
    res = client.post(f"{R}/offers", headers=sophie, json={"candidate_id": cand_id, "grade": "L5", "base_salary": 2400000,
                                                          "start_date": start})
    assert res.status_code == 201, res.text
    oid = res.json()["id"]
    assert client.post(f"{R}/offers/{oid}/submit", headers=sophie).status_code == 200
    assert client.post(f"{R}/offers/{oid}/approve", headers=ram).status_code == 200
    assert client.post(f"{R}/offers/{oid}/approve", headers=farhan).json()["status"] == "approved"
    assert client.post(f"{R}/offers/{oid}/status", headers=sophie, json={"status": "sent"}).status_code == 200
    res = client.post(f"{R}/offers/{oid}/status", headers=sophie, json={"status": "accepted", "note": "Accepted on a call"})
    assert res.status_code == 200, res.text
    return res.json()


def hire(client, sophie, ram, farhan, name: str, email: str, start_in_days: int = 14) -> tuple[dict, dict]:
    """Candidate on JOB-221 taken all the way to Hired. Returns (candidate, joiner)."""
    res = add_candidate(client, sophie, name, email)
    assert res.status_code == 201, res.text
    cand = res.json()
    to_offer_stage(client, sophie, ram, cand["id"])
    accepted_offer(client, sophie, ram, farhan, cand["id"], start_in_days)
    res = move(client, sophie, cand["id"], "Hired")
    assert res.status_code == 200, res.text
    joiner = next(j for j in client.get("/api/v1/onboarding/joiners", headers=farhan).json() if j["candidate_id"] == cand["id"])
    return res.json(), joiner
