"""Sample talent activity (app/seed_talent_activity.py): screens have data, the CEO is not given employee compliance
courses or a manager rating, and seeding again adds or changes nothing."""

from __future__ import annotations

from sqlalchemy import func, select

from app import seed
from app.db import SessionLocal
from app.models import Course, Employee, EmployeeSkill, Enrollment, Kudos, PerfReview, RewardRedemption
from app.seed_talent_activity import PAST_CYCLE

API = "/api/v1"


def test_second_seed_adds_nothing():
    stats = seed.run()
    assert {k: v for k, v in stats.items() if k.startswith("talent_") and v} == {}


def test_every_active_person_has_3_to_8_skills():
    with SessionLocal() as db:
        counts = dict(db.execute(select(EmployeeSkill.employee_id, func.count()).group_by(EmployeeSkill.employee_id)).all())
        active = list(db.scalars(select(Employee.id).where(Employee.employment_status == "Active")))
    assert all(i in counts for i in active)
    assert all(3 <= counts[i] <= 8 for i in active if i.startswith("TZ"))


def test_enrollments_follow_course_audience_and_ceo_gets_leadership_only():
    with SessionLocal() as db:
        courses = {c.id: c for c in db.scalars(select(Course))}
        ceo = [courses[e.course_id] for e in db.scalars(select(Enrollment).where(Enrollment.employee_id == "demo-ceo"))]
        assert ceo and not any(c.mandatory for c in ceo)
        depts = dict(db.execute(select(Employee.id, Employee.department)).all())
        for e in db.scalars(select(Enrollment).where(Enrollment.id.like("enr-seed-%"))):
            if courses[e.course_id].audience == "Engineering":
                assert depts[e.employee_id] == "Engineering"


def test_past_cycle_reviews_ceo_has_no_manager_rating():
    with SessionLocal() as db:
        ceo = db.scalar(select(PerfReview).where(PerfReview.cycle_id == PAST_CYCLE[0], PerfReview.employee_id == "demo-ceo"))
        babu = db.scalar(select(PerfReview).where(PerfReview.cycle_id == PAST_CYCLE[0], PerfReview.employee_id == "emp-mahesh"))
    assert ceo is not None and ceo.self_status == "submitted" and ceo.manager_status == "not_started" and ceo.rating is None
    assert babu is not None and babu.manager_id == "emp-ram" and babu.released and babu.rating


def test_points_never_overspent():
    with SessionLocal() as db:
        received = dict(db.execute(select(Kudos.to_id, func.sum(Kudos.points)).group_by(Kudos.to_id)).all())
        spent = dict(db.execute(select(RewardRedemption.employee_id, func.sum(RewardRedemption.points))
                                .where(RewardRedemption.id.like("rr-seed-%")).group_by(RewardRedemption.employee_id)).all())
    assert all(spent[i] <= (received.get(i) or 0) for i in spent)


def test_screens_have_data(client, babu, farhan):
    from tests.conftest import login

    sophie, jordan = login(client, "sophie.clark@timez.com"), login(client, "jordan.blake@timez.com")
    assert client.get(f"{API}/learning/skills", headers=babu).json()
    assert client.get(f"{API}/learning/enrollments", headers=babu).json()
    assert client.get(f"{API}/performance/check-ins", headers=babu).json()
    assert len(client.get(f"{API}/surveys/trend", headers=farhan).json()) >= 3
    assert client.get(f"{API}/recruiting/my-activity", headers=sophie).json()
    me = client.get(f"{API}/career/me", headers=jordan).json()
    assert me["interests"] and me["target_roles"]
    assert client.get(f"{API}/recognition/points", headers=babu).json()["received"] > 0
