"""Full person records carry the job profile (from the position, else the profile with the same job title)."""

from __future__ import annotations

from sqlalchemy import select

from app.db import SessionLocal
from app.models import Employee, JobProfile


def test_job_profile_on_full_records_only(client, farhan, babu):
    with SessionLocal() as db:
        titles = {p.title: p for p in db.scalars(select(JobProfile).where(JobProfile.active.is_(True)))}
        emp = db.scalar(select(Employee).where(Employee.job_title.in_(list(titles) or [""]),
                                               Employee.position_id.is_(None)).limit(1))
        assert emp is not None, "the sample data has someone whose title matches a job profile"
        profile = titles[emp.job_title]
    full = client.get(f"/api/v1/people/{emp.id}", headers=farhan).json()
    assert full["view"] == "full" and full["job_profile_id"] == profile.id and full["job_profile_title"] == profile.title
    listed = client.get("/api/v1/people", headers=farhan, params={"q": emp.employee_code}).json()["items"]
    assert any(p["id"] == emp.id and p["job_profile_id"] == profile.id for p in listed)
    basic = client.get(f"/api/v1/people/{emp.id}", headers=babu).json()
    assert basic["view"] == "basic" and "job_profile_id" not in basic
