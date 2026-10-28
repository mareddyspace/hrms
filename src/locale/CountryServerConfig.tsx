import { useEffect, useState } from "react";
import { API_ENABLED } from "../api/client.ts";
import { countryConfigApi, type CountryConfig } from "../api/syncLeaveAdmin.ts";
import { Banner, Card, Field } from "../components/ui.tsx";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const LANGS = [
  { id: "en", label: "English" },
  { id: "hi", label: "Hindi" },
  { id: "de", label: "German" },
  { id: "ar", label: "Arabic" },
];

/** Backend mode: the server's country config list (null while loading or with the backend off). */
export function useServerCountries(): [CountryConfig[] | null, (next: CountryConfig) => void] {
  const [rows, setRows] = useState<CountryConfig[] | null>(null);
  useEffect(() => {
    if (!API_ENABLED) return;
    let live = true;
    countryConfigApi
      .list()
      .then((r) => live && setRows(r))
      .catch(() => live && setRows([]));
    return () => {
      live = false;
    };
  }, []);
  const replace = (next: CountryConfig) => setRows((r) => (r ?? []).map((c) => (c.code === next.code ? next : c)));
  return [rows, replace];
}

type Msg = { tone: "ok" | "err" | "warn" | "info"; text: string } | null;

/** Country rules stored on the server. Admins can edit; HR can view. */
export function CountryServerConfigCard({ config, canEdit, onSaved }: { config: CountryConfig; canEdit: boolean; onSaved: (c: CountryConfig) => void }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(() => toForm(config));
  const [msg, setMsg] = useState<Msg>(null);

  useEffect(() => {
    setForm(toForm(config));
    setEditing(false);
    setMsg(null);
  }, [config]);

  const set = <K extends keyof ReturnType<typeof toForm>>(k: K, v: ReturnType<typeof toForm>[K]) => setForm((f) => ({ ...f, [k]: v }));
  const toggle = (list: string[], item: string, on: boolean) => (on ? [...list, item] : list.filter((x) => x !== item));

  const save = async () => {
    if (!form.days.length) return setMsg({ tone: "err", text: "Pick at least one work day." });
    try {
      const out = await countryConfigApi.update(config.code, {
        languages: form.languages.length ? form.languages : ["en"],
        work_week_days: form.days,
        standard_daily_hours: form.hours === "" ? null : Number(form.hours),
        probation_months: form.probation === "" ? null : Number(form.probation),
        notice_days: form.notice === "" ? null : Number(form.notice),
        required_documents: form.documents.split("\n").map((d) => d.trim()).filter(Boolean),
        workflow_notes: form.notes,
      });
      onSaved(out);
      setMsg({ tone: "ok", text: "Saved." });
    } catch (e) {
      setMsg({ tone: "err", text: e instanceof Error ? e.message : "Could not save." });
    }
  };

  return (
    <Card
      title="Country rules"
      action={
        canEdit && !editing ? (
          <button className="btn-ghost btn-tiny" type="button" onClick={() => setEditing(true)}>Edit</button>
        ) : undefined
      }
    >
      <Banner message={msg} />
      {!editing ? (
        <dl className="info-grid">
          <div className="info-fact"><dt>Languages</dt><dd>{(config.languages ?? []).join(", ") || "—"}</dd></div>
          <div className="info-fact"><dt>Work week</dt><dd>{(config.work_week_days ?? []).join(", ") || "—"}</dd></div>
          <div className="info-fact"><dt>Hours a day</dt><dd>{config.standard_daily_hours ?? "—"}</dd></div>
          <div className="info-fact"><dt>Probation</dt><dd>{config.probation_months != null ? `${config.probation_months} months` : "—"}</dd></div>
          <div className="info-fact"><dt>Notice</dt><dd>{config.notice_days != null ? `${config.notice_days} days` : "—"}</dd></div>
          <div className="info-fact"><dt>Required documents</dt><dd>{(config.required_documents ?? []).join(", ") || "—"}</dd></div>
          <div className="info-fact"><dt>Workflow notes</dt><dd>{config.workflow_notes || "—"}</dd></div>
        </dl>
      ) : (
        <>
          <p className="note">Languages</p>
          <div className="form-grid-2">
            {LANGS.map((l) => (
              <label key={l.id} className="perm-item">
                <input type="checkbox" checked={form.languages.includes(l.id)} onChange={(e) => set("languages", toggle(form.languages, l.id, e.target.checked))} />
                <span>{l.label}</span>
              </label>
            ))}
          </div>
          <p className="note">Work days</p>
          <div className="form-grid-2">
            {DAYS.map((d) => (
              <label key={d} className="perm-item">
                <input type="checkbox" checked={form.days.includes(d)} onChange={(e) => set("days", DAYS.filter((x) => (x === d ? e.target.checked : form.days.includes(x))))} />
                <span>{d}</span>
              </label>
            ))}
          </div>
          <div className="form-grid-2">
            <Field label="Hours a day"><input type="number" min={1} max={24} step={0.1} value={form.hours} onChange={(e) => set("hours", e.target.value)} /></Field>
            <Field label="Probation (months)"><input type="number" min={0} max={24} value={form.probation} onChange={(e) => set("probation", e.target.value)} /></Field>
            <Field label="Notice (days)"><input type="number" min={0} max={365} value={form.notice} onChange={(e) => set("notice", e.target.value)} /></Field>
          </div>
          <Field label="Required documents (one per line)" wide>
            <textarea rows={4} value={form.documents} onChange={(e) => set("documents", e.target.value)} />
          </Field>
          <Field label="Workflow notes" wide>
            <textarea rows={3} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
          </Field>
          <div className="row-between" style={{ marginTop: 12 }}>
            <button className="btn-ghost" type="button" onClick={() => setEditing(false)}>Cancel</button>
            <button className="btn" type="button" onClick={save}>Save</button>
          </div>
        </>
      )}
    </Card>
  );
}

function toForm(c: CountryConfig) {
  return {
    languages: c.languages ?? ["en"],
    days: c.work_week_days ?? ["Mon", "Tue", "Wed", "Thu", "Fri"],
    hours: c.standard_daily_hours == null ? "" : String(c.standard_daily_hours),
    probation: c.probation_months == null ? "" : String(c.probation_months),
    notice: c.notice_days == null ? "" : String(c.notice_days),
    documents: (c.required_documents ?? []).join("\n"),
    notes: c.workflow_notes ?? "",
  };
}
