import hashlib
import os
import tempfile
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import select

from app.db import SessionLocal
from app.models import Account, ApprovalInstance, AuditLog, Employee, ExpenseReceipt
from app.security import create_access_token
from app.services import storage

API = "/api/v1/expenses"
PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
DEFAULT_EXPENSE = [{"roles": ["manager"], "mode": "any"}, {"roles": ["finance"], "mode": "any", "min_amount": 10000}]


def token_for(account_id: str, role: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(account_id, role)[0]}"}


def today_ist():
    return datetime.now(ZoneInfo("Asia/Kolkata")).date()


@pytest.fixture(scope="module")
def admin():
    return token_for("demo-admin", "admin")


@pytest.fixture(scope="module")
def jordan():
    return token_for("demo-ceo", "executive")


@pytest.fixture(scope="module")
def sophie():
    return token_for("demo-recruiter", "recruiter")


@pytest.fixture(scope="module", autouse=True)
def setup(client, admin):
    old = os.environ.get("STORAGE_DIR")
    tmp = tempfile.mkdtemp(prefix="timez-storage-")
    os.environ["STORAGE_DIR"] = tmp
    # Earlier test modules change the expense workflow: put the default chain back.
    assert client.put("/api/v1/workflows/expense", headers=admin, json={"steps": DEFAULT_EXPENSE}).status_code == 200
    yield tmp
    if old is None:
        os.environ.pop("STORAGE_DIR", None)
    else:
        os.environ["STORAGE_DIR"] = old


def upload(client, headers, data=PDF, content_type="application/pdf", filename="taxi.pdf", claim_id=None):
    url = f"{API}/{claim_id}/receipts" if claim_id else f"{API}/receipts"
    return client.post(url, headers={**headers, "Content-Type": content_type}, params={"filename": filename}, content=data)


def claim(client, headers, amount, days_ago=2, category="Travel", **extra):
    body = {"category": category, "amount": amount, "date": (today_ist() - timedelta(days=days_ago)).isoformat(),
            "description": "Client visit cab"} | extra
    return client.post(API, headers=headers, json=body)


def unique_pdf(tag: str) -> bytes:
    return PDF + tag.encode()


def test_rules(client, babu):
    body = client.get(f"{API}/rules", headers=babu).json()
    assert body["country_code"] == "IN" and body["currency"] == "INR"
    assert body["max_claim"] == 200000 and body["receipt_required_over"] == 500 and body["finance_threshold"] == 10000
    assert "Food" in body["categories"] and "application/pdf" in body["receipt_types"]


def test_validation(client, babu):
    assert claim(client, babu, 100, days_ago=-1).status_code == 422  # future
    assert claim(client, babu, 100, days_ago=91).status_code == 422  # outside the 90-day window
    assert claim(client, babu, 200001).status_code == 422  # over the IN max claim
    res = claim(client, babu, 600)  # receipt required above 500
    assert res.status_code == 422 and "receipt" in res.json()["detail"].lower()
    assert claim(client, babu, 100, currency="USD").status_code == 422
    assert claim(client, babu, 100, category="Gifts").status_code == 422
    assert claim(client, babu, 0).status_code == 422
    assert claim(client, babu, 100, receipt_ids=["rcpt-nope"]).status_code == 422
    assert claim(client, babu, 100, trip_id="trv-nope").status_code == 422


def test_receipt_upload_checks(client, babu):
    assert upload(client, babu, b"hello world", "text/plain", "x.txt").status_code == 415
    assert upload(client, babu, PNG, "application/pdf").status_code == 415  # declared type doesn't match the bytes
    assert upload(client, babu, b"", "application/pdf").status_code == 422
    big = b"%PDF-" + b"0" * (storage.MAX_RECEIPT_BYTES + 1)
    assert upload(client, babu, big).status_code == 413
    res = upload(client, babu, PNG, "image/png", "../../evil<>.png")
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["claim_id"] is None and body["content_type"] == "image/png" and body["size_bytes"] == len(PNG)
    assert body["sha256"] == hashlib.sha256(PNG).hexdigest()
    assert "/" not in body["file_name"] and "<" not in body["file_name"]
    with SessionLocal() as db:
        row = db.get(ExpenseReceipt, body["id"])
        assert row.storage_path.startswith("receipts/emp-mahesh/") and storage.resolve(row.storage_path).is_file()
    # octet-stream: the type comes from the bytes
    res = upload(client, babu, unique_pdf("octet"), "application/octet-stream", "scan")
    assert res.status_code == 201 and res.json()["content_type"] == "application/pdf"


def test_small_claim_manager_only_then_paid(client, babu, ram, farhan, admin, sophie):
    res = claim(client, babu, 431.5, category="Food")
    assert res.status_code == 201, res.text
    item = res.json()
    assert item["status"] == "submitted" and item["approval_status"] == "pending" and item["currency"] == "INR"
    cid, iid = item["id"], item["approval_instance_id"]
    assert claim(client, babu, 431.5, category="Food").status_code == 409  # duplicate
    assert cid in {c["id"] for c in client.get(API, headers=babu).json()}
    assert cid in {c["id"] for c in client.get(API, params={"view": "to_decide"}, headers=ram).json()}
    assert cid not in {c["id"] for c in client.get(API, params={"view": "to_decide"}, headers=farhan).json()}
    assert cid in {c["id"] for c in client.get(API, params={"view": "all"}, headers=farhan).json()}  # HR scope
    assert client.get(f"{API}/{cid}", headers=sophie).status_code == 404

    assert client.post(f"{API}/{cid}/decision", headers=babu, json={"decision": "approve"}).status_code == 403
    res = client.post(f"{API}/{cid}/decision", headers=ram, json={"decision": "approve"})
    assert res.status_code == 200 and res.json()["status"] == "approved"  # under 10000: no finance step
    assert client.post(f"{API}/{cid}/decision", headers=ram, json={"decision": "approve"}).status_code == 409

    pay = {"paid_on": (today_ist() - timedelta(days=1)).isoformat(), "payment_reference": "NEFT-001"}
    assert client.post(f"{API}/{cid}/pay", headers=babu, json=pay).status_code == 403
    assert client.post(f"{API}/{cid}/pay", headers=ram, json=pay).status_code == 403
    future = {"paid_on": (today_ist() + timedelta(days=3)).isoformat(), "payment_reference": "X"}
    assert client.post(f"{API}/{cid}/pay", headers=admin, json=future).status_code == 422
    res = client.post(f"{API}/{cid}/pay", headers=admin, json=pay)
    assert res.status_code == 200 and res.json()["status"] == "paid" and res.json()["payment_reference"] == "NEFT-001"
    assert client.post(f"{API}/{cid}/pay", headers=admin, json=pay).status_code == 409
    assert any(n["title"] == "Expense claim paid" for n in client.get("/api/v1/notifications", headers=babu).json())
    with SessionLocal() as db:
        actions = set(db.scalars(select(AuditLog.action).where(AuditLog.entity_id == cid)))
        assert {"expense_submitted", "expense_approved", "expense_paid"} <= actions
        assert db.get(ApprovalInstance, iid).status == "approved"


def test_big_claim_needs_finance_and_receipt_access(client, babu, ram, farhan, admin, jordan, sophie):
    rec = upload(client, babu, unique_pdf("hotel"), filename="hotel.pdf").json()
    res = claim(client, babu, 15000, category="Lodging", receipt_ids=[rec["id"]])
    assert res.status_code == 201, res.text
    item = res.json()
    cid, iid = item["id"], item["approval_instance_id"]
    assert [r["id"] for r in item["receipts"]] == [rec["id"]]
    # the same receipt can't go on another claim
    assert claim(client, babu, 15001, category="Lodging", receipt_ids=[rec["id"]]).status_code == 409

    res = client.post(f"{API}/{cid}/decision", headers=ram, json={"decision": "approve"}).json()
    assert res["status"] == "submitted" and res["current_step"] == 1  # finance (admin fallback) next
    assert cid in {c["id"] for c in client.get(API, params={"view": "to_decide"}, headers=admin).json()}
    # deciding through the generic approvals endpoint updates the claim too
    res = client.post(f"/api/v1/approvals/{iid}/decision", headers=admin, json={"decision": "approve"})
    assert res.status_code == 200 and res.json()["status"] == "approved"
    assert client.get(f"{API}/{cid}", headers=babu).json()["status"] == "approved"

    url = f"{API}/receipts/{rec['id']}"
    for who in (babu, ram, admin, farhan):  # owner, approvers, finance, HR
        res = client.get(url, headers=who)
        assert res.status_code == 200 and res.content == unique_pdf("hotel")
        assert res.headers["content-type"] == "application/pdf"
    assert client.get(url, headers=jordan).status_code == 403  # sees the claim, not an approver / HR / finance
    assert client.get(url, headers=sophie).status_code == 404
    with SessionLocal() as db:
        assert db.scalar(select(AuditLog).where(AuditLog.action == "receipt_downloaded", AuditLog.entity_id == rec["id"]))


def test_unattached_receipt_is_private(client, babu, ram, admin):
    rec = upload(client, babu, unique_pdf("private")).json()
    assert client.get(f"{API}/receipts/{rec['id']}", headers=babu).status_code == 200
    assert client.get(f"{API}/receipts/{rec['id']}", headers=ram).status_code == 404
    assert client.get(f"{API}/receipts/{rec['id']}", headers=admin).status_code == 404


def test_add_receipt_to_claim_and_reuse_blocked(client, babu, ram):
    cid = claim(client, babu, 250, category="Supplies").json()["id"]
    res = upload(client, babu, unique_pdf("supplies"), claim_id=cid)
    assert res.status_code == 201 and res.json()["claim_id"] == cid
    assert upload(client, ram, unique_pdf("other"), claim_id=cid).status_code == 404  # not Ram's claim
    assert upload(client, babu, unique_pdf("supplies")).status_code == 409  # same file already on an open claim
    assert len(client.get(f"{API}/{cid}", headers=babu).json()["receipts"]) == 1


def test_withdraw_and_reject(client, babu, ram):
    cid = claim(client, babu, 222, category="Other").json()["id"]
    assert client.post(f"{API}/{cid}/withdraw", headers=ram).status_code == 404
    res = client.post(f"{API}/{cid}/withdraw", headers=babu)
    assert res.status_code == 200 and res.json()["status"] == "withdrawn" and res.json()["approval_status"] == "cancelled"
    assert client.post(f"{API}/{cid}/withdraw", headers=babu).status_code == 409
    assert cid not in {c["id"] for c in client.get(API, params={"view": "to_decide"}, headers=ram).json()}
    assert claim(client, babu, 222, category="Other").status_code == 201  # no longer a duplicate
    assert upload(client, babu, unique_pdf("late"), claim_id=cid).status_code == 409

    cid = claim(client, babu, 333, category="Other").json()["id"]
    assert client.post(f"{API}/{cid}/decision", headers=ram, json={"decision": "reject"}).status_code == 422
    res = client.post(f"{API}/{cid}/decision", headers=ram, json={"decision": "reject", "note": "Personal expense"})
    assert res.json()["status"] == "rejected"
    assert client.post(f"{API}/{cid}/pay", headers=token_for("demo-admin", "admin"),
                       json={"paid_on": (today_ist() - timedelta(days=1)).isoformat(), "payment_reference": "R"}).status_code == 409


def test_finance_role_approves_and_sees_all(client, babu, ram):
    with SessionLocal() as db:
        person = db.scalar(select(Employee.id).where(Employee.source == "hcm_sample", Employee.country_code == "GB")
                           .order_by(Employee.id))
        db.add(Account(id="test-finance", email="finance.test@timez.com", password_hash="x", role="finance",
                       employee_id=person, active=True, failed_attempts=0))
        db.commit()
    finance = token_for("test-finance", "finance")
    try:
        rec = upload(client, babu, unique_pdf("laptop")).json()
        item = claim(client, babu, 12000, category="Supplies", receipt_ids=[rec["id"]]).json()
        with SessionLocal() as db:
            steps = db.get(ApprovalInstance, item["approval_instance_id"]).steps
            assert steps[1]["groups"]["finance"] == [person]
        assert item["id"] in {c["id"] for c in client.get(API, params={"view": "all"}, headers=finance).json()}
        assert client.get(f"{API}/receipts/{rec['id']}", headers=finance).status_code == 200
        client.post(f"{API}/{item['id']}/decision", headers=ram, json={"decision": "approve"})
        res = client.post(f"{API}/{item['id']}/decision", headers=finance, json={"decision": "approve"})
        assert res.status_code == 200 and res.json()["status"] == "approved"
        res = client.post(f"{API}/{item['id']}/pay", headers=finance,
                          json={"paid_on": (today_ist() - timedelta(days=1)).isoformat(), "payment_reference": "WIRE-77"})
        assert res.status_code == 200 and res.json()["paid_by"] == person
    finally:
        with SessionLocal() as db:
            db.get(Account, "test-finance").active = False
            db.commit()
