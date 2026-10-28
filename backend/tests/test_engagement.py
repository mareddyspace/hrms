"""Surveys (anonymity threshold, no employee id on anonymous answers, eNPS) and recognition (points allowance, rewards)."""

from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import select

from app.db import SessionLocal
from app.models import EngagementResponse
from tests.conftest import login
from tests.talent_helpers import token_for

S = "/api/v1/surveys"
R = "/api/v1/recognition"


def test_anonymity_threshold_and_enps(client, babu, ram, farhan):
    today = date.today()
    body = {"title": "Pulse test run", "kind": "pulse", "anonymous": True, "open_date": today.isoformat(),
            "close_date": (today + timedelta(days=7)).isoformat(), "publish": True,
            "questions": [{"kind": "rating", "prompt": "Tools"}, {"kind": "enps", "prompt": "Recommend us?"},
                          {"kind": "text", "prompt": "Anything else?"}]}
    assert client.post(S, headers=babu, json=body).status_code == 403
    res = client.post(S, headers=farhan, json=body)
    assert res.status_code == 201, res.text
    sid = res.json()["id"]
    assert res.json()["phase"] == "Open"
    assert client.post(S, headers=farhan, json=body).status_code == 409  # same title
    people = [babu, ram, farhan, login(client, "sophie.clark@timez.com"), login(client, "jordan.blake@timez.com")]
    scores = [(5, 10), (4, 9), (3, 7), (2, 3), (5, 10)]
    for i, (headers, (rating, nps)) in enumerate(zip(people[:4], scores[:4], strict=True)):
        res = client.post(f"{S}/{sid}/responses", headers=headers, json={"answers": {"q1": rating, "q2": nps, "q3": f"note {i}"}})
        assert res.status_code == 201, res.text
    assert client.post(f"{S}/{sid}/responses", headers=babu, json={"answers": {"q1": 5, "q2": 10}}).status_code == 409
    assert client.post(f"{S}/{sid}/responses", headers=people[4], json={"answers": {"q1": 9, "q2": 10}}).status_code == 422
    four = client.get(f"{S}/{sid}/results", headers=farhan).json()
    assert four["responses"] == 4 and four["suppressed"] is True and four["questions"] == [] and four["enps"] is None
    assert client.get(f"{S}/{sid}/results", headers=babu).status_code == 403
    assert client.post(f"{S}/{sid}/responses", headers=people[4], json={"answers": {"q1": 5, "q2": 10}}).status_code == 201
    five = client.get(f"{S}/{sid}/results", headers=farhan).json()
    assert five["suppressed"] is False and five["threshold"] == 5
    # eNPS: promoters 10, 9, 10 (3); detractors 3 (1); 5 answers -> (3 - 1) / 5 = 40
    assert five["enps"] == 40
    assert five["engagement"] == round(((5 + 4 + 3 + 2 + 5) / 5 - 1) / 4 * 100)
    assert 0 < five["participation_pct"] < 5
    # every department / country bucket here is below 5 people, so none shows scores
    assert five["departments"] and all(b["suppressed"] and b["engagement"] is None for b in five["departments"])
    # anonymous: no employee id stored with any answer
    with SessionLocal() as db:
        rows = db.scalars(select(EngagementResponse).where(EngagementResponse.survey_id == sid)).all()
        assert len(rows) == 5 and all(r.employee_id is None for r in rows) and {r.department for r in rows}
    closed = client.post(f"{S}/{sid}/close", headers=farhan).json()
    assert closed["phase"] == "Closed"
    assert client.post(f"{S}/{sid}/responses", headers=token_for("demo-admin", "admin"),
                       json={"answers": {"q1": 5, "q2": 10}}).status_code == 409
    trend = client.get(f"{S}/trend", headers=farhan).json()
    point = next(p for p in trend if p["survey_id"] == sid)
    assert point["enps"] == 40 and point["responses"] == 5


def test_seeded_pulse_survey_is_open(client, babu):
    surveys = client.get(S, headers=babu).json()
    assert any(s["id"] == "srv-pulse-seed" and s["phase"] == "Open" for s in surveys)


def test_points_allowance_and_rewards(client, babu, ram, farhan):
    k = lambda pts, msg: client.post(f"{R}/kudos", headers=babu, json={  # noqa: E731
        "to_id": "emp-ram", "value": "Ownership", "message": msg, "points": pts})
    assert k(51, "Too many points at once").status_code == 422
    assert client.post(f"{R}/kudos", headers=babu, json={"to_id": "emp-mahesh", "value": "Teamwork",
                                                          "message": "Thanks to me, myself", "points": 0}).status_code == 422
    assert k(50, "Great release support last week").status_code == 201
    assert k(40, "Thanks for the code reviews!").status_code == 201
    over = k(20, "And for the design doc too")
    assert over.status_code == 409 and "10 points left" in over.json()["detail"]
    assert k(10, "And for the design doc too").status_code == 201
    assert k(1, "One more thank you note").status_code == 409
    assert k(0, "Kudos without points still works").status_code == 201
    mine = client.get(f"{R}/points", headers=babu).json()
    assert mine["given_this_month"] == 100 and mine["allowance_left"] == 0
    bal = client.get(f"{R}/points", headers=ram).json()
    assert bal["received"] >= 100
    start = bal["balance"]
    # likes toggle
    kid = client.get(f"{R}/kudos", headers=ram, params={"person_id": "emp-ram"}).json()[0]["id"]
    assert client.post(f"{R}/kudos/{kid}/like", headers=ram).json()["likes"] == 1
    assert client.post(f"{R}/kudos/{kid}/like", headers=ram).json()["likes"] == 0
    # rewards: hold points, decline refunds them
    rewards = {r["id"]: r for r in client.get(f"{R}/rewards", headers=ram).json()}
    assert {"rw-coffee", "rw-swag", "rw-voucher", "rw-dayoff"} <= set(rewards)
    res = client.post(f"{R}/redemptions", headers=ram, json={"reward_id": "rw-coffee"})
    assert res.status_code == 201
    rid = res.json()["id"]
    assert client.post(f"{R}/redemptions", headers=ram, json={"reward_id": "rw-coffee"}).status_code == 409
    assert client.get(f"{R}/points", headers=ram).json()["balance"] == start - 50
    assert client.post(f"{R}/redemptions/{rid}/decision", headers=ram, json={"decision": "fulfil"}).status_code == 403
    assert client.post(f"{R}/redemptions/{rid}/decision", headers=farhan, json={"decision": "decline"}).status_code == 422
    res = client.post(f"{R}/redemptions/{rid}/decision", headers=farhan, json={"decision": "decline", "note": "Out of stock"})
    assert res.json()["status"] == "Declined"
    assert client.get(f"{R}/points", headers=ram).json()["balance"] == start
    if start < 300:
        assert client.post(f"{R}/redemptions", headers=ram, json={"reward_id": "rw-dayoff", "note": "1 Dec"}).status_code == 409
