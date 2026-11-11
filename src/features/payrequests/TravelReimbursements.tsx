/**
 * Travel reimbursements: expense claims linked to an approved trip. Backend mode reads and files them through
 * /expenses (trip_id) and /travel; local mode uses the browser's claims and trips, with sample history until the
 * person files their own.
 */
import { useMemo, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { Banner, Card, Dialog, EmptyState, Field, StatusBadge, SubmitButton, notify, useAction } from "../../components/ui.tsx";
import { claimLimitsFor, itemCurrency, money, moneyTotals, payRulesFor, receiptThresholdFor } from "../../countryPay.ts";
import { formatShortDate, todayISO, type Expense } from "../../model.ts";
import { usePortal } from "../../store.tsx";
import { API_ENABLED } from "../../api/client.ts";
import { listPeople, subscribePeople } from "../../data/peopleLocal.ts";
import { receiptFileError, saveReceipt } from "../../data/receiptStore.ts";
import { tripLabel, useTravelRequests, type TravelRequest } from "../../data/travelStore.ts";
import { Facts, SummaryTiles } from "./requestKit.tsx";
import { sampleTravelClaims, type TravelClaimRow } from "./travelReimbursementSamples.ts";

const CATEGORIES = ["Travel", "Accommodation", "Food", "Transportation", "Other"] as const;
const STATUS: Record<TravelClaimRow["status"], { label: string; tone: "ok" | "warn" | "danger" | "info" | "neutral" }> = {
  submitted: { label: "Pending", tone: "warn" },
  approved: { label: "Approved", tone: "info" },
  paid: { label: "Paid", tone: "ok" },
  rejected: { label: "Declined", tone: "danger" },
  withdrawn: { label: "Withdrawn", tone: "neutral" },
};
const refOf = (id: string) => id.toUpperCase();

function approverOf(e: Expense, nameOf: (id: string) => string): string {
  if (e.decidedByName) return e.decidedByName;
  const last = e.stepDecisions?.[e.stepDecisions.length - 1];
  if (e.status === "submitted") {
    const step = e.steps?.[e.currentStep ?? 0];
    const names = (step?.groups?.flatMap((g) => g.approverIds) ?? step?.approverIds ?? []).map(nameOf).filter(Boolean);
    if (names.length) return `Waiting on ${[...new Set(names)].slice(0, 2).join(", ")}`;
    return step ? `Waiting on ${step.label}` : "Waiting for approval";
  }
  return last?.byName ?? "";
}

function toRow(e: Expense, trip: TravelRequest | undefined, nameOf: (id: string) => string): TravelClaimRow {
  return {
    id: e.id,
    date: e.date,
    submittedOn: e.submittedOn,
    category: e.category,
    description: e.description,
    amount: e.amount,
    currency: itemCurrency(e),
    status: e.status,
    tripId: e.tripId ?? "",
    tripLabel: trip ? `${trip.purpose} · ${trip.fromCity} → ${trip.toCity}` : "Trip not available",
    tripDates: trip ? `${trip.departOn} to ${trip.returnOn}` : "",
    approver: approverOf(e, nameOf),
    decisionNote: e.decisionNote,
    paidOn: e.paidOn,
    paymentRef: e.paymentRef,
    receipts: e.receipts?.length ?? (e.receipt ? 1 : 0),
  };
}

export function TravelReimbursements() {
  const { state, employee, currentProjects, addExpense, hasApprover, demoAccounts } = usePortal();
  const people = useSyncExternalStore(subscribePeople, listPeople, listPeople);
  const trips = useTravelRequests();
  const currency = payRulesFor(employee.countryCode).currency;
  const receiptAbove = receiptThresholdFor(employee.countryCode);
  const { maxClaim } = claimLimitsFor(employee.countryCode);
  const nameOf = (id: string) => demoAccounts.find((a) => a.id === id)?.fullName ?? people.find((p) => p.id === id)?.fullName ?? "";
  const managerName = people.find((p) => p.id === employee.id)?.managerName ?? "";

  const myTrips = trips.filter((t) => t.employeeId === employee.id && t.status === "approved");
  const real = useMemo(
    () =>
      state.expenses
        .filter((e) => e.employeeId === employee.id && e.tripId)
        .map((e) => toRow(e, trips.find((t) => t.id === e.tripId), nameOf))
        .sort((a, b) => b.date.localeCompare(a.date)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.expenses, trips, employee.id, demoAccounts, people],
  );
  const showSamples = !API_ENABLED && real.length === 0;
  const rows = showSamples ? sampleTravelClaims(currency, managerName) : real;

  const [openId, setOpenId] = useState<string | null>(null);
  const opened = rows.find((r) => r.id === openId) ?? null;
  const [tripId, setTripId] = useState("");
  const [date, setDate] = useState("");
  const [category, setCategory] = useState<string>(CATEGORIES[0]);
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const action = useAction();
  const trip = myTrips.find((t) => t.id === tripId);

  const sum = (list: TravelClaimRow[]) => (list.length ? moneyTotals(list.map((r) => ({ amount: r.amount, currency: r.currency })), currency) : money(0, currency));
  const claimed = rows.filter((r) => r.status !== "rejected" && r.status !== "withdrawn");

  async function onSubmit(): Promise<boolean | string> {
    if (!trip) return "Choose the trip this claim belongs to.";
    if (!date) return "Choose the expense date.";
    if (date < trip.departOn || date > trip.returnOn) return `The date must fall within the trip (${formatShortDate(trip.departOn)} to ${formatShortDate(trip.returnOn)}).`;
    if (date > todayISO()) return "You can't claim an expense in the future.";
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return "Enter an amount greater than zero.";
    if (value > maxClaim) return `A single claim can't be more than ${money(maxClaim, currency)}.`;
    if (!description.trim()) return "Enter a description.";
    if (value > receiptAbove && !file) return `Attach a receipt for claims over ${money(receiptAbove, currency)}.`;
    if (file) {
      const problem = receiptFileError(file);
      if (problem) return problem;
    }
    let receipt;
    try {
      receipt = file ? await saveReceipt(file) : undefined;
    } catch (error) {
      return error instanceof Error ? error.message : "Couldn't save the receipt.";
    }
    const error = await addExpense({
      date,
      category,
      amount: value,
      description: description.trim(),
      projectId: currentProjects[0]?.id ?? "",
      tripId: trip.id,
      ...(receipt ? { receipt, receipts: [receipt] } : {}),
    });
    if (error) return error;
    const text = hasApprover ? "Travel claim submitted for approval." : "Travel claim submitted.";
    setMessage({ tone: "ok", text });
    notify(text);
    setDate("");
    setAmount("");
    setDescription("");
    setFile(null);
    setFileKey((k) => k + 1);
    return true;
  }

  return (
    <>
      <SummaryTiles
        label="Travel reimbursement totals"
        items={[
          { label: "Claimed", value: sum(claimed), tone: "lilac", hint: "Everything filed, except declined and withdrawn claims" },
          { label: "Approved", value: sum(rows.filter((r) => r.status === "approved" || r.status === "paid")) },
          { label: "Paid", value: sum(rows.filter((r) => r.status === "paid")) },
          { label: "Pending", value: sum(rows.filter((r) => r.status === "submitted")), tone: "sky" },
        ]}
      />
      <div className="pc-stack">
        <Card title="Claim history">
          {showSamples && <p className="muted tr-sample-note">Sample history. Your own travel claims replace it once you file one.</p>}
          {rows.length === 0 ? (
            <EmptyState title="No travel claims yet" description="Claims you file against an approved trip show here with their status and payment." />
          ) : (
            <div className="table-scroll">
              <table className="data tr-history">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Trip</th>
                    <th className="num">Amount</th>
                    <th>Status</th>
                    <th>Approver</th>
                    <th>Paid on</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="tr-row" tabIndex={0} onClick={() => setOpenId(r.id)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setOpenId(r.id))}>
                      <td>{formatShortDate(r.date)}</td>
                      <td>
                        <strong>{r.tripLabel}</strong>
                        <div className="muted">{r.category}</div>
                      </td>
                      <td className="num">{money(r.amount, r.currency)}</td>
                      <td>
                        <StatusBadge status={STATUS[r.status].label} tone={STATUS[r.status].tone} literal />
                      </td>
                      <td>{r.approver || "—"}</td>
                      <td>{r.paidOn ? formatShortDate(r.paidOn) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="New travel claim">
          {myTrips.length === 0 ? (
            <EmptyState
              title="No approved trips"
              description="Travel claims are filed against an approved trip. Raise the trip on the Travel page first."
            />
          ) : (
            <form onSubmit={action.submit(onSubmit)}>
              <div className="form-grid">
                <Field label="Trip" wide>
                  <select value={tripId} onChange={(e) => setTripId(e.target.value)} required>
                    <option value="">Choose a trip</option>
                    {myTrips.map((t) => (
                      <option key={t.id} value={t.id}>
                        {tripLabel(t)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Expense date">
                  <input
                    type="date"
                    min={trip?.departOn}
                    max={trip ? (trip.returnOn < todayISO() ? trip.returnOn : todayISO()) : todayISO()}
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    required
                  />
                </Field>
                <Field label="Category">
                  <select value={category} onChange={(e) => setCategory(e.target.value)}>
                    {CATEGORIES.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </Field>
                <Field label={`Amount (${currency}, up to ${money(maxClaim, currency)})`}>
                  <input type="number" min={1} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required />
                </Field>
                <Field label={`Receipt (required over ${money(receiptAbove, currency)})`}>
                  <input key={fileKey} type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                </Field>
                <Field label="Description" wide>
                  <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What was this for?" />
                </Field>
              </div>
              <div className="form-actions">
                <SubmitButton action={action} className="btn">
                  Submit claim
                </SubmitButton>
              </div>
              <Banner message={message} />
            </form>
          )}
        </Card>
      </div>
      {opened && <ClaimDetail row={opened} onClose={() => setOpenId(null)} />}
    </>
  );
}

function ClaimDetail({ row, onClose }: { row: TravelClaimRow; onClose: () => void }) {
  const status = STATUS[row.status];
  return (
    <Dialog open title={row.sample ? "Sample travel claim" : `Travel claim ${refOf(row.id)}`} onClose={onClose} wide>
      <div className="pr-detail">
        <div className="pr-item-head">
          <div>
            <h3>{row.category}</h3>
            <p style={{ whiteSpace: "pre-line" }}>{row.description}</p>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="pr-amount">{money(row.amount, row.currency)}</div>
            <StatusBadge status={status.label} tone={status.tone} literal />
          </div>
        </div>
        <Facts
          items={[
            ["Claim ID", row.sample ? "" : refOf(row.id)],
            ["Trip", row.tripLabel],
            ["Trip dates", row.tripDates],
            ["Expense date", formatShortDate(row.date)],
            ["Submitted", row.submittedOn ? formatShortDate(row.submittedOn) : ""],
            ["Amount", `${money(row.amount, row.currency)} (${row.currency})`],
            ["Status", status.label],
            [row.status === "submitted" ? "Approval" : "Approver", row.approver],
            ["Approver's note", row.decisionNote ?? ""],
            ["Paid on", row.paidOn ? formatShortDate(row.paidOn) : row.status === "approved" ? "Approved, waiting for Finance to pay" : ""],
            ["Payment reference", row.paymentRef ?? ""],
            ["Receipts", String(row.receipts)],
          ]}
        />
        {!row.sample && (
          <p>
            <Link className="btn-ghost btn-tiny" to={`/expenses?open=${row.id}`}>
              Open the full claim (receipts, comments, approval steps)
            </Link>
          </p>
        )}
      </div>
    </Dialog>
  );
}
