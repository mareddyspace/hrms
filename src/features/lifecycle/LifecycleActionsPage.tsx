import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  Banner,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  MetricCard,
  MetricGrid,
  Page,
  StatusBadge,
  Tabs,
} from "../../components/ui.tsx";
import { GRADE_OPTIONS, locationOptions, subscribeOrgOverlay, getOrgOverlay, unitOptions } from "../../data/orgStructureLocal.ts";
import { allReportIds, getPerson, listPeople, subscribePeople } from "../../data/peopleLocal.ts";
import type { PersonRecord } from "../../data/peopleData.ts";
import { formatShortDate, todayISO } from "../../model.ts";
import { usePortal } from "../../store.tsx";
import {
  FIELDS_BY_TYPE,
  LIFECYCLE_ACTION_TYPES,
  applyDueLifecycleActions,
  approverNames,
  canDecide,
  canRaiseFor,
  canSeeAction,
  changedFields,
  currentStepIndex,
  decideLifecycleAction,
  getLifecycleActions,
  raiseLifecycleAction,
  subscribeLifecycleActions,
  withdrawLifecycleAction,
  type LifecycleAction,
  type LifecycleActionStatus,
  type LifecycleActionType,
} from "./lifecycleActionsStore.ts";
import { isHrRole } from "./lifecycleShared.ts";
import "./lifecycle.css";

type Message = { tone: "ok" | "err" | "warn" | "info"; text: string } | null;

function statusTone(status: LifecycleActionStatus): "ok" | "warn" | "danger" | "info" | "neutral" {
  if (status === "Applied") return "ok";
  if (status === "Scheduled") return "info";
  if (status === "Rejected") return "danger";
  if (status === "Withdrawn") return "neutral";
  return "warn";
}

function StatusCell({ action }: { action: LifecycleAction }) {
  const step = action.steps[currentStepIndex(action)];
  return (
    <div>
      <StatusBadge status={action.status} tone={statusTone(action.status)} literal />
      {action.status === "Pending" && step && <p className="muted">{step.label}</p>}
    </div>
  );
}

function ChangeSummary({ action }: { action: LifecycleAction }) {
  const changes = changedFields(action);
  return (
    <div>
      {changes.map((c) => (
        <p key={c.field} style={{ margin: 0 }}>
          <span className="muted">{c.field}:</span> {c.before} → <strong>{c.after}</strong>
        </p>
      ))}
    </div>
  );
}

/* ───────────── Raise form ───────────── */

function PersonPicker({
  label,
  people,
  value,
  onChange,
  excludeId,
}: {
  label: string;
  people: PersonRecord[];
  value: string;
  onChange: (id: string) => void;
  excludeId?: string;
}) {
  const [q, setQ] = useState("");
  const options = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = people.filter(
      (p) => p.id !== excludeId && (!needle || `${p.fullName} ${p.employeeCode} ${p.designation}`.toLowerCase().includes(needle)),
    );
    const picked = people.find((p) => p.id === value);
    const top = list.slice(0, 100);
    return picked && !top.includes(picked) ? [picked, ...top] : top;
  }, [people, q, value, excludeId]);
  return (
    <Field label={label} wide>
      <div className="row-gap">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or code" aria-label={`Search ${label.toLowerCase()}`} />
        <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
          <option value="">Choose…</option>
          {options.map((p) => (
            <option key={p.id} value={p.id}>
              {p.fullName} · {p.designation} · {p.countryName}
            </option>
          ))}
        </select>
      </div>
    </Field>
  );
}

function RaiseForm({ candidates, people, onDone }: { candidates: PersonRecord[]; people: PersonRecord[]; onDone: (m: Message) => void }) {
  const { demoProfile } = usePortal();
  useSyncExternalStore(subscribeOrgOverlay, getOrgOverlay);
  const [employeeId, setEmployeeId] = useState("");
  const [type, setType] = useState<LifecycleActionType>("Transfer");
  const [effectiveDate, setEffectiveDate] = useState(todayISO());
  const [reason, setReason] = useState("");
  const [department, setDepartment] = useState("");
  const [location, setLocation] = useState("");
  const [designation, setDesignation] = useState("");
  const [grade, setGrade] = useState("");
  const [managerId, setManagerId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const person = employeeId ? getPerson(employeeId) : undefined;
  const fields = FIELDS_BY_TYPE[type];
  const departments = useMemo(() => unitOptions(people, "department"), [people]);
  const locations = useMemo(() => locationOptions(people), [people]);
  const managers = useMemo(() => people.filter((p) => p.employmentStatus !== "Terminated"), [people]);

  function pickEmployee(id: string) {
    setEmployeeId(id);
    const p = getPerson(id);
    setDepartment(p?.department ?? "");
    setLocation(p ? `${p.countryCode}|${p.location}` : "");
    setDesignation(p?.designation ?? "");
    setGrade(p?.grade ?? "");
    setManagerId(p?.managerId ?? "");
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const [countryCode, loc] = location.includes("|") ? [location.split("|")[0], location.split("|").slice(1).join("|")] : ["", location];
    const result = raiseLifecycleAction(demoProfile, {
      employeeId,
      type,
      effectiveDate,
      reason,
      department,
      location: loc,
      countryCode,
      designation,
      grade,
      managerId,
    });
    if (result) setError(result);
    else onDone({ tone: "ok", text: `${type} for ${person?.fullName ?? "the employee"} raised.` });
  }

  return (
    <form className="stack" onSubmit={submit}>
      <Banner message={error ? { tone: "err", text: error } : null} />
      <div className="lc-grid">
        <PersonPicker label="Employee" people={candidates} value={employeeId} onChange={pickEmployee} />
        {person && (
          <p className="muted" style={{ gridColumn: "1 / -1", margin: 0 }}>
            Now: {person.designation} · {person.grade} · {person.department} · {person.location}, {person.countryName} · Manager{" "}
            {person.managerName || "none"}
          </p>
        )}
        <Field label="Action">
          <select value={type} onChange={(e) => setType(e.target.value as LifecycleActionType)}>
            {LIFECYCLE_ACTION_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </Field>
        <Field label="Effective date">
          <input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} required />
        </Field>
        {fields.includes("department") && (
          <Field label="New department">
            <select value={department} onChange={(e) => setDepartment(e.target.value)}>
              {person && !departments.some((d) => d.value === person.department) && <option value={person.department}>{person.department}</option>}
              {departments.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          </Field>
        )}
        {fields.includes("location") && (
          <Field label="New location">
            <select value={location} onChange={(e) => setLocation(e.target.value)}>
              {person && !locations.some((l) => `${l.countryCode}|${l.location}` === location) && location && (
                <option value={location}>{location.split("|").slice(1).join("|")}</option>
              )}
              {locations.map((l) => (
                <option key={`${l.countryCode}|${l.location}`} value={`${l.countryCode}|${l.location}`}>
                  {l.label} · {l.countryName}
                </option>
              ))}
            </select>
          </Field>
        )}
        {fields.includes("designation") && (
          <Field label="New title">
            <input value={designation} maxLength={80} onChange={(e) => setDesignation(e.target.value)} required />
          </Field>
        )}
        {fields.includes("grade") && (
          <Field label="New grade">
            <select value={grade} onChange={(e) => setGrade(e.target.value)}>
              {GRADE_OPTIONS.map((g) => (
                <option key={g}>{g}</option>
              ))}
            </select>
          </Field>
        )}
        {fields.includes("managerId") && (
          <PersonPicker label={type === "Transfer" ? "Manager (optional change)" : "New manager"} people={managers} value={managerId} onChange={setManagerId} excludeId={employeeId} />
        )}
        <Field label="Reason" wide>
          <textarea value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} required />
        </Field>
      </div>
      <div>
        <button className="btn" type="submit" disabled={!employeeId}>
          Submit for approval
        </button>
      </div>
    </form>
  );
}

/* ───────────── Detail / decide ───────────── */

function ActionDetail({ action, onDone }: { action: LifecycleAction; onDone: (m: Message) => void }) {
  const { demoProfile } = usePortal();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const decidable = canDecide(demoProfile, action);
  const withdrawable = action.status === "Pending" && (action.raisedById === demoProfile.id || isHrRole(demoProfile.role));

  function decide(decision: "approve" | "reject") {
    const result = decideLifecycleAction(demoProfile, action.id, decision, note);
    if (result) setError(result);
    else onDone({ tone: "ok", text: decision === "approve" ? "Approved." : "Rejected." });
  }

  function withdraw() {
    const result = withdrawLifecycleAction(demoProfile, action.id);
    if (result) setError(result);
    else onDone({ tone: "ok", text: "Withdrawn." });
  }

  return (
    <div className="stack">
      <Banner message={error ? { tone: "err", text: error } : null} />
      <dl className="lc-facts">
        <div>
          <dt>Employee</dt>
          <dd>
            <Link to={`/people/${action.employeeId}`}>{action.employeeName}</Link>
          </dd>
        </div>
        <div>
          <dt>Effective</dt>
          <dd>{formatShortDate(action.effectiveDate)}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>
            <StatusBadge status={action.status} tone={statusTone(action.status)} literal />
          </dd>
        </div>
        <div>
          <dt>Raised by</dt>
          <dd>
            {action.raisedBy} · {formatShortDate(action.raisedOn)}
          </dd>
        </div>
        {action.appliedOn && (
          <div>
            <dt>Applied</dt>
            <dd>{formatShortDate(action.appliedOn)}</dd>
          </div>
        )}
        <div style={{ gridColumn: "1 / -1" }}>
          <dt>Reason</dt>
          <dd>{action.reason}</dd>
        </div>
        {action.closedNote && (
          <div style={{ gridColumn: "1 / -1" }}>
            <dt>Note</dt>
            <dd>{action.closedNote}</dd>
          </div>
        )}
      </dl>
      <DataTable headers={["Field", "From", "To"]} rows={changedFields(action).map((c) => [c.field, c.before, c.after])} />
      <DataTable
        headers={["Step", "Approvers", "Decision", "By", "Note"]}
        rows={action.steps.map((s, i) => [
          s.label,
          approverNames(s),
          s.decision ? (
            <StatusBadge status={s.decision} tone={s.decision === "Approved" ? "ok" : "danger"} literal />
          ) : action.status === "Pending" && i === currentStepIndex(action) ? (
            <StatusBadge status="Waiting" tone="warn" literal />
          ) : (
            <span className="muted">—</span>
          ),
          s.by ? `${s.by} · ${formatShortDate(s.on ?? "")}` : "—",
          s.note || "—",
        ])}
        empty={<p className="muted">No approval steps. Applied on submit.</p>}
      />
      {decidable && (
        <>
          <Field label="Note">
            <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Required when rejecting" />
          </Field>
          <div className="row-gap">
            <button className="btn" type="button" onClick={() => decide("approve")}>
              Approve
            </button>
            <button className="btn-ghost" type="button" onClick={() => decide("reject")}>
              Reject
            </button>
          </div>
        </>
      )}
      {withdrawable && !decidable && (
        <div>
          <button className="btn-ghost" type="button" onClick={withdraw}>
            Withdraw
          </button>
        </div>
      )}
    </div>
  );
}

/* ───────────── Page ───────────── */

export function LifecycleActionsPage() {
  const { demoProfile } = usePortal();
  const people = useSyncExternalStore(subscribePeople, listPeople);
  const actions = useSyncExternalStore(subscribeLifecycleActions, getLifecycleActions);
  const [tab, setTab] = useState("mine");
  const [message, setMessage] = useState<Message>(null);
  const [raising, setRaising] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const actor = demoProfile;
  const hr = isHrRole(actor.role);

  useEffect(() => {
    const applied = applyDueLifecycleActions();
    if (applied) setMessage({ tone: "info", text: `${applied} scheduled change${applied === 1 ? "" : "s"} took effect today.` });
  }, []);

  const candidates = useMemo(() => {
    const active = people.filter((p) => p.employmentStatus !== "Terminated" && p.id !== actor.id);
    if (hr) return active;
    const below = new Set(allReportIds(actor.id));
    return active.filter((p) => below.has(p.id) && canRaiseFor(actor, p.id));
  }, [people, actor, hr]);

  const visible = useMemo(() => actions.filter((a) => canSeeAction(actor, a)), [actions, actor]);
  const waiting = visible.filter((a) => canDecide(actor, a));
  const open = visible.filter((a) => a.status === "Pending" || a.status === "Scheduled");
  const rows = tab === "mine" ? waiting : tab === "open" ? open : visible;
  const selected = openId ? actions.find((a) => a.id === openId) : undefined;
  const canRaise = candidates.length > 0;

  return (
    <Page
      title="Lifecycle actions"
      action={
        canRaise ? (
          <button className="btn" type="button" onClick={() => setRaising(true)}>
            Raise action
          </button>
        ) : undefined
      }
    >
      <Banner message={message} />
      <MetricGrid>
        <MetricCard label="Waiting for me" value={waiting.length} />
        <MetricCard label="Pending" value={visible.filter((a) => a.status === "Pending").length} />
        <MetricCard label="Scheduled" value={visible.filter((a) => a.status === "Scheduled").length} />
        <MetricCard label="Applied" value={visible.filter((a) => a.status === "Applied").length} />
      </MetricGrid>
      <Card>
        <div className="stack">
          <Tabs
            tabs={[
              { id: "mine", label: `Waiting for me (${waiting.length})` },
              { id: "open", label: `Open (${open.length})` },
              { id: "all", label: "All" },
            ]}
            value={tab}
            onChange={setTab}
          />
          <DataTable
            headers={["Employee", "Action", "Change", "Effective", "Status", "Raised by", ""]}
            rows={rows.map((a) => [
              <Link key={`p-${a.id}`} to={`/people/${a.employeeId}`}>
                {a.employeeName}
              </Link>,
              a.type,
              <ChangeSummary key={`c-${a.id}`} action={a} />,
              formatShortDate(a.effectiveDate),
              <StatusCell key={`s-${a.id}`} action={a} />,
              a.raisedBy,
              <button key={`o-${a.id}`} className="btn-ghost btn-tiny" type="button" onClick={() => setOpenId(a.id)}>
                {canDecide(actor, a) ? "Review" : "View"}
              </button>,
            ])}
            empty={<EmptyState title={tab === "mine" ? "Nothing waiting for you" : "No lifecycle actions"} />}
          />
        </div>
      </Card>
      <Dialog open={raising} title="Raise lifecycle action" onClose={() => setRaising(false)}>
        {raising && (
          <RaiseForm
            candidates={candidates}
            people={people}
            onDone={(m) => {
              setMessage(m);
              setRaising(false);
            }}
          />
        )}
      </Dialog>
      <Dialog open={Boolean(selected)} title={selected ? `${selected.type} · ${selected.employeeName}` : "Lifecycle action"} onClose={() => setOpenId(null)}>
        {selected && (
          <ActionDetail
            action={selected}
            onDone={(m) => {
              setMessage(m);
              setOpenId(null);
            }}
          />
        )}
      </Dialog>
    </Page>
  );
}
