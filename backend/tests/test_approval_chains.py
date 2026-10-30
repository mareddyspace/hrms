"""Leave / attendance corrections / timesheets through the approvals engine, delegation, step conditions and SLA."""

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import select

from app.db import SessionLocal, utcnow
from app.models import ApprovalDecision, ApprovalInstance, AuditLog, Employee, LeaveRequest, LeaveType, Notification
from app.security import create_access_token
from app.services import approvals as engine
from app.services import jobs
from app.services import time_approvals as chain
from tests.conftest import login

L = "/api/v1/leave/requests"
IST = ZoneInfo("Asia/Kolkata")


def token_for(account_id: str, role: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(account_id, role)[0]}"}


@pytest.fixture(scope="module")
def admin():
    return token_for("demo-admin", "admin")


@pytest.fixture(scope="module")
def sophie(client):
    return login(client, "sophie.clark@timez.com")


def _workday(client, headers, days_ahead: int) -> date:
    day = datetime.now(IST).date() + timedelta(days=days_ahead)
    holidays: set[str] = set()
    for year in {day.year, day.year + 1}:
        holidays |= {h["date"] for h in client.get("/api/v1/leave/holidays", headers=headers, params={"year": year}).json()}
    while day.weekday() >= 5 or day.isoformat() in holidays:
        day += timedelta(days=1)
    return day


def _apply(client, headers, code: str, start: date, end: date | None = None) -> dict:
    res = client.post(L, headers=headers, json={"leave_code": code, "from": start.isoformat(),
                                                "to": (end or start).isoformat(), "reason": "Family"})
    assert res.status_code == 201, res.text
    return res.json()


def _decide(client, headers, url, decision="approve", note=None):
    return client.post(url, headers=headers, json={"decision": decision, "note": note})


def _pending(client, headers) -> dict[str, dict]:
    return {i["id"]: i for i in client.get("/api/v1/approvals/pending", headers=headers).json()}


def test_defaults_and_workflow_list(client, admin, babu):
    rows = {w["type"]: w for w in client.get("/api/v1/workflows", headers=admin).json()}
    assert {"expense", "travel", "lifecycle", "leave", "attendance_correction", "timesheet"} <= set(rows)
    assert rows["leave"]["label"] == "Leave" and rows["leave"]["version"] >= 1
    assert [s["roles"] for s in rows["leave"]["steps"]] == [["manager"], ["hr"]]
    assert rows["leave"]["steps"][1]["only_if"] == "needs_hr"
    assert client.get("/api/v1/workflows", headers=babu).status_code == 403
    with SessionLocal() as db:
        assert chain.leave_needs_hr(db, "unpaid", 1) and chain.leave_needs_hr(db, "casual", 6)
        assert not chain.leave_needs_hr(db, "casual", 5)
        db.get(LeaveType, "unpaid").needs_hr_approval = False  # configured: no HR step
        assert not chain.leave_needs_hr(db, "unpaid", 1)
        db.get(LeaveType, "casual").needs_hr_approval = True
        assert chain.leave_needs_hr(db, "casual", 1)
        db.rollback()


def test_leave_manager_then_hr(client, babu, ram, farhan):
    day = _workday(client, babu, 70)
    req = _apply(client, babu, "unpaid", day)
    progress = req["approval"]
    assert req["status"] == "pending" and progress["total_steps"] == 2 and progress["step"] == 1
    assert progress["current_label"] == "Manager" and [s["status"] for s in progress["steps"]] == ["current", "waiting"]
    assert "(step 1 of 2)" in _pending(client, ram)[req["id"]]["summary"]
    assert req["id"] not in _pending(client, farhan)  # HR's step hasn't started

    res = _decide(client, ram, f"{L}/{req['id']}/decision")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["status"] == "pending" and body["approval"]["step"] == 2 and body["approval"]["current_label"] == "HR"
    assert body["approval"]["steps"][0]["decisions"][0]["by"] == "Ram Krishnan"
    assert _decide(client, ram, f"{L}/{req['id']}/decision").status_code == 403  # nobody approves two steps
    assert req["id"] in _pending(client, farhan) and req["id"] not in _pending(client, ram)

    iid = body["approval"]["instance_id"]
    res = _decide(client, farhan, f"/api/v1/approvals/{iid}/decision")  # the generic endpoint works too
    assert res.status_code == 200 and res.json()["status"] == "approved"
    got = next(r for r in client.get(L, headers=babu).json() if r["id"] == req["id"])
    assert got["status"] == "approved" and got["decided_by"] == "demo-hr-admin"
    assert [s["status"] for s in got["approval"]["steps"]] == ["done", "done"]
    assert any(n["title"] == "Leave approved" for n in client.get("/api/v1/notifications", headers=babu).json())
    with SessionLocal() as db:
        actions = list(db.scalars(select(AuditLog.action).where(AuditLog.entity_id == req["id"]).order_by(AuditLog.id)))
        assert actions == ["leave_applied", "leave_approved"]
    assert client.post(f"{L}/{req['id']}/cancel", headers=babu).json()["status"] == "cancelled"


def test_hr_acts_on_manager_step_and_long_leave(client, babu, farhan, admin):
    start = _workday(client, babu, 84)
    end = start
    while (end - start).days < 9:  # 6+ working days in the same year
        end += timedelta(days=1)
    if end.year != start.year:
        start, end = date(start.year + 1, 1, 11), date(start.year + 1, 1, 20)
    req = _apply(client, babu, "wfh", start, end)
    assert req["days"] > 5 and req["approval"]["total_steps"] == 2
    url = f"{L}/{req['id']}/decision"
    body = _decide(client, farhan, url).json()  # HR may decide the manager step (as before)
    assert body["status"] == "pending" and body["approval"]["step"] == 2
    assert body["approval"]["steps"][1]["approvers"] == ["Alex Morgan"]  # Farhan approved step 1: admin covers HR
    assert _decide(client, farhan, url).status_code == 403
    assert _decide(client, admin, f"/api/v1/approvals/{body['approval']['instance_id']}/decision").json()["status"] == "approved"
    assert client.post(f"{L}/{req['id']}/cancel", headers=babu).json()["status"] == "cancelled"


def test_short_leave_manager_only_reject_and_withdraw(client, babu, ram):
    day = _workday(client, babu, 75)
    req = _apply(client, babu, "casual", day)
    assert req["approval"]["total_steps"] == 1
    iid = req["approval"]["instance_id"]
    assert _decide(client, ram, f"/api/v1/approvals/{iid}/decision", "reject").status_code == 422
    assert _decide(client, ram, f"/api/v1/approvals/{iid}/decision", "reject", "Release week").status_code == 200
    got = next(r for r in client.get(L, headers=babu).json() if r["id"] == req["id"])
    assert got["status"] == "rejected" and got["decision_note"] == "Release week" and got["decided_by"] == "emp-ram"
    assert _decide(client, ram, f"{L}/{req['id']}/decision").status_code == 409

    req = _apply(client, babu, "casual", day)
    assert client.post(f"{L}/{req['id']}/cancel", headers=babu).json()["status"] == "withdrawn"
    with SessionLocal() as db:
        assert db.get(ApprovalInstance, req["approval"]["instance_id"]).status == "cancelled"


def test_request_without_chain_keeps_old_decision(client, ram):
    with SessionLocal() as db:
        db.add(LeaveRequest(id="lv-legacy", employee_id="emp-mahesh", leave_code="casual", from_date=date(2027, 9, 6),
                            to_date=date(2027, 9, 6), half="none", days=1, reason="x", status="pending"))
        db.commit()
    assert "lv-legacy" in _pending(client, ram)
    res = _decide(client, ram, f"{L}/lv-legacy/decision")
    assert res.status_code == 200 and res.json()["status"] == "approved" and res.json()["approval"] is None


def test_correction_and_timesheet_through_engine(client, babu, ram):
    day = datetime.now(IST).date() - timedelta(days=12)
    res = client.post("/api/v1/attendance/corrections", headers=babu, json={
        "work_date": day.isoformat(), "requested_check_in": f"{day}T09:00:00", "requested_check_out": f"{day}T18:00:00",
        "reason": "Card reader down"})
    assert res.status_code == 201, res.text
    item = res.json()
    assert item["approval"]["total_steps"] == 1 and item["approval"]["current_label"] == "Manager"
    iid = item["approval"]["instance_id"]
    assert item["id"] in _pending(client, ram)
    res = _decide(client, ram, f"/api/v1/approvals/{iid}/decision")
    assert res.status_code == 200 and res.json()["status"] == "approved"
    got = next(c for c in client.get("/api/v1/attendance/corrections", headers=babu).json() if c["id"] == item["id"])
    assert got["status"] == "approved" and got["session_id"] and got["decided_by"] == "emp-ram"
    session = next(s for s in client.get("/api/v1/attendance", headers=babu).json() if s["work_date"] == day.isoformat())
    assert session["corrected"] is True
    assert any(n["title"] == "Attendance correction approved" for n in client.get("/api/v1/notifications", headers=babu).json())

    assert client.post("/api/v1/timesheets/entries", headers=babu, json={"work_date": "2026-04-06", "project_id": "prj-hrms",
                       "task": "Build", "hours": 8}).status_code == 201
    week = client.post("/api/v1/timesheets/weeks/2026-04-06/submit", headers=babu).json()
    assert week["status"] == "submitted" and week["approval"]["total_steps"] == 1
    assert week["id"] in _pending(client, ram)
    res = _decide(client, ram, f"/api/v1/approvals/{week['approval']['instance_id']}/decision")
    assert res.status_code == 200
    week = next(w for w in client.get("/api/v1/timesheets/weeks", headers=babu).json() if w["id"] == week["id"])
    assert week["status"] == "approved" and week["decided_by"] == "emp-ram"
    with SessionLocal() as db:
        actions = list(db.scalars(select(AuditLog.action).where(AuditLog.entity_id == week["id"]).order_by(AuditLog.id)))
        assert actions[-2:] == ["timesheet_submitted", "timesheet_approved"]


def test_delegation(client, babu, ram, farhan, sophie):
    today = datetime.now(IST).date()
    D = "/api/v1/delegations"
    base = {"delegate_id": "demo-recruiter", "from": today.isoformat(), "to": (today + timedelta(days=7)).isoformat()}
    assert client.post(D, headers=ram, json=base | {"delegate_id": "emp-ram"}).status_code == 422
    assert client.post(D, headers=ram, json=base | {"to": (today - timedelta(days=1)).isoformat()}).status_code == 422
    assert client.post(D, headers=ram, json=base | {"types": ["parking"]}).status_code == 422
    res = client.post(D, headers=ram, json=base | {"types": ["leave"], "note": "On a course"})
    assert res.status_code == 201, res.text
    dlg = res.json()
    assert dlg["delegate_name"] == "Sophie Clark" and dlg["types"] == ["leave"] and dlg["from"] == today.isoformat()
    assert client.post(D, headers=ram, json=base).status_code == 409  # overlaps
    assert client.post(D, headers=sophie, json=base | {"delegate_id": "emp-ram"}).status_code == 409  # loop
    assert dlg["id"] in {d["id"] for d in client.get(D, headers=sophie).json()}
    assert dlg["id"] in {d["id"] for d in client.get(D, headers=farhan, params={"view": "all"}).json()}
    assert client.get(D, headers=babu, params={"view": "all"}).status_code == 403

    req = _apply(client, babu, "casual", _workday(client, babu, 95))
    assert req["id"] in _pending(client, sophie)
    assert any("You are covering" in n["body"] for n in client.get("/api/v1/notifications", headers=sophie).json())
    res = _decide(client, sophie, f"{L}/{req['id']}/decision")  # not in her scope, but covering for Ram
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "approved" and res.json()["decided_by"] == "demo-recruiter"
    assert res.json()["approval"]["steps"][0]["decisions"][0]["on_behalf_of"] == "Ram Krishnan"
    with SessionLocal() as db:
        decision = db.scalar(select(ApprovalDecision).where(ApprovalDecision.instance_id == req["approval"]["instance_id"]))
        assert decision.approver_id == "demo-recruiter" and decision.on_behalf_of == "emp-ram"
        audit = db.scalar(select(AuditLog).where(AuditLog.entity_id == decision.instance_id, AuditLog.action == "approval_approved"))
        assert audit.changes["after"]["on_behalf_of"] == "emp-ram"
    assert client.post(f"{L}/{req['id']}/cancel", headers=babu).status_code == 200

    # not handed over: attendance corrections
    day = today - timedelta(days=14)
    cid = client.post("/api/v1/attendance/corrections", headers=babu, json={"work_date": day.isoformat(),
                      "requested_check_in": f"{day}T09:10:00", "reason": "Missed punch"}).json()["id"]
    assert cid not in _pending(client, sophie)
    assert _decide(client, sophie, f"/api/v1/attendance/corrections/{cid}/decision").status_code == 404

    # ended: no longer covering
    assert client.delete(f"{D}/{dlg['id']}", headers=sophie).status_code == 404
    assert client.delete(f"{D}/{dlg['id']}", headers=ram).json()["active"] is False
    assert client.delete(f"{D}/{dlg['id']}", headers=ram).status_code == 409
    req = _apply(client, babu, "casual", _workday(client, babu, 100))
    assert req["id"] not in _pending(client, sophie)
    assert _decide(client, sophie, f"{L}/{req['id']}/decision").status_code == 404
    assert client.post(f"{L}/{req['id']}/cancel", headers=babu).status_code == 200
    assert _decide(client, ram, f"/api/v1/attendance/corrections/{cid}/decision", "reject", "Not needed").status_code == 200


def test_delegation_engine_window_and_types():
    with SessionLocal() as db:
        from app.models import ApprovalDelegation

        today = utcnow().date()
        db.add(ApprovalDelegation(id="dlg-test-old", delegator_id="emp-ram", delegate_id="demo-ceo", active=True,
                                  starts_on=today - timedelta(days=10), ends_on=today - timedelta(days=1), types=None))
        db.add(ApprovalDelegation(id="dlg-test-other", delegator_id="emp-ram", delegate_id="demo-hr-admin", active=True,
                                  starts_on=today, ends_on=today, types=["other"]))
        db.flush()
        assert "emp-ram" not in engine.delegators_for(db, "demo-ceo", on=today)  # window over
        assert "emp-ram" in engine.delegators_for(db, "demo-ceo", on=today - timedelta(days=2))
        assert "emp-ram" in engine.delegators_for(db, "demo-hr-admin", "travel", on=today)
        assert "emp-ram" not in engine.delegators_for(db, "demo-hr-admin", "leave", on=today)
        db.rollback()


def test_step_conditions_and_put(client, admin):
    res = client.put("/api/v1/workflows/wf_cond", headers=admin, json={"steps": [
        {"roles": ["manager"], "condition": {"field": "country", "values": ["US"]}, "label": "US manager"},
        {"roles": ["hr"], "condition": {"field": "department", "values": ["__dept__"]}, "sla_hours": 24},
        {"roles": ["admin"], "condition": {"field": "grade", "values": ["ZZ"]}},
    ]})
    assert res.status_code == 200, res.text
    assert res.json()["steps"][1]["sla_hours"] == 24 and res.json()["steps"][0]["label"] == "US manager"
    assert client.put("/api/v1/workflows/wf_cond", headers=admin, json={"steps": [
        {"roles": ["manager"], "condition": {"field": "colour", "values": ["x"]}}]}).status_code == 422
    assert client.put("/api/v1/workflows/wf_cond", headers=admin, json={"steps": [
        {"roles": ["manager"], "sla_hours": 0}]}).status_code == 422
    with SessionLocal() as db:
        emp = db.get(Employee, "emp-mahesh")
        definition = engine.latest_definition(db, "wf_cond")
        steps = [dict(s) for s in definition.steps]
        steps[1]["condition"] = {"field": "department", "values": [emp.department.upper()]}  # case-insensitive
        engine.save_definition(db, "wf_cond", steps, "demo-admin")
        inst = engine.start(db, "wf_cond", "c-1", emp)
        assert [s["skipped"] for s in inst.steps] == [True, False, True]
        assert inst.steps[0]["applies"] is False and inst.current_step == 1 and inst.steps[1]["sla_hours"] == 24
        engine.decide(db, inst, "demo-hr-admin", "approve")
        assert inst.status == "approved"  # later steps stay skipped after retarget
        # context overrides the requester's own value
        assert engine.start(db, "wf_cond", "c-2", emp, context={"country": "US", "department": "x"}).steps[0]["skipped"] is False
        db.rollback()


def test_sla_escalation_uses_step_hours(client, admin):
    with SessionLocal() as db:
        engine.save_definition(db, "wf_sla", [{"roles": ["manager"], "mode": "any", "sla_hours": 4},
                                              {"roles": ["hr"], "mode": "any"}], "demo-admin")
        inst = engine.start(db, "wf_sla", "sla-1", db.get(Employee, "emp-mahesh"))
        assert inst.steps[0]["started_at"]
        db.commit()
        iid = inst.id
    with SessionLocal() as db:
        assert engine.escalate_overdue_steps(db, utcnow() + timedelta(hours=3)) == 0
        out = jobs.run_sla_escalation(db, utcnow() + timedelta(hours=5))
        assert out["approvals_escalated"] == 1
        inst = db.get(ApprovalInstance, iid)
        ram = db.get(Employee, "emp-ram")
        assert inst.steps[0]["escalated_at"] and inst.steps[0]["escalated_to"] == [ram.manager_id or "demo-admin"]
        assert db.scalar(select(Notification).where(Notification.recipient_id == "emp-ram",
                                                    Notification.title.like("Approval overdue%")))
        assert db.scalar(select(AuditLog).where(AuditLog.entity_id == iid, AuditLog.action == "approval_escalated"))
        assert engine.escalate_overdue_steps(db, utcnow() + timedelta(hours=50)) == 0  # once per step
        engine.decide(db, inst, "emp-ram", "approve")  # the HR step has no SLA
        assert engine.escalate_overdue_steps(db, utcnow() + timedelta(hours=50)) == 0
        db.commit()


def test_skip_level_manager_cannot_approve_over_line_manager(client, babu):
    """Babu's leave waits on Ram; Jordan (Ram's manager) can't decide it for him."""
    from datetime import date, timedelta

    from tests.conftest import login

    day = date.today() + timedelta(days=60)
    while day.weekday() >= 5:
        day += timedelta(days=1)
    res = client.post("/api/v1/leave/requests", headers=babu,
                      json={"leave_code": "pto", "from": day.isoformat(), "to": day.isoformat(), "reason": "Skip-level check"})
    assert res.status_code == 201, res.text
    jordan = login(client, "jordan.blake@timez.com")
    denied = client.post(f"/api/v1/leave/requests/{res.json()['id']}/decision", headers=jordan, json={"decision": "approve"})
    assert denied.status_code in (403, 404), denied.text
