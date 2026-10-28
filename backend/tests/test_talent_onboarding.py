import pytest
from sqlalchemy import select

from app.db import SessionLocal
from app.models import Account, AuditLog, Employee, EmployeeAssignment
from tests.conftest import login
from tests.talent_helpers import hire, token_for

O = "/api/v1/onboarding"


@pytest.fixture(scope="module")
def sophie(client):
    return login(client, "sophie.clark@timez.com")


@pytest.fixture(scope="module")
def admin():
    return token_for("demo-admin", "admin")


def _joiner_login(employee_id: str) -> dict[str, str]:
    """Give the new employee a sign-in account (normally done by IT) and a token for it."""
    with SessionLocal() as db:
        acc_id = f"acc-{employee_id.lower()}"
        if db.get(Account, acc_id) is None:
            db.add(Account(id=acc_id, email=f"{employee_id.lower()}@timez.example", password_hash="x", role="employee",
                           employee_id=employee_id, active=True, failed_attempts=0))
            db.commit()
    return token_for(acc_id, "employee")


def _task(joiner: dict, key: str) -> dict:
    return next(t for t in joiner["tasks"] if t["key"] == key)


def _set(client, headers, task: dict, status: str, reason: str | None = None):
    return client.patch(f"{O}/tasks/{task['id']}", headers=headers, json={"status": status, "reason": reason})


def test_checklist_owners_dependencies_and_completion(client, babu, ram, farhan, sophie, admin):
    cand, joiner = hire(client, sophie, ram, farhan, "Leela Menon", "leela.menon@example.com")
    assert joiner["status"] == "pre_boarding" and joiner["policy_ack"] is False and joiner["employment_status"] == "Onboarding"
    keys = {t["key"]: t for t in joiner["tasks"]}
    assert set(keys) == {"hr_docs", "it_account", "laptop", "access", "manager_intro", "orientation", "policy_training",
                         "mandatory_learning", "team_intro", "first_week_review"}
    assert keys["it_account"]["depends_on"] == ["hr_docs"]
    # visibility: HR, the manager, recruiting, IT; not unrelated employees
    assert client.get(f"{O}/joiners/{joiner['id']}", headers=ram).status_code == 200
    assert client.get(f"{O}/joiners/{joiner['id']}", headers=babu).status_code == 404
    assert joiner["id"] not in {j["id"] for j in client.get(f"{O}/joiners", headers=babu).json()}
    me = _joiner_login(joiner["employee_id"])
    assert client.get(f"{O}/joiners/{joiner['id']}", headers=me).status_code == 200

    # owners
    assert _set(client, ram, keys["hr_docs"], "done").status_code == 403  # HR's task
    assert _set(client, me, keys["laptop"], "done").status_code == 403  # IT's task
    # dependencies
    res = _set(client, admin, keys["it_account"], "in_progress")
    assert res.status_code == 409 and "HR documentation" in res.json()["detail"]
    assert _set(client, farhan, keys["hr_docs"], "done").status_code == 200
    for key in ("laptop", "it_account", "access"):
        assert _set(client, admin, keys[key], "done").status_code == 200
    # HR updating someone else's task needs a reason, which is kept
    assert _set(client, farhan, keys["manager_intro"], "done").status_code == 422
    res = _set(client, farhan, keys["manager_intro"], "done", "Manager on leave; done by HR")
    assert res.status_code == 200 and _task(res.json(), "manager_intro")["override_note"] == "Manager on leave; done by HR"
    assert _set(client, farhan, keys["orientation"], "done").status_code == 200
    assert _set(client, ram, keys["team_intro"], "done").status_code == 200
    assert _set(client, ram, keys["first_week_review"], "done").status_code == 200
    assert _set(client, me, keys["mandatory_learning"], "done").status_code == 200
    res = _set(client, me, keys["policy_training"], "done")
    body = res.json()
    assert body["progress_pct"] == 100 and body["status"] == "day1_ready"  # starts in two weeks, policies still open
    assert body["employment_status"] == "Onboarding"

    # policy acknowledgment by the joiner completes onboarding -> employee Active
    assert client.post(f"{O}/joiners/{joiner['id']}/acknowledge", headers=ram).status_code == 403
    res = client.post(f"{O}/joiners/{joiner['id']}/acknowledge", headers=me)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["policy_ack"] is True and body["policy_ack_by_hr"] is False
    assert body["status"] == "completed" and body["employment_status"] == "Active"
    assert client.post(f"{O}/joiners/{joiner['id']}/acknowledge", headers=farhan).status_code == 409
    assert _set(client, admin, keys["laptop"], "pending").status_code == 409  # completed onboarding is frozen
    with SessionLocal() as db:
        emp = db.get(Employee, joiner["employee_id"])
        assert emp.employment_status == "Active"
        assignment = db.scalar(select(EmployeeAssignment).where(EmployeeAssignment.employee_id == emp.id))
        assert assignment.employment_status == "Active"
        actions = set(db.scalars(select(AuditLog.action).where(AuditLog.subject_id == emp.id)))
        assert {"employee_created", "joiner_created", "onboarding_task_updated", "onboarding_policies_acknowledged",
                "onboarding_completed"} <= actions
    assert any(n["title"] == "Onboarding complete: Leela Menon" for n in client.get("/api/v1/notifications", headers=ram).json())
    assert any(n["title"] == "New joiner: Leela Menon" for n in client.get("/api/v1/notifications", headers=farhan).json())


def test_hr_acknowledges_on_behalf(client, ram, farhan, sophie, admin):
    _, joiner = hire(client, sophie, ram, farhan, "Omar Siddiqui", "omar.siddiqui@example.com", start_in_days=21)
    res = client.post(f"{O}/joiners/{joiner['id']}/acknowledge", headers=farhan)
    assert res.status_code == 200 and res.json()["policy_ack_by_hr"] is True
    assert res.json()["status"] == "pre_boarding"  # tasks still open: not complete, not Active
    assert res.json()["employment_status"] == "Onboarding"
    with SessionLocal() as db:
        ids = sorted(int(e[2:]) for e in db.scalars(select(Employee.id).where(Employee.source == "recruiting")))
        assert len(ids) == len(set(ids)) and all(i > 500 for i in ids)
