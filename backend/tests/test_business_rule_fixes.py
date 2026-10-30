"""Business-rule fixes from the requirements audit (product-owner decisions):

- only the line manager (or their delegate) or HR in scope decides - never a skip-level manager;
- nobody approves a request they raised or that is about them, not even as somebody's delegate;
- lifecycle changes go to the SUBJECT's manager;
- weekly days off follow the country (Saudi Arabia Friday-Saturday);
- requester notices open the requester's own page;
- the expense finance step works in every currency.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from sqlalchemy import select

from app.db import SessionLocal
from app.deps import CurrentUser
from app.models import Account, ApprovalDelegation, ApprovalInstance, Employee, LeaveRequest, Notification
from app.security import create_access_token
from app.services import approvals as engine
from app.services.data_scope import scope_for
from app.services.decisions import can_decide

API = "/api/v1"


def token_for(account_id: str, role: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(account_id, role)[0]}"}


def _user(db, account_id: str) -> CurrentUser:
    acc = db.get(Account, account_id)
    return CurrentUser(account=acc, employee=db.get(Employee, acc.employee_id), scope=scope_for(db, acc))


@pytest.fixture()
def delegation():
    """Ram (Babu's manager) hands his approvals to Sophie for today; removed afterwards."""
    with SessionLocal() as db:
        row = ApprovalDelegation(id="dlg-rule-fix", delegator_id="emp-ram", delegate_id="demo-recruiter",
                                 starts_on=date.today() - timedelta(days=1), ends_on=date.today() + timedelta(days=1),
                                 types=None, active=True, created_by="emp-ram")
        db.add(row)
        db.commit()
    yield
    with SessionLocal() as db:
        db.delete(db.get(ApprovalDelegation, "dlg-rule-fix"))
        db.commit()


# ---------- 1. no skip-level ----------
def test_can_decide_line_manager_delegate_or_hr_only(delegation):
    with SessionLocal() as db:
        babu = db.get(Employee, "emp-mahesh")
        assert babu.manager_id == "emp-ram"
        assert can_decide(db, _user(db, "emp-ram"), babu)  # line manager
        assert can_decide(db, _user(db, "demo-recruiter"), babu, "leave")  # Ram's delegate
        assert can_decide(db, _user(db, "demo-hr-admin"), babu)  # HR in scope
        assert not can_decide(db, _user(db, "demo-ceo"), babu)  # skip-level (Ram's manager)
        assert not can_decide(db, _user(db, "emp-mahesh"), babu)  # never your own


def test_legacy_leave_without_chain_refuses_skip_level(client):
    """A leave request from before approval chains: the CEO (skip-level) is refused, the line manager decides."""
    day = date.today() + timedelta(days=200)
    with SessionLocal() as db:
        db.add(LeaveRequest(id="lv-skip-level", employee_id="emp-mahesh", leave_code="casual", from_date=day, to_date=day,
                            half="none", days=1, reason="old request", status="pending"))
        db.commit()
    try:
        url = f"{API}/leave/requests/lv-skip-level/decision"
        res = client.post(url, headers=token_for("demo-ceo", "executive"), json={"decision": "approve"})
        assert res.status_code == 403, res.text
        res = client.post(url, headers=token_for("emp-ram", "manager"), json={"decision": "approve"})
        assert res.status_code == 200 and res.json()["status"] == "approved"
    finally:
        with SessionLocal() as db:
            db.delete(db.get(LeaveRequest, "lv-skip-level"))
            db.commit()


# ---------- 2. no self-approval through delegation ----------
def test_subject_cannot_approve_as_delegate(delegation):
    """Babu raises something about Sophie that Ram approves; Sophie covers for Ram but is the subject: refused."""
    with SessionLocal() as db:
        engine.save_definition(db, "wf_about_subject", [{"roles": ["manager"], "mode": "any"}], "demo-admin")
        inst = engine.start(db, "wf_about_subject", "subj-1", db.get(Employee, "emp-mahesh"), exclude={"demo-recruiter"})
        assert inst.steps[0]["groups"]["manager"] == ["emp-ram"]
        assert engine.can_act(db, inst, "emp-ram")
        assert not engine.can_act(db, inst, "demo-recruiter")  # the subject, even as Ram's delegate
        assert inst not in engine.pending_for(db, "demo-recruiter")
        with pytest.raises(engine.NotAllowed):
            engine.decide(db, inst, "demo-recruiter", "approve")
        with pytest.raises(engine.NotAllowed):  # nor by HR-style authority
            engine.decide(db, inst, "demo-recruiter", "approve", authority=True)
        # an unrelated request: Sophie may act for Ram as usual
        other = engine.start(db, "wf_about_subject", "subj-2", db.get(Employee, "emp-mahesh"))
        assert engine.can_act(db, other, "demo-recruiter")
        db.rollback()


# ---------- 3. lifecycle follows the subject's line ----------
def test_lifecycle_raised_by_skip_level_goes_to_the_subjects_manager(client):
    """Jordan (CEO) raises a change for Babu: the manager step is Ram (Babu's manager), not someone above Jordan."""
    jordan, ram = token_for("demo-ceo", "executive"), token_for("emp-ram", "manager")
    res = client.post(f"{API}/lifecycle/actions", headers=jordan, json={
        "employee_id": "emp-mahesh", "action_type": "location_change", "effective_date": (date.today() + timedelta(days=45)).isoformat(),
        "after": {"location": "Kochi"}, "reason": "Closer to the client"})
    assert res.status_code == 201, res.text
    action = res.json()
    try:
        with SessionLocal() as db:
            inst = db.get(ApprovalInstance, action["approval_instance_id"])
            assert inst.steps[inst.current_step]["groups"].get("manager") == ["emp-ram"]
            assert "emp-mahesh" in inst.steps[0].get("exclude", [])
        to_decide = client.get(f"{API}/lifecycle/actions", headers=ram, params={"view": "to_decide"}).json()
        assert action["id"] in {a["id"] for a in to_decide}
        assert client.post(f"{API}/lifecycle/actions/{action['id']}/decision", headers=jordan,
                           json={"decision": "approve"}).status_code == 403
    finally:
        client.post(f"{API}/lifecycle/actions/{action['id']}/withdraw", headers=jordan)


# ---------- 5. weekends per country ----------
def _sa_employee() -> str:
    with SessionLocal() as db:
        emp_id = db.scalar(select(Employee.id).where(Employee.country_code == "SA", Employee.employment_status == "Active")
                           .order_by(Employee.id))
    assert emp_id, "expected a Saudi employee in the sample data"
    return emp_id


def test_saudi_weekend_is_friday_saturday():
    from app.services.attendance import month_summary
    from app.services.leave import LeaveError, holiday_dates_for, validate_new_request, weekly_off_for, working_days
    from app.services.timesheets import DAY_TARGET, day_target

    sun, thu, fri, sat = date(2026, 11, 15), date(2026, 11, 19), date(2026, 11, 20), date(2026, 11, 21)
    with SessionLocal() as db:
        assert weekly_off_for(db, "SA") == {4, 5}  # Friday, Saturday
        assert weekly_off_for(db, "AE") == {5, 6}  # Saturday, Sunday since 2022
        assert weekly_off_for(db, "IN") == {5, 6}
        emp = db.get(Employee, _sa_employee())
        holidays = holiday_dates_for(db, emp, sun, sat)
        # Sunday-Thursday is a full working week in Saudi Arabia (Sat/Sun would have made it 4 days)
        assert working_days(sun, thu, holidays, weekly_off=weekly_off_for(db, "SA")) == 5 - len(holidays & {sun + timedelta(d) for d in range(5)})
        with pytest.raises(LeaveError, match="no working days"):
            validate_new_request(db, emp, "pto", fri, sat, "none", "Weekend trip")
        # timesheets: Friday is a day off, Sunday a working day
        assert day_target(db, emp, fri) == (0.0, "weekend")
        if sun not in holidays:
            assert day_target(db, emp, sun)[0] == DAY_TARGET
        # attendance: working days in November skip Fridays and Saturdays
        summary = month_summary(db, emp, 2026, 11)
        nov = [date(2026, 11, d) for d in range(1, 31)]
        all_holidays = holiday_dates_for(db, emp, nov[0], nov[-1])
        assert summary.working_days == sum(1 for d in nov if d.weekday() not in (4, 5) and d not in all_holidays)


# ---------- 8. requester notices open the requester's page ----------
def test_requester_outcome_notice_links_to_their_own_page():
    with SessionLocal() as db:
        babu = db.get(Employee, "emp-mahesh")
        engine.save_definition(db, "expense", [{"roles": ["manager"], "mode": "any"}], "demo-admin")
        inst = engine.start(db, "expense", "exp-notice-check", babu, 100.0)
        engine.decide(db, inst, "emp-ram", "approve")
        db.flush()
        note = db.scalar(select(Notification).where(Notification.recipient_id == "emp-mahesh",
                                                    Notification.title == "Expense request approved")
                         .order_by(Notification.id.desc()))
        assert note is not None and note.href == "/expenses/exp-notice-check"
        assert engine.requester_href(ApprovalInstance(type="lifecycle", entity_id="lca-1")) == "/lifecycle/actions/lca-1"
        db.rollback()


# ---------- 10. expense finance step in every currency ----------
def test_expense_finance_threshold_is_per_currency():
    from app.services.workflow_defaults import expense_compare_amount, expense_finance_threshold

    assert expense_finance_threshold("IN") == 10000 and expense_finance_threshold("SA") == 450
    steps = [{"roles": ["manager"], "mode": "any"}, {"roles": ["finance"], "mode": "any", "min_amount": 10000}]
    with SessionLocal() as db:
        engine.save_definition(db, "expense", steps, "demo-admin")
        sa = db.get(Employee, _sa_employee())
        big = engine.start(db, "expense", "exp-sa-big", sa, 500.0, compare_amount=expense_compare_amount(500.0, "SA"))
        small = engine.start(db, "expense", "exp-sa-small", sa, 400.0, compare_amount=expense_compare_amount(400.0, "SA"))
        assert big.steps[1]["skipped"] is False  # 500 SAR reaches Finance (it never did against a unitless 10000)
        assert small.steps[1]["skipped"] is True
        assert big.amount == 500.0  # the amount shown stays in riyals
        db.rollback()


def test_expense_rules_report_local_threshold(client):
    """GET /expenses/rules tells a Saudi employee their own threshold (needs a sign-in for them)."""
    sa = _sa_employee()
    with SessionLocal() as db:
        acc = db.scalar(select(Account).where(Account.employee_id == sa))
        if acc is None:
            acc = Account(id=f"rf-{sa}", email=f"rf.{sa.lower()}@timez.example", password_hash="x", role="employee",
                          employee_id=sa, active=True)
            db.add(acc)
            db.commit()
        acc_id, role = acc.id, acc.role
    body = client.get(f"{API}/expenses/rules", headers=token_for(acc_id, role)).json()
    assert body["currency"] == "SAR" and body["finance_threshold"] == 450
