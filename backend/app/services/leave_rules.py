"""Leave eligibility, country config defaults and the year-end carry-forward job (migration 0011).

Eligibility on a leave policy (NULL = no limit):
- gender: any | female | male (types for the other gender are hidden from balances)
- min_service_months: months since joining_date
- employment_types: list such as ["Full-Time"] (compared ignoring case, spaces and hyphens)
- not_in_probation: not while joining_date + the country's probation_months is still ahead
- max_per_request / min_notice_days: checked when someone applies

Carry-forward: run_carry_forward() writes one leave_carry_forwards row per person, leave type and year
(min(carry_forward_max, unused last year)). Balances use the saved row when there is one. Running it again
for the same year adds nothing.
"""

from __future__ import annotations

import logging
from datetime import date

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Country, Employee, LeaveCarryForward, LeavePolicy, LeaveRequest, LeaveType

log = logging.getLogger("timez.leave_rules")

GENDERS = ("any", "female", "male")
DEFAULT_PROBATION_MONTHS = 6
WEEK_DAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")

# Country config defaults (filled only where a column is still empty).
COUNTRY_DEFAULTS: dict[str, dict] = {
    "IN": {"languages": ["en", "hi"], "work_week_days": ["Mon", "Tue", "Wed", "Thu", "Fri"], "standard_daily_hours": 9,
           "probation_months": 6, "notice_days": 60, "required_documents": ["PAN", "Aadhaar", "Bank details"],
           "workflow_notes": "Leave goes to the line manager. Resignations need HR sign-off."},
    "US": {"languages": ["en"], "work_week_days": ["Mon", "Tue", "Wed", "Thu", "Fri"], "standard_daily_hours": 8,
           "probation_months": 3, "notice_days": 14, "required_documents": ["I-9", "W-4"],
           "workflow_notes": "At-will employment. FMLA leave needs HR review."},
    "GB": {"languages": ["en"], "work_week_days": ["Mon", "Tue", "Wed", "Thu", "Fri"], "standard_daily_hours": 7.5,
           "probation_months": 6, "notice_days": 30, "required_documents": ["Right to work check", "P45"],
           "workflow_notes": "Statutory leave follows UK rules. Sick notes after 7 days."},
    "AU": {"languages": ["en"], "work_week_days": ["Mon", "Tue", "Wed", "Thu", "Fri"], "standard_daily_hours": 7.6,
           "probation_months": 6, "notice_days": 28, "required_documents": ["TFN declaration", "Super choice form"],
           "workflow_notes": "Long service leave after 10 years."},
    "CA": {"languages": ["en"], "work_week_days": ["Mon", "Tue", "Wed", "Thu", "Fri"], "standard_daily_hours": 8,
           "probation_months": 3, "notice_days": 14, "required_documents": ["TD1", "SIN"],
           "workflow_notes": "Provincial rules apply to leave and notice."},
    "AE": {"languages": ["en", "ar"], "work_week_days": ["Mon", "Tue", "Wed", "Thu", "Fri"], "standard_daily_hours": 8,
           "probation_months": 6, "notice_days": 30, "required_documents": ["Passport", "Emirates ID", "Work visa"],
           "workflow_notes": "Visa and labour card changes need HR approval."},
    "SA": {"languages": ["en", "ar"], "work_week_days": ["Sun", "Mon", "Tue", "Wed", "Thu"], "standard_daily_hours": 8,
           "probation_months": 3, "notice_days": 60, "required_documents": ["Iqama", "Passport"],
           "workflow_notes": "Iqama renewals are tracked by HR."},
    "DE": {"languages": ["en", "de"], "work_week_days": ["Mon", "Tue", "Wed", "Thu", "Fri"], "standard_daily_hours": 8,
           "probation_months": 6, "notice_days": 28, "required_documents": ["Tax ID", "Social security number"],
           "workflow_notes": "Works council may need to be told about some changes."},
}
COUNTRY_FALLBACK = {"languages": ["en"], "work_week_days": ["Mon", "Tue", "Wed", "Thu", "Fri"], "standard_daily_hours": 8,
                    "probation_months": DEFAULT_PROBATION_MONTHS, "notice_days": 30, "required_documents": [],
                    "workflow_notes": ""}
COUNTRY_CONFIG_FIELDS = tuple(COUNTRY_FALLBACK)

# New leave types (insert once) and the working-day quota per country.
EXTRA_TYPES: dict[str, dict] = {
    "maternity": {"name": "Maternity leave", "half_day_allowed": False,
                  "quota": {"IN": 130, "US": 60, "GB": 130, "AU": 60, "CA": 85, "AE": 60, "SA": 50, "DE": 70}},
    "paternity": {"name": "Paternity leave", "half_day_allowed": False,
                  "quota": {"IN": 5, "US": 5, "GB": 10, "AU": 10, "CA": 5, "AE": 5, "SA": 3, "DE": 10}},
    "sabbatical": {"name": "Sabbatical", "half_day_allowed": False, "quota": {}, "default_quota": 20},
}

# Eligibility defaults per leave code (applied once, while a policy's gender is still NULL).
RULE_DEFAULTS: dict[str, dict] = {
    "maternity": {"gender": "female"},
    "paternity": {"gender": "male", "max_per_request": 10},
    "sabbatical": {"min_service_months": 60, "employment_types": ["Full-Time"], "not_in_probation": True,
                   "max_per_request": 20, "min_notice_days": 30},
    "bereavement": {"max_per_request": 5},
}


def _norm(value: str | None) -> str:
    return (value or "").strip().lower().replace("-", "").replace(" ", "")


def add_months(day: date, months: int) -> date:
    y, m = divmod(day.month - 1 + months, 12)
    year, month = day.year + y, m + 1
    for d in (day.day, 30, 29, 28):
        try:
            return date(year, month, d)
        except ValueError:
            continue
    return date(year, month, 28)


def service_months(joined: date, on: date) -> int:
    months = (on.year - joined.year) * 12 + on.month - joined.month
    if on.day < joined.day:
        months -= 1
    return max(0, months)


def probation_end(db: Session, employee: Employee) -> date:
    country = db.get(Country, employee.country_code)
    months = country.probation_months if country and country.probation_months is not None else DEFAULT_PROBATION_MONTHS
    return add_months(employee.joining_date, months)


def hidden_for(policy: LeavePolicy, employee: Employee) -> bool:
    """Types only for the other gender aren't shown at all."""
    want = (policy.gender or "any").lower()
    return want in ("female", "male") and _norm(employee.gender) != want


def ineligible_reason(db: Session, employee: Employee, policy: LeavePolicy, on: date) -> str | None:
    """Why this person can't take this leave on `on`, or None."""
    want = (policy.gender or "any").lower()
    if want in ("female", "male") and _norm(employee.gender) != want:
        return f"Only for {want} employees."
    if policy.min_service_months and employee.joining_date:
        have = service_months(employee.joining_date, on)
        if have < policy.min_service_months:
            return f"Needs {policy.min_service_months} months of service (you have {have})."
    types = [t for t in (policy.employment_types or []) if t]
    if types and _norm(employee.employment_type) not in {_norm(t) for t in types}:
        return f"Not open to {employee.employment_type or 'your'} employees."
    if policy.not_in_probation and employee.joining_date:
        ends = probation_end(db, employee)
        if on < ends:
            return f"Not available during probation (ends {ends.isoformat()})."
    return None


def check_request(db: Session, employee: Employee, policy: LeavePolicy, start: date, days: float, today: date) -> str | None:
    """Eligibility plus per-request limits for a new request. Returns a message or None."""
    reason = ineligible_reason(db, employee, policy, start)
    if reason:
        return f"{policy.name}: {reason}"
    if policy.min_notice_days and (start - today).days < policy.min_notice_days:
        return f"{policy.name} needs at least {policy.min_notice_days} days' notice."
    if policy.max_per_request and days > float(policy.max_per_request):
        return f"At most {float(policy.max_per_request):g} day(s) of {policy.name} per request."
    return None


def saved_carry(db: Session, employee_id: str, code: str, year: int) -> float | None:
    row = db.scalar(select(LeaveCarryForward.days).where(
        LeaveCarryForward.employee_id == employee_id, LeaveCarryForward.leave_code == code, LeaveCarryForward.to_year == year))
    return None if row is None else float(row)


# ---------- seeding (idempotent) ----------
def ensure_country_config(db: Session) -> int:
    changed = 0
    for country in db.scalars(select(Country)):
        defaults = COUNTRY_DEFAULTS.get(country.code, COUNTRY_FALLBACK)
        for field in COUNTRY_CONFIG_FIELDS:
            if getattr(country, field) is None:
                setattr(country, field, defaults.get(field, COUNTRY_FALLBACK[field]))
                changed += 1
    return changed


def ensure_leave_rule_defaults(db: Session, effective_from: date = date(2026, 1, 1)) -> dict[str, int]:
    added = 0
    countries = list(db.scalars(select(Country.code)))
    for code, spec in EXTRA_TYPES.items():
        if db.get(LeaveType, code) is None:
            db.add(LeaveType(code=code, name=spec["name"], half_day_allowed=spec["half_day_allowed"], active=True))
            db.flush()
        for cc in countries:
            pid = f"{code}-{cc}-{effective_from.year}"
            if db.get(LeavePolicy, pid) is None:
                db.add(LeavePolicy(id=pid, leave_code=code, country_code=cc, name=spec["name"],
                                   quota=spec["quota"].get(cc, spec.get("default_quota", 0)), carry_forward_max=0,
                                   accrual="annual", effective_from=effective_from, effective_to=None))
                added += 1
    db.flush()
    ruled = 0
    for policy in db.scalars(select(LeavePolicy).where(LeavePolicy.gender.is_(None))):
        rules = RULE_DEFAULTS.get(policy.leave_code, {})
        policy.gender = rules.get("gender", "any")
        for field in ("min_service_months", "employment_types", "max_per_request", "min_notice_days"):
            if field in rules:
                setattr(policy, field, rules[field])
        policy.not_in_probation = bool(rules.get("not_in_probation", False))
        ruled += 1
    return {"leave_policies_added": added, "leave_rules_defaulted": ruled}


def seed_defaults(db: Session) -> dict[str, int]:
    out = {"country_config_filled": ensure_country_config(db)}
    out.update(ensure_leave_rule_defaults(db))
    db.flush()
    return out


# ---------- year-end carry-forward ----------
def run_carry_forward(db: Session, to_year: int | None = None, today: date | None = None) -> dict[str, int]:
    """Carry unused days from to_year - 1 into to_year (default: this year). Idempotent per year."""
    to_year = to_year or (today or date.today()).year
    from_year = to_year - 1
    year_end = date(from_year, 12, 31)
    policies = list(db.scalars(select(LeavePolicy).join(LeaveType, LeaveType.code == LeavePolicy.leave_code).where(
        LeavePolicy.active.is_(True), LeaveType.active.is_(True), LeavePolicy.carry_forward_max > 0,
        LeavePolicy.effective_from <= date(to_year, 1, 1),
        (LeavePolicy.effective_to.is_(None)) | (LeavePolicy.effective_to >= year_end))))
    if not policies:
        return {"year": to_year, "created": 0, "skipped": 0}
    by_country: dict[str, list[LeavePolicy]] = {}
    for p in policies:
        by_country.setdefault(p.country_code, []).append(p)
    used = {
        (emp, code): float(days or 0)
        for emp, code, days in db.execute(
            select(LeaveRequest.employee_id, LeaveRequest.leave_code, func.sum(LeaveRequest.days)).where(
                LeaveRequest.status == "approved", LeaveRequest.from_date >= date(from_year, 1, 1),
                LeaveRequest.from_date <= year_end).group_by(LeaveRequest.employee_id, LeaveRequest.leave_code))
    }
    done = {(e, c) for e, c in db.execute(select(LeaveCarryForward.employee_id, LeaveCarryForward.leave_code).where(
        LeaveCarryForward.to_year == to_year))}
    created = skipped = 0
    for emp in db.scalars(select(Employee).where(Employee.country_code.in_(list(by_country)),
                                                 Employee.joining_date <= year_end)):
        for policy in by_country.get(emp.country_code, []):
            if (emp.id, policy.leave_code) in done:
                skipped += 1
                continue
            if hidden_for(policy, emp):
                continue
            unused = max(0.0, float(policy.quota) - used.get((emp.id, policy.leave_code), 0.0))
            db.add(LeaveCarryForward(employee_id=emp.id, leave_code=policy.leave_code, policy_id=policy.id,
                                     to_year=to_year, unused=unused, days=min(float(policy.carry_forward_max), unused)))
            done.add((emp.id, policy.leave_code))
            created += 1
    db.flush()
    return {"year": to_year, "created": created, "skipped": skipped}


def run_carry_forward_safely(db: Session, today: date) -> dict[str, int] | str:
    """For jobs.run_all: never breaks the other jobs (e.g. before migration 0011 has run)."""
    try:
        with db.begin_nested():
            return run_carry_forward(db, today.year, today)
    except Exception as exc:  # noqa: BLE001
        log.warning("Leave carry-forward skipped (%s).", exc.__class__.__name__)
        return "skipped"
