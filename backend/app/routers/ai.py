"""HR Copilot: answers from the signed-in person's own permitted data and the policy library (OpenRouter)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from app.deps import CurrentUserDep, DbSession, client_ip
from app.schemas.ai import AgentStatusOut, CopilotAnswerOut, CopilotAskIn, CopilotSourceOut, CopilotStatusOut
from app.services import ai_agents, ai_copilot

router = APIRouter(prefix="/ai", tags=["ai"])


@router.get("/status", response_model=CopilotStatusOut)
def ai_status(user: CurrentUserDep) -> CopilotStatusOut:
    """Whether AI answers are switched on (no secrets)."""
    return CopilotStatusOut(**ai_copilot.status())


@router.post("/ask", response_model=CopilotAnswerOut)
def ask(body: CopilotAskIn, request: Request, db: DbSession, user: CurrentUserDep) -> CopilotAnswerOut:
    """answer=null / used_ai=false means "use the built-in answer" (no key, or every model failed)."""
    agent, problem = ai_agents.resolve(db, body.agent, user.account.role)
    if problem == "not_found":
        raise HTTPException(404, "Assistant not found.")
    if problem == "forbidden":
        raise HTTPException(403, "This assistant isn't available for your role.")
    if problem == "off":
        raise HTTPException(409, "This assistant is switched off in AI settings.")
    if not ai_copilot.allow_question(user.id):
        raise HTTPException(429, "Too many Copilot questions. Try again in a minute.")
    result = ai_copilot.ask(
        db, user, body.question, [t.model_dump() for t in body.history], ip=client_ip(request),
        focus=ai_agents.prompt_line(agent), agent_id=agent.id if agent else None,
    )
    db.commit()
    return CopilotAnswerOut(
        answer=result.answer,
        sources=[
            CopilotSourceOut(title=s.title, ref=s.ref, kind=s.kind, version=s.version, effective=s.effective, section=s.section)
            for s in result.sources
        ],
        used_ai=result.used_ai,
        model=result.model,
        denied=result.denied,
    )


@router.get("/agents", response_model=list[AgentStatusOut])
def agents(db: DbSession, user: CurrentUserDep) -> list[AgentStatusOut]:
    """The assistants this person may open, with their live status (AI answers, or the built-in rules)."""
    off = ai_agents.disabled_agents(db)
    mode = "ai" if ai_copilot.status()["enabled"] else "builtin"
    return [
        AgentStatusOut(id=a.id, name=a.name, available=a.id not in off, mode=mode)  # type: ignore[arg-type]
        for a in ai_agents.AGENTS.values() if ai_agents.allowed(a, user.account.role)
    ]
