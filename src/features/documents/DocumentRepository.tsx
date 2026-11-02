import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Banner, Card, DataTable, Dialog, EmptyState, Field, FilterBar, StatusBadge, SubmitButton, notify, useAction, ActionButton } from "../../components/ui.tsx";
import { formatShortDate } from "../../model.ts";
import { listPeople, subscribePeople } from "../../data/peopleLocal.ts";
import { isAboveInLine } from "../lifecycle/lifecycleShared.ts";
import { CsvButton, Facts, LoadState, RequestThread, useServerValue } from "../payrequests/requestKit.tsx";
import type { ThreadContext } from "../payrequests/threadStore.ts";
import {
  canConfigure,
  fileProblem,
  isDocHr,
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
  type RepoDoc,
  type RepoRules,
  type RepoVersion,
} from "./docRepo.ts";
import "../payrequests/payrequests.css";

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
    <img src={state.url} alt={`Preview of ${doc.title}`} style={{ maxWidth: "100%", maxHeight: 360, borderRadius: 8, border: "1px solid var(--line)" }} />
  ) : (
    <iframe title={`Preview of ${doc.title}`} src={state.url} style={{ width: "100%", height: 360, border: "1px solid var(--line)", borderRadius: 8 }} />
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
  const act = useAction();
  const cat = rules.categories.find((c) => c.name === (doc?.category ?? category));
  const willVerify = !!cat?.verification && ownerId === actor.id && !hr;

  return (
    <Dialog open title={doc ? `Replace · ${doc.title}` : "Upload document"} onClose={onClose}>
      <form
        className="stack"
        onSubmit={act.submit(async () => {
          if (!file) return "Choose a file.";
          const err = doc
            ? await uploadVersion(actor, doc, file, rules, expiry || undefined)
            : await uploadDoc(actor, file, { category, title, description, expiryDate: expiry || undefined, employeeId: ownerId }, rules);
          if (err) {
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
            accept={rules.contentTypes.join(",")}
            onChange={(e) => {
              const next = e.target.files?.[0] ?? null;
              setError(null);
              if (next) {
                const problem = fileProblem(next, rules);
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
        <p className="note">
          {rules.contentTypes.some((t) => t.includes("word")) ? "PDF, Word (.docx) or image" : "PDF or image"} · up to {sizeText(rules.maxBytes)}.{file ? ` ${file.name} · ${sizeText(file.size)}` : ""}
        </p>
        {!doc && (
          <>
            <Field label="Category">
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
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
        <Field label={doc ? "New expiry date (optional)" : "Expiry date (optional)"}>
          <input type="date" value={expiry} onChange={(e) => setExpiryValue(e.target.value)} />
        </Field>
        {willVerify && <p className="pr-note" style={{ margin: 0 }}>HR checks documents in {cat?.label} before they are marked verified. You'll be notified when it's verified or if it's rejected.</p>}
        {doc && <p className="note">The current version stays available in the version history.</p>}
        {error && <Banner message={{ tone: "err", text: error }} />}
        <div className="dialog-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <SubmitButton action={act} className="btn" disabled={!file || (!doc && !title.trim())}>
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
        <DataTable
          headers={["Category", "Shown as", "HR verifies employee uploads", "Employees may upload"]}
          rows={rows.map((c, i) => [
            c.name,
            <input key={`l-${c.name}`} value={c.label} maxLength={60} aria-label={`Label for ${c.name}`} onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, label: e.target.value } : r)))} />,
            <input key={`v-${c.name}`} type="checkbox" checked={c.verification} aria-label={`${c.name} needs verification`} onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, verification: e.target.checked } : r)))} />,
            <input
              key={`u-${c.name}`}
              type="checkbox"
              checked={c.employeeUpload}
              disabled={c.name === "Letters"}
              aria-label={`Employees may upload ${c.name}`}
              onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, employeeUpload: e.target.checked } : r)))}
            />,
          ])}
        />
        <p className="note">Letters are always added by HR when a letter is issued.</p>
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

function DocDetail({ actor, doc, rules, onChanged, onReplace, setMsg }: { actor: Actor; doc: RepoDoc; rules: RepoRules; onChanged: (text?: string) => void; onReplace: () => void; setMsg: (m: Msg) => void }) {
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
              const err = await setExpiry(actor, doc, expiry || null);
              if (err) return err;
              onChanged(expiry ? `Expiry set to ${formatShortDate(expiry)}.` : "Expiry removed.");
              return true;
            })}
          >
            <label className="filter-label">
              Expiry date
              <input type="date" value={expiry} onChange={(e) => setExpiryValue(e.target.value)} />
            </label>
            <SubmitButton action={expiryAct} className="btn-ghost">
              Save expiry
            </SubmitButton>
          </form>
        </section>
      )}
      <RequestThread type="document" id={doc.id} ctx={ctx} showFiles={false} refreshKey={`${doc.currentVersion}|${doc.verification}`} />
    </div>
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
  const expiring = useServerValue(() => loadExpiring(30, actor), `${tick}|${localTick}`);
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
      <div className="mgr-home-grid">
        <Card
          title="Document repository"
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
          <p className="note">Files are stored securely and only you, HR and (for work documents) your managers can open them. Older versions stay available after an update.</p>
        </Card>
        <Card title={selected ? selected.title : "Details"}>
          {!selected || !rules.value ? (
            <EmptyState title="Select a document" description="Its details, preview, versions and verification appear here." />
          ) : (
            <DocDetail actor={actor} doc={selected} rules={rules.value} onChanged={refresh} onReplace={() => setUpload({ doc: selected })} setMsg={setMsg} />
          )}
        </Card>
      </div>
      {(expiring.value ?? []).length > 0 && (
        <Card title="Expiring within 30 days">
          <DataTable
            headers={["Employee", "Document", "Category", "Expires", ""]}
            rows={(expiring.value ?? []).map((d) => [
              d.employeeName,
              d.title,
              labelOf.get(d.category) ?? d.category,
              <ExpiryText key={`e-${d.id}`} d={d} />,
              <button
                key={d.id}
                type="button"
                className="quiet-link"
                onClick={() => {
                  setOwnerId(d.employeeId);
                  setSelectedId(d.id);
                }}
              >
                Open
              </button>,
            ])}
          />
        </Card>
      )}
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
