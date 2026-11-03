"""Copilot assistants ("AI Agents"): each one is the same permission-filtered Copilot with its own focus.

An assistant never widens what the Copilot may read: the context is still built for the signed-in person only
(app/services/ai_context.py). The assistant adds a focus line to the system prompt, and some assistants are only
for some roles (same lists as src/data/platformData.ts AI_AGENTS / AGENT_ROLES). Admins switch assistants off in
AI settings (AiSetting.disabled_agents).
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.models import AiSetting
from app.services.scope import HR_ACCESS_ROLES, HR_ROLES


@dataclass(frozen=True)
class Agent:
    id: str
    name: str
    focus: str
    roles: frozenset[str] | None = None  # None: everyone


AGENTS: dict[str, Agent] = {a.id: a for a in [
    Agent("employee", "Leave & self-service assistant",
          "leave balances, applying for leave, holidays, attendance, timesheets, payslips and other self-service tasks"),
    Agent("knowledge", "Policy assistant",
          "company policies: quote the policy name and section, and say when a policy does not apply to the person"),
    Agent("career", "Career coach",
          "the person's own skills, skill gaps for their target or next role, goals, courses that close the gaps and "
          "career interests; suggest concrete next steps (courses to enrol in, skills to practise)"),
    Agent("document", "Letter & document assistant",
          "letters and documents: which letter to request, what details it needs, and where to track it. Never create "
          "a letter yourself; the person confirms a prepared draft in the portal"),
    Agent("manager", "Manager assistant",
          "the manager's team: who is away, approvals waiting on them, team attendance and goals",
          frozenset({"manager", "executive"})),
    Agent("hr", "HR assistant", "HR operations: workforce numbers, policy acknowledgements and movements", HR_ROLES),
    Agent("recruiter", "Recruiting assistant", "hiring: open roles, pipeline stages and joiners",
          frozenset({"recruiter"}) | HR_ROLES),
    Agent("analytics", "Analytics assistant", "workforce numbers: headcount, joiners, exits and attrition",
          frozenset({"manager", "executive"}) | HR_ACCESS_ROLES),
]}


def disabled_agents(db: Session) -> set[str]:
    row = db.get(AiSetting, "default")
    return set(row.disabled_agents or []) if row else set()


def allowed(agent: Agent, role: str) -> bool:
    return agent.roles is None or role in agent.roles


def resolve(db: Session, agent_id: str | None, role: str) -> tuple[Agent | None, str | None]:
    """(agent, error). error: "not_found" (unknown id), "forbidden" (not for this role) or "off" (switched off)."""
    if not agent_id:
        return None, None
    agent = AGENTS.get(agent_id)
    if agent is None:
        return None, "not_found"
    if not allowed(agent, role):
        return None, "forbidden"
    if agent.id in disabled_agents(db):
        return None, "off"
    return agent, None


def prompt_line(agent: Agent | None) -> str:
    if agent is None:
        return ""
    return (f"\nYou are the {agent.name}. Focus on {agent.focus}. For questions outside that focus, answer briefly "
            "from the context or point to the right portal page. The same rules above still apply.")
