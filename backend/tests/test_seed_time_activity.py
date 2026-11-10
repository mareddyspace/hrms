"""Sample attendance / timesheets / overtime / corrections (app/seed_time_activity.py): present, consistent, insert-once."""

from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta

from sqlalchemy import func, or_, select

from app import seed_time_activity
from app.db import SessionLocal
from app.models import (
    AttendanceCorrection,
    AttendanceSession,
    CompOffCredit,
    CoverageMinimum,
    Employee,
    LeaveRequest,
    OvertimeRequest,
    TimesheetDay,
    TimesheetEntry,
    TimesheetWeek,
)
from app.services.attendance import MAX_WORK_MINUTES
from app.services import leave_rules
from app.services.leave import DAY_INDEX, WORKING_LEAVE, holiday_dates_for

SEEDED = "att-%"
DEMO = ("emp-mahesh", "emp-priya", "emp-oliver", "emp-ram", "demo-hr-admin", "demo-recruiter", "demo-ceo", "demo-admin")


def _count(db, model, *where) -> int:
    return db.scalar(select(func.count()).select_from(model).where(*where)) or 0


def test_seeded_counts(database):
    with SessionLocal() as db:
        assert _count(db, AttendanceSession) > 5000
        assert _count(db, TimesheetEntry, TimesheetEntry.id.like("tse-seed-%")) > 100
        assert _count(db, TimesheetDay, TimesheetDay.id.like("tsd-seed-%"), TimesheetDay.status == "approved") > 50
        assert _count(db, TimesheetDay, TimesheetDay.id.like("tsd-seed-%"), TimesheetDay.status == "submitted") > 0
        assert _count(db, OvertimeRequest, OvertimeRequest.id.like("ot-seed-%")) > 0
        assert _count(db, CompOffCredit, CompOffCredit.id.like("co-seed-%")) > 0
        statuses = set(db.scalars(select(AttendanceCorrection.status).where(AttendanceCorrection.id.like("corr-seed-%"))))
        assert {"pending", "approved", "rejected"} <= statuses
        assert _count(db, CoverageMinimum) > 0
        # Ram has something to approve
        team = set(db.scalars(select(Employee.id).where(Employee.manager_id == "emp-ram")))
        assert _count(db, AttendanceCorrection, AttendanceCorrection.employee_id.in_(team),
                      AttendanceCorrection.status == "pending") > 0
        assert _count(db, TimesheetDay, TimesheetDay.employee_id.in_(team), TimesheetDay.status == "submitted") > 0


def test_second_run_adds_nothing(database):
    with SessionLocal() as db:
        stats = seed_time_activity.seed(db)
        db.rollback()
    assert stats and all(v == 0 for v in stats.values()), stats


def test_attendance_obeys_the_rules(database):
    with SessionLocal() as db:
        # workbook people only: the demo sign-ins check in and correct attendance in other tests
        rows = list(db.scalars(select(AttendanceSession).where(
            AttendanceSession.id.like(SEEDED), AttendanceSession.employee_id.not_in(DEMO),
            or_(AttendanceSession.note.is_(None), AttendanceSession.note != "Weekend work"))))
        # weekend days worked for overtime (other tests may decide or correct those, changing the note)
        overtime_days = {(o.employee_id, o.work_date) for o in db.scalars(select(OvertimeRequest))}
        rows = [s for s in rows if (s.employee_id, s.work_date) not in overtime_days]
        # seeded sessions are stamped at their own check-in; rows other tests create through the API are stamped now
        rows = [s for s in rows if s.created_at is None or s.created_at.date() <= s.work_date + timedelta(days=1)]
        people = {e.id: e for e in db.scalars(select(Employee))}
        leave = defaultdict(set)
        for lv in db.scalars(select(LeaveRequest).where(LeaveRequest.status == "approved", LeaveRequest.half == "none",
                                                        LeaveRequest.leave_code.not_in(WORKING_LEAVE))):
            d = lv.from_date
            while d <= lv.to_date:
                leave[lv.employee_id].add(d)
                d += timedelta(days=1)
        start = date.today() - timedelta(days=40)
        offs, hols = {}, {}
        for s in rows:
            emp = people[s.employee_id]
            assert s.work_date < date.today() + timedelta(days=1)
            assert s.check_out is not None and s.check_out > s.check_in
            if not s.corrected:
                assert 0 < s.worked_minutes <= MAX_WORK_MINUTES
            if emp.id not in offs:
                # the country default (other tests change a country's working week after seeding)
                days = leave_rules.COUNTRY_DEFAULTS.get(emp.country_code, leave_rules.COUNTRY_FALLBACK)["work_week_days"]
                # a day off both by default and in the country's current setting (tests change it, then re-seed)
                from app.services.leave import weekly_off_for

                offs[emp.id] = (set(range(7)) - {DAY_INDEX[d] for d in days}) & set(weekly_off_for(db, emp.country_code))
                hols[emp.id] = holiday_dates_for(db, emp, start, date.today())
            assert s.work_date.weekday() not in offs[emp.id], (s.id, "weekly off")
            assert s.work_date not in hols[emp.id], (s.id, "holiday")
            assert s.work_date not in leave[emp.id], (s.id, "on leave")
        assert any(s.is_late for s in rows) and any(not s.is_late for s in rows)
        assert {"office", "wfh", "remote"} <= {s.work_mode for s in rows}


def test_timesheets_obey_the_rules(database):
    with SessionLocal() as db:
        per_day = defaultdict(float)
        billable = set()
        for e in db.scalars(select(TimesheetEntry).where(TimesheetEntry.id.like("tse-seed-%"))):
            per_day[(e.employee_id, e.work_date)] += float(e.hours)
            billable.add(e.billable)
            week = db.get(TimesheetWeek, e.week_id)
            assert week.employee_id == e.employee_id and week.week_start == e.work_date - timedelta(days=e.work_date.weekday())
            assert db.scalar(select(AttendanceSession.id).where(AttendanceSession.employee_id == e.employee_id,
                                                                AttendanceSession.work_date == e.work_date))
        assert billable == {True, False}
        assert all(h in (4.5, 9.0) for h in per_day.values()), set(per_day.values())
        for d in db.scalars(select(TimesheetDay).where(TimesheetDay.id.like("tsd-seed-%"))):
            assert per_day[(d.employee_id, d.work_date)] > 0  # nothing submitted empty
            if d.status in ("approved", "rejected"):
                assert d.decided_by and d.decided_at
            if d.status == "rejected":
                assert d.decision_note


def test_overtime_and_comp_off_are_plausible(database):
    with SessionLocal() as db:
        for row in db.scalars(select(OvertimeRequest).where(OvertimeRequest.id.like("ot-seed-%"))):
            assert 0.5 <= row.hours <= 12 and row.attendance_minutes and row.attendance_minutes >= row.hours * 60
            assert row.work_date < date.today()
            if row.status == "Submitted":
                assert row.approval_instance_id
            else:
                assert row.decided_by
            assert (row.outcome == "comp_off") == (row.comp_off_days > 0)
        for c in db.scalars(select(CompOffCredit).where(CompOffCredit.id.like("co-seed-%"))):
            assert c.expires_on == c.worked_date + timedelta(days=90) and c.granted_by != c.employee_id
