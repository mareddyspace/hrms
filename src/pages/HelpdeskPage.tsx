import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ActionButton, Banner, EmptyState, FilterBar, MetricCard, MetricGrid, Page, StatusBadge, SubmitButton, Tabs, notify, useAction } from "../components/ui.tsx";
import {
  HR_DESK_OWNERS,
  HR_REQUEST_CATEGORIES,
  HR_REQUEST_PRIORITIES,
  HR_REQUEST_SLA,
  hrDeskOwnerName,
  hrRequestOverdue,
  isHrRole,
  type HrRequest,
  type HrRequestCategory,
  type HrRequestPriority,
} from "../data/collabData.ts";
import {
  addHrComment,
  addHrCommentApi,
  allowedHrStatuses,
  assignHrRequest,
  assignHrRequestApi,
  canReassignHrRequest,
  createHrRequest,
  createHrRequestApi,
  downloadHrRequestFileApi,
  escalateHrRequestApi,
  getCollabState,
  hrRequestVisibleTo,
  isHrDeskMember,
  rateHrRequestApi,
  setHrRequestPriority,
  setHrRequestStatus,
  setHrRequestStatusApi,
  subscribeCollab,
  uploadHrRequestFileApi,
  worksHrRequest,
} from "../data/collabLocal.ts";
import {
  CONTACT_PREFERENCES,
  HELP_FAQ,
  HR_REQUEST_SUBCATEGORIES,
  POLICY_SHORTCUTS,
  useFaqVotes,
  voteFaq,
  type ContactPreference,
} from "../data/helpdesk.ts";
import { TEMPLATE_BLANKS_ERROR, hasTemplateBlanks, useTemplatedText } from "../data/requestTemplates.ts";
import { API_ENABLED } from "../api/client.ts";
import { usePortal } from "../store.tsx";
import "./helpdesk.css";

type QueueFilter = "open" | "mine" | "unassigned" | "overdue" | "all";
const MAX_FILES = 5;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
// Same as the server (backend/app/services/storage.py ALLOWED_TYPES).
const FILE_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"];
const FILE_ACCEPT = ".pdf,.png,.jpg,.jpeg,.gif,.webp";
const fileProblem = (f: File) =>
  !FILE_TYPES.includes(f.type) ? `${f.name}: attach a PDF or an image.` : f.size > MAX_FILE_BYTES ? `${f.name} is larger than 5 MB.` : "";

function stamp(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function sizeLabel(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function hoursBetween(from?: string, to?: string): number | null {
  const a = Date.parse(from ?? "");
  const b = Date.parse(to ?? "");
  return Number.isNaN(a) || Number.isNaN(b) || b < a ? null : (b - a) / 3_600_000;
}

function hoursLabel(h: number | null): string {
  if (h === null) return "—";
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  return h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} days`;
}

const isClosed = (r: HrRequest) => r.status === "Resolved" || r.status === "Closed";
const shortId = (id: string) => id.toUpperCase().replace(/^HR-LOCAL-/, "HR-");

function SlaCell({ r }: { r: HrRequest }) {
  if (isClosed(r)) return <span className="muted">Met · {stamp(r.dueAt)}</span>;
  const overdue = hrRequestOverdue(r);
  return (
    <span className={overdue ? "hd-sla overdue" : "hd-sla"}>
      {stamp(r.dueAt)}
      {overdue ? " · Overdue" : r.status === "Waiting on you" ? " · Paused" : ""}
    </span>
  );
}

export function HelpdeskPage() {
  const { employee, demoProfile } = usePortal();
  const collab = useSyncExternalStore(subscribeCollab, getCollabState, getCollabState);
  const [params, setParams] = useSearchParams();
  const hrView = isHrRole(demoProfile.role);
  const deskView = isHrDeskMember(employee.id, demoProfile.role) || demoProfile.role === "admin";
  const me = employee.id;

  const visible = useMemo(
    () => collab.hrRequests.filter((r) => API_ENABLED || hrRequestVisibleTo(r, me, demoProfile.role)),
    [collab.hrRequests, me, demoProfile.role],
  );
  const mine = useMemo(() => visible.filter((r) => r.requesterId === me), [visible, me]);
  const queue = useMemo(() => visible.filter((r) => r.requesterId !== me && (hrView || deskView || r.assigneeId === me)), [visible, me, hrView, deskView]);

  const [tab, setTab] = useState(hrView ? "queue" : "request");
  const [selectedId, setSelectedId] = useState("");
  const [queueFilter, setQueueFilter] = useState<QueueFilter>("open");
  const [historyQ, setHistoryQ] = useState("");

  // /help?request=<id> from a notification opens that request.
  const linkedId = params.get("request");
  useEffect(() => {
    if (!linkedId) return;
    const target = visible.find((r) => r.id === linkedId);
    if (!target) return;
    setSelectedId(target.id);
    setTab(target.requesterId === me ? "history" : "queue");
    if (target.requesterId !== me) setQueueFilter("all");
    const next = new URLSearchParams(params);
    next.delete("request");
    setParams(next, { replace: true });
  }, [linkedId, visible, me, params, setParams]);

  const queueRows = useMemo(() => {
    const now = Date.now();
    return queue
      .filter((r) => {
        if (queueFilter === "open") return !isClosed(r);
        if (queueFilter === "mine") return r.assigneeId === me && !isClosed(r);
        if (queueFilter === "unassigned") return !r.assigneeId && !isClosed(r);
        if (queueFilter === "overdue") return hrRequestOverdue(r, now);
        return true;
      })
      .sort((a, b) => {
        const oa = hrRequestOverdue(a, now) ? 0 : 1;
        const ob = hrRequestOverdue(b, now) ? 0 : 1;
        return oa - ob || (Date.parse(a.dueAt ?? "") || Infinity) - (Date.parse(b.dueAt ?? "") || Infinity);
      });
  }, [queue, queueFilter, me]);

  const historyRows = useMemo(() => {
    const n = historyQ.trim().toLowerCase();
    return mine.filter((r) => !n || `${r.id} ${r.subject} ${r.category} ${r.subcategory ?? ""} ${r.status}`.toLowerCase().includes(n));
  }, [mine, historyQ]);

  const sla = useMemo(() => {
    const now = Date.now();
    const open = queue.filter((r) => !isClosed(r));
    const responses = queue.map((r) => hoursBetween(r.submittedAt, r.firstResponseAt)).filter((h): h is number => h !== null);
    return {
      open: open.length,
      overdue: open.filter((r) => hrRequestOverdue(r, now)).length,
      unassigned: open.filter((r) => !r.assigneeId).length,
      avg: responses.length ? responses.reduce((s, h) => s + h, 0) / responses.length : null,
      count: responses.length,
    };
  }, [queue]);

  const rows = tab === "queue" ? queueRows : historyRows;
  const selected = rows.find((r) => r.id === selectedId) ?? visible.find((r) => r.id === selectedId) ?? null;

  const tabs = [
    ...(hrView ? [] : [{ id: "request", label: "New request" }, { id: "history", label: `Request history (${mine.length})` }]),
    ...(deskView ? [{ id: "queue", label: `Request queue (${sla.open})` }] : []),
    { id: "faq", label: "FAQ & policies" },
  ];

  return (
    <Page title="Helpdesk">
      <Tabs
        tabs={tabs}
        value={tab}
        onChange={(id) => {
          setTab(id);
          setSelectedId("");
        }}
      />

      {tab === "request" && !hrView && (
        <NewRequestForm
          onCreated={(id) => {
            setSelectedId(id);
            setTab("history");
          }}
        />
      )}

      {(tab === "history" || tab === "queue") && (
        <div className="stack">
          {tab === "queue" && (
            <>
              <MetricGrid>
                <MetricCard label="Open" value={sla.open} hint={`${sla.unassigned} unassigned`} />
                <MetricCard label="Overdue" value={sla.overdue} hint="Past SLA" />
                <MetricCard label="Avg first response" value={hoursLabel(sla.avg)} hint={sla.count ? `${sla.count} requests` : "No replies yet"} />
              </MetricGrid>
              <FilterBar>
                <div className="chip-row" role="group" aria-label="Show">
                  {(
                    [
                      ["open", "Open"],
                      ["mine", "Assigned to me"],
                      ["unassigned", "Unassigned"],
                      ["overdue", "Overdue"],
                      ["all", "All"],
                    ] as const
                  ).map(([id, label]) => (
                    <button key={id} type="button" className={queueFilter === id ? "chip-btn active" : "chip-btn"} aria-pressed={queueFilter === id} onClick={() => setQueueFilter(id)}>
                      {label}
                    </button>
                  ))}
                </div>
              </FilterBar>
            </>
          )}
          {tab === "history" && (
            <FilterBar>
              <input type="search" value={historyQ} onChange={(e) => setHistoryQ(e.target.value)} placeholder="Search requests" aria-label="Search requests" />
            </FilterBar>
          )}
          <div className={selected ? "hd-split with-detail" : "hd-split"}>
            <section className="hd-table-wrap">
              {rows.length === 0 ? (
                <EmptyState
                  title={tab === "queue" ? "Nothing in this view" : "No requests yet"}
                  action={
                    tab === "history" ? (
                      <button type="button" className="btn-ghost" onClick={() => setTab("request")}>
                        New request
                      </button>
                    ) : undefined
                  }
                />
              ) : (
                <table className="hd-table">
                  <thead>
                    <tr>
                      <th>Ticket ID</th>
                      <th>Subject</th>
                      {tab === "queue" && <th>Requester</th>}
                      <th>Assigned to</th>
                      <th>Priority</th>
                      <th>Status</th>
                      <th>SLA due</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} className={r.id === selected?.id ? "active" : undefined} onClick={() => setSelectedId(r.id)}>
                        <td>
                          <button type="button" className="quiet-link hd-id" onClick={() => setSelectedId(r.id)}>
                            {shortId(r.id)}
                          </button>
                        </td>
                        <td>
                          <strong>{r.subject}</strong>
                          <div className="muted">
                            {r.category}
                            {r.subcategory ? ` · ${r.subcategory}` : ""}
                          </div>
                        </td>
                        {tab === "queue" && <td>{r.requesterName ?? "—"}</td>}
                        <td>{r.assigneeId ? hrDeskOwnerName(r.assigneeId) : <span className="muted">Unassigned</span>}</td>
                        <td>
                          <span className={`hd-prio p-${(r.priority ?? "Normal").toLowerCase()}`}>{r.priority ?? "Normal"}</span>
                        </td>
                        <td>
                          <StatusBadge status={r.status} />
                        </td>
                        <td>
                          <SlaCell r={r} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
            {selected && <RequestDetail key={selected.id} r={selected} onClose={() => setSelectedId("")} />}
          </div>
        </div>
      )}

      {tab === "faq" && <FaqView />}
    </Page>
  );
}

function NewRequestForm({ onCreated }: { onCreated: (id: string) => void }) {
  const { employee } = usePortal();
  const [category, setCategory] = useState<HrRequestCategory>("Payroll provider");
  const [subcategory, setSubcategory] = useState(HR_REQUEST_SUBCATEGORIES["Payroll provider"][0]);
  const [priority, setPriority] = useState<HrRequestPriority>("Normal");
  const [contact, setContact] = useState<ContactPreference>("email");
  const [subject, setSubject] = useState("");
  const { value: description, setValue: setDescription, ref, fill, fillIfEmpty, reset } = useTemplatedText();
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement | null>(null);
  const action = useAction();
  const route = HR_REQUEST_SLA[category] ?? HR_REQUEST_SLA.Other;

  function addFiles(list: FileList | null) {
    if (!list) return;
    const next = [...files];
    for (const f of Array.from(list)) {
      if (fileProblem(f)) {
        setError(fileProblem(f));
        continue;
      }
      if (!next.some((x) => x.name === f.name && x.size === f.size)) next.push(f);
    }
    if (next.length > MAX_FILES) setError(`Attach up to ${MAX_FILES} files.`);
    setFiles(next.slice(0, MAX_FILES));
  }

  async function submit() {
    setError("");
    if (subject.trim().length < 3) return fail("Add a short subject (3 characters or more).");
    if (!description.trim()) return fail("Describe your request.");
    if (hasTemplateBlanks(description)) return fail(TEMPLATE_BLANKS_ERROR);
    let id: string;
    if (API_ENABLED) {
      const made = await createHrRequestApi({ category, subject, description, priority, subcategory, contactPreference: contact });
      if ("error" in made) return fail(made.error);
      id = made.id;
      const failed: string[] = [];
      for (const f of files) if (await uploadHrRequestFileApi(id, f)) failed.push(f.name);
      if (failed.length) notify(`Request raised, but ${failed.join(", ")} could not be attached. Add them from the request.`, "err");
    } else {
      id = createHrRequest({
        category,
        subject,
        description,
        author: employee.fullName,
        requesterId: employee.id,
        priority,
        subcategory,
        contactPreference: contact,
        attachments: files.map((f) => ({ name: f.name, size: f.size, at: new Date().toISOString() })),
      });
    }
    notify(`Request sent to ${hrDeskOwnerName(route.ownerId)}.`);
    setSubject("");
    setPriority("Normal");
    setFiles([]);
    reset();
    onCreated(id);
    return true;
  }

  function fail(text: string) {
    setError(text);
    return false;
  }

  return (
    <form className="hd-form" onSubmit={action.submit(submit)}>
      <div className="hd-form-grid">
        <label className="field">
          <span>Category</span>
          <select
            value={category}
            onChange={(e) => {
              const c = e.target.value as HrRequestCategory;
              setCategory(c);
              setSubcategory(HR_REQUEST_SUBCATEGORIES[c][0]);
              fill("hrRequest", c);
            }}
          >
            {HR_REQUEST_CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Subcategory</span>
          <select value={subcategory} onChange={(e) => setSubcategory(e.target.value)}>
            {HR_REQUEST_SUBCATEGORIES[category].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <fieldset className="field hd-seg">
          <legend>Priority</legend>
          <div className="hd-seg-row">
            {HR_REQUEST_PRIORITIES.map((p) => (
              <label key={p} className={priority === p ? `active p-${p.toLowerCase()}` : undefined}>
                <input type="radio" name="hd-priority" value={p} checked={priority === p} onChange={() => setPriority(p)} />
                {p}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="field hd-seg">
          <legend>Contact me by</legend>
          <div className="hd-seg-row">
            {CONTACT_PREFERENCES.map((c) => (
              <label key={c.id} className={contact === c.id ? "active" : undefined}>
                <input type="radio" name="hd-contact" value={c.id} checked={contact === c.id} onChange={() => setContact(c.id)} />
                {c.label}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="field wide">
          <span>Subject</span>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} placeholder="Short summary" />
        </label>
        <label className="field wide">
          <span>Description</span>
          <textarea
            ref={ref}
            rows={5}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onFocus={() => fillIfEmpty("hrRequest", category)}
            spellCheck
          />
        </label>
        <div className="field wide">
          <span>Attachments</span>
          <div
            className="hd-drop"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              addFiles(e.dataTransfer.files);
            }}
          >
            <button type="button" className="btn-ghost" onClick={() => fileInput.current?.click()}>
              Add files
            </button>
            <span className="muted">or drop here · PDF or images, up to {MAX_FILES} files, 5 MB each</span>
            <input ref={fileInput} type="file" multiple hidden accept={FILE_ACCEPT} onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }} />
          </div>
          {files.length > 0 && (
            <ul className="hd-files">
              {files.map((f) => (
                <li key={`${f.name}-${f.size}`}>
                  <span>📎 {f.name}</span>
                  <span className="muted">{sizeLabel(f.size)}</span>
                  <button type="button" className="btn-ghost btn-tiny" onClick={() => setFiles(files.filter((x) => x !== f))} aria-label={`Remove ${f.name}`}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <p className="hd-route">
        Goes to <strong>{hrDeskOwnerName(route.ownerId)}</strong> · SLA {route.workingDays} working {route.workingDays === 1 ? "day" : "days"}
      </p>
      {error && <Banner message={{ tone: "err", text: error }} />}
      <div className="row-gap">
        <SubmitButton action={action} className="btn">
          Submit request
        </SubmitButton>
      </div>
    </form>
  );
}

function RequestDetail({ r, onClose }: { r: HrRequest; onClose: () => void }) {
  const { employee, demoProfile } = usePortal();
  const me = employee.id;
  const actor = { id: me, role: demoProfile.role, name: employee.fullName };
  const [reply, setReply] = useState("");
  const [error, setError] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [rating, setRating] = useState(5);
  const replyAction = useAction();
  const works = worksHrRequest(r, me, demoProfile.role) || (API_ENABLED && demoProfile.role === "admin" && r.requesterId !== me);
  const statuses = allowedHrStatuses(r, me, demoProfile.role);
  const canAssign = canReassignHrRequest(r, me, demoProfile.role) || (API_ENABLED && demoProfile.role === "admin" && r.requesterId !== me);
  const canRate = API_ENABLED && r.requesterId === me && isClosed(r) && r.satisfaction === undefined;
  const conversation = r.comments.filter((c) => !c.system);
  const mineMsg = (c: HrRequest["comments"][number]) => (c.authorId ? c.authorId === me : c.author === employee.fullName);
  const overdue = hrRequestOverdue(r);

  const timeline = useMemo(() => {
    const ev: { at: string; text: string }[] = [];
    if (r.submittedAt) ev.push({ at: r.submittedAt, text: `Raised by ${r.requesterName ?? "requester"}` });
    for (const c of r.comments) if (c.system) ev.push({ at: c.at, text: c.text });
    if (r.firstResponseAt) ev.push({ at: r.firstResponseAt, text: "First response from the desk" });
    if (r.escalatedAt) ev.push({ at: r.escalatedAt, text: "Escalated" });
    if (r.satisfaction !== undefined) ev.push({ at: r.comments.at(-1)?.at ?? r.submittedAt ?? "", text: `Rated ${r.satisfaction}/5` });
    return ev.sort((a, b) => a.at.localeCompare(b.at));
  }, [r]);

  async function sendReply() {
    if (!reply.trim()) {
      setError("Write a reply.");
      return false;
    }
    const err = API_ENABLED ? await addHrCommentApi(r.id, reply) : addHrComment(r.id, employee.fullName, reply, actor);
    if (err) {
      setError(err);
      return false;
    }
    setReply("");
    setError("");
    return true;
  }

  return (
    <aside className="hd-detail" aria-label="Request details">
      <header className="hd-detail-head">
        <div>
          <span className="hd-id">{shortId(r.id)}</span>
          <h3>{r.subject}</h3>
          <div className="row-gap">
            <StatusBadge status={r.status} />
            <span className={`hd-prio p-${(r.priority ?? "Normal").toLowerCase()}`}>{r.priority ?? "Normal"}</span>
            {overdue && <StatusBadge status="Overdue" tone="danger" literal />}
          </div>
        </div>
        <button type="button" className="btn-ghost btn-tiny" onClick={onClose} aria-label="Close details">
          ×
        </button>
      </header>

      <dl className="hd-facts">
        <dt>Category</dt>
        <dd>
          {r.category}
          {r.subcategory ? ` · ${r.subcategory}` : ""}
        </dd>
        <dt>Requester</dt>
        <dd>{r.requesterName ?? "—"}</dd>
        <dt>Assigned to</dt>
        <dd>
          {canAssign ? (
            <select
              value={r.assigneeId ?? ""}
              aria-label="Assign to"
              onChange={async (e) => {
                const v = e.target.value;
                const err = API_ENABLED ? await assignHrRequestApi(r.id, v) : assignHrRequest(r.id, v, actor);
                setError(err ?? "");
                if (!err) notify(v ? `Assigned to ${hrDeskOwnerName(v)}.` : "Unassigned.");
              }}
            >
              <option value="">Unassigned</option>
              {HR_DESK_OWNERS.filter((o) => o.id !== r.requesterId).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.id === me ? `${o.name} (me)` : o.name}
                </option>
              ))}
            </select>
          ) : r.assigneeId ? (
            hrDeskOwnerName(r.assigneeId)
          ) : (
            "Unassigned"
          )}
        </dd>
        <dt>Status</dt>
        <dd>
          {statuses.length > 0 ? (
            <select
              value={r.status}
              aria-label="Status"
              onChange={async (e) => {
                const next = e.target.value as HrRequest["status"];
                const err = API_ENABLED ? await setHrRequestStatusApi(r.id, next) : setHrRequestStatus(r.id, next, actor);
                setError(err ?? "");
                if (!err) notify(`Status set to ${next}.`);
              }}
            >
              {[r.status, ...statuses].map((s) => (
                <option key={s} value={s}>
                  {r.requesterId === me && s === "In progress" && r.status !== "In progress" ? "Reopen" : s}
                </option>
              ))}
            </select>
          ) : (
            r.status
          )}
        </dd>
        {works && !API_ENABLED && (
          <>
            <dt>Priority</dt>
            <dd>
              <select
                value={r.priority ?? "Normal"}
                aria-label="Priority"
                onChange={(e) => {
                  const err = setHrRequestPriority(r.id, e.target.value as HrRequestPriority, actor);
                  setError(err ?? "");
                  if (!err) notify("Priority updated.");
                }}
              >
                {HR_REQUEST_PRIORITIES.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </dd>
          </>
        )}
        <dt>Contact by</dt>
        <dd>{CONTACT_PREFERENCES.find((c) => c.id === r.contactPreference)?.label ?? "—"}</dd>
        <dt>Submitted</dt>
        <dd>{stamp(r.submittedAt ?? r.createdAt)}</dd>
        <dt>SLA due</dt>
        <dd>
          <SlaCell r={r} />
        </dd>
        <dt>First response</dt>
        <dd>{r.firstResponseAt ? `${stamp(r.firstResponseAt)} (${hoursLabel(hoursBetween(r.submittedAt, r.firstResponseAt))})` : "Not yet"}</dd>
        {r.satisfaction !== undefined && (
          <>
            <dt>Rating</dt>
            <dd>{r.satisfaction}/5</dd>
          </>
        )}
      </dl>

      <div className="hd-detail-actions">
        {API_ENABLED && works && overdue && !r.escalatedAt && !isClosed(r) && (
          <ActionButton className="btn-ghost" busyLabel="Escalating…" doneLabel="Escalated" success="Request escalated." toastError onAction={() => escalateHrRequestApi(r.id)}>
            Escalate
          </ActionButton>
        )}
        {canRate && (
          <span className="row-gap">
            <select value={rating} onChange={(e) => setRating(Number(e.target.value))} aria-label="Rating">
              {[5, 4, 3, 2, 1].map((n) => (
                <option key={n} value={n}>
                  {n} / 5
                </option>
              ))}
            </select>
            <ActionButton className="btn-ghost" busyLabel="Sending…" doneLabel="Rated" success="Thanks for rating." toastError onAction={() => rateHrRequestApi(r.id, rating)}>
              Rate service
            </ActionButton>
          </span>
        )}
      </div>
      {error && <Banner message={{ tone: "err", text: error }} />}

      <section className="hd-block">
        <h4>Conversation</h4>
        <div className="hd-convo">
          {conversation.length === 0 ? (
            <p className="muted">No messages yet.</p>
          ) : (
            conversation.map((c, i) => (
              <div key={`${c.at}-${i}`} className={mineMsg(c) ? "hd-msg mine" : "hd-msg"}>
                <span className="hd-msg-meta">
                  {mineMsg(c) ? "You" : c.author} · {stamp(c.at)}
                </span>
                <p>{c.text}</p>
              </div>
            ))
          )}
        </div>
        {r.status !== "Closed" && (
          <form className="hd-reply" onSubmit={replyAction.submit(sendReply)}>
            <textarea rows={2} value={reply} onChange={(e) => setReply(e.target.value)} placeholder={works ? "Reply to the requester" : "Reply to the desk"} aria-label="Reply" spellCheck />
            <SubmitButton action={replyAction} className="btn">
              Send reply
            </SubmitButton>
          </form>
        )}
      </section>

      <section className="hd-block">
        <h4>Attachments</h4>
        {(r.files?.length ?? 0) + (r.attachments?.length ?? 0) === 0 ? (
          <p className="muted">No attachments.</p>
        ) : (
          <ul className="hd-files">
            {(r.files ?? []).map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  className="quiet-link"
                  onClick={async () => {
                    const err = await downloadHrRequestFileApi(r.id, f);
                    if (err) setError(err);
                  }}
                >
                  📎 {f.name}
                </button>
                <span className="muted">
                  {sizeLabel(f.size)} · {stamp(f.at)}
                </span>
              </li>
            ))}
            {(r.attachments ?? []).map((f) => (
              <li key={`${f.name}-${f.at}`}>
                <span>📎 {f.name}</span>
                <span className="muted">
                  {sizeLabel(f.size)} · {stamp(f.at)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {API_ENABLED && r.status !== "Closed" && (
          <div className="row-gap">
            <input key={fileKey} type="file" accept={FILE_ACCEPT} aria-label="Attach a file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <ActionButton
              className="btn-ghost"
              disabled={!file}
              busyLabel="Uploading…"
              doneLabel="Uploaded"
              toastError
              onAction={async () => {
                if (!file) return false;
                if (fileProblem(file)) return fileProblem(file);
                const err = await uploadHrRequestFileApi(r.id, file);
                if (err) return err;
                notify(`${file.name} attached.`);
                setFile(null);
                setFileKey((k) => k + 1);
                return null;
              }}
            >
              Upload
            </ActionButton>
          </div>
        )}
      </section>

      <section className="hd-block">
        <h4>Timeline</h4>
        <ol className="hd-timeline">
          {timeline.map((e, i) => (
            <li key={`${e.at}-${i}`}>
              <span className="muted">{stamp(e.at)}</span>
              <span>{e.text}</span>
            </li>
          ))}
          {!isClosed(r) && r.dueAt && (
            <li className={overdue ? "due overdue" : "due"}>
              <span className="muted">{stamp(r.dueAt)}</span>
              <span>{overdue ? "SLA missed" : "SLA due"}</span>
            </li>
          )}
        </ol>
      </section>
    </aside>
  );
}

function FaqView() {
  const { employee } = usePortal();
  const votes = useFaqVotes(employee.id);
  const [q, setQ] = useState("");
  const [topic, setTopic] = useState("");
  const [openId, setOpenId] = useState("");
  const topics = [...new Set(HELP_FAQ.map((f) => f.topic))].sort();
  const n = q.trim().toLowerCase();
  const faqs = HELP_FAQ.filter((f) => (!topic || f.topic === topic) && (!n || `${f.question} ${f.answer} ${f.topic}`.toLowerCase().includes(n)));
  const policies = POLICY_SHORTCUTS.filter((p) => (!topic || p.topic === topic) && (!n || `${p.label} ${p.topic}`.toLowerCase().includes(n)));

  return (
    <div className="hd-faq">
      <div className="hd-faq-bar">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search FAQ and policies" aria-label="Search FAQ and policies" />
        <div className="chip-row" role="group" aria-label="Category">
          <button type="button" className={!topic ? "chip-btn active" : "chip-btn"} onClick={() => setTopic("")}>
            All
          </button>
          {topics.map((t) => (
            <button key={t} type="button" className={topic === t ? "chip-btn active" : "chip-btn"} aria-pressed={topic === t} onClick={() => setTopic(t)}>
              {t}
            </button>
          ))}
        </div>
      </div>
      <div className="hd-faq-grid">
        <section>
          <h3 className="hd-h">Frequently asked questions</h3>
          {faqs.length === 0 ? (
            <EmptyState title="No matches" />
          ) : (
            <ul className="hd-faq-list">
              {faqs.map((f) => {
                const v = votes[f.id];
                const open = openId === f.id || !!n;
                return (
                  <li key={f.id} className={open ? "open" : undefined}>
                    <button type="button" className="hd-faq-q" aria-expanded={open} onClick={() => setOpenId(open && !n ? "" : f.id)}>
                      <span>{f.question}</span>
                      <span className="hd-faq-topic">{f.topic}</span>
                    </button>
                    {open && (
                      <div className="hd-faq-a">
                        <p>{f.answer}</p>
                        {f.policyLink && (
                          <Link to={f.policyLink} className="quiet-link">
                            Open related page
                          </Link>
                        )}
                        <div className="hd-vote">
                          <span className="muted">Was this helpful?</span>
                          <ActionButton
                            className={v?.mine === true ? "btn btn-tiny" : "btn-ghost btn-tiny"}
                            busyLabel="Saving…"
                            doneLabel="Thanks"
                            toastError
                            aria-pressed={v?.mine === true}
                            onAction={() => voteFaq(f.id, true, employee.id)}
                          >
                            👍 Helpful{v?.helpful ? ` · ${v.helpful}` : ""}
                          </ActionButton>
                          <ActionButton
                            className={v?.mine === false ? "btn btn-tiny" : "btn-ghost btn-tiny"}
                            busyLabel="Saving…"
                            doneLabel="Thanks"
                            toastError
                            aria-pressed={v?.mine === false}
                            onAction={() => voteFaq(f.id, false, employee.id)}
                          >
                            👎 Not helpful{v?.notHelpful ? ` · ${v.notHelpful}` : ""}
                          </ActionButton>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <section>
          <h3 className="hd-h">Policies</h3>
          {policies.length === 0 ? (
            <p className="muted">No policies match.</p>
          ) : (
            <ul className="hd-policies">
              {policies.map((p) => (
                <li key={p.label}>
                  <Link to={p.to}>{p.label}</Link>
                  <span className="muted">{p.topic}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
