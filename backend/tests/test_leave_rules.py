"""Leave eligibility, leave admin (types, policies, holidays by calendar), year-end carry-forward, country config,
and the business unit / location data scopes (migration 0011)."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import func, select

from app.db import SessionLocal
from app.models import AuditLog, Country, Employee, LeaveCarryForward, LeavePolicy
from app.services import leave_rules
from tests.talent_helpers import token_for

L = "/api/v1/admin/leave"
A = "/api/v1/admin"


def admin():
    return token_for("demo-admin", "admin")


def _workday(days_ahead: int) -> date:
    day = datetime.now(ZoneInfo("Asia/Kolkata")).date() + timedelta(days=days_ahead)
    while day.weekday() >= 5:
        day += timedelta(days=1)
    return day


def _balances(client, headers, year: int | None = None) -> dict[str, dict]:
    params = {"year": year} if year else {}
    return {r["code"]: r for r in client.get("/api/v1/leave/balances", headers=headers, params=params).json()["balances"]}


def _apply(client, headers, code: str, start: date, end: date | None = None):
    end = end or start
    return client.post("/api/v1/leave/requests", headers=headers,
                       json={"leave_code": code, "from": start.isoformat(), "to": end.isoformat(), "reason": "Rule test"})


def _set_employee(employee_id: str, **values):
    with SessionLocal() as db:
        emp = db.get(Employee, employee_id)
        before = {k: getattr(emp, k) for k in values}
        for k, v in values.items():
            setattr(emp, k, v)
        db.commit()
    return before


def test_seeded_defaults_are_idempotent():
    with SessionLocal() as db:
        assert db.get(LeavePolicy, "maternity-IN-2026").gender == "female"
        assert db.get(LeavePolicy, "paternity-GB-2026").gender == "male"
        sab = db.get(LeavePolicy, "sabbatical-IN-2026")
        assert sab.min_service_months == 60 and sab.employment_types == ["Full-Time"] and sab.not_in_probation
        assert db.get(LeavePolicy, "pto-IN-2026").gender == "any"
        india = db.get(Country, "IN")
        assert india.probation_months == 6 and india.languages == ["en", "hi"] and "PAN" in india.required_documents
        count = db.scalar(select(func.count()).select_from(LeavePolicy))
        assert leave_rules.seed_defaults(db) == {"country_config_filled": 0, "leave_policies_added": 0, "leave_rules_defaulted": 0}
        assert db.scalar(select(func.count()).select_from(LeavePolicy)) == count
        db.rollback()


def test_balances_hide_other_gender_and_mark_ineligible(client, babu):
    rows = _balances(client, babu)
    assert "maternity" not in rows and rows["paternity"]["eligible"] is True  # Babu: male, India
    assert rows["sabbatical"]["eligible"] is True  # joined 2019, full-time
    assert "maternity" not in {p["code"] for p in client.get("/api/v1/leave/policies", headers=babu).json()}
    before = _set_employee("emp-mahesh", employment_type="Contract")
    try:
        row = _balances(client, babu)["sabbatical"]
        assert row["eligible"] is False and "Contract" in row["not_eligible_reason"]
        res = _apply(client, babu, "sabbatical", _workday(40))
        assert res.status_code == 422 and "Not open to Contract" in res.json()["detail"]
    finally:
        _set_employee("emp-mahesh", **before)


def test_apply_checks_gender_notice_max_and_probation(client, babu, farhan):
    res = _apply(client, babu, "maternity", _workday(20))
    assert res.status_code == 422 and res.json()["detail"] == "Maternity leave: Only for female employees."
    res = _apply(client, babu, "sabbatical", _workday(5))
    assert res.status_code == 422 and "30 days' notice" in res.json()["detail"]

    # A test type with tight limits, made through the admin API.
    assert client.post(f"{L}/types", headers=babu, json={"code": "rule_test", "name": "Rule test"}).status_code == 403
    res = client.post(f"{L}/types", headers=farhan, json={"code": "rule_test", "name": "Rule test leave", "half_day_allowed": False})
    assert res.status_code == 201, res.text
    assert client.post(f"{L}/types", headers=farhan, json={"code": "rule_test", "name": "Again"}).status_code == 409
    body = {"leave_code": "rule_test", "country_code": "IN", "name": "Rule test leave", "quota": 10,
            "effective_from": "2020-01-01", "max_per_request": 1, "min_notice_days": 3}
    res = client.post(f"{L}/policies", headers=farhan, json=body)
    assert res.status_code == 201, res.text
    policy = res.json()
    assert policy["gender"] == "any" and policy["active"] is True

    start = _workday(14)
    end = start + timedelta(days=1)
    while end.weekday() >= 5:
        end += timedelta(days=1)
    res = _apply(client, babu, "rule_test", start, end)
    assert res.status_code == 422 and res.json()["detail"] == "At most 1 day(s) of Rule test leave per request."
    res = client.post("/api/v1/leave/requests", headers=babu, json={"leave_code": "rule_test", "from": start.isoformat(),
                                                                   "to": start.isoformat(), "half": "first", "reason": "x"})
    assert res.status_code == 422 and "half day" in res.json()["detail"]
    res = _apply(client, babu, "rule_test", _workday(0))  # at most 2 calendar days ahead on any weekday
    assert res.status_code == 422 and "3 days' notice" in res.json()["detail"]

    # Probation: joined last month -> blocked (India probation is 6 months).
    res = client.put(f"{L}/policies/{policy['id']}", headers=farhan, json={"not_in_probation": True, "max_per_request": None})
    assert res.status_code == 200 and res.json()["max_per_request"] is None and res.json()["not_in_probation"] is True
    before = _set_employee("emp-mahesh", joining_date=date.today() - timedelta(days=30))
    try:
        assert _balances(client, babu)["rule_test"]["eligible"] is False
        res = _apply(client, babu, "rule_test", start)
        assert res.status_code == 422 and "probation" in res.json()["detail"]
    finally:
        _set_employee("emp-mahesh", **before)

    # Deactivated: gone from balances and can't be applied for.
    res = client.delete(f"{L}/policies/{policy['id']}", headers=farhan)
    assert res.status_code == 200 and res.json()["active"] is False
    assert "rule_test" not in _balances(client, babu)
    assert _apply(client, babu, "rule_test", start).status_code == 422
    assert client.delete(f"{L}/types/rule_test", headers=farhan).json()["active"] is False

    with SessionLocal() as db:
        actions = set(db.scalars(select(AuditLog.action).where(AuditLog.entity_id.in_(["rule_test", policy["id"]]))))
    assert {"leave_type_created", "leave_type_deactivated", "leave_policy_created", "leave_policy_updated",
            "leave_policy_deactivated"} <= actions


def test_policy_list_and_validation(client, farhan):
    rows = client.get(f"{L}/policies", headers=farhan, params={"country": "GB"}).json()
    assert rows and all(r["country_code"] == "GB" for r in rows)
    assert any(r["leave_code"] == "paternity" and r["gender"] == "male" for r in rows)
    pto = next(r for r in rows if r["leave_code"] == "pto")
    assert client.put(f"{L}/policies/{pto['id']}", headers=farhan, json={"carry_forward_max": 99}).status_code == 422
    res = client.post(f"{L}/policies", headers=farhan, json={"leave_code": "nope", "country_code": "GB", "name": "X",
                                                            "quota": 1, "effective_from": "2026-01-01"})
    assert res.status_code == 422
    assert {t["code"] for t in client.get(f"{L}/types", headers=farhan).json()} >= {"pto", "maternity", "sabbatical"}


def test_holidays_by_calendar(client, babu, farhan):
    cals = client.get(f"{L}/calendars", headers=farhan, params={"country": "IN"}).json()
    assert any(c["calendar"] == "India Standard" and c["employees"] > 0 for c in cals)
    day = _workday(60)
    holidays = {h["date"] for h in client.get("/api/v1/leave/holidays", headers=babu, params={"year": day.year}).json()}
    while day.isoformat() in holidays or day.weekday() >= 5:
        day += timedelta(days=1)
    mine = client.post(f"{L}/holidays", headers=farhan, json={"country_code": "IN", "date": day.isoformat(),
                                                              "name": "Office day off", "calendar": "India Standard"})
    other = client.post(f"{L}/holidays", headers=farhan, json={"country_code": "IN", "date": day.isoformat(),
                                                               "name": "Other site day off", "calendar": "India North"})
    assert mine.status_code == 201 and other.status_code == 201, (mine.text, other.text)
    dup = client.post(f"{L}/holidays", headers=farhan, json={"country_code": "IN", "date": day.isoformat(), "name": "x",
                                                             "calendar": "India Standard"})
    assert dup.status_code == 409
    try:
        listed = client.get("/api/v1/leave/holidays", headers=babu, params={"year": day.year}).json()
        names = {h["name"] for h in listed if h["date"] == day.isoformat()}
        assert names == {"Office day off"}  # Babu's calendar only
        res = _apply(client, babu, "casual", day)
        assert res.status_code == 422 and "no working days" in res.json()["detail"]
        res = client.put(f"{L}/holidays/{mine.json()['id']}", headers=farhan, json={"name": "Office closed"})
        assert res.status_code == 200 and res.json()["name"] == "Office closed"
        assert client.get(f"{L}/holidays", headers=babu).status_code == 403
        assert any(h["id"] == other.json()["id"] for h in
                   client.get(f"{L}/holidays", headers=farhan, params={"country": "IN", "calendar": "India North"}).json())
    finally:
        for h in (mine, other):
            assert client.delete(f"{L}/holidays/{h.json()['id']}", headers=farhan).json()["active"] is False
    listed = client.get("/api/v1/leave/holidays", headers=babu, params={"year": day.year}).json()
    assert day.isoformat() not in {h["date"] for h in listed}


def test_carry_forward_job_is_idempotent(client, babu, farhan):
    assert client.post(f"{L}/carry-forward/run", headers=babu, params={"year": 2030}).status_code == 403
    first = client.post(f"{L}/carry-forward/run", headers=farhan, params={"year": 2030}).json()
    assert first["year"] == 2030 and first["created"] > 0
    again = client.post(f"{L}/carry-forward/run", headers=farhan, params={"year": 2030}).json()
    assert again["created"] == 0 and again["skipped"] == first["created"]
    with SessionLocal() as db:
        row = db.scalar(select(LeaveCarryForward).where(LeaveCarryForward.employee_id == "emp-mahesh",
                                                        LeaveCarryForward.leave_code == "pto", LeaveCarryForward.to_year == 2030))
        assert row.days == 10 and row.unused == 18  # India cap 10, nothing used in 2029
        row.days = 3
        db.commit()
    assert _balances(client, babu, 2030)["pto"]["carried_over"] == 3  # the saved figure wins
    res = client.post(f"{A}/jobs/run", headers=admin())
    assert res.status_code == 200 and "leave_carry_forward" in res.json()["results"]


def test_country_config_get_and_put(client, babu, farhan):
    rows = {c["code"]: c for c in client.get("/api/v1/countries", headers=babu).json()}
    assert rows["SA"]["work_week_days"] == ["Sun", "Mon", "Tue", "Wed", "Thu"] and rows["GB"]["standard_daily_hours"] == 7.5
    assert client.put("/api/v1/countries/DE", headers=farhan, json={"notice_days": 30}).status_code == 403
    before = rows["DE"]
    try:
        res = client.put("/api/v1/countries/DE", headers=admin(), json={
            "notice_days": 90, "probation_months": 4, "work_week_days": ["Fri", "Mon", "Tue"],
            "required_documents": ["Tax ID", " Tax ID ", "Passport"], "workflow_notes": " Works council first. "})
        assert res.status_code == 200, res.text
        out = res.json()
        assert out["notice_days"] == 90 and out["work_week_days"] == ["Mon", "Tue", "Fri"]
        assert out["required_documents"] == ["Tax ID", "Passport"] and out["workflow_notes"] == "Works council first."
        assert client.put("/api/v1/countries/DE", headers=admin(), json={"work_week_days": ["Funday"]}).status_code == 422
        assert client.put("/api/v1/countries/XX", headers=admin(), json={"notice_days": 1}).status_code == 404
        with SessionLocal() as db:
            assert db.scalar(select(AuditLog.id).where(AuditLog.action == "country_config_updated", AuditLog.entity_id == "DE"))
    finally:
        client.put("/api/v1/countries/DE", headers=admin(), json={k: before[k] for k in leave_rules.COUNTRY_CONFIG_FIELDS})


def test_business_unit_and_location_scopes(client, babu):
    before = _set_employee("emp-mahesh", business_unit="Technology")  # a unit with people in other locations
    try:
        _check_unit_and_location_scopes(client, babu)
    finally:
        _set_employee("emp-mahesh", **before)


def _check_unit_and_location_scopes(client, babu):
    with SessionLocal() as db:
        me = db.get(Employee, "emp-mahesh")
        def pick(**same):
            stmt = select(Employee.id).where(Employee.id.not_in(["emp-mahesh", "emp-ram"]), Employee.manager_id != "emp-mahesh")
            for col, keep in same.items():
                stmt = stmt.where((getattr(Employee, col) == getattr(me, col)) if keep else (getattr(Employee, col) != getattr(me, col)))
            return db.scalar(stmt.limit(1))
        same_location = pick(location=True, business_unit=False)
        same_unit = pick(business_unit=True, location=False)
    assert same_location and same_unit
    seen = lambda emp_id: client.get("/api/v1/leave/balances", headers=babu, params={"employee_id": emp_id}).status_code  # noqa: E731
    assert seen(same_location) == 404 and seen(same_unit) == 404
    try:
        assert client.put(f"{A}/accounts/emp-mahesh/data-scope", headers=admin(), json={"scope": "location"}).status_code == 200
        assert seen(same_location) == 200 and seen(same_unit) == 404
        res = client.put(f"{A}/accounts/emp-mahesh/data-scope", headers=admin(), json={"scope": "business_unit"})
        assert res.status_code == 200 and res.json()["scope"] == "business_unit"
        assert seen(same_unit) == 200 and seen(same_location) == 404
    finally:
        client.put(f"{A}/accounts/emp-mahesh/data-scope", headers=admin(), json={"scope": "line"})
    assert seen(same_unit) == 404
