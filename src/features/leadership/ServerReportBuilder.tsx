/**
 * Report builder on the server (backend mode): sources, columns and filters come from GET /insights/reports/sources
 * (only what the signed-in user may see — no pay for directors, no personal identifiers outside HR); rows are
 * computed and scoped by the API, CSV export is audited there, and saved reports live in the database.
 */
import { useEffect, useMemo, useState } from "react";
import { Card, DataTable, EmptyState, Field } from "../../components/ui.tsx";
import { downloadBlob } from "../datatools/shared.ts";
import { notify, notifyError } from "../../components/Toast.tsx";
import {
  deleteSavedReport,
  exportServerReport,
  getReportSources,
  listSavedReports,
  runServerReport,
  saveServerReport,
  type FilterValue,
  type ReportDefinition,
  type ReportResult,
  type ReportSource,
  type SavedReportOut,
} from "../../api/syncLeadership.ts";
import "../../styles/leadership.css";

const PREVIEW = 100;

function cell(v: string | number | boolean | null | undefined): string {
  if (v === true) return "Yes";
  if (v === false) return "No";
  return v == null || v === "" ? "—" : String(v);
}

export function ServerReportBuilder() {
  const [sources, setSources] = useState<ReportSource[] | null>(null);
  const [saved, setSaved] = useState<SavedReportOut[]>([]);
  const [def, setDef] = useState<ReportDefinition>({ source: "people", columns: [], filters: {}, group_by: null });
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<ReportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState<SavedReportOut | null>(null);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);

  useEffect(() => {
    getReportSources()
      .then((s) => {
        setSources(s);
        if (s[0]) setDef((d) => ({ ...d, source: s[0].key, columns: s[0].columns.slice(0, 6).map((c) => c.key) }));
      })
      .catch((e: Error) => notifyError(e.message));
    listSavedReports().then(setSaved).catch(() => setSaved([]));
  }, []);

  const source = useMemo(() => sources?.find((s) => s.key === def.source) ?? null, [sources, def.source]);

  function pickSource(key: string) {
    const s = sources?.find((x) => x.key === key);
    setDef({ source: key, columns: s ? s.columns.slice(0, 6).map((c) => c.key) : [], filters: {}, group_by: null });
    setResult(null);
    setLoaded(null);
  }

  function toggleColumn(key: string) {
    setDef((d) => ({ ...d, columns: d.columns.includes(key) ? d.columns.filter((c) => c !== key) : [...d.columns, key] }));
  }

  function setFilter(key: string, value: FilterValue | null) {
    setDef((d) => {
      const filters = { ...d.filters };
      if (value == null || value === "" || (typeof value === "object" && !value.from && !value.to)) delete filters[key];
      else filters[key] = value;
      return { ...d, filters };
    });
  }

  async function run() {
    if (!def.columns.length) return notifyError("Pick at least one column.");
    setBusy(true);
    try {
      setResult(await runServerReport(def, search));
    } catch (e) {
      notifyError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function exportCsv() {
    setBusy(true);
    try {
      const out = await exportServerReport(def, search);
      downloadBlob(out.filename, new Blob(["﻿" + out.content], { type: "text/csv;charset=utf-8" }));
      notify(`Downloaded ${out.filename}.`);
    } catch (e) {
      notifyError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save(asNew: boolean) {
    setBusy(true);
    try {
      const out = await saveServerReport({ ...def, name: name.trim(), shared }, asNew ? undefined : loaded?.id);
      setLoaded(out);
      setSaved(await listSavedReports());
      notify(`Saved "${out.name}".`);
    } catch (e) {
      notifyError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function open(r: SavedReportOut) {
    setDef({ source: r.source, columns: r.columns, filters: r.filters, group_by: r.group_by });
    setLoaded(r.mine ? r : null);
    setName(r.mine ? r.name : `${r.name} (copy)`);
    setShared(r.mine ? r.shared : false);
    setResult(null);
  }

  async function remove(r: SavedReportOut) {
    if (!window.confirm(`Delete the saved report "${r.name}"?`)) return;
    try {
      await deleteSavedReport(r.id);
      setSaved((s) => s.filter((x) => x.id !== r.id));
      if (loaded?.id === r.id) setLoaded(null);
      notify("Report deleted.");
    } catch (e) {
      notifyError((e as Error).message);
    }
  }

  if (!sources) return <Card title="Report builder"><p className="note">Loading report sources…</p></Card>;
  if (!source) return <EmptyState title="No report sources available to you" />;

  const filterable = source.columns.filter((c) => c.kind !== "number" || def.filters[c.key] !== undefined).slice(0, 40);

  return (
    <div className="ld stack">
      <Card title="Build a report">
        <div className="ld-filters">
          <Field label="Data">
            <select value={def.source} onChange={(e) => pickSource(e.target.value)}>
              {sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </Field>
          <Field label="Group by">
            <select value={def.group_by ?? ""} onChange={(e) => setDef({ ...def, group_by: e.target.value || null })}>
              <option value="">No grouping</option>
              {source.columns.filter((c) => c.kind !== "number").map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </Field>
          <Field label="Search">
            <input type="search" value={search} maxLength={200} onChange={(e) => setSearch(e.target.value)} placeholder="Any shown column" />
          </Field>
        </div>
        <fieldset className="ld-cols">
          <legend>Columns</legend>
          {source.columns.map((c) => (
            <label key={c.key} className="ld-check">
              <input type="checkbox" checked={def.columns.includes(c.key)} onChange={() => toggleColumn(c.key)} /> {c.label}
            </label>
          ))}
        </fieldset>
        <details className="ld-more">
          <summary>Filters{Object.keys(def.filters).length ? ` (${Object.keys(def.filters).length})` : ""}</summary>
          <div className="ld-filter-grid">
            {filterable.map((c) => {
              const v = def.filters[c.key];
              if (c.kind === "date") {
                const r = (typeof v === "object" ? v : {}) as { from?: string; to?: string };
                return (
                  <Field key={c.key} label={`${c.label} between`}>
                    <span className="ld-range">
                      <input type="date" value={r.from ?? ""} onChange={(e) => setFilter(c.key, { ...r, from: e.target.value })} />
                      <input type="date" value={r.to ?? ""} onChange={(e) => setFilter(c.key, { ...r, to: e.target.value })} />
                    </span>
                  </Field>
                );
              }
              if (c.kind === "bool") {
                return (
                  <Field key={c.key} label={c.label}>
                    <select value={typeof v === "string" ? v : ""} onChange={(e) => setFilter(c.key, e.target.value || null)}>
                      <option value="">Any</option>
                      <option value="true">Yes</option>
                      <option value="false">No</option>
                    </select>
                  </Field>
                );
              }
              return (
                <Field key={c.key} label={`${c.label} is`}>
                  <input value={typeof v === "string" ? v : ""} maxLength={200} onChange={(e) => setFilter(c.key, e.target.value || null)} placeholder="Any" />
                </Field>
              );
            })}
          </div>
        </details>
        <div className="ld-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => void run()}>Run report</button>
          <button type="button" className="btn-ghost" disabled={busy || !def.columns.length} onClick={() => void exportCsv()}>Export CSV</button>
          <span className="ld-spacer" />
          <input className="ld-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Report name" aria-label="Report name" />
          <label className="ld-check" title="HR can open shared reports">
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> Share with HR
          </label>
          {loaded && <button type="button" className="btn-ghost" disabled={busy || name.trim().length < 2} onClick={() => void save(false)}>Update</button>}
          <button type="button" className="btn-ghost" disabled={busy || name.trim().length < 2} onClick={() => void save(true)}>Save as new</button>
        </div>
      </Card>

      {result && (
        <Card title={`Results · ${result.total} row${result.total === 1 ? "" : "s"}${result.truncated ? " (first 5,000 shown)" : ""}`}>
          {result.groups && (
            <div className="ld-groups">
              {result.groups.map((g) => (
                <button
                  key={g.value}
                  type="button"
                  className="ld-chip"
                  title="Filter to this group"
                  onClick={() => def.group_by && setFilter(def.group_by, g.value === "Not set" ? null : g.value)}
                >
                  {g.value} <strong>{g.count}</strong>
                </button>
              ))}
            </div>
          )}
          <DataTable
            headers={result.columns.map((c) => c.label)}
            rows={result.rows.slice(0, PREVIEW).map((r) => result.columns.map((c) => cell(r[c.key])))}
            empty={<EmptyState title="No rows match" />}
          />
          {result.rows.length > PREVIEW && <p className="ld-foot">Showing the first {PREVIEW} rows here; Export CSV has all of them.</p>}
        </Card>
      )}

      <Card title={`Saved reports (${saved.length})`}>
        <DataTable
          headers={["Name", "Data", "Shared", ""]}
          rows={saved.map((r) => [
            r.name + (r.mine ? "" : " (shared with HR)"),
            sources.find((s) => s.key === r.source)?.label ?? r.source,
            r.shared ? "Yes" : "No",
            <span key="a" className="ld-row-actions">
              <button type="button" className="btn-ghost btn-tiny" onClick={() => open(r)}>Open</button>
              {r.mine && <button type="button" className="btn-ghost btn-tiny" onClick={() => void remove(r)}>Delete</button>}
            </span>,
          ])}
          empty={<p className="note">No saved reports yet. Build one above and save it.</p>}
        />
      </Card>
    </div>
  );
}
