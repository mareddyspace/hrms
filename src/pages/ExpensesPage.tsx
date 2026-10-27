import { useState } from "react";
import type { FormEvent } from "react";
import { Banner, Card, Field, Page, StatusPill } from "../components/ui.tsx";
import { claimLimitsFor, itemCurrency, money, moneyTotals, payRulesFor, receiptThresholdFor } from "../countryPay.ts";
import { addDaysISO, EXPENSE_CATEGORIES, EXPENSE_CLAIM_WINDOW_DAYS, todayISO } from "../model.ts";
import { usePortal } from "../store.tsx";
import { TEMPLATE_BLANKS_ERROR, hasTemplateBlanks, useTemplatedText } from "../data/requestTemplates.ts";

export function ExpensesPage() {
  const { state, employee, currentProjects, addExpense, hasApprover } = usePortal();
  const currency = payRulesFor(employee.countryCode).currency;
  const receiptAbove = receiptThresholdFor(employee.countryCode);
  const { maxClaim } = claimLimitsFor(employee.countryCode);
  const [receipt, setReceipt] = useState("");
  const [fileKey, setFileKey] = useState(0);
  const [date, setDate] = useState("");
  const [category, setCategory] = useState<string>(EXPENSE_CATEGORIES[0]);
  const [amount, setAmount] = useState("");
  const {
    value: description,
    setValue: setDescription,
    ref: descriptionRef,
    fill: fillDescription,
    fillIfEmpty: fillDescriptionIfEmpty,
    reset: resetDescription,
  } = useTemplatedText();
  const [projectId, setProjectId] = useState(currentProjects[0]?.id ?? "");
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const mine = state.expenses.filter((expense) => expense.employeeId === employee.id);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (hasTemplateBlanks(description)) {
      setMessage({ tone: "err", text: TEMPLATE_BLANKS_ERROR });
      return;
    }
    const value = Number(amount);
    if (value > receiptAbove && !receipt) {
      setMessage({ tone: "err", text: `Attach a receipt for claims over ${money(receiptAbove, currency)}.` });
      return;
    }
    // Expense records have no attachment field, so the receipt file name is kept with the description.
    const text = receipt && description.trim() ? `${description.trim()}\nReceipt: ${receipt}` : description;
    const error = addExpense({
      date,
      category,
      amount: value,
      description: text,
      projectId,
    });
    setMessage(
      error
        ? { tone: "err", text: error }
        : { tone: "ok", text: hasApprover ? "Expense submitted for approval." : "Expense approved automatically." },
    );
    if (!error) {
      setAmount("");
      resetDescription();
      setDate("");
      setReceipt("");
      setFileKey((key) => key + 1);
    }
  }

  return (
    <Page title="Reimbursements">
      <section className="summary-row" aria-label="Claim summary">
        <div className="summary">
          <span>Claims</span>
          <strong>{mine.length}</strong>
        </div>
        <div className="summary sky">
          <span>Waiting</span>
          <strong>{mine.filter((item) => item.status === "submitted").length}</strong>
        </div>
        <div className="summary lilac">
          <span>Amount claimed</span>
          <strong className="summary-text">{moneyTotals(mine.map((item) => ({ amount: item.amount, currency: itemCurrency(item) })))}</strong>
        </div>
      </section>
      <div className="split">
        <Card title="New claim">
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
                <select
                  value={category}
                  onChange={(event) => {
                    setCategory(event.target.value);
                    fillDescription("expense", event.target.value);
                  }}
                >
                  {EXPENSE_CATEGORIES.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </Field>
              <Field label={`Amount (${currency}, up to ${money(maxClaim, currency)})`}>
                <input type="number" min={1} value={amount} onChange={(event) => setAmount(event.target.value)} />
              </Field>
              <Field label={`Receipt (required over ${money(receiptAbove, currency)})`}>
                <input
                  key={fileKey}
                  type="file"
                  accept="image/*,application/pdf"
                  onChange={(event) => setReceipt(event.target.files?.[0]?.name ?? "")}
                />
              </Field>
              <Field label="Project">
                <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                  {currentProjects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Description" wide>
                <textarea
                  ref={descriptionRef}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  onFocus={() => fillDescriptionIfEmpty("expense", category)}
                />
              </Field>
            </div>
            <div className="form-actions">
              <button className="btn" type="submit">
                Submit claim
              </button>
            </div>
            <Banner message={message} />
          </form>
        </Card>
        <Card title="My claims">
          {mine.length === 0 ? (
            <p className="empty">No expenses yet.</p>
          ) : (
            <div className="doc-table-wrap">
              <table className="data doc-table pay-list expense-claims">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Category</th>
                    <th className="num">Amount</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {mine.map((expense) => (
                    <tr key={expense.id}>
                      <td>{expense.date}</td>
                      <td>
                        {expense.category}
                        <div className="muted" style={{ whiteSpace: "pre-line" }}>{expense.description}</div>
                      </td>
                      <td className="num">{money(expense.amount, itemCurrency(expense))}</td>
                      <td>
                        <StatusPill status={expense.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </Page>
  );
}
