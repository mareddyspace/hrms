import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { API_ENABLED } from "../../api/client.ts";
import { ActionButton, Banner, Card, EmptyState, Field, Page, StatusBadge, SubmitButton, Tabs, useAction } from "../../components/ui.tsx";
import { money } from "../../countryPay.ts";
import { hasReports } from "../../data/delegations.ts";
import { addDaysISO, formatShortDate, todayISO } from "../../model.ts";
import { usePortal } from "../../store.tsx";
import { isHrRole } from "../lifecycle/lifecycleShared.ts";
import { monthLabel, waitingOn } from "../payrequests/rules.ts";
import { DecideBar, Tracker, approvalStages } from "../payrequests/Tracker.tsx";
import {
  attendanceMinutesOn,
  decideOvertime,
  getOvertimeSnapshot,
  overtimeMirror,
  overtimeViews,
  submitOvertime,
  subscribeOvertime,
  withdrawOvertime,
  type OvertimeOutcome,
  type OvertimeView,
} from "./overtimeStore.ts";
import { MAX_DAYS_BACK, compOffDays, hourlyRate, overtimePay, overtimeRulesFor } from "./rules.ts";

type Msg = { tone: "ok" | "err" | "warn" | "info"; text: string } | null;

const hoursText = (m: number) => `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} m`;

function statusText(v: OvertimeView): string {
  if (v.status === "Approved") return v.outcome === "comp_off" ? "Comp-off added" : v.paid ? "Paid" : "Approved";
  return v.status === "Submitted" ? "Waiting" : v.status;
}

function tone(v: OvertimeView): "ok" | "warn" | "danger" | "neutral" | "info" {
  if (v.status === "Approved") return "ok";
  if (v.status === "Rejected") return "danger";
  if (v.status === "Withdrawn") return "neutral";
  return "warn";
}

function payText(v: OvertimeView): string {
  return v.outcome === "comp_off" ? `${v.compOffDays} comp-off ${v.compOffDays === 1 ? "day" : "days"}` : money(v.amount, v.currency);
}

function OvertimeCard({ v, actorId, onMessage }: { v: OvertimeView; actorId: string; onMessage: (m: Msg) => void }) {
  const { demoProfile } = usePortal();
  const mine = v.employeeId === actorId;
  const stages = approvalStages({
    submittedOn: v.submittedOn,
    steps: v.steps,
    closed: v.status === "Withdrawn" ? "withdrawn" : v.status === "Rejected" ? "rejected" : null,
    after:
      v.outcome === "pay"
        ? [{ label: "Paid", state: v.paid ? "done" : v.status === "Approved" ? "current" : "todo", detail: v.payoutMonth ? `${monthLabel(v.payoutMonth)} pay` : undefined }]
        : [{ label: "Comp-off", state: v.status === "Approved" ? "done" : "todo", detail: v.status === "Approved" ? "In your leave balance" : undefined }],
  });
  return (
    <article className="pr-item">
      <div className="pr-item-head">
        <div>
          <h3>{mine ? formatShortDate(v.date) : `${v.employeeName} · ${formatShortDate(v.date)}`}</h3>
          <p>
            {v.hours} h · {v.outcome === "comp_off" ? "comp-off" : `paid at ${v.multiplier}×`}
            {v.attendanceMinutes === null ? " · no attendance that day" : ` · attended ${hoursText(v.attendanceMinutes)}`}
          </p>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="pr-amount">{payText(v)}</div>
          <StatusBadge status={statusText(v)} tone={tone(v)} literal />
        </div>
      </div>
      {v.reason && <p className="muted" style={{ margin: 0 }}>{v.reason}</p>}
      {!mine && v.attendanceMinutes === null && v.status === "Submitted" && (
        <Banner message={{ tone: "warn", text: `No attendance on ${formatShortDate(v.date)}.` }} />
      )}
      <Tracker stages={stages} label="Overtime progress" />
      {v.canDecide && (
        <DecideBar
          onDecide={async (decision, note) => {
            const error = await decideOvertime(demoProfile, v.id, decision, note);
            onMessage(error ? { tone: "err", text: error } : { tone: "ok", text: decision === "approve" ? `Approved for ${v.employeeName}.` : "Declined." });
            return error;
          }}
        />
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
              const error = await withdrawOvertime(demoProfile, v.id);
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

function RequestForm({ onMessage }: { onMessage: (m: Msg) => void }) {
  const { demoProfile } = usePortal();
  const today = todayISO();
  const rules = overtimeRulesFor(demoProfile.countryCode);
  const [date, setDate] = useState(() => addDaysISO(today, -1));
  const [hours, setHours] = useState("2");
  const [outcome, setOutcome] = useState<OvertimeOutcome>("pay");
  const [reason, setReason] = useState("");
  const [worked, setWorked] = useState<number | null | undefined>(undefined);
  const act = useAction();
  const value = Number(hours);
  const rate = useMemo(() => hourlyRate(demoProfile.id, demoProfile.countryCode, demoProfile.role), [demoProfile]);
  const currency = demoProfile.currency ?? "INR";

  useEffect(() => {
    let live = true;
    setWorked(undefined);
    void attendanceMinutesOn(demoProfile.id, date).then((m) => live && setWorked(m));
    return () => {
      live = false;
    };
  }, [date, demoProfile.id]);

  const preview =
    value > 0
      ? outcome === "comp_off"
        ? `${compOffDays(value, demoProfile.countryCode)} comp-off day(s)`
        : `About ${money(overtimePay(value, rate, demoProfile.countryCode), currency)} (${value} h × ${money(rate, currency)} × ${rules.multiplier})`
      : "";

  return (
    <form
      className="pr-form"
      onSubmit={act.submit(
        async () => {
          const error = await submitOvertime(demoProfile, { date, hours: value, outcome, reason });
          onMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Sent to your manager." });
          if (!error) setReason("");
          return error ?? true;
        },
        { success: "Overtime sent for approval.", toastError: true },
      )}
    >
      <div className="pr-grid">
        <Field label="Date">
          <input type="date" min={addDaysISO(today, -MAX_DAYS_BACK)} max={addDaysISO(today, -1)} value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Hours">
          <input type="number" min={0.5} max={rules.maxHours} step={0.5} inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} />
        </Field>
      </div>
      {worked === null && date && <Banner message={{ tone: "warn", text: `No attendance on ${formatShortDate(date)}. Your manager will see this.` }} />}
      {typeof worked === "number" && <p className="muted" style={{ margin: 0 }}>Attended {hoursText(worked)} that day.</p>}
      {rules.compOff && (
        <div>
          <p className="muted" style={{ margin: "0 0 6px" }}>Take as</p>
          <div className="pr-choice-row" role="group" aria-label="Take as">
            <button type="button" className="pr-choice" aria-pressed={outcome === "pay"} onClick={() => setOutcome("pay")}>
              Paid
            </button>
            <button type="button" className="pr-choice" aria-pressed={outcome === "comp_off"} onClick={() => setOutcome("comp_off")}>
              Comp-off
            </button>
          </div>
        </div>
      )}
      <Field label="Reason" wide>
        <textarea rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      {preview && <p className="pr-note" style={{ margin: 0 }}>{preview}</p>}
      <div className="pr-actions">
        <SubmitButton action={act} className="btn">
          Send request
        </SubmitButton>
      </div>
    </form>
  );
}

export function OvertimePage() {
  const { demoProfile } = usePortal();
  const snapshot = useSyncExternalStore(subscribeOvertime, getOvertimeSnapshot, getOvertimeSnapshot);
  const rows = useMemo(() => overtimeViews(demoProfile), [snapshot, demoProfile]);
  const [message, setMessage] = useState<Msg>(null);
  const [tab, setTab] = useState("mine");
  const mine = rows.filter((r) => r.employeeId === demoProfile.id);
  const toAct = rows.filter((r) => r.employeeId !== demoProfile.id && r.canDecide);
  const allowedAll = isHrRole(demoProfile.role) || demoProfile.role === "finance";
  const others = rows.filter((r) => r.employeeId !== demoProfile.id);
  const showTeam = toAct.length > 0 || allowedAll || hasReports(demoProfile.id);
  const loading = API_ENABLED && !overtimeMirror.loaded();

  return (
    <Page title="Overtime">
      <Banner message={message} />
      {showTeam && (
        <Tabs
          tabs={[
            { id: "mine", label: "Mine" },
            { id: "act", label: `To approve (${toAct.length})` },
            { id: "all", label: allowedAll ? "Everyone" : "Team" },
          ]}
          value={tab}
          onChange={setTab}
        />
      )}
      {(!showTeam || tab === "mine") && (
        <>
          <Card title="Request overtime">
            <RequestForm onMessage={setMessage} />
          </Card>
          <Card title="My requests">
            {loading ? (
              <p className="muted">Loading…</p>
            ) : mine.length === 0 ? (
              <EmptyState title="No overtime yet" />
            ) : (
              <div className="pr-list">
                {mine.map((v) => (
                  <OvertimeCard key={v.id} v={v} actorId={demoProfile.id} onMessage={setMessage} />
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
                <OvertimeCard key={v.id} v={v} actorId={demoProfile.id} onMessage={setMessage} />
              ))}
            </div>
          )}
        </Card>
      )}
      {showTeam && tab === "all" && (
        <Card title={allowedAll ? "Everyone" : "Team"}>
          {others.length === 0 ? (
            <EmptyState title="No overtime yet" />
          ) : (
            <div className="pr-list">
              {others.map((v) => (
                <OvertimeCard key={v.id} v={v} actorId={demoProfile.id} onMessage={setMessage} />
              ))}
            </div>
          )}
        </Card>
      )}
    </Page>
  );
}
