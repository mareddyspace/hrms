"""Sensitive personal details are masked in responses; full values only via audited reveal endpoints."""

from __future__ import annotations

import pytest
from sqlalchemy import select

from app.db import SessionLocal
from app.models import AuditLog, Employee
from app.services.pii import mask_address, mask_dob, mask_email, mask_id, mask_phone
from tests.conftest import login
from tests.talent_helpers import R, add_candidate, token_for

DOT = "•"
P = "/api/v1/people"


@pytest.fixture(scope="module")
def jordan(client):
    return login(client, "jordan.blake@timez.com")


@pytest.fixture(scope="module")
def sophie(client):
    return login(client, "sophie.clark@timez.com")


@pytest.fixture(scope="module")
def babu_raw():
    with SessionLocal() as db:
        emp = db.get(Employee, "emp-mahesh")
        assert emp is not None and emp.mobile and emp.date_of_birth
        return {"mobile": emp.mobile, "personal_email": emp.personal_email, "date_of_birth": emp.date_of_birth.isoformat()}


def _reveal_audits(subject: str) -> list[AuditLog]:
    with SessionLocal() as db:
        return list(db.scalars(select(AuditLog).where(AuditLog.action == "viewed personal detail",
                                                      AuditLog.subject_id == subject)))


def test_mask_formats():
    assert mask_phone("+91 98450 22110") == f"+91 {DOT * 5} 22110"
    assert mask_phone("+919845022110") == f"+91 {DOT * 5} 22110"
    assert mask_email("babu@gmail.com") == f"b{DOT * 3}@gmail.com"
    assert mask_dob("1990-06-14") == f"{DOT * 2} {DOT * 3} 1990"
    assert mask_address("12 MG Road, Bengaluru, India") == "Bengaluru, India"
    assert mask_id("ABCDE1234F") == f"{DOT * 4} 234F"
    assert mask_phone(None) is None and mask_phone(mask_phone("+91 98450 22110")) == f"+91 {DOT * 5} 22110"


@pytest.mark.parametrize("who", ["babu", "ram", "farhan", "jordan"])
def test_full_record_is_masked_for_every_role(client, request, who, babu_raw):
    body = client.get(f"{P}/emp-mahesh", headers=request.getfixturevalue(who)).json()
    assert body["view"] == "full"
    assert body["mobile"] != babu_raw["mobile"] and DOT in body["mobile"]
    assert body["date_of_birth"] == mask_dob(babu_raw["date_of_birth"])
    if babu_raw["personal_email"]:
        assert body["personal_email"] == mask_email(babu_raw["personal_email"])
    assert "@timez.com" in body["email"]  # work email stays visible
    listed = client.get(P, headers=request.getfixturevalue(who), params={"q": "emp-mahesh"}).json()["items"]
    assert all(babu_raw["mobile"] not in str(p) for p in listed)


def test_can_reveal_flag(client, babu, ram, farhan, jordan):
    assert client.get(f"{P}/emp-mahesh", headers=babu).json()["can_reveal"] is True  # owner
    assert client.get(f"{P}/emp-mahesh", headers=farhan).json()["can_reveal"] is True  # HR in scope
    assert client.get(f"{P}/emp-mahesh", headers=ram).json()["can_reveal"] is False  # manager
    assert client.get(f"{P}/emp-mahesh", headers=jordan).json()["can_reveal"] is False  # executive


def test_owner_reveals_without_audit(client, babu, babu_raw):
    before = len(_reveal_audits("emp-mahesh"))
    for field in ("mobile", "date_of_birth"):
        res = client.get(f"{P}/emp-mahesh/reveal", headers=babu, params={"field": field})
        assert res.status_code == 200 and res.json()["value"] == babu_raw[field]
    assert len(_reveal_audits("emp-mahesh")) == before


def test_hr_reveal_is_audited_without_value(client, farhan, babu_raw):
    before = len(_reveal_audits("emp-mahesh"))
    res = client.get(f"{P}/emp-mahesh/reveal", headers=farhan, params={"field": "mobile"})
    assert res.status_code == 200 and res.json()["value"] == babu_raw["mobile"]
    # The platform admin is a system administrator, not HR: no PII reveal (src/data/rbac.ts canViewSensitivePii).
    admin = token_for("demo-admin", "admin")
    assert client.get(f"{P}/emp-mahesh/reveal", headers=admin, params={"field": "date_of_birth"}).status_code == 403
    res = client.get(f"{P}/emp-mahesh/reveal", headers=farhan, params={"field": "date_of_birth"})
    assert res.status_code == 200
    rows = _reveal_audits("emp-mahesh")
    assert len(rows) == before + 2
    last = rows[-2]
    assert last.entity == "employee" and last.entity_id == "emp-mahesh" and last.changes["after"] == {"field": "mobile"}
    assert babu_raw["mobile"] not in str(last.changes) and babu_raw["date_of_birth"] not in str(rows[-1].changes)


def test_others_cannot_reveal(client, babu, ram, jordan):
    for headers in (ram, jordan):
        assert client.get(f"{P}/emp-mahesh/reveal", headers=headers, params={"field": "mobile"}).status_code == 403
    assert client.get(f"{P}/emp-ram/reveal", headers=babu, params={"field": "mobile"}).status_code == 403
    assert client.get(f"{P}/emp-mahesh/reveal", headers=babu, params={"field": "salary"}).status_code == 422


def test_hr_outside_country_scope_cannot_reveal():
    from types import SimpleNamespace

    from app.services.pii import can_reveal_employee
    from app.services.scope import Scope

    def user(role: str, countries=None, self_id="emp-x"):
        return SimpleNamespace(employee_id=self_id, account=SimpleNamespace(role=role),
                               scope=Scope(self_id=self_id, role=role, is_global=True, countries=countries))

    india, uk = SimpleNamespace(id="emp-in", country_code="IN"), SimpleNamespace(id="emp-gb", country_code="GB")
    assert can_reveal_employee(user("hr_admin", ["IN"]), india) and not can_reveal_employee(user("hr_admin", ["IN"]), uk)
    assert not can_reveal_employee(user("admin"), uk) and not can_reveal_employee(user("executive"), uk)
    assert can_reveal_employee(user("executive", self_id="emp-gb"), uk)  # their own record


def test_dependent_dob_masked_for_hr(client, babu, farhan):
    res = client.post("/api/v1/benefits/dependents", headers=babu,
                      json={"name": "Masked Parent", "relationship": "Parent", "date_of_birth": "1961-03-04"})
    assert res.status_code == 201, res.text
    assert res.json()["date_of_birth"] == "1961-03-04"  # owner sees their own
    dep_id = res.json()["id"]
    hr_view = client.get("/api/v1/benefits/dependents", headers=farhan, params={"employee_id": "emp-mahesh"}).json()
    row = next(d for d in hr_view if d["id"] == dep_id)
    assert row["date_of_birth"] == mask_dob("1961-03-04")
    assert client.delete(f"/api/v1/benefits/dependents/{dep_id}", headers=babu).status_code in (204, 409)


def test_candidate_phone_masked_with_recruiter_reveal(client, sophie, babu, ram):
    res = add_candidate(client, sophie, "Mask Test", "mask.test@mail.example", phone="+91 99887 66554")
    assert res.status_code == 201, res.text
    cand = res.json()
    assert cand["phone"] == f"+91 {DOT * 5} 66554"
    listed = client.get(f"{R}/candidates", headers=sophie, params={"requisition_id": "JOB-221"}).json()
    assert all("99887" not in (c["phone"] or "") for c in listed)
    # Saving the masked copy back doesn't overwrite the number.
    assert client.patch(f"{R}/candidates/{cand['id']}", headers=sophie, json={"phone": cand["phone"]}).status_code == 200
    res = client.get(f"{R}/candidates/{cand['id']}/reveal", headers=sophie)
    assert res.status_code == 200 and res.json()["value"] == "+91 99887 66554"
    with SessionLocal() as db:
        audit = db.scalars(select(AuditLog).where(AuditLog.entity == "candidate", AuditLog.entity_id == cand["id"],
                                                  AuditLog.action == "viewed personal detail")).all()
    assert len(audit) == 1 and "99887" not in str(audit[0].changes)
    # The hiring manager sees the candidate but can't reveal the number.
    assert client.get(f"{R}/candidates/{cand['id']}/reveal", headers=ram).status_code == 403
    assert client.get(f"{R}/candidates/{cand['id']}/reveal", headers=babu).status_code == 404
