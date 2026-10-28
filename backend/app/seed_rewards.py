"""Compensation, benefits and letter seed data (fictional; same people and plans as src/data/rewardData.ts). Insert-once:
rows already present (matched by id, or employee + date for pay records) are left as they are.

- grade bands for every grade in use, in all 8 countries (annual base, local currency)
- pay history and bonuses for the 6 sign-in people, two review cycles
- the "compensation" and "letter" approval chains
- benefit plans per country, the open enrollment window, statutory / auto enrollments for the 6 sign-in people,
  Babu's verified dependents and medical cover, a PF nomination
- letter templates (default + country wording) from app/services/letters.py
"""

from __future__ import annotations

from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    Beneficiary,
    BenefitDependent,
    BenefitDependentCoverage,
    BenefitEnrollment,
    BenefitPlan,
    BenefitWindow,
    CompBonus,
    CompensationRecord,
    CompReviewCycle,
    Country,
    Employee,
    GradeBand,
)

# Mid-point of grade L4 / G6 per country; other grades scale from it. Range = mid -20% .. +20%.
BAND_BASE = {"IN": 1_500_000, "US": 120_000, "GB": 62_000, "AU": 125_000, "CA": 105_000, "AE": 300_000, "SA": 290_000,
             "DE": 72_000}
GRADE_FACTOR = {"G3": 0.55, "G4": 0.7, "G5": 0.85, "G6": 1.0, "G7": 1.25, "G8": 1.6, "G9": 2.1,
                "L4": 1.0, "L5": 1.35, "L6": 1.65, "M1": 2.25, "M2": 2.7, "E1": 6.0}

PAY_HISTORY = [  # employee, effective, base, grade, reason
    ("emp-mahesh", "2025-04-01", 1_620_000, "L4", "Annual increment"),
    ("emp-mahesh", "2026-04-01", 1_740_000, "L4", "Annual increment"),
    ("emp-ram", "2025-04-01", 2_900_000, "L6", "Annual increment"),
    ("emp-ram", "2026-04-01", 3_400_000, "M1", "Promotion + increment"),
    ("demo-hr-admin", "2026-04-01", 4_200_000, "M2", "Annual increment"),
    ("demo-recruiter", "2026-04-01", 185_000, "L6", "Annual increment"),
    ("demo-ceo", "2026-04-01", 450_000, "E1", "Board approved"),
    ("demo-admin", "2026-04-01", 82_000, "L5", "Annual increment"),
]
BONUSES = [  # id, employee, type, period, amount, status
    ("bonus-seed-1", "emp-mahesh", "Annual incentive", "FY2025", 120_000, "paid"),
    ("bonus-seed-2", "emp-mahesh", "Spot award", "Q2 2026", 25_000, "accrued"),
    ("bonus-seed-3", "emp-ram", "Annual incentive", "FY2025", 300_000, "paid"),
]
CYCLES = [
    {"id": "cyc-fy2026", "name": "FY2026 Annual compensation review", "effective_date": "2027-04-01", "budget_pct": 8,
     "opens_on": "2026-10-01", "closes_on": "2026-11-30", "status": "open", "countries": ["CA", "GB", "IN", "US"]},
    {"id": "cyc-h1-2026", "name": "H1 2026 Off-cycle adjustments", "effective_date": "2026-04-01", "budget_pct": 3,
     "opens_on": "2026-03-01", "closes_on": "2026-03-31", "status": "closed", "countries": ["IN", "US"]},
]

NO_CONTRACT = {"exclude_employment_types": ["Contract"]}
PLANS: list[dict[str, Any]] = [
    {"id": "bp-in-med", "country_code": "IN", "name": "Group Medical (India)", "plan_type": "Medical",
     "provider": "Northwind Health India", "summary": "Employee + family floater cover", "employee_cost": "Employer paid",
     "employer_annual_cost": 45_000, "covers_dependents": True, "eligibility": NO_CONTRACT},
    {"id": "bp-in-pf", "country_code": "IN", "name": "Provident Fund", "plan_type": "Retirement", "provider": "EPFO",
     "summary": "Statutory PF. Every employee is enrolled from day one.", "employee_cost": "12% of basic",
     "employer_annual_cost": 100_000, "mandatory": True, "auto_enrolled": True},
    {"id": "bp-in-life", "country_code": "IN", "name": "Group Term Life (India)", "plan_type": "Life",
     "provider": "Harbor Life India", "summary": "3x annual base salary life cover", "employee_cost": "Employer paid",
     "employer_annual_cost": 6_000},
    {"id": "bp-in-nps", "country_code": "IN", "name": "NPS employer contribution", "plan_type": "Retirement",
     "provider": "NPS Trust", "summary": "Employer contribution of 10% of basic for senior grades",
     "employee_cost": "Voluntary top-up", "employer_annual_cost": 150_000,
     "eligibility": {"exclude_employment_types": ["Contract"], "min_service_months": 12, "grades": ["G8", "G9", "M1", "M2", "E1"]}},
    {"id": "bp-us-med", "country_code": "US", "name": "Medical PPO", "plan_type": "Medical", "provider": "Northwind Care US",
     "summary": "PPO network, open enrollment in November", "employee_cost": "$120 / paycheck", "employer_annual_cost": 14_000,
     "covers_dependents": True, "eligibility": {"exclude_employment_types": ["Contract"], "min_service_months": 1}},
    {"id": "bp-us-401", "country_code": "US", "name": "401(k)", "plan_type": "Retirement", "provider": "Harbor Retirement Services",
     "summary": "4% employer match", "employee_cost": "Elective deferral", "employer_annual_cost": 5_000,
     "eligibility": {"exclude_employment_types": ["Contract"], "min_service_months": 3}},
    {"id": "bp-uk-med", "country_code": "GB", "name": "Private Medical", "plan_type": "Medical", "provider": "Northwind Health UK",
     "summary": "Employee + optional dependents", "employee_cost": "£45 / month", "employer_annual_cost": 1_800,
     "covers_dependents": True, "eligibility": {"exclude_employment_types": ["Contract"], "min_service_months": 6,
                                                "grades": ["L5", "L6", "M1", "M2", "M3", "E1", "G7", "G8", "G9"]}},
    {"id": "bp-uk-pen", "country_code": "GB", "name": "Workplace Pension", "plan_type": "Retirement", "provider": "Harbor Pensions UK",
     "summary": "Auto-enrolment pension, 3% employer contribution. You can opt out.", "employee_cost": "5% of qualifying earnings",
     "employer_annual_cost": 2_400, "auto_enrolled": True,
     "eligibility": {"exclude_employment_types": ["Contract"], "min_service_months": 3}},
    {"id": "bp-ae-med", "country_code": "AE", "name": "DHA Medical", "plan_type": "Medical", "provider": "Gulf Shield Care",
     "summary": "Mandatory medical insurance (DHA)", "employee_cost": "Employer paid", "employer_annual_cost": 9_000,
     "covers_dependents": True, "mandatory": True, "auto_enrolled": True},
    {"id": "bp-ae-life", "country_code": "AE", "name": "Group Life (UAE)", "plan_type": "Life", "provider": "Gulf Shield Life",
     "summary": "24 months of base salary", "employee_cost": "Employer paid", "employer_annual_cost": 1_200},
    {"id": "bp-au-super", "country_code": "AU", "name": "Superannuation", "plan_type": "Retirement", "provider": "Harbor Super AU",
     "summary": "Superannuation guarantee", "employee_cost": "Optional salary sacrifice", "employer_annual_cost": 14_000,
     "mandatory": True, "auto_enrolled": True},
    {"id": "bp-au-med", "country_code": "AU", "name": "Private Health (Australia)", "plan_type": "Medical",
     "provider": "Northwind Health AU", "summary": "Hospital + extras cover", "employee_cost": "A$30 / fortnight",
     "employer_annual_cost": 2_500, "covers_dependents": True, "eligibility": NO_CONTRACT},
    {"id": "bp-ca-health", "country_code": "CA", "name": "Extended Health & Dental", "plan_type": "Medical",
     "provider": "Northwind Care Canada", "summary": "Extended health, dental and vision", "employee_cost": "C$40 / month",
     "employer_annual_cost": 3_000, "covers_dependents": True,
     "eligibility": {"exclude_employment_types": ["Contract"], "min_service_months": 3}},
    {"id": "bp-ca-rrsp", "country_code": "CA", "name": "Group RRSP", "plan_type": "Retirement", "provider": "Harbor Retirement Canada",
     "summary": "Employer match up to 4%", "employee_cost": "Elective contribution", "employer_annual_cost": 4_000,
     "eligibility": NO_CONTRACT},
    {"id": "bp-sa-med", "country_code": "SA", "name": "CCHI Medical", "plan_type": "Medical", "provider": "Gulf Shield Care KSA",
     "summary": "Mandatory medical insurance (CCHI)", "employee_cost": "Employer paid", "employer_annual_cost": 8_000,
     "covers_dependents": True, "mandatory": True, "auto_enrolled": True},
    {"id": "bp-sa-gosi", "country_code": "SA", "name": "GOSI", "plan_type": "Retirement", "provider": "GOSI",
     "summary": "Statutory social insurance", "employee_cost": "Statutory share", "employer_annual_cost": 12_000,
     "mandatory": True, "auto_enrolled": True},
    {"id": "bp-de-health", "country_code": "DE", "name": "Statutory health insurance", "plan_type": "Medical",
     "provider": "Gesetzliche Krankenkasse", "summary": "Employer share of statutory health insurance",
     "employee_cost": "Statutory share", "employer_annual_cost": 5_500, "covers_dependents": True, "mandatory": True,
     "auto_enrolled": True},
    {"id": "bp-de-bav", "country_code": "DE", "name": "Company pension (bAV)", "plan_type": "Retirement",
     "provider": "Harbor Pensionskasse", "summary": "Deferred compensation with 15% employer top-up",
     "employee_cost": "Salary conversion", "employer_annual_cost": 1_800,
     "eligibility": {"exclude_employment_types": ["Contract"], "min_service_months": 6}},
]
OPEN_ENROLLMENT = {"id": "bw-oe-2027", "name": "Open enrollment 2027", "start_date": "2026-10-15", "end_date": "2026-11-15"}
SIGN_IN_PEOPLE = ("emp-mahesh", "emp-ram", "demo-hr-admin", "demo-recruiter", "demo-ceo", "demo-admin")
EXTRA_ENROLLMENTS = [("emp-mahesh", "bp-in-med", "2026-01-01"), ("demo-hr-admin", "bp-in-med", "2026-01-01")]
DEPENDENTS = [
    ("dep-seed-1", "emp-mahesh", "Ananya Menon", "Spouse", "1993-08-21", "Female"),
    ("dep-seed-2", "emp-mahesh", "Arjun Menon", "Child", "2025-05-30", "Male"),
]


def _d(value: str) -> date:
    return date.fromisoformat(value)


def seed(db: Session) -> dict[str, int]:
    from app.services import compensation as comp
    from app.services import letters
    from app.services.benefits import check_eligibility

    stats = {"grade_bands": 0, "comp_records": 0, "benefit_plans": 0, "letter_templates": 0}
    countries = {c.code: c for c in db.scalars(select(Country))}
    for code, base in BAND_BASE.items():
        if code not in countries:
            continue
        for grade, factor in GRADE_FACTOR.items():
            bid = f"gb-{code.lower()}-{grade.lower()}"
            if db.get(GradeBand, bid) is None and not db.scalar(select(GradeBand.id).where(GradeBand.grade == grade,
                                                                                           GradeBand.country_code == code)):
                mid = round(base * factor, -3)
                db.add(GradeBand(id=bid, grade=grade, country_code=code, currency=countries[code].currency,
                                 min_amount=round(mid * 0.8, -3), mid_amount=mid, max_amount=round(mid * 1.2, -3)))
                stats["grade_bands"] += 1

    people = {e.id: e for e in db.scalars(select(Employee).where(Employee.id.in_(SIGN_IN_PEOPLE)))}
    for emp_id, effective, base, grade, reason in PAY_HISTORY:
        emp = people.get(emp_id)
        if emp is None:
            continue
        exists = db.scalar(select(CompensationRecord.id).where(CompensationRecord.employee_id == emp_id,
                                                               CompensationRecord.effective_date == _d(effective)))
        if not exists:
            db.add(CompensationRecord(id=f"comp-seed-{emp_id}-{effective}", employee_id=emp_id, effective_date=_d(effective),
                                      base_salary=base, currency=emp.currency, grade=grade, reason=reason))
            stats["comp_records"] += 1
    for bid, emp_id, kind, period, amount, status in BONUSES:
        if emp_id in people and db.get(CompBonus, bid) is None:
            db.add(CompBonus(id=bid, employee_id=emp_id, bonus_type=kind, period=period, amount=amount,
                             currency=people[emp_id].currency, status=status))
    for c in CYCLES:
        if db.get(CompReviewCycle, c["id"]) is None and not db.scalar(select(CompReviewCycle.id).where(CompReviewCycle.name == c["name"])):
            db.add(CompReviewCycle(id=c["id"], name=c["name"], effective_date=_d(c["effective_date"]), budget_pct=c["budget_pct"],
                                   opens_on=_d(c["opens_on"]), closes_on=_d(c["closes_on"]), status=c["status"],
                                   countries=c["countries"]))
    comp.ensure_workflow(db)
    letters.ensure_workflow(db)

    for p in PLANS:
        if p["country_code"] in countries and db.get(BenefitPlan, p["id"]) is None:
            db.add(BenefitPlan(**{"summary": "", "employee_cost": "", "covers_dependents": False, "mandatory": False,
                                  "auto_enrolled": False, "eligibility": {}, "active": True} | p,
                               currency=countries[p["country_code"]].currency))
            stats["benefit_plans"] += 1
    if db.get(BenefitWindow, OPEN_ENROLLMENT["id"]) is None:
        db.add(BenefitWindow(id=OPEN_ENROLLMENT["id"], name=OPEN_ENROLLMENT["name"], country_code=None,
                             start_date=_d(OPEN_ENROLLMENT["start_date"]), end_date=_d(OPEN_ENROLLMENT["end_date"])))
    db.flush()

    today = date.today()
    plans = list(db.scalars(select(BenefitPlan)))
    wanted: list[tuple[str, str, date]] = [(e, p, _d(on)) for e, p, on in EXTRA_ENROLLMENTS if e in people]
    for emp in people.values():
        for plan in plans:
            if (plan.mandatory or plan.auto_enrolled) and check_eligibility(plan, emp, today)[0]:
                wanted.append((emp.id, plan.id, emp.joining_date))
    for emp_id, plan_id, effective in wanted:
        if db.get(BenefitPlan, plan_id) is None:
            continue
        if not db.scalar(select(BenefitEnrollment.id).where(BenefitEnrollment.employee_id == emp_id,
                                                            BenefitEnrollment.plan_id == plan_id)):
            db.add(BenefitEnrollment(id=f"be-seed-{emp_id}-{plan_id}"[:64], employee_id=emp_id, plan_id=plan_id,
                                     status="approved", effective_date=effective, note="Seeded"))
    for dep_id, emp_id, name, relationship, dob, gender in DEPENDENTS:
        if emp_id in people and db.get(BenefitDependent, dep_id) is None:
            db.add(BenefitDependent(id=dep_id, employee_id=emp_id, name=name, relationship=relationship, date_of_birth=_d(dob),
                                    gender=gender, verification="verified", verified_by="demo-hr-admin"))
    db.flush()
    med = db.scalar(select(BenefitEnrollment).where(BenefitEnrollment.employee_id == "emp-mahesh", BenefitEnrollment.plan_id == "bp-in-med"))
    if med is not None:
        for dep_id, emp_id, *_ in DEPENDENTS:
            if db.get(BenefitDependent, dep_id) is not None and db.get(BenefitDependentCoverage, (med.id, dep_id)) is None:
                db.add(BenefitDependentCoverage(enrollment_id=med.id, dependent_id=dep_id))
    if "emp-mahesh" in people and not db.scalar(select(Beneficiary.id).where(Beneficiary.employee_id == "emp-mahesh")):
        db.add(Beneficiary(employee_id="emp-mahesh", nomination_for="Provident Fund", name="Ananya Menon", relationship="Spouse",
                           share_pct=100, date_of_birth=_d("1993-08-21")))

    stats["letter_templates"] = letters.seed_templates(db, sorted(countries))
    db.flush()
    return stats
