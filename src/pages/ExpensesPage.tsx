import { useEffect, useState, useSyncExternalStore } from "react";
import type { FormEvent } from "react";
import { Banner, Card, Field, Page, StatusBadge } from "../components/ui.tsx";
import { StepTimeline } from "../components/StepTimeline.tsx";
import { claimLimitsFor, itemCurrency, money, moneyTotals, payRulesFor, receiptThresholdFor } from "../countryPay.ts";
import { addDaysISO, EXPENSE_CATEGORIES, EXPENSE_CLAIM_WINDOW_DAYS, formatShortDate, todayISO } from "../model.ts";
import type { Expense, ExpenseReceipt } from "../model.ts";
import { usePortal } from "../store.tsx";
import { TEMPLATE_BLANKS_ERROR, hasTemplateBlanks, useTemplatedText } from "../data/requestTemplates.ts";
import { openReceipt, RECEIPT_MAX_BYTES, receiptFileError, saveReceipt } from "../data/receiptStore.ts";
import { stepText } from "../data/expenseFlow.ts";
import { tripLabel, useTravelRequests } from "../data/travelStore.ts";
import { listPeople, subscribePeople } from "../data/peopleLocal.ts";
import { API_ENABLED } from "../api/client.ts";
import { loadExpenseRules, type ExpenseRulesOut } from "../api/syncTimeExpenses.ts";

const STATUS_LABEL: Record<Expense["status"], string> = {
  submitted: "Pending",
  approved: "Approved",
  rejected: "Declined",
  withdrawn: "Withdrawn",
  paid: "Paid",
};
const STATUS_TONE: Record<Expense["status"], "ok" | "warn" | "danger" | "neutral" | "info"> = {
  submitted: "warn",
  approved: "ok",
  rejected: "danger",
  withdrawn: "neutral",
  paid: "info",
};

function ReceiptLinks({ receipt, onError }: { receipt?: ExpenseReceipt; onError: (text: string) => void }) {
  if (!receipt) return null;
  const run = async (download: boolean) => {
    const error = await openReceipt(receipt, download);
    if (error) onError(error);
  };
  return (
    <span className="muted" style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      Receipt: {receipt.name}
      <button type="button" className="btn-ghost btn-tiny" onClick={() => run(false)}>
        View
      </button>
      <button type="button" className="btn-ghost btn-tiny" onClick={() => run(true)}>
        Download
      </button>
    </span>
  );
}

export function ExpensesPage() {
  const portal = usePortal();
  const { state, employee, currentProjects, addExpense, hasApprover, demoAccounts } = portal;
  const people = useSyncExternalStore(subscribePeople, listPeople, listPeople);
  const trips = useTravelRequests();
  const currency = payRulesFor(employee.countryCode).currency;
  // Backend mode: the server's claim rules (receipt threshold, limits) for this person's country.
  const [apiRules, setApiRules] = useState<ExpenseRulesOut | null>(null);
  useEffect(() => {
    if (!API_ENABLED) return;
    let stale = false;
    loadExpenseRules()
      .then((rules) => {
        if (!stale) setApiRules(rules);
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [employee.id]);
  const receiptAbove = apiRules?.receipt_required_over ?? receiptThresholdFor(employee.countryCode);
  const maxClaim = apiRules?.max_claim ?? claimLimitsFor(employee.countryCode).maxClaim;
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [date, setDate] = useState("");
  const [category, setCategory] = useState<string>(EXPENSE_CATEGORIES[0]);
  const [amount, setAmount] = useState("");
  const [tripId, setTripId] = useState("");
  const [busy, setBusy] = useState(false);
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
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [payment, setPayment] = useState<Record<string, { on: string; ref: string }>>({});
  const [openId, setOpenId] = useState<string | null>(null);

  const mine = state.expenses.filter((expense) => expense.employeeId === employee.id);
  const myTrips = trips.filter((t) => t.employeeId === employee.id && t.status === "approved");
  const waiting = state.expenses.filter((expense) => portal.canDecideExpense(expense));
  const toPay = state.expenses.filter((expense) => portal.canPayExpense(expense));
  const showErr = (text: string) => setMessage({ tone: "err", text });

  const nameOf = (id: string) =>
    demoAccounts.find((a) => a.id === id)?.fullName ?? people.find((p) => p.id === id)?.fullName ?? id;
  const tripOf = (id?: string) => (id ? trips.find((t) => t.id === id) : undefined);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (hasTemplateBlanks(description)) {
      showErr(TEMPLATE_BLANKS_ERROR);
      return;
    }
    const value = Number(amount);
    if (value > receiptAbove && !receiptFile) {
      showErr(`Attach a receipt for claims over ${money(receiptAbove, currency)}.`);
      return;
    }
    setBusy(true);
    let receipt: ExpenseReceipt | undefined;
    try {
      if (receiptFile) receipt = await saveReceipt(receiptFile);
    } catch (error) {
      setBusy(false);
      showErr(error instanceof Error ? error.message : "Couldn't save the receipt.");
      return;
    }
    const error = await addExpense({
      date,
      category,
      amount: value,
      description,
      projectId,
      ...(receipt ? { receipt } : {}),
      ...(tripId ? { tripId } : {}),
    });
    setBusy(false);
    setMessage(
      error
        ? { tone: "err", text: error }
        : { tone: "ok", text: hasApprover ? "Expense submitted for approval." : "Expense submitted." },
    );
    if (!error) {
      setAmount("");
      resetDescription();
      setDate("");
      setTripId("");
      setReceiptFile(null);
      setFileKey((key) => key + 1);
    }
  }

  async function decide(expense: Expense, status: "approved" | "rejected") {
    const error = await portal.setExpenseStatus(expense.id, status, notes[expense.id]);
    setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: status === "approved" ? "Claim approved." : "Claim declined." });
    if (!error) setNotes((prev) => ({ ...prev, [expense.id]: "" }));
  }

  async function pay(expense: Expense) {
    const entry = payment[expense.id] ?? { on: todayISO(), ref: "" };
    const error = await portal.markExpensePaid(expense.id, entry.on, entry.ref);
    setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Claim marked paid." });
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
        <div className="summary">
          <span>Paid</span>
          <strong>{mine.filter((item) => item.status === "paid").length}</strong>
        </div>
        <div className="summary lilac">
          <span>Amount claimed</span>
          <strong className="summary-text">{moneyTotals(mine.map((item) => ({ amount: item.amount, currency: itemCurrency(item) })))}</strong>
        </div>
      </section>
      <Banner message={message} />

      {waiting.length > 0 && (
        <Card title={`Waiting on me (${waiting.length})`}>
          <ul className="approval-list">
            {waiting.map((expense) => {
              const trip = tripOf(expense.tripId);
              return (
                <li key={expense.id} className="approval-item">
                  <div className="row-between">
                    <strong>{nameOf(expense.employeeId)}</strong>
                    <span className="pill">{stepText(expense) || "Approval"}</span>
                  </div>
                  <span>
                    {expense.category} · {money(expense.amount, itemCurrency(expense))} · {formatShortDate(expense.date)}
                  </span>
                  {expense.description && <span className="muted" style={{ whiteSpace: "pre-line" }}>{expense.description}</span>}
                  {trip && <span className="muted">Trip: {tripLabel(trip)}</span>}
                  {(expense.stepDecisions ?? []).map((d, i) => (
                    <span key={i} className="muted">
                      {d.label}: {d.byName} · {formatShortDate(d.on)}
                      {d.note ? ` · “${d.note}”` : ""}
                    </span>
                  ))}
                  <ReceiptLinks receipt={expense.receipt} onError={showErr} />
                  <div className="approval-actions">
                    <input
                      value={notes[expense.id] ?? ""}
                      onChange={(e) => setNotes((prev) => ({ ...prev, [expense.id]: e.target.value }))}
                      placeholder="Note (optional)"
                      aria-label={`Note for ${nameOf(expense.employeeId)}`}
                    />
                    <button type="button" className="btn btn-tiny" onClick={() => decide(expense, "approved")}>
                      Approve
                    </button>
                    <button type="button" className="btn-ghost btn-tiny" onClick={() => decide(expense, "rejected")}>
                      Decline
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {toPay.length > 0 && (
        <Card title={`Ready to pay (${toPay.length})`}>
          <ul className="approval-list">
            {toPay.map((expense) => {
              const entry = payment[expense.id] ?? { on: todayISO(), ref: "" };
              const set = (patch: Partial<typeof entry>) => setPayment((prev) => ({ ...prev, [expense.id]: { ...entry, ...patch } }));
              return (
                <li key={expense.id} className="approval-item">
                  <div className="row-between">
                    <strong>{nameOf(expense.employeeId)}</strong>
                    <strong>{money(expense.amount, itemCurrency(expense))}</strong>
                  </div>
                  <span>
                    {expense.category} · {formatShortDate(expense.date)}
                    {expense.decidedByName ? ` · approved by ${expense.decidedByName}` : ""}
                    {expense.decidedOn ? ` on ${formatShortDate(expense.decidedOn)}` : ""}
                  </span>
                  <ReceiptLinks receipt={expense.receipt} onError={showErr} />
                  <div className="approval-actions">
                    <input
                      type="date"
                      max={todayISO()}
                      value={entry.on}
                      onChange={(e) => set({ on: e.target.value })}
                      aria-label="Payment date"
                    />
                    <input value={entry.ref} onChange={(e) => set({ ref: e.target.value })} placeholder="Payment reference" aria-label="Payment reference" />
                    <button type="button" className="btn btn-tiny" onClick={() => pay(expense)}>
                      Mark paid
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

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
              <Field label={`Receipt (required over ${money(receiptAbove, currency)}, up to ${RECEIPT_MAX_BYTES / 1024 / 1024} MB)`}>
                <input
                  key={fileKey}
                  type="file"
                  accept="image/*,application/pdf"
                  onChange={(event) => {
                    const file = event.target.files?.[0] ?? null;
                    const error = file ? receiptFileError(file) : null;
                    if (error) {
                      showErr(error);
                      setReceiptFile(null);
                      setFileKey((key) => key + 1);
                      return;
                    }
                    setReceiptFile(file);
                  }}
                />
              </Field>
              {/* Claims in the API have no project; the trip links them instead. */}
              {!API_ENABLED && (
                <Field label="Project">
                  <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                    {currentProjects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label="Trip">
                <select value={tripId} onChange={(event) => setTripId(event.target.value)}>
                  <option value="">No trip</option>
                  {myTrips.map((trip) => (
                    <option key={trip.id} value={trip.id}>
                      {tripLabel(trip)}
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
              <button className="btn" type="submit" disabled={busy}>
                {busy ? "Submitting…" : "Submit claim"}
              </button>
            </div>
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
                  {mine.map((expense) => {
                    const trip = tripOf(expense.tripId);
                    const open = openId === expense.id;
                    return (
                      <tr key={expense.id}>
                        <td>{expense.date}</td>
                        <td>
                          {expense.category}
                          <div className="muted" style={{ whiteSpace: "pre-line" }}>{expense.description}</div>
                          {trip && <div className="muted">Trip: {tripLabel(trip)}</div>}
                          <ReceiptLinks receipt={expense.receipt} onError={showErr} />
                          {open && (
                            <StepTimeline
                              status={expense.status}
                              submittedOn={expense.submittedOn ?? expense.date}
                              steps={expense.steps}
                              currentStep={expense.currentStep}
                              stepDecisions={expense.stepDecisions}
                              decided={expense}
                              paid={{ show: true, on: expense.paidOn, by: expense.paidByName, reference: expense.paymentRef }}
                              nameOf={nameOf}
                            />
                          )}
                        </td>
                        <td className="num">{money(expense.amount, itemCurrency(expense))}</td>
                        <td>
                          <StatusBadge status={STATUS_LABEL[expense.status]} tone={STATUS_TONE[expense.status]} literal />
                          {expense.status === "submitted" && stepText(expense) && <div className="muted">{stepText(expense)}</div>}
                          <div>
                            <button type="button" className="btn-ghost btn-tiny" onClick={() => setOpenId(open ? null : expense.id)}>
                              {open ? "Hide progress" : "Progress"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </Page>
  );
}
