from datetime import date, timedelta

import pytest

from tests.conftest import login

L = "/api/v1/learning"


@pytest.fixture(scope="module")
def sophie(client):
    return login(client, "sophie.clark@timez.com")


def test_catalog(client, babu, farhan):
    courses = client.get(f"{L}/courses", headers=babu).json()
    assert len(courses) >= 10 and {"crs-1", "crs-10"} <= {c["id"] for c in courses}
    assert next(c for c in courses if c["id"] == "crs-2")["skills"] == ["TypeScript", "System design"]
    body = {"title": "Kubernetes basics", "provider": "CNCF", "url": "https://example.com/k8s", "duration_hours": 6,
            "mandatory": False, "audience": "Engineering", "skills": ["Cloud architecture"]}
    assert client.post(f"{L}/courses", headers=babu, json=body).status_code == 403
    res = client.post(f"{L}/courses", headers=farhan, json=body)
    assert res.status_code == 201 and res.json()["provider"] == "CNCF"
    assert client.post(f"{L}/courses", headers=farhan, json=body | {"title": "KUBERNETES BASICS"}).status_code == 409
    assert client.post(f"{L}/courses", headers=farhan, json=body | {"title": "Bad url", "url": "ftp://x"}).status_code == 422
    assert client.put(f"{L}/courses/{res.json()['id']}", headers=farhan, json=body | {"mandatory": True}).json()["mandatory"] is True


def test_enrollments(client, babu, ram, farhan, sophie):
    res = client.post(f"{L}/enrollments", headers=babu, json={"course_id": "crs-1"})
    assert res.status_code == 201 and res.json()["status"] == "assigned"
    eid = res.json()["id"]
    assert client.post(f"{L}/enrollments", headers=babu, json={"course_id": "crs-1"}).status_code == 409
    assert client.post(f"{L}/enrollments", headers=babu, json={"course_id": "crs-3"}).status_code == 403  # managers only
    assert client.post(f"{L}/enrollments", headers=sophie, json={"course_id": "crs-3", "employee_id": "emp-mahesh"}).status_code == 403
    res = client.post(f"{L}/enrollments", headers=ram, json={"course_id": "crs-3", "employee_id": "emp-mahesh", "due": "2026-12-31"})
    assert res.status_code == 201
    assert any(n["title"] == "Course assigned: Manager essentials" for n in client.get("/api/v1/notifications", headers=babu).json())

    res = client.patch(f"{L}/enrollments/{eid}/progress", headers=babu, json={"progress": 95})
    assert res.json()["progress"] == 90 and res.json()["status"] == "in_progress"  # self-reported progress stops at 90
    assert client.patch(f"{L}/enrollments/{eid}/progress", headers=ram, json={"progress": 50}).status_code == 403
    assert client.post(f"{L}/enrollments/{eid}/complete", headers=babu, json={"score": 90}).status_code == 403
    assert client.post(f"{L}/enrollments/{eid}/complete", headers=ram, json={"score": 90}).status_code == 403
    assert client.post(f"{L}/enrollments/{eid}/complete", headers=farhan, json={"score": 101}).status_code == 422
    res = client.post(f"{L}/enrollments/{eid}/complete", headers=farhan, json={"score": 85})
    assert res.status_code == 200 and res.json()["status"] == "completed" and res.json()["score"] == 85 and res.json()["completed_on"]
    assert client.post(f"{L}/enrollments/{eid}/complete", headers=farhan, json={}).status_code == 409
    assert client.patch(f"{L}/enrollments/{eid}/progress", headers=babu, json={"progress": 10}).status_code == 409
    assert {e["course_title"] for e in client.get(f"{L}/enrollments", headers=ram, params={"employee_id": "emp-mahesh"}).json()} \
        >= {"Workplace safety", "Manager essentials"}
    assert client.get(f"{L}/enrollments", headers=sophie, params={"employee_id": "emp-mahesh"}).status_code == 404


def test_certifications_and_expiring(client, babu, ram, farhan, sophie):
    today = date.today()
    soon = {"name": "CKA", "issuer": "CNCF", "issued_on": (today - timedelta(days=700)).isoformat(),
            "expires_on": (today + timedelta(days=10)).isoformat()}
    later = soon | {"name": "CKAD", "expires_on": (today + timedelta(days=60)).isoformat()}
    assert client.post(f"{L}/certifications", headers=babu, json=soon | {"expires_on": soon["issued_on"]}).status_code == 422
    assert client.post(f"{L}/certifications", headers=sophie, json=soon | {"employee_id": "emp-mahesh"}).status_code == 403
    cka = client.post(f"{L}/certifications", headers=babu, json=soon)
    assert cka.status_code == 201 and cka.json()["days_to_expiry"] == 10
    assert client.post(f"{L}/certifications", headers=farhan, json=later | {"employee_id": "emp-mahesh"}).status_code == 201

    for headers in (babu, ram, farhan):
        names = {c["name"] for c in client.get(f"{L}/expiring", headers=headers).json()}
        assert "CKA" in names and "CKAD" not in names
    assert "CKA" not in {c["name"] for c in client.get(f"{L}/expiring", headers=sophie).json()}
    assert "CKAD" in {c["name"] for c in client.get(f"{L}/expiring", headers=babu, params={"days": 90}).json()}
    assert client.delete(f"{L}/certifications/{cka.json()['id']}", headers=sophie).status_code == 404
    assert client.delete(f"{L}/certifications/{cka.json()['id']}", headers=ram).status_code == 403
    assert client.delete(f"{L}/certifications/{cka.json()['id']}", headers=babu).status_code == 204


def test_skills_self_edit(client, babu, ram, sophie):
    res = client.put(f"{L}/skills/me", headers=babu, json={"skill": "React", "level": 3, "target_level": 4})
    assert res.status_code == 200
    sid = res.json()["id"]
    res = client.put(f"{L}/skills/me", headers=babu, json={"skill": "react", "level": 4, "target_level": 5})
    assert res.json()["id"] == sid and res.json()["level"] == 4 and res.json()["skill"] == "React"
    assert client.put(f"{L}/skills/me", headers=babu, json={"skill": "Go", "level": 6}).status_code == 422
    assert [s["skill"] for s in client.get(f"{L}/skills", headers=ram, params={"employee_id": "emp-mahesh"}).json()] == ["React"]
    assert client.get(f"{L}/skills", headers=sophie, params={"employee_id": "emp-mahesh"}).status_code == 404
    assert client.delete(f"{L}/skills/me/{sid}", headers=ram).status_code == 404  # only your own
    assert client.delete(f"{L}/skills/me/{sid}", headers=babu).status_code == 204
