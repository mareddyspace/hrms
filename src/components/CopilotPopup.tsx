import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Bot, Maximize2, X } from "lucide-react";
import { PRODUCT_NAME } from "../brand.ts";
import {
  copilotPersonaFromRole,
  COPILOT_SUGGESTIONS,
  type CopilotAnswer,
} from "../data/platformData.ts";
import { usePortal } from "../store.tsx";
import { useAskCopilot } from "../features/copilot/askCopilot.ts";
import { CopilotSources } from "../features/copilot/CopilotSources.tsx";

type Turn = { id: string; role: "user" | "assistant"; text: string; answer?: CopilotAnswer };

/** Floating AI button + popup chat — shown for every signed-in role. */
export function CopilotPopup() {
  const { employee, demoProfile } = usePortal();
  const askCopilot = useAskCopilot();
  const persona = copilotPersonaFromRole(demoProfile.role);
  const suggestions = COPILOT_SUGGESTIONS[persona].slice(0, 3);
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [history, setHistory] = useState<Turn[]>([]);
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [history, open]);

  function ask(question: string) {
    const q = question.trim();
    if (!q) return;
    const answer = askCopilot(q);
    const stamp = Date.now();
    setHistory((prev) => [
      ...prev,
      { id: `u-${stamp}`, role: "user", text: q },
      {
        id: `a-${stamp}`,
        role: "assistant",
        text: answer.summary?.trim() || "Here is what I found.",
        answer,
      },
    ]);
    setPrompt("");
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    ask(prompt);
  }

  const firstName = employee.fullName.split(" ")[0] || "there";

  return (
    <div className="copilot-fab-root">
      {open && (
        <div className="copilot-fab-panel" role="dialog" aria-label={`${PRODUCT_NAME} Copilot`} aria-modal="false">
          <header className="copilot-fab-head">
            <div className="copilot-fab-title">
              <span className="copilot-fab-mark" aria-hidden>
                <Bot size={18} strokeWidth={1.75} />
              </span>
              <div>
                <strong>{PRODUCT_NAME} Copilot</strong>
                <small>Assistant · {demoProfile.personaLabel}</small>
              </div>
            </div>
            <div className="copilot-fab-actions">
              <Link
                to="/ai/copilot"
                className="copilot-fab-iconbtn"
                title="Open full Copilot"
                aria-label="Open full Copilot"
                onClick={() => setOpen(false)}
              >
                <Maximize2 size={16} strokeWidth={1.75} />
              </Link>
              <button type="button" className="copilot-fab-iconbtn" aria-label="Close Copilot" onClick={() => setOpen(false)}>
                <X size={18} strokeWidth={1.75} />
              </button>
            </div>
          </header>

          <div className="copilot-fab-thread" ref={threadRef} aria-live="polite">
            {history.length === 0 && (
              <p className="note">
                Hi {firstName} — ask about leave, payslips, policies, or your team.
              </p>
            )}
            {history.map((turn) => (
              <div key={turn.id} className={`copilot-bubble ${turn.role}`}>
                <p className="copilot-role">{turn.role === "user" ? "You" : "Copilot"}</p>
                <p>{turn.text}</p>
                {turn.answer?.metrics && turn.answer.metrics.length > 0 && (
                  <dl className="copilot-fab-metrics">
                    {turn.answer.metrics.map((m) => (
                      <div key={m.label} className="copilot-fab-metric">
                        <dt>{m.label}</dt>
                        <dd>{m.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {turn.answer?.table && (
                  <div className="copilot-fab-table-wrap">
                    <table className="copilot-fab-table">
                      <thead>
                        <tr>
                          {turn.answer.table.headers.map((h) => (
                            <th key={h}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {turn.answer.table.rows.map((row, i) => (
                          <tr key={i}>
                            {row.map((cell, j) => (
                              <td key={j}>{cell}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <CopilotSources sources={turn.answer?.sources} onNavigate={() => setOpen(false)} />
                {turn.answer?.links && turn.answer.links.length > 0 && (
                  <p className="chip-row copilot-fab-links">
                    {turn.answer.links.map((l) => (
                      <Link key={l.to} className="auth-shortcut" to={l.to} onClick={() => setOpen(false)}>
                        {l.label}
                      </Link>
                    ))}
                  </p>
                )}
              </div>
            ))}
          </div>

          {history.length === 0 && (
            <div className="copilot-fab-chips">
              {suggestions.map((s) => (
                <button key={s} type="button" className="chip-btn" onClick={() => ask(s)}>
                  {s}
                </button>
              ))}
            </div>
          )}

          <form className="copilot-fab-compose" onSubmit={onSubmit}>
            <textarea aria-label="Ask Copilot"
              ref={inputRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={2}
              placeholder="Ask Copilot…"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  ask(prompt);
                }
              }}
            />
            <button className="btn" type="submit" disabled={!prompt.trim()}>
              Send
            </button>
          </form>
        </div>
      )}

      <button
        type="button"
        className={`copilot-fab-btn${open ? " is-open" : ""}`}
        aria-label={open ? "Close Copilot" : "Open Copilot"}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <X size={22} strokeWidth={2} /> : <Bot size={22} strokeWidth={2} />}
        {!open && <span className="copilot-fab-label">Ask AI</span>}
      </button>
    </div>
  );
}
