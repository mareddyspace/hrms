"""Policy knowledge for the HR Copilot: the portal's policy library, exported to seed/policies.json by
scripts/export-policies.mjs, with simple keyword retrieval.

Only policies that apply to the person (country, role, contractor or employee) and are not switched off by
an admin (ai_settings.disabled_policies) are searched.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

from sqlalchemy.orm import Session

from app.config import BACKEND_DIR
from app.models import AiSetting

POLICIES_FILE = BACKEND_DIR / "seed" / "policies.json"

_STOP = frozenset(
    "a an and are as at be by can do does for from have how i if in is it me my of on or our the this to "
    "what when where which who why will with you your am was were there their them get got any much many "
    "tell about please need want should could would".split()
)
# Words people use -> words the policy text uses.
_SYNONYMS = {
    "sick": ["sick", "ill", "illness"],
    "ill": ["sick"],
    "vacation": ["privilege", "annual", "leave"],
    "holiday": ["holiday", "holidays"],
    "holidays": ["holiday", "holidays"],
    "pto": ["leave", "privilege"],
    "wfh": ["work from home", "remote"],
    "remote": ["remote", "work from home"],
    "resign": ["resignation", "notice", "exit"],
    "resignation": ["resignation", "notice", "exit"],
    "quit": ["resignation", "notice"],
    "salary": ["pay", "payslip", "salary"],
    "payslip": ["pay", "payslip"],
    "tax": ["tax"],
    "expense": ["expense", "claim", "receipt"],
    "expenses": ["expense", "claim", "receipt"],
    "claim": ["claim", "expense"],
    "reimbursement": ["claim", "expense"],
    "travel": ["travel"],
    "maternity": ["maternity", "parental"],
    "paternity": ["paternity", "parental"],
    "overtime": ["overtime"],
    "late": ["late", "shift"],
    "attendance": ["attendance", "check"],
    "timesheet": ["timesheet", "hours"],
    "insurance": ["insurance", "medical", "benefit"],
    "benefits": ["benefit", "insurance"],
    "probation": ["probation"],
    "notice": ["notice"],
    "carry": ["carry"],
    "encash": ["encash", "encashment"],
    "password": ["password", "security"],
    "harassment": ["harassment", "conduct", "posh"],
}


@dataclass(frozen=True)
class PolicyHit:
    policy_id: str
    title: str
    version: str
    effective: str
    heading: str
    rules: tuple[str, ...]
    score: float

    @property
    def ref(self) -> str:
        return f"{self.policy_id}#{_slug(self.heading)}"

    def as_text(self) -> str:
        lines = "\n".join(f"- {r}" for r in self.rules)
        return f"[{self.title} v{self.version}, effective {self.effective}] {self.heading}\n{lines}"


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


@lru_cache
def load_policies() -> list[dict[str, Any]]:
    if not POLICIES_FILE.exists():
        return []
    return json.loads(POLICIES_FILE.read_text(encoding="utf-8"))


def _is_contractor(employment_type: str | None) -> bool:
    return "contract" in (employment_type or "").lower()


def applies_to(policy: dict[str, Any], *, country: str | None, role: str, employment_type: str | None,
               legal_entity: str | None) -> bool:
    """Same rule as policyAppliesTo in src/data/policyLibrary.ts."""
    if policy.get("countries") and country not in policy["countries"]:
        return False
    if policy.get("legal_entities") and legal_entity not in policy["legal_entities"]:
        return False
    if policy.get("roles") and role not in policy["roles"]:
        return False
    if policy.get("employment") == "contractors" and not _is_contractor(employment_type):
        return False
    if policy.get("employment") == "employees" and _is_contractor(employment_type):
        return False
    return True


def disabled_policy_ids(db: Session) -> set[str]:
    row = db.get(AiSetting, "default")
    return set(row.disabled_policies or []) if row else set()


def _terms(question: str) -> list[str]:
    words = [w for w in re.findall(r"[a-z0-9]+", question.lower()) if len(w) > 1 and w not in _STOP]
    out: list[str] = []
    for w in words:
        for t in [w, *_SYNONYMS.get(w, [])]:
            if t not in out:
                out.append(t)
    return out


def _stem(word: str) -> str:
    return word[:-1] if len(word) > 4 and word.endswith("s") else word


def search(
    db: Session,
    question: str,
    *,
    country: str | None,
    role: str,
    employment_type: str | None = None,
    legal_entity: str | None = None,
    limit: int = 3,
) -> list[PolicyHit]:
    """Top `limit` policy sections for the question, among policies that apply to this person."""
    terms = _terms(question)
    if not terms:
        return []
    off = disabled_policy_ids(db)
    hits: list[PolicyHit] = []
    for policy in load_policies():
        if policy["id"] in off:
            continue
        if not applies_to(policy, country=country, role=role, employment_type=employment_type, legal_entity=legal_entity):
            continue
        title_text = f"{policy['title']} {policy.get('category', '')}".lower()
        for section in policy.get("sections", []):
            body = " ".join(section.get("rules", [])).lower()
            heading = section.get("heading", "").lower()
            score = 0.0
            for t in terms:
                stem = _stem(t)
                if stem in title_text:
                    score += 2.0
                if stem in heading:
                    score += 1.5
                score += min(body.count(stem), 3) * 1.0
            if score > 0:
                hits.append(PolicyHit(
                    policy_id=policy["id"], title=policy["title"], version=policy.get("version", ""),
                    effective=policy.get("effective", ""), heading=section.get("heading", ""),
                    rules=tuple(section.get("rules", [])), score=score,
                ))
    hits.sort(key=lambda h: h.score, reverse=True)
    return [h for h in hits if h.score >= 2.0][:limit]
