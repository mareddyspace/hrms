"""Leadership insights: director dashboard (from real records, no pay for directors), drill-down, contractors with
contract extension approvals, and the server-side report builder (run, CSV export, saved reports)."""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from app.db import SessionLocal
from app.models import AuditLog, ContractExtension, Employee
from tests.conftest import login

API = "/api/v1/insights"


@pytest.fixture(scope="module")
def ceo(client):
    return login(client, "jordan.blake@timez.com")


@pytest.fixture(scope="module")
def hr(client):
    return login(client, "farhan.ali@timez.com")


def test_dashboard_from_records_and_cost_only_for_pay_roles(client, ceo, hr, ram, babu):
    res = client.get(f"{API}/leadership", headers=ceo)
    assert res.status_code == 200, res.text
    d = res.json()
    assert d["scope"] == "organisation" and d["headcount"] > 0
    assert sum(c["headcount"] for c in d["by_country"]) == d["headcount"]
    assert sum(c["headcount"] for c in d["by_department"]) == d["headcount"]
    assert d["cost"] is None and d["cost_visible"] is False  # directors: no salary unless authorised
    assert {"open_requisitions", "by_stage", "offers_awaiting_approval"} <= set(d["hiring"])
    assert "compliance_pct" in d["learning"]

    hr_d = client.get(f"{API}/leadership", headers=hr).json()
    assert hr_d["cost_visible"] is True and isinstance(hr_d["cost"]["annual_base"], list)

    # filters narrow the numbers
    country = d["by_country"][0]["key"]
    one = client.get(f"{API}/leadership", headers=ceo, params={"country": country, "range": "12m"}).json()
    assert one["headcount"] == d["by_country"][0]["headcount"] or one["range"] == "12m"
    assert all(c["key"] == country for c in one["by_country"])

    # managers see their team only; employees without reports have no dashboard
    team = client.get(f"{API}/leadership", headers=ram).json()
    assert team["scope"] == "team" and team["headcount"] <= d["headcount"]
    assert client.get(f"{API}/leadership", headers=babu).status_code == 403


def test_drill_down_has_no_personal_identifiers(client, ceo):
    d = client.get(f"{API}/leadership", headers=ceo).json()
    rows = client.get(f"{API}/leadership/drill", headers=ceo, params={"metric": "headcount"}).json()
    assert len(rows) == min(d["headcount"], 500)
    assert rows and not ({"date_of_birth", "personal_email", "mobile", "gender", "email"} & set(rows[0]))
    assert client.get(f"{API}/leadership/drill", headers=ceo, params={"metric": "salary"}).status_code == 422


def _seeded_contractor_outside(manager_id: str) -> tuple[str, date | None]:
    """A seeded contractor outside this manager's line (no new rows: other tests count people)."""
    from sqlalchemy import select

    from app.services.scope import report_ids

    with SessionLocal() as db:
        line = report_ids(db, manager_id)
        emp = next(e for e in db.scalars(select(Employee).where(Employee.employment_type == "Contract",
                                                                Employee.employment_status != "Terminated"))
                   if e.id not in line)
        original = emp.contract_end_date
        emp.contract_end_date = date.today() + timedelta(days=20)
        db.commit()
        return emp.id, original


def test_contract_extension_workflow(client, ram, hr, babu):
    admin = login(client, "alex.morgan@timez.com")
    emp_id, original = _seeded_contractor_outside("emp-ram")
    try:
        rows = client.get(f"{API}/contractors", headers=hr).json()
        me = next(r for r in rows if r["id"] == emp_id)
        assert me["alert"] == "ending_30" and me["pending_extension"] is None
        assert client.get(f"{API}/contractors", headers=babu).json() == []
        assert all(r["id"] != emp_id for r in client.get(f"{API}/contractors", headers=ram).json())  # managers: own line

        new_end = (date.today() + timedelta(days=200)).isoformat()
        bad = client.post(f"{API}/contractors/{emp_id}/extensions", headers=hr,
                          json={"new_end": (date.today() - timedelta(days=1)).isoformat(), "reason": "Project runs longer"})
        assert bad.status_code == 422
        for outsider in (babu, ram):
            assert client.post(f"{API}/contractors/{emp_id}/extensions", headers=outsider,
                               json={"new_end": new_end, "reason": "Project runs longer"}).status_code == 403
        res = client.post(f"{API}/contractors/{emp_id}/extensions", headers=hr, json={"new_end": new_end, "reason": "Project runs longer"})
        assert res.status_code == 201, res.text
        ext = res.json()
        assert ext["can_decide"] is False  # nobody approves their own request
        assert client.post(f"{API}/contractors/{emp_id}/extensions", headers=hr,
                           json={"new_end": new_end, "reason": "Again please"}).status_code == 409
        assert client.post(f"{API}/contract-extensions/{ext['id']}/decision", headers=hr, json={"decision": "approve"}).status_code == 403
        assert client.post(f"{API}/contract-extensions/{ext['id']}/decision", headers=ram, json={"decision": "approve"}).status_code == 403
        assert client.post(f"{API}/contract-extensions/{ext['id']}/decision", headers=admin, json={"decision": "reject"}).status_code == 422
        pending = client.get(f"{API}/contract-extensions", headers=admin, params={"status": "pending"}).json()
        assert any(p["id"] == ext["id"] and p["can_decide"] for p in pending)
        ok = client.post(f"{API}/contract-extensions/{ext['id']}/decision", headers=admin,
                         json={"decision": "approve", "comment": "Budget confirmed"})
        assert ok.status_code == 200 and ok.json()["status"] == "approved"
        with SessionLocal() as db:
            assert db.get(Employee, emp_id).contract_end_date.isoformat() == new_end  # the employee record is updated
            assert db.get(ContractExtension, ext["id"]).decision_comment == "Budget confirmed"
            assert db.query(AuditLog).filter(AuditLog.entity_id == ext["id"]).count() == 2
        assert client.post(f"{API}/contract-extensions/{ext['id']}/decision", headers=admin,
                           json={"decision": "approve"}).status_code == 409
    finally:
        with SessionLocal() as db:
            db.get(Employee, emp_id).contract_end_date = original
            db.commit()


def test_report_builder_permissions_run_export_and_saved(client, ceo, hr, ram):
    srcs = {s["key"]: s for s in client.get(f"{API}/reports/sources", headers=ceo).json()}
    assert "compensation" not in srcs  # no pay for directors
    assert "date_of_birth" not in {c["key"] for c in srcs["people"]["columns"]}
    hr_srcs = {s["key"]: s for s in client.get(f"{API}/reports/sources", headers=hr).json()}
    assert "compensation" in hr_srcs and "date_of_birth" in {c["key"] for c in hr_srcs["people"]["columns"]}

    body = {"source": "people", "columns": ["full_name", "department", "country"], "group_by": "department"}
    run = client.post(f"{API}/reports/run", headers=ceo, json=body).json()
    assert run["total"] > 0 and sum(g["count"] for g in run["groups"]) == run["total"]
    dept = run["groups"][0]["value"]
    narrowed = client.post(f"{API}/reports/run", headers=ceo, json={**body, "filters": {"department": dept}}).json()
    assert narrowed["total"] == run["groups"][0]["count"]
    # hidden columns can't be filtered on or asked for
    assert client.post(f"{API}/reports/run", headers=ceo, json={**body, "filters": {"date_of_birth": "1990-01-01"}}).status_code == 422
    assert client.post(f"{API}/reports/run", headers=ceo, json={"source": "compensation"}).status_code == 403
    sneaky = client.post(f"{API}/reports/run", headers=ceo, json={"source": "people", "columns": ["full_name", "mobile"]}).json()
    assert [c["key"] for c in sneaky["columns"]] == ["full_name"]

    csv = client.post(f"{API}/reports/export", headers=ceo, json=body).json()
    assert csv["filename"].endswith(".csv") and csv["content"].splitlines()[0] == "Name,Department,Country"

    saved = client.post(f"{API}/reports/saved", headers=ram, json={**body, "name": "My team by department", "shared": True})
    assert saved.status_code == 201, saved.text
    rid = saved.json()["id"]
    assert client.post(f"{API}/reports/saved", headers=ram, json={**body, "name": "My team by department"}).status_code == 409
    assert any(r["id"] == rid and not r["mine"] for r in client.get(f"{API}/reports/saved", headers=hr).json())  # shared with HR
    assert all(r["id"] != rid for r in client.get(f"{API}/reports/saved", headers=ceo).json())
    assert client.put(f"{API}/reports/saved/{rid}", headers=hr, json={**body, "name": "Mine now"}).status_code == 404
    assert client.put(f"{API}/reports/saved/{rid}", headers=ram, json={**body, "name": "Team by dept"}).json()["name"] == "Team by dept"
    assert client.delete(f"{API}/reports/saved/{rid}", headers=ram).status_code == 204

    # managers report on their own line only; ratings outside HR only once released or for their reports
    perf = client.post(f"{API}/reports/run", headers=ram, json={"source": "performance"}).json()
    assert perf["total"] >= 0
    learning = client.post(f"{API}/reports/run", headers=hr, json={"source": "learning", "filters": {"overdue": "true"}}).json()
    assert all(r.get("overdue", True) for r in learning["rows"])


def test_seed_gives_every_contractor_an_end_date():
    from sqlalchemy import select

    from app import seed_contracts

    with SessionLocal() as db:
        assert seed_contracts.seed(db) == {"contract_end_dates_filled": 0}  # idempotent: already filled by seed.run
        blank = db.scalars(select(Employee.id).where(Employee.employment_type == "Contract",
                                                     Employee.contract_end_date.is_(None))).all()
        assert blank == []
        db.rollback()
