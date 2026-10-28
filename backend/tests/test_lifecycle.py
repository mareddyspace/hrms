from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import exists, func, select
from sqlalchemy.orm import aliased

from app.db import SessionLocal
from app.main import app
from app.models import AuditLog, Employee, EmployeeAssignment, LifecycleAction
from app.security import create_access_token
from app.services.lifecycle import apply_due_lifecycle_actions, run_due_at_startup
from tests.conftest import login

API = "/api/v1/lifecycle/actions"
DEFAULT_LIFECYCLE = [{"roles": ["manager"], "mode": "any"}, {"roles": ["hr"], "mode": "any"}]


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
def leaves() -> list[str]:
    """Indian sample employees with nobody reporting to them (safe to change)."""
    report = aliased(Employee)
    with SessionLocal() as db:
        return list(db.scalars(
            select(Employee.id).where(
                Employee.source == "hcm_sample", Employee.country_code == "IN", Employee.employment_status == "Active",
                Employee.manager_id.is_not(None), ~exists().where(report.manager_id == Employee.id),
            ).order_by(Employee.id).limit(12)
        ))


@pytest.fixture(scope="module", autouse=True)
def default_workflow(client, admin):
    assert client.put("/api/v1/workflows/lifecycle", headers=admin, json={"steps": DEFAULT_LIFECYCLE}).status_code == 200
    yield
    client.put("/api/v1/workflows/lifecycle", headers=admin, json={"steps": DEFAULT_LIFECYCLE})


def raise_action(client, headers, employee_id, action_type, after, effective=None, reason="Business need"):
    effective = effective or today_ist()
    return client.post(API, headers=headers, json={"employee_id": employee_id, "action_type": action_type,
                                                   "effective_date": effective.isoformat(), "after": after, "reason": reason})


def approve_all(client, aid, *approvers):
    res = None
    for who in approvers:
        res = client.post(f"{API}/{aid}/decision", headers=who, json={"decision": "approve"})
        assert res.status_code == 200, res.text
    return res.json()


def test_who_can_raise(client, babu, ram, leaves):
    sophie = token_for("demo-recruiter", "recruiter")
    assert raise_action(client, babu, "emp-ram", "promotion", {"grade": "G9"}).status_code == 404  # not in Babu's scope
    assert raise_action(client, babu, "emp-mahesh", "promotion", {"grade": "G9"}).status_code == 403  # not self-service
    assert raise_action(client, sophie, "emp-mahesh", "promotion", {"grade": "G9"}).status_code == 404
    assert raise_action(client, ram, leaves[0], "promotion", {"grade": "G9"}).status_code == 404  # not Ram's team
    res = client.post(API, headers=babu, json={"employee_id": "emp-mahesh", "action_type": "demotion",
                                               "effective_date": today_ist().isoformat(), "after": {}, "reason": "x"})
    assert res.status_code == 422


def test_validation(client, farhan, ram, leaves):
    who = leaves[0]
    assert raise_action(client, farhan, who, "promotion", {"salary": 1}).status_code == 422  # not allowed key
    assert raise_action(client, farhan, who, "promotion", {"job_title": "Lead"}).status_code == 422  # grade required
    with SessionLocal() as db:
        emp = db.get(Employee, who)
        grade, location = emp.grade, emp.location
    assert raise_action(client, farhan, who, "promotion", {"grade": grade}).status_code == 422  # nothing changes
    assert raise_action(client, farhan, who, "return_from_leave", {}).status_code == 422  # not on leave
    assert raise_action(client, farhan, who, "rehire", {}).status_code == 422  # hasn't left
    assert raise_action(client, farhan, who, "manager_change", {"manager_id": "nobody"}).status_code == 422
    assert raise_action(client, farhan, who, "manager_change", {"manager_id": who}).status_code == 422  # loop
    assert raise_action(client, ram, "emp-ram", "manager_change", {"manager_id": "emp-mahesh"}).status_code == 403
    assert raise_action(client, farhan, "emp-ram", "manager_change", {"manager_id": "emp-mahesh"}).status_code == 422  # loop
    assert raise_action(client, farhan, who, "location_change", {"location": location, "country_code": "ZZ"}).status_code == 422
    assert raise_action(client, farhan, who, "contract_extension", {"contract_end_date": "soon"}).status_code == 422
    past = (today_ist() - timedelta(days=1)).isoformat()
    assert raise_action(client, farhan, who, "contract_extension", {"contract_end_date": past}).status_code == 422
    assert raise_action(client, farhan, who, "contract_extension",
                        {"contract_end_date": "2027-12-31", "employment_type": "Gig"}).status_code == 422


def test_promotion_applies_now_with_history(client, farhan, jordan, admin, babu, leaves):
    who = leaves[1]
    with SessionLocal() as db:
        emp = db.get(Employee, who)
        old_grade, old_title, joined = emp.grade, emp.job_title, emp.joining_date
    res = raise_action(client, farhan, who, "promotion", {"grade": "G9", "job_title": "Principal Analyst"})
    assert res.status_code == 201, res.text
    item = res.json()
    assert item["status"] == "submitted" and item["before"] == {"grade": old_grade, "job_title": old_title}
    assert raise_action(client, farhan, who, "promotion", {"grade": "G8"}).status_code == 409  # one open promotion
    aid = item["id"]
    # Farhan raised it: manager step = Farhan's manager (Jordan); HR step falls back to admin (never Farhan himself)
    assert client.post(f"{API}/{aid}/decision", headers=farhan, json={"decision": "approve"}).status_code == 403
    assert aid in {a["id"] for a in client.get(API, params={"view": "to_decide"}, headers=jordan).json()}
    item = approve_all(client, aid, jordan, admin)
    assert item["status"] == "applied" and item["applied_at"]
    with SessionLocal() as db:
        emp = db.get(Employee, who)
        assert (emp.grade, emp.job_title) == ("G9", "Principal Analyst")
        actions = set(db.scalars(select(AuditLog.action).where(AuditLog.entity_id.in_([aid, who]))))
        assert {"lifecycle_submitted", "lifecycle_approved", "lifecycle_applied", "employee_updated"} <= actions

    history = client.get(f"/api/v1/people/{who}/history", headers=farhan).json()
    assert history[0]["effective_from"] == today_ist().isoformat() and history[0]["effective_to"] is None
    assert history[0]["grade"] == "G9" and history[0]["job_title"] == "Principal Analyst"
    if joined < today_ist():
        assert history[1]["effective_to"] == (today_ist() - timedelta(days=1)).isoformat()
        assert history[1]["grade"] == old_grade
    assert client.get(f"/api/v1/people/{who}/history", headers=babu).status_code == 404
    assert client.get("/api/v1/people/emp-mahesh/history", headers=babu).status_code == 200
    assert client.get("/api/v1/people/emp-mahesh/history", headers=token_for("emp-ram", "manager")).status_code == 200


def test_scheduled_transfer_applied_when_due(client, farhan, jordan, admin, babu, leaves):
    who = leaves[2]
    effective = today_ist() + timedelta(days=10)
    with SessionLocal() as db:
        old_location = db.get(Employee, who).location
    new_location = "Pune" if old_location != "Pune" else "Chennai"
    aid = raise_action(client, farhan, who, "location_change", {"location": new_location}, effective).json()["id"]
    item = approve_all(client, aid, jordan, admin)
    assert item["status"] == "scheduled" and item["applied_at"] is None
    with SessionLocal() as db:
        assert db.get(Employee, who).location == old_location
        assert apply_due_lifecycle_actions(db, today=effective - timedelta(days=1)) == []
        assert apply_due_lifecycle_actions(db, today=effective) == [aid]
        db.commit()
        assert db.get(Employee, who).location == new_location
        rows = list(db.scalars(select(EmployeeAssignment).where(EmployeeAssignment.employee_id == who)
                               .order_by(EmployeeAssignment.effective_from)))
        assert rows[-1].effective_from == effective and rows[-1].location == new_location and rows[-1].effective_to is None
        assert rows[-2].effective_to == effective - timedelta(days=1)
        assert db.get(LifecycleAction, aid).status == "applied"
    assert client.post("/api/v1/lifecycle/apply-due", headers=babu).status_code == 403
    res = client.post("/api/v1/lifecycle/apply-due", headers=farhan)
    assert res.status_code == 200 and aid not in res.json()["ids"]


def test_startup_applies_due_actions(client, farhan, jordan, admin, leaves):
    who = leaves[3]
    aid = raise_action(client, farhan, who, "job_change", {"job_title": "Operations Lead"},
                       today_ist() + timedelta(days=5)).json()["id"]
    assert approve_all(client, aid, jordan, admin)["status"] == "scheduled"
    with SessionLocal() as db:  # pretend the date has come
        db.get(LifecycleAction, aid).effective_date = today_ist() - timedelta(days=1)
        db.commit()
    with TestClient(app):  # runs the startup hook
        pass
    with SessionLocal() as db:
        assert db.get(LifecycleAction, aid).status == "applied"
        assert db.get(Employee, who).job_title == "Operations Lead"
    assert run_due_at_startup() == 0


def test_self_service_leave_withdraw_and_reject(client, babu, ram, farhan):
    start = today_ist() + timedelta(days=60)
    res = raise_action(client, babu, "emp-mahesh", "leave_of_absence",
                       {"leave_end_date": (start + timedelta(days=90)).isoformat()}, start, "Higher studies")
    assert res.status_code == 201, res.text
    aid = res.json()["id"]
    assert res.json()["before"] == {"employment_status": "Active"}
    assert aid in {a["id"] for a in client.get(API, params={"view": "to_decide"}, headers=ram).json()}
    assert aid in {a["id"] for a in client.get(API, headers=babu).json()}
    assert client.post(f"{API}/{aid}/withdraw", headers=token_for("demo-recruiter", "recruiter")).status_code == 404
    res = client.post(f"{API}/{aid}/withdraw", headers=babu)
    assert res.status_code == 200 and res.json()["status"] == "withdrawn" and res.json()["approval_status"] == "cancelled"
    assert aid not in {a["id"] for a in client.get(API, params={"view": "to_decide"}, headers=ram).json()}
    assert client.post(f"{API}/{aid}/withdraw", headers=babu).status_code == 409

    aid = raise_action(client, babu, "emp-mahesh", "leave_of_absence", {}, start).json()["id"]
    res = client.post(f"{API}/{aid}/decision", headers=ram, json={"decision": "reject", "note": "Not this quarter"})
    assert res.json()["status"] == "rejected"
    with SessionLocal() as db:
        assert db.get(Employee, "emp-mahesh").employment_status == "Active"


def test_hr_withdraws_scheduled_action(client, farhan, jordan, admin, leaves):
    who = leaves[4]
    aid = raise_action(client, farhan, who, "probation_completion", {"probation_end_date": "2027-01-31"},
                       today_ist() + timedelta(days=30)).json()["id"]
    assert approve_all(client, aid, jordan, admin)["status"] == "scheduled"
    assert client.post(f"{API}/{aid}/withdraw", headers=farhan).json()["status"] == "withdrawn"
    with SessionLocal() as db:
        assert apply_due_lifecycle_actions(db, today=today_ist() + timedelta(days=30)) == []
        db.rollback()


def test_any_and_all_modes(client, admin, farhan, jordan, leaves):
    client.put("/api/v1/workflows/lifecycle", headers=admin, json={"steps": [{"roles": ["manager", "hr"], "mode": "any"}]})
    aid = raise_action(client, farhan, leaves[5], "contract_extension", {"contract_end_date": "2027-12-31"}).json()["id"]
    item = approve_all(client, aid, admin)  # one approval from either group is enough
    assert item["status"] == "applied" and item["after"] == {"contract_end_date": "2027-12-31"}
    with SessionLocal() as db:  # nothing on the employee row changed, so no new history row
        assert db.scalar(select(func.count()).select_from(EmployeeAssignment)
                         .where(EmployeeAssignment.employee_id == leaves[5])) == 1

    client.put("/api/v1/workflows/lifecycle", headers=admin, json={"steps": [{"roles": ["manager", "hr"], "mode": "all"}]})
    aid = raise_action(client, farhan, leaves[6], "promotion", {"grade": "G7"}).json()["id"]
    assert approve_all(client, aid, admin)["status"] == "submitted"
    assert approve_all(client, aid, jordan)["status"] == "applied"
    client.put("/api/v1/workflows/lifecycle", headers=admin, json={"steps": DEFAULT_LIFECYCLE})


def test_rehire_and_country_transfer(client, farhan, jordan, admin, leaves):
    who = leaves[7]
    with SessionLocal() as db:
        db.get(Employee, who).employment_status = "Terminated"
        db.commit()
    assert raise_action(client, farhan, who, "promotion", {"grade": "G9"}).status_code == 422  # has left
    aid = raise_action(client, farhan, who, "rehire", {"job_title": "Analyst"}).json()["id"]
    assert approve_all(client, aid, jordan, admin)["status"] == "applied"
    aid = raise_action(client, farhan, who, "transfer", {"country_code": "AE", "location": "Dubai",
                                                         "legal_entity": "TimeZ UAE LLC"}).json()["id"]
    assert approve_all(client, aid, jordan, admin)["status"] == "applied"
    with SessionLocal() as db:
        emp = db.get(Employee, who)
        assert (emp.employment_status, emp.country_code, emp.currency, emp.time_zone) == ("Active", "AE", "AED", "Asia/Dubai")
        current = db.scalar(select(EmployeeAssignment).where(EmployeeAssignment.employee_id == who,
                                                             EmployeeAssignment.effective_to.is_(None)))
        assert current.location == "Dubai" and current.employment_status == "Active"


def test_subject_can_follow_steps_raised_by_manager(client, ram, babu):
    sophie = login(client, "sophie.clark@timez.com")
    res = raise_action(client, ram, "emp-mahesh", "location_change", {"location": "Hyderabad"},
                       effective=today_ist() + timedelta(days=40), reason="Closer to family")
    assert res.status_code == 201, res.text
    item = res.json()
    inst = item["approval_instance_id"]
    assert client.get(f"/api/v1/approvals/{inst}", headers=babu).status_code == 200  # the person it is about
    assert client.get(f"/api/v1/approvals/{inst}", headers=sophie).status_code == 404  # not involved
    assert client.post(f"{API}/{item['id']}/withdraw", headers=ram).status_code == 200
