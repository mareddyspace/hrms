import { Link } from "react-router-dom";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActionButton, Banner, Card, Field, Page, StatusBadge, StatusPill, SubmitButton, notify, useAction } from "../components/ui.tsx";
import { managementChain } from "../demoAccounts.ts";
import type { BackdatedLeavePermission, LeaveCode, LeaveHalf } from "../model.ts";
import {
  addDaysISO,
  backdatedPermissionFor,
  formatShortDate,
  holidaySet,
  holidaysForPerson,
  leaveNameFor,
  leaveRows,
  localPolicy,
  needsBackdatedPermission,
  plural,
  SICK_LEAVE_GRACE_DAYS,
  todayISO,
  workingDays,
} from "../model.ts";
import { usePortal } from "../store.tsx";
import { API_ENABLED } from "../api/client.ts";
import { apiLeaveAttachment, apiLeaveMeta } from "../api/portalSync.ts";
import { OptionalHolidaysCard } from "../features/workforce/OptionalHolidaysPage.tsx";
import { getPerson, listPeople, subscribePeople } from "../data/peopleLocal.ts";
import {
  LeaveBalanceCards,
  LeavePoliciesCard,
  LeaveRequestHistory,
  dateProblem,
  dayBreakdown,
  localPolicyLines,
  useHandoverOptions,
} from "./leaveParts.tsx";
import { scheduleForEmployee } from "../data/workSchedule.ts";
import { taskPersonById } from "../data/taskTeam.ts";
import { TEMPLATE_BLANKS_ERROR, hasTemplateBlanks, useTemplatedText } from "../data/requestTemplates.ts";
import "../styles/home-leave-desk.css";

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
    changeLeave,
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
  const [handoverTo, setHandoverTo] = useState("");
  const [attachment, setAttachment] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const people = useSyncExternalStore(subscribePeople, listPeople, listPeople);
  const handoverOptions = useHandoverOptions(people, { id: employee.id, managerId: approver?.id ?? getPerson(employee.id)?.managerId });
  const [halfPart, setHalfPart] = useState<LeaveHalf>("first");
  // Half days: one date only, and not for work-from-home types (you're working either way).
  const halfAllowed = Boolean(from) && from === to && code !== "wfh" && code !== "emergency_wfh";
  const half: LeaveHalf | undefined = halfAllowed && halfDay ? halfPart : undefined;
  const myHolidays = holidaysForPerson(state.holidays, employee.id);
  const days = from && to ? workingDays(from, to, holidaySet(myHolidays), activeOffs, half) : 0;
  const breakdown = dayBreakdown(from, to, myHolidays, activeOffs);
  const dateError = dateProblem(from, to, today, code);
  const selectedRow = formRows.find((row) => row.code === code);
  const overBalance = Boolean(selectedRow && code !== "unpaid" && days > selectedRow.available);
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
  ).sort((a, b) => b.from.localeCompare(a.from));
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
  // Managers: who in their team is away today or in the next two weeks (approved or still pending).
  const soon = addDaysISO(today, 14);
  const teamAway = state.leaveRequests
    .filter(
      (r) =>
        r.employeeId !== employee.id &&
        (r.status === "approved" || r.status === "pending") &&
        r.to >= today &&
        r.from <= soon &&
        (API_ENABLED ? Boolean(apiLeaveMeta.get(r.id)?.canDecide) || canDecideFor(r.employeeId) : canDecideFor(r.employeeId)),
    )
    .sort((a, b) => a.from.localeCompare(b.from));
  const isManager = teamAway.length > 0 || teamLeave.length > 0 || people.some((p) => p.id !== employee.id && canDecideFor(p.id));
  const upcomingHolidays = myHolidays.filter((h) => h.date >= today).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6);
  const balanceAfter = selectedRow && code !== "unpaid" ? selectedRow.available - days : null;
  const nameOf = (id: string) =>
    demoAccounts.find((a) => a.id === id)?.fullName ?? taskPersonById(id)?.fullName ?? getPerson(id)?.fullName ?? id;
  /** Working days of a request: the server's count in backend mode. */
  const daysOf = (id: string, local: () => number) => apiLeaveMeta.get(id)?.days ?? local();
  // A teammate's request is named for their country (a US "pto" is "Paid time off").
  const leaveName = (leaveCode: LeaveCode, employeeId?: string) =>
    (employeeId ? leaveNameFor(state.leavePolicies, leaveCode, employeeId) : undefined) ?? leaveTable.find((row) => row.code === leaveCode)?.name ?? leaveCode;
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
    setHandoverTo("");
    setAttachment(null);
    if (fileRef.current) fileRef.current.value = "";
    setLockedCode(null);
    setHalfDay(false);
    setHalfPart("first");
  }

  const applyAction = useAction();

  function pickFile(file: File | undefined) {
    if (!file) return setAttachment(null);
    if (!/^(application\/pdf|image\/(png|jpeg|gif|webp))$/.test(file.type)) {
      setMessage({ tone: "err", text: "Attach a PDF or an image (PNG, JPG)." });
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setMessage({ tone: "err", text: "The file is larger than 5 MB." });
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    setAttachment(file);
  }

  function startApply(next: LeaveCode) {
    setCode(next);
    fillReason(reasonForm, next);
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    formRef.current?.querySelector<HTMLInputElement>("input[type=date]")?.focus();
  }

  async function onSubmit(): Promise<boolean> {
    if (dateError) {
      setMessage({ tone: "err", text: dateError });
      return false;
    }
    if (from && to && days <= 0) {
      setMessage({ tone: "err", text: "Those dates have no working days (weekends and holidays are skipped)." });
      return false;
    }
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
    const handoverName = handoverOptions.find((p) => p.id === handoverTo)?.fullName;
    const error = await applyLeave({
      code,
      from,
      to,
      reason,
      half,
      ...(handoverTo ? { handoverTo, handoverName } : {}),
      ...(attachment ? { attachment } : {}),
    });
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

  async function openAttachment(id: string, name: string) {
    if (!API_ENABLED) {
      setMessage({ tone: "err", text: "The file is kept on the device it was added from." });
      return;
    }
    try {
      const url = URL.createObjectURL(await apiLeaveAttachment(id));
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setMessage({ tone: "err", text: e instanceof Error ? e.message : "Could not download the file." });
    }
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
      <nav className="lvx-holidays" aria-label="Upcoming holidays">
        <span className="lvx-holidays-label">Upcoming holidays · {employee.countryName || "your country"}</span>
        {upcomingHolidays.length ? (
          upcomingHolidays.map((h) => (
            <Link key={h.id} to="/holidays" className="lvx-holiday-chip">
              <strong>{formatShortDate(h.date)}</strong>
              <span>{h.name}</span>
            </Link>
          ))
        ) : (
          <span className="muted">No more holidays this year</span>
        )}
        <Link to="/holidays" className="lvx-holidays-all">
          Holiday calendar
        </Link>
      </nav>
      <div className="leave-layout">
        <div className="leave-main">
          <Card title={`Leave balance · ${year}`}>
            {/* Unpaid leave has no balance; it stays available in the apply form below. */}
            <LeaveBalanceCards rows={yearRows.filter((row) => row.code !== "unpaid")} showPending={hasApprover} onApply={startApply} />
          </Card>
          {isManager && (
            <Card
              title={`Team on leave · next 2 weeks (${teamAway.length})`}
              action={
                <Link to="/leave/team-calendar" className="quiet-link">
                  Team calendar
                </Link>
              }
            >
              {teamAway.length === 0 ? (
                <p className="note">Nobody in your team is away in the next two weeks.</p>
              ) : (
                <ul className="lvx-team-list">
                  {teamAway.slice(0, 10).map((r) => (
                    <li key={r.id}>
                      <strong>{nameOf(r.employeeId)}</strong>
                      <span className="muted">
                        {leaveName(r.code, r.employeeId)} · {r.from === r.to ? formatShortDate(r.from) : `${formatShortDate(r.from)} – ${formatShortDate(r.to)}`}
                        {r.from <= today ? " · away today" : ""}
                      </span>
                      <StatusPill status={r.status} />
                    </li>
                  ))}
                </ul>
              )}
              {teamAway.length > 10 && <p className="note">Showing 10 of {teamAway.length}.</p>}
            </Card>
          )}
          <Card title={hasApprover ? `My requests · ${year}` : `My leave · ${year}`}>
            <LeaveRequestHistory
              requests={requests}
              leaveName={(c) => leaveTable.find((row) => row.code === c)?.name ?? leaveName(c, employee.id)}
              daysOf={(request) =>
                daysOf(request.id, () =>
                  workingDays(request.from, request.to, holidaySet(myHolidays), activeOffs, request.half),
                )
              }
              approverName={approver?.fullName}
              today={today}
              onWithdraw={(request) => setLeaveStatus(request.id, "withdrawn")}
              onChange={API_ENABLED ? (request, input) => changeLeave(request.id, input) : undefined}
              onError={(error) => setMessage({ tone: "err", text: error })}
            />
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
                      {leaveName(p.code, p.employeeId)} · {formatShortDate(p.from)} – {formatShortDate(p.to)} ·{" "}
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
                      {leaveName(r.code, r.employeeId)} · {r.from === r.to ? formatShortDate(r.from) : `${formatShortDate(r.from)} – ${formatShortDate(r.to)}`} ·{" "}
                      {plural(daysOf(r.id, () => workingDays(r.from, r.to, holidaySet(holidaysForPerson(state.holidays, r.employeeId)), undefined, r.half)), "day")}
                      {r.half ? ` · ${halfLabel(r.half)}` : ""}
                    </span>
                    <span className="muted">Reason: {r.reason}</span>
                    {r.handoverName && <span className="muted">Work covered by {r.handoverName}</span>}
                    {r.attachmentName && (
                      <span className="muted">
                        File:{" "}
                        <button type="button" className="link-btn" onClick={() => void openAttachment(r.id, r.attachmentName!)}>
                          {r.attachmentName}
                        </button>
                      </span>
                    )}
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

        </div>
        <div className="leave-side" ref={formRef}>
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
                  {/* Optional holidays are picked from their own list below. */}
                  {formRows.filter((row) => row.code !== "optional").map((row) => (
                    <option key={row.code} value={row.code}>
                      {row.code === "unpaid" ? row.name : `${row.name} · ${row.available} available`}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="From">
                <input
                  type="date"
                  value={from}
                  max={code === "sick" ? today : undefined}
                  onChange={(event) => {
                    setFrom(event.target.value);
                    if (!to || to < event.target.value) setTo(event.target.value);
                  }}
                  required
                />
              </Field>
              <Field label="To">
                <input type="date" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} required />
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
              <Field label="Work covered by" wide>
                <select value={handoverTo} onChange={(event) => setHandoverTo(event.target.value)}>
                  <option value="">No one</option>
                  {handoverOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.fullName}
                      {p.designation ? ` · ${p.designation}` : ""}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Attachment" wide>
                <div className="lv-file">
                  <input
                    ref={fileRef}
                    type="file"
                    accept="application/pdf,image/png,image/jpeg,image/gif,image/webp"
                    aria-label="Attach a file"
                    onChange={(event) => pickFile(event.target.files?.[0])}
                  />
                  {attachment && (
                    <span className="muted">
                      {attachment.name} · {Math.max(1, Math.round(attachment.size / 1024))} KB{" "}
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() => {
                          setAttachment(null);
                          if (fileRef.current) fileRef.current.value = "";
                        }}
                      >
                        Remove
                      </button>
                    </span>
                  )}
                  <span className="muted">PDF or image, up to 5 MB{code === "sick" ? " (a medical certificate helps)" : ""}.</span>
                </div>
              </Field>
              <Field label="Reason" wide>
                <textarea
                  ref={reasonRef}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  onFocus={() => fillReasonIfEmpty(reasonForm, code)}
                />
              </Field>
            </div>
            <div className="lvx-summary" aria-live="polite">
              <div>
                <span>Dates</span>
                <strong>
                  {from && to ? (from === to ? formatShortDate(from) : `${formatShortDate(from)} – ${formatShortDate(to)}`) : "—"}
                </strong>
              </div>
              <div>
                <span>Leave days</span>
                <strong>
                  {days}
                  {half ? ` · ${halfLabel(half)}` : ""}
                </strong>
              </div>
              <div>
                <span>Available</span>
                <strong>{selectedRow && code !== "unpaid" ? selectedRow.available : "—"}</strong>
              </div>
              <div className={balanceAfter != null && balanceAfter < 0 ? "is-over" : undefined}>
                <span>Balance after</span>
                <strong>{balanceAfter != null ? balanceAfter : "Unpaid"}</strong>
              </div>
            </div>
            {breakdown.calendar > 0 && !half && (
              <p className="muted lvx-breakdown">
                {breakdown.calendar} calendar {breakdown.calendar === 1 ? "day" : "days"}
                {breakdown.weekends ? ` · ${breakdown.weekends} weekly off` : ""}
                {breakdown.holidays.length ? ` · ${breakdown.holidays.length} holiday` : ""} · weekly offs and holidays are not counted
              </p>
            )}
            {breakdown.holidays.length > 0 && (
              <p className="muted">Not counted: {breakdown.holidays.map((h) => `${h.name} (${formatShortDate(h.date)})`).join(", ")}</p>
            )}
            {dateError && <p className="note err">{dateError}</p>}
            {overBalance && selectedRow && (
              <p className="note warn">
                Only {selectedRow.available} {selectedRow.available === 1 ? "day" : "days"} of {selectedRow.name} available.
              </p>
            )}
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
          {leaveTable.some((row) => row.code === "optional" && row.quota > 0) && <OptionalHolidaysCard />}
          <LeavePoliciesCard
            countryName={employee.countryName || "your country"}
            local={localPolicyLines(state.leavePolicies, (p) => localPolicy(p, employee.countryCode as never))}
          />
        </div>
      </div>
    </Page>
  );
}
