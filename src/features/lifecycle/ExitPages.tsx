import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { API_ENABLED } from "../../api/client.ts";
import {
  apiDecideExit,
  apiMyNotice,
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
import { listPeople, subscribePeople } from "../../data/peopleLocal.ts";
import { formatShortDate, todayISO, type AssetAssignment } from "../../model.ts";
import { usePortal } from "../../store.tsx";
import {
  EXIT_REASONS,
  INTERVIEW_REASONS,
  OWNER_LABEL,
  SETTLEMENT_STEPS,
  canSeeInterview,
  canTickItem,
  clearanceProgress,
  completeExit,
  completionBlocker,
  decideResignation,
  earliestLastDay,
  exitCountry,
  getExitState,
  setClearanceItem,
  setSettlement,
  submitExitInterview,
  submitResignation,
  subscribeExits,
  withdrawResignation,
  type ExitCase,
  type ExitInterview,
  type ExitStatus,
  type SettlementStatus,
} from "./exitStore.ts";
import { NOTICE_POLICY, canActForEmployee, isAboveInLine, isHrRole, lineManagerId, noticeDaysFor, personName, type LifecycleActor } from "./lifecycleShared.ts";
import { TEMPLATE_BLANKS_ERROR, hasTemplateBlanks, useTemplatedText } from "../../data/requestTemplates.ts";
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

function settlementTone(status: SettlementStatus): "ok" | "warn" | "neutral" {
  return status === "Paid" ? "ok" : status === "In progress" ? "warn" : "neutral";
}

function ExitStatusBadge({ status }: { status: ExitStatus }) {
  return <StatusBadge status={status} tone={statusTone(status)} literal />;
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

/* ───────────── Shared detail ───────────── */

function ExitFacts({ row }: { row: ExitCase }) {
  return (
    <dl className="lc-facts">
      <div>
        <dt>Employee</dt>
        <dd>{row.employeeName}</dd>
      </div>
      {row.api && (
        <div>
          <dt>Type</dt>
          <dd>
            {row.api.typeLabel}
            {row.api.raisedById !== row.employeeId ? ` · raised by ${row.api.raisedBy}` : ""}
          </dd>
        </div>
      )}
      <div>
        <dt>Country</dt>
        <dd>{exitCountry(row.employeeId)}</dd>
      </div>
      <div>
        <dt>Status</dt>
        <dd>
          <ExitStatusBadge status={row.status} />
        </dd>
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
        <dt>Requested last day</dt>
        <dd>
          {formatShortDate(row.proposedLastDay)}
          {row.earlyRelease ? " · early release" : ""}
        </dd>
      </div>
      {(row.status === "Accepted" || row.status === "Completed") && (
        <div>
          <dt>Agreed last day</dt>
          <dd>{formatShortDate(row.lastWorkingDay)}</dd>
        </div>
      )}
      <div>
        <dt>Reason</dt>
        <dd>{row.reason}</dd>
      </div>
      {row.note && (
        <div>
          <dt>Note</dt>
          <dd>{row.note}</dd>
        </div>
      )}
      {row.api && row.api.steps.length > 0 && (
        <div style={{ gridColumn: "1 / -1" }}>
          <dt>Approvals</dt>
          <dd>
            {row.api.steps
              .map((st) =>
                st.decision
                  ? `${st.label}: ${st.decision === "approve" ? "approved" : "rejected"}${st.by ? ` by ${st.by}` : ""}${st.note ? ` — ${st.note}` : ""}`
                  : `${st.label}: waiting`,
              )
              .join(" · ")}
          </dd>
        </div>
      )}
      {row.decidedBy && !row.api && (
        <div>
          <dt>Decision</dt>
          <dd>
            {row.decidedBy}
            {row.decidedOn ? ` · ${formatShortDate(row.decidedOn)}` : ""}
            {row.decisionNote ? ` — ${row.decisionNote}` : ""}
          </dd>
        </div>
      )}
      {row.completedBy && (
        <div>
          <dt>Completed</dt>
          <dd>
            {row.completedBy}
            {row.completedOn ? ` · ${formatShortDate(row.completedOn)}` : ""}
          </dd>
        </div>
      )}
    </dl>
  );
}

function DecisionBlock({
  row,
  actor,
  assets,
  onMessage,
}: {
  row: ExitCase;
  actor: LifecycleActor;
  assets: AssetAssignment[];
  onMessage: (m: Message) => void;
}) {
  const [note, setNote] = useState("");
  const [approveEarly, setApproveEarly] = useState(true);
  if (API_ENABLED) {
    if (!row.api?.canDecide) return null;
    const run = async (decision: "approve" | "reject") => {
      const error = await apiDecideExit(row.id, decision, note, row.earlyRelease ? approveEarly : undefined);
      onMessage(error ? { tone: "err", text: error } : { tone: "ok", text: decision === "approve" ? `Approved for ${row.employeeName}.` : "Rejected." });
      if (!error) setNote("");
      return !error;
    };
    return (
      <Card title="Decision">
        <div className="stack">
          {row.earlyRelease && (
            <label className="lc-inline-check">
              <input type="checkbox" checked={approveEarly} onChange={(e) => setApproveEarly(e.target.checked)} />
              Approve early release to {formatShortDate(row.proposedLastDay)}
            </label>
          )}
          <Field label="Note">
            <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Needed to reject" />
          </Field>
          <div className="row-gap">
            <ActionButton className="btn" busyLabel="Approving…" doneLabel="Approved" success={`Approved for ${row.employeeName}.`} onAction={() => run("approve")}>
              Approve
            </ActionButton>
            <ActionButton className="btn-ghost" success="Rejected." onAction={() => run("reject")}>
              Reject
            </ActionButton>
          </div>
        </div>
      </Card>
    );
  }
  if (row.status !== "Submitted" || !canActForEmployee(actor, row.employeeId)) return null;

  function decide(decision: "accept" | "conversation") {
    const error = decideResignation(actor, row.id, decision, {
      note,
      approveEarlyRelease: row.earlyRelease ? approveEarly : undefined,
      assets,
    });
    onMessage(
      error
        ? { tone: "err", text: error }
        : { tone: "ok", text: decision === "accept" ? `Resignation accepted for ${row.employeeName}.` : "Conversation requested." },
    );
    if (!error) setNote("");
    return error ? false : true;
  }

  return (
    <Card title="Decision">
      <div className="stack">
        {row.earlyRelease && (
          <label className="lc-inline-check">
            <input type="checkbox" checked={approveEarly} onChange={(e) => setApproveEarly(e.target.checked)} />
            Approve early release to {formatShortDate(row.proposedLastDay)}
          </label>
        )}
        <Field label="Note">
          <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Shared with the employee" />
        </Field>
        <div className="row-gap">
          <ActionButton
            className="btn"
            busyLabel="Accepting…"
            doneLabel="Accepted"
            success={`Resignation accepted for ${row.employeeName}.`}
            onAction={() => decide("accept")}
          >
            Accept
          </ActionButton>
          <ActionButton
            className="btn-ghost"
            success={`Conversation requested with ${row.employeeName}.`}
            onAction={() => decide("conversation")}
          >
            Request a conversation
          </ActionButton>
        </div>
      </div>
    </Card>
  );
}

function ClearanceList({ row, actor, onMessage }: { row: ExitCase; actor: LifecycleActor; onMessage: (m: Message) => void }) {
  if (!row.clearance.length) return <p className="muted">Available once the resignation is accepted.</p>;
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
              {item.done && item.doneBy && (
                <span className="muted">
                  {item.doneBy}
                  {item.doneOn ? ` · ${formatShortDate(item.doneOn)}` : ""}
                </span>
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
    onMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Thank you — your exit interview was submitted." });
    return error ? false : true;
  }

  return (
    <form className="stack" onSubmit={act.submit(submit, { success: "Exit interview submitted to HR." })}>
      <p className="muted">{lineManagerId(actor.id) ? "Confidential to HR. Not shared with your manager." : "Confidential to HR."}</p>
      <div>
        <p className="muted">Overall experience</p>
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
                onChange={(e) =>
                  setReasons((list) => (e.target.checked ? [...list, reason] : list.filter((r) => r !== reason)))
                }
              />
              {reason}
            </label>
          ))}
        </div>
      </div>
      <div className="lc-grid">
        <Field label="Would you consider coming back?">
          <select value={wouldReturn} onChange={(e) => setWouldReturn(e.target.value as ExitInterview["wouldReturn"])}>
            <option>Yes</option>
            <option>Maybe</option>
            <option>No</option>
          </select>
        </Field>
        <Field label="Comments" wide>
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
  const canEdit =
    isHrRole(actor.role) && actor.id !== row.employeeId && (row.status === "Accepted" || row.status === "Completed");
  const { state } = usePortal();
  const summary = finalSettlementForCase(row, state);
  return (
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
          busyLabel="Updating…"
          doneLabel="Updated"
          success={`Settlement for ${row.employeeName} marked ${next.toLowerCase()}.`}
          onAction={async () => {
            const error = API_ENABLED ? await apiSetSettlement(row.id, next) : setSettlement(actor, row.id, next);
            onMessage(error ? { tone: "err", text: error } : { tone: "ok", text: `Settlement marked ${next.toLowerCase()}.` });
            return error ? false : true;
          }}
        >
          Mark {next.toLowerCase()}
        </ActionButton>
      )}
      {summary && (
        <dl className="lc-facts" style={{ width: "100%" }}>
          <div>
            <dt>Days paid · {formatShortDate(`${summary.month}-01`).slice(3)}</dt>
            <dd>
              {summary.paidDays} of {summary.totalDays} · to {formatShortDate(summary.lastWorkingDay)}
            </dd>
          </div>
          <div>
            <dt>Leave encashment</dt>
            <dd>
              {summary.encashmentDays} days · {money(summary.encashment, summary.currency)}
            </dd>
          </div>
          <div>
            <dt>Gross</dt>
            <dd>{money(summary.gross, summary.currency)}</dd>
          </div>
          <div>
            <dt>Net{summary.estimate ? " (estimate)" : ""}</dt>
            <dd>{money(summary.net, summary.currency)}</dd>
          </div>
        </dl>
      )}
    </div>
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
      return false;
    }
    onMessage(warning ? { tone: "warn", text: warning } : { tone: "ok", text: `${row.employeeName}'s exit is complete. Letter request raised.` });
    return true;
  }

  return (
    <div className="stack">
      <ExitFacts row={row} />
      <DecisionBlock row={row} actor={actor} assets={state.assets} onMessage={onMessage} />
      {(row.status === "Accepted" || row.status === "Completed") && (
        <>
          <Card title="Exit clearance">
            <ClearanceList row={row} actor={actor} onMessage={onMessage} />
          </Card>
          <Card title="Exit interview">
            {!canSeeInterview(actor, row) ? (
              <p className="muted">{row.interview || row.api?.interviewSubmitted ? "Submitted · confidential to HR" : "Not submitted yet"}</p>
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
          {hr && row.status === "Accepted" && API_ENABLED && (
            <Card title="Complete exit">
              <p className="muted">Closes on its own after the last working day. Sign-in then stops.</p>
            </Card>
          )}
          {hr && row.status === "Accepted" && !API_ENABLED && (
            <Card title="Complete exit">
              <div className="stack">
                <p className="muted">
                  {blocker ?? "Terminates the record and issues relieving and experience letters."}
                </p>
                <div>
                  <ActionButton className="btn" disabled={Boolean(blocker)} success={`Exit completed for ${row.employeeName}.`} onAction={complete}>
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

/* ───────────── My exit ───────────── */

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

function ResignationForm({ actor, onMessage }: { actor: LifecycleActor; onMessage: (m: Message) => void }) {
  const today = todayISO();
  const server = useServerNotice();
  const noticeDays = server?.days ?? noticeDaysFor(actor.id);
  const earliest = server?.earliest ?? earliestLastDay(actor.id, today);
  const [picked, setLastDay] = useState("");
  const lastDay = picked || earliest;
  const [reason, setReason] = useState("");
  const { value: note, setValue: setNote, ref: noteRef, fill: fillNote } = useTemplatedText();
  const [early, setEarly] = useState(false);
  const insideNotice = Boolean(lastDay) && lastDay < earliest;
  const act = useAction();
  const sentTo = lineManagerId(actor.id) ? `Resignation sent to ${personName(lineManagerId(actor.id)!)}.` : "Resignation recorded for the Board.";

  async function submit() {
    if (hasTemplateBlanks(note)) {
      onMessage({ tone: "err", text: TEMPLATE_BLANKS_ERROR });
      return false;
    }
    const input = { proposedLastDay: lastDay, reason, note, earlyRelease: early && insideNotice };
    const error = API_ENABLED ? await apiSubmitResignation(input) : submitResignation(actor, input);
    const toBoard = !lineManagerId(actor.id);
    onMessage(
      error
        ? { tone: "err", text: error }
        : { tone: "ok", text: toBoard ? "Resignation recorded for the Board." : `Resignation sent to ${personName(lineManagerId(actor.id)!)}.` },
    );
    return error ? false : true;
  }

  return (
    <Card title="Submit resignation">
      <form className="stack" onSubmit={act.submit(submit, { success: sentTo })}>
        <p className="muted">
          Your notice period is {noticeDays} days, so the earliest standard last day is {formatShortDate(earliest)}.
        </p>
        <div className="lc-grid">
          <Field label="Proposed last working day">
            <input type="date" value={lastDay} min={today} onChange={(e) => setLastDay(e.target.value)} required />
          </Field>
          <Field label="Reason">
            <select
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                fillNote("resignation", e.target.value);
              }}
              required
            >
              <option value="">Choose a reason</option>
              {EXIT_REASONS.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </Field>
          <Field label="Note (optional)" wide>
            <textarea ref={noteRef} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
        {insideNotice && (
          <label className="lc-inline-check">
            <input type="checkbox" checked={early} onChange={(e) => setEarly(e.target.checked)} />
            {lineManagerId(actor.id) ? "Request early release — your manager must approve this date" : "Request early release — the Board must approve this date"}
          </label>
        )}
        <div>
          <SubmitButton action={act} className="btn">
            Submit resignation
          </SubmitButton>
        </div>
      </form>
    </Card>
  );
}

export function MyExitPage() {
  const { demoProfile } = usePortal();
  const cases = useExits();
  const [message, setMessage] = useState<Message>(null);
  const actor = demoProfile;
  const mine = cases.filter((c) => c.employeeId === actor.id);
  const current =
    mine.find((c) => c.status === "Submitted" || c.status === "Manager approved" || c.status === "Accepted") ?? mine.find((c) => c.status === "Completed");
  const canWithdraw = current ? (API_ENABLED ? Boolean(current.api?.canWithdraw) : current.status === "Submitted") : false;
  const history = mine.filter((c) => c !== current);

  return (
    <Page title="Resignation">
      <Banner message={message} />
      {current?.status === "Accepted" && (
        <Banner
          message={{
            tone: "info",
            text: `Notice period · last working day ${formatShortDate(current.lastWorkingDay)}. You are paid up to that day; see My payslips.`,
          }}
        />
      )}
      {!current && <ResignationForm actor={actor} onMessage={setMessage} />}
      {current && (
        <Card
          title="Resignation"
          action={
            canWithdraw ? (
              <ActionButton
                className="btn-ghost btn-tiny"
                success="Resignation withdrawn."
                onAction={async () => {
                  const error = API_ENABLED ? await apiWithdrawExit(current.id) : withdrawResignation(actor, current.id);
                  setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Resignation withdrawn." });
                  return error ? false : true;
                }}
              >
                Withdraw
              </ActionButton>
            ) : undefined
          }
        >
          <ExitFacts row={current} />
        </Card>
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
              <p className="muted">Sent to HR · confidential.</p>
            ) : current.status === "Accepted" ? (
              <InterviewForm row={current} actor={actor} onMessage={setMessage} />
            ) : (
              <p className="muted">Not submitted.</p>
            )}
          </Card>
          <Card title="Final settlement">
            <SettlementBlock row={current} actor={actor} onMessage={setMessage} />
          </Card>
        </>
      )}
      {history.length > 0 && (
        <Card title="Earlier requests">
          <DataTable
            headers={["Submitted", "Requested last day", "Reason", "Status", "Note"]}
            rows={history.map((c) => [
              formatShortDate(c.submittedOn),
              formatShortDate(c.proposedLastDay),
              c.reason,
              <ExitStatusBadge status={c.status} />,
              c.decisionNote || "—",
            ])}
          />
        </Card>
      )}
      {/* Backend mode: notice comes from the server's country config (shown on the form). */}
      {!API_ENABLED && (
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

/* ───────────── Team / all exits ───────────── */

function ExitTable({ rows, onOpen }: { rows: ExitCase[]; onOpen: (id: string) => void }) {
  return (
    <DataTable
      headers={["Employee", "Submitted", "Last day", "Status", "Clearance", "Settlement", ""]}
      rows={rows.map((c) => [
        <div>
          <strong>{c.employeeName}</strong>
          <p className="muted">{exitCountry(c.employeeId)}</p>
        </div>,
        formatShortDate(c.submittedOn),
        <span>
          {formatShortDate(c.status === "Accepted" || c.status === "Completed" ? c.lastWorkingDay : c.proposedLastDay)}
          {c.earlyRelease && c.status === "Submitted" ? <span className="muted"> · early</span> : null}
        </span>,
        <ExitStatusBadge status={c.status} />,
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
  const [message, setMessage] = useState<Message>(null);
  const actor = demoProfile;
  const hr = isHrRole(actor.role);

  const visible = useMemo(
    () =>
      cases.filter((c) =>
        c.employeeId !== actor.id &&
        (API_ENABLED ? (scope === "all" ? Boolean(c.api?.inAll) : Boolean(c.api?.inTeam)) : scope === "all" ? hr : isAboveInLine(actor.id, c.employeeId)),
      ),
    [cases, actor.id, scope, hr],
  );
  const today = todayISO();
  const awaiting = visible.filter((c) => c.status === "Submitted" || c.status === "Manager approved");
  const clearing = visible.filter((c) => c.status === "Accepted");
  const ready = API_ENABLED ? [] : clearing.filter((c) => !completionBlocker(c, today));
  const closed = visible.filter(
    (c) => c.status === "Completed" || c.status === "Withdrawn" || c.status === "Conversation requested" || c.status === "Rejected",
  );
  const rows = tab === "open" ? [...awaiting, ...clearing] : tab === "closed" ? closed : visible;
  const selected = openId ? cases.find((c) => c.id === openId) : undefined;

  if (scope === "all" && !hr) {
    return (
      <Page title="All exits">
        <EmptyState title="HR only" description="Only HR can see every exit." />
      </Page>
    );
  }

  return (
    <Page title={scope === "all" ? "All exits" : "Team exits"}>
      <Banner message={message} />
      <MetricGrid>
        <MetricCard label="Awaiting decision" value={awaiting.length} />
        <MetricCard label="In clearance" value={clearing.length} />
        <MetricCard label="Ready to complete" value={ready.length} />
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
            onOpen={(id) => {
              setMessage(null);
              setOpenId(id);
            }}
          />
        </div>
      </Card>
      <Dialog open={Boolean(selected)} title={selected ? `Exit · ${selected.employeeName}` : "Exit"} onClose={() => setOpenId(null)} wide>
        {selected && (
          <div className="stack">
            <Banner message={message} />
            <ExitDetail row={selected} onMessage={setMessage} />
          </div>
        )}
      </Dialog>
    </Page>
  );
}

export function TeamExitsPage() {
  return <ExitsBoard scope="team" />;
}

export function AllExitsPage() {
  return <ExitsBoard scope="all" />;
}
