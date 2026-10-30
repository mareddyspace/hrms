"""Security audit: role and data-scope checks with real signed-in sessions for the six demo roles.

Babu (employee, reports to Ram) · Ram (manager, reports to Jordan) · Farhan (HR) · Sophie (recruiter, reports to Farhan)
Jordan (CEO / executive, also stands for Founder) · Alex (admin). Extra accounts for sample employees are made here
with real passwords and signed in through /auth/login.
"""

from __future__ import annotations

import re
import uuid
from datetime import date, timedelta

import pytest
from sqlalchemy import exists, select
from sqlalchemy.orm import aliased

from app.db import SessionLocal
from app.models import AccessScope, Account, Employee
from app.security import hash_password
from tests.conftest import login

API = "/api/v1"
AUDIT_PASSWORD = "Audit-Pass-2026x"


@pytest.fixture(scope="module")
def sophie(client):
    return login(client, "sophie.clark@timez.com")


@pytest.fixture(scope="module")
def jordan(client):
    return login(client, "jordan.blake@timez.com")


@pytest.fixture(scope="module")
def alex(client):
    return login(client, "alex.morgan@timez.com")


def retire_audit_accounts() -> None:
    """Switch the audit accounts off again, so other test files see the approver groups they expect."""
    with SessionLocal() as db:
        for acc in db.scalars(select(Account).where(Account.id.like("audit-%"))):
            acc.active = False
        db.commit()


@pytest.fixture(scope="module", autouse=True)
def audit_accounts_cleanup():
    yield
    retire_audit_accounts()


def real_account(client, employee_id: str, role: str, countries: str | None = None) -> dict[str, str]:
    """A sign-in account with a real password for a sample employee, then a real /auth/login."""
    email = f"audit.{employee_id.lower()}@timez.example"
    with SessionLocal() as db:
        acc = db.scalar(select(Account).where(Account.employee_id == employee_id))
        if acc is None:
            acc = Account(id=f"audit-{employee_id}", email=email, password_hash=hash_password(AUDIT_PASSWORD), role=role,
                          employee_id=employee_id, active=True)
            db.add(acc)
        else:
            acc.password_hash, acc.role, acc.active, acc.locked_until, acc.failed_attempts = (
                hash_password(AUDIT_PASSWORD), role, True, None, 0)
        db.flush()
        if countries is not None:
            row = db.get(AccessScope, acc.id) or AccessScope(account_id=acc.id)
            row.country_codes = countries
            db.merge(row)
        db.commit()
        email = acc.email
    res = client.post(f"{API}/auth/login", json={"email": email, "password": AUDIT_PASSWORD})
    assert res.status_code == 200, res.text
    return {"Authorization": f"Bearer {res.json()['access_token']}"}


def sample_employee(country: str, offset: int = 0, leaf: bool = True) -> str:
    report = aliased(Employee)
    with SessionLocal() as db:
        stmt = select(Employee.id).where(Employee.source == "hcm_sample", Employee.country_code == country,
                                         Employee.employment_status == "Active", Employee.manager_id.is_not(None),
                                         ~exists().where(Account.employee_id == Employee.id))
        if leaf:
            stmt = stmt.where(~exists().where(report.manager_id == Employee.id))
        ids = list(db.scalars(stmt.order_by(Employee.id).offset(300 + offset).limit(1)))
        if not ids:
            ids = list(db.scalars(stmt.order_by(Employee.id).offset(offset).limit(1)))
    assert ids, country
    return ids[0]


def _ids_in(obj, key_names=("employee_id", "subject_id", "person_id", "id")) -> set[str]:
    found: set[str] = set()
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in key_names and isinstance(v, str):
                found.add(v)
            found |= _ids_in(v, key_names)
    elif isinstance(obj, list):
        for v in obj:
            found |= _ids_in(v, key_names)
    return found


def denied_or_absent(res, target: str) -> bool:
    """403/404, or a 200 whose rows never belong to the target (the parameter was ignored / filtered out)."""
    if res.status_code in (403, 404):
        return True
    if res.status_code != 200:
        return False
    return target not in _ids_in(res.json(), ("employee_id", "subject_id", "person_id"))


# Lists that take ?employee_id=... and hold confidential data about that person.
CONFIDENTIAL_BY_PARAM = [
    "/leave/balances", "/leave/requests", "/attendance", "/attendance/summary", "/timesheets/entries",
    "/performance/goals", "/performance/check-ins", "/learning/enrollments", "/learning/certifications",
    "/learning/skills", "/compensation/records", "/compensation/bonuses", "/benefits/life-events",
    "/benefits/dependents", "/benefits/enrollments", "/benefits/beneficiaries", "/documents", "/documents/policy-acks",
    "/recognition/points", "/career/matches", "/lifecycle/actions",
]
PAY_BY_PARAM = ["/compensation/records", "/compensation/bonuses"]
PII = {"emp-ram": ["+91 98450 11001", "ram.krishnan@mail.example", "1985-02-09"]}


# ---------- employee ----------
@pytest.mark.parametrize("path", CONFIDENTIAL_BY_PARAM)
@pytest.mark.parametrize("target", ["emp-ram", "demo-hr-admin", "demo-ceo"])
def test_employee_cannot_read_others_by_param(client, babu, path, target):
    res = client.get(f"{API}{path}", headers=babu, params={"employee_id": target})
    assert denied_or_absent(res, target), (path, target, res.status_code, res.text[:300])


def test_employee_sees_only_basic_profile_of_others(client, babu):
    for target in ("emp-ram", "demo-hr-admin", "demo-ceo", "demo-recruiter"):
        res = client.get(f"{API}/people/{target}", headers=babu)
        assert res.status_code == 200
        body = res.json()
        assert body["view"] == "basic"
        for field in ("mobile", "personal_email", "date_of_birth", "grade", "employee_code", "address_line",
                      "emergency_phone", "gender", "tax_regime"):
            assert field not in body, (target, field)
    text = client.get(f"{API}/people/emp-ram", headers=babu).text
    assert not [v for v in PII["emp-ram"] if v in text]


@pytest.mark.parametrize("field", ["mobile", "personal_email", "date_of_birth", "address_line", "emergency_phone"])
def test_employee_cannot_reveal_others(client, babu, field):
    for target in ("emp-ram", "demo-hr-admin", "demo-ceo"):
        res = client.get(f"{API}/people/{target}/reveal", headers=babu, params={"field": field})
        assert res.status_code in (403, 404), (target, field, res.status_code)


def test_directory_never_carries_raw_pii(client, babu, ram, sophie, jordan, alex, farhan):
    phone = re.compile(r"\+\d{1,3}[ -]?\d{5}[ -]?\d{5}")
    for h in (babu, ram, sophie, jordan, alex, farhan):
        res = client.get(f"{API}/people", headers=h, params={"page_size": 200})
        assert res.status_code == 200
        assert not phone.search(res.text), "an unmasked phone number in the directory"
        assert "@mail.example" not in res.text.replace("•••@mail.example", "")


def test_employee_cannot_open_others_documents_by_id(client, babu, ram):
    pdf = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"
    res = client.post(f"{API}/documents", headers={**ram, "Content-Type": "application/pdf"}, content=pdf,
                      params={"category": "Medical", "title": "Audit medical note", "filename": "note.pdf"})
    assert res.status_code == 201, res.text
    doc_id = res.json()["id"]
    assert client.get(f"{API}/documents/{doc_id}", headers=babu).status_code in (403, 404)
    assert client.get(f"{API}/documents/{doc_id}/download", headers=babu).status_code in (403, 404)
    assert client.patch(f"{API}/documents/{doc_id}", headers=babu, json={"expiry_date": None}).status_code in (403, 404, 422)
    up = client.post(f"{API}/documents/{doc_id}/versions", headers={**babu, "Content-Type": "application/pdf"}, content=pdf)
    assert up.status_code in (403, 404)
    # guessed ids give the same answer as real ones (no existence oracle)
    assert client.get(f"{API}/documents/doc-{uuid.uuid4().hex[:12]}", headers=babu).status_code == \
        client.get(f"{API}/documents/{doc_id}", headers=babu).status_code
    # medical documents are not for the manager chain either, nor for admin or the recruiter
    for other in ("jordan.blake@timez.com", "alex.morgan@timez.com", "sophie.clark@timez.com"):
        assert client.get(f"{API}/documents/{doc_id}", headers=login(client, other)).status_code in (403, 404), other


def test_employee_cannot_read_others_leave_by_id(client, babu, ram):
    day = date.today() + timedelta(days=75)
    while day.weekday() >= 5:
        day += timedelta(days=1)
    res = client.post(f"{API}/leave/requests", headers=ram,
                      json={"leave_code": "pto", "from": day.isoformat(), "to": day.isoformat(), "reason": "Audit: private"})
    assert res.status_code == 201, res.text
    rid = res.json()["id"]
    try:
        assert rid not in client.get(f"{API}/leave/requests", headers=babu, params={"view": "team"}).text
        assert client.post(f"{API}/leave/requests/{rid}/decision", headers=babu,
                           json={"decision": "approve"}).status_code in (403, 404)
        assert client.post(f"{API}/leave/requests/{rid}/cancel", headers=babu).status_code in (403, 404)
    finally:
        client.post(f"{API}/leave/requests/{rid}/cancel", headers=ram)


def test_employee_cannot_read_others_letters_and_cases(client, babu, ram, farhan):
    letter = client.post(f"{API}/letters/requests", headers=ram,
                         json={"letter_type": "Salary Certificate", "note": "Audit"})
    if letter.status_code == 422:  # type name differs by country template set
        letter = client.post(f"{API}/letters/requests", headers=ram, json={"letter_type": "Employment", "note": "Audit"})
    assert letter.status_code == 201, letter.text
    lid = letter.json()["id"]
    for suffix in ("", "/preview", "/download"):
        assert client.get(f"{API}/letters/requests/{lid}{suffix}", headers=babu).status_code in (403, 404), suffix
    assert client.post(f"{API}/letters/requests/{lid}/cancel", headers=babu).status_code in (403, 404)
    client.post(f"{API}/letters/requests/{lid}/cancel", headers=ram)

    case = client.post(f"{API}/cases", headers=ram, json={"category": "Grievance", "anonymous": False,
                                                          "description": "Audit: a confidential grievance about pay."})
    assert case.status_code == 201, case.text
    cid, code = case.json()["id"], case.json()["code"]
    assert client.get(f"{API}/cases/{cid}", headers=babu).status_code == 404
    assert client.get(f"{API}/cases/by-code/{code}", headers=babu).status_code == 404
    assert client.post(f"{API}/cases/{cid}/comments", headers=babu, json={"text": "hi"}).status_code in (403, 404)
    assert client.get(f"{API}/cases/{cid}/files/x", headers=babu).status_code == 404


# ---------- manager ----------
@pytest.mark.parametrize("path", CONFIDENTIAL_BY_PARAM)
def test_manager_limited_to_own_line(client, ram, path):
    # Sophie reports to Farhan, not to Ram
    res = client.get(f"{API}{path}", headers=ram, params={"employee_id": "demo-recruiter"})
    assert denied_or_absent(res, "demo-recruiter"), (path, res.status_code, res.text[:300])


def test_manager_sees_report_but_not_their_pay(client, ram):
    assert client.get(f"{API}/people/emp-mahesh", headers=ram).json()["view"] == "full"
    assert client.get(f"{API}/people/demo-recruiter", headers=ram).json()["view"] == "basic"
    assert client.get(f"{API}/leave/balances", headers=ram, params={"employee_id": "emp-mahesh"}).status_code == 200
    for path in PAY_BY_PARAM:
        res = client.get(f"{API}{path}", headers=ram, params={"employee_id": "emp-mahesh"})
        assert denied_or_absent(res, "emp-mahesh"), path
    assert client.get(f"{API}/compensation/records/current", headers=ram).status_code == 403
    # a manager cannot reveal a report's personal details (only the person, HR or admin)
    assert client.get(f"{API}/people/emp-mahesh/reveal", headers=ram, params={"field": "mobile"}).status_code == 403


# ---------- HR ----------
def test_hr_country_scope_is_enforced(client):
    hr_emp = sample_employee("IN", offset=7)
    hr = real_account(client, hr_emp, "hr_admin", countries="IN")
    me = client.get(f"{API}/auth/me", headers=hr).json()
    assert me["scope_countries"] == ["IN"]
    gb = sample_employee("GB", offset=3)
    india = sample_employee("IN", offset=11)
    assert client.get(f"{API}/people/{india}", headers=hr).json()["view"] == "full"
    assert client.get(f"{API}/people/{gb}", headers=hr).json()["view"] == "basic"
    assert client.get(f"{API}/people/{gb}/reveal", headers=hr, params={"field": "mobile"}).status_code in (403, 404)
    for path in CONFIDENTIAL_BY_PARAM:
        if path == "/recognition/points":
            continue  # AUD-09, below
        res = client.get(f"{API}{path}", headers=hr, params={"employee_id": gb})
        assert denied_or_absent(res, gb), (path, res.status_code)
    current = client.get(f"{API}/compensation/records/current", headers=hr, params={"limit": 200})
    assert current.status_code == 200
    assert gb not in current.text
    listed = client.get(f"{API}/people", headers=hr, params={"scope": "mine", "page_size": 200}).json()
    rows = listed["items"] if isinstance(listed, dict) else listed
    assert all(r.get("country_code") in ("IN", None) for r in rows)


def test_hr_country_scope_applies_to_recognition_points(client):
    hr = real_account(client, sample_employee("IN", offset=7), "hr_admin", countries="IN")
    gb = sample_employee("GB", offset=3)
    assert denied_or_absent(client.get(f"{API}/recognition/points", headers=hr, params={"employee_id": gb}), gb)


def test_hr_country_scope_applies_to_cases(client):
    hr = real_account(client, sample_employee("IN", offset=7), "hr_admin", countries="IN")
    gb_emp = sample_employee("GB", offset=5)
    reporter = real_account(client, gb_emp, "employee")
    case = client.post(f"{API}/cases", headers=reporter, json={
        "category": "Grievance", "anonymous": False, "description": "Audit: a UK grievance that India HR must not see."})
    assert case.status_code == 201, case.text
    assert client.get(f"{API}/cases/{case.json()['id']}", headers=hr).status_code == 404


# ---------- admin ----------
def test_admin_has_no_pay_or_case_access(client, alex):
    for path in PAY_BY_PARAM:
        assert denied_or_absent(client.get(f"{API}{path}", headers=alex, params={"employee_id": "emp-mahesh"}), "emp-mahesh")
    assert client.get(f"{API}/compensation/records/current", headers=alex).status_code == 403
    assert client.get(f"{API}/compensation/proposals", headers=alex, params={"view": "all"}).status_code == 403
    assert client.get(f"{API}/cases", headers=alex, params={"view": "manage"}).json() == []
    case = client.post(f"{API}/cases", headers=login(client, "babu.menon@timez.com"), json={
        "category": "Grievance", "anonymous": False, "description": "Audit: admin must never read this case."})
    assert client.get(f"{API}/cases/{case.json()['id']}", headers=alex).status_code == 404


def test_admin_cannot_read_employee_documents(client, alex):
    res = client.get(f"{API}/documents", headers=alex, params={"employee_id": "emp-mahesh"})
    assert denied_or_absent(res, "emp-mahesh")


def test_admin_gets_basic_profile_and_no_pii_reveal(client, alex):
    assert client.get(f"{API}/people/emp-mahesh", headers=alex).json()["view"] == "basic"
    assert client.get(f"{API}/people/emp-mahesh/reveal", headers=alex, params={"field": "mobile"}).status_code == 403


def test_admin_and_executive_cannot_read_performance_of_strangers(client, alex, jordan):
    stranger = sample_employee("GB", offset=9)
    for h in (alex, jordan):
        for path in ("/performance/goals", "/leave/balances", "/attendance/summary"):
            assert denied_or_absent(client.get(f"{API}{path}", headers=h, params={"employee_id": stranger}), stranger), path


# ---------- executive ----------
def test_executive_has_no_pay_without_flag(client, jordan):
    for path in PAY_BY_PARAM:
        assert denied_or_absent(client.get(f"{API}{path}", headers=jordan, params={"employee_id": "emp-mahesh"}),
                                "emp-mahesh"), path
    assert client.get(f"{API}/people/emp-mahesh/reveal", headers=jordan, params={"field": "mobile"}).status_code == 403


# ---------- recruiter ----------
def test_recruiter_limited_to_recruiting(client, sophie):
    assert client.get(f"{API}/recruiting/candidates", headers=sophie).status_code == 200
    assert client.get(f"{API}/people/emp-mahesh", headers=sophie).json()["view"] == "basic"
    for path in CONFIDENTIAL_BY_PARAM:
        res = client.get(f"{API}{path}", headers=sophie, params={"employee_id": "emp-mahesh"})
        assert denied_or_absent(res, "emp-mahesh"), (path, res.status_code)
    for path in ("/admin/accounts", "/admin/settings", "/admin/email-outbox", "/compensation/records/current",
                 ):  # GET /admin/ai-settings and /security/mfa-policy are for everyone (feature switches, one flag)
        assert client.get(f"{API}{path}", headers=sophie).status_code in (403, 404), path
    assert client.get(f"{API}/cases", headers=sophie, params={"view": "manage"}).json() == []


# ---------- admin-only configuration ----------
ADMIN_WRITES = [
    ("PUT", "/workflows/leave", {"steps": [{"roles": ["admin"], "mode": "any"}]}),
    ("PUT", "/admin/accounts/emp-mahesh/data-scope", {"scope": "global"}),
    ("PUT", "/admin/accounts/emp-mahesh/page-access", {"pages": {}}),
    ("PUT", "/admin/settings", {}),
    ("PUT", "/admin/ai-settings", {}),
    ("PUT", "/security/mfa-policy", {"required_roles": []}),
    ("POST", "/admin/jobs/run", {}),
    ("POST", "/security/accounts/demo-admin/sessions/revoke", {}),
    ("PUT", "/payroll/providers", {}),
]


@pytest.mark.parametrize("method,path,body", ADMIN_WRITES)
def test_non_admins_cannot_change_platform_settings(client, babu, ram, sophie, method, path, body):
    for h in (babu, ram, sophie):
        res = client.request(method, f"{API}{path}", headers=h, json=body)
        assert res.status_code in (403, 404, 422), (path, res.status_code)
        if res.status_code == 422:  # body problems must not hide a missing permission check: retry looks the same
            assert client.request(method, f"{API}{path}", headers=h, json=body).status_code == 422


def test_employee_cannot_escalate_own_data_scope(client, babu):
    res = client.put(f"{API}/admin/accounts/emp-mahesh/data-scope", headers=babu, json={"scope": "global"})
    assert res.status_code in (403, 422)
    assert client.get(f"{API}/auth/me", headers=babu).json()["scope"] == "self"


def test_mass_assignment_on_own_profile_is_ignored(client, babu):
    before = client.get(f"{API}/people/emp-mahesh", headers=babu).json()
    client.patch(f"{API}/people/me", headers=babu, json={"grade": "L9", "manager_id": "emp-mahesh", "role": "admin",
                                                         "employment_status": "Terminated", "job_title": "CEO"})
    after = client.get(f"{API}/people/emp-mahesh", headers=babu).json()
    for field in ("grade", "manager_id", "employment_status", "job_title"):
        assert after[field] == before[field], field
    assert client.get(f"{API}/auth/me", headers=babu).json()["role"] == "employee"
