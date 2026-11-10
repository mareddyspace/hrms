"""HR common sense about who a rule applies to (app/services/role_rules.py and the modules that use it).

The CEO (demo-ceo) is at the top of every line; HR (Farhan) and the IT admin (Alex) work for him.
"""

from __future__ import annotations

import uuid
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import exists, select
from sqlalchemy.orm import aliased

from app.db import SessionLocal
from app.models import Account, AuditLog, Employee, JobPosting, LeaveType, Requisition
from app.security import create_access_token
from app.services import approvals as engine
from app.services import role_rules

API = "/api/v1"
DEFAULT_EXPENSE = [{"roles": ["manager"], "mode": "any"}, {"roles": ["finance"], "mode": "any", "min_amount": 10000}]


def token_for(account_id: str, role: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(account_id, role)[0]}"}


@pytest.fixture(scope="module")
def admin():
    return token_for("demo-admin", "admin")


@pytest.fixture(scope="module")
def jordan():
    return token_for("demo-ceo", "executive")


def _sample(*where) -> str:
    """An active Indian sample employee with a manager and nobody reporting to them."""
    report = aliased(Employee)
    with SessionLocal() as db:
        found = db.scalar(select(Employee.id).where(
            Employee.source == "hcm_sample", Employee.country_code == "IN", Employee.employment_status == "Active",
            Employee.manager_id.is_not(None), ~exists().where(report.manager_id == Employee.id), *where,
        ).order_by(Employee.id).offset(3).limit(1))
    assert found
    return found


def _account(employee_id: str) -> dict[str, str]:
    with SessionLocal() as db:
        acc = db.scalar(select(Account).where(Account.employee_id == employee_id))
        if acc is None:
            acc = Account(id=f"t-rl-{employee_id}", email=f"rl.{employee_id.lower()}@timez.example", password_hash="x",
                          role="employee", employee_id=employee_id, active=True)
            db.add(acc)
            db.commit()
        return token_for(acc.id, acc.role)


@contextmanager
def serving_notice(employee_id: str):
    with SessionLocal() as db:
        emp = db.get(Employee, employee_id)
        before = emp.employment_status
        emp.employment_status = "Notice period"
        db.commit()
    try:
        yield
    finally:
        with SessionLocal() as db:
            db.get(Employee, employee_id).employment_status = before
            db.commit()


# ---------- approvals at the top of the org and without a finance team ----------
def test_ceo_requests_never_go_to_the_it_admin(client, admin, jordan):
    assert client.put(f"{API}/workflows/expense", headers=admin, json={"steps": DEFAULT_EXPENSE}).status_code == 200
    day = (datetime.now(ZoneInfo("America/Los_Angeles")).date() - timedelta(days=2)).isoformat()
    small = client.post(f"{API}/expenses", headers=jordan, json={"category": "Travel", "amount": 20, "date": day,
                                                                  "description": "Taxi to board meeting"})
    assert small.status_code == 201, small.text
    assert small.json()["status"] == "approved"  # nobody above the CEO: auto-approved, audited with the reason
    with SessionLocal() as db:
        audit = db.scalar(select(AuditLog).where(AuditLog.action == "approval_approved",
                                                 AuditLog.entity_id == small.json()["approval_instance_id"]))
        assert audit is not None and "top of the organisation" in ((audit.changes or {}).get("after") or {}).get("reason", "")

    with SessionLocal() as db:
        inst = engine.start(db, "expense", "x-big", db.get(Employee, "demo-ceo"), 300, compare_amount=30000)
        steps = inst.steps
        assert steps[0]["groups"]["manager"] == [] and steps[0]["skipped"]
        assert steps[1]["groups"]["finance"] == ["demo-hr-admin"]  # HR covers finance, never the IT admin
        assert "covered by" in steps[1]["label"]
        db.rollback()


def test_hr_heads_own_leave_goes_to_their_manager_not_admin():
    with SessionLocal() as db:
        engine.save_definition(db, "wf_rl_leave", [
            {"roles": ["manager"], "mode": "any", "label": "Manager"},
            {"roles": ["hr"], "mode": "any", "label": "HR", "only_if": "needs_hr"},
        ], "demo-admin")
        inst = engine.start(db, "wf_rl_leave", "lv", db.get(Employee, "demo-hr-admin"), context={"needs_hr": True},
                            fallback=False)
        assert inst.steps[0]["groups"]["manager"] == ["demo-ceo"]
        assert inst.steps[1]["skipped"] is True  # the CEO already approves step 1; the HR step is not re-routed
        assert all("demo-admin" not in ids for s in inst.steps for ids in s["groups"].values())
        db.rollback()


# ---------- nobody below the CEO changes his job, line, pay or employment ----------
def test_hr_and_admin_cannot_act_on_the_ceo(client, farhan, admin):
    later = (date.today() + timedelta(days=90)).isoformat()
    res = client.post(f"{API}/exits", headers=farhan, json={"employee_id": "demo-ceo", "exit_type": "termination",
                                                              "requested_last_day": later, "reason": "Performance"})
    assert res.status_code == 403 and "above you" in res.json()["detail"]
    for who in (farhan, admin):
        res = client.post(f"{API}/lifecycle/actions", headers=who, json={
            "employee_id": "demo-ceo", "action_type": "manager_change", "effective_date": date.today().isoformat(),
            "after": {"manager_id": "emp-ram"}, "reason": "Re-org"})
        assert res.status_code == 403, res.text
    # Farhan's own manager is the CEO: he can't demote him either
    res = client.post(f"{API}/lifecycle/actions", headers=farhan, json={
        "employee_id": "demo-ceo", "action_type": "job_change", "effective_date": date.today().isoformat(),
        "after": {"job_title": "Advisor"}, "reason": "Re-org"})
    assert res.status_code == 403
    assert client.post(f"{API}/compensation/bonuses", headers=farhan, json={
        "employee_id": "demo-ceo", "bonus_type": "Annual", "period": "2026", "amount": 1000}).status_code == 403


def test_pay_proposals_need_an_eligible_person(client, admin, farhan):
    today = date.today()
    cycle = client.post(f"{API}/compensation/cycles", headers=farhan, json={
        "name": f"Role rules {uuid.uuid4().hex[:6]}", "effective_date": (today + timedelta(days=400)).isoformat(),
        "budget_pct": 8, "opens_on": (today - timedelta(days=1)).isoformat(),
        "closes_on": (today + timedelta(days=30)).isoformat(), "status": "open"}).json()
    body = {"cycle_id": cycle["id"], "increase_pct": 25}
    res = client.post(f"{API}/compensation/proposals", headers=farhan, json=body | {"employee_id": "demo-ceo"})
    assert res.status_code == 403  # a raise for the CEO is the board's call
    contractor = _sample(Employee.employment_type == "Contract")
    assert client.post(f"{API}/compensation/proposals", headers=farhan,
                       json=body | {"employee_id": contractor}).status_code == 409
    leaver = _sample(Employee.employment_type == "Full-Time", Employee.joining_date < today - timedelta(days=800))
    with serving_notice(leaver):
        res = client.post(f"{API}/compensation/proposals", headers=farhan, json=body | {"employee_id": leaver})
        assert res.status_code == 409 and "notice" in res.json()["detail"]
        res = client.post(f"{API}/lifecycle/actions", headers=farhan, json={
            "employee_id": leaver, "action_type": "promotion", "effective_date": today.isoformat(),
            "after": {"grade": "G9"}, "reason": "Counter-offer"})
        assert res.status_code == 422 and "notice" in res.json()["detail"]


# ---------- paid overtime ----------
def test_overtime_not_for_executives_or_managers(client, jordan, ram):
    day = (date.today() - timedelta(days=3)).isoformat()
    res = client.post(f"{API}/overtime", headers=jordan, json={"work_date": day, "hours": 2, "reason": "Board pack"})
    assert res.status_code in (409, 422) and "executives" in res.json()["detail"]
    res = client.post(f"{API}/overtime", headers=ram, json={"work_date": day, "hours": 2, "reason": "Release", "outcome": "pay"})
    assert res.status_code in (409, 422) and "comp-off" in res.json()["detail"]
    with SessionLocal() as db:
        assert role_rules.overtime_block_reason(db, db.get(Employee, "emp-mahesh")) is None
        senior = db.scalar(select(Employee).where(Employee.grade == "G9").limit(1))
        assert senior is not None and role_rules.overtime_block_reason(db, senior)


# ---------- timesheet target follows the shift and part-time ----------
def test_timesheet_target_follows_the_shift_and_part_time():
    from app.services.timesheets import DAY_TARGET, full_day_hours

    with SessionLocal() as db:
        assert full_day_hours(db, db.get(Employee, "emp-mahesh")) == 9  # India: 9 h day (also the attendance auto-stop)
        assert full_day_hours(db, db.get(Employee, "emp-oliver")) == 7.5  # UK 09:00-17:30 minus the break
        part = db.scalar(select(Employee).where(Employee.employment_type == "Part-Time", Employee.country_code == "IN").limit(1))
        assert part is not None and full_day_hours(db, part) == 4.5
        assert all(full_day_hours(db, e) <= DAY_TARGET for e in db.scalars(select(Employee).limit(50)))


# ---------- internal jobs, reviews, notice period ----------
def test_internal_applications_blocked_for_ceo_probation_and_notice(client, jordan):
    with SessionLocal() as db:
        open_posts = [p for p in db.scalars(select(JobPosting).where(JobPosting.status == "open"))
                      if p.closing_date >= date.today() and (req := db.get(Requisition, p.requisition_id)) is not None
                      and req.status == "approved" and req.hiring_manager_id != "demo-ceo"]
    assert open_posts, "expected an open internal job in the sample data"
    url = f"{API}/recruiting/postings/{open_posts[0].id}/apply"
    res = client.post(url, headers=jordan, json={"cover_note": "Me"})
    assert res.status_code == 409 and "executives" in res.json()["detail"]
    with SessionLocal() as db:
        newbie = next(e.id for e in db.scalars(select(Employee).where(
            Employee.source == "hcm_sample", Employee.employment_status == "Active",
            Employee.joining_date >= date.today() - timedelta(days=400)).order_by(Employee.joining_date.desc()))
            if role_rules.in_probation(db, e, date.today()))
    res = client.post(url, headers=_account(newbie), json={"cover_note": "Keen"})
    assert res.status_code == 409 and "probation" in res.json()["detail"]
    leaver = _sample(Employee.employment_type == "Full-Time", Employee.joining_date < date.today() - timedelta(days=900))
    with serving_notice(leaver):
        res = client.post(url, headers=_account(leaver), json={"cover_note": "Keen"})
        assert res.status_code == 409 and "notice" in res.json()["detail"]


def test_no_review_for_the_ceo(client, farhan):
    cycles = client.get(f"{API}/performance/cycles", headers=farhan).json()
    open_cycle = next((c for c in cycles if c["status"] != "closed"), None)
    assert open_cycle
    res = client.get(f"{API}/performance/cycles/{open_cycle['id']}/reviews/demo-ceo", headers=farhan)
    # an existing (seeded) review is shown as is; a new one is never opened for someone nobody can rate
    assert res.status_code in (200, 409)
    if res.status_code == 409:
        assert "no manager" in res.json()["detail"]


# ---------- lifecycle applicability, notice by grade, grades, parental leave ----------
def test_lifecycle_actions_only_where_they_apply(client, farhan):
    today = date.today().isoformat()
    res = client.post(f"{API}/lifecycle/actions", headers=farhan, json={
        "employee_id": "emp-mahesh", "action_type": "probation_completion", "effective_date": today,
        "after": {}, "reason": "Confirm"})
    assert res.status_code == 422 and "probation" in res.json()["detail"]
    res = client.post(f"{API}/lifecycle/actions", headers=farhan, json={
        "employee_id": "emp-mahesh", "action_type": "contract_extension", "effective_date": today,
        "after": {"contract_end_date": "2027-12-31"}, "reason": "Extend"})
    assert res.status_code == 422 and "contract" in res.json()["detail"]


def test_notice_grades_and_parental_leave():
    from app.services.career import GRADE_LEVEL, LEADER_GRADES
    from app.services.exits import notice_days_for

    with SessionLocal() as db:
        assert notice_days_for(db, db.get(Employee, "demo-ceo")) == 90  # US at-will 14 days, raised for the E band
        assert notice_days_for(db, db.get(Employee, "emp-mahesh")) == 60  # India
        assert role_rules.is_executive(db, db.get(Employee, "demo-ceo"))
        assert role_rules.in_probation(db, db.get(Employee, "emp-mahesh"), date.today()) is False
        parental = db.get(LeaveType, "parental")
        assert parental is not None and parental.active
    assert all(f"G{i}" in GRADE_LEVEL for i in range(1, 10)) and GRADE_LEVEL["G9"] > GRADE_LEVEL["G3"]
    assert "G9" in LEADER_GRADES and "G3" not in LEADER_GRADES
