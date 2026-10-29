import { useState, useSyncExternalStore } from "react";
import { ActionButton, Banner, Card, Field, Page, StatusBadge, SubmitButton, notify, useAction } from "../components/ui.tsx";
import { StepTimeline } from "../components/StepTimeline.tsx";
import { money, payRulesFor } from "../countryPay.ts";
import { TIMEZ_COUNTRIES, formatShortDate, todayISO } from "../model.ts";
import { usePortal } from "../store.tsx";
import { stepText } from "../data/expenseFlow.ts";
import { listPeople, subscribePeople } from "../data/peopleLocal.ts";
import {
  TRAVEL_MODES,
  canDecideTravel,
  decideTravel,
  getTravelRequests,
  submitTravel,
  useTravelRequests,
  withdrawTravel,
  type TravelMode,
  type TravelRequest,
} from "../data/travelStore.ts";

const STATUS_LABEL: Record<TravelRequest["status"], string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Declined",
  withdrawn: "Withdrawn",
};
const STATUS_TONE: Record<TravelRequest["status"], "ok" | "warn" | "danger" | "neutral"> = {
  pending: "warn",
  approved: "ok",
  rejected: "danger",
  withdrawn: "neutral",
};

const CURRENCIES = Array.from(new Set(TIMEZ_COUNTRIES.map((c) => c.currency)));

export function TravelPage() {
  const { state, employee, demoAccounts, canDecideFor } = usePortal();
  const people = useSyncExternalStore(subscribePeople, listPeople, listPeople);
  const requests = useTravelRequests();
  const homeCurrency = payRulesFor(employee.countryCode).currency;
  const actor = { id: employee.id, fullName: employee.fullName };
  const canApprove = (id: string) => canDecideFor(id, "expenses");

  const [purpose, setPurpose] = useState("");
  const [fromCity, setFromCity] = useState("");
  const [toCity, setToCity] = useState("");
  const [departOn, setDepartOn] = useState("");
  const [returnOn, setReturnOn] = useState("");
  const [mode, setMode] = useState<TravelMode>("Flight");
  const [cost, setCost] = useState("");
  const [currency, setCurrency] = useState(homeCurrency);
  const [advanceNeeded, setAdvanceNeeded] = useState(false);
  const [advance, setAdvance] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const mine = requests.filter((t) => t.employeeId === employee.id);
  const waiting = requests.filter((t) => canDecideTravel(t, employee.id, canApprove));
  const nameOf = (id: string) =>
    demoAccounts.find((a) => a.id === id)?.fullName ?? people.find((p) => p.id === id)?.fullName ?? id;
  const claimsFor = (tripId: string) => state.expenses.filter((x) => x.tripId === tripId && x.status !== "withdrawn" && x.status !== "rejected");

  const travelAction = useAction();

  async function onSubmit(): Promise<boolean> {
    const error = await submitTravel(actor, {
      purpose,
      fromCity,
      toCity,
      departOn,
      returnOn,
      mode,
      estimatedCost: Number(cost),
      currency,
      advanceNeeded,
      advanceAmount: advanceNeeded ? Number(advance) : undefined,
    });
    if (error) {
      setMessage({ tone: "err", text: error });
      return false;
    }
    // With nobody to approve it (the CEO), the trip is approved straight away.
    const latest = getTravelRequests().find((t) => t.employeeId === actor.id);
    const auto = latest?.status === "approved" && latest.decidedById === actor.id && latest.submittedOn === todayISO();
    setMessage({ tone: "ok", text: auto ? "Trip approved automatically." : "Travel request submitted." });
    notify(auto ? "Trip approved automatically." : "Travel request submitted for approval.");
    setPurpose("");
    setFromCity("");
    setToCity("");
    setDepartOn("");
    setReturnOn("");
    setCost("");
    setAdvanceNeeded(false);
    setAdvance("");
    return true;
  }

  async function decide(t: TravelRequest, d: "approved" | "rejected") {
    const error = await decideTravel(actor, t.id, d, notes[t.id], canApprove);
    setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: d === "approved" ? "Trip approved." : "Trip declined." });
    if (error) return false;
    setNotes((prev) => ({ ...prev, [t.id]: "" }));
    notify(`Trip ${d === "approved" ? "approved" : "declined"} for ${t.employeeName}.`);
    return true;
  }

  async function withdraw(t: TravelRequest) {
    const error = await withdrawTravel(actor, t.id);
    setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Request withdrawn." });
    if (error) return false;
    notify("Travel request withdrawn.");
    return true;
  }

  return (
    <Page title="Travel">
      <section className="summary-row" aria-label="Travel summary">
        <div className="summary">
          <span>Trips</span>
          <strong>{mine.length}</strong>
        </div>
        <div className="summary sky">
          <span>Waiting</span>
          <strong>{mine.filter((t) => t.status === "pending").length}</strong>
        </div>
        <div className="summary lilac">
          <span>Approved</span>
          <strong>{mine.filter((t) => t.status === "approved").length}</strong>
        </div>
      </section>
      <Banner message={message} />

      {waiting.length > 0 && (
        <Card title={`Waiting on me (${waiting.length})`}>
          <ul className="approval-list">
            {waiting.map((t) => (
              <li key={t.id} className="approval-item">
                <div className="row-between">
                  <strong>{t.employeeName || nameOf(t.employeeId)}</strong>
                  <span className="pill">{stepText(t)}</span>
                </div>
                <span>
                  {t.fromCity} → {t.toCity} · {formatShortDate(t.departOn)} – {formatShortDate(t.returnOn)} · {t.mode}
                </span>
                <span className="muted">
                  {t.purpose} · est. {money(t.estimatedCost, t.currency)}
                  {t.advanceNeeded && t.advanceAmount ? ` · advance ${money(t.advanceAmount, t.currency)}` : ""}
                </span>
                {t.stepDecisions.map((d) => (
                  <span key={d.step} className="muted">
                    {d.label}: {d.byName} · {formatShortDate(d.on)}
                    {d.note ? ` · “${d.note}”` : ""}
                  </span>
                ))}
                <div className="approval-actions">
                  <input
                    value={notes[t.id] ?? ""}
                    onChange={(e) => setNotes((prev) => ({ ...prev, [t.id]: e.target.value }))}
                    placeholder="Note (optional)"
                    aria-label={`Note for ${t.employeeName}`}
                  />
                  <ActionButton className="btn btn-tiny" onAction={() => decide(t, "approved")}>
                    Approve
                  </ActionButton>
                  <ActionButton className="btn-ghost btn-tiny" onAction={() => decide(t, "rejected")}>
                    Decline
                  </ActionButton>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="split">
        <Card title="New travel request">
          <form onSubmit={travelAction.submit(onSubmit)}>
            <div className="form-grid">
              <Field label="Purpose" wide>
                <input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Client visit, conference…" required />
              </Field>
              <Field label="From">
                <input value={fromCity} onChange={(e) => setFromCity(e.target.value)} placeholder="City" required />
              </Field>
              <Field label="To">
                <input value={toCity} onChange={(e) => setToCity(e.target.value)} placeholder="City" required />
              </Field>
              <Field label="Depart">
                <input type="date" min={todayISO()} value={departOn} onChange={(e) => setDepartOn(e.target.value)} required />
              </Field>
              <Field label="Return">
                <input type="date" min={departOn || todayISO()} value={returnOn} onChange={(e) => setReturnOn(e.target.value)} required />
              </Field>
              <Field label="Travel mode">
                <select value={mode} onChange={(e) => setMode(e.target.value as TravelMode)}>
                  {TRAVEL_MODES.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
              </Field>
              <Field label="Estimated cost">
                <input type="number" min={1} value={cost} onChange={(e) => setCost(e.target.value)} required />
              </Field>
              <Field label="Currency">
                <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                  {CURRENCIES.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </Field>
              <Field label="Advance needed">
                <select value={advanceNeeded ? "yes" : "no"} onChange={(e) => setAdvanceNeeded(e.target.value === "yes")}>
                  <option value="no">No</option>
                  <option value="yes">Yes</option>
                </select>
              </Field>
              {advanceNeeded && (
                <Field label={`Advance amount (${currency})`}>
                  <input type="number" min={1} value={advance} onChange={(e) => setAdvance(e.target.value)} required />
                </Field>
              )}
            </div>
            <div className="form-actions">
              <SubmitButton action={travelAction} className="btn">
                Submit request
              </SubmitButton>
            </div>
          </form>
        </Card>
        <Card title="My trips">
          {mine.length === 0 ? (
            <p className="empty">No travel requests yet.</p>
          ) : (
            <ul className="approval-list">
              {mine.map((t) => {
                const open = openId === t.id;
                const claims = claimsFor(t.id);
                return (
                  <li key={t.id} className="approval-item">
                    <div className="row-between">
                      <strong>
                        {t.fromCity} → {t.toCity}
                      </strong>
                      <StatusBadge status={STATUS_LABEL[t.status]} tone={STATUS_TONE[t.status]} literal />
                    </div>
                    <span>
                      {t.purpose} · {formatShortDate(t.departOn)} – {formatShortDate(t.returnOn)} · {t.mode}
                    </span>
                    <span className="muted">
                      Est. {money(t.estimatedCost, t.currency)}
                      {t.advanceNeeded && t.advanceAmount ? ` · advance ${money(t.advanceAmount, t.currency)}` : ""}
                      {t.status === "pending" && stepText(t) ? ` · ${stepText(t)}` : ""}
                    </span>
                    {claims.length > 0 && (
                      <span className="muted">
                        {claims.length} claim{claims.length === 1 ? "" : "s"} filed ·{" "}
                        {claims.map((x) => money(x.amount, x.currency)).join(", ")}
                      </span>
                    )}
                    {open && (
                      <StepTimeline
                        status={t.status}
                        submittedOn={t.submittedOn}
                        steps={t.steps}
                        currentStep={t.currentStep}
                        stepDecisions={t.stepDecisions}
                        decided={t}
                        nameOf={nameOf}
                      />
                    )}
                    <div className="approval-actions">
                      <button type="button" className="btn-ghost btn-tiny" onClick={() => setOpenId(open ? null : t.id)}>
                        {open ? "Hide progress" : "Progress"}
                      </button>
                      {t.status === "pending" && (
                        <ActionButton className="btn-ghost btn-tiny" onAction={() => withdraw(t)}>
                          Withdraw
                        </ActionButton>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </Page>
  );
}
