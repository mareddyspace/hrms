"""Documents & letters, round 2: per-category rules, soft delete, inline preview, employee folders, HR expiry digest,
letter templates per legal entity with placeholders and preview."""

import os
import tempfile
from datetime import date, timedelta

import pytest
from sqlalchemy import select

from app.db import SessionLocal
from app.models import AuditLog, Employee, EmployeeDocument, Notification

DOCS = "/api/v1/documents"
LETTERS = "/api/v1/letters"
PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


@pytest.fixture(scope="module", autouse=True)
def storage_dir():
    old = os.environ.get("STORAGE_DIR")
    os.environ["STORAGE_DIR"] = tempfile.mkdtemp(prefix="timez-docs2-")
    yield
    if old is None:
        os.environ.pop("STORAGE_DIR", None)
    else:
        os.environ["STORAGE_DIR"] = old


@pytest.fixture()
def restore_categories(client, farhan):
    before = client.get(f"{DOCS}/rules", headers=farhan).json()["category_config"]
    yield
    assert client.put(f"{DOCS}/categories", headers=farhan, json=before).status_code == 200


def upload(client, headers, data=PDF, content_type="application/pdf", **params):
    params = {"category": "Other", "title": "Note", "filename": "note.pdf"} | params
    return client.post(DOCS, headers={**headers, "Content-Type": content_type}, params=params, content=data)


def _config(client, headers, **changes):
    rows = client.get(f"{DOCS}/rules", headers=headers).json()["category_config"]
    return [r | changes.get(r["name"], {}) for r in rows]


def test_rules_expose_category_policy(client, babu):
    rules = client.get(f"{DOCS}/rules", headers=babu).json()
    cfg = {c["name"]: c for c in rules["category_config"]}
    assert cfg["Immigration"]["requires_expiry"] and cfg["Identity"]["required"]
    assert cfg["Payroll"]["label"] == "Payroll & tax" and cfg["Letters"]["types"] == ["pdf"]
    assert set(rules["manager_categories"]) == {c for c, v in cfg.items() if v["manager_visible"]}
    assert all(1 <= c["max_mb"] <= 10 and c["types"] for c in cfg.values())


def test_category_types_size_and_required_expiry(client, babu, farhan, restore_categories):
    config = _config(client, farhan, Personal={"types": ["pdf"], "max_mb": 1})
    assert client.put(f"{DOCS}/categories", headers=babu, json=config).status_code == 403
    assert client.put(f"{DOCS}/categories", headers=farhan, json=config).status_code == 200
    bad = upload(client, babu, data=PNG, content_type="image/png", category="Personal", filename="x.png")
    assert bad.status_code == 415 and "PDF" in bad.json()["detail"]
    big = upload(client, babu, data=PDF + b"0" * (1024 * 1024), category="Personal")
    assert big.status_code == 413 and "1 MB" in big.json()["detail"]
    assert upload(client, babu, category="Personal").status_code == 201
    # Visas need an expiry date: on upload, and it can't be cleared later.
    assert upload(client, babu, category="Immigration", title="Work visa").status_code == 422
    expiry = (date.today() + timedelta(days=200)).isoformat()
    visa = upload(client, babu, category="Immigration", title="Work visa", expiry_date=expiry)
    assert visa.status_code == 201, visa.text
    assert client.patch(f"{DOCS}/{visa.json()['id']}", headers=babu, json={"expiry_date": None}).status_code == 422
    # Old clients that send only the original four fields keep the other rules.
    legacy = [{k: c[k] for k in ("name", "label", "verification", "employee_upload")} for c in config]
    saved = {c["name"]: c for c in client.put(f"{DOCS}/categories", headers=farhan, json=legacy).json()}
    assert saved["Personal"]["types"] == ["pdf"] and saved["Personal"]["max_mb"] == 1


def test_manager_visibility_follows_policy(client, babu, ram, farhan, restore_categories):
    med = upload(client, babu, category="Medical", title="Fitness certificate").json()
    assert client.get(f"{DOCS}/{med['id']}", headers=ram).status_code == 404
    assert client.put(f"{DOCS}/categories", headers=farhan,
                      json=_config(client, farhan, Medical={"manager_visible": True})).status_code == 200
    assert client.get(f"{DOCS}/{med['id']}", headers=ram).status_code == 200
    assert med["id"] in [d["id"] for d in client.get(DOCS, headers=ram, params={"employee_id": "emp-mahesh"}).json()]


def test_soft_delete_rules_and_audit(client, babu, ram, farhan):
    own = upload(client, babu, title="Old address proof").json()
    assert client.delete(f"{DOCS}/{own['id']}", headers=ram).status_code == 404  # the manager can't see "Other"
    assert client.delete(f"{DOCS}/{own['id']}", headers=babu).status_code == 204
    assert client.get(f"{DOCS}/{own['id']}", headers=babu).status_code == 404
    assert client.get(f"{DOCS}/{own['id']}/download", headers=farhan).status_code == 404
    assert own["id"] not in [d["id"] for d in client.get(DOCS, headers=babu).json()]
    with SessionLocal() as db:
        row = db.get(EmployeeDocument, own["id"])
        assert row is not None and row.deleted_at is not None and row.deleted_by  # kept for the audit trail
        assert db.scalar(select(AuditLog).where(AuditLog.action == "document_deleted", AuditLog.entity_id == own["id"]))
    # HR-added documents: the employee can't remove them; HR must give a reason, and the employee is told.
    hr_doc = client.post(DOCS, headers={**farhan, "Content-Type": "application/pdf"}, content=PDF,
                         params={"category": "Contracts", "title": "Contract", "employee_id": "emp-mahesh"}).json()
    assert client.delete(f"{DOCS}/{hr_doc['id']}", headers=babu).status_code == 403
    assert client.request("DELETE", f"{DOCS}/{hr_doc['id']}", headers=farhan).status_code == 422
    assert client.request("DELETE", f"{DOCS}/{hr_doc['id']}", headers=farhan,
                          json={"reason": "Uploaded to the wrong person"}).status_code == 204
    with SessionLocal() as db:
        assert db.scalar(select(Notification).where(Notification.recipient_id == "emp-mahesh",
                                                    Notification.title == "Contract was removed"))
    # A verified upload stays unless HR removes it.
    edu = upload(client, babu, category="Education", title="Diploma").json()
    assert client.post(f"{DOCS}/{edu['id']}/verification", headers=farhan, json={"decision": "verify"}).status_code == 200
    assert client.delete(f"{DOCS}/{edu['id']}", headers=babu).status_code == 403


def test_inline_preview_is_audited_as_a_view(client, babu):
    doc = upload(client, babu, title="Preview me").json()
    res = client.get(f"{DOCS}/{doc['id']}/download", headers=babu, params={"inline": "true"})
    assert res.status_code == 200 and res.headers["content-disposition"].startswith("inline")
    assert client.get(f"{DOCS}/{doc['id']}/download", headers=babu).headers["content-disposition"].startswith("attachment")
    with SessionLocal() as db:
        assert db.scalar(select(AuditLog).where(AuditLog.action == "document_viewed", AuditLog.entity_id == doc["id"]))


def test_employee_folders(client, babu, ram, farhan):
    hr = {f["employee_id"]: f for f in client.get(f"{DOCS}/folders", headers=farhan).json()}
    assert "emp-mahesh" in hr and hr["emp-mahesh"]["documents"] >= 1
    mine = client.get(f"{DOCS}/folders", headers=babu).json()
    assert [f["employee_id"] for f in mine] == ["emp-mahesh"]
    team = {f["employee_id"]: f for f in client.get(f"{DOCS}/folders", headers=ram).json()}
    assert "emp-mahesh" in team
    # the manager's count only covers categories they may see, and never names identity proofs as missing
    assert team["emp-mahesh"]["documents"] <= hr["emp-mahesh"]["documents"]
    assert "Identity proofs" not in team["emp-mahesh"]["missing"]
    assert client.get(f"{DOCS}/folders", headers=farhan, params={"q": "zzz-nobody"}).json() == []


def test_expiry_digest_for_hr(client, babu):
    from app.services import jobs
    from app.services.documents import send_expiry_reminders

    doc = upload(client, babu, title="Expiring permit", expiry_date=(date.today() + timedelta(days=3)).isoformat()).json()
    with SessionLocal() as db:
        assert send_expiry_reminders(db, date.today(), jobs._send) >= 2  # the owner, and the HR digest
        db.commit()
        assert db.scalar(select(Notification).where(Notification.recipient_id == "demo-hr-admin",
                                                    Notification.title.like("%expiring within 7 days%")))
        assert send_expiry_reminders(db, date.today(), jobs._send) == 0
    assert doc["days_to_expiry"] == 3


def test_letter_templates_per_entity_with_preview(client, babu, farhan):
    names = {p["name"] for p in client.get(f"{LETTERS}/placeholders", headers=farhan).json()}
    assert {"employee", "entity", "joining_date"} <= names
    body = {"letter_type": "Bonafide", "title": "Bonafide Certificate", "to_whom": True,
            "paragraphs": ["{employee} works at {entity} as {role}.", "Issued for official use."]}
    assert client.post(f"{LETTERS}/templates/preview", headers=babu, json=body).status_code == 403
    prev = client.post(f"{LETTERS}/templates/preview", headers=farhan, json=body | {"employee_id": "emp-mahesh"})
    assert prev.status_code == 200 and "Babu Menon" in prev.json()["paragraphs"][0]
    assert client.post(f"{LETTERS}/templates/preview", headers=farhan,
                       json=body | {"paragraphs": ["{salary_typo}"]}).status_code == 422
    with SessionLocal() as db:
        entity = db.get(Employee, "emp-mahesh").legal_entity
    assert client.post(f"{LETTERS}/templates", headers=farhan,
                       json=body | {"country_code": "IN", "legal_entity": entity}).status_code == 422
    made = client.post(f"{LETTERS}/templates", headers=farhan,
                       json=body | {"legal_entity": entity, "paragraphs": ["ENTITY WORDING for {employee_name}."]})
    assert made.status_code == 201, made.text
    tid = made.json()["id"]
    assert made.json()["legal_entity"] == entity and made.json()["country_code"] is None
    assert client.post(f"{LETTERS}/templates", headers=farhan, json=body | {"legal_entity": entity.upper()}).status_code == 409
    draft = client.post(f"{LETTERS}/draft-preview", headers=babu, json={"letter_type": "Bonafide"}).json()
    assert draft["paragraphs"][0].startswith("ENTITY WORDING for Babu Menon")
    # Switched off, the country / default wording applies again; the default itself can't be switched off.
    off = client.put(f"{LETTERS}/templates/{tid}", headers=farhan,
                     json={"title": "Bonafide Certificate", "to_whom": True, "paragraphs": ["ENTITY WORDING."], "active": False})
    assert off.status_code == 200 and off.json()["active"] is False and off.json()["version"] == 2
    draft = client.post(f"{LETTERS}/draft-preview", headers=babu, json={"letter_type": "Bonafide"}).json()
    assert not draft["paragraphs"][0].startswith("ENTITY WORDING")
    default = next(t for t in client.get(f"{LETTERS}/templates", headers=farhan, params={"letter_type": "Bonafide"}).json()
                   if t["country_code"] is None and not t["legal_entity"])
    assert client.put(f"{LETTERS}/templates/{default['id']}", headers=farhan,
                      json={"title": default["title"], "to_whom": True, "paragraphs": default["paragraphs"],
                            "active": False}).status_code == 422
    with SessionLocal() as db:
        assert db.scalar(select(AuditLog).where(AuditLog.action == "letter_template_created", AuditLog.entity_id == tid))
