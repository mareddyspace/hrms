"""Effective-dated org units, job profiles and positions: history, as-of views, new fields and assignment placement."""

from datetime import date, timedelta

from sqlalchemy import select

from app.db import SessionLocal
from app.models import EmployeeAssignment, JobProfile, OrgUnit

API = "/api/v1/org"


def test_unit_history_and_as_of(client, farhan, babu):
    today = date.today()
    d0, d1, d2 = today - timedelta(days=100), today - timedelta(days=50), today - timedelta(days=10)
    company = client.get(f"{API}/units", headers=farhan, params={"type": "company"}).json()[0]
    res = client.post(f"{API}/units", headers=farhan, json={
        "code": "SUP-OPS-HUB", "name": "Ops Hub", "type": "supervisory_org", "effective_from": d0.isoformat(),
        "manager_id": "emp-ram", "headcount": 8,
    })
    assert res.status_code == 201, res.text
    unit = res.json()
    assert unit["effective_from"] == d0.isoformat() and unit["manager_id"] == "emp-ram"
    assert client.post(f"{API}/units", headers=farhan, json={"code": "CTRY-XX", "name": "Nowhere", "type": "country",
                                                              "parent_id": company["id"]}).status_code == 201
    assert client.patch(f"{API}/units/{unit['id']}", headers=farhan, json={
        "name": "Ops Centre", "headcount": 12, "effective_from": d1.isoformat(), "reason": "Renamed"}).status_code == 200
    assert client.patch(f"{API}/units/{unit['id']}", headers=farhan, json={
        "parent_id": company["id"], "effective_from": d2.isoformat()}).status_code == 200
    # can't date a change before the open version, or in the future
    assert client.patch(f"{API}/units/{unit['id']}", headers=farhan, json={
        "name": "Too early", "effective_from": d1.isoformat()}).status_code == 422
    assert client.patch(f"{API}/units/{unit['id']}", headers=farhan, json={
        "name": "Later", "effective_from": (today + timedelta(days=3)).isoformat()}).status_code == 422

    history = client.get(f"{API}/units/{unit['id']}/history", headers=babu).json()  # everyone can read
    assert [v["effective_from"] for v in history] == [d2.isoformat(), d1.isoformat(), d0.isoformat()]
    assert history[0]["effective_to"] is None and history[1]["effective_to"] == (d2 - timedelta(days=1)).isoformat()
    assert set(history[1]["changed_fields"]) == {"headcount", "name"} and history[1]["reason"] == "Renamed"
    assert history[0]["changed_fields"] == ["parent_id"] and history[2]["change"] == "created"
    assert history[2]["snapshot"]["name"] == "Ops Hub" and history[0]["changed_by_name"]

    def as_of(day: date) -> dict | None:
        rows = client.get(f"{API}/units", headers=babu, params={"as_of": day.isoformat(), "type": "supervisory_org"}).json()
        return next((r for r in rows if r["id"] == unit["id"]), None)

    assert as_of(d0 - timedelta(days=1)) is None
    assert as_of(d0 + timedelta(days=1))["name"] == "Ops Hub"
    mid = as_of(d1 + timedelta(days=1))
    assert mid["name"] == "Ops Centre" and mid["parent_id"] is None and mid["headcount"] == 12
    assert as_of(today)["parent_id"] == company["id"]

    res = client.post(f"{API}/units/{unit['id']}/deactivate", headers=farhan, json={"reason": "Merged"})
    assert res.status_code == 200 and res.json()["effective_to"] == (today - timedelta(days=1)).isoformat()
    assert as_of(today) is None and as_of(today - timedelta(days=1)) is not None
    assert client.get(f"{API}/units/{unit['id']}/history", headers=babu).json()[0]["change"] == "deactivated"


def test_seeded_records_have_baseline_history(client, babu):
    with SessionLocal() as db:
        company = db.scalar(select(OrgUnit).where(OrgUnit.code == "TIMEZ"))
        assert company.effective_from is not None
        countries = list(db.scalars(select(OrgUnit).where(OrgUnit.type == "country")))
        assert {"IN"} <= {c.country_code for c in countries}
    history = client.get(f"{API}/units/{company.id}/history", headers=babu).json()
    assert len(history) == 1 and history[0]["change"] == "baseline"
    # the tree as it stood before anything had history still shows seeded units
    old = client.get(f"{API}/units", headers=babu, params={"as_of": company.effective_from.isoformat()}).json()
    assert company.id in {u["id"] for u in old}


def test_job_profile_fields_and_history(client, farhan):
    today = date.today()
    body = {"code": "JP-SRE-LEAD", "title": "SRE Lead", "grade": "G6", "job_level": "L6", "experience_min_years": 6,
            "experience_max_years": 10, "education": "B.Tech or equivalent",
            "responsibilities": ["Own uptime", " ", "Lead on-call"], "effective_from": (today - timedelta(days=30)).isoformat()}
    assert client.post(f"{API}/job-profiles", headers=farhan, json=body | {"code": "JP-BAD", "experience_min_years": 12}).status_code == 422
    res = client.post(f"{API}/job-profiles", headers=farhan, json=body)
    assert res.status_code == 201, res.text
    prof = res.json()
    assert prof["job_level"] == "L6" and prof["responsibilities"] == ["Own uptime", "Lead on-call"]
    assert prof["education"] == "B.Tech or equivalent" and prof["experience_max_years"] == 10
    res = client.patch(f"{API}/job-profiles/{prof['id']}", headers=farhan, json={"grade": "G7", "job_level": "L7"})
    assert res.status_code == 200 and res.json()["grade"] == "G7"
    history = client.get(f"{API}/job-profiles/{prof['id']}/history", headers=farhan).json()
    assert len(history) == 2 and set(history[0]["changed_fields"]) == {"grade", "job_level"}
    assert history[1]["snapshot"]["grade"] == "G6" and history[0]["effective_from"] == today.isoformat()


def test_position_history(client, farhan):
    with SessionLocal() as db:
        profile = db.scalar(select(JobProfile).where(JobProfile.title == "Software Engineer"))
        eng = db.scalar(select(OrgUnit).where(OrgUnit.type == "department", OrgUnit.name == "Engineering"))
    yesterday = date.today() - timedelta(days=1)
    pos = client.post(f"{API}/positions", headers=farhan, json={
        "profile_id": profile.id, "department_id": eng.id, "country_code": "IN", "headcount": 2,
        "effective_from": (yesterday - timedelta(days=5)).isoformat()}).json()
    res = client.patch(f"{API}/positions/{pos['id']}", headers=farhan, json={
        "headcount": 3, "manager_id": "emp-ram", "effective_from": yesterday.isoformat()})
    assert res.status_code == 200 and res.json()["effective_from"] == (yesterday - timedelta(days=5)).isoformat()
    history = client.get(f"{API}/positions/{pos['id']}/history", headers=farhan).json()
    assert len(history) == 2 and set(history[0]["changed_fields"]) == {"headcount", "manager_id"}
    assert history[1]["snapshot"]["headcount"] == 2
    assert client.get(f"{API}/positions/nope/history", headers=farhan).status_code == 404


def test_assignments_carry_full_placement(client, babu):
    with SessionLocal() as db:
        row = db.scalar(select(EmployeeAssignment).where(EmployeeAssignment.employee_id == "emp-mahesh",
                                                         EmployeeAssignment.effective_to.is_(None)))
        assert row.business_unit and row.job_profile_id
    history = client.get("/api/v1/people/emp-mahesh/history", headers=babu).json()
    assert history[0]["business_unit"] and history[0]["job_profile_id"]
