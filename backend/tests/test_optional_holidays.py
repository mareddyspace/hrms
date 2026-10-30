from tests.conftest import login
from tests.test_leave import _balance, _workday

OH = "/api/v1/leave/optional-holidays"
LR = "/api/v1/leave/requests"


def _ensure(client, babu, farhan, days_ahead: int) -> str:
    day = _workday(client, babu, days_ahead)
    listed = {h["date"] for h in client.get(OH, headers=babu, params={"year": day.year}).json()}
    if day.isoformat() not in listed:
        res = client.post(OH, headers=farhan, json={"country_code": "IN", "date": day.isoformat(), "name": f"Test {days_ahead}"})
        assert res.status_code == 201, res.text
    return day.isoformat()


def test_list_is_per_country_and_hr_manages(client, babu, farhan):
    rows = client.get(OH, headers=babu, params={"year": 2026}).json()
    assert {"Onam", "Chhath Puja"} <= {r["name"] for r in rows} and all(r["country_code"] == "IN" for r in rows)
    sophie = login(client, "sophie.clark@timez.com")
    us = client.get(OH, headers=sophie, params={"year": 2026}).json()
    assert {r["country_code"] for r in us} == {"US"}
    assert client.get(OH, headers=babu, params={"country": "US"}).status_code == 403
    assert client.post(OH, headers=babu, json={"country_code": "IN", "date": "2030-03-05", "name": "Nope"}).status_code == 403
    added = client.post(OH, headers=farhan, json={"country_code": "IN", "date": "2030-03-05", "name": "Test day"})
    assert added.status_code == 201, added.text
    assert client.post(OH, headers=farhan, json={"country_code": "IN", "date": "2030-03-05", "name": "Again"}).status_code == 409
    assert client.post(OH, headers=farhan, json={"country_code": "IN", "date": "2030-03-09", "name": "Weekend"}).status_code == 422
    assert client.delete(f"{OH}/{added.json()['id']}", headers=farhan).status_code == 204
    assert "2030-03-05" not in {r["date"] for r in client.get(OH, headers=babu, params={"year": 2030}).json()}


def test_pick_goes_to_manager_and_counts_against_balance(client, babu, ram, farhan):
    first = _ensure(client, babu, farhan, 55)
    second = _ensure(client, babu, farhan, 59)
    third = _ensure(client, babu, farhan, 63)
    year = int(first[:4])
    before = _balance(client, babu, "optional", year)
    assert before["quota"] == 2

    # only listed dates, a single full day
    plain = _workday(client, babu, 66).isoformat()
    bad = client.post(LR, headers=babu, json={"leave_code": "optional", "from": plain, "to": plain, "reason": "x"})
    assert bad.status_code == 422 and "optional holiday" in bad.json()["detail"]
    half = client.post(LR, headers=babu, json={"leave_code": "optional", "from": first, "to": first, "half": "first", "reason": "x"})
    assert half.status_code == 422

    res = client.post(LR, headers=babu, json={"leave_code": "optional", "from": first, "to": first, "reason": "Optional holiday"})
    assert res.status_code == 201, res.text
    req = res.json()
    assert req["status"] == "pending" and req["days"] == 1
    assert _balance(client, babu, "optional", year)["pending"] == before["pending"] + 1
    assert req["id"] in {r["id"] for r in client.get(LR, headers=ram, params={"view": "team"}).json()}

    decided = client.post(f"{LR}/{req['id']}/decision", headers=ram, json={"decision": "approve"})
    assert decided.status_code == 200 and decided.json()["status"] == "approved"
    assert _balance(client, babu, "optional", year)["used"] == before["used"] + 1
    # HR sees the pick count
    counts = {h["date"]: h["picked_by"] for h in client.get(OH, headers=farhan, params={"year": year, "country": "IN"}).json()}
    assert counts[first] >= 1

    two = client.post(LR, headers=babu, json={"leave_code": "optional", "from": second, "to": second, "reason": "Optional holiday"})
    assert two.status_code == 201, two.text
    if second[:4] == third[:4] == first[:4]:
        over = client.post(LR, headers=babu, json={"leave_code": "optional", "from": third, "to": third, "reason": "Optional holiday"})
        assert over.status_code == 422 and "available" in over.json()["detail"]
    client.post(f"{LR}/{two.json()['id']}/cancel", headers=babu)
