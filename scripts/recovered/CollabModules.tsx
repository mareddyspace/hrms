import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from "react";
import { Link } from "react-router-dom";
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
  COLLAB_DISCLAIMER,
  FAQ_ITEMS,
  type AnnouncementScope,
  type ApprovalKind,
  type HrRequestCategory,
  type InboxTab,
} from "../data/collabData.ts";
import {
  addHrComment,
  countPendingInbox,
  countUnreadMessages,
  countUnreadNotifications,
  createHrRequest,
  decideInboxTask,
  delegateInboxTask,
  getCollabState,
  markAllNotificationsRead,
  markAnnouncementRead,
  markConversationRead,
  markNotificationRead,
  sendChatMessage,
  setAnnouncementState,
  setHrRequestStatus,
  setNotifPrefs,
  startDirectChat,
  subscribeCollab,
} from "../data/collabLocal.ts";
import { usePortal } from "../store.tsx";

function useCollab() {
  return useSyncExternalStore(subscribeCollab, getCollabState, getCollabState);
}

function formatWhen(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
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
    <Page
      title="Inbox and Approvals"
      subtitle="Unified approval queue · leave, timesheet, attendance, recruiting & documents"
    >
      <Banner message={{ tone: "ok", text: COLLAB_DISCLAIMER }} />
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
              <EmptyState title="Select a task" description="Choose an item from the list to review timeline and act." />
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
  const { employee } = usePortal();
  const collab = useCollab();
  const [filter, setFilter] = useState<"all" | "direct" | "group">("all");
  const [peopleQ, setPeopleQ] = useState("");
  const [activeId, setActiveId] = useState(collab.conversations[0]?.id ?? "");
  const [text, setText] = useState("");
  const [attachName, setAttachName] = useState<string | undefined>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setLoading(false), 240);
    return () => window.clearTimeout(t);
  }, []);

  const conversations = collab.conversations.filter(
    (c) => filter === "all" || c.kind === filter,
  );
  const active = conversations.find((c) => c.id === activeId) ?? conversations[0] ?? null;

  useEffect(() => {
    if (active) markConversationRead(active.id);
  }, [active?.id]);

  const people = CHAT_PEOPLE.filter((p) => {
    if (p.id === employee.id) return false;
    if (!peopleQ) return true;
    return `${p.name} ${p.title} ${p.department}`.toLowerCase().includes(peopleQ.toLowerCase());
  });

  function send(event: FormEvent) {
    event.preventDefault();
    if (!active) {
      setError("Select or start a conversation first.");
      return;
    }
    if (!text.trim() && !attachName) {
      setError("Type a message or attach a demo file.");
      return;
    }
    setError("");
    sendChatMessage(active.id, employee.id, employee.fullName, text.trim() || `(Attachment) ${attachName}`, attachName);
    setText("");
    setAttachName(undefined);
  }

  return (
    <Page title="Messages" subtitle="Internal messaging demo · not real-time and not emailed">
      <Banner message={{ tone: "ok", text: COLLAB_DISCLAIMER }} />

      {loading ? (
        <Card><p className="note">Loading conversations…</p></Card>
      ) : (
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
              {conversations.length === 0 ? (
                <EmptyState title="No conversations" description="Start a chat from the people directory." />
              ) : (
                <ul className="collab-list">
                  {conversations.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        className={active?.id === c.id ? "collab-list-item active" : "collab-list-item"}
                        onClick={() => setActiveId(c.id)}
                      >
                        <strong>
                          {c.title}{" "}
                          {c.unread > 0 && <StatusBadge status={`${c.unread} new`} tone="warn" />}
                        </strong>
                        <span className="muted">
                          {c.kind === "group" ? "Group" : "Direct"} · {c.messages.at(-1)?.text.slice(0, 48) ?? "No messages yet"}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="People directory">
              <label className="filter-label">
                Search people
                <input value={peopleQ} onChange={(e) => setPeopleQ(e.target.value)} placeholder="Name or department…" />
              </label>
              {people.length === 0 ? (
                <EmptyState title="No people found" description="Try a different search." />
              ) : (
                <ul className="collab-list">
                  {people.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        className="collab-list-item"
                        onClick={() => {
                          const id = startDirectChat(p.id, p.name, employee.id, employee.fullName);
                          setActiveId(id);
                          setFilter("direct");
                        }}
                      >
                        <strong>{p.name}</strong>
                        <span className="muted">
                          {p.title} · {p.department}
                        </span>
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
                <EmptyState title="No conversation selected" description="Pick a thread or start a one-to-one chat." />
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
                {showDetails && (
                  <div className="msg-details">
                    <p>
                      <strong>Type:</strong> {active.kind === "group" ? "Group" : "One-to-one"}
                    </p>
                    <p>
                      <strong>Participants:</strong> {active.participantNames.join(", ")}
                    </p>
                  </div>
                )}

                <div className="msg-thread" role="log" aria-live="polite">
                  {active.messages.length === 0 ? (
                    <EmptyState title="No messages yet" description="Say hello — stored in local demo state only." />
                  ) : (
                    active.messages.map((m) => (
                      <div
                        key={m.id}
                        className={m.fromId === employee.id ? "msg-bubble mine" : "msg-bubble"}
                      >
                        <div className="msg-meta">
                          <strong>{m.fromName}</strong>
                          <span className="muted">{formatWhen(m.at)}</span>
                          {!m.read && m.fromId !== employee.id && <StatusBadge status="Unread" tone="warn" />}
                        </div>
                        <p>{m.text}</p>
                        {m.attachmentName && (
                          <p className="note">Attachment (demo): {m.attachmentName}</p>
                        )}
                      </div>
                    ))
                  )}
                </div>

                <form className="msg-composer" onSubmit={send}>
                  {error && <Banner message={{ tone: "err", text: error }} />}
                  <textarea
                    rows={2}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="Write a message…"
                    aria-label="Message"
                  />
                  <div className="row-between">
                    <label className="btn-ghost" style={{ cursor: "pointer" }}>
                      Attach (demo)
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
                    {attachName && <span className="note">Demo file: {attachName}</span>}
                    <button type="submit" className="btn">
                      Send
                    </button>
                  </div>
                  <p className="note">Attachments are metadata-only in this prototype — no cloud storage.</p>
                </form>
              </Card>
            )}
          </section>
        </div>
      )}
    </Page>
  );
}

/* ───────────────────────────── 3. ANNOUNCEMENTS ── */

export function AnnouncementsPage() {
  const { demoProfile } = usePortal();
  const collab = useCollab();
  const [scope, setScope] = useState<AnnouncementScope | "">("");
  const [stateFilter, setStateFilter] = useState("");
  const [selectedId, setSelectedId] = useState(collab.announcements[0]?.id ?? "");

  const canPublish =
    demoProfile.role === "hr_admin" ||
    demoProfile.role === "hr" ||
    demoProfile.role === "super_admin" ||
    demoProfile.role === "manager";

  const list = collab.announcements.filter((a) => {
    if (scope && a.scope !== scope) return false;
    if (stateFilter && a.state !== stateFilter) return false;
    if (!canPublish && a.state === "Draft") return false;
    return true;
  });

  const selected = list.find((a) => a.id === selectedId) ?? list[0] ?? null;

  return (
    <Page title="Announcements" subtitle="Company, country, department and team communications (demo)">
      <Banner message={{ tone: "ok", text: COLLAB_DISCLAIMER }} />
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
                      if (a.state === "Published") markAnnouncementRead(a.id);
                    }}
                  >
                    <strong>
                      {a.title} {!a.readByMe && a.state === "Published" && <StatusBadge status="Unread" tone="warn" />}
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
            <EmptyState title="Select an announcement" description="Open an item to read full details." />
          ) : (
            <div className="stack">
              <h2 style={{ margin: 0, fontSize: 18 }}>{selected.title}</h2>
              <div className="row-gap">
                <StatusBadge status={selected.state} />
                <StatusBadge status={selected.scope} tone="info" />
                {selected.readByMe ? (
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
              {canPublish && (
                <Field label="Demo publish controls">
                  <select
                    value={selected.state}
                    onChange={(e) =>
                      setAnnouncementState(selected.id, e.target.value as typeof selected.state)
                    }
                  >
                    {(["Draft", "Scheduled", "Published"] as const).map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </Field>
              )}
              {selected.state === "Published" && !selected.readByMe && (
                <button type="button" className="btn" onClick={() => markAnnouncementRead(selected.id)}>
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

export function NotificationCenterPage() {
  const collab = useCollab();
  const [category, setCategory] = useState("");
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [prefs, setPrefs] = useState(collab.prefs);

  useEffect(() => {
    setPrefs(collab.prefs);
  }, [collab.prefs]);

  const list = collab.notifications.filter((n) => {
    if (category && n.category !== category) return false;
    const key = n.category.toLowerCase() as keyof typeof prefs;
    if (key in prefs && prefs[key] === false) return false;
    // Map Announcements category
    if (n.category === "Announcements" && !prefs.announcements) return false;
    if (n.category === "Leave" && !prefs.leave) return false;
    if (n.category === "Timesheet" && !prefs.timesheet) return false;
    if (n.category === "Messages" && !prefs.messages) return false;
    if (n.category === "Holidays" && !prefs.holidays) return false;
    if (n.category === "Learning" && !prefs.learning) return false;
    if (n.category === "Performance" && !prefs.performance) return false;
    return true;
  });

  const unread = collab.notifications.filter((n) => !n.read).length;

  return (
    <Page
      title="Notification Center"
      subtitle="Approvals, messages, holidays, learning, performance and HR updates"
      action={
        <div className="row-gap">
          <button type="button" className="btn-ghost" onClick={() => setPrefsOpen((v) => !v)}>
            Preferences
          </button>
          <button type="button" className="btn" onClick={() => markAllNotificationsRead()} disabled={unread === 0}>
            Mark all as read
          </button>
        </div>
      }
    >
      <Banner message={{ tone: "ok", text: COLLAB_DISCLAIMER }} />
      <MetricGrid>
        <MetricCard label="Unread" value={unread} />
        <MetricCard label="Total" value={collab.notifications.length} />
        <MetricCard label="Pending approvals" value={countPendingInbox()} hint="Open Inbox" />
        <MetricCard label="Unread messages" value={countUnreadMessages()} hint="Open Messages" />
      </MetricGrid>

      {prefsOpen && (
        <Card title="Notification preferences (local demo)">
          <div className="form-grid-2">
            {(
              [
                ["leave", "Leave approvals"],
                ["timesheet", "Timesheet updates"],
                ["messages", "New messages"],
                ["holidays", "Upcoming holidays"],
                ["learning", "Learning deadlines"],
                ["performance", "Performance reminders"],
                ["announcements", "HR announcements"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="filter-label" style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={prefs[key]}
                  onChange={(e) => setPrefs({ ...prefs, [key]: e.target.checked })}
                />
                {label}
              </label>
            ))}
          </div>
          <button
            type="button"
            className="btn"
            style={{ marginTop: 12 }}
            onClick={() => {
              setNotifPrefs(prefs);
              setPrefsOpen(false);
            }}
          >
            Save preferences
          </button>
        </Card>
      )}

      <FilterBar>
        <label className="filter-label">
          Category
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All</option>
            {(["Leave", "Timesheet", "Messages", "Holidays", "Learning", "Performance", "Announcements"] as const).map(
              (c) => (
                <option key={c} value={c}>{c}</option>
              ),
            )}
          </select>
        </label>
      </FilterBar>

      <Card title="Notifications">
        {list.length === 0 ? (
          <EmptyState title="No notifications" description="You're caught up, or preferences are filtering everything out." />
        ) : (
          <ul className="collab-list">
            {list.map((n) => (
              <li key={n.id}>
                <div className={n.read ? "collab-list-item" : "collab-list-item active"} style={{ cursor: "default" }}>
                  <div className="row-between" style={{ width: "100%", gap: 8 }}>
                    <div>
                      <strong>
                        {n.title} {!n.read && <StatusBadge status="Unread" tone="warn" />}
                      </strong>
                      <div className="muted">
                        {n.category} · {formatWhen(n.at)}
                      </div>
                      <p style={{ margin: "6px 0 0" }}>{n.body}</p>
                    </div>
                    <div className="row-gap">
                      {n.href && (
                        <Link to={n.href} className="quiet-link">
                          Open
                        </Link>
                      )}
                      {!n.read && (
                        <button type="button" className="btn-ghost" onClick={() => markNotificationRead(n.id)}>
                          Mark read
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Page>
  );
}

/* ───────────────────────────── 5. HELP & HR REQUESTS ── */

export function HelpHrRequestsPage() {
  const { employee } = usePortal();
  const collab = useCollab();
  const [tab, setTab] = useState("request");
  const [category, setCategory] = useState<HrRequestCategory>("Documents");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [formError, setFormError] = useState("");
  const [formOk, setFormOk] = useState("");
  const [selectedId, setSelectedId] = useState(collab.hrRequests[0]?.id ?? "");
  const [comment, setComment] = useState("");
  const [faqQ, setFaqQ] = useState("");

  const selected = collab.hrRequests.find((r) => r.id === selectedId) ?? collab.hrRequests[0] ?? null;

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
    createHrRequest({
      category,
      subject,
      description,
      author: employee.fullName,
    });
    setSubject("");
    setDescription("");
    setFormError("");
    setFormOk("Request submitted to local demo queue — HR will not receive a real email.");
    setTab("history");
  }

  return (
    <Page title="Help & HR Requests" subtitle="Service desk demo · FAQ, policies and request history">
      <Banner message={{ tone: "ok", text: COLLAB_DISCLAIMER }} />

      <Tabs
        tabs={[
          { id: "request", label: "New request" },
          { id: "history", label: "Request history" },
          { id: "faq", label: "FAQ & policies" },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "request" && (
        <Card title="HR service request">
          <form className="stack" onSubmit={submitRequest}>
            <Field label="Category">
              <select value={category} onChange={(e) => setCategory(e.target.value as HrRequestCategory)}>
                {(
                  [
                    "Payroll provider",
                    "Benefits",
                    "Documents",
                    "Leave",
                    "Profile correction",
                    "Other",
                  ] as const
                ).map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </Field>
            <Field label="Subject">
              <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Short summary" />
            </Field>
            <Field label="Description" wide>
              <textarea
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
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

      {tab === "history" && (
        <div className="collab-split">
          <Card title="My requests">
            {collab.hrRequests.length === 0 ? (
              <EmptyState title="No requests yet" description="Submit a service request from the New request tab." />
            ) : (
              <DataTable
                headers={["Subject", "Category", "Status", "Updated", ""]}
                rows={collab.hrRequests.map((r) => [
                  r.subject,
                  r.category,
                  <StatusBadge key={r.id} status={r.status} />,
                  r.updatedAt,
                  <button key={`${r.id}-o`} type="button" className="quiet-link" onClick={() => setSelectedId(r.id)}>
                    Open
                  </button>,
                ])}
              />
            )}
          </Card>
          <Card title="Status & comments">
            {!selected ? (
              <EmptyState title="Select a request" description="View comments and update status." />
            ) : (
              <div className="stack">
                <h3 style={{ margin: 0 }}>{selected.subject}</h3>
                <p className="muted">
                  {selected.category} · Created {selected.createdAt}
                </p>
                <Field label="Status">
                  <select
                    value={selected.status}
                    onChange={(e) => setHrRequestStatus(selected.id, e.target.value as typeof selected.status)}
                  >
                    {(["Open", "In progress", "Waiting on you", "Resolved", "Closed"] as const).map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </Field>
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
                <Field label="Add comment" wide>
                  <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
                </Field>
                <button
                  type="button"
                  className="btn"
                  disabled={!comment.trim()}
                  onClick={() => {
                    addHrComment(selected.id, employee.fullName, comment.trim());
                    setComment("");
                  }}
                >
                  Post comment
                </button>
              </div>
            )}
          </Card>
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
              <Link className="auth-shortcut" to="/info">My Profile</Link>
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
