import { useCallback } from "react";
import { API_ENABLED, api, hasTokens } from "../../api/client.ts";
import { appendAuditEntries } from "../../data/auditTrail.ts";
import { answerCopilot, type CopilotAnswer, type CopilotContext, type CopilotSource } from "../../data/platformData.ts";
import { usePortal } from "../../store.tsx";
import { summaryTarget } from "./answers.ts";
import { logCopilotAction } from "./assist.ts";
import { useCopilotContext } from "./copilotContext.ts";
import { policyHref } from "./policyAnswers.ts";

/** Records one Copilot question in the audit trail: who asked, what, which sources, and whether access was denied. */
export function logCopilotQuestion(question: string, answer: CopilotAnswer, asker: { id: string; name: string }): void {
  const q = question.trim();
  const trimmed = q.length > 80 ? `${q.slice(0, 79)}…` : q;
  const sources = answer.sources?.length ? answer.sources.map((s) => `${s.title} v${s.version} · ${s.section}`).join("; ") : "None";
  appendAuditEntries([
    {
      at: new Date().toISOString(),
      actorId: asker.id,
      actorName: asker.name,
      entity: "Copilot question",
      entityId: `cq-${Date.now().toString(36)}`,
      subjectId: asker.id,
      action: "Created",
      changes: [
        { field: "question", before: "—", after: trimmed },
        { field: "sources", before: "—", after: sources },
        { field: "access denied", before: "—", after: answer.denied ? "Yes" : "No" },
      ],
    },
  ]);
}

/** Ask Copilot as the signed-in person: answers from fresh context and logs the question (built-in rules only). */
export function useAskCopilot(): (question: string) => CopilotAnswer {
  const { employee } = usePortal();
  const buildContext = useCopilotContext();
  return useCallback(
    (question: string) => {
      const answer = answerCopilot(question, buildContext());
      const asker = { id: employee.id, name: employee.fullName };
      logCopilotQuestion(question, answer, asker);
      if (answer.action || answer.letterDraft) logCopilotAction("Proposed", asker, { action: answer.action, letter: answer.letterDraft });
      return answer;
    },
    [buildContext, employee.id, employee.fullName],
  );
}

/* ───────── AI answers (backend POST /ai/ask, OpenRouter) ───────── */

/** Longest wait for the AI before the built-in answer is shown. */
const AI_WAIT_MS = 15000;

/** Where an answer came from: the AI model ("AI") or the portal's own rules ("Built-in"). */
export type CopilotOrigin = "ai" | "builtin";

export interface CopilotReply {
  answer: CopilotAnswer;
  origin: CopilotOrigin;
  model?: string;
}

export interface CopilotHistoryTurn {
  role: "user" | "assistant";
  content: string;
}

interface AiSourceOut {
  title: string;
  ref: string;
  kind: "policy" | "data";
  version?: string | null;
  effective?: string | null;
  section?: string | null;
}

interface AiAnswerOut {
  answer: string | null;
  sources: AiSourceOut[];
  used_ai: boolean;
  model: string | null;
  denied: boolean;
}

/** How many earlier turns go with a question. */
const HISTORY_TURNS = 6;

/**
 * Answers that stay on the built-in rules even when AI is on: prepared actions (leave, address, mobile),
 * letter drafts, analytics tables/charts, person summaries, and anything the rules already refused.
 */
function keepBuiltIn(question: string, ctx: CopilotContext, builtIn: CopilotAnswer): boolean {
  if (builtIn.denied || builtIn.action || builtIn.letterDraft || builtIn.chart) return true;
  if (summaryTarget(question)) return true;
  return Boolean(ctx.assist?.(question));
}

const COPILOT_PAGE_ALIASES: Record<string, string> = { "/performance": "/evaluations", "/learning": "/programs" };

function fromAi(out: AiAnswerOut): CopilotAnswer {
  const sources: CopilotSource[] = [];
  const links: { label: string; to: string }[] = [];
  for (const s of out.sources) {
    if (s.kind === "policy") {
      const [policyId] = s.ref.split("#");
      const section = s.section ?? "";
      sources.push({ title: s.title, version: s.version ?? "", effective: s.effective ?? "", section, to: policyHref(policyId, section) });
    } else if (s.ref.startsWith("/")) {
      // Older servers sent API-style paths; send them to the app's pages (unknown paths would land on Home).
      const to = COPILOT_PAGE_ALIASES[s.ref] ?? s.ref;
      if (!links.some((l) => l.to === to)) links.push({ label: s.title, to });
    }
  }
  return {
    kind: "text",
    summary: out.answer ?? "",
    denied: out.denied || undefined,
    sources: sources.length ? sources : undefined,
    links: links.length ? links : undefined,
  };
}

/**
 * Ask Copilot, using the AI model when the backend is on and the person is signed in to it. Falls back to the
 * built-in answer (exactly as useAskCopilot) when AI is off, every model failed, or the request errored.
 * The backend audits the questions it receives; questions it never saw are audited here as before.
 */
export function useAskCopilotAi(): (question: string, history?: CopilotHistoryTurn[]) => Promise<CopilotReply> {
  const { employee } = usePortal();
  const buildContext = useCopilotContext();
  return useCallback(
    async (question: string, history: CopilotHistoryTurn[] = []) => {
      const ctx = buildContext();
      const builtIn = answerCopilot(question, ctx);
      const asker = { id: employee.id, name: employee.fullName };
      const builtInReply = (audited: boolean): CopilotReply => {
        if (!audited) logCopilotQuestion(question, builtIn, asker);
        if (builtIn.action || builtIn.letterDraft) logCopilotAction("Proposed", asker, { action: builtIn.action, letter: builtIn.letterDraft });
        return { answer: builtIn, origin: "builtin" };
      };
      if (!API_ENABLED || !hasTokens() || keepBuiltIn(question, ctx, builtIn)) return builtInReply(false);
      try {
        const request = api.post<AiAnswerOut>("/ai/ask", {
          question: question.trim().slice(0, 1000),
          history: history
            .filter((t) => t.content.trim())
            .slice(-HISTORY_TURNS)
            .map((t) => ({ role: t.role, content: t.content.slice(0, 1000) })),
        });
        // A busy free model can take long; after a short wait show the built-in answer instead.
        const out = await Promise.race([
          request,
          new Promise<null>((resolve) => window.setTimeout(() => resolve(null), AI_WAIT_MS)),
        ]);
        if (!out) return builtInReply(false);
        if (out.answer && (out.used_ai || out.denied)) {
          return { answer: fromAi(out), origin: out.used_ai ? "ai" : "builtin", model: out.model ?? undefined };
        }
        return builtInReply(true); // the backend already audited this question
      } catch {
        return builtInReply(false);
      }
    },
    [buildContext, employee.id, employee.fullName],
  );
}
