import { useState } from "react";
import type { FormEvent } from "react";
import { Banner, Card, Field, Page, StatusPill } from "../components/ui.tsx";
import { addDaysISO, EXPENSE_CATEGORIES, EXPENSE_CLAIM_WINDOW_DAYS, inr, todayISO } from "../model.ts";
import { usePortal } from "../store.tsx";

export function ExpensesPage() {
  const { state, employee, currentProjects, addExpense } = usePortal();
  const [date, setDate] = useState("");
  const [category, setCategory] = useState<string>(EXPENSE_CATEGORIES[0]);
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState(currentProjects[0]?.id ?? "");
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const mine = state.expenses.filter((expense) => expense.employeeId === employee.id);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const error = addExpense({
      date,
      category,
      amount: Number(amount),
      description,
      projectId,
    });
    setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Expense submitted." });
    if (!error) {
      setAmount("");
      setDescription("");
      setDate("");
    }
  }

  return (
    <Page title="Claim expenses" subtitle="Submit a claim against a project. It stays here until it is approved.">
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
          <strong className="summary-text">{inr(mine.reduce((total, item) => total + item.amount, 0))}</strong>
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
                <select value={category} onChange={(event) => setCategory(event.target.value)}>
                  {EXPENSE_CATEGORIES.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </Field>
              <Field label="Amount (INR)">
                <input type="number" min={1} value={amount} onChange={(event) => setAmount(event.target.value)} />
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
                <textarea value={description} onChange={(event) => setDescription(event.target.value)} />
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
                      <div className="muted">{expense.description}</div>
                    </td>
                    <td className="num">{inr(expense.amount)}</td>
                    <td>
                      <StatusPill status={expense.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </Page>
  );
}
