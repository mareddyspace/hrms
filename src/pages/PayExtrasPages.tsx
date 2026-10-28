import { useState } from "react";
import type { FormEvent } from "react";
import { Banner, Card, Field, Page, StatusPill } from "../components/ui.tsx";
import { claimLimitsFor, declarableTaxYears, itemCurrency, money, payRulesFor, receiptThresholdFor } from "../countryPay.ts";
import { addDaysISO, EXPENSE_CLAIM_WINDOW_DAYS, todayISO } from "../model.ts";

import { usePortal } from "../store.tsx";
import { TEMPLATE_BLANKS_ERROR, hasTemplateBlanks, useTemplatedText } from "../data/requestTemplates.ts";

const REIMBURSE_CATEGORIES = ["Internet", "Books", "Medical", "Conveyance", "Other"] as const;

export function ReimbursementPage() {
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
    if (!error) {
      setDate("");
      setAmount("");
      resetDescription();
      setReceipt("");
      setFileKey((key) => key + 1);
    }
  }

  return (
    <Page title="Other reimbursements">
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
        </Card>
      </div>
    </Page>
  );
}

export function InvestmentProofPage() {
  const { state, employee, addInvestmentProof } = usePortal();
  const rules = payRulesFor(employee.countryCode);
  const years = declarableTaxYears(rules, todayISO());
  const mine = state.investmentProofs.filter((item) => item.employeeId === employee.id);
  const [section, setSection] = useState<string>(rules.declarations[0]?.code ?? "");
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [financialYear, setFinancialYear] = useState(years[0]);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [regime, setRegime] = useState<"old" | "new">("old");
  const cap = rules.declarations.find((item) => item.code === section)?.cap;
  const hasRegimes = rules.code === "IN";
  const newRegime = hasRegimes && regime === "new";

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const error = addInvestmentProof({
      section,
      title,
      amount: Number(amount),
      financialYear,
    });
    setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Declaration submitted." });
    if (!error) {
      setTitle("");
      setAmount("");
    }
  }

  if (rules.declarations.length === 0) {
    return (
      <Page title="Tax declarations" subtitle={employee.countryName}>
        <Card>
          <p className="empty">{rules.declarationNote}</p>
        </Card>
      </Page>
    );
  }

  const regimeField = hasRegimes && (
    <Field label="Tax regime">
      <select value={regime} onChange={(event) => setRegime(event.target.value as "old" | "new")}>
        <option value="old">Old regime</option>
        <option value="new">New regime</option>
      </select>
    </Field>
  );

  return (
    <Page title="Tax declarations" subtitle={`${employee.countryName ?? "India"} · ${rules.declarationNote}`}>
      <div className="split">
        <Card title="Declare">
          {newRegime ? (
            <div className="form-grid">
              {regimeField}
              <p className="empty">
                No deductions under the new regime. Switch to the old regime to declare investments.
              </p>
            </div>
          ) : (
          <form onSubmit={onSubmit}>
            <div className="form-grid">
              {regimeField}
              <Field label="Section">
                <select value={section} onChange={(event) => setSection(event.target.value)}>
                  {rules.declarations.map((item) => (
                    <option key={item.code} value={item.code}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Tax year">
                <select value={financialYear} onChange={(event) => setFinancialYear(event.target.value)}>
                  {years.map((fy) => (
                    <option key={fy} value={fy}>
                      {fy}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Title" wide>
                <input value={title} onChange={(event) => setTitle(event.target.value)} />
              </Field>
              <Field label={cap ? `Amount (${rules.currency}, up to ${money(cap, rules.currency)})` : `Amount (${rules.currency})`}>
                <input type="number" min={1} value={amount} onChange={(event) => setAmount(event.target.value)} />
              </Field>
            </div>
            <div className="form-actions">
              <button className="btn" type="submit">
                Submit
              </button>
            </div>
            <Banner message={message} />
          </form>
          )}
        </Card>
        <Card title="Submitted">
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Section</th>
                  <th>Title</th>
                  <th className="num">Amount</th>
                  <th>Tax year</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {mine.map((item) => (
                  <tr key={item.id}>
                    <td>{item.section}</td>
                    <td>{item.title}</td>
                    <td className="num">{money(item.amount, item.currency)}</td>
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
