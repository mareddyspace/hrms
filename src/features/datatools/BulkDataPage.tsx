import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Banner, Card, DataTable, Dialog, EmptyState, Field, MetricCard, MetricGrid, Page, StatusBadge, Tabs } from "../../components/ui.tsx";
import { FILTER_OPTIONS, type EmploymentStatus, type PersonRecord } from "../../data/peopleData.ts";
import { listPeople, subscribePeople } from "../../data/peopleLocal.ts";
import { todayISO } from "../../model.ts";
import { usePortal } from "../../store.tsx";
import { commitImport, commitMassUpdate, getBulkState, subscribeBulk, undoableEntry, undoLast } from "./bulkStore.ts";
import { MAX_IMPORT_ROWS, parseImportFile, templateSheets, validateImport, type ImportAction, type RawImportRow } from "./importRules.ts";
import { MAX_MASS_UPDATE, canMassUpdate, describeChange, orphanedReports, planMassUpdate, type MassChange } from "./massUpdateRules.ts";
import { downloadCsv, downloadXlsx, isHrOrAdmin, type DataToolsActor } from "./shared.ts";
import "./datatools.css";

type Message = { tone: "ok" | "err" | "warn" | "info"; text: string } | null;
const PAGE_SIZE = 100;

function usePeople(): PersonRecord[] {
  return useSyncExternalStore(subscribePeople, listPeople, listPeople);
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function peopleLabel(n: number): string {
  return n === 1 ? "1 person" : `${n} people`;
}

export function BulkDataPage() {
  const { demoProfile } = usePortal();
  const [tab, setTab] = useState("import");
  const actor: DataToolsActor = { id: demoProfile.id, fullName: demoProfile.fullName, role: demoProfile.role };

  if (!isHrOrAdmin(demoProfile.role)) {
    return (
      <Page title="Bulk data">
        <EmptyState title="No access" description="Only HR and admins can import employees or make mass updates." />
      </Page>
    );
  }

  return (
    <Page title="Bulk data">
      <Tabs
        tabs={[
          { id: "import", label: "Import employees" },
          ...(canMassUpdate(demoProfile.role) ? [{ id: "mass", label: "Mass update" }] : []),
          { id: "history", label: "History" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "import" && <ImportPanel actor={actor} onDone={() => setTab("history")} />}
      {tab === "mass" && canMassUpdate(demoProfile.role) && <MassUpdatePanel actor={actor} onDone={() => setTab("history")} />}
      {tab === "history" && <HistoryPanel actor={actor} />}
    </Page>
  );
}

/* ---------------------------------------------------------------- Import */

const ACTION_LABEL: Record<ImportAction, { label: string; tone: "ok" | "info" | "neutral" | "danger" }> = {
  create: { label: "Create", tone: "ok" },
  update: { label: "Update", tone: "info" },
  unchanged: { label: "No change", tone: "neutral" },
  error: { label: "Error", tone: "danger" },
};

function ImportPanel({ actor, onDone }: { actor: DataToolsActor; onDone: () => void }) {
  const people = usePeople();
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<RawImportRow[]>([]);
  const [ignored, setIgnored] = useState<string[]>([]);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"all" | ImportAction>("all");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [validOnly, setValidOnly] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const validated = useMemo(() => validateImport(rows, people, todayISO()), [rows, people]);
  const counts = useMemo(() => {
    const c: Record<ImportAction, number> = { create: 0, update: 0, unchanged: 0, error: 0 };
    for (const row of validated) c[row.action] += 1;
    return c;
  }, [validated]);
  const shown = view === "all" ? validated : validated.filter((r) => r.action === view);
  const importable = counts.create + counts.update;
  const canImport = importable > 0 && (counts.error === 0 || validOnly);

  function reset() {
    setRows([]);
    setFileName("");
    setIgnored([]);
    setValidOnly(false);
    setView("all");
    setLimit(PAGE_SIZE);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function onFile(file: File | undefined) {
    setMessage(null);
    if (!file) return;
    setBusy(true);
    const parsed = await parseImportFile(file);
    setBusy(false);
    if (!parsed.ok) {
      reset();
      setMessage({ tone: "err", text: parsed.error });
      return;
    }
    setRows(parsed.rows);
    setIgnored(parsed.ignoredColumns);
    setFileName(file.name);
    setView("all");
    setLimit(PAGE_SIZE);
    setValidOnly(false);
  }

  function downloadTemplate(format: "xlsx" | "csv") {
    const manager = people.find((p) => p.id === "emp-ram") ?? people.find((p) => p.employmentStatus === "Active");
    const sheets = templateSheets(manager?.employeeCode ?? "");
    if (format === "xlsx") downloadXlsx("employee-import-template.xlsx", sheets);
    else downloadCsv("employee-import-template.csv", sheets[0].rows);
  }

  function downloadIssues() {
    const out: unknown[][] = [["row", "employeeCode", "fullName", "action", "errors", "warnings"]];
    for (const r of validated) {
      if (!r.errors.length && !r.warnings.length) continue;
      out.push([r.rowNumber, r.values.employeeCode, r.values.fullName, ACTION_LABEL[r.action].label, r.errors.join(" | "), r.warnings.join(" | ")]);
    }
    downloadCsv(`${fileName.replace(/\.[^.]+$/, "") || "import"}-issues.csv`, out);
  }

  function confirmImport() {
    setBusy(true);
    const error = commitImport(actor, fileName, rows, { validOnly });
    setBusy(false);
    setConfirming(false);
    if (error) {
      setMessage({ tone: "err", text: error });
      return;
    }
    reset();
    setMessage({ tone: "ok", text: `Import finished: ${plural(counts.create, "employee")} created, ${counts.update} updated.` });
    onDone();
  }

  return (
    <>
      <Banner message={message} />
      <Card title="Upload a file">
        <div className="stack">
          <p className="note">
            Required columns, in any order: employeeCode, fullName, email, department, designation, countryName, location, managerEmployeeCode,
            dateOfJoining (YYYY-MM-DD), employmentType, employmentStatus. CSV or Excel, up to 2 MB and {MAX_IMPORT_ROWS} rows. An existing
            employee code updates that person; a new code creates one.
          </p>
          <div className="dt-actions">
            <button type="button" className="btn-ghost" onClick={() => downloadTemplate("xlsx")}>
              Download Excel template
            </button>
            <button type="button" className="btn-ghost" onClick={() => downloadTemplate("csv")}>
              Download CSV template
            </button>
          </div>
          <div className="dt-file">
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              aria-label="Employee file"
              disabled={busy}
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
            {fileName && (
              <button type="button" className="btn-ghost btn-tiny" onClick={reset}>
                Clear file
              </button>
            )}
          </div>
          {ignored.length > 0 && <p className="note warn">Ignored unknown columns: {ignored.join(", ")}</p>}
        </div>
      </Card>

      {rows.length > 0 && (
        <>
          <MetricGrid>
            <MetricCard label="Rows" value={validated.length} />
            <MetricCard label="New employees" value={counts.create} />
            <MetricCard label="Updates" value={counts.update} />
            <MetricCard label="No change" value={counts.unchanged} />
            <MetricCard label="Rows with errors" value={counts.error} />
          </MetricGrid>

          <Card
            title={`Preview · ${fileName}`}
            action={
              counts.error > 0 || validated.some((r) => r.warnings.length) ? (
                <button type="button" className="btn-ghost btn-tiny" onClick={downloadIssues}>
                  Download issues
                </button>
              ) : undefined
            }
          >
            <div className="stack">
              <Tabs
                tabs={[
                  { id: "all", label: `All (${validated.length})` },
                  { id: "error", label: `Errors (${counts.error})` },
                  { id: "create", label: `Create (${counts.create})` },
                  { id: "update", label: `Update (${counts.update})` },
                  { id: "unchanged", label: `No change (${counts.unchanged})` },
                ]}
                value={view}
                onChange={(id) => {
                  setView(id as "all" | ImportAction);
                  setLimit(PAGE_SIZE);
                }}
              />
              <DataTable
                headers={["Row", "Action", "Employee", "Email", "Department", "Manager", "Issues"]}
                rows={shown.slice(0, limit).map((r) => [
                  r.rowNumber,
                  <StatusBadge status={ACTION_LABEL[r.action].label} tone={ACTION_LABEL[r.action].tone} literal />,
                  <span>
                    {r.values.fullName || "—"}
                    <br />
                    <span className="dt-subtle">{r.values.employeeCode || "—"}</span>
                  </span>,
                  r.values.email || "—",
                  r.values.department || "—",
                  r.values.managerEmployeeCode || "—",
                  r.errors.length || r.warnings.length ? (
                    <ul className="dt-issues">
                      {r.errors.map((e) => (
                        <li key={e}>{e}</li>
                      ))}
                      {r.warnings.map((w) => (
                        <li key={w} className="warn">
                          {w}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="dt-subtle">OK</span>
                  ),
                ])}
                empty={<EmptyState title="No rows in this view" />}
              />
              {shown.length > limit && (
                <div className="dt-more">
                  <button type="button" className="btn-ghost btn-tiny" onClick={() => setLimit((n) => n + PAGE_SIZE)}>
                    Show more ({shown.length - limit} left)
                  </button>
                </div>
              )}
            </div>
          </Card>

          <Card title="Import">
            <div className="stack">
              {counts.error > 0 && (
                <label className="dt-check">
                  <input type="checkbox" checked={validOnly} onChange={(e) => setValidOnly(e.target.checked)} />
                  Import valid rows only and skip {plural(counts.error, "row")} with errors
                </label>
              )}
              {importable === 0 && <p className="note">Nothing to import — every row is unchanged or has errors.</p>}
              {counts.error > 0 && !validOnly && importable > 0 && <p className="note err">Fix the errors in the file, or choose to import valid rows only.</p>}
              <div className="dt-actions">
                <button type="button" className="btn" disabled={!canImport || busy} onClick={() => setConfirming(true)}>
                  Review and import {importable} row{importable === 1 ? "" : "s"}
                </button>
              </div>
            </div>
          </Card>
        </>
      )}

      <Dialog
        open={confirming}
        title="Confirm import"
        onClose={() => setConfirming(false)}
        actions={
          <>
            <button type="button" className="btn-ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button type="button" className="btn" disabled={busy} onClick={confirmImport}>
              Import now
            </button>
          </>
        }
      >
        <div className="dt-summary">
          <span>
            <strong>{counts.create}</strong> to create
          </span>
          <span>
            <strong>{counts.update}</strong> to update
          </span>
          <span>
            <strong>{counts.unchanged + counts.error}</strong> skipped
          </span>
        </div>
        <p className="note">From {fileName}. Undo from History until another bulk change is made.</p>
      </Dialog>
    </>
  );
}

/* ----------------------------------------------------------- Mass update */

type ChangeKind = MassChange["kind"];

function MassUpdatePanel({ actor, onDone }: { actor: DataToolsActor; onDone: () => void }) {
  const people = usePeople();
  const [search, setSearch] = useState("");
  const [country, setCountry] = useState("");
  const [department, setDepartment] = useState("");
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [kind, setKind] = useState<ChangeKind>("manager");
  const [managerSearch, setManagerSearch] = useState("");
  const [managerId, setManagerId] = useState("");
  const [newDepartment, setNewDepartment] = useState("");
  const [location, setLocation] = useState("");
  const [newStatus, setNewStatus] = useState<EmploymentStatus | "">("");
  const [message, setMessage] = useState<Message>(null);
  const [confirming, setConfirming] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return people.filter(
      (p) =>
        (!country || p.countryName === country) &&
        (!department || p.department === department) &&
        (!status || p.employmentStatus === status) &&
        (!q || p.fullName.toLowerCase().includes(q) || p.employeeCode.toLowerCase().includes(q) || p.email.toLowerCase().includes(q)),
    );
  }, [people, search, country, department, status]);

  const managerOptions = useMemo(() => {
    const q = managerSearch.trim().toLowerCase();
    const list = people.filter((p) => p.employmentStatus !== "Terminated" && (!q || p.fullName.toLowerCase().includes(q) || p.employeeCode.toLowerCase().includes(q)));
    return list.slice(0, 200);
  }, [people, managerSearch]);

  const locations = useMemo(() => [...new Set(people.map((p) => p.location))].sort(), [people]);

  const change: MassChange | null =
    kind === "manager"
      ? managerId
        ? { kind, managerId }
        : null
      : kind === "department"
        ? newDepartment
          ? { kind, department: newDepartment }
          : null
        : kind === "location"
          ? location.trim()
            ? { kind, location }
            : null
          : newStatus
            ? { kind: "status", status: newStatus }
            : null;

  const selectedIds = useMemo(() => [...selected].filter((id) => people.some((p) => p.id === id)), [selected, people]);
  const plan = change && selectedIds.length ? planMassUpdate(actor, selectedIds, change, people, todayISO()) : null;
  const orphaned = plan ? orphanedReports(plan, people) : 0;

  const allShownSelected = filtered.length > 0 && filtered.every((p) => selected.has(p.id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectShown(on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of filtered) {
        if (on) next.add(p.id);
        else next.delete(p.id);
      }
      return next;
    });
  }

  function apply() {
    if (!change) return;
    const error = commitMassUpdate(actor, selectedIds, change);
    setConfirming(false);
    if (error) {
      setMessage({ tone: "err", text: error });
      return;
    }
    setMessage({ tone: "ok", text: `Updated ${peopleLabel(plan?.changes.length ?? 0)}.` });
    setSelected(new Set());
    onDone();
  }

  return (
    <>
      <Banner message={message} />
      <Card title="1. Choose people">
        <div className="stack">
          <div className="dt-filters">
            <Field label="Search">
              <input value={search} onChange={(e) => { setSearch(e.target.value); setLimit(PAGE_SIZE); }} placeholder="Name, code or email" maxLength={80} />
            </Field>
            <Field label="Country">
              <select value={country} onChange={(e) => setCountry(e.target.value)}>
                <option value="">All countries</option>
                {FILTER_OPTIONS.countries.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </Field>
            <Field label="Department">
              <select value={department} onChange={(e) => setDepartment(e.target.value)}>
                <option value="">All departments</option>
                {FILTER_OPTIONS.departments.map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
            </Field>
            <Field label="Status">
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">All statuses</option>
                {FILTER_OPTIONS.employmentStatuses.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </Field>
          </div>
          <div className="row-between">
            <label className="dt-check">
              <input type="checkbox" checked={allShownSelected} onChange={(e) => selectShown(e.target.checked)} />
              Select all {filtered.length} matching
            </label>
            <span className="dt-subtle">
              {selectedIds.length} selected
              {selectedIds.length > 0 && (
                <>
                  {" · "}
                  <button type="button" className="btn-ghost btn-tiny" onClick={() => setSelected(new Set())}>
                    Clear
                  </button>
                </>
              )}
            </span>
          </div>
          {selectedIds.length > MAX_MASS_UPDATE && <p className="note err">Select at most {MAX_MASS_UPDATE} people at a time.</p>}
          <DataTable
            headers={["", "Employee", "Department", "Location", "Manager", "Status"]}
            rows={filtered.slice(0, limit).map((p) => [
              <input type="checkbox" aria-label={`Select ${p.fullName}`} checked={selected.has(p.id)} onChange={() => toggle(p.id)} />,
              <span>
                {p.fullName}
                <br />
                <span className="dt-subtle">{p.employeeCode}</span>
              </span>,
              p.department,
              p.location,
              p.managerName || "—",
              <StatusBadge status={p.employmentStatus} tone={p.employmentStatus === "Active" ? "ok" : p.employmentStatus === "Terminated" ? "danger" : "warn"} literal />,
            ])}
            empty={<EmptyState title="No people match these filters" />}
          />
          {filtered.length > limit && (
            <div className="dt-more">
              <button type="button" className="btn-ghost btn-tiny" onClick={() => setLimit((n) => n + PAGE_SIZE)}>
                Show more ({filtered.length - limit} left)
              </button>
            </div>
          )}
        </div>
      </Card>

      <Card title="2. Choose one change">
        <div className="form-grid-2">
          <Field label="Change">
            <select value={kind} onChange={(e) => setKind(e.target.value as ChangeKind)}>
              <option value="manager">Manager</option>
              <option value="department">Department</option>
              <option value="location">Location</option>
              <option value="status">Employment status</option>
            </select>
          </Field>
          {kind === "manager" && (
            <>
              <Field label="Find manager">
                <input value={managerSearch} onChange={(e) => setManagerSearch(e.target.value)} placeholder="Name or code" maxLength={80} />
              </Field>
              <Field label="New manager" wide>
                <select value={managerId} onChange={(e) => setManagerId(e.target.value)}>
                  <option value="">Choose a manager</option>
                  {managerId && !managerOptions.some((p) => p.id === managerId) && (
                    <option value={managerId}>{people.find((p) => p.id === managerId)?.fullName ?? managerId}</option>
                  )}
                  {managerOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.fullName} · {p.employeeCode} · {p.designation}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          )}
          {kind === "department" && (
            <Field label="New department">
              <select value={newDepartment} onChange={(e) => setNewDepartment(e.target.value)}>
                <option value="">Choose a department</option>
                {FILTER_OPTIONS.departments.map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
            </Field>
          )}
          {kind === "location" && (
            <Field label="New location">
              <input value={location} onChange={(e) => setLocation(e.target.value)} list="dt-locations" maxLength={60} placeholder="City or office" />
              <datalist id="dt-locations">
                {locations.map((l) => (
                  <option key={l} value={l} />
                ))}
              </datalist>
            </Field>
          )}
          {kind === "status" && (
            <>
              <Field label="New status">
                <select value={newStatus} onChange={(e) => setNewStatus(e.target.value as EmploymentStatus | "")}>
                  <option value="">Choose a status</option>
                  {FILTER_OPTIONS.employmentStatuses
                    .filter((s) => s !== "Terminated")
                    .map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                </select>
              </Field>
              <p className="note">To end someone's employment, use the exit workflow.</p>
            </>
          )}
        </div>
      </Card>

      <Card title="3. Preview and apply">
        {!selectedIds.length ? (
          <p className="note">Select at least one person.</p>
        ) : !change || !plan ? (
          <p className="note">Choose the change to apply.</p>
        ) : plan.error ? (
          <p className="note err">{plan.error}</p>
        ) : (
          <div className="stack">
            <div className="dt-summary">
              <span>{describeChange(change, people)}</span>
              <span>
                <strong>{plan.changes.length}</strong> will change
              </span>
              <span>
                <strong>{plan.skipped.length}</strong> skipped
              </span>
            </div>
            {orphaned > 0 && <p className="note warn">{plural(orphaned, "active direct report")} will still point to a terminated manager. Reassign them next.</p>}
            {plan.skipped.length > 0 && (
              <DataTable
                headers={["Skipped", "Reason"]}
                rows={plan.skipped.slice(0, 50).map((s) => [`${s.person.fullName} (${s.person.employeeCode})`, s.reason])}
              />
            )}
            {plan.skipped.length > 50 && <p className="dt-subtle">And {plan.skipped.length - 50} more skipped.</p>}
            <div className="dt-actions">
              <button type="button" className="btn" disabled={!plan.changes.length} onClick={() => setConfirming(true)}>
                Apply to {peopleLabel(plan.changes.length)}
              </button>
            </div>
          </div>
        )}
      </Card>

      <Dialog
        open={confirming && !!plan && !plan.error}
        title="Confirm mass update"
        onClose={() => setConfirming(false)}
        actions={
          <>
            <button type="button" className="btn-ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button type="button" className="btn" onClick={apply}>
              Apply change
            </button>
          </>
        }
      >
        <p className="note">
          {change ? describeChange(change, people) : ""} for {peopleLabel(plan?.changes.length ?? 0)}.{" "}
          {plan?.skipped.length ? `${plan.skipped.length} skipped. ` : ""}Undo from History until another bulk change is made.
        </p>
      </Dialog>
    </>
  );
}

/* --------------------------------------------------------------- History */

function HistoryPanel({ actor }: { actor: DataToolsActor }) {
  const state = useSyncExternalStore(subscribeBulk, getBulkState, getBulkState);
  const last = undoableEntry(state);
  const [message, setMessage] = useState<Message>(null);
  const [confirming, setConfirming] = useState(false);

  function undo() {
    const error = undoLast(actor);
    setConfirming(false);
    setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "The last bulk change was undone." });
  }

  return (
    <>
      <Banner message={message} />
      <Card
        title="Bulk change history"
        action={
          last ? (
            <button type="button" className="btn-ghost btn-tiny" onClick={() => setConfirming(true)}>
              Undo last change
            </button>
          ) : undefined
        }
      >
        <DataTable
          headers={["When", "By", "Type", "Detail", "Created", "Updated", "Skipped", "State"]}
          rows={state.history.map((e) => [
            <span className="dt-nowrap">{formatWhen(e.at)}</span>,
            e.actorName,
            e.kind === "import" ? "Import" : "Mass update",
            e.kind === "import" ? e.fileName ?? e.summary : e.summary,
            e.created,
            e.updated,
            e.skipped,
            e.undoneAt ? (
              <span title={`Undone by ${e.undoneBy ?? "someone"} on ${formatWhen(e.undoneAt)}`}>
                <StatusBadge status="Undone" tone="warn" literal />
              </span>
            ) : (
              <StatusBadge status="Applied" tone="ok" literal />
            ),
          ])}
          empty={<EmptyState title="No bulk changes yet" />}
        />
      </Card>
      <Dialog
        open={confirming && !!last}
        title="Undo last change"
        onClose={() => setConfirming(false)}
        actions={
          <>
            <button type="button" className="btn-ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button type="button" className="btn" onClick={undo}>
              Undo
            </button>
          </>
        }
      >
        {last && (
          <p className="note">
            {last.kind === "import" ? `Undo the import of ${last.fileName ?? "this file"}` : `Undo "${last.summary}"`} by {last.actorName}:{" "}
            {last.created > 0 ? `remove ${plural(last.created, "new employee")} and ` : ""}restore {plural(last.snapshots.length, "record")} to how they were.
            Edits made to these people since then will also be reverted.
          </p>
        )}
      </Dialog>
    </>
  );
}
