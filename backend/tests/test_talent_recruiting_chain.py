"""The whole hiring chain through the API: requisition -> approval -> job post -> application (careers page and the
internal board) -> screening -> interview -> scorecard -> offer with letter -> candidate answers through the link ->
joiner in onboarding."""

from __future__ import annotations

import base64
from datetime import UTC, date, datetime, timedelta

import pytest
from sqlalchemy import select

from app.db import SessionLocal
from app.models import Candidate, Interview, Joiner
from tests.conftest import login
from tests.talent_helpers import R, move, token_for

P = "/api/v1/public"
CV_TEXT = ("Lena Fischer\nlena.fischer@example.com\n+49 151 555 0101\nSenior Frontend Engineer at Webshop GmbH\n"
           "8 years of experience with React, TypeScript, GraphQL and system design.\n")


@pytest.fixture(scope="module")
def sophie(client):
    return login(client, "sophie.clark@timez.com")


@pytest.fixture(scope="module")
def jordan(client):
    return login(client, "jordan.blake@timez.com")


@pytest.fixture(scope="module")
def admin():
    return token_for("demo-admin", "admin")


def _notes(client, headers) -> list[dict]:
    return client.get("/api/v1/notifications", headers=headers).json()


def _approved_requisition(client, ram, jordan, farhan, admin, title: str) -> dict:
    body = {"title": title, "department": "Engineering", "country_code": "IN", "location": "Bengaluru", "openings": 1,
            "requirements": ["React", "TypeScript", "5+ years"], "budget": 3200000, "reason": "new_role",
            "justification": "New squad for the payroll product."}
    res = client.post(f"{R}/requisitions", headers=ram, json=body)
    assert res.status_code == 201, res.text
    req = res.json()
    assert req["budget"] == 3200000 and req["budget_currency"] == "INR" and req["reason"] == "new_role"
    assert req["raised_by"] == "emp-ram" and req["posting"] is None
    # the approval chain from the approvals inbox: department head, HR, finance (admin)
    for who in (jordan, farhan, admin):
        res = client.post(f"/api/v1/approvals/{req['approval_id']}/decision", headers=who, json={"decision": "approve"})
        assert res.status_code == 200, res.text
    got = client.get(f"{R}/requisitions/{req['id']}", headers=ram).json()
    assert got["status"] == "approved" and got["recruiter_id"] == "demo-recruiter"
    return got


def test_full_hiring_chain(client, babu, ram, farhan, sophie, jordan, admin):
    req = _approved_requisition(client, ram, jordan, farhan, admin, "Senior Frontend Engineer")
    rid = req["id"]

    # ---- job post ----
    closing = (date.today() + timedelta(days=30)).isoformat()
    post_body = {"title": "Senior Frontend Engineer", "description": "Build the React front end of our payroll product. " * 2,
                 "location": "Bengaluru (hybrid)", "closing_date": closing, "on_careers_site": True}
    assert client.post(f"{R}/requisitions/{rid}/posting", headers=babu, json=post_body).status_code == 404
    assert client.post(f"{R}/requisitions/{rid}/posting", headers=ram, json=post_body).status_code == 403  # recruiter posts
    past = post_body | {"closing_date": (date.today() - timedelta(days=1)).isoformat()}
    assert client.post(f"{R}/requisitions/{rid}/posting", headers=sophie, json=past).status_code == 422
    res = client.post(f"{R}/requisitions/{rid}/posting", headers=sophie, json=post_body)
    assert res.status_code == 200, res.text
    posting = res.json()["posting"]
    assert posting["status"] == "open" and posting["closing_date"] == closing
    pid = posting["id"]
    assert any(n["title"] == "Senior Frontend Engineer is posted" for n in _notes(client, ram))
    board = client.get(f"{R}/postings", headers=babu).json()
    assert rid in {r["id"] for r in board}
    assert all(r["budget"] is None and r["stage_counts"] == {} for r in board)  # no budget / pipeline on the board
    careers = client.get(f"{P}/careers").json()  # no sign-in
    mine = next(p for p in careers if p["id"] == pid)
    assert mine["title"] == "Senior Frontend Engineer" and mine["country_name"] == "India" and "budget" not in mine

    # ---- application from the careers page (no sign-in) ----
    apply = {"name": "Lena Fischer", "email": "Lena.Fischer@example.com", "phone": "+49 151 555 0101",
             "cover_note": "I build design systems.", "cv_filename": "lena-fischer.txt",
             "cv_base64": base64.b64encode(CV_TEXT.encode()).decode()}
    assert client.post(f"{P}/careers/{pid}/apply", json=apply | {"cv_filename": "cv.exe"}).status_code == 415
    assert client.post(f"{P}/careers/{pid}/apply", json=apply | {"cv_base64": "%%%"}).status_code == 422
    assert client.post(f"{P}/careers/post-nope/apply", json=apply).status_code == 404
    res = client.post(f"{P}/careers/{pid}/apply", json=apply)
    assert res.status_code == 201, res.text
    cid = res.json()["reference"]
    assert client.post(f"{P}/careers/{pid}/apply", json=apply).status_code == 409  # once per job
    cand = client.get(f"{R}/candidates/{cid}", headers=sophie).json()
    assert cand["stage"] == "Applied" and cand["source"] == "Careers site" and cand["has_cv"] and cand["posting_id"] == pid
    assert cand["email"] == "lena.fischer@example.com" and "React" in cand["skills"] and cand["cover_note"]
    note = next(n for n in _notes(client, sophie) if n["title"] == "New application: Lena Fischer")
    assert note["href"] == f"/recruiting/candidates/{cid}"
    assert client.get(f"{R}/candidates/{cid}/cv", headers=sophie).content == CV_TEXT.encode()

    # ---- internal application from the jobs board ----
    assert client.post(f"{R}/postings/{pid}/apply", headers=ram, json={}).status_code == 409  # the hiring manager
    res = client.post(f"{R}/postings/{pid}/apply", headers=babu, json={"cover_note": "I want to move to frontend."})
    assert res.status_code == 201, res.text
    internal_id = res.json()["reference"]
    assert client.post(f"{R}/postings/{pid}/apply", headers=babu, json={}).status_code == 409
    apps = client.get(f"{R}/my-applications", headers=babu).json()
    assert any(a["id"] == internal_id and a["stage"] == "Applied" for a in apps)
    counts = client.get(f"{R}/requisitions/{rid}", headers=sophie).json()
    assert counts["stage_counts"] == {"Applied": 2} and counts["candidate_count"] == 2 and counts["posting"]["applications"] == 2

    # ---- screening ----
    assert client.post(f"{R}/candidates/{internal_id}/screen", headers=sophie, json={"decision": "reject"}).status_code == 422
    assert client.post(f"{R}/candidates/{cid}/screen", headers=ram, json={"decision": "shortlist"}).status_code == 403
    res = client.post(f"{R}/candidates/{internal_id}/screen", headers=sophie, json={"decision": "reject", "reason": "Needs more React"})
    assert res.json()["stage"] == "Rejected"
    assert any(n["title"] == "Your application: Senior Frontend Engineer" and n["href"] == "/internal-jobs" for n in _notes(client, babu))
    res = client.post(f"{R}/candidates/{cid}/screen", headers=sophie, json={"decision": "shortlist"})
    assert res.status_code == 200, res.text
    shortlisted = res.json()
    assert shortlisted["stage"] == "Shortlisted" and shortlisted["match_score"] is not None
    assert [h["stage"] for h in shortlisted["history"]] == ["Applied", "Screening", "Shortlisted"]
    assert client.post(f"{R}/candidates/{cid}/screen", headers=sophie, json={"decision": "shortlist"}).status_code == 409
    assert any(n["title"] == "Lena Fischer shortlisted for Senior Frontend Engineer" for n in _notes(client, ram))
    assert move(client, sophie, cid, "Rejected").status_code == 422  # a reason to reject

    # ---- interview with Ram, scorecard ----
    assert move(client, sophie, cid, "Interview").status_code == 200
    when = (datetime.now(UTC) + timedelta(hours=2)).isoformat()
    res = client.post(f"{R}/candidates/{cid}/interviews", headers=sophie,
                      json={"scheduled_at": when, "panel_ids": ["emp-ram"], "kind": "Technical"})
    assert res.status_code == 201, res.text
    iid = res.json()["id"]
    assert any(n["title"] == "Interview: Lena Fischer" and n["href"] == f"/recruiting/interviews/{iid}" for n in _notes(client, ram))
    card = {"ratings": {"Skills": 5, "Experience": 4, "Problem solving": 4, "Communication": 3, "Team fit": 4},
            "recommendation": "yes", "notes": "Strong React and design system depth."}
    assert client.post(f"{R}/interviews/{iid}/feedback", headers=ram, json=card).status_code == 409  # not held yet
    with SessionLocal() as db:
        db.get(Interview, iid).scheduled_at = datetime.now(UTC) - timedelta(minutes=5)
        db.commit()
    bad = card | {"ratings": {"Skills": 9}}
    assert client.post(f"{R}/interviews/{iid}/feedback", headers=ram, json=bad).status_code == 422
    res = client.post(f"{R}/interviews/{iid}/feedback", headers=ram, json=card)
    assert res.status_code == 200, res.text
    assert res.json()["score"] == 4 and res.json()["recommendation"] == "yes" and res.json()["ratings"]["Skills"] == 5
    assert any(n["title"] == "Scorecard for Lena Fischer" for n in _notes(client, sophie))

    # ---- decision and offer (assessment skipped) ----
    assert move(client, sophie, cid, "Final Review").status_code == 200
    assert move(client, ram, cid, "Offer", "Make the offer").status_code == 200
    start = (date.today() + timedelta(days=21)).isoformat()
    res = client.post(f"{R}/offers", headers=sophie, json={"candidate_id": cid, "grade": "L5", "base_salary": 3000000,
                                                          "start_date": start, "package_note": "Hybrid, Bengaluru office."})
    assert res.status_code == 201, res.text
    offer = res.json()
    letter = offer["letter"]
    assert letter["title"] == "Offer of Employment" and any("Senior Frontend Engineer" in p for p in letter["paragraphs"])
    assert any("30,00,000" in p or "3,000,000" in p for p in letter["paragraphs"])  # the salary from the offer
    oid = offer["id"]
    assert client.post(f"{R}/offers/{oid}/submit", headers=sophie).status_code == 200
    assert client.post(f"{R}/offers/{oid}/approve", headers=ram).status_code == 200
    assert client.post(f"{R}/offers/{oid}/approve", headers=farhan).json()["status"] == "approved"
    res = client.post(f"{R}/offers/{oid}/status", headers=sophie, json={"status": "sent"})
    token = res.json()["response_token"]
    assert res.json()["status"] == "sent" and token and len(token) >= 20
    ram_view = next(o for o in client.get(f"{R}/offers", headers=ram).json() if o["id"] == oid)
    assert ram_view["response_token"] is None  # the link is for the recruiter / HR to pass on

    # ---- the candidate answers through the link (no sign-in) ----
    assert client.get(f"{P}/offers/not-a-real-token-at-all-123").status_code == 404
    page = client.get(f"{P}/offers/{token}").json()
    assert page["status"] == "sent" and page["candidate_name"] == "Lena Fischer" and page["letter"]["title"] == "Offer of Employment"
    res = client.post(f"{P}/offers/{token}/respond", json={"decision": "accept", "note": "Happy to join!"})
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "accepted"
    assert client.post(f"{P}/offers/{token}/respond", json={"decision": "decline"}).status_code == 409  # answered once
    assert client.get(f"{P}/offers/{token}").json()["status"] == "accepted"  # the link still shows the answer
    hired = client.get(f"{R}/candidates/{cid}", headers=sophie).json()
    assert hired["stage"] == "Hired" and hired["history"][-1]["note"] == "Accepted the offer (answer link)"

    # ---- onboarding: the joiner, for HR and the hiring manager ----
    for who in (farhan, ram):
        joiner = next(j for j in client.get("/api/v1/onboarding/joiners", headers=who).json() if j["candidate_id"] == cid)
        assert joiner["start_date"] == start and joiner["requisition_id"] == rid and joiner["tasks"]
    assert any(n["title"] == "New joiner: Lena Fischer" for n in _notes(client, farhan))
    assert any(n["title"] == "Lena Fischer accepted the offer" for n in _notes(client, sophie))
    final = client.get(f"{R}/requisitions/{rid}", headers=sophie).json()
    assert final["stage_counts"] == {"Hired": 1, "Rejected": 1}

    # ---- closing the post takes it off the board and the careers page ----
    assert client.post(f"{R}/requisitions/{rid}/posting/close", headers=sophie).json()["posting"]["status"] == "closed"
    assert pid not in {p["id"] for p in client.get(f"{P}/careers").json()}
    assert client.post(f"{P}/careers/{pid}/apply", json=apply | {"email": "late@example.com"}).status_code == 404


def test_decline_through_the_link_and_recorded_answers(client, ram, farhan, sophie, jordan, admin):
    req = _approved_requisition(client, ram, jordan, farhan, admin, "Frontend Engineer II")
    rid = req["id"]
    pid = client.post(f"{R}/requisitions/{rid}/posting", headers=sophie, json={
        "title": "Frontend Engineer II", "description": "Work on the employee portal front end in React.",
        "location": "Bengaluru", "closing_date": (date.today() + timedelta(days=10)).isoformat(), "on_careers_site": False,
    }).json()["posting"]["id"]
    assert pid not in {p["id"] for p in client.get(f"{P}/careers").json()}  # internal board only
    assert client.get(f"{P}/careers/{pid}").status_code == 404
    cid = client.post(f"{R}/candidates", headers=sophie, json={
        "requisition_id": rid, "name": "Omar Haddad", "email": "omar.haddad@example.com", "source": "LinkedIn",
        "applied_on": date.today().isoformat(), "skills": ["React"]}).json()["id"]
    client.post(f"{R}/candidates/{cid}/screen", headers=sophie, json={"decision": "shortlist"})
    for stage in ("Interview", "Final Review"):
        assert move(client, sophie, cid, stage).status_code == 200
    assert move(client, ram, cid, "Offer", "Go").status_code == 200
    oid = client.post(f"{R}/offers", headers=sophie, json={"candidate_id": cid, "grade": "L4", "base_salary": 2000000,
                                                          "start_date": (date.today() + timedelta(days=30)).isoformat()}).json()["id"]
    client.post(f"{R}/offers/{oid}/submit", headers=sophie)
    client.post(f"{R}/offers/{oid}/approve", headers=ram)
    client.post(f"{R}/offers/{oid}/approve", headers=farhan)
    token = client.post(f"{R}/offers/{oid}/status", headers=sophie, json={"status": "sent"}).json()["response_token"]
    res = client.post(f"{P}/offers/{token}/respond", json={"decision": "decline", "note": "Took another offer"})
    assert res.json()["status"] == "declined"
    assert client.get(f"{R}/candidates/{cid}", headers=sophie).json()["stage"] == "Offer"  # no hire
    with SessionLocal() as db:
        assert db.scalar(select(Joiner.id).where(Joiner.candidate_id == cid)) is None
    assert any(n["title"] == "Omar Haddad declined the offer" for n in client.get("/api/v1/notifications", headers=ram).json())


def test_recruiter_raises_for_a_manager(client, babu, ram, sophie):
    body = {"title": "QA Engineer", "department": "Engineering", "country_code": "IN", "location": "Bengaluru", "openings": 2,
            "budget": 1500000, "reason": "replacement", "justification": "Backfill after a resignation."}
    assert client.post(f"{R}/requisitions", headers=babu, json=body | {"hiring_manager_id": "emp-ram"}).status_code == 403
    assert client.post(f"{R}/requisitions", headers=sophie, json=body | {"hiring_manager_id": "nobody"}).status_code == 422
    res = client.post(f"{R}/requisitions", headers=sophie, json=body | {"hiring_manager_id": "emp-ram"})
    assert res.status_code == 201, res.text
    req = res.json()
    assert req["hiring_manager_id"] == "emp-ram" and req["recruiter_id"] == "demo-recruiter" and req["status"] == "pending_approval"
    assert req["raised_by"] == "demo-recruiter" and req["reason"] == "replacement"
    assert any(n["title"] == f"Requisition {req['id']} raised for you" for n in client.get("/api/v1/notifications", headers=ram).json())
    # not open until approved: no posting yet
    assert client.post(f"{R}/requisitions/{req['id']}/posting", headers=sophie, json={
        "title": "QA Engineer", "description": "Test the platform end to end with the squad.", "location": "Bengaluru",
        "closing_date": (date.today() + timedelta(days=5)).isoformat()}).status_code == 409
    with SessionLocal() as db:
        assert db.scalar(select(Candidate.id).where(Candidate.requisition_id == req["id"])) is None
