import { useState, useSyncExternalStore } from "react";
import { Banner, Card, Dialog, EmptyState, Field, MetricCard, MetricGrid, Page, StatusBadge, Tabs } from "../../components/ui.tsx";
import { formatShortDate } from "../../model.ts";
import { listPeople, subscribePeople } from "../../data/peopleLocal.ts";
import {
  CASE_CATEGORIES,
  ICC_MEMBERS,
  POSH_SLA_DAYS,
  addCaseNote,
  addCommentByCode,
  canManageCase,
  caseMoves,
  findCaseByCode,
  getGrievanceState,
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
  type CaseCategory,
  type CaseEntry,
  type CaseRecord,
  type CaseStatus,
} from "./grievanceStore.ts";
import { formatStamp, isHr, personName, type ComplianceActor } from "./shared.ts";
import { PersonPicker, toneFor } from "./ComplianceUi.tsx";
import { useComplianceActor } from "./useActor.ts";
import { TEMPLATE_BLANKS_ERROR, hasTemplateBlanks, useTemplatedText } from "../../data/requestTemplates.ts";
import "./compliance.css";

type Msg = { tone: "ok" | "err" | "warn" | "info"; text: string } | null;

export function GrievancePage() {
  const actor = useComplianceActor();
  const state = useSyncExternalStore(subscribeGrievance, getGrievanceState, getGrievanceState);
  useSyncExternalStore(subscribePeople, listPeople, listPeople);
  const staff = isHr(actor.role) || isIccMember(actor.id);
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
    <Page title="Grievances and POSH">
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
            setMsg({ tone: "ok", text: "Case raised. HR will be in touch through the case timeline." });
          }}
        />
      )}

      {tab === "mine" && (
        <Card title="My cases">
          {mine.length === 0 ? (
            <EmptyState title="No cases" />
          ) : (
            <ul className="cmp-list">
              {mine.map((c) => (
                <CaseSummary key={c.id} c={c} onOpen={() => setOpenId(c.id)} showCode />
              ))}
            </ul>
          )}
        </Card>
      )}

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

  function submit() {
    if (hasTemplateBlanks(description)) return setError(TEMPLATE_BLANKS_ERROR);
    if (namePerson && !againstId) return setError("Choose the person from the list, or untick “Name a person”.");
    const result = raiseCase(actor, { category, description, againstId: namePerson ? againstId : undefined, anonymous });
    if ("error" in result) return setError(result.error);
    setError("");
    resetDescription();
    setAgainstId("");
    setNamePerson(false);
    setAnonymous(false);
    setPickerKey((k) => k + 1);
    onRaised(result.code);
  }

  return (
    <Card title="Raise a case">
      <div className="stack">
        {error && <p className="note err">{error}</p>}
        <div className="cmp-form">
          <Field label="Category" wide>
            <select
              value={category}
              onChange={(e) => {
                setCategory(e.target.value as CaseCategory);
                fillDescription("grievance", e.target.value);
              }}
            >
              {CASE_CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="What happened" wide>
            <textarea
              ref={descriptionRef}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onFocus={() => fillDescriptionIfEmpty("grievance", category)}
              placeholder="When, where, who was involved, and anything already tried" />
          </Field>
          <label className="cmp-check" style={{ gridColumn: "1 / -1" }}>
            <input type="checkbox" checked={namePerson} onChange={(e) => setNamePerson(e.target.checked)} />
            Name a person this is about
          </label>
          {namePerson && (
            <Field label="Person" wide>
              <PersonPicker key={pickerKey} value={againstId} onChange={setAgainstId} excludeId={actor.id} />
            </Field>
          )}
          <label className="cmp-check" style={{ gridColumn: "1 / -1" }}>
            <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} />
            Raise anonymously
          </label>
        </div>
        <p className="muted">
          {anonymous ? "Your name is never shown to anyone handling the case. " : ""}
          {category === "Harassment/POSH" ? `Handled by the Internal Committee within ${POSH_SLA_DAYS} days.` : "Handled confidentially by HR."}
          {" "}Your manager cannot see cases.
        </p>
        <div>
          <button className="btn" type="button" onClick={submit}>
            Submit case
          </button>
        </div>
      </div>
    </Card>
  );
}

function SlaBadge({ c }: { c: CaseRecord }) {
  if (!isPosh(c) || !isCaseOpen(c)) return null;
  if (isSlaOverdue(c)) return <StatusBadge status="SLA overdue" tone="danger" literal />;
  const left = slaDaysLeft(c) ?? 0;
  return <StatusBadge status={`${left} days to SLA`} tone={left <= 15 ? "warn" : "info"} literal />;
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

  const shown = cases
    .filter((c) => (status === "open" ? isCaseOpen(c) : status === "all" ? true : c.status === status))
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

function StaffCaseDialog({ c, actor, onClose }: { c: CaseRecord; actor: ComplianceActor; onClose: () => void }) {
  const [next, setNext] = useState<CaseStatus | "">("");
  const [statusNote, setStatusNote] = useState("");
  const [note, setNote] = useState("");
  const [confidential, setConfidential] = useState(true);
  const [msg, setMsg] = useState<Msg>(null);
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
            {due && <span>POSH SLA due {formatShortDate(due)}</span>}
          </span>
          <span className="row-gap">
            <SlaBadge c={c} />
            <StatusBadge status={c.status} tone={toneFor(c.status)} literal />
          </span>
        </div>
        <p className="cmp-desc">{c.description}</p>
        {c.resolution && <p className="note ok">Resolution: {c.resolution}</p>}

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
              <button
                className="btn"
                type="button"
                onClick={() => {
                  if (!next) return setMsg({ tone: "err", text: "Choose the new status." });
                  const err = setCaseStatus(actor, c.id, next, statusNote);
                  setMsg(err ? { tone: "err", text: err } : { tone: "ok", text: `Case moved to ${next}.` });
                  if (!err) {
                    setNext("");
                    setStatusNote("");
                  }
                }}
              >
                Update status
              </button>
            </div>
          </div>
        )}

        <div className="cmp-form">
          <Field label="Add note" wide>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <label className="cmp-check">
            <input type="checkbox" checked={confidential} onChange={(e) => setConfidential(e.target.checked)} />
            Confidential (hidden from reporter)
          </label>
          <div>
            <button
              className="btn-ghost"
              type="button"
              onClick={() => {
                const err = addCaseNote(actor, c.id, note, confidential);
                setMsg(err ? { tone: "err", text: err } : { tone: "ok", text: "Note added." });
                if (!err) setNote("");
              }}
            >
              Add note
            </button>
          </div>
        </div>

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
        <p className="cmp-desc">{c.description}</p>
        {c.resolution && <p className="note ok">Resolution: {c.resolution}</p>}
        <h3 style={{ margin: 0, fontSize: 15 }}>Timeline</h3>
        <Timeline entries={reporterTimeline(c)} />
        {c.status !== "Closed" && (
          <div className="stack">
            <Field label="Add a comment">
              <textarea value={comment} onChange={(e) => setComment(e.target.value)} />
            </Field>
            <div>
              <button
                className="btn"
                type="button"
                onClick={() => {
                  const err = code ? addCommentByCode(actor, code, comment) : addCaseNote(actor, c.id, comment, false);
                  setMsg(err ? { tone: "err", text: err } : { tone: "ok", text: "Comment added." });
                  if (!err) setComment("");
                }}
              >
                Add comment
              </button>
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
