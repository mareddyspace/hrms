import { Link } from "react-router-dom";
import type { CopilotSource } from "../../data/platformData.ts";
import type { CopilotOrigin } from "./askCopilot.ts";

/** "Sources" list under a Copilot answer: policy, version, effective date and section, each linking to the policy. */
export function CopilotSources({ sources, onNavigate }: { sources?: CopilotSource[]; onNavigate?: () => void }) {
  if (!sources?.length) return null;
  return (
    <div className="copilot-sources">
      <p className="copilot-role">Sources</p>
      <ul className="stack-tight">
        {sources.map((s) => (
          <li key={s.to}>
            <Link to={s.to} onClick={onNavigate}>
              {s.title}
            </Link>{" "}
            <span className="note">
              · v{s.version} · effective {s.effective} · {s.section}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Tiny tag on each answer: "AI" (answered by the AI model from your permitted data) or "Built-in" (portal rules). */
export function CopilotOriginTag({ origin, model }: { origin?: CopilotOrigin; model?: string }) {
  if (!origin) return null;
  const ai = origin === "ai";
  return (
    <span
      className={`pill ${ai ? "pill-open" : ""}`}
      style={{ fontSize: 10, padding: "0 5px", marginLeft: 6, verticalAlign: "middle" }}
      title={ai ? `Answered by AI${model ? ` (${model})` : ""} from data you're allowed to see` : "Answered by the portal's built-in rules"}
    >
      {ai ? "AI" : "Built-in"}
    </span>
  );
}

/** "Thinking…" placeholder while the AI answer is on its way. */
export function CopilotThinking() {
  return (
    <p className="note" aria-busy="true">
      Thinking…
    </p>
  );
}
