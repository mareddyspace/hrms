"""Sample attendance, timesheets, overtime, comp-off and attendance corrections.

Insert-only and idempotent: adds rows only where none exist yet and never changes a value that is already set,
so it is safe to run again on a database that already holds real data.

- Attendance: the last four weeks up to yesterday (the person's own date) for everyone working, skipping weekly offs,
  their holidays and approved full-day leave; half-day leave gives a half session, work-from-home leave a "wfh" one.
  A person who already has any attendance session is left alone. Today is never touched (people check in themselves).
  Worked time never passes 9 hours (the clock stops there: app/services/attendance.py).
- Timesheets: project members log 9 h a day (4.5 h on half-day leave) on the days they attended; older days approved
  by the manager, a few submitted and waiting, the last two working days still draft (no TimesheetDay row). A person
  with any timesheet entry, day or week is left alone.
- Overtime and comp-off: a few people worked a weekly off; a mix of waiting / approved / rejected.
- Attendance corrections: a mix of pending / approved / rejected, some in Ram's team so his approvals have items.
- Coverage minimums: rows equal to the built-in defaults (so the settings screen lists them; behaviour unchanged).
Values come from a random generator seeded with the employee id and date, so every run makes the same choices.
"""

from __future__ import annotations

import random
from collections import defaultdict
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    AttendanceCorrection,
    AttendanceSession,
    CompOffCredit,
    CoverageMinimum,
    Employee,
    Holiday,
    LeaveRequest,
    OvertimeRequest,
    Project,
    ProjectMember,
    ShiftType,
    TimesheetDay,
    TimesheetEntry,
    TimesheetWeek,
)
from app.services.attendance import AUTO_CHECKOUT_NOTE, MAX_WORK_MINUTES, apply_flags, shift_for
from app.services.leave import WORKING_LEAVE, today_for, weekly_off_for

WINDOW_DAYS = 28  # calendar days back from yesterday (about 20 working days)
NOT_WORKING = {"terminated", "exited", "resigned", "inactive", "on leave", "left", "separated"}
HR_FALLBACK = "demo-hr-admin"
RAM = "emp-ram"
# People the API tests drive by hand on recent dates: no sample overtime, comp-off or corrections for them.
KEEP_CLEAR = {"emp-mahesh"}

TASKS = {
    "prj-internal": ["Team stand-up and planning", "Internal tooling fixes", "Knowledge sharing session"],
    "prj-hrms": ["HRMS leave module changes", "HRMS bug fixes", "HRMS code review"],
    "prj-acme": ["Acme API integration", "Acme sprint tasks", "Acme client call"],
    "prj-globex": ["Globex data migration", "Globex reporting", "Globex QA support"],
    "p-maple": ["Maple feature build", "Maple testing", "Maple design review"],
    "p-north": ["Northwind support tickets", "Northwind release prep", "Northwind performance work"],
}
DEFAULT_TASKS = ["Development", "Testing", "Meetings and planning"]
LATE_REASONS = [
    "The office gate reader didn't register my badge; I was at my desk before shift start.",
    "Checked in from the mobile app after reaching the office - the network was down at the gate.",
]
OUT_REASONS = ["Forgot to check out after a late client call.", "Laptop died before I could check out."]
MISSED_REASON = "Forgot to check in - I was at the client site all day."
OT_REASONS = [
    "Production release over the weekend.",
    "Month-end close support.",
    "Client escalation - fixed a blocking issue.",
    "Data migration cut-over window.",
]


def _rng(*parts: object) -> random.Random:
    return random.Random("|".join(str(p) for p in parts))


def _hm(value: str) -> int:
    h, m = value.split(":")
    return int(h) * 60 + int(m)


def _zone(name: str | None, cache: dict[str, ZoneInfo]) -> ZoneInfo:
    key = name or "UTC"
    if key not in cache:
        try:
            cache[key] = ZoneInfo(key)
        except Exception:  # unknown zone name
            cache[key] = ZoneInfo("UTC")
    return cache[key]


def _at(day: date, minute: int, tz: ZoneInfo) -> datetime:
    """Local minute-of-day on `day` as a UTC datetime."""
    return (datetime.combine(day, time(0, 0), tz) + timedelta(minutes=minute)).astimezone(UTC)


def _working(emp: Employee) -> bool:
    return (emp.employment_status or "").strip().lower() not in NOT_WORKING


def seed(db: Session) -> dict[str, int]:
    stats = {
        "attendance_sessions_added": 0,
        "timesheet_weeks_added": 0,
        "timesheet_entries_added": 0,
        "timesheet_days_added": 0,
        "overtime_requests_added": 0,
        "comp_off_credits_added": 0,
        "attendance_corrections_added": 0,
        "coverage_minimums_added": 0,
    }
    db.flush()
    employees = [e for e in db.scalars(select(Employee).order_by(Employee.id)) if _working(e)]
    if not employees:
        return stats
    by_id = {e.id: e for e in employees}
    reports: set[str] = {e.manager_id for e in employees if e.manager_id}
    hr_ok = db.get(Employee, HR_FALLBACK) is not None
    tz_cache: dict[str, ZoneInfo] = {}

    has_session = set(db.scalars(select(AttendanceSession.employee_id).distinct()))
    window_start = date.today() - timedelta(days=WINDOW_DAYS + 2)
    window_end = date.today() + timedelta(days=1)

    holidays: dict[str, list[tuple[date, str | None]]] = defaultdict(list)
    for h in db.scalars(select(Holiday).where(Holiday.date >= window_start, Holiday.date <= window_end,
                                              Holiday.active.is_(True))):
        holidays[h.country_code].append((h.date, h.calendar))
    weekly_off = {cc: weekly_off_for(db, cc) for cc in {e.country_code for e in employees}}
    leave: dict[str, dict[date, str]] = defaultdict(dict)  # day -> "full" | "half-first" | "half-second" | "wfh"
    for lv in db.scalars(select(LeaveRequest).where(LeaveRequest.status == "approved", LeaveRequest.from_date <= window_end,
                                                    LeaveRequest.to_date >= window_start)):
        d = max(lv.from_date, window_start)
        while d <= min(lv.to_date, window_end):
            if lv.leave_code in WORKING_LEAVE:
                kind = "wfh"
            elif lv.half != "none":
                kind = f"half-{lv.half}"
            else:
                kind = "full"
            if leave[lv.employee_id].get(d) != "full":
                leave[lv.employee_id][d] = kind
            d += timedelta(days=1)

    def is_off(emp: Employee, d: date) -> bool:
        if d.weekday() in weekly_off.get(emp.country_code, {5, 6}):
            return True
        return any(hd == d and (cal is None or cal == emp.holiday_calendar) for hd, cal in holidays.get(emp.country_code, []))

    def decider(emp: Employee) -> str | None:
        if emp.manager_id and emp.manager_id in by_id:
            return emp.manager_id
        return HR_FALLBACK if hr_ok and emp.id != HR_FALLBACK else None

    # ---------- attendance ----------
    sessions: dict[str, dict[date, AttendanceSession]] = defaultdict(dict)
    new_people: list[Employee] = []
    for emp in employees:
        if emp.id in has_session:
            continue
        new_people.append(emp)
        tz = _zone(emp.time_zone, tz_cache)
        start_s, end_s = shift_for(emp)
        shift_start = _hm(start_s)
        span = (_hm(end_s) - shift_start) % (24 * 60) or 24 * 60
        today = today_for(emp)
        person = _rng("att-profile", emp.id)
        style = person.random()  # < 0.6 office, < 0.85 hybrid, else remote
        punctual = person.random()
        for back in range(WINDOW_DAYS, 0, -1):
            d = today - timedelta(days=back)
            if emp.joining_date and d < emp.joining_date:
                continue
            if is_off(emp, d):
                continue
            kind = leave[emp.id].get(d)
            if kind == "full":
                continue
            r = _rng("att", emp.id, d)
            if kind is None and r.random() < 0.02 and emp.id not in reports:  # an odd unexplained absence
                continue
            # check-in offset from shift start (minutes; positive = late)
            x = r.random()
            late_share = 0.12 + 0.18 * punctual
            if x < late_share * 0.7:
                offset = r.randint(1, 12)
            elif x < late_share:
                offset = r.randint(15, 50)
            else:
                offset = -r.randint(0, 25)
            brk = r.choice((30, 40, 45, 50, 60))
            if r.random() < 0.18 and back > 4:
                # stopped by the 9-hour rule (not in the last few days: such a day lets the person log time late,
                # and the open draft days stay ordinary ones)
                worked = MAX_WORK_MINUTES
            elif r.random() < 0.06:
                worked = r.randint(400, 470)  # left early
            else:
                worked = r.randint(max(0, span - brk - 30), MAX_WORK_MINUTES - 1)
            if kind and kind.startswith("half"):
                half = span // 2
                if kind == "half-first":
                    offset += half
                brk, worked = 0, r.randint(225, 260)
            if kind == "wfh":
                mode = "wfh"
            elif style < 0.6:
                mode = "office"
            elif style < 0.85:
                mode = "wfh" if r.random() < 0.4 else "office"
            else:
                mode = "remote"
            source = r.choice(("device", "device", "web")) if mode == "office" else r.choice(("web", "web", "mobile"))
            check_in = _at(d, shift_start + offset, tz)
            breaks = None
            if brk:
                b_start = check_in + timedelta(minutes=min(240, worked // 2) + r.randint(-20, 20))
                b_end = b_start + timedelta(minutes=brk)
                breaks = [{"start": b_start.isoformat(), "end": b_end.isoformat()}]
            check_out = check_in + timedelta(minutes=worked + brk)
            s = AttendanceSession(
                id=f"att-{emp.id}-{d.isoformat()}"[:64], employee_id=emp.id, work_date=d, time_zone=str(tz.key),
                check_in=check_in, check_out=check_out, break_minutes=brk, breaks=breaks, work_mode=mode,
                source=source, shift_start=start_s, shift_end=end_s, corrected=False,
                note=AUTO_CHECKOUT_NOTE if worked >= MAX_WORK_MINUTES else None,
                created_at=check_in, updated_at=check_out,
            )
            apply_flags(s)
            sessions[emp.id][d] = s

    # ---------- overtime and comp-off (worked a weekly off) ----------
    has_ot = set(db.scalars(select(OvertimeRequest.employee_id).distinct()))
    has_credit = set(db.scalars(select(CompOffCredit.employee_id).distinct()))
    candidates = [e for e in new_people if e.id not in reports and e.id not in KEEP_CLEAR and decider(e)
                  and sessions[e.id] and e.manager_id]
    ram_team = [e for e in candidates if e.manager_id == RAM]
    others = [e for e in candidates if e.manager_id != RAM]
    picked = ram_team[:2] + others[::max(1, len(others) // 18)][:18]

    def weekend_day(emp: Employee, nth: int) -> date | None:
        today = today_for(emp)
        offs = [today - timedelta(days=b) for b in range(2, 28)
                if (today - timedelta(days=b)).weekday() in weekly_off.get(emp.country_code, {5, 6})]
        return offs[nth] if len(offs) > nth else None

    def weekend_session(emp: Employee, d: date, minutes: int) -> AttendanceSession:
        tz = _zone(emp.time_zone, tz_cache)
        start_s, end_s = shift_for(emp)
        check_in = _at(d, 10 * 60, tz)
        s = AttendanceSession(
            id=f"att-{emp.id}-{d.isoformat()}"[:64], employee_id=emp.id, work_date=d, time_zone=str(tz.key),
            check_in=check_in, check_out=check_in + timedelta(minutes=minutes), break_minutes=0, work_mode="office",
            source="web", shift_start=start_s, shift_end=end_s, corrected=False, note="Weekend work",
            created_at=check_in, updated_at=check_in + timedelta(minutes=minutes),
        )
        apply_flags(s)
        sessions[emp.id][d] = s
        return s

    from app.services import overtime as ot_rules

    ot_rows: list[OvertimeRequest] = []
    pending_ot: list[tuple[OvertimeRequest, Employee]] = []
    credits: list[CompOffCredit] = []
    plan = ["Submitted", "Approved", "Approved", "Rejected", "Approved", "Submitted"]
    for i, emp in enumerate(picked):
        r = _rng("ot", emp.id)
        rules = ot_rules.rules_for(emp.country_code)
        if i % 2 == 0 or emp.id in has_credit:  # overtime request
            if emp.id in has_ot:
                continue
            d = weekend_day(emp, i % 3)
            if d is None:
                continue
            hours = float(r.choice((3, 4, 4.5, 5, 6)))
            s = weekend_session(emp, d, int(hours * 60) + r.choice((0, 10, 20)))
            status = plan[(i // 2) % len(plan)] if emp.manager_id != RAM else "Submitted"
            outcome = "comp_off" if rules["comp_off"] and r.random() < 0.5 else "pay"
            rate = ot_rules.hourly_rate(db, emp, d)
            days = ot_rules.comp_off_days(hours, emp.country_code) if outcome == "comp_off" else 0.0
            if outcome == "comp_off" and days <= 0:
                outcome, days = "pay", 0.0
            submitted = _at(d + timedelta(days=2), 10 * 60, _zone(emp.time_zone, tz_cache))
            row = OvertimeRequest(
                id=f"ot-seed-{emp.id}-{d.isoformat()}"[:64], employee_id=emp.id, work_date=d, hours=hours,
                reason=r.choice(OT_REASONS), outcome=outcome, status=status, attendance_minutes=s.worked_minutes,
                hourly_rate=rate, multiplier=rules["multiplier"],
                amount=round(hours * rate * rules["multiplier"]) if outcome == "pay" else 0.0,
                currency=emp.currency, comp_off_days=days, created_at=submitted, updated_at=submitted,
            )
            if status != "Submitted":
                row.decided_by = decider(emp)
                row.decided_at = submitted + timedelta(days=1, hours=3)
                row.updated_at = row.decided_at
                if status == "Approved" and outcome == "pay":
                    row.payout_month = ot_rules.payout_month_for(db, emp, d)
            else:
                pending_ot.append((row, emp))
            ot_rows.append(row)
        else:  # comp-off credit for working a weekly off
            d = weekend_day(emp, 1)
            if d is None or not rules["comp_off"]:
                continue
            weekend_session(emp, d, r.randint(330, 480))
            credits.append(CompOffCredit(
                id=f"co-seed-{emp.id}-{d.isoformat()}"[:64], employee_id=emp.id, worked_date=d, days=1,
                reason="Weekly off (Saturday)" if d.weekday() == 5 else "Weekly off (Sunday)" if d.weekday() == 6
                else "Weekly off", granted_by=decider(emp), expires_on=d + timedelta(days=90),
            ))

    # ---------- attendance corrections ----------
    has_corr = set(db.scalars(select(AttendanceCorrection.employee_id).distinct()))
    corrections: list[AttendanceCorrection] = []
    corr_people = [e for e in candidates if e.id not in has_corr]
    corr_ram = [e for e in corr_people if e.manager_id == RAM]
    corr_others = [e for e in corr_people if e.manager_id != RAM][3::max(1, len(corr_people) // 12)][:10]
    for i, emp in enumerate(corr_ram + corr_others):
        tz = _zone(emp.time_zone, tz_cache)
        days = sorted(d for d, s in sessions[emp.id].items() if not is_off(emp, d) and s.break_minutes)
        if len(days) < 6:
            continue
        status = "pending" if emp.manager_id == RAM or i % 3 == 0 else ("approved" if i % 3 == 1 else "rejected")
        made = _at(days[-1], 20 * 60, tz)
        if i == 0 and emp.manager_id == RAM:
            # a day with no attendance at all: asks for both times
            d = days[-3]
            s = sessions[emp.id].pop(d)
            corrections.append(AttendanceCorrection(
                id=f"corr-seed-{emp.id}-{d.isoformat()}"[:64], employee_id=emp.id, work_date=d, session_id=None,
                requested_check_in=s.check_in, requested_check_out=s.check_out, reason=MISSED_REASON, status=status,
                created_at=made, updated_at=made))
            continue
        late = [d for d in days if sessions[emp.id][d].is_late]
        d = late[-1] if late else days[-4]
        s = sessions[emp.id][d]
        r = _rng("corr", emp.id)
        if i % 2 == 0:
            wanted_in = _at(d, _hm(s.shift_start) - r.randint(2, 15), tz)
            wanted_out, reason = None, r.choice(LATE_REASONS)
        else:
            wanted_in, reason = None, r.choice(OUT_REASONS)
            wanted_out = s.check_out + timedelta(minutes=r.randint(30, 75))
        row = AttendanceCorrection(
            id=f"corr-seed-{emp.id}-{d.isoformat()}"[:64], employee_id=emp.id, work_date=d, session_id=s.id,
            requested_check_in=wanted_in, requested_check_out=wanted_out, reason=reason, status=status,
            created_at=made, updated_at=made)
        if status != "pending":
            row.decided_by = decider(emp)
            row.decided_at = made + timedelta(hours=15)
            row.updated_at = row.decided_at
            if status == "rejected":
                row.decision_note = "The gate log shows the original time; please speak to me if this is wrong."
            else:
                if wanted_in is not None:
                    s.check_in = wanted_in
                if wanted_out is not None:
                    s.check_out = wanted_out
                    s.note = None
                s.corrected = True
                apply_flags(s)
        corrections.append(row)

    for per in sessions.values():
        db.add_all(per.values())
        stats["attendance_sessions_added"] += len(per)
    db.flush()
    db.add_all(ot_rows)
    db.add_all(credits)
    db.add_all(corrections)
    stats["overtime_requests_added"] = len(ot_rows)
    stats["comp_off_credits_added"] = len(credits)
    stats["attendance_corrections_added"] = len(corrections)
    db.flush()
    if pending_ot:
        from app.services import approvals as engine
        from app.services import workflow_defaults

        workflow_defaults.ensure_default(db, ot_rules.OVERTIME)
        for row, emp in pending_ot:
            try:
                row.approval_instance_id = engine.start(db, ot_rules.OVERTIME, row.id, emp, None, actor_id=None).id
            except engine.ApprovalError:
                pass
        db.flush()

    # ---------- timesheets ----------
    _seed_timesheets(db, stats, by_id, sessions, leave, is_off, decider, tz_cache)

    # ---------- coverage minimums (same values as the built-in defaults) ----------
    shifts = set(db.scalars(select(ShiftType.id)))
    existing = {(c.scope, c.shift_id, c.weekday) for c in db.scalars(select(CoverageMinimum))}
    wanted: list[tuple[str, str, int, int]] = []
    for sid in ("sh-morning", "sh-general", "sh-evening"):
        wanted += [("*", sid, wd, 1) for wd in range(1, 6)]
    wanted += [("*", "sh-weekend", wd, 1) for wd in (0, 6)]
    if RAM in by_id:
        wanted += [(RAM, "sh-general", wd, 1) for wd in range(1, 6)]
    for scope, sid, wd, minimum in wanted:
        if sid in shifts and (scope, sid, wd) not in existing:
            db.add(CoverageMinimum(scope=scope, shift_id=sid, weekday=wd, minimum=minimum))
            stats["coverage_minimums_added"] += 1
    db.flush()
    return stats


def _seed_timesheets(db, stats, by_id, sessions, leave, is_off, decider, tz_cache) -> None:
    projects = {p.id: p for p in db.scalars(select(Project).where(Project.active.is_(True)))}
    members: dict[str, list[str]] = defaultdict(list)
    for m in db.scalars(select(ProjectMember).order_by(ProjectMember.employee_id, ProjectMember.project_id)):
        if m.project_id in projects and m.employee_id in by_id:
            members[m.employee_id].append(m.project_id)
    taken = (set(db.scalars(select(TimesheetEntry.employee_id).distinct()))
             | set(db.scalars(select(TimesheetDay.employee_id).distinct()))
             | set(db.scalars(select(TimesheetWeek.employee_id).distinct())))
    weeks_out, entries_out, days_out = [], [], []
    for emp_id, proj_ids in members.items():
        if emp_id in taken or not sessions.get(emp_id):
            continue
        emp = by_id[emp_id]
        tz = _zone(emp.time_zone, tz_cache)
        work_days = sorted(d for d in sessions[emp_id] if not is_off(emp, d))
        if not work_days:
            continue
        weeks: dict[date, TimesheetWeek] = {}
        decide_by = decider(emp)
        n = len(work_days)
        for idx, d in enumerate(work_days):
            live = [p for p in proj_ids if (projects[p].start_date is None or projects[p].start_date <= d)
                    and (projects[p].end_date is None or projects[p].end_date >= d)]
            if not live:
                continue
            monday = d - timedelta(days=d.weekday())
            if monday not in weeks:
                weeks[monday] = TimesheetWeek(id=f"tsw-seed-{emp_id}-{monday.isoformat()}"[:64], employee_id=emp_id,
                                              week_start=monday, status="draft")
            r = _rng("ts", emp_id, d)
            s = sessions[emp_id][d]
            half = (leave.get(emp_id, {}).get(d) or "").startswith("half")
            total_q = 18 if half else 36  # quarter hours: 4.5 h / 9 h
            count = min(len(live), 1 if half else r.choice((1, 2, 2, 3)))
            chosen = r.sample(live, count)
            # split the quarter hours into blocks of at least an hour
            cuts = sorted(r.sample(range(4, total_q - 3), count - 1)) if count > 1 and total_q > 8 else []
            parts = [b - a for a, b in zip([0] + cuts, cuts + [total_q])]
            if any(p < 4 for p in parts):
                parts = [total_q // count] * (count - 1) + [total_q - (total_q // count) * (count - 1)]
            local_in = s.check_in.astimezone(tz)
            minute = ((local_in.hour * 60 + local_in.minute + 14) // 15) * 15
            lunch = 0 if half else (45 if s.break_minutes >= 45 else 30)
            for j, (pid, q) in enumerate(zip(chosen, parts)):
                brk = lunch if j == (1 if count > 1 else 0) else 0
                entries_out.append(TimesheetEntry(
                    id=f"tse-seed-{emp_id}-{d.isoformat()}-{j}"[:64], employee_id=emp_id, week_id=weeks[monday].id,
                    work_date=d, project_id=pid, task=r.choice(TASKS.get(pid, DEFAULT_TASKS)), hours=q / 4,
                    billable=bool(projects[pid].billable_default), comment=None, start_minute=minute,
                    break_minutes=brk, work_type="project", work_id=pid, work_label=projects[pid].name,
                    created_at=s.check_out or s.check_in, updated_at=s.check_out or s.check_in,
                ))
                minute += q * 15 + brk
            # status: last two working days draft, the two before waiting, one older day sent back, the rest approved
            evening = _at(d, 19 * 60, tz)
            if idx >= n - 2:
                continue
            if idx >= n - 4:
                status = "submitted"
            elif idx == n - 9 and r.random() < 0.5:
                status = "rejected"
            else:
                status = "approved"
            row = TimesheetDay(id=f"tsd-seed-{emp_id}-{d.isoformat()}"[:64], employee_id=emp_id, work_date=d,
                               status=status, submitted_at=evening, created_at=evening, updated_at=evening)
            if status != "submitted":
                row.decided_by = decide_by
                row.decided_at = evening + timedelta(hours=15)
                row.updated_at = row.decided_at
                if status == "rejected":
                    row.decision_note = "Please split the hours by task - the client needs the detail."
            days_out.append(row)
        weeks_out.extend(weeks.values())
    db.add_all(weeks_out)
    db.flush()
    db.add_all(entries_out)
    db.add_all(days_out)
    db.flush()
    stats["timesheet_weeks_added"] += len(weeks_out)
    stats["timesheet_entries_added"] += len(entries_out)
    stats["timesheet_days_added"] += len(days_out)
