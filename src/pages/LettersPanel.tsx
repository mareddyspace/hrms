/** Documents & Letters — letter request, approval, generation and access (blueprint §24 / §39). */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { API_ENABLED } from "../api/client.ts";
import {
  apiCancelLetter,
  apiDecideLetter,
  apiIssueLetter,
  apiRequestLetter,
  downloadLetterPdf,
  fetchLetterPreview,
  type LetterPreviewOut,
} from "../api/syncRewards.ts";
import { LetterDownloadButtons, LetterFrame, printLetter } from "../components/LetterDocument.tsx";
import { ActionButton, Banner, Card, DataTable, Dialog, EmptyState, Field, StatusBadge, SubmitButton, notify, useAction } from "../components/ui.tsx";
import {
  approveLetter,
  canApproveLetterRow,
  canRequestType,
  canSeeLetter,
  collectLetterFields,
  currentIssue,
  issuedLetterHtml,
  letterApproversFor,
  needsChecker,
  previewLetter,
  regenerateLetter,
  rejectLetter,
  requestLetter,
  updateLetterInputs,
} from "../data/letterService.ts";
import {
  ALL_LETTER_TEMPLATES,
  letterDate,
  letterDocumentHtml,
  letterFileName,
  letterInfo,
  missingFields,
  type FullLetterType,
} from "../data/letterTemplates.ts";
import { listPeople, subscribePeople } from "../data/peopleLocal.ts";
import { canManageLetters } from "../data/rbac.ts";
import type { LetterRequest, LetterType } from "../data/rewardData.ts";
import { getRewardState, nextLetterStatuses, runRewardApi, setLetterStatus, subscribeReward } from "../data/rewardLocal.ts";
import type { DemoAccount } from "../demoAccounts.ts";
import { getExitState, subscribeExits } from "../features/lifecycle/exitStore.ts";
import { todayISO } from "../model.ts";

type Msg = { tone: "ok" | "err"; text: string } | null;
export type OpenLetter = { letterId: string; docId?: string } | null;

function useLetterData() {
  const reward = useSyncExternalStore(subscribeReward, getRewardState, getRewardState);
  // Re-render when directory or exit data change — both feed merge fields.
  useSyncExternalStore(subscribePeople, listPeople, listPeople);
  useSyncExternalStore(subscribeExits, getExitState, getExitState);
  return reward;
}

const label = (type: FullLetterType) => letterInfo(type).label;

/** Backend mode: the server already returns only the letters this viewer may see. */
const visibleTo = (actor: DemoAccount, row: LetterRequest) => (row.api ? true : canSeeLetter(actor, row));

const pdfName = (row: LetterRequest, version?: number) =>
  `${letterFileName(row.type, row.employeeName.replace(/\s+/g, "-"), version ?? row.api?.issues.at(-1)?.version ?? 1).replace(/\.html?$/i, "")}.pdf`;

/** Backend mode: the letter's actions (approve, reject, cancel, generate, PDF). */
function ApiLetterActions({ row, onOpen, onResult }: { row: LetterRequest; onOpen?: () => void; onResult: (msg: Msg) => void }) {
  const info = row.api!;
  const [busy, setBusy] = useState(false);
  async function go(call: () => Promise<string | null>, ok: string) {
    if (busy) return false;
    setBusy(true);
    const error = await runRewardApi(call(), ["letters"]);
    setBusy(false);
    onResult(error ? { tone: "err", text: error } : { tone: "ok", text: ok });
    if (!error) notify(ok);
    return error;
  }
  async function pdf() {
    const error = await downloadLetterPdf(row.id, pdfName(row));
    if (error) onResult({ tone: "err", text: error });
  }
  return (
    <span className="reward-actions">
      {onOpen && (
        <button type="button" className="quiet-link" onClick={onOpen}>
          {info.issues.length ? "Open" : "Preview"}
        </button>
      )}
      {info.canDecide && (
        <>
          <ActionButton className="btn" disabled={busy} onAction={() => go(() => apiDecideLetter(row.id, "approve"), `${label(row.type)} approved for ${row.employeeName}.`)}>
            Approve
          </ActionButton>
          <ActionButton className="btn-ghost" disabled={busy} onAction={() => go(() => apiDecideLetter(row.id, "reject"), `${label(row.type)} request rejected for ${row.employeeName}.`)}>
            Reject
          </ActionButton>
        </>
      )}
      {info.canCancel && (
        <ActionButton className="btn-ghost" disabled={busy} onAction={() => go(() => apiCancelLetter(row.id), "Letter request cancelled.")}>
          Cancel
        </ActionButton>
      )}
      {info.canIssue && (
        <ActionButton
          className="btn-ghost"
          disabled={busy}
          busyLabel="Generating…"
          doneLabel="Generated"
          onAction={() => go(() => apiIssueLetter(row.id), info.issues.length ? `Regenerated as v${info.issues.length + 1}.` : "Letter generated.")}
        >
          {info.issues.length ? "Regenerate" : "Generate PDF"}
        </ActionButton>
      )}
      {row.status === "Issued" && info.issues.length > 0 && (
        <button type="button" className="btn-ghost" onClick={() => void pdf()}>
          PDF
        </button>
      )}
    </span>
  );
}

function MissingList({ missing }: { missing: string[] }) {
  if (!missing.length) return null;
  return (
    <div className="letter-missing" role="alert">
      <strong>Cannot generate yet — missing:</strong>
      <ul>
        {missing.map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ul>
    </div>
  );
}

/* ───────────── Request + workflow ───────────── */

export function LetterRequestsPanel({ actor, onOpen }: { actor: DemoAccount; onOpen: (open: OpenLetter) => void }) {
  const reward = useLetterData();
  const hr = canManageLetters(actor);
  const people = useSyncExternalStore(subscribePeople, listPeople, listPeople);
  const [employeeId, setEmployeeId] = useState(actor.id);
  const types = hr ? ALL_LETTER_TEMPLATES : ALL_LETTER_TEMPLATES.filter((t) => t.employeeCanRequest);
  const [type, setType] = useState<FullLetterType>("Employment");
  const [note, setNote] = useState("");
  const [details, setDetails] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [msg, setMsg] = useState<Msg>(null);

  const subjectId = hr ? employeeId : actor.id;
  const template = letterInfo(type);
  const blocked = canRequestType(actor, type, subjectId);
  const missing = useMemo(() => {
    const draft = {
      id: "draft",
      employeeId: subjectId,
      employeeName: "",
      type: type as LetterType,
      status: "Draft",
      requestedBy: actor.fullName,
      requestedOn: todayISO(),
      note,
      previewBody: "",
      details,
      effectiveDate,
    } satisfies LetterRequest;
    return missingFields(type, collectLetterFields(draft, reward.history));
  }, [subjectId, type, note, details, effectiveDate, actor.fullName, reward.history]);

  const letters = reward.letters.filter((l) => visibleTo(actor, l));
  const sortedPeople = [...people].sort((a, b) => a.fullName.localeCompare(b.fullName));

  function act(fn: () => string | null, ok: string) {
    const error = fn();
    setMsg(error ? { tone: "err", text: error } : { tone: "ok", text: ok });
    if (!error) notify(ok);
    return error;
  }

  const requestAction = useAction();

  async function submitRequest() {
    if (API_ENABLED) {
      const error = await runRewardApi(apiRequestLetter({ employeeId: subjectId, type, note, details, effectiveDate }), ["letters"]);
      if (error) {
        setMsg({ tone: "err", text: error });
        return false;
      }
      setMsg({
        tone: "ok",
        text: template.secondApproval ? `${template.label} raised. It needs a second approver.` : `${template.label} requested — awaiting approval.`,
      });
      notify(template.secondApproval ? `${template.label} raised and sent for second approval.` : `${template.label} request sent for approval.`);
      setNote("");
      setDetails("");
      setEffectiveDate("");
      return true;
    }
    const error = requestLetter(actor, { employeeId: subjectId, type, note, details, effectiveDate });
    if (error) {
      setMsg({ tone: "err", text: error });
      return false;
    }
    const checker = needsChecker({ employeeId: subjectId, type, requestedById: actor.id });
    setMsg({
      tone: "ok",
      text: checker ? `${template.label} raised. It needs a second approver.` : `${template.label} requested — awaiting approval.`,
    });
    notify(checker ? `${template.label} raised and sent for second approval.` : `${template.label} request sent for approval.`);
    setNote("");
    setDetails("");
    setEffectiveDate("");
    return true;
  }

  return (
    <div className="mgr-home-grid">
      <Card title="Request a letter">
        <form className="stack" onSubmit={requestAction.submit(submitRequest)}>
          {hr && (
            <Field label="Employee">
              <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
                {!sortedPeople.some((p) => p.id === actor.id) && <option value={actor.id}>{actor.fullName}</option>}
                {sortedPeople.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.fullName} · {p.employeeCode}
                    {p.employmentStatus === "Terminated" ? " (left)" : ""}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Letter type">
            <select value={type} onChange={(e) => setType(e.target.value as FullLetterType)}>
              {types.map((t) => (
                <option key={t.type} value={t.type}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          {template.detailsLabel && (
            <Field label={template.detailsLabel} wide>
              <input value={details} maxLength={200} onChange={(e) => setDetails(e.target.value)} required />
            </Field>
          )}
          {hr && template.effectiveInput && (
            <Field label={type === "Termination" ? "Termination date" : type === "Internship" ? "Internship end date" : "Effective date"}>
              <input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
            </Field>
          )}
          <Field label="Reason" wide>
            <input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="e.g. bank loan, visa appointment" />
          </Field>
          {blocked ? <Banner message={{ tone: "warn", text: blocked }} /> : hr && !API_ENABLED && <MissingList missing={missing} />}
          <SubmitButton action={requestAction} className="btn" disabled={!!blocked}>
            Request letter
          </SubmitButton>
        </form>
        <h3 style={{ fontSize: 14, marginTop: 16 }}>Templates</h3>
        <DataTable
          headers={["Letter", "Contents", "Requested by"]}
          rows={ALL_LETTER_TEMPLATES.map((t) => [t.label, t.description, t.employeeCanRequest ? "Employee or HR" : t.secondApproval ? "HR only, second approver" : "HR only"])}
        />
      </Card>

      <Card title="Letter requests">
        <Banner message={msg} />
        <DataTable
          headers={["Employee", "Letter", "Status", "Version", "Approver", "Actions"]}
          rows={letters.map((l) => {
            if (l.api) {
              const latest = l.api.issues.at(-1);
              return [
                l.employeeName,
                label(l.type),
                <StatusBadge key={`${l.id}-s`} status={l.status} literal />,
                latest ? `v${latest.version}` : "—",
                l.approver ?? (l.api.issueError ? `Not generated: ${l.api.issueError}` : "—"),
                <ApiLetterActions key={`${l.id}-a`} row={l} onOpen={() => onOpen({ letterId: l.id })} onResult={setMsg} />,
              ];
            }
            const issue = currentIssue(l);
            const canDecide = canApproveLetterRow(actor, l) && (l.status === "Pending approval" || l.status === "Approved");
            const submit = nextLetterStatuses(actor, l).includes("Pending approval");
            const approverText =
              l.approver ?? (l.status === "Pending approval" ? letterApproversFor(l).map((a) => a.fullName).join(", ") || "None available" : "—");
            return [
              l.employeeName,
              label(l.type),
              <StatusBadge key={`${l.id}-s`} status={l.status} literal />,
              issue ? `v${issue.version}` : "—",
              approverText,
              <span key={`${l.id}-a`} className="reward-actions">
                <button type="button" className="quiet-link" onClick={() => onOpen({ letterId: l.id })}>
                  {issue ? "Open" : "Preview"}
                </button>
                {submit && (
                  <ActionButton className="btn" onAction={() => act(() => setLetterStatus(actor, l.id, "Pending approval"), `${label(l.type)} submitted for approval.`)}>
                    Submit
                  </ActionButton>
                )}
                {canDecide && (
                  <>
                    <ActionButton className="btn" onAction={() => act(() => approveLetter(actor, l.id), `${label(l.type)} approved and generated for ${l.employeeName}.`)}>
                      Approve &amp; generate
                    </ActionButton>
                    <ActionButton className="btn-ghost" onAction={() => act(() => rejectLetter(actor, l.id), `${label(l.type)} request rejected for ${l.employeeName}.`)}>
                      Reject
                    </ActionButton>
                  </>
                )}
                {l.status === "Issued" && canApproveLetterRow(actor, l) && (
                  <ActionButton
                    className="btn-ghost"
                    busyLabel="Generating…"
                    doneLabel="Regenerated"
                    onAction={() => act(() => regenerateLetter(actor, l.id), `Regenerated as v${(l.issued?.length ?? 0) + 1}.`)}
                  >
                    Regenerate
                  </ActionButton>
                )}
                {issue && (
                  <button type="button" className="btn-ghost" onClick={() => printLetter(issuedLetterHtml(l, issue))}>
                    PDF
                  </button>
                )}
              </span>,
            ];
          })}
          empty={<EmptyState title="No letter requests" />}
        />
      </Card>
    </div>
  );
}

/* ───────────── History ───────────── */

export function LetterHistoryPanel({ actor, onOpen }: { actor: DemoAccount; onOpen: (open: OpenLetter) => void }) {
  const reward = useLetterData();
  const letters = reward.letters.filter((l) => visibleTo(actor, l));
  return (
    <Card title="Request and approval history">
      <DataTable
        headers={["Requested", "Employee", "Letter", "By", "Status", "Approver", "Decided", "Document", "Note"]}
        rows={letters.map((l) => {
          const issue = currentIssue(l);
          const apiIssue = l.api?.issues.at(-1);
          return [
            l.requestedOn,
            l.employeeName,
            label(l.type),
            l.requestedBy,
            <StatusBadge key={l.id} status={l.status} literal />,
            l.approver ?? "—",
            l.decidedOn ?? "—",
            apiIssue ? (
              <button key={`${l.id}-d`} type="button" className="quiet-link" onClick={() => onOpen({ letterId: l.id })}>
                {apiIssue.referenceNo} · v{apiIssue.version}
              </button>
            ) : issue ? (
              <button key={`${l.id}-d`} type="button" className="quiet-link" onClick={() => onOpen({ letterId: l.id, docId: issue.docId })}>
                {issue.docId} · v{issue.version}
              </button>
            ) : (
              "—"
            ),
            l.note,
          ];
        })}
        empty={<EmptyState title="No letter requests" />}
      />
    </Card>
  );
}

/* ───────────── Employee access ───────────── */

export function MyLettersPanel({ actor, onOpen }: { actor: DemoAccount; onOpen: (open: OpenLetter) => void }) {
  const reward = useLetterData();
  const mine = reward.letters.filter((l) => l.employeeId === actor.id && l.status === "Issued");
  const [msg, setMsg] = useState<Msg>(null);
  return (
    <Card title="My letters">
      <Banner message={msg} />
      <DataTable
        headers={["Letter", "Version", "Reference", "Approved", ""]}
        rows={mine.map((l) => {
          const apiIssue = l.api?.issues.at(-1);
          if (l.api) {
            if (!apiIssue) return [label(l.type), "—", "—", l.decidedOn ?? "—", <span key={l.id} className="muted">Not generated — ask HR to regenerate</span>];
            return [
              label(l.type),
              `v${apiIssue.version}`,
              apiIssue.referenceNo,
              `${l.approver ? `${l.approver}, ` : ""}${apiIssue.on}`,
              <span key={l.id} className="reward-actions">
                <button type="button" className="quiet-link" onClick={() => onOpen({ letterId: l.id })}>
                  Open
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => void downloadLetterPdf(l.id, pdfName(l, apiIssue.version)).then((e) => e && setMsg({ tone: "err", text: e }))}
                >
                  Download PDF
                </button>
              </span>,
            ];
          }
          const issue = currentIssue(l);
          if (!issue) return [label(l.type), "—", "—", l.decidedOn ?? "—", <span key={l.id} className="muted">Not generated — ask HR to regenerate</span>];
          return [
            label(l.type),
            `v${issue.version}`,
            issue.referenceNo,
            `${issue.approvedBy}, ${issue.approvedOn}`,
            <span key={l.id} className="reward-actions">
              <button type="button" className="quiet-link" onClick={() => onOpen({ letterId: l.id, docId: issue.docId })}>
                Open
              </button>
              <button type="button" className="btn-ghost" onClick={() => printLetter(issuedLetterHtml(l, issue))}>
                Download PDF
              </button>
            </span>,
          ];
        })}
        empty={<EmptyState title="No issued letters" description="Request a letter under Letters & templates." />}
      />
    </Card>
  );
}

/* ───────────── Viewer ───────────── */

export function LetterViewerDialog({ actor, open, onClose }: { actor: DemoAccount; open: OpenLetter; onClose: () => void }) {
  const reward = useLetterData();
  const row = open ? reward.letters.find((l) => l.id === open.letterId) : undefined;
  const [docId, setDocId] = useState<string | undefined>(undefined);
  const [msg, setMsg] = useState<Msg>(null);
  const [editKey, setEditKey] = useState("");
  const [details, setDetails] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");
  const detailsAction = useAction();

  if (!open) return null;
  if (row?.api) return <ApiLetterViewer row={row} onClose={onClose} />;
  if (!row || !canSeeLetter(actor, row)) {
    return (
      <Dialog open title="Letter" onClose={onClose}>
        <EmptyState title="Letter not available" />
      </Dialog>
    );
  }

  // Reset the editor when a different letter opens.
  if (editKey !== row.id) {
    setEditKey(row.id);
    setDetails(row.details ?? "");
    setEffectiveDate(row.effectiveDate ?? "");
    setDocId(open.docId);
    setMsg(null);
  }

  const issues = row.issued ?? [];
  const issue = issues.find((i) => i.docId === docId) ?? currentIssue(row);
  const template = letterInfo(row.type);
  const open_ = row.status === "Pending approval" || row.status === "Draft" || row.status === "Approved";
  const hr = canManageLetters(actor) && actor.id !== row.employeeId;
  const canEdit = open_ && (hr || row.requestedById === actor.id);
  const canDecide = canApproveLetterRow(actor, row) && (row.status === "Pending approval" || row.status === "Approved");

  if (issue) {
    const html = issuedLetterHtml(row, issue);
    return (
      <Dialog
        open
        wide
        title={`${template.label} — ${row.employeeName}`}
        onClose={onClose}
        actions={<LetterDownloadButtons html={html} fileName={letterFileName(row.type, row.employeeName.replace(/\s+/g, "-"), issue.version)} />}
      >
        {issues.length > 1 && (
          <Field label="Version">
            <select value={issue.docId} onChange={(e) => setDocId(e.target.value)}>
              {issues.map((i) => (
                <option key={i.docId} value={i.docId}>
                  v{i.version} · {i.generatedOn}
                  {i === issues[issues.length - 1] ? " (current)" : ""}
                </option>
              ))}
            </select>
          </Field>
        )}
        <p className="letter-meta">
          {issue.referenceNo} · {issue.docId} · v{issue.version} · approved by {issue.approvedBy} on {issue.approvedOn}
        </p>
        <LetterFrame html={html} title={`${template.label} v${issue.version}`} />
      </Dialog>
    );
  }

  const preview = previewLetter(row, reward.history);
  return (
    <Dialog
      open
      wide
      title={`${template.label} — ${row.employeeName} (draft)`}
      onClose={onClose}
      actions={
        canDecide ? (
          <>
            <ActionButton
              className="btn-ghost"
              success={`${template.label} request rejected for ${row.employeeName}.`}
              onAction={() => {
                const error = rejectLetter(actor, row.id);
                setMsg(error ? { tone: "err", text: error } : { tone: "ok", text: "Request rejected." });
                return error;
              }}
            >
              Reject
            </ActionButton>
            <ActionButton
              className="btn"
              disabled={preview.missing.length > 0}
              success={`${template.label} approved and generated for ${row.employeeName}.`}
              onAction={() => {
                const error = approveLetter(actor, row.id);
                setMsg(error ? { tone: "err", text: error } : { tone: "ok", text: "Approved — final letter generated." });
                return error;
              }}
            >
              Approve &amp; generate
            </ActionButton>
          </>
        ) : undefined
      }
    >
      <Banner message={msg} />
      <p className="letter-meta">
        Status: {row.status}
        {row.status === "Pending approval" && ` · approver: ${letterApproversFor(row).map((a) => a.fullName).join(", ") || "none available"}`}
        {` · ${letterDate(todayISO(), preview.fields.countryCode)}`}
      </p>
      <MissingList missing={preview.missing} />
      {canEdit && (template.detailsLabel || (hr && template.effectiveInput) || preview.missing.includes("Effective date")) && (
        <form
          className="letter-inputs"
          onSubmit={detailsAction.submit(
            () => {
              const error = updateLetterInputs(actor, row.id, {
                details: template.detailsLabel ? details : undefined,
                effectiveDate: hr ? effectiveDate : undefined,
              });
              setMsg(error ? { tone: "err", text: error } : { tone: "ok", text: "Details saved." });
              return error;
            },
            { success: "Letter details saved." },
          )}
        >
          {template.detailsLabel && (
            <Field label={template.detailsLabel}>
              <input value={details} maxLength={200} onChange={(e) => setDetails(e.target.value)} />
            </Field>
          )}
          {hr && (
            <Field label={row.type === ("Termination" as string) ? "Termination date" : row.type === ("Internship" as string) ? "Internship end date" : "Effective date"}>
              <input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
            </Field>
          )}
          <SubmitButton action={detailsAction} className="btn-ghost">
            Save details
          </SubmitButton>
        </form>
      )}
      <LetterFrame html={preview.html} title={`${template.label} draft`} />
    </Dialog>
  );
}

/* ───────────── Backend-mode viewer ───────────── */

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/** The wording the server puts in the letter, plus PDF downloads for issued versions. */
function ApiLetterViewer({ row, onClose }: { row: LetterRequest; onClose: () => void }) {
  const info = row.api!;
  const [preview, setPreview] = useState<LetterPreviewOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [version, setVersion] = useState<number | undefined>(info.issues.at(-1)?.version);

  useEffect(() => {
    let live = true;
    setPreview(null);
    setError(null);
    void fetchLetterPreview(row.id).then((out) => {
      if (!live) return;
      setPreview(out.data);
      setError(out.error);
    });
    return () => {
      live = false;
    };
  }, [row.id, row.status]);

  useEffect(() => setVersion(info.issues.at(-1)?.version), [info.issues]);

  const template = letterInfo(row.type);
  const issued = row.status === "Issued" && info.issues.length > 0;
  const html = preview
    ? letterDocumentHtml(
        `<h1>${escapeHtml(preview.title)}</h1>${preview.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("")}`,
        { title: `${template.label}${issued ? "" : " (draft)"}`, draft: !issued },
      )
    : "";

  async function pdf(mode: "save" | "open") {
    const err = await downloadLetterPdf(row.id, pdfName(row, version), version, mode);
    if (err) setMsg({ tone: "err", text: err });
  }

  return (
    <Dialog
      open
      wide
      title={`${template.label} — ${row.employeeName}${issued ? "" : " (draft)"}`}
      onClose={onClose}
      actions={
        issued ? (
          <>
            <button type="button" className="btn-ghost" onClick={() => void pdf("open")}>
              Open PDF
            </button>
            <button type="button" className="btn" onClick={() => void pdf("save")}>
              Download PDF
            </button>
          </>
        ) : undefined
      }
    >
      <Banner message={msg} />
      {issued && info.issues.length > 1 && (
        <Field label="Version">
          <select value={version} onChange={(e) => setVersion(Number(e.target.value))}>
            {info.issues.map((i, n) => (
              <option key={i.version} value={i.version}>
                v{i.version} · {i.on} · {i.referenceNo}
                {n === info.issues.length - 1 ? " (current)" : ""}
              </option>
            ))}
          </select>
        </Field>
      )}
      <p className="letter-meta">
        Status: {row.status}
        {issued && ` · ${info.issues.find((i) => i.version === version)?.referenceNo ?? ""}`}
        {info.issueError && ` · not generated: ${info.issueError}`}
      </p>
      <div className="row-gap">
        <ApiLetterActions row={row} onResult={setMsg} />
      </div>
      {preview && <MissingList missing={preview.missing} />}
      {error && <Banner message={{ tone: "warn", text: error }} />}
      {preview ? <LetterFrame html={html} title={`${template.label} wording`} /> : !error && <p className="note">Loading the letter…</p>}
    </Dialog>
  );
}
