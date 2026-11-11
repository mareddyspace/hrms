import type { HistoryEntry } from "../../api/syncExperience.ts";
import { formatStamp } from "../compliance/shared.ts";
import "../../styles/experience.css";

/** Status timeline of a request or record (oldest first): what happened, who did it, when, and any note. */
export function HistoryTimeline({ entries, compact = false }: { entries: HistoryEntry[]; compact?: boolean }) {
  if (!entries.length) return null;
  const shown = compact && entries.length > 3 ? entries.slice(-3) : entries;
  return (
    <ol className={compact ? "xp-timeline compact" : "xp-timeline"} aria-label="History">
      {compact && entries.length > shown.length && <li className="xp-timeline-more">{entries.length - shown.length} earlier steps</li>}
      {shown.map((h, i) => (
        <li key={`${h.at}-${i}`} className={i === shown.length - 1 ? "current" : undefined}>
          <span className="xp-dot" aria-hidden />
          <div>
            <strong>{h.action}</strong>
            <span className="muted"> · {h.by_name} · {formatStamp(h.at)}</span>
            {h.note && <p className="xp-note">{h.note}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Step tracker for a request's workflow: done steps, the current one, and what is still ahead. */
export function StepTrail({ steps, current, failed = false }: { steps: string[]; current: number; failed?: boolean }) {
  return (
    <ol className="xp-steps" aria-label="Progress">
      {steps.map((label, i) => {
        const state = i < current ? "done" : i === current ? (failed ? "failed" : "now") : "todo";
        return (
          <li key={label} className={`xp-step ${state}`}>
            <span className="xp-step-dot" aria-hidden>
              {state === "done" ? "✓" : state === "failed" ? "✕" : i + 1}
            </span>
            {label}
          </li>
        );
      })}
    </ol>
  );
}
