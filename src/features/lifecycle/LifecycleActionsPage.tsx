import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import {
  ActionButton,
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
  SubmitButton,
  Tabs,
  useAction,
} from "../../components/ui.tsx";
import { GRADE_OPTIONS, listJobProfiles, locationOptions, subscribeOrgOverlay, getOrgOverlay, unitOptions } from "../../data/orgStructureLocal.ts";
import { allReportIds, getPerson, listPeople, subscribePeople } from "../../data/peopleLocal.ts";
import type { PersonRecord } from "../../data/peopleData.ts";
import { formatShortDate, todayISO } from "../../model.ts";
import { usePortal } from "../../store.tsx";
import {
  FIELDS_BY_TYPE,
  HR_ONLY_ACTION_TYPES,
  LEAVE_OF_ABSENCE_TYPES,
  LIFECYCLE_ACTION_TYPES,
  actionBlocker,
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
  pendingGroupsOf,
  type ActionStep,
  type LifecycleAction,
  type LifecycleActionStatus,
  type LifecycleActionType,
} from "./lifecycleActionsStore.ts";
import { isHrRole } from "./lifecycleShared.ts";
import { API_ENABLED } from "../../api/client.ts";
import { loadApiPeople } from "../../api/portalSync.ts";
import {
  apiDecideLifecycleAction,
  apiRaiseLifecycleAction,
  apiWithdrawLifecycleAction,
  loadAssignmentHistory,
  type AssignmentOut,
} from "../../api/syncOpsLifecycle.ts";
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
  const waiting = pendingGroupsOf(step);
  const partly = waiting.length > 0 && waiting.length < (step?.groups?.length ?? 0);
  return (
    <div>
      <StatusBadge status={action.status} tone={statusTone(action.status)} literal />
      {action.status === "Pending" && step && (
        <p className="muted">
          {step.label}
          {partly ? ` · waiting on ${waiting.map((g) => g.label.replace(/ approval$/, "")).join(" + ")}` : ""}
        </p>
      )}
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

const DATE_LABEL: Partial<Record<LifecycleActionType, string>> = {
  "Leave of absence": "First day of leave",
  "Return from leave": "Return date",
  "Probation completion": "Confirmation date",
  Rehire: "Rehire date",
};

function RaiseForm({ candidates, people, onDone }: { candidates: PersonRecord[]; people: PersonRecord[]; onDone: (m: Message) => void }) {
  const { demoProfile } = usePortal();
  const orgOverlay = useSyncExternalStore(subscribeOrgOverlay, getOrgOverlay);
  const [employeeId, setEmployeeId] = useState("");
  const [type, setType] = useState<LifecycleActionType>("Transfer");
  const [effectiveDate, setEffectiveDate] = useState(todayISO());
  const [reason, setReason] = useState("");
  const [department, setDepartment] = useState("");
  const [location, setLocation] = useState("");
  const [designation, setDesignation] = useState("");
  const [grade, setGrade] = useState("");
  const [managerId, setManagerId] = useState("");
  const [jobProfileId, setJobProfileId] = useState("");
  const [contractEndDate, setContractEndDate] = useState("");
  const [leaveType, setLeaveType] = useState(LEAVE_OF_ABSENCE_TYPES[0]);
  const [leaveEnd, setLeaveEnd] = useState("");
  const [error, setError] = useState<string | null>(null);
  const person = employeeId ? getPerson(employeeId) : undefined;
  const fields = FIELDS_BY_TYPE[type];
  const types = isHrRole(demoProfile.role) ? LIFECYCLE_ACTION_TYPES : LIFECYCLE_ACTION_TYPES.filter((t) => !HR_ONLY_ACTION_TYPES.includes(t));
  // Only people this action fits: leavers for a rehire, people on leave for a return, and so on.
  const eligible = useMemo(
    () => candidates.filter((p) => !actionBlocker(p, type) && canRaiseFor(demoProfile, p.id, type)),
    [candidates, type, demoProfile],
  );
  const profiles = useMemo(() => listJobProfiles(orgOverlay).filter((p) => !p.inactive), [orgOverlay]);
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
    setJobProfileId(p?.jobProfileId ?? "");
    setContractEndDate(p?.contractEndDate ?? "");
  }

  function pickType(next: LifecycleActionType) {
    setType(next);
    setError(null);
    const current = employeeId ? getPerson(employeeId) : undefined;
    if (current && actionBlocker(current, next)) pickEmployee("");
  }

  const act = useAction();

  async function submit() {
    const [countryCode, loc] = location.includes("|") ? [location.split("|")[0], location.split("|").slice(1).join("|")] : ["", location];
    const raise = API_ENABLED ? apiRaiseLifecycleAction : (input: Parameters<typeof raiseLifecycleAction>[1]) => Promise.resolve(raiseLifecycleAction(demoProfile, input));
    const result = await raise({
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
      jobProfileId,
      contractEndDate,
      leaveType,
      leaveEnd,
    });
    if (result) {
      setError(result);
      return false;
    }
    onDone({ tone: "ok", text: `${type} for ${person?.fullName ?? "the employee"} raised.` });
    return true;
  }

  return (
    <form className="stack" onSubmit={act.submit(submit, { success: () => `${type} for ${person?.fullName ?? "the employee"} sent for approval.` })}>
      <Banner message={error ? { tone: "err", text: error } : null} />
      <div className="lc-grid">
        <Field label="Action">
          <select value={type} onChange={(e) => pickType(e.target.value as LifecycleActionType)}>
            {types.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </Field>
        <PersonPicker label="Employee" people={eligible} value={employeeId} onChange={pickEmployee} />
        {eligible.length === 0 && (
          <p className="muted" style={{ gridColumn: "1 / -1", margin: 0 }}>
            No one you can raise this for right now.
          </p>
        )}
        {person && (
          <p className="muted" style={{ gridColumn: "1 / -1", margin: 0 }}>
            Now: {person.employmentStatus} · {person.designation} · {person.grade} · {person.department} · {person.location}, {person.countryName} ·
            Manager {person.managerName || "none"}
            {person.contractEndDate ? ` · Contract ends ${formatShortDate(person.contractEndDate)}` : ""}
            {person.leaveOfAbsence ? ` · On ${person.leaveOfAbsence.type.toLowerCase()} leave until ${formatShortDate(person.leaveOfAbsence.end)}` : ""}
          </p>
        )}
        <Field label={DATE_LABEL[type] ?? "Effective date"}>
          <input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} required />
        </Field>
        {type === "Leave of absence" && (
          <>
            <Field label="Type of leave">
              <select value={leaveType} onChange={(e) => setLeaveType(e.target.value)}>
                {LEAVE_OF_ABSENCE_TYPES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </Field>
            <Field label="Last day of leave">
              <input type="date" value={leaveEnd} min={effectiveDate} onChange={(e) => setLeaveEnd(e.target.value)} required />
            </Field>
            <p className="muted" style={{ gridColumn: "1 / -1", margin: 0 }}>
              They go back to active automatically on the last day.
            </p>
          </>
        )}
        {fields.includes("contractEndDate") && (
          <Field label="New contract end date">
            <input type="date" value={contractEndDate} onChange={(e) => setContractEndDate(e.target.value)} required />
          </Field>
        )}
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
          <Field label={type === "Rehire" ? "Title" : "New title"}>
            <input value={designation} maxLength={80} onChange={(e) => setDesignation(e.target.value)} required />
          </Field>
        )}
        {fields.includes("jobProfileId") && (
          <Field label="Job profile">
            <select value={jobProfileId} onChange={(e) => setJobProfileId(e.target.value)}>
              {person && !profiles.some((p) => p.id === person.jobProfileId) && <option value={person.jobProfileId}>Current profile</option>}
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title} · {p.familyName}
                </option>
              ))}
            </select>
          </Field>
        )}
        {fields.includes("grade") && (
          <Field label={type === "Job change" ? "Grade (same or lower)" : "New grade"}>
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
        <SubmitButton action={act} className="btn" disabled={!employeeId}>
          Submit for approval
        </SubmitButton>
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

  const [busy, setBusy] = useState(false);

  async function decide(decision: "approve" | "reject") {
    setBusy(true);
    const result = API_ENABLED
      ? await apiDecideLifecycleAction(action.id, decision, note)
      : decideLifecycleAction(demoProfile, action.id, decision, note);
    setBusy(false);
    if (result) {
      setError(result);
      return false;
    }
    // An approved change may already be applied to the person's record.
    if (API_ENABLED && decision === "approve") void loadApiPeople().catch(() => undefined);
    onDone({ tone: "ok", text: decision === "approve" ? "Approved." : "Rejected." });
    return true;
  }

  async function withdraw() {
    setBusy(true);
    const result = API_ENABLED ? await apiWithdrawLifecycleAction(action.id) : withdrawLifecycleAction(demoProfile, action.id);
    setBusy(false);
    if (result) {
      setError(result);
      return false;
    }
    onDone({ tone: "ok", text: "Withdrawn." });
    return true;
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
        {action.leave && (
          <div>
            <dt>Leave</dt>
            <dd>
              {action.leave.type} · {formatShortDate(action.leave.start)} – {formatShortDate(action.leave.end)}
              {action.returnedOn ? ` · returned ${formatShortDate(action.returnedOn)}` : ""}
            </dd>
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
        rows={action.steps.flatMap((s, i) => {
          const open = action.status === "Pending" && i === currentStepIndex(action);
          const badge = (d: ActionStep["decision"], waiting: boolean) =>
            d ? (
              <StatusBadge status={d} tone={d === "Approved" ? "ok" : "danger"} literal />
            ) : waiting ? (
              <StatusBadge status="Waiting" tone="warn" literal />
            ) : (
              <span className="muted">—</span>
            );
          const parallel = (s.groups?.length ?? 0) > 1;
          const head = [
            parallel ? `${s.label} (${s.mode === "any" ? "any one" : "all must approve"})` : s.label,
            approverNames(s),
            badge(s.decision, open),
            s.by ? `${s.by} · ${formatShortDate(s.on ?? "")}` : "—",
            s.note || "—",
          ];
          if (!parallel) return [head];
          // Parallel step: one row per approver group.
          return [
            head,
            ...(s.groups ?? []).map((g) => [
              <span style={{ paddingLeft: 16 }}>{g.label}</span>,
              approverNames(g),
              badge(g.decision, open && !s.decision),
              g.by ? `${g.by} · ${formatShortDate(g.on ?? "")}` : "—",
              g.note || "—",
            ]),
          ];
        })}
        empty={<p className="muted">No approval steps. Applied on submit.</p>}
      />
      {API_ENABLED && <JobHistory personId={action.employeeId} refreshKey={`${action.status}-${action.appliedOn ?? ""}`} />}
      {decidable && (
        <>
          <Field label="Note">
            <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Required when rejecting" />
          </Field>
          <div className="row-gap">
            <ActionButton
              className="btn"
              disabled={busy}
              success={`${action.type} for ${action.employeeName} approved.`}
              onAction={() => decide("approve")}
            >
              Approve
            </ActionButton>
            <ActionButton
              className="btn-ghost"
              disabled={busy}
              success={`${action.type} for ${action.employeeName} rejected.`}
              onAction={() => decide("reject")}
            >
              Reject
            </ActionButton>
          </div>
        </>
      )}
      {withdrawable && !decidable && (
        <div>
          <ActionButton className="btn-ghost" disabled={busy} success={`${action.type} for ${action.employeeName} withdrawn.`} onAction={withdraw}>
            Withdraw
          </ActionButton>
        </div>
      )}
    </div>
  );
}

/** Effective-dated job history from the backend (newest first). */
function JobHistory({ personId, refreshKey }: { personId: string; refreshKey: string }) {
  const [rows, setRows] = useState<AssignmentOut[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadAssignmentHistory(personId)
      .then((r) => live && (setRows(r), setError(null)))
      .catch(() => live && setError("Couldn't load the job history."));
    return () => {
      live = false;
    };
  }, [personId, refreshKey]);
  if (error) return <p className="muted">{error}</p>;
  if (!rows) return null;
  return (
    <div className="stack">
      <strong>Job history</strong>
      <DataTable
        headers={["From", "To", "Title", "Grade", "Department", "Location", "Manager"]}
        rows={rows.map((r) => [
          formatShortDate(r.effective_from),
          r.effective_to ? formatShortDate(r.effective_to) : "Now",
          r.job_title,
          r.grade,
          r.department,
          r.location,
          r.manager_name ?? "—",
        ])}
        empty={<p className="muted">No history yet.</p>}
      />
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
    // HR also gets people who have left (for a rehire); the form narrows the list to the chosen action.
    if (hr) return people.filter((p) => p.id !== actor.id);
    const active = people.filter((p) => p.employmentStatus !== "Terminated" && p.id !== actor.id);
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
