import { useCallback } from "react";
import { appendAuditEntries } from "../../data/auditTrail.ts";
import { answerCopilot, type CopilotAnswer } from "../../data/platformData.ts";
import { usePortal } from "../../store.tsx";
import { logCopilotAction } from "./assist.ts";
import { useCopilotContext } from "./copilotContext.ts";

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

/** Ask Copilot as the signed-in person: answers from fresh context and logs the question. */
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
