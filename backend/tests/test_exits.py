"""Exits: who can raise and decide, the approval chain, clearance, private exit interview, settlement, and the job
that closes an exit after the last working day. Uses sample employees (accounts made here) so the demo people stay."""

from datetime import date, timedelta

import pytest
from sqlalchemy import exists, select
from sqlalchemy.orm import aliased

from app.db import SessionLocal
from app.models import Account, AuditLog, Employee, ExitCase
from app.security import create_access_token
from app.services.exits import complete_due_exits
from app.services.leave import today_for
from app.services.jobs import run_all

API = "/api/v1/exits"
DEMO_ACCOUNTS = ("emp-mahesh", "emp-ram", "demo-hr-admin", "demo-recruiter", "demo-ceo", "demo-admin")


def token_for(account_id: str, role: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(account_id, role)[0]}"}


def account_for(employee_id: str, role: str = "employee") -> dict[str, str]:
    """A sign-in account for a sample employee (made once)."""
    with SessionLocal() as db:
        acc = db.scalar(select(Account).where(Account.employee_id == employee_id))
        if acc is None:
            acc = Account(id=f"t-exit-{employee_id}", email=f"exit.{employee_id.lower()}@timez.example", password_hash="x",
                          role=role, employee_id=employee_id, active=True)
            db.add(acc)
            db.commit()
        return token_for(acc.id, acc.role)


def token_of_employee(employee_id: str) -> dict[str, str]:
    with SessionLocal() as db:
        acc = db.scalar(select(Account).where(Account.employee_id == employee_id))
        assert acc is not None, employee_id
        return token_for(acc.id, acc.role)


@pytest.fixture(scope="module")
def people() -> list[tuple[str, str]]:
    """(employee, manager) pairs: active Indian sample employees with no reports whose manager is a sample employee."""
    report = aliased(Employee)
    manager = aliased(Employee)
    with SessionLocal() as db:
        rows = db.execute(
            select(Employee.id, Employee.manager_id).join(manager, manager.id == Employee.manager_id).where(
                Employee.source == "hcm_sample", Employee.country_code == "IN", Employee.employment_status == "Active",
                manager.source == "hcm_sample", ~exists().where(report.manager_id == Employee.id),
            ).order_by(Employee.id).offset(40).limit(60)
        ).all()
    seen, out = set(), []
    for emp_id, mgr_id in rows:
        if mgr_id not in seen:  # one person per manager, so team views stay simple
            seen.add(mgr_id)
            out.append((emp_id, mgr_id))
    assert len(out) >= 4
    return out


def today_of(employee_id: str) -> date:
    with SessionLocal() as db:
        return today_for(db.get(Employee, employee_id))


def resign(client, headers, last_day: date, early=False, **extra):
    return client.post(API, headers=headers, json={"requested_last_day": last_day.isoformat(), "reason": "Career growth",
                                                   "early_release": early, **extra})


def decide(client, headers, exit_id, decision="approve", **extra):
    return client.post(f"{API}/{exit_id}/decision", headers=headers, json={"decision": decision, **extra})


def test_notice_and_validation(client, babu, people):
    emp_id, _ = people[0]
    me = account_for(emp_id)
    notice = client.get(f"{API}/notice", headers=me).json()
    assert notice["notice_days"] == 60  # India country config
    today = today_of(emp_id)
    assert resign(client, me, today + timedelta(days=10)).status_code == 422  # inside notice, no early release
    assert resign(client, me, today - timedelta(days=1)).status_code == 422
    assert resign(client, me, today + timedelta(days=70), early=True).status_code == 422  # early release not needed
    assert client.post(API, headers=me, json={"exit_type": "termination", "requested_last_day": (today + timedelta(days=70)).isoformat(),
                                              "reason": "x"}).status_code == 422
    # Employees can't raise an exit for someone else; the scope check hides people they can't see.
    other = people[1][0]
    assert client.post(API, headers=babu, json={"employee_id": other, "requested_last_day": (today + timedelta(days=70)).isoformat(),
                                                "reason": "x"}).status_code == 404
    assert client.get(API, headers=babu, params={"scope": "all"}).status_code == 403


def test_resignation_flow_clearance_interview_settlement_and_job(client, babu, farhan, people):
    emp_id, mgr_id = people[0]
    me, mgr = account_for(emp_id), account_for(mgr_id, "manager")
    today = today_of(emp_id)
    res = resign(client, me, today + timedelta(days=75), note="Thanks for everything")
    assert res.status_code == 201, res.text
    case = res.json()
    assert case["status"] == "Submitted" and case["notice_days"] == 60 and case["can_withdraw"]
    assert [s["label"] for s in case["steps"]] == ["Manager", "HR"] and case["steps"][0]["approver_ids"] == [mgr_id]
    assert resign(client, me, today + timedelta(days=80)).status_code == 409  # one open exit at a time
    assert client.get(f"{API}/{case['id']}", headers=babu).status_code == 404
    assert decide(client, farhan, case["id"]).status_code == 403  # HR waits for the manager
    team = client.get(API, headers=mgr, params={"scope": "team"}).json()
    assert [c["id"] for c in team] == [case["id"]] and team[0]["can_decide"]

    res = decide(client, mgr, case["id"], note="All the best")
    assert res.status_code == 200 and res.json()["status"] == "Manager approved"
    assert client.post(f"{API}/{case['id']}/withdraw", headers=mgr).status_code == 403
    res = decide(client, farhan, case["id"])
    assert res.status_code == 200, res.text
    case = res.json()
    lwd = today + timedelta(days=75)
    assert case["status"] == "Approved" and case["approved_last_working_day"] == lwd.isoformat()
    assert client.post(f"{API}/{case['id']}/withdraw", headers=me).status_code == 409
    person = client.get(f"/api/v1/people/{emp_id}", headers=farhan).json()
    assert person["employment_status"] == "Notice period" and person["last_working_day"] == lwd.isoformat()
    assert [i["key"] for i in case["clearance"]] == ["assets_returned", "it_access", "finance_dues", "knowledge_transfer"]

    # Clearance: the leaver ticks nothing; the manager signs off knowledge transfer; HR any item.
    assert client.post(f"{API}/{case['id']}/clearance/assets_returned", headers=me, json={"done": True}).status_code == 403
    assert client.post(f"{API}/{case['id']}/clearance/finance_dues", headers=mgr, json={"done": True}).status_code == 403
    res = client.post(f"{API}/{case['id']}/clearance/knowledge_transfer", headers=mgr, json={"done": True})
    assert res.status_code == 200 and res.json()["clearance"][3]["done"]
    assert client.post(f"{API}/{case['id']}/clearance/finance_dues", headers=farhan, json={"done": True}).status_code == 200

    # Exit interview: the leaver sends it once; only HR reads it (never the manager).
    answers = {"rating": 4, "reasons": ["Limited growth"], "would_return": "Yes", "comments": "Good team"}
    assert client.post(f"{API}/{case['id']}/interview", headers=mgr, json=answers).status_code == 403
    res = client.post(f"{API}/{case['id']}/interview", headers=me, json=answers)
    assert res.status_code == 200 and res.json()["interview_submitted"] and res.json()["interview"] is None
    assert client.post(f"{API}/{case['id']}/interview", headers=me, json=answers).status_code == 409
    assert client.get(f"{API}/{case['id']}/interview", headers=mgr).status_code == 403
    assert client.get(f"{API}/{case['id']}", headers=mgr).json()["interview"] is None
    assert client.get(f"{API}/{case['id']}/interview", headers=farhan).json()["comments"] == "Good team"

    # Final settlement: the leaver and HR see it; HR moves it on one step at a time.
    settlement = client.get(f"{API}/{case['id']}/settlement", headers=me).json()
    assert settlement["status"] == "Pending" and settlement["unused_leave_days"] >= 0 and not settlement["frozen"]
    assert client.get(f"{API}/{case['id']}/settlement", headers=mgr).status_code == 403
    assert client.post(f"{API}/{case['id']}/settlement", headers=farhan, json={"status": "Paid"}).status_code == 422
    assert client.post(f"{API}/{case['id']}/settlement", headers=me, json={"status": "In progress"}).status_code == 403
    assert client.post(f"{API}/{case['id']}/settlement", headers=farhan, json={"status": "In progress"}).status_code == 200

    # Nothing happens before the last working day has passed.
    with SessionLocal() as db:
        assert complete_due_exits(db) == []
        row = db.get(ExitCase, case["id"])
        row.approved_last_working_day = today - timedelta(days=1)
        db.get(Employee, emp_id).last_working_day = today - timedelta(days=1)
        db.commit()
        out = run_all(db)
        db.commit()
        assert out["exits_completed"] == 1
        emp = db.get(Employee, emp_id)
        assert emp.employment_status == "Exited"
        assert db.scalar(select(Account.active).where(Account.employee_id == emp_id)) is False
        assert all(db.get(Account, a).active for a in DEMO_ACCOUNTS)  # only people who truly exited
        row = db.get(ExitCase, case["id"])
        assert row.status == "Completed" and "unused_leave_days" in row.settlement
        actions = set(db.scalars(select(AuditLog.action).where(AuditLog.entity_id.in_([case["id"], emp_id]))))
        assert {"exit_submitted", "exit_approved", "exit_completed", "exit_interview_submitted"} <= actions
    assert client.get(f"{API}/{case['id']}", headers=me).status_code == 401  # sign-in deactivated
    final = client.get(f"{API}/{case['id']}", headers=farhan).json()
    assert final["status"] == "Completed" and final["settlement"]["frozen"]
    assert client.post(f"{API}/{case['id']}/clearance/it_access", headers=farhan, json={"done": True}).status_code == 409
    with SessionLocal() as db:  # back in the directory for the other test modules (they count people)
        emp = db.get(Employee, emp_id)
        emp.employment_status, emp.last_working_day = "Active", None
        db.commit()


def test_early_release_declined_uses_standard_notice(client, farhan, people):
    emp_id, mgr_id = people[1]
    me, mgr = account_for(emp_id), account_for(mgr_id, "manager")
    today = today_of(emp_id)
    case = resign(client, me, today + timedelta(days=20), early=True).json()
    assert case["early_release"] and case["standard_last_day"] == (today + timedelta(days=60)).isoformat()
    assert decide(client, mgr, case["id"], approve_early_release=False).status_code == 200
    res = decide(client, farhan, case["id"])
    assert res.json()["approved_last_working_day"] == (today + timedelta(days=60)).isoformat()
    assert res.json()["early_release_approved"] is False


def test_rejection_needs_note(client, farhan, people):
    emp_id, mgr_id = people[2]
    me, mgr = account_for(emp_id), account_for(mgr_id, "manager")
    case = resign(client, me, today_of(emp_id) + timedelta(days=65)).json()
    assert decide(client, mgr, case["id"], "reject").status_code == 422
    res = decide(client, mgr, case["id"], "reject", note="Let's talk first")
    assert res.json()["status"] == "Rejected"
    with SessionLocal() as db:
        assert db.get(Employee, emp_id).employment_status == "Active"


def test_ceo_goes_to_hr_only_and_can_withdraw(client, farhan):
    jordan = token_for("demo-ceo", "executive")
    today = today_of("demo-ceo")
    res = resign(client, jordan, today + timedelta(days=90))
    assert res.status_code == 201, res.text
    case = res.json()
    assert [s["label"] for s in case["steps"]] == ["HR"]
    assert "demo-hr-admin" in case["steps"][0]["approver_ids"]
    res = client.post(f"{API}/{case['id']}/withdraw", headers=jordan)
    assert res.status_code == 200 and res.json()["status"] == "Withdrawn"
    assert decide(client, farhan, case["id"]).status_code == 409


def test_hr_termination_needs_second_approver_and_is_hidden_until_approved(client, farhan, babu, people):
    emp_id, mgr_id = people[3]
    leaver, mgr = account_for(emp_id), account_for(mgr_id, "manager")
    today = today_of(emp_id)
    assert client.post(API, headers=babu, json={"employee_id": "emp-ram", "exit_type": "termination",
                                                "requested_last_day": today.isoformat(), "reason": "x"}).status_code in (403, 404)
    res = client.post(API, headers=farhan, json={"employee_id": emp_id, "exit_type": "termination",
                                                 "requested_last_day": (today + timedelta(days=14)).isoformat(),
                                                 "reason": "Policy breach"})
    assert res.status_code == 201, res.text
    case = res.json()
    assert len(case["steps"]) == 1
    approvers = case["steps"][0]["approver_ids"]
    assert approvers and "demo-hr-admin" not in approvers and emp_id not in approvers
    assert decide(client, farhan, case["id"]).status_code == 403  # never your own request
    assert client.get(API, headers=leaver, params={"scope": "mine"}).json() == []
    assert client.get(f"{API}/{case['id']}", headers=mgr).status_code == 404
    res = decide(client, token_of_employee(approvers[0]), case["id"])
    assert res.status_code == 200 and res.json()["status"] == "Approved", res.text
    mine = client.get(API, headers=leaver, params={"scope": "mine"}).json()
    assert [c["id"] for c in mine] == [case["id"]] and mine[0]["exit_type"] == "termination"
    assert client.get(f"{API}/{case['id']}", headers=mgr).status_code == 200
