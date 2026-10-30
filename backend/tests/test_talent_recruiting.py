from datetime import UTC, date, datetime, timedelta

import pytest
from sqlalchemy import select

from app.db import SessionLocal
from app.models import ApprovalInstance, AuditLog, Employee, Joiner, OnboardingTask
from tests.conftest import login
from tests.talent_helpers import R, accepted_offer, add_candidate, move, to_offer_stage, token_for


@pytest.fixture(scope="module")
def sophie(client):
    return login(client, "sophie.clark@timez.com")


@pytest.fixture(scope="module")
def jordan(client):
    return login(client, "jordan.blake@timez.com")


@pytest.fixture(scope="module")
def admin():
    return token_for("demo-admin", "admin")


def _req_ids(client, headers) -> set[str]:
    return {r["id"] for r in client.get(f"{R}/requisitions", headers=headers).json()}


def test_seeded_requisitions_and_visibility(client, babu, ram, farhan, sophie, admin):
    assert _req_ids(client, farhan) >= {"JOB-221", "JOB-218", "JOB-205", "JOB-230", "JOB-210"}  # HR: all
    assert _req_ids(client, ram) == {"JOB-221", "JOB-230"}  # hiring manager: own
    assert _req_ids(client, sophie) == {"JOB-221", "JOB-218", "JOB-205", "JOB-230"}  # recruiter: assigned
    assert _req_ids(client, babu) == set()
    assert "JOB-210" in _req_ids(client, admin)  # admin approves its finance step (after HR)
    assert client.get(f"{R}/requisitions/JOB-221", headers=babu).status_code == 404
    cands = client.get(f"{R}/candidates", headers=sophie, params={"requisition_id": "JOB-221"}).json()
    assert {c["id"] for c in cands} >= {"cand-1", "cand-6", "cand-12"}
    aisha = next(c for c in cands if c["id"] == "cand-1")
    assert aisha["stage"] == "Interview" and [h["stage"] for h in aisha["history"]] == ["Applied", "Screening", "Shortlisted", "Interview"]
    assert client.get(f"{R}/candidates/cand-1", headers=babu).status_code == 404


def test_requisition_approval_department_head_hr_finance(client, babu, ram, farhan, sophie, jordan, admin):
    body = {"title": "Staff Platform Engineer", "department": "Engineering", "country_code": "IN", "location": "Bengaluru",
            "openings": 1, "requirements": ["Cloud architecture", "7+ years"]}
    assert client.post(f"{R}/requisitions", headers=babu, json=body).status_code == 403
    assert client.post(f"{R}/requisitions", headers=ram, json=body | {"country_code": "ZZ"}).status_code == 422
    res = client.post(f"{R}/requisitions", headers=ram, json=body)
    assert res.status_code == 201, res.text
    req = res.json()
    assert req["status"] == "pending_approval" and req["recruiter_id"] is None and req["hiring_manager_id"] == "emp-ram"
    with SessionLocal() as db:
        inst = db.get(ApprovalInstance, req["approval_id"])
        # department head = the person above the hiring manager; then HR; then finance (falls back to admin)
        assert [s["groups"] for s in inst.steps] == [{"skip_manager": ["demo-ceo"]}, {"hr": ["demo-hr-admin"]},
                                                     {"finance": ["demo-admin"]}]
    dec = f"{R}/requisitions/{req['id']}/decision"
    assert client.post(dec, headers=ram, json={"decision": "approve"}).status_code == 403  # own requisition
    assert client.post(dec, headers=babu, json={"decision": "approve"}).status_code == 404
    assert client.post(dec, headers=farhan, json={"decision": "approve"}).status_code == 403  # not HR's step yet
    assert client.post(dec, headers=jordan, json={"decision": "approve"}).json()["status"] == "pending_approval"
    # HR decides from the generic approvals inbox; finance (admin) completes from there too
    assert client.post(f"/api/v1/approvals/{req['approval_id']}/decision", headers=farhan, json={"decision": "approve"}).status_code == 200
    assert client.get(f"{R}/requisitions/{req['id']}", headers=sophie).status_code == 404  # no recruiter yet
    assert client.post(f"/api/v1/approvals/{req['approval_id']}/decision", headers=admin, json={"decision": "approve"}).status_code == 200
    got = client.get(f"{R}/requisitions/{req['id']}", headers=ram).json()
    assert got["status"] == "approved" and got["recruiter_id"] == "demo-recruiter" and got["recruiter_assigned_on"]
    assert req["id"] in _req_ids(client, sophie)
    assert any(n["title"] == f"Requisition {req['id']} assigned to you" for n in client.get("/api/v1/notifications", headers=sophie).json())
    with SessionLocal() as db:
        actions = set(db.scalars(select(AuditLog.action).where(AuditLog.entity == "requisition", AuditLog.entity_id == req["id"])))
        assert {"requisition_raised", "requisition_approved", "requisition_recruiter_assigned"} <= actions

    # rejection via the recruiting endpoint (note required), and HR hold / resume
    req2 = client.post(f"{R}/requisitions", headers=ram, json=body | {"title": "Junior QA Engineer"}).json()
    dec2 = f"{R}/requisitions/{req2['id']}/decision"
    assert client.post(dec2, headers=jordan, json={"decision": "reject"}).status_code == 422
    assert client.post(dec2, headers=jordan, json={"decision": "reject", "note": "No budget"}).json()["status"] == "rejected"
    assert client.post(dec2, headers=farhan, json={"decision": "approve"}).status_code == 409
    assert client.post(f"{R}/requisitions/{req['id']}/hold", headers=ram, json={"note": "Budget review"}).status_code == 403
    assert client.post(f"{R}/requisitions/{req['id']}/hold", headers=farhan, json={"note": "Budget review"}).json()["status"] == "on_hold"
    assert add_candidate(client, sophie, "Hold Case", "hold.case@example.com", req["id"]).status_code == 409
    assert client.post(f"{R}/requisitions/{req['id']}/resume", headers=farhan).json()["status"] == "approved"


def test_candidate_rules_and_interviews(client, babu, ram, farhan, sophie):
    assert add_candidate(client, ram, "Hm Adds", "hm.adds@example.com").status_code == 403  # hiring manager doesn't add
    assert add_candidate(client, babu, "Nobody", "nobody@example.com").status_code == 422
    future = (date.today() + timedelta(days=2)).isoformat()
    assert add_candidate(client, sophie, "Future Date", "future@example.com", applied_on=future).status_code == 422
    assert add_candidate(client, sophie, "Bad Email", "not-an-email").status_code == 422
    res = add_candidate(client, sophie, "Dev Patel", "dev.patel@example.com")
    assert res.status_code == 201, res.text
    cid = res.json()["id"]
    assert add_candidate(client, sophie, "Dev Patel", "DEV.PATEL@example.com").status_code == 409  # duplicate

    assert move(client, sophie, cid, "Shortlisted").status_code == 409  # one stage at a time
    assert move(client, sophie, cid, "Hired").status_code == 409  # needs an accepted offer
    assert move(client, sophie, cid, "Screening").status_code == 200
    assert move(client, ram, cid, "Shortlisted").status_code == 403  # the recruiter runs the pipeline
    assert move(client, babu, cid, "Shortlisted").status_code == 404
    assert move(client, sophie, cid, "Shortlisted").status_code == 200

    when = (datetime.now(UTC) + timedelta(days=3)).isoformat()
    sched = f"{R}/candidates/{cid}/interviews"
    assert client.post(sched, headers=sophie, json={"scheduled_at": when, "panel_ids": ["emp-mahesh"]}).status_code == 409  # not at Interview
    assert move(client, sophie, cid, "Interview").status_code == 200
    past = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
    assert client.post(sched, headers=sophie, json={"scheduled_at": past, "panel_ids": ["emp-mahesh"]}).status_code == 422
    assert client.post(sched, headers=sophie, json={"scheduled_at": when, "panel_ids": ["nobody"]}).status_code == 422
    assert client.post(sched, headers=ram, json={"scheduled_at": when, "panel_ids": ["emp-mahesh"]}).status_code == 403
    res = client.post(sched, headers=sophie, json={"scheduled_at": when, "panel_ids": ["emp-mahesh"], "kind": "Technical"})
    assert res.status_code == 201, res.text
    iid = res.json()["id"]
    assert any(n["title"] == "Interview: Dev Patel" for n in client.get("/api/v1/notifications", headers=babu).json())
    assert iid in {i["id"] for i in client.get(f"{R}/interviews", headers=babu).json()}  # panel sees their interviews
    fb = f"{R}/interviews/{iid}/feedback"
    assert client.post(fb, headers=sophie, json={"score": 4, "notes": "Good"}).status_code == 403  # not on the panel
    assert client.post(fb, headers=babu, json={"score": 6, "notes": "Great"}).status_code == 422
    assert client.post(fb, headers=babu, json={"score": 4, "notes": ""}).status_code == 422
    assert client.post(fb, headers=babu, json={"score": 4, "notes": "Too early"}).status_code == 409  # not held yet
    with SessionLocal() as db:  # the interview took place
        from app.models import Interview
        db.get(Interview, iid).scheduled_at = datetime.now(UTC) - timedelta(hours=1)
        db.commit()
    res = client.post(fb, headers=babu, json={"score": 4, "notes": "Solid React depth"})
    assert res.status_code == 200 and res.json()["score"] == 4 and res.json()["feedback_status"] == "submitted"
    assert client.post(fb, headers=babu, json={"score": 5, "notes": "Again"}).status_code == 409

    assert move(client, sophie, cid, "Assessment").status_code == 200
    assert move(client, sophie, cid, "Final Review").status_code == 200
    assert move(client, sophie, cid, "Offer").status_code == 403  # the hiring manager decides at Final Review
    assert move(client, farhan, cid, "Offer").status_code == 403
    assert move(client, ram, cid, "Offer").status_code == 200
    assert move(client, sophie, cid, "Hired").status_code == 409  # no accepted offer yet
    # exits: from any open stage, never out of a closed one
    other = add_candidate(client, sophie, "Exit Case", "exit.case@example.com").json()["id"]
    assert move(client, sophie, other, "Rejected", "Not a fit").json()["stage"] == "Rejected"
    assert move(client, sophie, other, "Screening").status_code == 409
    # on-hold requisition: nothing moves
    assert move(client, farhan, "cand-4", "Shortlisted").status_code == 409


def test_offer_approvals_and_hired_needs_accepted_offer(client, babu, ram, farhan, sophie):
    cid = add_candidate(client, sophie, "Nisha Rao", "nisha.rao@example.com").json()["id"]
    offer_body = {"candidate_id": cid, "grade": "L5", "base_salary": 2400000, "start_date": (date.today() + timedelta(days=20)).isoformat()}
    assert client.post(f"{R}/offers", headers=sophie, json=offer_body).status_code == 409  # not at Offer yet
    to_offer_stage(client, sophie, ram, cid)
    assert client.post(f"{R}/offers", headers=ram, json=offer_body).status_code == 403
    assert client.post(f"{R}/offers", headers=sophie, json=offer_body | {"start_date": date.today().isoformat()}).status_code == 422
    assert client.post(f"{R}/offers", headers=sophie, json=offer_body | {"base_salary": 0}).status_code == 422
    offer = client.post(f"{R}/offers", headers=sophie, json=offer_body).json()
    assert offer["status"] == "preparing" and offer["currency"] == "INR"
    assert client.post(f"{R}/offers", headers=sophie, json=offer_body).status_code == 409  # one open offer
    oid = offer["id"]
    assert client.post(f"{R}/offers/{oid}/approve", headers=ram).status_code == 409  # not submitted
    assert client.post(f"{R}/offers/{oid}/submit", headers=sophie).json()["status"] == "pending_approval"
    assert client.post(f"{R}/offers/{oid}/approve", headers=sophie).status_code == 403  # own offer
    assert client.post(f"{R}/offers/{oid}/approve", headers=farhan).status_code == 403  # hiring manager first
    assert client.post(f"{R}/offers/{oid}/status", headers=sophie, json={"status": "sent"}).status_code == 409
    res = client.post(f"{R}/offers/{oid}/approve", headers=ram).json()
    assert res["status"] == "pending_approval" and [a["role"] for a in res["approvals"]] == ["hiring_manager"]
    assert client.post(f"{R}/offers/{oid}/approve", headers=ram).status_code == 403  # already approved a step
    assert client.get(f"{R}/offers", headers=babu).json() == []
    res = client.post(f"{R}/offers/{oid}/approve", headers=farhan).json()
    assert res["status"] == "approved"
    assert client.post(f"{R}/offers/{oid}/status", headers=sophie, json={"status": "accepted", "note": "Yes!!"}).status_code == 409
    assert client.post(f"{R}/offers/{oid}/status", headers=sophie, json={"status": "sent"}).json()["sent_on"] == date.today().isoformat()
    assert client.post(f"{R}/offers/{oid}/status", headers=sophie, json={"status": "accepted", "note": "ok"}).status_code == 422
    assert move(client, sophie, cid, "Hired").status_code == 409
    assert client.post(f"{R}/offers/{oid}/status", headers=sophie, json={"status": "accepted", "note": "Accepted by email"}).json()["status"] == "accepted"
    res = move(client, sophie, cid, "Hired")
    assert res.status_code == 200, res.text
    with SessionLocal() as db:
        emp = db.scalar(select(Employee).where(Employee.email == "nisha.rao@example.com"))
        assert emp.employment_status == "Onboarding" and emp.manager_id == "emp-ram" and emp.id.startswith("TZ0")
        assert int(emp.id[2:]) > 500 and emp.grade == "L5" and emp.country_code == "IN" and emp.source == "recruiting"
        joiner = db.scalar(select(Joiner).where(Joiner.candidate_id == cid))
        tasks = list(db.scalars(select(OnboardingTask).where(OnboardingTask.joiner_id == joiner.id)))
        assert {t.title for t in tasks} >= {"HR documentation: PAN, Aadhaar & tax", "Laptop assignment"}  # India template
        assert joiner.status == "pre_boarding" and joiner.employee_id == emp.id
    assert move(client, sophie, cid, "Withdrawn").status_code == 409  # closed

    activity = client.get(f"{R}/my-activity", headers=sophie).json()
    actions = {a["action"] for a in activity}
    assert {"candidate_added", "candidate_stage_moved", "offer_created", "offer_accepted"} <= actions
    assert all(datetime.fromisoformat(a["at"]) for a in activity)
    assert "employee_created" in actions
    ram_actions = {a["action"] for a in client.get(f"{R}/my-activity", headers=ram).json()}
    assert "offer_step_approved" in ram_actions and "offer_created" not in ram_actions


def test_offer_send_back(client, ram, farhan, sophie):
    cid = add_candidate(client, sophie, "Back Case", "back.case@example.com").json()["id"]
    to_offer_stage(client, sophie, ram, cid)
    oid = client.post(f"{R}/offers", headers=sophie, json={"candidate_id": cid, "grade": "L4", "base_salary": 1800000,
                                                           "start_date": (date.today() + timedelta(days=30)).isoformat()}).json()["id"]
    client.post(f"{R}/offers/{oid}/submit", headers=sophie)
    assert client.post(f"{R}/offers/{oid}/send-back", headers=farhan, json={"note": "Band check"}).status_code == 403
    res = client.post(f"{R}/offers/{oid}/send-back", headers=ram, json={"note": "Lower the grade"})
    assert res.status_code == 200 and res.json()["status"] == "preparing" and res.json()["approvals"] == []
    assert client.post(f"{R}/offers/{oid}/status", headers=sophie, json={"status": "withdrawn"}).json()["status"] == "withdrawn"
    assert accepted_offer(client, sophie, ram, farhan, cid)["status"] == "accepted"  # a new offer after the withdrawn one


def test_cv_upload_download(client, babu, sophie, tmp_path, monkeypatch):
    monkeypatch.setenv("STORAGE_DIR", str(tmp_path))
    url = f"{R}/candidates/cand-1/cv"
    text = b"Aisha Khan\naisha.khan@example.com\n7 years of experience with React and TypeScript"
    res = client.put(url, headers=sophie | {"Content-Type": "text/plain"}, params={"filename": "aisha.txt"}, content=text)
    assert res.status_code == 200, res.text
    assert res.json()["has_cv"] is True and res.json()["cv_filename"] == "aisha.txt"
    assert (tmp_path / "cvs" / "cand-1.txt").read_bytes() == text
    got = client.get(url, headers=sophie)
    assert got.status_code == 200 and got.content == text
    assert client.get(url, headers=babu).status_code == 404
    assert client.put(url, headers=babu, params={"filename": "x.txt"}, content=b"hello").status_code == 404
    assert client.put(url, headers=sophie, params={"filename": "cv.exe"}, content=b"MZ....").status_code == 415
    assert client.put(url, headers=sophie, params={"filename": "cv.pdf"}, content=b"not a pdf").status_code == 415
    assert client.put(url, headers=sophie, params={"filename": "cv.pdf"}, content=b"%PDF-" + b"0" * (5 * 1024 * 1024)).status_code == 413
    res = client.put(url, headers=sophie, params={"filename": "aisha.pdf"}, content=b"%PDF-1.7 small")
    assert res.status_code == 200 and not (tmp_path / "cvs" / "cand-1.txt").exists()  # the old file is replaced


def test_cv_parse_and_match(client, babu, sophie):
    cv = """Rahul Verma
rahul.verma@mail.example | +91 98450 33221
Senior Frontend Engineer at Acme Corp, Jan 2020 - Present
Software Engineer, Globex, 2016 - 2019
B.Tech Computer Science, IIT Madras, 2012 - 2016
Skills: React, TypeScript, Jest, AWS, stakeholder management
"""
    assert client.post(f"{R}/cv/parse", headers=babu, json={"text": cv}).status_code == 403
    res = client.post(f"{R}/cv/parse", headers=sophie, json={"text": cv})
    assert res.status_code == 200, res.text
    got = res.json()
    assert got["name"] == "Rahul Verma" and got["email"] == "rahul.verma@mail.example" and got["phone"] == "+91 98450 33221"
    assert got["experience_years"] == date.today().year - 2016
    assert got["current_title"] == "Senior Frontend Engineer" and got["current_company"] == "Acme Corp"
    assert got["education"] == ["B.Tech Computer Science, IIT Madras, 2012 - 2016"]
    assert got["library_skills"] == ["React", "TypeScript", "Cloud architecture"]
    assert set(got["other_skills"]) == {"Testing", "Stakeholder management"}

    m = client.get(f"{R}/candidates/cand-1/match", headers=sophie).json()
    # JOB-221 needs React, TypeScript, System design (5+ years); Aisha: React, TypeScript, Design systems, 7 years
    assert m["required"] == ["React", "TypeScript", "System design"] and m["preferred"] == ["Design systems", "Testing", "CI/CD"]
    assert m["matched"] == ["React", "TypeScript"] and m["missing"] == ["System design"] and m["preferred_matched"] == ["Design systems"]
    assert m["score"] == 70 and m["band"] == "Partial" and m["years_needed"] == 5 and len(m["questions"]) == 5
    assert m["summary"].startswith("Aisha shows 2 of 3 core skills (React, TypeScript).")
    other = client.get(f"{R}/candidates/cand-1/match", headers=sophie, params={"requisition_id": "JOB-218"}).json()
    assert other["requisition_id"] == "JOB-218" and other["band"] == "Weak"
    assert client.get(f"{R}/candidates/cand-1/match", headers=babu).status_code == 404


def test_ceo_requisition_skips_skip_level_step_instead_of_admin(client, farhan, admin):
    """The CEO has no one above them: the "Skip-level manager approval" step is skipped, never sent to admin."""
    with SessionLocal() as db:
        inst = db.scalar(select(ApprovalInstance).where(ApprovalInstance.type == "requisition",
                                                        ApprovalInstance.entity_id == "JOB-210"))
        assert inst is not None and inst.status == "pending"
        assert inst.steps[0]["groups"].get("skip_manager") == [] and inst.steps[0]["skipped"] is True
        assert inst.current_step >= 1 and not inst.steps[inst.current_step]["skipped"]
        waiting = {i for ids in inst.steps[inst.current_step]["groups"].values() for i in ids}
        assert "demo-admin" not in waiting and "demo-hr-admin" in waiting
    pending = client.get("/api/v1/approvals/pending", headers=admin).json()
    assert not any(p.get("id") == inst.id for p in pending)
