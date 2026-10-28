"""Rule-based CV reading and candidate <-> role matching.

Straight ports of the front end's src/features/ai/skillVocab.ts, cvReader.ts and candidateMatch.ts so both give
the same answers. Deterministic: no model calls. Every result is a suggestion for people to review.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import date
from typing import Any

# ---------- skills vocabulary (skillVocab.ts) ----------
SKILL_LIBRARY: list[dict[str, str]] = [
    {"id": "sk-1", "name": "React", "category": "Engineering"},
    {"id": "sk-2", "name": "TypeScript", "category": "Engineering"},
    {"id": "sk-3", "name": "People leadership", "category": "Leadership"},
    {"id": "sk-4", "name": "Cloud architecture", "category": "Engineering"},
    {"id": "sk-5", "name": "Recruiting", "category": "People"},
    {"id": "sk-6", "name": "Financial analysis", "category": "Finance"},
    {"id": "sk-7", "name": "System design", "category": "Engineering"},
    {"id": "sk-8", "name": "Employee relations", "category": "People"},
    {"id": "sk-9", "name": "Reward and pay", "category": "People"},
    {"id": "sk-10", "name": "Product management", "category": "Product"},
    {"id": "sk-11", "name": "Business strategy", "category": "Leadership"},
    {"id": "sk-12", "name": "Platform administration", "category": "IT"},
]

LIBRARY_ALIASES: dict[str, list[str]] = {
    "sk-1": ["react", "react.js", "reactjs", "next.js", "nextjs", "redux"],
    "sk-2": ["typescript", "type script"],
    "sk-3": ["people leadership", "people management", "team lead", "led a team", "managed a team", "line management", "mentoring", "mentored"],
    "sk-4": ["cloud architecture", "aws", "azure", "gcp", "google cloud", "kubernetes", "terraform", "cloud"],
    "sk-5": ["recruiting", "recruitment", "talent acquisition", "sourcing", "hiring", "headhunting"],
    "sk-6": ["financial analysis", "fp&a", "financial modelling", "financial modeling", "budgeting", "forecasting", "month-end close"],
    "sk-7": ["system design", "systems design", "software architecture", "distributed systems", "microservices", "scalable systems"],
    "sk-8": ["employee relations", "hrbp", "hr business partner", "grievance", "disciplinary", "workplace investigations"],
    "sk-9": ["reward", "compensation", "payroll", "benefits", "total rewards", "pay benchmarking"],
    "sk-10": ["product management", "product manager", "roadmap", "product discovery", "product owner"],
    "sk-11": ["business strategy", "strategy", "strategic planning", "go-to-market", "p&l"],
    "sk-12": ["platform administration", "system administration", "sysadmin", "active directory", "okta", "identity management", "it administration"],
}

EXTRA: list[tuple[str, str, list[str]]] = [
    ("JavaScript", "Engineering", ["javascript", "es6", "js"]),
    ("Node.js", "Engineering", ["node.js", "nodejs", "node", "express"]),
    ("Python", "Engineering", ["python", "django", "flask"]),
    ("Java", "Engineering", ["java", "spring boot"]),
    ("SQL", "Data", ["sql", "postgres", "postgresql", "mysql"]),
    ("Design systems", "Engineering", ["design systems", "design system", "component library", "storybook"]),
    ("Testing", "Engineering", ["jest", "cypress", "playwright", "unit testing", "test automation"]),
    ("CI/CD", "Engineering", ["ci/cd", "github actions", "jenkins", "devops"]),
    ("Data analysis", "Data", ["data analysis", "analytics", "tableau", "power bi", "looker"]),
    ("Excel / BI", "Finance", ["excel", "power bi", "bi tools"]),
    ("User research", "Product", ["user research", "usability testing", "user interviews"]),
    ("UX design", "Product", ["ux", "ui design", "figma", "wireframing", "prototyping"]),
    ("Workforce planning", "People", ["workforce planning", "headcount planning", "org design"]),
    ("Boolean search", "People", ["boolean search", "x-ray search"]),
    ("ATS proficiency", "People", ["ats", "greenhouse", "lever", "workday recruiting", "applicant tracking"]),
    ("Stakeholder management", "Business", ["stakeholder management", "stakeholder", "cross-functional"]),
    ("Customer onboarding", "Customer", ["customer onboarding", "customer success", "account management", "renewals"]),
    ("Communication", "Business", ["communication", "presentation", "public speaking"]),
    ("Agile delivery", "Engineering", ["agile", "scrum", "kanban", "sprint planning"]),
    ("Employment law", "Legal", ["employment law", "labour law", "labor law"]),
]


@dataclass(frozen=True)
class VocabSkill:
    name: str
    category: str
    aliases: tuple[str, ...]
    library_id: str | None = None


VOCAB: list[VocabSkill] = [
    *(VocabSkill(s["name"], s["category"], tuple(LIBRARY_ALIASES.get(s["id"], [s["name"].lower()])), s["id"]) for s in SKILL_LIBRARY),
    *(VocabSkill(name, cat, tuple(aliases)) for name, cat, aliases in EXTRA),
]


def mentions(text: str, alias: str) -> bool:
    """True when `alias` appears in `text` as a whole word or phrase."""
    return re.search(rf"(^|[^a-z0-9+#]){re.escape(alias.lower())}($|[^a-z0-9+#])", text, re.IGNORECASE) is not None


def find_skills(text: str) -> list[VocabSkill]:
    lower = text.lower()
    found = [s for s in VOCAB if any(mentions(lower, a) for a in s.aliases) or mentions(lower, s.name)]
    return [s for s in found if s.library_id] + [s for s in found if not s.library_id]


def canonical_skill(raw: str) -> str | None:
    found = find_skills(raw)
    return found[0].name if found else None


def same_skill(a: str, b: str) -> bool:
    if a.strip().lower() == b.strip().lower():
        return True
    ca = canonical_skill(a)
    return bool(ca) and ca == canonical_skill(b)


# ---------- CV reader (cvReader.ts) ----------
DEGREE = re.compile(
    r"\b(ph\.?d|doctorate|m\.?b\.?a|master'?s?|m\.?sc|m\.?s\b|m\.?tech|m\.?e\b|m\.?a\b|bachelor'?s?|b\.?sc|b\.?s\b|b\.?tech|"
    r"b\.?e\b|b\.?a\b|b\.?com|bca|mca|diploma|degree|university|college)",
    re.IGNORECASE,
)
HEADINGS = re.compile(
    r"^(curriculum vitae|resume|résumé|cv|profile|summary|experience|work experience|employment|education|skills|contact|"
    r"projects|certifications?)\s*:?$",
    re.IGNORECASE,
)
PRESENT = re.compile(r"\b(present|current|now|till date|to date)\b", re.IGNORECASE)
MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec"


def _clean(line: str) -> str:
    line = re.sub(r"^[\s•\-*·|]+", "", line)
    return re.sub(r"\s+", " ", line).strip()


def _find_name(lines: list[str]) -> str:
    for line in lines:
        m = re.match(r"^(?:name|full name)\s*[:\-]\s*(.+)$", line, re.IGNORECASE)
        if m:
            return m.group(1).strip()
    for line in lines[:6]:
        if HEADINGS.search(line) or re.search(r"@|\d|http", line, re.IGNORECASE):
            continue
        words = line.split(" ")
        if 2 <= len(words) <= 4 and all(re.match(r"^[A-Z][A-Za-z'’.-]*$", w) for w in words):
            return line
    return ""


def _find_phone(text: str) -> str:
    for p in re.findall(r"(\+?\d[\d\s().-]{7,}\d)", text):
        if len(re.sub(r"\D", "", p)) >= 9 and not re.match(r"^\s*(19|20)\d{2}\s*[-–]\s*(19|20)\d{2}\s*$", p):
            return p.strip()
    return ""


def _find_years(text: str, this_year: int) -> int | None:
    stated = [int(m.group(1)) for m in re.finditer(r"(\d{1,2})\s*\+?\s*(?:years?|yrs?)(?:\s+of)?(?:\s+\w+){0,3}\s+experience", text, re.IGNORECASE)]
    loose = [int(m.group(1)) for m in re.finditer(r"(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b", text, re.IGNORECASE)]
    if stated and max(stated) < 50:
        return max(stated)
    ranges = list(re.finditer(
        rf"(?:(?:{MONTHS})[a-z]*\.?\s+)?((?:19|20)\d{{2}})\s*(?:-|–|—|to)\s*(?:(?:{MONTHS})[a-z]*\.?\s+)?"
        rf"((?:19|20)\d{{2}}|present|current|now|till date|to date)",
        text, re.IGNORECASE,
    ))
    work = []
    for m in ranges:
        start = text.rfind("\n", 0, m.start() + 1)
        end = text.find("\n", m.start())
        line = text[start + 1:] if end < 0 else text[start + 1:end]
        if not DEGREE.search(line):
            work.append(m)
    if work:
        starts = [int(m.group(1)) for m in work]
        ends = [int(m.group(2)) if m.group(2)[0].isdigit() else this_year for m in work]
        span = max(ends) - min(starts)
        if 0 <= span < 50:
            return span
    if loose and max(loose) < 50:
        return max(loose)
    return None


def _split_role(line: str) -> dict[str, str]:
    no_dates = re.sub(rf"\(?\s*(?:(?:{MONTHS})[a-z]*\.?\s+)?(?:19|20)\d{{2}}.*$", "", line, count=1, flags=re.IGNORECASE)
    no_dates = PRESENT.sub("", no_dates, count=1)
    no_dates = re.sub(r"[\s,|–—-]+$", "", no_dates).strip()
    parts = [p.strip() for p in re.split(r"\s+at\s+|\s+@\s+|\s+[|–—-]\s+|,\s+", no_dates, flags=re.IGNORECASE)]
    parts = [p for p in parts if p]
    if len(parts) >= 2:
        return {"title": parts[0], "company": parts[1]}
    return {"title": parts[0] if parts else "", "company": ""}


def _after_label(line: str) -> str:
    return "-".join(re.split(r"[:\-]", line)[1:]).strip()


def _find_current_role(lines: list[str]) -> dict[str, str]:
    for line in lines:
        m = re.match(r"^(?:current (?:role|title|position)|designation|title)\s*[:\-]\s*(.+)$", line, re.IGNORECASE)
        if m:
            return _split_role(m.group(1))
    company_line = next((l for l in lines if re.match(r"^(?:current )?(?:company|employer)\s*[:\-]", l, re.IGNORECASE)), None)
    with_present = next(
        (l for l in lines if PRESENT.search(l) and not DEGREE.search(l) and re.search(r"[a-z]", PRESENT.sub("", l, count=1), re.IGNORECASE)),
        None,
    )
    if with_present:
        role = _split_role(with_present)
        if not role["title"]:
            i = lines.index(with_present)
            if i > 0:
                return _split_role(lines[i - 1])
        if not role["company"] and company_line:
            role["company"] = _after_label(company_line)
        return role
    if company_line:
        return {"title": "", "company": _after_label(company_line)}
    return {"title": "", "company": ""}


def read_cv(text: str, this_year: int | None = None) -> dict[str, Any]:
    """Pull candidate details out of pasted CV text. Rules only; every field is a suggestion."""
    this_year = this_year or date.today().year
    lines = [c for c in (_clean(l) for l in re.split(r"\r?\n", text)) if c]
    m = re.search(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", text, re.IGNORECASE)
    email = m.group(0) if m else ""
    skills = find_skills(text)
    role = _find_current_role(lines)
    education = [l for l in lines if DEGREE.search(l) and "@" not in l and len(l) < 160 and not HEADINGS.search(l)][:3]
    name = _find_name(lines)
    if not name and email:
        words = [w for w in re.split(r"[._-]+", email.split("@")[0]) if re.fullmatch(r"[a-z]+", w, re.IGNORECASE)]
        name = " ".join(w[0].upper() + w[1:].lower() for w in words)
    return {
        "name": name,
        "email": email.lower(),
        "phone": _find_phone(text),
        "experience_years": _find_years(text, this_year),
        "current_title": role["title"][:80],
        "current_company": role["company"][:80],
        "education": education,
        "library_skills": [s.name for s in skills if s.library_id],
        "other_skills": [s.name for s in skills if not s.library_id],
    }


# ---------- candidate match (candidateMatch.ts) ----------
TITLE_SKILLS: list[tuple[re.Pattern[str], list[str]]] = [
    (re.compile(r"react|front ?end|frontend", re.I), ["React", "TypeScript", "Design systems", "Testing"]),
    (re.compile(r"engineer|developer", re.I), ["System design", "TypeScript", "CI/CD", "Agile delivery"]),
    (re.compile(r"cloud|devops|platform|sre", re.I), ["Cloud architecture", "CI/CD", "Platform administration"]),
    (re.compile(r"product manager|product owner|head of product", re.I), ["Product management", "Stakeholder management", "User research", "Data analysis"]),
    (re.compile(r"product analyst|analyst", re.I), ["Data analysis", "SQL", "Stakeholder management"]),
    (re.compile(r"designer|ux", re.I), ["UX design", "User research", "Design systems"]),
    (re.compile(r"hr business partner|hrbp|people partner", re.I), ["Employee relations", "Workforce planning", "Stakeholder management", "Reward and pay"]),
    (re.compile(r"recruit|talent|sourcer", re.I), ["Recruiting", "Boolean search", "ATS proficiency", "Stakeholder management"]),
    (re.compile(r"finance|accountant|fp&a", re.I), ["Financial analysis", "Excel / BI", "Stakeholder management"]),
    (re.compile(r"reward|compensation|payroll", re.I), ["Reward and pay", "Financial analysis", "Excel / BI"]),
    (re.compile(r"customer success|account manager|support", re.I), ["Customer onboarding", "Communication", "Stakeholder management"]),
    (re.compile(r"it |administrator|it$", re.I), ["Platform administration", "Cloud architecture"]),
    (re.compile(r"manager|lead|head|director", re.I), ["People leadership"]),
]

DEPARTMENT_SKILLS: dict[str, list[str]] = {
    "Engineering": ["System design", "TypeScript"],
    "Product": ["Product management", "Stakeholder management"],
    "People": ["Employee relations", "Stakeholder management"],
    "Finance": ["Financial analysis", "Excel / BI"],
    "Customer Success": ["Customer onboarding", "Communication"],
    "Sales": ["Communication", "Stakeholder management"],
    "Information Technology": ["Platform administration"],
}

QUESTIONS: dict[str, str] = {
    "React": "Walk us through how you would structure state in a large React app.",
    "TypeScript": "How have you used TypeScript types to prevent bugs in a real project?",
    "System design": "Design a service that handles a sudden 10x traffic spike. What would you change first?",
    "Design systems": "How would you roll out a shared component across several teams?",
    "People leadership": "Tell us about a time you helped someone on your team improve.",
    "Cloud architecture": "How would you choose between managed services and running your own in the cloud?",
    "Recruiting": "How do you build a shortlist for a hard-to-fill role?",
    "Employee relations": "Describe a difficult employee relations case and how you handled it.",
    "Workforce planning": "How would you plan headcount for a team growing 30% next year?",
    "Stakeholder management": "Tell us about a time you had to align people with different goals.",
    "Financial analysis": "How would you explain a budget variance to a non-finance manager?",
    "Product management": "How do you decide what goes into the next release and what waits?",
    "Boolean search": "Show how you would search for this role on LinkedIn.",
    "ATS proficiency": "Which ATS have you used and how did you keep the data clean?",
}

FALLBACK_QUESTIONS = [
    "What attracted you to this role, and what would you want to achieve in the first 90 days?",
    "Tell us about a time a project did not go to plan. What did you learn?",
    "How do you keep your skills current?",
]


def _round(x: float) -> int:
    """JavaScript Math.round (halves go up)."""
    return math.floor(x + 0.5)


def _num(x: float) -> str:
    return f"{x:g}"


def years_for_title(title: str) -> int:
    if re.search(r"director|vp|vice president|chief|head of", title, re.I):
        return 10
    if re.search(r"principal|staff|lead", title, re.I):
        return 7
    if re.search(r"manager", title, re.I):
        return 6
    if re.search(r"senior|sr\.?\s", title, re.I):
        return 5
    if re.search(r"junior|associate|intern|graduate|sourcer", title, re.I):
        return 1
    return 3


def _uniq(items: list[str]) -> list[str]:
    out: list[str] = []
    for s in items:
        if s and not any(same_skill(o, s) for o in out):
            out.append(s)
    return out


@dataclass
class RoleNeeds:
    required: list[str]
    preferred: list[str]
    years: float
    source: str


def needs_for_role(title: str, department: str, requirements: list[str] | None = None) -> RoleNeeds:
    requirements = requirements or []
    from_reqs = [canonical_skill(r) or re.sub(r"^\d+\+?\s*years?\s*(of\s+)?", "", r, flags=re.I).strip() for r in requirements]
    stated = [int(m.group(1)) for r in requirements if (m := re.search(r"(\d+)\s*\+?\s*years?", r, re.I))]
    from_title = [s for rx, skills in TITLE_SKILLS if rx.search(f" {title} ") for s in skills]
    from_dept = DEPARTMENT_SKILLS.get(department, [])
    all_skills = _uniq([*from_reqs, *from_title, *from_dept])
    required_count = max(3, min(4, len(from_reqs) or 3))
    return RoleNeeds(
        required=all_skills[:required_count],
        preferred=all_skills[required_count:required_count + 3],
        years=max(stated) if stated else years_for_title(title),
        source="position requirements and job title" if requirements else "job title and department",
    )


@dataclass
class MatchInput:
    name: str
    skills: list[str] = field(default_factory=list)
    cv_note: str = ""
    experience_years: float = 0


def match_candidate(c: MatchInput, needs: RoleNeeds) -> dict[str, Any]:
    """Rule-based fit between a candidate and a role. A draft for people to review, not a decision."""
    skills = _uniq([*c.skills, *(s.name for s in find_skills(c.cv_note or ""))])
    has = lambda need: any(same_skill(s, need) for s in skills)  # noqa: E731
    matched = [s for s in needs.required if has(s)]
    missing = [s for s in needs.required if not has(s)]
    preferred_matched = [s for s in needs.preferred if has(s)]
    req = len(matched) / len(needs.required) if needs.required else 1
    pref = len(preferred_matched) / len(needs.preferred) if needs.preferred else 0
    exp = min(1, c.experience_years / needs.years) if needs.years else 1
    score = _round(req * 60 + pref * 15 + exp * 25)
    band = "Strong" if score >= 75 else "Partial" if score >= 50 else "Weak"
    first = c.name.split(" ")[0]
    years, needed = _num(c.experience_years), _num(needs.years)

    parts = [
        f"{first} shows {len(matched)} of {len(needs.required)} core skills ({', '.join(matched)})."
        if matched else f"{first}'s profile does not show the core skills for this role yet."
    ]
    if c.experience_years >= needs.years:
        parts.append(f"{years} years of experience meets the {needed}+ asked for.")
    else:
        parts.append(f"{years} years of experience is below the {needed}+ asked for.")
    if missing:
        parts.append(f"Worth probing: {', '.join(missing)}.")
    if preferred_matched:
        parts.append(f"Also brings {', '.join(preferred_matched)}.")

    questions = [QUESTIONS.get(s, f"This role needs {s}. Tell us about any related work you have done.") for s in missing]
    if c.experience_years < needs.years:
        questions.append(f"You have about {years} years of experience. What work best shows you are ready for this level?")
    for s in matched:
        if len(questions) >= 5:
            break
        questions.append(f"Give an example where your {s} work made a clear difference. What would you do differently now?")
    for f in FALLBACK_QUESTIONS:
        if len(questions) < 5:
            questions.append(f)

    return {
        "score": score,
        "band": band,
        "matched": matched,
        "missing": missing,
        "preferred_matched": preferred_matched,
        "years": c.experience_years,
        "years_needed": needs.years,
        "summary": " ".join(parts),
        "questions": questions[:5],
        "required": needs.required,
        "preferred": needs.preferred,
        "source": needs.source,
    }
