export { DocumentsPage } from "./RewardModules.tsx";
import { useEffect, useRef, useState } from "react";
import type { DragEvent, FormEvent, PointerEvent as ReactPointerEvent } from "react";
import * as XLSX from "xlsx";
import { Banner, Card, Field, Page, downloadText } from "../components/ui.tsx";
import { DownloadIcon } from "../components/icons.tsx";
import { DOCUMENT_GROUPS, formatStamp } from "../model.ts";
import type { DocumentGroup, EmployeeDocument } from "../model.ts";
import { usePortal } from "../store.tsx";

const emptyDocForm = {
  name: "",
  category: "Onboarding" as DocumentGroup,
  docType: "",
  expires: "",
  body: "",
};

export function LegacyEssDocumentsPage() {
  const { state, employee, addDocument, updateDocument, setDocumentShared } = usePortal();
  const docs = state.documents.filter((item) => item.employeeId === employee.id);
  const [group, setGroup] = useState<DocumentGroup>("Onboarding");
  const [pageSize, setPageSize] = useState(5);
  const [page, setPage] = useState(0);
  const [viewId, setViewId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyDocForm);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const inGroup = docs.filter((item) => item.category === group);
  const pageCount = Math.max(1, Math.ceil(inGroup.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const start = safePage * pageSize;
  const rows = inGroup.slice(start, start + pageSize);
  const viewing = docs.find((item) => item.id === viewId);

  function openAdd() {
    setEditingId(null);
    setForm({ ...emptyDocForm, category: group });
    setShowForm(true);
    setMessage(null);
  }

  function openEdit(doc: EmployeeDocument) {
    setEditingId(doc.id);
    setForm({
      name: doc.name,
      category: doc.category,
      docType: doc.docType,
      expires: doc.expires,
      body: doc.body,
    });
    setShowForm(true);
    setMessage(null);
  }

  function saveForm(event: FormEvent) {
    event.preventDefault();
    const error = editingId ? updateDocument(editingId, form) : addDocument(form);
    setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: editingId ? "Document updated." : "Document added." });
    if (!error) {
      setShowForm(false);
      setEditingId(null);
      setGroup(form.category);
      setPage(0);
    }
  }

  return (
    <Page
      title="My documents"
      action={
        <button className="btn" type="button" onClick={openAdd}>
          Add document
        </button>
      }
    >
      <Card>
        <div className="doc-tabs" role="tablist">
          {DOCUMENT_GROUPS.map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={item === group}
              className={item === group ? "active" : undefined}
              onClick={() => {
                setGroup(item);
                setPage(0);
              }}
            >
              {item}
            </button>
          ))}
        </div>
        <div className="doc-table-wrap">
          <table className="data doc-table">
            <thead>
              <tr>
                <th>Document</th>
                <th>Type</th>
                <th>Expires</th>
                <th>Uploaded</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5}>No documents in {group} yet.</td>
                </tr>
              ) : (
                rows.map((doc) => (
                  <tr key={doc.id}>
                    <td>{doc.name}</td>
                    <td>{doc.docType}</td>
                    <td>{doc.expires || "None"}</td>
                    <td>
                      {doc.uploadedBy}
                      <div className="muted">{formatStamp(doc.uploadedAt)}</div>
                    </td>
                    <td>
                      <div className="doc-actions">
                        <button className="btn-ghost btn-tiny" type="button" onClick={() => setViewId(doc.id)}>
                          View
                        </button>
                        <button
                          className="btn-ghost btn-tiny"
                          type="button"
                          onClick={() => downloadText(`${doc.name}.txt`, `${doc.name}\n${doc.docType}\n\n${doc.body}`)}
                        >
                          Download
                        </button>
                        <button className="btn-ghost btn-tiny" type="button" onClick={() => openEdit(doc)}>
                          Edit
                        </button>
                        <label className="share-toggle">
                          <input
                            type="checkbox"
                            checked={doc.shared}
                            onChange={(event) => setDocumentShared(doc.id, event.target.checked)}
                          />
                          Share
                        </label>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="pager">
          <label>
            Rows per page
            <select
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value));
                setPage(0);
              }}
            >
              <option value={5}>5</option>
              <option value={10}>10</option>
              <option value={20}>20</option>
            </select>
          </label>
          <span>
            {inGroup.length === 0 ? "0" : `${start + 1}–${Math.min(start + pageSize, inGroup.length)}`} of {inGroup.length}
          </span>
          <button className="btn-ghost btn-tiny" type="button" disabled={safePage === 0} onClick={() => setPage(0)}>
            First
          </button>
          <button className="btn-ghost btn-tiny" type="button" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>
            Previous
          </button>
          <button className="btn-ghost btn-tiny" type="button" disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>
            Next
          </button>
        </div>
      </Card>
      {showForm && (
        <Card title={editingId ? "Edit document" : "Add document"}>
          <form onSubmit={saveForm}>
            <div className="form-grid">
              <Field label="Document name">
                <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
              </Field>
              <Field label="Type">
                <input value={form.docType} onChange={(event) => setForm({ ...form, docType: event.target.value })} placeholder="Letter, ID, receipt" />
              </Field>
              <Field label="Group">
                <select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value as DocumentGroup })}>
                  {DOCUMENT_GROUPS.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </Field>
              <Field label="Expires">
                <input type="date" value={form.expires} onChange={(event) => setForm({ ...form, expires: event.target.value })} />
              </Field>
              <Field label="Note" wide>
                <textarea value={form.body} onChange={(event) => setForm({ ...form, body: event.target.value })} />
              </Field>
            </div>
            <div className="form-actions">
              <button className="btn" type="submit">
                Save
              </button>
              <button className="btn-ghost" type="button" onClick={() => setShowForm(false)}>
                Cancel
              </button>
            </div>
            <Banner message={message} />
          </form>
        </Card>
      )}
      {viewing && (
        <Card
          title={viewing.name}
          action={
            <button className="btn-ghost btn-tiny" type="button" onClick={() => setViewId(null)}>
              Close
            </button>
          }
        >
          <p className="muted">
            {viewing.docType}
            {viewing.expires ? ` · expires ${viewing.expires}` : " · no expiry"}
            {viewing.shared ? " · shared with HR" : " · private"}
          </p>
          <p className="prose">{viewing.body}</p>
        </Card>
      )}
    </Page>
  );
}

export function FormsPage() {
  const { state } = usePortal();
  return (
    <Page title="Forms">
      <Card>
        <table className="data">
          <thead>
            <tr>
              <th>Form</th>
              <th>Category</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {state.forms.map((form) => (
              <tr key={form.id}>
                <td>{form.name}</td>
                <td>{form.category}</td>
                <td>
                  <button className="btn-ghost btn-tiny" type="button" onClick={() => downloadText(`${form.name}.txt`, form.body)}>
                    Download
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </Page>
  );
}

export function FilesPage() {
  const { state } = usePortal();
  return (
    <Page title="File storage">
      <Card>
        <table className="data doc-table">
          <thead>
            <tr>
              <th>Folder</th>
              <th>File</th>
              <th>Updated</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {state.files.map((file) => (
              <tr key={file.id}>
                <td>{file.folder}</td>
                <td>{file.name}</td>
                <td>{file.updated}</td>
                <td>{file.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </Page>
  );
}

export function PoliciesPage() {
  const { state } = usePortal();
  const [query, setQuery] = useState("");
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(0);
  const [openId, setOpenId] = useState("");
  const filtered = state.policies.filter((policy) => policy.title.toLowerCase().includes(query.trim().toLowerCase()));
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const start = safePage * pageSize;
  const visible = filtered.slice(start, start + pageSize);
  const open = state.policies.find((policy) => policy.id === openId);

  return (
    <Page
      title="Policies"
      action={
        <input
          className="policy-search"
          value={query}
          placeholder="Search..."
          aria-label="Search policies"
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(0);
          }}
        />
      }
    >
      <Card>
        <div className="doc-table-wrap">
          <table className="data doc-table">
            <thead>
              <tr>
                <th>Document name</th>
                <th>Type</th>
                <th>File type</th>
                <th>Updated by</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((policy) => (
                <tr key={policy.id}>
                  <td>{policy.title}</td>
                  <td>{policy.kind}</td>
                  <td>{policy.fileType}</td>
                  <td>{policy.updatedBy}</td>
                  <td>
                    <span className="doc-actions">
                      <button className="icon-btn" type="button" aria-label={`View ${policy.title}`} onClick={() => setOpenId(policy.id === openId ? "" : policy.id)}>
                        <EyeIcon />
                      </button>
                      <button
                        className="icon-btn"
                        type="button"
                        aria-label={`Download ${policy.title}`}
                        onClick={() => downloadText(`${policy.title}.txt`, `${policy.title}\nUpdated by ${policy.updatedBy} on ${policy.updated}\n\n${policy.body}`)}
                      >
                        <DownloadIcon />
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {visible.length === 0 && <p className="empty">No policy matches that search.</p>}
        <div className="pager">
          <label>
            Rows per page
            <select
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value));
                setPage(0);
              }}
            >
              {[10, 25, 100].map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <span>
            {filtered.length === 0 ? "0" : `${start + 1}–${Math.min(start + pageSize, filtered.length)}`} of {filtered.length}
          </span>
          <span className="doc-actions">
            <button className="icon-btn" type="button" aria-label="Previous page" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>
              ‹
            </button>
            <button className="icon-btn" type="button" aria-label="Next page" disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>
              ›
            </button>
          </span>
        </div>
        {open && (
          <div className="prose policy-view">
            <h2>{open.title}</h2>
            <p className="muted">
              {open.fileType} · Updated by {open.updatedBy} on {open.updated}
            </p>
            <p>{open.body}</p>
          </div>
        )}
      </Card>
    </Page>
  );
}

function EyeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
      <path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12Z" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="12" cy="12" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

type ConvertTarget = "csv" | "xlsx" | "qbo";

const CONVERT_TARGETS: { id: ConvertTarget; label: string }[] = [
  { id: "csv", label: "CSV" },
  { id: "xlsx", label: "Excel" },
  { id: "qbo", label: "QBO" },
];

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else quoted = false;
      } else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell.trim());
      cell = "";
    } else if (char === "\n") {
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") cell += char;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.trim());
    rows.push(row);
  }
  return rows.filter((line) => line.some((value) => value.length > 0));
}

function toCsv(rows: string[][]): string {
  return rows
    .map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(","))
    .join("\n");
}

function parseQbo(text: string): string[][] {
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  const rows = [["Date", "Amount", "Name"]];
  for (const block of blocks) {
    const date = block.match(/<DTPOSTED>([^<\n]+)/i)?.[1]?.trim().slice(0, 8) ?? "";
    const amount = block.match(/<TRNAMT>([^<\n]+)/i)?.[1]?.trim() ?? "";
    const name = block.match(/<NAME>([^<\n]+)/i)?.[1]?.trim() ?? "";
    if (date || amount || name) rows.push([date, amount, name]);
  }
  return rows.length > 1 ? rows : [];
}

function toQbo(rows: string[][]): string {
  const header = rows[0]?.map((cell) => cell.toLowerCase()) ?? [];
  const amountIndex = header.findIndex((cell) => /amount|amt|total|debit|credit/.test(cell));
  const dateIndex = header.findIndex((cell) => /date|posted/.test(cell));
  const nameIndex = header.findIndex((cell) => /name|payee|description|memo|detail/.test(cell));
  if (amountIndex < 0) throw new Error("QBO needs a column named Amount, Total, Debit, or Credit.");
  const body = rows.slice(1).map((row, index) => {
    const rawDate = (dateIndex >= 0 ? row[dateIndex] : "").replaceAll(/\D/g, "").slice(0, 8);
    const amount = Number(String(row[amountIndex] ?? "").replace(/[^0-9.-]/g, ""));
    const name = (nameIndex >= 0 ? row[nameIndex] : row.find((cell) => cell && cell !== row[amountIndex]) ?? "Transaction").slice(0, 32);
    return `<STMTTRN>
<TRNTYPE>${amount < 0 ? "DEBIT" : "CREDIT"}
<DTPOSTED>${rawDate || "20260101"}
<TRNAMT>${Number.isFinite(amount) ? amount.toFixed(2) : "0.00"}
<FITID>ALDER${index + 1}
<NAME>${name}
</STMTTRN>`;
  });
  return `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKTRANLIST>
${body.join("\n")}
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;
}

async function readSheet(file: File): Promise<string[][]> {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "csv" || extension === "txt") return parseCsv(await file.text());
  if (extension === "qbo" || extension === "ofx") {
    const rows = parseQbo(await file.text());
    if (rows.length === 0) throw new Error("No transactions were found in that QBO file.");
    return rows;
  }
  if (extension === "xlsx" || extension === "xls") {
    const book = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const sheetName = book.SheetNames[0];
    if (!sheetName) throw new Error("That workbook has no sheets.");
    const grid = XLSX.utils.sheet_to_json<(string | number | null)[]>(book.Sheets[sheetName], { header: 1, raw: false });
    return grid
      .map((row) => row.map((cell) => String(cell ?? "").trim()))
      .filter((row) => row.some((cell) => cell.length > 0));
  }
  throw new Error("Use a CSV, Excel, or QBO file.");
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function ConvertPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<string[][]>([]);
  const [target, setTarget] = useState<ConvertTarget>("csv");
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  async function takeFile(file: File | undefined) {
    if (!file) return;
    try {
      const parsed = await readSheet(file);
      if (parsed.length === 0) throw new Error("That file has no rows.");
      setRows(parsed);
      setFileName(file.name);
      setMessage(null);
    } catch (error) {
      setRows([]);
      setFileName("");
      setMessage({ tone: "err", text: error instanceof Error ? error.message : "That file could not be read." });
    }
  }

  function onDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setDragging(false);
    void takeFile(event.dataTransfer.files[0]);
  }

  function submit() {
    if (rows.length === 0) {
      setMessage({ tone: "err", text: "Choose a file first." });
      return;
    }
    const base = fileName.replace(/\.[^.]+$/, "") || "converted";
    try {
      if (target === "csv") {
        downloadBlob(`${base}.csv`, new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" }));
      } else if (target === "xlsx") {
        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "Sheet1");
        XLSX.writeFile(book, `${base}.xlsx`);
      } else {
        downloadBlob(`${base}.qbo`, new Blob([toQbo(rows)], { type: "application/vnd.intu.qbo" }));
      }
      setMessage({ tone: "ok", text: `Downloaded as ${target === "xlsx" ? "Excel" : target.toUpperCase()}.` });
    } catch (error) {
      setMessage({ tone: "err", text: error instanceof Error ? error.message : "Conversion failed." });
    }
  }

  const preview = rows.slice(0, 6);

  return (
    <Page title="File conversion" subtitle="Convert to CSV, Excel or QBO">
      <Card>
        <div className="convert">
          <button
            type="button"
            className={dragging ? "dropzone over" : "dropzone"}
            onClick={() => inputRef.current?.click()}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <strong>Drop a file here</strong>
            <span>{fileName || "CSV, Excel, or QBO"}</span>
          </button>
          <p className="convert-or">or</p>
          <button className="btn-ghost" type="button" onClick={() => inputRef.current?.click()}>
            Choose file
          </button>
          <input
            ref={inputRef}
            className="file-input"
            type="file"
            accept=".csv,.txt,.xlsx,.xls,.qbo,.ofx,text/csv"
            onChange={(event) => {
              void takeFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
          <p className="convert-note">Accepted files: CSV, Excel (.xlsx), and QBO.</p>
          <div className="convert-rule" />
          <p className="convert-label">Convert to</p>
          <div className="convert-choices" role="group" aria-label="Output format">
            {CONVERT_TARGETS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={target === item.id ? "active" : undefined}
                onClick={() => setTarget(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <button className="btn" type="button" onClick={submit}>
            Convert
          </button>
          <Banner message={message} />
        </div>
        {preview.length > 0 && (
          <div className="doc-table-wrap">
            <table className="data">
              <tbody>
                {preview.map((row, index) => (
                  <tr key={index}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > preview.length && <p className="note">Showing the first {preview.length} of {rows.length} rows.</p>}
          </div>
        )}
      </Card>
    </Page>
  );
}

export function SignPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [name, setName] = useState("");
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const { state, employee, addSignature } = usePortal();
  const signatures = state.signatures.filter((item) => item.employeeId === employee.id);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = canvas.offsetWidth * ratio;
    canvas.height = 160 * ratio;
    context.scale(ratio, ratio);
    context.lineWidth = 2;
    context.lineCap = "round";
    context.strokeStyle = "#163e6b";
  }, []);

  function point(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function start(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    drawing.current = true;
    canvas.setPointerCapture(event.pointerId);
    const { x, y } = point(event);
    context.beginPath();
    context.moveTo(x, y);
  }

  function move(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const context = canvasRef.current?.getContext("2d");
    if (!context) return;
    const { x, y } = point(event);
    context.lineTo(x, y);
    context.stroke();
    setDirty(true);
  }

  function clearPad() {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    setDirty(false);
  }

  return (
    <Page title="Digital Sign">
      <Card title="Sign a document">
        <Field label="Document name">
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Example: September timesheet" />
        </Field>
        <canvas
          ref={canvasRef}
          className="sign-pad"
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={() => {
            drawing.current = false;
          }}
          onPointerLeave={() => {
            drawing.current = false;
          }}
        />
        <div className="form-actions">
          <button className="btn-ghost" type="button" onClick={clearPad}>
            Clear
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => {
              const canvas = canvasRef.current;
              const error = addSignature(name, dirty && canvas ? canvas.toDataURL("image/png") : "");
              setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Signature saved." });
              if (!error) {
                setName("");
                clearPad();
              }
            }}
          >
            Save signature
          </button>
        </div>
        <Banner message={message} />
      </Card>
      {signatures.length > 0 && (
        <Card title="Signed documents">
          <div className="sig-list">
            {signatures.map((item) => (
              <figure key={item.id}>
                <img src={item.dataUrl} alt={`Signature for ${item.documentName}`} />
                <figcaption>
                  {item.documentName}
                  <br />
                  {formatStamp(item.signedAt)}
                </figcaption>
              </figure>
            ))}
          </div>
        </Card>
      )}
    </Page>
  );
}
