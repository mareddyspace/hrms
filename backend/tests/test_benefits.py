from datetime import date, timedelta

import pytest

API = "/api/v1/benefits"


@pytest.fixture(scope="module", autouse=True)
def closed_window(client, farhan):
    """Run with open enrollment closed (whatever today's date is), then put the dates back."""
    res = client.patch(f"{API}/windows/bw-oe-2027", headers=farhan, json={"override": "closed"})
    assert res.status_code == 200 and res.json()["is_open"] is False
    yield
    client.patch(f"{API}/windows/bw-oe-2027", headers=farhan, json={"override": "dates"})


def test_plans_and_eligibility(client, babu, farhan):
    plans = {p["id"]: p for p in client.get(f"{API}/plans", headers=babu).json()}
    assert {"bp-in-med", "bp-in-pf", "bp-in-life"} <= set(plans) and "bp-us-med" not in plans
    assert "Not contract staff" in plans["bp-in-med"]["rules"]
    nps = client.get(f"{API}/plans/bp-in-nps/eligibility", headers=babu).json()
    assert nps["eligible"] is False and "Grade L4" in nps["reason"]
    us = client.get(f"{API}/plans/bp-us-med/eligibility", headers=babu).json()
    assert us["eligible"] is False and "US" in us["reason"]
    life = client.get(f"{API}/plans/bp-in-life/eligibility", headers=babu).json()
    assert life["eligible"] is True and life["window_open"] is False
    assert client.get(f"{API}/plans/bp-in-life/eligibility", headers=babu, params={"employee_id": "emp-ram"}).status_code == 404
    assert client.get(f"{API}/plans/bp-in-life/eligibility", headers=farhan,
                      params={"employee_id": "emp-mahesh"}).json()["eligible"] is True
    assert client.post(f"{API}/plans", headers=babu, json={"country_code": "IN", "name": "X plan", "plan_type": "Other",
                                                           "provider": "P"}).status_code == 403


def test_changes_blocked_outside_window(client, babu):
    status = client.get(f"{API}/change-window", headers=babu).json()
    assert status["open"] is False and "open enrollment" in status["text"] and "30 days of a life event" in status["text"]
    res = client.post(f"{API}/enrollments", headers=babu, json={"plan_id": "bp-in-life"})
    assert res.status_code == 409 and "open enrollment" in res.json()["detail"]
    enrollments = {e["plan_id"]: e for e in client.get(f"{API}/enrollments", headers=babu).json()}
    res = client.put(f"{API}/enrollments/{enrollments['bp-in-med']['id']}/dependents", headers=babu, json={"dependent_ids": []})
    assert res.status_code == 409 and "life event" in res.json()["detail"]
    assert client.post(f"{API}/enrollments", headers=babu, json={"plan_id": "bp-in-pf"}).status_code == 409  # statutory
    assert client.post(f"{API}/enrollments", headers=babu, json={"plan_id": "bp-in-nps"}).status_code == 422  # not eligible


def test_life_event_opens_window_and_hr_decides(client, babu, ram, farhan):
    today = date.today()
    assert client.post(f"{API}/life-events", headers=babu, json={"event_type": "Marriage",
                                                                 "event_date": (today + timedelta(days=1)).isoformat()}).status_code == 422
    assert client.post(f"{API}/life-events", headers=babu, json={"event_type": "Marriage",
                                                                 "event_date": (today - timedelta(days=40)).isoformat()}).status_code == 422
    res = client.post(f"{API}/life-events", headers=babu, json={"event_type": "Marriage",
                                                                "event_date": (today - timedelta(days=3)).isoformat()})
    assert res.status_code == 201 and res.json()["window_ends"] == (today + timedelta(days=27)).isoformat()
    assert client.post(f"{API}/life-events", headers=babu, json={"event_type": "Marriage",
                                                                 "event_date": (today - timedelta(days=3)).isoformat()}).status_code == 409
    window = client.get(f"{API}/change-window", headers=babu).json()
    assert window["open"] is True and window["life_event_id"] == res.json()["id"]

    enr = client.post(f"{API}/enrollments", headers=babu, json={"plan_id": "bp-in-life"})
    assert enr.status_code == 201 and enr.json()["status"] == "requested" and enr.json()["life_event_id"]
    eid = enr.json()["id"]
    assert client.post(f"{API}/enrollments", headers=babu, json={"plan_id": "bp-in-life"}).status_code == 409
    assert eid in [e["id"] for e in client.get(f"{API}/enrollments", headers=farhan, params={"view": "to_decide"}).json()]
    assert client.post(f"{API}/enrollments/{eid}/decision", headers=ram, json={"decision": "approve"}).status_code == 403
    assert client.post(f"{API}/enrollments/{eid}/decision", headers=babu, json={"decision": "approve"}).status_code == 403
    done = client.post(f"{API}/enrollments/{eid}/decision", headers=farhan, json={"decision": "approve"}).json()
    assert done["status"] == "approved" and done["effective_date"]
    assert client.post(f"{API}/enrollments/{eid}/decision", headers=farhan, json={"decision": "waive"}).status_code == 409


def test_dependents_verification_and_cover(client, babu, farhan):
    res = client.post(f"{API}/dependents", headers=babu, json={"name": "Meera Menon", "relationship": "Parent",
                                                               "date_of_birth": "1965-02-01", "gender": "Female"})
    assert res.status_code == 201 and res.json()["verification"] == "pending"
    dep = res.json()["id"]
    assert client.post(f"{API}/dependents", headers=babu, json={"name": "meera menon", "relationship": "Parent",
                                                                "date_of_birth": "1965-02-01"}).status_code == 409
    med = {e["plan_id"]: e for e in client.get(f"{API}/enrollments", headers=babu).json()}["bp-in-med"]
    covered = med["dependent_ids"]
    assert len(covered) == 2
    res = client.put(f"{API}/enrollments/{med['id']}/dependents", headers=babu, json={"dependent_ids": covered + [dep]})
    assert res.status_code == 422 and "verified by HR" in res.json()["detail"]
    assert client.post(f"{API}/dependents/{dep}/verification", headers=babu, json={"status": "verified"}).status_code == 403
    assert client.post(f"{API}/dependents/{dep}/verification", headers=farhan, json={"status": "verified"}).json()["verification"] == "verified"
    res = client.put(f"{API}/enrollments/{med['id']}/dependents", headers=babu, json={"dependent_ids": covered + [dep]})
    assert res.status_code == 200 and dep in res.json()["dependent_ids"]
    res = client.delete(f"{API}/dependents/{dep}", headers=babu)
    assert res.status_code == 409 and "Remove them from cover first" in res.json()["detail"]
    assert client.post(f"{API}/dependents/{dep}/verification", headers=farhan, json={"status": "rejected"}).status_code == 409
    # editing key details sends the dependent back for verification
    edited = client.put(f"{API}/dependents/{dep}", headers=babu, json={"name": "Meera K Menon", "relationship": "Parent",
                                                                       "date_of_birth": "1965-02-01"}).json()
    assert edited["verification"] == "pending"


def test_closing_life_event_blocks_again(client, babu, farhan):
    events = client.get(f"{API}/life-events", headers=babu).json()
    open_event = next(e for e in events if e["status"] == "open")
    assert client.post(f"{API}/life-events/{open_event['id']}/close", headers=babu).status_code == 403
    assert client.post(f"{API}/life-events/{open_event['id']}/close", headers=farhan).json()["status"] == "closed"
    med = {e["plan_id"]: e for e in client.get(f"{API}/enrollments", headers=babu).json()}["bp-in-med"]
    res = client.put(f"{API}/enrollments/{med['id']}/dependents", headers=babu, json={"dependent_ids": med["dependent_ids"][:1]})
    assert res.status_code == 409
    # HR forcing the window open lets changes through again
    client.patch(f"{API}/windows/bw-oe-2027", headers=farhan, json={"override": "open"})
    try:
        assert client.get(f"{API}/change-window", headers=babu).json()["open"] is True
    finally:
        client.patch(f"{API}/windows/bw-oe-2027", headers=farhan, json={"override": "closed"})


def test_beneficiaries_must_total_100(client, babu, ram):
    bad = {"nomination_for": "Group Term Life", "nominees": [
        {"name": "Ananya Menon", "relationship": "Spouse", "share_pct": 60},
        {"name": "Arjun Menon", "relationship": "Child", "share_pct": 30}]}
    res = client.put(f"{API}/beneficiaries", headers=babu, json=bad)
    assert res.status_code == 422 and "total 100%" in res.json()["detail"] and "90%" in res.json()["detail"]
    good = {"nomination_for": "Group Term Life", "nominees": [
        {"name": "Ananya Menon", "relationship": "Spouse", "share_pct": 60},
        {"name": "Arjun Menon", "relationship": "Child", "share_pct": 40}]}
    res = client.put(f"{API}/beneficiaries", headers=babu, json=good)
    assert res.status_code == 200 and len(res.json()) == 2
    dup = {"nomination_for": "X", "nominees": [{"name": "A B", "relationship": "Spouse", "share_pct": 50},
                                               {"name": "a b", "relationship": "Child", "share_pct": 50}]}
    assert client.put(f"{API}/beneficiaries", headers=babu, json=dup).status_code == 422
    rows = client.get(f"{API}/beneficiaries", headers=babu).json()
    assert {r["nomination_for"] for r in rows} >= {"Provident Fund", "Group Term Life"}
    assert client.get(f"{API}/beneficiaries", headers=ram, params={"employee_id": "emp-mahesh"}).status_code == 403
