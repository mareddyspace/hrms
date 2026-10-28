import { useMemo, useState, useSyncExternalStore } from "react";
import { Banner, Card, DataTable, Dialog, EmptyState, Field, MetricCard, MetricGrid, Page, StatusBadge, Tabs } from "../../components/ui.tsx";
import type { PersonRecord } from "../../data/peopleData.ts";
import { listPeople, subscribePeople } from "../../data/peopleLocal.ts";
import { DEMO_ACCOUNTS } from "../../demoAccounts.ts";
import { usePortal } from "../../store.tsx";
import {
  SOURCES,
  SOURCE_IDS,
  buildRows,
  columnLabel,
  defaultDefinition,
  exportSheets,
  runReport,
  validateDefinition,
  type ReportDefinition,
  type SourceId,
} from "./reportSources.ts";
import {
  MAX_RECIPIENTS,
  WEEKDAYS,
  canManageSchedule,
  deleteReport,
  deleteSchedule,
  describeSchedule,
  getReportState,
  logRun,
  nextRun,
  saveReport,
  saveSchedule,
  subscribeReports,
  type Frequency,
  type ReportSchedule,
  type SavedReport,
} from "./reportStore.ts";
import { downloadCsv, downloadXlsx, fileSlug, hasOrgWideReports, isHrOrAdmin, isInternalEmail, reportingLineIds, type DataToolsActor } from "./shared.ts";
import "./datatools.css";

type Message = { tone: "ok" | "err" | "warn" | "info"; text: string } | null;
const PREVIEW_ROWS = 50;
const MANAGER_ROLES = ["manager"];

function formatWhen(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

function stamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** null = everyone (HR/admin); otherwise the set of people ids the owner may report on. */
function scopeFor(ownerId: string, people: readonly PersonRecord[]): Set<string> | null {
  const owner = DEMO_ACCOUNTS.find((a) => a.id === ownerId);
  if (owner && hasOrgWideReports(owner.role)) return null;
  return reportingLineIds(ownerId, people);
}

export function ReportBuilderPage() {
  const { demoProfile, isManager, state, canApproveLeaveFor } = usePortal();
  const people = useSyncExternalStore(subscribePeople, listPeople, listPeople);
  const reports = useSyncExternalStore(subscribeReports, getReportState, getReportState);
  const [tab, setTab] = useState("builder");
  const [definition, setDefinition] = useState<ReportDefinition>(() => defaultDefinition());
  const [loaded, setLoaded] = useState<SavedReport | null>(null);
  const [message, setMessage] = useState<Message>(null);

  const actor: DataToolsActor = { id: demoProfile.id, fullName: demoProfile.fullName, role: demoProfile.role };
  const fullAccess = hasOrgWideReports(demoProfile.role);
  const managerAccess = !fullAccess && (isManager || MANAGER_ROLES.includes(demoProfile.role));

  const myScope = useMemo<Set<string> | null>(() => {
    if (fullAccess) return null;
    const line = reportingLineIds(demoProfile.id, people);
    for (const p of people) if (p.id !== demoProfile.id && canApproveLeaveFor(p.id)) line.add(p.id);
    line.delete(demoProfile.id);
    return line;
  }, [fullAccess, demoProfile.id, people, canApproveLeaveFor]);

  if (!fullAccess && !managerAccess) {
    return (
      <Page title="Report builder">
        <EmptyState title="No access" />
      </Page>
    );
  }

  const mine = reports.reports.filter((r) => r.ownerId === actor.id);
  const visibleSchedules = reports.schedules.filter((s) => canManageSchedule(actor, s));
  const visibleRuns = reports.runs.filter((r) => isHrOrAdmin(demoProfile.role) || r.actorId === actor.id || reports.reports.some((rep) => rep.id === r.reportId && rep.ownerId === actor.id));

  function rowsFor(def: ReportDefinition, scope: Set<string> | null) {
    return runReport(def, buildRows(def.source, state, people), scope);
  }

  function openReport(report: SavedReport) {
    setDefinition(structuredClone(report.definition));
    setLoaded(report);
    setTab("builder");
    setMessage({ tone: "info", text: `Loaded "${report.name}".` });
  }

  /** Generate a file for a schedule using the owner's access, then log the run. */
  function runSchedule(schedule: ReportSchedule) {
    const report = reports.reports.find((r) => r.id === schedule.reportId);
    if (!report) return setMessage({ tone: "err", text: "That report no longer exists." });
    const invalid = validateDefinition(report.definition);
    if (invalid) return setMessage({ tone: "err", text: invalid });
    const scope = schedule.ownerId === actor.id ? myScope : scopeFor(schedule.ownerId, people);
    const result = rowsFor(report.definition, scope);
    const fileName = `${fileSlug(report.name)}-${stamp()}.${schedule.format}`;
    const error = logRun(actor, { reportId: report.id, scheduleId: schedule.id, rowCount: result.rows.length, fileName });
    if (error) return setMessage({ tone: "err", text: error });
    const sheets = exportSheets(report.definition, result);
    if (schedule.format === "xlsx") downloadXlsx(fileName, sheets);
    else downloadCsv(fileName, sheets[0].rows);
    const internal = schedule.recipients.filter(isInternalEmail).length;
    setMessage({ tone: "ok", text: `Downloaded ${fileName} (${result.rows.length} rows). Scheduled for ${internal} recipient${internal === 1 ? "" : "s"}.` });
  }

  return (
    <Page title="Report builder">
      {!fullAccess && <p className="note info">Reports include only people in your reporting line.</p>}
      <Banner message={message} />
      <Tabs
        tabs={[
          { id: "builder", label: "Build" },
          { id: "saved", label: `Saved reports (${mine.length})` },
          { id: "schedules", label: `Schedules (${visibleSchedules.length})` },
          { id: "runs", label: "Run history" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "builder" && (
        <BuilderPanel
          key={loaded?.id ?? "new"}
          actor={actor}
          definition={definition}
          setDefinition={setDefinition}
          loaded={loaded && reports.reports.some((r) => r.id === loaded.id) ? loaded : null}
          setLoaded={setLoaded}
          result={rowsFor(definition, myScope)}
          allRows={buildRows(definition.source, state, people)}
          setMessage={setMessage}
        />
      )}
      {tab === "saved" && <SavedPanel actor={actor} reports={mine} schedules={reports.schedules} onOpen={openReport} setMessage={setMessage} />}
      {tab === "schedules" && (
        <SchedulesPanel actor={actor} myReports={mine} allReports={reports.reports} schedules={visibleSchedules} onRun={runSchedule} setMessage={setMessage} />
      )}
      {tab === "runs" && (
        <Card title="Run history">
          <DataTable
            headers={["When", "Report", "Run by", "Trigger", "Rows", "File", "Recipients"]}
            rows={visibleRuns.map((r) => [
              <span className="dt-nowrap">{formatWhen(r.at)}</span>,
              r.reportName,
              r.actorName,
              <StatusBadge status={r.trigger === "schedule" ? "Schedule" : "Manual"} tone={r.trigger === "schedule" ? "info" : "neutral"} literal />,
              r.rowCount,
              r.fileName,
              r.recipients.length ? r.recipients.join(", ") : "—",
            ])}
            empty={<EmptyState title="No runs yet" />}
          />
        </Card>
      )}
    </Page>
  );
}

/* --------------------------------------------------------------- Builder */

function BuilderPanel({
  actor,
  definition,
  setDefinition,
  loaded,
  setLoaded,
  result,
  allRows,
  setMessage,
}: {
  actor: DataToolsActor;
  definition: ReportDefinition;
  setDefinition: (d: ReportDefinition) => void;
  loaded: SavedReport | null;
  setLoaded: (r: SavedReport | null) => void;
  result: ReturnType<typeof runReport>;
  allRows: ReturnType<typeof buildRows>;
  setMessage: (m: Message) => void;
}) {
  const [name, setName] = useState(loaded?.name ?? "");
  const source = SOURCES[definition.source];
  const invalid = validateDefinition(definition);
  const countries = useMemo(() => [...new Set(allRows.map((r) => r.country).filter(Boolean))].sort(), [allRows]);
  const departments = useMemo(() => [...new Set(allRows.map((r) => r.department).filter(Boolean))].sort(), [allRows]);
  const statuses = useMemo(() => [...new Set(allRows.map((r) => r.status).filter(Boolean))].sort(), [allRows]);

  const update = (patch: Partial<ReportDefinition>) => setDefinition({ ...definition, ...patch });
  const setFilter = (key: keyof ReportDefinition["filters"], value: string) => update({ filters: { ...definition.filters, [key]: value } });

  function changeSource(id: SourceId) {
    setDefinition(defaultDefinition(id));
    setLoaded(null);
    setName("");
  }

  function toggleColumn(id: string) {
    const has = definition.columns.includes(id);
    const columns = has ? definition.columns.filter((c) => c !== id) : source.columns.map((c) => c.id).filter((c) => c === id || definition.columns.includes(c));
    update({ columns });
  }

  function exportAs(format: "csv" | "xlsx") {
    if (invalid) return setMessage({ tone: "err", text: invalid });
    if (!result.rows.length) return setMessage({ tone: "err", text: "There are no rows to export." });
    const fileName = `${fileSlug(loaded?.name ?? source.label)}-${stamp()}.${format}`;
    if (loaded && JSON.stringify(loaded.definition) === JSON.stringify(definition)) {
      const error = logRun(actor, { reportId: loaded.id, rowCount: result.rows.length, fileName });
      if (error) return setMessage({ tone: "err", text: error });
    }
    const sheets = exportSheets(definition, result);
    if (format === "xlsx") downloadXlsx(fileName, sheets);
    else downloadCsv(fileName, sheets[0].rows);
    setMessage({ tone: "ok", text: `Downloaded ${fileName}.` });
  }

  function save(asNew: boolean) {
    const error = saveReport(actor, { id: asNew ? undefined : loaded?.id, name, definition });
    if (error) return setMessage({ tone: "err", text: error });
    const saved = getReportState().reports.find((r) => r.ownerId === actor.id && r.name.toLowerCase() === name.trim().replace(/\s+/g, " ").toLowerCase());
    setLoaded(saved ?? null);
    setMessage({ tone: "ok", text: `Saved "${saved?.name ?? name}".` });
  }

  const shownColumns = definition.columns;

  return (
    <>
      <Card title="Data and columns">
        <div className="stack">
          <div className="form-grid-2">
            <Field label="Data source">
              <select value={definition.source} onChange={(e) => changeSource(e.target.value as SourceId)}>
                {SOURCE_IDS.map((id) => (
                  <option key={id} value={id}>
                    {SOURCES[id].label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="dt-subtle">Columns</legend>
            <div className="dt-columns">
              {source.columns.map((c) => (
                <label key={c.id} className="dt-check">
                  <input type="checkbox" checked={definition.columns.includes(c.id)} onChange={() => toggleColumn(c.id)} />
                  {c.label}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      </Card>

      <Card title="Filters, sort and grouping">
        <div className="dt-filters">
          <Field label="Country">
            <select value={definition.filters.country} onChange={(e) => setFilter("country", e.target.value)}>
              <option value="">All</option>
              {countries.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="Department">
            <select value={definition.filters.department} onChange={(e) => setFilter("department", e.target.value)}>
              <option value="">All</option>
              {departments.map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
          </Field>
          <Field label="Status">
            <select value={definition.filters.status} onChange={(e) => setFilter("status", e.target.value)}>
              <option value="">All</option>
              {statuses.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </Field>
          <Field label={`${source.dateLabel} from`}>
            <input type="date" value={definition.filters.from} onChange={(e) => setFilter("from", e.target.value)} />
          </Field>
          <Field label={`${source.dateLabel} to`}>
            <input type="date" value={definition.filters.to} onChange={(e) => setFilter("to", e.target.value)} />
          </Field>
          <Field label="Sort by">
            <select value={definition.sortBy} onChange={(e) => update({ sortBy: e.target.value })}>
              <option value="">No sorting</option>
              {source.columns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Order">
            <select value={definition.sortDir} onChange={(e) => update({ sortDir: e.target.value === "desc" ? "desc" : "asc" })} disabled={!definition.sortBy}>
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
          </Field>
          <Field label="Group by">
            <select value={definition.groupBy} onChange={(e) => update({ groupBy: e.target.value })}>
              <option value="">No grouping</option>
              {source.columns
                .filter((c) => !c.numeric)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
            </select>
          </Field>
        </div>
      </Card>

      {invalid && <p className="note err">{invalid}</p>}

      <MetricGrid>
        <MetricCard label="Rows" value={result.rows.length} />
        {definition.groupBy && <MetricCard label="Groups" value={result.groups.length} />}
        <MetricCard label="Columns" value={shownColumns.length} />
      </MetricGrid>

      {definition.groupBy && (
        <Card title={`Grouped by ${columnLabel(definition.source, definition.groupBy).toLowerCase()}`}>
          <DataTable
            headers={[
              columnLabel(definition.source, definition.groupBy),
              "Count",
              ...source.columns.filter((c) => c.numeric).map((c) => `Total ${c.label.toLowerCase()}`),
            ]}
            rows={result.groups.slice(0, PREVIEW_ROWS).map((g) => [g.key, g.count, ...source.columns.filter((c) => c.numeric).map((c) => g.totals[c.id])])}
            empty={<EmptyState title="No rows match these filters" />}
          />
        </Card>
      )}

      <Card
        title={result.rows.length > PREVIEW_ROWS ? `Preview · first ${PREVIEW_ROWS} of ${result.rows.length}` : "Preview"}
        action={
          <div className="dt-actions">
            <button type="button" className="btn-ghost btn-tiny" disabled={!!invalid || !result.rows.length} onClick={() => exportAs("csv")}>
              Export CSV
            </button>
            <button type="button" className="btn-ghost btn-tiny" disabled={!!invalid || !result.rows.length} onClick={() => exportAs("xlsx")}>
              Export Excel
            </button>
          </div>
        }
      >
        <DataTable
          headers={shownColumns.map((c) => columnLabel(definition.source, c))}
          rows={invalid ? [] : result.rows.slice(0, PREVIEW_ROWS).map((r) => shownColumns.map((c) => String(r.cells[c] ?? "")))}
          empty={<EmptyState title="No rows match these filters" />}
        />
      </Card>

      <Card title={loaded ? `Save · editing "${loaded.name}"` : "Save report"}>
        <div className="stack">
          <div className="form-grid-2">
            <Field label="Report name">
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="For example, India headcount" />
            </Field>
          </div>
          <div className="dt-actions">
            {loaded && loaded.ownerId === actor.id && (
              <button type="button" className="btn" disabled={!!invalid} onClick={() => save(false)}>
                Update report
              </button>
            )}
            <button type="button" className={loaded ? "btn-ghost" : "btn"} disabled={!!invalid} onClick={() => save(true)}>
              Save as new report
            </button>
            {loaded && (
              <button
                type="button"
                className="btn-ghost"
                onClick={() => {
                  setLoaded(null);
                  setName("");
                  setDefinition(defaultDefinition(definition.source));
                }}
              >
                Start over
              </button>
            )}
          </div>
        </div>
      </Card>
    </>
  );
}

/* ----------------------------------------------------------------- Saved */

function SavedPanel({
  actor,
  reports,
  schedules,
  onOpen,
  setMessage,
}: {
  actor: DataToolsActor;
  reports: SavedReport[];
  schedules: ReportSchedule[];
  onOpen: (r: SavedReport) => void;
  setMessage: (m: Message) => void;
}) {
  const [deleting, setDeleting] = useState<SavedReport | null>(null);
  return (
    <Card title="Your saved reports">
      <DataTable
        headers={["Name", "Source", "Columns", "Schedule", "Updated", ""]}
        rows={reports.map((r) => {
          const schedule = schedules.find((s) => s.reportId === r.id);
          return [
            r.name,
            SOURCES[r.definition.source].label,
            r.definition.columns.length,
            schedule ? describeSchedule(schedule) : "—",
            <span className="dt-nowrap">{formatWhen(r.updatedAt)}</span>,
            <div className="dt-actions">
              <button type="button" className="btn-ghost btn-tiny" onClick={() => onOpen(r)}>
                Open
              </button>
              <button type="button" className="btn-ghost btn-tiny" onClick={() => setDeleting(r)}>
                Delete
              </button>
            </div>,
          ];
        })}
        empty={<EmptyState title="No saved reports" />}
      />
      <Dialog
        open={!!deleting}
        title="Delete report"
        onClose={() => setDeleting(null)}
        actions={
          <>
            <button type="button" className="btn-ghost" onClick={() => setDeleting(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                const error = deleting ? deleteReport(actor, deleting.id) : null;
                setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: `Deleted "${deleting?.name}".` });
                setDeleting(null);
              }}
            >
              Delete
            </button>
          </>
        }
      >
        <p className="note">
          Delete "{deleting?.name}"{schedules.some((s) => s.reportId === deleting?.id) ? " and its schedule" : ""}? This cannot be undone.
        </p>
      </Dialog>
    </Card>
  );
}

/* ------------------------------------------------------------- Schedules */

type ScheduleDraft = {
  id?: string;
  reportId: string;
  frequency: Frequency;
  dayOfWeek: number;
  dayOfMonth: number;
  time: string;
  format: "csv" | "xlsx";
  recipientsText: string;
};

function SchedulesPanel({
  actor,
  myReports,
  allReports,
  schedules,
  onRun,
  setMessage,
}: {
  actor: DataToolsActor;
  myReports: SavedReport[];
  allReports: SavedReport[];
  schedules: ReportSchedule[];
  onRun: (s: ReportSchedule) => void;
  setMessage: (m: Message) => void;
}) {
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<ReportSchedule | null>(null);
  const unscheduled = myReports.filter((r) => !schedules.some((s) => s.reportId === r.id));
  const now = new Date();

  function openNew() {
    setError("");
    setDraft({ reportId: unscheduled[0]?.id ?? "", frequency: "weekly", dayOfWeek: 1, dayOfMonth: 1, time: "09:00", format: "xlsx", recipientsText: "" });
  }

  function openEdit(s: ReportSchedule) {
    setError("");
    setDraft({ id: s.id, reportId: s.reportId, frequency: s.frequency, dayOfWeek: s.dayOfWeek, dayOfMonth: s.dayOfMonth, time: s.time, format: s.format, recipientsText: s.recipients.join(", ") });
  }

  function submit() {
    if (!draft) return;
    const result = saveSchedule(actor, draft);
    if (result) return setError(result);
    setDraft(null);
    setMessage({ tone: "ok", text: draft.id ? "Schedule updated." : "Schedule created." });
  }

  const reportName = (id: string) => allReports.find((r) => r.id === id)?.name ?? "Deleted report";

  return (
    <Card
      title="Scheduled exports"
      action={
        <button type="button" className="btn-ghost btn-tiny" disabled={!unscheduled.length} onClick={openNew} title={unscheduled.length ? undefined : "Save a report first"}>
          New schedule
        </button>
      }
    >
      <DataTable
        headers={["Report", "Owner", "When", "Next run", "Format", "Recipients", "Last run", ""]}
        rows={schedules.map((s) => [
          reportName(s.reportId),
          s.ownerName,
          describeSchedule(s),
          <span className="dt-nowrap">{formatWhen(nextRun(s, now))}</span>,
          s.format === "xlsx" ? "Excel" : "CSV",
          <ul className="dt-chip-list">
            {s.recipients.filter(isInternalEmail).map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>,
          s.lastRunAt ? <span className="dt-nowrap">{formatWhen(s.lastRunAt)}</span> : "—",
          <div className="dt-actions">
            <button type="button" className="btn-ghost btn-tiny" onClick={() => onRun(s)}>
              Run now
            </button>
            <button type="button" className="btn-ghost btn-tiny" onClick={() => openEdit(s)}>
              Edit
            </button>
            <button type="button" className="btn-ghost btn-tiny" onClick={() => setDeleting(s)}>
              Delete
            </button>
          </div>,
        ])}
        empty={<EmptyState title="No schedules" description={myReports.length ? undefined : "Save a report first."} />}
      />

      <Dialog
        open={!!draft}
        title={draft?.id ? "Edit schedule" : "New schedule"}
        onClose={() => setDraft(null)}
        actions={
          <>
            <button type="button" className="btn-ghost" onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button type="button" className="btn" onClick={submit}>
              Save schedule
            </button>
          </>
        }
      >
        {draft && (
          <div className="stack">
            {error && <p className="note err">{error}</p>}
            <div className="form-grid-2">
              <Field label="Report" wide>
                {draft.id ? (
                  <input value={reportName(draft.reportId)} disabled />
                ) : (
                  <select value={draft.reportId} onChange={(e) => setDraft({ ...draft, reportId: e.target.value })}>
                    {unscheduled.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="Frequency">
                <select value={draft.frequency} onChange={(e) => setDraft({ ...draft, frequency: e.target.value as Frequency })}>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </Field>
              {draft.frequency === "weekly" && (
                <Field label="Day">
                  <select value={draft.dayOfWeek} onChange={(e) => setDraft({ ...draft, dayOfWeek: Number(e.target.value) })}>
                    {WEEKDAYS.map((d, i) => (
                      <option key={d} value={i}>
                        {d}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {draft.frequency === "monthly" && (
                <Field label="Day of month (1–28)">
                  <input type="number" min={1} max={28} value={draft.dayOfMonth} onChange={(e) => setDraft({ ...draft, dayOfMonth: Number(e.target.value) })} />
                </Field>
              )}
              <Field label="Time">
                <input type="time" value={draft.time} onChange={(e) => setDraft({ ...draft, time: e.target.value })} />
              </Field>
              <Field label="Format">
                <select value={draft.format} onChange={(e) => setDraft({ ...draft, format: e.target.value === "csv" ? "csv" : "xlsx" })}>
                  <option value="xlsx">Excel</option>
                  <option value="csv">CSV</option>
                </select>
              </Field>
              <Field label={`Recipients (@timez.com only, up to ${MAX_RECIPIENTS})`} wide>
                <textarea value={draft.recipientsText} onChange={(e) => setDraft({ ...draft, recipientsText: e.target.value })} maxLength={1500} placeholder="name@timez.com, team@timez.com" />
              </Field>
            </div>
            {/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time) && <p className="dt-subtle">Next run: {formatWhen(nextRun(draft))}</p>}
          </div>
        )}
      </Dialog>

      <Dialog
        open={!!deleting}
        title="Delete schedule"
        onClose={() => setDeleting(null)}
        actions={
          <>
            <button type="button" className="btn-ghost" onClick={() => setDeleting(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                const result = deleting ? deleteSchedule(actor, deleting.id) : null;
                setMessage(result ? { tone: "err", text: result } : { tone: "ok", text: "Schedule deleted." });
                setDeleting(null);
              }}
            >
              Delete
            </button>
          </>
        }
      >
        <p className="note">Stop scheduled exports of "{deleting ? reportName(deleting.reportId) : ""}"? The saved report is kept.</p>
      </Dialog>
    </Card>
  );
}
