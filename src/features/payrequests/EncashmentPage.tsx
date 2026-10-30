import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { API_ENABLED } from "../../api/client.ts";
import { ActionButton, Banner, Card, DataTable, EmptyState, Page, StatusBadge, SubmitButton, Tabs, useAction } from "../../components/ui.tsx";
import { money, payRulesFor } from "../../countryPay.ts";
import { DEMO_ACCOUNTS, managementChain } from "../../demoAccounts.ts";
import { formatShortDate, todayISO, type LeaveCode } from "../../model.ts";
import { usePortal } from "../../store.tsx";
import { getPerson } from "../../data/peopleLocal.ts";
import { isHrRole, lineManagerId, personName } from "../lifecycle/lifecycleShared.ts";
import {
  apiDecideEncashment,
  apiEncashPolicy,
  apiSubmitEncashment,
  apiWithdrawEncashment,
  encashMirror,
  localEncashPolicy,
  localEncashViews,
  type EncashPolicy,
  type EncashView,
} from "./encashStore.ts";
import { monthLabel, payoutMonth, perDayPay } from "./rules.ts";
import { DecideBar, Tracker, approvalStages } from "./Tracker.tsx";

type Msg = { tone: "ok" | "err" | "warn" | "info"; text: string } | null;

function roleOf(id: string): string {
  return DEMO_ACCOUNTS.find((a) => a.id === id)?.role ?? "employee";
}

function countryOf(id: string): string {
  return getPerson(id)?.countryCode ?? DEMO_ACCOUNTS.find((a) => a.id === id)?.countryCode ?? "IN";
}

function statusTone(s: EncashView["status"]): "ok" | "warn" | "danger" | "neutral" {
  return s === "Approved" ? "ok" : s === "Rejected" ? "danger" : s === "Withdrawn" ? "neutral" : "warn";
}

function statusLabel(v: EncashView): string {
  if (v.status === "Approved" && v.payoutMonth) return v.payoutMonth < todayISO().slice(0, 7) ? "Paid" : "Approved";
  return v.status === "Submitted" || v.status === "Manager approved" ? "Waiting" : v.status;
}

function EncashCard({ v, mine, onDecide, onWithdraw }: { v: EncashView; mine: boolean; onDecide?: (d: "approve" | "reject", note: string) => Promise<string | null>; onWithdraw?: () => Promise<string | null> }) {
  const paidMonth = v.payoutMonth;
  return (
    <article className="pr-item">
      <div className="pr-item-head">
        <div>
          <h3>{mine ? `${v.days} ${v.days === 1 ? "day" : "days"} encashed` : `${v.employeeName} · ${v.days} ${v.days === 1 ? "day" : "days"}`}</h3>
          <p>
            Asked {formatShortDate(v.submittedOn)} · {money(v.perDay, v.currency)} a day
          </p>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="pr-amount">{money(v.amount, v.currency)}</div>
          <StatusBadge status={statusLabel(v)} tone={statusTone(v.status)} literal />
        </div>
      </div>
      <Tracker
        label="Encashment progress"
        stages={approvalStages({
          submittedOn: v.submittedOn,
          steps: v.steps,
          closed: v.status === "Withdrawn" ? "withdrawn" : v.status === "Rejected" ? "rejected" : null,
          after: [
            {
              label: "Paid",
              state: v.status === "Approved" ? (paidMonth && paidMonth < todayISO().slice(0, 7) ? "done" : "current") : "todo",
              detail: paidMonth ? `With ${monthLabel(paidMonth)} pay` : undefined,
            },
          ],
        })}
      />
      {onDecide && v.canDecide && <DecideBar onDecide={onDecide} />}
      {onWithdraw && v.canWithdraw && mine && (
        <div className="pr-actions">
          <span className="spacer" />
          <ActionButton className="btn-ghost btn-tiny" toastError success="Encashment withdrawn." onAction={async () => (await onWithdraw()) ?? true}>
            Withdraw
          </ActionButton>
        </div>
      )}
    </article>
  );
}

export function EncashmentPage() {
  const portal = usePortal();
  const { demoProfile, leaveTable, state, applyEncashment, setEncashmentStatus, canDecideFor } = portal;
  const api = useSyncExternalStore(encashMirror.subscribe, encashMirror.get, encashMirror.get);
  const [serverPolicy, setServerPolicy] = useState<EncashPolicy | null>(null);
  const [message, setMessage] = useState<Msg>(null);
  const [tab, setTab] = useState("mine");
  const act = useAction();

  useEffect(() => {
    if (!API_ENABLED) return;
    let live = true;
    apiEncashPolicy()
      .then((p) => live && setServerPolicy(p))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api]);

  const localPerDay = perDayPay(demoProfile.countryCode, demoProfile.role);
  const policy: EncashPolicy | null = API_ENABLED
    ? serverPolicy
    : localEncashPolicy(leaveTable, state.encashments, demoProfile.id, localPerDay, payRulesFor(demoProfile.countryCode).currency);

  const rows: EncashView[] = useMemo(() => {
    if (API_ENABLED) return api.rows;
    const views = localEncashViews(state.encashments, {
      perDayOf: (id) => perDayPay(countryOf(id), roleOf(id)),
      currencyOf: (id) => payRulesFor(countryOf(id) as never).currency,
      nameOf: (id) => personName(id, id),
      approverOf: (id) => {
        const m = lineManagerId(id);
        return m ? personName(m, m) : "HR";
      },
    });
    const ceo = (id: string) => managementChain(id, DEMO_ACCOUNTS).length === 0;
    return views
      .map((v) => ({
        ...v,
        canDecide:
          v.status === "Submitted" &&
          v.employeeId !== demoProfile.id &&
          (ceo(v.employeeId) ? isHrRole(demoProfile.role) : canDecideFor(v.employeeId, "leave")),
        canWithdraw: v.status === "Submitted" && v.employeeId === demoProfile.id,
      }))
      .sort((a, b) => b.submittedOn.localeCompare(a.submittedOn));
  }, [api, state.encashments, demoProfile, canDecideFor]);

  const encashable = policy?.types.find((t) => t.eligible) ?? policy?.types.find((t) => t.code === "pto");
  const max = encashable?.encashable ?? 0;
  const [days, setDays] = useState(1);
  const picked = Math.min(Math.max(0.5, days), Math.max(0.5, max));
  const mine = rows.filter((r) => r.employeeId === demoProfile.id);
  const waiting = mine.find((r) => r.status === "Submitted" || r.status === "Manager approved");
  const toAct = rows.filter((r) => r.employeeId !== demoProfile.id && r.canDecide);
  const showTeam = toAct.length > 0 || isHrRole(demoProfile.role);
  const amount = policy ? Math.round(policy.perDay * picked * 100) / 100 : 0;
  const paidWith = monthLabel(payoutMonth(todayISO()));

  async function decide(v: EncashView, decision: "approve" | "reject", note: string): Promise<string | null> {
    const error = API_ENABLED
      ? await apiDecideEncashment(v.id, decision, note)
      : setEncashmentStatus(v.id, decision === "approve" ? "approved" : "rejected", note.trim() || undefined);
    setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: decision === "approve" ? `Approved for ${v.employeeName}.` : "Declined." });
    return error;
  }

  async function withdraw(v: EncashView): Promise<string | null> {
    const error = API_ENABLED ? await apiWithdrawEncashment(v.id) : setEncashmentStatus(v.id, "withdrawn");
    setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Encashment withdrawn." });
    return error;
  }

  return (
    <Page title="Leave encashment">
      <Banner message={message} />
      {showTeam && (
        <Tabs
          tabs={[
            { id: "mine", label: "My encashment" },
            { id: "act", label: `To approve (${toAct.length})` },
          ]}
          value={tab}
          onChange={setTab}
        />
      )}
      {(!showTeam || tab === "mine") && (
        <>
          <Card title="What you can encash">
            {!policy ? (
              <p className="muted">Loading…</p>
            ) : (
              <div className="pr-form">
                <DataTable
                  headers={["Leave type", "Available", "Can encash", ""]}
                  rows={policy.types
                    // Only leave types that can be encashed at all (not leave without pay, sick leave, …).
                    .filter((t) => t.eligible || t.whyNot !== "Not encashable")
                    .map((t) => [t.name, String(t.available), t.eligible ? String(t.encashable) : "—", <span className="muted">{t.eligible ? "" : t.whyNot}</span>])}
                  empty={<EmptyState title="No encashable leave" />}
                />
                <p className="pr-note" style={{ margin: 0 }}>
                  {/* The encashable type is named per country (Privilege leave in India, Paid time off in the US). */}
                  {policy.types.filter((t) => t.eligible || (t.whyNot && t.whyNot !== "Not encashable")).map((t) => t.name).join(", ") || "Privilege leave"} only · up to {policy.maxDaysAYear} days a year · keep at least {policy.keepDays} days · paid at {money(policy.perDay, policy.currency)} a day (basic pay ÷ 22)
                </p>
              </div>
            )}
          </Card>
          <Card title="Encash days">
            {!policy ? (
              <p className="muted">Loading…</p>
            ) : waiting ? (
              <p className="muted">One request at a time. Your request below is waiting for approval.</p>
            ) : max <= 0 ? (
              <p className="muted">{encashable?.whyNot ?? "Nothing to encash right now."}</p>
            ) : (
              <form
                className="pr-form"
                onSubmit={act.submit(
                  async () => {
                    const code = (encashable?.code ?? "pto") as LeaveCode;
                    const error = API_ENABLED ? await apiSubmitEncashment(code, picked) : applyEncashment(code, picked);
                    setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Sent for approval." });
                    if (!error) setDays(1);
                    return error ?? true;
                  },
                  { success: "Encashment sent for approval.", toastError: true },
                )}
              >
                <div className="pr-days">
                  <input type="range" min={0.5} max={max} step={0.5} value={picked} onChange={(e) => setDays(Number(e.target.value))} aria-label="Days to encash" />
                  <input type="number" min={0.5} max={max} step={0.5} value={picked} onChange={(e) => setDays(Number(e.target.value) || 0.5)} aria-label="Days" />
                  <span className="muted">of {max}</span>
                </div>
                <div className="pr-calc">
                  <div className="row">
                    <span>Per day</span>
                    <span>{money(policy.perDay, policy.currency)}</span>
                  </div>
                  <div className="row">
                    <span>Days</span>
                    <span>× {picked}</span>
                  </div>
                  <div className="row total">
                    <span>Before tax</span>
                    <span>{money(amount, policy.currency)}</span>
                  </div>
                  <span className="muted">
                    Taxed as salary. Paid with {paidWith} pay if approved by the {policy.cutoffDay}th, else the month after. Balance left: {(encashable?.available ?? 0) - picked} days.
                  </span>
                </div>
                <div className="pr-actions">
                  <SubmitButton action={act} className="btn">
                    Submit request
                  </SubmitButton>
                </div>
              </form>
            )}
          </Card>
          <Card title="History">
            {mine.length === 0 ? (
              <EmptyState title="No encashment requests yet" />
            ) : (
              <div className="pr-list">
                {mine.map((v) => (
                  <EncashCard key={v.id} v={v} mine onWithdraw={() => withdraw(v)} />
                ))}
              </div>
            )}
          </Card>
        </>
      )}
      {showTeam && tab === "act" && (
        <Card title="To approve">
          {toAct.length === 0 ? (
            <EmptyState title="Nothing waiting on you" />
          ) : (
            <div className="pr-list">
              {toAct.map((v) => (
                <EncashCard key={v.id} v={v} mine={false} onDecide={(d, n) => decide(v, d, n)} />
              ))}
            </div>
          )}
        </Card>
      )}
    </Page>
  );
}
