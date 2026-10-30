"""Cash advances, leave encashment and software licences (app/services/self_service.py), plus the resignation
extras (handover plan, retention conversation). Uses sample employees (accounts made here) so the demo people stay."""

from datetime import date, timedelta

import pytest
from sqlalchemy import exists, select
from sqlalchemy.orm import aliased

from app.db import SessionLocal
from app.models import Account, Employee
from app.security import create_access_token
from app.services.leave import today_for

CASH = "/api/v1/cash-advances"
ENC = "/api/v1/encashments"
SW = "/api/v1/software"


def token_for(account_id: str, role: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(account_id, role)[0]}"}


def account_for(employee_id: str, role: str = "employee") -> dict[str, str]:
    with SessionLocal() as db:
        acc = db.scalar(select(Account).where(Account.employee_id == employee_id))
        if acc is None:
            acc = Account(id=f"t-ss-{employee_id}", email=f"ss.{employee_id.lower()}@timez.example", password_hash="x",
                          role=role, employee_id=employee_id, active=True)
            db.add(acc)
            db.commit()
        return token_for(acc.id, acc.role)


@pytest.fixture(scope="module")
def people() -> list[tuple[str, str]]:
    """(employee, manager) pairs of active Indian sample employees with no reports (different from test_exits)."""
    report = aliased(Employee)
    manager = aliased(Employee)
    with SessionLocal() as db:
        rows = db.execute(
            select(Employee.id, Employee.manager_id).join(manager, manager.id == Employee.manager_id).where(
                Employee.source == "hcm_sample", Employee.country_code == "IN", Employee.employment_status == "Active",
                manager.source == "hcm_sample", ~exists().where(report.manager_id == Employee.id),
            ).order_by(Employee.id).offset(100).limit(120)
        ).all()
    seen, out = set(), []
    for emp_id, mgr_id in rows:
        if mgr_id not in seen:
            seen.add(mgr_id)
            out.append((emp_id, mgr_id))
    assert len(out) >= 5
    return out


@pytest.fixture(scope="module")
def alex():
    return token_for("demo-admin", "admin")


def today_of(employee_id: str) -> date:
    with SessionLocal() as db:
        return today_for(db.get(Employee, employee_id))


def decide(client, url, headers, decision="approve", note=None):
    return client.post(f"{url}/decision", headers=headers, json={"decision": decision, "note": note})


def test_cash_advance_limit_flow_and_schedule(client, farhan, people):
    emp_id, mgr_id = people[0]
    me, mgr = account_for(emp_id), account_for(mgr_id, "manager")
    policy = client.get(f"{CASH}/policy", headers=me).json()
    assert policy["limit"] == 38000 and policy["currency"] == "INR" and policy["open_id"] is None
    needed = (today_of(emp_id) + timedelta(days=7)).isoformat()
    body = {"amount": 30000, "category": "Medical", "purpose": "Hospital bill", "needed_by": needed, "instalments": 3}
    assert client.post(CASH, headers=me, json=body | {"amount": 50000}).status_code == 422  # over one month's basic
    assert client.post(CASH, headers=me, json=body | {"instalments": 9}).status_code == 422
    assert client.post(CASH, headers=me, json=body | {"category": "Holiday"}).status_code == 422
    res = client.post(CASH, headers=me, json=body)
    assert res.status_code == 201, res.text
    row = res.json()
    assert row["status"] == "Submitted" and row["can_withdraw"]
    assert [s["label"] for s in row["steps"]] == ["Manager", "Finance / HR"] and row["steps"][0]["approver_ids"] == [mgr_id]
    assert client.post(CASH, headers=me, json=body | {"amount": 1000}).status_code == 409  # one open advance at a time

    pending = client.get("/api/v1/approvals/pending", headers=mgr).json()
    assert any("Cash advance of 30,000 INR" in p["summary"] for p in pending)
    url = f"{CASH}/{row['id']}"
    assert decide(client, url, farhan).status_code == 403  # HR waits for the manager
    team = client.get(CASH, headers=mgr, params={"scope": "team"}).json()
    assert [r["id"] for r in team] == [row["id"]] and team[0]["can_decide"]
    assert decide(client, url, mgr).json()["status"] == "Manager approved"
    res = decide(client, url, farhan)
    assert res.status_code == 200 and res.json()["status"] == "Approved" and res.json()["can_pay"]
    assert client.post(f"{url}/pay", headers=me, json={}).status_code == 403
    res = client.post(f"{url}/pay", headers=farhan, json={"reference": "NEFT-1"})
    assert res.status_code == 200, res.text
    paid = res.json()
    assert paid["status"] == "Paid" and paid["reference"] == "NEFT-1"
    assert len(paid["schedule"]) == 3 and sum(i["amount"] for i in paid["schedule"]) == 30000
    assert paid["outstanding"] == 30000 and not any(i["recovered"] for i in paid["schedule"])
    assert client.get(f"{CASH}/policy", headers=me).json()["open_id"] == row["id"]  # still being repaid
    assert client.post(f"{url}/pay", headers=farhan, json={}).status_code == 409
    assert client.get(CASH, headers=me, params={"scope": "all"}).status_code == 403
    assert any(r["id"] == row["id"] for r in client.get(CASH, headers=farhan, params={"scope": "all"}).json())


def test_cash_advance_withdraw_and_reject(client, people):
    emp_id, mgr_id = people[1]
    me, mgr = account_for(emp_id), account_for(mgr_id, "manager")
    needed = (today_of(emp_id) + timedelta(days=3)).isoformat()
    body = {"amount": 5000, "category": "Travel", "purpose": "", "needed_by": needed, "instalments": 1}
    first = client.post(CASH, headers=me, json=body).json()
    assert client.post(f"{CASH}/{first['id']}/withdraw", headers=mgr).status_code == 403
    assert client.post(f"{CASH}/{first['id']}/withdraw", headers=me).json()["status"] == "Withdrawn"
    second = client.post(CASH, headers=me, json=body).json()
    assert decide(client, f"{CASH}/{second['id']}", mgr, "reject").status_code == 422  # needs a note
    assert decide(client, f"{CASH}/{second['id']}", mgr, "reject", "Use a travel advance").json()["status"] == "Rejected"


def test_encashment_rules_balance_and_approval(client, farhan, people):
    emp_id, mgr_id = people[2]
    me, mgr = account_for(emp_id), account_for(mgr_id, "manager")
    policy = client.get(f"{ENC}/policy", headers=me).json()
    assert policy["per_day"] == round(38000 / 22, 2) and policy["max_days_a_year"] == 10 and policy["keep_days"] == 5
    pto = next(t for t in policy["types"] if t["code"] == "pto")
    others = [t for t in policy["types"] if t["code"] != "pto"]
    assert all(not t["eligible"] for t in others)
    assert pto["encashable"] == max(0, min(10, int((pto["available"] - 5) * 2) / 2))
    assert pto["eligible"], pto  # sample employees have more than 5 days left in October
    assert client.post(ENC, headers=me, json={"leave_code": "pto", "days": pto["encashable"] + 1}).status_code == 422
    assert client.post(ENC, headers=me, json={"leave_code": "pto", "days": 0.3}).status_code == 422
    if others:
        assert client.post(ENC, headers=me, json={"leave_code": others[0]["code"], "days": 1}).status_code == 422
    before = next(b for b in client.get("/api/v1/leave/balances", headers=me).json()["balances"] if b["code"] == "pto")
    res = client.post(ENC, headers=me, json={"leave_code": "pto", "days": 1})
    assert res.status_code == 201, res.text
    row = res.json()
    assert row["amount"] == policy["per_day"] and [s["label"] for s in row["steps"]] == ["Manager", "HR"]
    after = next(b for b in client.get("/api/v1/leave/balances", headers=me).json()["balances"] if b["code"] == "pto")
    assert after["pending"] == before["pending"] + 1 and after["available"] == before["available"] - 1
    assert client.post(ENC, headers=me, json={"leave_code": "pto", "days": 1}).status_code == 409  # one waiting at a time
    url = f"{ENC}/{row['id']}"
    assert decide(client, url, mgr).json()["status"] == "Manager approved"
    res = decide(client, url, farhan)
    assert res.status_code == 200 and res.json()["status"] == "Approved" and res.json()["payout_month"]
    final = next(b for b in client.get("/api/v1/leave/balances", headers=me).json()["balances"] if b["code"] == "pto")
    assert final["used"] == before["used"] + 1 and final["pending"] == before["pending"]


def test_software_catalogue_auto_approval_chain_return_and_revoke(client, alex, people):
    emp_id, mgr_id = people[3]
    me, mgr = account_for(emp_id), account_for(mgr_id, "manager")
    titles = {t["id"]: t for t in client.get(f"{SW}/catalogue", headers=me).json()}
    assert not titles["sw-slack"]["needs_approval"] and titles["sw-figma"]["needs_approval"]

    res = client.post(f"{SW}/requests", headers=me, json={"title_id": "sw-slack", "reason": "Team chat"})
    assert res.status_code == 201, res.text
    slack = res.json()
    assert slack["status"] == "Active" and slack["licence_key"] and slack["can_return"] and not slack["steps"]
    assert client.post(f"{SW}/requests", headers=me, json={"title_id": "sw-slack", "reason": "again"}).status_code == 409
    assert client.post(f"{SW}/requests", headers=me, json={"title_id": "sw-figma", "reason": ""}).status_code == 422

    res = client.post(f"{SW}/requests", headers=me, json={"title_id": "sw-figma", "reason": "UI mock-ups", "duration_months": 3})
    figma = res.json()
    assert figma["status"] == "Submitted" and [s["label"] for s in figma["steps"]] == ["Manager", "IT"]
    url = f"{SW}/requests/{figma['id']}"
    assert decide(client, url, alex).status_code == 403  # IT waits for the manager
    assert decide(client, url, mgr).json()["status"] == "Manager approved"
    res = decide(client, url, alex)
    assert res.status_code == 200 and res.json()["status"] == "Active", res.text
    assert res.json()["expires_on"] == None or res.json()["expires_on"] > today_of(emp_id).isoformat()  # noqa: E711
    used = {t["id"]: t["seats_used"] for t in client.get(f"{SW}/catalogue", headers=me).json()}
    assert used["sw-figma"] >= 1

    assert client.post(f"{url}/return", headers=mgr).status_code == 403
    assert client.post(f"{url}/return", headers=me).json()["status"] == "Returned"
    assert client.post(f"{SW}/requests/{slack['id']}/revoke", headers=me).status_code == 403
    res = client.post(f"{SW}/requests/{slack['id']}/revoke", headers=alex)
    assert res.status_code == 200 and res.json()["status"] == "Revoked"

    # IT assigns directly; seat limits apply; only IT edits the catalogue and sees everyone.
    res = client.post(f"{SW}/requests", headers=alex, json={"title_id": "sw-tableau", "employee_id": emp_id})
    assert res.status_code == 201 and res.json()["status"] == "Active" and res.json()["direct"], res.text
    assert client.post(f"{SW}/requests", headers=me, json={"title_id": "sw-jira", "employee_id": mgr_id,
                                                           "reason": "x"}).status_code == 403
    assert client.patch(f"{SW}/catalogue/sw-notion", headers=me, json={"seats": 1}).status_code == 403
    assert client.post(f"{SW}/requests", headers=alex, json={"title_id": "sw-notion", "employee_id": mgr_id}).status_code == 201
    taken = next(t for t in client.get(f"{SW}/catalogue", headers=alex).json() if t["id"] == "sw-notion")["seats_used"]
    assert client.patch(f"{SW}/catalogue/sw-notion", headers=alex, json={"seats": taken}).json()["seats"] == taken
    res = client.post(f"{SW}/requests", headers=me, json={"title_id": "sw-notion", "reason": "Notes"})
    assert res.status_code == 422 and "seats" in res.text
    client.patch(f"{SW}/catalogue/sw-notion", headers=alex, json={"seats": 150})
    assert client.get(f"{SW}/requests", headers=me, params={"scope": "all"}).status_code == 403
    mine = client.get(f"{SW}/requests", headers=me).json()
    assert {r["status"] for r in mine} >= {"Active", "Returned", "Revoked"}
    assert any(r["employee_id"] == emp_id for r in client.get(f"{SW}/requests", headers=alex, params={"scope": "all"}).json())


def test_resignation_handover_and_retention(client, people):
    emp_id, mgr_id = people[4]
    me, mgr = account_for(emp_id), account_for(mgr_id, "manager")
    last = (today_of(emp_id) + timedelta(days=70)).isoformat()
    res = client.post("/api/v1/exits", headers=me, json={
        "requested_last_day": last, "reason": "Career growth", "note": "New role", "handover_plan": "Docs and two sessions",
        "handover_to": "A colleague"})
    assert res.status_code == 201, res.text
    case = res.json()
    assert case["handover_plan"] == "Docs and two sessions" and case["handover_to"] == "A colleague"
    assert not case["can_add_retention"]
    url = f"/api/v1/exits/{case['id']}"
    assert client.post(f"{url}/retention", headers=me, json={"note": "x"}).status_code == 403
    assert client.get(url, headers=mgr).json()["can_add_retention"]
    res = client.post(f"{url}/retention", headers=mgr, json={"note": "Can we talk about a new project?",
                                                             "meet_on": (today_of(emp_id) + timedelta(days=2)).isoformat()})
    assert res.status_code == 200, res.text
    assert [r["by_id"] for r in res.json()["retention"]] == [mgr_id]
    assert client.get(url, headers=me).json()["retention"][0]["note"].startswith("Can we talk")
    assert client.post(f"{url}/withdraw", headers=me).json()["status"] == "Withdrawn"
    assert client.post(f"{url}/retention", headers=mgr, json={"note": "Late"}).status_code == 409


def test_cash_advance_for_manager_and_ceo_routes_up_never_to_self(client, ram):
    """A manager's advance goes to their own manager (Ram -> Jordan); the CEO's goes to finance / HR only."""
    jordan = token_for("demo-ceo", "executive")
    needed = (today_of("emp-ram") + timedelta(days=5)).isoformat()
    body = {"amount": 10000, "category": "Medical", "purpose": "", "needed_by": needed, "instalments": 2}
    res = client.post(CASH, headers=ram, json=body)
    assert res.status_code == 201, res.text
    row = res.json()
    assert [s["label"] for s in row["steps"]] == ["Manager", "Finance / HR"]
    assert row["steps"][0]["approver_ids"] == ["demo-ceo"] and "emp-ram" not in row["steps"][1]["approver_ids"]
    assert any(p["summary"].startswith("Cash advance of 10,000") for p in client.get("/api/v1/approvals/pending", headers=jordan).json())
    assert not any("Cash advance" in p["summary"] for p in client.get("/api/v1/approvals/pending", headers=ram).json())
    assert client.post(f"{CASH}/{row['id']}/withdraw", headers=ram).json()["status"] == "Withdrawn"

    res = client.post(CASH, headers=jordan, json=body | {"amount": 500})
    assert res.status_code == 201, res.text
    ceo = res.json()
    assert [s["label"] for s in ceo["steps"]] == ["Finance / HR"] and "demo-ceo" not in ceo["steps"][0]["approver_ids"]
    assert client.post(f"{CASH}/{ceo['id']}/withdraw", headers=jordan).json()["status"] == "Withdrawn"
