"""HR Copilot: answers from the signed-in person's own permitted data and the policy library (OpenRouter)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from app.deps import CurrentUserDep, DbSession, client_ip
from app.schemas.ai import CopilotAnswerOut, CopilotAskIn, CopilotSourceOut, CopilotStatusOut
from app.services import ai_copilot

router = APIRouter(prefix="/ai", tags=["ai"])


@router.get("/status", response_model=CopilotStatusOut)
def ai_status(user: CurrentUserDep) -> CopilotStatusOut:
    """Whether AI answers are switched on (no secrets)."""
    return CopilotStatusOut(**ai_copilot.status())


@router.post("/ask", response_model=CopilotAnswerOut)
def ask(body: CopilotAskIn, request: Request, db: DbSession, user: CurrentUserDep) -> CopilotAnswerOut:
    """answer=null / used_ai=false means "use the built-in answer" (no key, or every model failed)."""
    if not ai_copilot.allow_question(user.id):
        raise HTTPException(429, "Too many Copilot questions. Try again in a minute.")
    result = ai_copilot.ask(
        db, user, body.question, [t.model_dump() for t in body.history], ip=client_ip(request)
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
