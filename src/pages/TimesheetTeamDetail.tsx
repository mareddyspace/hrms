import { useEffect, useMemo, useState } from "react";
import { ActionButton, StatusPill, notify } from "../components/ui.tsx";
import { formatHoursAmount, formatShortDate, weekDates } from "../model.ts";
import type { OrgTimesheetRecord } from "../model.ts";
import { usePortal } from "../store.tsx";
import { sharedProjectsFor } from "../seed.ts";
import { API_ENABLED } from "../api/client.ts";
import { loadApiWeekDetail } from "../api/syncTimeSheets.ts";

type Line = { date: string; project: string; hours: number; note: string; billable: boolean };

/** Hours per project and day for one person's week, with approve / send back (comment) for the decider. */
export function TimesheetTeamDetail({ row, canDecide }: { row: OrgTimesheetRecord; canDecide: boolean }) {
  const { state, setOrgTimesheetStatus } = usePortal();
  const [apiLines, setApiLines] = useState<Line[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [comment, setComment] = useState("");

  useEffect(() => {
    if (!API_ENABLED) return;
    let stale = false;
    loadApiWeekDetail(row.id)
      .then((out) => {
        if (stale) return;
        setApiLines(
          out.entries.map((e) => ({ date: e.work_date, project: e.project_name || e.project_code, hours: e.hours, note: e.task, billable: e.billable })),
        );
      })
      .catch((err: unknown) => {
        if (!stale) setLoadError(err instanceof Error ? err.message : "Could not load this week.");
      });
    return () => {
      stale = true;
    };
  }, [row.id, row.status]);

  const localLines = useMemo<Line[]>(() => {
    if (API_ENABLED) return [];
    const projectName = (id: string) =>
      state.projects.find((p) => p.id === id)?.name ?? sharedProjectsFor(row.personId).find((p) => p.id === id)?.name ?? id;
    return state.timesheets
      .filter((s) => s.employeeId === row.personId && s.weekStart === row.weekStart)
      .flatMap((s) => s.entries.map((e) => ({ date: e.date, project: projectName(s.projectId), hours: e.hours, note: e.note, billable: e.billable })));
  }, [row.personId, row.weekStart, state.projects, state.timesheets]);

  const lines = API_ENABLED ? apiLines : localLines;
  const days = weekDates(row.weekStart);
  const projects = [...new Set((lines ?? []).map((l) => l.project))].sort();
  const cell = (project: string, day: string) =>
    (lines ?? []).filter((l) => l.project === project && l.date === day).reduce((a, l) => a + l.hours, 0);
  const dayTotal = (day: string) => (lines ?? []).filter((l) => l.date === day).reduce((a, l) => a + l.hours, 0);
  const total = (lines ?? []).reduce((a, l) => a + l.hours, 0);
  const billable = (lines ?? []).filter((l) => l.billable).reduce((a, l) => a + l.hours, 0);

  async function decide(status: "approved" | "draft") {
    if (status === "draft" && !comment.trim()) return "Add a comment saying what to change.";
    const error = await setOrgTimesheetStatus(row.id, status, comment.trim() || undefined);
    if (error) return error;
    setComment("");
    return null;
  }

  return (
    <div className="ts-team-detail">
      {loadError && <p className="note err">{loadError}</p>}
      {lines === null && !loadError && <p className="muted">Loading…</p>}
      {lines && lines.length === 0 && <p className="muted">No hours logged this week.</p>}
      {lines && lines.length > 0 && (
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Project</th>
                {days.map((d) => (
                  <th key={d}>{formatShortDate(d)}</th>
                ))}
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p}>
                  <td>{p}</td>
                  {days.map((d) => (
                    <td key={d}>{cell(p, d) ? formatHoursAmount(cell(p, d)) : "—"}</td>
                  ))}
                  <td>
                    <strong>{formatHoursAmount(days.reduce((a, d) => a + cell(p, d), 0))}</strong>
                  </td>
                </tr>
              ))}
              <tr>
                <td>
                  <strong>Day total</strong>
                </td>
                {days.map((d) => (
                  <td key={d}>
                    <strong>{dayTotal(d) ? formatHoursAmount(dayTotal(d)) : "—"}</strong>
                  </td>
                ))}
                <td>
                  <strong>{formatHoursAmount(total)}</strong>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {lines && lines.length > 0 && (
        <p className="muted">
          Billable {formatHoursAmount(billable)} · Non-billable {formatHoursAmount(total - billable)}
        </p>
      )}
      {row.decisionNote && row.status !== "submitted" && (
        <p className="muted">
          <StatusPill status={row.status === "draft" ? "sent back" : row.status} /> “{row.decisionNote}”
        </p>
      )}
      {row.status === "submitted" && canDecide && (
        <div className="form-actions">
          <input
            aria-label="Comment"
            placeholder="Comment (needed to send back)"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            style={{ minWidth: 260 }}
          />
          <ActionButton className="btn btn-tiny" success={`${row.name}'s timesheet approved.`} onAction={() => decide("approved")}>
            Approve
          </ActionButton>
          <ActionButton
            className="btn-ghost btn-tiny"
            success={`Sent back to ${row.name}.`}
            onError={(m) => notify(m, "err")}
            onAction={() => decide("draft")}
          >
            Send back
          </ActionButton>
        </div>
      )}
    </div>
  );
}
