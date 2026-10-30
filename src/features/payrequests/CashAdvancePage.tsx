import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { API_ENABLED } from "../../api/client.ts";
import { ActionButton, Banner, Card, EmptyState, Field, Page, StatusBadge, SubmitButton, Tabs, useAction } from "../../components/ui.tsx";
import { money } from "../../countryPay.ts";
import { addDaysISO, formatShortDate, todayISO } from "../../model.ts";
import { usePortal } from "../../store.tsx";
import { hasReports } from "../../data/delegations.ts";
import {
  apiCashPolicy,
  canSeeAllCash,
  cashMirror,
  cashViews,
  decideCash,
  getCashSnapshot,
  localCashPolicy,
  payCash,
  submitCash,
  subscribeCash,
  withdrawCash,
  type CashPolicy,
  type CashView,
} from "./cashStore.ts";
import { MAX_INSTALMENTS, monthLabel, neededByMax, previewSchedule, waitingOn, type Instalment } from "./rules.ts";
import { DecideBar, Tracker, approvalStages, type Stage } from "./Tracker.tsx";

type Msg = { tone: "ok" | "err" | "warn" | "info"; text: string } | null;

const PLANS = [1, 2, 3, 6].filter((n) => n <= MAX_INSTALMENTS);

function statusText(v: CashView): string {
  if (v.status === "Paid") return v.outstanding > 0 ? "Repaying" : "Repaid";
  if (v.status === "Submitted" || v.status === "Manager approved") return "Waiting";
  return v.status;
}

function tone(v: CashView): "ok" | "warn" | "danger" | "info" | "neutral" {
  if (v.status === "Paid") return v.outstanding > 0 ? "info" : "ok";
  if (v.status === "Approved") return "ok";
  if (v.status === "Rejected") return "danger";
  if (v.status === "Withdrawn") return "neutral";
  return "warn";
}

function stagesFor(v: CashView): Stage[] {
  const paid = v.status === "Paid";
  const recovered = v.schedule.filter((i) => i.recovered).length;
  return approvalStages({
    submittedOn: v.submittedOn,
    steps: v.steps,
    closed: v.status === "Withdrawn" ? "withdrawn" : v.status === "Rejected" ? "rejected" : null,
    after: [
      {
        label: "Paid",
        state: paid ? "done" : v.status === "Approved" ? "current" : "todo",
        detail: paid ? [v.paidOn ? formatShortDate(v.paidOn) : "", v.reference].filter(Boolean).join(" · ") : v.status === "Approved" ? "Being paid out" : undefined,
      },
      {
        label: "Repaid",
        state: paid && v.outstanding === 0 ? "done" : paid ? "current" : "todo",
        detail: paid ? `${recovered} of ${v.schedule.length} instalments` : undefined,
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

function AdvanceCard({ v, actorId, onMessage }: { v: CashView; actorId: string; onMessage: (m: Msg) => void }) {
  const { demoProfile } = usePortal();
  const [reference, setReference] = useState("");
  const mine = v.employeeId === actorId;
  return (
    <article className="pr-item">
      <div className="pr-item-head">
        <div>
          <h3>
            {mine ? v.category : `${v.employeeName} · ${v.category}`}
          </h3>
          <p>
            Asked {formatShortDate(v.submittedOn)} · needed by {formatShortDate(v.neededBy)} ·{" "}
            {v.instalments === 1 ? "one payment" : `${v.instalments} monthly instalments`}
          </p>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="pr-amount">{money(v.amount, v.currency)}</div>
          <StatusBadge status={statusText(v)} tone={tone(v)} literal />
        </div>
      </div>
      {v.purpose && <p className="muted" style={{ margin: 0 }}>{v.purpose}</p>}
      <Tracker stages={stagesFor(v)} label="Cash advance progress" />
      {v.status === "Paid" && (
        <>
          <div className="pr-calc">
            <div className="row">
              <span>Paid</span>
              <strong>{money(v.amount, v.currency)}</strong>
            </div>
            <div className="row total">
              <span>Still to repay</span>
              <span>{money(v.outstanding, v.currency)}</span>
            </div>
            <span className="muted">Deducted from your pay each month. Shown on your payslips.</span>
          </div>
          <ScheduleTable rows={v.schedule} currency={v.currency} />
        </>
      )}
      {v.canDecide && (
        <DecideBar
          onDecide={async (decision, note) => {
            const error = await decideCash(demoProfile, v.id, decision, note);
            onMessage(error ? { tone: "err", text: error } : { tone: "ok", text: decision === "approve" ? `Approved for ${v.employeeName}.` : "Declined." });
            return error;
          }}
        />
      )}
      {v.canPay && (
        <div className="pr-actions">
          <input value={reference} maxLength={64} onChange={(e) => setReference(e.target.value)} placeholder="Payment reference (optional)" aria-label="Payment reference" />
          <ActionButton
            className="btn"
            toastError
            busyLabel="Paying…"
            doneLabel="Paid"
            success={`${money(v.amount, v.currency)} paid to ${v.employeeName}.`}
            onAction={async () => {
              const error = await payCash(demoProfile, v.id, reference);
              onMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Marked as paid. Recovery starts next month." });
              return error ?? true;
            }}
          >
            Mark paid
          </ActionButton>
        </div>
      )}
      {v.canWithdraw && (
        <div className="pr-actions">
          <span className="muted">{waitingOn(v.steps) ? `With ${waitingOn(v.steps)}` : ""}</span>
          <span className="spacer" />
          <ActionButton
            className="btn-ghost btn-tiny"
            toastError
            success="Request withdrawn."
            onAction={async () => {
              const error = await withdrawCash(demoProfile, v.id);
              onMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Request withdrawn." });
              return error ?? true;
            }}
          >
            Withdraw
          </ActionButton>
        </div>
      )}
    </article>
  );
}

function NewAdvanceForm({ policy, onMessage }: { policy: CashPolicy; onMessage: (m: Msg) => void }) {
  const { demoProfile } = usePortal();
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("");
  const [purpose, setPurpose] = useState("");
  const [neededBy, setNeededBy] = useState(() => addDaysISO(todayISO(), 7));
  const [plan, setPlan] = useState(1);
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
          const error = await submitCash(demoProfile, { amount: value, category, purpose, neededBy, instalments: plan }, policy);
          onMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Sent for approval." });
          if (!error) {
            setAmount("");
            setCategory("");
            setPurpose("");
            setNeededBy(addDaysISO(todayISO(), 7));
            setPlan(1);
          }
          return error ?? true;
        },
        { success: "Cash advance sent for approval.", toastError: true },
      )}
    >
      <div className="pr-grid">
        <Field label={`Amount (${policy.currency})`}>
          <input type="number" min={1} max={policy.limit} step={1} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Needed by">
          <input type="date" min={today} max={neededByMax(today)} value={neededBy} onChange={(e) => setNeededBy(e.target.value)} />
        </Field>
      </div>
      <p className={`pr-note${over ? " err" : ""}`} style={{ margin: 0 }}>
        Up to {money(policy.limit, policy.currency)} · one month's basic pay{policy.cap < policy.basic ? " (country limit)" : ""}. One open advance at a time.
      </p>
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
      <Field label="Details (optional)" wide>
        <textarea rows={2} maxLength={1000} value={purpose} onChange={(e) => setPurpose(e.target.value)} />
      </Field>
      <div>
        <p className="muted" style={{ margin: "0 0 6px" }}>Repay</p>
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
          <p className="muted" style={{ margin: "0 0 6px" }}>Repayment plan (if paid this month)</p>
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

function useCashPolicy(rowsKey: unknown): CashPolicy | null {
  const { demoProfile } = usePortal();
  const [server, setServer] = useState<CashPolicy | null>(null);
  useEffect(() => {
    if (!API_ENABLED) return;
    let live = true;
    apiCashPolicy()
      .then((p) => live && setServer(p))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [rowsKey]);
  if (API_ENABLED) return server;
  return localCashPolicy(demoProfile);
}

export function CashAdvancePage() {
  const { demoProfile } = usePortal();
  const snapshot = useSyncExternalStore(subscribeCash, getCashSnapshot, getCashSnapshot);
  const rows = useMemo(() => cashViews(demoProfile), [snapshot, demoProfile]);
  const policy = useCashPolicy(snapshot);
  const [message, setMessage] = useState<Msg>(null);
  const mine = rows.filter((r) => r.employeeId === demoProfile.id);
  const open = mine.find((r) => r.status === "Submitted" || r.status === "Manager approved" || r.status === "Approved" || (r.status === "Paid" && r.outstanding > 0));
  const history = mine.filter((r) => r !== open);
  const toAct = rows.filter((r) => r.employeeId !== demoProfile.id && (r.canDecide || r.canPay));
  const allowedAll = canSeeAllCash(demoProfile.role);
  const others = rows.filter((r) => r.employeeId !== demoProfile.id);
  const showTeam = toAct.length > 0 || allowedAll || hasReports(demoProfile.id);
  const [tab, setTab] = useState("mine");
  const loading = API_ENABLED && !cashMirror.loaded();

  return (
    <Page title="Cash advance">
      <Banner message={message} />
      {showTeam && (
        <Tabs
          tabs={[
            { id: "mine", label: "My advance" },
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
              <AdvanceCard v={open} actorId={demoProfile.id} onMessage={setMessage} />
            </Card>
          ) : (
            <Card title="New advance">
              {loading || !policy ? <p className="muted">Loading…</p> : <NewAdvanceForm policy={policy} onMessage={setMessage} />}
            </Card>
          )}
          {history.length > 0 && (
            <Card title="Earlier advances">
              <div className="pr-list">
                {history.map((v) => (
                  <AdvanceCard key={v.id} v={v} actorId={demoProfile.id} onMessage={setMessage} />
                ))}
              </div>
            </Card>
          )}
        </>
      )}
      {showTeam && tab === "act" && (
        <Card title="To action">
          {toAct.length === 0 ? (
            <EmptyState title="Nothing waiting on you" />
          ) : (
            <div className="pr-list">
              {toAct.map((v) => (
                <AdvanceCard key={v.id} v={v} actorId={demoProfile.id} onMessage={setMessage} />
              ))}
            </div>
          )}
        </Card>
      )}
      {showTeam && tab === "all" && (
        <Card title={allowedAll ? "All advances" : "Team"}>
          {others.length === 0 ? (
            <EmptyState title="No advances yet" />
          ) : (
            <div className="pr-list">
              {others.map((v) => (
                <AdvanceCard key={v.id} v={v} actorId={demoProfile.id} onMessage={setMessage} />
              ))}
            </div>
          )}
        </Card>
      )}
    </Page>
  );
}
