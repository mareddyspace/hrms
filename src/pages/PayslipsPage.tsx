import { Link, useParams } from "react-router-dom";
import { Card, Page, downloadText } from "../components/ui.tsx";
import { money } from "../countryPay.ts";
import { parseISODate, payslipText } from "../model.ts";
import { usePortal } from "../store.tsx";

function monthTitle(month: string) {
  return parseISODate(`${month}-01`).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

export function PayslipsPage() {
  const { payslipViews, employee } = usePortal();
  return (
    <Page title="My payslips" subtitle="Pay amounts stay private. Open a month to view or download the slip.">
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
