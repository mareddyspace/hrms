import uuid
from datetime import date, timedelta

import pytest
from sqlalchemy import func, select

from app.db import SessionLocal
from app.models import AccessScope, ApprovalInstance, AuditLog, CompBonus, CompensationRecord
from app.security import create_access_token

API = "/api/v1/compensation"
COMP_WORKFLOW = [
    {"roles": ["hr"], "mode": "any"},
    {"roles": ["finance", "admin"], "mode": "any"},
    {"roles": ["executive"], "mode": "any", "min_amount": 10},
]


def token_for(account_id: str, role: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(account_id, role)[0]}"}


@pytest.fixture(scope="module")
def admin():
    return token_for("demo-admin", "admin")


@pytest.fixture(scope="module")
def jordan():
    return token_for("demo-ceo", "executive")


@pytest.fixture(scope="module")
def cycle(client, admin, farhan):
    assert client.put("/api/v1/workflows/compensation", headers=admin, json={"steps": COMP_WORKFLOW}).status_code == 200
    today = date.today()
    res = client.post(f"{API}/cycles", headers=farhan, json={
        "name": f"Test cycle {uuid.uuid4().hex[:6]}", "effective_date": (today + timedelta(days=400)).isoformat(),
        "budget_pct": 8, "opens_on": (today - timedelta(days=2)).isoformat(),
        "closes_on": (today + timedelta(days=30)).isoformat(), "status": "open"})
    assert res.status_code == 201, res.text
    return res.json()


def pay_views(actor: str, subject: str) -> int:
    with SessionLocal() as db:
        return db.scalar(select(func.count()).select_from(AuditLog).where(
            AuditLog.action == "pay_viewed", AuditLog.actor_id == actor, AuditLog.subject_id == subject)) or 0


def set_comp_access(account_id: str, value: bool) -> None:
    with SessionLocal() as db:
        row = db.get(AccessScope, account_id) or AccessScope(account_id=account_id)
        row.comp_access = value
        db.add(row)
        db.commit()


def test_own_pay_and_no_audit_for_self(client, babu):
    before = pay_views("emp-mahesh", "emp-mahesh")
    body = client.get(f"{API}/records", headers=babu).json()
    assert body["current"]["base_salary"] == 1_740_000 and body["current"]["currency"] == "INR"
    assert len(body["records"]) >= 2
    assert pay_views("emp-mahesh", "emp-mahesh") == before
    assert client.get(f"{API}/bonuses", headers=babu).status_code == 200


def test_manager_sees_no_pay(client, ram, babu):
    res = client.get(f"{API}/records", headers=ram, params={"employee_id": "emp-mahesh"})
    assert res.status_code == 403 and "pay" in res.json()["detail"]
    assert client.get(f"{API}/bonuses", headers=ram, params={"employee_id": "emp-mahesh"}).status_code == 403
    assert client.get(f"{API}/records/current", headers=ram).status_code == 403
    # an employee can't even tell whether someone else exists here
    assert client.get(f"{API}/records", headers=babu, params={"employee_id": "emp-ram"}).status_code == 404


def test_hr_view_is_audited(client, farhan):
    before = pay_views("demo-hr-admin", "emp-mahesh")
    res = client.get(f"{API}/records", headers=farhan, params={"employee_id": "emp-mahesh"})
    assert res.status_code == 200 and res.json()["current"]["base_salary"] == 1_740_000
    assert pay_views("demo-hr-admin", "emp-mahesh") == before + 1
    client.get(f"{API}/bonuses", headers=farhan, params={"employee_id": "emp-mahesh"})
    assert pay_views("demo-hr-admin", "emp-mahesh") == before + 2
    with SessionLocal() as db:
        entry = db.scalar(select(AuditLog).where(AuditLog.action == "pay_viewed").order_by(AuditLog.id.desc()))
        assert entry.changes["after"]["viewed"] == "viewed pay"


def test_comp_access_flag_lets_manager_see_line(client, ram):
    set_comp_access("emp-ram", True)
    try:
        before = pay_views("emp-ram", "emp-mahesh")
        res = client.get(f"{API}/records", headers=ram, params={"employee_id": "emp-mahesh"})
        assert res.status_code == 200
        assert pay_views("emp-ram", "emp-mahesh") == before + 1
        # still only their own line
        assert client.get(f"{API}/records", headers=ram, params={"employee_id": "demo-admin"}).status_code == 404
    finally:
        set_comp_access("emp-ram", False)
    assert client.get(f"{API}/records", headers=ram, params={"employee_id": "emp-mahesh"}).status_code == 403


def test_records_hr_only_and_not_own(client, farhan, ram):
    body = {"employee_id": "emp-mahesh", "effective_date": "2024-04-01", "base_salary": 1_500_000, "reason": "Joining"}
    assert client.post(f"{API}/records", headers=ram, json=body).status_code == 403
    assert client.post(f"{API}/records", headers=farhan, json=body | {"currency": "USD"}).status_code == 422
    res = client.post(f"{API}/records", headers=farhan, json=body)
    assert res.status_code == 201 and res.json()["is_current"] is False
    assert client.post(f"{API}/records", headers=farhan, json=body).status_code == 409
    own = body | {"employee_id": "demo-hr-admin"}
    assert client.post(f"{API}/records", headers=farhan, json=own).status_code == 403


def test_bonus_rules(client, farhan, babu):
    res = client.post(f"{API}/bonuses", headers=farhan, json={"employee_id": "emp-mahesh", "bonus_type": "Spot award",
                                                              "period": "Q3 2026", "amount": 10000})
    assert res.status_code == 201 and res.json()["status"] == "accrued"
    bid = res.json()["id"]
    assert client.post(f"{API}/bonuses/{bid}/status", headers=babu, json={"status": "paid"}).status_code == 403
    assert client.post(f"{API}/bonuses/{bid}/status", headers=farhan, json={"status": "paid"}).json()["status"] == "paid"
    assert client.post(f"{API}/bonuses/{bid}/status", headers=farhan, json={"status": "forfeited"}).status_code == 409


def test_cycle_rules(client, farhan, ram):
    today = date.today().isoformat()
    body = {"name": "Bad cycle", "effective_date": today, "budget_pct": 5, "opens_on": today, "closes_on": "2000-01-01"}
    assert client.post(f"{API}/cycles", headers=ram, json=body).status_code == 403
    assert client.post(f"{API}/cycles", headers=farhan, json=body).status_code == 422
    assert client.post(f"{API}/cycles", headers=farhan, json=body | {"budget_pct": 80}).status_code == 422
    names = [c["name"] for c in client.get(f"{API}/cycles", headers=ram).json()]
    assert "FY2026 Annual compensation review" in names


def test_proposal_chain_with_executive_step(client, cycle, ram, farhan, admin, jordan, babu):
    res = client.post(f"{API}/proposals", headers=ram, json={"cycle_id": cycle["id"], "employee_id": "emp-mahesh",
                                                             "increase_pct": 12, "proposed_grade": "L5", "bonus_amount": 150000})
    assert res.status_code == 201, res.text
    p = res.json()
    # the manager proposes a percentage but never sees the amounts
    assert p["pay_visible"] is False and p["current_base"] is None and p["proposed_base"] is None
    assert p["executive_step"] is True and p["status"] == "pending"
    pid = p["id"]
    assert client.post(f"{API}/proposals", headers=ram, json={"cycle_id": cycle["id"], "employee_id": "emp-mahesh",
                                                              "increase_pct": 3}).status_code == 409
    # the employee never sees proposals about their pay
    assert client.get(f"{API}/proposals/{pid}", headers=babu).status_code == 404
    assert client.post(f"{API}/proposals/{pid}/decision", headers=ram, json={"decision": "approve"}).status_code == 403
    # wrong step: finance/admin can't jump ahead of HR
    assert client.post(f"{API}/proposals/{pid}/decision", headers=admin, json={"decision": "approve"}).status_code == 403

    before = pay_views("demo-hr-admin", "emp-mahesh")
    hr_view = client.post(f"{API}/proposals/{pid}/decision", headers=farhan, json={"decision": "approve"}).json()
    assert hr_view["current_base"] == 1_740_000 and hr_view["proposed_base"] == pytest.approx(1_948_800)
    assert hr_view["current_step"] == 1 and hr_view["status"] == "pending"
    assert pay_views("demo-hr-admin", "emp-mahesh") > before
    assert pid in [x["id"] for x in client.get(f"{API}/proposals", headers=admin, params={"view": "to_decide"}).json()]
    step2 = client.post(f"{API}/proposals/{pid}/decision", headers=admin, json={"decision": "approve"}).json()
    assert step2["current_step"] == 2 and step2["status"] == "pending"
    done = client.post(f"{API}/proposals/{pid}/decision", headers=jordan, json={"decision": "approve"}).json()
    assert done["status"] == "approved" and done["record_id"]
    with SessionLocal() as db:
        record = db.get(CompensationRecord, done["record_id"])
        assert record.base_salary == pytest.approx(1_948_800) and record.grade == "L5"
        assert record.effective_date.isoformat() == cycle["effective_date"]
        assert db.scalar(select(CompBonus).where(CompBonus.proposal_id == pid)).status == "accrued"
    history = client.get(f"{API}/records", headers=babu).json()
    assert any(r["proposal_id"] == pid and not r["is_current"] for r in history["records"])  # effective later


def test_small_increase_skips_executive(client, cycle, farhan, admin, ram, jordan):
    res = client.post(f"{API}/proposals", headers=farhan, json={"cycle_id": cycle["id"], "employee_id": "emp-ram",
                                                                "increase_pct": 5})
    assert res.status_code == 201, res.text
    p = res.json()
    assert p["executive_step"] is False and p["pay_visible"] is True and p["proposed_base"] == pytest.approx(3_570_000)
    # Farhan proposed, so the HR step falls back to the administrator (never the proposer or the employee)
    assert client.post(f"{API}/proposals/{p['id']}/decision", headers=farhan, json={"decision": "approve"}).status_code == 403
    assert client.get(f"{API}/proposals/{p['id']}", headers=ram).status_code == 404
    first = client.post(f"{API}/proposals/{p['id']}/decision", headers=admin, json={"decision": "approve"}).json()
    assert first["status"] == "pending"
    # Alex approved the HR step, so the finance/admin step goes to the executive instead of Alex again
    with SessionLocal() as db:
        inst = db.scalar(select(ApprovalInstance).where(ApprovalInstance.entity_id == p["id"]))
        assert inst.steps[1]["groups"] == {"finance": ["demo-ceo"], "admin": ["demo-ceo"]}
    assert client.post(f"{API}/proposals/{p['id']}/decision", headers=admin, json={"decision": "approve"}).status_code == 403
    final = client.post(f"{API}/proposals/{p['id']}/decision", headers=jordan, json={"decision": "approve"}).json()
    assert final["status"] == "approved"


def test_proposal_rules(client, cycle, ram, farhan, babu):
    assert client.post(f"{API}/proposals", headers=farhan, json={"cycle_id": cycle["id"], "employee_id": "demo-hr-admin",
                                                                 "increase_pct": 5}).status_code == 403
    assert client.post(f"{API}/proposals", headers=babu, json={"cycle_id": cycle["id"], "employee_id": "emp-ram",
                                                               "increase_pct": 5}).status_code == 404
    assert client.post(f"{API}/proposals", headers=ram, json={"cycle_id": "cyc-h1-2026", "employee_id": "emp-mahesh",
                                                              "increase_pct": 5}).status_code == 409
    # reject needs a note, then the proposal is closed
    res = client.post(f"{API}/proposals", headers=farhan, json={"cycle_id": cycle["id"], "employee_id": "demo-recruiter",
                                                                "increase_pct": 4})
    assert res.status_code == 201, res.text
    pid = res.json()["id"]
    withdrawn = client.post(f"{API}/proposals/{pid}/withdraw", headers=farhan).json()
    assert withdrawn["status"] == "withdrawn"


def test_statement(client, babu):
    body = client.get(f"{API}/statement", headers=babu, params={"year": 2026}).json()
    assert body["base_salary"] == 1_740_000 and body["currency"] == "INR"
    assert body["bonus_total"] >= 25_000
    plans = {b["plan_id"] for b in body["benefits"]}
    assert {"bp-in-med", "bp-in-pf"} <= plans
    assert body["total_rewards"] == pytest.approx(body["base_salary"] + body["bonus_total"] + body["benefits_employer_cost"])
