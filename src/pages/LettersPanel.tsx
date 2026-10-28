/** Documents & Letters — letter request, approval, generation and access (blueprint §24 / §39). */
import { useMemo, useState, useSyncExternalStore } from "react";
import { LetterDownloadButtons, LetterFrame, printLetter } from "../components/LetterDocument.tsx";
import { Banner, Card, DataTable, Dialog, EmptyState, Field, StatusBadge } from "../components/ui.tsx";
import {
  approveLetter,
  canApproveLetterRow,
  canRequestType,
  canSeeLetter,
  collectLetterFields,
  currentIssue,
  issuedLetterHtml,
  letterApproversFor,
  previewLetter,
  regenerateLetter,
  rejectLetter,
  requestLetter,
  updateLetterInputs,
} from "../data/letterService.ts";
import {
  ALL_LETTER_TEMPLATES,
  letterDate,
  letterFileName,
  letterInfo,
  missingFields,
  needsSecondApproval,
  type FullLetterType,
} from "../data/letterTemplates.ts";
import { listPeople, subscribePeople } from "../data/peopleLocal.ts";
import { canManageLetters } from "../data/rbac.ts";
import type { LetterRequest, LetterType } from "../data/rewardData.ts";
import { getRewardState, nextLetterStatuses, setLetterStatus, subscribeReward } from "../data/rewardLocal.ts";
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

  const letters = reward.letters.filter((l) => canSeeLetter(actor, l));
  const sortedPeople = [...people].sort((a, b) => a.fullName.localeCompare(b.fullName));

  function act(fn: () => string | null, ok: string) {
    const error = fn();
    setMsg(error ? { tone: "err", text: error } : { tone: "ok", text: ok });
  }

  return (
    <div className="mgr-home-grid">
      <Card title="Request a letter">
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            const error = requestLetter(actor, { employeeId: subjectId, type, note, details, effectiveDate });
            if (error) return setMsg({ tone: "err", text: error });
            setMsg({
              tone: "ok",
              text: needsSecondApproval(type) ? `${template.label} raised. It needs a second approver.` : `${template.label} requested — awaiting approval.`,
            });
            setNote("");
            setDetails("");
            setEffectiveDate("");
          }}
        >
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
          {blocked ? <Banner message={{ tone: "warn", text: blocked }} /> : hr && <MissingList missing={missing} />}
          <button type="submit" className="btn" disabled={!!blocked}>
            Request letter
          </button>
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
                  <button type="button" className="btn" onClick={() => act(() => setLetterStatus(actor, l.id, "Pending approval"), "Submitted for approval.")}>
                    Submit
                  </button>
                )}
                {canDecide && (
                  <>
                    <button type="button" className="btn" onClick={() => act(() => approveLetter(actor, l.id), `${label(l.type)} approved and generated.`)}>
                      Approve &amp; generate
                    </button>
                    <button type="button" className="btn-ghost" onClick={() => act(() => rejectLetter(actor, l.id), "Request rejected.")}>
                      Reject
                    </button>
                  </>
                )}
                {l.status === "Issued" && canApproveLetterRow(actor, l) && (
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => act(() => regenerateLetter(actor, l.id), `Regenerated as v${(l.issued?.length ?? 0) + 1}.`)}
                  >
                    Regenerate
                  </button>
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
  const letters = reward.letters.filter((l) => canSeeLetter(actor, l));
  return (
    <Card title="Request and approval history">
      <DataTable
        headers={["Requested", "Employee", "Letter", "By", "Status", "Approver", "Decided", "Document", "Note"]}
        rows={letters.map((l) => {
          const issue = currentIssue(l);
          return [
            l.requestedOn,
            l.employeeName,
            label(l.type),
            l.requestedBy,
            <StatusBadge key={l.id} status={l.status} literal />,
            l.approver ?? "—",
            l.decidedOn ?? "—",
            issue ? (
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
  return (
    <Card title="My letters">
      <DataTable
        headers={["Letter", "Version", "Reference", "Approved", ""]}
        rows={mine.map((l) => {
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

  if (!open) return null;
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
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                const error = rejectLetter(actor, row.id);
                setMsg(error ? { tone: "err", text: error } : { tone: "ok", text: "Request rejected." });
              }}
            >
              Reject
            </button>
            <button
              type="button"
              className="btn"
              disabled={preview.missing.length > 0}
              onClick={() => {
                const error = approveLetter(actor, row.id);
                setMsg(error ? { tone: "err", text: error } : { tone: "ok", text: "Approved — final letter generated." });
              }}
            >
              Approve &amp; generate
            </button>
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
          onSubmit={(e) => {
            e.preventDefault();
            const error = updateLetterInputs(actor, row.id, {
              details: template.detailsLabel ? details : undefined,
              effectiveDate: hr ? effectiveDate : undefined,
            });
            setMsg(error ? { tone: "err", text: error } : { tone: "ok", text: "Details saved." });
          }}
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
          <button type="submit" className="btn-ghost">
            Save details
          </button>
        </form>
      )}
      <LetterFrame html={preview.html} title={`${template.label} draft`} />
    </Dialog>
  );
}
