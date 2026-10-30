import io
import os
import tempfile
import zipfile
from datetime import date, timedelta

import pytest
from sqlalchemy import select

from app.db import SessionLocal
from app.models import AuditLog, LetterIssue
from app.security import create_access_token
from app.services.letters import format_money

DOCS = "/api/v1/documents"
LETTERS = "/api/v1/letters"
PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def token_for(account_id: str, role: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(account_id, role)[0]}"}


@pytest.fixture(scope="module")
def admin():
    return token_for("demo-admin", "admin")


@pytest.fixture(scope="module", autouse=True)
def storage_dir(client, admin):
    old = os.environ.get("STORAGE_DIR")
    tmp = tempfile.mkdtemp(prefix="timez-docs-")
    os.environ["STORAGE_DIR"] = tmp
    assert client.put("/api/v1/workflows/letter", headers=admin,
                      json={"steps": [{"roles": ["hr"], "mode": "any"}]}).status_code == 200
    yield tmp
    if old is None:
        os.environ.pop("STORAGE_DIR", None)
    else:
        os.environ["STORAGE_DIR"] = old


def upload(client, headers, data=PDF, content_type="application/pdf", **params):
    params = {"category": "Identity", "title": "Passport", "filename": "passport.pdf"} | params
    return client.post(DOCS, headers={**headers, "Content-Type": content_type}, params=params, content=data)


def docx_bytes() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("[Content_Types].xml", "<Types/>")
        zf.writestr("word/document.xml", "<w:document/>")
    return buf.getvalue()


# ---------- documents ----------
def test_upload_versions_and_download(client, babu, ram, farhan):
    expiry = (date.today() + timedelta(days=10)).isoformat()
    res = upload(client, babu, expiry_date=expiry)
    assert res.status_code == 201, res.text
    doc = res.json()
    assert doc["current_version"] == 1 and doc["days_to_expiry"] == 10
    v2 = client.post(f"{DOCS}/{doc['id']}/versions", headers={**babu, "Content-Type": "image/png"},
                     params={"filename": "passport.png"}, content=PNG)
    assert v2.status_code == 201 and v2.json()["current_version"] == 2 and len(v2.json()["versions"]) == 2
    first = client.get(f"{DOCS}/{doc['id']}/download", headers=babu, params={"version": 1})
    assert first.status_code == 200 and first.content == PDF
    assert client.get(f"{DOCS}/{doc['id']}/download", headers=babu).content == PNG
    # the manager can't see identity documents; HR in scope can
    assert client.get(f"{DOCS}/{doc['id']}", headers=ram).status_code == 404
    assert client.get(f"{DOCS}/{doc['id']}/download", headers=farhan).status_code == 200
    with SessionLocal() as db:
        assert db.scalar(select(AuditLog).where(AuditLog.action == "document_downloaded", AuditLog.actor_id == "demo-hr-admin",
                                                AuditLog.entity_id == doc["id"]))


def test_manager_sees_selected_categories(client, babu, ram):
    edu = upload(client, babu, category="Education", title="Degree certificate", filename="degree.docx",
                 content_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document", data=docx_bytes())
    assert edu.status_code == 201, edu.text
    assert client.get(f"{DOCS}/{edu.json()['id']}", headers=ram).status_code == 200
    listed = {d["category"] for d in client.get(DOCS, headers=ram, params={"employee_id": "emp-mahesh"}).json()}
    assert "Education" in listed and "Identity" not in listed
    # the manager can't upload for their report
    assert upload(client, ram, employee_id="emp-mahesh").status_code == 403


def test_upload_validation(client, babu):
    assert upload(client, babu, data=b"just text", content_type="text/plain").status_code == 415
    assert upload(client, babu, data=PNG, content_type="application/pdf").status_code == 415
    assert upload(client, babu, data=PDF + b"0" * (10 * 1024 * 1024)).status_code == 413
    assert upload(client, babu, category="Letters").status_code == 422
    assert upload(client, babu, category="Secret").status_code == 422


def test_expiring(client, babu, farhan):
    mine = client.get(f"{DOCS}/expiring", headers=babu, params={"days": 30}).json()
    assert any(d["title"] == "Passport" and d["days_to_expiry"] == 10 for d in mine)
    assert not client.get(f"{DOCS}/expiring", headers=babu, params={"days": 5}).json()
    hr = client.get(f"{DOCS}/expiring", headers=farhan, params={"days": 30}).json()
    assert any(d["employee_id"] == "emp-mahesh" for d in hr)


def test_policy_acknowledgment(client, babu, farhan):
    # Unknown policies or versions are refused (built-in library ids at their current version, or published HR policies).
    for bad in ({"policy_id": "made-up-policy", "policy_version": "1.0"},
                {"policy_id": "code-of-conduct", "policy_version": "9.9"},
                {"policy_id": "leave-US", "policy_version": "2026.1"}):  # another country's policy (Babu is in India)
        res = client.post(f"{DOCS}/policy-acks", headers=babu, json=bad)
        assert res.status_code == 422 and res.json()["detail"] == "Unknown policy or version.", bad
    assert client.post(f"{DOCS}/policy-acks", headers=babu,
                       json={"policy_id": "leave-IN", "policy_version": "2026.1"}).status_code == 201
    res = client.post(f"{DOCS}/policy-acks", headers=babu, json={"policy_id": "code-of-conduct", "policy_version": "2.0"})
    assert res.status_code == 201 and res.json()["acknowledged_at"]
    assert client.post(f"{DOCS}/policy-acks", headers=babu,
                       json={"policy_id": "code-of-conduct", "policy_version": "2.0"}).status_code == 409
    rows = client.get(f"{DOCS}/policy-acks", headers=farhan, params={"policy_id": "code-of-conduct"}).json()
    assert [r["employee_id"] for r in rows] == ["emp-mahesh"]


# ---------- letters ----------
def test_types_and_templates(client, babu):
    types = {t["type"]: t for t in client.get(f"{LETTERS}/types", headers=babu).json()}
    assert len(types) == 17 and types["Warning"]["second_approval"] and types["Salary revision"]["sensitive"]
    us = {t["letter_type"]: t for t in client.get(f"{LETTERS}/templates", headers=babu, params={"country": "US"}).json()}
    assert us["Employment"]["title"] == "Employment Verification"
    india = {t["letter_type"]: t for t in client.get(f"{LETTERS}/templates", headers=babu, params={"country": "IN"}).json()}
    assert india["Employment"]["title"] == "Employment Certificate"


def test_employee_request_rules(client, babu):
    res = client.post(f"{LETTERS}/requests", headers=babu, json={"letter_type": "Address proof"})
    assert res.status_code == 422 and "missing: Address" in res.json()["detail"]
    assert client.post(f"{LETTERS}/requests", headers=babu, json={"letter_type": "Warning", "details": "x"}).status_code == 403
    assert client.post(f"{LETTERS}/requests", headers=babu, json={"letter_type": "Offer"}).status_code == 403
    assert client.post(f"{LETTERS}/requests", headers=babu, json={"letter_type": "NOC"}).status_code == 422  # purpose
    assert client.post(f"{LETTERS}/requests", headers=babu, json={"letter_type": "Experience"}).status_code == 422
    assert client.post(f"{LETTERS}/requests", headers=babu,
                       json={"letter_type": "Employment", "employee_id": "emp-ram"}).status_code == 404


def test_employment_letter_issued_as_pdf(client, babu, ram, farhan):
    res = client.post(f"{LETTERS}/requests", headers=babu, json={"letter_type": "Employment", "note": "Bank KYC"})
    assert res.status_code == 201, res.text
    lid = res.json()["id"]
    assert res.json()["status"] == "pending"
    assert client.get(f"{LETTERS}/requests/{lid}/download", headers=babu).status_code == 409
    preview = client.get(f"{LETTERS}/requests/{lid}/preview", headers=babu).json()
    assert preview["missing"] == [] and "Babu Menon" in preview["paragraphs"][0]
    assert lid in [r["id"] for r in client.get(f"{LETTERS}/requests", headers=farhan, params={"view": "to_decide"}).json()]
    done = client.post(f"{LETTERS}/requests/{lid}/decision", headers=farhan, json={"decision": "approve"}).json()
    assert done["status"] == "issued" and len(done["issues"]) == 1 and done["document_id"]
    assert done["issues"][0]["reference_no"].startswith("INF-IN/HR/EMP/")
    pdf = client.get(f"{LETTERS}/requests/{lid}/download", headers=babu)
    assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF") and pdf.headers["content-type"] == "application/pdf"
    assert len(pdf.content) > 1000
    # the manager can't open it; it shows in the employee's documents under Letters
    assert client.get(f"{LETTERS}/requests/{lid}/download", headers=ram).status_code == 404
    letters_docs = client.get(DOCS, headers=babu, params={"category": "Letters"}).json()
    assert any(d["id"] == done["document_id"] for d in letters_docs)
    # HR regenerates: a new version
    again = client.post(f"{LETTERS}/requests/{lid}/issue", headers=farhan).json()
    assert [i["version"] for i in again["issues"]] == [1, 2]
    assert client.get(f"{LETTERS}/requests/{lid}/download", headers=babu, params={"version": 1}).status_code == 200
    assert client.post(f"{LETTERS}/requests/{lid}/issue", headers=babu).status_code == 403


def test_warning_needs_second_approver_and_hidden_until_issued(client, babu, farhan, admin):
    assert client.post(f"{LETTERS}/requests", headers=farhan,
                       json={"letter_type": "Warning", "employee_id": "emp-mahesh"}).status_code == 422  # details
    res = client.post(f"{LETTERS}/requests", headers=farhan, json={
        "letter_type": "Warning", "employee_id": "emp-mahesh", "details": "Repeated missed deadlines in Q3"})
    assert res.status_code == 201, res.text
    lid = res.json()["id"]
    # hidden from the employee until issued
    assert lid not in [r["id"] for r in client.get(f"{LETTERS}/requests", headers=babu).json()]
    assert client.get(f"{LETTERS}/requests/{lid}", headers=babu).status_code == 404
    # the HR person who raised it can't approve it
    res = client.post(f"{LETTERS}/requests/{lid}/decision", headers=farhan, json={"decision": "approve"})
    assert res.status_code == 403 and "Someone other than" in res.json()["detail"]
    with SessionLocal() as db:
        from app.models import ApprovalInstance, LetterRequest
        inst = db.get(ApprovalInstance, db.get(LetterRequest, lid).approval_instance_id)
        approvers = {i for s in inst.steps for ids in s["groups"].values() for i in ids}
        assert "demo-hr-admin" not in approvers and "emp-mahesh" not in approvers and approvers
    # the approvals inbox names the letter and the employee, not internal ids
    inbox = [i for i in client.get("/api/v1/approvals/pending", headers=admin).json() if i["type"] == "letter"]
    assert any(i["summary"].startswith("Warning letter for Babu Menon") for i in inbox), inbox
    done = client.post(f"{LETTERS}/requests/{lid}/decision", headers=admin, json={"decision": "approve"}).json()
    assert done["status"] == "issued"
    assert client.get(f"{LETTERS}/requests/{lid}", headers=babu).status_code == 200
    pdf = client.get(f"{LETTERS}/requests/{lid}/download", headers=babu)
    assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF")


def test_salary_revision_uses_pay_history(client, babu, farhan, admin):
    res = client.post(f"{LETTERS}/requests", headers=farhan, json={"letter_type": "Salary revision", "employee_id": "emp-mahesh"})
    assert res.status_code == 201, res.text
    lid = res.json()["id"]
    assert client.get(f"{LETTERS}/requests/{lid}", headers=babu).status_code == 404
    preview = client.get(f"{LETTERS}/requests/{lid}/preview", headers=farhan).json()
    assert preview["fields"]["salary"].startswith("INR ") and preview["fields"]["previous_salary"].startswith("INR ")
    assert format_money(1_740_000, "INR") == "INR 17,40,000" and format_money(185_000, "USD") == "USD 185,000"
    rejected = client.post(f"{LETTERS}/requests/{lid}/decision", headers=admin, json={"decision": "reject", "note": "Not yet"}).json()
    assert rejected["status"] == "rejected"
    # still hidden: rejected sensitive letters never reach the employee
    assert client.get(f"{LETTERS}/requests/{lid}", headers=babu).status_code == 404
    with SessionLocal() as db:
        assert not db.scalars(select(LetterIssue).where(LetterIssue.request_id == lid)).all()
