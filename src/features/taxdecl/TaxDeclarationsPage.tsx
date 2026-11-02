import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ActionButton, Banner, Card, Dialog, EmptyState, Field, MetricCard, MetricGrid, Page, StatusBadge, Tabs } from "../../components/ui.tsx";
import { money } from "../../countryPay.ts";
import { compareRegimes } from "../../data/payslipGenerator.ts";
import { useTaxRegime } from "../../data/taxRegime.ts";
import { formatShortDate, type InvestmentProof } from "../../model.ts";
import { RegimePicker, SlipTag } from "../../pages/PayslipsPage.tsx";
import { usePortal } from "../../store.tsx";
import { PdfDoc, pdfMoney, saveFile } from "../payroll/pdfDoc.ts";
import "../payroll/payslips.css";
import {
  createDeclaration,
  declConfig,
  declarationsError,
  declarationsLoaded,
  decideDeclaration,
  deleteDeclaration,
  downloadProof,
  myDeclarations,
  removeProof,
  setDeclarationWindow,
  submitDeclaration,
  updateDeclaration,
  uploadProof,
  useDeclarationsVersion,
  verifyQueue,
  withdrawDeclaration,
  type Actor,
  type DeclConfig,
  type Declaration,
  type DeclStatus,
} from "./taxDeclStore.ts";

const STATUS_LABEL: Record<DeclStatus, string> = { draft: "Draft", submitted: "Waiting for verification", verified: "Verified", rejected: "Rejected" };
const STATUS_TONE: Record<DeclStatus, "ok" | "warn" | "danger" | "info" | "neutral"> = { draft: "neutral", submitted: "warn", verified: "ok", rejected: "danger" };
const KB = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const when = (iso?: string) => (iso ? formatShortDate(iso.slice(0, 10)) : "—");

function Status({ status }: { status: DeclStatus }) {
  return <StatusBadge status={STATUS_LABEL[status]} tone={STATUS_TONE[status]} literal />;
}

type FormState = { id?: string; financialYear: string; section: string; title: string; amount: string; note: string };

/** Add / edit form: section with its cap and the proof it needs, tax year, title, amount, note, proof file. */
function DeclarationForm({
  cfg,
  actor,
  initial,
  onDone,
  onCancel,
}: {
  cfg: DeclConfig;
  actor: Actor;
  initial: FormState;
  onDone: (text: string, id?: string) => void;
  onCancel?: () => void;
}) {
  const [form, setForm] = useState<FormState>(initial);
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [busy, setBusy] = useState<"" | "save" | "submit">("");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const section = cfg.sections.find((s) => s.code === form.section);
  const openYears = cfg.years.filter((y) => y.open || y.financialYear === initial.financialYear);
  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  async function save(andSubmit: boolean) {
    const amount = Number(form.amount);
    if (!form.title.trim()) return setMsg({ tone: "err", text: "Enter a title, e.g. the policy or scheme name." });
    if (!Number.isFinite(amount) || amount <= 0) return setMsg({ tone: "err", text: "Enter an amount above zero." });
    if (section?.cap != null && amount > section.cap) return setMsg({ tone: "err", text: `${section.code} allows up to ${money(section.cap, cfg.currency)} a year.` });
    if (andSubmit && !file && !(form.id && initial.id)) return setMsg({ tone: "err", text: "Attach a proof file to submit." });
    setBusy(andSubmit ? "submit" : "save");
    const input = { financialYear: form.financialYear, section: form.section, title: form.title, amount, note: form.note };
    let id = form.id;
    let error: string | null;
    if (id) error = await updateDeclaration(actor, id, input);
    else {
      const out = await createDeclaration(actor, input);
      error = out.error;
      id = out.id;
    }
    if (!error && id && file) error = await uploadProof(actor, id, file);
    if (!error && id && andSubmit) error = await submitDeclaration(actor, id);
    setBusy("");
    if (error) {
      setMsg({ tone: "err", text: id && !form.id ? `Saved as a draft, but: ${error}` : error });
      if (id && !form.id) set({ id });
      return;
    }
    setFile(null);
    setFileKey((k) => k + 1);
    setMsg(null);
    onDone(andSubmit ? "Declaration submitted for Finance verification." : form.id ? "Declaration updated." : "Draft saved. Add a proof and submit before the deadline.", id);
    if (!form.id) setForm({ ...initial, id: undefined, title: "", amount: "", note: "" });
  }

  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void save(false);
      }}
    >
      <div className="form-grid">
        <Field label="Section" required>
          <select value={form.section} onChange={(e) => set({ section: e.target.value })}>
            {cfg.sections.map((s) => (
              <option key={s.code} value={s.code}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tax year" required>
          <select value={form.financialYear} disabled={Boolean(form.id)} onChange={(e) => set({ financialYear: e.target.value })}>
            {openYears.map((y) => (
              <option key={y.financialYear} value={y.financialYear}>
                {y.financialYear}
                {y.open ? ` · until ${formatShortDate(y.deadline)}` : " · closed"}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Title" wide required>
          <input value={form.title} maxLength={200} placeholder="e.g. PPF account, LIC policy 12345, rent for flat 4B" onChange={(e) => set({ title: e.target.value })} />
        </Field>
        <Field label={section?.cap != null ? `Amount (${cfg.currency}, up to ${money(section.cap, cfg.currency)} a year)` : `Amount (${cfg.currency})`} required>
          <input type="number" min={1} step="0.01" value={form.amount} onChange={(e) => set({ amount: e.target.value })} />
        </Field>
        <Field label={`Proof (PDF or image${section?.proof ? `: ${section.proof}` : ""})`}>
          <input key={fileKey} type="file" accept="application/pdf,image/png,image/jpeg,image/gif,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
        <Field label="Note for Finance (optional)" wide>
          <textarea value={form.note} maxLength={1000} onChange={(e) => set({ note: e.target.value })} />
        </Field>
      </div>
      <div className="form-actions">
        <button className="btn-ghost" type="submit" disabled={Boolean(busy)}>
          {busy === "save" ? "Saving…" : form.id ? "Save changes" : "Save draft"}
        </button>
        <button className="btn" type="button" disabled={Boolean(busy)} onClick={() => void save(true)}>
          {busy === "submit" ? "Submitting…" : "Save & submit"}
        </button>
        {onCancel && (
          <button className="btn-ghost" type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      <Banner message={msg} />
    </form>
  );
}

/** Everything about one item: amounts, year, status, notes, proofs, history and what can be done next. */
function DeclarationDetail({
  item,
  cfg,
  actor,
  verifying,
  onClose,
  onMessage,
}: {
  item: Declaration;
  cfg: DeclConfig;
  actor: Actor;
  verifying: boolean;
  onClose: () => void;
  onMessage: (m: { tone: "ok" | "err"; text: string }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState("");
  const [allowed, setAllowed] = useState(String(item.amount));
  const [fileKey, setFileKey] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const mine = item.employeeId === actor.id;
  const run = async (p: Promise<string | null>, ok: string, close = false) => {
    const e = await p;
    setErr(e);
    if (!e) {
      onMessage({ tone: "ok", text: ok });
      if (close) onClose();
    }
    return e;
  };
  if (editing) {
    return (
      <Dialog open title={`Edit · ${item.section}`} onClose={() => setEditing(false)} wide>
        <DeclarationForm
          cfg={cfg}
          actor={actor}
          initial={{ id: item.id, financialYear: item.financialYear, section: item.section, title: item.title, amount: String(item.amount), note: item.employeeNote ?? "" }}
          onDone={(text) => {
            setEditing(false);
            onMessage({ tone: "ok", text });
          }}
          onCancel={() => setEditing(false)}
        />
      </Dialog>
    );
  }
  return (
    <Dialog open title={`${item.section} · ${item.title}`} onClose={onClose} wide>
      <dl className="info-grid">
        {!mine && (
          <div className="info-fact">
            <dt>Employee</dt>
            <dd>
              {item.employeeName} {item.employeeCode ? `(${item.employeeCode})` : ""}
            </dd>
          </div>
        )}
        <div className="info-fact">
          <dt>Section</dt>
          <dd>{item.sectionLabel}</dd>
        </div>
        <div className="info-fact">
          <dt>Tax year</dt>
          <dd>{item.financialYear}</dd>
        </div>
        <div className="info-fact">
          <dt>Declared</dt>
          <dd>{money(item.amount, item.currency)}</dd>
        </div>
        <div className="info-fact">
          <dt>Verified</dt>
          <dd>{item.verifiedAmount != null ? money(item.verifiedAmount, item.currency) : "—"}</dd>
        </div>
        <div className="info-fact">
          <dt>Status</dt>
          <dd>
            <Status status={item.status} />
          </dd>
        </div>
        {item.regime && (
          <div className="info-fact">
            <dt>Regime</dt>
            <dd>{item.regime === "old" ? "Old regime" : "New regime"}</dd>
          </div>
        )}
        <div className="info-fact">
          <dt>Submitted</dt>
          <dd>{when(item.submittedAt)}</dd>
        </div>
        {item.decidedAt && (
          <div className="info-fact">
            <dt>{item.status === "verified" ? "Verified" : "Reviewed"} by</dt>
            <dd>
              {item.decidedByName ?? "Finance"} · {when(item.decidedAt)}
            </dd>
          </div>
        )}
      </dl>
      {item.employeeNote && <p className="note">Employee note: {item.employeeNote}</p>}
      {item.decisionNote && (
        <Banner message={{ tone: item.status === "rejected" ? "err" : "info", text: `Finance: ${item.decisionNote}` }} />
      )}
      <h3 style={{ fontSize: 14, margin: "14px 0 6px" }}>Proof documents</h3>
      {item.documents.length === 0 ? (
        <p className="muted">No proof attached yet.</p>
      ) : (
        <ul className="todo">
          {item.documents.map((d) => (
            <li key={d.id}>
              {d.fileName} <span className="muted">· {KB(d.size)} · {when(d.uploadedAt)}</span>{" "}
              <ActionButton className="quiet-link" busyLabel="Downloading…" doneLabel="Downloaded" onAction={() => downloadProof(item, d)} toastError>
                Download
              </ActionButton>
              {mine && item.editable && (
                <ActionButton className="quiet-link" busyLabel="Removing…" onAction={() => run(removeProof(actor, item.id, d.id), `${d.fileName} removed.`)}>
                  Remove
                </ActionButton>
              )}
            </li>
          ))}
        </ul>
      )}
      {mine && item.editable && (
        <label className="field">
          <span>Add a proof (PDF or image, up to {item.documents.length >= 5 ? "5 files" : "5 MB"})</span>
          <input
            key={fileKey}
            type="file"
            accept="application/pdf,image/png,image/jpeg,image/gif,image/webp"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void run(uploadProof(actor, item.id, f), `${f.name} attached.`).then(() => setFileKey((k) => k + 1));
            }}
          />
        </label>
      )}
      <h3 style={{ fontSize: 14, margin: "14px 0 6px" }}>History</h3>
      <ol className="todo">
        {[...item.history].reverse().map((h, i) => (
          <li key={`${h.at}-${i}`}>
            <strong>{h.action}</strong> · {when(h.at)}
            {h.byName ? ` · ${h.byName}` : ""}
            {h.note ? <span className="muted"> — {h.note}</span> : null}
          </li>
        ))}
      </ol>
      {verifying && item.status === "submitted" && !mine && (
        <div className="form-grid" style={{ marginTop: 12 }}>
          <Field label={`Verified amount (${item.currency})`}>
            <input type="number" min={0} step="0.01" max={item.amount} value={allowed} onChange={(e) => setAllowed(e.target.value)} />
          </Field>
          <Field label="Comment (required to reject)" wide>
            <textarea value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
      )}
      <Banner message={err ? { tone: "err", text: err } : null} />
      <div className="dialog-actions" style={{ marginTop: 12 }}>
        {mine && item.editable && (
          <>
            <button className="btn-ghost" type="button" onClick={() => setEditing(true)}>
              Edit
            </button>
            <ActionButton className="btn-ghost" busyLabel="Deleting…" onAction={() => run(deleteDeclaration(actor, item.id), "Declaration deleted.", true)}>
              Delete
            </ActionButton>
            <ActionButton className="btn" busyLabel="Submitting…" doneLabel="Submitted" onAction={() => run(submitDeclaration(actor, item.id), "Submitted for Finance verification.")}>
              Submit for verification
            </ActionButton>
          </>
        )}
        {mine && item.status === "submitted" && cfg.years.find((y) => y.financialYear === item.financialYear)?.open && (
          <ActionButton className="btn-ghost" busyLabel="Withdrawing…" onAction={() => run(withdrawDeclaration(actor, item.id), "Withdrawn to draft. You can edit it now.")}>
            Withdraw to edit
          </ActionButton>
        )}
        {verifying && item.status === "submitted" && !mine && (
          <>
            <ActionButton className="btn" busyLabel="Verifying…" doneLabel="Verified" onAction={() => run(decideDeclaration(actor, item.id, "verify", note, Number(allowed)), `${item.employeeName ?? "Item"} · ${item.section} verified.`)}>
              Verify
            </ActionButton>
            <ActionButton className="btn-ghost" busyLabel="Rejecting…" doneLabel="Rejected" onAction={() => run(decideDeclaration(actor, item.id, "reject", note), `${item.employeeName ?? "Item"} · ${item.section} rejected.`)}>
              Reject
            </ActionButton>
          </>
        )}
        <button className="btn-ghost" type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}

/** A preview of the year's declarations (what Finance will see), downloadable as PDF, with "submit all drafts". */
function PreviewDialog({ items, cfg, actor, fy, onClose, onMessage }: { items: Declaration[]; cfg: DeclConfig; actor: Actor; fy: string; onClose: () => void; onMessage: (m: { tone: "ok" | "err"; text: string }) => void }) {
  const rows = items.filter((d) => d.financialYear === fy);
  const drafts = rows.filter((d) => d.editable);
  const total = rows.reduce((s, d) => s + d.amount, 0);
  function pdf() {
    const doc = new PdfDoc(`Tax declarations ${fy} - ${actor.fullName}`);
    doc.text(42, 40, `Tax declarations · ${fy}`, { size: 16, bold: true });
    doc.text(42, 62, `${actor.fullName} · ${cfg.countryCode}${cfg.regime ? ` · ${cfg.regime} regime` : ""} · preview ${new Date().toLocaleDateString("en-GB")}`, { size: 9 });
    let y = 90;
    doc.text(42, y, "Section", { size: 9, bold: true });
    doc.text(150, y, "Item", { size: 9, bold: true });
    doc.text(420, y, "Status", { size: 9, bold: true });
    doc.text(553, y, "Amount", { size: 9, bold: true, align: "right" });
    y += 16;
    for (const d of rows) {
      doc.text(42, y, d.section, { size: 9 });
      doc.text(150, y, d.title.length > 48 ? `${d.title.slice(0, 47)}…` : d.title, { size: 9 });
      doc.text(420, y, STATUS_LABEL[d.status], { size: 9 });
      doc.text(553, y, pdfMoney(d.amount, d.currency), { size: 9, align: "right" });
      y += 15;
      if (y > 780) {
        doc.addPage();
        y = 50;
      }
    }
    doc.line(42, y, 553, y);
    doc.text(42, y + 6, "Total declared", { size: 10, bold: true });
    doc.text(553, y + 6, pdfMoney(total, cfg.currency), { size: 10, bold: true, align: "right" });
    doc.paragraph(42, y + 30, "Preview only. Amounts lower your tax once Finance verifies the proofs (India: old regime).", 511, { size: 8, color: [0.4, 0.42, 0.48] });
    saveFile(doc.toBlob(), `Tax-declarations-${fy}-preview.pdf`);
    return null;
  }
  async function submitAll() {
    for (const d of drafts) {
      const e = await submitDeclaration(actor, d.id);
      if (e) return `${d.section} · ${d.title}: ${e}`;
    }
    onMessage({ tone: "ok", text: `${drafts.length} item(s) submitted for Finance verification.` });
    onClose();
    return null;
  }
  return (
    <Dialog
      open
      wide
      title={`Preview · ${fy}`}
      onClose={onClose}
      actions={
        <>
          <ActionButton className="btn-ghost" busyLabel="Preparing…" doneLabel="Downloaded" onAction={pdf} success="Preview downloaded (PDF).">
            Download PDF
          </ActionButton>
          {drafts.length > 0 && (
            <ActionButton className="btn" busyLabel="Submitting…" onAction={submitAll} toastError>
              Submit {drafts.length} draft{drafts.length > 1 ? "s" : ""}
            </ActionButton>
          )}
          <button className="btn-ghost" type="button" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {rows.length === 0 ? (
        <p className="muted">Nothing declared for {fy} yet.</p>
      ) : (
        <div className="doc-table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Section</th>
                <th>Item</th>
                <th>Proofs</th>
                <th>Status</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td>{d.section}</td>
                  <td>{d.title}</td>
                  <td>{d.documents.length || <span className="muted">none</span>}</td>
                  <td>
                    <Status status={d.status} />
                  </td>
                  <td className="num">{money(d.amount, d.currency)}</td>
                </tr>
              ))}
              <tr>
                <th colSpan={4}>Total declared</th>
                <th className="num">{money(total, cfg.currency)}</th>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {drafts.some((d) => !d.documents.length) && <p className="note">Drafts without a proof can't be submitted — open them and attach one.</p>}
    </Dialog>
  );
}

function ItemsTable({ items, onOpen, showEmployee }: { items: Declaration[]; onOpen: (d: Declaration) => void; showEmployee?: boolean }) {
  if (!items.length) return <EmptyState title="Nothing here" description="No declarations match these filters." />;
  return (
    <div className="doc-table-wrap scroll-x">
      <table className="data">
        <thead>
          <tr>
            {showEmployee && <th>Employee</th>}
            <th>Section</th>
            <th>Item</th>
            <th>Tax year</th>
            <th className="num">Amount</th>
            <th className="num">Verified</th>
            <th>Proofs</th>
            <th>Status</th>
            <th>{showEmployee ? "Submitted" : "Updated"}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {items.map((d) => (
            <tr key={d.id}>
              {showEmployee && (
                <td>
                  {d.employeeName}
                  <div className="muted">{d.employeeCode}</div>
                </td>
              )}
              <td>{d.section}</td>
              <td>
                <button type="button" className="quiet-link" onClick={() => onOpen(d)}>
                  {d.title}
                </button>
              </td>
              <td>{d.financialYear}</td>
              <td className="num">{money(d.amount, d.currency)}</td>
              <td className="num">{d.verifiedAmount != null ? money(d.verifiedAmount, d.currency) : "—"}</td>
              <td>{d.documents.length}</td>
              <td>
                <Status status={d.status} />
              </td>
              <td>{when(showEmployee ? d.submittedAt : d.updatedAt)}</td>
              <td>
                <button type="button" className="btn-ghost btn-tiny" onClick={() => onOpen(d)}>
                  {showEmployee && d.status === "submitted" ? "Review" : "Open"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function useFilters(items: Declaration[]) {
  const [q, setQ] = useState("");
  const [year, setYear] = useState("");
  const [status, setStatus] = useState("");
  const [section, setSection] = useState("");
  const years = [...new Set(items.map((d) => d.financialYear))];
  const sections = [...new Set(items.map((d) => d.section))];
  const needle = q.trim().toLowerCase();
  const shown = items.filter(
    (d) =>
      (!year || d.financialYear === year) &&
      (!status || d.status === status) &&
      (!section || d.section === section) &&
      (!needle || [d.title, d.section, d.sectionLabel, d.employeeName ?? "", d.employeeCode ?? ""].some((t) => t.toLowerCase().includes(needle))),
  );
  const bar = (
    <div className="slip-filters">
      <label>
        Search
        <input type="search" value={q} placeholder="Item, section or person" onChange={(e) => setQ(e.target.value)} />
      </label>
      <label>
        Tax year
        <select value={year} onChange={(e) => setYear(e.target.value)}>
          <option value="">All years</option>
          {years.map((y) => (
            <option key={y}>{y}</option>
          ))}
        </select>
      </label>
      <label>
        Status
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any status</option>
          {(Object.keys(STATUS_LABEL) as DeclStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Section
        <select value={section} onChange={(e) => setSection(e.target.value)}>
          <option value="">All sections</option>
          {sections.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
    </div>
  );
  return { shown, bar };
}

function DeadlinesCard({ cfg, actor, onMessage }: { cfg: DeclConfig; actor: Actor; onMessage: (m: { tone: "ok" | "err"; text: string }) => void }) {
  const [fy, setFy] = useState(cfg.years[0]?.financialYear ?? "");
  const year = cfg.years.find((y) => y.financialYear === fy);
  const [opens, setOpens] = useState(year?.opensOn ?? "");
  const [deadline, setDeadline] = useState(year?.deadline ?? "");
  const [proof, setProof] = useState(year?.proofDeadline ?? "");
  const [locked, setLocked] = useState(year?.locked ?? false);
  useEffect(() => {
    setOpens(year?.opensOn ?? "");
    setDeadline(year?.deadline ?? "");
    setProof(year?.proofDeadline ?? "");
    setLocked(year?.locked ?? false);
  }, [year?.opensOn, year?.deadline, year?.proofDeadline, year?.locked]);
  return (
    <Card title={`Declaration deadlines · ${cfg.countryCode}`}>
      <p className="muted" style={{ marginTop: 0 }}>
        Employees can add, change or submit declarations from the opening date to the deadline; the India regime choice closes with it. Locking closes the year early.
      </p>
      <div className="form-grid">
        <Field label="Tax year">
          <select value={fy} onChange={(e) => setFy(e.target.value)}>
            {cfg.years.map((y) => (
              <option key={y.financialYear}>{y.financialYear}</option>
            ))}
          </select>
        </Field>
        <Field label="Opens">
          <input type="date" value={opens} onChange={(e) => setOpens(e.target.value)} />
        </Field>
        <Field label="Declaration deadline">
          <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
        </Field>
        <Field label="Proof deadline">
          <input type="date" value={proof} onChange={(e) => setProof(e.target.value)} />
        </Field>
        <label className="field">
          <span>Locked</span>
          <span>
            <input type="checkbox" checked={locked} onChange={(e) => setLocked(e.target.checked)} /> Close this year now
          </span>
        </label>
      </div>
      <div className="form-actions">
        <ActionButton
          className="btn"
          busyLabel="Saving…"
          doneLabel="Saved"
          onAction={async () => {
            const e = await setDeclarationWindow(actor, { countryCode: cfg.countryCode, financialYear: fy, opensOn: opens, deadline, proofDeadline: proof || undefined, locked });
            onMessage(e ? { tone: "err", text: e } : { tone: "ok", text: `Deadlines for ${fy} saved.` });
            return e;
          }}
        >
          Save deadlines
        </ActionButton>
      </div>
    </Card>
  );
}

export function TaxDeclarationsPage() {
  const { employee, demoProfile, state, payInput } = usePortal();
  useDeclarationsVersion();
  const regime = useTaxRegime(employee.id);
  const actor: Actor = { id: employee.id, fullName: employee.fullName, role: demoProfile.role, countryCode: employee.countryCode };
  const cfg = declConfig(actor);
  const legacy: InvestmentProof[] = state.investmentProofs;
  const mine = myDeclarations(actor, legacy);
  const queue = cfg?.verifier ? verifyQueue(actor, legacy) : [];
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "mine";
  const openId = params.get("item");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [preview, setPreview] = useState(false);
  const [fy, setFy] = useState("");
  const year = cfg?.years.find((y) => y.financialYear === fy) ?? cfg?.years[0];
  const mineF = useFilters(mine);
  const queueF = useFilters(queue);
  const open = [...mine, ...queue].find((d) => d.id === openId) ?? null;
  const setTab = (t: string) => setParams((p) => {
    const next = new URLSearchParams(p);
    next.set("tab", t);
    next.delete("item");
    return next;
  });
  const openItem = (d: Declaration | null) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (d) next.set("item", d.id);
      else next.delete("item");
      return next;
    });

  // Totals for the chosen year: declared, verified, pending; tax with verified items vs if the pending are verified.
  const totals = useMemo(() => {
    const rows = mine.filter((d) => d.financialYear === year?.financialYear);
    const sum = (f: (d: Declaration) => boolean, v: (d: Declaration) => number = (d) => d.amount) => rows.filter(f).reduce((s, d) => s + v(d), 0);
    return {
      declared: sum((d) => d.status !== "rejected"),
      verified: sum((d) => d.status === "verified", (d) => d.verifiedAmount ?? d.amount),
      pending: sum((d) => d.status === "submitted"),
      drafts: rows.filter((d) => d.status === "draft" || d.status === "rejected").length,
      pendingRows: rows.filter((d) => d.status === "submitted"),
    };
  }, [mine, year?.financialYear]);
  const tax = useMemo(() => {
    if (!cfg || !payInput) return null;
    const now = compareRegimes(payInput);
    const extra = totals.pendingRows.map((d) => ({ id: `p-${d.id}`, employeeId: employee.id, section: d.section, title: d.title, amount: d.amount, financialYear: d.financialYear, status: "verified" as const, submittedOn: "" }));
    const ifAll = compareRegimes({ ...payInput, investmentProofs: [...(payInput.investmentProofs ?? []), ...extra] });
    return { now, ifAll };
  }, [cfg, payInput, totals.pendingRows, employee.id]);

  if (!cfg) {
    const error = declarationsError();
    return (
      <Page title="Tax declarations">
        <Card>{declarationsLoaded() || error ? <p className="empty">{error ?? "Could not load your declarations."}</p> : <p className="muted">Loading your declarations…</p>}</Card>
      </Page>
    );
  }
  if (!cfg.hasDeclarations) {
    return (
      <Page title="Tax declarations" subtitle={employee.countryName}>
        <Card>
          <p className="empty">There are no personal tax declarations in {employee.countryName ?? "your country"} (no personal income tax).</p>
        </Card>
      </Page>
    );
  }
  const isIndia = cfg.countryCode === "IN";
  const newRegime = isIndia && regime === "new";
  const c = cfg.currency;
  const regimeTax = (r: { new: { annualTax: number }; old: { annualTax: number } }) => (isIndia ? r[regime === "old" ? "old" : "new"].annualTax : r.new.annualTax);

  return (
    <Page title="Tax declarations" subtitle={`${employee.countryName ?? "India"} · ${c} · Finance verifies proofs before they lower your tax`}>
      <Tabs
        tabs={[{ id: "mine", label: "My declarations" }, ...(cfg.verifier ? [{ id: "verify", label: `Verify${queue.filter((q) => q.status === "submitted").length ? ` (${queue.filter((q) => q.status === "submitted").length})` : ""}` }, { id: "deadlines", label: "Deadlines" }] : [])]}
        value={tab}
        onChange={setTab}
      />
      <Banner message={msg} />

      {tab === "mine" && (
        <>
          <Card>
            <div className="slip-filters" style={{ marginBottom: 8 }}>
              <label>
                Tax year
                <select value={year?.financialYear ?? ""} onChange={(e) => setFy(e.target.value)}>
                  {cfg.years.map((y) => (
                    <option key={y.financialYear}>{y.financialYear}</option>
                  ))}
                </select>
              </label>
              {year && (
                <p className="slip-legend">
                  {year.locked
                    ? "Closed by Finance."
                    : year.open
                      ? `Open until ${formatShortDate(year.deadline)} (${year.daysLeft} day${year.daysLeft === 1 ? "" : "s"} left)${year.proofDeadline ? ` · proofs by ${formatShortDate(year.proofDeadline)}` : ""}.`
                      : `Opens ${formatShortDate(year.opensOn)} · deadline ${formatShortDate(year.deadline)}.`}
                </p>
              )}
            </div>
            {year?.open && year.daysLeft <= 30 && totals.drafts > 0 && (
              <Banner message={{ tone: "warn", text: `${totals.drafts} item(s) are not submitted and the deadline is in ${year.daysLeft} days.` }} />
            )}
            <MetricGrid>
              <MetricCard label="Declared" value={money(totals.declared, c)} hint={year?.financialYear} />
              <MetricCard label="Verified by Finance" value={money(totals.verified, c)} hint="Counts in payroll tax" />
              <MetricCard label="Waiting for verification" value={money(totals.pending, c)} hint={`${totals.pendingRows.length} item(s)`} />
              {tax && (
                <MetricCard
                  label="Projected tax for the year (estimate)"
                  value={money(regimeTax(tax.now), c)}
                  hint={totals.pending > 0 && !newRegime ? `${money(regimeTax(tax.ifAll), c)} if pending items are verified` : isIndia ? `${regime === "old" ? "Old" : "New"} regime` : undefined}
                />
              )}
            </MetricGrid>
            <p className="slip-legend" style={{ marginTop: 8 }}>
              <SlipTag status="estimated" /> Projected tax is worked out from your pay and verified declarations. The figures on a <SlipTag status="final" /> payslip come from the locked payroll run. <Link to="/payslips">Payslips</Link>
            </p>
          </Card>
          {isIndia && (
            <Card title="Tax regime">
              <RegimePicker input={payInput} showLink={false} />
            </Card>
          )}
          <div className="split">
            <Card title="Declare" action={<button type="button" className="btn-ghost btn-tiny" onClick={() => setPreview(true)}>Preview & submit</button>}>
              {newRegime ? (
                <p className="empty">The new regime has no deductions to declare. Switch to the old regime above to declare investments, rent and loans.</p>
              ) : !cfg.years.some((y) => y.open) ? (
                <p className="empty">Declarations are closed for now.</p>
              ) : (
                <DeclarationForm
                  cfg={cfg}
                  actor={actor}
                  initial={{ financialYear: cfg.years.find((y) => y.open)?.financialYear ?? cfg.years[0].financialYear, section: cfg.sections[0]?.code ?? "", title: "", amount: "", note: "" }}
                  onDone={(text) => setMsg({ tone: "ok", text })}
                />
              )}
            </Card>
            <Card title="Sections">
              <div className="doc-table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Section</th>
                      <th className="num">Yearly limit</th>
                      <th className="num">Declared</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cfg.sections.map((s) => {
                      const used = mine.filter((d) => d.section === s.code && d.financialYear === year?.financialYear && d.status !== "rejected").reduce((t, d) => t + d.amount, 0);
                      return (
                        <tr key={s.code}>
                          <td>
                            {s.label}
                            <div className="muted">Proof: {s.proof}</div>
                          </td>
                          <td className="num">{s.cap != null ? money(s.cap, c) : "Actuals"}</td>
                          <td className="num">{used ? money(used, c) : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
          <Card title="My declarations and history">
            {mineF.bar}
            <ItemsTable items={mineF.shown} onOpen={openItem} />
          </Card>
        </>
      )}

      {tab === "verify" && cfg.verifier && (
        <Card title="Declarations to verify">
          <p className="muted" style={{ marginTop: 0 }}>
            People in your scope; never your own. Open an item to see the proofs, then verify (all or part of the amount) or reject with a comment.
          </p>
          {queueF.bar}
          <ItemsTable items={queueF.shown} onOpen={openItem} showEmployee />
        </Card>
      )}

      {tab === "deadlines" && cfg.verifier && <DeadlinesCard cfg={cfg} actor={actor} onMessage={setMsg} />}

      {open && cfg && <DeclarationDetail key={open.id} item={open} cfg={cfg} actor={actor} verifying={tab === "verify" || open.employeeId !== employee.id} onClose={() => openItem(null)} onMessage={setMsg} />}
      {preview && year && <PreviewDialog items={mine} cfg={cfg} actor={actor} fy={year.financialYear} onClose={() => setPreview(false)} onMessage={setMsg} />}
    </Page>
  );
}
