import { useState, type ReactNode } from "react";
import { ActionButton, Field } from "../../components/ui.tsx";
import { formatShortDate } from "../../model.ts";
import type { StepView } from "./rules.ts";
import "./payrequests.css";

export type StageState = "done" | "current" | "todo" | "declined" | "skipped";
export interface Stage {
  label: string;
  state: StageState;
  detail?: string;
}

/** A row of stages: done (tick), current (ring), declined (cross), still to come. */
export function Tracker({ stages, label = "Progress" }: { stages: Stage[]; label?: string }) {
  return (
    <ol className="pr-tracker" aria-label={label}>
      {stages.map((s, i) => (
        <li key={`${s.label}-${i}`} className={s.state} aria-current={s.state === "current" ? "step" : undefined}>
          <span className="pr-dot-row">
            <span className="pr-dot" aria-hidden="true">
              {s.state === "done" ? "✓" : s.state === "declined" ? "✕" : i + 1}
            </span>
            <span className="pr-bar" aria-hidden="true" />
          </span>
          <strong>{s.label}</strong>
          {s.detail && <small>{s.detail}</small>}
        </li>
      ))}
    </ol>
  );
}

const dated = (iso?: string) => (iso ? formatShortDate(iso) : "");

/** Submitted → each approval step → the closing stages (`after`, e.g. Paid) once approved. */
export function approvalStages(input: {
  submittedOn: string;
  steps: StepView[];
  closed?: "withdrawn" | "rejected" | null;
  after?: Stage[];
}): Stage[] {
  const stages: Stage[] = [{ label: "Submitted", state: "done", detail: dated(input.submittedOn) }];
  let waitingShown = false;
  for (const step of input.steps) {
    if (step.decision === "approve") stages.push({ label: step.label, state: "done", detail: [step.by, dated(step.on)].filter(Boolean).join(" · ") });
    else if (step.decision === "reject")
      stages.push({ label: step.label, state: "declined", detail: [step.by, step.note ? `“${step.note}”` : ""].filter(Boolean).join(" · ") });
    else if (input.closed) stages.push({ label: step.label, state: "skipped" });
    else {
      stages.push({
        label: step.label,
        state: waitingShown ? "todo" : "current",
        detail: waitingShown ? undefined : `Waiting${step.approverNames.length ? ` · ${step.approverNames.slice(0, 2).join(", ")}` : ""}`,
      });
      waitingShown = true;
    }
  }
  if (input.closed === "withdrawn") stages.push({ label: "Withdrawn", state: "declined" });
  else if (input.closed !== "rejected") stages.push(...(input.after ?? []));
  return stages;
}

/** Approve / decline with an optional note (needed to decline). */
export function DecideBar({
  onDecide,
  approveLabel = "Approve",
  extra,
}: {
  onDecide: (decision: "approve" | "reject", note: string) => Promise<string | null>;
  approveLabel?: string;
  extra?: ReactNode;
}) {
  const [note, setNote] = useState("");
  return (
    <div className="pr-form">
      {extra}
      <Field label="Note">
        <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Needed to decline" />
      </Field>
      <div className="pr-actions">
        <ActionButton
          className="btn"
          toastError
          busyLabel="Saving…"
          doneLabel="Done"
          success="Approved."
          onAction={async () => {
            const error = await onDecide("approve", note);
            if (!error) setNote("");
            return error ?? true;
          }}
        >
          {approveLabel}
        </ActionButton>
        <ActionButton
          className="btn-ghost"
          toastError
          busyLabel="Saving…"
          doneLabel="Declined"
          success="Declined."
          onAction={async () => {
            if (!note.trim()) return "Add a note saying why.";
            const error = await onDecide("reject", note);
            if (!error) setNote("");
            return error ?? true;
          }}
        >
          Decline
        </ActionButton>
      </div>
    </div>
  );
}

/** Small wizard header: numbered steps, clickable once reached. */
export function WizardSteps({ steps, current, reached, onGo }: { steps: string[]; current: number; reached: number; onGo: (i: number) => void }) {
  return (
    <div className="pr-wizard-steps" role="list">
      {steps.map((s, i) => (
        <button
          key={s}
          type="button"
          role="listitem"
          aria-current={i === current ? "step" : undefined}
          className={i < current ? "done" : undefined}
          disabled={i > reached}
          onClick={() => onGo(i)}
        >
          {i + 1}. {s}
        </button>
      ))}
    </div>
  );
}
