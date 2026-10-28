import { useMemo, useState } from "react";
import { Banner } from "../../components/ui.tsx";
import type { JobProfile } from "../../data/peopleData.ts";
import { saveJobProfileAsync, type OrgActor } from "../../data/orgStructureLocal.ts";
import { draftJobDescription, formatJobDraft, similarRoles, type JobDraftInput } from "./jobDescription.ts";
import { DraftTag } from "./DraftTag.tsx";
import "./ai.css";

/**
 * Drafts a job description for a profile or position. The text stays editable and is only
 * saved to the job profile when someone presses Save.
 */
export function JobDescriptionWriter({
  input,
  profile,
  profiles,
  actor,
  canSave,
  onUseText,
  autoStart = false,
}: {
  input: JobDraftInput;
  /** The job profile the text saves to; without one, Save is hidden. */
  profile?: JobProfile | null;
  profiles: JobProfile[];
  actor: OrgActor;
  canSave: boolean;
  /** When set (e.g. inside the profile form), offers "Use in form" instead of saving directly. */
  onUseText?: (text: string) => void;
  /** Draft straight away (the writer was opened with a "Draft description" button). */
  autoStart?: boolean;
}) {
  const [variant, setVariant] = useState(0);
  const [text, setText] = useState(() => (autoStart && input.title.trim() ? formatJobDraft(input.title, draftJobDescription(input, 0)) : ""));
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const draft = useMemo(() => draftJobDescription(input, variant), [input, variant]);
  const similar = useMemo(
    () => similarRoles({ id: profile?.id, title: input.title, familyName: input.familyName, gradeBand: input.gradeBand }, profiles),
    [profile?.id, input.title, input.familyName, input.gradeBand, profiles],
  );
  const suggested = [...draft.required, ...draft.preferred];

  function generate() {
    const next = text ? variant + 1 : variant;
    setVariant(next);
    setText(formatJobDraft(input.title, draftJobDescription(input, next)));
    setMessage(null);
  }

  function addSkill(skill: string) {
    if (!text) return;
    if (text.toLowerCase().includes(`- ${skill.toLowerCase()}`)) return;
    const marker = "Required skills\n";
    const at = text.indexOf(marker);
    setText(at < 0 ? `${text}\n- ${skill}` : `${text.slice(0, at + marker.length)}- ${skill}\n${text.slice(at + marker.length)}`);
  }

  async function save() {
    if (!profile || saving) return;
    setSaving(true);
    const result = await saveJobProfileAsync(actor, profile.id, {
      title: profile.title,
      familyName: profile.familyName,
      gradeBand: profile.gradeBand,
      description: text,
    });
    setSaving(false);
    setMessage(result ? { tone: "err", text: result } : { tone: "ok", text: `Saved to ${profile.title}.` });
  }

  return (
    <div className="ai-jd stack">
      <div className="ai-head">
        <strong>Job description · {input.title || "Untitled"}</strong>
        <DraftTag />
      </div>
      <Banner message={message} />
      <div className="ai-row">
        <button type="button" className="btn btn-tiny" disabled={!input.title.trim()} onClick={generate}>
          {text ? "Redraft" : "Draft description"}
        </button>
        {text && onUseText && (
          <button type="button" className="btn-ghost btn-tiny" onClick={() => onUseText(text)}>
            Use in form
          </button>
        )}
        {text && !onUseText && canSave && profile && (
          <button type="button" className="btn-ghost btn-tiny" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save to job profile"}
          </button>
        )}
        {text && !onUseText && !profile && <span className="muted">Link a job profile to save this.</span>}
      </div>
      {text && (
        <textarea aria-label="Job description draft" value={text} maxLength={4000} onChange={(e) => setText(e.target.value)} />
      )}
      <div>
        <span className="muted">Suggested skills{text ? " · click to add" : ""}</span>
        <div className="ai-chips">
          {suggested.map((s) =>
            text ? (
              <button key={s} type="button" className="ai-chip" onClick={() => addSkill(s)}>
                + {s}
              </button>
            ) : (
              <span key={s} className="ai-chip">{s}</span>
            ),
          )}
        </div>
      </div>
      <div>
        <span className="muted">Similar roles</span>
        {similar.length === 0 ? (
          <p className="muted">None found.</p>
        ) : (
          <ul className="todo">
            {similar.map((p) => (
              <li key={p.id}>
                {p.title} · {p.familyName} · {p.gradeBand}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
