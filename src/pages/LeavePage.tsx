import { Link } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import { ActionButton, Banner, Card, Field, LeaveTable, Page, StatusBadge, StatusPill, SubmitButton, notify, useAction } from "../components/ui.tsx";
import { managementChain } from "../demoAccounts.ts";
import type { BackdatedLeavePermission, LeaveCode, LeaveHalf } from "../model.ts";
import {
  backdatedPermissionFor,
  formatShortDate,
  holidaySet,
  holidaysForPerson,
  leaveRows,
  needsBackdatedPermission,
  plural,
  SICK_LEAVE_GRACE_DAYS,
  todayISO,
  workingDays,
} from "../model.ts";
import { usePortal } from "../store.tsx";
import { API_ENABLED } from "../api/client.ts";
import { apiLeaveMeta } from "../api/portalSync.ts";
import { getPerson } from "../data/peopleLocal.ts";
import { scheduleForEmployee } from "../data/workSchedule.ts";
import { taskPersonById } from "../data/taskTeam.ts";
import { TEMPLATE_BLANKS_ERROR, hasTemplateBlanks, useTemplatedText } from "../data/requestTemplates.ts";

const PERMISSION_LABEL: Record<BackdatedLeavePermission["status"], { text: string; tone: "ok" | "warn" | "danger" | "neutral" | "info" }> = {
  pending: { text: "Awaiting approval", tone: "warn" },
  approved: { text: "Approved — apply now", tone: "ok" },
  rejected: { text: "Declined", tone: "danger" },
  withdrawn: { text: "Withdrawn", tone: "neutral" },
  used: { text: "Leave applied", tone: "info" },
};

function halfLabel(half: LeaveHalf): string {
  return half === "first" ? "First half" : "Second half";
}

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
  const activeOffs = scheduleForEmployee({
    shiftName: employee.shiftName,
    shiftHours: employee.shiftHours,
    countryCode: employee.countryCode,
  }).weeklyOffDays;
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
  // Balances in the dropdown follow the year of the chosen start date.
  const formYear = from ? Number(from.slice(0, 4)) : Number(todayISO().slice(0, 4));
  const formRows = API_ENABLED && formYear === new Date().getFullYear() ? leaveTable : leaveRows(
    state.leavePolicies,
    state.leaveRequests,
    state.encashments,
    state.holidays,
    employee.id,
    scheduleForEmployee({ shiftName: employee.shiftName, shiftHours: employee.shiftHours, countryCode: employee.countryCode })
      .weeklyOffDays,
    formYear,
  );
  const [to, setTo] = useState("");
  const {
    value: reason,
    setValue: setReason,
    ref: reasonRef,
    fill: fillReason,
    fillIfEmpty: fillReasonIfEmpty,
    swapIfAuto: swapReasonIfAuto,
    reset: resetReason,
  } = useTemplatedText();
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  // Set when the form was filled from an approved permission: the permission only covers that leave type.
  const [lockedCode, setLockedCode] = useState<LeaveCode | null>(null);
  const [halfDay, setHalfDay] = useState(false);
  const [halfPart, setHalfPart] = useState<LeaveHalf>("first");
  // Half days: one date only, and not for work-from-home types (you're working either way).
  const halfAllowed = Boolean(from) && from === to && code !== "wfh" && code !== "emergency_wfh";
  const half: LeaveHalf | undefined = halfAllowed && halfDay ? halfPart : undefined;
  const days =
    from && to ? workingDays(from, to, holidaySet(holidaysForPerson(state.holidays, employee.id)), activeOffs, half) : 0;
  // Balances for the selected leave year (quotas reset every January).
  const yearRows = useMemo(
    () =>
      // Backend mode: this year's balances come from the server.
      API_ENABLED && year === new Date().getFullYear()
        ? leaveTable
        : leaveRows(state.leavePolicies, state.leaveRequests, state.encashments, state.holidays, employee.id, activeOffs, year),
    [state.leavePolicies, state.leaveRequests, state.encashments, state.holidays, employee.id, year, leaveTable],
  );
  const requests = state.leaveRequests.filter(
    (request) => request.employeeId === employee.id && request.from.startsWith(String(year)),
  );
  // Past dates need permission from the reporting line before leave can be applied (recent sick leave excepted).
  // Backend mode: the server checks past dates itself (no separate permission step).
  const isBackdated = !API_ENABLED && hasApprover && Boolean(from) && needsBackdatedPermission(code, from, today);
  const permission = isBackdated ? backdatedPermissionFor(state, employee.id, from, to || from, code) : undefined;
  const needsPermission = isBackdated && !permission;
  const recentSick = code === "sick" && Boolean(from) && from < today && !isBackdated;
  const myPermissions = state.backdatedPermissions.filter((p) => p.employeeId === employee.id);
  const teamPermissions = state.backdatedPermissions.filter((p) => p.status === "pending" && canDecideFor(p.employeeId));
  const teamLeave = state.leaveRequests.filter(
    (r) => r.status === "pending" && (API_ENABLED ? Boolean(apiLeaveMeta.get(r.id)?.canDecide) : canDecideFor(r.employeeId)),
  );
  const nameOf = (id: string) =>
    demoAccounts.find((a) => a.id === id)?.fullName ?? taskPersonById(id)?.fullName ?? getPerson(id)?.fullName ?? id;
  /** Working days of a request: the server's count in backend mode. */
  const daysOf = (id: string, local: () => number) => apiLeaveMeta.get(id)?.days ?? local();
  const leaveName = (leaveCode: LeaveCode) => leaveTable.find((row) => row.code === leaveCode)?.name ?? leaveCode;
  const [notes, setNotes] = useState<Record<string, string>>({});
  // Past dates turn the form into a permission request, which has its own starter text.
  const reasonForm = needsPermission ? "leavePermission" : "leave";
  useEffect(() => {
    swapReasonIfAuto(reasonForm, code);
    // Only react to the form switching between leave and permission request.
  }, [reasonForm]);

  function resetForm() {
    resetReason();
    setFrom("");
    setTo("");
    setLockedCode(null);
    setHalfDay(false);
    setHalfPart("first");
  }

  const applyAction = useAction();

  async function onSubmit(): Promise<boolean> {
    if (hasTemplateBlanks(reason)) {
      setMessage({ tone: "err", text: TEMPLATE_BLANKS_ERROR });
      return false;
    }
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
      if (error) return false;
      notify(`Permission request sent to ${approver?.fullName ?? "your manager"}.`);
      resetForm();
      return true;
    }
    const error = await applyLeave({ code, from, to, reason, half });
    setMessage(
      error
        ? { tone: "err", text: error }
        : {
            tone: "ok",
            text: hasApprover
              ? `Leave request sent to ${approver?.fullName ?? "your manager"} for approval.`
              : "Leave added to your calendar.",
          },
    );
    if (error) return false;
    notify(hasApprover ? `Leave request sent to ${approver?.fullName ?? "your manager"} for approval.` : "Leave added to your calendar.");
    resetForm();
    return true;
  }

  function applyWithPermission(p: BackdatedLeavePermission) {
    setCode(p.code);
    setLockedCode(p.code);
    setFrom(p.from);
    setTo(p.to);
    resetReason(p.reason);
    setMessage({ tone: "ok", text: "Dates filled in. Review and submit." });
  }

  function decide(id: string, decision: "approved" | "rejected", kind: "permission" | "leave", who?: string) {
    const note = notes[id];
    const run =
      kind === "permission" ? Promise.resolve(decideBackdatedPermission(id, decision, note)) : setLeaveStatus(id, decision, note);
    return run.then((error) => {
      setMessage(
        error
          ? { tone: "err", text: error }
          : { tone: "ok", text: decision === "approved" ? "Approved." : "Declined." },
      );
      if (!error) {
        setNotes((prev) => ({ ...prev, [id]: "" }));
        notify(`${kind === "permission" ? "Permission" : "Leave"} ${decision === "approved" ? "approved" : "declined"}${who ? ` for ${who}` : ""}.`);
      }
      return error;
    });
  }

  return (
    <Page
      title="Leave & holidays"
      action={
        <Link className="btn-ghost" to="/leave/team-calendar">
          Team calendar
        </Link>
      }
    >
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
            <LeaveTable rows={yearRows.filter((row) => row.code !== "unpaid")} showPending={hasApprover} />
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
                      {plural(workingDays(p.from, p.to, holidaySet(holidaysForPerson(state.holidays, p.employeeId))), "day")} · asked {formatShortDate(p.requestedOn)}
                    </span>
                    <span className="muted">Reason: {p.reason}</span>
                    <div className="approval-actions">
                      <input
                        value={notes[p.id] ?? ""}
                        onChange={(e) => setNotes((prev) => ({ ...prev, [p.id]: e.target.value }))}
                        placeholder="Note to employee (optional)"
                        aria-label={`Note for ${p.employeeName}`}
                      />
                      <ActionButton className="btn btn-tiny" onAction={() => decide(p.id, "approved", "permission", p.employeeName)}>
                        Approve
                      </ActionButton>
                      <ActionButton className="btn-ghost btn-tiny" onAction={() => decide(p.id, "rejected", "permission", p.employeeName)}>
                        Decline
                      </ActionButton>
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
                      {plural(daysOf(r.id, () => workingDays(r.from, r.to, holidaySet(holidaysForPerson(state.holidays, r.employeeId)), undefined, r.half)), "day")}
                      {r.half ? ` · ${halfLabel(r.half)}` : ""}
                    </span>
                    <span className="muted">Reason: {r.reason}</span>
                    {r.approvalProgress && <span className="muted">{r.approvalProgress}</span>}
                    <div className="approval-actions">
                      <input
                        value={notes[r.id] ?? ""}
                        onChange={(e) => setNotes((prev) => ({ ...prev, [r.id]: e.target.value }))}
                        placeholder="Note to employee (optional)"
                        aria-label={`Note for ${nameOf(r.employeeId)}`}
                      />
                      <ActionButton className="btn btn-tiny" onAction={() => decide(r.id, "approved", "leave", nameOf(r.employeeId))}>
                        Approve
                      </ActionButton>
                      <ActionButton className="btn-ghost btn-tiny" onAction={() => decide(r.id, "rejected", "leave", nameOf(r.employeeId))}>
                        Decline
                      </ActionButton>
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
                          <ActionButton
                            className="btn-ghost btn-tiny"
                            success="Permission request withdrawn."
                            onError={(error) => setMessage({ tone: "err", text: error })}
                            onAction={() => withdrawBackdatedPermission(p.id)}
                          >
                            Withdraw
                          </ActionButton>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card title={hasApprover ? `My requests · ${year}` : `My leave · ${year}`}>
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
                    const count = daysOf(request.id, () =>
                      workingDays(
                        request.from,
                        request.to,
                        holidaySet(holidaysForPerson(state.holidays, employee.id)),
                        activeOffs,
                        request.half,
                      ),
                    );
                    return (
                      <tr key={request.id}>
                        <td>{policy?.name ?? request.code}</td>
                        <td>
                          {request.half
                            ? `${formatShortDate(request.from)} · ${halfLabel(request.half)}`
                            : `${formatShortDate(request.from)} – ${formatShortDate(request.to)}`}
                        </td>
                        <td>{count}</td>
                        <td>{request.reason}</td>
                        <td>
                          <StatusPill status={request.status} />
                          {request.status === "pending" && request.approvalProgress && (
                            <span className="muted request-decision">{request.approvalProgress}</span>
                          )}
                          {request.decidedByName && (
                            <span className="muted request-decision">
                              by {request.decidedByName}
                              {request.decisionNote ? ` · “${request.decisionNote}”` : ""}
                            </span>
                          )}
                        </td>
                        <td>
                          {(request.status === "pending" || (request.status === "approved" && request.from > today)) && (
                            <ActionButton
                              className="btn-ghost btn-tiny"
                              success={request.status === "pending" ? "Leave request withdrawn." : "Leave cancelled."}
                              onError={(error) => setMessage({ tone: "err", text: error })}
                              onAction={() => setLeaveStatus(request.id, "withdrawn")}
                            >
                              {request.status === "pending" ? "Withdraw" : "Cancel leave"}
                            </ActionButton>
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
        <Card title={hasApprover ? "Apply for leave" : "Record leave"}>
          {hasApprover && approver && (
            <p className="muted" style={{ marginTop: 0 }}>
              <Link to={`/mail?compose=manager&subject=${encodeURIComponent("Leave request discussion")}`}>
                Mail {approver.fullName}
              </Link>
            </p>
          )}
          <form onSubmit={applyAction.submit(onSubmit)}>
            <div className="form-grid">
              <Field label="Leave type" wide>
                <select
                  value={code}
                  disabled={lockedCode != null}
                  onChange={(event) => {
                    setCode(event.target.value as LeaveCode);
                    fillReason(reasonForm, event.target.value);
                  }}
                  title={lockedCode ? "Fixed by your approved permission" : undefined}
                >
                  {formRows.map((row) => (
                    <option key={row.code} value={row.code}>
                      {row.code === "unpaid" ? row.name : `${row.name} · ${row.available} available`}
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
              {halfAllowed && (
                <Field label="Half day" wide>
                  <div className="row-between" style={{ justifyContent: "flex-start", gap: 12, flexWrap: "wrap" }}>
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <input type="checkbox" checked={halfDay} onChange={(event) => setHalfDay(event.target.checked)} />
                      Half day
                    </label>
                    {halfDay && (
                      <select
                        value={halfPart}
                        onChange={(event) => setHalfPart(event.target.value as LeaveHalf)}
                        aria-label="Which half"
                      >
                        <option value="first">First half</option>
                        <option value="second">Second half</option>
                      </select>
                    )}
                  </div>
                </Field>
              )}
              <Field label="Reason" wide>
                <textarea
                  ref={reasonRef}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  onFocus={() => fillReasonIfEmpty(reasonForm, code)}
                />
              </Field>
            </div>
            <p className="note">
              Working days: {days}
              {half ? ` (${halfLabel(half)})` : ""}.
            </p>
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
              <SubmitButton action={applyAction}>
                {needsPermission ? "Request permission" : hasApprover ? "Submit request" : "Record leave"}
              </SubmitButton>
            </div>
            <Banner message={message} />
          </form>
        </Card>
      </div>
    </Page>
  );
}
