import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ActionButton, Banner, EmptyState, LoadingState, Page, notify } from "../components/ui.tsx";
import { formatShortDate, formatStamp, todayISO } from "../model.ts";
import { usePortal } from "../store.tsx";
import { TASK_TEAM, taskTeamFor } from "../data/taskTeam.ts";
import {
  SLA_HOURS,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_TYPES,
  addTicketTask,
  assignTicket,
  canPlanTicket,
  canTakeTicket,
  canViewTicket,
  commentOnTicket,
  createTicket,
  isOpenTicket,
  nextStatuses,
  personName,
  refreshTickets,
  removeTicketTask,
  setTicketDue,
  setTicketPriority,
  setTicketStatus,
  setTicketSubOwner,
  ticketTarget,
  ticketsLoadError,
  ticketsLoaded,
  toggleTicketTask,
  toggleWatch,
  useTickets,
  type Ticket,
  type TicketActor,
  type TicketPriority,
  type TicketStatus,
  type TicketType,
} from "../data/ticketStore.ts";
import { Avatar, Drawer, PriorityChip, WorkSwitch, dayGap, dueText } from "./workParts.tsx";

type View = "assigned" | "mine" | "watching" | "team" | "all";
type Layout = "list" | "board";
type SortKey = "updated" | "target" | "priority";
type Focus = "" | "Open" | "In progress" | "Waiting" | "late" | "unassigned" | "Resolved";

const PRIORITY_RANK: Record<TicketPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const DOT: Record<TicketStatus, string> = {
  Open: "s-todo",
  "In progress": "s-progress",
  Waiting: "s-wait",
  Resolved: "s-review",
  Closed: "s-done",
};
const STATUS_WORD: Record<TicketStatus, string> = {
  Open: "Open",
  "In progress": "In progress",
  Waiting: "On hold",
  Resolved: "Resolved",
  Closed: "Closed",
};
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** The button label for moving a ticket to a status (from where it is now). */
function moveLabel(t: Ticket, s: TicketStatus, actorId: string): string {
  if (s === "In progress") return t.status === "Resolved" ? "Reopen" : t.status === "Waiting" ? "Resume" : "Start work";
  if (s === "Waiting") return "Put on hold";
  if (s === "Resolved") return "Resolve";
  if (s === "Closed") return t.status === "Open" && t.requesterId === actorId ? "Withdraw" : "Close";
  return s;
}

function targetChip(t: Ticket, today: string) {
  const target = ticketTarget(t);
  if (!isOpenTicket(t)) return <span className="wk-chip met">{t.status}</span>;
  const cls = target.state === "late" ? "late" : target.state === "soon" ? "soon" : "";
  return (
    <span className={`wk-chip ${cls}`} title={target.source === "sla" ? `${t.priority} priority target` : "Deadline"}>
      {target.source === "sla" ? "SLA " : ""}
      {dueText(target.date, today, formatShortDate)}
    </span>
  );
}

export function TicketsPage() {
  const { employee, currentProjects } = usePortal();
  const tickets = useTickets();
  const actor: TicketActor = { id: employee.id, fullName: employee.fullName, role: employee.role };
  const team = useMemo(() => taskTeamFor(employee.id), [employee.id]);
  const teamIds = useMemo(() => new Set(team.map((p) => p.id)), [team]);
  const hasTeam = team.length > 0;
  const today = todayISO();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("id") ?? "";
  const [view, setView] = useState<View>("assigned");
  const [layout, setLayout] = useState<Layout>("list");
  const [focus, setFocus] = useState<Focus>("");
  const [status, setStatus] = useState<"active" | "all" | TicketStatus>("active");
  const [type, setType] = useState<"" | TicketType>("");
  const [priority, setPriority] = useState<"" | TicketPriority>("");
  const [project, setProject] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("target");
  const [createOpen, setCreateOpen] = useState(false);
  const [dragOver, setDragOver] = useState("");
  const [resolveHint, setResolveHint] = useState<TicketStatus | "">("");

  // Backend mode: pick up other people's changes on open, on focus and every 30 seconds.
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
  const inView = (t: Ticket, v: View): boolean => {
    if (v === "assigned") return t.assigneeId === employee.id || t.subOwnerId === employee.id;
    if (v === "mine") return t.requesterId === employee.id;
    if (v === "watching") return t.watcherIds.includes(employee.id);
    if (v === "team") return teamIds.has(t.requesterId) || (!!t.assigneeId && teamIds.has(t.assigneeId));
    return true;
  };
  const counts = (v: View) => visible.filter((t) => inView(t, v) && isOpenTicket(t)).length;
  const views: [View, string][] = [
    ["assigned", "Assigned to me"],
    ["mine", "Raised by me"],
    ["watching", "Watching"],
    ...(hasTeam ? ([["team", "My team"]] as [View, string][]) : []),
    ["all", "All"],
  ];

  // Open on the first view with open tickets in it, once tickets load.
  const picked = useRef(false);
  useEffect(() => {
    if (picked.current || tickets.length === 0) return;
    picked.current = true;
    const order: View[] = hasTeam ? ["assigned", "team", "mine", "all"] : ["assigned", "mine", "all"];
    setView(order.find((v) => counts(v) > 0) ?? "all");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickets.length, hasTeam]);

  const viewRows = visible.filter((t) => inView(t, view));
  const openRows = viewRows.filter(isOpenTicket);
  const stats = {
    Open: openRows.filter((t) => t.status === "Open").length,
    "In progress": openRows.filter((t) => t.status === "In progress").length,
    Waiting: openRows.filter((t) => t.status === "Waiting").length,
    late: openRows.filter((t) => ticketTarget(t).state === "late").length,
    unassigned: openRows.filter((t) => !t.assigneeId).length,
    Resolved: viewRows.filter((t) => t.status === "Resolved").length,
  };
  const projectNames = [...new Set(viewRows.map((t) => t.projectName).filter((x): x is string => !!x))].sort();

  const rows = viewRows
    .filter((t) => {
      if (layout === "list") {
        if (status === "active" && t.status === "Closed") return false;
        if (status !== "active" && status !== "all" && t.status !== status) return false;
      }
      if (focus === "late" && ticketTarget(t).state !== "late") return false;
      if (focus === "unassigned" && (t.assigneeId || !isOpenTicket(t))) return false;
      if (focus && focus !== "late" && focus !== "unassigned" && t.status !== focus) return false;
      if (type && t.type !== type) return false;
      if (priority && t.priority !== priority) return false;
      if (project && t.projectName !== project) return false;
      const q = query.trim().toLowerCase();
      if (q && !`${t.id} ${t.title} ${t.projectName ?? ""} ${personName(t.requesterId)} ${personName(t.assigneeId)}`.toLowerCase().includes(q)) return false;
      return true;
    })
    .sort((a, b) => {
      if (sort === "updated") return b.updatedAt.localeCompare(a.updatedAt);
      if (sort === "priority") return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.updatedAt.localeCompare(a.updatedAt);
      const open = Number(isOpenTicket(b)) - Number(isOpenTicket(a));
      return open || ticketTarget(a).date.localeCompare(ticketTarget(b).date) || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    });

  const selected = visible.find((t) => t.id === selectedId);
  const filtersOn = !!(focus || type || priority || project || query);
  const clearFilters = () => {
    setFocus("");
    setType("");
    setPriority("");
    setProject("");
    setQuery("");
  };

  function select(id: string | null, hint: TicketStatus | "" = "") {
    const next = new URLSearchParams(params);
    if (id) next.set("id", id);
    else next.delete("id");
    setResolveHint(hint);
    setParams(next, { replace: true });
  }

  async function dropOn(s: TicketStatus, id: string) {
    const t = visible.find((x) => x.id === id);
    if (!t || t.status === s) return;
    if (!nextStatuses(t, actor).includes(s)) {
      notify(`${t.id} can't move to ${STATUS_WORD[s]} from here.`, "err");
      return;
    }
    if (s === "Resolved") {
      select(t.id, "Resolved"); // needs a resolution note
      return;
    }
    const error = await setTicketStatus(t.id, s, actor);
    if (error) notify(error, "err");
    else notify(`${t.id} → ${STATUS_WORD[s]}.`);
  }

  const statTiles: [Focus, string, number, string][] = [
    ["Open", "Open", stats.Open, ""],
    ["In progress", "In progress", stats["In progress"], "active"],
    ["Waiting", "On hold", stats.Waiting, "wait"],
    ["late", "Past target", stats.late, "late"],
    ...(stats.unassigned ? ([["unassigned", "Unassigned", stats.unassigned, "soon"]] as [Focus, string, number, string][]) : []),
    ["Resolved", "Resolved", stats.Resolved, "done"],
  ];

  return (
    <Page
      title="Tickets"
      action={
        <button className="btn" type="button" onClick={() => setCreateOpen(true)}>
          Raise ticket
        </button>
      }
    >
      <WorkSwitch />

      <div className="wk-tabs" role="tablist" aria-label="Ticket views">
        {views.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={view === id}
            className={view === id ? "on" : undefined}
            onClick={() => {
              setView(id);
              setFocus("");
            }}
          >
            {label}
            <span className="wk-count">{counts(id)}</span>
          </button>
        ))}
      </div>

      <div className="wk-stats" role="group" aria-label="Ticket totals">
        {statTiles.map(([key, label, value, tone]) => (
          <button
            key={key}
            type="button"
            className={`wk-stat ${tone}${focus === key ? " on" : ""}`}
            aria-pressed={focus === key}
            onClick={() => {
              setFocus(focus === key ? "" : key);
              if (key === "Resolved") setStatus("all");
            }}
          >
            <b>{value}</b>
            <span>{label}</span>
          </button>
        ))}
      </div>

      <div className="wk-toolbar">
        <input type="search" placeholder="Search tickets" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search tickets" />
        {layout === "list" && (
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Status">
            <option value="active">Not closed</option>
            <option value="all">All statuses</option>
            {TICKET_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_WORD[s]}
              </option>
            ))}
          </select>
        )}
        <select value={type} onChange={(e) => setType(e.target.value as "" | TicketType)} aria-label="Category">
          <option value="">All categories</option>
          {TICKET_TYPES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select value={priority} onChange={(e) => setPriority(e.target.value as "" | TicketPriority)} aria-label="Priority">
          <option value="">Any priority</option>
          {TICKET_PRIORITIES.map((s) => (
            <option key={s} value={s}>
              {cap(s)}
            </option>
          ))}
        </select>
        {projectNames.length > 0 && (
          <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
            <option value="">All projects</option>
            {projectNames.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        )}
        {layout === "list" && (
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort">
            <option value="target">By target date</option>
            <option value="priority">By priority</option>
            <option value="updated">Recently updated</option>
          </select>
        )}
        {filtersOn && (
          <button type="button" className="btn-ghost btn-tiny wk-clear" onClick={clearFilters}>
            Clear
          </button>
        )}
        <span className="wk-spacer" />
        <div className="wk-seg" role="group" aria-label="Layout">
          {(["list", "board"] as Layout[]).map((l) => (
            <button key={l} type="button" className={layout === l ? "on" : undefined} aria-pressed={layout === l} onClick={() => setLayout(l)}>
              {cap(l)}
            </button>
          ))}
        </div>
      </div>

      {!ticketsLoaded() ? (
        <div className="wk-list">
          {ticketsLoadError() ? (
            <EmptyState
              title="Tickets could not load"
              description={ticketsLoadError() ?? undefined}
              action={
                <ActionButton className="btn-ghost" onAction={() => refreshTickets().then(() => ticketsLoadError())}>
                  Retry
                </ActionButton>
              }
            />
          ) : (
            <LoadingState label="Loading tickets…" />
          )}
        </div>
      ) : layout === "list" ? (
        rows.length === 0 ? (
          <div className="wk-list">
            <EmptyState
              title={filtersOn ? "No tickets match" : "No tickets here"}
              action={
                filtersOn ? (
                  <button type="button" className="btn-ghost" onClick={clearFilters}>
                    Clear filters
                  </button>
                ) : (
                  <button type="button" className="btn-ghost" onClick={() => setCreateOpen(true)}>
                    Raise ticket
                  </button>
                )
              }
            />
          </div>
        ) : (
          <div className="wk-list">
            <ul className="wk-rows">
              {rows.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    className={`wk-row p-${t.priority}${t.id === selectedId ? " on" : ""}${t.status === "Closed" ? " is-done" : ""}`}
                    onClick={() => select(t.id)}
                  >
                    <span className={`wk-dot ${DOT[t.status]}`} title={STATUS_WORD[t.status]} />
                    <span className="wk-main">
                      <span className="wk-title">{t.title}</span>
                      <span className="wk-meta">
                        <code>{t.id}</code>
                        <span>{STATUS_WORD[t.status]}</span>
                        <span>{t.type}</span>
                        {t.projectName && <span>{t.projectName}</span>}
                        <span>by {personName(t.requesterId)}</span>
                        {t.tasks?.length ? (
                          <span>
                            ☑ {t.tasks.filter((k) => k.done).length}/{t.tasks.length}
                          </span>
                        ) : null}
                      </span>
                    </span>
                    <span className="wk-who">
                      <Avatar name={t.assigneeId ? personName(t.assigneeId) : undefined} none={!t.assigneeId} />
                      <span className={t.assigneeId ? undefined : "muted"}>{t.assigneeId ? personName(t.assigneeId) : "Unassigned"}</span>
                    </span>
                    <span className="wk-hide-sm">{targetChip(t, today)}</span>
                    <span className="wk-cell-end">
                      <PriorityChip priority={t.priority} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )
      ) : (
        <div className="wk-board">
          {TICKET_STATUSES.map((s) => {
            const cards = rows.filter((t) => t.status === s);
            return (
              <section
                key={s}
                className={dragOver === s ? "wk-col drop" : "wk-col"}
                aria-label={STATUS_WORD[s]}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(s);
                }}
                onDragLeave={() => setDragOver("")}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver("");
                  void dropOn(s, e.dataTransfer.getData("text/plain"));
                }}
              >
                <div className="wk-col-head">
                  <span className={`wk-dot ${DOT[s]}`} aria-hidden="true" />
                  {STATUS_WORD[s]}
                  <span className="wk-count">{cards.length}</span>
                </div>
                {cards.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    draggable={nextStatuses(t, actor).length > 0}
                    onDragStart={(e) => e.dataTransfer.setData("text/plain", t.id)}
                    className={`wk-card p-${t.priority}${t.id === selectedId ? " on" : ""}`}
                    onClick={() => select(t.id)}
                  >
                    <span className="wk-meta">
                      <code>{t.id}</code>
                      <span>{t.type}</span>
                    </span>
                    <span className="wk-card-title">{t.title}</span>
                    <span className="wk-card-foot">
                      {targetChip(t, today)}
                      <PriorityChip priority={t.priority} />
                      <Avatar name={t.assigneeId ? personName(t.assigneeId) : undefined} none={!t.assigneeId} />
                    </span>
                  </button>
                ))}
                {cards.length === 0 && <p className="wk-col-empty">Empty</p>}
              </section>
            );
          })}
        </div>
      )}

      {selected && (
        <TicketDrawer
          key={selected.id}
          ticket={selected}
          actor={actor}
          team={team}
          startWith={resolveHint}
          onClose={() => select(null)}
        />
      )}

      {createOpen && (
        <CreateTicketDialog
          actor={actor}
          team={hasTeam ? team : []}
          projects={currentProjects.map((p) => ({ id: p.id, name: p.name }))}
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            setView("mine");
            select(id);
            notify(`${id} raised.`);
          }}
        />
      )}
    </Page>
  );
}

const FLOW: TicketStatus[] = ["Open", "In progress", "Resolved", "Closed"];

function TicketDrawer({
  ticket: t,
  actor,
  team,
  startWith,
  onClose,
}: {
  ticket: Ticket;
  actor: TicketActor;
  team: { id: string; fullName: string }[];
  startWith: TicketStatus | "";
  onClose: () => void;
}) {
  const today = todayISO();
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<TicketStatus | "">(startWith === "Resolved" ? "Resolved" : "");
  const [assignee, setAssignee] = useState("");
  const [watcher, setWatcher] = useState("");
  const [comment, setComment] = useState("");
  const [task, setTask] = useState({ title: "", ownerId: "", due: "" });
  const canPlan = canPlanTicket(t, actor);
  const canTake = canTakeTicket(t, actor);
  const moves = nextStatuses(t, actor);
  const tasks = t.tasks ?? [];
  const doneCount = tasks.filter((k) => k.done).length;
  const watching = t.watcherIds.includes(actor.id);
  const target = ticketTarget(t);
  const open = isOpenTicket(t);
  const people = [
    ...new Map(
      [...team, ...[t.assigneeId, t.subOwnerId, t.requesterId, actor.id].filter((id): id is string => !!id).map((id) => ({ id, fullName: personName(id) }))].map(
        (p) => [p.id, p] as const,
      ),
    ).values(),
  ];

  const result = (error: string | null, ok: string) => {
    if (error) notify(error, "err");
    else notify(ok);
    return error;
  };

  async function move(s: TicketStatus) {
    if ((s === "Resolved" && !note.trim()) || (s === "Closed" && t.status === "Open" && pending !== "Closed")) {
      setPending(s);
      return "";
    }
    const error = await setTicketStatus(t.id, s, actor, note);
    if (!error) {
      setNote("");
      setPending("");
    }
    return result(error, `${t.id} → ${STATUS_WORD[s]}.`);
  }

  const stepIndex = FLOW.indexOf(t.status === "Waiting" ? "In progress" : t.status);
  const feed = [...t.activity].reverse();

  return (
    <Drawer
      label={`${t.id} ${t.title}`}
      onClose={onClose}
      head={
        <>
          <div className="wk-dhead-top">
            <span className={`wk-dot ${DOT[t.status]}`} aria-hidden="true" />
            <span className="wk-status">{STATUS_WORD[t.status]}</span>
            <code>{t.id}</code>
            <button type="button" className="wk-x" aria-label="Close" onClick={onClose}>
              ×
            </button>
          </div>
          <h2>{t.title}</h2>
          <div className="wk-dhead-chips">
            <PriorityChip priority={t.priority} />
            <span className="wk-chip">{t.type}</span>
            {t.projectName && <span className="wk-chip">{t.projectName}</span>}
            {targetChip(t, today)}
          </div>
        </>
      }
      foot={
        <>
          {moves
            .filter((s) => s !== pending)
            .map((s) => (
              <ActionButton
                key={s}
                className={s === "Resolved" || (s === "In progress" && t.status === "Open") ? "btn" : "btn-ghost"}
                onAction={() => move(s)}
              >
                {moveLabel(t, s, actor.id)}
              </ActionButton>
            ))}
          {canTake && !t.assigneeId && (
            <ActionButton className="btn" onAction={async () => result(await assignTicket(t.id, actor.id, actor), "It's yours now.")}>
              Take it
            </ActionButton>
          )}
          <span className="wk-spacer" />
          {t.assigneeId === actor.id && open && (
            <Link className="btn-ghost" to={`/timesheet?work=ticket:${t.id}`}>
              Log time
            </Link>
          )}
          <ActionButton
            className="btn-ghost"
            onAction={async () => result(await toggleWatch(t.id, actor.id, actor), watching ? "Stopped watching." : "Watching.")}
          >
            {watching ? "Unwatch" : "Watch"}
          </ActionButton>
        </>
      }
    >
      <ol className="wk-steps" aria-label="Progress">
        {FLOW.map((s, i) => (
          <li
            key={s}
            className={
              i < stepIndex || t.status === "Closed"
                ? "done"
                : i === stepIndex
                  ? t.status === "Waiting"
                    ? "now hold"
                    : "now"
                  : undefined
            }
          >
            {i === stepIndex && t.status === "Waiting" ? "On hold" : s}
          </li>
        ))}
      </ol>

      {pending && (
        <div className="wk-inline-form">
          <label className="field">
            {pending === "Resolved" ? "What was done?" : pending === "Closed" ? "Why withdraw it? (optional)" : "Note"}
            <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
          </label>
          <div className="wk-compose-actions">
            <ActionButton
              className="btn btn-tiny"
              disabled={pending === "Resolved" && !note.trim()}
              onAction={async () => {
                const error = await setTicketStatus(t.id, pending, actor, note);
                if (!error) {
                  setNote("");
                  setPending("");
                }
                return result(error, `${t.id} → ${STATUS_WORD[pending]}.`);
              }}
            >
              {moveLabel(t, pending, actor.id)}
            </ActionButton>
            <button type="button" className="btn-ghost btn-tiny" onClick={() => setPending("")}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {t.status === "Resolved" && t.requesterId === actor.id && (
        <div className="wk-next">
          <span>Your call</span>
          Close it if it's fixed, or reopen it.
        </div>
      )}
      {open && target.state === "late" && (
        <div className="wk-next late">
          <span>{target.source === "sla" ? "Past the response target" : "Past the deadline"}</span>
          {-dayGap(today, target.date)} day(s) late
        </div>
      )}

      <dl className="wk-facts">
        <div className="wk-fact">
          <dt>Raised by</dt>
          <dd>
            <Avatar name={personName(t.requesterId)} />
            {personName(t.requesterId)}
          </dd>
        </div>
        <div className="wk-fact">
          <dt>Owner</dt>
          <dd>
            {t.assigneeId ? <Avatar name={personName(t.assigneeId)} /> : <Avatar none />}
            {personName(t.assigneeId)}
          </dd>
        </div>
        <div className="wk-fact">
          <dt>Helper</dt>
          <dd>
            {canPlan ? (
              <select
                value={t.subOwnerId ?? ""}
                aria-label="Helper"
                onChange={async (e) => result(await setTicketSubOwner(t.id, e.target.value, actor), "Helper updated.")}
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
              personName(t.subOwnerId) === "Unassigned" ? "—" : personName(t.subOwnerId)
            )}
          </dd>
        </div>
        <div className="wk-fact">
          <dt>Priority</dt>
          <dd>
            {canPlan ? (
              <select
                value={t.priority}
                aria-label="Priority"
                onChange={async (e) => result(await setTicketPriority(t.id, e.target.value as TicketPriority, actor), "Priority changed.")}
              >
                {TICKET_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {cap(p)} · {SLA_HOURS[p] < 24 ? `${SLA_HOURS[p]}h` : `${SLA_HOURS[p] / 24}d`} target
                  </option>
                ))}
              </select>
            ) : (
              <PriorityChip priority={t.priority} />
            )}
          </dd>
        </div>
        <div className="wk-fact">
          <dt>Deadline</dt>
          <dd>
            {canPlan ? (
              <input
                type="date"
                value={t.due ?? ""}
                aria-label="Deadline"
                onChange={async (e) => result(await setTicketDue(t.id, e.target.value, actor), e.target.value ? "Deadline set." : "Deadline removed.")}
              />
            ) : t.due ? (
              formatShortDate(t.due)
            ) : (
              "—"
            )}
          </dd>
        </div>
        <div className="wk-fact">
          <dt>{target.source === "sla" ? "Response target" : "Target"}</dt>
          <dd>{formatShortDate(target.date)}</dd>
        </div>
        <div className="wk-fact">
          <dt>Raised</dt>
          <dd>{formatStamp(t.createdAt)}</dd>
        </div>
        <div className="wk-fact">
          <dt>Updated</dt>
          <dd>{formatStamp(t.updatedAt)}</dd>
        </div>
        {open && team.length > 0 && (
          <div className="wk-fact wide">
            <dt>{t.assigneeId ? "Hand over to" : "Assign to"}</dt>
            <dd>
              <span className="wk-inline" style={{ width: "100%" }}>
                <select value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Assign to">
                  <option value="">Pick someone from your team…</option>
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
                  onAction={async () => {
                    const error = await assignTicket(t.id, assignee, actor);
                    if (!error) setAssignee("");
                    return result(error, `Assigned to ${personName(assignee)}.`);
                  }}
                >
                  Assign
                </ActionButton>
                {canTake && t.assigneeId && (
                  <ActionButton className="btn-ghost btn-tiny" onAction={async () => result(await assignTicket(t.id, actor.id, actor), "It's yours now.")}>
                    Take it
                  </ActionButton>
                )}
              </span>
            </dd>
          </div>
        )}
      </dl>

      {t.description && (
        <section className="wk-sec">
          <h3>Details</h3>
          <p className="wk-desc">{t.description}</p>
        </section>
      )}

      {(tasks.length > 0 || canPlan) && (
        <section className="wk-sec">
          <h3>
            Steps <span className="wk-count">{tasks.length ? `${doneCount}/${tasks.length}` : ""}</span>
          </h3>
          {tasks.length > 0 && (
            <div className="wk-bar" aria-hidden="true">
              <i style={{ width: `${(doneCount / tasks.length) * 100}%` }} />
            </div>
          )}
          {tasks.length > 0 && (
            <ul className="wk-check">
              {tasks.map((k) => {
                const late = !k.done && !!k.due && k.due < today;
                const canTick = open && (k.ownerId === actor.id || canPlan);
                return (
                  <li key={k.id} className={k.done ? "done" : undefined}>
                    <input
                      type="checkbox"
                      checked={k.done}
                      disabled={!canTick}
                      aria-label={`Mark "${k.title}" done`}
                      onChange={async () => result(await toggleTicketTask(t.id, k.id, actor), k.done ? "Step reopened." : "Step done.")}
                    />
                    <span className="wk-check-title">{k.title}</span>
                    <span className="wk-hide-sm muted" style={{ fontSize: 12.5 }}>
                      {k.ownerId ? personName(k.ownerId) : "No owner"}
                    </span>
                    <span className={`wk-hide-sm wk-chip${late ? " late" : ""}`}>{k.due ? formatShortDate(k.due) : "No date"}</span>
                    {canPlan ? (
                      <button
                        type="button"
                        className="wk-x"
                        style={{ fontSize: 16, width: 26, height: 26 }}
                        aria-label={`Remove "${k.title}"`}
                        onClick={async () => result(await removeTicketTask(t.id, k.id, actor), "Step removed.")}
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
            <div className="wk-check-add">
              <input value={task.title} onChange={(e) => setTask({ ...task, title: e.target.value })} placeholder="Add a step" aria-label="New step" />
              <select value={task.ownerId} onChange={(e) => setTask({ ...task, ownerId: e.target.value })} aria-label="Step owner">
                <option value="">Owner</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.fullName}
                  </option>
                ))}
              </select>
              <input
                type="date"
                value={task.due}
                min={today}
                max={t.due || undefined}
                onChange={(e) => setTask({ ...task, due: e.target.value })}
                aria-label="Step due date"
              />
              <ActionButton
                className="btn btn-tiny"
                disabled={!task.title.trim()}
                onAction={async () => {
                  const error = await addTicketTask(t.id, task, actor);
                  if (!error) setTask({ title: "", ownerId: "", due: "" });
                  return result(error, "Step added.");
                }}
              >
                Add
              </ActionButton>
            </div>
          )}
        </section>
      )}

      <section className="wk-sec">
        <h3>
          Watchers <span className="wk-count">{t.watcherIds.length}</span>
        </h3>
        <div className="wk-people">
          {t.watcherIds.length === 0 && <span className="muted">Nobody yet</span>}
          {t.watcherIds.map((id) => (
            <span key={id} className="wk-person">
              <Avatar name={personName(id)} />
              {personName(id)}
              {(canPlan || id === actor.id) && (
                <button type="button" aria-label={`Remove ${personName(id)}`} onClick={async () => result(await toggleWatch(t.id, id, actor), "Watcher removed.")}>
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
        {canPlan && (
          <div className="wk-inline">
            <select value={watcher} onChange={(e) => setWatcher(e.target.value)} aria-label="Add a watcher">
              <option value="">Add someone to keep informed…</option>
              {TASK_TEAM.filter((p) => !t.watcherIds.includes(p.id)).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.fullName}
                </option>
              ))}
            </select>
            <ActionButton
              className="btn-ghost btn-tiny"
              disabled={!watcher}
              onAction={async () => {
                const error = await toggleWatch(t.id, watcher, actor);
                if (!error) setWatcher("");
                return result(error, "Watcher added.");
              }}
            >
              Add
            </ActionButton>
          </div>
        )}
      </section>

      <section className="wk-sec">
        <h3>
          Conversation <span className="wk-count">{t.activity.filter((e) => e.kind === "comment").length}</span>
        </h3>
        <div className="wk-compose">
          <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Write an update or a question" aria-label="Comment" />
          <div className="wk-compose-actions">
            <ActionButton
              className="btn btn-tiny"
              disabled={!comment.trim()}
              onAction={async () => {
                const error = await commentOnTicket(t.id, comment, actor);
                if (!error) setComment("");
                return result(error, "Comment posted.");
              }}
            >
              Comment
            </ActionButton>
          </div>
        </div>
        <ul className="wk-feed">
          {feed.map((e) =>
            e.kind === "comment" ? (
              <li key={e.id}>
                <Avatar name={personName(e.byId)} />
                <div className="wk-bubble">
                  <header>
                    <b>{personName(e.byId)}</b>
                    <time>{formatStamp(e.at)}</time>
                  </header>
                  <p>{e.text}</p>
                </div>
              </li>
            ) : (
              <li key={e.id}>
                <span className="wk-tick" aria-hidden="true" />
                <div className="wk-ev">
                  <b>{personName(e.byId)}</b> {e.text} · <time>{formatStamp(e.at)}</time>
                </div>
              </li>
            ),
          )}
        </ul>
      </section>
    </Drawer>
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
  const [d, setD] = useState({
    title: "",
    description: "",
    type: "IT support" as TicketType,
    priority: "medium" as TicketPriority,
    projectId: "",
    assigneeId: "",
    due: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const routed = d.type === "IT support" || d.type === "Access request" ? "IT desk" : d.type === "HR query" ? "HR" : null;
  const sla = SLA_HOURS[d.priority];

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = await createTicket({ ...d, projectName: projects.find((p) => p.id === d.projectId)?.name }, actor);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onCreated(res.id);
  }

  return (
    <div className="modal-root" role="presentation">
      <button className="modal-scrim" type="button" aria-label="Close" onClick={onClose} />
      <div className="modal-card wk-modal" role="dialog" aria-modal="true" aria-labelledby="new-ticket-title">
        <h2 id="new-ticket-title">Raise ticket</h2>
        <form onSubmit={submit}>
          <div className="wk-form">
            <label className="wide">
              Title
              <input value={d.title} maxLength={200} autoFocus onChange={(e) => setD({ ...d, title: e.target.value })} placeholder="What's wrong or what do you need?" />
            </label>
            <label>
              Category
              <select value={d.type} onChange={(e) => setD({ ...d, type: e.target.value as TicketType })}>
                {TICKET_TYPES.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label>
              Priority
              <select value={d.priority} onChange={(e) => setD({ ...d, priority: e.target.value as TicketPriority })}>
                {TICKET_PRIORITIES.map((s) => (
                  <option key={s} value={s}>
                    {cap(s)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Project
              <select value={d.projectId} onChange={(e) => setD({ ...d, projectId: e.target.value })}>
                <option value="">None</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Deadline
              <input type="date" value={d.due} min={todayISO()} onChange={(e) => setD({ ...d, due: e.target.value })} />
            </label>
            <label className="wide">
              {team.length > 0 ? "Assign to" : "Goes to"}
              {team.length > 0 ? (
                <select value={d.assigneeId} onChange={(e) => setD({ ...d, assigneeId: e.target.value })}>
                  <option value="">{routed ? `The ${routed}` : "Leave unassigned"}</option>
                  {team.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.fullName}
                    </option>
                  ))}
                </select>
              ) : (
                <input value={routed ? `The ${routed}` : "Your manager assigns it"} readOnly />
              )}
            </label>
            <label className="wide">
              Details
              <textarea rows={4} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} placeholder="Steps, screenshots links, who is affected" />
            </label>
            <p className="wk-hint wide">
              Response target: {sla < 24 ? `${sla} hours` : `${sla / 24} days`}
              {d.due ? ` · deadline ${formatShortDate(d.due)}` : ""}
            </p>
          </div>
          {error && <Banner message={{ tone: "err", text: error }} />}
          <div className="form-actions">
            <button className="btn-ghost" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="btn" type="submit" disabled={busy || !d.title.trim()}>
              {busy ? "Raising…" : "Raise"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
