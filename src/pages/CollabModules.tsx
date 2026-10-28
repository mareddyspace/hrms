import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Banner,
  Card,
  DataTable,
  EmptyState,
  Field,
  FilterBar,
  MetricCard,
  MetricGrid,
  Page,
  StatusBadge,
  Tabs,
} from "../components/ui.tsx";
import {
  CHAT_PEOPLE,
  FAQ_ITEMS,
  HR_DESK_OWNERS,
  HR_REQUEST_CATEGORIES,
  HR_REQUEST_PRIORITIES,
  HR_REQUEST_SLA,
  chatPersonById,
  canManageAnnouncement,
  isHrRole,
  type AnnouncementScope,
  type ApprovalKind,
  type ChatAvailability,
  type ChatPerson,
  hrDeskOwnerName,
  hrRequestOverdue,
  type HrRequest,
  type HrRequestCategory,
  type HrRequestPriority,
  type InboxTab,
} from "../data/collabData.ts";
import { TEMPLATE_BLANKS_ERROR, hasTemplateBlanks, useTemplatedText } from "../data/requestTemplates.ts";
import {
  addHrComment,
  allowedHrStatuses,
  assignHrRequest,
  canReassignHrRequest,
  conversationUnreadCount,
  countPendingInbox,
  countUnreadMessages,
  countUnreadNotifications,
  createGroupConversation,
  createHrRequest,
  decideInboxTask,
  delegateInboxTask,
  getCollabState,
  hrRequestVisibleTo,
  isHrDeskMember,
  isMessageUnreadFor,
  listConversationsForUser,
  markAnnouncementRead,
  markConversationRead,
  sendChatMessage,
  setAnnouncementState,
  setHrRequestPriority,
  setHrRequestStatus,
  startDirectChat,
  subscribeCollab,
  worksHrRequest,
} from "../data/collabLocal.ts";
import { usePortal } from "../store.tsx";

function useCollab() {
  return useSyncExternalStore(subscribeCollab, getCollabState, getCollabState);
}

function formatWhen(iso: string) {
  try {
    return new Date(iso).toLocaleString("en-GB", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function availabilityTone(status: ChatAvailability): "ok" | "warn" | "neutral" {
  if (status === "Online") return "ok";
  if (status === "Away" || status === "Busy") return "warn";
  return "neutral";
}

function matchesPeopleQuery(person: ChatPerson, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return `${person.name} ${person.department} ${person.roleLabel} ${person.title}`
    .toLowerCase()
    .includes(needle);
}

/* ───────────────────────────── 1. INBOX & APPROVALS ── */

export function InboxApprovalsPage() {
  const { employee } = usePortal();
  const collab = useCollab();
  const [tab, setTab] = useState<InboxTab>("Pending");
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<ApprovalKind | "">("");
  const [selectedId, setSelectedId] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = window.setTimeout(() => setLoading(false), 280);
    return () => window.clearTimeout(t);
  }, []);

  const filtered = useMemo(() => {
    return collab.inbox.filter((t) => {
      if (t.status !== tab) return false;
      if (kind && t.kind !== kind) return false;
      if (q) {
        const blob = `${t.title} ${t.requester} ${t.summary} ${t.kind}`.toLowerCase();
        if (!blob.includes(q.toLowerCase())) return false;
      }
      return true;
    });
  }, [collab.inbox, tab, kind, q]);

  const selected = filtered.find((t) => t.id === selectedId) ?? filtered[0] ?? null;

  function onApprove() {
    if (!selected) return;
    setError("");
    decideInboxTask(selected.id, "Approved", employee.fullName, reason.trim() || undefined);
    setReason("");
  }

  function onReject() {
    if (!selected) return;
    if (selected.requiresReasonOnReject && !reason.trim()) {
      setError("A reason is required to reject this request.");
      return;
    }
    setError("");
    decideInboxTask(selected.id, "Rejected", employee.fullName, reason.trim());
    setReason("");
  }

  function onDelegate() {
    if (!selected) return;
    if (!reason.trim()) {
      setError("Add a short note when delegating.");
      return;
    }
    setError("");
    delegateInboxTask(selected.id, employee.fullName, "Farhan Ali", reason.trim());
    setReason("");
  }

  return (
    <Page title="Inbox and approvals">
      <MetricGrid>
        <MetricCard label="Pending" value={collab.inbox.filter((t) => t.status === "Pending").length} />
        <MetricCard label="Approved" value={collab.inbox.filter((t) => t.status === "Approved").length} />
        <MetricCard label="Rejected" value={collab.inbox.filter((t) => t.status === "Rejected").length} />
        <MetricCard label="Delegated" value={collab.inbox.filter((t) => t.status === "Delegated").length} />
      </MetricGrid>

      <FilterBar>
        <label className="filter-label">
          Search
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Requester, title, summary…" />
        </label>
        <label className="filter-label">
          Type
          <select value={kind} onChange={(e) => setKind(e.target.value as ApprovalKind | "")}>
            <option value="">All</option>
            {(["Leave", "Timesheet", "Attendance correction", "Recruitment", "Document"] as const).map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </label>
      </FilterBar>

      <Tabs
        tabs={[
          { id: "Pending", label: "Pending" },
          { id: "Approved", label: "Approved" },
          { id: "Rejected", label: "Rejected" },
          { id: "Delegated", label: "Delegated" },
        ]}
        value={tab}
        onChange={(id) => {
          setTab(id as InboxTab);
          setSelectedId("");
          setError("");
        }}
      />

      {loading ? (
        <Card>
          <p className="note">Loading inbox…</p>
        </Card>
      ) : (
        <div className="collab-split">
          <Card title={`${tab} tasks`}>
            {filtered.length === 0 ? (
              <EmptyState title={`No ${tab.toLowerCase()} items`} description="Try another tab or clear filters." />
            ) : (
              <ul className="collab-list">
                {filtered.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      className={selected?.id === t.id ? "collab-list-item active" : "collab-list-item"}
                      onClick={() => {
                        setSelectedId(t.id);
                        setError("");
                      }}
                    >
                      <strong>{t.title}</strong>
                      <span className="muted">
                        {t.kind} · {t.requester} · {formatWhen(t.createdAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={selected ? selected.title : "Task detail"}>
            {!selected ? (
              <EmptyState title="Select a task" description="Choose an item from the list." />
            ) : (
              <div className="stack">
                <dl className="info-grid">
                  <div className="info-fact"><dt>Type</dt><dd>{selected.kind}</dd></div>
                  <div className="info-fact"><dt>Requester</dt><dd>{selected.requester}</dd></div>
                  <div className="info-fact"><dt>Status</dt><dd><StatusBadge status={selected.status} /></dd></div>
                  <div className="info-fact"><dt>Summary</dt><dd>{selected.summary}</dd></div>
                  {selected.delegatedTo && (
                    <div className="info-fact"><dt>Delegated to</dt><dd>{selected.delegatedTo}</dd></div>
                  )}
                </dl>

                <h3 className="collab-section-title">Approval timeline</h3>
                <ol className="collab-timeline">
                  {selected.timeline.map((ev, i) => (
                    <li key={`${ev.at}-${i}`}>
                      <strong>{ev.action}</strong> · {ev.actor}
                      <div className="muted">{formatWhen(ev.at)} · {ev.status}</div>
                      {ev.comment && <div className="note">{ev.comment}</div>}
                    </li>
                  ))}
                </ol>

                {selected.status === "Pending" && (
                  <>
                    <Field label="Comment / reason (required to reject)" wide>
                      <textarea
                        rows={3}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="Add context for the requester…"
                      />
                    </Field>
                    {error && <Banner message={{ tone: "err", text: error }} />}
                    <div className="row-gap">
                      <button type="button" className="btn" onClick={onApprove}>
                        Approve
                      </button>
                      <button type="button" className="btn-ghost" onClick={onReject}>
                        Reject
                      </button>
                      <button type="button" className="btn-ghost" onClick={onDelegate}>
                        Delegate
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </Card>
        </div>
      )}
    </Page>
  );
}

/* ───────────────────────────── 2. MESSAGING ── */

export function MessagingPage() {
  const { employee, demoProfile } = usePortal();
  const collab = useCollab();
  const [searchParams] = useSearchParams();
  const [filter, setFilter] = useState<"all" | "direct" | "group">("all");
  const [convQ, setConvQ] = useState("");
  const [peopleQ, setPeopleQ] = useState("");
  // ?c=<conversation id> opens that conversation, e.g. from a profile's Message button.
  const [activeId, setActiveId] = useState(() => searchParams.get("c") ?? "");
  const [text, setText] = useState("");
  const [attachName, setAttachName] = useState<string | undefined>();
  const [error, setError] = useState("");
  const [sentOk, setSentOk] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const [composerMode, setComposerMode] = useState<"closed" | "direct" | "group">("closed");
  const [groupTitle, setGroupTitle] = useState("");
  const [groupMemberIds, setGroupMemberIds] = useState<string[]>([]);
  const markedReadRef = useRef<string | null>(null);
  const threadEndRef = useRef<HTMLDivElement | null>(null);

  const visibleConversations = useMemo(
    () => listConversationsForUser(employee.id, demoProfile.role),
    [collab.conversations, employee.id, demoProfile.role],
  );

  const conversations = useMemo(() => {
    const needle = convQ.trim().toLowerCase();
    return visibleConversations.filter((c) => {
      if (filter !== "all" && c.kind !== filter) return false;
      if (!needle) return true;
      const last = c.messages?.at(-1)?.text ?? "";
      const blob = `${c.title} ${c.participantNames.join(" ")} ${last} ${c.kind}`.toLowerCase();
      return blob.includes(needle);
    });
  }, [visibleConversations, filter, convQ]);

  const active = visibleConversations.find((c) => c.id === activeId) ?? null;

  useEffect(() => {
    if (activeId && visibleConversations.some((c) => c.id === activeId)) return;
    setActiveId(visibleConversations[0]?.id ?? "");
  }, [visibleConversations, activeId]);

  useEffect(() => {
    if (!active?.id) return;
    if (markedReadRef.current === active.id) return;
    markedReadRef.current = active.id;
    markConversationRead(active.id, employee.id);
  }, [active?.id, employee.id]);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: "end" });
  }, [active?.id, active?.messages?.length]);

  useEffect(() => {
    if (!sentOk) return;
    const t = window.setTimeout(() => setSentOk(""), 2800);
    return () => window.clearTimeout(t);
  }, [sentOk]);

  const people = useMemo(
    () => CHAT_PEOPLE.filter((p) => p.id !== employee.id && matchesPeopleQuery(p, peopleQ.trim())),
    [employee.id, peopleQ],
  );

  const peer =
    active?.kind === "direct"
      ? chatPersonById(active.participantIds.find((id) => id !== employee.id) ?? "")
      : undefined;

  function openDirect(person: ChatPerson) {
    const id = startDirectChat(person.id, person.name, employee.id, employee.fullName);
    markedReadRef.current = null;
    setActiveId(id);
    setFilter("direct");
    setComposerMode("closed");
    setError("");
    setSentOk(`Opened chat with ${person.name}.`);
  }

  function toggleGroupMember(id: string) {
    setGroupMemberIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function createGroup(event: FormEvent) {
    event.preventDefault();
    if (groupMemberIds.length === 0) {
      setError("Select at least one colleague.");
      return;
    }
    const members = CHAT_PEOPLE.filter((p) => groupMemberIds.includes(p.id));
    const id = createGroupConversation({
      title: groupTitle,
      selfId: employee.id,
      selfName: employee.fullName,
      memberIds: members.map((m) => m.id),
      memberNames: members.map((m) => m.name),
    });
    markedReadRef.current = null;
    setActiveId(id);
    setFilter("group");
    setComposerMode("closed");
    setGroupTitle("");
    setGroupMemberIds([]);
    setError("");
    setSentOk("Group created.");
  }

  function send(event: FormEvent) {
    event.preventDefault();
    if (!active) {
      setError("Select or start a conversation first.");
      return;
    }
    if (!text.trim() && !attachName) {
      setError("Type a message or attach a file.");
      return;
    }
    const failure = sendChatMessage(
      active.id,
      employee.id,
      employee.fullName,
      text.trim() || `(Attachment) ${attachName}`,
      attachName,
    );
    if (failure) {
      setError(failure);
      return;
    }
    setError("");
    setText("");
    setAttachName(undefined);
    setSentOk("Message sent.");
  }

  return (
    <Page
      title="Messages"
      action={
        <div className="row-gap">
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setComposerMode((m) => (m === "direct" ? "closed" : "direct"))}
          >
            New message
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setComposerMode((m) => (m === "group" ? "closed" : "group"))}
          >
            New group
          </button>
        </div>
      }
    >
      {sentOk && <Banner message={{ tone: "ok", text: sentOk }} />}

      {composerMode !== "closed" && (
        <Card title={composerMode === "direct" ? "New message" : "New group"}>
          {composerMode === "direct" ? (
            <div className="stack-tight">
              <label className="filter-label">
                Search
                <input
                  value={peopleQ}
                  onChange={(e) => setPeopleQ(e.target.value)}
                  placeholder="Name, department, or role…"
                />
              </label>
              {people.length === 0 ? (
                <EmptyState title="No people found" description="Try other filters." />
              ) : (
                <ul className="collab-list">
                  {people.map((p) => (
                    <li key={p.id} className="msg-person-row">
                      <div>
                        <strong>{p.name}</strong>
                        <span className="muted">
                          {p.roleLabel} · {p.department}
                        </span>
                      </div>
                      <button type="button" className="btn-ghost" onClick={() => openDirect(p)}>
                        Message
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <form className="stack" onSubmit={createGroup}>
              <Field label="Group name">
                <input
                  value={groupTitle}
                  onChange={(e) => setGroupTitle(e.target.value)}
                  placeholder="e.g. Sprint sync"
                />
              </Field>
              <ul className="collab-list">
                {CHAT_PEOPLE.filter((p) => p.id !== employee.id).map((p) => (
                  <li key={p.id} className="msg-person-row">
                    <label className="msg-check-label">
                      <input
                        type="checkbox"
                        checked={groupMemberIds.includes(p.id)}
                        onChange={() => toggleGroupMember(p.id)}
                      />
                      <span>
                        <strong>{p.name}</strong>
                        <span className="muted">
                          {" "}
                          · {p.roleLabel} · {p.department}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              {error && composerMode === "group" && <Banner message={{ tone: "err", text: error }} />}
              <div className="row-gap">
                <button type="submit" className="btn">
                  Create group
                </button>
                <button type="button" className="btn-ghost" onClick={() => setComposerMode("closed")}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </Card>
      )}

      <div className="msg-layout">
        <aside className="msg-sidebar stack">
          <Card title="Conversations">
            <div className="soft-tabs" role="tablist">
              {(
                [
                  ["all", "All"],
                  ["direct", "Direct"],
                  ["group", "Groups"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={filter === id ? "soft-tab active" : "soft-tab"}
                  onClick={() => setFilter(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <label className="filter-label">
              Search conversations
              <input
                value={convQ}
                onChange={(e) => setConvQ(e.target.value)}
                placeholder="Name, participants, or text…"
              />
            </label>
            {conversations.length === 0 ? (
              <EmptyState
                title="No conversations"
                description="Start a chat with New message."
              />
            ) : (
              <ul className="collab-list">
                {conversations.map((c) => {
                  const last = c.messages?.at(-1);
                  const unreadCount = conversationUnreadCount(c, employee.id);
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        className={active?.id === c.id ? "collab-list-item active" : "collab-list-item"}
                        onClick={() => {
                          markedReadRef.current = null;
                          setActiveId(c.id);
                          setSentOk("");
                          setError("");
                        }}
                      >
                        <strong>
                          {c.title}{" "}
                          {unreadCount > 0 && <StatusBadge status={`${unreadCount} new`} tone="warn" />}
                          {c.restricted === "compensation" && (
                            <StatusBadge status="Pay confidential" tone="danger" />
                          )}
                          {c.restricted === "hr_confidential" && (
                            <StatusBadge status="HR confidential" tone="danger" />
                          )}
                        </strong>
                        <span className="muted">
                          {c.kind === "group" ? "Group" : "Direct"}
                          {last ? ` · ${formatWhen(last.at)} · ${last.text.slice(0, 42)}` : " · No messages yet"}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card title="People directory">
            <label className="filter-label">
              Search people
              <input
                value={peopleQ}
                onChange={(e) => setPeopleQ(e.target.value)}
                placeholder="Name, department, or role…"
              />
            </label>
            {people.length === 0 ? (
              <EmptyState title="No people found" description="Try other filters." />
            ) : (
              <ul className="collab-list">
                {people.map((p) => (
                  <li key={p.id} className="msg-person-row">
                    <div>
                      <strong>{p.name}</strong>
                      <span className="muted">
                        {p.roleLabel} · {p.department}
                      </span>
                      <span className="msg-avail">
                        <StatusBadge status={p.availability} tone={availabilityTone(p.availability)} />
                      </span>
                    </div>
                    <button type="button" className="btn-ghost" onClick={() => openDirect(p)}>
                      Message
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </aside>

        <section className="msg-main">
          {!active ? (
            <Card>
              <EmptyState
                title="No conversation selected"
                description="Pick a conversation."
              />
            </Card>
          ) : (
            <Card
              title={active.title}
              action={
                <button type="button" className="quiet-link" onClick={() => setShowDetails((v) => !v)}>
                  {showDetails ? "Hide details" : "Details"}
                </button>
              }
            >
              <div className="msg-header-meta">
                {peer ? (
                  <>
                    <strong>{peer.name}</strong>
                    <span className="muted">
                      {peer.roleLabel} · {peer.title}
                    </span>
                    <StatusBadge status={peer.availability} tone={availabilityTone(peer.availability)} />
                  </>
                ) : (
                  <>
                    <strong>{active.kind === "group" ? "Group chat" : "Direct chat"}</strong>
                    <span className="muted">{active.participantNames.join(", ")}</span>
                  </>
                )}
                {active.restricted && (
                  <StatusBadge
                    status={active.restricted === "compensation" ? "Pay confidential" : "HR confidential"}
                    tone="danger"
                  />
                )}
              </div>

              {showDetails && (
                <div className="msg-details">
                  <p>
                    <strong>Type:</strong> {active.kind === "group" ? "Group" : "One-to-one"}
                  </p>
                  <p>
                    <strong>Participants:</strong> {active.participantNames.join(", ")}
                  </p>
                  {active.restricted && (
                    <p>
                      <strong>Access:</strong> Restricted to authorized roles among participants.
                    </p>
                  )}
                </div>
              )}

              <div className="msg-thread" role="log" aria-live="polite">
                {(active.messages ?? []).length === 0 ? (
                  <EmptyState title="No messages yet" />
                ) : (
                  // Oldest first, newest at the bottom.
                  [...(active.messages ?? [])].sort((a, b) => a.at.localeCompare(b.at)).map((m) => (
                    <div
                      key={m.id}
                      className={m.fromId === employee.id ? "msg-bubble mine" : "msg-bubble"}
                    >
                      <div className="msg-meta">
                        <strong>{m.fromName}</strong>
                        <span className="muted">{formatWhen(m.at)}</span>
                        {m.fromId === employee.id ? (
                          <StatusBadge status="Sent" tone="ok" />
                        ) : (
                          isMessageUnreadFor(m, employee.id) && <StatusBadge status="Unread" tone="warn" />
                        )}
                      </div>
                      <p>{m.text}</p>
                      {m.attachmentName && (
                        <p className="note">Attachment: {m.attachmentName}</p>
                      )}
                    </div>
                  ))
                )}
                <div ref={threadEndRef} />
              </div>

              <form className="msg-composer" onSubmit={send}>
                {error && composerMode !== "group" && <Banner message={{ tone: "err", text: error }} />}
                <textarea
                  rows={2}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Write a message…"
                  aria-label="Message"
                />
                <div className="row-between">
                  <label className="btn-ghost" style={{ cursor: "pointer" }}>
                    Attach
                    <input
                      type="file"
                      hidden
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        setAttachName(file.name);
                        setError("");
                        e.target.value = "";
                      }}
                    />
                  </label>
                  {attachName && <span className="note">File: {attachName}</span>}
                  <button type="submit" className="btn">
                    Send
                  </button>
                </div>
              </form>
            </Card>
          )}
        </section>
      </div>
    </Page>
  );
}

/* ───────────────────────────── 3. ANNOUNCEMENTS ── */

export function AnnouncementsPage() {
  const { employee, demoProfile } = usePortal();
  const collab = useCollab();
  const [scope, setScope] = useState<AnnouncementScope | "">("");
  const [stateFilter, setStateFilter] = useState("");
  const [selectedId, setSelectedId] = useState(collab.announcements[0]?.id ?? "");
  const [publishError, setPublishError] = useState("");

  const actor = { id: employee.id, fullName: employee.fullName, role: demoProfile.role };
  const canManage = (a: (typeof collab.announcements)[number]) => canManageAnnouncement(a, actor);
  const isReadByMe = (a: (typeof collab.announcements)[number]) => a.readBy.includes(employee.id);

  // Drafts / scheduled posts are only visible to people who may manage them.
  const list = collab.announcements.filter((a) => {
    if (scope && a.scope !== scope) return false;
    if (stateFilter && a.state !== stateFilter) return false;
    if (a.state !== "Published" && !canManage(a)) return false;
    return true;
  });

  const selected = list.find((a) => a.id === selectedId) ?? list[0] ?? null;

  return (
    <Page title="Announcements">
      <FilterBar>
        <label className="filter-label">
          Scope
          <select value={scope} onChange={(e) => setScope(e.target.value as AnnouncementScope | "")}>
            <option value="">All</option>
            {(["Company", "Country", "Department", "Team"] as const).map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="filter-label">
          State
          <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
            <option value="">All</option>
            {(["Draft", "Scheduled", "Published"] as const).map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
      </FilterBar>

      <div className="collab-split">
        <Card title="Announcement list">
          {list.length === 0 ? (
            <EmptyState title="No announcements" description="Adjust scope or state filters." />
          ) : (
            <ul className="collab-list">
              {list.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    className={selected?.id === a.id ? "collab-list-item active" : "collab-list-item"}
                    onClick={() => {
                      setSelectedId(a.id);
                      setPublishError("");
                      if (a.state === "Published") markAnnouncementRead(a.id, employee.id);
                    }}
                  >
                    <strong>
                      {a.title} {!isReadByMe(a) && a.state === "Published" && <StatusBadge status="Unread" tone="warn" />}
                    </strong>
                    <span className="muted">
                      {a.scope} · {a.audience} · {a.state}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Details">
          {!selected ? (
            <EmptyState title="Select an announcement" description="Open an item to read it." />
          ) : (
            <div className="stack">
              <h2 style={{ margin: 0, fontSize: 18 }}>{selected.title}</h2>
              <div className="row-gap">
                <StatusBadge status={selected.state} />
                <StatusBadge status={selected.scope} tone="info" />
                {isReadByMe(selected) ? (
                  <StatusBadge status="Read" tone="ok" />
                ) : (
                  <StatusBadge status="Unread" tone="warn" />
                )}
              </div>
              <p className="muted">
                Audience: {selected.audience} · Author: {selected.author}
                {selected.publishedAt ? ` · Published ${formatWhen(selected.publishedAt)}` : ""}
                {selected.scheduledFor ? ` · Scheduled ${formatWhen(selected.scheduledFor)}` : ""}
              </p>
              <p>{selected.body}</p>
              {canManage(selected) && (
                <Field label="Publish state">
                  <select
                    value={selected.state}
                    onChange={(e) =>
                      setPublishError(
                        setAnnouncementState(selected.id, e.target.value as typeof selected.state, actor) ?? "",
                      )
                    }
                  >
                    {(["Draft", "Scheduled", "Published"] as const).map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </Field>
              )}
              {publishError && <Banner message={{ tone: "err", text: publishError }} />}
              {selected.state === "Published" && !isReadByMe(selected) && (
                <button type="button" className="btn" onClick={() => markAnnouncementRead(selected.id, employee.id)}>
                  Mark as read
                </button>
              )}
            </div>
          )}
        </Card>
      </div>
    </Page>
  );
}

/* ───────────────────────────── 4. NOTIFICATIONS ── */

// The Notification Center lives in its own file; re-exported here so existing imports keep working.
export { NotificationCenterPage } from "./NotificationCenter.tsx";

/* ───────────────────────────── 5. HELP & HR REQUESTS ── */

type HrQueueFilter = "open" | "mine" | "unassigned" | "overdue" | "all";

function formatDueAt(iso: string | undefined) {
  if (!iso) return "—";
  return formatWhen(iso);
}

/** Hours between two timestamps, rounded to one decimal. */
function hoursBetween(fromIso: string, toIso: string): number | null {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return (b - a) / 3_600_000;
}

function formatHours(h: number | null): string {
  if (h === null) return "—";
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} days`;
}

function HrDueCell({ request }: { request: HrRequest }) {
  const overdue = hrRequestOverdue(request);
  return (
    <span className="row-gap">
      <span>{formatDueAt(request.dueAt)}</span>
      {overdue && <StatusBadge status="Overdue" tone="danger" literal />}
    </span>
  );
}

export function HelpHrRequestsPage() {
  const { employee, demoProfile } = usePortal();
  const collab = useCollab();
  const [params, setParams] = useSearchParams();
  const hrView = isHrRole(demoProfile.role);
  const deskView = isHrDeskMember(employee.id, demoProfile.role);
  const actor = { id: employee.id, role: demoProfile.role, name: employee.fullName };
  const visible = useMemo(
    () => collab.hrRequests.filter((r) => hrRequestVisibleTo(r, employee.id, demoProfile.role)),
    [collab.hrRequests, employee.id, demoProfile.role],
  );
  const mine = useMemo(() => visible.filter((r) => r.requesterId === employee.id), [visible, employee.id]);
  const queue = useMemo(
    () => visible.filter((r) => r.requesterId !== employee.id && (hrView || r.assigneeId === employee.id)),
    [visible, employee.id, hrView],
  );
  // HR handles requests; they don't raise HR requests to themselves.
  const [tab, setTab] = useState(hrView ? "queue" : "request");
  const [queueFilter, setQueueFilter] = useState<HrQueueFilter>("open");
  const [category, setCategory] = useState<HrRequestCategory>("Documents");
  const [priority, setPriority] = useState<HrRequestPriority>("Normal");
  const [subject, setSubject] = useState("");
  const {
    value: description,
    setValue: setDescription,
    ref: descriptionRef,
    fill: fillDescription,
    fillIfEmpty: fillDescriptionIfEmpty,
    reset: resetDescription,
  } = useTemplatedText();
  const [formError, setFormError] = useState("");
  const [formOk, setFormOk] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [comment, setComment] = useState("");
  const [ticketError, setTicketError] = useState("");
  const [faqQ, setFaqQ] = useState("");

  // Deep link from a notification: /help?request=<id>
  const linkedId = params.get("request");
  useEffect(() => {
    if (!linkedId) return;
    const target = visible.find((r) => r.id === linkedId);
    if (target) {
      setSelectedId(target.id);
      setTab(target.requesterId === employee.id ? "history" : "queue");
      if (target.requesterId !== employee.id) setQueueFilter("all");
    }
    const next = new URLSearchParams(params);
    next.delete("request");
    setParams(next, { replace: true });
  }, [linkedId, visible, employee.id, params, setParams]);

  const queueRows = useMemo(() => {
    const now = Date.now();
    const rows = queue.filter((r) => {
      switch (queueFilter) {
        case "open":
          return r.status !== "Resolved" && r.status !== "Closed";
        case "mine":
          return r.assigneeId === employee.id && r.status !== "Resolved" && r.status !== "Closed";
        case "unassigned":
          return !r.assigneeId && r.status !== "Resolved" && r.status !== "Closed";
        case "overdue":
          return hrRequestOverdue(r, now);
        default:
          return true;
      }
    });
    // Overdue first, then the soonest due.
    return rows.sort((a, b) => {
      const oa = hrRequestOverdue(a, now) ? 0 : 1;
      const ob = hrRequestOverdue(b, now) ? 0 : 1;
      if (oa !== ob) return oa - ob;
      return (Date.parse(a.dueAt ?? "") || Infinity) - (Date.parse(b.dueAt ?? "") || Infinity);
    });
  }, [queue, queueFilter, employee.id]);

  const sla = useMemo(() => {
    const now = Date.now();
    const open = queue.filter((r) => r.status !== "Resolved" && r.status !== "Closed");
    const responses = queue
      .map((r) => (r.firstResponseAt && r.submittedAt ? hoursBetween(r.submittedAt, r.firstResponseAt) : null))
      .filter((h): h is number => h !== null);
    return {
      open: open.length,
      overdue: open.filter((r) => hrRequestOverdue(r, now)).length,
      unassigned: open.filter((r) => !r.assigneeId).length,
      avgFirstResponse: responses.length ? responses.reduce((s, h) => s + h, 0) / responses.length : null,
      responded: responses.length,
    };
  }, [queue]);

  const listForTab = tab === "queue" ? queue : mine;
  const selected = listForTab.find((r) => r.id === selectedId) ?? (tab === "queue" ? queueRows[0] : mine[0]) ?? null;
  const statusOptions = selected ? allowedHrStatuses(selected, employee.id, demoProfile.role) : [];
  const canReassign = selected ? canReassignHrRequest(selected, employee.id, demoProfile.role) : false;
  const canSetPriority = selected ? worksHrRequest(selected, employee.id, demoProfile.role) : false;

  const faqs = FAQ_ITEMS.filter((f) => {
    if (!faqQ) return true;
    return `${f.question} ${f.answer} ${f.topic}`.toLowerCase().includes(faqQ.toLowerCase());
  });

  function submitRequest(event: FormEvent) {
    event.preventDefault();
    if (!subject.trim() || !description.trim()) {
      setFormError("Subject and description are required.");
      setFormOk("");
      return;
    }
    if (hasTemplateBlanks(description)) {
      setFormError(TEMPLATE_BLANKS_ERROR);
      setFormOk("");
      return;
    }
    const id = createHrRequest({
      category,
      subject,
      description,
      author: employee.fullName,
      requesterId: employee.id,
      priority,
    });
    setSubject("");
    setPriority("Normal");
    resetDescription();
    setFormError("");
    setFormOk("Request submitted.");
    setSelectedId(id);
    setTab("history");
  }

  function openRequest(id: string) {
    setSelectedId(id);
    setTicketError("");
  }

  const route = HR_REQUEST_SLA[category] ?? HR_REQUEST_SLA.Other;

  const detail = (
    <Card title="Status & comments">
      {!selected ? (
        <EmptyState title="Select a request" description="View comments and update status." />
      ) : (
        <div className="stack">
          <h3 style={{ margin: 0 }}>{selected.subject}</h3>
          <p className="muted">
            {selected.category} · Created {selected.createdAt}
            {selected.requesterId !== employee.id && ` · Raised by ${selected.requesterName ?? "Unknown"}`}
          </p>
          <dl className="kv">
            <dt>Due</dt>
            <dd><HrDueCell request={selected} /></dd>
            <dt>Owner</dt>
            <dd>{hrDeskOwnerName(selected.assigneeId)}</dd>
            <dt>Priority</dt>
            <dd>{selected.priority ?? "Normal"}</dd>
            <dt>First response</dt>
            <dd>
              {selected.firstResponseAt
                ? `${formatWhen(selected.firstResponseAt)} (${formatHours(
                    selected.submittedAt ? hoursBetween(selected.submittedAt, selected.firstResponseAt) : null,
                  )})`
                : "Not yet"}
            </dd>
          </dl>
          {selected.status === "Waiting on you" && (
            <p className="muted">The due time is paused while HR waits for a reply.</p>
          )}
          {(canReassign || canSetPriority) && (
            <div className="row-gap">
              {canReassign && (
                <Field label="Owner">
                  <select
                    value={selected.assigneeId ?? ""}
                    onChange={(e) => setTicketError(assignHrRequest(selected.id, e.target.value, actor) ?? "")}
                  >
                    <option value="">Unassigned</option>
                    {HR_DESK_OWNERS.filter((o) => o.id !== selected.requesterId).map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.id === employee.id ? `${o.name} (me)` : o.name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {canSetPriority && (
                <Field label="Priority">
                  <select
                    value={selected.priority ?? "Normal"}
                    onChange={(e) =>
                      setTicketError(setHrRequestPriority(selected.id, e.target.value as HrRequestPriority, actor) ?? "")
                    }
                  >
                    {HR_REQUEST_PRIORITIES.map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
          )}
          {statusOptions.length > 0 ? (
            <Field label="Status">
              <select
                value={selected.status}
                onChange={(e) =>
                  setTicketError(setHrRequestStatus(selected.id, e.target.value as typeof selected.status, actor) ?? "")
                }
              >
                {[selected.status, ...statusOptions].map((s) => (
                  <option key={s} value={s}>
                    {selected.requesterId === employee.id && s === "In progress" && selected.status !== "In progress"
                      ? "Reopen"
                      : s}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <div className="row-gap">
              <StatusBadge status={selected.status} />
              <span className="muted">
                {selected.requesterId === employee.id && hrView
                  ? "You raised this request — another HR team member resolves it."
                  : "HR updates the status of this request."}
              </span>
            </div>
          )}
          <p>{selected.description}</p>
          <h4 className="collab-section-title">Comments</h4>
          <ul className="collab-timeline">
            {selected.comments.map((c, i) => (
              <li key={`${c.at}-${i}`}>
                <strong>{c.author}</strong>
                <div className="muted">{formatWhen(c.at)}</div>
                <div>{c.text}</div>
              </li>
            ))}
          </ul>
          {ticketError && <Banner message={{ tone: "err", text: ticketError }} />}
          <Field label="Add comment" wide>
            <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
          </Field>
          <button
            type="button"
            className="btn"
            disabled={!comment.trim()}
            onClick={() => {
              const failure = addHrComment(selected.id, employee.fullName, comment, actor);
              setTicketError(failure ?? "");
              if (!failure) setComment("");
            }}
          >
            Post comment
          </button>
        </div>
      )}
    </Card>
  );

  return (
    <Page title={hrView ? "HR requests" : "Helpdesk"}>
      <Tabs
        tabs={[
          ...(hrView ? [] : [{ id: "request", label: "New request" }, { id: "history", label: "Request history" }]),
          ...(deskView ? [{ id: "queue", label: "Request queue" }] : []),
          { id: "faq", label: "FAQ & policies" },
        ]}
        value={tab}
        onChange={(id) => {
          setTab(id);
          setSelectedId("");
          setTicketError("");
        }}
      />

      {tab === "request" && !hrView && (
        <Card title="HR service request">
          <form className="stack" onSubmit={submitRequest}>
            <Field label="Category">
              <select
                value={category}
                onChange={(e) => {
                  setCategory(e.target.value as HrRequestCategory);
                  fillDescription("hrRequest", e.target.value);
                }}
              >
                {HR_REQUEST_CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </Field>
            <Field label="Priority">
              <select value={priority} onChange={(e) => setPriority(e.target.value as HrRequestPriority)}>
                {HR_REQUEST_PRIORITIES.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </Field>
            <p className="muted">
              {category} requests go to {hrDeskOwnerName(route.ownerId)} and are due within {route.workingDays} working{" "}
              {route.workingDays === 1 ? "day" : "days"}.
            </p>
            <Field label="Subject">
              <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Short summary" />
            </Field>
            <Field label="Description" wide>
              <textarea
                ref={descriptionRef}
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onFocus={() => fillDescriptionIfEmpty("hrRequest", category)}
                placeholder="Describe your request…"
              />
            </Field>
            {formError && <Banner message={{ tone: "err", text: formError }} />}
            {formOk && <Banner message={{ tone: "ok", text: formOk }} />}
            <button type="submit" className="btn">
              Submit request
            </button>
          </form>
        </Card>
      )}

      {tab === "history" && !hrView && (
        <div className="collab-split">
          <Card title="My requests">
            {mine.length === 0 ? (
              <EmptyState title="No requests yet" description="Use the New request tab." />
            ) : (
              <DataTable
                headers={["Subject", "Category", "Status", "Due", "Updated", ""]}
                rows={mine.map((r) => [
                  r.subject,
                  r.category,
                  <StatusBadge key={r.id} status={r.status} />,
                  r.status === "Resolved" || r.status === "Closed" ? "—" : <HrDueCell key={`${r.id}-d`} request={r} />,
                  r.updatedAt,
                  <button key={`${r.id}-o`} type="button" className="quiet-link" onClick={() => openRequest(r.id)}>
                    Open
                  </button>,
                ])}
              />
            )}
          </Card>
          {detail}
        </div>
      )}

      {tab === "queue" && deskView && (
        <div className="stack">
          <MetricGrid>
            <MetricCard label="Open" value={sla.open} hint={`${sla.unassigned} unassigned`} />
            <MetricCard label="Overdue" value={sla.overdue} hint="Past the category due time" />
            <MetricCard
              label="Avg first response"
              value={formatHours(sla.avgFirstResponse)}
              hint={sla.responded ? `Across ${sla.responded} requests` : "No replies yet"}
            />
          </MetricGrid>
          <FilterBar>
            <label className="filter-label">
              Show
              <select value={queueFilter} onChange={(e) => setQueueFilter(e.target.value as HrQueueFilter)}>
                <option value="open">All open</option>
                <option value="mine">Assigned to me</option>
                <option value="unassigned">Unassigned</option>
                <option value="overdue">Overdue</option>
                <option value="all">All requests</option>
              </select>
            </label>
          </FilterBar>
          <div className="collab-split">
            <Card title="Requests from employees">
              {queueRows.length === 0 ? (
                <EmptyState title="Nothing in this view" description="Try another filter." />
              ) : (
                <DataTable
                  headers={["Subject", "Requester", "Category", "Priority", "Owner", "Due", "Status", ""]}
                  rows={queueRows.map((r) => [
                    r.subject,
                    r.requesterName ?? "Unknown",
                    r.category,
                    r.priority ?? "Normal",
                    hrDeskOwnerName(r.assigneeId),
                    r.status === "Resolved" || r.status === "Closed" ? "—" : <HrDueCell key={`${r.id}-d`} request={r} />,
                    <StatusBadge key={r.id} status={r.status} />,
                    <button key={`${r.id}-o`} type="button" className="quiet-link" onClick={() => openRequest(r.id)}>
                      Open
                    </button>,
                  ])}
                />
              )}
            </Card>
            {detail}
          </div>
        </div>
      )}

      {tab === "faq" && (
        <div className="stack">
          <FilterBar>
            <label className="filter-label">
              Search FAQ
              <input value={faqQ} onChange={(e) => setFaqQ(e.target.value)} placeholder="Leave, payslips, messaging…" />
            </label>
          </FilterBar>
          <Card title="Frequently asked questions">
            {faqs.length === 0 ? (
              <EmptyState title="No matches" description="Try another search term." />
            ) : (
              <ul className="todo">
                {faqs.map((f) => (
                  <li key={f.id}>
                    <strong>{f.question}</strong>
                    <div>{f.answer}</div>
                    <div className="muted">Topic: {f.topic}</div>
                    {f.policyLink && (
                      <Link to={f.policyLink} className="quiet-link">
                        Open related page
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Policy & quick links">
            <div className="auth-shortcut-row">
              <Link className="auth-shortcut" to="/policies">Policies</Link>
              <Link className="auth-shortcut" to="/leave">Leave</Link>
              <Link className="auth-shortcut" to="/benefits">Benefits</Link>
              <Link className="auth-shortcut" to="/documents">Documents</Link>
              <Link className="auth-shortcut" to="/payslips">Payslips</Link>
              <Link className="auth-shortcut" to="/info">My profile</Link>
            </div>
          </Card>
        </div>
      )}
    </Page>
  );
}

/** Route aliases matching existing App paths */
export function ApprovalsPage() {
  return <InboxApprovalsPage />;
}

export function ChatPage() {
  return <MessagingPage />;
}

export function HelpPage() {
  return <HelpHrRequestsPage />;
}

export function collabBadgeCounts() {
  return {
    approvals: countPendingInbox(),
    messages: countUnreadMessages(),
    notifications: countUnreadNotifications(),
  };
}
