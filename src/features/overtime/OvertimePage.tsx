import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { API_ENABLED } from "../../api/client.ts";
import { Banner, Card, Dialog, EmptyState, Field, Page, StatusBadge, SubmitButton, Tabs, useAction } from "../../components/ui.tsx";
import { money } from "../../countryPay.ts";
import { hasReports } from "../../data/delegations.ts";
import { addDaysISO, formatShortDate, todayISO } from "../../model.ts";
import { usePortal } from "../../store.tsx";
import { isHrRole } from "../lifecycle/lifecycleShared.ts";
import { monthLabel, waitingOn } from "../payrequests/rules.ts";
import { DecideBar, Tracker, approvalStages } from "../payrequests/Tracker.tsx";
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
} from "../payrequests/requestKit.tsx";
import { addComment, type ThreadContext } from "../payrequests/threadStore.ts";
import {
  checkOvertimeDay,
  decideOvertime,
  getOvertimeSnapshot,
  overtimeMirror,
  overtimePolicy,
  overtimeViews,
  submitOvertime,
  subscribeOvertime,
  withdrawOvertime,
  type DayCheck,
  type OvertimeOutcome,
  type OvertimeView,
} from "./overtimeStore.ts";
import { compOffDays } from "./rules.ts";

type Msg = { tone: "ok" | "err" | "warn" | "info"; text: string } | null;

const refOf = (id: string) => id.toUpperCase();
const hoursText = (m: number) => `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} m`;
const STATUSES = ["Waiting", "Approved", "Paid", "Comp-off added", "Declined", "Withdrawn"];

function statusText(v: OvertimeView): string {
  if (v.status === "Approved") return v.outcome === "comp_off" ? "Comp-off added" : v.paid ? "Paid" : "Approved";
  if (v.status === "Rejected") return "Declined";
  return v.status === "Submitted" ? "Waiting" : v.status;
}

function tone(v: OvertimeView): "ok" | "warn" | "danger" | "neutral" | "info" {
  if (v.status === "Approved") return v.paid ? "info" : "ok";
  if (v.status === "Rejected") return "danger";
  if (v.status === "Withdrawn") return "neutral";
  return "warn";
}

function payText(v: OvertimeView): string {
  return v.outcome === "comp_off" ? `${v.compOffDays} comp-off ${v.compOffDays === 1 ? "day" : "days"}` : money(v.amount, v.currency);
}

function stagesOf(v: OvertimeView) {
  return approvalStages({
    submittedOn: v.submittedOn,
    steps: v.steps,
    closed: v.status === "Withdrawn" ? "withdrawn" : v.status === "Rejected" ? "rejected" : null,
    after:
      v.outcome === "pay"
        ? [{ label: "Paid", state: v.paid ? "done" : v.status === "Approved" ? "current" : "todo", detail: v.payoutMonth ? `${monthLabel(v.payoutMonth)} payroll` : undefined }]
        : [{ label: "Comp-off", state: v.status === "Approved" ? "done" : "todo", detail: v.status === "Approved" ? "In your leave balance" : undefined }],
  });
}

function OvertimeRow({ v, actorId, onOpen }: { v: OvertimeView; actorId: string; onOpen: () => void }) {
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
      aria-label={`Open overtime ${refOf(v.id)}`}
    >
      <div className="pr-item-head">
        <div>
          <h3>{mine ? formatShortDate(v.date) : `${v.employeeName} · ${formatShortDate(v.date)}`}</h3>
          <p>
            <span className="pr-id">{refOf(v.id)}</span> · {v.hours} h · {v.outcome === "comp_off" ? "comp-off" : `paid at ${v.multiplier}×`}
            {v.attendanceMinutes === null ? " · no attendance that day" : ` · attended ${hoursText(v.attendanceMinutes)}`}
          </p>
          {v.infoRequested && <span className="pr-flag">More information requested</span>}
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="pr-amount">{payText(v)}</div>
          <StatusBadge status={statusText(v)} tone={tone(v)} literal />
        </div>
      </div>
    </article>
  );
}

function OvertimeDetail({ v, onClose, onMessage }: { v: OvertimeView; onClose: () => void; onMessage: (m: Msg) => void }) {
  const { demoProfile } = usePortal();
  const mine = v.employeeId === demoProfile.id;
  const reviewer = isHrRole(demoProfile.role) || demoProfile.role === "finance";
  const ctx: ThreadContext = { actorId: demoProfile.id, actorName: demoProfile.fullName, ownerId: v.employeeId, canDecide: v.canDecide, reviewer: reviewer && !mine, label: "overtime request", href: `/overtime?open=${v.id}` };
  return (
    <Dialog open title={`Overtime ${refOf(v.id)}`} onClose={onClose} wide>
      <div className="pr-detail">
        {!mine && v.attendanceMinutes === null && v.status === "Submitted" && <Banner message={{ tone: "warn", text: `No attendance on ${formatShortDate(v.date)}.` }} />}
        <Facts
          items={[
            ["Request ID", refOf(v.id)],
            ["Employee", v.employeeName],
            ["Date worked", formatShortDate(v.date)],
            ["Hours", `${v.hours} h`],
            ["Type", v.outcome === "comp_off" ? "Comp-off" : "Paid"],
            ["Attendance that day", v.attendanceMinutes === null ? "None recorded" : hoursText(v.attendanceMinutes)],
            ["Calculation", v.outcome === "pay" ? `${v.hours} h × ${money(v.hourlyRate, v.currency)} × ${v.multiplier}` : `${v.compOffDays} day(s)`],
            [v.outcome === "pay" ? (v.paid ? "Paid" : "Estimated pay") : "Comp-off", payText(v)],
            ["Payroll month", v.payoutMonth ? monthLabel(v.payoutMonth) : ""],
            ["Asked on", formatShortDate(v.submittedOn)],
            ["Status", statusText(v)],
          ]}
        />
        {v.reason && <p className="muted" style={{ margin: 0 }}>Reason: {v.reason}</p>}
        {v.outcome === "pay" && !v.paid && <p className="muted" style={{ margin: 0 }}>Estimate. The payroll run works out the final amount on the payslip.</p>}
        <section>
          <h4>Timeline</h4>
          <Tracker stages={stagesOf(v)} label="Overtime progress" />
          {v.status === "Submitted" && waitingOn(v.steps) && <p className="muted">With {waitingOn(v.steps)}</p>}
        </section>
        {v.canDecide && (
          <section>
            <h4>Your decision</h4>
            <DecideBar
              onDecide={async (decision, note) => {
                const error = await decideOvertime(demoProfile, v.id, decision, note);
                onMessage(error ? { tone: "err", text: error } : { tone: "ok", text: decision === "approve" ? `Approved for ${v.employeeName}.` : "Declined." });
                return error;
              }}
              onRequestInfo={async (note) => {
                const error = await addComment("overtime", v.id, ctx, note, true);
                if (!error && API_ENABLED) await overtimeMirror.reload();
                onMessage(error ? { tone: "err", text: error } : { tone: "ok", text: `Asked ${v.employeeName} for more information.` });
                return error;
              }}
            />
          </section>
        )}
        {v.canWithdraw && (
          <div className="pr-actions">
            <span className="spacer" />
            <ConfirmButton
              title="Withdraw this overtime request?"
              message={<p>{refOf(v.id)}: {v.hours} h on {formatShortDate(v.date)} will be withdrawn and your manager told.</p>}
              confirmLabel="Withdraw request"
              success="Request withdrawn."
              onConfirm={async () => {
                const error = await withdrawOvertime(demoProfile, v.id);
                onMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Request withdrawn." });
                if (!error) onClose();
                return error;
              }}
            >
              Withdraw
            </ConfirmButton>
          </div>
        )}
        <RequestThread type="overtime" id={v.id} ctx={ctx} refreshKey={`${v.status}|${v.infoRequested}`} onChanged={() => API_ENABLED && void overtimeMirror.reload()} />
      </div>
    </Dialog>
  );
}

function RequestForm({ onMessage, onSent }: { onMessage: (m: Msg) => void; onSent: () => void }) {
  const { demoProfile } = usePortal();
  const today = todayISO();
  const [date, setDate] = useState(() => addDaysISO(today, -1));
  const [hours, setHours] = useState("2");
  const [outcome, setOutcome] = useState<OvertimeOutcome>("pay");
  const [reason, setReason] = useState("");
  const [check, setCheck] = useState<DayCheck | null | undefined>(undefined);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checkTick, setCheckTick] = useState(0);
  const act = useAction();
  const value = Number(hours);
  const policy = useServerValue(() => overtimePolicy(demoProfile), demoProfile.id);
  const p = policy.value;

  useEffect(() => {
    let live = true;
    setCheck(undefined);
    setCheckError(null);
    checkOvertimeDay(demoProfile, date)
      .then((c) => live && setCheck(c))
      .catch((e: unknown) => {
        if (!live) return;
        setCheck(null);
        setCheckError(e instanceof Error ? e.message : "Couldn't check the date.");
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, demoProfile.id, checkTick]);

  if (!p) return <LoadState error={policy.error} onRetry={policy.retry} />;
  const hoursOk = Number.isFinite(value) && value >= 0.5 && value <= p.maxHours && Math.round(value * 2) === value * 2;
  const estimate = Math.round(value * p.hourlyRate * p.multiplier);

  return (
    <form
      className="pr-form"
      onSubmit={act.submit(
        async () => {
          if (check && !check.eligible) return check.warnings[0] ?? "This date can't be claimed.";
          if (!hoursOk) return `Enter 0.5 to ${p.maxHours} hours in half hours.`;
          const error = await submitOvertime(demoProfile, { date, hours: value, outcome, reason });
          onMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Sent to your manager. The request ID is on it below." });
          if (!error) {
            setReason("");
            setCheckTick((n) => n + 1);
            onSent();
          }
          return error ?? true;
        },
        { success: "Overtime sent for approval.", toastError: true },
      )}
    >
      <div className="pr-grid">
        <Field label="Date worked">
          <input type="date" min={addDaysISO(today, -p.maxDaysBack)} max={addDaysISO(today, -1)} value={date} onChange={(e) => setDate(e.target.value)} required />
        </Field>
        <Field label={`Hours (0.5 to ${p.maxHours})`}>
          <input type="number" min={0.5} max={p.maxHours} step={0.5} inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} required />
        </Field>
      </div>
      {check === undefined && date && <p className="muted" style={{ margin: 0 }}>Checking attendance…</p>}
      {checkError && <p className="pr-note err" style={{ margin: 0 }}>Couldn't check the date: {checkError}</p>}
      {check && (
        <div className="pr-calc" aria-label="Date check">
          <div className="row">
            <span>Day</span>
            <span>{check.dayType === "holiday" ? `Holiday${check.holidayName ? ` · ${check.holidayName}` : ""}` : check.dayType === "weekend" ? "Weekend" : check.dayType === "leave" ? "On leave" : "Working day"}</span>
          </div>
          <div className="row">
            <span>Shift</span>
            <span>
              {check.shiftName}
              {check.shiftStart ? ` · ${check.shiftStart}–${check.shiftEnd}` : ""}
            </span>
          </div>
          <div className="row">
            <span>Attendance</span>
            <span>{check.workedMinutes === null ? "None recorded" : hoursText(check.workedMinutes)}</span>
          </div>
          {check.beyondShiftMinutes !== null && (
            <div className="row">
              <span>{check.dayType === "working" ? "Beyond shift" : "Worked on a day off"}</span>
              <span>{hoursText(check.beyondShiftMinutes)}</span>
            </div>
          )}
          {check.warnings.map((w) => (
            <span key={w} className={check.eligible ? "muted" : "pr-flag"}>
              {w}
            </span>
          ))}
        </div>
      )}
      {p.compOff && (
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
        <textarea rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} required />
      </Field>
      {hoursOk && (
        <div className="pr-calc" aria-label="Estimate">
          {outcome === "pay" ? (
            <>
              <div className="row">
                <span>Hourly rate</span>
                <span>{money(p.hourlyRate, p.currency)}</span>
              </div>
              <div className="row">
                <span>Hours × multiplier</span>
                <span>
                  {value} × {p.multiplier}
                </span>
              </div>
              <div className="row total">
                <span>Estimated pay</span>
                <span>{money(estimate, p.currency)}</span>
              </div>
              <span className="muted">Estimate: annual pay ÷ ({p.weeklyHours} h × 52 weeks) × {p.multiplier}. Final amount in the payroll run.</span>
            </>
          ) : (
            <div className="row total">
              <span>Comp-off</span>
              <span>{compOffDays(value, demoProfile.countryCode)} day(s) (one day per {p.dayHours} h, in half days)</span>
            </div>
          )}
        </div>
      )}
      <div className="pr-actions">
        <SubmitButton action={act} className="btn" disabled={!!check && !check.eligible}>
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
  const [openId, setOpenId] = useState<string | null>(null);
  const mine = rows.filter((r) => r.employeeId === demoProfile.id);
  const toAct = rows.filter((r) => r.employeeId !== demoProfile.id && r.canDecide);
  const allowedAll = isHrRole(demoProfile.role) || demoProfile.role === "finance";
  const others = rows.filter((r) => r.employeeId !== demoProfile.id);
  const showTeam = toAct.length > 0 || allowedAll || hasReports(demoProfile.id);
  const loading = API_ENABLED && !overtimeMirror.loaded();
  const opened = openId ? rows.find((r) => r.id === openId) ?? null : null;
  const openRow = useCallback((id: string) => setOpenId(id), []);
  useOpenFromQuery(rows.map((r) => r.id), openRow);
  const mineF = useListFilters();
  const teamF = useListFilters();
  const pick = { text: (v: OvertimeView) => `${v.id} ${v.employeeName} ${v.reason}`, status: statusText, date: (v: OvertimeView) => v.date, category: (v: OvertimeView) => (v.outcome === "pay" ? "Paid" : "Comp-off") };
  const mineShown = applyFilters(mine, mineF.filters, pick);
  const teamSource = tab === "act" ? toAct : others;
  const teamShown = applyFilters(teamSource, teamF.filters, pick);
  const currency = mine[0]?.currency ?? demoProfile.currency ?? "INR";
  const approved = mine.filter((v) => v.status === "Approved");
  const sum = (list: OvertimeView[], f: (v: OvertimeView) => number) => Math.round(list.reduce((s, v) => s + f(v), 0) * 100) / 100;
  const monthly = useMemo(() => {
    const map = new Map<string, OvertimeView[]>();
    for (const v of mineShown) map.set(v.date.slice(0, 7), [...(map.get(v.date.slice(0, 7)) ?? []), v]);
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [mineShown]);
  const csvHeaders = ["Request ID", "Employee", "Date", "Hours", "Type", "Hourly rate", "Multiplier", "Amount", "Currency", "Comp-off days", "Status", "Payroll month", "Asked on", "Reason"];
  const csvRows = (list: OvertimeView[]) =>
    list.map((v) => [refOf(v.id), v.employeeName, v.date, v.hours, v.outcome === "pay" ? "Paid" : "Comp-off", v.hourlyRate, v.multiplier, v.amount, v.currency, v.compOffDays, statusText(v), v.payoutMonth ?? "", v.submittedOn, v.reason]);

  return (
    <Page title="Overtime">
      <SummaryTiles
        label="My overtime"
        items={[
          { label: "Approved hours", value: `${sum(approved, (v) => v.hours)} h` },
          { label: "Paid", value: money(sum(approved.filter((v) => v.paid), (v) => v.amount), currency), tone: "lilac" },
          { label: "Due in payroll", value: money(sum(approved.filter((v) => v.outcome === "pay" && !v.paid), (v) => v.amount), currency), hint: "Approved, not paid yet (estimate)" },
          { label: "Comp-off credits", value: `${sum(approved, (v) => v.compOffDays)} days` },
          { label: "Pending", value: `${mine.filter((v) => v.status === "Submitted").length} · ${sum(mine.filter((v) => v.status === "Submitted"), (v) => v.hours)} h`, tone: "sky" },
        ]}
      />
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
            <RequestForm onMessage={setMessage} onSent={() => setTab("mine")} />
          </Card>
          <Card title="My requests">
            <ListFilters
              state={mineF.filters}
              onChange={mineF.set}
              onReset={mineF.reset}
              statuses={STATUSES}
              categories={["Paid", "Comp-off"]}
              categoryLabel="Type"
              searchPlaceholder="ID or reason"
              dateLabel="Worked"
              extra={<CsvButton filename={`overtime-${todayISO()}.csv`} headers={csvHeaders} rows={() => csvRows(mineShown)} />}
            />
            {loading ? (
              <LoadState error={overtimeMirror.lastError()} onRetry={() => void overtimeMirror.reload()} />
            ) : mineShown.length === 0 ? (
              <EmptyState title={mine.length ? "No requests match these filters" : "No overtime yet"} />
            ) : (
              <div className="pr-list">
                {monthly.map(([month, list]) => (
                  <section key={month}>
                    <div className="pr-section-head">
                      <h4 style={{ margin: "6px 0" }}>{monthLabel(month)}</h4>
                      <span className="muted">
                        {sum(list.filter((v) => v.status === "Approved"), (v) => v.hours)} h approved · {money(sum(list.filter((v) => v.status === "Approved"), (v) => v.amount), currency)} ·{" "}
                        {sum(list.filter((v) => v.status === "Approved"), (v) => v.compOffDays)} comp-off days
                      </span>
                    </div>
                    <div className="pr-list">
                      {list.map((v) => (
                        <OvertimeRow key={v.id} v={v} actorId={demoProfile.id} onOpen={() => setOpenId(v.id)} />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </Card>
        </>
      )}
      {showTeam && tab !== "mine" && (
        <Card title={tab === "act" ? "To approve" : allowedAll ? "Everyone" : "Team"}>
          <ListFilters
            state={teamF.filters}
            onChange={teamF.set}
            onReset={teamF.reset}
            statuses={STATUSES}
            categories={["Paid", "Comp-off"]}
            categoryLabel="Type"
            searchPlaceholder="ID, name, reason"
            dateLabel="Worked"
            extra={<CsvButton filename={`overtime-${tab}-${todayISO()}.csv`} headers={csvHeaders} rows={() => csvRows(teamShown)} />}
          />
          {teamShown.length === 0 ? (
            <EmptyState title={teamSource.length ? "No requests match these filters" : tab === "act" ? "Nothing waiting on you" : "No overtime yet"} />
          ) : (
            <div className="pr-list">
              {teamShown.map((v) => (
                <OvertimeRow key={v.id} v={v} actorId={demoProfile.id} onOpen={() => setOpenId(v.id)} />
              ))}
            </div>
          )}
        </Card>
      )}
      {opened && <OvertimeDetail key={opened.id} v={opened} onClose={() => setOpenId(null)} onMessage={setMessage} />}
    </Page>
  );
}
