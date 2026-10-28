import re

import pytest
from sqlalchemy import func, select

from app.db import SessionLocal
from app.models import AuditLog, Employee, JobFamily, JobProfile, OrgUnit
from app.security import create_access_token
from app.services.org import seed_org_from_employees

API = "/api/v1/org"


def token_for(account_id: str, role: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(account_id, role)[0]}"}


@pytest.fixture(scope="module")
def admin():
    return token_for("demo-admin", "admin")


def test_seed_derived_from_employees_and_idempotent(client, babu):
    with SessionLocal() as db:
        departments = set(db.scalars(select(Employee.department).distinct()))
        locations = set(db.scalars(select(Employee.location).distinct()))
        titles = set(db.scalars(select(Employee.job_title).distinct()))
        before = seed_org_from_employees(db)
        db.commit()
        again = seed_org_from_employees(db)
        db.commit()
        assert before == again
        assert db.scalar(select(func.count()).select_from(JobProfile)) >= len(titles)
        company = db.scalar(select(OrgUnit).where(OrgUnit.code == "TIMEZ"))
        assert company.type == "company" and company.parent_id is None
    units = client.get(f"{API}/units", headers=babu).json()  # everyone can read
    by_type: dict[str, set[str]] = {}
    for u in units:
        by_type.setdefault(u["type"], set()).add(u["name"])
    assert departments <= by_type["department"] and locations <= by_type["location"]
    assert {"legal_entity", "business_unit", "cost_centre"} <= set(by_type)
    dubai = next(u for u in units if u["type"] == "location" and u["name"] == "Dubai")
    assert dubai["country_code"] == "AE" and dubai["parent_id"]
    eng = client.get(f"{API}/units", headers=babu, params={"type": "department", "q": "engineer"}).json()
    assert [u["name"] for u in eng] == ["Engineering"]
    families = {f["name"] for f in client.get(f"{API}/job-families", headers=babu).json()}
    assert "Engineering" in families
    profiles = client.get(f"{API}/job-profiles", headers=babu, params={"q": "software engineer"}).json()
    assert profiles and all(p["family_id"] for p in profiles)


def test_only_hr_and_admin_change(client, babu, ram):
    body = {"code": "TEAM-X", "name": "X", "type": "team"}
    assert client.post(f"{API}/units", headers=babu, json=body).status_code == 403
    assert client.post(f"{API}/units", headers=ram, json=body).status_code == 403
    assert client.post(f"{API}/job-families", headers=ram, json={"code": "JF-X", "name": "X"}).status_code == 403
    assert client.post(f"{API}/positions", headers=babu, json={"profile_id": "x", "country_code": "IN"}).status_code == 403
    assert client.get(f"{API}/positions", headers=babu).status_code == 200


def test_units_crud_and_rules(client, farhan, admin):
    company = client.get(f"{API}/units", headers=farhan, params={"type": "company"}).json()[0]
    res = client.post(f"{API}/units", headers=farhan, json={"code": "DEPT-QA-LAB", "name": "QA Lab", "type": "department",
                                                            "parent_id": company["id"]})
    assert res.status_code == 201, res.text
    dept = res.json()
    assert client.post(f"{API}/units", headers=farhan, json={"code": "DEPT-QA-LAB", "name": "Dup", "type": "department"}).status_code == 409
    assert client.post(f"{API}/units", headers=farhan, json={"code": "bad code", "name": "B", "type": "team"}).status_code == 422
    assert client.post(f"{API}/units", headers=farhan, json={"code": "T-1", "name": "B", "type": "squad"}).status_code == 422
    assert client.post(f"{API}/units", headers=farhan, json={"code": "T-2", "name": "B", "type": "team", "parent_id": "nope"}).status_code == 422
    assert client.post(f"{API}/units", headers=farhan, json={"code": "CO-2", "name": "B", "type": "company",
                                                              "parent_id": company["id"]}).status_code == 422
    team = client.post(f"{API}/units", headers=admin, json={"code": "TEAM-QA-AUTO", "name": "QA Automation", "type": "team",
                                                            "parent_id": dept["id"]}).json()
    # loop: the department can't move under its own team
    assert client.patch(f"{API}/units/{dept['id']}", headers=farhan, json={"parent_id": team["id"]}).status_code == 422
    res = client.patch(f"{API}/units/{team['id']}", headers=farhan, json={"name": "QA Automation Guild"})
    assert res.status_code == 200 and res.json()["name"] == "QA Automation Guild"
    assert client.post(f"{API}/units/{dept['id']}/deactivate", headers=farhan).status_code == 409  # active child
    assert client.post(f"{API}/units/{team['id']}/deactivate", headers=farhan).json()["active"] is False
    assert client.post(f"{API}/units/{dept['id']}/deactivate", headers=farhan).json()["active"] is False
    assert team["id"] not in {u["id"] for u in client.get(f"{API}/units", headers=farhan).json()}
    assert team["id"] in {u["id"] for u in client.get(f"{API}/units", headers=farhan, params={"active": False}).json()}
    with SessionLocal() as db:
        actions = list(db.scalars(select(AuditLog.action).where(AuditLog.entity_id == team["id"]).order_by(AuditLog.id)))
        assert actions == ["org_unit_created", "org_unit_updated", "org_unit_updated"]


def test_families_and_profiles(client, farhan):
    res = client.post(f"{API}/job-families", headers=farhan, json={"code": "JF-DATA-SCI", "name": "Data Science"})
    assert res.status_code == 201
    fam = res.json()
    assert client.post(f"{API}/job-families", headers=farhan, json={"code": "JF-DATA-2", "name": "Data Science"}).status_code == 409
    res = client.post(f"{API}/job-profiles", headers=farhan, json={
        "code": "JP-DATA-SCIENTIST", "title": "Data Scientist", "family_id": fam["id"], "grade": "G5",
        "description": "Builds models", "required_skills": ["Python", "python", "SQL"], "preferred_skills": ["Spark"],
    })
    assert res.status_code == 201, res.text
    prof = res.json()
    assert prof["required_skills"] == ["Python", "SQL"]
    assert client.post(f"{API}/job-profiles", headers=farhan, json={"code": "JP-X", "title": "X", "family_id": "nope"}).status_code == 422
    res = client.patch(f"{API}/job-profiles/{prof['id']}", headers=farhan, json={"preferred_skills": ["Spark", "MLOps"]})
    assert res.json()["preferred_skills"] == ["Spark", "MLOps"]
    assert client.post(f"{API}/job-families/{fam['id']}/deactivate", headers=farhan).status_code == 409  # active profile
    assert client.post(f"{API}/job-profiles/{prof['id']}/deactivate", headers=farhan).json()["active"] is False
    assert client.post(f"{API}/job-families/{fam['id']}/deactivate", headers=farhan).json()["active"] is False
    assert client.get(f"{API}/job-profiles/{prof['id']}", headers=farhan).json()["active"] is False


def test_positions(client, farhan, babu):
    with SessionLocal() as db:
        profile = db.scalar(select(JobProfile).where(JobProfile.title == "Software Engineer"))
        eng = db.scalar(select(OrgUnit).where(OrgUnit.type == "department", OrgUnit.name == "Engineering"))
        blr = db.scalar(select(OrgUnit).where(OrgUnit.type == "location", OrgUnit.name == "Bengaluru"))
        assert db.scalar(select(JobFamily).where(JobFamily.id == profile.family_id)) is not None
    body = {"profile_id": profile.id, "department_id": eng.id, "location_id": blr.id, "country_code": "IN",
            "manager_id": "emp-ram", "headcount": 2}
    res = client.post(f"{API}/positions", headers=farhan, json=body)
    assert res.status_code == 201, res.text
    pos = res.json()
    assert re.fullmatch(r"TIMEZ-ENG-IND-\d{5}", pos["code"]) and pos["status"] == "open"
    assert pos["grade"] == profile.grade and pos["title"] == "Software Engineer"
    second = client.post(f"{API}/positions", headers=farhan, json=body).json()
    assert int(second["code"][-5:]) == int(pos["code"][-5:]) + 1
    assert client.post(f"{API}/positions", headers=farhan, json=body | {"code": pos["code"]}).status_code == 409
    assert client.post(f"{API}/positions", headers=farhan, json=body | {"department_id": blr.id}).status_code == 422
    assert client.post(f"{API}/positions", headers=farhan, json=body | {"filled": 3}).status_code == 422
    assert client.post(f"{API}/positions", headers=farhan, json=body | {"manager_id": "nobody"}).status_code == 422
    assert client.post(f"{API}/positions", headers=farhan, json=body | {"country_code": "ZZ"}).status_code == 422

    res = client.patch(f"{API}/positions/{pos['id']}", headers=farhan, json={"filled": 2})
    assert res.json()["status"] == "filled"
    assert client.patch(f"{API}/positions/{pos['id']}", headers=farhan, json={"headcount": 1}).status_code == 422
    assert client.post(f"{API}/positions/{pos['id']}/deactivate", headers=farhan).status_code == 409  # still filled
    res = client.patch(f"{API}/positions/{pos['id']}", headers=farhan, json={"filled": 0, "status": "frozen"})
    assert res.json()["status"] == "frozen"
    assert client.patch(f"{API}/positions/{pos['id']}", headers=farhan, json={"status": "open"}).json()["status"] == "open"
    assert client.post(f"{API}/positions/{pos['id']}/deactivate", headers=farhan).json()["active"] is False
    listed = client.get(f"{API}/positions", headers=babu, params={"country": "in", "department_id": eng.id}).json()
    assert second["id"] in {p["id"] for p in listed} and pos["id"] not in {p["id"] for p in listed}
    assert client.get(f"{API}/positions/{pos['id']}", headers=babu).status_code == 200
    # an org unit with active positions can't be deactivated
    assert client.post(f"{API}/units/{blr.id}/deactivate", headers=farhan).status_code == 409
