import { Link } from "react-router-dom";
import type { CopilotSource } from "../../data/platformData.ts";

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
