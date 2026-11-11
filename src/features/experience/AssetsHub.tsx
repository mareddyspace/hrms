/**
 * Assets (backend mode): my assets with repair / lost / return reports, new-asset requests with a step trail and
 * history, the manager's approvals, and the IT desk (request queue and the inventory). Rules on the server
 * (backend/app/services/experience.py): manager approves new assets, IT issues, repairs and takes back.
 */
import { useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { ActionButton, Banner, Card, DataTable, Dialog, EmptyState, Field, LoadingState, MetricCard, MetricGrid, Page, StatusBadge, Tabs } from "../../components/ui.tsx";
import { formatShortDate, todayISO } from "../../model.ts";
import { assetsApi, assetsMirror, type AssetRequestKind, type AssetRequestRow, type AssetRow } from "../../api/syncExperience.ts";
import { PersonPicker } from "../compliance/ComplianceUi.tsx";
import { HistoryTimeline, StepTrail } from "./HistoryTimeline.tsx";
import "../../styles/experience.css";

type Msg = { tone: "ok" | "err" | "warn" | "info"; text: string } | null;
type Tone = "ok" | "warn" | "danger" | "info" | "neutral";

const STATUS_LABEL: Record<AssetRow["status"], string> = {
  in_stock: "In stock",
  assigned: "Assigned",
  in_repair: "In repair",
  lost: "Lost",
  retired: "Retired",
};
const STATUS_TONE: Record<AssetRow["status"], Tone> = { in_stock: "ok", assigned: "info", in_repair: "warn", lost: "danger", retired: "neutral" };
const KIND_LABEL: Record<AssetRequestKind, string> = { new: "New asset", repair: "Repair", lost: "Lost", return: "Return" };

function requestTone(status: string): Tone {
  if (["Fulfilled", "Resolved", "Returned"].includes(status)) return "ok";
  if (status === "Rejected") return "danger";
  if (status === "Cancelled") return "neutral";
  return "warn";
}

/** The workflow steps of a request and where it is now. */
function trailFor(r: AssetRequestRow): { steps: string[]; current: number; failed: boolean } {
  const end = { new: "Issued", repair: "Resolved", lost: "Resolved", return: "Received" }[r.kind];
  const steps = r.kind === "new" ? ["Requested", "Manager", "IT", end] : ["Reported", "IT", end];
  const failed = r.status === "Rejected" || r.status === "Cancelled";
  const closed = ["Fulfilled", "Resolved", "Returned"].includes(r.status);
  let current = r.status === "Pending manager" ? 1 : r.status === "Pending IT" ? steps.length - 2 : steps.length;
  if (failed) {
    const managerStep = r.history.some((h) => h.action === "Manager approved");
    current = r.kind === "new" && !managerStep && r.status === "Rejected" ? 1 : r.status === "Cancelled" ? 0 : steps.length - 2;
  }
  return { steps, current: closed ? steps.length : current, failed };
}

export function AssetsHub() {
  const data = useSyncExternalStore(assetsMirror.subscribe, assetsMirror.get, assetsMirror.get);
  const loaded = useSyncExternalStore(assetsMirror.subscribe, assetsMirror.loaded, assetsMirror.loaded);
  const [tab, setTab] = useState("mine");
  const [msg, setMsg] = useState<Msg>(null);
  const { meta } = data;

  const toApprove = data.manage.filter((r) => r.can_approve);
  const itQueue = data.manage.filter((r) => r.can_complete);
  const tabs = [
    { id: "mine", label: "My assets" },
    { id: "requests", label: `My requests (${data.myRequests.filter((r) => r.can_cancel).length} open)` },
  ];
  if (meta.has_team || meta.is_hr) tabs.push({ id: "team", label: toApprove.length ? `Team (${toApprove.length} to approve)` : "Team" });
  if (meta.is_it) tabs.push({ id: "it", label: `IT desk (${itQueue.length})` });

  async function report(result: Promise<string | null>, ok: string): Promise<string | null> {
    const error = await result;
    setMsg(error ? { tone: "err", text: error } : { tone: "ok", text: ok });
    return error;
  }

  if (!loaded && !assetsMirror.lastError()) return <Page title="Assets"><LoadingState label="Loading your assets…" /></Page>;

  return (
    <Page title="Assets">
      {assetsMirror.lastError() && <Banner message={{ tone: "err", text: assetsMirror.lastError() ?? "" }} />}
      <Banner message={msg} />
      <Tabs tabs={tabs} value={tab} onChange={(id) => { setTab(id); setMsg(null); }} />
      {tab === "mine" && <MyAssets assets={data.mine} requests={data.myRequests} onResult={report} onRequest={() => setTab("requests")} />}
      {tab === "requests" && <MyRequests categories={meta.categories} requests={data.myRequests} onResult={report} />}
      {tab === "team" && <TeamView approvals={toApprove} all={data.manage} assets={data.team} onResult={report} />}
      {tab === "it" && meta.is_it && <ItDesk queue={itQueue} inventory={data.inventory} categories={meta.categories} conditions={meta.conditions} onResult={report} />}
    </Page>
  );
}

type OnResult = (result: Promise<string | null>, ok: string) => Promise<string | null>;

/* ───────────── my assets ───────────── */
function MyAssets({ assets, requests, onResult, onRequest }: { assets: AssetRow[]; requests: AssetRequestRow[]; onResult: OnResult; onRequest: () => void }) {
  const [reporting, setReporting] = useState<{ asset: AssetRow; kind: Exclude<AssetRequestKind, "new"> } | null>(null);
  const openFor = (id: string) => requests.find((r) => r.asset_id === id && r.can_cancel);
  return (
    <Card title="Assigned to me" action={<button className="btn-ghost" type="button" onClick={onRequest}>Request an asset</button>}>
      {assets.length === 0 ? (
        <EmptyState title="No assets are assigned to you" description="Request one if you need equipment for your work." />
      ) : (
        <div className="xp-asset-grid">
          {assets.map((a) => {
            const open = openFor(a.id);
            return (
              <div key={a.id} className="xp-asset">
                <div className="xp-asset-head">
                  <strong>{a.name}</strong>
                  <StatusBadge status={STATUS_LABEL[a.status]} tone={STATUS_TONE[a.status]} literal />
                </div>
                <span className="xp-tag">{a.tag}{a.serial_no ? ` · S/N ${a.serial_no}` : ""}</span>
                <span className="muted xp-small">
                  {a.category} · since {a.assigned_on ? formatShortDate(a.assigned_on) : "—"} · condition {a.condition}
                </span>
                {open ? (
                  <p className="note warn xp-small">{KIND_LABEL[open.kind]} request open — {open.status.toLowerCase()}.</p>
                ) : (
                  <div className="xp-actions">
                    <button className="btn-ghost btn-tiny" type="button" onClick={() => setReporting({ asset: a, kind: "repair" })}>Report a fault</button>
                    <button className="btn-ghost btn-tiny" type="button" onClick={() => setReporting({ asset: a, kind: "lost" })}>Report lost</button>
                    <button className="btn-ghost btn-tiny" type="button" onClick={() => setReporting({ asset: a, kind: "return" })}>Return</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {reporting && (
        <ReportDialog
          asset={reporting.asset}
          kind={reporting.kind}
          onClose={() => setReporting(null)}
          onSubmit={(reason) =>
            onResult(
              assetsApi.request({ kind: reporting.kind, assetId: reporting.asset.id, reason }),
              { repair: "Fault reported to IT.", lost: "Loss reported to IT and your manager.", return: "Return requested; IT will collect it." }[reporting.kind],
            )
          }
        />
      )}
    </Card>
  );
}

function ReportDialog({ asset, kind, onClose, onSubmit }: { asset: AssetRow; kind: "repair" | "lost" | "return"; onClose: () => void; onSubmit: (reason: string) => Promise<string | null> }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const title = { repair: "Report a fault", lost: "Report a lost asset", return: "Return an asset" }[kind];
  const hint = {
    repair: "What is wrong? e.g. Screen flickers after waking from sleep.",
    lost: "Where and when was it last seen? Report a theft to the police too.",
    return: "Why are you returning it? e.g. Replaced by a new laptop.",
  }[kind];
  return (
    <Dialog
      open
      title={`${title} · ${asset.tag}`}
      onClose={onClose}
      actions={
        <>
          <button className="btn-ghost" type="button" onClick={onClose}>Cancel</button>
          <ActionButton
            className="btn"
            onAction={async () => {
              if (reason.trim().length < 10) {
                setError("Tell IT a little more (at least 10 characters).");
                return false;
              }
              const err = await onSubmit(reason);
              if (err) {
                setError(err);
                return false;
              }
              onClose();
              return true;
            }}
          >
            Send to IT
          </ActionButton>
        </>
      }
    >
      <div className="stack">
        {error && <p className="note err">{error}</p>}
        <Field label="Details" required wide>
          <span className="xp-counter">{reason.trim().length}/1000</span>
          <textarea value={reason} maxLength={1000} placeholder={hint} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

/* ───────────── my requests ───────────── */
function MyRequests({ categories, requests, onResult }: { categories: string[]; requests: AssetRequestRow[]; onResult: OnResult }) {
  const [category, setCategory] = useState("");
  const [item, setItem] = useState("");
  const [reason, setReason] = useState("");
  const [neededBy, setNeededBy] = useState("");
  const [error, setError] = useState("");

  async function submit() {
    if (!category) return setError("Choose the type of asset."), false;
    if (reason.trim().length < 10) return setError("Say why you need it (at least 10 characters)."), false;
    if (neededBy && neededBy < todayISO()) return setError("The needed-by date can't be in the past."), false;
    setError("");
    const err = await onResult(assetsApi.request({ kind: "new", category, item, reason, neededBy }), "Request sent to your manager for approval.");
    if (err) {
      setError(err);
      return false;
    }
    setCategory("");
    setItem("");
    setReason("");
    setNeededBy("");
    return true;
  }

  return (
    <div className="cmp-split">
      <Card title="Request an asset">
        <div className="stack">
          {error && <p className="note err">{error}</p>}
          <div className="xp-form">
            <Field label="Type" required>
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">Choose…</option>
                {categories.map((c) => <option key={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="Model or details">
              <input value={item} maxLength={120} placeholder="e.g. 27-inch monitor" onChange={(e) => setItem(e.target.value)} />
            </Field>
            <Field label="Needed by">
              <input type="date" value={neededBy} min={todayISO()} onChange={(e) => setNeededBy(e.target.value)} />
            </Field>
            <Field label="Why do you need it?" required wide>
              <span className="xp-counter">{reason.trim().length}/1000</span>
              <textarea value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} placeholder="e.g. A second screen for reconciling payroll reports." />
            </Field>
          </div>
          <p className="xp-hint">Your manager approves, then IT issues the asset. You'll get a notification at each step.</p>
          <div>
            <ActionButton className="btn" busyLabel="Sending…" doneLabel="Sent" onAction={submit}>Submit request</ActionButton>
          </div>
        </div>
      </Card>
      <Card title="My requests">
        <RequestList requests={requests} empty="No asset requests yet" onResult={onResult} />
      </Card>
    </div>
  );
}

function RequestList({ requests, empty, onResult, showPerson = false, children }: {
  requests: AssetRequestRow[];
  empty: string;
  onResult: OnResult;
  showPerson?: boolean;
  children?: (r: AssetRequestRow) => ReactNode;
}) {
  if (!requests.length) return <EmptyState title={empty} />;
  return (
    <ul className="xp-list">
      {requests.map((r) => {
        const trail = trailFor(r);
        return (
          <li key={r.id} className="xp-item">
            <div className="xp-item-head">
              <strong>
                {showPerson ? `${r.employee_name} · ` : ""}
                {KIND_LABEL[r.kind]}: {r.item}
              </strong>
              <StatusBadge status={r.status} tone={requestTone(r.status)} literal keepCase />
            </div>
            <div className="xp-meta">
              <span>Raised {formatShortDate(r.created_at.slice(0, 10))}</span>
              {r.needed_by && <span>Needed by {formatShortDate(r.needed_by)}</span>}
              {r.manager_name && r.status === "Pending manager" && <span>With {r.manager_name}</span>}
              {r.closed_on && <span>Closed {formatShortDate(r.closed_on)}</span>}
            </div>
            <p className="xp-small">{r.reason}</p>
            <StepTrail steps={trail.steps} current={trail.current} failed={trail.failed} />
            {r.decision_note && <p className="muted xp-small">Note: {r.decision_note}</p>}
            <HistoryTimeline entries={r.history} compact />
            <div className="xp-actions">
              {r.can_cancel && !showPerson && (
                <ActionButton className="btn-ghost btn-tiny" success="Request cancelled." onAction={() => onResult(assetsApi.cancel(r.id), "Request cancelled.")}>
                  Cancel request
                </ActionButton>
              )}
              {children?.(r)}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/* ───────────── team (managers / HR) ───────────── */
function TeamView({ approvals, all, assets, onResult }: { approvals: AssetRequestRow[]; all: AssetRequestRow[]; assets: AssetRow[]; onResult: OnResult }) {
  const [declining, setDeclining] = useState<AssetRequestRow | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const recent = all.filter((r) => !r.can_approve).slice(0, 20);
  return (
    <div className="stack">
      <Card title={`Waiting for your approval (${approvals.length})`}>
        <RequestList requests={approvals} empty="Nothing to approve" onResult={onResult} showPerson>
          {(r) => (
            <>
              <ActionButton className="btn btn-tiny" busyLabel="Approving…" doneLabel="Approved" onAction={() => onResult(assetsApi.managerDecision(r.id, true, ""), `Approved; IT will issue ${r.item}.`)}>
                Approve
              </ActionButton>
              <button className="btn-ghost btn-tiny" type="button" onClick={() => { setDeclining(r); setNote(""); setError(""); }}>Decline</button>
            </>
          )}
        </RequestList>
      </Card>
      <Card title="Team assets">
        <DataTable
          headers={["Employee", "Asset", "Tag", "Since", "Condition"]}
          empty={<EmptyState title="No assets assigned to your team" />}
          rows={assets.map((a) => [a.employee_name ?? "—", a.name, <span key="t" className="xp-tag">{a.tag}</span>, a.assigned_on ? formatShortDate(a.assigned_on) : "—", a.condition])}
        />
      </Card>
      <Card title="Recent team requests">
        <RequestList requests={recent} empty="No other requests" onResult={onResult} showPerson />
      </Card>
      <Dialog
        open={!!declining}
        title="Decline request"
        onClose={() => setDeclining(null)}
        actions={
          <>
            <button className="btn-ghost" type="button" onClick={() => setDeclining(null)}>Cancel</button>
            <ActionButton
              className="btn"
              onAction={async () => {
                if (!declining) return false;
                const err = await onResult(assetsApi.managerDecision(declining.id, false, note), "Request declined.");
                if (err) return setError(err), false;
                setDeclining(null);
                return true;
              }}
            >
              Decline
            </ActionButton>
          </>
        }
      >
        <div className="stack">
          {error && <p className="note err">{error}</p>}
          <Field label="Reason (shared with the employee)" required>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}

/* ───────────── IT desk ───────────── */
type CloseAction = "fulfil" | "resolve" | "receive" | "reject";

function ItDesk({ queue, inventory, categories, conditions, onResult }: { queue: AssetRequestRow[]; inventory: AssetRow[]; categories: string[]; conditions: string[]; onResult: OnResult }) {
  const [closing, setClosing] = useState<{ req: AssetRequestRow; action: CloseAction } | null>(null);
  const [editing, setEditing] = useState<AssetRow | "new" | null>(null);
  const [assigning, setAssigning] = useState<AssetRow | null>(null);
  const [recovering, setRecovering] = useState<AssetRow | null>(null);
  const [retiring, setRetiring] = useState<AssetRow | null>(null);
  const [status, setStatus] = useState("all");
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");
  const counts = useMemo(() => {
    const c: Record<string, number> = { in_stock: 0, assigned: 0, in_repair: 0, lost: 0 };
    for (const a of inventory) c[a.status] = (c[a.status] ?? 0) + 1;
    return c;
  }, [inventory]);
  const shown = inventory.filter(
    (a) =>
      (status === "all" || a.status === status) &&
      (category === "all" || a.category === category) &&
      (!query.trim() || `${a.tag} ${a.name} ${a.employee_name ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())),
  );
  const primary: Record<AssetRequestKind, { action: CloseAction; label: string }> = {
    new: { action: "fulfil", label: "Issue asset" },
    repair: { action: "resolve", label: "Mark repaired" },
    lost: { action: "resolve", label: "Write off" },
    return: { action: "receive", label: "Receive" },
  };

  return (
    <div className="stack">
      <MetricGrid>
        <MetricCard label="Waiting for IT" value={queue.length} />
        <MetricCard label="In stock" value={counts.in_stock} />
        <MetricCard label="Assigned" value={counts.assigned} />
        <MetricCard label="In repair" value={counts.in_repair} />
      </MetricGrid>
      <Card title="Request queue">
        <RequestList requests={queue} empty="No requests waiting for IT" onResult={onResult} showPerson>
          {(r) => (
            <>
              <button className="btn btn-tiny" type="button" onClick={() => setClosing({ req: r, action: primary[r.kind].action })}>{primary[r.kind].label}</button>
              <button className="btn-ghost btn-tiny" type="button" onClick={() => setClosing({ req: r, action: "reject" })}>Reject</button>
            </>
          )}
        </RequestList>
      </Card>
      <Card title="Inventory" action={<button className="btn-ghost" type="button" onClick={() => setEditing("new")}>Add asset</button>}>
        <div className="xp-filters">
          <Field label="Search"><input value={query} placeholder="Tag, model or holder" onChange={(e) => setQuery(e.target.value)} /></Field>
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="all">All</option>
              {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="Type">
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="all">All</option>
              {categories.map((c) => <option key={c}>{c}</option>)}
            </select>
          </Field>
        </div>
        <DataTable
          headers={["Tag", "Asset", "Status", "With", "Condition", ""]}
          empty={<EmptyState title="No matching assets" />}
          rows={shown.map((a) => [
            <span key="t" className="xp-tag">{a.tag}</span>,
            `${a.name} · ${a.category}`,
            <StatusBadge key="s" status={STATUS_LABEL[a.status]} tone={STATUS_TONE[a.status]} literal />,
            a.employee_name ?? "—",
            a.condition,
            <span key="a" className="xp-actions">
              <button className="btn-ghost btn-tiny" type="button" onClick={() => setEditing(a)}>Edit</button>
              {a.status === "in_stock" && <button className="btn-ghost btn-tiny" type="button" onClick={() => setAssigning(a)}>Assign</button>}
              {(a.status === "assigned" || (a.status === "in_repair" && a.employee_id)) && (
                <button className="btn-ghost btn-tiny" type="button" onClick={() => setRecovering(a)}>Take back</button>
              )}
              {(a.status === "in_stock" || a.status === "in_repair") && !a.employee_id && (
                <button className="btn-ghost btn-tiny" type="button" onClick={() => setRetiring(a)}>Retire</button>
              )}
            </span>,
          ])}
        />
      </Card>
      {closing && <CloseDialog req={closing.req} action={closing.action} inventory={inventory} conditions={conditions} onClose={() => setClosing(null)} onResult={onResult} />}
      {editing && <AssetDialog asset={editing === "new" ? null : editing} categories={categories} conditions={conditions} onClose={() => setEditing(null)} onResult={onResult} />}
      {assigning && <AssignDialog asset={assigning} onClose={() => setAssigning(null)} onResult={onResult} />}
      {recovering && <RecoverDialog asset={recovering} conditions={conditions} onClose={() => setRecovering(null)} onResult={onResult} />}
      {retiring && <RetireDialog asset={retiring} onClose={() => setRetiring(null)} onResult={onResult} />}
    </div>
  );
}

function DialogShell({ title, error, onClose, onSave, saveLabel, children }: {
  title: string;
  error: string;
  onClose: () => void;
  onSave: () => Promise<boolean>;
  saveLabel: string;
  children: ReactNode;
}) {
  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      actions={
        <>
          <button className="btn-ghost" type="button" onClick={onClose}>Cancel</button>
          <ActionButton className="btn" onAction={onSave}>{saveLabel}</ActionButton>
        </>
      }
    >
      <div className="stack">
        {error && <p className="note err">{error}</p>}
        {children}
      </div>
    </Dialog>
  );
}

function CloseDialog({ req, action, inventory, conditions, onClose, onResult }: { req: AssetRequestRow; action: CloseAction; inventory: AssetRow[]; conditions: string[]; onClose: () => void; onResult: OnResult }) {
  const stock = inventory.filter((a) => a.status === "in_stock" && a.category === req.category);
  const [assetId, setAssetId] = useState(stock[0]?.id ?? "");
  const [condition, setCondition] = useState("Good");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const title = { fulfil: "Issue an asset", resolve: req.kind === "lost" ? "Write off lost asset" : "Mark repaired", receive: "Receive returned asset", reject: "Reject request" }[action];
  return (
    <DialogShell
      title={`${title} · ${req.employee_name}`}
      error={error}
      saveLabel={action === "reject" ? "Reject" : "Confirm"}
      onClose={onClose}
      onSave={async () => {
        if (action === "fulfil" && !assetId) return setError(`No ${req.category.toLowerCase()} in stock. Add one to the inventory first.`), false;
        const err = await onResult(assetsApi.complete(req.id, action, note, assetId, action === "fulfil" || action === "reject" ? undefined : condition), `${title} — done.`);
        if (err) return setError(err), false;
        onClose();
        return true;
      }}
    >
      <p className="muted">{req.item} — {req.reason}</p>
      {action === "fulfil" && (
        <Field label={`${req.category} from stock`} required>
          <select value={assetId} onChange={(e) => setAssetId(e.target.value)}>
            {stock.length === 0 && <option value="">None in stock</option>}
            {stock.map((a) => <option key={a.id} value={a.id}>{a.tag} · {a.name} ({a.condition})</option>)}
          </select>
        </Field>
      )}
      {(action === "receive" || (action === "resolve" && req.kind === "repair")) && (
        <Field label="Condition now">
          <select value={condition} onChange={(e) => setCondition(e.target.value)}>
            {conditions.map((c) => <option key={c}>{c}</option>)}
          </select>
        </Field>
      )}
      <Field label={action === "reject" ? "Reason (shared with the employee)" : "Note to the employee"} required={action === "reject"}>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </DialogShell>
  );
}

function AssetDialog({ asset, categories, conditions, onClose, onResult }: { asset: AssetRow | null; categories: string[]; conditions: string[]; onClose: () => void; onResult: OnResult }) {
  const [form, setForm] = useState({
    tag: asset?.tag ?? "",
    name: asset?.name ?? "",
    category: asset?.category ?? "",
    serial_no: asset?.serial_no ?? "",
    condition: asset?.condition ?? "New",
    country_code: asset?.country_code ?? "",
    notes: asset?.notes ?? "",
  });
  const [error, setError] = useState("");
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <DialogShell
      title={asset ? `Edit ${asset.tag}` : "Add asset"}
      error={error}
      saveLabel="Save"
      onClose={onClose}
      onSave={async () => {
        if (!/^[A-Za-z0-9][A-Za-z0-9-]{2,39}$/.test(form.tag.trim())) return setError("Asset tag: 3-40 letters, digits or dashes (e.g. LT-6120)."), false;
        if (!form.name.trim() || !form.category) return setError("Enter the model and choose the type."), false;
        const err = await onResult(assetsApi.save(form, asset?.id), asset ? "Asset updated." : "Asset added to the inventory.");
        if (err) return setError(err), false;
        onClose();
        return true;
      }}
    >
      <div className="xp-form">
        <Field label="Tag" required><input value={form.tag} onChange={(e) => set("tag", e.target.value.toUpperCase())} placeholder="LT-7003" /></Field>
        <Field label="Type" required>
          <select value={form.category} onChange={(e) => set("category", e.target.value)}>
            <option value="">Choose…</option>
            {categories.map((c) => <option key={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Model" required wide><input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Dell Latitude 7440" /></Field>
        <Field label="Serial number"><input value={form.serial_no} onChange={(e) => set("serial_no", e.target.value)} /></Field>
        <Field label="Condition">
          <select value={form.condition} onChange={(e) => set("condition", e.target.value)}>
            {conditions.map((c) => <option key={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Country"><input value={form.country_code} maxLength={2} onChange={(e) => set("country_code", e.target.value.toUpperCase())} placeholder="IN" /></Field>
        <Field label="Notes" wide><textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} /></Field>
      </div>
      {asset && asset.history.length > 0 && <HistoryTimeline entries={asset.history} compact />}
    </DialogShell>
  );
}

function AssignDialog({ asset, onClose, onResult }: { asset: AssetRow; onClose: () => void; onResult: OnResult }) {
  const [person, setPerson] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  return (
    <DialogShell
      title={`Assign ${asset.tag}`}
      error={error}
      saveLabel="Assign"
      onClose={onClose}
      onSave={async () => {
        if (!person) return setError("Choose who gets the asset."), false;
        const err = await onResult(assetsApi.assign(asset.id, person, note), `${asset.tag} assigned.`);
        if (err) return setError(err), false;
        onClose();
        return true;
      }}
    >
      <Field label="Employee" required wide><PersonPicker value={person} onChange={setPerson} /></Field>
      <Field label="Note"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Replacement for LT-3307" /></Field>
    </DialogShell>
  );
}

function RecoverDialog({ asset, conditions, onClose, onResult }: { asset: AssetRow; conditions: string[]; onClose: () => void; onResult: OnResult }) {
  const [condition, setCondition] = useState("Good");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  return (
    <DialogShell
      title={`Take back ${asset.tag} from ${asset.employee_name ?? "the holder"}`}
      error={error}
      saveLabel="Take back"
      onClose={onClose}
      onSave={async () => {
        const err = await onResult(assetsApi.recover(asset.id, condition, note), `${asset.tag} is back with IT.`);
        if (err) return setError(err), false;
        onClose();
        return true;
      }}
    >
      <Field label="Condition">
        <select value={condition} onChange={(e) => setCondition(e.target.value)}>
          {conditions.map((c) => <option key={c}>{c}</option>)}
        </select>
      </Field>
      <Field label="Note"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Exit clearance" /></Field>
    </DialogShell>
  );
}

function RetireDialog({ asset, onClose, onResult }: { asset: AssetRow; onClose: () => void; onResult: OnResult }) {
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  return (
    <DialogShell
      title={`Retire ${asset.tag}`}
      error={error}
      saveLabel="Retire"
      onClose={onClose}
      onSave={async () => {
        if (note.trim().length < 5) return setError("Say why the asset is retired (at least 5 characters)."), false;
        const err = await onResult(assetsApi.retire(asset.id, note), `${asset.tag} retired.`);
        if (err) return setError(err), false;
        onClose();
        return true;
      }}
    >
      <p className="muted">A retired asset stays on record but can't be issued again.</p>
      <Field label="Reason" required>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Beyond economical repair" />
      </Field>
    </DialogShell>
  );
}
