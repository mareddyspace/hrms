"""Onboarding checklist scoping, the pre-boarding form, onboarding analytics and the payroll integration-status tab."""

from datetime import date

import pytest
from sqlalchemy import select

from app.db import SessionLocal
from app.models import Account, OnboardingTemplateTask
from app.services.onboarding import template_for
from tests.conftest import login
from tests.talent_helpers import hire, token_for

O = "/api/v1/onboarding"


@pytest.fixture(scope="module")
def sophie(client):
    return login(client, "sophie.clark@timez.com")


@pytest.fixture(scope="module")
def jordan(client):
    return login(client, "jordan.blake@timez.com")


@pytest.fixture(scope="module")
def admin():
    return token_for("demo-admin", "admin")


def _joiner_login(employee_id: str) -> dict[str, str]:
    with SessionLocal() as db:
        acc_id = f"acc-{employee_id.lower()}"
        if db.get(Account, acc_id) is None:
            db.add(Account(id=acc_id, email=f"{employee_id.lower()}@timez.example", password_hash="x", role="employee",
                           employee_id=employee_id, active=True, failed_attempts=0))
            db.commit()
    return token_for(acc_id, "employee")


def test_seeded_templates_are_scoped_and_idempotent():
    with SessionLocal() as db:
        rows = list(db.scalars(select(OnboardingTemplateTask)))
        keys = {(r.country_code, r.legal_entity, r.employment_type, r.key) for r in rows}
        assert len(keys) == len(rows)  # seed ran twice: no duplicates
        default = {t["key"]: t for t in template_for(db, "CA")}
        assert len(default) == 10 and default["hr_docs"]["title"] == "HR documentation"
        assert default["first_week_review"]["depends_on"] == ["orientation", "team_intro"]
        assert all(t["owner_role"] in {"hr", "it", "manager", "employee"} for t in default.values())
        india = {t["key"]: t for t in template_for(db, "IN", "TimeZ India Pvt Ltd", "Contract")}
        assert "PAN" in india["hr_docs"]["title"]  # country row
        assert "POSH" in india["policy_training"]["title"]  # legal entity row
        assert "contractor" in india["mandatory_learning"]["title"]  # employment type row
        assert "POSH" not in {t["key"]: t for t in template_for(db, "IN", "Other Entity", "Full-Time")}["policy_training"]["title"]


def test_preboarding_form_creates_tasks(client, babu, ram, farhan, sophie):
    _, joiner = hire(client, sophie, ram, farhan, "Priya Nair", "priya.nair.pb@example.com", start_in_days=20)
    form = {
        "personal": {"confirmed": True, "preferred_name": "Priya", "mobile": "+91 90000 00000"},
        "emergency_contact": {"name": "Anil Nair", "relationship": "Father", "phone": "+91 90000 11111"},
        "equipment": ["laptop", "monitor", "headset"],
        "it_request": {"systems": ["VPN", "Jira"], "notes": "Needs Figma too"},
    }
    url = f"{O}/joiners/{joiner['id']}/preboarding"
    assert client.put(url, headers=babu, json=form).status_code == 404  # not visible
    assert client.put(url, headers=ram, json=form).status_code == 403  # manager can't fill it in
    assert client.put(url, headers=farhan, json={**form, "equipment": ["printer"]}).status_code == 422
    me = _joiner_login(joiner["employee_id"])
    res = client.put(url, headers=me, json=form)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["preboarding"]["emergency_contact"]["name"] == "Anil Nair" and body["preboarding_at"]
    keys = {t["key"]: t for t in body["tasks"]}
    assert {"equip_monitor", "equip_headset", "it_request"} <= set(keys) and "equip_laptop" not in keys
    assert keys["equip_monitor"]["owner_role"] == "it" and keys["it_request"]["depends_on"] == ["it_account"]
    assert "VPN, Jira" in keys["it_request"]["title"]
    # resubmitting does not duplicate tasks; HR can update it
    res = client.put(url, headers=farhan, json={**form, "equipment": ["monitor"]})
    assert res.status_code == 200
    assert sum(t["key"] == "equip_monitor" for t in res.json()["tasks"]) == 1
    assert res.json()["status"] == "pre_boarding"


def test_onboarding_analytics(client, babu, ram, farhan, jordan, admin):
    assert client.get(f"{O}/analytics", headers=babu).status_code == 403
    assert client.get(f"{O}/analytics", headers=ram).status_code == 403
    res = client.get(f"{O}/analytics", headers=farhan)
    assert res.status_code == 200, res.text
    a = res.json()
    assert a["total_joiners"] >= 1
    assert sum(m["count"] for m in a["joiners_by_month"]) == a["total_joiners"]
    assert sum(c["count"] for c in a["joiners_by_country"]) == a["total_joiners"]
    assert a["preboarding_count"] + a["onboarding_count"] + a["completed_count"] == a["total_joiners"]
    assert 0 <= a["completion_pct"] <= 100 and a["tasks_total"] >= a["tasks_done"]
    assert a["overdue_total"] == sum(o["count"] for o in a["overdue_by_owner"])
    assert client.get(f"{O}/analytics", headers=jordan).status_code == 200
    assert client.get(f"{O}/analytics", headers=admin).status_code == 200
    assert client.get(f"{O}/analytics?country=ZZ", headers=farhan).json()["total_joiners"] == 0


def test_payroll_status(client, babu, ram, farhan, admin):
    assert client.get("/api/v1/payroll/status", headers=babu).status_code == 403
    assert client.get("/api/v1/payroll/status", headers=ram).status_code == 403
    res = client.get("/api/v1/payroll/status", headers=farhan)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["period"] == date.today().strftime("%Y-%m")
    assert body["rows"] and {"IN", "US"} <= {r["country_code"] for r in body["rows"]}
    row = next(r for r in body["rows"] if r["country_code"] == "IN")
    for field in ("provider", "connection_status", "integration_status", "last_sync_at", "payroll_period",
                  "integration_health", "configuration_status", "legal_entity"):
        assert field in row
    assert row["employees"] == sum(row["payroll_status_counts"].values())
    assert sum(body["totals"].values()) == sum(r["employees"] for r in body["rows"])
    assert client.get("/api/v1/payroll/status", headers=admin).status_code == 200


def test_payroll_providers_config(client, babu, farhan, admin):
    rows = client.get("/api/v1/payroll/status", headers=farhan).json()["rows"]
    assert all(r["provider"] == "Not set" and r["configuration_status"] == "Incomplete" for r in rows)
    assert client.get("/api/v1/payroll/providers", headers=babu).status_code == 403
    assert client.get("/api/v1/payroll/providers", headers=farhan).json()["providers"] == {}
    assert client.put("/api/v1/payroll/providers", headers=farhan, json={"providers": {"IN": "X"}}).status_code == 403
    assert client.put("/api/v1/payroll/providers", headers=admin, json={"providers": {"ZZ": "X"}}).status_code == 422
    res = client.put("/api/v1/payroll/providers", headers=admin, json={"providers": {"in": " Acme Payroll ", "US": ""}})
    assert res.status_code == 200 and res.json()["providers"] == {"IN": "Acme Payroll"}
    rows = client.get("/api/v1/payroll/status", headers=farhan).json()["rows"]
    assert all(r["provider"] == ("Acme Payroll" if r["country_code"] == "IN" else "Not set") for r in rows)
    assert client.put("/api/v1/payroll/providers", headers=admin, json={"providers": {}}).json()["providers"] == {}
