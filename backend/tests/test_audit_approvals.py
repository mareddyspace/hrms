"""Security audit: nobody decides their own request; a skip-level manager can't take the line manager's step."""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from sqlalchemy import select

from app.db import SessionLocal
from app.models import Account, ApprovalInstance, Employee
from app.security import create_access_token
from tests.conftest import login
from tests.test_audit_rbac import audit_accounts_cleanup, real_account, sample_employee  # noqa: F401

API = "/api/v1"


def _workday(days_ahead: int) -> str:
    day = date.today() + timedelta(days=days_ahead)
    while day.weekday() >= 5:
        day += timedelta(days=1)
    return day.isoformat()


def _leave(client, headers, days_ahead: int, reason: str) -> dict:
    d = _workday(days_ahead)
    res = client.post(f"{API}/leave/requests", headers=headers, json={"leave_code": "pto", "from": d, "to": d, "reason": reason})
    assert res.status_code == 201, res.text
    return res.json()


def _instance_for(entity_id: str) -> ApprovalInstance | None:
    with SessionLocal() as db:
        return db.scalar(select(ApprovalInstance).where(ApprovalInstance.entity_id == entity_id,
                                                        ApprovalInstance.status == "pending"))


@pytest.fixture(scope="module")
def jordan(client):
    return login(client, "jordan.blake@timez.com")


def test_employee_cannot_approve_own_leave(client, babu):
    item = _leave(client, babu, 81, "Audit self approval")
    try:
        assert client.post(f"{API}/leave/requests/{item['id']}/decision", headers=babu,
                           json={"decision": "approve"}).status_code == 403
        inst = _instance_for(item["id"])
        assert inst is not None
        res = client.post(f"{API}/approvals/{inst.id}/decision", headers=babu, json={"decision": "approve"})
        assert res.status_code == 403 and "own" in res.json()["detail"]
    finally:
        client.post(f"{API}/leave/requests/{item['id']}/cancel", headers=babu)


def test_hr_cannot_approve_own_requests(client):
    """An HR admin in scope of everybody still can't decide their own leave, correction or benefit enrollment."""
    hr = real_account(client, sample_employee("IN", offset=21), "hr_admin")
    item = _leave(client, hr, 83, "Audit HR self approval")
    try:
        assert client.post(f"{API}/leave/requests/{item['id']}/decision", headers=hr,
                           json={"decision": "approve"}).status_code == 403
        inst = _instance_for(item["id"])
        if inst is not None:
            assert client.post(f"{API}/approvals/{inst.id}/decision", headers=hr,
                               json={"decision": "approve"}).status_code == 403
    finally:
        client.post(f"{API}/leave/requests/{item['id']}/cancel", headers=hr)

    me = client.get(f"{API}/auth/me", headers=hr).json()["employee_id"]
    corr = client.post(f"{API}/people/{me}/corrections", headers=hr,
                       json={"field": "nationality", "requested_value": "Indian", "reason": "Audit"})
    assert corr.status_code == 201, corr.text
    assert client.post(f"{API}/profile-corrections/{corr.json()['id']}/decide", headers=hr,
                       json={"decision": "approve"}).status_code == 403

    plans = client.get(f"{API}/benefits/plans", headers=hr).json()
    optional = [p for p in plans if not p.get("mandatory")]
    if optional:
        enr = client.post(f"{API}/benefits/enrollments", headers=hr, json={"plan_id": optional[0]["id"]})
        if enr.status_code == 201 and enr.json()["status"] == "requested":
            assert client.post(f"{API}/benefits/enrollments/{enr.json()['id']}/decision", headers=hr,
                               json={"decision": "approve"}).status_code == 403


def test_hr_cannot_approve_own_cash_advance(client):
    hr = real_account(client, sample_employee("IN", offset=22), "hr_admin")
    res = client.post(f"{API}/cash-advances", headers=hr, json={"amount": 5000, "category": "Medical", "purpose": "Audit",
                                                                "needed_by": _workday(10)})
    assert res.status_code == 201, res.text
    assert client.post(f"{API}/cash-advances/{res.json()['id']}/decision", headers=hr,
                       json={"decision": "approve"}).status_code == 403


def test_nobody_decides_their_own_pending_request_anywhere():
    """Every pending approval in the database (from every area): the requester's own decision is refused."""
    from fastapi.testclient import TestClient

    from app.main import app

    client = TestClient(app)
    with SessionLocal() as db:
        rows = db.execute(select(ApprovalInstance.id, ApprovalInstance.type, Account.id, Account.role)
                          .join(Account, Account.employee_id == ApprovalInstance.requester_id)
                          .where(ApprovalInstance.status == "pending")).all()
    assert rows, "expected pending approvals from earlier tests"
    for inst_id, type_, acc_id, role in rows:
        h = {"Authorization": f"Bearer {create_access_token(acc_id, role)[0]}"}
        res = client.post(f"{API}/approvals/{inst_id}/decision", headers=h, json={"decision": "approve"})
        assert res.status_code == 403, (type_, inst_id, res.status_code, res.text)


def test_skip_level_cannot_take_line_manager_step_via_engine(client, babu, jordan):
    """Babu's leave waits on Ram; Jordan (CEO, Ram's manager) is refused on both decision endpoints."""
    item = _leave(client, babu, 85, "Audit skip level")
    try:
        inst = _instance_for(item["id"])
        assert inst is not None
        assert client.post(f"{API}/approvals/{inst.id}/decision", headers=jordan,
                           json={"decision": "approve"}).status_code == 403
        assert client.post(f"{API}/leave/requests/{item['id']}/decision", headers=jordan,
                           json={"decision": "approve"}).status_code in (403, 404)
        # and nothing moved
        assert _instance_for(item["id"]).current_step == inst.current_step
    finally:
        client.post(f"{API}/leave/requests/{item['id']}/cancel", headers=babu)


def test_unrelated_manager_cannot_decide(client, babu):
    """A manager outside Babu's line gets nothing (404 or 403), whatever the id."""
    with SessionLocal() as db:
        other_mgr = db.scalar(select(Account).join(Employee, Employee.id == Account.employee_id)
                              .where(Account.role == "manager", Account.employee_id != "emp-ram"))
    item = _leave(client, babu, 87, "Audit outsider")
    try:
        inst = _instance_for(item["id"])
        headers = real_account(client, sample_employee("GB", offset=1, leaf=False), "manager") if other_mgr is None else \
            {"Authorization": f"Bearer {create_access_token(other_mgr.id, other_mgr.role)[0]}"}
        assert client.post(f"{API}/approvals/{inst.id}/decision", headers=headers,
                           json={"decision": "approve"}).status_code in (403, 404)
        assert client.get(f"{API}/approvals/{inst.id}", headers=headers).status_code in (403, 404)
    finally:
        client.post(f"{API}/leave/requests/{item['id']}/cancel", headers=babu)


def test_can_decide_excludes_skip_level():
    """AUD-08 (fixed): only the line manager (or their delegate) or HR in scope; the CEO can't approve over Ram."""
    from app.deps import CurrentUser
    from app.services.data_scope import scope_for
    from app.services.decisions import can_decide

    with SessionLocal() as db:
        acc = db.get(Account, "demo-ceo")
        user = CurrentUser(account=acc, employee=db.get(Employee, "demo-ceo"), scope=scope_for(db, acc))
        assert not can_decide(db, user, db.get(Employee, "emp-mahesh"))
