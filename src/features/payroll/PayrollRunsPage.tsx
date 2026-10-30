/** Payroll: the monthly run per country and legal entity — Prepare → Review → Approve (second person) → Locked. */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import {
  ActionButton,
  Banner,
  Card,
  DataTable,
  Drawer,
  EmptyState,
  Field,
  FilterBar,
  MetricCard,
  MetricGrid,
  Page,
  StatusBadge,
  downloadText,
} from "../../components/ui.tsx";
import { API_ENABLED, apiRequest } from "../../api/client.ts";
import { money } from "../../countryPay.ts";
import { formatShortDate, todayISO } from "../../model.ts";
import { usePortal } from "../../store.tsx";
import { Tracker, type Stage } from "../payrequests/Tracker.tsx";
import { FLAG_TEXT, type RunFlag, type RunLine } from "./runCalc.ts";
import {
  APPROVE_ROLES,
  PREPARE_ROLES,
  approveRun,
  entities,
  exportRun,
  getRunsSnapshot,
  loadRun,
  prepareRun,
  runViews,
  runsLoaded,
  sendBackRun,
  submitRun,
  subscribeRuns,
  type RunView,
} from "./runsStore.ts";
import "./payroll.css";

type Msg = { tone: "ok" | "err" | "warn" | "info"; text: string } | null;

const STATUS_LABEL: Record<RunView["status"], string> = { draft: "Draft", review: "In review", locked: "Locked" };
const STATUS_TONE: Record<RunView["status"], "warn" | "info" | "ok"> = { draft: "warn", review: "info", locked: "ok" };
const PAGE_SIZE = 50;

function thisMonth(): string {
  const d = new Date();
  d.setDate(1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthTitle(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, (m || 1) - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

const day = (iso?: string) => (iso ? formatShortDate(iso.slice(0, 10)) : "");

function stagesFor(run: RunView | null): Stage[] {
  const status = run?.status;
  return [
    { label: "Draft", state: run ? "done" : "current", detail: run?.preparedBy ? `${run.preparedBy} · ${day(run.preparedAt)}` : undefined },
    {
      label: "Review",
      state: status === "review" || status === "locked" ? "done" : run ? "current" : "todo",
      detail: run?.submittedBy ? `${run.submittedBy} · ${day(run.submittedAt)}` : undefined,
    },
    {
      label: "Approved",
      state: status === "locked" ? "done" : status === "review" ? "current" : "todo",
      detail: run?.approvedBy ? `${run.approvedBy} · ${day(run.approvedAt)}` : status === "review" ? "Second person" : undefined,
    },
    { label: "Locked", state: status === "locked" ? "done" : "todo", detail: status === "locked" && run?.payday ? `Payday ${formatShortDate(run.payday)}` : undefined },
  ];
}

/** HR fills in missing bank details for one person (PUT /payroll/bank-details/{id}); the next Prepare picks them up. */
function BankDetailsForm({ employeeId, name, onDone }: { employeeId: string; name: string; onDone: (saved: boolean) => void }) {
  const [form, setForm] = useState({ account_name: name, account_number: "", bank_code: "", bank_name: "" });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <div className="form-grid-2" style={{ marginTop: 8 }}>
      <Field label="Account holder">
        <input value={form.account_name} maxLength={200} onChange={set("account_name")} />
      </Field>
      <Field label="Account number">
        <input value={form.account_number} maxLength={34} inputMode="numeric" onChange={set("account_number")} />
      </Field>
      <Field label="Bank code (IFSC / sort code / routing)">
        <input value={form.bank_code} maxLength={20} onChange={set("bank_code")} />
      </Field>
      <Field label="Bank name">
        <input value={form.bank_name} maxLength={120} onChange={set("bank_name")} />
      </Field>
      <div className="row-gap">
        <ActionButton
          className="btn btn-tiny"
          toastError
          success={`Bank details saved for ${name}. Prepare again to release the pay.`}
          onAction={async () => {
            if (!/^[0-9A-Za-z]{6,34}$/.test(form.account_number.trim())) return "Enter an account number of 6–34 letters or digits.";
            if (form.bank_code.trim().length < 2 || !form.bank_name.trim() || !form.account_name.trim()) return "Fill in every field.";
            try {
              await apiRequest(`/payroll/bank-details/${encodeURIComponent(employeeId)}`, { method: "PUT", body: {
                account_name: form.account_name.trim(),
                account_number: form.account_number.trim(),
                bank_code: form.bank_code.trim(),
                bank_name: form.bank_name.trim(),
              } });
            } catch (error) {
              return error instanceof Error ? error.message : "Could not save the bank details.";
            }
            onDone(true);
            return true;
          }}
        >
          Save bank details
        </ActionButton>
        <button type="button" className="btn-ghost btn-tiny" onClick={() => onDone(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function LineDrawer({ line, currency, onClose }: { line: RunLine | null; currency: string; onClose: () => void }) {
  if (!line) return null;
  return (
    <Drawer open title={`${line.employeeName} · ${line.employeeCode}`} onClose={onClose}>
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>
          {line.paidDays} of {line.daysInMonth} days paid{line.lwpDays ? ` · ${line.lwpDays} unpaid leave` : ""}
          {line.overtimeHours ? ` · ${line.overtimeHours} h overtime` : ""}
        </p>
        <table className="pay-lines">
          <tbody>
            {line.earnings.map((e) => (
              <tr key={`e-${e.name}`}>
                <td>{e.name}</td>
                <td className="num">{money(e.amount, currency)}</td>
              </tr>
            ))}
            <tr className="total">
              <td>Gross</td>
              <td className="num">{money(line.gross, currency)}</td>
            </tr>
            {line.deductions.map((d) => (
              <tr key={`d-${d.name}`}>
                <td>{d.name}</td>
                <td className="num">−{money(d.amount, currency)}</td>
              </tr>
            ))}
            <tr className="total">
              <td>Net pay</td>
              <td className="num">{money(line.net, currency)}</td>
            </tr>
          </tbody>
        </table>
        {line.flags.length > 0 && <p className="note warn">{line.flags.map((f) => FLAG_TEXT[f]).join(" · ")}</p>}
        <Link to={`/people/${line.employeeId}`}>Open profile</Link>
      </div>
    </Drawer>
  );
}

export function PayrollRunsPage() {
  const { demoProfile, state } = usePortal();
  const snapshot = useSyncExternalStore(subscribeRuns, getRunsSnapshot, getRunsSnapshot);
  const runs = useMemo(() => runViews(demoProfile), [snapshot, demoProfile]);
  const options = useMemo(() => entities(), [snapshot]);
  const [month, setMonth] = useState(thisMonth);
  const [entityKey, setEntityKey] = useState("");
  const [detail, setDetail] = useState<RunView | null>(null);
  const [message, setMessage] = useState<Msg>(null);
  const [query, setQuery] = useState("");
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [openLine, setOpenLine] = useState<RunLine | null>(null);
  const [note, setNote] = useState("");
  const [bankFor, setBankFor] = useState<string | null>(null);

  const mine = options.find((o) => o.countryCode === demoProfile.countryCode);
  // Approvers land on the run waiting for them; others on their own country.
  const waiting = runs.find((r) => r.month === month && r.canApprove);
  const key = entityKey || (waiting ? `${waiting.countryCode}|${waiting.legalEntity}` : mine ? `${mine.countryCode}|${mine.legalEntity}` : options[0] ? `${options[0].countryCode}|${options[0].legalEntity}` : "");
  const [country, entity] = key.split("|");
  // Keep the entity once chosen, so approving or preparing doesn't jump to another one.
  useEffect(() => {
    if (!entityKey && key && runsLoaded()) setEntityKey(key);
  }, [entityKey, key, snapshot]);
  const summary = runs.find((r) => r.month === month && r.countryCode === country && r.legalEntity === entity) ?? null;
  const canPrepareRole = PREPARE_ROLES.has(demoProfile.role);
  const canApproveRole = APPROVE_ROLES.has(demoProfile.role);

  useEffect(() => {
    let live = true;
    if (!summary) {
      setDetail(null);
      return;
    }
    void loadRun(demoProfile, summary.id)
      .then((r) => live && setDetail(r))
      .catch(() => live && setDetail(null));
    return () => {
      live = false;
    };
  }, [summary?.id, summary?.status, summary?.preparedAt, demoProfile]);

  const run = detail && summary && detail.id === summary.id ? detail : summary;
  const currency = run?.currency ?? options.find((o) => o.countryCode === country)?.currency ?? "INR";
  const lines = run?.lines ?? [];
  const filtered = lines.filter(
    (l) =>
      (!onlyFlagged || l.flags.length > 0) &&
      (!query.trim() || `${l.employeeName} ${l.employeeCode}`.toLowerCase().includes(query.trim().toLowerCase())),
  );
  const shown = showAll ? filtered : filtered.slice(0, PAGE_SIZE);
  const counts = (run?.exceptions ?? []).reduce<Record<string, number>>((acc, x) => ({ ...acc, [x.kind]: (acc[x.kind] ?? 0) + 1 }), {});
  const prepared = Boolean(run?.headcount);
  const canPrepare = canPrepareRole && (!run || run.status === "draft") && month <= todayISO().slice(0, 7);

  async function doExport(kind: "register" | "bank") {
    if (!run) return "Prepare the run first.";
    const out = await exportRun(demoProfile, run.id, kind);
    if (typeof out === "string") return out;
    downloadText(out.filename, out.csv);
    return true;
  }

  if (!canPrepareRole && !canApproveRole) {
    return (
      <Page title="Payroll">
        <EmptyState title="Payroll runs are for HR, finance and the executive" />
      </Page>
    );
  }

  return (
    <Page
      title="Payroll"
      action={
        <Link className="btn-ghost" to="/payroll/providers">
          Providers
        </Link>
      }
    >
      <Banner message={message} />
      <FilterBar>
        <Field label="Month">
          <input type="month" value={month} max={todayISO().slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        </Field>
        <Field label="Country / entity">
          <select value={key} onChange={(e) => setEntityKey(e.target.value)}>
            {options.map((o) => (
              <option key={`${o.countryCode}|${o.legalEntity}`} value={`${o.countryCode}|${o.legalEntity}`}>
                {o.countryCode} · {o.legalEntity}
              </option>
            ))}
          </select>
        </Field>
        {canPrepare && (
          <ActionButton
            className={prepared && run?.status === "draft" ? "btn-ghost" : "btn"}
            busyLabel="Preparing…"
            doneLabel="Prepared"
            toastError
            success={() => `Payroll prepared for ${monthTitle(month)}.`}
            onAction={async () => {
              const { error } = await prepareRun(demoProfile, state, month, country, entity);
              setMessage(error ? { tone: "err", text: error } : null);
              return error ?? true;
            }}
          >
            {prepared ? "Prepare again" : "Prepare"}
          </ActionButton>
        )}
      </FilterBar>
      {!runsLoaded() ? (
        <Card>
          <p className="muted">Loading…</p>
        </Card>
      ) : !run ? (
        <Card>
          <EmptyState title={`No run for ${monthTitle(month)} yet`} description={canPrepareRole ? undefined : "HR prepares it."} />
        </Card>
      ) : (
        <>
          <Card
            title={`${monthTitle(run.month)} · ${run.legalEntity}`}
            action={<StatusBadge status={STATUS_LABEL[run.status]} tone={STATUS_TONE[run.status]} literal keepCase />}
          >
            <Tracker stages={stagesFor(run)} label="Payroll run progress" />
            {run.returnedNote && run.status === "draft" && <p className="note warn">Sent back: {run.returnedNote}</p>}
            <MetricGrid>
              <MetricCard label="People" value={run.headcount} />
              <MetricCard label="Gross" value={money(run.totals.gross ?? 0, currency)} />
              <MetricCard label="Deductions" value={money(run.totals.deductions ?? 0, currency)} />
              <MetricCard label="Net pay" value={money(run.totals.net ?? 0, currency)} />
              <MetricCard label="Bank transfer" value={money(run.totals.bank_total ?? 0, currency)} hint={run.totals.held ? `${run.totals.held} held` : undefined} />
            </MetricGrid>
            <div className="payroll-actions">
              {run.canSubmit && (
                <ActionButton
                  className="btn"
                  toastError
                  success="Sent for review."
                  onAction={async () => {
                    const error = await submitRun(demoProfile, run.id);
                    setMessage(error ? { tone: "err", text: error } : null);
                    return error ?? true;
                  }}
                >
                  Send for review
                </ActionButton>
              )}
              {run.canApprove && (
                <>
                  <ActionButton
                    className="btn"
                    toastError
                    busyLabel="Approving…"
                    doneLabel="Locked"
                    success="Approved and locked. Payslips are out."
                    onAction={async () => {
                      const error = await approveRun(demoProfile, run.id);
                      setMessage(error ? { tone: "err", text: error } : null);
                      return error ?? true;
                    }}
                  >
                    Approve and lock
                  </ActionButton>
                  <input className="payroll-note" aria-label="Note" placeholder="Note to send back" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
                  <ActionButton
                    className="btn-ghost"
                    toastError
                    success="Sent back."
                    onAction={async () => {
                      const error = await sendBackRun(demoProfile, run.id, note);
                      if (!error) setNote("");
                      setMessage(error ? { tone: "err", text: error } : null);
                      return error ?? true;
                    }}
                  >
                    Send back
                  </ActionButton>
                </>
              )}
              {run.status === "review" && !run.canApprove && <span className="muted">Waiting for a second person to approve.</span>}
              <span className="spacer" />
              <ActionButton className="btn-ghost" busyLabel="Exporting…" doneLabel="Exported" toastError onAction={() => doExport("register")}>
                Register CSV
              </ActionButton>
              {run.status === "locked" && (
                <ActionButton className="btn-ghost" busyLabel="Exporting…" doneLabel="Exported" toastError onAction={() => doExport("bank")}>
                  Bank file CSV
                </ActionButton>
              )}
            </div>
          </Card>

          <Card title={`Exceptions (${run.exceptions.length})`}>
            {run.exceptions.length === 0 ? (
              <EmptyState title="No exceptions" />
            ) : (
              <>
                <div className="chip-row" style={{ marginBottom: 8 }}>
                  {(Object.keys(counts) as RunFlag[]).map((k) => (
                    <StatusBadge key={k} status={`${FLAG_TEXT[k]} · ${counts[k]}`} tone={k === "missing_bank" || k === "negative_net" ? "danger" : "info"} literal keepCase />
                  ))}
                </div>
                <ul className="payroll-exceptions">
                  {run.exceptions.slice(0, 40).map((x) => (
                    <li key={`${x.employee_id}-${x.kind}`}>
                      <Link to={`/people/${x.employee_id}`}>{x.name}</Link>
                      <span className="muted">{x.text}</span>
                      {API_ENABLED && canPrepareRole && run.status === "draft" && x.kind === "missing_bank" &&
                        (bankFor === x.employee_id ? (
                          <BankDetailsForm
                            employeeId={x.employee_id}
                            name={x.name}
                            onDone={(saved) => {
                              setBankFor(null);
                              if (saved) setMessage({ tone: "ok", text: `Bank details saved for ${x.name}. Prepare again to release the pay.` });
                            }}
                          />
                        ) : (
                          <button type="button" className="quiet-link" onClick={() => setBankFor(x.employee_id)}>
                            Add bank details
                          </button>
                        ))}
                    </li>
                  ))}
                </ul>
                {run.exceptions.length > 40 && <p className="muted">{run.exceptions.length - 40} more in the register.</p>}
              </>
            )}
          </Card>

          <Card title="Register">
            <FilterBar>
              <Field label="Search">
                <input value={query} placeholder="Name or code" onChange={(e) => setQuery(e.target.value)} />
              </Field>
              <label className="payroll-check">
                <input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} /> Flagged only
              </label>
            </FilterBar>
            {lines.length === 0 ? (
              <p className="muted">Loading…</p>
            ) : (
              <>
                <DataTable
                  headers={["Person", "Paid days", "Gross", "Deductions", "Net", "Flags"]}
                  rows={shown.map((l) => [
                    <button key="p" type="button" className="link-btn" onClick={() => setOpenLine(l)}>
                      {l.employeeName} <small className="muted">{l.employeeCode}</small>
                    </button>,
                    `${l.paidDays}/${l.daysInMonth}`,
                    money(l.gross, currency),
                    money(l.deductionsTotal, currency),
                    money(l.net, currency),
                    l.flags.map((f) => FLAG_TEXT[f]).join(", "),
                  ])}
                  empty={<EmptyState title="Nobody matches" />}
                />
                {filtered.length > PAGE_SIZE && (
                  <button type="button" className="btn-ghost" onClick={() => setShowAll((v) => !v)}>
                    {showAll ? "Show fewer" : `Show all ${filtered.length}`}
                  </button>
                )}
              </>
            )}
          </Card>
        </>
      )}

      {runs.length > 0 && (
        <Card title="All runs">
          <DataTable
            headers={["Month", "Entity", "Status", "People", "Net"]}
            rows={runs.map((r) => [
              <button
                key="m"
                type="button"
                className="link-btn"
                onClick={() => {
                  setMonth(r.month);
                  setEntityKey(`${r.countryCode}|${r.legalEntity}`);
                }}
              >
                {monthTitle(r.month)}
              </button>,
              `${r.countryCode} · ${r.legalEntity}`,
              <StatusBadge key="s" status={STATUS_LABEL[r.status]} tone={STATUS_TONE[r.status]} literal keepCase />,
              r.headcount,
              money(r.totals.net ?? 0, r.currency),
            ])}
          />
        </Card>
      )}
      <LineDrawer line={openLine} currency={currency} onClose={() => setOpenLine(null)} />
    </Page>
  );
}
