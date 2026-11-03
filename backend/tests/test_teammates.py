"""Priya (India) and Oliver (UK): two more employees under Ram with the same pages and rules as Babu."""

from __future__ import annotations

import pytest

from tests.conftest import login

PRIYA, OLIVER, BABU, RAM = "emp-priya", "emp-oliver", "emp-mahesh", "emp-ram"


@pytest.fixture(scope="module")
def priya(client):
    return login(client, "priya.nair@timez.com")


@pytest.fixture(scope="module")
def oliver(client):
    return login(client, "oliver.hughes@timez.com")


def test_they_sign_in_as_employees_of_ram(client, priya, oliver):
    for headers, emp_id, country in ((priya, PRIYA, "IN"), (oliver, OLIVER, "GB")):
        me = client.get("/api/v1/auth/me", headers=headers).json()
        assert (me["role"], me["employee_id"], me["country_code"], me["scope"]) == ("employee", emp_id, country, "self")
    oli = client.get(f"/api/v1/people/{OLIVER}", headers=oliver).json()
    assert (oli["manager_id"], oli["currency"], oli["time_zone"]) == (RAM, "GBP", "Europe/London")


def test_ram_sees_all_three_reports(client, ram):
    reports = client.get(f"/api/v1/people/{RAM}/reports", headers=ram).json()
    assert {BABU, PRIYA, OLIVER} <= {p["id"] for p in reports}
    assert all(p["view"] == "full" for p in reports if p["id"] in (PRIYA, OLIVER))


def test_teammates_see_only_basic_details_of_each_other(client, priya, babu):
    team = {p["id"]: p for p in client.get(f"/api/v1/people/{RAM}/reports", headers=priya).json()}
    assert team[OLIVER]["view"] == "basic" and team[BABU]["view"] == "basic"
    for headers, other in ((priya, OLIVER), (babu, PRIYA)):
        assert client.get("/api/v1/leave/balances", headers=headers, params={"employee_id": other}).status_code == 404


def test_country_rules_follow_the_person(client, priya, oliver):
    uk = {h["name"] for h in client.get("/api/v1/leave/holidays", headers=oliver, params={"year": 2026}).json()}
    india = {h["name"] for h in client.get("/api/v1/leave/holidays", headers=priya, params={"year": 2026}).json()}
    assert uk and india and uk != india
    pay = client.get("/api/v1/compensation/records", headers=oliver).json()
    assert pay["current"]["currency"] == "GBP" and pay["current"]["base_salary"] == 60_500


def test_starting_data_is_there(client, priya, oliver):
    for headers in (priya, oliver):
        assert client.get("/api/v1/leave/balances", headers=headers).json()["balances"]
        assert client.get("/api/v1/documents", headers=headers).json()
        assert client.get("/api/v1/shifts/mine", headers=headers).status_code == 200
        assert client.get("/api/v1/timesheets/projects", headers=headers).json()
    titles = {d["title"] for d in client.get("/api/v1/documents", headers=oliver).json()}
    assert "Right to work check" in titles and "Aadhaar card" not in titles


def test_their_requests_wait_for_ram_not_jordan(client, ram):
    waiting = {i["employee_id"] for i in client.get("/api/v1/approvals/pending", headers=ram).json()}
    assert {PRIYA, OLIVER} <= waiting
    jordan = login(client, "jordan.blake@timez.com")
    assert not {PRIYA, OLIVER} & {i["employee_id"] for i in client.get("/api/v1/approvals/pending", headers=jordan).json()}
