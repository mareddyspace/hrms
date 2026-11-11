import { useState } from "react";
import { Banner, Card, EmptyState, Field, Page, StatusPill, SubmitButton, Tabs, notify, useAction } from "../components/ui.tsx";
import { TravelReimbursements } from "../features/payrequests/TravelReimbursements.tsx";
import { SummaryTiles } from "../features/payrequests/requestKit.tsx";
import "../styles/pay-claims.css";
import { claimLimitsFor, itemCurrency, money, moneyTotals, payRulesFor, receiptThresholdFor } from "../countryPay.ts";
import { addDaysISO, EXPENSE_CLAIM_WINDOW_DAYS, formatShortDate, todayISO } from "../model.ts";

import { usePortal } from "../store.tsx";
import { TEMPLATE_BLANKS_ERROR, hasTemplateBlanks, useTemplatedText } from "../data/requestTemplates.ts";

const REIMBURSE_CATEGORIES = ["Internet", "Books", "Medical", "Conveyance", "Other"] as const;

/** Travel claims (linked to an approved trip, with history) and other reimbursements. */
export function ReimbursementPage() {
  const [tab, setTab] = useState("travel");
  return (
    <Page title="Travel reimbursements">
      <Tabs
        tabs={[
          { id: "travel", label: "Travel claims" },
          { id: "other", label: "Other reimbursements" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "travel" ? <TravelReimbursements /> : <OtherReimbursements />}
    </Page>
  );
}

function OtherReimbursements() {
  const { state, employee, addReimbursement, hasApprover } = usePortal();
  const currency = payRulesFor(employee.countryCode).currency;
  const receiptAbove = receiptThresholdFor(employee.countryCode);
  const { maxClaim } = claimLimitsFor(employee.countryCode);
  const [receipt, setReceipt] = useState("");
  const [fileKey, setFileKey] = useState(0);
  const mine = state.reimbursements.filter((item) => item.employeeId === employee.id);
  const [date, setDate] = useState("");
  const [category, setCategory] = useState<string>(REIMBURSE_CATEGORIES[0]);
  const [amount, setAmount] = useState("");
  const {
    value: description,
    setValue: setDescription,
    ref: descriptionRef,
    fill: fillDescription,
    fillIfEmpty: fillDescriptionIfEmpty,
    reset: resetDescription,
  } = useTemplatedText();
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const reimburseAction = useAction();
  const total = (list: typeof mine) => moneyTotals(list.map((r) => ({ amount: r.amount, currency: itemCurrency(r) })), currency);

  function onSubmit(): boolean {
    if (hasTemplateBlanks(description)) {
      setMessage({ tone: "err", text: TEMPLATE_BLANKS_ERROR });
      return false;
    }
    const value = Number(amount);
    if (value > receiptAbove && !receipt) {
      setMessage({ tone: "err", text: `Attach a receipt for claims over ${money(receiptAbove, currency)}.` });
      return false;
    }
    const text = receipt && description.trim() ? `${description.trim()}\nReceipt: ${receipt}` : description;
    const error = addReimbursement({
      date,
      category,
      amount: value,
      description: text,
    });
    setMessage(
      error
        ? { tone: "err", text: error }
        : { tone: "ok", text: hasApprover ? "Reimbursement submitted for approval." : "Reimbursement approved automatically." },
    );
    if (error) return false;
    notify(hasApprover ? "Reimbursement submitted for approval." : "Reimbursement approved automatically.");
    setDate("");
    setAmount("");
    resetDescription();
    setReceipt("");
    setFileKey((key) => key + 1);
    return true;
  }

  return (
    <>
      <SummaryTiles
        label="Reimbursement summary"
        items={[
          { label: "Claims", value: mine.length },
          { label: "Pending", value: mine.filter((r) => r.status === "submitted").length, tone: "sky" },
          { label: "Approved", value: mine.filter((r) => r.status === "approved").length },
          { label: "Declined", value: mine.filter((r) => r.status === "rejected").length },
          { label: "Total claimed", value: total(mine.filter((r) => r.status !== "rejected" && r.status !== "withdrawn")), tone: "lilac" },
          { label: "Approved amount", value: total(mine.filter((r) => r.status === "approved")) },
        ]}
      />
      <div className="split">
        <Card title="New reimbursement">
          <form onSubmit={reimburseAction.submit(onSubmit)}>
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
                    fillDescription("reimbursement", event.target.value);
                  }}
                >
                  {REIMBURSE_CATEGORIES.map((item) => (
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
              <Field label="Description" wide>
                <textarea
                  ref={descriptionRef}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  onFocus={() => fillDescriptionIfEmpty("reimbursement", category)}
                />
              </Field>
            </div>
            <div className="form-actions">
              <SubmitButton action={reimburseAction} className="btn">
                Submit
              </SubmitButton>
            </div>
            <Banner message={message} />
          </form>
        </Card>
        <Card title="My reimbursements">
          {mine.length === 0 ? (
            <EmptyState title="No reimbursements yet" description="Submitted claims show here with their status." />
          ) : (
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
                    <td>{formatShortDate(item.date)}</td>
                    <td>
                      <strong>{item.category}</strong>
                      <div className="muted" style={{ whiteSpace: "pre-line" }}>{item.description}</div>
                    </td>
                    <td className="num">{money(item.amount, itemCurrency(item))}</td>
                    <td>
                      <StatusPill status={item.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
        </Card>
      </div>
    </>
  );
}

/** Tax declarations with proofs, Finance verification and deadlines: src/features/taxdecl/TaxDeclarationsPage.tsx. */
export { TaxDeclarationsPage as InvestmentProofPage } from "../features/taxdecl/TaxDeclarationsPage.tsx";
