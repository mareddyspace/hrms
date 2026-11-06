"""GET /attendance/in-scope: other people's sessions for team and company attendance charts, within data scope."""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import select

from app.db import SessionLocal
from app.models import AttendanceSession, Employee
from app.services import attendance as rules
from tests.test_audit_rbac import sample_employee

URL = "/api/v1/attendance/in-scope"


def _closed_session(emp_id: str, days_back: int) -> str:
    with SessionLocal() as db:
        emp = db.get(Employee, emp_id)
        day = rules.local_today(emp) - timedelta(days=days_back)
        while db.scalar(select(AttendanceSession.id).where(AttendanceSession.employee_id == emp_id,
                                                           AttendanceSession.work_date == day)):
            day -= timedelta(days=1)
        start = rules.to_utc(rules.datetime.combine(day, rules.time(9, 30)), emp)
        s = rules.new_session(emp, day, start, "office", "web")
        s.check_out = start + timedelta(hours=8)
        rules.apply_flags(s)
        db.add(s)
        db.commit()
        return s.id


def test_in_scope_follows_the_data_scope(client, babu, ram, farhan):
    babu_sid = _closed_session("emp-mahesh", 20)
    stranger = sample_employee("GB", offset=11)
    stranger_sid = _closed_session(stranger, 20)

    with SessionLocal() as db:
        today = rules.local_today(db.get(Employee, "emp-ram"))
    params = {"from": (today - timedelta(days=40)).isoformat(), "to": today.isoformat()}
    ids = lambda h: {s["id"] for s in client.get(URL, headers=h, params=params).json()}  # noqa: E731
    assert babu_sid in ids(ram) and stranger_sid not in ids(ram)  # manager: own reporting line only
    assert {babu_sid, stranger_sid} <= ids(farhan)  # HR: everyone
    assert babu_sid not in ids(babu) and stranger_sid not in ids(babu)  # never their own, nobody else's
    assert client.get(URL, headers=farhan, params={"from": (today - timedelta(days=200)).isoformat(),
                                                    "to": today.isoformat()}).status_code == 422
