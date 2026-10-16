import { useState, useSyncExternalStore, type FormEvent } from "react";
import { Banner, Card, DataTable, Dialog, EmptyState, Field, MetricCard, MetricGrid, Page, StatusBadge, Tabs } from "../../components/ui.tsx";
import { usePortal } from "../../store.tsx";
import { todayISO, TIMEZ_COUNTRIES } from "../../model.ts";
import { findDemoById } from "../../demoAccounts.ts";
import {
  assignableManagers,
  canManageVendors,
  cancelExtension,
  contractorStatus,
  CURRENCIES,
  decideExtension,
  endingSoonFor,
  ENDING_SOON_DAYS,
  getContractorState,
  removeContractor,
  removeVendor,
  requestExtension,
  saveContractor,
  saveVendor,
  subscribeContractors,
  vendorById,
  visibleContractors,
  type Contractor,
  type ContractorInput,
  type ContractorStatus,
  type ExtensionRequest,
  type Vendor,
  type VendorInput,
} from "./contractorsStore.ts";
import { daysBetween, fmt, isHrRole, type WorkforceActor } from "./workforceShared.ts";
import "./workforce.css";

type Msg = { tone: "ok" | "err" | "warn" | "info"; text: string } | null;

function useContractors() {
  return useSyncExternalStore(subscribeContractors, getContractorState, getContractorState);
}

function result(error: string | null, ok: string): Msg {
  return error ? { tone: "err", text: error } : { tone: "ok", text: ok };
}

const STATUS_TONE: Record<ContractorStatus, "ok" | "warn" | "danger" | "info"> = {
  Upcoming: "info",
  Active: "ok",
  "Ending soon": "warn",
  Ended: "danger",
};

const EXT_TONE: Record<ExtensionRequest["status"], "ok" | "warn" | "danger" | "neutral"> = {
  pending: "warn",
  approved: "ok",
  rejected: "danger",
  cancelled: "neutral",
};

const EXT_LABEL: Record<ExtensionRequest["status"], string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

function money(amount: number, currency: string) {
  return `${currency} ${amount.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

const managerName = (id: string) => findDemoById(id)?.fullName ?? id;

export function ContractorsPage() {
  const { demoProfile } = usePortal();
  const actor: WorkforceActor = demoProfile;
  const data = useContractors();
  const admin = canManageVendors(actor.role);
  const hr = isHrRole(actor.role);
  const mine = visibleContractors(actor, data);
  const pendingForHr = hr ? data.extensions.filter((e) => e.status === "pending" && e.requestedById !== actor.id).length : 0;
  const tabs = [
    { id: "contractors", label: "Contractors" },
    ...(admin ? [{ id: "vendors", label: "Vendors" }] : []),
    { id: "extensions", label: pendingForHr ? `Extensions (${pendingForHr})` : "Extensions" },
  ];
  const [tab, setTab] = useState("contractors");
  const active = tabs.some((t) => t.id === tab) ? tab : "contractors";
  const ending = endingSoonFor(actor, data);

  return (
    <Page title="Contractors & vendors">
      {ending.length > 0 && (
        <p className="note wf-warn">
          {`${ending.length} contract${ending.length === 1 ? " ends" : "s end"} within ${ENDING_SOON_DAYS} days: ${ending
            .map((c) => `${c.name} (${fmt(c.endDate)})`)
            .join(", ")}.`}
        </p>
      )}
      <MetricGrid>
        <MetricCard label="Active" value={mine.filter((c) => contractorStatus(c) === "Active" || contractorStatus(c) === "Ending soon").length} />
        <MetricCard label="Ending soon" value={ending.length} hint={`Within ${ENDING_SOON_DAYS} days`} />
        {admin && <MetricCard label="Vendors" value={data.vendors.length} />}
      </MetricGrid>
      <Tabs tabs={tabs} value={active} onChange={setTab} />
      {active === "contractors" && <ContractorList actor={actor} />}
      {active === "vendors" && admin && <VendorList actor={actor} />}
      {active === "extensions" && <Extensions actor={actor} />}
    </Page>
  );
}

// ---------- contractors ----------

function blankContractor(vendor?: Vendor): ContractorInput {
  return { name: "", vendorId: vendor?.id ?? "", managerId: "", project: "", startDate: todayISO(), endDate: "", dailyRate: 0 };
}

function ContractorList({ actor }: { actor: WorkforceActor }) {
  const data = useContractors();
  const admin = canManageVendors(actor.role);
  const list = visibleContractors(actor, data);
  const [msg, setMsg] = useState<Msg>(null);
  const [form, setForm] = useState<ContractorInput | null>(null);
  const [rateText, setRateText] = useState("");
  const [extendFor, setExtendFor] = useState<Contractor | null>(null);
  const [newEnd, setNewEnd] = useState("");
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  function openForm(c?: Contractor) {
    setForm(c ? { ...c } : blankContractor(data.vendors[0]));
    setRateText(c ? String(c.dailyRate) : "");
    setFormError(null);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    const rate = rateText.trim() === "" ? NaN : Number(rateText);
    const error = saveContractor(actor, { ...form, dailyRate: rate });
    if (error) return setFormError(error);
    setMsg({ tone: "ok", text: form.id ? `${form.name.trim()} updated.` : `${form.name.trim()} added.` });
    setForm(null);
  }

  function submitExtension(e: FormEvent) {
    e.preventDefault();
    if (!extendFor) return;
    const error = requestExtension(actor, extendFor.id, newEnd, reason);
    if (error) return setFormError(error);
    setMsg({ tone: "ok", text: `Extension for ${extendFor.name} sent to HR.` });
    setExtendFor(null);
  }

  const vendor = form ? vendorById(form.vendorId, data) : undefined;

  return (
    <>
      <Banner message={msg} />
      <Card
        title="Contractors"
        action={
          admin && data.vendors.length > 0 ? (
            <button className="btn btn-tiny" type="button" onClick={() => openForm()}>
              Add contractor
            </button>
          ) : undefined
        }
      >
        <DataTable
          headers={["Name", "Vendor", "Manager", "Project", "Dates", "Daily rate", "Status", ""]}
          rows={list.map((c) => {
            const v = vendorById(c.vendorId, data);
            const status = contractorStatus(c);
            const left = daysBetween(todayISO(), c.endDate);
            return [
              <strong key="n">{c.name}</strong>,
              v?.name ?? "—",
              managerName(c.managerId),
              c.project,
              `${fmt(c.startDate)} – ${fmt(c.endDate)}`,
              v ? money(c.dailyRate, v.currency) : String(c.dailyRate),
              <span key="s" className="wf-block">
                <StatusBadge status={status} tone={STATUS_TONE[status]} literal />
                {status === "Ending soon" && <span className="muted wf-block">{left === 0 ? "Ends today" : `${left} days left`}</span>}
              </span>,
              <div key="a" className="row-gap">
                {c.managerId === actor.id && status !== "Ended" && (
                  <button
                    className="btn-ghost btn-tiny"
                    type="button"
                    onClick={() => {
                      setExtendFor(c);
                      setNewEnd("");
                      setReason("");
                      setFormError(null);
                    }}
                  >
                    Request extension
                  </button>
                )}
                {admin && (
                  <>
                    <button className="btn-ghost btn-tiny" type="button" onClick={() => openForm(c)}>
                      Edit
                    </button>
                    <button
                      className="btn-ghost btn-tiny"
                      type="button"
                      onClick={() => {
                        if (window.confirm(`Remove ${c.name}?`)) setMsg(result(removeContractor(actor, c.id), `${c.name} removed.`));
                      }}
                    >
                      Remove
                    </button>
                  </>
                )}
              </div>,
            ];
          })}
          empty={<EmptyState title="No contractors" description={admin ? "Add a vendor, then add contractors." : "No contractors report to you."} />}
        />
      </Card>

      <Dialog
        open={!!form}
        title={form?.id ? "Edit contractor" : "Add contractor"}
        onClose={() => setForm(null)}
        actions={
          <>
            <button className="btn-ghost" type="button" onClick={() => setForm(null)}>
              Cancel
            </button>
            <button className="btn" type="submit" form="wf-contractor-form">
              Save
            </button>
          </>
        }
      >
        {form && (
          <form id="wf-contractor-form" className="stack" onSubmit={submit}>
            <Banner message={formError ? { tone: "err", text: formError } : null} />
            <div className="form-grid-2">
              <Field label="Name">
                <input value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </Field>
              <Field label="Vendor">
                <select value={form.vendorId} onChange={(e) => setForm({ ...form, vendorId: e.target.value })}>
                  <option value="">Pick a vendor</option>
                  {data.vendors.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Manager">
                <select value={form.managerId} onChange={(e) => setForm({ ...form, managerId: e.target.value })}>
                  <option value="">Pick a manager</option>
                  {assignableManagers().map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.fullName}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Project">
                <input value={form.project} maxLength={80} onChange={(e) => setForm({ ...form, project: e.target.value })} />
              </Field>
              <Field label="Start date">
                <input type="date" value={form.startDate} min={vendor?.contractStart} max={vendor?.contractEnd} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
              </Field>
              <Field label="End date">
                <input type="date" value={form.endDate} min={vendor?.contractStart} max={vendor?.contractEnd} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
              </Field>
              <Field label={`Daily rate${vendor ? ` (${vendor.currency})` : ""}`}>
                <input type="number" min={0} step="0.01" inputMode="decimal" value={rateText} onChange={(e) => setRateText(e.target.value)} />
              </Field>
            </div>
            {vendor && <p className="muted">Vendor contract: {fmt(vendor.contractStart)} – {fmt(vendor.contractEnd)}</p>}
          </form>
        )}
      </Dialog>

      <Dialog
        open={!!extendFor}
        title={extendFor ? `Extend ${extendFor.name}` : "Extend contract"}
        onClose={() => setExtendFor(null)}
        actions={
          <>
            <button className="btn-ghost" type="button" onClick={() => setExtendFor(null)}>
              Cancel
            </button>
            <button className="btn" type="submit" form="wf-extension-form">
              Send to HR
            </button>
          </>
        }
      >
        {extendFor && (
          <form id="wf-extension-form" className="stack" onSubmit={submitExtension}>
            <Banner message={formError ? { tone: "err", text: formError } : null} />
            <p className="muted">
              Ends {fmt(extendFor.endDate)} · vendor contract ends {fmt(vendorById(extendFor.vendorId, data)?.contractEnd ?? extendFor.endDate)}
            </p>
            <Field label="New end date">
              <input type="date" value={newEnd} min={extendFor.endDate} max={vendorById(extendFor.vendorId, data)?.contractEnd} onChange={(e) => setNewEnd(e.target.value)} />
            </Field>
            <Field label="Reason">
              <input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </form>
        )}
      </Dialog>
    </>
  );
}

// ---------- vendors ----------

const BLANK_VENDOR: VendorInput = { name: "", countryCode: "IN", contactEmail: "", contractStart: "", contractEnd: "", currency: "INR" };

function VendorList({ actor }: { actor: WorkforceActor }) {
  const data = useContractors();
  const [msg, setMsg] = useState<Msg>(null);
  const [form, setForm] = useState<VendorInput | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    const error = saveVendor(actor, form);
    if (error) return setFormError(error);
    setMsg({ tone: "ok", text: form.id ? `${form.name.trim()} updated.` : `${form.name.trim()} added.` });
    setForm(null);
  }

  return (
    <>
      <Banner message={msg} />
      <Card
        title="Vendors"
        action={
          <button className="btn btn-tiny" type="button" onClick={() => { setForm({ ...BLANK_VENDOR }); setFormError(null); }}>
            Add vendor
          </button>
        }
      >
        <DataTable
          headers={["Vendor", "Country", "Contact", "Contract", "Currency", "Contractors", ""]}
          rows={data.vendors.map((v) => [
            <strong key="n">{v.name}</strong>,
            TIMEZ_COUNTRIES.find((c) => c.code === v.countryCode)?.name ?? v.countryCode,
            <a key="e" href={`mailto:${v.contactEmail}`}>{v.contactEmail}</a>,
            <span key="d">
              {fmt(v.contractStart)} – {fmt(v.contractEnd)}
              {v.contractEnd < todayISO() && <span className="wf-block"><StatusBadge status="Expired" tone="danger" literal /></span>}
            </span>,
            v.currency,
            data.contractors.filter((c) => c.vendorId === v.id).length,
            <div key="a" className="row-gap">
              <button className="btn-ghost btn-tiny" type="button" onClick={() => { setForm({ ...v }); setFormError(null); }}>
                Edit
              </button>
              <button
                className="btn-ghost btn-tiny"
                type="button"
                onClick={() => {
                  if (window.confirm(`Remove ${v.name}?`)) setMsg(result(removeVendor(actor, v.id), `${v.name} removed.`));
                }}
              >
                Remove
              </button>
            </div>,
          ])}
          empty={<EmptyState title="No vendors yet" />}
        />
      </Card>
      <Dialog
        open={!!form}
        title={form?.id ? "Edit vendor" : "Add vendor"}
        onClose={() => setForm(null)}
        actions={
          <>
            <button className="btn-ghost" type="button" onClick={() => setForm(null)}>
              Cancel
            </button>
            <button className="btn" type="submit" form="wf-vendor-form">
              Save
            </button>
          </>
        }
      >
        {form && (
          <form id="wf-vendor-form" className="stack" onSubmit={submit}>
            <Banner message={formError ? { tone: "err", text: formError } : null} />
            <div className="form-grid-2">
              <Field label="Vendor name">
                <input value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </Field>
              <Field label="Country">
                <select value={form.countryCode} onChange={(e) => setForm({ ...form, countryCode: e.target.value })}>
                  {TIMEZ_COUNTRIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Contact email">
                <input type="email" value={form.contactEmail} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} />
              </Field>
              <Field label="Rate card currency">
                <select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Contract start">
                <input type="date" value={form.contractStart} onChange={(e) => setForm({ ...form, contractStart: e.target.value })} />
              </Field>
              <Field label="Contract end">
                <input type="date" value={form.contractEnd} min={form.contractStart || undefined} onChange={(e) => setForm({ ...form, contractEnd: e.target.value })} />
              </Field>
            </div>
          </form>
        )}
      </Dialog>
    </>
  );
}

// ---------- extensions ----------

function Extensions({ actor }: { actor: WorkforceActor }) {
  const data = useContractors();
  const hr = isHrRole(actor.role);
  const [msg, setMsg] = useState<Msg>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const name = (e: ExtensionRequest) => data.contractors.find((c) => c.id === e.contractorId)?.name ?? "Removed contractor";
  const pending = hr ? data.extensions.filter((e) => e.status === "pending" && e.requestedById !== actor.id) : [];
  const history = data.extensions.filter((e) => (hr ? true : e.requestedById === actor.id));

  return (
    <>
      <Banner message={msg} />
      {hr && (
        <Card title="Waiting for HR">
          {pending.length === 0 ? (
            <EmptyState title="Nothing to decide" />
          ) : (
            <ul className="approval-list">
              {pending.map((e) => {
                const c = data.contractors.find((x) => x.id === e.contractorId);
                const v = c ? vendorById(c.vendorId, data) : undefined;
                return (
                  <li key={e.id} className="approval-item">
                    <strong>{name(e)}</strong>
                    <span>
                      {fmt(e.currentEnd)} → {fmt(e.newEnd)} · requested by {e.requestedByName}
                    </span>
                    {v && <span className="muted">{v.name} contract ends {fmt(v.contractEnd)}</span>}
                    <p className="muted">{e.reason}</p>
                    <div className="approval-actions">
                      <input placeholder="Note (needed to reject)" value={notes[e.id] ?? ""} onChange={(ev) => setNotes({ ...notes, [e.id]: ev.target.value })} />
                      <button className="btn btn-tiny" type="button" onClick={() => setMsg(result(decideExtension(actor, e.id, true, notes[e.id]), `${name(e)} extended to ${fmt(e.newEnd)}.`))}>
                        Approve
                      </button>
                      <button className="btn-ghost btn-tiny" type="button" onClick={() => setMsg(result(decideExtension(actor, e.id, false, notes[e.id]), "Extension rejected."))}>
                        Reject
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}
      <Card title={hr ? "All requests" : "My requests"}>
        <DataTable
          headers={["Contractor", "Current end", "New end", "Requested", "Status", ""]}
          rows={history.map((e) => [
            name(e),
            fmt(e.currentEnd),
            fmt(e.newEnd),
            `${fmt(e.requestedOn)} · ${e.requestedByName}`,
            <span key="s" className="wf-block">
              <StatusBadge status={EXT_LABEL[e.status]} tone={EXT_TONE[e.status]} literal />
              {e.decisionNote && <span className="muted wf-block">{e.decisionNote}</span>}
            </span>,
            e.status === "pending" && e.requestedById === actor.id ? (
              <button key="c" className="btn-ghost btn-tiny" type="button" onClick={() => setMsg(result(cancelExtension(actor, e.id), "Request cancelled."))}>
                Cancel
              </button>
            ) : (
              ""
            ),
          ])}
          empty={<EmptyState title="No extension requests" />}
        />
      </Card>
    </>
  );
}
