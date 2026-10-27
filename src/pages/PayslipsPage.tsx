import { Link, useParams } from "react-router-dom";
import { Card, Page, downloadText } from "../components/ui.tsx";
import { legalEntityFor, money } from "../countryPay.ts";
import { asDetailView, type PayslipDetailView } from "../data/payslipGenerator.ts";
import { setTaxRegime, useTaxRegime } from "../data/taxRegime.ts";
import { formatShortDate, parseISODate, toISO } from "../model.ts";
import type { Employee, PayLine, PayslipView } from "../model.ts";
import { usePortal } from "../store.tsx";

function monthTitle(month: string) {
  return parseISODate(`${month}-01`).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

/** First and last day of the payslip's month. */
function payPeriod(month: string): { from: string; to: string } {
  const start = parseISODate(`${month}-01`);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
  return { from: toISO(start), to: toISO(end) };
}

function slipHeader(payslip: PayslipView, employee: Pick<Employee, "legalEntity" | "countryCode" | "countryName">) {
  const period = payPeriod(payslip.month);
  return {
    entity: employee.legalEntity ?? legalEntityFor(employee.countryCode),
    country: employee.countryName ?? "India",
    period: `${formatShortDate(period.from)} – ${formatShortDate(period.to)}`,
  };
}

function basisText(slip: PayslipDetailView): string {
  return slip.basis === "hourly" && slip.hourlyRate ? `Hourly · ${money(slip.hourlyRate, slip.currency)}/h` : "Monthly salary";
}

function payslipText(payslip: PayslipView, employee: Employee): string {
  const currency = payslip.currency ?? "INR";
  const header = slipHeader(payslip, employee);
  const detail = asDetailView(payslip);
  const lines = (items: { name: string; amount: number }[]) => items.map((line) => `${line.name}: ${money(line.amount, currency)}`).join("\n");
  return [
    `Payslip — ${payslip.label}`,
    header.entity,
    `Pay period: ${header.period}`,
    `${employee.fullName} (${employee.employeeCode})`,
    `Country: ${header.country}`,
    `Currency: ${currency}`,
    ...(detail ? [`Pay basis: ${basisText(detail)}`] : []),
    ...(payslip.paidDays != null ? [`Days paid: ${payslip.paidDays} of ${payslip.totalDays}${payslip.finalSettlement ? " (final settlement)" : ""}`] : []),
    "",
    "Earnings",
    lines(payslip.earnings.filter((line) => line.amount > 0)),
    `Gross: ${money(payslip.gross, currency)}`,
    "",
    "Deductions",
    payslip.deductions.length ? lines(payslip.deductions) : "None",
    `Total deductions: ${money(payslip.deductionTotal, currency)}`,
    "",
    `Net pay: ${money(payslip.net, currency)}`,
    ...(detail
      ? [
          ...(detail.employerContributions.length ? ["", "Employer contributions", lines(detail.employerContributions)] : []),
          "",
          `Tax computation (${detail.tax.taxYear}) — ${detail.tax.basis}`,
          `Annual gross: ${money(detail.tax.annualGross, currency)}`,
          ...detail.tax.reliefs.map((r) => `Less ${r.name}: ${money(r.amount, currency)}`),
          `Annual taxable income: ${money(detail.tax.annualTaxable, currency)}`,
          `Annual tax: ${money(detail.tax.annualTax, currency)}`,
          `This month: ${money(detail.tax.monthTax, currency)}`,
          "",
          `Year to date (${detail.ytd.taxYear}): gross ${money(detail.ytd.gross, currency)} · tax ${money(detail.ytd.tax, currency)} · net ${money(detail.ytd.net, currency)}`,
        ]
      : []),
  ].join("\n");
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
        </section>
      </div>
      <div className="pay-net">
        <span>Net pay</span>
        <span>{money(payslip.net, currency)}</span>
      </div>
      {detail && detail.employerContributions.length > 0 && (
        <p className="muted" style={{ margin: "12px 0 0" }}>
          Employer pays on top: {detail.employerContributions.map((l) => `${l.name} ${money(l.amount, currency)}`).join(" · ")}
        </p>
      )}
      {detail && (
        <details style={{ marginTop: 16 }}>
          <summary>
            Tax computation · {detail.tax.taxYear}
          </summary>
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
        <div className="pay-head" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "8px 16px", marginTop: 16 }}>
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

function RegimePicker({ employeeId }: { employeeId: string }) {
  const regime = useTaxRegime(employeeId);
  return (
    <label className="field" style={{ maxWidth: 280 }}>
      <span>Tax regime</span>
      <select value={regime} onChange={(event) => setTaxRegime(employeeId, event.target.value === "old" ? "old" : "new")}>
        <option value="new">New regime (default)</option>
        <option value="old">Old regime — uses verified declarations</option>
      </select>
    </label>
  );
}

export function PayslipsPage() {
  const { employee } = usePortal();
  useTaxRegime(employee.id);
  const { payslipViews } = usePortal();
  return (
    <Page title="My payslips">
      {employee.countryCode === "IN" && (
        <Card>
          <RegimePicker employeeId={employee.id} />
        </Card>
      )}
      <Card>
        <div className="doc-table-wrap">
          <table className="data doc-table pay-list">
            <thead>
              <tr>
                <th>Month</th>
                <th>Net pay</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {payslipViews.map((payslip) => (
                <tr key={payslip.id}>
                  <td>
                    <Link to={`/payslips/${payslip.id}`}>{monthTitle(payslip.month)}</Link>
                    {payslip.finalSettlement && <span className="pill pill-mandatory"> Final settlement</span>}
                    {!payslip.finalSettlement && payslip.paidDays != null && (
                      <span className="muted"> · {payslip.paidDays} of {payslip.totalDays} days</span>
                    )}
                  </td>
                  <td>{money(payslip.net, payslip.currency)}</td>
                  <td className="actions">
                    <Link className="btn-ghost btn-tiny" to={`/payslips/${payslip.id}`}>
                      View
                    </Link>
                    <button
                      className="btn-ghost btn-tiny"
                      type="button"
                      onClick={() => downloadText(`${monthTitle(payslip.month)} payslip.txt`, payslipText(payslip, employee))}
                    >
                      Download
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </Page>
  );
}

/** Header facts for a payslip: entity, period, country, basis, days, currency. */
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
  useTaxRegime(employee.id);
  const { payslipViews } = usePortal();
  const payslip = payslipViews.find((item) => item.id === id);
  if (!payslip) {
    return (
      <Page title="Payslip">
        <Card>
          <p className="empty">That payslip is not on this account.</p>
        </Card>
      </Page>
    );
  }
  return (
    <Page
      title={payslip.label}
      subtitle={`${employee.fullName} · ${employee.employeeCode}`}
      action={
        <span className="form-actions no-print">
          <button className="btn-ghost" type="button" onClick={() => downloadText(`${payslip.label}.txt`, payslipText(payslip, employee))}>
            Download
          </button>
          <button className="btn" type="button" onClick={() => window.print()}>
            Print
          </button>
        </span>
      }
    >
      <Card className="pay-sheet">
        <PayslipHead payslip={payslip} person={employee} />
        <PayslipBody payslip={payslip} />
      </Card>
    </Page>
  );
}
