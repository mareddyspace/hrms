"""Short AI drafts through OpenRouter (same model chain as the Copilot, app/services/ai_copilot.py):

- Employee 360 summary: built only from the sections the viewer may see (app/services/ai_talent_context.py).
  summary=None / used_ai=False -> the portal shows its built-in, rule-based summary.
- Recruiting: side-by-side candidate comparison and interview feedback summaries. Rule-based text when AI is off.

Drafts only: decisions (hiring, ratings, pay) stay with people. Every call is audited without the generated text.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.deps import CurrentUser
from app.models import Candidate, Employee, Interview, Requisition
from app.services import ai_copilot
from app.services import ai_talent_context as blocks
from app.services import career
from app.services.activity import record_audit
from app.services.attendance import local_today
from app.services.leave import balances
from app.services.talent_ai import MatchInput, match_candidate, needs_for_role

DRAFT_RULES = """Rules:
- Use ONLY the facts below. Never invent numbers, dates, names or events.
- This is a draft for a person to review. Never make or suggest decisions about hiring, ratings, pay, promotion or
  discipline; do not say who should be hired or rated higher.
- Never mention pay, personal contact details, health or case information.
- Plain, neutral language. No headings, no tables."""

EMPLOYEE_PROMPT = f"""You write a short draft summary of an employee for the TimeZ HRMS Employee 360 page.
Write 3 to 5 sentences: role and tenure, current goals and learning, skills and career direction when given.
{DRAFT_RULES}"""

COMPARE_PROMPT = f"""You write a short neutral comparison of job candidates for a recruiter and hiring manager.
Write 3 to 5 sentences covering experience, skills matched and missing against the requirements, interview scores and
stage. Point out differences and open questions; do not rank or recommend anyone.
{DRAFT_RULES}"""

FEEDBACK_PROMPT = f"""You summarise interview feedback for one candidate for the recruiter and hiring manager.
Write 2 to 4 sentences: common strengths, common concerns, where interviewers disagree, and what is still pending.
Do not recommend a hiring decision.
{DRAFT_RULES}"""

DECISION_NOTE = "Draft to help people review. Hiring decisions stay with the recruiter and hiring manager."


def _draft(system: str, facts: str) -> tuple[str | None, str | None]:
    messages = [{"role": "system", "content": f"{system}\n\nFACTS\n{facts}"},
                {"role": "user", "content": "Write the draft now."}]
    return ai_copilot._ask_models(messages)


# ---------- Employee 360 ----------
@dataclass
class EmployeeSummary:
    summary: str | None
    used_ai: bool
    model: str | None
    sections: list[str]


def employee_facts(db: Session, user: CurrentUser, emp: Employee) -> tuple[str, list[str]]:
    """Facts the viewer may see about this employee, and the section names used."""
    today = local_today(emp)
    manager = db.get(Employee, emp.manager_id) if emp.manager_id else None
    direct = len(list(db.scalars(select(Employee.id).where(Employee.manager_id == emp.id))))
    years = (today - emp.joining_date).days / 365.25 if emp.joining_date else 0
    parts = [
        "PROFILE\n"
        f"- Name: {emp.preferred_name or emp.full_name}\n- Job title: {emp.job_title} (grade {emp.grade}); department: "
        f"{emp.department}; location: {emp.location}, {emp.country_code}\n- Joined {emp.joining_date.isoformat()} "
        f"(about {years:.1f} years); employment: {emp.employment_type}, {emp.employment_status}\n"
        f"- Manager: {manager.full_name if manager else 'none'}; direct reports: {direct}"
    ]
    sections = ["Profile"]
    if not career.can_view_career(db, user, emp):
        return "\n\n".join(parts), sections  # role basics only (e.g. executives or admins outside HR)
    self_view = emp.id == user.employee_id

    def add(name: str, text: str | None) -> None:
        if text:
            parts.append(text)
            sections.append(name)

    add("Goals", blocks.goals_block(db, emp, heading="GOALS"))
    add("Released ratings", blocks.ratings_block(db, emp, heading="PERFORMANCE RATINGS (released by HR)"))
    add("Skills", blocks.skills_block(db, emp, heading="SKILLS"))
    add("Learning", blocks.learning_block(db, emp, today, heading="LEARNING"))
    add("Career interests", blocks.career_block(db, emp, heading="CAREER INTERESTS"))
    leave = [f"- {r.name}: {r.used:g} used, {r.available:g} available" for r in balances(db, emp)]
    add("Leave", "LEAVE THIS YEAR\n" + "\n".join(leave) if leave else None)
    if self_view:
        add("Benefits", blocks.benefits_block(db, emp))
    return "\n\n".join(parts), sections


def employee_summary(db: Session, user: CurrentUser, emp: Employee, ip: str | None = None) -> EmployeeSummary:
    facts, sections = employee_facts(db, user, emp)
    text, model = _draft(EMPLOYEE_PROMPT, facts)
    result = EmployeeSummary(text, text is not None, model, sections)
    record_audit(db, actor_id=user.id, action="generated", entity="AI employee summary", entity_id=emp.id, subject_id=emp.id,
                 after={"sections": sections, "used_ai": result.used_ai, "model": model}, ip=ip)
    return result


# ---------- recruiting ----------
@dataclass
class CandidateFacts:
    candidate: Candidate
    matched: list[str]
    missing: list[str]
    match_score: int
    scores: list[int]
    done: int
    pending: int
    feedback: list[tuple[str, int | None, str]]  # (kind, score, notes)

    @property
    def average(self) -> float | None:
        return round(sum(self.scores) / len(self.scores), 1) if self.scores else None


def candidate_facts(db: Session, cand: Candidate, req: Requisition) -> CandidateFacts:
    needs = needs_for_role(req.title, req.department, list(req.requirements or []))
    m = match_candidate(MatchInput(cand.name, list(cand.skills or []), cand.cv_note or "", cand.experience_years or 0), needs)
    interviews = list(db.scalars(select(Interview).where(Interview.candidate_id == cand.id).order_by(Interview.scheduled_at)))
    done = [i for i in interviews if i.feedback_status == "submitted"]
    return CandidateFacts(
        cand, list(m.get("matched") or []), list(m.get("missing") or []), int(m.get("score") or 0),
        [i.score for i in done if i.score is not None], len(done), len(interviews) - len(done),
        [(i.kind, i.score, (i.feedback or "").strip()) for i in done],
    )


def _facts_text(f: CandidateFacts) -> str:
    c = f.candidate
    return (f"CANDIDATE {c.name}\n- Stage: {c.stage}; experience: {c.experience_years:g} years\n"
            f"- Skills matched: {', '.join(f.matched) or 'none'}; missing: {', '.join(f.missing) or 'none'}; "
            f"skill match {f.match_score}%\n- Interview scores (1-5): {', '.join(map(str, f.scores)) or 'none yet'}; "
            f"interviews pending feedback: {f.pending}")


def rule_compare(rows: list[CandidateFacts]) -> str:
    def avg(f: CandidateFacts) -> str:
        return f"{f.average:g}/5" if f.average is not None else "no scores yet"

    lines = [f"{f.candidate.name}: {f.candidate.experience_years:g} yrs, {f.candidate.stage}, skill match {f.match_score}%, "
             f"interviews {avg(f)}" + (f"; missing {', '.join(f.missing[:3])}" if f.missing else "") + "." for f in rows]
    pending = sum(f.pending for f in rows)
    if pending:
        lines.append(f"{pending} interview(s) still need feedback.")
    return " ".join(lines)


def compare(db: Session, req: Requisition, cands: list[Candidate]) -> tuple[list[CandidateFacts], str, bool, str | None]:
    rows = [candidate_facts(db, c, req) for c in cands]
    facts = f"ROLE {req.title} ({req.department}); requirements: {', '.join(req.requirements or []) or 'not listed'}\n\n" + \
        "\n\n".join(_facts_text(f) for f in rows)
    text, model = _draft(COMPARE_PROMPT, facts)
    return rows, text or rule_compare(rows), text is not None, model


_STRENGTH = ("strong", "excellent", "great", "good", "clear", "solid", "impressive", "confident")
_CONCERN = ("concern", "weak", "lack", "gap", "unclear", "struggled", "limited", "missing", "slow")


def rule_feedback(f: CandidateFacts) -> str:
    if not f.done:
        return f"No interview feedback yet. {f.pending} interview(s) waiting for feedback." if f.pending else "No interviews yet."
    parts = [f"{f.done} interview(s) with feedback, average score {f.average:g}/5." if f.average is not None
             else f"{f.done} interview(s) with feedback."]
    strengths = [k for k, _, notes in f.feedback if any(w in notes.lower() for w in _STRENGTH)]
    concerns = [k for k, _, notes in f.feedback if any(w in notes.lower() for w in _CONCERN)]
    if strengths:
        parts.append(f"Positive notes from: {', '.join(dict.fromkeys(strengths))}.")
    if concerns:
        parts.append(f"Concerns raised in: {', '.join(dict.fromkeys(concerns))}.")
    if f.scores and max(f.scores) - min(f.scores) >= 2:
        parts.append("Interviewers disagree (scores range from "
                     f"{min(f.scores)} to {max(f.scores)}).")
    if f.pending:
        parts.append(f"{f.pending} interview(s) still waiting for feedback.")
    return " ".join(parts)


def feedback_summary(db: Session, cand: Candidate, req: Requisition) -> tuple[CandidateFacts, str, bool, str | None]:
    f = candidate_facts(db, cand, req)
    if not f.done:
        return f, rule_feedback(f), False, None
    notes = "\n".join(f"- {kind}: score {score if score is not None else '-'} of 5. {text[:800]}" for kind, score, text in f.feedback)
    facts = f"ROLE {req.title}\n{_facts_text(f)}\n\nINTERVIEW FEEDBACK\n{notes}"
    text, model = _draft(FEEDBACK_PROMPT, facts)
    return f, text or rule_feedback(f), text is not None, model
