import { useState } from "react";
import type { FormEvent } from "react";
import { Banner, Card, Field, Page, StatusPill } from "../components/ui.tsx";
import { addDaysISO, EXPENSE_CLAIM_WINDOW_DAYS, inr, todayISO } from "../model.ts";

/** Current and next Indian financial year (April–March), e.g. 2026-27 and 2027-28. */
function financialYearOptions(): string[] {
  const [year, month] = todayISO().split("-").map(Number);
  const start = month >= 4 ? year : year - 1;
  return [start, start + 1].map((y) => `${y}-${String((y + 1) % 100).padStart(2, "0")}`);
}
import { usePortal } from "../store.tsx";

const REIMBURSE_CATEGORIES = ["Internet", "Books", "Medical", "Conveyance", "Other"] as const;
const POI_SECTIONS = ["80C", "80D", "80E", "HRA", "Other"] as const;

export function ReimbursementPage() {
  const { state, employee, addReimbursement } = usePortal();
  const mine = state.reimbursements.filter((item) => item.employeeId === employee.id);
  const [date, setDate] = useState("");
  const [category, setCategory] = useState<string>(REIMBURSE_CATEGORIES[0]);
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const error = addReimbursement({
      date,
      category,
      amount: Number(amount),
      description,
    });
    setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Reimbursement submitted for payroll review." });
    if (!error) {
      setDate("");
      setAmount("");
      setDescription("");
    }
  }

  return (
    <Page title="Reimbursement" subtitle="Claim non-project reimbursements. Payslip receipts stay under Expenses.">
      <div className="split">
        <Card title="New reimbursement">
          <form onSubmit={onSubmit}>
            <div className="form-grid">
              <Field label="Date">
                <input
                  type="date"
                  min={addDaysISO(todayISO(), -EXPENSE_CLAIM_WINDOW_DAYS)}
                  max={todayISO()}
                  value={date}
                  onChange={(event) => setDate(event.target.value)}
                  required
                />
              </Field>
              <Field label="Category">
                <select value={category} onChange={(event) => setCategory(event.target.value)}>
                  {REIMBURSE_CATEGORIES.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </Field>
              <Field label="Amount (INR)">
                <input type="number" min={1} value={amount} onChange={(event) => setAmount(event.target.value)} />
              </Field>
              <Field label="Description" wide>
                <textarea value={description} onChange={(event) => setDescription(event.target.value)} />
              </Field>
            </div>
            <div className="form-actions">
              <button className="btn" type="submit">
                Submit
              </button>
            </div>
            <Banner message={message} />
          </form>
        </Card>
        <Card title="My reimbursements">
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Category</th>
                  <th className="num">Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {mine.map((item) => (
                  <tr key={item.id}>
                    <td>{item.date}</td>
                    <td>
                      <strong>{item.category}</strong>
                      <div className="muted">{item.description}</div>
                    </td>
                    <td className="num">{inr(item.amount)}</td>
                    <td>
                      <StatusPill status={item.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </Page>
  );
}

export function InvestmentProofPage() {
  const { state, employee, addInvestmentProof } = usePortal();
  const mine = state.investmentProofs.filter((item) => item.employeeId === employee.id);
  const [section, setSection] = useState<string>(POI_SECTIONS[0]);
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [financialYear, setFinancialYear] = useState(() => financialYearOptions()[0]);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const error = addInvestmentProof({
      section,
      title,
      amount: Number(amount),
      financialYear,
    });
    setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Proof of investment submitted." });
    if (!error) {
      setTitle("");
      setAmount("");
    }
  }

  return (
    <Page title="Proof of investment" subtitle="Upload tax-saving proofs for the selected financial year. Finance verifies them for payroll.">
      <div className="split">
        <Card title="Submit proof">
          <form onSubmit={onSubmit}>
            <div className="form-grid">
              <Field label="Section">
                <select value={section} onChange={(event) => setSection(event.target.value)}>
                  {POI_SECTIONS.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </Field>
              <Field label="Financial year">
                <select value={financialYear} onChange={(event) => setFinancialYear(event.target.value)}>
                  {financialYearOptions().map((fy) => (
                    <option key={fy} value={fy}>
                      {fy}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Title" wide>
                <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. ELSS mutual fund" />
              </Field>
              <Field label="Amount (INR)">
                <input type="number" min={1} value={amount} onChange={(event) => setAmount(event.target.value)} />
              </Field>
            </div>
            <div className="form-actions">
              <button className="btn" type="submit">
                Submit proof
              </button>
            </div>
            <Banner message={message} />
          </form>
        </Card>
        <Card title="Submitted proofs">
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Section</th>
                  <th>Title</th>
                  <th className="num">Amount</th>
                  <th>FY</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {mine.map((item) => (
                  <tr key={item.id}>
                    <td>{item.section}</td>
                    <td>{item.title}</td>
                    <td className="num">{inr(item.amount)}</td>
                    <td>{item.financialYear}</td>
                    <td>
                      <StatusPill status={item.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </Page>
  );
}
