"""India tax regime: the employee saves new / old on their record; HR sees it on the person (pay preview)."""

from tests.conftest import login

API = "/api/v1/payroll/me/tax-regime"


def test_employee_sets_regime_and_hr_sees_it(client, babu, farhan):
    me = client.get("/api/v1/people/emp-mahesh", headers=babu).json()
    assert me["country_code"] == "IN"
    assert me["tax_regime"] in (None, "new")

    res = client.post(API, json={"regime": "old"}, headers=babu)
    assert res.status_code == 200, res.text
    assert res.json() == {"employee_id": "emp-mahesh", "regime": "old"}
    assert client.get("/api/v1/people/emp-mahesh", headers=babu).json()["tax_regime"] == "old"
    assert client.get("/api/v1/people/emp-mahesh", headers=farhan).json()["tax_regime"] == "old"

    assert client.post(API, json={"regime": "flat"}, headers=babu).status_code == 422
    assert client.post(API, json={"regime": "new"}, headers=babu).json()["regime"] == "new"
    assert client.get("/api/v1/people/emp-mahesh", headers=farhan).json()["tax_regime"] == "new"


def test_regime_is_india_only(client):
    headers = login(client, "jordan.blake@timez.com")
    me = client.get("/api/v1/auth/me", headers=headers).json()
    person = client.get(f"/api/v1/people/{me['employee_id']}", headers=headers).json()
    res = client.post(API, json={"regime": "old"}, headers=headers)
    assert res.status_code == (200 if person["country_code"] == "IN" else 422), res.text
