import { useEffect, useState, useSyncExternalStore } from "react";
import { ActionButton, Banner, Card, Dialog, EmptyState, Field, MetricCard, MetricGrid, Page, StatusBadge, Tabs } from "../../components/ui.tsx";
import { formatShortDate, plural } from "../../model.ts";
import { listPeople, subscribePeople } from "../../data/peopleLocal.ts";
import {
  CASE_CATEGORIES,
  ICC_MEMBERS,
  POSH_SLA_DAYS,
  ARCHIVED_STATUS,
  addCaseNote,
  addCommentByCode,
  assignCase,
  assigneeName,
  canManageCase,
  caseAssignees,
  caseMoves,
  downloadCaseFile,
  enforceCaseRetention,
  escalateCase,
  findCaseByCode,
  getGrievanceState,
  isCaseArchived,
  isCaseOpen,
  isIccMember,
  isPosh,
  isReporter,
  isSlaOverdue,
  raiseCase,
  reporterTimeline,
  setCaseStatus,
  slaDaysLeft,
  slaDueOn,
  subscribeGrievance,
  uploadCaseFile,
  type CaseCategory,
  type CaseEntry,
  type CaseRecord,
  type CaseStatus,
} from "./grievanceStore.ts";
import { formatStamp, isHr, personName, type ComplianceActor } from "./shared.ts";
import { PersonPicker, toneFor } from "./ComplianceUi.tsx";
import { useComplianceActor } from "./useActor.ts";
import { TEMPLATE_BLANKS_ERROR, hasTemplateBlanks, useTemplatedText } from "../../data/requestTemplates.ts";
import { API_ENABLED } from "../../api/syncOps.ts";
import { managementChain } from "../../demoAccounts.ts";
import "./compliance.css";
import "../../styles/workspace.css";

type Msg = { tone: "ok" | "err" | "warn" | "info"; text: string } | null;

export function GrievancePage() {
  const actor = useComplianceActor();
  const state = useSyncExternalStore(subscribeGrievance, getGrievanceState, getGrievanceState);
  useSyncExternalStore(subscribePeople, listPeople, listPeople);
  const staff = isHr(actor.role) || isIccMember(actor.id);
  // Apply the retention rule as it stands now (it can change in the Privacy centre).
  useEffect(() => {
    enforceCaseRetention();
  }, []);
  const managed = state.cases.filter((c) => canManageCase(actor, c));
  const mine = state.cases.filter((c) => isReporter(actor, c));
  const [tab, setTab] = useState(staff ? "manage" : "raise");
  const [msg, setMsg] = useState<Msg>(null);
  const [newCode, setNewCode] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [codeCase, setCodeCase] = useState<string | null>(null);

  const tabs = [
    { id: "raise", label: "Raise a case" },
    { id: "mine", label: `My cases (${mine.length})` },
    { id: "lookup", label: "Find by code" },
  ];
  if (staff) tabs.unshift({ id: "manage", label: `Case management (${managed.filter(isCaseOpen).length})` });

  const opened = openId ? state.cases.find((c) => c.id === openId) : undefined;
  const byCode = codeCase ? findCaseByCode(actor, codeCase) : undefined;

  return (
    <Page title={window.location.pathname.startsWith("/people/cases") ? "HR cases" : "Raise a concern"}>
      <Banner message={msg} />
      <Tabs
        tabs={tabs}
        value={tab}
        onChange={(id) => {
          setTab(id);
          setMsg(null);
        }}
      />

      {tab === "raise" && (
        <RaiseForm
          actor={actor}
          onRaised={(code) => {
            setNewCode(code);
            setTab("mine");
            setMsg({ tone: "ok", text: `Case ${code} raised. It is listed under My cases and HR will reply on its timeline.` });
          }}
        />
      )}

      {tab === "mine" && <MyCases cases={mine} onOpen={setOpenId} onRaise={() => setTab("raise")} />}

      {tab === "lookup" && <CodeLookup onFound={(code) => setCodeCase(code)} actor={actor} />}

      {tab === "manage" && staff && <ManageList actor={actor} cases={managed} onOpen={setOpenId} />}

      {newCode && (
        <Dialog
          open
          title="Save your case code"
          onClose={() => setNewCode(null)}
          actions={
            <button className="btn" type="button" onClick={() => setNewCode(null)}>
              Done
            </button>
          }
        >
          <div className="stack">
            <p>
              <strong className="cmp-code">{newCode}</strong>
            </p>
            <p className="muted">Use this code under “Find by code” to follow your case. Keep it private.</p>
          </div>
        </Dialog>
      )}

      {opened && (canManageCase(actor, opened) ? (
        <StaffCaseDialog c={opened} actor={actor} onClose={() => setOpenId(null)} />
      ) : isReporter(actor, opened) ? (
        <ReporterCaseDialog c={opened} actor={actor} onClose={() => setOpenId(null)} />
      ) : null)}

      {codeCase && byCode && <ReporterCaseDialog c={byCode} actor={actor} code={codeCase} onClose={() => setCodeCase(null)} />}
    </Page>
  );
}

/** What each category covers and who handles it. */
const CATEGORY_INFO: Record<CaseCategory, { blurb: string; handler: string }> = {
  Grievance: { blurb: "Workload, pay, leave, manager or team concerns", handler: "HR business partner" },
  "Harassment/POSH": { blurb: "Sexual harassment or unwelcome conduct", handler: "Internal Committee" },
  Discrimination: { blurb: "Unfair treatment based on who you are", handler: "HR, confidentially" },
  "Ethics/whistleblowing": { blurb: "Fraud, bribery, policy or legal breaches", handler: "Ethics officer and HR" },
  Safety: { blurb: "Unsafe premises, equipment or practices", handler: "HR and facilities" },
};

const CASE_STEPS: { status: CaseStatus; label: string }[] = [
  { status: "Open", label: "Received" },
  { status: "Investigating", label: "Investigating" },
  { status: "Resolved", label: "Resolved" },
  { status: "Closed", label: "Closed" },
];

/** Received → Investigating → Resolved → Closed, with the date each step was reached. */
function CaseProgress({ c }: { c: CaseRecord }) {
  const archived = isCaseArchived(c);
  const at = CASE_STEPS.findIndex((s) => s.status === c.status);
  const reached = archived ? CASE_STEPS.length - 1 : Math.max(0, at);
  const dateOf = (status: CaseStatus) =>
    status === "Open" ? c.createdOn : c.timeline.find((e) => e.status === status)?.at.slice(0, 10) ?? (status === "Closed" ? c.closedOn : undefined);
  return (
    <ol className="ws-steps" aria-label="Case progress">
      {CASE_STEPS.map((step, i) => {
        const state = i < reached || (i === reached && (step.status === "Closed" || archived)) ? "done" : i === reached ? "current" : "todo";
        const when = i <= reached ? dateOf(step.status) : undefined;
        return (
          <li key={step.status} className={`ws-step ${state}`} aria-current={state === "current" ? "step" : undefined}>
            <span className="ws-step-dot" aria-hidden="true">
              {state === "done" ? "✓" : i + 1}
            </span>
            <span className="ws-step-label">{step.label}</span>
            <span className="ws-step-date">{when ? formatShortDate(when) : ""}</span>
          </li>
        );
      })}
    </ol>
  );
}

function MyCases({ cases, onOpen, onRaise }: { cases: CaseRecord[]; onOpen: (id: string) => void; onRaise: () => void }) {
  const sorted = [...cases].sort((a, b) => b.createdOn.localeCompare(a.createdOn));
  const open = cases.filter(isCaseOpen).length;
  return (
    <Card
      title="My cases"
      action={
        <button type="button" className="btn-ghost btn-tiny" onClick={onRaise}>
          Raise a new case
        </button>
      }
    >
      {sorted.length === 0 ? (
        <EmptyState title="You have not raised any cases" />
      ) : (
        <div className="stack">
          <div className="ws-summary">
            <span>
              <strong>{open}</strong> open
            </span>
            <span>
              <strong>{cases.length - open}</strong> resolved or closed
            </span>
          </div>
          <ul className="ws-case-list">
            {sorted.map((c) => {
              const last = reporterTimeline(c).at(-1);
              return (
                <li key={c.id} className="ws-case">
                  <div className="ws-case-head">
                    <div>
                      <strong>{c.category}</strong>
                      <span className="ws-case-code">{c.code}</span>
                    </div>
                    <span className="row-gap">
                      {c.anonymous && <StatusBadge status="Anonymous" tone="neutral" literal />}
                      <StatusBadge status={c.status} tone={toneFor(c.status)} literal />
                    </span>
                  </div>
                  <p className="ws-case-desc">{c.description.length > 180 ? `${c.description.slice(0, 180)}…` : c.description}</p>
                  <CaseProgress c={c} />
                  <div className="ws-case-foot">
                    <span className="muted">
                      Raised {formatShortDate(c.createdOn)}
                      {last && last.kind !== "filed" ? ` · last update ${formatStamp(last.at)} by ${last.authorLabel}` : " · awaiting first response"}
                    </span>
                    <button className="btn-ghost btn-tiny" type="button" onClick={() => onOpen(c.id)}>
                      View case
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Card>
  );
}

function RaiseForm({ actor, onRaised }: { actor: ComplianceActor; onRaised: (code: string) => void }) {
  const [category, setCategory] = useState<CaseCategory>("Grievance");
  const {
    value: description,
    setValue: setDescription,
    ref: descriptionRef,
    fill: fillDescription,
    fillIfEmpty: fillDescriptionIfEmpty,
    reset: resetDescription,
  } = useTemplatedText();
  const [namePerson, setNamePerson] = useState(false);
  const [againstId, setAgainstId] = useState("");
  const [anonymous, setAnonymous] = useState(false);
  const [error, setError] = useState("");
  const [pickerKey, setPickerKey] = useState(0);
  const posh = category === "Harassment/POSH";

  async function submit() {
    if (hasTemplateBlanks(description)) {
      setError(TEMPLATE_BLANKS_ERROR);
      return false;
    }
    if (namePerson && !againstId) {
      setError("Choose the person from the list, or untick “Name a person”.");
      return false;
    }
    const result = await raiseCase(actor, { category, description, againstId: namePerson ? againstId : undefined, anonymous });
    if ("error" in result) {
      setError(result.error);
      return false;
    }
    setError("");
    resetDescription();
    setAgainstId("");
    setNamePerson(false);
    setAnonymous(false);
    setPickerKey((k) => k + 1);
    onRaised(result.code);
    return true;
  }

  return (
    <div className="ws-raise">
      <Card title="Raise a case">
        <div className="stack">
          {error && <p className="note err">{error}</p>}
          <fieldset className="ws-fieldset">
            <legend>1. What is it about?</legend>
            <div className="ws-cat-grid" role="radiogroup" aria-label="Category">
              {CASE_CATEGORIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={category === c}
                  className={`ws-cat${category === c ? " active" : ""}`}
                  onClick={() => {
                    setCategory(c);
                    fillDescription("grievance", c);
                  }}
                >
                  <strong>{c}</strong>
                  <span>{CATEGORY_INFO[c].blurb}</span>
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="ws-fieldset">
            <legend>2. What happened?</legend>
            <Field label="Description" wide>
              <textarea
                ref={descriptionRef}
                rows={6}
                value={description}
                maxLength={4000}
                onChange={(e) => setDescription(e.target.value)}
                onFocus={() => fillDescriptionIfEmpty("grievance", category)}
                placeholder="When, where, who was involved, and anything already tried"
              />
            </Field>
            <span className="ws-count">{description.trim().length} / 4,000</span>
            <label className="cmp-check">
              <input type="checkbox" checked={namePerson} onChange={(e) => setNamePerson(e.target.checked)} />
              Name a person this is about
            </label>
            {namePerson && (
              <Field label="Person" wide>
                <PersonPicker key={pickerKey} value={againstId} onChange={setAgainstId} excludeId={actor.id} />
              </Field>
            )}
          </fieldset>

          <fieldset className="ws-fieldset">
            <legend>3. How should we handle your identity?</legend>
            <div className="ws-choice-row" role="radiogroup" aria-label="Identity">
              <button type="button" role="radio" aria-checked={!anonymous} className={`ws-choice${!anonymous ? " active" : ""}`} onClick={() => setAnonymous(false)}>
                <strong>Share my name</strong>
                <span>Only the case handler sees it, so they can follow up with you directly.</span>
              </button>
              <button type="button" role="radio" aria-checked={anonymous} className={`ws-choice${anonymous ? " active" : ""}`} onClick={() => setAnonymous(true)}>
                <strong>Stay anonymous</strong>
                <span>Your name is never shown. Follow the case with the private code you get.</span>
              </button>
            </div>
          </fieldset>

          <div className="ws-attach-note">
            <strong>Evidence and attachments</strong>
            <span>
              {API_ENABLED
                ? "After you submit, open the case under My cases to attach screenshots, emails or documents. Files are visible only to the case handler."
                : "After you submit, share screenshots, emails or documents with the case handler through the case timeline."}
            </span>
          </div>

          <div className="ws-submit-row">
            <ActionButton className="btn" success={posh ? "Case sent to the Internal Committee." : "Case sent to HR."} onAction={submit}>
              Submit case
            </ActionButton>
            <span className="muted">
              {posh ? `Handled by the Internal Committee within ${POSH_SLA_DAYS} days.` : `Handled by the ${CATEGORY_INFO[category].handler.toLowerCase()}.`}
            </span>
          </div>
        </div>
      </Card>

      <aside className="ws-aside">
        <Card title="What happens next">
          <ol className="ws-howto">
            <li>
              <strong>Received</strong>
              <span>You get a private case code straight away.</span>
            </li>
            <li>
              <strong>Investigating</strong>
              <span>{posh ? "The Internal Committee reviews the facts." : "HR reviews the facts and may ask you questions."}</span>
            </li>
            <li>
              <strong>Resolved</strong>
              <span>You see the outcome on the case timeline.</span>
            </li>
            <li>
              <strong>Closed</strong>
              <span>The file is kept confidential under the retention rule.</span>
            </li>
          </ol>
        </Card>
        <Card title="Your protection">
          <ul className="ws-bullets">
            <li>Cases are confidential to HR{posh ? " and the Internal Committee" : ""}.</li>
            {managementChain(actor.id).length > 0 && <li>Your manager cannot see cases.</li>}
            <li>Retaliation for raising a concern in good faith is not tolerated.</li>
          </ul>
        </Card>
      </aside>
    </div>
  );
}

function SlaBadge({ c }: { c: CaseRecord }) {
  if (!isPosh(c) || !isCaseOpen(c)) return null;
  if (isSlaOverdue(c)) return <StatusBadge status="SLA overdue" tone="danger" literal />;
  const left = slaDaysLeft(c) ?? 0;
  return <StatusBadge status={`${plural(left, "day")} to SLA`} tone={left <= 15 ? "warn" : "info"} literal />;
}

function CaseSummary({ c, onOpen, showCode = false, staffView = false }: { c: CaseRecord; onOpen: () => void; showCode?: boolean; staffView?: boolean }) {
  return (
    <li className="cmp-item">
      <div className="cmp-item-head">
        <strong>
          {c.category}
          {showCode ? <span className="muted cmp-code"> · {c.code}</span> : null}
        </strong>
        <span className="row-gap">
          <SlaBadge c={c} />
          <StatusBadge status={c.status} tone={toneFor(c.status)} literal />
        </span>
      </div>
      <p className="cmp-desc muted">{c.description.length > 140 ? `${c.description.slice(0, 140)}…` : c.description}</p>
      <div className="cmp-meta">
        <span>Raised {formatShortDate(c.createdOn)}</span>
        {staffView && <span>Reporter: {c.anonymous ? "Anonymous" : personName(c.reporterId)}</span>}
        {staffView && c.againstName && <span>About: {c.againstName}</span>}
        {staffView && <span>Assigned to: {assigneeName(c) ?? "Unassigned"}</span>}
        {!staffView && c.anonymous && <span>Anonymous</span>}
      </div>
      <div className="cmp-actions">
        <button className="btn-ghost btn-tiny" type="button" onClick={onOpen}>
          Open
        </button>
      </div>
    </li>
  );
}

function ManageList({ actor, cases, onOpen }: { actor: ComplianceActor; cases: CaseRecord[]; onOpen: (id: string) => void }) {
  const [status, setStatus] = useState<"open" | "all" | CaseStatus>("open");
  const [category, setCategory] = useState<"all" | CaseCategory>("all");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [mineOnly, setMineOnly] = useState(false);
  const hr = isHr(actor.role);

  const shown = cases
    .filter((c) => (status === "open" ? isCaseOpen(c) : status === "all" ? !isCaseArchived(c) : c.status === status))
    .filter((c) => !mineOnly || c.assigneeId === actor.id)
    .filter((c) => category === "all" || c.category === category)
    .filter((c) => !overdueOnly || isSlaOverdue(c))
    .sort((a, b) => Number(isSlaOverdue(b)) - Number(isSlaOverdue(a)) || b.createdOn.localeCompare(a.createdOn));

  const posh = cases.filter((c) => isPosh(c) && isCaseOpen(c));
  return (
    <>
      <MetricGrid>
        <MetricCard label="Open cases" value={cases.filter(isCaseOpen).length} />
        <MetricCard label="Open POSH" value={posh.length} />
        <MetricCard label="POSH past 90 days" value={posh.filter((c) => isSlaOverdue(c)).length} />
      </MetricGrid>
      <div className="cmp-split">
        <Card title="Cases">
          <div className="stack">
            <div className="cmp-filters">
              <Field label="Status">
                <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
                  <option value="open">Open and investigating</option>
                  <option value="all">All</option>
                  {(["Open", "Investigating", "Resolved", "Closed"] as CaseStatus[]).map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                  {hr && <option value={ARCHIVED_STATUS}>Archived</option>}
                </select>
              </Field>
              <Field label="Category">
                <select value={category} onChange={(e) => setCategory(e.target.value as typeof category)}>
                  <option value="all">All categories</option>
                  {CASE_CATEGORIES.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </Field>
              <label className="cmp-check">
                <input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} />
                SLA overdue only
              </label>
              <label className="cmp-check">
                <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} />
                Assigned to me
              </label>
            </div>
            {shown.length === 0 ? (
              <EmptyState title="No cases match these filters" />
            ) : (
              <ul className="cmp-list">
                {shown.map((c) => (
                  <CaseSummary key={c.id} c={c} onOpen={() => onOpen(c.id)} staffView />
                ))}
              </ul>
            )}
          </div>
        </Card>
        <Card title="Internal Committee">
          <ul className="cmp-list">
            {ICC_MEMBERS.map((m) => (
              <li key={m.name} className="row-between">
                <span>
                  {m.name}
                  {m.id === actor.id ? " (you)" : ""}
                </span>
                <span className="muted">{m.seat}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}

function Timeline({ entries }: { entries: CaseEntry[] }) {
  return (
    <ol className="cmp-timeline">
      {entries.map((e) => (
        <li key={e.id} className={e.confidential ? "confidential" : undefined}>
          <span className="muted">
            {formatStamp(e.at)} · {e.authorLabel}
            {e.status ? ` · ${e.status}` : ""}
            {e.confidential ? " · Confidential" : ""}
          </span>
          <p>{e.text}</p>
        </li>
      ))}
    </ol>
  );
}

/** Backend mode: priority, escalation and evidence files on a case. */
function CaseExtras({ c, staff, onMsg }: { c: CaseRecord; staff: boolean; onMsg: (m: Msg) => void }) {
  const [reason, setReason] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [confidentialFile, setConfidentialFile] = useState(staff);
  const [busy, setBusy] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  if (!API_ENABLED) return null;
  const open = isCaseOpen(c) && !isCaseArchived(c);
  const files = c.files ?? [];

  async function run(fn: () => Promise<string | null>, ok: string) {
    setBusy(true);
    const err = await fn();
    setBusy(false);
    onMsg(err ? { tone: "err", text: err } : { tone: "ok", text: ok });
    return !err;
  }

  return (
    <div className="stack">
      <span className="cmp-meta">
        {c.priority && <span>Priority: {c.priority}</span>}
        {(c.escalationCount ?? 0) > 0 && (
          <span>
            Escalated {plural(c.escalationCount ?? 0, "time")}
            {c.escalatedAt ? ` · last ${formatStamp(c.escalatedAt)}` : ""}
          </span>
        )}
      </span>
      {open && (
        <div className="cmp-form">
          <Field label="Escalate (tell every HR member, priority Urgent)" wide>
            <input value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} placeholder="Why this needs attention now" />
          </Field>
          <div>
            <ActionButton
              className="btn-ghost"
              disabled={busy}
              busyLabel="Escalating…"
              doneLabel="Escalated"
              success="Case escalated to every HR member."
              onAction={async () => {
                const ok = await run(() => escalateCase(c.id, reason), "Case escalated.");
                if (ok) setReason("");
                return ok;
              }}
            >
              Escalate
            </ActionButton>
          </div>
        </div>
      )}
      <h3 style={{ margin: 0, fontSize: 15 }}>Files</h3>
      {files.length ? (
        <ul className="cmp-files">
          {files.map((f) => (
            <li key={f.id} className="row-gap">
              <button
                type="button"
                className="quiet-link"
                onClick={async () => {
                  const err = await downloadCaseFile(c.id, f);
                  if (err) onMsg({ tone: "err", text: err });
                }}
              >
                {f.name}
              </button>
              <span className="muted">
                {Math.max(1, Math.round(f.size / 1024))} KB · {formatStamp(f.at)}
                {f.byReporter ? " · from reporter" : ""}
                {f.confidential ? " · Confidential" : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No files yet.</p>
      )}
      {!isCaseArchived(c) && (
        <div className="cmp-form">
          <Field label="Add a file" wide>
            <input key={inputKey} type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
          {staff && (
            <label className="cmp-check">
              <input type="checkbox" checked={confidentialFile} onChange={(e) => setConfidentialFile(e.target.checked)} />
              Confidential (hidden from reporter)
            </label>
          )}
          <div>
            <ActionButton
              className="btn-ghost"
              disabled={!file || busy}
              success={file ? `${file.name} uploaded to the case.` : "File uploaded."}
              onAction={async () => {
                if (!file) return false;
                const ok = await run(() => uploadCaseFile(c.id, file, staff && confidentialFile), `${file.name} added.`);
                if (ok) {
                  setFile(null);
                  setInputKey((k) => k + 1);
                }
                return ok;
              }}
            >
              Upload
            </ActionButton>
          </div>
        </div>
      )}
    </div>
  );
}

function StaffCaseDialog({ c, actor, onClose }: { c: CaseRecord; actor: ComplianceActor; onClose: () => void }) {
  const [next, setNext] = useState<CaseStatus | "">("");
  const [statusNote, setStatusNote] = useState("");
  const [note, setNote] = useState("");
  const [confidential, setConfidential] = useState(true);
  const [msg, setMsg] = useState<Msg>(null);
  const [assignee, setAssignee] = useState(c.assigneeId ?? "");
  const archived = isCaseArchived(c);
  const canAssign = isHr(actor.role) && !archived;
  const moves = caseMoves(c);
  const due = slaDueOn(c);

  return (
    <Dialog
      open
      wide
      title={`${c.category} case`}
      onClose={onClose}
      actions={
        <button className="btn-ghost" type="button" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="stack">
        <Banner message={msg} />
        <div className="cmp-item-head">
          <span className="cmp-meta">
            <span>Raised {formatShortDate(c.createdOn)}</span>
            <span>Reporter: {c.anonymous ? "Anonymous" : personName(c.reporterId)}</span>
            {c.againstName && <span>About: {c.againstName}</span>}
            <span>Assigned to: {assigneeName(c) ?? "Unassigned"}</span>
            {c.closedOn && <span>Closed {formatShortDate(c.closedOn)}</span>}
            {due && <span>POSH SLA due {formatShortDate(due)}</span>}
          </span>
          <span className="row-gap">
            <SlaBadge c={c} />
            <StatusBadge status={c.status} tone={toneFor(c.status)} literal />
          </span>
        </div>
        <p className="cmp-desc">{c.description}</p>
        {c.resolution && <p className="note ok">Resolution: {c.resolution}</p>}

        {canAssign && (
          <div className="cmp-form">
            <Field label="Assign to">
              <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <option value="">Unassigned</option>
                {caseAssignees(c).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.id === actor.id ? " (you)" : ""}
                  </option>
                ))}
              </select>
            </Field>
            <div>
              <ActionButton
                className="btn-ghost"
                success={() => {
                  const who = caseAssignees(c).find((a) => a.id === assignee)?.name;
                  return assignee ? `Case assigned to ${who ?? "the selected person"}.` : "Assignment cleared.";
                }}
                onAction={async () => {
                  const err = await assignCase(actor, c.id, assignee);
                  setMsg(err ? { tone: "err", text: err } : { tone: "ok", text: assignee ? "Case assigned." : "Assignment cleared." });
                  return err;
                }}
              >
                Assign
              </ActionButton>
            </div>
          </div>
        )}

        {moves.length > 0 && (
          <div className="cmp-form">
            <Field label="Move to">
              <select value={next} onChange={(e) => setNext(e.target.value as CaseStatus | "")}>
                <option value="">Choose…</option>
                {moves.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </Field>
            <Field label={next === "Resolved" ? "Resolution note" : next === "Closed" ? "Reason" : "Note (shared with reporter)"} wide>
              <textarea value={statusNote} onChange={(e) => setStatusNote(e.target.value)} />
            </Field>
            <div>
              <ActionButton
                className="btn"
                success={next ? `Case moved to ${next}.` : undefined}
                onAction={async () => {
                  if (!next) {
                    setMsg({ tone: "err", text: "Choose the new status." });
                    return false;
                  }
                  const err = await setCaseStatus(actor, c.id, next, statusNote);
                  setMsg(err ? { tone: "err", text: err } : { tone: "ok", text: `Case moved to ${next}.` });
                  if (!err) {
                    setNext("");
                    setStatusNote("");
                  }
                  return err;
                }}
              >
                Update status
              </ActionButton>
            </div>
          </div>
        )}

        {!archived && (
          <div className="cmp-form">
            <Field label="Add note" wide>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <label className="cmp-check">
              <input type="checkbox" checked={confidential} onChange={(e) => setConfidential(e.target.checked)} />
              Confidential (hidden from reporter)
            </label>
            <div>
              <ActionButton
                className="btn-ghost"
                success={confidential ? "Confidential note added." : "Note added and shared with the reporter."}
                onAction={async () => {
                  const err = await addCaseNote(actor, c.id, note, confidential);
                  setMsg(err ? { tone: "err", text: err } : { tone: "ok", text: "Note added." });
                  if (!err) setNote("");
                  return err;
                }}
              >
                Add note
              </ActionButton>
            </div>
          </div>
        )}

        <CaseExtras c={c} staff onMsg={setMsg} />

        <h3 style={{ margin: 0, fontSize: 15 }}>Timeline</h3>
        <Timeline entries={c.timeline} />
      </div>
    </Dialog>
  );
}

function ReporterCaseDialog({ c, actor, code, onClose }: { c: CaseRecord; actor: ComplianceActor; code?: string; onClose: () => void }) {
  const [comment, setComment] = useState("");
  const [msg, setMsg] = useState<Msg>(null);

  return (
    <Dialog
      open
      wide
      title={`${c.category} case`}
      onClose={onClose}
      actions={
        <button className="btn-ghost" type="button" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="stack">
        <Banner message={msg} />
        <div className="cmp-item-head">
          <span className="cmp-meta">
            <span className="cmp-code">{c.code}</span>
            <span>Raised {formatShortDate(c.createdOn)}</span>
            {c.anonymous && <span>Anonymous</span>}
          </span>
          <StatusBadge status={c.status} tone={toneFor(c.status)} literal />
        </div>
        <CaseProgress c={c} />
        <p className="cmp-desc">{c.description}</p>
        {c.resolution && <p className="note ok">Resolution: {c.resolution}</p>}
        <CaseExtras c={c} staff={false} onMsg={setMsg} />
        <h3 style={{ margin: 0, fontSize: 15 }}>Timeline</h3>
        <Timeline entries={reporterTimeline(c)} />
        {c.status !== "Closed" && !isCaseArchived(c) && (
          <div className="stack">
            <Field label="Add a comment">
              <textarea value={comment} onChange={(e) => setComment(e.target.value)} />
            </Field>
            <div>
              <ActionButton
                className="btn"
                success="Comment sent to the case handler."
                onAction={async () => {
                  const err = await (code ? addCommentByCode(actor, code, comment) : addCaseNote(actor, c.id, comment, false));
                  setMsg(err ? { tone: "err", text: err } : { tone: "ok", text: "Comment added." });
                  if (!err) setComment("");
                  return err;
                }}
              >
                Add comment
              </ActionButton>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function CodeLookup({ actor, onFound }: { actor: ComplianceActor; onFound: (code: string) => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  return (
    <Card title="Find by code">
      <div className="stack">
        {error && <p className="note err">{error}</p>}
        <Field label="Private case code">
          <input className="cmp-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="CASE-XXXX-XXXX" autoComplete="off" />
        </Field>
        <div>
          <button
            className="btn"
            type="button"
            onClick={() => {
              const found = findCaseByCode(actor, code);
              if (!found) return setError("No case found for that code.");
              setError("");
              onFound(code.trim().toUpperCase());
            }}
          >
            Open case
          </button>
        </div>
      </div>
    </Card>
  );
}
