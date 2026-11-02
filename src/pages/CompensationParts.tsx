/**
 * Compensation page tabs: pay history, bonuses and the total rewards statement, each with filters and a
 * per-row breakdown. Rows come from the reward store, which already holds only pay this viewer may see
 * (backend mode: the server returns your own pay, plus everyone in scope for HR / compensation and
 * explicitly authorized people); the total rewards statement for someone else is authorized by the server.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchStatement, type CompStatementOut } from "../api/syncRewards.ts";
import { money, moneyTotals } from "../countryPay.ts";
import type { BonusRecord, CompHistoryRow } from "../data/rewardData.ts";
import { formatAmount } from "../data/rewardLocal.ts";
import { formatShortDate, todayISO } from "../model.ts";
import { Card, DataTable, Dialog, EmptyState, FilterBar, MetricCard, MetricGrid, StatusBadge } from "../components/ui.tsx";

/** "₹34,00,000" / "$185,000" → 3400000 / 185000 (amounts are whole numbers in the store). */
export function amountOf(text: string): number {
  const n = Number(String(text).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function dateText(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? formatShortDate(iso) : iso;
}

function people<T extends { employeeId: string; employeeName: string }>(rows: T[]): { id: string; name: string }[] {
  const seen = new Map<string, string>();
  rows.forEach((r) => seen.set(r.employeeId, r.employeeName));
  return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

/* ───────── Pay history ───────── */

export function PayHistoryCard({ rows, compTeam, title }: { rows: CompHistoryRow[]; compTeam: boolean; title: string }) {
  const [who, setWho] = useState("");
  const [open, setOpen] = useState<CompHistoryRow | null>(null);
  const names = useMemo(() => people(rows), [rows]);
  const shown = rows.filter((r) => !who || r.employeeId === who);

  /** The record in effect just before this one, for the same person. */
  function previousOf(row: CompHistoryRow): CompHistoryRow | undefined {
    return rows
      .filter((r) => r.employeeId === row.employeeId && r.effective < row.effective)
      .sort((a, b) => b.effective.localeCompare(a.effective))[0];
  }

  const prev = open ? previousOf(open) : undefined;
  const base = open ? amountOf(open.base) : 0;
  const before = prev ? amountOf(prev.base) : 0;
  const change = prev ? base - before : 0;
  const pct = prev && before > 0 ? (change / before) * 100 : null;

  return (
    <Card title={title}>
      {compTeam && names.length > 1 && (
        <FilterBar>
          <label className="filter-label">
            Employee
            <select value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="">All ({names.length})</option>
              {names.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
        </FilterBar>
      )}
      <DataTable
        headers={[...(compTeam ? ["Employee"] : []), "Effective", "Event", "Grade", "Base", ""]}
        rows={shown.map((row) => [
          ...(compTeam ? [row.employeeName] : []),
          dateText(row.effective),
          row.event,
          row.grade,
          row.base,
          <button key={row.id} type="button" className="quiet-link" onClick={() => setOpen(row)} aria-label={`Pay change details, ${dateText(row.effective)}`}>
            Details
          </button>,
        ])}
        empty={<EmptyState title="No pay changes" description="Nothing recorded yet." />}
      />
      {open && (
        <Dialog open title={`Pay change · ${dateText(open.effective)}`} onClose={() => setOpen(null)}>
          <dl className="info-grid">
            {compTeam && <div className="info-fact"><dt>Employee</dt><dd>{open.employeeName}</dd></div>}
            <div className="info-fact"><dt>Effective</dt><dd>{dateText(open.effective)}</dd></div>
            <div className="info-fact"><dt>Reason</dt><dd>{open.event || "—"}</dd></div>
            <div className="info-fact"><dt>Grade</dt><dd>{prev && prev.grade !== open.grade ? `${prev.grade} → ${open.grade}` : open.grade}</dd></div>
            <div className="info-fact"><dt>Annual base</dt><dd>{open.base}</dd></div>
            <div className="info-fact"><dt>Monthly (÷12)</dt><dd>{money(Math.round(base / 12), open.currency)}</dd></div>
            <div className="info-fact"><dt>Previous base</dt><dd>{prev ? `${prev.base} (from ${dateText(prev.effective)})` : "First record"}</dd></div>
            <div className="info-fact">
              <dt>Change</dt>
              <dd>{prev ? `${change >= 0 ? "+" : "−"}${money(Math.abs(change), open.currency)}${pct !== null ? ` (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)` : ""}` : "—"}</dd>
            </div>
          </dl>
          <p className="note">Pay details are confidential. Each view of someone else's pay is recorded.</p>
        </Dialog>
      )}
    </Card>
  );
}

/* ───────── Bonuses ───────── */

const BONUS_STATUSES: BonusRecord["status"][] = ["Accrued", "Paid", "Forfeited"];

export function BonusesCard({
  rows,
  compTeam,
  title,
  action,
  renderAction,
}: {
  rows: BonusRecord[];
  compTeam: boolean;
  title: string;
  action?: ReactNode;
  /** Extra last column (HR: Mark paid / Forfeit). */
  renderAction?: (b: BonusRecord) => ReactNode;
}) {
  const [status, setStatus] = useState<BonusRecord["status"] | "">("");
  const [who, setWho] = useState("");
  const names = useMemo(() => people(rows), [rows]);
  const shown = rows.filter((b) => (!status || b.status === status) && (!who || b.employeeId === who));
  const counted = shown.filter((b) => b.status !== "Forfeited");
  const totals = moneyTotals(counted.map((b) => ({ amount: amountOf(b.amount), currency: b.currency })), rows[0]?.currency ?? "INR");

  return (
    <Card title={title} action={action}>
      <FilterBar>
        <label className="filter-label">
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value as BonusRecord["status"] | "")}>
            <option value="">All</option>
            {BONUS_STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        {compTeam && names.length > 1 && (
          <label className="filter-label">
            Employee
            <select value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="">All ({names.length})</option>
              {names.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
        )}
      </FilterBar>
      {shown.length > 0 && (
        <MetricGrid>
          <MetricCard label="Records" value={shown.length} />
          <MetricCard label="Accrued or paid" value={counted.length ? totals : "—"} hint="Forfeited bonuses are not counted" />
        </MetricGrid>
      )}
      <DataTable
        headers={[...(compTeam ? ["Employee"] : []), "Type", "Period", "Amount", "Status", ...(renderAction ? [""] : [])]}
        rows={shown.map((b) => [
          ...(compTeam ? [b.employeeName] : []),
          b.type,
          b.period,
          b.amount,
          <StatusBadge key={b.id} status={b.status} literal />,
          ...(renderAction ? [<span key={`${b.id}-a`}>{renderAction(b)}</span>] : []),
        ])}
        empty={<EmptyState title="No bonuses" description={rows.length ? "None match these filters." : "Nothing recorded yet."} />}
      />
    </Card>
  );
}

/* ───────── Total rewards (backend mode) ───────── */

export function TotalRewardsCard({ selfId, others }: { selfId: string; others: { id: string; name: string }[] }) {
  const thisYear = Number(todayISO().slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [who, setWho] = useState(selfId);
  const [data, setData] = useState<CompStatementOut | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setData(undefined);
    void fetchStatement(year, who === selfId ? undefined : who).then((out) => {
      if (live) setData(out);
    });
    return () => {
      live = false;
    };
  }, [year, who, selfId]);
  const cur = data?.currency ?? "INR";
  const total = data?.total_rewards ?? 0;
  const share = (n: number) => (total > 0 ? `${Math.round((n / total) * 100)}%` : "—");
  const choices = others.filter((p) => p.id !== selfId);
  return (
    <Card
      title="Total rewards statement"
      action={
        <div className="row-gap">
          {choices.length > 0 && (
            <label className="filter-label">
              Employee
              <select value={who} onChange={(e) => setWho(e.target.value)}>
                <option value={selfId}>Me</option>
                {choices.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
          )}
          <label className="filter-label">
            Year
            <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
              {[thisYear, thisYear - 1, thisYear - 2].map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </label>
        </div>
      }
    >
      {data === undefined ? (
        <p className="note">Loading…</p>
      ) : data === null ? (
        <EmptyState title="No statement" description="Nothing to show for this year, or you don't have access to it." />
      ) : (
        <>
          <MetricGrid>
            <MetricCard label="Base salary" value={formatAmount(data.base_salary, cur)} hint={data.grade ? `Grade ${data.grade}` : undefined} />
            <MetricCard label="Bonuses" value={formatAmount(data.bonus_total, cur)} hint={`${data.bonuses.length} in ${data.year}`} />
            <MetricCard label="Benefits (employer cost)" value={formatAmount(data.benefits_employer_cost, cur)} hint={`${data.benefits.length} plan${data.benefits.length === 1 ? "" : "s"}`} />
            <MetricCard label="Total rewards" value={formatAmount(data.total_rewards, cur)} />
          </MetricGrid>
          <DataTable
            headers={["Item", "Type", "Annual value", "Share"]}
            rows={[
              ["Base salary", data.base_effective_date ? `Since ${formatShortDate(data.base_effective_date)}` : "Base", formatAmount(data.base_salary, cur), share(data.base_salary)],
              ...data.bonuses.map((b) => [b.bonus_type, `Bonus · ${b.period} · ${b.status}`, formatAmount(b.amount, b.currency), b.currency === cur ? share(b.amount) : "—"]),
              ...data.benefits.map((b) => [b.plan_name, `Benefit · ${b.plan_type}`, formatAmount(b.employer_annual_cost, b.currency), b.currency === cur ? share(b.employer_annual_cost) : "—"]),
            ]}
          />
          <p className="note">Benefits are shown at what the company pays for them each year. Bonuses count when accrued or paid.</p>
        </>
      )}
    </Card>
  );
}
