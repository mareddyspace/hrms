/**
 * Pieces of the Leave & holidays page: balance cards, the working-day breakdown of the apply form,
 * request history with an approval timeline, upcoming holidays and the leave policies.
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ActionButton, Card, EmptyState, StatusPill, notify } from "../components/ui.tsx";
import { API_ENABLED, api, type LeavePolicyOut } from "../api/client.ts";
import { apiLeaveAttachment } from "../api/portalSync.ts";
import {
  formatShortDate,
  parseISODate,
  toISO,
  type Holiday,
  type LeaveCode,
  type LeaveHalf,
  type LeavePolicy,
  type LeaveRequest,
  type LeaveRow,
} from "../model.ts";
import "./leave.css";

const fmtDays = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/* ───────── Balance cards ───────── */

export function LeaveBalanceCards({ rows, showPending, onApply }: { rows: LeaveRow[]; showPending: boolean; onApply: (code: LeaveCode) => void }) {
  if (!rows.length) return <EmptyState title="No leave types" description="No leave policy applies to you yet." />;
  return (
    <div className="lv-balances">
      {rows.map((row) => {
        const carried = row.carriedOver ?? 0;
        const allowed = Math.max(0, row.quota - carried);
        const pct = row.quota > 0 ? Math.min(100, Math.round((100 * (row.utilized + row.pending)) / row.quota)) : 0;
        return (
          <article key={row.code} className="lv-balance">
            <header>
              <strong>{row.name}</strong>
              <button type="button" className="link-btn" onClick={() => onApply(row.code)} aria-label={`Apply for ${row.name}`}>
                Apply
              </button>
            </header>
            <p className="lv-available">
              {fmtDays(row.available)}
              <span> available</span>
            </p>
            <div className="lv-bar" aria-hidden="true">
              <span style={{ width: `${pct}%` }} />
            </div>
            <dl>
              <div>
                <dt>Allowed</dt>
                <dd>{fmtDays(allowed)}</dd>
              </div>
              <div>
                <dt>Carried forward</dt>
                <dd>{fmtDays(carried)}</dd>
              </div>
              <div>
                <dt>Used</dt>
                <dd>{fmtDays(row.utilized)}</dd>
              </div>
              {showPending && (
                <div>
                  <dt>Pending</dt>
                  <dd>{fmtDays(row.pending)}</dd>
                </div>
              )}
            </dl>
          </article>
        );
      })}
    </div>
  );
}

/* ───────── Working-day breakdown ───────── */

export function dayBreakdown(from: string, to: string, holidays: Holiday[], weeklyOffs: number[]) {
  const out = { calendar: 0, weekends: 0, holidays: [] as Holiday[] };
  if (!from || !to || to < from) return out;
  const byDate = new Map(holidays.map((h) => [h.date, h]));
  for (let d = parseISODate(from); toISO(d) <= to; d.setDate(d.getDate() + 1)) {
    const iso = toISO(d);
    out.calendar += 1;
    if (weeklyOffs.includes(d.getDay())) out.weekends += 1;
    else if (byDate.has(iso)) out.holidays.push(byDate.get(iso)!);
    if (out.calendar > 400) break;
  }
  return out;
}

/** Problems with the chosen dates, shown before the form is sent. */
export function dateProblem(from: string, to: string, today: string, code: string): string | null {
  if (!from || !to) return null;
  if (to < from) return "The end date is before the start date.";
  if (from.slice(0, 4) !== to.slice(0, 4)) return "Leave can't cross into the next year. Split it into two requests.";
  const span = (parseISODate(to).getTime() - parseISODate(from).getTime()) / 86400000;
  if (span > 90) return "Choose at most 90 days at a time.";
  if (code === "sick" && from > today) return "Sick leave can't be booked in advance.";
  return null;
}

/* ───────── Request history ───────── */

function halfLabel(half: LeaveHalf): string {
  return half === "first" ? "First half" : "Second half";
}

function datesText(r: LeaveRequest): string {
  if (r.half) return `${formatShortDate(r.from)} · ${halfLabel(r.half)}`;
  return r.from === r.to ? formatShortDate(r.from) : `${formatShortDate(r.from)} – ${formatShortDate(r.to)}`;
}

type TimelineStep = { label: string; detail?: string; tone: "done" | "current" | "rejected" | "waiting" };

function timelineFor(r: LeaveRequest, approverName?: string): TimelineStep[] {
  const steps: TimelineStep[] = [{ label: "Applied", detail: formatShortDate(r.appliedOn), tone: "done" }];
  if (r.approvalSteps?.steps.length) {
    for (const s of r.approvalSteps.steps) {
      const d = s.decisions[s.decisions.length - 1];
      steps.push({
        label: `${s.label}${d ? (d.decision === "approve" ? " approved" : d.decision === "reject" ? " declined" : "") : ""}`,
        detail: d
          ? [d.by, d.at ? formatShortDate(d.at.slice(0, 10)) : "", d.note ? `“${d.note}”` : ""].filter(Boolean).join(" · ")
          : s.status === "current"
            ? `Waiting for ${s.approvers.join(", ") || "approver"}`
            : "Not reached yet",
        tone: s.status === "done" ? "done" : s.status === "rejected" ? "rejected" : s.status === "current" ? "current" : "waiting",
      });
    }
  } else if (r.status === "pending") {
    steps.push({ label: "Manager review", detail: `Waiting for ${approverName ?? "your manager"}`, tone: "current" });
  } else if (r.decidedByName) {
    steps.push({
      label: r.status === "rejected" ? "Declined" : r.status === "withdrawn" ? "Closed" : "Approved",
      detail: [r.decidedByName, r.decidedOn ? formatShortDate(r.decidedOn) : "", r.decisionNote ? `“${r.decisionNote}”` : ""].filter(Boolean).join(" · "),
      tone: r.status === "rejected" ? "rejected" : "done",
    });
  } else if (r.status === "approved") {
    steps.push({ label: "Approved", tone: "done" });
  }
  if (r.status === "withdrawn") steps.push({ label: "Withdrawn", tone: "waiting" });
  return steps;
}

export function LeaveRequestHistory({
  requests,
  leaveName,
  daysOf,
  approverName,
  today,
  onWithdraw,
  onChange,
  onError,
}: {
  requests: LeaveRequest[];
  leaveName: (code: LeaveCode) => string;
  daysOf: (r: LeaveRequest) => number;
  approverName?: string;
  today: string;
  onWithdraw: (r: LeaveRequest) => Promise<string | null>;
  /** Leave correction (backend mode): new dates or reason; the change is approved again. */
  onChange?: (r: LeaveRequest, input: { from: string; to: string; reason: string }) => Promise<string | null>;
  onError: (message: string) => void;
}) {
  const [changing, setChanging] = useState<{ id: string; from: string; to: string; reason: string } | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const types = [...new Set(requests.map((r) => r.code))];
  const rows = requests.filter((r) => {
    if (status && r.status !== status) return false;
    if (type && r.code !== type) return false;
    const text = `${leaveName(r.code)} ${r.reason} ${r.from} ${r.to} ${r.status} ${r.decisionNote ?? ""} ${r.handoverName ?? ""}`.toLowerCase();
    return !q.trim() || text.includes(q.trim().toLowerCase());
  });

  async function download(r: LeaveRequest) {
    if (!API_ENABLED) {
      onError("The file is kept on the device it was added from.");
      return;
    }
    try {
      const blob = await apiLeaveAttachment(r.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = r.attachmentName ?? "attachment";
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify("File downloaded.");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not download the file.");
    }
  }

  return (
    <>
      <div className="lv-filters">
        <label className="filter-label">
          Search
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type, reason, date…" />
        </label>
        <label className="filter-label">
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Declined</option>
            <option value="withdrawn">Withdrawn</option>
          </select>
        </label>
        <label className="filter-label">
          Type
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All</option>
            {types.map((code) => (
              <option key={code} value={code}>
                {leaveName(code)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="table-scroll">
        <table className="data requests">
          <thead>
            <tr>
              <th>Type</th>
              <th>Dates</th>
              <th>Days</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  {requests.length ? "No requests match." : "No leave requests yet."}
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const expanded = open === r.id;
              const canWithdraw = r.status === "pending" || (r.status === "approved" && r.from > today);
              return (
                <Fragment key={r.id}>
                  <tr className={expanded ? "row-active" : undefined}>
                    <td>{leaveName(r.code)}</td>
                    <td>{datesText(r)}</td>
                    <td>{fmtDays(daysOf(r))}</td>
                    <td>
                      <StatusPill status={r.status} />
                      {r.status === "pending" && r.approvalProgress && <span className="muted request-decision">{r.approvalProgress}</span>}
                    </td>
                    <td className="lv-row-actions">
                      <button type="button" className="btn-ghost btn-tiny" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : r.id)}>
                        {expanded ? "Hide" : "Details"}
                      </button>
                      {canWithdraw && (
                        <ActionButton
                          className="btn-ghost btn-tiny"
                          success={r.status === "pending" ? "Leave request withdrawn." : "Leave cancelled."}
                          onError={onError}
                          onAction={() => onWithdraw(r)}
                        >
                          {r.status === "pending" ? "Withdraw" : "Cancel leave"}
                        </ActionButton>
                      )}
                      {canWithdraw && onChange && (
                        <button type="button" className="btn-ghost btn-tiny" onClick={() => setChanging(changing?.id === r.id ? null : { id: r.id, from: r.from, to: r.to, reason: r.reason })}>
                          {changing?.id === r.id ? "Keep as is" : "Change dates"}
                        </button>
                      )}
                    </td>
                  </tr>
                  {changing?.id === r.id && onChange && (
                    <tr className="lv-detail-row">
                      <td colSpan={5}>
                        <div className="lv-detail lv-change">
                          <label>
                            <span className="muted">From</span>
                            <input type="date" value={changing.from} min={today} onChange={(e) => setChanging({ ...changing, from: e.target.value })} />
                          </label>
                          <label>
                            <span className="muted">To</span>
                            <input type="date" value={changing.to} min={changing.from} onChange={(e) => setChanging({ ...changing, to: e.target.value })} />
                          </label>
                          <label>
                            <span className="muted">Reason</span>
                            <input value={changing.reason} maxLength={500} onChange={(e) => setChanging({ ...changing, reason: e.target.value })} />
                          </label>
                          <ActionButton
                            className="btn btn-tiny"
                            success="Leave changed and sent for approval again."
                            onError={onError}
                            onAction={async () => {
                              const error = await onChange(r, { from: changing.from, to: changing.to, reason: changing.reason });
                              if (!error) setChanging(null);
                              return error;
                            }}
                          >
                            Save change
                          </ActionButton>
                          <span className="muted">The new dates go to {approverName ?? "your approver"} again.</span>
                        </div>
                      </td>
                    </tr>
                  )}
                  {expanded && (
                    <tr className="lv-detail-row">
                      <td colSpan={5}>
                        <div className="lv-detail">
                          <div>
                            <p>
                              <span className="muted">Reason</span> {r.reason || "—"}
                            </p>
                            {r.handoverName && (
                              <p>
                                <span className="muted">Work covered by</span> {r.handoverName}
                              </p>
                            )}
                            {r.attachmentName && (
                              <p>
                                <span className="muted">File</span>{" "}
                                <button type="button" className="link-btn" onClick={() => void download(r)}>
                                  {r.attachmentName}
                                </button>
                              </p>
                            )}
                          </div>
                          <ol className="lv-timeline" aria-label="Approval timeline">
                            {timelineFor(r, approverName).map((s, i) => (
                              <li key={i} className={`is-${s.tone}`}>
                                <strong>{s.label}</strong>
                                {s.detail && <span className="muted">{s.detail}</span>}
                              </li>
                            ))}
                          </ol>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ───────── Holidays ───────── */

export function UpcomingHolidaysCard({ holidays, today, countryName }: { holidays: Holiday[]; today: string; countryName: string }) {
  const upcoming = holidays.filter((h) => h.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  const next = upcoming[0];
  const daysTo = next ? Math.round((parseISODate(next.date).getTime() - parseISODate(today).getTime()) / 86400000) : 0;
  return (
    <Card title={`Holidays · ${countryName}`} action={<Link to="/holidays">Holiday calendar</Link>}>
      {!next ? (
        <EmptyState title="No more holidays this year" />
      ) : (
        <div className="stack">
          <div className="lv-next-holiday">
            <span className="muted">Next holiday</span>
            <strong>{next.name}</strong>
            <span>
              {parseISODate(next.date).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })} ·{" "}
              {daysTo === 0 ? "today" : daysTo === 1 ? "tomorrow" : `in ${daysTo} days`}
            </span>
          </div>
          <ul className="lv-holiday-list">
            {upcoming.slice(1, 6).map((h) => (
              <li key={h.id}>
                <span>{formatShortDate(h.date)}</span>
                <span>{h.name}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

/* ───────── Policies ───────── */

type PolicyLine = { code: string; name: string; quota: number; carry: number; accrual: string; half: boolean };

export function LeavePoliciesCard({ local, countryName }: { local: PolicyLine[]; countryName: string }) {
  const [remote, setRemote] = useState<PolicyLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!API_ENABLED) return;
    let live = true;
    api
      .get<LeavePolicyOut[]>("/leave/policies")
      .then((rows) => {
        if (live)
          setRemote(rows.map((p) => ({ code: p.code, name: p.name, quota: p.quota, carry: p.carry_forward_max, accrual: p.accrual, half: p.half_day_allowed })));
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : "Could not load the policies."));
    return () => {
      live = false;
    };
  }, []);
  const rows = (API_ENABLED ? remote : local) ?? [];
  return (
    <Card title={`Leave policies · ${countryName}`}>
      {error && <p className="note err">{error}</p>}
      {!rows.length && !error ? (
        <p className="muted">{API_ENABLED && !remote ? "Loading…" : "No policies."}</p>
      ) : (
        <ul className="lv-policies">
          {rows.map((p) => (
            <li key={p.code}>
              <strong>{p.name}</strong>
              <span className="muted">
                {p.quota > 0 ? `${fmtDays(p.quota)} days a year` : "As earned"}
                {p.accrual === "monthly" ? " · earned monthly" : ""}
                {p.carry ? ` · carry forward up to ${fmtDays(p.carry)}` : " · no carry forward"}
                {p.half ? " · half days allowed" : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="note">Weekends and public holidays are not counted as leave days. Sick leave can be applied up to 7 days after.</p>
    </Card>
  );
}

export function localPolicyLines(policies: LeavePolicy[], localName: (p: LeavePolicy) => LeavePolicy): PolicyLine[] {
  return policies
    .map(localName)
    .filter((p) => p.quota > 0)
    .map((p) => ({
      code: p.code,
      name: p.name,
      quota: p.quota,
      carry: p.carryForwardMax ?? 0,
      accrual: p.accrual ?? "yearly",
      half: p.code !== "wfh" && p.code !== "emergency_wfh" && p.code !== "optional",
    }));
}

/** Colleagues who can cover: same manager, the manager, and own reports (active people only). */
export function useHandoverOptions(
  people: { id: string; fullName: string; managerId?: string; employmentStatus?: string; designation?: string }[],
  me: { id: string; managerId?: string },
) {
  return useMemo(() => {
    const active = people.filter((p) => p.id !== me.id && p.employmentStatus !== "Terminated");
    const close = active.filter(
      (p) => (me.managerId && (p.managerId === me.managerId || p.id === me.managerId)) || p.managerId === me.id,
    );
    return close.sort((a, b) => a.fullName.localeCompare(b.fullName)).slice(0, 60);
  }, [people, me.id, me.managerId]);
}
