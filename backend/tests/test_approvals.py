from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import select

from app.db import SessionLocal
from app.models import ApprovalInstance, AuditLog, Employee, LeaveRequest
from app.security import create_access_token
from app.services import approvals as engine
from tests.timesheet_helpers import legacy_submit_week


def token_for(account_id: str, role: str) -> dict[str, str]:
    """Signed token without a login (the auth tests lock Alex's account on purpose)."""
    return {"Authorization": f"Bearer {create_access_token(account_id, role)[0]}"}


@pytest.fixture(scope="module")
def admin():
    return token_for("demo-admin", "admin")


def _workflow(client, admin, type_: str, steps: list[dict]) -> dict:
    res = client.put(f"/api/v1/workflows/{type_}", headers=admin, json={"steps": steps})
    assert res.status_code == 200, res.text
    return res.json()


def _start(type_: str, requester: str, amount: float | None = None, entity: str = "ent-1") -> str:
    with SessionLocal() as db:
        inst = engine.start(db, type_, entity, db.get(Employee, requester), amount)
        db.commit()
        return inst.id


def _decide(client, headers, iid, decision="approve", note=None):
    return client.post(f"/api/v1/approvals/{iid}/decision", headers=headers, json={"decision": decision, "note": note})


def _pending_ids(client, headers) -> set[str]:
    return {i["id"] for i in client.get("/api/v1/approvals/pending", headers=headers).json()}


def test_workflow_versions_admin_only(client, admin, babu):
    first = _workflow(client, admin, "expense", [{"roles": ["manager"], "mode": "any"}])
    second = _workflow(client, admin, "expense", [{"roles": ["manager", "hr"], "mode": "all", "min_amount": 100}])
    assert second["version"] == first["version"] + 1 and second["active"] is True
    got = client.get("/api/v1/workflows/expense", headers=admin).json()
    assert got["version"] == second["version"] and got["steps"][0]["roles"] == ["manager", "hr"]
    assert client.get("/api/v1/workflows/expense", headers=babu).status_code == 403
    assert client.put("/api/v1/workflows/expense", headers=babu, json={"steps": [{"roles": ["manager"]}]}).status_code == 403
    assert client.get("/api/v1/workflows/never_set", headers=admin).status_code == 404
    assert client.put("/api/v1/workflows/expense", headers=admin, json={"steps": [{"roles": ["boss"]}]}).status_code == 422
    assert client.put("/api/v1/workflows/expense", headers=admin, json={"steps": []}).status_code == 422
    with SessionLocal() as db:
        assert db.scalar(select(AuditLog).where(AuditLog.action == "workflow_saved", AuditLog.entity_id == f"expense:v{second['version']}"))


def test_mode_all_needs_every_group(client, admin, babu, ram, farhan):
    _workflow(client, admin, "wf_all", [{"roles": ["manager", "hr"], "mode": "all"}])
    iid = _start("wf_all", "emp-mahesh", entity="exp-all")
    assert iid in _pending_ids(client, ram) and iid in _pending_ids(client, farhan)
    assert iid not in _pending_ids(client, babu)

    assert _decide(client, babu, iid).status_code == 403  # never self
    sophie = token_for("demo-recruiter", "recruiter")
    assert _decide(client, sophie, iid).status_code == 404  # out of scope
    res = _decide(client, ram, iid)
    assert res.status_code == 200 and res.json()["status"] == "pending"
    assert _decide(client, ram, iid).status_code == 403  # Ram's group is done
    assert iid not in _pending_ids(client, ram) and iid in _pending_ids(client, farhan)
    res = _decide(client, farhan, iid)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["status"] == "approved" and [d["group"] for d in body["decisions"]] == ["manager", "hr"]
    assert _decide(client, farhan, iid).status_code == 409
    assert any(n["title"] == "Wf all request approved" for n in client.get("/api/v1/notifications", headers=babu).json())
    assert client.get(f"/api/v1/approvals/{iid}", headers=babu).status_code == 200
    with SessionLocal() as db:
        actions = list(db.scalars(select(AuditLog.action).where(AuditLog.entity_id == iid).order_by(AuditLog.id)))
        assert actions == ["approval_started", "approval_step_decided", "approval_approved"]


def test_mode_any_and_reject(client, admin, ram, farhan):
    _workflow(client, admin, "wf_any", [{"roles": ["manager", "hr"], "mode": "any"}])
    iid = _start("wf_any", "emp-mahesh", entity="exp-any")
    assert _decide(client, farhan, iid).json()["status"] == "approved"
    assert iid not in _pending_ids(client, ram)

    iid = _start("wf_any", "emp-mahesh", entity="exp-any-2")
    assert _decide(client, ram, iid, "reject").status_code == 422  # note required
    assert _decide(client, ram, iid, "reject", "Duplicate claim").json()["status"] == "rejected"


def test_min_amount_finance_fallback_and_skip_manager(client, admin, ram):
    _workflow(client, admin, "wf_amount", [
        {"roles": ["manager"], "mode": "any"},
        {"roles": ["finance"], "mode": "any", "min_amount": 1000},
        {"roles": ["skip_manager"], "mode": "any", "min_amount": 10000},
    ])
    small = _start("wf_amount", "emp-mahesh", 500, "exp-small")
    assert _decide(client, ram, small).json()["status"] == "approved"

    big = _start("wf_amount", "emp-mahesh", 5000, "exp-big")
    res = _decide(client, ram, big).json()
    assert res["status"] == "pending" and res["current_step"] == 1
    assert res["steps"][1]["groups"]["finance"] == ["demo-admin"]  # nobody holds the finance role
    assert res["steps"][2]["skipped"] is True
    assert big in _pending_ids(client, admin)
    assert _decide(client, admin, big).json()["status"] == "approved"

    huge = _start("wf_amount", "emp-mahesh", 20000, "exp-huge")
    with SessionLocal() as db:
        steps = db.get(ApprovalInstance, huge).steps
        assert steps[2]["groups"]["skip_manager"] == ["demo-ceo"] and steps[2]["skipped"] is False


def test_requester_never_approver_and_auto_approve():
    with SessionLocal() as db:
        engine.save_definition(db, "wf_hr", [{"roles": ["hr"], "mode": "any"}], "demo-admin")
        inst = engine.start(db, "wf_hr", "x", db.get(Employee, "demo-hr-admin"))
        assert inst.steps[0]["groups"]["hr"] == ["demo-admin"]  # Farhan is the only HR person: falls back to admin
        with pytest.raises(engine.NotAllowed):
            engine.decide(db, inst, "demo-hr-admin", "approve")
        engine.save_definition(db, "wf_mgr", [{"roles": ["manager"], "mode": "any"}], "demo-admin")
        # Jordan has no manager: falls back to admin
        assert engine.start(db, "wf_mgr", "y", db.get(Employee, "demo-ceo")).steps[0]["groups"]["manager"] == ["demo-admin"]
        engine.save_definition(db, "wf_none", [{"roles": ["manager"], "mode": "any", "min_amount": 50}], "demo-admin")
        assert engine.start(db, "wf_none", "z", db.get(Employee, "emp-mahesh"), 10).status == "approved"
        with pytest.raises(engine.ApprovalError):
            engine.start(db, "not_configured", "z", db.get(Employee, "emp-mahesh"))
        db.rollback()


def test_pending_inbox_covers_every_kind(client, admin, babu, ram):
    today = datetime.now(ZoneInfo("Asia/Kolkata")).date()
    # attendance correction
    day = today - timedelta(days=8)
    assert client.post("/api/v1/attendance/corrections", headers=babu, json={"work_date": day.isoformat(),
                       "requested_check_in": f"{day}T09:30:00", "reason": "Missed punch"}).status_code == 201
    # timesheet week
    assert client.post("/api/v1/timesheets/entries", headers=babu, json={"work_date": "2026-01-05", "project_id": "prj-hrms",
                       "task": "Build", "hours": 8}).status_code == 201
    legacy_submit_week(client, babu, "emp-mahesh", "2026-01-05")  # submitted before timesheets went daily
    # leave
    with SessionLocal() as db:
        db.add(LeaveRequest(id="lv-inbox", employee_id="emp-mahesh", leave_code="casual", from_date=date(2027, 8, 16),
                            to_date=date(2027, 8, 16), half="none", days=1, reason="x", status="pending"))
        db.commit()
    # generic
    _workflow(client, admin, "travel", [{"roles": ["manager"], "mode": "any"}])
    iid = _start("travel", "emp-mahesh", 300, "trip-1")

    items = client.get("/api/v1/approvals/pending", headers=ram).json()
    kinds = {i["kind"] for i in items if i["employee_id"] == "emp-mahesh"}
    assert kinds >= {"leave", "attendance_correction", "timesheet_week", "approval"}
    assert iid in {i["id"] for i in items} and "lv-inbox" in {i["id"] for i in items}
    assert all(i["employee_id"] != "emp-mahesh" for i in client.get("/api/v1/approvals/pending", headers=babu).json())


def test_no_one_approves_two_steps(client, admin, farhan):
    _workflow(client, admin, "wf_twice", [{"roles": ["hr", "admin"], "mode": "any"}, {"roles": ["admin"], "mode": "any"}])
    jordan = token_for("demo-ceo", "executive")
    # Alex approves the first step: the admin step falls back to the executive, never Alex again
    iid = _start("wf_twice", "emp-mahesh", entity="twice-1")
    res = _decide(client, admin, iid).json()
    assert res["status"] == "pending" and res["current_step"] == 1
    assert res["steps"][1]["groups"]["admin"] == ["demo-ceo"]
    assert iid not in _pending_ids(client, admin)
    assert _decide(client, admin, iid).status_code == 403
    assert _decide(client, jordan, iid).json()["status"] == "approved"
    # Farhan approves the first step: Alex keeps the second
    iid = _start("wf_twice", "emp-mahesh", entity="twice-2")
    assert _decide(client, farhan, iid).json()["steps"][1]["groups"]["admin"] == ["demo-admin"]
    assert _decide(client, admin, iid).json()["status"] == "approved"


def test_sole_approver_of_earlier_step_left_out_at_start():
    with SessionLocal() as db:
        # Farhan raises it: HR falls back to Alex, so the admin step can't be Alex too -> executive
        engine.save_definition(db, "wf_chain", [{"roles": ["hr"], "mode": "any"}, {"roles": ["admin"], "mode": "any"},
                                                {"roles": ["executive"], "mode": "any"}], "demo-admin")
        inst = engine.start(db, "wf_chain", "c", db.get(Employee, "demo-hr-admin"))
        assert inst.steps[0]["groups"]["hr"] == ["demo-admin"]
        assert inst.steps[1]["groups"]["admin"] == ["demo-ceo"]
        # Jordan is the only one left and already holds step 2: the executive step has nobody and is skipped
        assert inst.steps[2]["skipped"] is True
        engine.decide(db, inst, "demo-admin", "approve")
        engine.decide(db, inst, "demo-ceo", "approve")
        assert inst.status == "approved"
        db.rollback()
