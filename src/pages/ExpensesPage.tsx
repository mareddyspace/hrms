import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ActionButton, Banner, Card, Dialog, EmptyState, Field, Page, StatusBadge, SubmitButton, Tabs, notify, useAction } from "../components/ui.tsx";
import { StepTimeline } from "../components/StepTimeline.tsx";
import { claimLimitsFor, itemCurrency, money, moneyTotals, payRulesFor, receiptThresholdFor } from "../countryPay.ts";
import { addDaysISO, EXPENSE_CLAIM_WINDOW_DAYS, formatShortDate, todayISO } from "../model.ts";
import type { Expense, ExpenseReceipt } from "../model.ts";
import { usePortal } from "../store.tsx";
import { TEMPLATE_BLANKS_ERROR, hasTemplateBlanks, useTemplatedText } from "../data/requestTemplates.ts";
import { openReceipt, RECEIPT_MAX_BYTES, receiptFileError, saveReceipt } from "../data/receiptStore.ts";
import { stepText } from "../data/expenseFlow.ts";
import { tripLabel, useTravelRequests } from "../data/travelStore.ts";
import { listPeople, subscribePeople } from "../data/peopleLocal.ts";
import { API_ENABLED } from "../api/client.ts";
import { apiAddClaimReceipt, claimsMirror, loadExpenseRules, type ExpenseRulesOut } from "../api/syncTimeExpenses.ts";
import { CLAIM_CATEGORIES, CLAIM_CATEGORY_NAMES, categoryOf, cleanDetails, detailLabel, detailsProblem } from "../features/payrequests/expenseCategories.ts";
import { DecideBar } from "../features/payrequests/Tracker.tsx";
import {
  ConfirmButton,
  CsvButton,
  Facts,
  ListFilters,
  RequestThread,
  SummaryTiles,
  applyFilters,
  useListFilters,
  useOpenFromQuery,
} from "../features/payrequests/requestKit.tsx";
import { addComment, loadOpenInfo, recordLocalEvent, subscribeThreads, threadsVersion, type ThreadContext } from "../features/payrequests/threadStore.ts";
import { canPayOut } from "../features/payrequests/rules.ts";
import "../styles/pay-claims.css";

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
const STATUS_FILTERS = Object.values(STATUS_LABEL);
const refOf = (id: string) => id.toUpperCase();

function ReceiptLinks({ receipts, onError }: { receipts: ExpenseReceipt[]; onError: (text: string) => void }) {
  if (!receipts.length) return <span className="muted">No receipt</span>;
  const run = async (r: ExpenseReceipt, download: boolean) => {
    const error = await openReceipt(r, download);
    if (error) onError(error);
  };
  return (
    <ul className="pr-files">
      {receipts.map((r) => (
        <li key={r.id}>
          <span>
            {r.name} <span className="muted">· {Math.max(1, Math.round(r.size / 1024))} KB</span>
          </span>
          <span className="pr-actions">
            <button type="button" className="btn-ghost btn-tiny" onClick={() => run(r, false)}>
              View
            </button>
            <button type="button" className="btn-ghost btn-tiny" onClick={() => run(r, true)}>
              Download
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
}

const receiptsOf = (e: Expense): ExpenseReceipt[] => e.receipts ?? (e.receipt ? [e.receipt] : []);

/** Category fields for the claim form (and the edit form). */
function DetailFields({ category, details, onChange }: { category: string; details: Record<string, string>; onChange: (next: Record<string, string>) => void }) {
  const c = categoryOf(category);
  if (!c.fields.length) return null;
  return (
    <>
      {c.fields.map((f) => (
        <Field key={f.key} label={`${f.label}${f.required ? "" : " (optional)"}`}>
          <input
            type={f.type ?? "text"}
            value={details[f.key] ?? ""}
            placeholder={f.placeholder}
            min={f.type === "number" ? 0 : undefined}
            maxLength={f.type ? undefined : 120}
            required={f.required}
            onChange={(e) => onChange({ ...details, [f.key]: e.target.value })}
          />
        </Field>
      ))}
    </>
  );
}

function ClaimDetail({
  expense,
  onClose,
  setMessage,
  infoOpen,
}: {
  expense: Expense;
  onClose: () => void;
  setMessage: (m: { tone: "ok" | "err" | "warn"; text: string } | null) => void;
  infoOpen: boolean;
}) {
  const portal = usePortal();
  const { employee, demoProfile, demoAccounts } = portal;
  const people = useSyncExternalStore(subscribePeople, listPeople, listPeople);
  const trips = useTravelRequests();
  const nameOf = (id: string) => demoAccounts.find((a) => a.id === id)?.fullName ?? people.find((p) => p.id === id)?.fullName ?? id;
  const trip = expense.tripId ? trips.find((t) => t.id === expense.tripId) : undefined;
  const mine = expense.employeeId === employee.id;
  const canDecide = portal.canDecideExpense(expense);
  const canPay = portal.canPayExpense(expense);
  const canEdit = mine && expense.status === "submitted" && (API_ENABLED ? !!expense.canEdit : !(expense.stepDecisions ?? []).length || infoOpen);
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState({ amount: String(expense.amount), description: expense.description, date: expense.date, details: expense.details ?? {} });
  const [payOn, setPayOn] = useState(todayISO());
  const [payRef, setPayRef] = useState("");
  const [fileKey, setFileKey] = useState(0);
  const editAction = useAction();
  const ctx: ThreadContext = {
    actorId: employee.id,
    actorName: employee.fullName,
    ownerId: expense.employeeId,
    canDecide,
    reviewer: !mine && (canPay || canPayOut(demoProfile.role)),
    label: "expense claim",
    href: `/expenses?open=${expense.id}`,
  };
  const reload = () => {
    if (API_ENABLED) void claimsMirror.reload();
  };

  return (
    <Dialog open title={`Claim ${refOf(expense.id)}`} onClose={onClose} wide>
      <div className="pr-detail">
        <div className="pr-item-head">
          <div>
            <h3>{mine ? expense.category : `${nameOf(expense.employeeId)} · ${expense.category}`}</h3>
            <p style={{ whiteSpace: "pre-line" }}>{expense.description}</p>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="pr-amount">{money(expense.amount, itemCurrency(expense))}</div>
            <StatusBadge status={STATUS_LABEL[expense.status]} tone={STATUS_TONE[expense.status]} literal />
          </div>
        </div>
        <Facts
          items={[
            ["Claim ID", refOf(expense.id)],
            ["Employee", nameOf(expense.employeeId)],
            ["Expense date", formatShortDate(expense.date)],
            ["Submitted", expense.submittedOn ? formatShortDate(expense.submittedOn) : ""],
            ["Category", expense.category],
            ["Trip", trip ? tripLabel(trip) : ""],
            ...Object.entries(expense.details ?? {}).map(([k, v]): [string, string] => [detailLabel(expense.category, k), v]),
            ["Payment", expense.status === "paid" ? `Paid ${formatShortDate(expense.paidOn ?? "")}${expense.paymentRef ? ` · ${expense.paymentRef}` : ""}` : expense.status === "approved" ? "Approved, waiting for Finance to pay" : "Not paid"],
          ]}
        />
        <section>
          <h4>Receipts</h4>
          <ReceiptLinks receipts={receiptsOf(expense)} onError={(text) => setMessage({ tone: "err", text })} />
          {mine && expense.status === "submitted" && API_ENABLED && (
            <label className="btn-ghost btn-tiny pr-file-btn">
              Add receipt
              <input
                key={fileKey}
                type="file"
                accept="image/*,application/pdf"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  setFileKey((k) => k + 1);
                  if (!file) return;
                  const problem = receiptFileError(file);
                  const err = problem ?? (await apiAddClaimReceipt(expense.id, file));
                  notify(err ?? `${file.name} added to the claim.`);
                }}
              />
            </label>
          )}
        </section>
        <section>
          <h4>Approval progress</h4>
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
          {expense.status === "submitted" && stepText(expense) && <p className="muted">Now with: {stepText(expense)}</p>}
        </section>
        {canDecide && (
          <section>
            <h4>Your decision</h4>
            <DecideBar
              onDecide={async (decision, note) => {
                if (decision === "reject" && !note.trim()) return "Add a comment saying why it is declined.";
                const error = await portal.setExpenseStatus(expense.id, decision === "approve" ? "approved" : "rejected", note);
                if (!error) recordLocalEvent("expense", expense.id, decision === "approve" ? "expense_approved" : "expense_rejected", employee.fullName);
                setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: decision === "approve" ? "Claim approved." : "Claim declined." });
                return error;
              }}
              onRequestInfo={async (note) => {
                const error = await addComment("expense", expense.id, ctx, note, true);
                setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: `Asked ${nameOf(expense.employeeId)} for more information.` });
                reload();
                return error;
              }}
            />
          </section>
        )}
        {canPay && (
          <section>
            <h4>Record payment</h4>
            <div className="pr-actions">
              <input type="date" max={todayISO()} min={expense.date} value={payOn} onChange={(e) => setPayOn(e.target.value)} aria-label="Payment date" />
              <input value={payRef} maxLength={100} onChange={(e) => setPayRef(e.target.value)} placeholder="Payment reference" aria-label="Payment reference" />
              <ActionButton
                className="btn"
                toastError
                busyLabel="Saving…"
                doneLabel="Paid"
                success={`Claim marked paid for ${nameOf(expense.employeeId)}.`}
                onAction={async () => {
                  if (!payRef.trim()) return "Enter the payment reference.";
                  const error = await portal.markExpensePaid(expense.id, payOn, payRef);
                  if (!error) recordLocalEvent("expense", expense.id, "expense_paid", employee.fullName);
                  setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Claim marked paid." });
                  return error ?? true;
                }}
              >
                Mark paid
              </ActionButton>
            </div>
          </section>
        )}
        {canEdit && !editing && (
          <div className="pr-actions">
            <button type="button" className="btn-ghost btn-tiny" onClick={() => setEditing(true)}>
              Edit claim
            </button>
          </div>
        )}
        {editing && (
          <form
            className="pr-form"
            onSubmit={editAction.submit(
              async () => {
                const problem = detailsProblem(expense.category, edit.details);
                if (problem) return problem;
                const error = await portal.editExpense(expense.id, {
                  amount: Number(edit.amount),
                  description: edit.description,
                  date: edit.date,
                  details: cleanDetails(expense.category, edit.details),
                });
                if (!error) {
                  recordLocalEvent("expense", expense.id, "expense_edited", employee.fullName);
                  setEditing(false);
                }
                setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Claim updated. Your approver was told." });
                return error ?? true;
              },
              { success: "Claim updated.", toastError: true },
            )}
          >
            <div className="pr-grid">
              <Field label="Date">
                <input type="date" min={addDaysISO(todayISO(), -EXPENSE_CLAIM_WINDOW_DAYS)} max={todayISO()} value={edit.date} onChange={(e) => setEdit({ ...edit, date: e.target.value })} required />
              </Field>
              <Field label={`Amount (${itemCurrency(expense)}, up to the original)`}>
                <input type="number" min={1} max={expense.amount} step="0.01" value={edit.amount} onChange={(e) => setEdit({ ...edit, amount: e.target.value })} required />
              </Field>
              <DetailFields category={expense.category} details={edit.details} onChange={(details) => setEdit({ ...edit, details })} />
              <Field label="Description" wide>
                <textarea value={edit.description} maxLength={2000} onChange={(e) => setEdit({ ...edit, description: e.target.value })} required />
              </Field>
            </div>
            <div className="pr-actions">
              <SubmitButton action={editAction} className="btn">
                Save changes
              </SubmitButton>
              <button type="button" className="btn-ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </form>
        )}
        {mine && expense.status === "submitted" && (
          <div className="pr-actions">
            <span className="spacer" />
            <ConfirmButton
              title="Withdraw this claim?"
              message={<p>{refOf(expense.id)} for {money(expense.amount, itemCurrency(expense))} will be withdrawn and your approvers told. Its receipts can be used on a new claim.</p>}
              confirmLabel="Withdraw claim"
              success="Claim withdrawn."
              onConfirm={async () => {
                const error = await portal.setExpenseStatus(expense.id, "withdrawn");
                if (!error) {
                  recordLocalEvent("expense", expense.id, "expense_withdrawn", employee.fullName);
                  setMessage({ tone: "ok", text: "Claim withdrawn." });
                  onClose();
                }
                return error;
              }}
            >
              Withdraw
            </ConfirmButton>
          </div>
        )}
        <RequestThread
          type="expense"
          id={expense.id}
          ctx={ctx}
          refreshKey={`${expense.status}|${expense.infoRequested}|${(expense.stepDecisions ?? []).length}|${expense.amount}|${expense.description}|${receiptsOf(expense).length}`}
          onChanged={reload}
        />
      </div>
    </Dialog>
  );
}

function ClaimRow({ expense, who, info, onOpen }: { expense: Expense; who?: string; info: boolean; onOpen: () => void }) {
  return (
    <article
      className="pr-item clickable"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      aria-label={`Open claim ${refOf(expense.id)}`}
    >
      <div className="pr-item-head">
        <div>
          <h3>{who ? `${who} · ${expense.category}` : expense.category}</h3>
          <p>
            <span className="pr-id">{refOf(expense.id)}</span> · {formatShortDate(expense.date)} · {receiptsOf(expense).length} receipt{receiptsOf(expense).length === 1 ? "" : "s"}
            {expense.status === "submitted" && stepText(expense) ? ` · ${stepText(expense)}` : ""}
          </p>
          <p style={{ whiteSpace: "pre-line" }}>{expense.description.slice(0, 140)}</p>
          {info && <span className="pr-flag">More information requested</span>}
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="pr-amount">{money(expense.amount, itemCurrency(expense))}</div>
          <StatusBadge status={STATUS_LABEL[expense.status]} tone={STATUS_TONE[expense.status]} literal />
        </div>
      </div>
    </article>
  );
}

const claimsMirrorReady = () => !API_ENABLED || claimsMirror.loaded();

export function ExpensesPage() {
  const portal = usePortal();
  const { state, employee, currentProjects, addExpense, hasApprover, demoAccounts } = portal;
  const people = useSyncExternalStore(subscribePeople, listPeople, listPeople);
  const trips = useTravelRequests();
  const threadsTick = useSyncExternalStore(subscribeThreads, threadsVersion, threadsVersion);
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
  const [receiptFiles, setReceiptFiles] = useState<File[]>([]);
  const [fileKey, setFileKey] = useState(0);
  const [date, setDate] = useState("");
  const [category, setCategory] = useState<string>(CLAIM_CATEGORIES[0].name);
  const [details, setDetails] = useState<Record<string, string>>({});
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
  const [message, setMessage] = useState<{ tone: "ok" | "err" | "warn"; text: string } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [tab, setTab] = useState("mine");
  const [formOpen, setFormOpen] = useState(false);
  const [localInfo, setLocalInfo] = useState<Set<string>>(new Set());

  const mine = state.expenses.filter((expense) => expense.employeeId === employee.id);
  const myTrips = trips.filter((t) => t.employeeId === employee.id && t.status === "approved");
  const waiting = state.expenses.filter((expense) => portal.canDecideExpense(expense));
  const toPay = state.expenses.filter((expense) => portal.canPayExpense(expense));
  const finance = canPayOut(portal.demoProfile.role);
  const hrView = ["hr", "hr_admin", "hrbp", "admin", "super_admin"].includes(portal.demoProfile.role);
  // Others' claims only for their approvers' reporting line, HR and Finance (local mode keeps everyone's claims).
  const team = state.expenses.filter((e) => e.employeeId !== employee.id && (API_ENABLED || finance || hrView || portal.canDecideFor(e.employeeId, "expenses")));
  const showErr = (text: string) => setMessage({ tone: "err", text });
  const cat = categoryOf(category);

  // Local mode: the "more information" flag comes from the browser's threads.
  useEffect(() => {
    if (API_ENABLED) return;
    void loadOpenInfo("expense", state.expenses.map((e) => e.id)).then(setLocalInfo);
  }, [state.expenses, threadsTick]);
  const infoOf = (e: Expense) => (API_ENABLED ? !!e.infoRequested : localInfo.has(e.id));

  const nameOf = (id: string) => demoAccounts.find((a) => a.id === id)?.fullName ?? people.find((p) => p.id === id)?.fullName ?? id;
  const opened = openId ? state.expenses.find((e) => e.id === openId) ?? null : null;
  const openRow = useCallback((id: string) => setOpenId(id), []);
  useOpenFromQuery(state.expenses.map((e) => e.id), openRow);

  const claimAction = useAction();
  const mineFilters = useListFilters();
  const teamFilters = useListFilters();
  const pick = {
    text: (e: Expense) => `${e.id} ${e.category} ${e.description} ${nameOf(e.employeeId)} ${Object.values(e.details ?? {}).join(" ")}`,
    status: (e: Expense) => STATUS_LABEL[e.status],
    date: (e: Expense) => e.date,
    category: (e: Expense) => e.category,
  };
  const mineShown = applyFilters(mine, mineFilters.filters, pick);
  const teamSource = tab === "approve" ? waiting : tab === "pay" ? toPay : team;
  const teamShown = applyFilters(teamSource, teamFilters.filters, pick);
  const categories = [...new Set([...CLAIM_CATEGORY_NAMES, ...state.expenses.map((e) => e.category)])];
  const csvHeaders = ["Claim ID", "Employee", "Date", "Category", "Description", "Amount", "Currency", "Status", "Submitted", "Trip", "Receipts", "Paid on", "Payment reference", "Details"];
  const csvRows = (list: Expense[]) =>
    list.map((e) => [
      refOf(e.id),
      nameOf(e.employeeId),
      e.date,
      e.category,
      e.description,
      e.amount,
      itemCurrency(e),
      STATUS_LABEL[e.status],
      e.submittedOn ?? "",
      e.tripId ?? "",
      receiptsOf(e).length,
      e.paidOn ?? "",
      e.paymentRef ?? "",
      Object.entries(e.details ?? {}).map(([k, v]) => `${detailLabel(e.category, k)}: ${v}`).join("; "),
    ]);
  const byCategory = useMemo(() => {
    const map = new Map<string, Expense[]>();
    for (const e of mineShown) map.set(e.category, [...(map.get(e.category) ?? []), e]);
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [mineShown]);
  const totals = (list: Expense[]) => moneyTotals(list.map((item) => ({ amount: item.amount, currency: itemCurrency(item) })), currency);

  async function onSubmit(): Promise<boolean | string> {
    if (busy) return false;
    if (!date) return "Choose the expense date.";
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return "Enter an amount greater than zero.";
    if (value > maxClaim) return `A single claim can't be more than ${money(maxClaim, currency)}. Split it or contact Finance.`;
    if (!description.trim()) return "Enter a description.";
    if (hasTemplateBlanks(description)) return TEMPLATE_BLANKS_ERROR;
    const problem = detailsProblem(category, details);
    if (problem) return problem;
    if (value > receiptAbove && receiptFiles.length === 0) return `Attach a receipt for claims over ${money(receiptAbove, currency)}.`;
    for (const f of receiptFiles) {
      const err = receiptFileError(f);
      if (err) return `${f.name}: ${err}`;
    }
    setBusy(true);
    const saved: ExpenseReceipt[] = [];
    try {
      for (const f of receiptFiles) saved.push(await saveReceipt(f));
    } catch (error) {
      setBusy(false);
      showErr(error instanceof Error ? error.message : "Couldn't save the receipt.");
      return false;
    }
    const before = new Set(state.expenses.map((e) => e.id));
    const error = await addExpense({
      date,
      category,
      amount: value,
      description,
      projectId,
      details: cleanDetails(category, details),
      ...(saved[0] ? { receipt: saved[0], receipts: saved } : {}),
      ...(tripId ? { tripId } : {}),
    });
    setBusy(false);
    if (error) {
      showErr(error);
      return false;
    }
    const created = (API_ENABLED ? claimsMirror.get().expenses : []).find((e) => e.employeeId === employee.id && !before.has(e.id));
    if (created) recordLocalEvent("expense", created.id, "expense_submitted", employee.fullName);
    setMessage({
      tone: "ok",
      text: `${hasApprover ? "Claim submitted for approval" : "Claim submitted"}${created ? ` as ${refOf(created.id)}` : ""}. You'll be notified when it is decided and paid.`,
    });
    notify(hasApprover ? "Expense claim submitted for approval." : "Expense claim submitted.");
    setAmount("");
    resetDescription();
    setDate("");
    setTripId("");
    setDetails({});
    setReceiptFiles([]);
    setFileKey((key) => key + 1);
    setFormOpen(false);
    return true;
  }

  const showForm = formOpen || (claimsMirrorReady() && mine.length === 0);
  const approverTabs = waiting.length > 0 || toPay.length > 0 || finance || team.length > 0;

  return (
    <Page
      title="Reimbursements"
      action={
        tab === "mine" || !approverTabs ? (
          <button type="button" className={showForm ? "btn-ghost" : "btn"} onClick={() => setFormOpen(!showForm)} aria-expanded={showForm}>
            {showForm ? "Close form" : "New claim"}
          </button>
        ) : undefined
      }
    >
      <SummaryTiles
        label="Claim summary"
        items={[
          { label: "Total claims", value: mine.length },
          { label: "Pending", value: mine.filter((e) => e.status === "submitted").length, tone: "sky" },
          { label: "Approved", value: mine.filter((e) => e.status === "approved").length },
          { label: "Declined", value: mine.filter((e) => e.status === "rejected").length },
          { label: "Paid", value: mine.filter((e) => e.status === "paid").length },
          { label: "Total claimed", value: totals(mine.filter((e) => e.status !== "withdrawn")), tone: "lilac" },
          { label: "Reimbursed", value: totals(mine.filter((e) => e.status === "paid")) },
        ]}
      />
      <Banner message={message} />
      {mine.some(infoOf) && <Banner message={{ tone: "warn", text: "An approver asked for more information on one of your claims. Open it to answer." }} />}
      {approverTabs && (
        <Tabs
          tabs={[
            { id: "mine", label: "My claims" },
            { id: "approve", label: `To approve (${waiting.length})` },
            ...(toPay.length > 0 || finance ? [{ id: "pay", label: `Ready to pay (${toPay.length})` }] : []),
            ...(team.length > 0 ? [{ id: "team", label: finance ? "All claims" : "Team claims" }] : []),
          ]}
          value={tab}
          onChange={setTab}
        />
      )}

      {tab !== "mine" && approverTabs && (
        <Card title={tab === "approve" ? "Waiting on me" : tab === "pay" ? "Approved, ready to pay" : finance ? "All claims" : "Team claims"}>
          <ListFilters
            state={teamFilters.filters}
            onChange={teamFilters.set}
            onReset={teamFilters.reset}
            statuses={STATUS_FILTERS}
            categories={categories}
            searchPlaceholder="ID, name, description"
            extra={<CsvButton filename={`reimbursements-${tab}-${todayISO()}.csv`} headers={csvHeaders} rows={() => csvRows(teamShown)} />}
          />
          {teamShown.length === 0 ? (
            <EmptyState title={teamSource.length ? "No claims match these filters" : tab === "approve" ? "Nothing waiting on you" : tab === "pay" ? "Nothing to pay" : "No claims yet"} />
          ) : (
            <div className="pr-list">
              {teamShown.map((e) => (
                <ClaimRow key={e.id} expense={e} who={nameOf(e.employeeId)} info={infoOf(e)} onOpen={() => setOpenId(e.id)} />
              ))}
            </div>
          )}
        </Card>
      )}

      {(tab === "mine" || !approverTabs) && (
        <div className="pc-stack">
          {showForm && (
          <Card title="New claim">
            <form onSubmit={claimAction.submit(onSubmit, { toastError: true })} noValidate>
              <div className="form-grid">
                <Field label="Date">
                  <input type="date" min={addDaysISO(todayISO(), -EXPENSE_CLAIM_WINDOW_DAYS)} max={todayISO()} value={date} onChange={(event) => setDate(event.target.value)} required />
                </Field>
                <Field label="Category">
                  <select
                    value={category}
                    onChange={(event) => {
                      setCategory(event.target.value);
                      setDetails({});
                      fillDescription("expense", event.target.value);
                    }}
                  >
                    {CLAIM_CATEGORY_NAMES.map((item) => (
                      <option key={item}>{item}</option>
                    ))}
                  </select>
                </Field>
                <Field label={`Amount (up to ${money(maxClaim, currency)})`}>
                  <input type="number" min={1} max={maxClaim} step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} required />
                </Field>
                <Field label="Currency">
                  <input value={`${currency} · your country's currency`} readOnly aria-readonly="true" />
                </Field>
                <DetailFields category={category} details={details} onChange={setDetails} />
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
                <Field label={cat.tripRelated ? "Trip (approved trips)" : "Trip (optional)"}>
                  <select value={tripId} onChange={(event) => setTripId(event.target.value)}>
                    <option value="">No trip</option>
                    {myTrips.map((trip) => (
                      <option key={trip.id} value={trip.id}>
                        {tripLabel(trip)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={`Receipts (PDF or image, up to ${RECEIPT_MAX_BYTES / 1024 / 1024} MB each; required over ${money(receiptAbove, currency)})`} wide>
                  <input
                    key={fileKey}
                    type="file"
                    multiple
                    accept={API_ENABLED ? "application/pdf,image/png,image/jpeg,image/gif,image/webp" : "image/*,application/pdf"}
                    onChange={(event) => {
                      const files = [...(event.target.files ?? [])].slice(0, API_ENABLED ? 10 : 1);
                      const bad = files.map((f) => [f, receiptFileError(f)] as const).find(([, e]) => e);
                      if (bad) {
                        showErr(`${bad[0].name}: ${bad[1]}`);
                        setReceiptFiles([]);
                        setFileKey((key) => key + 1);
                        return;
                      }
                      setReceiptFiles(files);
                    }}
                  />
                  {receiptFiles.length > 0 && <span className="muted">{receiptFiles.map((f) => f.name).join(", ")}</span>}
                </Field>
                <Field label="Description" wide>
                  <textarea
                    ref={descriptionRef}
                    value={description}
                    maxLength={2000}
                    onChange={(event) => setDescription(event.target.value)}
                    onFocus={() => fillDescriptionIfEmpty("expense", category)}
                    required
                  />
                </Field>
              </div>
              <ul className="pc-rules" aria-label="Claim rules">
                <li>Up to {money(maxClaim, currency)} a claim</li>
                <li>Receipt above {money(receiptAbove, currency)}</li>
                <li>Within {EXPENSE_CLAIM_WINDOW_DAYS} days</li>
                {apiRules && <li>Finance review from {money(apiRules.finance_threshold, currency)}</li>}
              </ul>
              <div className="form-actions">
                <SubmitButton action={claimAction} className="btn" disabled={busy}>
                  Submit claim
                </SubmitButton>
              </div>
            </form>
          </Card>
          )}
          <Card title="My claims" action={mine.length ? <span className="muted">{totals(mine.filter((e) => e.status !== "withdrawn"))} claimed</span> : undefined}>
            <ListFilters
              state={mineFilters.filters}
              onChange={mineFilters.set}
              onReset={mineFilters.reset}
              statuses={STATUS_FILTERS}
              categories={categories}
              searchPlaceholder="ID, description, merchant"
              extra={<CsvButton filename={`my-reimbursements-${todayISO()}.csv`} headers={csvHeaders} rows={() => csvRows(mineShown)} />}
            />
            {byCategory.length > 0 && (
              <div className="pr-cat-summary" aria-label="By category">
                {byCategory.map(([c, list]) => (
                  <span key={c}>
                    {c}: {list.length} · {totals(list)}
                  </span>
                ))}
              </div>
            )}
            {API_ENABLED && !claimsMirror.loaded() ? (
              <p className="muted">Loading…</p>
            ) : mineShown.length === 0 ? (
              <EmptyState
                title={mine.length ? "No claims match these filters" : "No claims yet"}
                description={mine.length ? "Clear the filters to see all your claims." : "Claims you submit show here with their status and payment."}
                action={mine.length ? <button type="button" className="btn-ghost" onClick={mineFilters.reset}>Clear filters</button> : undefined}
              />
            ) : (
              <div className="pr-list" style={{ marginTop: 10 }}>
                {mineShown.map((e) => (
                  <ClaimRow key={e.id} expense={e} info={infoOf(e)} onOpen={() => setOpenId(e.id)} />
                ))}
              </div>
            )}
          </Card>
        </div>
      )}
      {opened && <ClaimDetail key={opened.id} expense={opened} infoOpen={infoOf(opened)} onClose={() => setOpenId(null)} setMessage={setMessage} />}
    </Page>
  );
}
