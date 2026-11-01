"""Tax declarations: drafts, proofs, submit, Finance / HR verification, privacy, deadlines, regime lock, no amounts in audit."""

from datetime import date, timedelta

from sqlalchemy import select

from app.db import SessionLocal
from app.models import AuditLog, Notification, TaxDeclarationWindow

API = "/api/v1/tax-declarations"
PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"


def _fy(client, headers):
    cfg = client.get(f"{API}/config", headers=headers)
    assert cfg.status_code == 200, cfg.text
    return cfg.json()


def test_full_flow_and_privacy(client, babu, farhan, ram):
    cfg = _fy(client, babu)
    assert cfg["country_code"] == "IN" and cfg["has_declarations"] and cfg["verifier"] is False
    codes = {s["code"] for s in cfg["sections"]}
    assert {"80C", "80D", "HRA", "24(b)", "80CCD(1B)", "LTA"} <= codes
    fy = cfg["years"][0]["financial_year"]
    assert cfg["years"][0]["open"] is True

    # New regime: nothing to declare.
    assert client.post("/api/v1/payroll/me/tax-regime", json={"regime": "new"}, headers=babu).status_code == 200
    res = client.post(API, json={"financial_year": fy, "section": "80C", "title": "PPF", "amount": 10000}, headers=babu)
    assert res.status_code == 409 and "old regime" in res.json()["detail"]
    assert client.post("/api/v1/payroll/me/tax-regime", json={"regime": "old"}, headers=babu).status_code == 200

    try:
        # Caps per section, per year.
        res = client.post(API, json={"financial_year": fy, "section": "80C", "title": "Too much", "amount": 140000}, headers=babu)
        assert res.status_code == 422 and "80C allows" in res.json()["detail"]
        res = client.post(API, json={"financial_year": fy, "section": "80CCD(1B)", "title": "NPS tier 1", "amount": 30000,
                                     "note": "Monthly SIP"}, headers=babu)
        assert res.status_code == 201, res.text
        item = res.json()
        assert item["status"] == "draft" and item["editable"] and item["currency"] == "INR"

        # Edit, then submit needs a proof.
        res = client.put(f"{API}/{item['id']}", json={"financial_year": fy, "section": "80CCD(1B)", "title": "NPS tier 1",
                                                      "amount": 35000}, headers=babu)
        assert res.status_code == 200 and res.json()["amount"] == 35000
        assert client.post(f"{API}/{item['id']}/submit", headers=babu).status_code == 422
        bad = client.post(f"{API}/{item['id']}/documents?filename=x.exe", content=b"MZ\x90\x00binary", headers={**babu, "Content-Type": "application/pdf"})
        assert bad.status_code in (415, 422)
        up = client.post(f"{API}/{item['id']}/documents?filename=nps.pdf", content=PDF, headers={**babu, "Content-Type": "application/pdf"})
        assert up.status_code == 201, up.text
        doc = up.json()["documents"][0]
        assert doc["file_name"] == "nps.pdf"
        res = client.post(f"{API}/{item['id']}/submit", headers=babu)
        assert res.status_code == 200 and res.json()["status"] == "submitted" and not res.json()["editable"]
        # Submitted items can't be edited or deleted, only withdrawn.
        assert client.delete(f"{API}/{item['id']}", headers=babu).status_code == 409

        # Privacy: a manager is not a verifier and can't fetch the proof; another employee's item is 404.
        assert client.get(f"{API}/queue", headers=ram).status_code == 403
        assert client.get(f"{API}/{item['id']}/documents/{doc['id']}", headers=ram).status_code == 404
        assert client.post(f"{API}/{item['id']}/decision", json={"decision": "verify"}, headers=ram).status_code == 403
        assert client.put(f"{API}/{item['id']}", json={"financial_year": fy, "section": "80C", "title": "x", "amount": 1},
                          headers=ram).status_code == 404

        # HR / Finance verify: queue, proof download, reject needs a reason, partial verification.
        queue = client.get(f"{API}/queue", params={"q": "Babu"}, headers=farhan)
        assert queue.status_code == 200 and any(q["id"] == item["id"] for q in queue.json())
        got = client.get(f"{API}/{item['id']}/documents/{doc['id']}", headers=farhan)
        assert got.status_code == 200 and got.content.startswith(b"%PDF")
        assert client.post(f"{API}/{item['id']}/decision", json={"decision": "reject"}, headers=farhan).status_code == 422
        res = client.post(f"{API}/{item['id']}/decision", json={"decision": "reject", "note": "Statement is unsigned"}, headers=farhan)
        assert res.status_code == 200 and res.json()["status"] == "rejected"
        # The employee corrects and resubmits; HR verifies a lower amount.
        res = client.post(f"{API}/{item['id']}/submit", headers=babu)
        assert res.status_code == 200 and res.json()["status"] == "submitted"
        res = client.post(f"{API}/{item['id']}/decision", json={"decision": "verify", "verified_amount": 40000}, headers=farhan)
        assert res.status_code == 422  # more than declared
        res = client.post(f"{API}/{item['id']}/decision", json={"decision": "verify", "verified_amount": 30000, "note": "Two months only"},
                          headers=farhan)
        assert res.status_code == 200 and res.json()["status"] == "verified" and res.json()["verified_amount"] == 30000
        assert [h["action"] for h in res.json()["history"]][-1] == "Verified"
        assert client.post(f"{API}/{item['id']}/decision", json={"decision": "verify"}, headers=farhan).status_code == 409
        # HR can't verify their own.
        assert client.post(f"{API}/{item['id']}/withdraw", headers=babu).status_code == 409

        with SessionLocal() as db:
            notes = db.scalars(select(Notification.title).where(Notification.recipient_id == "emp-mahesh")).all()
            assert any(t.startswith("Tax proof rejected") for t in notes) and any(t.startswith("Tax proof verified") for t in notes)
            hr_notes = db.scalars(select(Notification.title).where(Notification.recipient_id == "demo-hr-admin")).all()
            assert any(t.startswith("Verify tax proof: Babu") for t in hr_notes)
            # No amounts in the audit log.
            for row in db.scalars(select(AuditLog).where(AuditLog.entity == "tax_declaration")):
                text = str(row.changes)
                assert "35000" not in text and "30000" not in text and "amount" not in text

        # Payroll inputs carry the verified amount.
        month = date.today().replace(day=1) - timedelta(days=1)
        inputs = client.get("/api/v1/payroll/runs/inputs", params={"month": month.strftime("%Y-%m"), "country": "IN",
                                                                   "entity": "TimeZ India Pvt Ltd"}, headers=farhan)
        assert inputs.status_code == 200, inputs.text
        mine = next(p for p in inputs.json() if p["employee_id"] == "emp-mahesh")
        assert {"financial_year": fy, "section": "80CCD(1B)", "amount": 30000} in mine["declarations"]

        # Drafts can be deleted.
        res = client.post(API, json={"financial_year": fy, "section": "LTA", "title": "Goa trip", "amount": 12000}, headers=babu)
        assert res.status_code == 201
        assert client.delete(f"{API}/{res.json()['id']}", headers=babu).status_code == 204
        assert all(i["id"] != res.json()["id"] for i in client.get(f"{API}/mine", headers=babu).json())
    finally:
        client.post("/api/v1/payroll/me/tax-regime", json={"regime": "new"}, headers=babu)


def test_deadline_locks_changes_and_regime(client, babu):
    cfg = _fy(client, babu)
    fy = cfg["years"][0]["financial_year"]
    with SessionLocal() as db:
        row = db.scalar(select(TaxDeclarationWindow).where(TaxDeclarationWindow.country_code == "IN",
                                                           TaxDeclarationWindow.financial_year == fy))
        assert row is not None
        saved = (row.deadline, row.locked)
        row.deadline = date.today() - timedelta(days=1)
        db.commit()
    try:
        cfg = _fy(client, babu)
        assert cfg["years"][0]["open"] is False and cfg["regime_editable"] is False
        res = client.post("/api/v1/payroll/me/tax-regime", json={"regime": "old"}, headers=babu)
        assert res.status_code == 409
        res = client.post(API, json={"financial_year": fy, "section": "80C", "title": "Late", "amount": 1000}, headers=babu)
        assert res.status_code == 409
    finally:
        with SessionLocal() as db:
            row = db.scalar(select(TaxDeclarationWindow).where(TaxDeclarationWindow.country_code == "IN",
                                                               TaxDeclarationWindow.financial_year == fy))
            row.deadline, row.locked = saved
            db.commit()


def test_deadline_reminder_once(client, babu):
    cfg = _fy(client, babu)
    fy = cfg["years"][0]["financial_year"]
    client.post("/api/v1/payroll/me/tax-regime", json={"regime": "old"}, headers=babu)
    with SessionLocal() as db:
        row = db.scalar(select(TaxDeclarationWindow).where(TaxDeclarationWindow.country_code == "IN",
                                                           TaxDeclarationWindow.financial_year == fy))
        saved = row.deadline
        row.deadline = date.today() + timedelta(days=5)
        db.commit()
    try:
        _fy(client, babu)
        _fy(client, babu)
        with SessionLocal() as db:
            n = db.scalars(select(Notification).where(Notification.recipient_id == "emp-mahesh",
                                                      Notification.title.like(f"Tax declarations for {fy} close%"))).all()
            assert len(n) == 1
    finally:
        with SessionLocal() as db:
            row = db.scalar(select(TaxDeclarationWindow).where(TaxDeclarationWindow.country_code == "IN",
                                                               TaxDeclarationWindow.financial_year == fy))
            row.deadline = saved
            db.commit()
        client.post("/api/v1/payroll/me/tax-regime", json={"regime": "new"}, headers=babu)


def test_other_country_sections(client):
    from tests.conftest import login

    jordan = login(client, "jordan.blake@timez.com")
    cfg = _fy(client, jordan)
    assert cfg["country_code"] == "US" and cfg["regime"] is None
    assert {s["code"] for s in cfg["sections"]} >= {"401(k)", "HSA"}
    assert cfg["years"][0]["financial_year"].startswith("Tax year ")
