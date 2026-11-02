"""HR Copilot (POST /ai/ask, GET /ai/status)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class CopilotTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=4000)


class CopilotAskIn(BaseModel):
    question: str = Field(min_length=1, max_length=1000)
    history: list[CopilotTurn] = Field(default_factory=list, max_length=20)  # only the last 6 turns are used
    # An assistant from AI Agents (app/services/ai_agents.py): same permissions, its own focus.
    agent: str | None = Field(default=None, max_length=32, pattern=r"^[a-z_]+$")


class CopilotSourceOut(BaseModel):
    title: str
    ref: str  # policy: "<policy id>#<section slug>"; data: the portal page, e.g. "/leave"
    kind: Literal["policy", "data"] = "data"
    version: str | None = None
    effective: str | None = None
    section: str | None = None


class CopilotAnswerOut(BaseModel):
    answer: str | None  # None = use the portal's built-in answer
    sources: list[CopilotSourceOut]
    used_ai: bool
    model: str | None
    denied: bool


class CopilotStatusOut(BaseModel):
    enabled: bool
    model: str | None


class AgentStatusOut(BaseModel):
    id: str
    name: str
    available: bool  # for this person's role and switched on by the admin
    mode: Literal["ai", "builtin"]  # "builtin": AI is unavailable, the portal's rule-based answers are used
