import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { API_ENABLED } from "../../api/client.ts";
import {
  apiAddRetention,
  apiDecideExit,
  apiMyNotice,
  apiRaiseExit,
  apiSetClearance,
  apiSetSettlement,
  apiSubmitInterview,
  apiSubmitResignation,
  apiWithdrawExit,
} from "../../api/syncExits.ts";
import { money } from "../../countryPay.ts";
import { finalSettlementForCase } from "../../data/finalPay.ts";
import {
  ActionButton,
  Banner,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  MetricCard,
  MetricGrid,
  Page,
  StatusBadge,
  SubmitButton,
  Tabs,
  useAction,
} from "../../components/ui.tsx";
import { LetterDownloadButtons } from "../../components/LetterDocument.tsx";
import { DEMO_ACCOUNTS } from "../../demoAccounts.ts";
import { getPerson, listPeople, subscribePeople } from "../../data/peopleLocal.ts";
import { entityFor, letterDocumentHtml, letterFileName, referenceNumber, renderLetterBody, type LetterFields } from "../../data/letterTemplates.ts";
import { formatShortDate, todayISO, type AssetAssignment } from "../../model.ts";
import { usePortal } from "../../store.tsx";
import { outstandingCashFor } from "../payrequests/cashStore.ts";
import { Tracker, WizardSteps, type Stage } from "../payrequests/Tracker.tsx";
import {
  COMPANY_EXIT_TYPES,
  EXIT_REASONS,
  INTERVIEW_REASONS,
  OWNER_LABEL,
  PENDING_EXIT_STATUSES,
  SETTLEMENT_STEPS,
  addRetentionNote,
  canAddRetention,
  canDecideExit,
  canSeeInterview,
  canTickItem,
  canWithdrawExit,
  clearanceProgress,
  completeExit,
  completionBlocker,
  decideResignation,
  earliestLastDay,
  exitCountry,
  getExitState,
  isCompanyRaised,
  nextExitStep,
  raiseCompanyExit,
  setClearanceItem,
  setSettlement,
  submitExitInterview,
  submitResignation,
  subscribeExits,
  withdrawResignation,
  type ExitCase,
  type ExitInterview,
  type ExitKind,
  type ExitStatus,
  type SettlementStatus,
} from "./exitStore.ts";
import { NOTICE_POLICY, addMonthsISO, daysBetween, isAboveInLine, isHrRole, lineManagerId, noticeDaysFor, personName, type LifecycleActor } from "./lifecycleShared.ts";
import "./lifecycle.css";

type Message = { tone: "ok" | "err" | "warn" | "info"; text: string } | null;

function useExits() {
  useSyncExternalStore(subscribePeople, listPeople);
  return useSyncExternalStore(subscribeExits, getExitState).cases;
}

function statusTone(status: ExitStatus): "ok" | "warn" | "danger" | "info" | "neutral" {
  if (status === "Completed") return "ok";
  if (status === "Accepted") return "info";
  if (status === "Submitted" || status === "Manager approved") return "warn";
  if (status === "Conversation requested" || status === "Rejected") return "danger";
  return "neutral";
}

function statusLabel(row: ExitCase): string {
  if (row.status === "Accepted") return row.lastWorkingDay < todayISO() ? "Clearing" : "Notice period";
  if (row.status === "Completed") return row.api?.clearancePending ? "Exited · clearance pending" : "Exited";
  if (row.status === "Submitted" || row.status === "Manager approved") return "Waiting";
  return row.status;
}

function settlementTone(status: SettlementStatus): "ok" | "warn" | "neutral" {
  return status === "Paid" ? "ok" : status === "In progress" ? "warn" : "neutral";
}

function ExitStatusBadge({ row }: { row: ExitCase }) {
  return <StatusBadge status={statusLabel(row)} tone={statusTone(row.status)} literal />;
}

function kindOf(row: ExitCase): ExitKind {
  return row.kind ?? "Resignation";
}

function Progress({ row }: { row: ExitCase }) {
  const { done, total } = clearanceProgress(row);
  if (!total) return <span className="muted">—</span>;
  return (
    <div style={{ minWidth: 90 }}>
      <div className="lc-progress" aria-label={`${done} of ${total} clearance items done`}>
        <span style={{ width: `${Math.round((done / total) * 100)}%` }} />
      </div>
      <span className="muted">
        {done}/{total}
      </span>
    </div>
  );
}

/* ───────────── Tracker ───────────── */

const dated = (iso?: string | null) => (iso ? formatShortDate(iso) : "");

/** Submitted → Manager → HR → Notice period → Clearance → Exited (company exits: Raised → Approval → …). */
function exitStages(row: ExitCase): Stage[] {
  const today = todayISO();
  const closed = row.status === "Withdrawn" || row.status === "Rejected" || row.status === "Conversation requested";
  const accepted = row.status === "Accepted" || row.status === "Completed";
  const company = isCompanyRaised(row);
  const stages: Stage[] = [{ label: company ? "Raised" : "Submitted", state: "done", detail: dated(row.submittedOn) }];

  if (row.api) {
    let waitingShown = false;
    for (const st of row.api.steps) {
      if (st.decision === "approve") stages.push({ label: st.label, state: "done", detail: [st.by, dated(st.on)].filter(Boolean).join(" · ") });
      else if (st.decision === "reject") stages.push({ label: st.label, state: "declined", detail: st.note ? `“${st.note}”` : st.by ?? undefined });
      else if (closed) stages.push({ label: st.label, state: "skipped" });
      else {
        stages.push({ label: st.label, state: waitingShown ? "todo" : "current", detail: waitingShown ? undefined : "Waiting" });
        waitingShown = true;
      }
    }
  } else {
    const step = nextExitStep(row);
    if (!company && lineManagerId(row.employeeId)) {
      const m = row.managerDecision;
      stages.push(
        m || accepted
          ? { label: "Manager", state: "done", detail: m ? [m.by, dated(m.on)].join(" · ") : row.decidedBy }
          : row.status === "Rejected" && !m
            ? { label: "Manager", state: "declined", detail: row.decisionNote ? `“${row.decisionNote}”` : row.decidedBy }
            : { label: "Manager", state: closed ? "skipped" : "current", detail: closed ? undefined : `Waiting · ${personName(lineManagerId(row.employeeId)!)}` },
      );
    }
    const label = company ? "Approval" : "HR";
    stages.push(
      accepted
        ? { label, state: "done", detail: [row.decidedBy, dated(row.decidedOn)].filter(Boolean).join(" · ") }
        : row.status === "Rejected" && (row.managerDecision || company || !lineManagerId(row.employeeId))
          ? { label, state: "declined", detail: row.decisionNote ? `“${row.decisionNote}”` : row.decidedBy }
          : { label, state: closed ? "skipped" : step === "hr" || step === "second" ? "current" : "todo", detail: step === "hr" || step === "second" ? "Waiting" : undefined },
    );
  }

  if (row.status === "Withdrawn") {
    stages.push({ label: "Withdrawn", state: "declined", detail: dated(row.decidedOn) });
    return stages;
  }
  if (closed) return stages;
  const left = daysBetween(today, row.lastWorkingDay);
  const { done, total } = clearanceProgress(row);
  stages.push({
    label: "Notice period",
    state: !accepted ? "todo" : row.status === "Completed" || left < 0 ? "done" : "current",
    detail: accepted ? (left >= 0 && row.status !== "Completed" ? `${left} day${left === 1 ? "" : "s"} left · to ${dated(row.lastWorkingDay)}` : `Ended ${dated(row.lastWorkingDay)}`) : undefined,
  });
  stages.push({
    label: "Clearance",
    state: !accepted ? "todo" : total && done === total ? "done" : "current",
    detail: accepted && total ? `${done} of ${total} done` : undefined,
  });
  stages.push({
    label: "Exited",
    state: row.status === "Completed" ? "done" : accepted && left < 0 ? "current" : "todo",
    detail: row.status === "Completed" ? dated(row.completedOn ?? row.lastWorkingDay) : undefined,
  });
  return stages;
}

/* ───────────── Shared detail ───────────── */

function ExitFacts({ row }: { row: ExitCase }) {
  return (
    <dl className="lc-facts">
      <div>
        <dt>Employee</dt>
        <dd>{row.employeeName}</dd>
      </div>
      <div>
        <dt>Type</dt>
        <dd>
          {kindOf(row)}
          {isCompanyRaised(row) && row.raisedBy ? ` · raised by ${row.raisedBy}` : ""}
        </dd>
      </div>
      <div>
        <dt>Country</dt>
        <dd>{exitCountry(row.employeeId)}</dd>
      </div>
      <div>
        <dt>Submitted</dt>
        <dd>{formatShortDate(row.submittedOn)}</dd>
      </div>
      <div>
        <dt>Notice period</dt>
        <dd>{row.noticeDays} days</dd>
      </div>
      <div>
        <dt>{row.status === "Accepted" || row.status === "Completed" ? "Agreed last day" : "Requested last day"}</dt>
        <dd>
          {formatShortDate(row.status === "Accepted" || row.status === "Completed" ? row.lastWorkingDay : row.proposedLastDay)}
          {row.earlyRelease ? " · early release" : ""}
        </dd>
      </div>
      <div>
        <dt>Reason</dt>
        <dd>{row.reason}</dd>
      </div>
      {row.note && (
        <div style={{ gridColumn: "span 2" }}>
          <dt>Details</dt>
          <dd>{row.note}</dd>
        </div>
      )}
      {row.earlyReason && (
        <div style={{ gridColumn: "1 / -1" }}>
          <dt>Why early</dt>
          <dd>{row.earlyReason}</dd>
        </div>
      )}
      {(row.handoverPlan || row.handoverTo) && (
        <div style={{ gridColumn: "1 / -1" }}>
          <dt>Handover</dt>
          <dd>
            {row.handoverTo ? `To ${row.handoverTo}` : ""}
            {row.handoverTo && row.handoverPlan ? " · " : ""}
            {row.handoverPlan ?? ""}
          </dd>
        </div>
      )}
      {(row.decisionNote || row.managerDecision?.note) && (
        <div style={{ gridColumn: "1 / -1" }}>
          <dt>Notes</dt>
          <dd>
            {[row.managerDecision?.note ? `${row.managerDecision.by}: ${row.managerDecision.note}` : "", row.decisionNote ? `${row.decidedBy ?? "HR"}: ${row.decisionNote}` : ""]
              .filter(Boolean)
              .join(" · ")}
          </dd>
        </div>
      )}
    </dl>
  );
}

function DecisionBlock({ row, actor, assets, onMessage }: { row: ExitCase; actor: LifecycleActor; assets: AssetAssignment[]; onMessage: (m: Message) => void }) {
  const [note, setNote] = useState("");
  const [approveEarly, setApproveEarly] = useState(true);
  if (!canDecideExit(actor, row)) return null;
  const step = API_ENABLED ? null : nextExitStep(row);

  async function run(decision: "approve" | "reject") {
    if (decision === "reject" && !note.trim()) return "Add a note saying why.";
    const error = API_ENABLED
      ? await apiDecideExit(row.id, decision, note, row.earlyRelease ? approveEarly : undefined)
      : decideResignation(actor, row.id, decision, { note, approveEarlyRelease: row.earlyRelease ? approveEarly : undefined, assets });
    onMessage(error ? { tone: "err", text: error } : { tone: "ok", text: decision === "approve" ? `Approved for ${row.employeeName}.` : "Declined." });
    if (!error) setNote("");
    return error ?? true;
  }

  return (
    <Card title={step === "manager" ? "Your decision (then HR)" : "Decision"}>
      <div className="stack">
        {row.earlyRelease && (
          <label className="lc-inline-check">
            <input type="checkbox" checked={approveEarly} onChange={(e) => setApproveEarly(e.target.checked)} />
            Allow early release to {formatShortDate(row.proposedLastDay)}
          </label>
        )}
        <Field label="Note">
          <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Shared with the employee · needed to decline" />
        </Field>
        <div className="row-gap">
          <ActionButton className="btn" toastError busyLabel="Approving…" doneLabel="Approved" success={`Approved for ${row.employeeName}.`} onAction={() => run("approve")}>
            Approve
          </ActionButton>
          <ActionButton className="btn-ghost" toastError busyLabel="Declining…" doneLabel="Declined" success="Declined." onAction={() => run("reject")}>
            Decline
          </ActionButton>
        </div>
      </div>
    </Card>
  );
}

function RetentionBlock({ row, actor, onMessage }: { row: ExitCase; actor: LifecycleActor; onMessage: (m: Message) => void }) {
  const [note, setNote] = useState("");
  const [meetOn, setMeetOn] = useState("");
  const allowed = canAddRetention(actor, row);
  const notes = row.retention ?? [];
  if (!allowed && notes.length === 0) return null;
  const leaver = actor.id === row.employeeId;
  return (
    <Card title={leaver ? "Your manager would like to talk" : "Retention conversation"}>
      <div className="stack">
        {notes.map((n, i) => (
          <div key={`${n.on}-${i}`} className="pr-note">
            <strong>{n.by}</strong> · {formatShortDate(n.on)}
            {n.meetOn ? ` · meet on ${formatShortDate(n.meetOn)}` : ""}
            <div>{n.note}</div>
          </div>
        ))}
        {leaver && notes.length > 0 && PENDING_EXIT_STATUSES.includes(row.status) && (
          <p className="muted" style={{ margin: 0 }}>
            Changed your mind after talking? You can withdraw the resignation until it is finally approved.
          </p>
        )}
        {allowed && (
          <div className="lc-grid">
            <Field label="Note to the employee" wide>
              <textarea rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you'd like to discuss" />
            </Field>
            <Field label="Meet on (optional)">
              <input type="date" min={todayISO()} value={meetOn} onChange={(e) => setMeetOn(e.target.value)} />
            </Field>
            <div style={{ alignSelf: "end" }}>
              <ActionButton
                className="btn-ghost"
                toastError
                busyLabel="Sending…"
                doneLabel="Sent"
                success={`Sent to ${row.employeeName}.`}
                onAction={async () => {
                  const error = API_ENABLED ? await apiAddRetention(row.id, note, meetOn || undefined) : addRetentionNote(actor, row.id, note, meetOn || undefined);
                  onMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Conversation offered." });
                  if (!error) {
                    setNote("");
                    setMeetOn("");
                  }
                  return error ?? true;
                }}
              >
                Offer a conversation
              </ActionButton>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

function ClearanceList({ row, actor, onMessage }: { row: ExitCase; actor: LifecycleActor; onMessage: (m: Message) => void }) {
  if (!row.clearance.length) return <p className="muted">Starts once the exit is approved.</p>;
  return (
    <ul className="lc-checklist">
      {row.clearance.map((item) => {
        const editable = canTickItem(actor, row, item);
        return (
          <li key={item.id} className={`lc-check${item.done ? " done" : ""}`}>
            <label className="lc-check-main">
              <input
                type="checkbox"
                checked={item.done}
                disabled={!editable}
                onChange={(e) => {
                  const done = e.target.checked;
                  if (API_ENABLED) {
                    void apiSetClearance(row.id, item.id, done).then((error) => onMessage(error ? { tone: "err", text: error } : null));
                    return;
                  }
                  const error = setClearanceItem(actor, row.id, item.id, done);
                  onMessage(error ? { tone: "err", text: error } : null);
                }}
              />
              <span>{item.label}</span>
            </label>
            <span className="row-gap">
              <span className="pill">{OWNER_LABEL[item.owner]}</span>
              {item.done && item.doneBy ? (
                <span className="muted">
                  {item.doneBy}
                  {item.doneOn ? ` · ${formatShortDate(item.doneOn)}` : ""}
                </span>
              ) : (
                <span className="muted">{editable ? "Tick when done" : "Open"}</span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function InterviewAnswers({ interview }: { interview: ExitInterview }) {
  return (
    <dl className="lc-facts">
      <div>
        <dt>Overall rating</dt>
        <dd>{interview.rating} / 5</dd>
      </div>
      <div>
        <dt>Would return</dt>
        <dd>{interview.wouldReturn}</dd>
      </div>
      <div>
        <dt>Submitted</dt>
        <dd>{formatShortDate(interview.submittedOn)}</dd>
      </div>
      <div style={{ gridColumn: "1 / -1" }}>
        <dt>Reasons</dt>
        <dd>{interview.reasons.join(", ")}</dd>
      </div>
      {interview.comments && (
        <div style={{ gridColumn: "1 / -1" }}>
          <dt>Comments</dt>
          <dd>{interview.comments}</dd>
        </div>
      )}
    </dl>
  );
}

function InterviewForm({ row, actor, onMessage }: { row: ExitCase; actor: LifecycleActor; onMessage: (m: Message) => void }) {
  const [rating, setRating] = useState(0);
  const [reasons, setReasons] = useState<string[]>([]);
  const [wouldReturn, setWouldReturn] = useState<ExitInterview["wouldReturn"]>("Maybe");
  const [comments, setComments] = useState("");
  const act = useAction();

  async function submit() {
    const input = { rating, reasons, wouldReturn, comments };
    const error = API_ENABLED ? await apiSubmitInterview(row.id, input) : submitExitInterview(actor, row.id, input);
    onMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Thank you. Your exit interview was sent to HR." });
    return error ?? true;
  }

  return (
    <form className="stack" onSubmit={act.submit(submit, { success: "Exit interview sent to HR.", toastError: true })}>
      <p className="muted">{lineManagerId(actor.id) ? "Private to HR. Not shared with your manager." : "Private to HR."}</p>
      <div>
        <p className="muted">How was your time here?</p>
        <div className="lc-rating" role="group" aria-label="Overall rating">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" className="btn-ghost btn-tiny" aria-pressed={rating === n} onClick={() => setRating(n)}>
              {n}
            </button>
          ))}
        </div>
      </div>
      <div>
        <p className="muted">Main reasons for leaving</p>
        <div className="lc-chips">
          {INTERVIEW_REASONS.map((reason) => (
            <label key={reason} className="lc-chip">
              <input
                type="checkbox"
                checked={reasons.includes(reason)}
                onChange={(e) => setReasons((list) => (e.target.checked ? [...list, reason] : list.filter((r) => r !== reason)))}
              />
              {reason}
            </label>
          ))}
        </div>
      </div>
      <div className="lc-grid">
        <Field label="Would you come back?">
          <select value={wouldReturn} onChange={(e) => setWouldReturn(e.target.value as ExitInterview["wouldReturn"])}>
            <option>Yes</option>
            <option>Maybe</option>
            <option>No</option>
          </select>
        </Field>
        <Field label="Anything else" wide>
          <textarea value={comments} maxLength={2000} onChange={(e) => setComments(e.target.value)} />
        </Field>
      </div>
      <div>
        <SubmitButton action={act} className="btn">
          Submit exit interview
        </SubmitButton>
      </div>
    </form>
  );
}

function SettlementBlock({ row, actor, onMessage }: { row: ExitCase; actor: LifecycleActor; onMessage: (m: Message) => void }) {
  const next = SETTLEMENT_STEPS[SETTLEMENT_STEPS.indexOf(row.settlement) + 1];
  const canEdit = isHrRole(actor.role) && actor.id !== row.employeeId && (row.status === "Accepted" || row.status === "Completed");
  const { state } = usePortal();
  const summary = finalSettlementForCase(row, state);
  const advance = outstandingCashFor(row.employeeId);
  return (
    <div className="stack">
      <div className="row-between" style={{ flexWrap: "wrap", gap: 8 }}>
        <span className="row-gap">
          <StatusBadge status={row.settlement} tone={settlementTone(row.settlement)} literal />
          {row.settlementUpdatedBy && (
            <span className="muted">
              {row.settlementUpdatedBy}
              {row.settlementUpdatedOn ? ` · ${formatShortDate(row.settlementUpdatedOn)}` : ""}
            </span>
          )}
        </span>
        {canEdit && next && (
          <ActionButton
            className="btn-ghost btn-tiny"
            toastError
            busyLabel="Updating…"
            doneLabel="Updated"
            success={`Settlement for ${row.employeeName} marked ${next.toLowerCase()}.`}
            onAction={async () => {
              const error = API_ENABLED ? await apiSetSettlement(row.id, next) : setSettlement(actor, row.id, next);
              onMessage(error ? { tone: "err", text: error } : { tone: "ok", text: `Settlement marked ${next.toLowerCase()}.` });
              return error ?? true;
            }}
          >
            Mark {next.toLowerCase()}
          </ActionButton>
        )}
      </div>
      {summary && (
        <div className="pr-calc">
          <div className="row">
            <span>
              Salary · {summary.paidDays} of {summary.totalDays} days to {formatShortDate(summary.lastWorkingDay)}
            </span>
            <span />
          </div>
          <div className="row">
            <span>Leave encashment · {summary.encashmentDays} days</span>
            <span>{money(summary.encashment, summary.currency)}</span>
          </div>
          <div className="row">
            <span>Gross</span>
            <span>{money(summary.gross, summary.currency)}</span>
          </div>
          <div className="row">
            <span>Tax and deductions</span>
            <span>− {money(summary.deductionTotal, summary.currency)}</span>
          </div>
          {advance && advance.amount > 0 && (
            <div className="row">
              <span>Cash advance still owed</span>
              <span>− {money(advance.amount, advance.currency)}</span>
            </div>
          )}
          <div className="row total">
            <span>Net{summary.estimate ? " (estimate)" : ""}</span>
            <span>{money(Math.max(0, summary.net - (advance && advance.currency === summary.currency ? advance.amount : 0)), summary.currency)}</span>
          </div>
          <span className="muted">Paid with the final payslip after the last working day.</span>
        </div>
      )}
    </div>
  );
}

/* ───────────── Letters ───────────── */

function lettersReady(row: ExitCase): boolean {
  return row.status === "Completed" || (row.status === "Accepted" && row.lastWorkingDay <= todayISO());
}

function exitLetterHtml(row: ExitCase, type: "Relieving" | "Experience"): string {
  const p = getPerson(row.employeeId);
  const demo = DEMO_ACCOUNTS.find((a) => a.id === row.employeeId);
  const country = p?.countryCode ?? demo?.countryCode ?? "IN";
  const fields: LetterFields = {
    employeeName: p?.fullName ?? row.employeeName,
    employeeCode: p?.employeeCode ?? demo?.employeeCode ?? row.employeeId,
    title: p?.designation ?? demo?.designation ?? "",
    department: p?.department ?? demo?.department ?? "",
    grade: p?.grade ?? "",
    joiningDate: p?.dateOfJoining || addMonthsISO(row.submittedOn, -24),
    lastWorkingDay: row.lastWorkingDay,
    manager: p?.managerName ?? "",
    countryCode: country,
    countryName: p?.countryName ?? demo?.countryName ?? country,
    legalEntity: p?.legalEntity || demo?.legalEntity || entityFor(country),
    address: p?.address ?? "",
    salary: "",
    previousSalary: "",
    effectiveDate: row.lastWorkingDay,
    details: "",
    nationality: p?.nationality ?? "",
    endDate: row.lastWorkingDay,
    customText: "",
  };
  const serial = Math.abs([...row.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)) % 9000 + 1000;
  const on = row.completedOn ?? row.lastWorkingDay;
  const body = renderLetterBody(fields, {
    type,
    date: on,
    referenceNo: referenceNumber(type, country, serial, on),
    approval: { by: "Human Resources", on },
    docId: `${row.id}-${type.slice(0, 3).toUpperCase()}`,
    version: 1,
  });
  return letterDocumentHtml(body, { title: `${type} letter · ${fields.employeeName}`, draft: false });
}

function LettersBlock({ row }: { row: ExitCase }) {
  const code = getPerson(row.employeeId)?.employeeCode ?? row.employeeId;
  return (
    <Card title="Relieving and experience letters">
      {!lettersReady(row) ? (
        <p className="muted">Ready to download from {formatShortDate(row.lastWorkingDay)}, your last working day.</p>
      ) : (
        <div className="stack">
          {(["Relieving", "Experience"] as const).map((type) => (
            <div key={type} className="row-between" style={{ flexWrap: "wrap", gap: 8 }}>
              <strong>{type} letter</strong>
              <LetterDownloadButtons html={exitLetterHtml(row, type)} fileName={letterFileName(type, code, 1)} />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function ExitDetail({ row, onMessage }: { row: ExitCase; onMessage: (m: Message) => void }) {
  const { demoProfile, state } = usePortal();
  const actor = demoProfile;
  const hr = isHrRole(actor.role) && actor.id !== row.employeeId;
  const blocker = completionBlocker(row);

  function complete() {
    let warning: string | null = null;
    const error = completeExit(actor, row.id, (text) => {
      warning = text;
    });
    if (error) {
      onMessage({ tone: "err", text: error });
      return error;
    }
    onMessage(warning ? { tone: "warn", text: warning } : { tone: "ok", text: `${row.employeeName}'s exit is complete. Letters are ready.` });
    return true;
  }

  return (
    <div className="stack">
      <Tracker stages={exitStages(row)} label="Exit progress" />
      <ExitFacts row={row} />
      <RetentionBlock row={row} actor={actor} onMessage={onMessage} />
      <DecisionBlock row={row} actor={actor} assets={state.assets} onMessage={onMessage} />
      {canWithdrawExit(actor, row) && (
        <div>
          <ActionButton
            className="btn-ghost btn-tiny"
            toastError
            success="Exit withdrawn."
            onAction={async () => {
              const error = API_ENABLED ? await apiWithdrawExit(row.id) : withdrawResignation(actor, row.id);
              onMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Exit withdrawn." });
              return error ?? true;
            }}
          >
            Withdraw
          </ActionButton>
        </div>
      )}
      {(row.status === "Accepted" || row.status === "Completed") && (
        <>
          <Card title="Exit clearance">
            <ClearanceList row={row} actor={actor} onMessage={onMessage} />
          </Card>
          <Card title="Exit interview">
            {!canSeeInterview(actor, row) ? (
              <p className="muted">{row.interview || row.api?.interviewSubmitted ? "Submitted · private to HR" : "Not submitted yet"}</p>
            ) : row.interview ? (
              <InterviewAnswers interview={row.interview} />
            ) : (
              <p className="muted">Not submitted yet.</p>
            )}
          </Card>
          {(hr || actor.id === row.employeeId) && (
            <Card title="Final settlement">
              <SettlementBlock row={row} actor={actor} onMessage={onMessage} />
            </Card>
          )}
          {hr && <LettersBlock row={row} />}
          {hr && row.status === "Accepted" && API_ENABLED && (
            <Card title="Complete exit">
              <p className="muted">Closes on its own after the last working day. Sign-in then stops.</p>
            </Card>
          )}
          {hr && row.status === "Accepted" && !API_ENABLED && (
            <Card title="Complete exit">
              <div className="stack">
                <p className="muted">{blocker ?? "Marks the person as left and issues the relieving and experience letters."}</p>
                <div>
                  <ActionButton className="btn" toastError disabled={Boolean(blocker)} success={`Exit completed for ${row.employeeName}.`} onAction={complete}>
                    Complete exit
                  </ActionButton>
                </div>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

/* ───────────── Resignation form ───────────── */

/** Backend mode: notice days and earliest date from the server (country config). */
function useServerNotice() {
  const [notice, setNotice] = useState<{ days: number; earliest: string } | null>(null);
  useEffect(() => {
    if (!API_ENABLED) return;
    let live = true;
    apiMyNotice()
      .then((n) => live && setNotice({ days: n.notice_days, earliest: n.earliest_last_day }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return notice;
}

const WIZARD = ["Reason", "Last day", "Handover", "Review"];

function ResignationWizard({ actor, onMessage }: { actor: LifecycleActor; onMessage: (m: Message) => void }) {
  const today = todayISO();
  const server = useServerNotice();
  const people = useSyncExternalStore(subscribePeople, listPeople, listPeople);
  const noticeDays = server?.days ?? noticeDaysFor(actor.id);
  const earliest = server?.earliest ?? earliestLastDay(actor.id, today);
  const [step, setStep] = useState(0);
  const [reached, setReached] = useState(0);
  const [reason, setReason] = useState("");
  const [details, setDetails] = useState("");
  const [picked, setLastDay] = useState("");
  const [early, setEarly] = useState(false);
  const [earlyReason, setEarlyReason] = useState("");
  const [handoverPlan, setHandoverPlan] = useState("");
  const [handoverTo, setHandoverTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const act = useAction();
  const lastDay = picked || earliest;
  const insideNotice = lastDay < earliest;
  const manager = lineManagerId(actor.id);
  const teammates = useMemo(() => {
    const me = getPerson(actor.id);
    return people.filter((p) => p.id !== actor.id && p.employmentStatus !== "Terminated" && (p.managerId === me?.managerId || p.managerId === actor.id)).slice(0, 50);
  }, [people, actor.id]);
  const noticeGiven = daysBetween(today, lastDay);

  function check(i: number): string | null {
    if (i === 0 && !reason) return "Choose a reason.";
    if (i === 1) {
      if (!lastDay || lastDay < today) return "Choose a last working day from today on.";
      if (insideNotice && !early) return `That is inside your ${noticeDays}-day notice. Ask for early release or pick ${formatShortDate(earliest)} or later.`;
      if (insideNotice && early && !earlyReason.trim()) return "Say why you need to leave early.";
    }
    return null;
  }

  function go(i: number) {
    for (let k = 0; k < Math.min(i, WIZARD.length - 1); k += 1) {
      const problem = check(k);
      if (problem && k < i) {
        setError(problem);
        setStep(k);
        return;
      }
    }
    setError(null);
    setStep(i);
    setReached((r) => Math.max(r, i));
  }

  async function submit() {
    for (let k = 0; k < 3; k += 1) {
      const problem = check(k);
      if (problem) {
        setStep(k);
        setError(problem);
        return problem;
      }
    }
    const input = {
      proposedLastDay: lastDay,
      reason,
      note: details,
      earlyRelease: early && insideNotice,
      earlyReason,
      handoverPlan,
      handoverTo,
    };
    const err = API_ENABLED ? await apiSubmitResignation(input) : submitResignation(actor, input);
    onMessage(err ? { tone: "err", text: err } : { tone: "ok", text: manager ? `Sent to ${personName(manager)}.` : "Sent to HR." });
    return err ?? true;
  }

  return (
    <Card title="Resign">
      <form className="pr-form" onSubmit={act.submit(submit, { success: manager ? `Resignation sent to ${personName(manager)}.` : "Resignation sent to HR.", toastError: true })}>
        <WizardSteps steps={WIZARD} current={step} reached={reached} onGo={go} />
        {error && <Banner message={{ tone: "err", text: error }} />}

        {step === 0 && (
          <>
            <div>
              <p className="muted" style={{ margin: "0 0 6px" }}>Main reason</p>
              <div className="pr-choice-row" role="group" aria-label="Reason">
                {EXIT_REASONS.map((r) => (
                  <button key={r} type="button" className="pr-choice" aria-pressed={reason === r} onClick={() => setReason(r)}>
                    {r}
                  </button>
                ))}
              </div>
            </div>
            <Field label="Details (optional)">
              <textarea rows={3} maxLength={1000} value={details} onChange={(e) => setDetails(e.target.value)} />
            </Field>
          </>
        )}

        {step === 1 && (
          <>
            <p className="pr-note" style={{ margin: 0 }}>
              Your notice period is {noticeDays} days. Standard last day: <strong>{formatShortDate(earliest)}</strong>.
            </p>
            <div className="pr-grid">
              <Field label="Preferred last working day">
                <input type="date" value={lastDay} min={today} onChange={(e) => setLastDay(e.target.value)} />
              </Field>
              <div style={{ alignSelf: "end" }}>
                <span className={insideNotice ? "pill pill-mandatory" : "pill"}>{noticeGiven >= 0 ? `${noticeGiven} days' notice` : "In the past"}</span>
              </div>
            </div>
            {insideNotice && (
              <>
                <label className="lc-inline-check">
                  <input type="checkbox" checked={early} onChange={(e) => setEarly(e.target.checked)} />
                  Ask for early release
                </label>
                {early && (
                  <Field label="Why you need to leave early">
                    <textarea rows={2} maxLength={1000} value={earlyReason} onChange={(e) => setEarlyReason(e.target.value)} />
                  </Field>
                )}
                <p className="muted" style={{ margin: 0 }}>If early release is declined, {formatShortDate(earliest)} applies.</p>
              </>
            )}
          </>
        )}

        {step === 2 && (
          <>
            <Field label="Hand over to (optional)">
              <input list="handover-people" value={handoverTo} maxLength={200} onChange={(e) => setHandoverTo(e.target.value)} placeholder="A teammate" />
              <datalist id="handover-people">
                {teammates.map((p) => (
                  <option key={p.id} value={p.fullName} />
                ))}
              </datalist>
            </Field>
            <Field label="Handover plan (optional)">
              <textarea rows={4} maxLength={2000} value={handoverPlan} onChange={(e) => setHandoverPlan(e.target.value)} placeholder="Open work, documents, who takes what" />
            </Field>
          </>
        )}

        {step === 3 && (
          <dl className="lc-facts">
            <div>
              <dt>Reason</dt>
              <dd>{reason || "—"}</dd>
            </div>
            <div>
              <dt>Last working day</dt>
              <dd>
                {formatShortDate(lastDay)}
                {insideNotice && early ? " · early release" : ""}
              </dd>
            </div>
            <div>
              <dt>Goes to</dt>
              <dd>{manager ? `${personName(manager)}, then HR` : "HR"}</dd>
            </div>
            {details && (
              <div style={{ gridColumn: "1 / -1" }}>
                <dt>Details</dt>
                <dd>{details}</dd>
              </div>
            )}
            {(handoverTo || handoverPlan) && (
              <div style={{ gridColumn: "1 / -1" }}>
                <dt>Handover</dt>
                <dd>{[handoverTo && `To ${handoverTo}`, handoverPlan].filter(Boolean).join(" · ")}</dd>
              </div>
            )}
          </dl>
        )}

        <div className="pr-actions">
          {step > 0 && (
            <button type="button" className="btn-ghost" onClick={() => go(step - 1)}>
              Back
            </button>
          )}
          <span className="spacer" />
          {step < WIZARD.length - 1 ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                const problem = check(step);
                if (problem) {
                  setError(problem);
                  return;
                }
                go(step + 1);
              }}
            >
              Next
            </button>
          ) : (
            <SubmitButton action={act} className="btn">
              Submit resignation
            </SubmitButton>
          )}
        </div>
      </form>
    </Card>
  );
}

/* ───────────── My exit ───────────── */

export function MyExitPage() {
  const { demoProfile } = usePortal();
  const cases = useExits();
  const [message, setMessage] = useState<Message>(null);
  const actor = demoProfile;
  // A company-raised exit stays hidden from the person until it is approved (as on the server).
  const mine = cases.filter((c) => c.employeeId === actor.id && !(isCompanyRaised(c) && PENDING_EXIT_STATUSES.includes(c.status)));
  const current =
    mine.find((c) => c.status === "Submitted" || c.status === "Manager approved" || c.status === "Accepted") ?? mine.find((c) => c.status === "Completed");
  const history = mine.filter((c) => c !== current);
  const left = current ? daysBetween(todayISO(), current.lastWorkingDay) : 0;

  return (
    <Page title="Resignation">
      <Banner message={message} />
      {!current && <ResignationWizard actor={actor} onMessage={setMessage} />}
      {current && (
        <>
          <Card title={kindOf(current) === "Resignation" ? "Your resignation" : kindOf(current)}>
            <div className="stack">
              {current.status === "Accepted" && (
                <MetricGrid>
                  <MetricCard label="Last working day" value={formatShortDate(current.lastWorkingDay)} />
                  <MetricCard label="Days left" value={Math.max(0, left)} />
                  <MetricCard label="Clearance" value={`${clearanceProgress(current).done}/${clearanceProgress(current).total}`} />
                </MetricGrid>
              )}
              <Tracker stages={exitStages(current)} label="Resignation progress" />
              <ExitFacts row={current} />
              {canWithdrawExit(actor, current) && (
                <div className="pr-actions">
                  <span className="muted">You can withdraw until it is finally approved.</span>
                  <span className="spacer" />
                  <ActionButton
                    className="btn-ghost btn-tiny"
                    toastError
                    success="Resignation withdrawn."
                    onAction={async () => {
                      const error = API_ENABLED ? await apiWithdrawExit(current.id) : withdrawResignation(actor, current.id);
                      setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Resignation withdrawn." });
                      return error ?? true;
                    }}
                  >
                    Withdraw
                  </ActionButton>
                </div>
              )}
            </div>
          </Card>
          <RetentionBlock row={current} actor={actor} onMessage={setMessage} />
        </>
      )}
      {current && (current.status === "Accepted" || current.status === "Completed") && (
        <>
          <Card title="Exit clearance">
            <ClearanceList row={current} actor={actor} onMessage={setMessage} />
          </Card>
          <Card title="Exit interview">
            {current.interview ? (
              <InterviewAnswers interview={current.interview} />
            ) : current.api?.interviewSubmitted ? (
              <p className="muted">Sent to HR · private.</p>
            ) : current.status === "Accepted" ? (
              <InterviewForm row={current} actor={actor} onMessage={setMessage} />
            ) : (
              <p className="muted">Not submitted.</p>
            )}
          </Card>
          <Card title="Final settlement">
            <SettlementBlock row={current} actor={actor} onMessage={setMessage} />
          </Card>
          <LettersBlock row={current} />
        </>
      )}
      {history.length > 0 && (
        <Card title="Earlier requests">
          <DataTable
            headers={["Submitted", "Requested last day", "Reason", "Status", "Note"]}
            rows={history.map((c) => [formatShortDate(c.submittedOn), formatShortDate(c.proposedLastDay), c.reason, <ExitStatusBadge row={c} />, c.decisionNote || "—"])}
          />
        </Card>
      )}
      {!API_ENABLED && !current && (
        <Card title="Notice periods">
          <DataTable
            headers={["Country", "Notice", "Basis"]}
            rows={[...NOTICE_POLICY.map((p) => [p.country, `${p.days} days`, p.basis]), ["Contractors (all countries)", "7 days", "Contract terms"]]}
          />
        </Card>
      )}
    </Page>
  );
}

/* ───────────── Raise an exit (HR) ───────────── */

function RaiseExitDialog({ onClose, onMessage }: { onClose: () => void; onMessage: (m: Message) => void }) {
  const { demoProfile } = usePortal();
  const people = useSyncExternalStore(subscribePeople, listPeople, listPeople);
  const [who, setWho] = useState("");
  const [type, setType] = useState<(typeof COMPANY_EXIT_TYPES)[number]["value"]>("termination");
  const [lastDay, setLastDay] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const act = useAction();
  const options = useMemo(() => people.filter((p) => p.id !== demoProfile.id && p.employmentStatus !== "Terminated"), [people, demoProfile.id]);
  const person = options.find((p) => `${p.fullName} (${p.employeeCode || p.id})` === who);
  const label = COMPANY_EXIT_TYPES.find((t) => t.value === type)!.label;

  return (
    <Dialog open title="Raise an exit" onClose={onClose}>
      <form
        className="pr-form"
        onSubmit={act.submit(
          async () => {
            if (!person) return "Pick a person from the list.";
            if (!lastDay) return "Choose the last working day.";
            const error = API_ENABLED
              ? await apiRaiseExit({ employeeId: person.id, exitType: type, lastWorkingDay: lastDay, reason, note })
              : raiseCompanyExit(demoProfile, { employeeId: person.id, kind: label, lastWorkingDay: lastDay, reason, note });
            onMessage(error ? { tone: "err", text: error } : { tone: "ok", text: `${label} raised for ${person.fullName}. It now needs a second approver.` });
            if (!error) onClose();
            return error ?? true;
          },
          { success: `${label} raised.`, toastError: true },
        )}
      >
        <Field label="Person">
          <input list="exit-people" value={who} onChange={(e) => setWho(e.target.value)} placeholder="Start typing a name" />
          <datalist id="exit-people">
            {options.slice(0, 800).map((p) => (
              <option key={p.id} value={`${p.fullName} (${p.employeeCode || p.id})`} />
            ))}
          </datalist>
        </Field>
        <div className="pr-grid">
          <Field label="Type">
            <select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
              {COMPANY_EXIT_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Last working day">
            <input type="date" min={todayISO()} value={lastDay} onChange={(e) => setLastDay(e.target.value)} />
          </Field>
        </div>
        <Field label="Reason">
          <input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Field label="Note (optional)">
          <textarea rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <p className="pr-note" style={{ margin: 0 }}>
          Another HR person, an admin or an executive approves it. The person does not see it until then.
        </p>
        <div className="pr-actions">
          <SubmitButton action={act} className="btn">
            Raise exit
          </SubmitButton>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/* ───────────── Team / all exits ───────────── */

function ExitTable({ rows, onOpen, actor }: { rows: ExitCase[]; onOpen: (id: string) => void; actor: LifecycleActor }) {
  return (
    <DataTable
      headers={["Employee", "Type", "Last day", "Status", "Clearance", "Settlement", ""]}
      rows={rows.map((c) => [
        <div>
          <strong>{c.employeeName}</strong>
          <p className="muted">{exitCountry(c.employeeId)}</p>
        </div>,
        kindOf(c),
        <span>
          {formatShortDate(c.status === "Accepted" || c.status === "Completed" ? c.lastWorkingDay : c.proposedLastDay)}
          {c.earlyRelease && PENDING_EXIT_STATUSES.includes(c.status) ? <span className="muted"> · early</span> : null}
        </span>,
        <span className="row-gap">
          <ExitStatusBadge row={c} />
          {canDecideExit(actor, c) && <span className="pill pill-mandatory">Your turn</span>}
        </span>,
        <Progress row={c} />,
        <StatusBadge status={c.settlement} tone={settlementTone(c.settlement)} literal />,
        <button className="btn-ghost btn-tiny" type="button" onClick={() => onOpen(c.id)}>
          Open
        </button>,
      ])}
      empty={<EmptyState title="No exits" />}
    />
  );
}

function ExitsBoard({ scope }: { scope: "team" | "all" }) {
  const { demoProfile } = usePortal();
  const cases = useExits();
  const [tab, setTab] = useState("open");
  const [openId, setOpenId] = useState<string | null>(null);
  const [raising, setRaising] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const actor = demoProfile;
  const hr = isHrRole(actor.role);
  const canSeeAll = hr || actor.role === "executive" || actor.role === "admin" || actor.role === "super_admin";

  const visible = useMemo(
    () =>
      cases.filter(
        (c) =>
          c.employeeId !== actor.id &&
          (API_ENABLED
            ? scope === "all"
              ? Boolean(c.api?.inAll)
              : Boolean(c.api?.inTeam)
            : scope === "all"
              ? canSeeAll
              : (isAboveInLine(actor.id, c.employeeId) && !(isCompanyRaised(c) && PENDING_EXIT_STATUSES.includes(c.status))) || canDecideExit(actor, c)),
      ),
    [cases, actor, scope, canSeeAll],
  );
  const today = todayISO();
  const awaiting = visible.filter((c) => PENDING_EXIT_STATUSES.includes(c.status));
  const mineToDecide = awaiting.filter((c) => canDecideExit(actor, c));
  const clearing = visible.filter((c) => c.status === "Accepted");
  const ready = API_ENABLED ? [] : clearing.filter((c) => !completionBlocker(c, today));
  const closed = visible.filter((c) => c.status === "Completed" || c.status === "Withdrawn" || c.status === "Conversation requested" || c.status === "Rejected");
  const rows = tab === "open" ? [...awaiting, ...clearing] : tab === "closed" ? closed : visible;
  const selected = openId ? cases.find((c) => c.id === openId) : undefined;

  if (scope === "all" && !canSeeAll) {
    return (
      <Page title="All exits">
        <EmptyState title="HR only" description="Only HR can see every exit." />
      </Page>
    );
  }

  return (
    <Page
      title={scope === "all" ? "All exits" : "Team exits"}
      action={
        scope === "all" && hr ? (
          <button type="button" className="btn" onClick={() => setRaising(true)}>
            Raise an exit
          </button>
        ) : undefined
      }
    >
      <Banner message={message} />
      <MetricGrid>
        <MetricCard label="Waiting on you" value={mineToDecide.length} />
        <MetricCard label="Waiting" value={awaiting.length} />
        <MetricCard label="Notice / clearance" value={clearing.length} />
        {!API_ENABLED && <MetricCard label="Ready to complete" value={ready.length} />}
        <MetricCard label="Closed" value={closed.length} />
      </MetricGrid>
      <Card>
        <div className="stack">
          <Tabs
            tabs={[
              { id: "open", label: `Open (${awaiting.length + clearing.length})` },
              { id: "closed", label: "Closed" },
              { id: "all", label: "All" },
            ]}
            value={tab}
            onChange={setTab}
          />
          <ExitTable
            rows={rows}
            actor={actor}
            onOpen={(id) => {
              setMessage(null);
              setOpenId(id);
            }}
          />
        </div>
      </Card>
      <Dialog open={Boolean(selected)} title={selected ? `${kindOf(selected)} · ${selected.employeeName}` : "Exit"} onClose={() => setOpenId(null)} wide>
        {selected && (
          <div className="stack">
            <Banner message={message} />
            <ExitDetail row={selected} onMessage={setMessage} />
          </div>
        )}
      </Dialog>
      {raising && <RaiseExitDialog onClose={() => setRaising(false)} onMessage={setMessage} />}
    </Page>
  );
}

export function TeamExitsPage() {
  return <ExitsBoard scope="team" />;
}

export function AllExitsPage() {
  return <ExitsBoard scope="all" />;
}
