import { useMemo, useState } from "react";
import { Card, EmptyState, Page } from "../components/ui.tsx";
import { useAuditTrail, type AuditEntry } from "../data/auditTrail.ts";
import { listAuditLog } from "../data/platformLocal.ts";
import { downloadText } from "../components/ui.tsx";
import { usePortal } from "../store.tsx";

const FIELD_NAMES: Record<string, string> = {
  status: "Status",
  decidedByName: "Decided by",
  decidedOn: "Decided on",
  decisionNote: "Note",
  decidedById: "Decided by (ID)",
  from: "From",
  to: "To",
  amount: "Amount",
  hours: "Hours",
  entries: "Time entries",
};

function when(iso: string, timeZone: string): string {
  try {
    return new Date(iso).toLocaleString("en-GB", { timeZone, dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

/** Who changed what and when, with the values before and after. */
export function AuditLogPage() {
  const { employee, demoAccounts } = usePortal();
  const trail = useAuditTrail();
  // Same events as the admin Home "Recent audit events" card: record changes plus platform events.
  const entries = useMemo((): (Omit<AuditEntry, "action"> & { action: string })[] => {
    const platform = listAuditLog().map((e) => ({
      id: e.id,
      at: e.at.includes("T") ? e.at : e.at.replace(" ", "T"),
      actorId: "",
      actorName: e.actor,
      entity: "Platform",
      entityId: e.target,
      action: e.action,
      changes: [],
    }));
    return [...trail, ...platform].sort((a, b) => b.at.localeCompare(a.at));
  }, [trail]);
  const [query, setQuery] = useState("");
  const [entity, setEntity] = useState("all");

  const nameOf = (id?: string) => (id ? (demoAccounts.find((a) => a.id === id)?.fullName ?? id) : "—");
  const entities = useMemo(() => [...new Set(entries.map((e) => e.entity))].sort(), [entries]);
  const needle = query.trim().toLowerCase();
  const rows = entries.filter(
    (e) =>
      (entity === "all" || e.entity === entity) &&
      (!needle ||
        e.actorName.toLowerCase().includes(needle) ||
        nameOf(e.subjectId).toLowerCase().includes(needle) ||
        e.entityId.toLowerCase().includes(needle)),
  );

  function exportCsv() {
    const lines = [
      ["When (UTC)", "By", "Action", "Record", "Record ID", "Person", "Changes"].join(","),
      ...rows.map((e) =>
        [
          e.at,
          e.actorName,
          e.action,
          e.entity,
          e.entityId,
          nameOf(e.subjectId),
          e.changes.map((c) => `${c.field}: ${c.before} → ${c.after}`).join("; "),
        ]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(","),
      ),
    ];
    downloadText("audit-log.csv", lines.join("\n"));
  }

  return (
    <Page
      title="Audit log"
      subtitle={`Times in ${employee.timeZone}`}
      action={
        <button className="btn-ghost" type="button" onClick={exportCsv} disabled={rows.length === 0}>
          Export CSV
        </button>
      }
    >
      <Card>
        <div className="form-grid">
          <label className="field">
            <span>Search</span>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Person, approver or record ID" />
          </label>
          <label className="field">
            <span>Record type</span>
            <select value={entity} onChange={(e) => setEntity(e.target.value)}>
              <option value="all">All</option>
              {entities.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
        </div>
        {rows.length === 0 ? (
          <EmptyState title="No changes recorded yet" />
        ) : (
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>When</th>
                  <th>By</th>
                  <th>Action</th>
                  <th>Record</th>
                  <th>Person</th>
                  <th>Before → after</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 300).map((e, i) => (
                  <tr key={`${e.id}-${i}`}>
                    <td>{when(e.at, employee.timeZone)}</td>
                    <td>{e.actorName}</td>
                    <td>{e.action}</td>
                    <td>
                      {e.entity}
                      <br />
                      <span className="muted">{e.entityId}</span>
                    </td>
                    <td>{nameOf(e.subjectId)}</td>
                    <td>
                      {e.changes.length === 0
                        ? "—"
                        : e.changes.slice(0, 4).map((c) => (
                            <div key={c.field}>
                              <strong>{FIELD_NAMES[c.field] ?? c.field}:</strong> {c.before} → {c.after}
                            </div>
                          ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </Page>
  );
}
