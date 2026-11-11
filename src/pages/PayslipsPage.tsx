import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ActionButton, Banner, Card, Page, Tabs } from "../components/ui.tsx";
import { legalEntityFor, money, payRulesFor, taxYearStartFor } from "../countryPay.ts";
import { notify } from "../components/Toast.tsx";
import type { IndiaRegime } from "../countryPay.ts";
import {
  asDetailView,
  compareRegimes,
  estimateMonthSoFar,
  paydayFor,
  taxYearSummary,
  type MonthSoFar,
  type PayslipDetailView,
  type PayslipInput,
} from "../data/payslipGenerator.ts";
import { annualBaseFor } from "../data/annualPay.ts";
import { getRewardState, subscribeReward } from "../data/rewardLocal.ts";
import { setTaxRegime, useTaxRegime } from "../data/taxRegime.ts";
import { formatShortDate, parseISODate, todayISO, toISO } from "../model.ts";
import type { Employee, PayLine, PayslipView } from "../model.ts";
import { usePortal } from "../store.tsx";
import { STATUS_TEXT, downloadPayslip, monthTitle, slipBreakdown, slipStatus, type SlipStatus } from "../features/payroll/payslipDoc.ts";
import { declConfig, myDeclarations, reloadDeclarations, useDeclarationsVersion } from "../features/taxdecl/taxDeclStore.ts";
import "../features/payroll/payslips.css";
import "../styles/pay-claims.css";

/** First and last day of the payslip's month. */
function payPeriod(month: string): { from: string; to: string } {
  const start = parseISODate(`${month}-01`);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
  return { from: toISO(start), to: toISO(end) };
}

function slipHeader(payslip: PayslipView, employee: Pick<Employee, "legalEntity" | "countryCode" | "countryName">) {
  const period = payPeriod(payslip.month);
  // A final payslip ends on the last working day (paid from the 1st).
  if (payslip.finalSettlement && payslip.paidDays != null) period.to = `${payslip.month}-${String(payslip.paidDays).padStart(2, "0")}`;
  return {
    entity: employee.legalEntity ?? legalEntityFor(employee.countryCode),
    country: employee.countryName ?? "India",
    period: `${formatShortDate(period.from)} – ${formatShortDate(period.to)}`,
  };
}

function basisText(slip: PayslipDetailView): string {
  return slip.basis === "hourly" && slip.hourlyRate ? `Hourly · ${money(slip.hourlyRate, slip.currency)}/h` : "Monthly salary";
}

/** FINAL (locked payroll run) or ESTIMATED (worked out by the portal). */
export function SlipTag({ status }: { status: SlipStatus }) {
  return (
    <span className={`slip-tag ${status}`} title={STATUS_TEXT[status]}>
      {status === "final" ? "Final" : "Estimated"}
    </span>
  );
}

function LinesTable({ lines, currency, empty }: { lines: PayLine[]; currency?: string; empty: string }) {
  return (
    <div className="doc-table-wrap">
      <table className="data pay-lines-table">
        <tbody>
          {lines.length === 0 && (
            <tr>
              <td colSpan={2} className="muted">
                {empty}
              </td>
            </tr>
          )}
          {lines.map((line) => (
            <tr key={line.name}>
              <td>{line.name}</td>
              <td>{money(line.amount, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Earnings, deductions, net, employer contributions, tax working and year-to-date — read only. */
export function PayslipBody({ payslip }: { payslip: PayslipView }) {
  const detail = asDetailView(payslip);
  const currency = payslip.currency;
  return (
    <>
      <div className="pay-lines">
        <section className="pay-col">
          <h2 className="card-title">Earnings</h2>
          <LinesTable lines={payslip.earnings.filter((line) => line.amount > 0)} currency={currency} empty="No approved hours this month" />
          <div className="total-row">
            <span>Gross</span>
            <span>{money(payslip.gross, currency)}</span>
          </div>
        </section>
        <section className="pay-col">
          <h2 className="card-title">Deductions</h2>
          <LinesTable lines={payslip.deductions} currency={currency} empty="No income tax or deductions" />
          <div className="total-row">
            <span>Total deductions</span>
            <span>{money(payslip.deductionTotal, currency)}</span>
          </div>
          {detail && detail.tax.monthTax > 0 && (
            <div className="total-row muted">
              <span>Of which income tax</span>
              <span>{money(detail.tax.monthTax, currency)}</span>
            </div>
          )}
        </section>
      </div>
      <div className="pay-net">
        <span>Net pay</span>
        <span>{money(payslip.net, currency)}</span>
      </div>
      {detail && detail.employerContributions.length > 0 && (
        <section style={{ marginTop: 16 }}>
          <h2 className="card-title">Employer contributions</h2>
          <div className="doc-table-wrap">
            <table className="data pay-lines-table pay-employer-table">
              <tbody>
                {detail.employerContributions.map((l) => (
                  <tr key={l.name}>
                    <td>{l.name}</td>
                    <td>{money(l.amount, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {detail && (
        <details style={{ marginTop: 16 }} open>
          <summary>Tax computation · {detail.tax.taxYear}</summary>
          <div className="doc-table-wrap">
            <table className="data pay-lines-table" style={{ marginTop: 8 }}>
              <tbody>
                <tr>
                  <td>Basis</td>
                  <td>{detail.tax.basis}</td>
                </tr>
                <tr>
                  <td>Annual gross (annualised)</td>
                  <td>{money(detail.tax.annualGross, currency)}</td>
                </tr>
                {detail.tax.reliefs.map((r) => (
                  <tr key={r.name}>
                    <td className="muted">Less {r.name}</td>
                    <td className="muted">{money(r.amount, currency)}</td>
                  </tr>
                ))}
                <tr>
                  <td>Annual taxable income</td>
                  <td>{money(detail.tax.annualTaxable, currency)}</td>
                </tr>
                {detail.tax.components.length > 1 &&
                  detail.tax.components.map((c) => (
                    <tr key={c.name}>
                      <td className="muted">{c.name}</td>
                      <td className="muted">{money(c.amount, currency)}</td>
                    </tr>
                  ))}
                <tr>
                  <td>Annual tax</td>
                  <td>{money(detail.tax.annualTax, currency)}</td>
                </tr>
                <tr>
                  <td>This month</td>
                  <td>{money(detail.tax.monthTax, currency)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </details>
      )}
      {detail && (
        <div className="pay-head slip-stats" style={{ marginTop: 16 }}>
          <div>
            <div className="muted">YTD gross · {detail.ytd.taxYear}</div>
            <strong>{money(detail.ytd.gross, currency)}</strong>
          </div>
          <div>
            <div className="muted">YTD tax</div>
            <strong>{money(detail.ytd.tax, currency)}</strong>
          </div>
          <div>
            <div className="muted">YTD net</div>
            <strong>{money(detail.ytd.net, currency)}</strong>
          </div>
        </div>
      )}
    </>
  );
}

/** India: new / old regime, with a full year's tax under each. Saving changes the payslip TDS (until the deadline). */
export function RegimePicker({ input, showLink = true }: { input: PayslipInput; showLink?: boolean }) {
  const regime = useTaxRegime(input.employeeId);
  const { demoProfile } = usePortal();
  useDeclarationsVersion();
  const cfg = declConfig({ id: input.employeeId, fullName: "", role: demoProfile.role, countryCode: input.countryCode });
  const locked = cfg ? !cfg.regimeEditable : false;
  const [saving, setSaving] = useState(false);
  const both = compareRegimes({ ...input, regime });
  const c = "INR";
  const better: IndiaRegime = both.old.annualTax < both.new.annualTax ? "old" : "new";
  async function choose(next: IndiaRegime) {
    if (next === regime || saving) return;
    setSaving(true);
    const error = await setTaxRegime(input.employeeId, next);
    if (!error) await reloadDeclarations();
    setSaving(false);
    notify(error ?? `${next === "new" ? "New" : "Old"} regime saved. Payslip tax updated.`, error ? "err" : "ok");
  }
  return (
    <div className="regime-pick">
      <label className="field" style={{ maxWidth: 280, margin: 0 }}>
        <span>Tax regime</span>
        <select value={regime} disabled={saving || locked} onChange={(event) => void choose(event.target.value === "old" ? "old" : "new")}>
          <option value="new">New regime (default)</option>
          <option value="old">Old regime</option>
        </select>
      </label>
      <p className="muted" style={{ margin: "8px 0 0" }}>
        Estimated tax for the year · new {money(both.new.annualTax, c)} · old {money(both.old.annualTax, c)}
        {both.new.annualTax !== both.old.annualTax && ` · ${better} is lower by ${money(Math.abs(both.new.annualTax - both.old.annualTax), c)}`}
        {saving ? " · saving…" : ""}
      </p>
      <p className="muted" style={{ margin: "4px 0 0" }}>
        {cfg?.regimeNote ? `${cfg.regimeNote} ` : ""}Old regime counts verified declarations.
        {showLink && (
          <>
            {" "}
            <Link to="/investment">Declarations</Link>
          </>
        )}
      </p>
    </div>
  );
}

/** Tax paid so far this tax year, projected to the year end, and the regime (India: pick it here). */
export function TaxYearCard({ input, slips }: { input: PayslipInput; slips: PayslipView[] }) {
  useTaxRegime(input.employeeId);
  const sum = taxYearSummary(input, slips);
  const c = sum.currency;
  if (!sum.hasIncomeTax) {
    return (
      <Card title="Tax this year">
        <p className="muted" style={{ margin: 0 }}>
          {sum.basis || "No personal income tax"} · {sum.taxYear}
        </p>
      </Card>
    );
  }
  const stat = (label: string, value: string) => (
    <div>
      <div className="muted">{label}</div>
      <strong>{value}</strong>
    </div>
  );
  return (
    <Card title="Tax this year">
      <p className="muted" style={{ margin: "0 0 12px" }}>
        {sum.taxYear} · {sum.basis} · <SlipTag status="estimated" />
      </p>
      <div className="pay-head slip-stats">
        {stat("Tax paid so far", money(sum.ytdTax, c))}
        {stat("Projected for the year", money(sum.projectedTax, c))}
        {stat("Per month now", money(sum.monthTax, c))}
        {stat("Months left", String(sum.monthsLeft))}
      </div>
      {input.countryCode === "IN" && (
        <div style={{ marginTop: 16 }}>
          <RegimePicker input={input} />
        </div>
      )}
    </Card>
  );
}

function dayMonth(iso: string) {
  return parseISODate(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** "1–29 Oct" (or "12–29 Oct" for a joiner). */
function spanText(from: string, to: string) {
  return `${Number(from.slice(8, 10))}–${dayMonth(to)}`;
}

/** Pay earned this month up to today: an estimate until payday. */
function MonthSoFarCard({ est }: { est: MonthSoFar }) {
  const c = est.currency;
  return (
    <Card title="This month so far">
      <p className="muted" style={{ margin: "0 0 12px" }}>
        {spanText(est.from, est.to)} · <SlipTag status="estimated" />
      </p>
      <div className="pay-head slip-stats">
        <div>
          <div className="muted">Gross</div>
          <strong>{money(est.gross, c)}</strong>
        </div>
        <div>
          <div className="muted">Deductions (est.)</div>
          <strong>{money(est.deductionTotal, c)}</strong>
        </div>
        <div>
          <div className="muted">Net (est.)</div>
          <strong>{money(est.net, c)}</strong>
        </div>
        <div>
          <div className="muted">Days counted</div>
          <strong>
            {est.daysCounted} of {est.totalDays}
          </strong>
        </div>
      </div>
      <p className="muted" style={{ margin: "12px 0 0" }}>
        Payday: {formatShortDate(est.payday)} (last working day of the month)
        {est.leavingThisMonth ? " · your final pay this month also settles unused leave" : ""}
      </p>
    </Card>
  );
}

function taxYearOf(slip: PayslipView): string {
  return asDetailView(slip)?.tax.taxYear ?? slip.month.slice(0, 4);
}

/** Pay periods as a horizontal strip (arrows, drag, wheel, keys; click selects) with the chosen payslip in full below. */
function PeriodPicker({ slips, employee, regime }: { slips: PayslipView[]; employee: Employee; regime?: string }) {
  const navigate = useNavigate();
  const ordered = useMemo(() => [...slips].sort((a, b) => a.month.localeCompare(b.month)), [slips]);
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const index = Math.max(0, chosen ? ordered.findIndex((s) => s.id === chosen) : ordered.length - 1);
  const slip = ordered[index];
  const rail = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; left: number; moved: boolean } | null>(null);
  const [edges, setEdges] = useState({ start: true, end: true });

  const updateEdges = useCallback(() => {
    const el = rail.current;
    if (!el) return;
    setEdges({ start: el.scrollLeft <= 2, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 2 });
  }, []);

  // Keep the chosen month in view without moving the page.
  useEffect(() => {
    const el = rail.current;
    const chip = el?.querySelector<HTMLElement>(`[data-slip="${slip?.id}"]`);
    if (!el || !chip) return;
    el.scrollTo({ left: chip.offsetLeft - el.clientWidth / 2 + chip.clientWidth / 2, behavior: chosen ? "smooth" : "auto" });
    window.setTimeout(updateEdges, chosen ? 350 : 0);
  }, [slip?.id, chosen, updateEdges]);

  // A mouse wheel scrolls the strip sideways (React wheel handlers are passive, so listen directly).
  useEffect(() => {
    const el = rail.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("resize", updateEdges);
    return () => {
      el.removeEventListener("wheel", onWheel);
      window.removeEventListener("resize", updateEdges);
    };
  }, [updateEdges]);

  if (!slip) return null;
  const select = (i: number) => setChosen(ordered[Math.min(ordered.length - 1, Math.max(0, i))]?.id);
  const scrollBy = (dir: number) => rail.current?.scrollBy({ left: dir * Math.max(160, (rail.current.clientWidth ?? 0) * 0.7), behavior: "smooth" });
  const b = slipBreakdown(slip);
  const status = slipStatus(slip);

  return (
    <Card title="Pay periods" className="pc-periods-card">
      <div className="pc-periods">
        <button type="button" className="pc-periods-arrow" aria-label="Earlier months" disabled={edges.start} onClick={() => scrollBy(-1)}>
          ‹
        </button>
        <div
          ref={rail}
          className="pc-periods-rail"
          role="listbox"
          aria-label="Pay periods"
          aria-activedescendant={`period-${slip.id}`}
          tabIndex={0}
          onScroll={updateEdges}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              select(index + (e.key === "ArrowLeft" ? -1 : 1));
            } else if (e.key === "Home" || e.key === "End") {
              e.preventDefault();
              select(e.key === "Home" ? 0 : ordered.length - 1);
            }
          }}
          onPointerDown={(e) => {
            if (e.pointerType !== "mouse" || e.button !== 0 || !rail.current) return;
            drag.current = { x: e.clientX, left: rail.current.scrollLeft, moved: false };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d || !rail.current) return;
            if (Math.abs(e.clientX - d.x) > 5) d.moved = true;
            if (d.moved) rail.current.scrollLeft = d.left - (e.clientX - d.x);
          }}
          onPointerUp={() => window.setTimeout(() => (drag.current = null), 0)}
          onPointerLeave={() => (drag.current = null)}
        >
          {ordered.map((s, i) => {
            const st = slipStatus(s);
            const d = parseISODate(`${s.month}-01`);
            return (
              <button
                key={s.id}
                id={`period-${s.id}`}
                data-slip={s.id}
                type="button"
                role="option"
                aria-selected={i === index}
                tabIndex={-1}
                className={`pc-period${i === index ? " is-on" : ""} is-${st}`}
                onClick={(e) => {
                  if (drag.current?.moved) {
                    e.preventDefault();
                    return;
                  }
                  select(i);
                }}
              >
                <span className="pc-period-month">{d.toLocaleDateString("en-GB", { month: "short" })}</span>
                <span className="pc-period-year">{d.getFullYear()}</span>
                <span className="pc-period-net">{money(s.net, s.currency)}</span>
                <span className="pc-period-dot" aria-label={st === "final" ? "Final" : "Estimated"} />
              </button>
            );
          })}
        </div>
        <button type="button" className="pc-periods-arrow" aria-label="Later months" disabled={edges.end} onClick={() => scrollBy(1)}>
          ›
        </button>
      </div>

      <div className="pc-slip">
        <div className="pc-slip-top">
          <div className="pc-slip-title">
            <button type="button" className="btn-ghost btn-tiny" aria-label="Previous month" disabled={index === 0} onClick={() => select(index - 1)}>
              ‹
            </button>
            <h3>{monthTitle(slip.month)}</h3>
            <button
              type="button"
              className="btn-ghost btn-tiny"
              aria-label="Next month"
              disabled={index === ordered.length - 1}
              onClick={() => select(index + 1)}
            >
              ›
            </button>
            <SlipTag status={status} />
            {slip.finalSettlement && <span className="pill pill-mandatory">Final settlement</span>}
          </div>
          <span className="form-actions pc-slip-actions">
            <button type="button" className="btn-ghost btn-tiny" onClick={() => navigate(`/payslips/${slip.id}`)}>
              Open
            </button>
            <ActionButton
              className="btn btn-tiny"
              busyLabel="Preparing…"
              doneLabel="Downloaded"
              onAction={() => downloadPayslip(slip, employee, regime)}
              success={`${monthTitle(slip.month)} payslip downloaded (PDF).`}
              toastError
            >
              Download PDF
            </ActionButton>
          </span>
        </div>
        <div className="pc-slip-figures">
          <div>
            <span className="muted">Gross</span>
            <strong>{money(b.gross, slip.currency)}</strong>
          </div>
          <div>
            <span className="muted">Deductions</span>
            <strong>{money(b.deductions, slip.currency)}</strong>
          </div>
          <div>
            <span className="muted">Tax</span>
            <strong>{money(b.tax, slip.currency)}</strong>
          </div>
          <div className="is-net">
            <span className="muted">Net pay</span>
            <strong>{money(b.net, slip.currency)}</strong>
          </div>
        </div>
        <PayslipHead payslip={slip} person={employee} />
        <PayslipBody payslip={slip} />
      </div>
    </Card>
  );
}

/** Monthly summary: basic, allowances, gross, deductions, tax, net; click a month for the full payslip. */
function SummaryCard({ slips, employee, regime }: { slips: PayslipView[]; employee: Employee; regime?: string }) {
  const navigate = useNavigate();
  const years = [...new Set(slips.map(taxYearOf))];
  const [year, setYear] = useState("");
  const [status, setStatus] = useState<"" | SlipStatus>("");
  const shown = slips.filter((s) => (!year || taxYearOf(s) === year) && (!status || slipStatus(s) === status));
  const c = slips[0]?.currency;
  const totals = shown.reduce(
    (acc, s) => {
      const b = slipBreakdown(s);
      return { gross: acc.gross + b.gross, deductions: acc.deductions + b.deductions, tax: acc.tax + b.tax, net: acc.net + b.net };
    },
    { gross: 0, deductions: 0, tax: 0, net: 0 },
  );
  return (
    <Card title="Monthly payslips">
      <div className="slip-filters">
        <label>
          Tax year
          <select value={year} onChange={(e) => setYear(e.target.value)}>
            <option value="">All years</option>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
        <label>
          Figures
          <select value={status} onChange={(e) => setStatus(e.target.value as "" | SlipStatus)}>
            <option value="">Final and estimated</option>
            <option value="final">Final only</option>
            <option value="estimated">Estimated only</option>
          </select>
        </label>
        <p className="slip-legend">
          <span>
            <SlipTag status="final" /> from the locked payroll run
          </span>
          <span>
            <SlipTag status="estimated" /> worked out by TimeZ until payroll locks the month
          </span>
        </p>
      </div>
      <div className="doc-table-wrap scroll-x">
        <table className="data doc-table pay-list pay-summary">
          <thead>
            <tr>
              <th>Month</th>
              <th>Figures</th>
              <th className="num">Basic</th>
              <th className="num">Allowances</th>
              <th className="num">Gross</th>
              <th className="num">Deductions</th>
              <th className="num">Tax</th>
              <th className="num">Net pay</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={9} className="muted">
                  No payslips match these filters.
                </td>
              </tr>
            )}
            {shown.map((payslip) => {
              const b = slipBreakdown(payslip);
              const cur = payslip.currency;
              return (
                <tr key={payslip.id}>
                  <td>
                    <Link to={`/payslips/${payslip.id}`}>{monthTitle(payslip.month)}</Link>
                    {payslip.finalSettlement && <span className="pill pill-mandatory"> Final settlement</span>}
                    {!payslip.finalSettlement && payslip.paidDays != null && (
                      <span className="muted"> · {payslip.paidDays} of {payslip.totalDays} days</span>
                    )}
                  </td>
                  <td>
                    <SlipTag status={slipStatus(payslip)} />
                  </td>
                  <td className="num">{money(b.basic, cur)}</td>
                  <td className="num">
                    {money(b.allowances, cur)}
                    {b.other > 0 && <div className="muted">+ {money(b.other, cur)} one-off</div>}
                  </td>
                  <td className="num">{money(b.gross, cur)}</td>
                  <td className="num">{money(b.deductions, cur)}</td>
                  <td className="num">{money(b.tax, cur)}</td>
                  <td className="num">
                    <strong>{money(b.net, cur)}</strong>
                  </td>
                  <td className="actions">
                    <button className="btn-ghost btn-tiny" type="button" onClick={() => navigate(`/payslips/${payslip.id}`)}>
                      View
                    </button>
                    <ActionButton
                      className="btn-ghost btn-tiny"
                      busyLabel="Preparing…"
                      doneLabel="Downloaded"
                      onAction={() => downloadPayslip(payslip, employee, regime)}
                      success={`${monthTitle(payslip.month)} payslip downloaded (PDF).`}
                      toastError
                    >
                      Download PDF
                    </ActionButton>
                  </td>
                </tr>
              );
            })}
          </tbody>
          {shown.length > 1 && (
            <tfoot>
              <tr>
                <th colSpan={4}>Total · {shown.length} months</th>
                <th className="num">{money(totals.gross, c)}</th>
                <th className="num">{money(totals.deductions, c)}</th>
                <th className="num">{money(totals.tax, c)}</th>
                <th className="num">{money(totals.net, c)}</th>
                <th></th>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </Card>
  );
}

/** Pay record changes (Compensation) and month-on-month pay from the payslips. */
function SalaryHistoryCard({ slips, employeeId }: { slips: PayslipView[]; employeeId: string }) {
  const reward = useSyncExternalStore(subscribeReward, getRewardState, getRewardState);
  const revisions = reward.history.filter((h) => h.employeeId === employeeId).sort((a, b) => b.effective.localeCompare(a.effective));
  const base = annualBaseFor(employeeId);
  const ordered = [...slips].sort((a, b) => a.month.localeCompare(b.month));
  return (
    <Card title="Salary history">
      {revisions.length > 0 ? (
        <div className="doc-table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Effective</th>
                <th>Change</th>
                <th>Grade</th>
                <th className="num">Annual base</th>
              </tr>
            </thead>
            <tbody>
              {revisions.map((r) => (
                <tr key={r.id}>
                  <td>{formatShortDate(r.effective)}</td>
                  <td>{r.event}</td>
                  <td>{r.grade}</td>
                  <td className="num">
                    {r.base} {r.currency}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted" style={{ marginTop: 0 }}>
          {base ? `Current annual base on your pay record: ${money(base.amount, base.currency)}.` : "Payslips use your country's standard package for your role."}{" "}
          <Link to="/compensation">Compensation</Link>
        </p>
      )}
      <div className="doc-table-wrap scroll-x" style={{ marginTop: 12 }}>
        <table className="data">
          <thead>
            <tr>
              <th>Month</th>
              <th className="num">Gross</th>
              <th className="num">Net</th>
              <th className="num">Change in gross</th>
            </tr>
          </thead>
          <tbody>
            {ordered
              .map((s, i) => {
                const prev = ordered[i - 1];
                const diff = prev ? s.gross - prev.gross : 0;
                return (
                  <tr key={s.id}>
                    <td>
                      {monthTitle(s.month)} <SlipTag status={slipStatus(s)} />
                    </td>
                    <td className="num">{money(s.gross, s.currency)}</td>
                    <td className="num">{money(s.net, s.currency)}</td>
                    <td className="num">{prev && diff !== 0 ? `${diff > 0 ? "+" : "−"}${money(Math.abs(diff), s.currency)}` : "—"}</td>
                  </tr>
                );
              })
              .reverse()}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function AnnualSummaryCard({ slips }: { slips: PayslipView[] }) {
  const rows = new Map<string, { months: number; final: number; gross: number; deductions: number; tax: number; net: number; employer: number; currency?: string }>();
  for (const s of slips) {
    const y = taxYearOf(s);
    const b = slipBreakdown(s);
    const r = rows.get(y) ?? { months: 0, final: 0, gross: 0, deductions: 0, tax: 0, net: 0, employer: 0, currency: s.currency };
    r.months += 1;
    r.final += slipStatus(s) === "final" ? 1 : 0;
    r.gross += b.gross;
    r.deductions += b.deductions;
    r.tax += b.tax;
    r.net += b.net;
    r.employer += b.employer;
    rows.set(y, r);
  }
  return (
    <Card title="Annual earnings summary">
      <div className="doc-table-wrap scroll-x">
        <table className="data">
          <thead>
            <tr>
              <th>Tax year</th>
              <th>Months</th>
              <th className="num">Gross</th>
              <th className="num">Deductions</th>
              <th className="num">Tax</th>
              <th className="num">Net</th>
              <th className="num">Employer contributions</th>
            </tr>
          </thead>
          <tbody>
            {[...rows].map(([y, r]) => (
              <tr key={y}>
                <td>{y}</td>
                <td>
                  {r.months} · {r.final} final{r.months - r.final ? `, ${r.months - r.final} estimated` : ""}
                </td>
                <td className="num">{money(r.gross, r.currency)}</td>
                <td className="num">{money(r.deductions, r.currency)}</td>
                <td className="num">{money(r.tax, r.currency)}</td>
                <td className="num">{money(r.net, r.currency)}</td>
                <td className="num">{money(r.employer, r.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** Each deduction line month by month (statutory contributions, tax, recoveries). */
function MonthlyDeductionsCard({ slips }: { slips: PayslipView[] }) {
  const months = [...slips].sort((a, b) => a.month.localeCompare(b.month)).slice(-6);
  const names = [...new Set(months.flatMap((s) => s.deductions.map((d) => d.name)))];
  return (
    <Card title={`Monthly deductions · last ${months.length} months`}>
      <div className="doc-table-wrap scroll-x">
        <table className="data">
          <thead>
            <tr>
              <th>Deduction</th>
              {months.map((s) => (
                <th key={s.id} className="num">
                  {parseISODate(`${s.month}-01`).toLocaleDateString("en-GB", { month: "short", year: "2-digit" })}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {names.map((n) => (
              <tr key={n}>
                <td>{n}</td>
                {months.map((s) => (
                  <td key={s.id} className="num">
                    {money(s.deductions.find((d) => d.name === n)?.amount ?? 0, s.currency)}
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <th>Total</th>
              {months.map((s) => (
                <th key={s.id} className="num">
                  {money(s.deductionTotal, s.currency)}
                </th>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const STATUTORY_NOTES: Record<string, string> = {
  "Provident Fund": "12% of basic to your EPF account (EPF Act)",
  "Professional Tax": "State professional tax",
  TDS: "Income tax deducted at source",
  "Employer PF": "Company's 12% of basic",
  ESI: "Employees' State Insurance",
};

function StatutoryCard({ latest, countryCode }: { latest: PayslipView | undefined; countryCode: Employee["countryCode"] }) {
  const detail = latest ? asDetailView(latest) : null;
  const rules = payRulesFor(countryCode);
  if (!latest) return null;
  return (
    <Card title="Statutory deductions">
      <p className="muted" style={{ marginTop: 0 }}>
        {rules.incomeTaxName ? `Income tax: ${rules.incomeTaxName}.` : "No personal income tax."} From your {monthTitle(latest.month)} payslip.
      </p>
      <div className="doc-table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Item</th>
              <th>Paid by</th>
              <th className="num">This month</th>
            </tr>
          </thead>
          <tbody>
            {latest.deductions.map((d) => (
              <tr key={`d-${d.name}`}>
                <td>
                  {d.name}
                  {STATUTORY_NOTES[d.name] && <div className="muted">{STATUTORY_NOTES[d.name]}</div>}
                </td>
                <td>You</td>
                <td className="num">{money(d.amount, latest.currency)}</td>
              </tr>
            ))}
            {detail?.employerContributions.map((d) => (
              <tr key={`e-${d.name}`}>
                <td>
                  {d.name}
                  {STATUTORY_NOTES[d.name] && <div className="muted">{STATUTORY_NOTES[d.name]}</div>}
                </td>
                <td>Company</td>
                <td className="num">{money(d.amount, latest.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** Paydays this tax year and which months are final, estimated or still to come. */
function PayrollCalendarCard({ slips, employee }: { slips: PayslipView[]; employee: Employee }) {
  const rules = payRulesFor(employee.countryCode);
  const today = todayISO();
  const start = taxYearStartFor(rules, today);
  const first = new Date(start, rules.taxYearStart.month - 1, 1);
  const rows = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(first.getFullYear(), first.getMonth() + i, 1);
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const slip = slips.find((s) => s.month === month);
    const payday = paydayFor(month, employee.countryCode);
    const state = slip ? (slipStatus(slip) === "final" ? "Paid · final" : "Estimated") : month === today.slice(0, 7) ? "In progress" : month < today.slice(0, 7) ? "Not on payroll" : "Upcoming";
    return { month, payday, state, slip };
  });
  return (
    <Card title={`Payroll calendar · ${rules.taxYearLabel(start)}`}>
      <div className="doc-table-wrap scroll-x">
        <table className="data">
          <thead>
            <tr>
              <th>Month</th>
              <th>Payday</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.month}>
                <td>{r.slip ? <Link to={`/payslips/${r.slip.id}`}>{monthTitle(r.month)}</Link> : monthTitle(r.month)}</td>
                <td>{formatShortDate(r.payday)}</td>
                <td>{r.slip ? <SlipTag status={slipStatus(r.slip)} /> : <span className="muted">{r.state}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function DeclarationHistoryCard() {
  const { employee, demoProfile, state } = usePortal();
  useDeclarationsVersion();
  const items = myDeclarations({ id: employee.id, fullName: employee.fullName, role: demoProfile.role, countryCode: employee.countryCode }, state.investmentProofs);
  return (
    <Card title="Declaration history" action={<Link to="/investment">Tax declarations</Link>}>
      {items.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>No tax declarations yet.</p>
      ) : (
        <div className="doc-table-wrap scroll-x">
          <table className="data">
            <thead>
              <tr>
                <th>Tax year</th>
                <th>Section</th>
                <th>Item</th>
                <th className="num">Declared</th>
                <th className="num">Verified</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <tr key={d.id}>
                  <td>{d.financialYear}</td>
                  <td>{d.section}</td>
                  <td>
                    <Link to={`/investment?item=${encodeURIComponent(d.id)}`}>{d.title}</Link>
                  </td>
                  <td className="num">{money(d.amount, d.currency)}</td>
                  <td className="num">{d.verifiedAmount != null ? money(d.verifiedAmount, d.currency) : "—"}</td>
                  <td style={{ textTransform: "capitalize" }}>{d.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function PayslipsPage() {
  const { employee } = usePortal();
  const regime = useTaxRegime(employee.id);
  useDeclarationsVersion();
  const { payslipViews, payInput } = usePortal();
  const [tab, setTab] = useState("payslips");
  const est = estimateMonthSoFar(payInput);
  const lwd = payInput.lastWorkingDay;
  const leaving = Boolean(lwd && lwd >= payInput.today);
  const rules = payRulesFor(employee.countryCode);
  const taxYear = rules.taxYearLabel(taxYearStartFor(rules, todayISO()));
  const finalCount = useMemo(() => payslipViews.filter((s) => slipStatus(s) === "final").length, [payslipViews]);
  return (
    <Page
      title="My payslips"
      subtitle={`${employee.countryName ?? "India"} · ${rules.currency} · tax year ${taxYear} · paid on the last working day`}
    >
      {leaving && lwd && (
        <Card>
          <p style={{ margin: 0 }}>
            <strong>Notice period</strong> · last working day {formatShortDate(lwd)}. Your final payslip covers 1–{dayMonth(lwd)} and
            includes unused leave.
          </p>
        </Card>
      )}
      <Banner
        message={{
          tone: "info",
          text: `${finalCount} of ${payslipViews.length} months are FINAL (from a locked payroll run); the rest are ESTIMATED by TimeZ and may change when payroll locks the month. Only you and HR / payroll can see your pay. Your payslips are also on your profile (Payslips tab).`,
        }}
      />
      <Tabs
        tabs={[
          { id: "payslips", label: "Payslips" },
          { id: "salary", label: "Salary & earnings" },
          { id: "tax", label: "Tax & deductions" },
          { id: "calendar", label: "Payroll calendar" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "payslips" && (
        <>
          {est && <MonthSoFarCard est={est} />}
          <PeriodPicker slips={payslipViews} employee={employee} regime={employee.countryCode === "IN" ? regime : undefined} />
          <SummaryCard slips={payslipViews} employee={employee} regime={employee.countryCode === "IN" ? regime : undefined} />
        </>
      )}
      {tab === "salary" && (
        <>
          <AnnualSummaryCard slips={payslipViews} />
          <SalaryHistoryCard slips={payslipViews} employeeId={employee.id} />
        </>
      )}
      {tab === "tax" && (
        <>
          <TaxYearCard input={payInput} slips={payslipViews} />
          <MonthlyDeductionsCard slips={payslipViews} />
          <StatutoryCard latest={payslipViews[0]} countryCode={employee.countryCode} />
          <DeclarationHistoryCard />
        </>
      )}
      {tab === "calendar" && <PayrollCalendarCard slips={payslipViews} employee={employee} />}
    </Page>
  );
}

/** Header facts for a payslip: entity, period, payment date, country, basis, days, currency. */
export function PayslipHead({ payslip, person }: { payslip: PayslipView; person: Pick<Employee, "legalEntity" | "countryCode" | "countryName"> }) {
  const header = slipHeader(payslip, person);
  const detail = asDetailView(payslip);
  const item = (label: string, value: string) => (
    <div>
      <dt className="muted">{label}</dt>
      <dd style={{ margin: 0 }}>{value}</dd>
    </div>
  );
  return (
    <dl className="pay-head" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "8px 16px", margin: "0 0 16px" }}>
      {item("Legal entity", header.entity)}
      {item("Pay period", header.period)}
      {item("Payment date", formatShortDate(paydayFor(payslip.month, person.countryCode)))}
      {item("Country", header.country)}
      {detail && item("Pay basis", basisText(detail))}
      {payslip.paidDays != null &&
        item("Days paid", `${payslip.paidDays} of ${payslip.totalDays}${payslip.finalSettlement ? " · Final settlement" : ""}`)}
      {payslip.paidDays == null && payslip.finalSettlement && item("Settlement", "Final settlement")}
      {item("Currency", payslip.currency ?? "INR")}
    </dl>
  );
}

export function PayslipDetail() {
  const { id } = useParams();
  const { employee } = usePortal();
  const regime = useTaxRegime(employee.id);
  useDeclarationsVersion();
  const { payslipViews } = usePortal();
  const index = payslipViews.findIndex((item) => item.id === id);
  const payslip = payslipViews[index];
  if (!payslip) {
    return (
      <Page title="Payslip">
        <Card>
          <p className="empty">That payslip is not on this account.</p>
          <Link to="/payslips">Back to payslips</Link>
        </Card>
      </Page>
    );
  }
  const status = slipStatus(payslip);
  const newer = payslipViews[index - 1];
  const older = payslipViews[index + 1];
  return (
    <Page
      title={payslip.label}
      subtitle={`${employee.fullName} · ${employee.employeeCode}${employee.designation ? ` · ${employee.designation}` : ""}`}
      action={
        <span className="form-actions no-print">
          <ActionButton
            className="btn-ghost"
            busyLabel="Preparing…"
            doneLabel="Downloaded"
            onAction={() => downloadPayslip(payslip, employee, employee.countryCode === "IN" ? regime : undefined)}
            success="Payslip downloaded (PDF)."
            toastError
          >
            Download PDF
          </ActionButton>
          <button className="btn" type="button" onClick={() => window.print()}>
            Print
          </button>
        </span>
      }
    >
      <Card className="pay-sheet">
        <div className="slip-banner">
          <SlipTag status={status} />
          <span>
            {status === "final"
              ? "Final figures from the locked payroll run for this month."
              : "Estimated by TimeZ from your pay record, tax rules and verified declarations. The final payslip comes from the locked payroll run and may differ."}
          </span>
        </div>
        <PayslipHead payslip={payslip} person={employee} />
        <PayslipBody payslip={payslip} />
        <nav className="slip-nav" aria-label="Other months">
          {older ? <Link to={`/payslips/${older.id}`}>← {monthTitle(older.month)}</Link> : <span />}
          <Link to="/payslips">All payslips</Link>
          {newer ? <Link to={`/payslips/${newer.id}`}>{monthTitle(newer.month)} →</Link> : <span />}
        </nav>
      </Card>
    </Page>
  );
}
