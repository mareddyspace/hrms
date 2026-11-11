import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Banner, Card, DataTable, Dialog, EmptyState, Field, FilterBar, StatusBadge, SubmitButton, notify, useAction, ActionButton } from "../../components/ui.tsx";
import { formatShortDate } from "../../model.ts";
import { listPeople, subscribePeople } from "../../data/peopleLocal.ts";
import { isAboveInLine } from "../lifecycle/lifecycleShared.ts";
import { CsvButton, Facts, LoadState, RequestThread, useServerValue } from "../payrequests/requestKit.tsx";
import type { ThreadContext } from "../payrequests/threadStore.ts";
import {
  FILE_KIND_LABELS,
  canConfigure,
  categoryAccepts,
  deleteBlocker,
  deleteDoc,
  fileProblem,
  isDocHr,
  loadFolders,
  loadDoc,
  loadDocs,
  loadExpiring,
  loadRules,
  loadVerificationQueue,
  openVersion,
  previewUrl,
  repoVersion,
  saveCategories,
  setExpiry,
  subscribeRepo,
  uploadDoc,
  uploadVersion,
  verifyDoc,
  type CategoryConfig,
  type FileKind,
  type RepoDoc,
  type RepoRules,
  type RepoVersion,
} from "./docRepo.ts";
import "../payrequests/payrequests.css";
import "../../styles/documents.css";

type Actor = { id: string; fullName: string; role: string };
type Msg = { tone: "ok" | "err" | "warn"; text: string } | null;

const sizeText = (b: number) => (b >= 1024 * 1024 ? `${(b / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

function VerificationBadge({ d }: { d: RepoDoc }) {
  if (!d.verification) return <span className="muted">Not needed</span>;
  const tone = d.verification === "verified" ? "ok" : d.verification === "rejected" ? "danger" : "warn";
  const label = d.verification === "verified" ? "Verified" : d.verification === "rejected" ? "Rejected" : "Pending verification";
  return <StatusBadge status={label} tone={tone} literal />;
}

function ExpiryText({ d }: { d: RepoDoc }) {
  if (!d.expiryDate) return <>None</>;
  const days = d.daysToExpiry;
  if (days === undefined || days > 30) return <>{formatShortDate(d.expiryDate)}</>;
  const label = days < 0 ? `expired ${-days}d ago` : days === 0 ? "today" : `in ${days}d`;
  return <StatusBadge status={`${formatShortDate(d.expiryDate)} · ${label}`} tone={days < 0 ? "danger" : "warn"} literal />;
}

function Preview({ doc, version }: { doc: RepoDoc; version: RepoVersion }) {
  const [state, setState] = useState<{ url: string; type: string } | string | null>(null);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    setState(null);
    const previewable = version.contentType.startsWith("image/") || version.contentType === "application/pdf";
    if (!previewable) {
      setState("No preview for this file type. Download it to open.");
      return;
    }
    void previewUrl(doc, version).then((out) => {
      if (typeof out !== "string") made = out.url;
      if (live) setState(out);
      else if (made) URL.revokeObjectURL(made);
    });
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [doc, version]);
  if (state === null) return <p className="muted">Loading preview…</p>;
  if (typeof state === "string") return <p className="muted">{state}</p>;
  return state.type.startsWith("image/") ? (
    <img src={state.url} alt={`Preview of ${doc.title}`} className="doc-preview-image" />
  ) : (
    <iframe title={`Preview of ${doc.title}`} src={state.url} className="doc-preview-frame" />
  );
}

/** What the chosen category accepts: file kinds, size, and whether expiry / HR verification apply. */
function RuleHint({ rules, category }: { rules: RepoRules; category?: CategoryConfig }) {
  const { text, maxBytes } = categoryAccepts(rules, category);
  return (
    <p className="doc-rule-hint">
      <span className="doc-chip">{text}</span>
      <span className="doc-chip">up to {sizeText(maxBytes)}</span>
      {category?.requiresExpiry && <span className="doc-chip is-required">Expiry date required</span>}
      {category?.verification && <span className="doc-chip">HR verifies employee uploads</span>}
      {category?.managerVisible && <span className="doc-chip">Managers can see</span>}
    </p>
  );
}

function UploadProgress({ percent }: { percent: number | null }) {
  if (percent === null) return null;
  return (
    <div className="doc-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Upload progress">
      <div className="doc-progress-track">
        <div className="doc-progress-bar" style={{ width: `${percent}%` }} />
      </div>
      <small>{percent >= 100 ? "Uploaded" : `Uploading… ${percent}%`}</small>
    </div>
  );
}

function UploadDialog({
  actor,
  rules,
  ownerId,
  doc,
  onClose,
  onDone,
}: {
  actor: Actor;
  rules: RepoRules;
  ownerId: string;
  doc?: RepoDoc;
  onClose: () => void;
  onDone: (text: string) => void;
}) {
  const hr = isDocHr(actor.role);
  const allowed = rules.categories.filter((c) => c.name !== "Letters" && (hr || c.employeeUpload));
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState(doc?.title ?? "");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState(allowed[0]?.name ?? "Other");
  const [expiry, setExpiryValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const act = useAction();
  const cat = rules.categories.find((c) => c.name === (doc?.category ?? category));
  const willVerify = !!cat?.verification && ownerId === actor.id && !hr;
  const accepts = categoryAccepts(rules, cat);
  const expiryNeeded = !!cat?.requiresExpiry && !(doc && doc.expiryDate);

  return (
    <Dialog open title={doc ? `Replace · ${doc.title}` : "Upload document"} onClose={onClose}>
      <form
        className="stack"
        onSubmit={act.submit(async () => {
          if (!file) return "Choose a file.";
          if (expiryNeeded && !expiry) return `Enter the expiry date: ${cat?.label.toLowerCase()} need one.`;
          setProgress(0);
          const err = doc
            ? await uploadVersion(actor, doc, file, rules, expiry || undefined, setProgress)
            : await uploadDoc(actor, file, { category, title, description, expiryDate: expiry || undefined, employeeId: ownerId }, rules, setProgress);
          if (err) {
            setProgress(null);
            setError(err);
            return err;
          }
          const text = doc ? `Version ${doc.currentVersion + 1} of ${doc.title} uploaded.` : `${title.trim()} uploaded${willVerify ? " and sent to HR for verification" : ""}.`;
          notify(text);
          onDone(text);
          return true;
        })}
      >
        <Field label="File">
          <input
            type="file"
            accept={accepts.accept}
            onChange={(e) => {
              const next = e.target.files?.[0] ?? null;
              setError(null);
              setProgress(null);
              if (next) {
                const problem = fileProblem(next, rules, cat?.name);
                if (problem) {
                  setError(problem);
                  setFile(null);
                  return;
                }
                if (!doc && !title.trim()) setTitle(next.name.replace(/\.[^.]+$/, ""));
              }
              setFile(next);
            }}
            required
          />
        </Field>
        <RuleHint rules={rules} category={cat} />
        {file && (
          <p className="note">
            {file.name} · {sizeText(file.size)}
          </p>
        )}
        {!doc && (
          <>
            <Field label="Category">
              <select
                value={category}
                onChange={(e) => {
                  setCategory(e.target.value);
                  // The new category may not accept the chosen file.
                  const problem = file ? fileProblem(file, rules, e.target.value) : null;
                  setError(problem);
                  if (problem) setFile(null);
                }}
              >
                {allowed.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Document name">
              <input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} required />
            </Field>
            <Field label="Description (optional)">
              <textarea rows={2} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
          </>
        )}
        <Field label={expiryNeeded ? "Expiry date (required)" : doc ? "New expiry date (optional)" : "Expiry date (optional)"}>
          <input type="date" value={expiry} onChange={(e) => setExpiryValue(e.target.value)} required={expiryNeeded} />
        </Field>
        {willVerify && <p className="pr-note" style={{ margin: 0 }}>HR checks documents in {cat?.label} before they are marked verified. You'll be notified when it's verified or if it's rejected.</p>}
        {doc && <p className="note">The current version stays available in the version history.</p>}
        <UploadProgress percent={progress} />
        {error && <Banner message={{ tone: "err", text: error }} />}
        <div className="dialog-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <SubmitButton action={act} className="btn" disabled={!file || (!doc && !title.trim()) || (expiryNeeded && !expiry)}>
            {doc ? "Upload new version" : willVerify ? "Upload and submit for verification" : "Upload"}
          </SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}

function CategoriesDialog({ actor, rules, onClose, onSaved }: { actor: Actor; rules: RepoRules; onClose: () => void; onSaved: () => void }) {
  const [rows, setRows] = useState<CategoryConfig[]>(rules.categories);
  const act = useAction();
  return (
    <Dialog open title="Document categories" onClose={onClose} wide>
      <form
        className="stack"
        onSubmit={act.submit(async () => {
          const err = await saveCategories(actor, rows);
          if (err) return err;
          notify("Categories saved.");
          onSaved();
          return true;
        })}
      >
        <div className="doc-config-table">
          <DataTable
            headers={["Category", "Shown as", "HR verifies", "Employees upload", "Managers see", "Expiry required", "Everyone needs one", "File types", "Max MB"]}
            rows={rows.map((c, i) => {
              const set = (patch: Partial<CategoryConfig>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
              const toggleKind = (k: FileKind, on: boolean) => set({ types: on ? (["pdf", "image", "docx"] as FileKind[]).filter((x) => x === k || c.types.includes(x)) : c.types.filter((x) => x !== k) });
              const letters = c.name === "Letters";
              return [
                c.name,
                <input key={`l-${c.name}`} value={c.label} maxLength={60} aria-label={`Label for ${c.name}`} onChange={(e) => set({ label: e.target.value })} />,
                <input key={`v-${c.name}`} type="checkbox" checked={c.verification} aria-label={`${c.name} needs verification`} onChange={(e) => set({ verification: e.target.checked })} />,
                <input key={`u-${c.name}`} type="checkbox" checked={c.employeeUpload} disabled={letters} aria-label={`Employees may upload ${c.name}`} onChange={(e) => set({ employeeUpload: e.target.checked })} />,
                <input key={`m-${c.name}`} type="checkbox" checked={c.managerVisible} aria-label={`Managers can see ${c.name}`} onChange={(e) => set({ managerVisible: e.target.checked })} />,
                <input key={`x-${c.name}`} type="checkbox" checked={c.requiresExpiry} disabled={letters} aria-label={`${c.name} needs an expiry date`} onChange={(e) => set({ requiresExpiry: e.target.checked })} />,
                <input key={`r-${c.name}`} type="checkbox" checked={c.required} disabled={letters} aria-label={`Every employee needs ${c.name}`} onChange={(e) => set({ required: e.target.checked })} />,
                <span key={`t-${c.name}`} className="doc-kinds">
                  {(["pdf", "image", "docx"] as FileKind[]).map((k) => (
                    <label key={k}>
                      <input type="checkbox" checked={c.types.includes(k)} disabled={letters} onChange={(e) => toggleKind(k, e.target.checked)} />
                      {FILE_KIND_LABELS[k]}
                    </label>
                  ))}
                </span>,
                <input
                  key={`s-${c.name}`}
                  className="doc-size-input"
                  type="number"
                  min={1}
                  max={10}
                  step={1}
                  value={c.maxMb}
                  aria-label={`Maximum size for ${c.name} in MB`}
                  onChange={(e) => set({ maxMb: Math.round(Number(e.target.value) || 1) })}
                />,
              ];
            })}
          />
        </div>
        <p className="note">Letters are always added by HR when a letter is issued (PDF). "Managers see" lets anyone above the employee in the reporting line open documents in that category; HR always sees documents of people in their scope.</p>
        <div className="dialog-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <SubmitButton action={act} className="btn">
            Save categories
          </SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}

function DeleteSection({ actor, doc, rules, onDeleted }: { actor: Actor; doc: RepoDoc; rules: RepoRules; onDeleted: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const act = useAction();
  if (deleteBlocker(actor, doc, rules)) return null;
  const forOther = doc.employeeId !== actor.id;
  return (
    <section className="doc-danger-zone">
      {!open ? (
        <button type="button" className="btn-ghost btn-tiny" onClick={() => setOpen(true)}>
          Delete document
        </button>
      ) : (
        <form
          className="stack"
          onSubmit={act.submit(async () => {
            const err = await deleteDoc(actor, doc, rules, reason);
            if (err) return err;
            notify(`${doc.title} deleted.`);
            onDeleted(`${doc.title} deleted.${forOther ? ` ${doc.employeeName} was told why.` : ""}`);
            return true;
          })}
        >
          <p className="note">
            {doc.title} and all {doc.versions.length || doc.currentVersion} version(s) will disappear from the library. HR keeps the record in the audit log.
          </p>
          <Field label={forOther ? "Reason (sent to the employee)" : "Reason (optional)"}>
            <input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} required={forOther} />
          </Field>
          <div className="pr-actions">
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
              Keep it
            </button>
            <SubmitButton action={act} className="btn btn-danger" disabled={forOther && !reason.trim()}>
              Delete
            </SubmitButton>
          </div>
        </form>
      )}
    </section>
  );
}

function DocDetail({ actor, doc, rules, onChanged, onDeleted, onReplace, setMsg }: { actor: Actor; doc: RepoDoc; rules: RepoRules; onChanged: (text?: string) => void; onDeleted: (text: string) => void; onReplace: () => void; setMsg: (m: Msg) => void }) {
  const [version, setVersion] = useState<RepoVersion | null>(null);
  const [expiry, setExpiryValue] = useState(doc.expiryDate ?? "");
  const [note, setNote] = useState("");
  const expiryAct = useAction();
  useEffect(() => {
    setExpiryValue(doc.expiryDate ?? "");
    setVersion(doc.versions.find((v) => v.version === doc.currentVersion) ?? doc.versions[doc.versions.length - 1] ?? null);
  }, [doc]);
  const hr = isDocHr(actor.role);
  const cat = rules.categories.find((c) => c.name === doc.category);
  const mine = doc.employeeId === actor.id;
  const canEdit = doc.category !== "Letters" && (hr || (mine && (cat?.employeeUpload ?? true)));
  const ctx: ThreadContext = { actorId: actor.id, actorName: actor.fullName, ownerId: doc.employeeId, canDecide: hr && !mine && doc.verification === "pending", reviewer: hr && !mine, label: "document", href: "/documents" };
  const versionsDesc = [...doc.versions].sort((a, b) => b.version - a.version);

  return (
    <div className="pr-detail">
      <Facts
        items={[
          ["Employee", doc.employeeName],
          ["Category", cat?.label ?? doc.category],
          ["Uploaded", formatShortDate(doc.createdOn)],
          ["Current version", `v${doc.currentVersion} · ${formatShortDate(doc.updatedOn)}`],
          ["Added by", doc.uploadedBy || "—"],
          ["Expires", <ExpiryText key="x" d={doc} />],
          ["Verification", <VerificationBadge key="v" d={doc} />],
          ["Verified by", doc.verifiedBy ? `${doc.verifiedBy}${doc.verifiedOn ? ` · ${formatShortDate(doc.verifiedOn)}` : ""}` : ""],
        ]}
      />
      {doc.description && <p className="muted" style={{ margin: 0 }}>{doc.description}</p>}
      {doc.verification === "rejected" && doc.verificationNote && <Banner message={{ tone: "warn", text: `Rejected: ${doc.verificationNote}${mine ? " Upload a new version to send it again." : ""}` }} />}
      {doc.verification === "verified" && doc.verificationNote && <p className="muted">HR note: {doc.verificationNote}</p>}
      {version && (
        <section>
          <h4>
            Preview · v{version.version} {version.fileName}
          </h4>
          <Preview doc={doc} version={version} />
        </section>
      )}
      <section>
        <h4>Version history</h4>
        <DataTable
          headers={["Version", "File", "Size", "Uploaded", ""]}
          rows={versionsDesc.map((v) => [
            v.version === doc.currentVersion ? `v${v.version} (current)` : `v${v.version}`,
            v.fileName,
            sizeText(v.sizeBytes),
            `${formatShortDate(v.on)}${v.uploadedBy ? ` · ${v.uploadedBy}` : ""}`,
            <span key={v.id} className="pr-actions">
              <button type="button" className="quiet-link" onClick={() => setVersion(v)}>
                Preview
              </button>
              <button
                type="button"
                className="quiet-link"
                onClick={async () => {
                  const err = await openVersion(doc, v, "save");
                  if (err) setMsg({ tone: "err", text: err });
                  else notify(`Downloading ${v.fileName}.`);
                }}
              >
                Download
              </button>
            </span>,
          ])}
        />
      </section>
      {hr && !mine && doc.verification === "pending" && (
        <section>
          <h4>Verify</h4>
          <div className="pr-form">
            <Field label="Note">
              <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Needed to reject" />
            </Field>
            <div className="pr-actions">
              <ActionButton
                className="btn"
                toastError
                success="Document verified."
                onAction={async () => {
                  const err = await verifyDoc(actor, doc, "verify", note);
                  if (!err) onChanged(`${doc.title} verified.`);
                  return err ?? true;
                }}
              >
                Verify
              </ActionButton>
              <ActionButton
                className="btn-ghost"
                toastError
                success="Document rejected."
                onAction={async () => {
                  const err = await verifyDoc(actor, doc, "reject", note);
                  if (!err) onChanged(`${doc.title} rejected. ${doc.employeeName} was told why.`);
                  return err ?? true;
                }}
              >
                Reject
              </ActionButton>
            </div>
          </div>
        </section>
      )}
      {canEdit && (
        <section>
          <h4>Update</h4>
          <div className="pr-actions">
            <button type="button" className="btn-ghost btn-tiny" onClick={onReplace}>
              Replace with a new version
            </button>
          </div>
          <form
            className="form-actions"
            onSubmit={expiryAct.submit(async () => {
              const err = await setExpiry(actor, doc, expiry || null, rules);
              if (err) return err;
              onChanged(expiry ? `Expiry set to ${formatShortDate(expiry)}.` : "Expiry removed.");
              return true;
            })}
          >
            <label className="filter-label">
              Expiry date{cat?.requiresExpiry ? " (required)" : ""}
              <input type="date" value={expiry} onChange={(e) => setExpiryValue(e.target.value)} required={!!cat?.requiresExpiry} />
            </label>
            <SubmitButton action={expiryAct} className="btn-ghost">
              Save expiry
            </SubmitButton>
          </form>
        </section>
      )}
      <DeleteSection actor={actor} doc={doc} rules={rules} onDeleted={onDeleted} />
      <RequestThread type="document" id={doc.id} ctx={ctx} showFiles={false} refreshKey={`${doc.currentVersion}|${doc.verification}`} />
    </div>
  );
}

/** HR / managers: one folder per employee with what needs attention; opening one shows that person's library. */
function FoldersCard({ actor, rules, people, ownerId, tick, onOpen }: { actor: Actor; rules: RepoRules; people: Parameters<typeof loadFolders>[2]; ownerId: string; tick: string; onOpen: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [only, setOnly] = useState("");
  const [limit, setLimit] = useState(12);
  const folders = useServerValue(() => loadFolders(actor, rules, people, q), `${q}|${tick}`);
  const all = folders.value ?? [];
  // Most urgent first: to verify, expired, rejected, expiring, then missing required documents.
  const urgency = (f: (typeof all)[number]) => f.pending * 1000 + f.expired * 100 + f.rejected * 50 + f.expiring * 10 + f.missing.length;
  const shown = all
    .filter((f) => !only || (only === "missing" ? f.missing.length > 0 : only === "pending" ? f.pending > 0 : f.expiring + f.expired > 0))
    .sort((a, b) => urgency(b) - urgency(a) || a.employeeName.localeCompare(b.employeeName));
  if (folders.value && all.length <= 1 && !q) return null; // just yourself: the library below is your folder
  return (
    <Card title="Employee folders">
      <FilterBar>
        <label className="filter-label">
          Find
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, code or department" />
        </label>
        <label className="filter-label">
          Show
          <select value={only} onChange={(e) => setOnly(e.target.value)}>
            <option value="">Everyone</option>
            <option value="missing">Missing required documents</option>
            <option value="pending">Waiting for verification</option>
            <option value="expiry">Expiring or expired</option>
          </select>
        </label>
        <CsvButton
          filename="document-folders.csv"
          headers={["Employee", "Code", "Department", "Documents", "Pending", "Rejected", "Expiring (30d)", "Expired", "Missing"]}
          rows={() => shown.map((f) => [f.employeeName, f.employeeCode, f.department, f.documents, f.pending, f.rejected, f.expiring, f.expired, f.missing.join("; ")])}
        />
      </FilterBar>
      {!folders.value ? (
        <LoadState error={folders.error} onRetry={folders.retry} />
      ) : shown.length === 0 ? (
        <EmptyState title="No folders match" description="Clear the search or the filter." />
      ) : (
        <div className="doc-folder-grid">
          {shown.slice(0, limit).map((f) => (
            <button key={f.employeeId} type="button" className="doc-folder" aria-pressed={ownerId === f.employeeId} onClick={() => onOpen(f.employeeId)}>
              <strong>{f.employeeName}</strong>
              <span className="doc-folder-meta">
                {f.employeeCode}
                {f.department ? ` · ${f.department}` : ""} · {f.documents} document{f.documents === 1 ? "" : "s"}
              </span>
              <span className="doc-folder-flags">
                {f.pending > 0 && <span className="doc-flag warn">{f.pending} to verify</span>}
                {f.rejected > 0 && <span className="doc-flag danger">{f.rejected} rejected</span>}
                {f.expired > 0 && <span className="doc-flag danger">{f.expired} expired</span>}
                {f.expiring > 0 && <span className="doc-flag warn">{f.expiring} expiring</span>}
                {f.missing.map((m) => (
                  <span key={m} className="doc-flag danger">
                    Missing: {m}
                  </span>
                ))}
                {!f.pending && !f.rejected && !f.expired && !f.expiring && !f.missing.length && <span className="doc-flag ok">All in order</span>}
              </span>
            </button>
          ))}
        </div>
      )}
      {shown.length > limit && (
        <div className="pr-actions">
          <span className="note">
            Showing {limit} of {shown.length}, most urgent first.
          </span>
          <button type="button" className="btn-ghost btn-tiny" onClick={() => setLimit(limit + 24)}>
            Show more
          </button>
        </div>
      )}
    </Card>
  );
}

/** Expiring documents with a window HR can change; employees see their own, managers their team's visible ones. */
function ExpiringCard({ actor, labelOf, tick, onOpen }: { actor: Actor; labelOf: Map<string, string>; tick: string; onOpen: (d: RepoDoc) => void }) {
  const hr = isDocHr(actor.role);
  const [days, setDays] = useState(30);
  const expiring = useServerValue(() => loadExpiring(days, actor), `${days}|${tick}`);
  const rows = expiring.value ?? [];
  if (!hr && rows.length === 0) return null;
  return (
    <Card
      title={`Expiring documents (${rows.length})`}
      action={
        <span className="pr-actions">
          <label className="filter-label">
            Within
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {[7, 30, 60, 90, 180].map((n) => (
                <option key={n} value={n}>
                  {n} days
                </option>
              ))}
            </select>
          </label>
          <CsvButton
            filename={`expiring-documents-${days}d.csv`}
            headers={["Employee", "Document", "Category", "Expires", "Days left"]}
            rows={() => rows.map((d) => [d.employeeName, d.title, labelOf.get(d.category) ?? d.category, d.expiryDate ?? "", d.daysToExpiry ?? ""])}
          />
        </span>
      }
    >
      {!expiring.value ? (
        <LoadState error={expiring.error} onRetry={expiring.retry} />
      ) : (
        <DataTable
          headers={["Employee", "Document", "Category", "Expires", ""]}
          rows={rows.map((d) => [
            d.employeeName,
            d.title,
            labelOf.get(d.category) ?? d.category,
            <ExpiryText key={`e-${d.id}`} d={d} />,
            <button key={d.id} type="button" className="quiet-link" onClick={() => onOpen(d)}>
              Open
            </button>,
          ])}
          empty={<EmptyState title="Nothing expiring" description={`No documents expire within ${days} days, and none have expired.`} />}
        />
      )}
      <p className="note">Owners are reminded 30 and 7 days before expiry and on the day; HR gets a daily summary when anything is within 7 days or expired.</p>
    </Card>
  );
}

/** The repository: library by category, upload, details with preview / versions / verification, expiry reminders. */
export function DocumentRepository({ actor }: { actor: Actor }) {
  const people = useSyncExternalStore(subscribePeople, listPeople, listPeople);
  const localTick = useSyncExternalStore(subscribeRepo, repoVersion, repoVersion);
  const hr = isDocHr(actor.role);
  const [ownerId, setOwnerId] = useState(actor.id);
  const [category, setCategory] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [tick, setTick] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<RepoDoc | null>(null);
  const [upload, setUpload] = useState<{ doc?: RepoDoc } | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const rules = useServerValue(loadRules, tick);
  const docs = useServerValue(() => loadDocs(ownerId, actor.id), `${ownerId}|${tick}|${localTick}`);
  const queue = useServerValue(() => loadVerificationQueue(actor), `${tick}|${localTick}`);
  const refresh = (text?: string) => {
    if (text) setMsg({ tone: "ok", text });
    setTick((n) => n + 1);
  };

  useEffect(() => {
    let live = true;
    if (!selectedId) {
      setSelected(null);
      return;
    }
    void loadDoc(selectedId).then((d) => live && setSelected(d));
    return () => {
      live = false;
    };
  }, [selectedId, tick, localTick]);

  const labelOf = useMemo(() => new Map((rules.value?.categories ?? []).map((c) => [c.name, c.label])), [rules.value]);
  const all = docs.value ?? [];
  const shown = all.filter(
    (d) =>
      (!category || d.category === category) &&
      (!q.trim() || `${d.title} ${d.description ?? ""}`.toLowerCase().includes(q.trim().toLowerCase())) &&
      (!status || (status === "expiring" ? d.daysToExpiry !== undefined && d.daysToExpiry <= 30 : (d.verification ?? "none") === status)),
  );
  const pickable = hr ? people : people.filter((p) => p.id === actor.id || isAboveInLine(actor.id, p.id) || p.managerId === actor.id);
  const sortedPeople = [...pickable].sort((a, b) => a.fullName.localeCompare(b.fullName));
  const mine = ownerId === actor.id;
  const countOf = (name: string) => all.filter((d) => d.category === name).length;

  return (
    <div className="stack">
      <Banner message={msg} />
      {(queue.value ?? []).length > 0 && (
        <Card title={`Waiting for verification (${queue.value?.length})`}>
          <DataTable
            headers={["Employee", "Document", "Category", "Uploaded", ""]}
            rows={(queue.value ?? []).map((d) => [
              d.employeeName,
              d.title,
              labelOf.get(d.category) ?? d.category,
              formatShortDate(d.updatedOn),
              <button
                key={d.id}
                type="button"
                className="quiet-link"
                onClick={() => {
                  setOwnerId(d.employeeId);
                  setSelectedId(d.id);
                }}
              >
                Review
              </button>,
            ])}
          />
        </Card>
      )}
      {rules.value && (
        <FoldersCard
          actor={actor}
          rules={rules.value}
          people={people}
          ownerId={ownerId}
          tick={`${tick}|${localTick}`}
          onOpen={(id) => {
            setOwnerId(id);
            setSelectedId(null);
          }}
        />
      )}
      <div className="mgr-home-grid">
        <Card
          title={mine ? "My documents" : `Documents · ${people.find((p) => p.id === ownerId)?.fullName ?? "employee"}`}
          action={
            <span className="pr-actions">
              {canConfigure(actor.role) && rules.value && (
                <button type="button" className="btn-ghost" onClick={() => setConfigOpen(true)}>
                  Categories
                </button>
              )}
              {(mine || hr) && (
                <button type="button" className="btn" onClick={() => setUpload({})} disabled={!rules.value}>
                  Upload document
                </button>
              )}
            </span>
          }
        >
          {rules.value && (
            <div className="pr-choice-row" role="group" aria-label="Library categories" style={{ marginBottom: 10 }}>
              <button type="button" className="pr-choice" aria-pressed={category === ""} onClick={() => setCategory("")}>
                All <small>{all.length}</small>
              </button>
              {rules.value.categories.map((c) => (
                <button key={c.name} type="button" className="pr-choice" aria-pressed={category === c.name} onClick={() => setCategory(category === c.name ? "" : c.name)}>
                  {c.label} <small>{countOf(c.name)}</small>
                </button>
              ))}
            </div>
          )}
          <FilterBar>
            {sortedPeople.length > 1 && (
              <label className="filter-label">
                Employee
                <select
                  value={ownerId}
                  onChange={(e) => {
                    setOwnerId(e.target.value);
                    setSelectedId(null);
                  }}
                >
                  {!sortedPeople.some((p) => p.id === actor.id) && <option value={actor.id}>{actor.fullName}</option>}
                  {sortedPeople.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.id === actor.id ? `${p.fullName} (you)` : `${p.fullName} · ${p.employeeCode}`}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="filter-label">
              Search
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or description" />
            </label>
            <label className="filter-label">
              Status
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">All</option>
                <option value="pending">Pending verification</option>
                <option value="verified">Verified</option>
                <option value="rejected">Rejected</option>
                <option value="none">No verification needed</option>
                <option value="expiring">Expiring in 30 days</option>
              </select>
            </label>
            <CsvButton
              filename={`documents-${ownerId}.csv`}
              headers={["Document", "Category", "Version", "Verification", "Expires", "Uploaded", "Updated"]}
              rows={() => shown.map((d) => [d.title, labelOf.get(d.category) ?? d.category, d.currentVersion, d.verification ?? "not needed", d.expiryDate ?? "", d.createdOn, d.updatedOn])}
            />
          </FilterBar>
          {!docs.value ? (
            <LoadState error={docs.error} onRetry={docs.retry} />
          ) : (
            <DataTable
              headers={["Document", "Category", "Version", "Verification", "Expires", "Updated"]}
              rows={shown.map((d) => [
                <button key={d.id} type="button" className="quiet-link" aria-pressed={selectedId === d.id} onClick={() => setSelectedId(d.id)}>
                  {d.title}
                </button>,
                labelOf.get(d.category) ?? d.category,
                `v${d.currentVersion}`,
                <VerificationBadge key={`v-${d.id}`} d={d} />,
                <ExpiryText key={`x-${d.id}`} d={d} />,
                formatShortDate(d.updatedOn),
              ])}
              empty={<EmptyState title={all.length ? "No documents match" : "No documents"} description={all.length ? "Pick another category or clear the search." : "Upload a document to start your library."} />}
            />
          )}
          <p className="note">
            Files are stored securely. Only the employee, HR and — for {(rules.value?.categories ?? []).filter((c) => c.managerVisible).map((c) => c.label.toLowerCase()).join(", ") || "no categories"} — their managers can open them. Every view, download, upload and delete is logged. Older versions stay available after an update.
          </p>
        </Card>
        <Card title={selected ? selected.title : "Details"}>
          {!selected || !rules.value ? (
            <EmptyState title="Select a document" description="Its details, preview, versions and verification appear here." />
          ) : (
            <DocDetail
              actor={actor}
              doc={selected}
              rules={rules.value}
              onChanged={refresh}
              onDeleted={(text) => {
                setSelectedId(null);
                refresh(text);
              }}
              onReplace={() => setUpload({ doc: selected })}
              setMsg={setMsg}
            />
          )}
        </Card>
      </div>
      <ExpiringCard
        actor={actor}
        labelOf={labelOf}
        tick={`${tick}|${localTick}`}
        onOpen={(d) => {
          setOwnerId(d.employeeId);
          setSelectedId(d.id);
        }}
      />
      {upload && rules.value && (
        <UploadDialog
          actor={actor}
          rules={rules.value}
          ownerId={ownerId}
          doc={upload.doc}
          onClose={() => setUpload(null)}
          onDone={(text) => {
            setUpload(null);
            refresh(text);
          }}
        />
      )}
      {configOpen && rules.value && (
        <CategoriesDialog
          actor={actor}
          rules={rules.value}
          onClose={() => setConfigOpen(false)}
          onSaved={() => {
            setConfigOpen(false);
            refresh("Document categories saved.");
          }}
        />
      )}
    </div>
  );
}
