/**
 * Director / leadership dashboard (backend mode): every number comes from GET /insights/leadership, computed on the
 * server from employee, recruiting, performance, learning and pay records. Filters: country, department, period.
 * Every count opens the people behind it (GET /insights/leadership/drill — no personal identifiers).
 * Cost appears only for HR / compensation roles; directors see headcount, never salaries.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Card, DataTable, Dialog, EmptyState, Field } from "../../components/ui.tsx";
import { notify, notifyError } from "../../components/Toast.tsx";
import {
  decideExtension,
  getContractors,
  getDrill,
  getLeadership,
  requestExtension,
  type ContractorOut,
  type DrillMetric,
  type DrillRow,
  type Filters,
  type LeadershipOut,
  type RangeKey,
} from "../../api/syncLeadership.ts";
import "../../styles/leadership.css";

const RANGES: { id: RangeKey; label: string }[] = [
  { id: "30d", label: "Last 30 days" },
  { id: "90d", label: "Last 90 days" },
  { id: "ytd", label: "Year to date" },
  { id: "12m", label: "Last 12 months" },
];

const DRILL_TITLES: Record<DrillMetric, string> = {
  headcount: "Headcount",
  joiners: "Joiners",
  exits: "Leavers",
  contractors: "Contractors",
  contracts_ending: "Contracts ending in 60 days",
  learning_overdue: "Overdue mandatory learning",
};

const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—";
const fmtMoney = (amount: number, currency: string) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency, maximumFractionDigits: 0, notation: amount >= 1e7 ? "compact" : "standard" }).format(amount);

function Tile({ label, value, hint, onOpen, tone }: { label: string; value: string | number; hint?: string; onOpen?: () => void; tone?: "warn" | "bad" }) {
  const body = (
    <>
      <span className="ld-tile-label">{label}</span>
      <strong className="ld-tile-value">{value}</strong>
      {hint && <span className="ld-tile-hint">{hint}</span>}
    </>
  );
  return onOpen ? (
    <button type="button" className={`ld-tile ld-tile-btn ${tone ? `ld-${tone}` : ""}`} onClick={onOpen} title={`Show the people behind ${label.toLowerCase()}`}>
      {body}
    </button>
  ) : (
    <div className={`ld-tile ${tone ? `ld-${tone}` : ""}`}>{body}</div>
  );
}

function Bar({ value, max, tone }: { value: number; max: number; tone?: "ok" | "warn" | "bad" }) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <span className="ld-bar" aria-hidden>
      <span className={`ld-bar-fill ${tone ? `ld-${tone}` : ""}`} style={{ width: `${pct}%` }} />
    </span>
  );
}

export function LeadershipDashboard({ initialCountry }: { initialCountry?: string }) {
  const [filters, setFilters] = useState<Filters>({ range: "ytd", country: initialCountry && initialCountry !== "ALL" ? initialCountry : undefined });
  const [data, setData] = useState<LeadershipOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drill, setDrill] = useState<{ metric: DrillMetric; filters: Filters; rows: DrillRow[] | null } | null>(null);
  const [groupBy, setGroupBy] = useState<"country" | "department">("country");

  useEffect(() => {
    let live = true;
    setError(null);
    getLeadership(filters)
      .then((d) => live && setData(d))
      .catch((e: Error) => live && setError(e.message || "Could not load the dashboard."));
    return () => {
      live = false;
    };
  }, [filters]);

  const openDrill = useCallback((metric: DrillMetric, extra: Partial<Filters> = {}) => {
    const f = { ...filters, ...extra };
    setDrill({ metric, filters: f, rows: null });
    getDrill(metric, f)
      .then((rows) => setDrill((d) => (d && d.metric === metric ? { ...d, rows } : d)))
      .catch((e: Error) => {
        notifyError(e.message || "Could not load the list.");
        setDrill(null);
      });
  }, [filters]);

  if (error) return <Card title="Leadership dashboard"><p className="note err">{error}</p></Card>;
  if (!data) return <Card title="Leadership dashboard"><p className="note">Loading workforce figures…</p></Card>;

  const groups = groupBy === "country" ? data.by_country : data.by_department;
  const maxHead = Math.max(1, ...groups.map((g) => g.headcount));
  const stageMax = Math.max(1, ...data.hiring.by_stage.map((s) => s.count));
  const perfTotal = data.performance?.distribution.reduce((n, d) => n + d.count, 0) ?? 0;
  const rangeLabel = RANGES.find((r) => r.id === data.range)?.label ?? "";

  return (
    <div className="ld stack">
      <div className="ld-filters" role="group" aria-label="Dashboard filters">
        <Field label="Country">
          <select value={filters.country ?? ""} onChange={(e) => setFilters({ ...filters, country: e.target.value || undefined })}>
            <option value="">All countries</option>
            {data.countries.map((c) => <option key={c} value={c}>{data.by_country.find((r) => r.key === c)?.name ?? c}</option>)}
          </select>
        </Field>
        <Field label="Department">
          <select value={filters.department ?? ""} onChange={(e) => setFilters({ ...filters, department: e.target.value || undefined })}>
            <option value="">All departments</option>
            {data.departments.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </Field>
        <Field label="Period">
          <select value={filters.range} onChange={(e) => setFilters({ ...filters, range: e.target.value as RangeKey })}>
            {RANGES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
        </Field>
        <span className="ld-asof">{data.scope === "team" ? "Your reporting line" : "Organisation"} · as of {fmtDate(data.as_of)}</span>
      </div>

      <div className="ld-tiles">
        <Tile label="Headcount" value={data.headcount} hint="Active today" onOpen={() => openDrill("headcount")} />
        <Tile label="Joiners" value={data.joiners} hint={rangeLabel} onOpen={() => openDrill("joiners")} />
        <Tile label="Leavers" value={data.exits} hint={rangeLabel} onOpen={() => openDrill("exits")} />
        <Tile label="Attrition" value={`${data.attrition_pct}%`} hint={`Net ${data.net_growth >= 0 ? "+" : ""}${data.net_growth}`} tone={data.attrition_pct >= 15 ? "warn" : undefined} />
        <Tile label="Open positions" value={data.hiring.open_positions} hint={`${data.hiring.open_requisitions} requisitions`} />
        <Tile
          label="Learning compliance"
          value={data.learning.compliance_pct == null ? "—" : `${data.learning.compliance_pct}%`}
          hint={`${data.learning.overdue} overdue`}
          tone={data.learning.overdue ? "warn" : undefined}
          onOpen={data.learning.overdue ? () => openDrill("learning_overdue") : undefined}
        />
        <Tile
          label="Contracts ending"
          value={data.contractors.ending_soon}
          hint={`${data.contractors.active} contractors${data.contractors.expired ? ` · ${data.contractors.expired} expired` : ""}`}
          tone={data.contractors.expired ? "bad" : data.contractors.ending_soon ? "warn" : undefined}
          onOpen={() => openDrill("contracts_ending")}
        />
      </div>

      <div className="ld-grid">
        <Card
          title={groupBy === "country" ? "By country" : "By department"}
          action={
            <div className="ld-seg" role="tablist">
              {(["country", "department"] as const).map((g) => (
                <button key={g} type="button" role="tab" aria-selected={groupBy === g} className={groupBy === g ? "on" : ""} onClick={() => setGroupBy(g)}>
                  {g === "country" ? "Country" : "Department"}
                </button>
              ))}
            </div>
          }
        >
          {groups.length === 0 ? (
            <EmptyState title="No people match these filters" />
          ) : (
            <div className="ld-table-wrap">
            <table className="ld-table">
              <thead>
                <tr><th>{groupBy === "country" ? "Country" : "Department"}</th><th>Headcount</th><th className="num">Joiners</th><th className="num">Leavers</th><th className="num">Attrition</th></tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const extra = groupBy === "country" ? { country: g.key } : { department: g.key };
                  return (
                    <tr key={g.key}>
                      <td>
                        <button type="button" className="ld-link" onClick={() => setFilters({ ...filters, ...extra })} title="Filter the dashboard">
                          {g.name ?? g.key}
                        </button>
                      </td>
                      <td>
                        <button type="button" className="ld-link ld-barcell" onClick={() => openDrill("headcount", extra)}>
                          <Bar value={g.headcount} max={maxHead} /> <span>{g.headcount}</span>
                        </button>
                      </td>
                      <td className="num">{g.joiners ? <button type="button" className="ld-link" onClick={() => openDrill("joiners", extra)}>{g.joiners}</button> : 0}</td>
                      <td className="num">{g.exits ? <button type="button" className="ld-link" onClick={() => openDrill("exits", extra)}>{g.exits}</button> : 0}</td>
                      <td className="num">{g.attrition_pct}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          )}
        </Card>

        <Card title="Hiring pipeline" to="/recruiting">
          <ul className="ld-funnel">
            {data.hiring.by_stage.map((s) => (
              <li key={s.stage}>
                <span>{s.stage}</span>
                <Bar value={s.count} max={stageMax} />
                <strong>{s.count}</strong>
              </li>
            ))}
          </ul>
          <p className="ld-foot">
            {data.hiring.awaiting_approval} requisition{data.hiring.awaiting_approval === 1 ? "" : "s"} and {data.hiring.offers_awaiting_approval} offer
            {data.hiring.offers_awaiting_approval === 1 ? "" : "s"} waiting for approval · {data.hiring.offers_out} offers out · {data.hiring.hires_in_range} hired ({rangeLabel.toLowerCase()})
          </p>
        </Card>

        <Card title="Performance distribution" to="/evaluations">
          {!data.performance ? (
            <EmptyState title="No review cycle yet" />
          ) : (
            <>
              <p className="ld-sub">
                {data.performance.cycle} · {data.performance.status} · self reviews {data.performance.self_done}/{data.performance.reviews} · manager reviews{" "}
                {data.performance.manager_done}/{data.performance.reviews} · released {data.performance.released}
              </p>
              {perfTotal === 0 ? (
                <p className="note">No {data.performance.includes_unreleased ? "" : "released "}ratings yet.</p>
              ) : (
                <ul className="ld-funnel" aria-label={`Ratings, ${data.performance.distribution_cycle}`}>
                  {data.performance.distribution_cycle !== data.performance.cycle && (
                    <li className="ld-funnel-note">Last released ratings · {data.performance.distribution_cycle}</li>
                  )}
                  {data.performance.distribution.map((d) => (
                    <li key={d.rating}>
                      <span>{d.rating}</span>
                      <Bar value={d.count} max={perfTotal} />
                      <strong>{Math.round((d.count * 100) / perfTotal)}%</strong>
                    </li>
                  ))}
                </ul>
              )}
              {data.performance.includes_unreleased && <p className="ld-foot">Includes proposed ratings still in calibration (HR view).</p>}
            </>
          )}
        </Card>

        <Card title="Mandatory learning" to="/programs">
          {data.learning.courses.length === 0 ? (
            <EmptyState title="No mandatory courses assigned" />
          ) : (
            <ul className="ld-funnel">
              {data.learning.courses.slice(0, 8).map((c) => (
                <li key={c.course_id}>
                  <span title={c.title}>{c.title}</span>
                  <Bar value={c.completed} max={c.assigned} tone={c.overdue ? "warn" : "ok"} />
                  <strong>
                    {c.completed}/{c.assigned}
                    {c.overdue ? <em className="ld-overdue"> · {c.overdue} late</em> : null}
                  </strong>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {data.cost_visible && data.cost && (
          <Card title="Annual base pay" to="/compensation">
            {data.cost.annual_base.length === 0 ? (
              <EmptyState title="No pay records" />
            ) : (
              <DataTable headers={["Currency", "Annual base"]} rows={data.cost.annual_base.map((c) => [c.currency, fmtMoney(c.amount, c.currency)])} />
            )}
            {data.cost.without_record > 0 && <p className="ld-foot">{data.cost.without_record} people have no pay record yet.</p>}
          </Card>
        )}
      </div>

      <Dialog
        open={drill !== null}
        title={drill ? `${DRILL_TITLES[drill.metric]}${drill.filters.country ? ` · ${drill.filters.country}` : ""}${drill.filters.department ? ` · ${drill.filters.department}` : ""}` : ""}
        onClose={() => setDrill(null)}
        wide
      >
        {drill?.rows == null ? (
          <p className="note">Loading…</p>
        ) : (
          <DataTable
            headers={["Name", "Job title", "Department", "Country", "Detail"]}
            rows={drill.rows.map((r) => [<Link key={r.id} to={`/directory/${encodeURIComponent(r.id)}`}>{r.name}</Link>, r.job_title, r.department, r.country, r.detail ?? `Joined ${fmtDate(r.joining_date)}`])}
            empty={<EmptyState title="Nobody here" />}
          />
        )}
      </Dialog>
    </div>
  );
}

const ALERT_TEXT: Record<ContractorOut["alert"], string> = {
  expired: "Expired",
  ending_30: "Ends within 30 days",
  ending_60: "Ends within 60 days",
  no_end_date: "No end date",
  ok: "Active",
};

/** Contractors in scope with contract end alerts; managers / HR ask to extend, HR approves with a comment. */
export function ContractorsCard({ title = "Contractors" }: { title?: string }) {
  const [rows, setRows] = useState<ContractorOut[] | null>(null);
  const [extend, setExtend] = useState<ContractorOut | null>(null);
  const [decide, setDecide] = useState<ContractorOut | null>(null);
  const [newEnd, setNewEnd] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    getContractors().then(setRows).catch(() => setRows([]));
  }, []);
  useEffect(load, [load]);

  async function submitExtension() {
    if (!extend) return;
    setBusy(true);
    try {
      await requestExtension(extend.id, newEnd, text.trim());
      notify(`Extension for ${extend.name} sent to HR.`);
      setExtend(null);
      load();
    } catch (e) {
      notifyError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submitDecision(decision: "approve" | "reject") {
    const ext = decide?.pending_extension;
    if (!ext) return;
    setBusy(true);
    try {
      await decideExtension(ext.id, decision, text.trim());
      notify(decision === "approve" ? `Contract extended to ${fmtDate(ext.new_end)}.` : "Extension rejected.");
      setDecide(null);
      load();
    } catch (e) {
      notifyError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (rows === null) return <Card title={title}><p className="note">Loading…</p></Card>;
  const alerts = rows.filter((r) => r.alert !== "ok").length;

  return (
    <Card title={`${title} (${rows.length})`}>
      {alerts > 0 && <p className="note warn">{alerts} contract{alerts === 1 ? "" : "s"} need attention.</p>}
      <DataTable
        headers={["Name", "Department", "Manager", "Contract end", "Status", ""]}
        rows={rows.map((r) => [
          r.name,
          r.department,
          r.manager ?? "—",
          r.contract_end_date ? `${fmtDate(r.contract_end_date)}${r.days_left != null && r.days_left >= 0 ? ` (${r.days_left} days)` : ""}` : "—",
          <span key="s" className={`ld-pill ld-pill-${r.alert}`}>{r.pending_extension ? `Extension to ${fmtDate(r.pending_extension.new_end)} pending` : ALERT_TEXT[r.alert]}</span>,
          r.pending_extension ? (
            r.pending_extension.can_decide ? (
              <button key="a" type="button" className="btn btn-tiny" onClick={() => { setDecide(r); setText(""); }}>Review</button>
            ) : null
          ) : (
            <button key="a" type="button" className="btn-ghost btn-tiny" onClick={() => { setExtend(r); setNewEnd(""); setText(""); }}>Extend</button>
          ),
        ])}
        empty={<EmptyState title="No contractors in your scope" />}
      />

      <Dialog
        open={extend !== null}
        title={`Extend ${extend?.name ?? ""}'s contract`}
        onClose={() => setExtend(null)}
        actions={
          <>
            <button type="button" className="btn-ghost" onClick={() => setExtend(null)}>Cancel</button>
            <button type="button" className="btn" disabled={busy || !newEnd || text.trim().length < 5} onClick={() => void submitExtension()}>Send to HR</button>
          </>
        }
      >
        <p className="note">Current end date: {fmtDate(extend?.contract_end_date)}. HR decides; the employee record changes once approved.</p>
        <Field label="New end date" required>
          <input type="date" value={newEnd} min={extend?.contract_end_date ?? undefined} onChange={(e) => setNewEnd(e.target.value)} />
        </Field>
        <Field label="Reason" required wide>
          <textarea rows={3} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} placeholder="Why the contract should continue (at least 5 characters)" />
        </Field>
      </Dialog>

      <Dialog
        open={decide !== null}
        title={`Contract extension · ${decide?.name ?? ""}`}
        onClose={() => setDecide(null)}
        actions={
          <>
            <button type="button" className="btn-ghost" disabled={busy || text.trim().length < 5} onClick={() => void submitDecision("reject")}>Reject</button>
            <button type="button" className="btn" disabled={busy} onClick={() => void submitDecision("approve")}>Approve</button>
          </>
        }
      >
        {decide?.pending_extension && (
          <>
            <p>
              {decide.pending_extension.requested_by_name} asks to extend from {fmtDate(decide.pending_extension.current_end)} to{" "}
              <strong>{fmtDate(decide.pending_extension.new_end)}</strong>.
            </p>
            <blockquote className="ld-quote">{decide.pending_extension.reason}</blockquote>
            <Field label="Comment (required to reject)" wide>
              <textarea rows={3} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
          </>
        )}
      </Dialog>
    </Card>
  );
}
