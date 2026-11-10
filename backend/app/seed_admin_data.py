"""Sample org detail (positions, job profiles, units), holidays, integrations, audit, payroll status and admin examples.

Insert-only and idempotent: adds rows only where none exist yet and never changes a value that is already set,
so it is safe to run again on a database that already holds real data. Dates are relative to today.

- org: one filled position per working employee (their job, the code already on their record when there is one,
  else TIMEZ-<DEP>-<CC>-<employee number>), an open position per approved requisition; blank job profile, job family
  and org unit details (unit head = most senior person in the unit, budgeted headcount = people in it today)
- holidays: a description where blank; next year's public holidays per country; optional holidays outside India
- admin: integration run history (with a few failures and retried quarantine records), a sign-in / change / approval /
  Copilot audit history, sent emails, payroll providers per country, one page-access and one data-scope example
- blanks on sample rows other seeders own: benefit plan legal entity, internal project client
"""

from __future__ import annotations

import re
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import utcnow
from app.models import (
    Account,
    AccountDataScope,
    AuditLog,
    BenefitPlan,
    Country,
    EmailOutboxItem,
    Employee,
    EmployeeAssignment,
    Holiday,
    IntegrationConnector,
    IntegrationQuarantine,
    IntegrationRun,
    JobFamily,
    JobProfile,
    LeaveRequest,
    OptionalHoliday,
    OrgChangeVersion,
    OrgUnit,
    PageAccessOverride,
    PlatformSetting,
    Position,
    Project,
    Requisition,
)

LEFT = ("Terminated", "Exited")
HOLDS_SEAT = ("Active", "On Leave")


def _blank(value: Any) -> bool:
    return value is None or value == "" or value == [] or value == {}


# ---------------------------------------------------------------- seniority
def _rank(title: str | None) -> int:
    t = (title or "").lower()
    if "chief" in t or re.search(r"\b(ceo|cto|cfo|coo)\b", t):
        return 100
    if "director" in t or "head of" in t or re.search(r"\bvp\b|vice president", t):
        return 80
    if "manager" in t:
        return 60
    if any(k in t for k in ("lead", "principal", "controller", "counsel", "partner", "architect")):
        return 45
    if "senior" in t or "administrator" in t:
        return 40
    return 20


def _grade_no(grade: str | None) -> int:
    m = re.search(r"(\d+)", grade or "")
    bonus = {"E": 30, "M": 20}.get((grade or " ")[0], 0)
    return bonus + (int(m.group(1)) if m else 0)


def _seniority(e: Any) -> tuple:
    joined = e.joining_date.toordinal() if e.joining_date else 10**7
    return (e.employment_status == "Active", _rank(e.job_title), _grade_no(e.grade), -joined, e.id)


# ---------------------------------------------------------------- positions
def _dep_code(e: Any) -> str:
    if e.cost_centre and (m := re.fullmatch(r"CC-[A-Z]{2}-([A-Z]{2,4})", e.cost_centre)):
        return m.group(1)
    return (re.sub(r"[^A-Z]", "", (e.department or "GEN").upper())[:3] or "GEN")


def _seq(e: Any) -> int:
    m = re.search(r"(\d+)$", e.employee_code or e.id or "")
    return int(m.group(1)) if m else 0


def _profile_for_req(title: str, department: str, profiles: dict[str, JobProfile], families: dict[str, str]) -> JobProfile | None:
    if title in profiles:
        return profiles[title]
    family_id = families.get(department) or families.get({"People": "Human Resources"}.get(department, department))
    if family_id is None:
        return None
    last = title.split()[-1].lower()
    same = sorted((p for p in profiles.values() if p.family_id == family_id and p.title.split()[-1].lower() == last),
                  key=lambda p: (("senior" in p.title.lower()) != ("senior" in title.lower()), p.title))
    return same[0] if same else None


def _positions(db: Session, today: date) -> tuple[int, int]:
    codes = set(db.scalars(select(Position.code)))
    ids = set(db.scalars(select(Position.id)))
    profiles = {p.title: p for p in db.scalars(select(JobProfile).where(JobProfile.active.is_(True)).order_by(JobProfile.code))}
    families = {f.name: f.id for f in db.scalars(select(JobFamily))}
    units = {(u.type, u.name): u.id for u in db.scalars(select(OrgUnit).where(OrgUnit.active.is_(True)))}
    people = list(db.scalars(select(Employee).order_by(Employee.id)))
    known_ids = {e.id for e in people}
    added: list[Position] = []
    links = 0
    for e in people:
        if e.employment_status not in HOLDS_SEAT or e.job_title not in profiles:
            continue
        code = e.position_id or f"TIMEZ-{_dep_code(e)}-{e.country_code}-{_seq(e):05d}"
        if code not in codes and code not in ids:
            row = Position(
                id=code, code=code, profile_id=profiles[e.job_title].id, department_id=units.get(("department", e.department)),
                location_id=units.get(("location", e.location)), country_code=e.country_code, grade=e.grade,
                manager_id=e.manager_id if e.manager_id in known_ids else None, headcount=1, filled=1, status="filled",
                active=True, effective_from=e.joining_date if e.joining_date and e.joining_date <= today else today,
            )
            db.add(row)
            added.append(row)
            codes.add(code)
            ids.add(code)
        if e.position_id is None:
            e.position_id = code
            links += 1
    # The open assignment row carries the same position.
    by_emp = {e.id: e.position_id for e in people if e.position_id}
    for a in db.scalars(select(EmployeeAssignment).where(EmployeeAssignment.effective_to.is_(None),
                                                        EmployeeAssignment.position_id.is_(None))):
        if by_emp.get(a.employee_id):
            a.position_id = by_emp[a.employee_id]
            links += 1
    # Open seats for approved requisitions still being hired for.
    for req in db.scalars(select(Requisition).where(Requisition.status == "approved").order_by(Requisition.id)):
        profile = _profile_for_req(req.title, req.department, profiles, families)
        if profile is None:
            continue
        digits = int(re.sub(r"\D", "", req.id) or 0) % 1000
        dep = re.sub(r"[^A-Z]", "", req.department.upper())[:3] or "GEN"
        code = f"TIMEZ-{dep}-{req.country_code}-{9000 + digits:05d}"
        if code in codes or code in ids:
            continue
        row = Position(id=code, code=code, profile_id=profile.id, department_id=units.get(("department", req.department)),
                       location_id=units.get(("location", req.location)), country_code=req.country_code, grade=profile.grade,
                       manager_id=req.hiring_manager_id if req.hiring_manager_id in known_ids else None,
                       headcount=max(1, req.openings or 1), filled=0, status="open", active=True,
                       effective_from=min(req.decided_on or req.raised_on or today, today))
        db.add(row)
        added.append(row)
        codes.add(code)
        ids.add(code)
    db.flush()
    from app.services.org_history import snapshot

    for row in added:  # a baseline history version, as org_history.backfill_baselines would add on the next run
        db.add(OrgChangeVersion(entity="position", entity_id=row.id, effective_from=row.effective_from, effective_to=None,
                                change="baseline", changed_fields=[], snapshot=snapshot("position", row)))
    return len(added), links


# ---------------------------------------------------------------- job families and profiles
FAMILY_TEXT: dict[str, str] = {
    "Customer Success": "Keeps customers successful after the sale: onboarding, adoption, renewals and support escalations.",
    "Engineering": "Designs, builds, tests and runs the TimeZ product and the platforms it runs on.",
    "Executive": "Sets the company's direction, strategy and priorities and is accountable to the board.",
    "Finance": "Accounting, planning, payroll accounting, tax and controls across every legal entity.",
    "Human Resources": "The employee life cycle: hiring, onboarding, policies, employee relations, rewards and exits.",
    "IT": "Corporate systems, devices, identity, networks and the help desk that keeps everyone working.",
    "Learning & Development": "Builds skills across the company: learning programmes, onboarding curricula and leadership development.",
    "Legal & Compliance": "Contracts, regulatory compliance, data protection and company policies in every country.",
    "Marketing": "Brand, demand generation, product marketing, content and digital campaigns.",
    "Operations": "Runs the day-to-day business processes, vendors, facilities and service delivery.",
    "Sales": "Wins new customers and grows existing accounts across regions.",
}

FAMILY_SKILLS: dict[str, tuple[list[str], list[str], str, list[str]]] = {
    # family: (required, preferred, education, responsibilities)
    "Customer Success": (["Customer onboarding", "Account management", "Stakeholder communication", "CRM (Salesforce or HubSpot)"],
                         ["Churn analysis", "SaaS metrics", "Product demos"],
                         "Bachelor's degree in Business, Communications or a related field",
                         ["Onboard new customers and drive product adoption", "Run regular account reviews and health checks",
                          "Handle escalations with Support and Engineering", "Identify renewal and expansion opportunities"]),
    "Engineering": (["Python or TypeScript", "REST APIs", "SQL", "Git and code review"],
                    ["React", "Cloud (AWS or Azure)", "CI/CD", "Automated testing"],
                    "Bachelor's degree in Computer Science, Engineering or a related field",
                    ["Design, build and test product features", "Review code and keep quality high",
                     "Fix production issues and improve reliability", "Work with Product on scope and estimates"]),
    "Executive": (["Strategy", "P&L ownership", "Leadership", "Board communication"],
                  ["M&A", "International expansion", "Fundraising"],
                  "Master's degree (MBA or equivalent)",
                  ["Set company strategy and annual priorities", "Lead the leadership team",
                   "Report to the board and investors", "Own company culture and values"]),
    "Finance": (["Financial accounting", "Excel modelling", "Month-end close", "IFRS / local GAAP"],
                ["ERP (SAP or NetSuite)", "FP&A", "Payroll accounting"],
                "Bachelor's degree in Accounting or Finance; CA, CPA or ACCA preferred",
                ["Prepare monthly and annual accounts", "Reconcile accounts and payroll journals",
                 "Support budgeting and forecasting", "Keep controls and audit evidence up to date"]),
    "Human Resources": (["Employee relations", "HR policies", "Labour law basics", "HRIS"],
                        ["Talent acquisition", "Compensation & benefits", "HR analytics"],
                        "Bachelor's or Master's degree in Human Resource Management or a related field",
                        ["Advise managers and employees on HR matters", "Run HR processes from joining to exit",
                         "Keep policies and records compliant", "Support performance and engagement cycles"]),
    "IT": (["Windows and macOS support", "Identity & access (Azure AD / Okta)", "Networking basics", "ITIL service desk"],
           ["Cloud administration", "Scripting (PowerShell or Bash)", "Endpoint management"],
           "Bachelor's degree in Information Technology or a related field",
           ["Resolve IT tickets within SLA", "Manage devices, accounts and access", "Keep systems patched and secure",
            "Document fixes in the knowledge base"]),
    "Learning & Development": (["Instructional design", "Facilitation", "Training needs analysis", "LMS administration"],
                               ["Coaching", "E-learning authoring", "Leadership programmes"],
                               "Bachelor's degree in Education, Psychology or HR; instructional design certification a plus",
                               ["Find skill gaps with managers", "Design and deliver learning programmes",
                                "Run the learning platform and course catalogue", "Measure the impact of training"]),
    "Legal & Compliance": (["Contract drafting and review", "Regulatory compliance", "Data protection (GDPR / DPDP)", "Risk assessment"],
                           ["Employment law", "Policy writing", "Investigations"],
                           "Law degree (LLB / JD); admitted to practise in the country",
                           ["Review and negotiate contracts", "Track regulatory changes and advise the business",
                            "Run compliance checks and training", "Handle data protection requests"]),
    "Marketing": (["Campaign management", "Content writing", "Marketing analytics", "SEO / SEM"],
                  ["Marketing automation", "Brand design", "Events"],
                  "Bachelor's degree in Marketing, Communications or Business",
                  ["Plan and run campaigns", "Create content for web, email and social",
                   "Report on pipeline and campaign results", "Work with Sales on messaging and leads"]),
    "Operations": (["Process improvement", "Vendor management", "Reporting", "Project coordination"],
                   ["Lean / Six Sigma", "Facilities management", "Procurement"],
                   "Bachelor's degree in Business, Operations or Supply Chain",
                   ["Run day-to-day operational processes", "Manage vendors and service levels",
                    "Track KPIs and fix bottlenecks", "Coordinate cross-team projects"]),
    "Sales": (["B2B sales", "Pipeline management", "Negotiation", "CRM (Salesforce)"],
              ["SaaS sales", "Solution selling", "Forecasting"],
              "Bachelor's degree in Business or a related field",
              ["Prospect and qualify new opportunities", "Run demos and proposals",
               "Negotiate and close deals", "Keep the CRM and forecast accurate"]),
}
GENERIC = (["Communication", "Planning and organisation", "Problem solving", "Microsoft 365"],
           ["Project management", "Data analysis", "Stakeholder management"],
           "Bachelor's degree in a related field",
           ["Deliver the role's objectives each quarter", "Work with colleagues across teams",
            "Keep records and reports up to date", "Suggest and drive improvements"])
TITLE_SKILLS: dict[str, list[str]] = {
    "QA Engineer": ["Test planning", "Automated testing (Playwright or Selenium)", "API testing", "Bug tracking (Jira)"],
    "Tech Lead": ["System design", "Python or TypeScript", "Code review", "Technical mentoring"],
    "Systems Administrator": ["Linux and Windows Server", "Backup and recovery", "Monitoring", "Scripting"],
    "Platform Administrator": ["SaaS administration", "Identity & access", "Audit logs", "Scripting"],
    "Talent Acquisition Specialist": ["Sourcing", "Interviewing", "ATS", "Offer negotiation"],
    "Talent Acquisition Lead": ["Recruitment strategy", "Sourcing", "Hiring manager partnership", "ATS reporting"],
    "Legal Counsel": ["Contract drafting and review", "Commercial law", "Employment law", "Negotiation"],
    "Digital Marketing Specialist": ["Paid social and search", "Marketing analytics", "SEO", "Email marketing"],
}
LEVELS = {  # rank -> (job level, min years, max years, extra responsibilities, extra required skills)
    100: ("Executive", 15, 25, ["Own the company's results and long-term plan"], []),
    80: ("Director", 12, 18, ["Set the function's strategy and budget", "Lead and develop managers"], ["People leadership", "Budgeting"]),
    60: ("Manager", 7, 12, ["Lead, coach and review the team", "Own the team's plan, budget and hiring"], ["People management"]),
    45: ("Lead", 5, 9, ["Guide and mentor colleagues", "Own the quality of the team's work"], []),
    40: ("Senior", 4, 8, ["Mentor junior colleagues"], []),
    20: ("Professional", 2, 5, [], []),
}


def _profile_text(title: str, family: str | None, rank: int) -> dict[str, Any]:
    req, pref, edu, resp = FAMILY_SKILLS.get(family or "", GENERIC)
    level, lo, hi, more_resp, more_req = LEVELS[rank]
    if title.lower().endswith("executive") and rank == 20:
        lo, hi = 1, 3
    required = list(dict.fromkeys(TITLE_SKILLS.get(title, req) + more_req))
    area = FAMILY_TEXT.get(family or "", "Supports the business in its area.")
    lead = {100: "leads the company", 80: "leads the function", 60: "leads a team",
            45: "leads the work of a small group", 40: "works independently on complex work", 20: "delivers the core work"}[rank]
    return {
        "description": f"The {title} {lead} in {family or 'the business'} at TimeZ. {area}",
        "required_skills": required,
        "preferred_skills": list(pref),
        "job_level": level,
        "experience_min_years": lo,
        "experience_max_years": hi,
        "education": edu,
        "responsibilities": list(resp) + more_resp,
    }


def _job_profiles(db: Session) -> int:
    families = {f.id: f.name for f in db.scalars(select(JobFamily))}
    filled = 0
    for p in db.scalars(select(JobProfile).order_by(JobProfile.id)):
        text = _profile_text(p.title, families.get(p.family_id or ""), _rank(p.title))
        if p.experience_min_years is not None and p.experience_max_years is None:
            text["experience_max_years"] = max(text["experience_max_years"], p.experience_min_years)
        if p.experience_max_years is not None and p.experience_min_years is None:
            text["experience_min_years"] = min(text["experience_min_years"], p.experience_max_years)
        changed = False
        for k, v in text.items():
            if _blank(getattr(p, k)):
                setattr(p, k, v)
                changed = True
        filled += changed
    for f in db.scalars(select(JobFamily)):
        if _blank(f.description):
            f.description = FAMILY_TEXT.get(f.name, f"The {f.name} job family at TimeZ.")
            filled += 1
    return filled


# ---------------------------------------------------------------- org units
def _units(db: Session) -> int:
    people = [e for e in db.scalars(select(Employee)) if e.employment_status not in LEFT]
    groups: dict[tuple[str, str], list[Employee]] = defaultdict(list)
    for e in people:
        for key in (("legal_entity", e.legal_entity), ("business_unit", e.business_unit), ("division", e.division),
                    ("department", e.department), ("cost_centre", e.cost_centre), ("location", e.location),
                    ("country", e.country_code)):
            if key[1]:
                groups[key].append(e)
    filled = 0
    for u in db.scalars(select(OrgUnit).order_by(OrgUnit.id)):
        if u.type == "company":
            members = people
        elif u.type == "country":
            members = groups.get(("country", u.country_code or u.code.removeprefix("CTRY-")), [])
        else:
            members = groups.get((u.type, u.name), [])
        changed = False
        if u.manager_id is None and members:
            u.manager_id = max(members, key=_seniority).id
            changed = True
        if u.headcount is None and members:
            u.headcount = len(members)
            changed = True
        if u.country_code is None:
            countries = {e.country_code for e in members}
            cc = None
            if u.type == "cost_centre" and (m := re.fullmatch(r"CC-([A-Z]{2})-.+", u.name)):
                cc = m.group(1)
            elif len(countries) == 1:
                cc = next(iter(countries))
            if cc:
                u.country_code = cc
                changed = True
        filled += changed
    return filled


def _refresh_baselines(db: Session) -> None:
    """Open baseline history versions show the details filled above (only keys still blank in the snapshot)."""
    from app.services.org_history import snapshot

    rows = {("org_unit", u.id): u for u in db.scalars(select(OrgUnit))}
    rows.update({("job_profile", p.id): p for p in db.scalars(select(JobProfile))})
    for v in db.scalars(select(OrgChangeVersion).where(OrgChangeVersion.entity.in_(("org_unit", "job_profile")),
                                                       OrgChangeVersion.change == "baseline",
                                                       OrgChangeVersion.effective_to.is_(None))):
        row = rows.get((v.entity, v.entity_id))
        if row is None:
            continue
        current = snapshot(v.entity, row)
        snap = dict(v.snapshot or {})
        fill = {k: val for k, val in current.items() if k in snap and _blank(snap[k]) and not _blank(val)}
        if fill:
            v.snapshot = {**snap, **fill}


# ---------------------------------------------------------------- holidays
NEXT_YEAR_HOLIDAYS: dict[str, list[tuple[str, str]]] = {
    "IN": [("01-01", "New Year's Day"), ("01-14", "Makar Sankranti / Pongal"), ("01-26", "Republic Day"),
           ("03-06", "Maha Shivaratri"), ("03-10", "Eid-ul-Fitr"), ("03-22", "Holi"), ("03-26", "Good Friday"),
           ("04-07", "Ugadi / Gudi Padwa"), ("04-14", "Dr. Ambedkar Jayanti"), ("04-15", "Ram Navami"), ("05-17", "Eid-ul-Adha (Bakrid)"),
           ("05-20", "Buddha Purnima"), ("06-15", "Muharram"), ("08-16", "Independence Day (observed)"), ("08-25", "Janmashtami"),
           ("09-04", "Ganesh Chaturthi"), ("10-01", "Gandhi Jayanti (observed)"), ("10-08", "Dussehra (Vijayadashami)"),
           ("10-29", "Diwali"), ("11-01", "Govardhan Puja"), ("11-15", "Guru Nanak Jayanti (observed)"), ("12-24", "Christmas (observed)")],
    "US": [("01-01", "New Year's Day"), ("01-18", "Martin Luther King Jr. Day"), ("02-15", "Presidents' Day"),
           ("05-31", "Memorial Day"), ("06-18", "Juneteenth (observed)"), ("07-05", "Independence Day (observed)"),
           ("09-06", "Labor Day"), ("11-25", "Thanksgiving"), ("11-26", "Day after Thanksgiving"), ("12-24", "Christmas Day (observed)")],
    "GB": [("01-01", "New Year's Day"), ("03-26", "Good Friday"), ("03-29", "Easter Monday"), ("05-03", "Early May bank holiday"),
           ("05-31", "Spring bank holiday"), ("08-30", "Summer bank holiday"), ("12-27", "Christmas Day (substitute)"),
           ("12-28", "Boxing Day (substitute)")],
    "AU": [("01-01", "New Year's Day"), ("01-26", "Australia Day"), ("03-26", "Good Friday"), ("03-29", "Easter Monday"),
           ("06-14", "King's Birthday"), ("10-04", "Labour Day"), ("12-27", "Christmas Day (substitute)"),
           ("12-28", "Boxing Day (substitute)")],
    "CA": [("01-01", "New Year's Day"), ("02-15", "Family Day"), ("03-26", "Good Friday"), ("05-24", "Victoria Day"),
           ("07-01", "Canada Day"), ("08-02", "Civic Holiday"), ("09-06", "Labour Day"), ("10-11", "Thanksgiving"),
           ("12-27", "Christmas Day (substitute)"), ("12-28", "Boxing Day (substitute)")],
    "AE": [("01-01", "New Year's Day"), ("03-09", "Eid al-Fitr"), ("03-10", "Eid al-Fitr holiday"), ("05-15", "Arafat Day"),
           ("05-16", "Eid al-Adha"), ("05-17", "Eid al-Adha holiday"), ("06-06", "Islamic New Year"), ("08-15", "Prophet's Birthday"),
           ("12-02", "National Day"), ("12-03", "National Day holiday")],
    "SA": [("02-22", "Founding Day"), ("03-09", "Eid al-Fitr"), ("03-10", "Eid al-Fitr holiday"), ("03-11", "Eid al-Fitr holiday"),
           ("05-15", "Arafat Day"), ("05-16", "Eid al-Adha"), ("05-17", "Eid al-Adha holiday"), ("09-23", "National Day")],
    "DE": [("01-01", "Neujahr"), ("03-26", "Karfreitag"), ("03-29", "Ostermontag"), ("05-01", "Tag der Arbeit"),
           ("05-06", "Christi Himmelfahrt"), ("05-17", "Pfingstmontag"), ("10-03", "Tag der Deutschen Einheit"),
           ("12-25", "1. Weihnachtstag"), ("12-26", "2. Weihnachtstag")],
}
NEXT_YEAR = 2027  # the dates above are for this year

HOLIDAY_MEANING: dict[str, str] = {
    "new year": "Start of the new calendar year.",
    "republic day": "Marks the day India's constitution came into force in 1950.",
    "independence day": "National independence day.",
    "gandhi jayanti": "Birthday of Mahatma Gandhi.",
    "diwali": "The festival of lights.",
    "holi": "The spring festival of colours.",
    "eid": "Islamic festival.",
    "christmas": "Christmas celebration.",
    "boxing day": "The day after Christmas.",
    "good friday": "Christian holiday before Easter.",
    "easter": "Easter holiday.",
    "thanksgiving": "National day of thanks.",
    "labour day": "Celebrates workers.",
    "labor day": "Celebrates workers.",
    "may day": "International Workers' Day.",
    "tag der arbeit": "International Workers' Day.",
    "national day": "National day celebrations.",
    "founding day": "Marks the founding of the first Saudi state in 1727.",
    "bank holiday": "UK bank holiday.",
    "canada day": "Anniversary of Confederation in 1867.",
    "australia day": "National day of Australia.",
    "martin luther king": "Honours the civil rights leader Dr. Martin Luther King Jr.",
    "juneteenth": "Commemorates the end of slavery in the United States.",
    "memorial day": "Honours those who died serving in the US armed forces.",
    "arafat": "The day before Eid al-Adha, the peak of the Hajj.",
    "founders": "TimeZ Founders' Day: company holiday.",
}


def _holiday_description(name: str, country: str) -> str:
    low = name.lower()
    meaning = next((text for key, text in HOLIDAY_MEANING.items() if key in low), f"{name}.")
    return f"{meaning} Public holiday in {country}: offices are closed and it is a paid day off."


def _holidays(db: Session) -> tuple[int, int]:
    countries = {c.code: c.name for c in db.scalars(select(Country))}
    existing = {(h.country_code, h.date) for h in db.scalars(select(Holiday))}
    ids = set(db.scalars(select(Holiday.id)))
    added = 0
    for cc, rows in NEXT_YEAR_HOLIDAYS.items():
        if cc not in countries:
            continue
        for md, name in rows:
            day = date.fromisoformat(f"{NEXT_YEAR}-{md}")
            hid = f"h-{cc.lower()}-{day.isoformat()}"
            if (cc, day) in existing or hid in ids:
                continue
            db.add(Holiday(id=hid, country_code=cc, date=day, name=name, calendar=None, active=True,
                           description=_holiday_description(name, countries[cc])))
            existing.add((cc, day))
            ids.add(hid)
            added += 1
    filled = 0
    for h in db.scalars(select(Holiday).where(Holiday.description.is_(None))):
        h.description = _holiday_description(h.name, countries.get(h.country_code, h.country_code))
        filled += 1
    return filled, added


OPTIONAL_HOLIDAYS: list[tuple[str, str, str, str, str]] = [
    # id, country, date, name, description
    ("oh-gb-xmas-eve", "GB", "2026-12-24", "Christmas Eve", "The day before Christmas Day."),
    ("oh-gb-nye", "GB", "2026-12-31", "New Year's Eve", "The last day of the year."),
    ("oh-gb-st-patrick", "GB", "2027-03-17", "St Patrick's Day", "Patron saint of Ireland; a bank holiday in Northern Ireland."),
    ("oh-gb-st-andrew", "GB", "2027-11-30", "St Andrew's Day", "Patron saint of Scotland."),
    ("oh-us-veterans", "US", "2027-11-11", "Veterans Day", "Honours military veterans."),
    ("oh-us-columbus", "US", "2027-10-11", "Indigenous Peoples' Day", "Observed in many states."),
    ("oh-au-xmas-eve", "AU", "2026-12-24", "Christmas Eve", "The day before Christmas Day."),
    ("oh-au-anzac", "AU", "2027-04-26", "Anzac Day (observed)", "Remembers Australians and New Zealanders who served."),
    ("oh-au-melb-cup", "AU", "2027-11-02", "Melbourne Cup Day", "A public holiday in Melbourne; optional elsewhere."),
    ("oh-ca-xmas-eve", "CA", "2026-12-24", "Christmas Eve", "The day before Christmas Day."),
    ("oh-ca-st-jean", "CA", "2027-06-24", "Saint-Jean-Baptiste Day", "National holiday of Quebec."),
    ("oh-ca-remembrance", "CA", "2027-11-11", "Remembrance Day", "Honours those who served in the armed forces."),
    ("oh-ae-xmas", "AE", "2026-12-25", "Christmas Day", "Christmas celebration."),
    ("oh-ae-diwali", "AE", "2027-10-29", "Diwali", "The festival of lights."),
    ("oh-sa-xmas-eve", "SA", "2026-12-24", "Christmas Eve", "The day before Christmas Day."),
    ("oh-sa-easter", "SA", "2027-03-28", "Easter Sunday", "Easter (a working day in Saudi Arabia)."),
    ("oh-de-buss-bettag", "DE", "2026-11-18", "Buß- und Bettag", "Day of Repentance and Prayer; a public holiday in Saxony."),
    ("oh-de-heiligabend", "DE", "2026-12-24", "Heiligabend", "Christmas Eve."),
    ("oh-de-drei-koenige", "DE", "2027-01-06", "Heilige Drei Könige", "Epiphany; a public holiday in Bavaria and Baden-Württemberg."),
    ("oh-de-fronleichnam", "DE", "2027-05-27", "Fronleichnam", "Corpus Christi; a public holiday in several states."),
]


def _optional_holidays(db: Session, today: date) -> int:
    countries = set(db.scalars(select(Country.code)))
    have = {(o.country_code, o.date) for o in db.scalars(select(OptionalHoliday))}
    ids = set(db.scalars(select(OptionalHoliday.id)))
    added = 0
    for hid, cc, day_s, name, desc in OPTIONAL_HOLIDAYS:
        day = date.fromisoformat(day_s)
        if cc not in countries or hid in ids or (cc, day) in have or day < today:
            continue
        db.add(OptionalHoliday(id=hid, country_code=cc, date=day, name=name, active=True, description=desc,
                               select_by=max(today, day - timedelta(days=7))))
        have.add((cc, day))
        added += 1
    return added


# ---------------------------------------------------------------- integrations
STEP = {"15m": timedelta(minutes=15), "hourly": timedelta(hours=1), "daily": timedelta(days=1), "manual": timedelta(days=2)}
LAST_SYNC_AGO = {"15m": timedelta(minutes=2), "hourly": timedelta(minutes=20), "daily": timedelta(hours=3),
                 "manual": timedelta(days=1)}
RUNS_PER_CONNECTOR = 8


def _first_run_fails(connector_id: str, run_no: int) -> bool:
    """Whether integrations.run_sync's run number run_no for this connector quarantines at least one record."""
    from app.services.integrations import BATCH_SIZE, _hash

    size = BATCH_SIZE.get(connector_id, 12)
    return any(_hash(connector_id, run_no, i) % 100 < 10 or (run_no == 1 and i == 3) for i in range(size))


def _integrations(db: Session, now: datetime) -> tuple[int, int]:
    from app.services.integrations import BATCH_SIZE, CONNECTOR_FIELDS, _bad_value, validate_value

    with_runs = set(db.scalars(select(IntegrationRun.connector_id).distinct()))
    q_ids = set(db.scalars(select(IntegrationQuarantine.id)))
    runs_added = quarantine_added = 0
    names = ["Priya Nair", "Arjun Sharma", "Meera Iyer", "Kabir Mehta", "Sara Khan", "Rohan Das"]
    for c in db.scalars(select(IntegrationConnector).order_by(IntegrationConnector.id)):
        if c.id in with_runs or c.status in ("Not configured", "Disconnected") or c.last_sync_at is not None or c.run_count:
            continue
        n = RUNS_PER_CONNECTOR
        while not _first_run_fails(c.id, n + 1) and n < RUNS_PER_CONNECTOR + 20:
            n += 1  # the next real sync (run n + 1) shows at least one quarantined record, like a first run does
        size = BATCH_SIZE.get(c.id, 12)
        step = STEP.get(c.schedule, timedelta(hours=1))
        last = now - LAST_SYNC_AGO.get(c.schedule, timedelta(minutes=20))
        degraded = c.status == "Degraded"
        runs: list[IntegrationRun] = []
        for k in range(n):  # oldest first, so ids grow with time
            at = last - step * (n - 1 - k)
            failed = 0
            if k in (2, 5) or (degraded and k == n - 1):
                failed = 1 + (k % 2) + (1 if degraded else 0)
            run = IntegrationRun(connector_id=c.id, started_at=at, trigger="manual" if k == 3 else "schedule",
                                 processed=size, succeeded=size - failed, failed=failed, run_by="demo-admin" if k == 3 else None)
            db.add(run)
            runs.append(run)
        db.flush()
        fields = CONNECTOR_FIELDS.get(c.id, ["costCentre"])
        for run in runs:
            for i in range(run.failed):
                qid = f"q-seed-{c.id}-{run.id}-{i}"
                if qid in q_ids:
                    continue
                field = fields[(run.id + i) % len(fields)]
                value = _bad_value(field, run.id * 7 + i)
                is_last = run is runs[-1]
                if is_last and degraded:
                    status, attempts, by, at_, note = "open", 1 + i, None, None, None
                elif i == 0:
                    status, attempts, by, at_, note = ("resolved", 2, "demo-admin", run.started_at + timedelta(hours=2),
                                                       "Corrected in the source system and retried")
                else:
                    status, attempts, by, at_, note = ("dismissed", 1, "demo-admin", run.started_at + timedelta(hours=3),
                                                       "Duplicate record")
                db.add(IntegrationQuarantine(
                    id=qid, connector_id=c.id, run_id=run.id, record=f"EMP-{1000 + (run.id * 37 + i * 13) % 900} · {names[(run.id + i) % len(names)]}",
                    field=field, value=value, reason=validate_value(field, value) or "Rejected by provider", attempts=attempts,
                    status=status, resolved_by=by, resolved_at=at_, resolution_note=note))
                q_ids.add(qid)
                quarantine_added += 1
        c.last_sync_at = runs[-1].started_at
        c.run_count = n
        c.success_count = sum(r.succeeded for r in runs)
        c.records_processed = c.success_count
        c.failed_count = sum(r.failed for r in runs)
        runs_added += n
    return runs_added, quarantine_added


# ---------------------------------------------------------------- audit history
UA = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
]
COPILOT_QUESTIONS = [
    ("emp-mahesh", "How many PTO days do I have left this year?", ["/leave"], [], "Your leave balances"),
    ("emp-priya", "What is the work from home policy?", [], ["policy:wfh"], None),
    ("emp-ram", "Who in my team is on leave next week?", ["/team"], [], "Your team"),
    ("demo-hr-admin", "Which documents are pending verification?", ["/documents"], [], None),
    ("emp-oliver", "When is the next bank holiday in the UK?", ["/holidays"], [], None),
    ("demo-recruiter", "Summarise the open requisitions and their stage", ["/recruiting"], [], None),
    ("demo-ceo", "What is our headcount by country?", ["/analytics"], [], None),
    ("demo-admin", "Which integrations failed in the last week?", ["/integrations"], [], None),
    ("emp-mahesh", "How do I claim internet reimbursement?", [], ["policy:expenses"], None),
    ("emp-priya", "Show my salary of my manager", [], [], None),  # refused: someone else's pay
]


def _audit(db: Session, now: datetime) -> int:
    """A few weeks of history, only when the audit log has nothing older than a day (a fresh database)."""
    if db.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.at < now - timedelta(days=1))):
        return 0
    accounts = {a.id: a for a in db.scalars(select(Account))}
    if not accounts:
        return 0
    rows: list[AuditLog] = []
    today = now.date()

    def at(days_ago: int, hour: int, minute: int = 0) -> datetime:
        return datetime.combine(today - timedelta(days=days_ago), time(hour, minute), tzinfo=now.tzinfo)

    def ip(n: int) -> str:
        return f"203.0.113.{10 + n % 200}"

    def add(when: datetime, actor: str | None, action: str, entity: str, entity_id: str | None, *, subject: str | None = None,
            before: dict | None = None, after: dict | None = None, result: str | None = None, n: int = 0, ua: bool = False) -> None:
        if when >= now - timedelta(days=1) or (actor is not None and actor not in accounts):
            return
        rows.append(AuditLog(actor_id=actor, action=action, entity=entity, entity_id=entity_id, subject_id=subject,
                             changes={"before": before, "after": after}, at=when, ip=ip(n),
                             result=result, user_agent=UA[n % len(UA)] if (ua or result) else None))

    ordered = sorted(accounts)
    for d in range(2, 22):
        if (today - timedelta(days=d)).weekday() >= 5:
            continue
        for k, acc_id in enumerate(ordered):
            if (d + k) % 3 == 0:
                continue  # not everyone signs in every day
            add(at(d, 3 + (k % 6), (d * 7 + k * 11) % 60), acc_id, "login", "account", acc_id, result="success",
                after={"method": "password"}, n=k)
            if (d + k) % 4 == 0:
                add(at(d, 12 + (k % 5), (d * 3 + k) % 60), acc_id, "logout", "account", acc_id, result="success", n=k)
    # failed sign-ins and security alerts
    add(at(3, 6, 12), "emp-mahesh", "login_failed", "account", "emp-mahesh", result="failure", n=1)
    add(at(3, 6, 13), "emp-mahesh", "login_failed", "account", "emp-mahesh", result="failure", n=1)
    add(at(4, 22, 41), None, "login_failed_unknown", "account", None, result="failure", after={"email": "a***@timez.com"}, n=77)
    add(at(6, 7, 5), "demo-admin", "mfa_failed", "account", "demo-admin", result="failure", n=7)
    add(at(9, 23, 50), "demo-recruiter", "login_failed", "account", "demo-recruiter", result="failure", n=91)
    add(at(9, 23, 52), "demo-recruiter", "account_locked", "account", "demo-recruiter", result="failure", n=91)
    add(at(9, 23, 55), "demo-recruiter", "login_blocked_locked", "account", "demo-recruiter", result="failure", n=91)
    add(at(12, 8, 30), "emp-oliver", "password_changed", "account", "emp-oliver", result="success",
        after={"other_sessions_ended": 1}, n=4)
    # profile changes (field names only, as the profile router writes them)
    for days, who, fields in ((5, "emp-priya", ["mobile"]), (8, "emp-mahesh", ["address", "emergency_contact"]),
                              (15, "emp-oliver", ["personal_email"])):
        add(at(days, 9, 10), who, "requested verification code", "employee", who, subject=who, after={"fields": fields}, n=2)
        add(at(days, 9, 12), who, "verified profile code", "employee", who, subject=who, after={"fields": fields}, n=2)
    # leave decisions by the manager
    leaves = {r.id: r for r in db.scalars(select(LeaveRequest).where(LeaveRequest.status == "approved"))}
    for k, (lid, days) in enumerate((("lv-oct-wfh", 20), ("lv-oliver-sep", 19), ("lv-priya-aug", 18), ("lv-jun", 17))):
        r = leaves.get(lid)
        if r is None:
            continue
        snap = {"status": "approved", "leave_code": r.leave_code, "from": r.from_date.isoformat(), "to": r.to_date.isoformat(),
                "days": r.days}
        add(at(days, 5, 20 + k), "emp-ram", "leave_approved", "leave_request", lid, subject=r.employee_id,
            before={**snap, "status": "pending"}, after=snap, n=3)
    # admin changes (result NULL: shown under "admin actions")
    add(at(14, 10, 0), "demo-admin", "updated payroll providers", "platform_setting", "payroll_providers",
        before={"providers": {}}, after={"providers": PAYROLL_PROVIDERS}, n=7, ua=True)
    add(at(10, 11, 30), "demo-admin", "page_access_changed", "account", "emp-ram", subject="emp-ram",
        before={"grant": [], "revoke": []}, after={"grant": ["reportbuilder"], "revoke": []}, n=7, ua=True)
    add(at(10, 11, 34), "demo-admin", "data_scope_changed", "account", "demo-recruiter",
        subject=accounts["demo-recruiter"].employee_id if "demo-recruiter" in accounts else None,
        before={"scope": "line", "countries": []}, after={"scope": "department", "countries": []}, n=7, ua=True)
    add(at(7, 9, 0), "demo-admin", "integration_sync_run", "integration", "payroll",
        after={"processed": 24, "passed": 23, "quarantined": 1, "trigger": "manual"}, n=7, ua=True)
    add(at(2, 16, 45), "demo-admin", "quarantine_retried", "integration_quarantine", None,
        after={"connector_id": "sso", "ok": False, "attempts": 2}, n=7, ua=True)
    # Copilot questions, in the format services/ai_copilot.py writes
    for k, (who, question, data, policies, _label) in enumerate(COPILOT_QUESTIONS):
        acc = accounts.get(who)
        if acc is None:
            continue
        denied = "salary" in question.lower()
        add(at(2 + k * 2 % 19, 4 + k % 9, (k * 13) % 60), who, "asked", "Copilot question", None, subject=acc.employee_id,
            after={"question": question, "capability": "copilot", "agent": None, "data_accessed": [] if denied else data,
                   "policies_used": [] if denied else policies, "sources": [] if denied else data + policies,
                   "model": None, "used_ai": False, "denied": denied,
                   "outcome": "refused" if denied else "built-in answer", "answer_chars": 120 + k * 37,
                   "action_taken": None}, n=k)
    db.add_all(rows)
    return len(rows)


# ---------------------------------------------------------------- email history
EMAILS = [
    # days ago, recipient, subject, link
    (20, "emp-mahesh", "Leave approved: Home repair appointment (22 Oct)", "/leave/requests/lv-oct-wfh"),
    (19, "emp-oliver", "Leave approved: Dentist appointment", "/leave/requests/lv-oliver-sep"),
    (16, "emp-ram", "Approve leave: Priya Nair", "/approvals"),
    (14, "demo-admin", "SSO / Identity: sync failures", "/integrations?connector=sso"),
    (13, "demo-hr-admin", "Benefits carrier: sync failures", "/integrations?connector=benefits"),
    (11, "emp-priya", "New announcement: Office closed for Diwali", "/announcements"),
    (10, "demo-recruiter", "Interview scheduled for JOB-221", "/recruiting"),
    (9, "demo-ceo", "Monthly headcount report is ready", "/analytics"),
    (7, "emp-mahesh", "Your timesheet for last week was approved", "/timesheets"),
    (6, "emp-oliver", "Upcoming holiday: Christmas Day", "/holidays"),
    (4, "demo-hr-admin", "Approve expense claim: team lunch", "/approvals"),
    (3, "emp-ram", "Help desk request updated", "/help"),
]


def _emails(db: Session, now: datetime) -> int:
    from app.services.email_outbox import channel_for, infer_category

    if db.scalar(select(func.count()).select_from(EmailOutboxItem).where(EmailOutboxItem.status == "Sent")):
        return 0
    people = {e.id: e for e in db.scalars(select(Employee).where(Employee.id.in_([r for _, r, _, _ in EMAILS])))}
    added = 0
    for days, rid, subject, link in EMAILS:
        emp = people.get(rid)
        if emp is None or not emp.email:
            continue
        created = now - timedelta(days=days, hours=days % 5)
        category = infer_category(link, subject)
        db.add(EmailOutboxItem(notification_id=None, recipient_id=rid, to_email=emp.email, subject=subject,
                               body=f"{subject}. Open TimeZ to see the details.", link=link, category=category,
                               channel=channel_for(category, link), status="Sent", created_at=created,
                               sent_at=created + timedelta(minutes=4), sent_by="demo-admin"))
        added += 1
    return added


# ---------------------------------------------------------------- payroll, access examples, other blanks
PAYROLL_PROVIDERS = {"IN": "Keka Payroll", "US": "ADP Workforce Now", "GB": "Sage Payroll", "AU": "Xero Payroll",
                     "CA": "Ceridian Dayforce", "AE": "Bayzat", "SA": "Jisr", "DE": "DATEV"}


def _payroll(db: Session) -> int:
    from app.routers.payroll import PROVIDERS_KEY

    if db.get(PlatformSetting, PROVIDERS_KEY) is not None:
        return 0
    countries = set(db.scalars(select(Country.code)))
    db.add(PlatformSetting(key=PROVIDERS_KEY, value={k: v for k, v in PAYROLL_PROVIDERS.items() if k in countries},
                           updated_by="demo-admin"))
    return 1


def _access_examples(db: Session) -> int:
    added = 0
    if db.get(Account, "emp-ram") is not None and db.get(PageAccessOverride, "emp-ram") is None:
        db.add(PageAccessOverride(account_id="emp-ram", grant_pages=["reportbuilder"], revoke_pages=[], updated_by="demo-admin"))
        added += 1
    if db.get(Account, "demo-recruiter") is not None and db.get(AccountDataScope, "demo-recruiter") is None:
        db.add(AccountDataScope(account_id="demo-recruiter", scope="department", country_codes=[], updated_by="demo-admin"))
        added += 1
    return added


INTERNAL_CLIENT = "TimeZ (internal)"


def _other_blanks(db: Session) -> tuple[int, int]:
    entity_by_country: dict[str, set[str]] = defaultdict(set)
    for cc, entity in db.execute(select(Employee.country_code, Employee.legal_entity).where(
            Employee.employment_status.not_in(LEFT)).distinct()):
        if entity:
            entity_by_country[cc].add(entity)
    plans = 0
    for p in db.scalars(select(BenefitPlan).where(BenefitPlan.legal_entity.is_(None))):
        entities = entity_by_country.get(p.country_code, set())
        if len(entities) == 1:  # one entity in the country: naming it changes nobody's eligibility
            p.legal_entity = next(iter(entities))
            plans += 1
    from app.seed import PROJECTS  # seed.seed_projects writes these clients back every run: not counted as new fills

    reset_each_run = {pid for pid, _code, _name, client, _billable in PROJECTS if client is None}
    projects = 0
    for p in db.scalars(select(Project)):
        if _blank(p.client) and not p.billable_default:
            p.client = INTERNAL_CLIENT
            projects += p.id not in reset_each_run
    return plans, projects


def seed(db: Session) -> dict[str, int]:
    now = utcnow()
    today = date.today()
    db.flush()
    positions, links = _positions(db, today)
    profile_fields = _job_profiles(db)
    unit_fields = _units(db)
    db.flush()
    _refresh_baselines(db)
    descriptions, holidays = _holidays(db)
    runs, quarantine = _integrations(db, now)
    plans, projects = _other_blanks(db)
    stats = {
        "positions_added": positions,
        "position_links_filled": links,
        "job_profile_details_filled": profile_fields,
        "org_unit_details_filled": unit_fields,
        "holiday_descriptions_filled": descriptions,
        "next_year_holidays_added": holidays,
        "optional_holidays_other_countries_added": _optional_holidays(db, today),
        "integration_runs_added": runs,
        "integration_quarantine_added": quarantine,
        "audit_history_added": _audit(db, now),
        "email_history_added": _emails(db, now),
        "payroll_providers_added": _payroll(db),
        "access_examples_added": _access_examples(db),
        "benefit_plan_entities_filled": plans,
        "project_clients_filled": projects,
    }
    db.flush()
    return stats
