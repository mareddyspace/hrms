"""Complete sample profiles: fill only the blank fields of every employee, and give people without a manager one.

The workbook (TimeZ_500_Employee_Sample_HCM_Data.xlsx) has the HR basics only, so personal details, address, emergency
contact, languages, education and past jobs were empty. This fills them with country-appropriate sample values.
Rules:
- Only blank fields (None, "" or an empty list) are filled; a value already there is never changed.
- Values are derived from the employee id, so the same person always gets the same details (safe to run again).
- Reporting line: someone without a manager reports to the head of their department in their country (highest grade,
  then earliest joiner); a department head reports to the country head; a country head reports to the CEO (demo-ceo).
  Demo sign-in people are never made heads, so their teams stay as they are. A manager is never set inside the
  person's own reporting line (no loops).
"""

from __future__ import annotations

import hashlib
from datetime import date, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Employee, EmployeeAssignment

CEO = "demo-ceo"

NATIONALITY = {"IN": "Indian", "US": "American", "GB": "British", "AU": "Australian", "CA": "Canadian", "AE": "Emirati",
               "SA": "Saudi", "DE": "German"}
COUNTRY_NAME = {"IN": "India", "US": "United States", "GB": "United Kingdom", "AU": "Australia", "CA": "Canada",
                "AE": "United Arab Emirates", "SA": "Saudi Arabia", "DE": "Germany"}
LANGUAGES = {
    "IN": ["English", "Hindi"], "US": ["English"], "GB": ["English"], "AU": ["English"], "CA": ["English", "French"],
    "AE": ["Arabic", "English"], "SA": ["Arabic", "English"], "DE": ["German", "English"],
}
CITY_LANGUAGE = {"Bengaluru": "Kannada", "Hyderabad": "Telugu", "Mumbai": "Marathi", "Chennai": "Tamil", "Pune": "Marathi"}
STREETS = {
    "IN": ["MG Road", "Residency Road", "Brigade Road", "Linking Road", "Banjara Hills Road", "Indiranagar 100 Feet Road"],
    "US": ["Main Street", "Oak Avenue", "Maple Drive", "Congress Avenue", "Market Street", "Park Avenue"],
    "GB": ["High Street", "Station Road", "Church Lane", "Victoria Road", "Deansgate", "Baker Street"],
    "AU": ["George Street", "Collins Street", "Pitt Street", "Bourke Street", "Chapel Street"],
    "CA": ["Queen Street", "King Street West", "Robson Street", "Granville Street", "Yonge Street"],
    "AE": ["Sheikh Zayed Road", "Al Wasl Road", "Corniche Road", "Hamdan Street", "Al Khaleej Road"],
    "SA": ["King Fahd Road", "Olaya Street", "Tahlia Street", "Prince Sultan Road", "King Abdulaziz Road"],
    "DE": ["Hauptstrasse", "Bahnhofstrasse", "Kaiserstrasse", "Friedrichstrasse", "Maximilianstrasse"],
}
FIRST = {
    "IN": ["Anil", "Sunita", "Rakesh", "Lakshmi", "Suresh", "Kavitha", "Ravi", "Meena"],
    "US": ["Michael", "Jennifer", "David", "Sarah", "Robert", "Linda", "James", "Karen"],
    "GB": ["Thomas", "Charlotte", "George", "Emily", "Harry", "Sophie", "Jack", "Lucy"],
    "AU": ["Liam", "Chloe", "Noah", "Ruby", "Lachlan", "Mia", "Cooper", "Grace"],
    "CA": ["Ethan", "Emma", "Lucas", "Olivia", "Benjamin", "Ava", "Logan", "Lily"],
    "AE": ["Ahmed", "Fatima", "Khalid", "Mariam", "Saeed", "Aisha", "Omar", "Noura"],
    "SA": ["Abdullah", "Nora", "Faisal", "Sara", "Turki", "Reem", "Fahad", "Lama"],
    "DE": ["Lukas", "Anna", "Felix", "Lena", "Jonas", "Laura", "Paul", "Hannah"],
}
UNIVERSITIES = {
    "IN": ["Anna University", "University of Mumbai", "Osmania University", "Bangalore University", "VIT Vellore"],
    "US": ["University of Texas at Austin", "New York University", "UC Berkeley", "Ohio State University"],
    "GB": ["University of Manchester", "King's College London", "University of Leeds", "University of Bristol"],
    "AU": ["University of Melbourne", "University of Sydney", "Monash University", "UNSW Sydney"],
    "CA": ["University of Toronto", "University of British Columbia", "McGill University", "University of Waterloo"],
    "AE": ["American University of Sharjah", "Khalifa University", "UAE University", "Zayed University"],
    "SA": ["King Saud University", "King Abdulaziz University", "KFUPM", "Princess Nourah University"],
    "DE": ["TU Munich", "Humboldt University of Berlin", "Goethe University Frankfurt", "LMU Munich"],
}
EMPLOYERS = ["Infosys", "Accenture", "Deloitte", "Capgemini", "IBM", "Wipro", "PwC", "Oracle", "SAP", "Cognizant",
             "EY", "KPMG", "Siemens", "HSBC", "Amazon"]
# department -> (division, job family, degree)
DEPARTMENT_INFO = {
    "Engineering": ("Technology", "Engineering", "B.Tech in Computer Science"),
    "IT": ("Technology", "Information Technology", "B.Sc in Information Technology"),
    "Customer Success": ("Customer", "Customer Support", "Bachelor of Business Administration"),
    "Sales": ("Commercial", "Sales", "Bachelor of Commerce"),
    "Marketing": ("Commercial", "Marketing", "BA in Marketing"),
    "Finance": ("Corporate", "Finance", "Bachelor of Commerce in Accounting"),
    "Human Resources": ("Corporate", "Human Resources", "MBA in Human Resources"),
    "People": ("Corporate", "Human Resources", "MBA in Human Resources"),
    "Talent Acquisition": ("Corporate", "Human Resources", "BA in Psychology"),
    "Learning & Development": ("Corporate", "Human Resources", "MA in Education"),
    "Legal & Compliance": ("Corporate", "Legal & Compliance", "Bachelor of Laws (LLB)"),
    "Operations": ("Operations", "Operations", "Bachelor of Business Administration"),
    "Executive": ("Corporate", "Leadership", "MBA"),
}
GRADE_RANK = {g: i for i, g in enumerate(["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "L4", "L5", "L6", "M1",
                                          "M2", "E1"])}


def _pick(seed: str, options: list[Any]) -> Any:
    return options[int(hashlib.sha256(seed.encode()).hexdigest(), 16) % len(options)]


def _num(seed: str, low: int, high: int) -> int:
    return low + int(hashlib.sha256(seed.encode()).hexdigest(), 16) % (high - low + 1)


def _digits(seed: str, n: int) -> str:
    h = int(hashlib.sha256(seed.encode()).hexdigest(), 16)
    return "".join(str((h >> (4 * i)) % 10) for i in range(n))


def _mobile(cc: str, seed: str) -> str:
    d = _digits(seed, 10)
    return {
        "IN": f"+91 9{d[:4]} {d[4:9]}", "US": f"+1 ({_num(seed, 201, 989)}) {d[:3]}-{d[3:7]}",
        "GB": f"+44 7{d[:3]} {d[3:9]}", "AU": f"+61 4{d[:2]} {d[2:5]} {d[5:8]}",
        "CA": f"+1 ({_num(seed, 204, 905)}) {d[:3]}-{d[3:7]}", "AE": f"+971 5{d[0]} {d[1:4]} {d[4:8]}",
        "SA": f"+966 5{d[0]} {d[1:4]} {d[4:8]}", "DE": f"+49 15{d[:2]} {d[2:10]}",
    }.get(cc, f"+1 555 {d[:7]}")


def _postcode(cc: str, seed: str) -> str:
    d = _digits(seed, 6)
    letters = "ABCDEFGHJKLMNPRSTUWXYZ"
    a, b = letters[int(d[0]) % len(letters)], letters[(int(d[1]) + 10) % len(letters)]
    return {
        "IN": f"5{d[:5]}", "US": f"{_num(seed, 10001, 98199)}", "GB": f"M{d[0]} {d[1]}{a}{b}",
        "AU": f"{_num(seed, 2000, 3999)}", "CA": f"M{d[0]}{a} {d[1]}{b}{d[2]}", "AE": f"{_num(seed, 10000, 99999)}",
        "SA": f"{_num(seed, 11000, 23999)}", "DE": f"{_num(seed, 10115, 81929)}",
    }.get(cc, d[:5])


def _blank(value: Any) -> bool:
    return value is None or value == "" or value == [] or value == {}


def _timeline(e: Employee) -> tuple[int, date, date, bool]:
    """Graduation year and previous job that fit together: born -> graduated at 21+ -> previous job starts after
    graduating and ends 3-13 weeks before joining TimeZ. With no room for a job, a student internship instead."""
    key = e.id
    joined = e.joining_date or date(2020, 1, 1)
    dob = e.date_of_birth if isinstance(e.date_of_birth, date) else None
    prev_end = joined - timedelta(days=_num(key + "pe", 20, 90))
    years = _num(key + "ps", 2, 6)
    earliest = (dob.year + 21) if dob else 1985
    latest = prev_end.year - 1  # at least about a year in the previous job
    grad = min(max(prev_end.year - years - _num(key + "gap", 0, 1), earliest), date.today().year - 1)
    if grad > latest:  # straight from university: an internship in the final year
        grad = max(earliest, min(joined.year, date.today().year - 1))
        start = date(grad - 1, 6, 1)
        return grad, start, start + timedelta(days=_num(key + "in", 60, 90)), True
    start = max(prev_end - timedelta(days=365 * years), date(grad, 7, 1))
    return grad, start, prev_end, False


def _old_background(e: Employee) -> tuple[list[dict], list[dict]]:
    """The education / job values the first version of this seeder wrote (graduation and job picked separately),
    so repair_backgrounds() can recognise and correct only those, never values a person or HR entered."""
    cc = e.country_code or "IN"
    key = e.id
    _division, family, degree = DEPARTMENT_INFO.get(e.department or "", ("Corporate", e.department or "General", "Bachelor's degree"))
    joined = e.joining_date or date(2020, 1, 1)
    grad_year = max(1985, min(joined.year - _num(key + "gap", 1, 8), date.today().year - 1))
    prev_end = joined - timedelta(days=_num(key + "pe", 20, 90))
    prev_start = prev_end - timedelta(days=365 * _num(key + "ps", 2, 6))
    edu = [{"degree": degree, "institution": _pick(key + "uni", UNIVERSITIES.get(cc, ["State University"])), "year": grad_year}]
    exp = [{"employer": _pick(key + "emp", EMPLOYERS), "title": _pick(key + "pt", [
        f"Associate {family}", f"{family} Analyst", f"{family} Specialist", f"Junior {e.job_title or family}"]),
        "from": prev_start.strftime("%Y-%m"), "to": prev_end.strftime("%Y-%m")}]
    return edu, exp


def min_joining_age(e: Employee) -> int:
    """Youngest believable age at joining for this grade / title (graduate roles 22, senior and director roles older)."""
    grade = (e.grade or "").upper()
    title = (e.job_title or "").lower()
    age = {"G1": 21, "G2": 22, "G3": 22, "G4": 23, "G5": 25, "G6": 27, "G7": 30, "G8": 33, "G9": 36}.get(grade, 22)
    if any(w in title for w in ("director", "head of", "vp", "chief")):
        age = max(age, 32)
    elif any(w in title for w in ("manager", "lead")):
        age = max(age, 27)
    return age


def repair_young_joiners(db: Session) -> int:
    """The sample workbook has people who joined at 13-20 (even directors). Move such a birth date back so the person
    was at least min_joining_age() when joining; day and month stay, joining date and everything else stay."""
    fixed = 0
    for e in db.scalars(select(Employee).where(Employee.date_of_birth.is_not(None), Employee.joining_date.is_not(None))):
        need = min_joining_age(e)
        dob, joined = e.date_of_birth, e.joining_date
        age = joined.year - dob.year - ((joined.month, joined.day) < (dob.month, dob.day))
        if age >= need:
            continue
        year = joined.year - need - _num(e.id + "dobfix", 0, 4) - 1
        day = min(dob.day, 28) if dob.month == 2 else dob.day
        e.date_of_birth = date(year, dob.month, day)
        fixed += 1
    return fixed


def _personas() -> dict[str, dict]:
    """The sign-in people's own education and jobs (the same as their portal personas, src/data/personProfileSeed.ts)."""
    import json
    from pathlib import Path

    path = Path(__file__).resolve().parents[1] / "seed" / "persona_backgrounds.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def repair_backgrounds(db: Session) -> int:
    """Correct generated education / previous-job values whose dates contradict each other (a job before
    graduating, or titles like "Junior Senior …"), and give the sign-in people their persona background.
    Only rows still holding exactly what this seeder generated (or nothing) are changed."""
    fixed = 0
    personas = _personas()
    for e in db.scalars(select(Employee)):
        old_edu, old_exp = _old_background(e)
        new = _profile_values(e)
        generated = (e.education, e.experience) in ((old_edu, old_exp), (new["education"], new["experience"]))
        blank = not e.education and not e.experience
        if e.id in personas and (generated or blank):
            want = personas[e.id]
            if e.education != want.get("education") or e.experience != want.get("experience"):
                e.education, e.experience = want.get("education") or [], want.get("experience") or []
                fixed += 1
            continue
        if e.education != old_edu or e.experience != old_exp:
            continue
        if new["education"] != old_edu or new["experience"] != old_exp:
            e.education, e.experience = new["education"], new["experience"]
            fixed += 1
    return fixed


def _profile_values(e: Employee) -> dict[str, Any]:
    cc = e.country_code or "IN"
    key = e.id
    first = (e.first_name or e.full_name.split()[0]).strip()
    last = (e.last_name or (e.full_name.split()[-1] if len(e.full_name.split()) > 1 else "")).strip()
    handle = ".".join(x for x in (first, last) if x).lower().replace(" ", "").replace("'", "")
    division, family, degree = DEPARTMENT_INFO.get(e.department or "", ("Corporate", e.department or "General", "Bachelor's degree"))
    city = e.location or ""
    langs = list(LANGUAGES.get(cc, ["English"]))
    if cc == "IN" and CITY_LANGUAGE.get(city) and CITY_LANGUAGE[city] not in langs:
        langs.append(CITY_LANGUAGE[city])
    joined = e.joining_date or date(2020, 1, 1)
    grad_year, prev_start, prev_end, intern = _timeline(e)
    rel = _pick(key + "rel", ["Spouse", "Parent", "Sibling"])
    contact = f"{_pick(key + 'efn', FIRST.get(cc, FIRST['IN']))} {last or _pick(key + 'eln', ['Smith', 'Khan', 'Rao'])}"
    if contact.lower() == f"{first} {last}".strip().lower():  # never the person themself as their emergency contact
        others = [n for n in FIRST.get(cc, FIRST["IN"]) if n.lower() != first.lower()]
        contact = f"{_pick(key + 'efn2', others)} {last or _pick(key + 'eln', ['Smith', 'Khan', 'Rao'])}"
    # a generated birth date fits the timeline: graduated at 21-23
    birth = date(grad_year - _num(key + "age", 21, 23), _num(key + "bm", 1, 12), _num(key + "bd", 1, 28))
    return {
        "nationality": NATIONALITY.get(cc, "Other"),
        "personal_email": f"{handle}{_num(key + 'em', 1, 99)}@mail.example",
        "mobile": _mobile(cc, key + "mob"),
        "photo": "/profile.svg",
        "division": division,
        "job_family": family,
        "address_line": f"{_num(key + 'no', 1, 240)} {_pick(key + 'st', STREETS.get(cc, ['Main Street']))}",
        "address_city": city,
        "address_postcode": _postcode(cc, key + "pc"),
        "address_country": COUNTRY_NAME.get(cc, cc),
        "emergency_name": contact,
        "emergency_relationship": rel,
        "emergency_phone": _mobile(cc, key + "emob"),
        "work_arrangement": _pick(key + "wa", ["Office", "Hybrid", "Hybrid", "Remote"]),
        "preferred_language": langs[0] if cc not in ("IN",) else "English",
        "languages": langs,
        "education": [{"degree": degree, "institution": _pick(key + "uni", UNIVERSITIES.get(cc, ["State University"])),
                       "year": grad_year}],
        "experience": [{"employer": _pick(key + "emp", EMPLOYERS), "title": (f"{family} Intern" if intern else _pick(key + "pt", [
            f"Associate {family}", f"{family} Analyst", f"{family} Specialist", f"{family} Executive"])),
            "from": prev_start.strftime("%Y-%m"), "to": prev_end.strftime("%Y-%m")}],
        "career_goals": _pick(key + "cg", [
            f"Grow into a senior {e.job_title or family} role within two years.",
            f"Lead a {family.lower()} team and mentor new joiners.",
            f"Deepen expertise in {family.lower()} and earn a professional certification.",
            "Take on a cross-country project and broaden my leadership skills."]),
        "tax_regime": _pick(key + "tax", ["new", "new", "old"]) if cc == "IN" else None,
        "ai_profile_status": "Available",
        "cost_centre": f"CC-{cc}-{(e.department or 'GEN')[:3].upper()}",
        "gender": _pick(key + "g", ["Female", "Male"]),
        "date_of_birth": birth,
    }


def fill_missing_profiles(db: Session) -> int:
    """Fill blank profile fields of every employee. Returns the number of fields filled."""
    filled = 0
    employees = list(db.scalars(select(Employee)))
    # A blank cost centre takes the code colleagues in the same country and department use (workbook format).
    codes: dict[tuple[str, str], str] = {}
    for x in employees:
        if x.cost_centre:
            codes.setdefault((x.country_code, x.department), x.cost_centre)
    for e in employees:
        values = _profile_values(e)
        values["cost_centre"] = codes.get((e.country_code, e.department), values["cost_centre"])
        for field, value in values.items():
            if value is None or not hasattr(e, field) or not _blank(getattr(e, field)):
                continue
            setattr(e, field, value)
            filled += 1
    return filled


def _rank(e: Employee) -> tuple[int, date, str]:
    return (-GRADE_RANK.get(e.grade or "", 0), e.joining_date or date.max, e.id)


def assign_missing_managers(db: Session) -> int:
    """Give everyone (except the CEO) without a manager one: department head -> country head -> CEO."""
    people = {e.id: e for e in db.scalars(select(Employee))}
    if CEO not in people:
        return 0
    demo = {e.id for e in people.values() if e.source != "hcm_sample"}
    active = [e for e in people.values() if e.id not in demo and e.employment_status not in ("Terminated", "Exited")]

    def chain(pid: str) -> set[str]:
        """Everyone above pid (its managers)."""
        out: set[str] = set()
        cur = people.get(pid)
        while cur is not None and cur.manager_id and cur.manager_id not in out:
            out.add(cur.manager_id)
            cur = people.get(cur.manager_id)
        return out

    def head_of(group: list[Employee]) -> Employee | None:
        return min(group, key=_rank) if group else None

    by_dept: dict[tuple[str, str], list[Employee]] = {}
    by_country: dict[str, list[Employee]] = {}
    for e in active:
        by_dept.setdefault((e.country_code, e.department), []).append(e)
        by_country.setdefault(e.country_code, []).append(e)
    dept_head = {k: head_of(v) for k, v in by_dept.items()}
    country_head = {k: head_of(v) for k, v in by_country.items()}

    assigned = 0
    for e in sorted((x for x in people.values() if not x.manager_id and x.id != CEO), key=_rank, reverse=True):
        candidates = []
        if e.id not in demo:
            dh = dept_head.get((e.country_code, e.department))
            ch = country_head.get(e.country_code)
            if dh is not None and dh.id != e.id:
                candidates.append(dh.id)
            if ch is not None and ch.id != e.id:
                candidates.append(ch.id)
        candidates.append(CEO)
        for mid in candidates:
            if mid != e.id and e.id not in chain(mid) and e.id != mid:  # e must not be above its new manager
                e.manager_id = mid
                current = db.scalar(select(EmployeeAssignment).where(EmployeeAssignment.employee_id == e.id,
                                                                     EmployeeAssignment.effective_to.is_(None)))
                if current is not None and not current.manager_id:
                    current.manager_id = mid
                assigned += 1
                break
    return assigned


def hiring_manager_for(e: Employee, people: dict[str, Employee]) -> str:
    """Who hired this person: their manager if the manager was already here on the joining day, otherwise the first
    person up the reporting line who was (a manager who joined later cannot have hired them); the board for the CEO."""
    if e.id == CEO:
        return "Board of Directors"
    boss, seen = people.get(e.manager_id or ""), set()
    while boss is not None and boss.id not in seen and boss.joining_date and e.joining_date and boss.joining_date > e.joining_date:
        seen.add(boss.id)
        boss = people.get(boss.manager_id or "")
    return boss.full_name if boss is not None and boss.id not in seen else "Board of Directors"


def fill_hiring(db: Session) -> int:
    """Blank "hired by" (a recruiter: someone in HR / talent in the same country who joined earlier) and "hiring
    manager" (the person's manager, or the first one up the line who had joined by then; the board for the CEO).
    Fills blanks only."""
    people = {e.id: e for e in db.scalars(select(Employee))}
    recruiters: dict[str, list[Employee]] = {}
    for e in people.values():
        dept = (e.department or "").lower()
        if e.id == "demo-recruiter" or "human resources" in dept or "talent" in dept or "people" in dept:
            recruiters.setdefault(e.country_code, []).append(e)
    for group in recruiters.values():
        group.sort(key=lambda x: (x.id != "demo-recruiter", x.joining_date or date.min, x.id))
    filled = 0
    for e in people.values():
        if _blank(e.hiring_manager):
            e.hiring_manager = hiring_manager_for(e, people)
            filled += 1
        if _blank(e.hired_by):
            if e.id == CEO:
                e.hired_by = "Board of Directors (executive search)"
            else:
                pool = [r for r in recruiters.get(e.country_code, []) if r.id != e.id
                        and (r.joining_date is None or e.joining_date is None or r.joining_date <= e.joining_date)]
                pick = _pick(e.id + ":recruiter", pool) if pool else None
                e.hired_by = f"{pick.full_name} (Talent Acquisition)" if pick else "TimeZ Talent Acquisition"
            filled += 1
    return filled


def seed_profiles(db: Session) -> dict[str, int]:
    out = {"birth_dates_repaired": repair_young_joiners(db)}
    db.flush()
    out["profile_fields_filled"] = fill_missing_profiles(db)
    db.flush()
    out["managers_assigned"] = assign_missing_managers(db)
    db.flush()
    out["backgrounds_repaired"] = repair_backgrounds(db)
    db.flush()
    out["hiring_fields_filled"] = fill_hiring(db)
    db.flush()
    return out
