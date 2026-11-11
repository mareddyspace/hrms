"""The seeded sample data never contradicts itself (whole database, after app.seed.run twice).

Dates: nothing sample is dated before the people involved joined; people: managers, hiring managers, reviewers and
emergency contacts make sense; eligibility: country-only items stay in their country; text: genders fit names.
Checks look at the seeded sample rows (fixed seed ids) so records other tests add do not count.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

from sqlalchemy import select

from app.db import SessionLocal
from app.models import (
    BenefitDependent,
    BenefitEnrollment,
    BenefitPlan,
    Certification,
    CheckIn,
    Country,
    Employee,
    EmployeeDocument,
    Enrollment,
    ExpenseClaim,
    Kudos,
    LeaveRequest,
    LifecycleAction,
    PerfFeedback,
    PerfReview,
    ReviewCycle,
    Reviewer360,
    TaxDeclaration,
    TravelRequest,
)
from app.seed_hcm import NAME_GENDER
from app.seed_repairs import _seniority
from app.services.compliance_calendar import probation_end

CURRENCY = {"IN": "INR", "US": "USD", "GB": "GBP", "AU": "AUD", "CA": "CAD", "AE": "AED", "SA": "SAR", "DE": "EUR"}
PHONE = {"IN": "+91 ", "US": "+1 ", "CA": "+1 ", "GB": "+44 ", "AU": "+61 ", "AE": "+971 ", "SA": "+966 ", "DE": "+49 "}
SIGN_INS = {"emp-mahesh", "emp-priya", "emp-oliver", "emp-ram", "demo-hr-admin", "demo-recruiter", "demo-ceo", "demo-admin"}


def _sample(row_id: object) -> bool:
    text = str(row_id)
    return "-seed-" in text or text.startswith(("gap-", "hrp-"))


def _day(value: date | datetime | None) -> date | None:
    return value.date() if isinstance(value, datetime) else value


def _people(db) -> dict[str, Employee]:
    return {e.id: e for e in db.scalars(select(Employee))}


def test_sample_activity_is_not_dated_before_joining(database):
    bad = []
    with SessionLocal() as db:
        people = _people(db)

        def check(kind: str, row_id: object, who: str | None, when: date | datetime | None) -> None:
            e = people.get(who or "")
            d = _day(when)
            if e is not None and d is not None and e.joining_date and d < e.joining_date and _sample(row_id):
                bad.append((kind, row_id, who, d, e.joining_date))

        for r in db.scalars(select(LeaveRequest)):
            check("leave", r.id, r.employee_id, r.from_date)
        for r in db.scalars(select(PerfFeedback)):
            check("feedback to", r.id, r.to_id, r.created_at)
            check("feedback from", r.id, r.from_id, r.created_at)
        for r in db.scalars(select(Kudos)):
            for who in (r.from_id, r.to_id):
                e = people.get(who)
                if e is not None and _sample(r.id) and r.month < e.joining_date.strftime("%Y-%m"):
                    bad.append(("kudos", r.id, who, r.month))
        for r in db.scalars(select(Enrollment)):
            check("course completed", r.id, r.employee_id, r.completed_on)
            check("course due", r.id, r.employee_id, r.due)
        for r in db.scalars(select(Certification)):
            check("certification", r.id, r.employee_id, r.issued_on)
        for r in db.scalars(select(CheckIn)):
            check("1:1", r.id, r.employee_id, r.meeting_date)
            check("1:1 manager", r.id, r.manager_id, r.meeting_date)
        for r in db.scalars(select(ExpenseClaim)):
            check("expense", r.id, r.employee_id, r.expense_date)
        for r in db.scalars(select(TravelRequest)):
            check("trip", r.id, r.employee_id, r.start_date)
        for r in db.scalars(select(BenefitEnrollment)):
            check("benefit", r.id, r.employee_id, r.effective_date)
    assert not bad, bad[:10]


def test_dates_on_sample_rows_are_in_order(database):
    bad = []
    with SessionLocal() as db:
        for c in db.scalars(select(Certification)):
            if c.expires_on and c.issued_on and c.expires_on < c.issued_on:
                bad.append(("certification expires before issue", c.id))
        for t in db.scalars(select(TravelRequest)):
            if t.end_date < t.start_date:
                bad.append(("trip ends before it starts", t.id))
        trips = {t.id: t for t in db.scalars(select(TravelRequest))}
        for x in db.scalars(select(ExpenseClaim).where(ExpenseClaim.trip_id.is_not(None))):
            t = trips.get(x.trip_id or "")
            if t and _sample(x.id) and not (t.start_date - timedelta(days=7) <= x.expense_date <= t.end_date + timedelta(days=7)):
                bad.append(("claim outside its trip", x.id))
    assert not bad, bad[:10]


def test_reviews_are_by_people_who_were_there(database):
    bad = []
    with SessionLocal() as db:
        people = _people(db)
        cycles = {c.id: c for c in db.scalars(select(ReviewCycle))}
        reviews = {r.id: r for r in db.scalars(select(PerfReview).where(PerfReview.id.like("rev-seed-%")))}
        for r in reviews.values():
            cycle, m = cycles[r.cycle_id], people.get(r.manager_id or "")
            if r.manager_id == r.employee_id:
                bad.append(("rates themself", r.id))
            if cycle.status == "closed" and m is not None and m.joining_date > cycle.end_date:
                bad.append(("manager joined after the cycle", r.id, m.id))
        for x in db.scalars(select(Reviewer360)):
            r = reviews.get(x.review_id)
            if r is None:
                continue
            who = people[x.reviewer_id]
            if x.reviewer_id == r.employee_id or who.joining_date > cycles[r.cycle_id].end_date:
                bad.append(("360 reviewer", x.review_id, x.reviewer_id))
    assert not bad, bad[:10]


def test_reporting_lines_and_hiring_make_sense(database):
    bad = []
    with SessionLocal() as db:
        people = _people(db)
        joined_by_name: dict[str, date] = {}
        for e in people.values():
            joined_by_name[e.full_name] = min(joined_by_name.get(e.full_name, e.joining_date), e.joining_date)
        for e in people.values():
            if e.source != "hcm_sample":
                continue
            m = people.get(e.manager_id or "")
            if m is None:
                bad.append(("no manager", e.id))
                continue
            if m.id == e.id or _seniority(m.grade) < _seniority(e.grade):
                bad.append(("manager junior", e.id, e.grade, m.id, m.grade))
            if m.country_code != e.country_code and m.id != "demo-ceo":
                bad.append(("manager in another country", e.id, m.id))
            if e.hiring_manager in joined_by_name and joined_by_name[e.hiring_manager] > e.joining_date:
                bad.append(("hiring manager joined later", e.id, e.hiring_manager))
            name = (e.hired_by or "").removesuffix(" (Talent Acquisition)")
            if name in joined_by_name and joined_by_name[name] > e.joining_date:
                bad.append(("recruiter joined later", e.id, e.hired_by))
    assert not bad, bad[:10]


def test_profile_text_fits_the_person(database):
    bad = []
    with SessionLocal() as db:
        people = _people(db)
        spouses = {d.employee_id: d for d in db.scalars(select(BenefitDependent).where(
            BenefitDependent.id.like("dep-seed-%"), BenefitDependent.relationship.in_(("Spouse", "Partner"))))}
        for e in people.values():
            if e.source == "hcm_sample" and NAME_GENDER.get(e.first_name or "") not in (None, e.gender):
                bad.append(("gender does not fit the name", e.id, e.full_name, e.gender))
            if e.emergency_name and e.emergency_name.lower() == e.full_name.lower():
                bad.append(("own emergency contact", e.id))
            if e.id in spouses and e.emergency_relationship in ("Spouse", "Partner") and e.emergency_name != spouses[e.id].name:
                bad.append(("two different spouses", e.id, e.emergency_name, spouses[e.id].name))
            for phone in (e.mobile, e.emergency_phone):
                if phone and e.country_code in PHONE and not phone.startswith(PHONE[e.country_code]):
                    bad.append(("phone of another country", e.id, phone))
            if e.currency != CURRENCY.get(e.country_code, e.currency):
                bad.append(("currency", e.id))
    assert not bad, bad[:10]


def test_country_only_items_stay_in_their_country(database):
    bad = []
    with SessionLocal() as db:
        people = _people(db)
        for e in people.values():
            if e.country_code != "IN" and e.tax_regime:
                bad.append(("tax regime outside India", e.id))
        for t in db.scalars(select(TaxDeclaration).where(TaxDeclaration.id.like("td-seed-%"))):
            e = people[t.employee_id]
            if t.country_code != e.country_code or t.currency != e.currency:
                bad.append(("declaration country", t.id))
            if t.regime and t.regime != e.tax_regime:
                bad.append(("declaration regime differs from the profile", t.id, t.regime, e.tax_regime))
        country_docs = {"Aadhaar": "IN", "PAN card": "IN", "Form 16": "IN", "P60": "GB", "Right to work": "GB",
                        "Form W-4": "US", "Form I-9": "US"}
        for d in db.scalars(select(EmployeeDocument).where(EmployeeDocument.id.like("doc-seed-%"))):
            e = people[d.employee_id]
            for word, cc in country_docs.items():
                if word in d.title and e.country_code != cc:
                    bad.append(("document of another country", d.id, e.country_code))
            if d.category == "Immigration" and e.nationality and e.nationality == {
                    "GB": "British", "AE": "Emirati", "SA": "Saudi", "DE": "German", "US": "American"}.get(e.country_code):
                bad.append(("visa for a national", d.id, e.nationality))
        plans = {p.id: p for p in db.scalars(select(BenefitPlan))}
        for b in db.scalars(select(BenefitEnrollment)):
            plan = plans.get(b.plan_id)
            if plan is not None and plan.country_code and plan.country_code != people[b.employee_id].country_code:
                bad.append(("benefit plan of another country", b.id))
        for model in (ExpenseClaim, TravelRequest):
            for r in db.scalars(select(model)):
                if _sample(r.id) and r.currency != people[r.employee_id].currency:
                    bad.append(("currency", r.id))
        for r in db.scalars(select(LeaveRequest)):
            g = (people[r.employee_id].gender or "").lower()
            if (r.leave_code == "maternity" and g != "female") or (r.leave_code == "paternity" and g != "male"):
                bad.append(("leave for the other gender", r.id))
    assert not bad, bad[:10]


def test_sample_probation_review_matches_the_calendar(database):
    with SessionLocal() as db:
        action = db.get(LifecycleAction, "lca-seed-probation")
        if action is None:
            return
        e = db.get(Employee, action.employee_id)
        months = db.get(Country, e.country_code).probation_months
        assert action.after["probation_end_date"] == probation_end(e, months).isoformat()


def test_repairs_leave_values_people_entered_alone(database):
    from app import seed_repairs

    with SessionLocal() as db:
        e = db.get(Employee, "TZ0002")  # "Grace Brown": the workbook said Male
        e.gender, e.emergency_name, e.hiring_manager = "Non-binary", e.full_name, "Someone HR typed"
        db.flush()
        stats = seed_repairs.seed(db)
        assert e.gender == "Non-binary" and e.hiring_manager == "Someone HR typed"
        assert e.emergency_name == e.full_name  # typed in, not generated: kept
        assert all(k.startswith("fix_") for k in stats)
        db.rollback()
        assert not any(seed_repairs.seed(db).values())  # nothing left to correct after the seed ran
        db.rollback()
