import { useMemo, useState, useSyncExternalStore } from "react";
import { Banner, Card, DataTable, Dialog, EmptyState, Field, MetricCard, MetricGrid, Page, StatusBadge, Tabs } from "../../components/ui.tsx";
import { formatShortDate, todayISO, TIMEZ_COUNTRIES } from "../../model.ts";
import { getPerson, listPeople, subscribePeople } from "../../data/peopleLocal.ts";
import {
  DOC_TYPES,
  ISSUING_COUNTRIES,
  addDocument,
  canSeeDocument,
  canSeeFullNumber,
  canVerify,
  daysToExpiry,
  docStatus,
  getImmigrationState,
  maskNumber,
  needsSponsor,
  removeDocument,
  setRenewalInProgress,
  subscribeImmigration,
  updateDocument,
  verifyDocument,
  type DocInput,
  type DocStatus,
  type DocType,
  type IdDocument,
} from "./immigrationStore.ts";
import { isHr, type ComplianceActor } from "./shared.ts";
import { PersonPicker, toneFor } from "./ComplianceUi.tsx";
import { useComplianceActor } from "./useActor.ts";
import "./compliance.css";

type Msg = { tone: "ok" | "err" | "warn" | "info"; text: string } | null;

function emptyInput(personId: string): DocInput {
  return { personId, type: "Passport", number: "", issuingCountry: "", issueDate: "", expiryDate: "", sponsor: "", recordExpired: false };
}

function expiryHint(doc: IdDocument): string {
  const days = daysToExpiry(doc);
  if (days < 0) return `${-days} days ago`;
  if (days === 0) return "today";
  return `in ${days} days`;
}

export function ImmigrationPage() {
  const actor = useComplianceActor();
  const state = useSyncExternalStore(subscribeImmigration, getImmigrationState, getImmigrationState);
  useSyncExternalStore(subscribePeople, listPeople, listPeople);
  const hr = isHr(actor.role);
  const [tab, setTab] = useState("mine");
  const [msg, setMsg] = useState<Msg>(null);
  const [editing, setEditing] = useState<{ id?: string; input: DocInput; forOther: boolean } | null>(null);

  const mine = state.documents.filter((d) => d.personId === actor.id);
  const pending = state.documents.filter((d) => d.verification === "Pending verification" && canVerify(actor, d));

  const tabs = [{ id: "mine", label: "My documents" }];
  if (hr) {
    tabs.push({ id: "all", label: "All employees" });
    tabs.push({ id: "verify", label: `Verification queue (${pending.length})` });
  }

  function report(error: string | null, ok: string) {
    setMsg(error ? { tone: "err", text: error } : { tone: "ok", text: ok });
  }

  function openEdit(doc: IdDocument) {
    setEditing({
      id: doc.id,
      forOther: doc.personId !== actor.id,
      input: {
        personId: doc.personId,
        type: doc.type,
        number: doc.number,
        issuingCountry: doc.issuingCountry,
        issueDate: doc.issueDate,
        expiryDate: doc.expiryDate,
        sponsor: doc.sponsor ?? "",
        recordExpired: doc.recordedExpired,
      },
    });
  }

  return (
    <Page
      title="Immigration and ID documents"
      action={
        <button className="btn" type="button" onClick={() => setEditing({ input: emptyInput(actor.id), forOther: false })}>
          Add document
        </button>
      }
    >
      <Banner message={msg} />
      {tabs.length > 1 && <Tabs tabs={tabs} value={tab} onChange={setTab} />}

      {tab === "mine" && (
        <Card title="My documents">
          {mine.length === 0 ? (
            <EmptyState title="No documents yet" description="Add your passport, visa or residence ID to get expiry reminders." />
          ) : (
            <ul className="cmp-list">
              {mine.map((doc) => (
                <DocItem
                  key={doc.id}
                  doc={doc}
                  actor={actor}
                  onEdit={() => openEdit(doc)}
                  onRenewal={(v) => report(setRenewalInProgress(actor, doc.id, v), v ? "Marked as renewal in progress." : "Renewal flag cleared.")}
                  onRemove={() => report(removeDocument(actor, doc.id), "Document removed.")}
                />
              ))}
            </ul>
          )}
        </Card>
      )}

      {tab === "all" && hr && (
        <AllDocuments
          docs={state.documents}
          actor={actor}
          onEdit={openEdit}
          onAdd={() => setEditing({ input: emptyInput(""), forOther: true })}
          onRenewal={(doc, v) => report(setRenewalInProgress(actor, doc.id, v), v ? "Marked as renewal in progress." : "Renewal flag cleared.")}
        />
      )}

      {tab === "verify" && hr && <VerificationQueue docs={pending} actor={actor} onResult={report} />}

      {editing && (
        <DocDialog
          key={editing.id ?? "new"}
          initial={editing.input}
          forOther={editing.forOther}
          editingId={editing.id}
          actorId={actor.id}
          onClose={() => setEditing(null)}
          onSave={(input) => {
            const error = editing.id ? updateDocument(actor, editing.id, input) : addDocument(actor, input);
            if (error) return error;
            const verified = hr && input.personId !== actor.id;
            setMsg({ tone: "ok", text: verified ? "Document saved and verified." : "Document saved — waiting for HR verification." });
            setEditing(null);
            return null;
          }}
        />
      )}
    </Page>
  );
}

function DocItem({
  doc,
  actor,
  onEdit,
  onRenewal,
  onRemove,
}: {
  doc: IdDocument;
  actor: ComplianceActor;
  onEdit: () => void;
  onRenewal: (value: boolean) => void;
  onRemove: () => void;
}) {
  const status = docStatus(doc);
  const canRemove = doc.verification !== "Verified";
  return (
    <li className="cmp-item">
      <div className="cmp-item-head">
        <strong>
          {doc.type} · {doc.issuingCountry}
        </strong>
        <span className="row-gap">
          <StatusBadge status={status} tone={toneFor(status)} literal />
          <StatusBadge status={doc.verification} tone={toneFor(doc.verification)} literal />
        </span>
      </div>
      <div className="cmp-meta">
        <span className="cmp-code">{canSeeFullNumber(actor, doc) ? doc.number : maskNumber(doc.number)}</span>
        <span>Issued {formatShortDate(doc.issueDate)}</span>
        <span>
          Expires {formatShortDate(doc.expiryDate)} ({expiryHint(doc)})
        </span>
        {doc.sponsor && <span>Sponsor: {doc.sponsor}</span>}
      </div>
      {doc.verification === "Rejected" && doc.verificationNote && <p className="note err">Returned by HR: {doc.verificationNote}</p>}
      <div className="cmp-actions">
        <button className="btn-ghost btn-tiny" type="button" onClick={onEdit}>
          Update
        </button>
        <button className="btn-ghost btn-tiny" type="button" onClick={() => onRenewal(!doc.renewalInProgress)}>
          {doc.renewalInProgress ? "Clear renewal flag" : "Renewal in progress"}
        </button>
        {canRemove && (
          <button className="btn-ghost btn-tiny" type="button" onClick={onRemove}>
            Remove
          </button>
        )}
      </div>
    </li>
  );
}

const WINDOWS = [
  { id: "any", label: "Any expiry" },
  { id: "30", label: "Within 30 days" },
  { id: "60", label: "Within 60 days" },
  { id: "90", label: "Within 90 days" },
];

function AllDocuments({
  docs,
  actor,
  onEdit,
  onAdd,
  onRenewal,
}: {
  docs: IdDocument[];
  actor: ComplianceActor;
  onEdit: (doc: IdDocument) => void;
  onAdd: () => void;
  onRenewal: (doc: IdDocument, value: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [country, setCountry] = useState("all");
  const [status, setStatus] = useState<"all" | DocStatus>("all");
  const [type, setType] = useState<"all" | DocType>("all");
  const [expiryWindow, setExpiryWindow] = useState("any");
  const today = todayISO();

  const visible = docs.filter((d) => canSeeDocument(actor, d));
  const counts = useMemo(() => {
    const c = { expired: 0, d30: 0, d60: 0, d90: 0, renewal: 0, pending: 0 };
    for (const d of visible) {
      const s = docStatus(d, today);
      const days = daysToExpiry(d, today);
      if (s === "Expired") c.expired += 1;
      if (s === "Renewal in progress") c.renewal += 1;
      if (days >= 0 && s !== "Renewal in progress") {
        if (days <= 30) c.d30 += 1;
        if (days <= 60) c.d60 += 1;
        if (days <= 90) c.d90 += 1;
      }
      if (d.verification === "Pending verification") c.pending += 1;
    }
    return c;
  }, [visible, today]);

  const rows = visible
    .map((d) => ({ d, person: getPerson(d.personId), s: docStatus(d, today), days: daysToExpiry(d, today) }))
    .filter(({ d, person, s, days }) => {
      const q = query.trim().toLowerCase();
      if (q && !`${person?.fullName ?? ""} ${person?.employeeCode ?? ""}`.toLowerCase().includes(q)) return false;
      if (country !== "all" && person?.countryCode !== country) return false;
      if (status !== "all" && s !== status) return false;
      if (type !== "all" && d.type !== type) return false;
      if (expiryWindow !== "any" && (days < 0 || days > Number(expiryWindow))) return false;
      return true;
    })
    .sort((a, b) => a.days - b.days);

  return (
    <>
      <MetricGrid>
        <MetricCard label="Expired" value={counts.expired} />
        <MetricCard label="Expiring in 30 days" value={counts.d30} />
        <MetricCard label="Expiring in 60 days" value={counts.d60} />
        <MetricCard label="Expiring in 90 days" value={counts.d90} />
        <MetricCard label="Renewal in progress" value={counts.renewal} />
        <MetricCard label="Pending verification" value={counts.pending} />
      </MetricGrid>
      <Card
        title="All employees"
        action={
          <button className="btn-ghost" type="button" onClick={onAdd}>
            Add for employee
          </button>
        }
      >
        <div className="stack">
          <div className="cmp-filters">
            <Field label="Search">
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name or employee ID" />
            </Field>
            <Field label="Country">
              <select value={country} onChange={(e) => setCountry(e.target.value)}>
                <option value="all">All countries</option>
                {TIMEZ_COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Status">
              <select value={status} onChange={(e) => setStatus(e.target.value as "all" | DocStatus)}>
                <option value="all">All statuses</option>
                {(["Valid", "Expiring", "Expired", "Renewal in progress"] as DocStatus[]).map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </Field>
            <Field label="Document">
              <select value={type} onChange={(e) => setType(e.target.value as "all" | DocType)}>
                <option value="all">All types</option>
                {DOC_TYPES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </Field>
            <Field label="Expiring">
              <select value={expiryWindow} onChange={(e) => setExpiryWindow(e.target.value)}>
                {WINDOWS.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <DataTable
            headers={["Employee", "Country", "Document", "Number", "Expiry", "Status", "Verification", ""]}
            empty={<EmptyState title="No matching documents" description="Try a different filter." />}
            rows={rows.map(({ d, person, s }) => [
              <span key="p">
                {person?.fullName ?? "Unknown"}
                <br />
                <small className="muted">{person?.employeeCode}</small>
              </span>,
              person?.countryName ?? "—",
              <span key="t">
                {d.type}
                <br />
                <small className="muted">{d.issuingCountry}</small>
              </span>,
              <span key="n" className="cmp-code">
                {canSeeFullNumber(actor, d) ? d.number : maskNumber(d.number)}
              </span>,
              <span key="e">
                {formatShortDate(d.expiryDate)}
                <br />
                <small className="muted">{expiryHint(d)}</small>
              </span>,
              <StatusBadge key="s" status={s} tone={toneFor(s)} literal />,
              <StatusBadge key="v" status={d.verification} tone={toneFor(d.verification)} literal />,
              <span key="a" className="cmp-actions">
                <button className="btn-ghost btn-tiny" type="button" onClick={() => onEdit(d)}>
                  Edit
                </button>
                <button className="btn-ghost btn-tiny" type="button" onClick={() => onRenewal(d, !d.renewalInProgress)}>
                  {d.renewalInProgress ? "Clear renewal" : "Mark renewal"}
                </button>
              </span>,
            ])}
          />
        </div>
      </Card>
    </>
  );
}

function VerificationQueue({ docs, actor, onResult }: { docs: IdDocument[]; actor: ComplianceActor; onResult: (error: string | null, ok: string) => void }) {
  const [returning, setReturning] = useState<IdDocument | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");

  if (docs.length === 0) {
    return (
      <Card title="Verification queue">
        <EmptyState title="Nothing to verify" description="New and updated documents appear here." />
      </Card>
    );
  }
  return (
    <Card title="Verification queue">
      <ul className="approval-list">
        {docs.map((d) => {
          const person = getPerson(d.personId);
          return (
            <li key={d.id} className="approval-item">
              <div className="row-between">
                <strong>
                  {person?.fullName ?? "Unknown"} · {d.type}
                </strong>
                <StatusBadge status={docStatus(d)} tone={toneFor(docStatus(d))} literal />
              </div>
              <p className="muted">
                <span className="cmp-code">{d.number}</span> · {d.issuingCountry} · {formatShortDate(d.issueDate)} to {formatShortDate(d.expiryDate)}
                {d.sponsor ? ` · Sponsor: ${d.sponsor}` : ""}
              </p>
              <div className="approval-actions cmp-actions">
                <button className="btn btn-tiny" type="button" onClick={() => onResult(verifyDocument(actor, d.id, "Verified"), "Document verified.")}>
                  Verify
                </button>
                <button
                  className="btn-ghost btn-tiny"
                  type="button"
                  onClick={() => {
                    setReturning(d);
                    setReason("");
                    setError("");
                  }}
                >
                  Return
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <Dialog
        open={!!returning}
        title="Return document"
        onClose={() => setReturning(null)}
        actions={
          <>
            <button className="btn-ghost" type="button" onClick={() => setReturning(null)}>
              Cancel
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => {
                if (!returning) return;
                const err = verifyDocument(actor, returning.id, "Rejected", reason);
                if (err) return setError(err);
                onResult(null, "Document returned to the employee.");
                setReturning(null);
              }}
            >
              Return
            </button>
          </>
        }
      >
        <div className="stack">
          {error && <p className="note err">{error}</p>}
          <Field label="Reason">
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Scan is unreadable" />
          </Field>
        </div>
      </Dialog>
    </Card>
  );
}

function DocDialog({
  initial,
  forOther,
  editingId,
  actorId,
  onClose,
  onSave,
}: {
  initial: DocInput;
  forOther: boolean;
  editingId?: string;
  actorId: string;
  onClose: () => void;
  onSave: (input: DocInput) => string | null;
}) {
  const [form, setForm] = useState<DocInput>(initial);
  const [error, setError] = useState("");
  const set = <K extends keyof DocInput>(key: K, value: DocInput[K]) => setForm((f) => ({ ...f, [key]: value }));
  const sponsorNeeded = needsSponsor(form.type, form.issuingCountry);
  const expired = !!form.expiryDate && form.expiryDate < todayISO();

  return (
    <Dialog
      open
      title={editingId ? "Update document" : "Add document"}
      onClose={onClose}
      actions={
        <>
          <button className="btn-ghost" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => {
              if (forOther && !form.personId) return setError("Choose the employee.");
              if (forOther && form.personId === actorId) return setError("Use My documents for your own records.");
              const err = onSave(form);
              if (err) setError(err);
            }}
          >
            Save
          </button>
        </>
      }
    >
      <div className="stack">
        {error && <p className="note err">{error}</p>}
        <div className="cmp-form">
          {forOther && !editingId && (
            <Field label="Employee" wide>
              <PersonPicker value={form.personId} onChange={(id) => set("personId", id)} excludeId={actorId} />
            </Field>
          )}
          <Field label="Document type">
            <select value={form.type} onChange={(e) => set("type", e.target.value as DocType)}>
              {DOC_TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </Field>
          <Field label="Issuing country">
            <select value={form.issuingCountry} onChange={(e) => set("issuingCountry", e.target.value)}>
              <option value="">Choose…</option>
              {ISSUING_COUNTRIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="Document number" wide>
            <input value={form.number} onChange={(e) => set("number", e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Issue date">
            <input type="date" value={form.issueDate} max={todayISO()} onChange={(e) => set("issueDate", e.target.value)} />
          </Field>
          <Field label="Expiry date">
            <input type="date" value={form.expiryDate} min={form.issueDate || undefined} onChange={(e) => set("expiryDate", e.target.value)} />
          </Field>
          {sponsorNeeded && (
            <Field label="Sponsor" wide>
              <input value={form.sponsor} onChange={(e) => set("sponsor", e.target.value)} placeholder="e.g. Infotech FZ-LLC" />
            </Field>
          )}
          {expired && (
            <label className="cmp-check" style={{ gridColumn: "1 / -1" }}>
              <input type="checkbox" checked={form.recordExpired} onChange={(e) => set("recordExpired", e.target.checked)} />
              Record expired document
            </label>
          )}
        </div>
        {!forOther && <p className="muted">HR verifies new and updated documents.</p>}
      </div>
    </Dialog>
  );
}
