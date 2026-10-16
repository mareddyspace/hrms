import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Banner, Card, Field, LeaveTable, Page, StatusBadge, StatusPill } from "../components/ui.tsx";
import { managementChain } from "../demoAccounts.ts";
import type { BackdatedLeavePermission, LeaveCode } from "../model.ts";
import {
  backdatedPermissionFor,
  formatShortDate,
  holidaySet,
  leaveRows,
  needsBackdatedPermission,
  SICK_LEAVE_GRACE_DAYS,
  todayISO,
  workingDays,
} from "../model.ts";
import { usePortal } from "../store.tsx";
import { taskPersonById } from "../data/taskTeam.ts";

const PERMISSION_LABEL: Record<BackdatedLeavePermission["status"], { text: string; tone: "ok" | "warn" | "danger" | "neutral" | "info" }> = {
  pending: { text: "Awaiting approval", tone: "warn" },
  approved: { text: "Approved — apply now", tone: "ok" },
  rejected: { text: "Declined", tone: "danger" },
  withdrawn: { text: "Withdrawn", tone: "neutral" },
  used: { text: "Leave applied", tone: "info" },
};

export function LeavePage() {
  const portal = usePortal();
  const {
    leaveTable,
    state,
    employee,
    demoAccounts,
    applyLeave,
    setLeaveStatus,
    requestBackdatedPermission,
    withdrawBackdatedPermission,
    decideBackdatedPermission,
    canDecideFor,
    hasApprover,
  } = portal;
  const today = todayISO();
  const approver = managementChain(employee.id, demoAccounts)[0];
  const years = useMemo(() => {
    const set = new Set<number>([new Date().getFullYear()]);
    for (const request of state.leaveRequests) {
      if (request.employeeId === employee.id) set.add(Number(request.from.slice(0, 4)));
    }
    return [...set].sort((a, b) => b - a);
  }, [employee.id, state.leaveRequests]);
  const [year, setYear] = useState(years[0] ?? new Date().getFullYear());
  const [code, setCode] = useState<LeaveCode>("pto");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  // Set when the form was filled from an approved permission: the permission only covers that leave type.
  const [lockedCode, setLockedCode] = useState<LeaveCode | null>(null);
  const days = from && to ? workingDays(from, to, holidaySet(state.holidays)) : 0;
  // Balances for the selected leave year (quotas reset every January).
  const yearRows = useMemo(
    () =>
      leaveRows(state.leavePolicies, state.leaveRequests, state.encashments, state.holidays, employee.id, undefined, year),
    [state.leavePolicies, state.leaveRequests, state.encashments, state.holidays, employee.id, year],
  );
  const requests = state.leaveRequests.filter(
    (request) => request.employeeId === employee.id && request.from.startsWith(String(year)),
  );
  // Past dates need permission from the reporting line before leave can be applied (recent sick leave excepted).
  const isBackdated = hasApprover && Boolean(from) && needsBackdatedPermission(code, from, today);
  const permission = isBackdated ? backdatedPermissionFor(state, employee.id, from, to || from, code) : undefined;
  const needsPermission = isBackdated && !permission;
  const recentSick = code === "sick" && Boolean(from) && from < today && !isBackdated;
  const myPermissions = state.backdatedPermissions.filter((p) => p.employeeId === employee.id);
  const teamPermissions = state.backdatedPermissions.filter((p) => p.status === "pending" && canDecideFor(p.employeeId));
  const teamLeave = state.leaveRequests.filter((r) => r.status === "pending" && canDecideFor(r.employeeId));
  const nameOf = (id: string) => demoAccounts.find((a) => a.id === id)?.fullName ?? taskPersonById(id)?.fullName ?? id;
  const leaveName = (leaveCode: LeaveCode) => leaveTable.find((row) => row.code === leaveCode)?.name ?? leaveCode;
  const [notes, setNotes] = useState<Record<string, string>>({});

  function resetForm() {
    setReason("");
    setFrom("");
    setTo("");
    setLockedCode(null);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (needsPermission) {
      const error = requestBackdatedPermission({ code, from, to, reason });
      setMessage(
        error
          ? { tone: "err", text: error }
          : {
              tone: "ok",
              text: `Permission request sent to ${approver?.fullName ?? "your manager"}. You can apply once it is approved.`,
            },
      );
      if (!error) resetForm();
      return;
    }
    const error = await applyLeave({ code, from, to, reason });
    setMessage(
      error
        ? { tone: "err", text: error }
        : {
            tone: "ok",
            text: hasApprover
              ? `Leave request submitted to ${approver?.fullName ?? "your manager"}.`
              : "Leave recorded and approved — there's no one above you to approve it.",
          },
    );
    if (!error) resetForm();
  }

  function applyWithPermission(p: BackdatedLeavePermission) {
    setCode(p.code);
    setLockedCode(p.code);
    setFrom(p.from);
    setTo(p.to);
    setReason(p.reason);
    setMessage({ tone: "ok", text: "Dates filled in from your approved permission. Review and submit." });
  }

  function decide(id: string, decision: "approved" | "rejected", kind: "permission" | "leave") {
    const note = notes[id];
    const run =
      kind === "permission" ? Promise.resolve(decideBackdatedPermission(id, decision, note)) : setLeaveStatus(id, decision, note);
    void run.then((error) => {
      setMessage(
        error
          ? { tone: "err", text: error }
          : { tone: "ok", text: decision === "approved" ? "Approved." : "Declined." },
      );
      if (!error) setNotes((prev) => ({ ...prev, [id]: "" }));
    });
  }

  return (
    <Page title="Leave & Absence" subtitle="Balances, requests and history.">
      <div className="year-bar" role="tablist" aria-label="Leave year">
        {years.map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={item === year}
            className={item === year ? "year-chip active" : "year-chip"}
            onClick={() => setYear(item)}
          >
            {item}
          </button>
        ))}
      </div>
      <div className="leave-layout">
        <div className="leave-main">
          <Card title={`Leave balance · ${year}`}>
            {/* Unpaid leave has no balance; it stays available in the apply form below. */}
            <LeaveTable rows={yearRows.filter((row) => row.code !== "unpaid")} showPending />
          </Card>
          {(teamPermissions.length > 0 || teamLeave.length > 0) && (
            <Card title={`Team approvals (${teamPermissions.length + teamLeave.length})`}>
              <ul className="approval-list">
                {teamPermissions.map((p) => (
                  <li key={p.id} className="approval-item">
                    <div className="row-between">
                      <strong>{p.employeeName}</strong>
                      <span className="pill pill-mandatory">Backdated leave permission</span>
                    </div>
                    <span>
                      {leaveName(p.code)} · {formatShortDate(p.from)} – {formatShortDate(p.to)} ·{" "}
                      {workingDays(p.from, p.to, holidaySet(state.holidays))} day(s) · asked {formatShortDate(p.requestedOn)}
                    </span>
                    <span className="muted">Reason: {p.reason}</span>
                    <div className="approval-actions">
                      <input
                        value={notes[p.id] ?? ""}
                        onChange={(e) => setNotes((prev) => ({ ...prev, [p.id]: e.target.value }))}
                        placeholder="Note to employee (optional)"
                        aria-label={`Note for ${p.employeeName}`}
                      />
                      <button type="button" className="btn btn-tiny" onClick={() => decide(p.id, "approved", "permission")}>
                        Approve
                      </button>
                      <button type="button" className="btn-ghost btn-tiny" onClick={() => decide(p.id, "rejected", "permission")}>
                        Decline
                      </button>
                    </div>
                  </li>
                ))}
                {teamLeave.map((r) => (
                  <li key={r.id} className="approval-item">
                    <div className="row-between">
                      <strong>{nameOf(r.employeeId)}</strong>
                      <span className="pill">Leave request</span>
                    </div>
                    <span>
                      {leaveName(r.code)} · {formatShortDate(r.from)} – {formatShortDate(r.to)} ·{" "}
                      {workingDays(r.from, r.to, holidaySet(state.holidays))} day(s)
                    </span>
                    <span className="muted">Reason: {r.reason}</span>
                    <div className="approval-actions">
                      <input
                        value={notes[r.id] ?? ""}
                        onChange={(e) => setNotes((prev) => ({ ...prev, [r.id]: e.target.value }))}
                        placeholder="Note to employee (optional)"
                        aria-label={`Note for ${nameOf(r.employeeId)}`}
                      />
                      <button type="button" className="btn btn-tiny" onClick={() => decide(r.id, "approved", "leave")}>
                        Approve
                      </button>
                      <button type="button" className="btn-ghost btn-tiny" onClick={() => decide(r.id, "rejected", "leave")}>
                        Decline
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {myPermissions.length > 0 && (
            <Card title="Backdated leave permissions">
              <ul className="approval-list">
                {myPermissions.map((p) => (
                  <li key={p.id} className="approval-item">
                    <div className="row-between">
                      <strong>
                        {leaveName(p.code)} · {formatShortDate(p.from)} – {formatShortDate(p.to)}
                      </strong>
                      <StatusBadge status={PERMISSION_LABEL[p.status].text} tone={PERMISSION_LABEL[p.status].tone} literal />
                    </div>
                    <span className="muted">
                      {p.decidedByName
                        ? `${p.status === "rejected" ? "Declined" : "Approved"} by ${p.decidedByName} on ${formatShortDate(p.decidedOn!)}`
                        : `Asked ${formatShortDate(p.requestedOn)} · with ${approver?.fullName ?? "your manager"}`}
                      {p.decisionNote ? ` · “${p.decisionNote}”` : ""}
                    </span>
                    {(p.status === "pending" || p.status === "approved") && (
                      <div className="approval-actions">
                        {p.status === "approved" && (
                          <button type="button" className="btn btn-tiny" onClick={() => applyWithPermission(p)}>
                            Apply for these dates
                          </button>
                        )}
                        {p.status === "pending" && (
                          <button
                            type="button"
                            className="btn-ghost btn-tiny"
                            onClick={() => {
                              const error = withdrawBackdatedPermission(p.id);
                              if (error) setMessage({ tone: "err", text: error });
                            }}
                          >
                            Withdraw
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card title={`My requests · ${year}`}>
            <div className="table-scroll">
              <table className="data requests">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Dates</th>
                    <th>Days</th>
                    <th>Reason</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {requests.length === 0 && (
                    <tr>
                      <td colSpan={6} className="muted">
                        No leave requests in {year}.
                      </td>
                    </tr>
                  )}
                  {requests.map((request) => {
                    const policy = leaveTable.find((row) => row.code === request.code);
                    const count = workingDays(request.from, request.to, holidaySet(state.holidays));
                    return (
                      <tr key={request.id}>
                        <td>{policy?.name ?? request.code}</td>
                        <td>
                          {formatShortDate(request.from)} – {formatShortDate(request.to)}
                        </td>
                        <td>{count}</td>
                        <td>{request.reason}</td>
                        <td>
                          <StatusPill status={request.status} />
                          {request.decidedByName && (
                            <span className="muted request-decision">
                              by {request.decidedByName}
                              {request.decisionNote ? ` · “${request.decisionNote}”` : ""}
                            </span>
                          )}
                        </td>
                        <td>
                          {(request.status === "pending" || (request.status === "approved" && request.from > today)) && (
                            <button
                              className="btn-ghost btn-tiny"
                              type="button"
                              onClick={async () => {
                                const error = await setLeaveStatus(request.id, "withdrawn");
                                if (error) setMessage({ tone: "err", text: error });
                              }}
                            >
                              {request.status === "pending" ? "Withdraw" : "Cancel leave"}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
        <Card title="Apply Leave">
          <form onSubmit={onSubmit}>
            <div className="form-grid">
              <Field label="Leave type" wide>
                <select
                  value={code}
                  disabled={lockedCode != null}
                  onChange={(event) => setCode(event.target.value as LeaveCode)}
                  title={lockedCode ? "Fixed by your approved permission" : undefined}
                >
                  {leaveTable.map((row) => (
                    <option key={row.code} value={row.code}>
                      {row.name} · {row.available} available
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="From">
                <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} required />
              </Field>
              <Field label="To">
                <input type="date" value={to} onChange={(event) => setTo(event.target.value)} required />
              </Field>
              <Field label="Reason" wide>
                <textarea value={reason} onChange={(event) => setReason(event.target.value)} />
              </Field>
            </div>
            <p className="note">Working days in this range: {days}. Weekends and holidays are skipped.</p>
            {needsPermission && (
              <p className="note warn">
                These dates are in the past. {approver?.fullName ?? "Your manager"} must approve before you can apply.
              </p>
            )}
            {recentSick && (
              <p className="note">Sick leave can be applied up to {SICK_LEAVE_GRACE_DAYS} days after the fact.</p>
            )}
            {permission && (
              <p className="note ok">
                Approved by {permission.decidedByName} on {formatShortDate(permission.decidedOn!)} — you can apply for these dates.
              </p>
            )}
            <div className="form-actions">
              <button className="btn" type="submit">
                {needsPermission ? "Request permission" : "Submit request"}
              </button>
            </div>
            <Banner message={message} />
          </form>
        </Card>
      </div>
    </Page>
  );
}
