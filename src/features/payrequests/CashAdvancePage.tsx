import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { API_ENABLED } from "../../api/client.ts";
import { ActionButton, Banner, Card, Dialog, EmptyState, Field, Page, StatusBadge, SubmitButton, Tabs, notify, useAction } from "../../components/ui.tsx";
import { money } from "../../countryPay.ts";
import { addDaysISO, formatShortDate, todayISO } from "../../model.ts";
import { usePortal } from "../../store.tsx";
import { hasReports } from "../../data/delegations.ts";
import { tripLabel, useTravelRequests } from "../../data/travelStore.ts";
import {
  apiCashPolicy,
  canSeeAllCash,
  cashMirror,
  cashViews,
  decideCash,
  getCashSnapshot,
  localCashPolicy,
  payCash,
  settleCash,
  submitCash,
  subscribeCash,
  verifySettlement,
  withdrawCash,
  type CashPolicy,
  type CashView,
} from "./cashStore.ts";
import { MAX_INSTALMENTS, SETTLEMENT_MAX_DAYS, monthLabel, neededByMax, previewSchedule, waitingOn, type Instalment } from "./rules.ts";
import { DecideBar, Tracker, approvalStages, type Stage } from "./Tracker.tsx";
import {
  ConfirmButton,
  CsvButton,
  Facts,
  ListFilters,
  LoadState,
  RequestThread,
  SummaryTiles,
  applyFilters,
  useListFilters,
  useOpenFromQuery,
  useServerValue,
} from "./requestKit.tsx";
import { ATTACH_TYPES, addComment, addFile, type ThreadContext } from "./threadStore.ts";

type Msg = { tone: "ok" | "err" | "warn" | "info"; text: string } | null;

const PLANS = [1, 2, 3, 6].filter((n) => n <= MAX_INSTALMENTS);
const STATUSES = ["Waiting", "Approved", "Disbursed", "Settlement pending", "Settled", "Repaid", "Declined", "Withdrawn"];

export const refOf = (id: string) => id.toUpperCase();

function statusText(v: CashView): string {
  if (v.status === "Settled") return "Settled";
  if (v.status === "Paid") {
    if (v.settlementStatus === "Submitted") return "Settlement pending";
    return v.outstanding > 0 ? "Disbursed" : "Repaid";
  }
  if (v.status === "Submitted" || v.status === "Manager approved") return "Waiting";
  if (v.status === "Rejected") return "Declined";
  return v.status;
}

function tone(v: CashView): "ok" | "warn" | "danger" | "info" | "neutral" {
  if (v.status === "Settled") return "ok";
  if (v.status === "Paid") return v.outstanding > 0 ? "info" : "ok";
  if (v.status === "Approved") return "ok";
  if (v.status === "Rejected") return "danger";
  if (v.status === "Withdrawn") return "neutral";
  return "warn";
}

function stagesFor(v: CashView): Stage[] {
  const paid = v.status === "Paid" || v.status === "Settled";
  const recovered = v.schedule.filter((i) => i.recovered).length;
  return approvalStages({
    submittedOn: v.submittedOn,
    steps: v.steps,
    closed: v.status === "Withdrawn" ? "withdrawn" : v.status === "Rejected" ? "rejected" : null,
    after: [
      {
        label: "Disbursed",
        state: paid ? "done" : v.status === "Approved" ? "current" : "todo",
        detail: paid ? [v.paidOn ? formatShortDate(v.paidOn) : "", v.reference].filter(Boolean).join(" · ") : v.status === "Approved" ? "Being paid out" : undefined,
      },
      {
        label: "Settled",
        state: v.status === "Settled" ? "done" : v.settlementStatus === "Rejected" ? "declined" : paid ? "current" : "todo",
        detail:
          v.status === "Settled"
            ? [v.settlementVerifiedBy, v.settlementVerifiedOn ? formatShortDate(v.settlementVerifiedOn) : ""].filter(Boolean).join(" · ")
            : v.settlementStatus === "Submitted"
              ? "Being verified"
              : paid
                ? `${recovered} of ${v.schedule.length} instalments recovered`
                : undefined,
      },
    ],
  });
}

export function ScheduleTable({ rows, currency }: { rows: Instalment[]; currency: string }) {
  return (
    <table className="pr-schedule">
      <thead>
        <tr>
          <th>#</th>
          <th>Deducted from</th>
          <th className="num">Amount</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.month} className={r.recovered ? "recovered" : undefined}>
            <td>{i + 1}</td>
            <td>{monthLabel(r.month)} pay</td>
            <td className="num">{money(r.amount, currency)}</td>
            <td>{r.recovered ? "Recovered" : "Due"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One row in a list: click (or Enter) opens the details. */
function AdvanceRow({ v, actorId, onOpen }: { v: CashView; actorId: string; onOpen: () => void }) {
  const mine = v.employeeId === actorId;
  return (
    <article
      className="pr-item clickable"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      aria-label={`Open cash advance ${refOf(v.id)}`}
    >
      <div className="pr-item-head">
        <div>
          <h3>{mine ? v.category : `${v.employeeName} · ${v.category}`}</h3>
          <p>
            <span className="pr-id">{refOf(v.id)}</span> · asked {formatShortDate(v.submittedOn)} · needed by {formatShortDate(v.neededBy)}
            {v.expectedSettlement ? ` · settle by ${formatShortDate(v.expectedSettlement)}` : ""}
          </p>
          {v.infoRequested && <span className="pr-flag">More information requested</span>}
          {v.settlementOverdue && <span className="pr-flag"> Settlement overdue</span>}
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="pr-amount">{money(v.amount, v.currency)}</div>
          <StatusBadge status={statusText(v)} tone={tone(v)} literal />
        </div>
      </div>
      <Tracker stages={stagesFor(v)} label="Cash advance progress" />
    </article>
  );
}

function SettlementForm({ v, onMessage }: { v: CashView; onMessage: (m: Msg) => void }) {
  const { demoProfile } = usePortal();
  const [spent, setSpent] = useState("");
  const [note, setNote] = useState("");
  const [reference, setReference] = useState("");
  const act = useAction();
  const spentValue = Number(spent) || 0;
  const returned = Math.max(0, Math.round((v.settlementDue - spentValue) * 100) / 100);
  const ctx: ThreadContext = { actorId: demoProfile.id, actorName: demoProfile.fullName, ownerId: v.employeeId, canDecide: false, reviewer: false, label: "cash advance", href: `/cash?open=${v.id}` };
  const [fileKey, setFileKey] = useState(0);
  return (
    <form
      className="pr-form"
      onSubmit={act.submit(
        async () => {
          const error = await settleCash(demoProfile, v.id, { spent: spentValue, returned, note, reference });
          onMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Settlement sent for verification." });
          return error ?? true;
        },
        { success: "Settlement sent for verification.", toastError: true },
      )}
    >
      <p className="pr-note" style={{ margin: 0 }}>
        Account for {money(v.settlementDue, v.currency)}: what you spent (with receipts) plus the unspent money you return. Spending above the advance is claimed as a reimbursement.
      </p>
      {v.settlementStatus === "Rejected" && v.settlementNote && <Banner message={{ tone: "warn", text: `Sent back: ${v.settlementNote}` }} />}
      <div className="pr-grid">
        <Field label={`Actual spend (${v.currency})`}>
          <input type="number" min={0} max={v.settlementDue} step="0.01" value={spent} onChange={(e) => setSpent(e.target.value)} required />
        </Field>
        <Field label={`Unspent to return (${v.currency})`}>
          <input type="number" value={returned} readOnly aria-readonly="true" />
        </Field>
        {returned > 0 && (
          <Field label="Return transfer reference" wide>
            <input value={reference} maxLength={64} onChange={(e) => setReference(e.target.value)} placeholder="Bank transfer / receipt number" />
          </Field>
        )}
        <Field label="Note (optional)" wide>
          <textarea rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      <div className="pr-actions">
        <label className="btn-ghost btn-tiny pr-file-btn">
          Attach receipts
          <input
            key={fileKey}
            type="file"
            accept={ATTACH_TYPES}
            multiple
            onChange={async (e) => {
              const files = [...(e.target.files ?? [])];
              setFileKey((k) => k + 1);
              for (const f of files) {
                const err = await addFile("cash_advance", v.id, ctx, f, "settlement");
                notify(err ?? `${f.name} attached.`);
              }
            }}
          />
        </label>
        <span className="muted">Receipts appear under Files below.</span>
        <span className="spacer" />
        <SubmitButton action={act} className="btn">
          Submit settlement
        </SubmitButton>
      </div>
    </form>
  );
}

function AdvanceDetail({ v, onClose, onMessage }: { v: CashView; onClose: () => void; onMessage: (m: Msg) => void }) {
  const { demoProfile } = usePortal();
  const trips = useTravelRequests();
  const [reference, setReference] = useState("");
  const [verifyNote, setVerifyNote] = useState("");
  const trip = v.tripId ? trips.find((t) => t.id === v.tripId) : undefined;
  const mine = v.employeeId === demoProfile.id;
  const reviewer = canSeeAllCash(demoProfile.role);
  const ctx: ThreadContext = {
    actorId: demoProfile.id,
    actorName: demoProfile.fullName,
    ownerId: v.employeeId,
    canDecide: v.canDecide,
    reviewer: reviewer && !mine,
    label: "cash advance",
    href: `/cash?open=${v.id}`,
  };
  return (
    <Dialog open title={`Cash advance ${refOf(v.id)}`} onClose={onClose} wide>
      <div className="pr-detail">
        <div className="pr-item-head">
          <div>
            <h3>{mine ? v.category : `${v.employeeName} · ${v.category}`}</h3>
            <p>{v.purpose}</p>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="pr-amount">{money(v.amount, v.currency)}</div>
            <StatusBadge status={statusText(v)} tone={tone(v)} literal />
          </div>
        </div>
        {v.settlementOverdue && <Banner message={{ tone: "warn", text: `Settlement was due ${formatShortDate(v.expectedSettlement ?? "")}.` }} />}
        <Facts
          items={[
            ["Request ID", refOf(v.id)],
            ["Employee", v.employeeName],
            ["Asked on", formatShortDate(v.submittedOn)],
            ["Needed by", formatShortDate(v.neededBy)],
            ["Settle by", v.expectedSettlement ? formatShortDate(v.expectedSettlement) : "—"],
            ["Repayment", v.instalments === 1 ? "One payment" : `${v.instalments} monthly instalments`],
            ["Trip", trip ? tripLabel(trip) : v.tripId ? v.tripId : ""],
            ["Project", v.project ?? ""],
            ["Disbursed", v.paidOn ? `${formatShortDate(v.paidOn)}${v.paidBy ? ` · ${v.paidBy}` : ""}` : "Not yet"],
            ["Payment reference", v.reference ?? ""],
            ["Still to repay", v.status === "Paid" ? money(v.outstanding, v.currency) : ""],
          ]}
        />
        <section>
          <h4>Progress</h4>
          <Tracker stages={stagesFor(v)} label="Cash advance progress" />
          {waitingOn(v.steps) && (v.status === "Submitted" || v.status === "Manager approved") && <p className="muted">With {waitingOn(v.steps)}</p>}
        </section>
        <section>
          <h4>Approval history</h4>
          {v.steps.length === 0 ? (
            <p className="muted">No approval steps.</p>
          ) : (
            <ul className="pr-audit">
              {v.steps.map((s, i) => (
                <li key={`${s.label}-${i}`}>
                  <span>
                    {s.label}: {s.decision === "approve" ? "Approved" : s.decision === "reject" ? "Declined" : "Waiting"}
                    {s.note ? ` · “${s.note}”` : ""}
                  </span>
                  <span className="muted">{s.by ? `${s.by}${s.on ? ` · ${formatShortDate(s.on)}` : ""}` : s.approverNames.slice(0, 3).join(", ")}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        {(v.status === "Paid" || v.status === "Settled") && v.schedule.length > 0 && (
          <section>
            <h4>Repayment from pay</h4>
            {v.status === "Settled" && <p className="muted">Settled: recovery from pay stopped.</p>}
            <ScheduleTable rows={v.schedule} currency={v.currency} />
          </section>
        )}
        {v.settlementStatus && (
          <section>
            <h4>Settlement</h4>
            <Facts
              items={[
                ["Status", v.settlementStatus === "Submitted" ? "Waiting for verification" : v.settlementStatus],
                ["Spent", v.settlementSpent !== undefined ? money(v.settlementSpent, v.currency) : ""],
                ["Returned", v.settlementReturned !== undefined ? money(v.settlementReturned, v.currency) : ""],
                ["Return reference", v.settlementReference ?? ""],
                ["Submitted", v.settlementOn ? formatShortDate(v.settlementOn) : ""],
                ["Verified by", v.settlementVerifiedBy ? `${v.settlementVerifiedBy}${v.settlementVerifiedOn ? ` · ${formatShortDate(v.settlementVerifiedOn)}` : ""}` : ""],
              ]}
            />
            {v.settlementNote && <p className="muted" style={{ whiteSpace: "pre-line" }}>{v.settlementNote}</p>}
          </section>
        )}
        {v.canSettle && (
          <section>
            <h4>Settle this advance</h4>
            <SettlementForm v={v} onMessage={onMessage} />
          </section>
        )}
        {v.canVerifySettlement && (
          <section>
            <h4>Verify settlement</h4>
            <div className="pr-form">
              <Field label="Note">
                <input value={verifyNote} maxLength={500} onChange={(e) => setVerifyNote(e.target.value)} placeholder="Needed to send it back" />
              </Field>
              <div className="pr-actions">
                <ActionButton
                  className="btn"
                  toastError
                  success="Settlement verified."
                  onAction={async () => {
                    const error = await verifySettlement(demoProfile, v.id, "verify", verifyNote);
                    onMessage(error ? { tone: "err", text: error } : { tone: "ok", text: `Settlement verified for ${v.employeeName}.` });
                    return error ?? true;
                  }}
                >
                  Verify settlement
                </ActionButton>
                <ActionButton
                  className="btn-ghost"
                  toastError
                  success="Settlement sent back."
                  onAction={async () => {
                    if (!verifyNote.trim()) return "Add a note saying what is missing.";
                    const error = await verifySettlement(demoProfile, v.id, "reject", verifyNote);
                    onMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Settlement sent back." });
                    return error ?? true;
                  }}
                >
                  Send back
                </ActionButton>
              </div>
            </div>
          </section>
        )}
        {v.canDecide && (
          <section>
            <h4>Your decision</h4>
            <DecideBar
              onDecide={async (decision, note) => {
                const error = await decideCash(demoProfile, v.id, decision, note);
                onMessage(error ? { tone: "err", text: error } : { tone: "ok", text: decision === "approve" ? `Approved for ${v.employeeName}.` : "Declined." });
                return error;
              }}
              onRequestInfo={async (note) => {
                const error = await addComment("cash_advance", v.id, ctx, note, true);
                onMessage(error ? { tone: "err", text: error } : { tone: "ok", text: `Asked ${v.employeeName} for more information.` });
                if (!error && API_ENABLED) await cashMirror.reload();
                return error;
              }}
            />
          </section>
        )}
        {v.canPay && (
          <section>
            <h4>Record disbursement</h4>
            <div className="pr-actions">
              <input value={reference} maxLength={64} onChange={(e) => setReference(e.target.value)} placeholder="Payment reference (optional)" aria-label="Payment reference" />
              <ActionButton
                className="btn"
                toastError
                busyLabel="Saving…"
                doneLabel="Disbursed"
                success={`${money(v.amount, v.currency)} disbursed to ${v.employeeName}.`}
                onAction={async () => {
                  const error = await payCash(demoProfile, v.id, reference);
                  onMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Disbursement recorded. Recovery from pay starts next month unless it is settled first." });
                  return error ?? true;
                }}
              >
                Mark disbursed
              </ActionButton>
            </div>
          </section>
        )}
        {v.canWithdraw && (
          <div className="pr-actions">
            <span className="spacer" />
            <ConfirmButton
              title="Withdraw this cash advance?"
              message={<p>{refOf(v.id)} for {money(v.amount, v.currency)} will be withdrawn and your approvers told. You can ask again later.</p>}
              confirmLabel="Withdraw request"
              success="Request withdrawn."
              onConfirm={async () => {
                const error = await withdrawCash(demoProfile, v.id);
                onMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Request withdrawn." });
                if (!error) onClose();
                return error;
              }}
            >
              Withdraw
            </ConfirmButton>
          </div>
        )}
        <RequestThread
          refreshKey={`${v.status}|${v.infoRequested}|${v.settlementStatus ?? ""}|${v.steps.map((s) => s.decision ?? "").join(",")}`}
          type="cash_advance"
          id={v.id}
          ctx={ctx}
          filePurposes={mine && (v.status === "Paid" || v.status === "Settled") ? ["settlement", "supporting"] : ["supporting"]}
          onChanged={() => {
            if (API_ENABLED) void cashMirror.reload();
          }}
        />
      </div>
    </Dialog>
  );
}

function NewAdvanceForm({ policy, onMessage, onCreated }: { policy: CashPolicy; onMessage: (m: Msg) => void; onCreated: (id: string) => void }) {
  const { demoProfile, currentProjects } = usePortal();
  const trips = useTravelRequests();
  const myTrips = trips.filter((t) => t.employeeId === demoProfile.id && (t.status === "approved" || t.status === "pending"));
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("");
  const [purpose, setPurpose] = useState("");
  const [neededBy, setNeededBy] = useState(() => addDaysISO(todayISO(), 7));
  const [settleBy, setSettleBy] = useState("");
  const [tripId, setTripId] = useState("");
  const [project, setProject] = useState("");
  const [plan, setPlan] = useState(1);
  const [files, setFiles] = useState<File[]>([]);
  const [fileKey, setFileKey] = useState(0);
  const act = useAction();
  const value = Number(amount);
  const over = value > policy.limit;
  const preview = value > 0 && !over ? previewSchedule(value, plan) : [];
  const today = todayISO();

  return (
    <form
      className="pr-form"
      onSubmit={act.submit(
        async () => {
          if (!category) return "Choose a purpose.";
          const result = await submitCash(
            demoProfile,
            { amount: value, category, purpose, neededBy, instalments: plan, expectedSettlement: settleBy || undefined, tripId: tripId || undefined, project: project || undefined },
            policy,
          );
          if (result.error) {
            onMessage({ tone: "err", text: result.error });
            return result.error;
          }
          const ctx: ThreadContext = { actorId: demoProfile.id, actorName: demoProfile.fullName, ownerId: demoProfile.id, canDecide: false, reviewer: false, label: "cash advance", href: "/cash" };
          const failed: string[] = [];
          for (const f of files) {
            const err = result.id ? await addFile("cash_advance", result.id, ctx, f, "supporting") : "No request id";
            if (err) failed.push(`${f.name}: ${err}`);
          }
          if (API_ENABLED) await cashMirror.reload();
          onMessage({
            tone: failed.length ? "warn" : "ok",
            text: `Sent for approval as ${refOf(result.id ?? "")}.${failed.length ? ` Some files weren't added (${failed.join("; ")}); add them from the request.` : ""}`,
          });
          setAmount("");
          setCategory("");
          setPurpose("");
          setNeededBy(addDaysISO(todayISO(), 7));
          setSettleBy("");
          setTripId("");
          setProject("");
          setPlan(1);
          setFiles([]);
          setFileKey((k) => k + 1);
          if (result.id) onCreated(result.id);
          return true;
        },
        { success: "Cash advance sent for approval.", toastError: true },
      )}
    >
      <div>
        <p className="muted" style={{ margin: "0 0 6px" }}>Purpose</p>
        <div className="pr-choice-row" role="group" aria-label="Purpose">
          {policy.categories.map((c) => (
            <button key={c} type="button" className="pr-choice" aria-pressed={category === c} onClick={() => setCategory(c)}>
              {c}
            </button>
          ))}
        </div>
      </div>
      <div className="pr-grid">
        <Field label={`Amount (${policy.currency})`}>
          <input type="number" min={1} max={policy.limit} step={1} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </Field>
        <Field label="Currency">
          <input value={`${policy.currency} · your pay currency`} readOnly aria-readonly="true" />
        </Field>
        <Field label="Needed by">
          <input type="date" min={today} max={neededByMax(today)} value={neededBy} onChange={(e) => setNeededBy(e.target.value)} required />
        </Field>
        <Field label="Expected settlement date (optional)">
          <input type="date" min={neededBy || today} max={addDaysISO(neededBy || today, SETTLEMENT_MAX_DAYS)} value={settleBy} onChange={(e) => setSettleBy(e.target.value)} />
        </Field>
        <Field label="Related trip (optional)">
          <select value={tripId} onChange={(e) => setTripId(e.target.value)}>
            <option value="">No trip</option>
            {myTrips.map((t) => (
              <option key={t.id} value={t.id}>
                {tripLabel(t)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Related project (optional)">
          <select value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">No project</option>
            {currentProjects.map((p) => (
              <option key={p.id} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Description" wide>
          <textarea rows={2} maxLength={1000} value={purpose} onChange={(e) => setPurpose(e.target.value)} required placeholder="What the money is for" />
        </Field>
        <Field label="Supporting documents (optional, PDF or image, up to 5 MB each)" wide>
          <input key={fileKey} type="file" multiple accept={ATTACH_TYPES} onChange={(e) => setFiles([...(e.target.files ?? [])])} />
        </Field>
      </div>
      <p className={`pr-note${over ? " err" : ""}`} style={{ margin: 0 }}>
        Up to {money(policy.limit, policy.currency)}: one month's basic pay{policy.paySource === "compensation" ? " from your pay record" : " (standard package for your role)"}
        {policy.cap < policy.basic ? `, capped at the country limit of ${money(policy.cap, policy.currency)}` : ""}. One open advance at a time. Unless you settle it with receipts, it is recovered from your pay.
      </p>
      <div>
        <p className="muted" style={{ margin: "0 0 6px" }}>Repay from pay</p>
        <div className="pr-choice-row" role="group" aria-label="Repayment">
          {PLANS.map((n) => (
            <button key={n} type="button" className="pr-choice" aria-pressed={plan === n} onClick={() => setPlan(n)}>
              {n === 1 ? "One time" : `${n} months`}
              {value > 0 && !over && <small>{money(Math.round((value / n) * 100) / 100, policy.currency)} / month</small>}
            </button>
          ))}
        </div>
      </div>
      {preview.length > 0 && (
        <div>
          <p className="muted" style={{ margin: "0 0 6px" }}>Repayment plan (estimate, if disbursed this month)</p>
          <ScheduleTable rows={preview} currency={policy.currency} />
        </div>
      )}
      <div className="pr-actions">
        <SubmitButton action={act} className="btn" disabled={over}>
          Submit request
        </SubmitButton>
      </div>
    </form>
  );
}

function moneyAll(rows: CashView[], pick: (v: CashView) => number, fallback: string): string {
  const byCur = new Map<string, number>();
  for (const v of rows) byCur.set(v.currency, (byCur.get(v.currency) ?? 0) + pick(v));
  if (byCur.size === 0) return money(0, fallback);
  return [...byCur.entries()].map(([c, n]) => money(Math.round(n * 100) / 100, c)).join(" + ");
}

function csvRows(rows: CashView[]): unknown[][] {
  return rows.map((v) => [
    refOf(v.id),
    v.employeeName,
    v.category,
    v.purpose,
    v.amount,
    v.currency,
    statusText(v),
    v.submittedOn,
    v.neededBy,
    v.expectedSettlement ?? "",
    v.paidOn ?? "",
    v.reference ?? "",
    v.outstanding,
    v.settlementStatus ?? "",
    v.settlementSpent ?? "",
    v.settlementReturned ?? "",
  ]);
}

const CSV_HEADERS = ["ID", "Employee", "Purpose", "Description", "Amount", "Currency", "Status", "Asked on", "Needed by", "Settle by", "Disbursed on", "Payment reference", "Outstanding", "Settlement", "Spent", "Returned"];

function AdvanceList({ rows, actorId, onOpen, filename, empty }: { rows: CashView[]; actorId: string; onOpen: (id: string) => void; filename: string; empty: string }) {
  const f = useListFilters();
  const shown = applyFilters(rows, f.filters, {
    text: (v) => `${v.id} ${v.employeeName} ${v.category} ${v.purpose} ${v.project ?? ""}`,
    status: statusText,
    date: (v) => v.submittedOn,
    category: (v) => v.category,
  });
  const categories = [...new Set(rows.map((r) => r.category))].sort();
  return (
    <>
      <ListFilters state={f.filters} onChange={f.set} onReset={f.reset} statuses={STATUSES} categories={categories} categoryLabel="Purpose" searchPlaceholder="ID, name, purpose" dateLabel="Asked" extra={<CsvButton filename={filename} headers={CSV_HEADERS} rows={() => csvRows(shown)} />} />
      {shown.length === 0 ? (
        <EmptyState title={rows.length ? "No advances match these filters" : empty} />
      ) : (
        <div className="pr-list">
          {shown.map((v) => (
            <AdvanceRow key={v.id} v={v} actorId={actorId} onOpen={() => onOpen(v.id)} />
          ))}
        </div>
      )}
    </>
  );
}

export function CashAdvancePage() {
  const { demoProfile } = usePortal();
  const snapshot = useSyncExternalStore(subscribeCash, getCashSnapshot, getCashSnapshot);
  const rows = useMemo(() => cashViews(demoProfile), [snapshot, demoProfile]);
  // Backend: the policy loads on its own (not cancelled by list reloads) and a failure shows with Retry.
  const server = useServerValue(API_ENABLED ? apiCashPolicy : null, snapshot);
  const policy: CashPolicy | null = API_ENABLED ? server.value : localCashPolicy(demoProfile);
  const [message, setMessage] = useState<Msg>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const mine = rows.filter((r) => r.employeeId === demoProfile.id);
  const open = mine.find((r) => r.status === "Submitted" || r.status === "Manager approved" || r.status === "Approved" || (r.status === "Paid" && r.outstanding > 0 && r.settlementStatus !== "Verified"));
  const toAct = rows.filter((r) => r.employeeId !== demoProfile.id && (r.canDecide || r.canPay || r.canVerifySettlement));
  const allowedAll = canSeeAllCash(demoProfile.role);
  const others = rows.filter((r) => r.employeeId !== demoProfile.id);
  const showTeam = toAct.length > 0 || allowedAll || hasReports(demoProfile.id);
  const [tab, setTab] = useState("mine");
  const listError = API_ENABLED && !cashMirror.loaded() ? cashMirror.lastError() : null;
  const listLoading = API_ENABLED && !cashMirror.loaded() && !listError;
  const opened = openId ? rows.find((r) => r.id === openId) ?? null : null;
  const openRow = useCallback((id: string) => setOpenId(id), []);
  useOpenFromQuery(rows.map((r) => r.id), openRow);
  const currency = policy?.currency ?? mine[0]?.currency ?? demoProfile.currency ?? "INR";
  const overdue = mine.filter((r) => r.settlementOverdue);

  return (
    <Page title="Cash advance">
      <SummaryTiles
        label="My cash advances"
        items={[
          { label: "Requested", value: `${mine.length} · ${moneyAll(mine, (v) => v.amount, currency)}` },
          { label: "Pending", value: mine.filter((v) => v.status === "Submitted" || v.status === "Manager approved").length, tone: "sky" },
          { label: "Approved", value: mine.filter((v) => v.status === "Approved").length },
          { label: "Disbursed", value: moneyAll(mine.filter((v) => v.status === "Paid" || v.status === "Settled"), (v) => v.amount, currency), tone: "lilac" },
          { label: "Outstanding", value: moneyAll(mine.filter((v) => v.status === "Paid"), (v) => v.outstanding, currency), hint: "Still to be recovered from pay or settled" },
          { label: "Settled", value: mine.filter((v) => v.status === "Settled").length },
        ]}
      />
      <Banner message={message} />
      {overdue.length > 0 && (
        <Banner message={{ tone: "warn", text: `Settlement overdue for ${overdue.map((o) => refOf(o.id)).join(", ")}. Open it to add receipts and return any unspent money.` }} />
      )}
      {showTeam && (
        <Tabs
          tabs={[
            { id: "mine", label: "My advances" },
            { id: "act", label: `To action (${toAct.length})` },
            { id: "all", label: allowedAll ? "All advances" : "Team" },
          ]}
          value={tab}
          onChange={setTab}
        />
      )}
      {(!showTeam || tab === "mine") && (
        <>
          {open ? (
            <Card title="Current advance">
              <AdvanceRow v={open} actorId={demoProfile.id} onOpen={() => setOpenId(open.id)} />
              <p className="muted" style={{ marginBottom: 0 }}>One open advance at a time. Open it to see details, settle it or withdraw it.</p>
            </Card>
          ) : (
            <Card title="New advance">
              {!policy ? <LoadState error={server.error} onRetry={server.retry} /> : <NewAdvanceForm policy={policy} onMessage={setMessage} onCreated={setOpenId} />}
            </Card>
          )}
          <Card title="My requests">
            {listLoading ? (
              <p className="muted">Loading…</p>
            ) : listError ? (
              <LoadState error={listError} onRetry={() => void cashMirror.reload()} />
            ) : (
              <AdvanceList rows={mine} actorId={demoProfile.id} onOpen={setOpenId} filename={`cash-advances-${todayISO()}.csv`} empty="No cash advances yet" />
            )}
          </Card>
        </>
      )}
      {showTeam && tab === "act" && (
        <Card title="To action">
          {toAct.length === 0 ? (
            <EmptyState title="Nothing waiting on you" />
          ) : (
            <AdvanceList rows={toAct} actorId={demoProfile.id} onOpen={setOpenId} filename={`cash-advances-to-action-${todayISO()}.csv`} empty="Nothing waiting on you" />
          )}
        </Card>
      )}
      {showTeam && tab === "all" && (
        <Card title={allowedAll ? "All advances" : "Team"}>
          <AdvanceList rows={others} actorId={demoProfile.id} onOpen={setOpenId} filename={`cash-advances-all-${todayISO()}.csv`} empty="No advances yet" />
        </Card>
      )}
      {opened && <AdvanceDetail key={opened.id} v={opened} onClose={() => setOpenId(null)} onMessage={setMessage} />}
    </Page>
  );
}
