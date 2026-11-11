import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ActionButton, Banner, EmptyState, LoadingState, Page, notify } from "../components/ui.tsx";
import { formatShortDate, formatStamp, todayISO } from "../model.ts";
import { usePortal } from "../store.tsx";
import { TASK_TEAM, taskTeamFor } from "../data/taskTeam.ts";
import {
  PRIORITY_FACTOR,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_TYPES,
  addTicketTask,
  assignTicket,
  canPlanTicket,
  canRateTicket,
  canTakeTicket,
  canViewTicket,
  commentOnTicket,
  createTicket,
  isOpenTicket,
  isTicketAgent,
  nextStatuses,
  personName,
  rateTicket,
  refreshTickets,
  removeTicketFile,
  removeTicketTask,
  saveTicketCategory,
  setTicketDue,
  setTicketPriority,
  setTicketStatus,
  setTicketSubOwner,
  slaState,
  ticketFilePath,
  ticketSla,
  ticketTarget,
  ticketsLoadError,
  ticketsLoaded,
  toggleTicketTask,
  toggleWatch,
  uploadTicketFile,
  useTicketCategories,
  useTickets,
  type Ticket,
  type TicketActor,
  type TicketCategoryInfo,
  type TicketPriority,
  type TicketStatus,
  type TicketType,
} from "../data/ticketStore.ts";
import { Avatar, Drawer, FileList, PriorityChip, WorkSwitch, dayGap, dueText } from "./workParts.tsx";
import { API_ENABLED } from "../api/client.ts";
import { openWorkFile } from "../api/syncTasks.ts";

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
const SLA_ADMINS = ["hr", "hr_admin", "hrbp", "admin", "super_admin", "it_admin"];

/** 6 -> "6h", 36 -> "1.5d". */
function hoursText(h: number): string {
  return h < 24 ? `${Math.round(h * 10) / 10}h` : `${Math.round((h / 24) * 10) / 10}d`;
}

/** "in 3h", "2h late", "on time" for a target timestamp. */
function targetText(iso: string, doneAt?: string): { text: string; late: boolean } {
  const end = Date.parse(iso);
  const at = doneAt ? Date.parse(doneAt) : Date.now();
  const hours = (end - at) / 3_600_000;
  if (doneAt) return { text: hours >= 0 ? "met" : `missed by ${hoursText(-hours)}`, late: hours < 0 };
  return hours >= 0 ? { text: `in ${hoursText(hours)}`, late: false } : { text: `${hoursText(-hours)} late`, late: true };
}

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
    <>
      <span className={`wk-chip ${cls}`} title={target.source === "sla" ? `${t.type} · ${t.priority} priority target` : "Deadline"}>
        {target.source === "sla" ? "SLA " : ""}
        {dueText(target.date, today, formatShortDate)}
      </span>
      {t.escalatedAt && <span className="wk-chip late">Escalated</span>}
    </>
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
  const [slaOpen, setSlaOpen] = useState(false);
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
    late: openRows.filter((t) => ticketTarget(t).state === "late" || slaState(t) === "breached").length,
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
      if (focus === "late" && ticketTarget(t).state !== "late" && slaState(t) !== "breached") return false;
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
        <>
          {SLA_ADMINS.includes(employee.role) && (
            <button className="btn-ghost" type="button" onClick={() => setSlaOpen(true)}>
              Service targets
            </button>
          )}
          <button className="btn" type="button" onClick={() => setCreateOpen(true)}>
            Raise ticket
          </button>
        </>
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

      {slaOpen && <CategoriesDialog onClose={() => setSlaOpen(false)} />}

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
  const [internal, setInternal] = useState(false);
  const [fileInternal, setFileInternal] = useState(false);
  const [stars, setStars] = useState(t.satisfaction ?? 0);
  const [rateNote, setRateNote] = useState(t.satisfactionNote ?? "");
  const [task, setTask] = useState({ title: "", ownerId: "", due: "" });
  const categories = useTicketCategories();
  const category = categories.find((c) => c.name === t.type);
  const agent = isTicketAgent(t, actor);
  const canRate = canRateTicket(t, actor);
  const sla = ticketSla(t);
  const respond = targetText(sla.respondBy, t.firstResponseAt);
  const resolve = targetText(sla.resolveBy, open0(t) ? undefined : t.resolvedAt ?? t.updatedAt);
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
    const reopening = s === "In progress" && t.status === "Resolved";
    if ((s === "Resolved" && !note.trim()) || (reopening && !note.trim()) || (s === "Closed" && t.status === "Open" && pending !== "Closed")) {
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
            {pending === "Resolved"
              ? "Resolution note (the requester sees it)"
              : pending === "Closed"
                ? "Why withdraw it? (optional)"
                : pending === "In progress" && t.status === "Resolved"
                  ? "What is still wrong?"
                  : "Note"}
            <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
          </label>
          <div className="wk-compose-actions">
            <ActionButton
              className="btn btn-tiny"
              disabled={(pending === "Resolved" || (pending === "In progress" && t.status === "Resolved")) && !note.trim()}
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

      {t.resolutionNote && (t.status === "Resolved" || t.status === "Closed") && (
        <div className="wk-resolution">
          <span>Resolution</span>
          <p>{t.resolutionNote}</p>
        </div>
      )}
      {t.status === "Resolved" && t.requesterId === actor.id && (
        <div className="wk-next">
          <span>Your call</span>
          Close it if it's fixed, or reopen it.
        </div>
      )}
      {(canRate || t.satisfaction) && (
        <div className="wk-rate">
          <span>{canRate ? "How was this handled?" : "Rating"}</span>
          <div className="wk-stars" role="radiogroup" aria-label="Rating">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={stars === n}
                aria-label={`${n} star${n > 1 ? "s" : ""}`}
                className={n <= (canRate ? stars : t.satisfaction ?? 0) ? "on" : undefined}
                disabled={!canRate}
                onClick={() => setStars(n)}
              >
                ★
              </button>
            ))}
          </div>
          {canRate ? (
            <span className="wk-inline">
              <input value={rateNote} maxLength={1000} onChange={(e) => setRateNote(e.target.value)} placeholder="Comment (optional)" aria-label="Rating comment" />
              <ActionButton
                className="btn btn-tiny"
                disabled={!stars || (stars === t.satisfaction && rateNote === (t.satisfactionNote ?? ""))}
                onAction={async () => result(await rateTicket(t.id, stars, rateNote, actor), "Thanks for the rating.")}
              >
                {t.satisfaction ? "Update" : "Rate"}
              </ActionButton>
            </span>
          ) : (
            t.satisfactionNote && <em>{t.satisfactionNote}</em>
          )}
        </div>
      )}
      {open && target.state === "late" && (
        <div className="wk-next late">
          <span>{target.source === "sla" ? "Past the resolve target" : "Past the deadline"}</span>
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
                    {cap(p)}
                    {category ? ` · resolve in ${hoursText(category.resolveHours * PRIORITY_FACTOR[p])}` : ""}
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
          <dt>Respond by</dt>
          <dd>
            {formatStamp(sla.respondBy)}
            <span className={`wk-chip${respond.late ? " late" : t.firstResponseAt ? " met" : ""}`}>{t.firstResponseAt ? respond.text : open ? respond.text : "—"}</span>
          </dd>
        </div>
        <div className="wk-fact">
          <dt>Resolve by</dt>
          <dd>
            {formatStamp(sla.resolveBy)}
            <span className={`wk-chip${resolve.late ? " late" : !open ? " met" : ""}`}>{resolve.text}</span>
          </dd>
        </div>
        {t.escalatedAt && (
          <div className="wk-fact">
            <dt>Escalated</dt>
            <dd>{formatStamp(t.escalatedAt)}</dd>
          </div>
        )}
        {(t.reopenCount ?? 0) > 0 && (
          <div className="wk-fact">
            <dt>Reopened</dt>
            <dd>
              {t.reopenCount} time{t.reopenCount === 1 ? "" : "s"}
            </dd>
          </div>
        )}
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
          Attachments <span className="wk-count">{t.files?.length ?? 0}</span>
        </h3>
        <FileList
          files={(t.files ?? []).map((f) => ({ id: f.id, name: f.name, size: f.size, at: f.at, by: personName(f.byId), internal: f.internal }))}
          canAdd={API_ENABLED}
          offlineNote={API_ENABLED ? undefined : "Files can be attached when TimeZ is connected to the server."}
          canRemove={(f) => {
            const file = (t.files ?? []).find((x) => x.id === f.id);
            return !!file && (file.byId === actor.id || canPlan);
          }}
          onAdd={async (file) => result(await uploadTicketFile(t.id, file, agent && fileInternal), "File attached.")}
          onOpen={async (f) => {
            const error = await openWorkFile(ticketFilePath(t.id, f.id));
            if (error) notify(error, "err");
          }}
          onRemove={async (f) => result(await removeTicketFile(t.id, f.id), "File removed.")}
          extra={
            agent ? (
              <label className="wk-check-inline">
                <input type="checkbox" checked={fileInternal} onChange={(e) => setFileInternal(e.target.checked)} />
                Internal
              </label>
            ) : undefined
          }
        />
      </section>

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
          <textarea
            rows={2}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={internal ? "Internal note for the people working this ticket" : "Write a reply or a question"}
            aria-label="Comment"
            className={internal ? "internal" : undefined}
          />
          <div className="wk-compose-actions">
            {agent && (
              <label className="wk-check-inline">
                <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
                Internal note
              </label>
            )}
            <ActionButton
              className="btn btn-tiny"
              disabled={!comment.trim()}
              onAction={async () => {
                const error = await commentOnTicket(t.id, comment, actor, agent && internal);
                if (!error) setComment("");
                return result(error, internal ? "Internal note added." : "Reply posted.");
              }}
            >
              {internal ? "Add note" : "Reply"}
            </ActionButton>
          </div>
        </div>
        <ul className="wk-feed">
          {feed.map((e) =>
            e.kind === "comment" ? (
              <li key={e.id}>
                <Avatar name={personName(e.byId)} />
                <div className={e.internal ? "wk-bubble internal" : "wk-bubble"}>
                  <header>
                    <b>{personName(e.byId)}</b>
                    {e.internal && <span className="wk-chip">Internal</span>}
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
  const categories = useTicketCategories();
  const cat = categories.find((c) => c.name === d.type);
  const routed = cat?.queueOwnerId
    ? cat.queueOwnerName ?? personName(cat.queueOwnerId)
    : d.type === "IT support" || d.type === "Access request" ? "IT desk" : d.type === "HR query" ? "HR" : null;
  const factor = PRIORITY_FACTOR[d.priority];

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
                  <option value="">{routed ? `Queue: ${routed}` : "Leave unassigned"}</option>
                  {team.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.fullName}
                    </option>
                  ))}
                </select>
              ) : (
                <input value={routed ? `Queue: ${routed}` : "Your manager assigns it"} readOnly />
              )}
            </label>
            <label className="wide">
              Details
              <textarea rows={4} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} placeholder="Steps, screenshots links, who is affected" />
            </label>
            <p className="wk-hint wide">
              {cat
                ? `First response within ${hoursText(cat.responseHours * factor)} · resolved within ${hoursText(cat.resolveHours * factor)}`
                : ""}
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


const open0 = (t: Ticket) => isOpenTicket(t);

/** HR / admin: response and resolve targets per category (for medium priority) and who picks up its queue. */
function CategoriesDialog({ onClose }: { onClose: () => void }) {
  const categories = useTicketCategories();
  const [rows, setRows] = useState<TicketCategoryInfo[]>(categories);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setRows(categories), [categories]);
  const set = (name: string, change: Partial<TicketCategoryInfo>) => setRows(rows.map((r) => (r.name === name ? { ...r, ...change } : r)));

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    for (const r of rows) {
      const before = categories.find((c) => c.name === r.name);
      if (before && before.responseHours === r.responseHours && before.resolveHours === r.resolveHours && (before.queueOwnerId ?? "") === (r.queueOwnerId ?? "")) continue;
      const err = await saveTicketCategory(r);
      if (err) {
        setError(`${r.name}: ${err}`);
        setBusy(false);
        return;
      }
    }
    setBusy(false);
    notify("Service targets saved.");
    onClose();
  }

  return (
    <div className="modal-root" role="presentation">
      <button className="modal-scrim" type="button" aria-label="Close" onClick={onClose} />
      <div className="modal-card wk-modal" role="dialog" aria-modal="true" aria-labelledby="sla-title">
        <h2 id="sla-title">Service targets</h2>
        <form onSubmit={save}>
          <table className="wk-sla-table">
            <thead>
              <tr>
                <th>Category</th>
                <th>Respond (h)</th>
                <th>Resolve (h)</th>
                <th>Queue</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name}>
                  <td>{r.name}</td>
                  <td>
                    <input type="number" min={1} max={2000} value={r.responseHours} aria-label={`${r.name} response hours`} onChange={(e) => set(r.name, { responseHours: Number(e.target.value) })} />
                  </td>
                  <td>
                    <input type="number" min={1} max={5000} value={r.resolveHours} aria-label={`${r.name} resolve hours`} onChange={(e) => set(r.name, { resolveHours: Number(e.target.value) })} />
                  </td>
                  <td>
                    <select value={r.queueOwnerId ?? ""} aria-label={`${r.name} queue`} onChange={(e) => set(r.name, { queueOwnerId: e.target.value || undefined })}>
                      <option value="">Manager assigns</option>
                      {TASK_TEAM.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.fullName}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="wk-hint">Hours are for medium priority: urgent ×0.25, high ×0.5, low ×2. Tickets past the resolve target are escalated to the owner's manager.</p>
          {error && <Banner message={{ tone: "err", text: error }} />}
          <div className="form-actions">
            <button className="btn-ghost" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="btn" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
