import { useMemo, useState, useSyncExternalStore } from "react";
import { decideCorrection, getAttendanceState, subscribeAttendance } from "../data/attendanceLocal.ts";
import { managementChain } from "../demoAccounts.ts";
import {
  compOffCandidates,
  decideSwap,
  getShiftState,
  grantCompOff,
  respondSwap,
  shiftById,
  subscribeShifts,
} from "../features/workforce/shiftsStore.ts";
import { money } from "../countryPay.ts";
import { Banner, Card, EmptyState, Page, StatusBadge, Tabs } from "../components/ui.tsx";
import { listPeople, subscribePeople } from "../data/peopleLocal.ts";
import { taskPersonById } from "../data/taskTeam.ts";
import { addDaysISO, formatShortDate, holidaySet, holidaysForPerson, parseISODate, todayISO, workingDays } from "../model.ts";
import type { DecisionInfo, PortalState } from "../model.ts";
import { usePortal } from "../store.tsx";
import {
  activeDelegationFor,
  chainIds,
  covers,
  delegatedAuthority,
  getDelegationState,
  hasReports,
  isAboveInLine,
  noteLeaves,
  onBehalfNote,
  parseOnBehalf,
  personLabel,
  scopeText,
  subscribeDelegations,
  type DelegationScope,
} from "../data/delegations.ts";
import { DelegationSettings } from "./DelegationSettings.tsx";

/** Which delegation scope (§25) a request kind falls under. */
function scopeOf(kind: string): DelegationScope {
  switch (kind) {
    case "Leave":
    case "Backdated leave permission":
    case "Leave encashment":
      return "leave";
    case "Expense claim":
    case "Reimbursement":
    case "Cash advance":
      return "expenses";
    case "Timesheet":
      return "timesheets";
    case "Attendance correction":
      return "attendance";
    default:
      return "others";
  }
}

/** Waiting longer than the SLA flags a request as overdue; overdue by more than this many working days escalates it. */
const SLA_DAYS = 3;
const ESCALATE_AFTER_WORKING_DAYS = 5;

/** One row in the approvals inbox, whatever kind of request it came from. */
type RequestItem = {
  key: string;
  kind: string;
  employeeId: string;
  title: string;
  detail?: string;
  raisedOn?: string;
  status: string;
  /** True while the request can still be approved, declined or withdrawn. */
  open: boolean;
  decided?: DecisionInfo;
  approveLabel?: string;
  declineLabel?: string;
  decide?: (decision: "approved" | "rejected", note?: string) => string | null | Promise<string | null>;
  withdraw?: () => string | null | Promise<string | null>;
};

const STATUS_TONE: Record<string, "ok" | "warn" | "danger" | "neutral" | "info"> = {
  pending: "warn",
  submitted: "warn",
  approved: "ok",
  verified: "ok",
  rejected: "danger",
  withdrawn: "neutral",
  used: "info",
  draft: "neutral",
};

const STATUS_TEXT: Record<string, string> = {
  pending: "Waiting for approval",
  submitted: "Waiting for approval",
  approved: "Approved",
  verified: "Verified",
  rejected: "Declined",
  withdrawn: "Withdrawn",
  used: "Leave applied",
  draft: "Sent back for changes",
};

/** How many requests are waiting on this person — drives the approvals badge. */
export function countWaitingOnMe(
  state: PortalState,
  myId: string,
  canApprove: (employeeId: string, scope?: DelegationScope) => boolean,
  canVerifyProofs: boolean,
): number {
  const open = (status: string) => status === "pending" || status === "submitted";
  // Delegated requests (§25) count for the delegate, within the delegation's scope.
  const mine = (employeeId: string, scope: DelegationScope = "others") => employeeId !== myId && canApprove(employeeId, scope);
  const lists: [DelegationScope, { employeeId: string; status: string }[]][] = [
    ["leave", state.backdatedPermissions],
    ["leave", state.leaveRequests],
    ["leave", state.encashments],
    ["expenses", state.expenses],
    ["expenses", state.reimbursements],
    ["expenses", state.cashAdvances],
    ["others", state.assetRequests],
    ["others", state.softwareRequests],
    ["others", state.cabBookings],
  ];
  const requests = lists.reduce(
    (sum, [scope, list]) => sum + list.filter((item) => open(item.status) && mine(item.employeeId, scope)).length,
    0,
  );
  const timesheets = state.orgTimesheets.filter((row) => row.status === "submitted" && mine(row.personId, "timesheets")).length;
  const proofs = canVerifyProofs
    ? state.investmentProofs.filter((p) => p.status === "submitted" && p.employeeId !== myId).length
    : 0;
  const corrections = getAttendanceState().corrections.filter((c) => c.status === "Pending" && mine(c.employeeId, "attendance")).length;
  const shifts = getShiftState();
  const swaps = shifts.swaps.filter(
    (w) =>
      (w.status === "awaiting_teammate" && w.teammateId === myId) ||
      (w.status === "awaiting_manager" && mine(w.requesterId) && mine(w.teammateId)),
  ).length;
  return requests + timesheets + proofs + corrections + swaps;
}

/** Approvals inbox built from real requests: decide what's waiting on you, track what you've asked for. */
export function ApprovalsCenterPage() {
  const portal = usePortal();
  const { state, employee, demoAccounts, leaveTable, canDecideFor, canVerifyProofs } = portal;
  const people = useSyncExternalStore(subscribePeople, listPeople, listPeople);
  const attendance = useSyncExternalStore(subscribeAttendance, getAttendanceState, getAttendanceState);
  const shifts = useSyncExternalStore(subscribeShifts, getShiftState, getShiftState);
  const delegations = useSyncExternalStore(subscribeDelegations, getDelegationState, getDelegationState);
  noteLeaves(state.leaveRequests);
  const actor = { id: employee.id, fullName: employee.fullName, role: portal.demoProfile.role };
  const rosterCtx = { leaves: state.leaveRequests, holidays: state.holidays };
  const [tab, setTab] = useState<"waiting" | "mine" | "delegate">("waiting");
  const canDelegate = useMemo(() => hasReports(employee.id), [employee.id, people]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const nameOf = (id: string) =>
    demoAccounts.find((a) => a.id === id)?.fullName ??
    people.find((p) => p.id === id)?.fullName ??
    taskPersonById(id)?.fullName ??
    id;
  const leaveName = (code: string) => leaveTable.find((row) => row.code === code)?.name ?? code;

  const items = useMemo<RequestItem[]>(() => {
    const isOpen = (status: string) => status === "pending" || status === "submitted";
    const list: RequestItem[] = [];

    for (const p of state.backdatedPermissions) {
      list.push({
        key: `bdp-${p.id}`,
        kind: "Backdated leave permission",
        employeeId: p.employeeId,
        title: `${leaveName(p.code)} · ${formatShortDate(p.from)} – ${formatShortDate(p.to)}`,
        detail: p.reason,
        raisedOn: p.requestedOn,
        status: p.status,
        open: p.status === "pending",
        decided: p,
        decide: (d, note) => portal.decideBackdatedPermission(p.id, d, note),
        withdraw: () => portal.withdrawBackdatedPermission(p.id),
      });
    }
    for (const r of state.leaveRequests) {
      list.push({
        key: `lv-${r.id}`,
        kind: "Leave",
        employeeId: r.employeeId,
        title: (() => {
          const halfDay = r.half && r.from === r.to;
          const days = workingDays(r.from, r.to, holidaySet(holidaysForPerson(state.holidays, r.employeeId)), undefined, r.half);
          const span = halfDay ? formatShortDate(r.from) : `${formatShortDate(r.from)} – ${formatShortDate(r.to)}`;
          return `${leaveName(r.code)} · ${span} · ${halfDay ? `${days} day (${r.half} half)` : `${days} day(s)`}`;
        })(),
        detail: r.reason,
        raisedOn: r.appliedOn,
        status: r.status,
        open: r.status === "pending",
        decided: r,
        decide: (d, note) => portal.setLeaveStatus(r.id, d, note),
        withdraw: () => portal.setLeaveStatus(r.id, "withdrawn"),
      });
    }
    for (const e of state.encashments) {
      list.push({
        key: `enc-${e.id}`,
        kind: "Leave encashment",
        employeeId: e.employeeId,
        title: `${e.days} day(s) of ${leaveName(e.code)}`,
        raisedOn: e.appliedOn,
        status: e.status,
        open: e.status === "pending",
        decided: e,
        decide: (d, note) => portal.setEncashmentStatus(e.id, d, note),
        withdraw: () => portal.setEncashmentStatus(e.id, "withdrawn"),
      });
    }
    for (const x of state.expenses) {
      list.push({
        key: `ex-${x.id}`,
        kind: "Expense claim",
        employeeId: x.employeeId,
        title: `${x.category} · ${money(x.amount, x.currency)} · ${formatShortDate(x.date)}`,
        detail: x.description,
        status: x.status,
        open: isOpen(x.status),
        decided: x,
        decide: (d, note) => portal.setExpenseStatus(x.id, d, note),
        withdraw: () => portal.setExpenseStatus(x.id, "withdrawn"),
      });
    }
    for (const x of state.reimbursements) {
      list.push({
        key: `rb-${x.id}`,
        kind: "Reimbursement",
        employeeId: x.employeeId,
        title: `${x.category} · ${money(x.amount, x.currency)} · ${formatShortDate(x.date)}`,
        detail: x.description,
        status: x.status,
        open: isOpen(x.status),
        decided: x,
        decide: (d, note) => portal.setReimbursementStatus(x.id, d, note),
        withdraw: () => portal.setReimbursementStatus(x.id, "withdrawn"),
      });
    }
    for (const x of state.cashAdvances) {
      list.push({
        key: `ca-${x.id}`,
        kind: "Cash advance",
        employeeId: x.employeeId,
        title: `${money(x.amount, x.currency)} · ${x.category} · needed by ${formatShortDate(x.requiredBy)}`,
        detail: x.purpose,
        raisedOn: x.date,
        status: x.status,
        open: isOpen(x.status),
        decided: x,
        decide: (d, note) => portal.setCashStatus(x.id, d, note),
        withdraw: () => portal.setCashStatus(x.id, "withdrawn"),
      });
    }
    for (const x of state.assetRequests) {
      list.push({
        key: `ar-${x.id}`,
        kind: "Asset request",
        employeeId: x.employeeId,
        title: x.item,
        detail: x.reason,
        raisedOn: x.date,
        status: x.status,
        open: isOpen(x.status),
        decided: x,
        decide: (d, note) => portal.setAssetStatus(x.id, d, note),
        withdraw: () => portal.setAssetStatus(x.id, "withdrawn"),
      });
    }
    for (const x of state.softwareRequests) {
      list.push({
        key: `sw-${x.id}`,
        kind: "Software request",
        employeeId: x.employeeId,
        title: x.software,
        detail: x.justification,
        raisedOn: x.date,
        status: x.status,
        open: isOpen(x.status),
        decided: x,
        decide: (d, note) => portal.setSoftwareStatus(x.id, d, note),
        withdraw: () => portal.setSoftwareStatus(x.id, "withdrawn"),
      });
    }
    for (const x of state.cabBookings) {
      list.push({
        key: `cab-${x.id}`,
        kind: "Cab booking",
        employeeId: x.employeeId,
        title: `${formatShortDate(x.date)} ${x.time} · ${x.from} → ${x.to}`,
        status: x.status,
        open: isOpen(x.status),
        decided: x,
        decide: (d, note) => portal.setCabStatus(x.id, d, note),
        withdraw: () => portal.setCabStatus(x.id, "withdrawn"),
      });
    }
    for (const x of state.investmentProofs) {
      list.push({
        key: `poi-${x.id}`,
        kind: "Tax-saving proof",
        employeeId: x.employeeId,
        title: `${x.section} · ${x.title} · ${money(x.amount, x.currency)} · ${x.financialYear}`,
        raisedOn: x.submittedOn,
        status: x.status,
        open: x.status === "submitted",
        decided: x,
        approveLabel: "Verify",
        decide: (d, note) => portal.setInvestmentProofStatus(x.id, d === "approved" ? "verified" : "rejected", note),
        withdraw: () => portal.setInvestmentProofStatus(x.id, "withdrawn"),
      });
    }
    for (const row of state.orgTimesheets) {
      if (row.status !== "submitted") continue;
      list.push({
        key: `ts-${row.id}`,
        kind: "Timesheet",
        employeeId: row.personId,
        title: `Week of ${formatShortDate(row.weekStart)} · ${row.hours} h`,
        detail: row.projectSummary,
        status: row.status,
        open: true,
        declineLabel: "Send back",
        decide: (d) => portal.setOrgTimesheetStatus(row.id, d === "approved" ? "approved" : "draft"),
      });
    }
    for (const c of attendance.corrections) {
      list.push({
        key: `ac-${c.id}`,
        kind: "Attendance correction",
        employeeId: c.employeeId,
        title: `${formatShortDate(c.date)} · ${[c.requestedCheckIn, c.requestedCheckOut].filter(Boolean).join(" – ") || c.kind}`,
        detail: c.reason,
        raisedOn: c.createdAt.slice(0, 10),
        status: c.status === "Pending" ? "pending" : c.status === "Approved" ? "approved" : "rejected",
        open: c.status === "Pending",
        decided: { decidedByName: c.decidedByName, decidedOn: c.decidedAt?.slice(0, 10), decisionNote: c.decisionNote },
        decide: (d, note) => decideCorrection(c.id, actor, d === "approved" ? "Approved" : "Rejected", note),
      });
    }
    for (const w of shifts.swaps) {
      const shiftName = (id: string) => shiftById(id, shifts)?.name ?? "shift";
      const base = {
        title: `${formatShortDate(w.date)} · ${shiftName(w.requesterShiftId)} ⇄ ${shiftName(w.teammateShiftId)}`,
        detail: w.reason,
        raisedOn: w.requestedOn,
        decided: { decidedByName: w.decidedByName, decidedOn: w.decidedOn, decisionNote: w.decisionNote },
      };
      if (w.status === "awaiting_teammate") {
        // The teammate answers first; it then goes to the manager of both.
        list.push({
          ...base,
          key: `swt-${w.id}`,
          kind: "Shift swap",
          employeeId: w.requesterId,
          status: "pending",
          open: w.teammateId === employee.id,
          approveLabel: "Accept",
          decide: (d) => respondSwap(actor, w.id, d === "approved"),
        });
      } else {
        list.push({
          ...base,
          key: `swm-${w.id}`,
          kind: "Shift swap",
          employeeId: w.requesterId,
          status: w.status === "awaiting_manager" ? "pending" : w.status === "approved" ? "approved" : w.status === "cancelled" ? "withdrawn" : "rejected",
          open: w.status === "awaiting_manager" && canDecideFor(w.teammateId, "others"),
          decide: (d, note) => decideSwap(actor, rosterCtx, w.id, d === "approved", note ?? ""),
        });
      }
    }
    for (const c of compOffCandidates(actor, rosterCtx, shifts)) {
      list.push({
        key: `co-${c.assignment.personId}-${c.assignment.date}`,
        kind: "Comp-off",
        employeeId: c.assignment.personId,
        title: `Worked ${formatShortDate(c.assignment.date)} · ${c.reason}`,
        status: "pending",
        open: true,
        approveLabel: "Grant 1 day",
        declineLabel: "Not now",
        decide: (d) => (d === "approved" ? grantCompOff(actor, rosterCtx, c.assignment.personId, c.assignment.date) : null),
      });
    }
    return list;
    // portal functions are recreated with state, so state is the real dependency
  }, [state, portal, leaveTable, attendance, shifts, delegations]);

  const waiting = items.filter((item) => {
    if (!item.open || !item.decide || item.employeeId === employee.id) return false;
    if (item.kind === "Tax-saving proof") return canVerifyProofs;
    if (item.key.startsWith("swt-")) return true; // already limited to the teammate asked
    if (item.kind === "Leave encashment" && managementChain(item.employeeId, demoAccounts).length === 0) {
      // The CEO has no one above them: HR (compensation & benefits) decides their encashment.
      return portal.demoProfile.role === "hr" || portal.demoProfile.role === "hr_admin";
    }
    return canDecideFor(item.employeeId, scopeOf(item.kind));
  });
  const mine = items
    .filter((item) => item.employeeId === employee.id && item.kind !== "Timesheet" && item.kind !== "Comp-off")
    .sort((a, b) => Number(b.open) - Number(a.open) || (b.raisedOn ?? "").localeCompare(a.raisedOn ?? ""));

  // SLA: requests waiting more than SLA_DAYS are flagged overdue; overdue by more than ESCALATE_AFTER_WORKING_DAYS
  // working days they escalate: the approver's own manager (already above in the line) sees them marked "Escalated".
  const today = todayISO();
  const ageOf = (item: RequestItem) =>
    item.raisedOn ? Math.max(0, Math.round((parseISODate(today).getTime() - parseISODate(item.raisedOn).getTime()) / 86400000)) : 0;
  const overdueWorkingDays = (item: RequestItem) => {
    if (!item.raisedOn || ageOf(item) <= SLA_DAYS) return 0;
    const breach = addDaysISO(item.raisedOn, SLA_DAYS + 1);
    return workingDays(breach, today, holidaySet(holidaysForPerson(state.holidays, item.employeeId)));
  };
  const isEscalated = (item: RequestItem) => overdueWorkingDays(item) > ESCALATE_AFTER_WORKING_DAYS;
  /** How the signed-in person holds this item: as an approver above (possibly by escalation) or by delegation. */
  const holdOf = (item: RequestItem): { escalated?: boolean; delegatedFrom?: string } => {
    if (item.key.startsWith("swt-") || item.kind === "Tax-saving proof") return {};
    if (isAboveInLine(employee.id, item.employeeId)) {
      const first = chainIds(item.employeeId)[0];
      return { escalated: first !== employee.id && isEscalated(item) };
    }
    const d = delegatedAuthority(employee.id, item.employeeId, scopeOf(item.kind));
    return d ? { delegatedFrom: d.delegatorId } : {};
  };
  const myDelegation = activeDelegationFor(employee.id, today);
  const awayToday = (personId: string) =>
    state.leaveRequests.some(
      (r) => r.employeeId === personId && r.status === "approved" && r.code !== "wfh" && r.code !== "emergency_wfh" && r.from <= today && today <= r.to,
    );
  /** Who the request is with now: the first person up the line who isn't away. */
  const currentApprover = (employeeId: string) => {
    const chain = managementChain(employeeId, demoAccounts);
    const first = chain[0];
    const available = chain.find((m) => !awayToday(m.id));
    return { first, available };
  };

  async function run(action: () => string | null | Promise<string | null>, success: string, key?: string) {
    const error = await action();
    setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: success });
    if (!error && key) setNotes((prev) => ({ ...prev, [key]: "" }));
  }

  return (
    <Page title="Approvals">
      <Tabs
        tabs={[
          { id: "waiting", label: `Waiting on me (${waiting.length})` },
          { id: "mine", label: `My requests (${mine.filter((m) => m.open).length} open)` },
          ...(canDelegate ? [{ id: "delegate", label: "Delegate approvals" }] : []),
        ]}
        value={tab}
        onChange={(next) => setTab(next as typeof tab)}
      />
      <Banner message={message} />
      {myDelegation && (
        <p className="note info">
          Delegated to {personLabel(myDelegation.delegateId)} until {formatShortDate(myDelegation.to)} · {scopeText(myDelegation.scope)}
          {myDelegation.auto ? " (automatic while you're on leave)" : ""}
        </p>
      )}

      {tab === "delegate" && canDelegate && <DelegationSettings myId={employee.id} />}

      {tab === "waiting" && (
        <Card>
          {waiting.length === 0 ? (
            <EmptyState title="Nothing waiting on you" />
          ) : (
            <ul className="approval-list">
              {waiting.map((item) => {
                const hold = holdOf(item);
                const noteFor = (raw?: string) => (hold.delegatedFrom ? onBehalfNote(hold.delegatedFrom, raw) : raw);
                return (
                <li key={item.key} className="approval-item">
                  <div className="row-between">
                    <strong>{nameOf(item.employeeId)}</strong>
                    <span>
                      {hold.delegatedFrom && <span className="pill">Delegated from {personLabel(hold.delegatedFrom)}</span>}
                      {hold.escalated && <span className="pill pill-mandatory">Escalated</span>}
                      <span className="pill">{item.kind}</span>
                    </span>
                  </div>
                  <span>{item.title}</span>
                  {item.detail && <span className="muted">{item.detail}</span>}
                  {item.raisedOn && (
                    <span className="muted">
                      Raised {formatShortDate(item.raisedOn)} · waiting {ageOf(item)} day(s)
                      {ageOf(item) > SLA_DAYS && <span className="pill pill-mandatory"> Overdue</span>}
                    </span>
                  )}
                  <div className="approval-actions">
                    {item.kind !== "Timesheet" && (
                      <input
                        value={notes[item.key] ?? ""}
                        onChange={(e) => setNotes((prev) => ({ ...prev, [item.key]: e.target.value }))}
                        placeholder="Note (optional)"
                        aria-label={`Note for ${nameOf(item.employeeId)}`}
                      />
                    )}
                    <button
                      type="button"
                      className="btn btn-tiny"
                      onClick={() => run(() => item.decide!("approved", noteFor(notes[item.key])), `${item.kind} approved.`, item.key)}
                    >
                      {item.approveLabel ?? "Approve"}
                    </button>
                    <button
                      type="button"
                      className="btn-ghost btn-tiny"
                      onClick={() => run(() => item.decide!("rejected", noteFor(notes[item.key])), `${item.kind} declined.`, item.key)}
                    >
                      {item.declineLabel ?? "Decline"}
                    </button>
                  </div>
                </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}

      {tab === "mine" && (
        <Card>
          {mine.length === 0 ? (
            <EmptyState title="No requests yet" />
          ) : (
            <ul className="approval-list">
              {mine.map((item) => (
                <li key={item.key} className="approval-item">
                  <div className="row-between">
                    <strong>{item.kind}</strong>
                    <StatusBadge status={STATUS_TEXT[item.status] ?? item.status} tone={STATUS_TONE[item.status]} literal />
                  </div>
                  <span>{item.title}</span>
                  {item.open && (() => {
                    const { first, available } = currentApprover(item.employeeId);
                    if (!first) return null;
                    // An active delegation (§25) from the first approver puts the request with the delegate.
                    const d = activeDelegationFor(first.id, today);
                    const delegated = d && covers(d, scopeOf(item.kind)) && d.delegateId !== item.employeeId ? d : undefined;
                    const away = !delegated && available && available.id !== first.id;
                    const escalatedTo = isEscalated(item) ? chainIds(item.employeeId)[1] : undefined;
                    return (
                      <span className="muted">
                        With {delegated ? personLabel(delegated.delegateId) : (available?.fullName ?? first.fullName)}
                        {delegated ? ` (delegated by ${first.fullName} until ${formatShortDate(delegated.to)})` : ""}
                        {away ? ` (${first.fullName} is away)` : ""} · {ageOf(item)} day(s)
                        {ageOf(item) > SLA_DAYS && <span className="pill pill-mandatory"> Overdue</span>}
                        {escalatedTo && <span className="pill pill-mandatory"> Escalated to {personLabel(escalatedTo)}</span>}
                      </span>
                    );
                  })()}
                  <span className="muted">
                    {(() => {
                      if (!item.decided?.decidedByName) return item.raisedOn ? `Raised ${formatShortDate(item.raisedOn)}` : "";
                      const { onBehalfOf, note } = parseOnBehalf(item.decided.decisionNote);
                      return `${item.status === "rejected" ? "Declined" : "Decided"} by ${item.decided.decidedByName}${
                        onBehalfOf ? ` on behalf of ${onBehalfOf}` : ""
                      }${item.decided.decidedOn ? ` on ${formatShortDate(item.decided.decidedOn)}` : ""}${note ? ` · “${note}”` : ""}`;
                    })()}
                  </span>
                  {item.open && item.withdraw && (
                    <div className="approval-actions">
                      <button type="button" className="btn-ghost btn-tiny" onClick={() => run(item.withdraw!, "Request withdrawn.")}>
                        Withdraw
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </Page>
  );
}
