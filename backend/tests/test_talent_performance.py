from datetime import date, timedelta

import pytest
from sqlalchemy import select

from app.db import SessionLocal
from app.models import AuditLog
from app.security import create_access_token
from tests.conftest import login

P = "/api/v1/performance"


@pytest.fixture(scope="module")
def sophie(client):
    return login(client, "sophie.clark@timez.com")


@pytest.fixture(scope="module")
def cycle(client, farhan):
    today = date.today()
    body = {"name": "Test cycle 2026", "start_date": (today - timedelta(days=30)).isoformat(),
            "end_date": (today + timedelta(days=60)).isoformat(), "self_review_due": (today + timedelta(days=10)).isoformat(),
            "manager_review_due": (today + timedelta(days=20)).isoformat()}
    res = client.post(f"{P}/cycles", headers=farhan, json=body)
    assert res.status_code == 201, res.text
    return res.json() | {"_body": body}


def test_cycles_hr_only_and_validation(client, babu, farhan, cycle):
    body = cycle["_body"]
    assert client.post(f"{P}/cycles", headers=babu, json=body | {"name": "Mine"}).status_code == 403
    assert client.post(f"{P}/cycles", headers=farhan, json=body).status_code == 409  # duplicate name
    assert client.post(f"{P}/cycles", headers=farhan, json=body | {"name": "Bad", "end_date": body["start_date"]}).status_code == 422
    assert client.post(f"{P}/cycles", headers=farhan, json=body | {"name": "Bad 2", "manager_review_due": body["start_date"]}).status_code == 422
    assert cycle["status"] == "planning"
    assert client.post(f"{P}/cycles/{cycle['id']}/advance", headers=babu).status_code == 403
    assert client.post(f"{P}/cycles/{cycle['id']}/advance", headers=farhan).json()["status"] == "active"
    names = {c["name"] for c in client.get(f"{P}/cycles", headers=babu).json()}
    assert {"H2 2026 review", "Test cycle 2026"} <= names


def test_goal_weights_and_permissions(client, babu, ram, sophie, cycle):
    def add(headers, weight, owner=None, title="Goal"):
        return client.post(f"{P}/goals", headers=headers, json={"employee_id": owner, "cycle_id": cycle["id"], "title": title,
                                                                "target": "Done", "weight": weight})

    g1 = add(babu, 60, title="Ship feature")
    assert g1.status_code == 201, g1.text
    g2 = add(ram, 40, "emp-mahesh", "Mentor a junior")  # a manager sets a goal for a report
    assert g2.status_code == 201
    res = add(babu, 1)
    assert res.status_code == 422 and "101%" in res.json()["detail"]
    assert add(babu, 0).status_code == 422 and add(babu, 101).status_code == 422
    assert add(babu, 10, "emp-ram").status_code == 403  # not below Babu
    gid = g1.json()["id"]
    upd = {"cycle_id": cycle["id"], "title": "Ship feature", "target": "Live", "weight": 61}
    assert client.put(f"{P}/goals/{gid}", headers=babu, json=upd).status_code == 422  # 61 + 40
    assert client.put(f"{P}/goals/{gid}", headers=babu, json=upd | {"weight": 50}).json()["weight"] == 50  # own weight excluded
    assert add(babu, 10, title="Learn Rust").status_code == 201  # back to 100
    assert client.patch(f"{P}/goals/{gid}/progress", headers=ram, json={"progress": 45}).json()["progress"] == 45
    assert client.patch(f"{P}/goals/{gid}/progress", headers=babu, json={"progress": 120}).status_code == 422
    assert client.patch(f"{P}/goals/{gid}/progress", headers=sophie, json={"progress": 50}).status_code == 404
    assert client.get(f"{P}/goals", headers=sophie, params={"employee_id": "emp-mahesh"}).status_code == 404
    mine = client.get(f"{P}/goals", headers=babu, params={"cycle_id": cycle["id"]}).json()
    assert sum(g["weight"] for g in mine) == 100
    seeded = client.get(f"{P}/goals", headers=babu, params={"cycle_id": "cyc-h2"}).json()
    assert {g["id"] for g in seeded} == {"g1", "g2", "g3"} and sum(g["weight"] for g in seeded) == 100


def test_check_ins(client, babu, ram, sophie):
    body = {"employee_id": "emp-mahesh", "meeting_date": date.today().isoformat(), "notes": "Talked about growth",
            "action_items": [{"text": "Pick a stretch project"}]}
    assert client.post(f"{P}/check-ins", headers=sophie, json=body).status_code == 403
    res = client.post(f"{P}/check-ins", headers=ram, json=body)
    assert res.status_code == 201 and res.json()["manager_id"] == "emp-ram"
    assert [c["notes"] for c in client.get(f"{P}/check-ins", headers=babu).json()] == ["Talked about growth"]
    assert client.get(f"{P}/check-ins", headers=sophie, params={"employee_id": "emp-mahesh"}).status_code == 404


def test_review_360_privacy_rating_release(client, babu, ram, farhan, sophie, cycle):
    review = client.get(f"{P}/cycles/{cycle['id']}/reviews/emp-mahesh", headers=babu).json()
    rid = review["id"]
    assert client.get(f"{P}/cycles/{cycle['id']}/reviews/emp-mahesh", headers=sophie).status_code == 404

    # 360: up to 3 nominees, never the employee; answers only for managers and HR
    nom = f"{P}/reviews/{rid}/reviewers"
    assert client.post(nom, headers=sophie, json={"reviewer_id": "demo-admin"}).status_code == 404
    assert client.post(nom, headers=babu, json={"reviewer_id": "emp-mahesh"}).status_code == 422
    for who in ("demo-recruiter", "demo-admin", "TZ0001"):
        assert client.post(nom, headers=babu, json={"reviewer_id": who}).status_code == 201
    assert client.post(nom, headers=ram, json={"reviewer_id": "TZ0002"}).status_code == 409  # max 3
    assert client.delete(f"{nom}/TZ0001", headers=babu).status_code == 200
    assert client.post(nom, headers=ram, json={"reviewer_id": "TZ0002"}).status_code == 201
    assert rid in {p["review_id"] for p in client.get(f"{P}/360/pending", headers=sophie).json()}
    assert client.post(f"{P}/reviews/{rid}/360", headers=farhan, json={"rating": 4, "comment": "Great"}).status_code == 404  # not asked
    assert client.post(f"{P}/reviews/{rid}/360", headers=sophie, json={"rating": 6, "comment": "Great work"}).status_code == 422
    assert client.post(f"{P}/reviews/{rid}/360", headers=sophie, json={"rating": 4, "comment": "Great"}).status_code == 204
    assert client.post(f"{P}/reviews/{rid}/360", headers=sophie, json={"rating": 5, "comment": "Again!"}).status_code == 409
    assert client.delete(f"{nom}/demo-recruiter", headers=babu).status_code == 409  # already answered
    assert rid not in {p["review_id"] for p in client.get(f"{P}/360/pending", headers=sophie).json()}
    assert client.get(f"{P}/reviews/{rid}", headers=sophie).status_code in (404, 405)  # no read access for nominees

    def answer(headers):
        r = client.get(f"{P}/cycles/{cycle['id']}/reviews/emp-mahesh", headers=headers).json()
        return next(x for x in r["reviewers"] if x["reviewer_id"] == "demo-recruiter")

    assert answer(babu)["responded"] is True and answer(babu)["rating"] is None and answer(babu)["comment"] is None
    assert answer(ram)["rating"] == 4 and answer(ram)["comment"] == "Great"
    assert answer(farhan)["rating"] == 4
    with SessionLocal() as db:
        logged = db.scalar(select(AuditLog).where(AuditLog.action == "reviewer_360_answered", AuditLog.entity_id == rid))
        assert "Great" not in str(logged.changes)

    # assessments and rating
    rate = f"{P}/reviews/{rid}/rating"
    assert client.post(rate, headers=ram, json={"rating": "Strong"}).status_code == 409  # self-assessment first
    assert client.put(f"{P}/reviews/{rid}/self", headers=ram, json={"text": "x" * 20, "submit": True}).status_code == 403
    assert client.put(f"{P}/reviews/{rid}/self", headers=babu, json={"text": "short", "submit": True}).status_code == 422
    assert client.put(f"{P}/reviews/{rid}/self", headers=babu, json={"text": "Draft only"}).json()["self_status"] == "draft"
    assert client.get(f"{P}/cycles/{cycle['id']}/reviews/emp-mahesh", headers=ram).json()["self_text"] is None  # drafts are private
    assert client.put(f"{P}/reviews/{rid}/self", headers=babu, json={"text": "Shipped the calendar UX", "submit": True}).json()["self_status"] == "submitted"
    assert client.put(f"{P}/reviews/{rid}/self", headers=babu, json={"text": "Changed", "submit": True}).status_code == 409
    assert client.put(f"{P}/reviews/{rid}/manager", headers=babu, json={"text": "I am great", "submit": True}).status_code == 403
    assert client.put(f"{P}/reviews/{rid}/manager", headers=farhan, json={"text": "HR is not the line", "submit": True}).status_code == 403
    # skip-level (Jordan, Ram's manager) may view the review but not write the assessment or rate (direct manager only)
    jordan = {"Authorization": f"Bearer {create_access_token('demo-ceo', 'executive')[0]}"}
    assert client.get(f"{P}/cycles/{cycle['id']}/reviews/emp-mahesh", headers=jordan).status_code == 200
    assert client.put(f"{P}/reviews/{rid}/manager", headers=jordan, json={"text": "Skip level writing", "submit": True}).status_code == 403
    assert client.post(rate, headers=ram, json={"rating": "Strong"}).status_code == 409  # manager assessment first
    assert client.put(f"{P}/reviews/{rid}/manager", headers=ram, json={"text": "Consistently strong delivery", "submit": True}).status_code == 200
    assert client.post(rate, headers=ram, json={"rating": "Brilliant"}).status_code == 422
    assert client.post(rate, headers=babu, json={"rating": "Exceptional"}).status_code == 403
    assert client.post(rate, headers=jordan, json={"rating": "Exceptional"}).status_code == 403  # skip-level
    assert client.post(rate, headers=ram, json={"rating": "Strong"}).json()["rating"] == "Strong"

    assert client.get(f"{P}/cycles/{cycle['id']}/reviews/emp-mahesh", headers=babu).json()["rating"] is None  # not released
    assert client.get(f"{P}/cycles/{cycle['id']}/reviews/emp-mahesh", headers=farhan).json()["rating"] == "Strong"
    assert client.post(f"{P}/reviews/{rid}/release", headers=farhan).status_code == 409  # only during calibration
    assert client.post(f"{P}/cycles/{cycle['id']}/advance", headers=farhan).json()["status"] == "calibration"
    assert client.post(nom, headers=babu, json={"reviewer_id": "TZ0003"}).status_code == 409  # nominations closed
    assert client.post(f"{P}/reviews/{rid}/release", headers=ram).status_code == 403
    res = client.post(f"{P}/reviews/{rid}/release", headers=farhan)
    assert res.status_code == 200 and res.json()["released"] is True
    assert client.post(f"{P}/reviews/{rid}/release", headers=farhan).status_code == 409
    assert client.post(rate, headers=ram, json={"rating": "Solid"}).status_code == 409  # released ratings are final
    mine = client.get(f"{P}/cycles/{cycle['id']}/reviews/emp-mahesh", headers=babu).json()
    assert mine["rating"] == "Strong" and mine["released"] is True
    assert any(n["title"] == "Your performance rating is available" for n in client.get("/api/v1/notifications", headers=babu).json())


def test_hr_cannot_release_own_rating(client, farhan):
    with SessionLocal() as db:
        from app.models import PerfReview, ReviewCycle

        db.add(ReviewCycle(id="cyc-own", name="Own release check", status="calibration", start_date=date(2026, 1, 1),
                           end_date=date(2026, 6, 30), self_review_due=date(2026, 5, 1), manager_review_due=date(2026, 6, 1)))
        db.flush()
        db.add(PerfReview(id="rev-own", cycle_id="cyc-own", employee_id="demo-hr-admin", self_status="submitted",
                          manager_status="submitted", rating="Strong", released=False))
        db.commit()
    res = client.post(f"{P}/reviews/rev-own/release", headers=farhan)
    assert res.status_code == 403 and "Another HR person" in res.json()["detail"]
    assert client.get(f"{P}/cycles/cyc-own/reviews/demo-hr-admin", headers=farhan).json()["rating"] is None  # own, unreleased


def test_development_actions(client, babu, ram, sophie):
    rid = client.get(f"{P}/cycles/cyc-h2/reviews/emp-mahesh", headers=babu).json()["id"]
    assert client.post(f"{P}/reviews/{rid}/actions", headers=sophie, json={"title": "Learn Go"}).status_code == 404
    assert client.post(f"{P}/reviews/{rid}/actions", headers=babu, json={"title": "Go"}).status_code == 422
    res = client.post(f"{P}/reviews/{rid}/actions", headers=babu, json={"title": "Lead a design review", "due": "2026-12-15"})
    assert res.status_code == 201 and res.json()["status"] == "not_started"
    aid = res.json()["id"]
    assert client.patch(f"{P}/actions/{aid}", headers=ram, json={"status": "in_progress"}).json()["status"] == "in_progress"
    assert client.patch(f"{P}/actions/{aid}", headers=babu, json={"status": "finished"}).status_code == 422
    review = client.get(f"{P}/cycles/cyc-h2/reviews/emp-mahesh", headers=babu).json()
    assert [a["title"] for a in review["dev_actions"]] == ["Lead a design review"]
    assert client.delete(f"{P}/actions/{aid}", headers=babu).status_code == 204
