"""Confidential HR cases: privacy (reporter, HR, committee, the person named), confidential notes, retention, audit."""

from __future__ import annotations

from datetime import date

from sqlalchemy import select

from app.db import SessionLocal
from app.models import AuditLog, HrCase, HrCaseNote
from app.services.jobs import archive_expired_cases
from tests.conftest import login
from tests.talent_helpers import token_for

C = "/api/v1/cases"
STORY = "My manager keeps shouting at me in team meetings in front of everyone."


def _raise(client, headers, **extra):
    body = {"category": "Grievance", "description": STORY, "anonymous": False} | extra
    res = client.post(C, headers=headers, json=body)
    assert res.status_code == 201, res.text
    return res.json()


def test_named_person_never_sees_the_case(client, babu, ram, farhan):
    created = _raise(client, babu, against_id="emp-ram", anonymous=True)
    cid, code = created["id"], created["code"]
    assert code.startswith("CASE-")
    # the person named: 404 by id, by code, and nothing in any list
    assert client.get(f"{C}/{cid}", headers=ram).status_code == 404
    assert client.get(f"{C}/by-code/{code}", headers=ram).status_code == 404
    assert all(c["id"] != cid for c in client.get(C, headers=ram, params={"view": "manage"}).json())
    # another employee (recruiter) can't see it either
    sophie = login(client, "sophie.clark@timez.com")
    assert client.get(f"{C}/{cid}", headers=sophie).status_code == 404
    # HR sees it, but an anonymous reporter stays hidden
    hr_view = client.get(f"{C}/{cid}", headers=farhan).json()
    assert hr_view["view"] == "manager" and hr_view["reporter_id"] is None and hr_view["against_id"] == "emp-ram"
    # reporter sees their own case by code
    mine = client.get(f"{C}/by-code/{code.lower()}", headers=babu).json()
    assert mine["view"] == "reporter" and mine["against_id"] is None


def test_named_hr_person_is_excluded_even_as_hr(client, babu, farhan):
    cid = _raise(client, babu, against_id="demo-hr-admin")["id"]
    assert client.get(f"{C}/{cid}", headers=farhan).status_code == 404
    res = client.post(f"{C}/{cid}/notes", headers=farhan, json={"text": "Looking into it", "confidential": False})
    assert res.status_code == 404


def test_confidential_notes_hidden_from_reporter(client, babu, farhan):
    cid = _raise(client, babu)["id"]
    assert client.post(f"{C}/{cid}/notes", headers=farhan, json={"text": "Witness says it happened twice.", "confidential": True}).status_code == 201
    assert client.post(f"{C}/{cid}/notes", headers=farhan, json={"text": "We have started an inquiry.", "confidential": False}).status_code == 201
    # the reporter can't add HR notes
    assert client.post(f"{C}/{cid}/notes", headers=babu, json={"text": "x", "confidential": False}).status_code == 403
    reporter = client.get(f"{C}/{cid}", headers=babu).json()
    texts = [e["text"] for e in reporter["timeline"]]
    assert "We have started an inquiry." in texts and "Witness says it happened twice." not in texts
    assert all(e["author"] in ("Reporter", "HR", "System") for e in reporter["timeline"])
    hr = client.get(f"{C}/{cid}", headers=farhan).json()
    assert "Witness says it happened twice." in [e["text"] for e in hr["timeline"]]
    # status flow and the closing-note rule
    assert client.post(f"{C}/{cid}/status", headers=farhan, json={"status": "Resolved", "note": ""}).status_code == 409
    assert client.post(f"{C}/{cid}/status", headers=farhan, json={"status": "Investigating"}).status_code == 200
    assert client.post(f"{C}/{cid}/status", headers=farhan, json={"status": "Resolved", "note": "short"}).status_code == 422
    res = client.post(f"{C}/{cid}/status", headers=farhan, json={"status": "Resolved", "note": "Manager coached, apology given."})
    assert res.status_code == 200 and res.json()["closed_on"]
    # audit rows never carry the description or note text
    with SessionLocal() as db:
        rows = db.scalars(select(AuditLog).where(AuditLog.entity == "hr_case", AuditLog.entity_id == cid)).all()
        assert rows
        dump = repr([r.changes for r in rows])
        assert STORY not in dump and "Witness" not in dump and "apology" not in dump


def test_posh_committee_and_deadline(client, babu, farhan):
    jordan = login(client, "jordan.blake@timez.com")
    posh = _raise(client, babu, category="Harassment/POSH")["id"]
    other = _raise(client, babu)["id"]
    assert client.get(f"{C}/{posh}", headers=jordan).status_code == 404
    admin = token_for("demo-admin", "admin")
    res = client.put("/api/v1/admin/settings", headers=admin, json={"posh_committee": ["demo-hr-admin", "demo-ceo"]})
    assert res.status_code == 200, res.text
    try:
        case = client.get(f"{C}/{posh}", headers=jordan).json()
        assert case["view"] == "manager" and case["posh_due_on"] and case["posh_overdue"] is False
        assert client.get(f"{C}/{other}", headers=jordan).status_code == 404  # committee: POSH only
        assert posh in {c["id"] for c in client.get(C, headers=jordan, params={"view": "manage"}).json()}
    finally:
        client.put("/api/v1/admin/settings", headers=admin, json={"posh_committee": ["demo-hr-admin"]})
    assert client.get(f"{C}/{posh}", headers=jordan).status_code == 404


def test_retention_archives_closed_cases_to_a_stub(client, babu, farhan):
    cid = _raise(client, babu, against_id="emp-ram")["id"]
    client.post(f"{C}/{cid}/notes", headers=farhan, json={"text": "Sensitive detail", "confidential": True})
    res = client.post(f"{C}/{cid}/status", headers=farhan, json={"status": "Closed", "note": "Withdrawn by the reporter."})
    assert res.status_code == 200
    with SessionLocal() as db:
        db.get(HrCase, cid).closed_on = date(2019, 1, 10)
        db.commit()
        assert archive_expired_cases(db) >= 1
        db.commit()
        case = db.get(HrCase, cid)
        notes = db.scalars(select(HrCaseNote).where(HrCaseNote.case_id == cid)).all()
        assert case.status == "Archived" and case.against_id is None and STORY not in case.description
        assert [n.kind for n in notes] == ["archived"]
    stub = client.get(f"{C}/{cid}", headers=farhan).json()
    assert stub["status"] == "Archived" and stub["archived_on"]
    assert client.post(f"{C}/{cid}/notes", headers=farhan, json={"text": "late", "confidential": False}).status_code == 409


def test_reporter_comment_escalation_and_files(client, babu, farhan):
    cid = _raise(client, babu)["id"]
    assert client.post(f"{C}/{cid}/comments", headers=babu, json={"text": "It happened again today."}).status_code == 201
    assert client.post(f"{C}/{cid}/comments", headers=farhan, json={"text": "x"}).status_code == 403
    res = client.post(f"{C}/{cid}/escalate", headers=babu, json={"reason": "No response for a week"})
    assert res.status_code == 200 and res.json()["priority"] == "Urgent"
    pdf = b"%PDF-1.4 evidence"
    res = client.post(f"{C}/{cid}/files", headers={**farhan, "Content-Type": "application/pdf"}, params={"confidential": True}, content=pdf)
    assert res.status_code == 201, res.text
    fid = res.json()["id"]
    assert client.get(f"{C}/{cid}", headers=babu).json()["files"] == []
    assert client.get(f"{C}/{cid}/files/{fid}", headers=babu).status_code == 404
    assert client.get(f"{C}/{cid}/files/{fid}", headers=farhan).content == pdf
