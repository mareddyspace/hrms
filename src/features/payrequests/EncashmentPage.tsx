import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { API_ENABLED } from "../../api/client.ts";
import { Banner, Card, Dialog, EmptyState, Page, StatusBadge, SubmitButton, Tabs, useAction } from "../../components/ui.tsx";
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
  type EncashType,
  type EncashView,
} from "./encashStore.ts";
import { canPayOut, monthLabel, paySourceFor, payoutMonth, perDayPay, basicMonthly } from "./rules.ts";
import { DecideBar, Tracker, approvalStages } from "./Tracker.tsx";
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
import { addComment, recordLocalEvent, type ThreadContext } from "./threadStore.ts";

type Msg = { tone: "ok" | "err" | "warn" | "info"; text: string } | null;

const STATUSES = ["Waiting", "Approved", "Paid", "Declined", "Withdrawn"];
const refOf = (id: string) => id.toUpperCase();

function roleOf(id: string): string {
  return DEMO_ACCOUNTS.find((a) => a.id === id)?.role ?? "employee";
}

function countryOf(id: string): string {
  return getPerson(id)?.countryCode ?? DEMO_ACCOUNTS.find((a) => a.id === id)?.countryCode ?? "IN";
}

function statusTone(v: EncashView): "ok" | "warn" | "danger" | "neutral" | "info" {
  if (v.status === "Approved") return v.paid ? "info" : "ok";
  return v.status === "Rejected" ? "danger" : v.status === "Withdrawn" ? "neutral" : "warn";
}

function statusLabel(v: EncashView): string {
  if (v.status === "Approved") return v.paid ? "Paid" : "Approved";
  if (v.status === "Rejected") return "Declined";
  return v.status === "Submitted" || v.status === "Manager approved" ? "Waiting" : v.status;
}

function stagesOf(v: EncashView) {
  return approvalStages({
    submittedOn: v.submittedOn,
    steps: v.steps,
    closed: v.status === "Withdrawn" ? "withdrawn" : v.status === "Rejected" ? "rejected" : null,
    after: [
      {
        label: "Paid",
        state: v.status === "Approved" ? (v.paid ? "done" : "current") : "todo",
        detail: v.payoutMonth ? `With ${monthLabel(v.payoutMonth)} pay` : undefined,
      },
    ],
  });
}

function EncashRow({ v, mine, onOpen }: { v: EncashView; mine: boolean; onOpen: () => void }) {
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
      aria-label={`Open leave encashment ${refOf(v.id)}`}
    >
      <div className="pr-item-head">
        <div>
          <h3>{mine ? `${v.days} ${v.days === 1 ? "day" : "days"} encashed` : `${v.employeeName} · ${v.days} ${v.days === 1 ? "day" : "days"}`}</h3>
          <p>
            <span className="pr-id">{refOf(v.id)}</span> · asked {formatShortDate(v.submittedOn)} · {money(v.perDay, v.currency)} a day
          </p>
          {v.infoRequested && <span className="pr-flag">More information requested</span>}
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="pr-amount">{money(v.amount, v.currency)}</div>
          <StatusBadge status={statusLabel(v)} tone={statusTone(v)} literal />
        </div>
      </div>
      <Tracker label="Encashment progress" stages={stagesOf(v)} />
    </article>
  );
}

function EncashDetail({
  v,
  onClose,
  onDecide,
  onWithdraw,
  reviewer,
}: {
  v: EncashView;
  onClose: () => void;
  onDecide: (d: "approve" | "reject", note: string) => Promise<string | null>;
  onWithdraw: () => Promise<string | null>;
  reviewer: boolean;
}) {
  const { demoProfile } = usePortal();
  const mine = v.employeeId === demoProfile.id;
  const ctx: ThreadContext = {
    actorId: demoProfile.id,
    actorName: demoProfile.fullName,
    ownerId: v.employeeId,
    canDecide: v.canDecide,
    reviewer: reviewer && !mine,
    label: "leave encashment",
    href: `/encashment?open=${v.id}`,
  };
  return (
    <Dialog open title={`Leave encashment ${refOf(v.id)}`} onClose={onClose} wide>
      <div className="pr-detail">
        <Facts
          items={[
            ["Request ID", refOf(v.id)],
            ["Employee", v.employeeName],
            ["Leave type", v.code === "pto" ? "Privilege leave" : v.code],
            ["Days", String(v.days)],
            ["Per day", money(v.perDay, v.currency)],
            ["Amount (before tax)", money(v.amount, v.currency)],
            ["Asked on", formatShortDate(v.submittedOn)],
            ["Status", statusLabel(v)],
            ["Payment", v.status === "Approved" ? (v.paid ? `Paid with ${monthLabel(v.payoutMonth ?? "")} pay` : `Due with ${monthLabel(v.payoutMonth ?? "")} pay`) : "Not yet approved"],
          ]}
        />
        <section>
          <h4>Progress</h4>
          <Tracker label="Encashment progress" stages={stagesOf(v)} />
        </section>
        <section>
          <h4>Approval history</h4>
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
        </section>
        {v.canDecide && !mine && (
          <section>
            <h4>Your decision</h4>
            <DecideBar
              onDecide={onDecide}
              onRequestInfo={async (note) => {
                const error = await addComment("encashment", v.id, ctx, note, true);
                if (!error && API_ENABLED) await encashMirror.reload();
                return error;
              }}
            />
          </section>
        )}
        {v.canWithdraw && mine && (
          <div className="pr-actions">
            <span className="spacer" />
            <ConfirmButton
              title="Withdraw this encashment?"
              message={<p>{refOf(v.id)} for {v.days} days ({money(v.amount, v.currency)}) will be withdrawn and the days go back to your balance.</p>}
              confirmLabel="Withdraw request"
              success="Encashment withdrawn."
              onConfirm={async () => {
                const error = await onWithdraw();
                if (!error) onClose();
                return error;
              }}
            >
              Withdraw
            </ConfirmButton>
          </div>
        )}
        <RequestThread refreshKey={`${v.status}|${v.infoRequested}|${v.steps.map((s) => s.decision ?? "").join(",")}`} type="encashment" id={v.id} ctx={ctx} onChanged={() => API_ENABLED && void encashMirror.reload()} />
      </div>
    </Dialog>
  );
}

function TypeRules({ t, policy, onClose }: { t: EncashType; policy: EncashPolicy; onClose: () => void }) {
  return (
    <Dialog open title={t.name} onClose={onClose}>
      <div className="pr-detail">
        <Facts
          items={[
            ["Balance", `${t.available} days`],
            ["Encashed this year", `${t.usedThisYear} days (incl. waiting)`],
            ["Can encash now", t.eligible ? `${t.encashable} days` : "None"],
            ["Yearly maximum", `${policy.maxDaysAYear} days`],
            ["Minimum balance to keep", `${policy.keepDays} days`],
            ["Rate per day", money(policy.perDay, policy.currency)],
          ]}
        />
        <p className="pr-note" style={{ margin: 0 }}>
          {t.eligible
            ? `Eligible. Up to ${t.encashable} days now: ${money(Math.round(policy.perDay * t.encashable * 100) / 100, policy.currency)} before tax at most.`
            : `Not eligible now: ${t.whyNot ?? "not encashable"}.`}
        </p>
        <p className="muted" style={{ margin: 0 }}>
          Rate: basic pay {policy.basicMonthly ? money(policy.basicMonthly, policy.currency) : ""} ÷ {policy.workingDays} working days
          {policy.paySource === "compensation" ? ", from your pay record" : ", standard package for your role"}. Approved by the {policy.cutoffDay}th: paid with that month's pay, otherwise the next. Taxed as salary; the payslip shows the final figure.
        </p>
      </div>
    </Dialog>
  );
}

export function EncashmentPage() {
  const portal = usePortal();
  const { demoProfile, leaveTable, state, applyEncashment, setEncashmentStatus, canDecideFor } = portal;
  const api = useSyncExternalStore(encashMirror.subscribe, encashMirror.get, encashMirror.get);
  const server = useServerValue(API_ENABLED ? apiEncashPolicy : null, api);
  const [message, setMessage] = useState<Msg>(null);
  const [tab, setTab] = useState("mine");
  const [openId, setOpenId] = useState<string | null>(null);
  const [typeOpen, setTypeOpen] = useState<string | null>(null);
  const [pickedCode, setPickedCode] = useState<string | null>(null);
  const act = useAction();

  const localPerDay = perDayPay(demoProfile.countryCode, demoProfile.role, demoProfile.id);
  const localPay = paySourceFor(demoProfile.countryCode, demoProfile.role, demoProfile.id);
  const policy: EncashPolicy | null = API_ENABLED
    ? server.value
    : localEncashPolicy(leaveTable, state.encashments, demoProfile.id, localPerDay, payRulesFor(demoProfile.countryCode).currency, {
        source: localPay.source,
        basic: basicMonthly(demoProfile.countryCode, demoProfile.role, demoProfile.id),
      });

  const rows: EncashView[] = useMemo(() => {
    if (API_ENABLED) return api.rows;
    const views = localEncashViews(state.encashments, {
      perDayOf: (id) => perDayPay(countryOf(id), roleOf(id), id),
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

  const shownTypes = (policy?.types ?? []).filter((t) => t.eligible || t.whyNot !== "Not encashable");
  const encashable = (pickedCode ? policy?.types.find((t) => t.code === pickedCode) : undefined) ?? policy?.types.find((t) => t.eligible) ?? policy?.types.find((t) => t.code === "pto");
  const max = encashable?.encashable ?? 0;
  const [daysText, setDaysText] = useState("1");
  const days = Number(daysText);
  const daysError =
    !Number.isFinite(days) || days <= 0
      ? "Enter the days to encash."
      : days * 2 !== Math.round(days * 2)
        ? "Use whole or half days."
        : days > max
          ? `You can encash up to ${max} days now.`
          : null;
  const mine = rows.filter((r) => r.employeeId === demoProfile.id);
  const waiting = mine.find((r) => r.status === "Submitted" || r.status === "Manager approved");
  const toAct = rows.filter((r) => r.employeeId !== demoProfile.id && r.canDecide);
  const reviewer = isHrRole(demoProfile.role) || canPayOut(demoProfile.role);
  const others = rows.filter((r) => r.employeeId !== demoProfile.id);
  const showTeam = toAct.length > 0 || reviewer;
  const amount = policy && !daysError ? Math.round(policy.perDay * days * 100) / 100 : 0;
  const paidWith = monthLabel(payoutMonth(todayISO()));
  const year = todayISO().slice(0, 4);
  const thisYear = mine.filter((r) => String(r.year) === year);
  const currency = policy?.currency ?? mine[0]?.currency ?? payRulesFor(demoProfile.countryCode).currency;
  const opened = openId ? rows.find((r) => r.id === openId) ?? null : null;
  const openRow = useCallback((id: string) => setOpenId(id), []);
  useOpenFromQuery(rows.map((r) => r.id), openRow);
  const hist = useListFilters();
  const teamFilters = useListFilters();

  async function decide(v: EncashView, decision: "approve" | "reject", note: string): Promise<string | null> {
    const error = API_ENABLED
      ? await apiDecideEncashment(v.id, decision, note)
      : setEncashmentStatus(v.id, decision === "approve" ? "approved" : "rejected", note.trim() || undefined);
    if (!error && !API_ENABLED) recordLocalEvent("encashment", v.id, decision === "approve" ? "encashment_approved" : "encashment_rejected", demoProfile.fullName);
    setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: decision === "approve" ? `Approved for ${v.employeeName}.` : "Declined." });
    return error;
  }

  async function withdraw(v: EncashView): Promise<string | null> {
    const error = API_ENABLED ? await apiWithdrawEncashment(v.id) : setEncashmentStatus(v.id, "withdrawn");
    if (!error && !API_ENABLED) recordLocalEvent("encashment", v.id, "encashment_withdrawn", demoProfile.fullName);
    setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Encashment withdrawn." });
    return error;
  }

  const filterPick = {
    text: (v: EncashView) => `${v.id} ${v.employeeName} ${v.code}`,
    status: statusLabel,
    date: (v: EncashView) => v.submittedOn,
  };
  const csvHeaders = ["ID", "Employee", "Leave type", "Days", "Per day", "Amount", "Currency", "Status", "Asked on", "Payout month", "Paid"];
  const csvRows = (list: EncashView[]) => list.map((v) => [refOf(v.id), v.employeeName, v.code, v.days, v.perDay, v.amount, v.currency, statusLabel(v), v.submittedOn, v.payoutMonth ?? "", v.paid ? "Yes" : "No"]);
  const histShown = applyFilters(mine, hist.filters, filterPick);
  const teamShown = applyFilters(tab === "act" ? toAct : others, teamFilters.filters, filterPick);
  const sum = (list: EncashView[], pick: (v: EncashView) => number) => Math.round(list.reduce((s, v) => s + pick(v), 0) * 100) / 100;

  return (
    <Page title="Leave encashment">
      <SummaryTiles
        label={`Encashment ${year}`}
        items={[
          { label: `Encashed ${year}`, value: `${sum(thisYear.filter((v) => v.status === "Approved"), (v) => v.days)} days` },
          { label: "Waiting", value: `${sum(thisYear.filter((v) => v.status === "Submitted" || v.status === "Manager approved"), (v) => v.days)} days`, tone: "sky" },
          { label: "Approved amount", value: money(sum(thisYear.filter((v) => v.status === "Approved"), (v) => v.amount), currency), tone: "lilac" },
          { label: "Paid", value: money(sum(thisYear.filter((v) => v.paid), (v) => v.amount), currency) },
          { label: "Yearly limit left", value: policy ? `${Math.max(0, policy.maxDaysAYear - sum(thisYear.filter((v) => v.status !== "Rejected" && v.status !== "Withdrawn"), (v) => v.days))} days` : "—" },
        ]}
      />
      <Banner message={message} />
      {showTeam && (
        <Tabs
          tabs={[
            { id: "mine", label: "My encashment" },
            { id: "act", label: `To approve (${toAct.length})` },
            ...(reviewer ? [{ id: "all", label: "All requests" }] : []),
          ]}
          value={tab}
          onChange={setTab}
        />
      )}
      {(!showTeam || tab === "mine") && (
        <>
          <Card title="What you can encash">
            {!policy ? (
              <LoadState error={server.error} onRetry={server.retry} />
            ) : (
              <div className="pr-form">
                {shownTypes.length === 0 ? (
                  <EmptyState title="No encashable leave" />
                ) : (
                  <div className="pr-catalogue">
                    {shownTypes.map((t) => (
                      <button
                        key={t.code}
                        type="button"
                        className={`pr-app pr-choice${encashable?.code === t.code ? " picked" : ""}`}
                        aria-pressed={encashable?.code === t.code}
                        onClick={() => {
                          setPickedCode(t.code);
                          setTypeOpen(t.code);
                        }}
                      >
                        <h3>{t.name}</h3>
                        <span className="meta">Balance {t.available} days</span>
                        <span className="meta">{t.eligible ? `Can encash ${t.encashable} of max ${policy.maxDaysAYear}/year` : t.whyNot}</span>
                        <span className="meta">Keep at least {policy.keepDays} days</span>
                        <StatusBadge status={t.eligible ? "Eligible" : "Not eligible"} tone={t.eligible ? "ok" : "neutral"} literal />
                      </button>
                    ))}
                  </div>
                )}
                <p className="pr-note" style={{ margin: 0 }}>
                  {shownTypes.map((t) => t.name).join(", ") || "Privilege leave"} only · up to {policy.maxDaysAYear} days a year · keep at least {policy.keepDays} days · paid at{" "}
                  {money(policy.perDay, policy.currency)} a day (basic pay ÷ {policy.workingDays}
                  {policy.paySource === "compensation" ? ", from your pay record" : ", standard package for your role"}). Select a type for its rules.
                </p>
              </div>
            )}
          </Card>
          <Card title="Encash days">
            {!policy ? (
              <LoadState error={server.error} onRetry={server.retry} />
            ) : waiting ? (
              <p className="muted">One request at a time. {refOf(waiting.id)} is waiting for approval.</p>
            ) : max <= 0 ? (
              <p className="muted">{encashable?.whyNot ?? "Nothing to encash right now."}</p>
            ) : (
              <form
                className="pr-form"
                onSubmit={act.submit(
                  async () => {
                    if (daysError) return daysError;
                    const code = (encashable?.code ?? "pto") as LeaveCode;
                    let error: string | null;
                    let id: string | undefined;
                    if (API_ENABLED) {
                      const out = await apiSubmitEncashment(code, days);
                      error = out.error;
                      id = out.id;
                    } else error = applyEncashment(code, days);
                    setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: id ? `Sent for approval as ${refOf(id)}.` : "Sent for approval." });
                    if (!error) setDaysText("1");
                    if (id) setOpenId(id);
                    return error ?? true;
                  },
                  { success: "Encashment sent for approval.", toastError: true },
                )}
              >
                <p className="muted" style={{ margin: 0 }}>
                  {encashable?.name}: balance {encashable?.available} days, up to {max} days now.
                </p>
                <div className="pr-days">
                  <input type="range" min={0.5} max={max} step={0.5} value={Math.min(Math.max(days || 0.5, 0.5), max)} onChange={(e) => setDaysText(e.target.value)} aria-label="Days to encash" />
                  <input type="number" min={0.5} max={max} step={0.5} value={daysText} onChange={(e) => setDaysText(e.target.value)} aria-label="Days" />
                  <span className="muted">of {max}</span>
                </div>
                {daysError && <p className="pr-note err" style={{ margin: 0 }}>{daysError}</p>}
                <div className="pr-calc">
                  <div className="row">
                    <span>Per day</span>
                    <span>{money(policy.perDay, policy.currency)}</span>
                  </div>
                  <div className="row">
                    <span>Days</span>
                    <span>× {daysError ? "—" : days}</span>
                  </div>
                  <div className="row total">
                    <span>Estimate before tax</span>
                    <span>{money(amount, policy.currency)}</span>
                  </div>
                  <div className="row">
                    <span>Balance left</span>
                    <span>{daysError ? "—" : `${Math.round(((encashable?.available ?? 0) - days) * 10) / 10} days`}</span>
                  </div>
                  <span className="muted">
                    Estimate only: taxed as salary, the payslip shows the final amount. Paid with {paidWith} pay if approved by the {policy.cutoffDay}th, else the month after.
                  </span>
                </div>
                <div className="pr-actions">
                  <SubmitButton action={act} className="btn" disabled={!!daysError}>
                    Submit request
                  </SubmitButton>
                </div>
              </form>
            )}
          </Card>
          <Card title="History">
            <ListFilters
              state={hist.filters}
              onChange={hist.set}
              onReset={hist.reset}
              statuses={STATUSES}
              searchPlaceholder="ID"
              dateLabel="Asked"
              extra={<CsvButton filename={`leave-encashment-${todayISO()}.csv`} headers={csvHeaders} rows={() => csvRows(histShown)} />}
            />
            {API_ENABLED && !encashMirror.loaded() ? (
              <LoadState error={encashMirror.lastError()} onRetry={() => void encashMirror.reload()} />
            ) : histShown.length === 0 ? (
              <EmptyState title={mine.length ? "No requests match these filters" : "No encashment requests yet"} />
            ) : (
              <div className="pr-list">
                {histShown.map((v) => (
                  <EncashRow key={v.id} v={v} mine onOpen={() => setOpenId(v.id)} />
                ))}
              </div>
            )}
          </Card>
        </>
      )}
      {showTeam && (tab === "act" || tab === "all") && (
        <Card title={tab === "act" ? "To approve" : "All requests"}>
          <ListFilters
            state={teamFilters.filters}
            onChange={teamFilters.set}
            onReset={teamFilters.reset}
            statuses={STATUSES}
            searchPlaceholder="ID or name"
            dateLabel="Asked"
            extra={<CsvButton filename={`leave-encashment-${tab}-${todayISO()}.csv`} headers={csvHeaders} rows={() => csvRows(teamShown)} />}
          />
          {teamShown.length === 0 ? (
            <EmptyState title={tab === "act" ? "Nothing waiting on you" : "No requests"} />
          ) : (
            <div className="pr-list">
              {teamShown.map((v) => (
                <EncashRow key={v.id} v={v} mine={false} onOpen={() => setOpenId(v.id)} />
              ))}
            </div>
          )}
        </Card>
      )}
      {opened && (
        <EncashDetail key={opened.id} v={opened} reviewer={reviewer} onClose={() => setOpenId(null)} onDecide={(d, n) => decide(opened, d, n)} onWithdraw={() => withdraw(opened)} />
      )}
      {typeOpen && policy && policy.types.find((t) => t.code === typeOpen) && (
        <TypeRules t={policy.types.find((t) => t.code === typeOpen) as EncashType} policy={policy} onClose={() => setTypeOpen(null)} />
      )}
    </Page>
  );
}
