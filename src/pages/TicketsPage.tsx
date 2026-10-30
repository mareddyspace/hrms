import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ActionButton,
  Banner,
  Card,
  EmptyState,
  Field,
  FilterBar,
  Page,
  StatusBadge,
  SubmitButton,
  notify,
  useAction,
} from "../components/ui.tsx";
import { formatShortDate, todayISO } from "../model.ts";
import { usePortal } from "../store.tsx";
import { taskTeamFor } from "../data/taskTeam.ts";
import { managementChain } from "../demoAccounts.ts";
import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_TYPES,
  assignTicket,
  canViewTicket,
  ticketViewCounts,
  commentOnTicket,
  createTicket,
  isOpenTicket,
  nextStatuses,
  addTicketTask,
  canPlanTicket,
  deadlineLabel,
  removeTicketTask,
  setTicketDue,
  setTicketSubOwner,
  toggleTicketTask,
  personName,
  refreshTickets,
  setTicketStatus,
  toggleWatch,
  useTickets,
  type Ticket,
  type TicketActor,
  type TicketPriority,
  type TicketStatus,
  type TicketType,
} from "../data/ticketStore.ts";
import "./tickets.css";

type View = "mine" | "assigned" | "team";

const STATUS_TONE: Record<TicketStatus, "ok" | "warn" | "danger" | "info" | "neutral"> = {
  Open: "info",
  "In progress": "warn",
  Waiting: "neutral",
  Resolved: "ok",
  Closed: "neutral",
};

function stampLabel(iso: string): string {
  const d = new Date(iso);
  return `${formatShortDate(iso.slice(0, 10))}, ${d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}`;
}

export function TicketsPage() {
  const { employee, isManager: isManagerRole, currentProjects } = usePortal();
  const tickets = useTickets();
  const actor: TicketActor = { id: employee.id, fullName: employee.fullName, role: employee.role };
  const team = useMemo(() => taskTeamFor(employee.id), [employee.id]);
  // No "Team" view for someone with nobody below them.
  const isManager = isManagerRole && team.length > 0;
  const teamIds = useMemo(() => new Set(team.map((p) => p.id)), [team]);
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("id") ?? "";
  const [view, setView] = useState<View>(() => "assigned");
  const [status, setStatus] = useState<"active" | "all" | TicketStatus>("active");
  const [type, setType] = useState<"all" | TicketType>("all");
  const [priority, setPriority] = useState<"all" | TicketPriority>("all");
  const [query, setQuery] = useState("");
  const [when, setWhen] = useState<"any" | "today" | "week" | "month" | "pick" | "range">("any");
  const [month, setMonth] = useState(() => todayISO().slice(0, 7));
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  // Backend mode: pick up other people's changes when the page opens, when the tab comes back, and every 30 seconds.
  useEffect(() => {
    void refreshTickets();
    const onFocus = () => void refreshTickets();
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshTickets();
    }, 30_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, []);

  const visible = tickets.filter((t) => canViewTicket(t, actor));
  const counts = ticketViewCounts(actor, tickets, teamIds);
  // Open on the first tab with something in it (managers: Team first when it has open tickets), once tickets load.
  const picked = useRef(false);
  useEffect(() => {
    if (picked.current || tickets.length === 0) return;
    picked.current = true;
    const order: View[] = isManager ? ["assigned", "team", "mine"] : ["assigned", "mine"];
    setView(order.find((v) => counts[v] > 0) ?? "assigned");
  }, [tickets.length, isManager, counts]);

  const rows = visible
    .filter((t) =>
      view === "mine"
        ? t.requesterId === employee.id
        : view === "assigned"
          ? t.assigneeId === employee.id
          : teamIds.has(t.requesterId) || (!!t.assigneeId && teamIds.has(t.assigneeId)),
    )
    .filter((t) => (status === "all" ? true : status === "active" ? t.status !== "Closed" : t.status === status))
    .filter((t) => type === "all" || t.type === type)
    .filter((t) => priority === "all" || t.priority === priority)
    .filter((t) => inPeriod(t.createdAt.slice(0, 10), when, month, from, to))
    .filter((t) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return `${t.id} ${t.title} ${t.projectName ?? ""} ${personName(t.requesterId)} ${personName(t.assigneeId)}`
        .toLowerCase()
        .includes(q);
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const selected = visible.find((t) => t.id === selectedId);

  function select(id: string | null) {
    const next = new URLSearchParams(params);
    if (id) next.set("id", id);
    else next.delete("id");
    setParams(next, { replace: true });
  }

  function done(error: string | null, ok: string) {
    setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: ok });
    if (!error) notify(ok);
    return error;
  }

  return (
    <Page
      title="Tickets"
      action={
        <button className="btn" type="button" onClick={() => setCreateOpen(true)}>
          Raise ticket
        </button>
      }
    >
      <div className="ts-tabs" role="tablist" aria-label="Ticket views">
        {(
          [
            ["assigned", `Assigned to me (${counts.assigned})`],
            ["mine", `My tickets (${counts.mine})`],
            ...(isManager ? ([["team", `Team (${counts.team})`]] as const) : []),
          ] as [View, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={view === id}
            className={view === id ? "active" : undefined}
            onClick={() => setView(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <FilterBar>
        <input
          className="tk-search"
          placeholder="Search tickets"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search tickets"
        />
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Status">
          <option value="active">Not closed</option>
          <option value="all">All statuses</option>
          {TICKET_STATUSES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select value={type} onChange={(e) => setType(e.target.value as typeof type)} aria-label="Type">
          <option value="all">All types</option>
          {TICKET_TYPES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)} aria-label="Priority">
          <option value="all">All priorities</option>
          {TICKET_PRIORITIES.map((s) => (
            <option key={s} value={s}>
              {s[0].toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>
        <select value={when} onChange={(e) => setWhen(e.target.value as typeof when)} aria-label="Raised">
          <option value="any">Any date</option>
          <option value="today">Today</option>
          <option value="week">Last 7 days</option>
          <option value="month">This month</option>
          <option value="pick">Pick a month</option>
          <option value="range">Date range</option>
        </select>
        {when === "pick" && (
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month" />
        )}
        {when === "range" && (
          <>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
            <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label="To" />
          </>
        )}
      </FilterBar>

      <Banner message={message} />

      <div className={selected ? "tk-layout with-detail" : "tk-layout"}>
        <Card>
          {rows.length === 0 ? (
            <EmptyState title="No tickets here" description="Change the filters or raise a ticket." />
          ) : (
            <ul className="tk-list">
              {rows.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    className={t.id === selectedId ? "tk-row active" : "tk-row"}
                    onClick={() => select(t.id)}
                  >
                    <span className="tk-row-top">
                      <code>{t.id}</code>
                      <span className={`tk-prio ${t.priority}`}>{t.priority}</span>
                      <StatusBadge status={t.status} tone={STATUS_TONE[t.status]} literal />
                    </span>
                    <strong>{t.title}</strong>
                    <span className="muted">
                      {t.type}
                      {t.projectName ? ` · ${t.projectName}` : ""} · {personName(t.assigneeId)}
                      {t.subOwnerId ? ` + ${personName(t.subOwnerId)}` : ""}
                      {t.due ? ` · due ${formatShortDate(t.due)}${isOpenTicket(t) ? ` (${deadlineLabel(t.due, todayISO())})` : ""}` : ""}
                      {t.tasks?.length ? ` · tasks ${t.tasks.filter((k) => k.done).length}/${t.tasks.length}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {selected && (
          <TicketDetail
            key={selected.id}
            ticket={selected}
            actor={actor}
            team={team}
            onClose={() => select(null)}
            onResult={done}
          />
        )}
      </div>

      {createOpen && (
        <CreateTicketDialog
          actor={actor}
          team={isManager ? team : []}
          projects={currentProjects.map((p) => ({ id: p.id, name: p.name }))}
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            setView("mine");
            select(id);
            done(null, `${id} raised.`);
          }}
        />
      )}
    </Page>
  );
}

function TicketDetail({
  ticket: t,
  actor,
  team,
  onClose,
  onResult,
}: {
  ticket: Ticket;
  actor: TicketActor;
  team: { id: string; fullName: string }[];
  onClose: () => void;
  onResult: (error: string | null, ok: string) => string | null;
}) {
  const [note, setNote] = useState("");
  const [assignee, setAssignee] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskOwner, setTaskOwner] = useState("");
  const [taskDue, setTaskDue] = useState("");
  const canPlan = canPlanTicket(t, actor);
  const tasks = t.tasks ?? [];
  const doneCount = tasks.filter((k) => k.done).length;
  // People who can be sub-owner or own a task: the team, the people on the ticket, and me.
  const people = [
    ...new Map(
      [
        ...team,
        ...[t.assigneeId, t.subOwnerId, t.requesterId, actor.id]
          .filter((id): id is string => !!id)
          .map((id) => ({ id, fullName: personName(id) })),
      ].map((p) => [p.id, p] as const),
    ).values(),
  ];
  const moves = nextStatuses(t, actor);
  const canAssign = isOpenTicket(t) && team.length > 0;
  const overdue = t.due && isOpenTicket(t) && t.due < todayISO();
  const isMineToWork = t.assigneeId === actor.id && isOpenTicket(t);
  const watching = t.watcherIds.includes(actor.id);
  const managerOfAssignee = t.assigneeId ? managementChain(t.assigneeId)[0]?.fullName : undefined;

  return (
    <Card
      className="tk-detail"
      title={t.id}
      action={
        <button className="btn-ghost btn-tiny" type="button" onClick={onClose} aria-label="Close ticket">
          ×
        </button>
      }
    >
      <h3 className="tk-title">{t.title}</h3>
      <div className="tk-chips">
        <StatusBadge status={t.status} tone={STATUS_TONE[t.status]} literal />
        <span className={`tk-prio ${t.priority}`}>{t.priority}</span>
        <span className="tk-chip">{t.type}</span>
      </div>
      {t.description && <p className="tk-desc">{t.description}</p>}

      <dl className="tk-facts">
        <dt>Project</dt>
        <dd>{t.projectName ?? "—"}</dd>
        <dt>Requester</dt>
        <dd>{personName(t.requesterId)}</dd>
        <dt>Owner</dt>
        <dd>
          {personName(t.assigneeId)}
          {managerOfAssignee && <span className="muted"> · reports to {managerOfAssignee}</span>}
        </dd>
        <dt>Sub-owner</dt>
        <dd>
          {canPlan ? (
            <select
              className="tk-mini"
              value={t.subOwnerId ?? ""}
              aria-label="Sub-owner"
              onChange={async (e) => onResult(await setTicketSubOwner(t.id, e.target.value, actor), "Sub-owner updated.")}
            >
              <option value="">None</option>
              {people
                .filter((p) => p.id !== t.assigneeId)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.fullName}
                  </option>
                ))}
            </select>
          ) : (
            personName(t.subOwnerId)
          )}
        </dd>
        <dt>Watchers</dt>
        <dd>{t.watcherIds.length ? t.watcherIds.map(personName).join(", ") : "—"}</dd>
        <dt>Deadline</dt>
        <dd className={overdue ? "tk-overdue" : undefined}>
          {canPlan ? (
            <input
              className="tk-mini"
              type="date"
              value={t.due ?? ""}
              aria-label="Deadline"
              onChange={async (e) => onResult(await setTicketDue(t.id, e.target.value, actor), e.target.value ? "Deadline updated." : "Deadline removed.")}
            />
          ) : t.due ? (
            formatShortDate(t.due)
          ) : (
            "—"
          )}
          {t.due && isOpenTicket(t) && <span className="muted"> · {deadlineLabel(t.due, todayISO())}</span>}
        </dd>
        <dt>Tasks</dt>
        <dd>{tasks.length ? `${doneCount} of ${tasks.length} done` : "—"}</dd>
        <dt>Created</dt>
        <dd>{stampLabel(t.createdAt)}</dd>
        <dt>Updated</dt>
        <dd>{stampLabel(t.updatedAt)}</dd>
      </dl>

      <section className="tk-tasks" aria-label="Tasks">
        <h4>Tasks</h4>
        {tasks.length > 0 && (
          <div className="tk-task-bar" aria-hidden="true">
            <span style={{ width: `${Math.round((doneCount / tasks.length) * 100)}%` }} />
          </div>
        )}
        {tasks.length === 0 ? (
          <p className="muted">No tasks yet.</p>
        ) : (
          <ul className="tk-task-list">
            {tasks.map((k) => {
              const late = !k.done && !!k.due && k.due < todayISO();
              const canTick = isOpenTicket(t) && (k.ownerId === actor.id || canPlan);
              return (
                <li key={k.id} className={k.done ? "done" : undefined}>
                  <input
                    type="checkbox"
                    checked={k.done}
                    disabled={!canTick}
                    aria-label={`Mark "${k.title}" done`}
                    onChange={async () => onResult(await toggleTicketTask(t.id, k.id, actor), k.done ? "Task reopened." : "Task done.")}
                  />
                  <span className="tk-task-title">{k.title}</span>
                  <span className="muted">{k.ownerId ? personName(k.ownerId) : "No owner"}</span>
                  <span className={late ? "tk-overdue" : "muted"}>
                    {k.due ? `${formatShortDate(k.due)}${late ? " · overdue" : ""}` : "No date"}
                  </span>
                  {canPlan ? (
                    <button
                      type="button"
                      className="btn-ghost btn-tiny"
                      aria-label={`Remove "${k.title}"`}
                      onClick={async () => onResult(await removeTicketTask(t.id, k.id, actor), "Task removed.")}
                    >
                      ×
                    </button>
                  ) : (
                    <span />
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {canPlan && (
          <div className="tk-task-add">
            <input value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} placeholder="New task" aria-label="New task" />
            <select value={taskOwner} onChange={(e) => setTaskOwner(e.target.value)} aria-label="Task owner">
              <option value="">Owner…</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.fullName}
                </option>
              ))}
            </select>
            <input
              type="date"
              value={taskDue}
              min={todayISO()}
              max={t.due || undefined}
              onChange={(e) => setTaskDue(e.target.value)}
              aria-label="Task deadline"
            />
            <ActionButton
              className="btn btn-tiny"
              disabled={!taskTitle.trim()}
              busyLabel="Adding…"
              doneLabel="Added"
              onAction={async () => {
                const error = await addTicketTask(t.id, { title: taskTitle, ownerId: taskOwner, due: taskDue }, actor);
                onResult(error, "Task added.");
                if (!error) {
                  setTaskTitle("");
                  setTaskOwner("");
                  setTaskDue("");
                }
                return error;
              }}
            >
              Add
            </ActionButton>
          </div>
        )}
      </section>

      <div className="form-actions tk-actions">
        {isMineToWork && (
          <Link className="btn" to={`/timesheet?work=ticket:${t.id}`}>
            Log time
          </Link>
        )}
        <ActionButton
          className="btn-ghost btn-tiny"
          busyLabel="Saving…"
          doneLabel={watching ? "Watching" : "Stopped"}
          onAction={async () => {
            const error = await toggleWatch(t.id, actor.id, actor);
            onResult(error, watching ? "Stopped watching." : "Watching.");
            return error;
          }}
        >
          {watching ? "Unwatch" : "Watch"}
        </ActionButton>
      </div>

      {canAssign && (
        <div className="tk-inline">
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Assign to">
            <option value="">Assign to…</option>
            {team
              .filter((p) => p.id !== t.assigneeId)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.fullName}
                </option>
              ))}
          </select>
          <ActionButton
            className="btn-ghost btn-tiny"
            disabled={!assignee}
            busyLabel="Assigning…"
            doneLabel="Assigned"
            onAction={async () => {
              const error = await assignTicket(t.id, assignee, actor);
              onResult(error, `Assigned to ${personName(assignee)}.`);
              if (!error) setAssignee("");
              return error;
            }}
          >
            Assign
          </ActionButton>
        </div>
      )}

      <Field label={moves.length ? "Note or comment" : "Comment"}>
        <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add an update" />
      </Field>
      <div className="form-actions tk-actions">
        <ActionButton
          className="btn-ghost btn-tiny"
          disabled={!note.trim()}
          busyLabel="Posting…"
          doneLabel="Posted"
          onAction={async () => {
            const error = await commentOnTicket(t.id, note, actor);
            onResult(error, "Comment added.");
            if (!error) setNote("");
            return error;
          }}
        >
          Comment
        </ActionButton>
        {moves.map((s) => (
          <ActionButton
            key={s}
            className={s === "Resolved" || s === "Closed" ? "btn btn-tiny" : "btn-ghost btn-tiny"}
            busyLabel="Updating…"
            doneLabel="Updated"
            onAction={async () => {
              const error = await setTicketStatus(t.id, s, actor, note);
              onResult(error, `${t.id} → ${s}.`);
              if (!error) setNote("");
              return error;
            }}
          >
            {s === "In progress" && t.status === "Resolved" ? "Reopen" : s === "Closed" ? "Close" : s === "Resolved" ? "Resolve" : s}
          </ActionButton>
        ))}
      </div>
      {t.requesterId === actor.id && t.status === "Resolved" && <p className="muted">Resolved. Close it, or reopen if not fixed.</p>}

      <h4 className="tk-sub">Activity</h4>
      <ol className="tk-activity">
        {[...t.activity].reverse().map((e) => (
          <li key={e.id} className={e.kind}>
            <span>
              <strong>{personName(e.byId)}</strong> · {stampLabel(e.at)}
            </span>
            <p>{e.text}</p>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function CreateTicketDialog({
  actor,
  team,
  projects,
  onClose,
  onCreated,
}: {
  actor: TicketActor;
  team: { id: string; fullName: string }[];
  projects: { id: string; name: string }[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<TicketType>("IT support");
  const [priority, setPriority] = useState<TicketPriority>("medium");
  const [projectId, setProjectId] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [due, setDue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const raiseAction = useAction();

  async function submit() {
    const result = await createTicket(
      {
        title,
        description,
        type,
        priority,
        projectId,
        projectName: projects.find((p) => p.id === projectId)?.name,
        assigneeId,
        due,
      },
      actor,
    );
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    onCreated(result.id);
    return true;
  }

  const routed = type === "IT support" || type === "Access request" ? "IT desk" : type === "HR query" ? "HR" : null;

  return (
    <div className="modal-root" role="presentation">
      <button className="modal-scrim" type="button" aria-label="Close" onClick={onClose} />
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="new-ticket-title">
        <h2 id="new-ticket-title">Raise ticket</h2>
        <form onSubmit={raiseAction.submit(submit)}>
          <div className="stack" style={{ marginTop: 12 }}>
            <Field label="Title">
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What's wrong?" />
            </Field>
            <Field label="Type">
              <select value={type} onChange={(e) => setType(e.target.value as TicketType)}>
                {TICKET_TYPES.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </Field>
            <Field label="Priority">
              <select value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority)}>
                {TICKET_PRIORITIES.map((s) => (
                  <option key={s} value={s}>
                    {s[0].toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Project (optional)">
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">None</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            {team.length > 0 && (
              <Field label="Assign to (optional)">
                <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
                  <option value="">{routed ? `Route to ${routed}` : "Leave unassigned"}</option>
                  {team.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.fullName}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Due date (optional)">
              <input type="date" value={due} min={todayISO()} onChange={(e) => setDue(e.target.value)} />
            </Field>
            <Field label="Details">
              <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
            {routed && !assigneeId && <p className="muted">Goes to the {routed}.</p>}
            {error && <Banner message={{ tone: "err", text: error }} />}
          </div>
          <div className="form-actions">
            <button className="btn-ghost" type="button" onClick={onClose}>
              Cancel
            </button>
            <SubmitButton action={raiseAction} className="btn">
              Raise
            </SubmitButton>
          </div>
        </form>
      </div>
    </div>
  );
}

/** True when a ticket raised on `day` (YYYY-MM-DD) falls in the chosen period. */
function inPeriod(day: string, when: string, month: string, from: string, to: string): boolean {
  const today = todayISO();
  if (when === "today") return day === today;
  if (when === "week") {
    const start = new Date(`${today}T00:00:00`);
    start.setDate(start.getDate() - 6);
    return day >= start.toLocaleDateString("en-CA") && day <= today;
  }
  if (when === "month") return day.slice(0, 7) === today.slice(0, 7);
  if (when === "pick") return !month || day.slice(0, 7) === month;
  if (when === "range") return (!from || day >= from) && (!to || day <= to);
  return true;
}
