"""Load seed data: python -m app.seed  [--reset-passwords]

Safe to re-run: rows are matched by id and updated; existing password hashes and existing leave requests are kept
(pass --reset-passwords to set the demo passwords again and unlock the accounts).
Sources in backend/seed/:
- TimeZ_500_Employee_Sample_HCM_Data.xlsx: the 500-person directory (validated on load, see app/seed_hcm.py)
- accounts.json: the 6 portal sign-in accounts and their own employee records (6 extra people, own reporting line)
- leave_policies.json, holidays.json, countries.json
- a few sample timesheet projects (defined below), with the 6 sign-in people as members
The JSON files are exported from the front end by scripts/export-seed.mjs.
"""

from __future__ import annotations

import argparse
import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import BACKEND_DIR, get_settings
from app.db import SessionLocal
from app.models import (
    AccessScope,
    Account,
    Country,
    Employee,
    EmployeeAssignment,
    Holiday,
    LeavePolicy,
    LeaveRequest,
    LeaveType,
    Project,
    ProjectMember,
)
from app.seed_hcm import SeedDataError, load_employees
from app.security import hash_password
from app.services.leave import holiday_dates, today_for, working_days
from app.services import leave_rules

SEED_DIR = BACKEND_DIR / "seed"
POLICY_EFFECTIVE_FROM = date(2026, 1, 1)
NO_HALF_DAY = {"wfh", "emergency_wfh", "optional"}


def _load(name: str) -> Any:
    return json.loads((SEED_DIR / name).read_text(encoding="utf-8"))


def _d(value: str | None) -> date | None:
    return date.fromisoformat(value) if value else None


def _upsert(db: Session, model: type, key: Any, values: dict[str, Any]) -> Any:
    row = db.get(model, key)
    if row is None:
        row = model(**values)
        db.add(row)
    else:
        for k, v in values.items():
            setattr(row, k, v)
    return row


def seed_countries(db: Session) -> None:
    for c in _load("countries.json"):
        _upsert(db, Country, c["code"], c)


def _account_people(hcm: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The 6 sign-in people, with the same per-country calendar/policy labels as the workbook."""
    by_country = {p["country_code"]: p for p in hcm}
    out = []
    for a in _load("accounts.json"):
        e = dict(a["employee"])
        e.pop("country_name", None)
        e["joining_date"] = _d(e["joining_date"])
        e["date_of_birth"] = _d(e.get("date_of_birth"))
        ref = by_country.get(e["country_code"], {})
        e["holiday_calendar"] = ref.get("holiday_calendar")
        e["leave_policy_name"] = ref.get("leave_policy_name")
        e["payroll_status"] = ref.get("payroll_status")
        e["ai_profile_status"] = None
        e["source"] = "portal_account"
        e["employment_type"] = e["employment_type"].replace(" ", "-")  # same wording as the workbook
        out.append(e)
    return out


def seed_people(db: Session) -> dict[str, int]:
    hcm, counts = load_employees()
    accounts = _account_people(hcm)
    people = hcm + accounts
    ids = [p["id"] for p in people]
    if len(set(ids)) != len(ids) or len({p["email"] for p in people}) != len(people):
        raise SeedDataError("Account people clash with workbook IDs or emails.")
    if any(p["manager_id"] and p["manager_id"] not in {a["id"] for a in accounts} for p in accounts):
        raise SeedDataError("Account people must report to other account people.")
    # Pass 1 without managers (so foreign keys never point at a row not yet written), pass 2 sets them.
    for p in people:
        values = {k: v for k, v in p.items() if k != "manager_id"}
        row = db.get(Employee, p["id"])
        if row is None:
            db.add(Employee(**values, manager_id=None))
        else:
            for k, v in values.items():
                setattr(row, k, v)
    db.flush()
    for p in people:
        db.get(Employee, p["id"]).manager_id = p.get("manager_id")  # type: ignore[union-attr]
    db.flush()
    # One open effective-dated assignment per person, starting at joining.
    have = set(db.scalars(select(EmployeeAssignment.employee_id).where(EmployeeAssignment.effective_to.is_(None))))
    for p in people:
        if p["id"] in have:
            continue
        db.add(
            EmployeeAssignment(
                employee_id=p["id"],
                effective_from=p["joining_date"],
                manager_id=p.get("manager_id"),
                job_title=p["job_title"],
                grade=p["grade"],
                department=p["department"],
                location=p["location"],
                legal_entity=p["legal_entity"],
                employment_status=p["employment_status"],
                business_unit=p.get("business_unit"),
                division=p.get("division"),
                cost_centre=p.get("cost_centre"),
                position_id=p.get("position_id"),
            )
        )
    return {**counts, "account_people": len(accounts), "employees_total": len(people)}


def seed_accounts(db: Session, reset_passwords: bool) -> int:
    accounts = _load("accounts.json")
    for a in accounts:
        row = db.get(Account, a["id"])
        if row is None:
            db.add(Account(id=a["id"], email=a["email"].lower(), password_hash=hash_password(a["password"]), role=a["role"],
                           employee_id=a["employee_id"], active=True, failed_attempts=0))
        else:
            row.email, row.role, row.employee_id = a["email"].lower(), a["role"], a["employee_id"]
            if reset_passwords:
                row.password_hash = hash_password(a["password"])
                row.failed_attempts, row.locked_until = 0, None
                row.must_change_password = False
    db.flush()
    for a in accounts:
        if db.get(AccessScope, a["id"]) is None:
            db.add(AccessScope(account_id=a["id"], country_codes=None))  # NULL = global within the role
    return len(accounts)


def seed_leave_policies(db: Session) -> int:
    countries = [c["code"] for c in _load("countries.json")]
    count = 0
    policies = _load("leave_policies.json")
    for p in policies:
        _upsert(db, LeaveType, p["code"], {"code": p["code"], "name": p["name"], "half_day_allowed": p["code"] not in NO_HALF_DAY, "active": True})
    db.flush()  # no ORM relationships, so write parents before children explicitly
    for p in policies:
        for cc in countries:
            local = (p.get("byCountry") or {}).get(cc, {})
            pid = f"{p['code']}-{cc}-{POLICY_EFFECTIVE_FROM.year}"
            _upsert(db, LeavePolicy, pid, {
                "id": pid,
                "leave_code": p["code"],
                "country_code": cc,
                "name": local.get("name", p["name"]),
                "quota": local.get("quota", p["quota"]),
                "carry_forward_max": local.get("carryForwardMax", p.get("carryForwardMax", 0)) or 0,
                "accrual": p.get("accrual") or "annual",
                "effective_from": POLICY_EFFECTIVE_FROM,
                "effective_to": None,
            })
            count += 1
    return count


def seed_holidays(db: Session) -> int:
    holidays = _load("holidays.json")
    for h in holidays:
        _upsert(db, Holiday, h["id"], {"id": h["id"], "country_code": h["country_code"], "date": _d(h["date"]), "name": h["name"]})
    return len(holidays)


def _next_workday(day: date, holidays: set[date]) -> date:
    while day.weekday() >= 5 or day in holidays:
        day += timedelta(days=1)
    return day


def seed_leave_requests(db: Session) -> int:
    """The same sample requests as the front end seed (src/seed.ts). Inserted once; never overwritten."""
    sophie = db.get(Employee, "demo-recruiter")
    ahead = today_for(sophie) + timedelta(days=7) if sophie else date.today() + timedelta(days=7)
    ahead = _next_workday(ahead, holiday_dates(db, "US", ahead, ahead + timedelta(days=30)))
    samples = [
        ("lv-apr", "emp-mahesh", "comp_off", "2026-04-13", "2026-04-13", "Worked the previous Saturday release", "approved", "emp-ram"),
        ("lv-mar", "emp-mahesh", "pto", "2026-03-16", "2026-03-18", "Family visit", "approved", "emp-ram"),
        ("lv-jun", "emp-mahesh", "pto", "2026-06-22", "2026-06-22", "Personal errand", "approved", "emp-ram"),
        ("lv-oct-wfh", "emp-mahesh", "wfh", "2026-10-22", "2026-10-22", "Home repair appointment", "approved", "emp-ram"),
        ("lv-sophie-pto", "demo-recruiter", "pto", ahead.isoformat(), ahead.isoformat(), "Family function", "pending", None),
    ]
    added = 0
    for rid, emp_id, code, start, end, reason, status, decided_by in samples:
        if db.get(LeaveRequest, rid) is not None or db.get(Employee, emp_id) is None:
            continue
        s, e = date.fromisoformat(start), date.fromisoformat(end)
        country = db.get(Employee, emp_id).country_code  # type: ignore[union-attr]
        days = working_days(s, e, holiday_dates(db, country, s, e))
        db.add(LeaveRequest(id=rid, employee_id=emp_id, leave_code=code, from_date=s, to_date=e, half="none", days=days,
                            reason=reason, status=status, decided_by=decided_by,
                            decided_at=None, decision_note=None))
        added += 1
    return added


PROJECTS = [
    # id, code, name, client, billable by default
    ("prj-internal", "TZ-INT", "Internal & admin", None, False),
    ("prj-hrms", "TZ-HRMS", "TimeZ HRMS platform", None, False),
    ("prj-acme", "ACME-PORTAL", "Acme customer portal", "Acme Corp", True),
    ("prj-globex", "GLOBEX-MIG", "Globex cloud migration", "Globex Ltd", True),
    # Same ids as the portal's ticket projects, so "Log time" on a ticket charges the right project.
    ("p-maple", "MAPLE-PORTAL", "Maple Clinic Portal", "Maple Clinic", True),
    ("p-north", "NW-BILLING", "Northwind Billing", "Northwind Traders", True),
]
# project id -> sign-in people on it (role)
PROJECT_MEMBERS = {
    "prj-internal": ["emp-mahesh", "emp-ram", "demo-hr-admin", "demo-recruiter", "demo-ceo", "demo-admin"],
    "prj-hrms": ["emp-mahesh", "emp-ram", "demo-hr-admin", "demo-admin"],
    "prj-acme": ["emp-mahesh", "emp-ram", "demo-ceo"],
    "prj-globex": ["emp-mahesh", "emp-ram", "demo-recruiter"],
    "p-maple": ["emp-mahesh", "emp-ram"],
    "p-north": ["emp-mahesh", "emp-ram"],
}


def seed_projects(db: Session) -> int:
    """Sample projects; existing rows are updated, members are only added (never removed)."""
    for pid, code, name, client, billable in PROJECTS:
        _upsert(db, Project, pid, {"id": pid, "code": code, "name": name, "client": client, "billable_default": billable, "active": True})
    db.flush()
    for pid, members in PROJECT_MEMBERS.items():
        for emp_id in members:
            if db.get(Employee, emp_id) is not None and db.get(ProjectMember, (pid, emp_id)) is None:
                db.add(ProjectMember(project_id=pid, employee_id=emp_id, role="lead" if emp_id == "emp-ram" else "member"))
    return len(PROJECTS)


def run(reset_passwords: bool = False) -> dict[str, int]:
    with SessionLocal() as db:
        # Load existing rows once so the per-row lookups below hit the session, not the network (matters on Neon).
        cache = [row for model in (Country, Employee, Account, AccessScope, LeaveType, LeavePolicy, Holiday, LeaveRequest,
                                    Project, ProjectMember)
                 for row in db.scalars(select(model)).all()]
        seed_countries(db)
        db.flush()
        stats = seed_people(db)
        stats["accounts"] = seed_accounts(db, reset_passwords)
        stats["leave_policies"] = seed_leave_policies(db)
        stats.update(leave_rules.seed_defaults(db))  # eligibility defaults, new leave types, country config (0011)
        stats["holidays"] = seed_holidays(db)
        stats["optional_holidays_added"] = _seed_optional_holidays(db)  # optional holiday list (0017)
        db.flush()
        stats["leave_requests_added"] = seed_leave_requests(db)
        stats["projects"] = seed_projects(db)
        stats.update(seed_org_and_workflows(db))
        stats.update(seed_talent(db))
        stats.update(seed_engagement_platform(db))
        stats.update(seed_rewards(db))
        stats.update(_seed_career(db))  # skills library, career paths, starter career profiles (0012)
        stats.update(_seed_demo_requests(db))  # a few open requests per demo sign-in (app/seed_demo.py)
        stats.update(_seed_hr_content(db))  # Babu's documents and a policy change to acknowledge (app/seed_hr_content.py)
        stats["tickets_added"] = _seed_tickets(db)  # sample work tickets (0020)
        db.commit()
        del cache
    return stats


def seed_org_and_workflows(db: Session) -> dict[str, int]:
    """Org units, job families and job profiles derived from the employees table, and the default expense / travel /
    lifecycle approval chains. Only adds what is missing (see app/services/org.py, app/services/workflow_defaults.py)."""
    from app.services.org import seed_org_from_employees
    from app.services.workflow_defaults import ensure_all

    db.flush()
    stats = seed_org_from_employees(db)
    stats["workflow_types"] = ensure_all(db)
    from app.services.org_history import seed_history  # effective-dated org history + assignment placement (0013)

    stats.update(seed_history(db))
    return stats


def seed_talent(db: Session) -> dict[str, int]:
    """Recruiting, onboarding templates, a review cycle with goals, the course catalog (app/seed_talent.py). Insert-once."""
    from app.seed_talent import seed

    db.flush()
    return seed(db)


def seed_engagement_platform(db: Session) -> dict[str, int]:
    """Shift types, a pulse survey, the rewards catalogue, integration connectors and email switches (migration 0006).
    Insert-once by id: rows an admin or HR changed are never overwritten."""
    from app.models import EmailChannelSwitch, EngagementSurvey, IntegrationConnector, RewardItem, ShiftType
    from app.services.email_outbox import DEFAULT_SWITCHES

    db.flush()
    added = {"shift_types": 0, "surveys": 0, "rewards": 0, "connectors": 0, "email_switches": 0}

    def add(model: type, key: str, stat: str, **values: Any) -> None:
        if db.get(model, key) is None:
            db.add(model(**values))
            added[stat] += 1

    for sid, name, start, end, weekend in (
        ("sh-morning", "Morning", "06:00", "14:00", False), ("sh-general", "General", "09:30", "18:30", False),
        ("sh-evening", "Evening", "14:00", "22:00", False), ("sh-night", "Night", "22:00", "06:00", False),
        ("sh-weekend", "Weekend support", "09:00", "17:00", True),
    ):
        add(ShiftType, sid, "shift_types", id=sid, name=name, start=start, end=end, weekend_only=weekend, active=True)
    today = date.today()
    add(EngagementSurvey, "srv-pulse-seed", "surveys", id="srv-pulse-seed", title="Quarterly pulse", kind="pulse",
        anonymous=True, audience_type="all", audience_value=None, open_date=today, close_date=today + timedelta(days=21),
        published=True, created_by="demo-hr-admin", questions=[
            {"id": "q1", "kind": "rating", "prompt": "I have the tools I need to do my job well"},
            {"id": "q2", "kind": "rating", "prompt": "My manager gives me useful feedback"},
            {"id": "q3", "kind": "enps", "prompt": "How likely are you to recommend us as a place to work?"},
            {"id": "q4", "kind": "text", "prompt": "What one thing would make work better?"},
        ])
    for rid, name, desc, points, needs_date in (
        ("rw-coffee", "Coffee voucher", "₹500 café voucher, sent by email", 50, False),
        ("rw-swag", "Swag pack", "Hoodie, bottle and stickers", 120, False),
        ("rw-voucher", "Gift voucher", "₹2,000 shopping voucher", 200, False),
        ("rw-dayoff", "Extra day off", "One paid day off — HR adds it to your leave", 300, True),
    ):
        add(RewardItem, rid, "rewards", id=rid, name=name, description=desc, points=points, needs_date=needs_date, active=True)
    for cid, name, category, status, schedule in (
        ("sso", "SSO / Identity", "Identity", "Degraded", "15m"), ("email", "Email", "Communication", "Connected", "15m"),
        ("teams", "Microsoft Teams", "Communication", "Connected", "15m"),
        ("slack", "Slack", "Communication", "Not configured", "hourly"),
        ("attendance", "Attendance devices", "Time", "Connected", "15m"),
        ("learning", "Learning LMS", "Learning", "Connected", "daily"),
        ("benefits", "Benefits carrier", "Benefits", "Degraded", "daily"),
        ("payroll", "External payroll provider", "Payroll", "Connected", "daily"),
    ):
        add(IntegrationConnector, cid, "connectors", id=cid, name=name, category=category, status=status, schedule=schedule,
            run_count=0, records_processed=0, success_count=0, failed_count=0)
    for channel, (label, desc, on) in DEFAULT_SWITCHES.items():
        add(EmailChannelSwitch, channel, "email_switches", channel=channel, label=label, description=desc, email=on)
    db.flush()
    added["roster_shifts"] = _seed_roster(db, today)
    return {f"{k}_added": v for k, v in added.items()}


def _seed_roster(db: Session, today: date) -> int:
    """A published General-shift roster for Ram's team (Babu) this week and next, so Shifts & roster isn't empty.
    Insert-once: a day that already has a shift, or a week Ram already published or edited, is left alone."""
    from app.models import RosterShift, RosterWeek

    if db.get(Employee, "emp-mahesh") is None or db.get(Employee, "emp-ram") is None:
        return 0
    added = 0
    monday = today - timedelta(days=today.weekday())
    for week_start in (monday, monday + timedelta(days=7)):
        if db.scalar(select(RosterWeek).where(RosterWeek.manager_id == "emp-ram", RosterWeek.week_start == week_start)):
            continue
        for offset in range(5):
            day = week_start + timedelta(days=offset)
            taken = db.scalar(select(RosterShift).where(RosterShift.employee_id == "emp-mahesh", RosterShift.work_date == day))
            if taken is None:
                db.add(RosterShift(id=f"rs-seed-{day.isoformat()}", employee_id="emp-mahesh", work_date=day,
                                   shift_id="sh-general", manager_id="emp-ram"))
                added += 1
        db.add(RosterWeek(manager_id="emp-ram", week_start=week_start, status="published",
                          published_at=datetime.now(timezone.utc), published_by="emp-ram", published_with_gaps=False))
    db.flush()
    return added


def seed_rewards(db: Session) -> dict[str, int]:
    """Grade bands, pay history and cycles, benefit plans and enrollments, letter templates (app/seed_rewards.py). Insert-once."""
    from app.seed_rewards import seed

    db.flush()
    return seed(db)


def _seed_career(db: Session) -> dict[str, int]:
    """Skills library, career paths and starter career profiles (app/services/career.py). Insert-once."""
    from app.services.career import seed_career

    db.flush()
    return seed_career(db)


def _seed_hr_content(db: Session) -> dict[str, int]:
    from app.seed_hr_content import seed

    db.flush()
    return seed(db)


def _seed_demo_requests(db: Session) -> dict[str, int]:
    """Open expense / travel / lifecycle / swap requests, a joiner, interviews and an offer. Insert-once by id."""
    from app.seed_demo import seed

    db.flush()
    return seed(db)


def _seed_tickets(db: Session) -> int:
    """Sample work tickets from src/data/ticketStore.ts (app/services/tickets.py). Insert-once by id."""
    from app.services.tickets import seed_samples

    db.flush()
    return seed_samples(db)


def _seed_optional_holidays(db: Session) -> int:
    from app.services.optional_holidays import seed_defaults

    return seed_defaults(db)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Load TimeZ seed data (idempotent).")
    parser.add_argument("--reset-passwords", action="store_true", help="Set the demo passwords again and unlock accounts.")
    args = parser.parse_args()
    result = run(reset_passwords=args.reset_passwords)
    target = "SQLite dev file" if get_settings().is_sqlite else "PostgreSQL"
    print(f"Seeded {target}: " + ", ".join(f"{k}={v}" for k, v in result.items()))
