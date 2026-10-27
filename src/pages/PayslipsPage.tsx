import { Link, useParams } from "react-router-dom";
import { Card, Page, downloadText } from "../components/ui.tsx";
import { legalEntityFor, money } from "../countryPay.ts";
import { formatShortDate, parseISODate, toISO } from "../model.ts";
import type { Employee, PayslipView } from "../model.ts";
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

function slipHeader(payslip: PayslipView, employee: Employee) {
  const period = payPeriod(payslip.month);
  return {
    entity: employee.legalEntity ?? legalEntityFor(employee.countryCode),
    country: employee.countryName ?? "India",
    period: `${formatShortDate(period.from)} – ${formatShortDate(period.to)}`,
  };
}

function payslipText(payslip: PayslipView, employee: Employee): string {
  const currency = payslip.currency ?? "INR";
  const header = slipHeader(payslip, employee);
  const lines = (items: { name: string; amount: number }[]) => items.map((line) => `${line.name}: ${money(line.amount, currency)}`).join("\n");
  return [
    `Payslip — ${payslip.label}`,
    header.entity,
    `Pay period: ${header.period}`,
    `${employee.fullName} (${employee.employeeCode})`,
    `Country: ${header.country}`,
    `Currency: ${currency}`,
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
  ].join("\n");
}

export function PayslipsPage() {
  const { payslipViews, employee } = usePortal();
  return (
    <Page title="My payslips">
      <Card>
        <div className="doc-table-wrap">
          <table className="data doc-table pay-list">
            <thead>
              <tr>
                <th>Month</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {payslipViews.map((payslip) => (
                <tr key={payslip.id}>
                  <td>
                    <Link to={`/payslips/${payslip.id}`}>{monthTitle(payslip.month)}</Link>
                  </td>
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

export function PayslipDetail() {
  const { id } = useParams();
  const { payslipViews, employee } = usePortal();
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
        {(() => {
          const header = slipHeader(payslip, employee);
          return (
            <dl className="pay-head" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "8px 16px", margin: "0 0 16px" }}>
              <div>
                <dt className="muted">Legal entity</dt>
                <dd style={{ margin: 0 }}>{header.entity}</dd>
              </div>
              <div>
                <dt className="muted">Pay period</dt>
                <dd style={{ margin: 0 }}>{header.period}</dd>
              </div>
              <div>
                <dt className="muted">Country</dt>
                <dd style={{ margin: 0 }}>{header.country}</dd>
              </div>
              <div>
                <dt className="muted">Currency</dt>
                <dd style={{ margin: 0 }}>{payslip.currency ?? "INR"}</dd>
              </div>
            </dl>
          );
        })()}
        <div className="pay-lines">
          <section className="pay-col">
            <h2 className="card-title">Earnings</h2>
            <table className="data pay-lines-table">
              <tbody>
                {payslip.earnings
                  .filter((line) => line.amount > 0)
                  .map((line) => (
                    <tr key={line.name}>
                      <td>{line.name}</td>
                      <td>{money(line.amount, payslip.currency)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
            <div className="total-row">
              <span>Gross</span>
              <span>{money(payslip.gross, payslip.currency)}</span>
            </div>
          </section>
          <section className="pay-col">
            <h2 className="card-title">Deductions</h2>
            <table className="data pay-lines-table">
              <tbody>
                {payslip.deductions.length === 0 && (
                  <tr>
                    <td colSpan={2} className="muted">
                      No income tax or deductions
                    </td>
                  </tr>
                )}
                {payslip.deductions.map((line) => (
                  <tr key={line.name}>
                    <td>{line.name}</td>
                    <td>{money(line.amount, payslip.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="total-row">
              <span>Total deductions</span>
              <span>{money(payslip.deductionTotal, payslip.currency)}</span>
            </div>
          </section>
        </div>
        <div className="pay-net">
          <span>Net pay</span>
          <span>{money(payslip.net, payslip.currency)}</span>
        </div>
      </Card>
    </Page>
  );
}
