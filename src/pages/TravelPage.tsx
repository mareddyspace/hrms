import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { Banner, Card, Dialog, EmptyState, Field, Page, StatusBadge, SubmitButton, Tabs, notify, useAction } from "../components/ui.tsx";
import { StepTimeline } from "../components/StepTimeline.tsx";
import { claimLimitsFor, itemCurrency, money, moneyTotals, payRulesFor } from "../countryPay.ts";
import { formatShortDate, todayISO } from "../model.ts";
import { usePortal } from "../store.tsx";
import { stepText } from "../data/expenseFlow.ts";
import { listPeople, subscribePeople } from "../data/peopleLocal.ts";
import { API_ENABLED } from "../api/client.ts";
import { claimsMirror } from "../api/syncTimeExpenses.ts";
import {
  TRAVEL_MODES,
  canDecideTravel,
  decideTravel,
  getTravelRequests,
  saveBooking,
  submitTravel,
  tripCompleted,
  useTravelRequests,
  withdrawTravel,
  type TravelMode,
  type TravelRequest,
} from "../data/travelStore.ts";
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
import { ATTACH_TYPES, addComment, addFile, loadOpenInfo, recordLocalEvent, subscribeThreads, threadsVersion, type ThreadContext } from "../features/payrequests/threadStore.ts";
import "../styles/pay-claims.css";

type Msg = { tone: "ok" | "err" | "warn"; text: string } | null;

const STATUS_LABEL: Record<TravelRequest["status"], string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Declined",
  withdrawn: "Withdrawn",
};
const STATUS_TONE: Record<TravelRequest["status"], "ok" | "warn" | "danger" | "neutral" | "info"> = {
  pending: "warn",
  approved: "ok",
  rejected: "danger",
  withdrawn: "neutral",
};
const refOf = (id: string) => id.toUpperCase();
const TRAVEL_ADMIN_ROLES = ["hr", "hr_admin", "admin", "super_admin", "travel_admin"];

/** Fields each travel mode asks for (kept in the request's details). */
const MODE_FIELDS: Record<TravelMode, { key: string; label: string; options?: string[]; placeholder?: string }[]> = {
  Flight: [
    { key: "cabin", label: "Cabin class", options: ["Economy", "Premium economy", "Business"] },
    { key: "airline", label: "Preferred airline", placeholder: "Optional" },
    { key: "time", label: "Preferred time", options: ["Any", "Morning", "Afternoon", "Evening"] },
  ],
  Train: [
    { key: "train", label: "Train name / number", placeholder: "Optional" },
    { key: "class", label: "Class", options: ["Sleeper", "3A", "2A", "1A", "Chair car", "Standard", "First"] },
  ],
  Bus: [
    { key: "operator", label: "Operator", placeholder: "Optional" },
    { key: "seat", label: "Seat type", options: ["Seater", "Sleeper", "AC seater", "AC sleeper"] },
  ],
  Car: [
    { key: "car_type", label: "Car", options: ["Own car", "Rental", "Taxi / cab"] },
    { key: "distance_km", label: "Distance (km)", placeholder: "Approximate" },
  ],
  Other: [{ key: "mode_detail", label: "How will you travel?" }],
};
const DETAIL_LABELS: Record<string, string> = {
  cabin: "Cabin class",
  airline: "Preferred airline",
  time: "Preferred time",
  train: "Train",
  class: "Class",
  operator: "Operator",
  seat: "Seat type",
  car_type: "Car",
  distance_km: "Distance (km)",
  mode_detail: "Travel detail",
  accommodation: "Accommodation",
  hotel: "Hotel preference",
  check_in: "Check-in",
  check_out: "Check-out",
  advance_reason: "Advance reason",
  mode: "Mode",
};
const BOOKING_FIELDS = [
  { key: "ticket", label: "Ticket / PNR" },
  { key: "carrier", label: "Carrier & number" },
  { key: "hotel", label: "Hotel & address" },
  { key: "reference", label: "Booking reference" },
  { key: "notes", label: "Notes" },
];

function stageOf(t: TravelRequest, today: string): string {
  if (t.status === "approved") return tripCompleted(t, today) ? "Completed" : t.departOn <= today ? "In progress" : "Upcoming";
  return STATUS_LABEL[t.status];
}

function TripDetail({ t, onClose, setMessage, info }: { t: TravelRequest; onClose: () => void; setMessage: (m: Msg) => void; info: boolean }) {
  const { state, employee, demoProfile, demoAccounts, canDecideFor } = usePortal();
  const people = useSyncExternalStore(subscribePeople, listPeople, listPeople);
  const nameOf = (id: string) => demoAccounts.find((a) => a.id === id)?.fullName ?? people.find((p) => p.id === id)?.fullName ?? id;
  const canApprove = (id: string) => canDecideFor(id, "expenses");
  const canDecide = canDecideTravel(t, employee.id, canApprove);
  const mine = t.employeeId === employee.id;
  const admin = TRAVEL_ADMIN_ROLES.includes(demoProfile.role);
  const claims = state.expenses.filter((x) => x.tripId === t.id && x.status !== "withdrawn");
  const openClaims = claims.filter((x) => x.status !== "rejected");
  const [booking, setBooking] = useState<Record<string, string>>(t.booking ?? {});
  const [fileKey, setFileKey] = useState(0);
  const bookAction = useAction();
  const today = todayISO();
  const ctx: ThreadContext = { actorId: employee.id, actorName: employee.fullName, ownerId: t.employeeId, canDecide, reviewer: !mine && admin, label: "travel request", href: `/travel?open=${t.id}` };
  const actor = { id: employee.id, fullName: employee.fullName, role: demoProfile.role };
  const reload = () => API_ENABLED && void claimsMirror.reload();
  const spent = claims.filter((x) => x.status !== "rejected");

  return (
    <Dialog open title={`Trip ${refOf(t.id)}`} onClose={onClose} wide>
      <div className="pr-detail">
        <div className="pr-item-head">
          <div>
            <h3>
              {t.fromCity} → {t.toCity}
            </h3>
            <p>{t.purpose}</p>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="pr-amount">{money(t.estimatedCost, t.currency)}</div>
            <StatusBadge status={stageOf(t, today)} tone={STATUS_TONE[t.status]} literal />
          </div>
        </div>
        {info && <Banner message={{ tone: "warn", text: mine ? "Your approver asked for more information. Answer in the comments below." : "Waiting for the traveller to answer your question." }} />}
        <Facts
          items={[
            ["Request ID", refOf(t.id)],
            ["Traveller", t.employeeName || nameOf(t.employeeId)],
            ["Itinerary", `${t.fromCity} → ${t.toCity} (return)`],
            ["Dates", `${formatShortDate(t.departOn)} – ${formatShortDate(t.returnOn)}`],
            ["Mode", t.mode],
            ["Estimated cost", money(t.estimatedCost, t.currency)],
            ["Advance", t.advanceNeeded && t.advanceAmount ? money(t.advanceAmount, t.currency) : "Not needed"],
            ["Submitted", formatShortDate(t.submittedOn)],
            ...Object.entries(t.details ?? {})
              .filter(([k]) => k !== "mode")
              .map(([k, v]): [string, string] => [DETAIL_LABELS[k] ?? k, k === "check_in" || k === "check_out" ? formatShortDate(v) : v]),
          ]}
        />
        <section>
          <h4>Approval timeline</h4>
          <StepTimeline status={t.status} submittedOn={t.submittedOn} steps={t.steps} currentStep={t.currentStep} stepDecisions={t.stepDecisions} decided={t} nameOf={nameOf} />
          {t.status === "pending" && stepText(t) && <p className="muted">Now with: {stepText(t)}</p>}
          {t.steps.length > 0 && <p className="muted">Approvers: {t.steps.map((s) => `${s.label} (${s.approverIds.map(nameOf).slice(0, 3).join(", ")})`).join(" → ")}</p>}
        </section>
        {canDecide && (
          <section>
            <h4>Your decision</h4>
            <DecideBar
              onDecide={async (d, note) => {
                if (d === "reject" && !note.trim()) return "Add a comment saying why it is declined.";
                const error = await decideTravel({ id: employee.id, fullName: employee.fullName }, t.id, d === "approve" ? "approved" : "rejected", note, canApprove);
                if (!error) recordLocalEvent("travel", t.id, d === "approve" ? "travel_approved" : "travel_rejected", employee.fullName);
                setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: d === "approve" ? "Trip approved." : "Trip declined." });
                return error;
              }}
              onRequestInfo={async (note) => {
                const error = await addComment("travel", t.id, ctx, note, true);
                setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: `Asked ${t.employeeName} for more information.` });
                reload();
                return error;
              }}
            />
          </section>
        )}
        {t.status === "approved" && (
          <section>
            <h4>Booking details</h4>
            {mine || admin ? (
              <form
                className="pr-form"
                onSubmit={bookAction.submit(
                  async () => {
                    const error = await saveBooking(actor, t.id, booking);
                    if (!error) recordLocalEvent("travel", t.id, "travel_booking_saved", employee.fullName);
                    setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Booking saved." });
                    return error ?? true;
                  },
                  { success: "Booking saved.", toastError: true },
                )}
              >
                <div className="pr-grid">
                  {BOOKING_FIELDS.map((f) => (
                    <Field key={f.key} label={f.label}>
                      <input value={booking[f.key] ?? ""} maxLength={300} onChange={(e) => setBooking({ ...booking, [f.key]: e.target.value })} />
                    </Field>
                  ))}
                </div>
                <div className="pr-actions">
                  <label className="btn-ghost btn-tiny pr-file-btn">
                    Upload ticket / hotel voucher
                    <input
                      key={fileKey}
                      type="file"
                      accept={ATTACH_TYPES}
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        setFileKey((k) => k + 1);
                        if (!file) return;
                        const err = await addFile("travel", t.id, ctx, file, "booking");
                        notify(err ?? `${file.name} added to the trip.`);
                      }}
                    />
                  </label>
                  <span className="spacer" />
                  <SubmitButton action={bookAction} className="btn">
                    Save booking
                  </SubmitButton>
                </div>
              </form>
            ) : t.booking ? (
              <Facts items={BOOKING_FIELDS.map((f): [string, string] => [f.label, t.booking?.[f.key] ?? ""])} />
            ) : (
              <p className="muted">Not booked yet.</p>
            )}
          </section>
        )}
        <section>
          <div className="pr-section-head">
            <h4>Expenses on this trip</h4>
            {mine && t.status === "approved" && (
              <Link className="btn-ghost btn-tiny" to="/expenses">
                Claim an expense
              </Link>
            )}
          </div>
          {claims.length === 0 ? (
            <p className="muted">No claims linked yet. Pick this trip on a reimbursement claim to link its receipts.</p>
          ) : (
            <ul className="pr-audit">
              {claims.map((x) => (
                <li key={x.id}>
                  <span>
                    <Link to={`/expenses?open=${x.id}`}>{refOf(x.id)}</Link> · {x.category} · {formatShortDate(x.date)}
                  </span>
                  <span className="muted">
                    {money(x.amount, itemCurrency(x))} · {x.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {spent.length > 0 && (
            <p className="muted">
              Claimed {moneyTotals(spent.map((x) => ({ amount: x.amount, currency: itemCurrency(x) })), t.currency)} of the {money(t.estimatedCost, t.currency)} estimate.
            </p>
          )}
        </section>
        {mine && (t.status === "pending" || (t.status === "approved" && t.departOn > today)) && (
          <div className="pr-actions">
            <span className="spacer" />
            <ConfirmButton
              title={t.status === "pending" ? "Withdraw this travel request?" : "Cancel this approved trip?"}
              message={
                <p>
                  {refOf(t.id)}: {t.fromCity} → {t.toCity}, {formatShortDate(t.departOn)}. {t.status === "approved" ? "Your manager is told. Cancel any bookings with the provider." : "Your approvers are told."}
                  {openClaims.length > 0 ? " Claims are linked to it, so it can't be cancelled until they are withdrawn." : ""}
                </p>
              }
              confirmLabel={t.status === "pending" ? "Withdraw request" : "Cancel trip"}
              success={t.status === "pending" ? "Request withdrawn." : "Trip cancelled."}
              onConfirm={async () => {
                const error = await withdrawTravel({ id: employee.id, fullName: employee.fullName }, t.id, () => openClaims.length > 0);
                if (!error) {
                  recordLocalEvent("travel", t.id, "travel_withdrawn", employee.fullName);
                  setMessage({ tone: "ok", text: t.status === "pending" ? "Travel request withdrawn." : "Trip cancelled." });
                  onClose();
                }
                return error;
              }}
            >
              {t.status === "pending" ? "Withdraw" : "Cancel trip"}
            </ConfirmButton>
          </div>
        )}
        <RequestThread type="travel" id={t.id} ctx={ctx} filePurposes={["supporting", "booking"]} refreshKey={`${t.status}|${t.infoRequested}|${t.stepDecisions.length}`} onChanged={reload} />
      </div>
    </Dialog>
  );
}

function TripRow({ t, who, info, onOpen }: { t: TravelRequest; who?: string; info: boolean; onOpen: () => void }) {
  const today = todayISO();
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
      aria-label={`Open trip ${refOf(t.id)}`}
    >
      <div className="pr-item-head">
        <div>
          <h3>
            {who ? `${who} · ` : ""}
            {t.fromCity} → {t.toCity}
          </h3>
          <p>
            <span className="pr-id">{refOf(t.id)}</span> · {formatShortDate(t.departOn)} – {formatShortDate(t.returnOn)} · {t.mode}
            {t.status === "pending" && stepText(t) ? ` · ${stepText(t)}` : ""}
          </p>
          <p>{t.purpose}</p>
          {info && <span className="pr-flag">More information requested</span>}
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="pr-amount">{money(t.estimatedCost, t.currency)}</div>
          <StatusBadge status={stageOf(t, today)} tone={STATUS_TONE[t.status]} literal />
        </div>
      </div>
    </article>
  );
}

export function TravelPage() {
  const { employee, demoAccounts, canDecideFor, demoProfile } = usePortal();
  const people = useSyncExternalStore(subscribePeople, listPeople, listPeople);
  const requests = useTravelRequests();
  const threadsTick = useSyncExternalStore(subscribeThreads, threadsVersion, threadsVersion);
  const homeCurrency = payRulesFor(employee.countryCode).currency;
  const advanceCap = claimLimitsFor(employee.countryCode).maxCashAdvance;
  const actor = { id: employee.id, fullName: employee.fullName };
  const canApprove = (id: string) => canDecideFor(id, "expenses");
  const today = todayISO();

  const [purpose, setPurpose] = useState("");
  const [fromCity, setFromCity] = useState("");
  const [toCity, setToCity] = useState("");
  const [departOn, setDepartOn] = useState("");
  const [returnOn, setReturnOn] = useState("");
  const [mode, setMode] = useState<TravelMode>("Flight");
  const [modeDetails, setModeDetails] = useState<Record<string, string>>({});
  const [stay, setStay] = useState({ needed: false, hotel: "" });
  const [cost, setCost] = useState("");
  const [advanceNeeded, setAdvanceNeeded] = useState(false);
  const [advance, setAdvance] = useState("");
  const [advanceReason, setAdvanceReason] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [message, setMessage] = useState<Msg>(null);
  const [tab, setTab] = useState("mine");
  const [when, setWhen] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [localInfo, setLocalInfo] = useState<Set<string>>(new Set());

  const mine = requests.filter((t) => t.employeeId === employee.id);
  const waiting = requests.filter((t) => canDecideTravel(t, employee.id, canApprove));
  const admin = TRAVEL_ADMIN_ROLES.includes(demoProfile.role);
  // Others' trips only for their reporting line, HR and travel admins (local mode keeps everyone's trips).
  const others = requests.filter((t) => t.employeeId !== employee.id && (API_ENABLED || admin || canApprove(t.employeeId)));
  const nameOf = (id: string) => demoAccounts.find((a) => a.id === id)?.fullName ?? people.find((p) => p.id === id)?.fullName ?? id;
  useEffect(() => {
    if (API_ENABLED) return;
    void loadOpenInfo("travel", requests.map((t) => t.id)).then(setLocalInfo);
  }, [requests, threadsTick]);
  const infoOf = (t: TravelRequest) => (API_ENABLED ? !!t.infoRequested : localInfo.has(t.id));
  const opened = openId ? requests.find((t) => t.id === openId) ?? null : null;
  const openRow = useCallback((id: string) => setOpenId(id), []);
  useOpenFromQuery(requests.map((t) => t.id), openRow);

  const travelAction = useAction();
  const mineFilters = useListFilters();
  const teamFilters = useListFilters();
  const pick = {
    text: (t: TravelRequest) => `${t.id} ${t.purpose} ${t.fromCity} ${t.toCity} ${t.employeeName} ${t.mode}`,
    status: (t: TravelRequest) => stageOf(t, today),
    date: (t: TravelRequest) => t.departOn,
    category: (t: TravelRequest) => t.mode,
  };
  const whenFilter = (list: TravelRequest[]) => (when === "upcoming" ? list.filter((t) => t.returnOn >= today) : when === "previous" ? list.filter((t) => t.returnOn < today) : list);
  const mineShown = whenFilter(applyFilters(mine, mineFilters.filters, pick));
  const teamSource = tab === "approve" ? waiting : others;
  const teamShown = applyFilters(teamSource, teamFilters.filters, pick);
  const statuses = ["Pending", "Upcoming", "In progress", "Completed", "Declined", "Withdrawn"];
  const csvHeaders = ["Trip ID", "Traveller", "Purpose", "From", "To", "Depart", "Return", "Mode", "Estimated cost", "Currency", "Advance", "Status", "Submitted", "Booking"];
  const csvRows = (list: TravelRequest[]) =>
    list.map((t) => [
      refOf(t.id),
      t.employeeName,
      t.purpose,
      t.fromCity,
      t.toCity,
      t.departOn,
      t.returnOn,
      t.mode,
      t.estimatedCost,
      t.currency,
      t.advanceAmount ?? 0,
      stageOf(t, today),
      t.submittedOn,
      Object.values(t.booking ?? {}).join("; "),
    ]);
  const estimate = (list: TravelRequest[]) => moneyTotals(list.map((t) => ({ amount: t.estimatedCost, currency: t.currency })), homeCurrency);

  async function onSubmit(): Promise<boolean | string> {
    const value = Number(cost);
    if (!purpose.trim()) return "Enter the trip purpose.";
    if (!fromCity.trim() || !toCity.trim()) return "Enter the from and to cities.";
    if (!departOn || !returnOn) return "Enter the travel dates.";
    if (!Number.isFinite(value) || value <= 0) return "Enter the estimated cost.";
    if (advanceNeeded) {
      const a = Number(advance);
      if (!(a > 0)) return "Enter the advance amount.";
      if (a > value) return "The advance can't be more than the estimated cost.";
      if (a > advanceCap) return `The advance can't be more than ${money(advanceCap, homeCurrency)} (country limit).`;
      if (!advanceReason.trim()) return "Say what the advance is for.";
    }
    const details: Record<string, string> = {};
    for (const f of MODE_FIELDS[mode]) if (modeDetails[f.key]?.trim()) details[f.key] = modeDetails[f.key].trim();
    if (stay.needed) {
      details.accommodation = "Needed";
      details.check_in = departOn;
      details.check_out = returnOn;
      if (stay.hotel.trim()) details.hotel = stay.hotel.trim();
    } else details.accommodation = "Not needed";
    if (advanceNeeded) details.advance_reason = advanceReason.trim();
    const before = new Set(getTravelRequests().map((t) => t.id));
    const error = await submitTravel(actor, {
      purpose,
      fromCity,
      toCity,
      departOn,
      returnOn,
      mode,
      estimatedCost: value,
      currency: homeCurrency,
      advanceNeeded,
      advanceAmount: advanceNeeded ? Number(advance) : undefined,
      details,
    });
    if (error) {
      setMessage({ tone: "err", text: error });
      return false;
    }
    const latest = getTravelRequests().find((t) => t.employeeId === actor.id && !before.has(t.id));
    if (latest) recordLocalEvent("travel", latest.id, "travel_submitted", actor.fullName);
    const auto = latest?.status === "approved";
    setMessage({ tone: "ok", text: `${auto ? "Trip approved automatically" : "Travel request sent to your manager"}${latest ? ` as ${refOf(latest.id)}` : ""}.` });
    notify(auto ? "Trip approved automatically." : "Travel request submitted for approval.");
    setPurpose("");
    setFromCity("");
    setToCity("");
    setDepartOn("");
    setReturnOn("");
    setCost("");
    setModeDetails({});
    setStay({ needed: false, hotel: "" });
    setAdvanceNeeded(false);
    setAdvance("");
    setAdvanceReason("");
    setFormOpen(false);
    return true;
  }

  const showForm = formOpen || ((!API_ENABLED || claimsMirror.loaded()) && mine.length === 0);
  const showTeam = waiting.length > 0 || admin || others.length > 0;

  return (
    <Page
      title="Travel"
      action={
        !showTeam || tab === "mine" ? (
          <button type="button" className={showForm ? "btn-ghost" : "btn"} onClick={() => setFormOpen(!showForm)} aria-expanded={showForm}>
            {showForm ? "Close form" : "New trip"}
          </button>
        ) : undefined
      }
    >
      <SummaryTiles
        label="Travel summary"
        items={[
          { label: "Total trips", value: mine.length },
          { label: "Pending", value: mine.filter((t) => t.status === "pending").length, tone: "sky" },
          { label: "Approved", value: mine.filter((t) => t.status === "approved" && !tripCompleted(t, today)).length },
          { label: "Completed", value: mine.filter((t) => tripCompleted(t, today)).length },
          { label: "Estimated cost", value: estimate(mine.filter((t) => t.status === "pending" || t.status === "approved")), tone: "lilac", hint: "Pending and approved trips" },
        ]}
      />
      <Banner message={message} />
      {showTeam && (
        <Tabs
          tabs={[
            { id: "mine", label: "My trips" },
            { id: "approve", label: `To approve (${waiting.length})` },
            ...(others.length ? [{ id: "team", label: admin ? "All trips" : "Team trips" }] : []),
          ]}
          value={tab}
          onChange={setTab}
        />
      )}

      {showTeam && tab !== "mine" && (
        <Card title={tab === "approve" ? "Waiting on me" : admin ? "All trips" : "Team trips"}>
          <ListFilters
            state={teamFilters.filters}
            onChange={teamFilters.set}
            onReset={teamFilters.reset}
            statuses={statuses}
            categories={[...TRAVEL_MODES]}
            categoryLabel="Mode"
            searchPlaceholder="ID, name, city, purpose"
            dateLabel="Departs"
            extra={<CsvButton filename={`travel-${tab}-${today}.csv`} headers={csvHeaders} rows={() => csvRows(teamShown)} />}
          />
          {teamShown.length === 0 ? (
            <EmptyState title={teamSource.length ? "No trips match these filters" : tab === "approve" ? "Nothing waiting on you" : "No trips yet"} />
          ) : (
            <div className="pr-list">
              {teamShown.map((t) => (
                <TripRow key={t.id} t={t} who={t.employeeName || nameOf(t.employeeId)} info={infoOf(t)} onOpen={() => setOpenId(t.id)} />
              ))}
            </div>
          )}
        </Card>
      )}

      {(!showTeam || tab === "mine") && (
        <div className="pc-stack">
          {showForm && (
          <Card title="New travel request">
            <form onSubmit={travelAction.submit(onSubmit, { toastError: true })} noValidate>
              <div className="form-grid">
                <Field label="Purpose" wide>
                  <input value={purpose} maxLength={2000} onChange={(e) => setPurpose(e.target.value)} placeholder="Client visit, conference…" required />
                </Field>
                <Field label="From city">
                  <input value={fromCity} maxLength={200} onChange={(e) => setFromCity(e.target.value)} placeholder="City" required />
                </Field>
                <Field label="Destination">
                  <input value={toCity} maxLength={200} onChange={(e) => setToCity(e.target.value)} placeholder="City" required />
                </Field>
                <Field label="Depart">
                  <input type="date" min={today} value={departOn} onChange={(e) => setDepartOn(e.target.value)} required />
                </Field>
                <Field label="Return">
                  <input type="date" min={departOn || today} value={returnOn} onChange={(e) => setReturnOn(e.target.value)} required />
                </Field>
                <Field label="Travel mode">
                  <select
                    value={mode}
                    onChange={(e) => {
                      setMode(e.target.value as TravelMode);
                      setModeDetails({});
                    }}
                  >
                    {TRAVEL_MODES.map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                </Field>
                {MODE_FIELDS[mode].map((f) => (
                  <Field key={f.key} label={f.label}>
                    {f.options ? (
                      <select value={modeDetails[f.key] ?? ""} onChange={(e) => setModeDetails({ ...modeDetails, [f.key]: e.target.value })}>
                        <option value="">Choose…</option>
                        {f.options.map((o) => (
                          <option key={o}>{o}</option>
                        ))}
                      </select>
                    ) : (
                      <input value={modeDetails[f.key] ?? ""} maxLength={120} placeholder={f.placeholder} onChange={(e) => setModeDetails({ ...modeDetails, [f.key]: e.target.value })} />
                    )}
                  </Field>
                ))}
                <Field label={`Estimated cost (${homeCurrency})`}>
                  <input type="number" min={1} value={cost} onChange={(e) => setCost(e.target.value)} required />
                </Field>
                <Field label="Currency">
                  <input value={`${homeCurrency} · your country's currency`} readOnly aria-readonly="true" />
                </Field>
                <Field label="Accommodation">
                  <select value={stay.needed ? "yes" : "no"} onChange={(e) => setStay({ ...stay, needed: e.target.value === "yes" })}>
                    <option value="no">Not needed</option>
                    <option value="yes">Needed for the trip dates</option>
                  </select>
                </Field>
                {stay.needed && (
                  <Field label="Hotel preference (optional)">
                    <input value={stay.hotel} maxLength={200} onChange={(e) => setStay({ ...stay, hotel: e.target.value })} placeholder="Area or hotel" />
                  </Field>
                )}
                <Field label="Advance needed">
                  <select value={advanceNeeded ? "yes" : "no"} onChange={(e) => setAdvanceNeeded(e.target.value === "yes")}>
                    <option value="no">No</option>
                    <option value="yes">Yes</option>
                  </select>
                </Field>
                {advanceNeeded && (
                  <>
                    <Field label={`Advance amount (up to ${money(advanceCap, homeCurrency)})`}>
                      <input type="number" min={1} max={advanceCap} value={advance} onChange={(e) => setAdvance(e.target.value)} required />
                    </Field>
                    <Field label="Advance is for">
                      <input value={advanceReason} maxLength={200} onChange={(e) => setAdvanceReason(e.target.value)} placeholder="Local travel, meals…" required />
                    </Field>
                  </>
                )}
              </div>
              <ul className="pc-rules" aria-label="Travel rules">
                <li>Manager approval</li>
                <li>Advance up to {money(advanceCap, homeCurrency)}</li>
                <li>In {homeCurrency}</li>
              </ul>
              <div className="form-actions">
                <SubmitButton action={travelAction} className="btn">
                  Submit request
                </SubmitButton>
              </div>
            </form>
          </Card>
          )}
          <Card title="My trips" action={mine.length ? <span className="muted">{estimate(mine.filter((t) => t.status === "pending" || t.status === "approved"))} estimated</span> : undefined}>
            <ListFilters
              state={mineFilters.filters}
              onChange={mineFilters.set}
              onReset={mineFilters.reset}
              statuses={statuses}
              categories={[...TRAVEL_MODES]}
              categoryLabel="Mode"
              searchPlaceholder="ID, city, purpose"
              dateLabel="Departs"
              extra={
                <>
                  <label className="filter-label">
                    Trips
                    <select value={when} onChange={(e) => setWhen(e.target.value)}>
                      <option value="">All</option>
                      <option value="upcoming">Upcoming</option>
                      <option value="previous">Previous</option>
                    </select>
                  </label>
                  <CsvButton filename={`my-trips-${today}.csv`} headers={csvHeaders} rows={() => csvRows(mineShown)} />
                </>
              }
            />
            {API_ENABLED && !claimsMirror.loaded() ? (
              <p className="muted">Loading…</p>
            ) : mineShown.length === 0 ? (
              <EmptyState
                title={mine.length ? "No trips match these filters" : "No trips yet"}
                description={mine.length ? "Clear the filters to see all your trips." : "Trips you request show here with approval, booking and linked claims."}
                action={mine.length ? <button type="button" className="btn-ghost" onClick={() => (mineFilters.reset(), setWhen(""))}>Clear filters</button> : undefined}
              />
            ) : (
              <div className="pr-list">
                {mineShown.map((t) => (
                  <TripRow key={t.id} t={t} info={infoOf(t)} onOpen={() => setOpenId(t.id)} />
                ))}
              </div>
            )}
          </Card>
        </div>
      )}
      {opened && <TripDetail key={opened.id} t={opened} info={infoOf(opened)} onClose={() => setOpenId(null)} setMessage={setMessage} />}
    </Page>
  );
}
