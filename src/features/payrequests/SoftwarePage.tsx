import { useMemo, useState, useSyncExternalStore } from "react";
import { ActionButton, Banner, Card, DataTable, Dialog, EmptyState, Field, Page, StatusBadge, SubmitButton, Tabs, useAction } from "../../components/ui.tsx";
import { money } from "../../countryPay.ts";
import { hasReports } from "../../data/delegations.ts";
import { listPeople, subscribePeople } from "../../data/peopleLocal.ts";
import { formatShortDate } from "../../model.ts";
import { usePortal } from "../../store.tsx";
import {
  decideSoftware,
  endSoftware,
  getSoftwareSnapshot,
  requestSoftware,
  softwareTitles,
  softwareViews,
  subscribeSoftware,
  updateTitle,
  type SoftwareTitle,
  type SoftwareView,
} from "./softwareStore.ts";
import { isItRole, waitingOn } from "./rules.ts";
import { DecideBar, Tracker, approvalStages } from "./Tracker.tsx";

type Msg = { tone: "ok" | "err" | "warn" | "info"; text: string } | null;

const DURATIONS: { value: string; label: string }[] = [
  { value: "", label: "Ongoing" },
  { value: "1", label: "1 month" },
  { value: "3", label: "3 months" },
  { value: "6", label: "6 months" },
  { value: "12", label: "12 months" },
];

const OPEN = new Set(["Submitted", "Manager approved"]);

function tone(s: SoftwareView["status"]): "ok" | "warn" | "danger" | "neutral" | "info" {
  if (s === "Active") return "ok";
  if (OPEN.has(s)) return "warn";
  if (s === "Rejected" || s === "Revoked") return "danger";
  return "neutral";
}

function SeatMeter({ t }: { t: SoftwareTitle }) {
  if (!t.seats) return <span className="muted">{t.seatsUsed} in use · no seat limit</span>;
  const pct = Math.min(100, Math.round((t.seatsUsed / t.seats) * 100));
  return (
    <div>
      <div className={`pr-meter${t.seatsUsed >= t.seats ? " full" : ""}`} aria-label={`${t.seatsUsed} of ${t.seats} seats used`}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <span className="muted">
        {t.seatsUsed} of {t.seats} seats used
      </span>
    </div>
  );
}

function RequestDialog({ title, onClose, onMessage }: { title: SoftwareTitle; onClose: () => void; onMessage: (m: Msg) => void }) {
  const { demoProfile } = usePortal();
  const [reason, setReason] = useState("");
  const [duration, setDuration] = useState("");
  const act = useAction();
  const full = title.seats > 0 && title.seatsUsed >= title.seats;
  return (
    <Dialog open title={title.needsApproval ? `Request ${title.name}` : `Get ${title.name}`} onClose={onClose}>
      <form
        className="pr-form"
        onSubmit={act.submit(
          async () => {
            const error = await requestSoftware(demoProfile, { titleId: title.id, reason, durationMonths: duration ? Number(duration) : null });
            onMessage(error ? { tone: "err", text: error } : { tone: "ok", text: title.needsApproval ? `${title.name} sent for approval.` : `${title.name} is ready to use.` });
            if (!error) onClose();
            return error ?? true;
          },
          { success: title.needsApproval ? `${title.name} requested.` : `${title.name} assigned to you.`, toastError: true },
        )}
      >
        <p className="pr-note" style={{ margin: 0 }}>
          {title.vendor} · {money(title.monthlyCost, title.currency)} a month ·{" "}
          {title.needsApproval ? "needs manager and IT approval" : full ? "no seats left" : "granted straight away"}
        </p>
        <Field label="Why you need it">
          <textarea rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Field label="For how long">
          <select value={duration} onChange={(e) => setDuration(e.target.value)}>
            {DURATIONS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </Field>
        <div className="pr-actions">
          <SubmitButton action={act} className="btn" disabled={full && !title.needsApproval}>
            {title.needsApproval ? "Send request" : "Get it now"}
          </SubmitButton>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function RequestCard({ v, actorId, onMessage }: { v: SoftwareView; actorId: string; onMessage: (m: Msg) => void }) {
  const { demoProfile } = usePortal();
  const mine = v.employeeId === actorId;
  const closed = v.status === "Withdrawn" ? "withdrawn" : v.status === "Rejected" ? "rejected" : null;
  const ended = v.status === "Returned" || v.status === "Revoked" || v.status === "Expired";
  return (
    <article className="pr-item">
      <div className="pr-item-head">
        <div>
          <h3>{mine ? v.titleName : `${v.employeeName} · ${v.titleName}`}</h3>
          <p>
            {v.category} · {money(v.monthlyCost, v.currency)} a month · {v.durationMonths ? `${v.durationMonths} months` : "ongoing"}
            {v.direct ? " · assigned by IT" : ""}
          </p>
        </div>
        <StatusBadge status={OPEN.has(v.status) ? "Waiting" : v.status} tone={tone(v.status)} literal />
      </div>
      {v.reason && <p className="muted" style={{ margin: 0 }}>{v.reason}</p>}
      {v.steps.length > 0 && (
        <Tracker
          label="Request progress"
          stages={approvalStages({
            submittedOn: v.submittedOn,
            steps: v.steps,
            closed,
            after: [
              {
                label: "Licence",
                state: v.status === "Active" || ended ? "done" : "todo",
                detail: v.assignedOn ? `Since ${formatShortDate(v.assignedOn)}` : undefined,
              },
            ],
          })}
        />
      )}
      {(v.status === "Active" || ended) && (
        <dl className="lc-facts">
          <div>
            <dt>Licence</dt>
            <dd>{v.licenceKey ?? "—"}</dd>
          </div>
          <div>
            <dt>Since</dt>
            <dd>{v.assignedOn ? formatShortDate(v.assignedOn) : "—"}</dd>
          </div>
          <div>
            <dt>{ended ? "Ended" : "Ends"}</dt>
            <dd>{ended ? `${v.endedOn ? formatShortDate(v.endedOn) : v.expiresOn ? formatShortDate(v.expiresOn) : "—"}${v.endedBy ? ` · ${v.endedBy}` : ""}` : v.expiresOn ? formatShortDate(v.expiresOn) : "No end date"}</dd>
          </div>
        </dl>
      )}
      {v.canDecide && (
        <DecideBar
          onDecide={async (decision, note) => {
            const error = await decideSoftware(demoProfile, v.id, decision, note);
            onMessage(error ? { tone: "err", text: error } : { tone: "ok", text: decision === "approve" ? `Approved ${v.titleName} for ${v.employeeName}.` : "Declined." });
            return error;
          }}
        />
      )}
      {(v.canWithdraw || v.canReturn || v.canRevoke) && (
        <div className="pr-actions">
          {v.canWithdraw && <span className="muted">{waitingOn(v.steps) ? `With ${waitingOn(v.steps)}` : ""}</span>}
          <span className="spacer" />
          {v.canWithdraw && (
            <ActionButton className="btn-ghost btn-tiny" toastError success="Request withdrawn." onAction={async () => (await endSoftware(demoProfile, v.id, "Withdrawn")) ?? true}>
              Withdraw
            </ActionButton>
          )}
          {v.canReturn && (
            <ActionButton className="btn-ghost btn-tiny" toastError doneLabel="Returned" success={`${v.titleName} returned.`} onAction={async () => (await endSoftware(demoProfile, v.id, "Returned")) ?? true}>
              Return licence
            </ActionButton>
          )}
          {v.canRevoke && (
            <ActionButton className="btn-ghost btn-tiny" toastError busyLabel="Revoking…" doneLabel="Revoked" success={`${v.titleName} revoked for ${v.employeeName}.`} onAction={async () => (await endSoftware(demoProfile, v.id, "Revoked")) ?? true}>
              Revoke
            </ActionButton>
          )}
        </div>
      )}
    </article>
  );
}

function SeatsEditor({ t }: { t: SoftwareTitle }) {
  const { demoProfile } = usePortal();
  const [seats, setSeats] = useState(String(t.seats));
  return (
    <span className="pr-actions">
      <input type="number" min={0} value={seats} onChange={(e) => setSeats(e.target.value)} style={{ width: 80 }} aria-label={`Seats for ${t.name}`} />
      <ActionButton className="btn-ghost btn-tiny" toastError success={`${t.name} seats updated.`} onAction={async () => (await updateTitle(demoProfile, t.id, { seats: Number(seats) })) ?? true}>
        Save
      </ActionButton>
    </span>
  );
}

function AssignForm({ titles, onMessage }: { titles: SoftwareTitle[]; onMessage: (m: Msg) => void }) {
  const { demoProfile } = usePortal();
  const people = useSyncExternalStore(subscribePeople, listPeople, listPeople);
  const [who, setWho] = useState("");
  const [titleId, setTitleId] = useState("");
  const [duration, setDuration] = useState("");
  const act = useAction();
  const person = people.find((p) => `${p.fullName} (${p.employeeCode || p.id})` === who);
  return (
    <form
      className="pr-grid"
      onSubmit={act.submit(
        async () => {
          if (!person) return "Pick a person from the list.";
          if (!titleId) return "Pick the software.";
          const error = await requestSoftware(demoProfile, { titleId, reason: "", durationMonths: duration ? Number(duration) : null, employeeId: person.id, employeeName: person.fullName });
          onMessage(error ? { tone: "err", text: error } : { tone: "ok", text: `Assigned to ${person.fullName}.` });
          if (!error) setWho("");
          return error ?? true;
        },
        { success: "Licence assigned.", toastError: true },
      )}
    >
      <Field label="Person">
        <input list="sw-people" value={who} onChange={(e) => setWho(e.target.value)} placeholder="Start typing a name" />
        <datalist id="sw-people">
          {people
            .filter((p) => p.employmentStatus !== "Terminated")
            .slice(0, 600)
            .map((p) => (
              <option key={p.id} value={`${p.fullName} (${p.employeeCode || p.id})`} />
            ))}
        </datalist>
      </Field>
      <Field label="Software">
        <select value={titleId} onChange={(e) => setTitleId(e.target.value)}>
          <option value="">Choose</option>
          {titles.filter((t) => t.active).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="For how long">
        <select value={duration} onChange={(e) => setDuration(e.target.value)}>
          {DURATIONS.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </select>
      </Field>
      <div className="pr-actions" style={{ alignSelf: "end" }}>
        <SubmitButton action={act} className="btn">
          Assign licence
        </SubmitButton>
      </div>
    </form>
  );
}

export function SoftwareCataloguePage() {
  const { demoProfile } = usePortal();
  const snapshot = useSyncExternalStore(subscribeSoftware, getSoftwareSnapshot, getSoftwareSnapshot);
  const titles = useMemo(() => softwareTitles(), [snapshot]);
  const rows = useMemo(() => softwareViews(demoProfile), [snapshot, demoProfile]);
  const [message, setMessage] = useState<Msg>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [picked, setPicked] = useState<SoftwareTitle | null>(null);
  const it = isItRole(demoProfile.role);
  const mine = rows.filter((r) => r.employeeId === demoProfile.id);
  const toAct = rows.filter((r) => r.employeeId !== demoProfile.id && r.canDecide);
  const showApprove = toAct.length > 0 || hasReports(demoProfile.id) || it;
  const [tab, setTab] = useState("catalogue");
  const categories = [...new Set(titles.map((t) => t.category))].sort();
  const q = query.trim().toLowerCase();
  const shown = titles.filter(
    (t) => t.active && (!category || t.category === category) && (!q || `${t.name} ${t.vendor} ${t.category}`.toLowerCase().includes(q)),
  );
  const holding = (id: string) => mine.find((r) => r.titleId === id && (r.status === "Active" || OPEN.has(r.status)));
  const active = mine.filter((r) => r.status === "Active");
  const monthly = active.reduce((s, r) => s + r.monthlyCost, 0);
  const licences = rows.filter((r) => r.status === "Active" && r.employeeId !== demoProfile.id);

  return (
    <Page title="Software">
      <Banner message={message} />
      <Tabs
        tabs={[
          { id: "catalogue", label: "Catalogue" },
          { id: "mine", label: `My software (${active.length})` },
          ...(showApprove ? [{ id: "act", label: `To approve (${toAct.length})` }] : []),
          ...(it ? [{ id: "licences", label: "Licences" }] : []),
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "catalogue" && (
        <Card>
          <div className="pr-form">
            <div className="pr-grid">
              <Field label="Search">
                <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name, vendor or category" />
              </Field>
              <Field label="Category">
                <select value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="">All</option>
                  {categories.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </Field>
            </div>
            {shown.length === 0 ? (
              <EmptyState title="No software matches" />
            ) : (
              <div className="pr-catalogue">
                {shown.map((t) => {
                  const held = holding(t.id);
                  const full = t.seats > 0 && t.seatsUsed >= t.seats;
                  return (
                    <article key={t.id} className={`pr-app${held ? " picked" : ""}`}>
                      <h3>{t.name}</h3>
                      <span className="meta">
                        {t.vendor} · {money(t.monthlyCost, t.currency)}/month
                      </span>
                      <span className="tags">
                        <span className="pill" style={{ textTransform: "none" }}>{t.category}</span>
                        <span className="pill">{t.needsApproval ? "Needs approval" : "Instant"}</span>
                      </span>
                      <SeatMeter t={t} />
                      {held ? (
                        <StatusBadge status={held.status === "Active" ? "You have it" : "Requested"} tone={held.status === "Active" ? "ok" : "warn"} literal />
                      ) : (
                        <button type="button" className="btn btn-tiny" disabled={full && !t.needsApproval} onClick={() => setPicked(t)}>
                          {full && !t.needsApproval ? "No seats left" : t.needsApproval ? "Request" : "Get it"}
                        </button>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </Card>
      )}
      {tab === "mine" && (
        <>
          <Card title="My software">
            {active.length === 0 ? (
              <EmptyState title="No licences yet" description="Pick something from the catalogue." />
            ) : (
              <div className="pr-form">
                <p className="muted" style={{ margin: 0 }}>
                  {active.length} licence{active.length === 1 ? "" : "s"} · {money(Math.round(monthly * 100) / 100, active[0]?.currency ?? "USD")} a month to the company
                </p>
                <div className="pr-list">
                  {active.map((v) => (
                    <RequestCard key={v.id} v={v} actorId={demoProfile.id} onMessage={setMessage} />
                  ))}
                </div>
              </div>
            )}
          </Card>
          {mine.some((r) => r.status !== "Active") && (
            <Card title="Requests and history">
              <div className="pr-list">
                {mine
                  .filter((r) => r.status !== "Active")
                  .map((v) => (
                    <RequestCard key={v.id} v={v} actorId={demoProfile.id} onMessage={setMessage} />
                  ))}
              </div>
            </Card>
          )}
        </>
      )}
      {tab === "act" && showApprove && (
        <Card title="To approve">
          {toAct.length === 0 ? (
            <EmptyState title="Nothing waiting on you" />
          ) : (
            <div className="pr-list">
              {toAct.map((v) => (
                <RequestCard key={v.id} v={v} actorId={demoProfile.id} onMessage={setMessage} />
              ))}
            </div>
          )}
        </Card>
      )}
      {tab === "licences" && it && (
        <>
          <Card title="Assign a licence">
            <AssignForm titles={titles} onMessage={setMessage} />
          </Card>
          <Card title="Seats">
            <DataTable
              headers={["Software", "Approval", "In use", "Seats (0 = no limit)", "Monthly cost"]}
              rows={titles.map((t) => [
                t.name,
                t.needsApproval ? "Manager + IT" : "Instant",
                <SeatMeter t={t} />,
                <SeatsEditor key={`${t.id}-${t.seats}`} t={t} />,
                money(Math.round(t.monthlyCost * t.seatsUsed * 100) / 100, t.currency),
              ])}
            />
          </Card>
          <Card title={`Active licences (${licences.length})`}>
            {licences.length === 0 ? (
              <EmptyState title="No licences in use" />
            ) : (
              <DataTable
                headers={["Person", "Software", "Licence", "Since", "Ends", ""]}
                rows={licences.map((v) => [
                  v.employeeName,
                  v.titleName,
                  v.licenceKey ?? "—",
                  v.assignedOn ? formatShortDate(v.assignedOn) : "—",
                  v.expiresOn ? formatShortDate(v.expiresOn) : "No end date",
                  v.canRevoke ? (
                    <ActionButton className="btn-ghost btn-tiny" toastError busyLabel="Revoking…" doneLabel="Revoked" success={`${v.titleName} revoked for ${v.employeeName}.`} onAction={async () => (await endSoftware(demoProfile, v.id, "Revoked")) ?? true}>
                      Revoke
                    </ActionButton>
                  ) : (
                    ""
                  ),
                ])}
              />
            )}
          </Card>
        </>
      )}
      {picked && <RequestDialog title={picked} onClose={() => setPicked(null)} onMessage={setMessage} />}
    </Page>
  );
}
