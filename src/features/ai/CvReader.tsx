import { useState } from "react";
import { Field } from "../../components/ui.tsx";
import { API_ENABLED } from "../../api/client.ts";
import { apiParseCv } from "../../api/syncTalent.ts";
import { readCv, type CvFields } from "./cvReader.ts";
import { DraftTag } from "./DraftTag.tsx";
import "./ai.css";

/**
 * Paste or load a CV, check what was read, then hand the confirmed fields to the form.
 * Backend mode: the server reads the text, and the chosen file is handed over too so it can be stored with the candidate.
 */
export function CvReader({ onApply, onClose }: { onApply: (fields: CvFields, file?: File) => void; onClose: () => void }) {
  const [text, setText] = useState("");
  const [fileNote, setFileNote] = useState("");
  const [fields, setFields] = useState<CvFields | null>(null);
  const [file, setFile] = useState<File | undefined>(undefined);
  const [reading, setReading] = useState(false);
  const set = (patch: Partial<CvFields>) => setFields((f) => (f ? { ...f, ...patch } : f));

  function read() {
    if (!API_ENABLED) {
      setFields(readCv(text));
      return;
    }
    setReading(true);
    setFileNote("");
    apiParseCv(text)
      .then(setFields)
      .catch((error: unknown) => setFileNote(error instanceof Error ? error.message : "The CV could not be read. Try again."))
      .finally(() => setReading(false));
  }

  function loadFile(file: File | undefined) {
    setFileNote("");
    setFile(undefined);
    if (!file) return;
    if (API_ENABLED && file.size <= 5 * 1024 * 1024 && /\.(pdf|docx?|txt)$/i.test(file.name)) setFile(file);
    if (file.size > 1_000_000) {
      setFileNote(`${file.name} is too large${API_ENABLED && file.size <= 5 * 1024 * 1024 ? " to read here, but it will be saved with the candidate" : ""}. Paste the text instead.`);
      return;
    }
    if (/\.txt$/i.test(file.name) || file.type === "text/plain") {
      const reader = new FileReader();
      reader.onload = () => {
        setText(String(reader.result ?? ""));
        setFileNote(`Loaded ${file.name}.`);
      };
      reader.readAsText(file);
    } else {
      setFileNote(
        `${file.name} attached${API_ENABLED ? " and will be saved with the candidate" : ""}. PDF and Word files can't be read here — open it and paste the text below.`,
      );
    }
  }

  return (
    <div className="ai-box ai-cv">
      <div className="ai-head">
        <strong>Read a CV</strong>
        <DraftTag text="Suggestions — confirm each field" />
      </div>
      {!fields ? (
        <>
          <Field label="CV file (.txt, or .pdf with pasted text)">
            <input type="file" accept=".txt,.pdf,.doc,.docx,text/plain,application/pdf" onChange={(e) => loadFile(e.target.files?.[0])} />
          </Field>
          {fileNote && <p className="ai-note">{fileNote}</p>}
          <Field label="CV text" wide>
            <textarea value={text} maxLength={20000} onChange={(e) => setText(e.target.value)} placeholder="Paste the CV text here" />
          </Field>
          <div className="row-gap">
            <button type="button" className="btn btn-tiny" disabled={text.trim().length < 20 || reading} onClick={read}>
              {reading ? "Reading…" : "Read CV"}
            </button>
            <button type="button" className="btn-ghost btn-tiny" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="ai-fields">
            <Field label="Name">
              <input value={fields.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label="Email">
              <input value={fields.email} maxLength={120} onChange={(e) => set({ email: e.target.value })} />
            </Field>
            <Field label="Phone">
              <input value={fields.phone} maxLength={30} onChange={(e) => set({ phone: e.target.value })} />
            </Field>
            <Field label="Years of experience">
              <input
                type="number"
                min={0}
                max={50}
                value={fields.experienceYears ?? ""}
                onChange={(e) => set({ experienceYears: e.target.value === "" ? null : Math.max(0, Math.min(50, Number(e.target.value))) })}
              />
            </Field>
            <Field label="Current title">
              <input value={fields.currentTitle} maxLength={80} onChange={(e) => set({ currentTitle: e.target.value })} />
            </Field>
            <Field label="Current company">
              <input value={fields.currentCompany} maxLength={80} onChange={(e) => set({ currentCompany: e.target.value })} />
            </Field>
            <Field label="Education (one per line)" wide>
              <textarea
                value={fields.education.join("\n")}
                rows={2}
                onChange={(e) => set({ education: e.target.value.split("\n") })}
              />
            </Field>
          </div>
          <div>
            <span className="muted">Skills from our library</span>
            <div className="ai-chips">
              {fields.librarySkills.length === 0 && <span className="muted">None found</span>}
              {fields.librarySkills.map((s) => (
                <button key={s} type="button" className="ai-chip is-ok" title="Remove" onClick={() => set({ librarySkills: fields.librarySkills.filter((x) => x !== s) })}>
                  {s} ×
                </button>
              ))}
            </div>
            {fields.otherSkills.length > 0 && (
              <>
                <span className="muted">Other skills</span>
                <div className="ai-chips">
                  {fields.otherSkills.map((s) => (
                    <button key={s} type="button" className="ai-chip" title="Remove" onClick={() => set({ otherSkills: fields.otherSkills.filter((x) => x !== s) })}>
                      {s} ×
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <div className="row-gap">
            <button
              type="button"
              className="btn btn-tiny"
              onClick={() => onApply({ ...fields, education: fields.education.map((x) => x.trim()).filter(Boolean) }, file)}
            >
              Use these details
            </button>
            <button type="button" className="btn-ghost btn-tiny" onClick={() => setFields(null)}>
              Back to text
            </button>
            <button type="button" className="btn-ghost btn-tiny" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
