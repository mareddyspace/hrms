import { useState, useSyncExternalStore, type ReactNode } from "react";
import { Banner, Card, DataTable, Dialog, EmptyState, Field, MetricCard, MetricGrid, Page, StatusBadge, Tabs } from "../../components/ui.tsx";
import { formatShortDate } from "../../model.ts";
import { getPerson, listPeople, subscribePeople } from "../../data/peopleLocal.ts";
import {
  CONSENT_TOPICS,
  REQUEST_DUE_DAYS,
  REQUEST_TYPES,
  canHandleRequest,
  currentConsents,
  daysLeft,
  getPrivacyState,
  isRequestOpen,
  isRequestOverdue,
  closesManually,
  moveRequest,
  raiseRequest,
  removeRetentionRule,
  saveRetentionRule,
  setConsent,
  subscribePrivacy,
  withdrawRequest,
  type DataRequest,
  type RequestType,
  type RetentionInput,
  type RetentionRule,
  type RetentionUnit,
} from "./privacyStore.ts";
import { formatStamp, isHr, personCountry, privacyLawFor, type ComplianceActor } from "./shared.ts";
import { Switch, toneFor } from "./ComplianceUi.tsx";
import { buildMyDataExport, downloadJson } from "./dataExport.ts";
import { useComplianceActor } from "./useActor.ts";
import "./compliance.css";

type Msg = { tone: "ok" | "err" | "warn" | "info"; text: string } | null;

const LEGAL_BASES = ["Contract", "Legal obligation", "Legitimate interest", "Consent", "Vital interests", "Public task"];

export function PrivacyCentrePage() {
  const actor = useComplianceActor();
  const state = useSyncExternalStore(subscribePrivacy, getPrivacyState, getPrivacyState);
  useSyncExternalStore(subscribePeople, listPeople, listPeople);
  const hr = isHr(actor.role);
  const [tab, setTab] = useState("consents");
  const [msg, setMsg] = useState<Msg>(null);
  const country = personCountry(actor.id, actor);
  const law = privacyLawFor(country.code);

  const queue = state.requests.filter((r) => canHandleRequest(actor, r));
  const openQueue = queue.filter(isRequestOpen).length;

  const tabs = [
    { id: "consents", label: "Consents" },
    { id: "data", label: "My data" },
    { id: "requests", label: "My requests" },
  ];
  if (hr) {
    tabs.push({ id: "queue", label: `Request queue (${openQueue})` });
    tabs.push({ id: "retention", label: "Retention policy" });
  }

  function report(error: string | null, ok: string) {
    setMsg(error ? { tone: "err", text: error } : { tone: "ok", text: ok });
  }

  return (
    <Page title="Privacy centre" action={<span className="pill" title={`Applicable law for ${country.name}`}>{law}</span>}>
      <Banner message={msg} />
      <Tabs
        tabs={tabs}
        value={tab}
        onChange={(id) => {
          setTab(id);
          setMsg(null);
        }}
      />
      {tab === "consents" && <ConsentsTab actor={actor} onResult={report} />}
      {tab === "data" && <MyDataTab actor={actor} onResult={setMsg} />}
      {tab === "requests" && <MyRequestsTab actor={actor} requests={state.requests.filter((r) => r.personId === actor.id)} onResult={report} />}
      {tab === "queue" && hr && <RequestQueue actor={actor} requests={queue} onResult={report} />}
      {tab === "retention" && hr && <RetentionTab actor={actor} rules={state.retention} onResult={report} />}
    </Page>
  );
}

function ConsentsTab({ actor, onResult }: { actor: ComplianceActor; onResult: (error: string | null, ok: string) => void }) {
  const state = useSyncExternalStore(subscribePrivacy, getPrivacyState, getPrivacyState);
  const current = currentConsents(state, actor.id);
  const history = state.consents.filter((c) => c.personId === actor.id).sort((a, b) => b.at.localeCompare(a.at));
  const labelOf = (key: string) => CONSENT_TOPICS.find((t) => t.key === key)?.label ?? key;

  return (
    <div className="cmp-split">
      <Card title="Your choices">
        <div>
          {CONSENT_TOPICS.map((topic) => {
            const event = current[topic.key];
            const on = event?.granted ?? false;
            return (
              <div key={topic.key} className="cmp-consent">
                <div>
                  {topic.label}
                  <small>{event ? `${on ? "Given" : "Withdrawn"} ${formatStamp(event.at)}` : "Not given"}</small>
                </div>
                <Switch
                  checked={on}
                  label={topic.label}
                  onChange={(next) => onResult(setConsent(actor, topic.key, next), next ? "Consent given." : "Consent withdrawn.")}
                />
              </div>
            );
          })}
        </div>
      </Card>
      <Card title="History">
        <DataTable
          headers={["When", "Consent", "Choice"]}
          empty={<EmptyState title="No changes yet" />}
          rows={history.map((h) => [
            formatStamp(h.at),
            labelOf(h.key),
            <StatusBadge key="c" status={h.granted ? "Given" : "Withdrawn"} tone={h.granted ? "ok" : "neutral"} literal />,
          ])}
        />
      </Card>
    </div>
  );
}

function MyDataTab({ actor, onResult }: { actor: ComplianceActor; onResult: (msg: Msg) => void }) {
  const [summary, setSummary] = useState<{ section: string; count: number }[] | null>(null);

  function download() {
    try {
      const data = buildMyDataExport(actor);
      const code = getPerson(actor.id)?.employeeCode ?? actor.id;
      downloadJson(`my-data-${code}-${new Date().toISOString().slice(0, 10)}.json`, data);
      setSummary(data.summary);
      onResult({ tone: "ok", text: "Your data file has been downloaded." });
    } catch {
      onResult({ tone: "err", text: "Could not build your data file. Try again." });
    }
  }

  return (
    <Card title="Download my data">
      <div className="stack">
        <p className="muted">A JSON file of your own records.</p>
        <div>
          <button className="btn" type="button" onClick={download}>
            Download my data
          </button>
        </div>
        {summary && (
          <DataTable headers={["Section", "Records"]} rows={summary.map((s) => [s.section, s.count])} />
        )}
      </div>
    </Card>
  );
}

function RequestRow({ req, children, showPerson = false }: { req: DataRequest; children?: ReactNode; showPerson?: boolean }) {
  const overdue = isRequestOverdue(req);
  const left = daysLeft(req);
  const person = showPerson ? getPerson(req.personId) : undefined;
  return (
    <li className="cmp-item">
      <div className="cmp-item-head">
        <strong>
          {showPerson ? `${person?.fullName ?? "Unknown"} · ` : ""}
          {req.type} request
        </strong>
        <span className="row-gap">
          {overdue && <StatusBadge status="Overdue" tone="danger" literal />}
          <StatusBadge status={req.status} tone={toneFor(req.status)} literal />
        </span>
      </div>
      {req.details && <p className="cmp-desc">{req.details}</p>}
      <div className="cmp-meta">
        <span>Raised {formatShortDate(req.createdOn)}</span>
        <span>Due {formatShortDate(req.dueOn)}</span>
        {isRequestOpen(req) && !overdue && <span>{left} days left</span>}
        {showPerson && person && <span>{privacyLawFor(String(person.countryCode))}</span>}
        {req.closedOn && <span>Closed {formatShortDate(req.closedOn)}</span>}
      </div>
      {req.outcome && <p className="muted">Outcome: {req.outcome}</p>}
      {children}
    </li>
  );
}

function MyRequestsTab({ actor, requests, onResult }: { actor: ComplianceActor; requests: DataRequest[]; onResult: (error: string | null, ok: string) => void }) {
  const [type, setType] = useState<RequestType>("Access");
  const [details, setDetails] = useState("");

  return (
    <div className="cmp-split">
      <Card title="New request">
        <div className="stack">
          <div className="cmp-form">
            <Field label="Request type" wide>
              <select value={type} onChange={(e) => setType(e.target.value as RequestType)}>
                {REQUEST_TYPES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </Field>
            <Field label={type === "Access" ? "Details (optional)" : "Details"} wide>
              <textarea
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                placeholder={type === "Correction" ? "What is wrong and what it should be" : type === "Deletion" ? "Which data should be deleted" : "Anything specific you need"}
              />
            </Field>
          </div>
          <p className="muted">HR responds within {REQUEST_DUE_DAYS} days.</p>
          <div>
            <button
              className="btn"
              type="button"
              onClick={() => {
                const error = raiseRequest(actor, type, details);
                onResult(error, `${type} request submitted.`);
                if (!error) setDetails("");
              }}
            >
              Submit request
            </button>
          </div>
        </div>
      </Card>
      <Card title="My requests">
        {requests.length === 0 ? (
          <EmptyState title="No requests" />
        ) : (
          <ul className="cmp-list">
            {requests.map((r) => (
              <RequestRow key={r.id} req={r}>
                {isRequestOpen(r) && (
                  <div className="cmp-actions">
                    <button className="btn-ghost btn-tiny" type="button" onClick={() => onResult(withdrawRequest(actor, r.id), "Request withdrawn.")}>
                      Withdraw
                    </button>
                  </div>
                )}
              </RequestRow>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function RequestQueue({ actor, requests, onResult }: { actor: ComplianceActor; requests: DataRequest[]; onResult: (error: string | null, ok: string) => void }) {
  const [filter, setFilter] = useState("open");
  const [closing, setClosing] = useState<{ req: DataRequest; next: "Completed" | "Rejected" } | null>(null);
  const [outcome, setOutcome] = useState("");
  const [error, setError] = useState("");

  const open = requests.filter(isRequestOpen);
  const overdue = open.filter((r) => isRequestOverdue(r));
  const shown = requests
    .filter((r) => (filter === "open" ? isRequestOpen(r) : filter === "overdue" ? isRequestOverdue(r) : !isRequestOpen(r)))
    .sort((a, b) => a.dueOn.localeCompare(b.dueOn));

  return (
    <>
      <MetricGrid>
        <MetricCard label="Open" value={open.length} />
        <MetricCard label="Overdue" value={overdue.length} />
        <MetricCard label="Due in 7 days" value={open.filter((r) => !isRequestOverdue(r) && daysLeft(r) <= 7).length} />
      </MetricGrid>
      <Card
        title="Request queue"
        action={
          <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter requests">
            <option value="open">Open</option>
            <option value="overdue">Overdue</option>
            <option value="closed">Closed</option>
          </select>
        }
      >
        {shown.length === 0 ? (
          <EmptyState title="No matching requests" />
        ) : (
          <ul className="cmp-list">
            {shown.map((r) => (
              <RequestRow key={r.id} req={r} showPerson>
                {isRequestOpen(r) && (
                  <div className="cmp-actions">
                    {r.status === "Open" && (
                      <button className="btn btn-tiny" type="button" onClick={() => onResult(moveRequest(actor, r.id, "In progress"), "Request started.")}>
                        Start
                      </button>
                    )}
                    {r.status === "In progress" && (
                      <>
                        <button
                          className="btn btn-tiny"
                          type="button"
                          onClick={() => {
                            setClosing({ req: r, next: "Completed" });
                            setOutcome("");
                            setError("");
                          }}
                        >
                          {closesManually(r.type) ? "Close (manual)" : "Complete"}
                        </button>
                        <button
                          className="btn-ghost btn-tiny"
                          type="button"
                          onClick={() => {
                            setClosing({ req: r, next: "Rejected" });
                            setOutcome("");
                            setError("");
                          }}
                        >
                          Reject
                        </button>
                      </>
                    )}
                  </div>
                )}
              </RequestRow>
            ))}
          </ul>
        )}
      </Card>
      <Dialog
        open={!!closing}
        title={closing?.next === "Rejected" ? "Reject request" : closing && closesManually(closing.req.type) ? "Close request (manual)" : "Complete request"}
        onClose={() => setClosing(null)}
        actions={
          <>
            <button className="btn-ghost" type="button" onClick={() => setClosing(null)}>
              Cancel
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => {
                if (!closing) return;
                const err = moveRequest(actor, closing.req.id, closing.next, outcome);
                if (err) return setError(err);
                onResult(
                  null,
                  closing.next === "Rejected" ? "Request rejected." : closesManually(closing.req.type) ? "Request closed (manual)." : "Request completed.",
                );
                setClosing(null);
              }}
            >
              {closing?.next === "Rejected" ? "Reject" : closing && closesManually(closing.req.type) ? "Close" : "Complete"}
            </button>
          </>
        }
      >
        <div className="stack">
          {error && <p className="note err">{error}</p>}
          {closing && closing.next === "Completed" && closesManually(closing.req.type) && (
            <p className="muted">Make the change in the employee's record first. Closing here does not change any data.</p>
          )}
          <Field
            label={
              closing?.next === "Rejected"
                ? "Reason"
                : closing && closesManually(closing.req.type)
                  ? "What was changed, and where"
                  : "Outcome (optional)"
            }
          >
            <textarea value={outcome} onChange={(e) => setOutcome(e.target.value)} />
          </Field>
        </div>
      </Dialog>
    </>
  );
}

function RetentionTab({ actor, rules, onResult }: { actor: ComplianceActor; rules: RetentionRule[]; onResult: (error: string | null, ok: string) => void }) {
  const blank = { category: "", period: "", unit: "years" as RetentionUnit, legalBasis: "" };
  const [form, setForm] = useState(blank);
  const [editingId, setEditingId] = useState<string | null>(null);

  function save() {
    const input: RetentionInput = { category: form.category, period: form.period.trim() === "" ? NaN : Number(form.period), unit: form.unit, legalBasis: form.legalBasis };
    const error = saveRetentionRule(actor, input, editingId ?? undefined);
    onResult(error, editingId ? "Retention rule updated." : "Retention rule added.");
    if (!error) {
      setForm(blank);
      setEditingId(null);
    }
  }

  return (
    <div className="stack">
      <Card title={editingId ? "Edit rule" : "Add rule"}>
        <div className="stack">
          <div className="cmp-form">
            <Field label="Data category" wide>
              <input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="e.g. Exit interview notes" />
            </Field>
            <Field label="Retention period">
              <input type="number" min={1} step={1} value={form.period} onChange={(e) => setForm({ ...form, period: e.target.value })} />
            </Field>
            <Field label="Unit">
              <select value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value as RetentionUnit })}>
                <option value="months">Months</option>
                <option value="years">Years</option>
              </select>
            </Field>
            <Field label="Legal basis" wide>
              <select value={form.legalBasis} onChange={(e) => setForm({ ...form, legalBasis: e.target.value })}>
                <option value="">Choose…</option>
                {LEGAL_BASES.map((b) => (
                  <option key={b}>{b}</option>
                ))}
              </select>
            </Field>
          </div>
          <div className="row-gap">
            <button className="btn" type="button" onClick={save}>
              {editingId ? "Save changes" : "Add rule"}
            </button>
            {editingId && (
              <button
                className="btn-ghost"
                type="button"
                onClick={() => {
                  setEditingId(null);
                  setForm(blank);
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      </Card>
      <Card title="Retention policy">
        <DataTable
          headers={["Data category", "Retention", "Legal basis", "Updated", ""]}
          empty={<EmptyState title="No rules" description="Add one per data category." />}
          rows={rules.map((r) => [
            r.category,
            `${r.period} ${r.period === 1 ? r.unit.slice(0, -1) : r.unit}`,
            r.legalBasis,
            formatShortDate(r.updatedOn),
            <span key="a" className="cmp-actions">
              <button
                className="btn-ghost btn-tiny"
                type="button"
                onClick={() => {
                  setEditingId(r.id);
                  setForm({ category: r.category, period: String(r.period), unit: r.unit, legalBasis: r.legalBasis });
                }}
              >
                Edit
              </button>
              <button className="btn-ghost btn-tiny" type="button" onClick={() => onResult(removeRetentionRule(actor, r.id), "Retention rule removed.")}>
                Remove
              </button>
            </span>,
          ])}
        />
      </Card>
    </div>
  );
}
