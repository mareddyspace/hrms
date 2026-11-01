import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ActionButton, EmptyState, Page, SubmitButton, notify as toast, useAction } from "../components/ui.tsx";
import { usePortal } from "../store.tsx";
import { managementChain } from "../demoAccounts.ts";
import { allReportIds, getPerson } from "../data/peopleLocal.ts";
import { pushPersonTaskAlert } from "../data/collabLocal.ts";
import { API_ENABLED } from "../api/client.ts";
import {
  MAIL_CATEGORIES,
  deleteDraft,
  inboxThreads,
  mailtoHref,
  markThreadRead,
  saveDraft,
  sendMailShared,
  sentThreads,
  threadFor,
  useDrafts,
  useMail,
} from "../data/mailStore.ts";
import type { MailCategory, MailDraft, MailMessage, MailThread } from "../data/mailStore.ts";
import { applyAll, applySuggestion, checkWriting, type WritingSuggestion } from "../data/writingCheck.ts";
import "./mail.css";

const HR_ID = "demo-hr-admin";

const TEMPLATES: { label: string; subject: string; category: MailCategory }[] = [
  { label: "Leave request discussion", subject: "Leave request discussion", category: "Leave" },
  { label: "Attendance issue", subject: "Attendance issue", category: "Attendance" },
  { label: "Work from home request", subject: "Work from home request", category: "Work from home" },
  { label: "General", subject: "", category: "General" },
];

/** People who lead others (managers, HR, executives, admin) write about the team, not to "my manager". */
const LEAD_TEMPLATES: { label: string; subject: string; category: MailCategory }[] = [
  { label: "Team update", subject: "Team update", category: "General" },
  { label: "Leave decision", subject: "About your leave request", category: "Leave" },
  { label: "Meeting request", subject: "Meeting request", category: "General" },
  { label: "General", subject: "", category: "General" },
];

type Folder = "inbox" | "sent" | "drafts" | "compose";
type Recipient = { id: string; name: string; email: string; group: string };

/** What the compose view is editing. */
interface ComposeState {
  draftId?: string;
  toIds: string[];
  ccIds: string[];
  subject: string;
  body: string;
  category: MailCategory;
  threadId?: string;
  /** Shown above the form: "Reply", "Forward", … */
  mode: "new" | "reply" | "all" | "forward" | "draft";
}

const emptyCompose = (): ComposeState => ({ toIds: [], ccIds: [], subject: "", body: "", category: "General", mode: "new" });

function fullStamp(iso: string, timeZone: string): string {
  try {
    return new Date(iso).toLocaleString("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

function listStamp(iso: string, timeZone: string): string {
  try {
    const d = new Date(iso);
    const day = (x: Date) => x.toLocaleDateString("en-CA", { timeZone });
    if (day(d) === day(new Date())) return d.toLocaleTimeString("en-GB", { timeZone, hour: "2-digit", minute: "2-digit" });
    return d.toLocaleDateString("en-GB", { timeZone, day: "numeric", month: "short" });
  } catch {
    return iso;
  }
}

const prefixed = (prefix: "Re" | "Fwd", subject: string) =>
  new RegExp(`^${prefix}:`, "i").test(subject) ? subject : `${prefix}: ${subject}`;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

export function MailPage() {
  const { employee, demoAccounts, demoProfile } = usePortal();
  const messages = useMail();
  const drafts = useDrafts(employee.id);
  const [params, setParams] = useSearchParams();
  const me = employee.id;
  const tz = employee.timeZone;

  const nameOf = (id: string) => (id === me ? employee.fullName : getPerson(id)?.fullName ?? demoAccounts.find((a) => a.id === id)?.fullName ?? id);
  const emailOf = (id: string) => getPerson(id)?.email ?? demoAccounts.find((a) => a.id === id)?.email ?? "";
  const canSignIn = (id: string) => demoAccounts.some((a) => a.id === id);

  const chain = useMemo(() => managementChain(me, demoAccounts), [me, demoAccounts]);
  const manager = chain[0];
  const leadsOthers =
    demoProfile.role !== "employee" || allReportIds(me).length > 0 || demoAccounts.some((a) => a.reportsToId === me);
  const templates = leadsOthers ? LEAD_TEMPLATES : TEMPLATES;

  /** Reporting line above, HR, and (for managers) the people below. Not the whole company. */
  const recipients = useMemo<Recipient[]>(() => {
    const out: Recipient[] = [];
    const seen = new Set<string>([me]);
    const add = (id: string, name: string, group: string) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      out.push({ id, name, email: getPerson(id)?.email ?? demoAccounts.find((a) => a.id === id)?.email ?? "", group });
    };
    chain.forEach((m, i) => add(m.id, m.fullName, i === 0 ? "My manager" : "Reporting line"));
    add(HR_ID, getPerson(HR_ID)?.fullName ?? demoAccounts.find((a) => a.id === HR_ID)?.fullName ?? "HR", "HR");
    const reports = [...allReportIds(me), ...demoAccounts.filter((a) => a.reportsToId === me).map((a) => a.id)];
    reports.forEach((id) => add(id, getPerson(id)?.fullName ?? demoAccounts.find((a) => a.id === id)?.fullName ?? id, "My team"));
    return out;
  }, [chain, me, demoAccounts]);
  // Anyone already in a thread with me can be written to as well (reply / forward to them).
  const knownIds = useMemo(() => {
    const ids = new Set(recipients.map((r) => r.id));
    for (const m of messages) if (m.fromId === me || m.toIds.includes(me) || m.ccIds.includes(me)) [m.fromId, ...m.toIds, ...m.ccIds].forEach((id) => ids.add(id));
    ids.delete(me);
    return ids;
  }, [recipients, messages, me]);
  const pickable = useMemo(() => {
    const extra = [...knownIds].filter((id) => !recipients.some((r) => r.id === id)).map((id) => ({ id, name: nameOf(id), email: emailOf(id), group: "Recent" }));
    return [...recipients, ...extra];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipients, knownIds]);

  const threadParam = params.get("thread");
  const [folder, setFolder] = useState<Folder>(() => (params.get("compose") || params.get("to") ? "compose" : "inbox"));
  const [openId, setOpenId] = useState<string | null>(threadParam);
  const [query, setQuery] = useState("");
  const [compose, setCompose] = useState<ComposeState>(emptyCompose);

  // Deep links: /mail?thread=…, /mail?compose=manager&subject=…, /mail?to=<id>
  useEffect(() => {
    if (threadParam) {
      setOpenId(threadParam);
      setFolder(messages.some((m) => m.threadId === threadParam && m.fromId !== me) ? "inbox" : "sent");
    }
    const c = params.get("compose");
    const to = params.get("to");
    if (c || to) {
      const target = to && recipients.some((r) => r.id === to) ? to : c === "manager" ? manager?.id ?? "" : "";
      setCompose({ ...emptyCompose(), toIds: target ? [target] : [], subject: (params.get("subject") ?? "").slice(0, 120) });
      setFolder("compose");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const inbox = useMemo(() => inboxThreads(messages, me), [messages, me]);
  const sent = useMemo(() => sentThreads(messages, me), [messages, me]);
  const unread = inbox.reduce((n, t) => n + t.unread, 0);
  const open = openId ? threadFor(messages, me, openId) : undefined;

  useEffect(() => {
    if (open && open.unread > 0) markThreadRead(open.threadId, me);
  }, [open, me]);

  const needle = query.trim().toLowerCase();
  const matchesThread = (t: MailThread) =>
    !needle ||
    `${t.subject} ${t.messages.map((m) => `${m.fromName} ${m.body} ${m.toIds.map(nameOf).join(" ")}`).join(" ")}`.toLowerCase().includes(needle);
  const list = (folder === "sent" ? sent : inbox).filter(matchesThread);
  const draftList = drafts.filter((d) => !needle || `${d.subject} ${d.body} ${d.toIds.map(nameOf).join(" ")}`.toLowerCase().includes(needle));

  function go(next: Folder) {
    setFolder(next);
    if (next !== "compose") setOpenId(null);
    if (params.toString()) setParams({}, { replace: true });
  }

  function startNew(to?: string) {
    setCompose({ ...emptyCompose(), toIds: to ? [to] : [] });
    setFolder("compose");
  }

  function startFrom(thread: MailThread, mode: "reply" | "all" | "forward") {
    const latest = thread.latest;
    const quote = `\n\n----- ${mode === "forward" ? "Forwarded message" : "Original message"} -----\nFrom: ${latest.fromName}\nDate: ${fullStamp(latest.sentAt, tz)}\nSubject: ${latest.subject}\nTo: ${latest.toIds.map(nameOf).join(", ")}\n\n${latest.body}`;
    if (mode === "forward") {
      setCompose({ ...emptyCompose(), subject: prefixed("Fwd", thread.subject), body: quote, category: thread.category ?? "General", mode });
    } else {
      const replyTo = latest.fromId === me ? latest.toIds : [latest.fromId];
      const everyone = [...new Set([latest.fromId, ...latest.toIds, ...latest.ccIds])].filter((id) => id !== me && !replyTo.includes(id));
      setCompose({
        ...emptyCompose(),
        toIds: replyTo,
        ccIds: mode === "all" ? everyone : [],
        subject: prefixed("Re", thread.subject),
        body: quote,
        category: thread.category ?? "General",
        threadId: thread.threadId,
        mode,
      });
    }
    setFolder("compose");
  }

  function openDraft(d: MailDraft) {
    setCompose({ draftId: d.id, toIds: d.toIds, ccIds: d.ccIds, subject: d.subject, body: d.body, category: d.category ?? "General", threadId: d.threadId, mode: "draft" });
    setFolder("compose");
  }

  function notifyLocal(ids: string[], subj: string, threadId: string) {
    if (API_ENABLED) return; // the server notifies the recipients
    for (const id of ids) {
      if (!canSignIn(id)) continue;
      pushPersonTaskAlert({ recipientId: id, title: `New mail from ${employee.fullName}`, body: subj, href: `/mail?thread=${encodeURIComponent(threadId)}` });
    }
  }

  return (
    <Page title="Mail">
      <div className="mx-shell">
        <nav className="mx-folders" aria-label="Mail folders">
          <button type="button" className="btn mx-compose-btn" onClick={() => startNew(leadsOthers ? undefined : manager?.id)}>
            Compose
          </button>
          {(
            [
              ["inbox", "Inbox", unread],
              ["sent", "Sent", 0],
              ["drafts", "Drafts", drafts.length],
            ] as const
          ).map(([id, label, count]) => (
            <button key={id} type="button" className={folder === id ? "mx-folder active" : "mx-folder"} aria-current={folder === id ? "page" : undefined} onClick={() => go(id)}>
              <span>{label}</span>
              {count > 0 && <span className={id === "inbox" ? "mx-count strong" : "mx-count"}>{count}</span>}
            </button>
          ))}
          <p className="mx-tz">Times in {tz}</p>
        </nav>

        {folder === "compose" ? (
          <ComposeView
            key={`${compose.draftId ?? ""}${compose.mode}${compose.threadId ?? ""}${compose.subject}`}
            initial={compose}
            me={me}
            myName={employee.fullName}
            pickable={pickable}
            templates={templates}
            nameOf={nameOf}
            emailOf={emailOf}
            canSignIn={canSignIn}
            onSent={(m) => {
              notifyLocal([...m.toIds, ...m.ccIds], m.subject, m.threadId);
              setOpenId(m.threadId);
              setFolder("sent");
            }}
            onClosed={() => go(compose.mode === "draft" ? "drafts" : "inbox")}
          />
        ) : (
          <>
            <section className="mx-list" aria-label={folder}>
              <div className="mx-list-head">
                <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${folder}`} aria-label={`Search ${folder}`} />
              </div>
              {folder === "drafts" ? (
                draftList.length === 0 ? (
                  <EmptyState title="No drafts" />
                ) : (
                  <ul className="mx-rows">
                    {draftList.map((d) => (
                      <li key={d.id}>
                        <button type="button" className="mx-row" onClick={() => openDraft(d)}>
                          <span className="mx-avatar draft" aria-hidden>
                            ✎
                          </span>
                          <span className="mx-row-body">
                            <span className="mx-row-top">
                              <span className="mx-from mx-draft-label">Draft{d.toIds.length ? ` · To ${d.toIds.map(nameOf).join(", ")}` : ""}</span>
                              <span className="mx-date">{listStamp(d.updatedAt, tz)}</span>
                            </span>
                            <span className="mx-subject">{d.subject || "(no subject)"}</span>
                            <span className="mx-snippet">{d.body.replace(/\s+/g, " ").slice(0, 100) || "No text"}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )
              ) : list.length === 0 ? (
                <EmptyState
                  title={needle ? "No mail matches" : folder === "sent" ? "Nothing sent yet" : "Inbox is empty"}
                  action={
                    <button className="btn-ghost" type="button" onClick={() => startNew()}>
                      Compose
                    </button>
                  }
                />
              ) : (
                <ul className="mx-rows">
                  {list.map((t) => {
                    const latest = t.latest;
                    const who =
                      folder === "sent"
                        ? `To: ${[...new Set(t.messages.filter((m) => m.fromId === me).flatMap((m) => m.toIds))].map(nameOf).join(", ")}`
                        : latest.fromId === me
                          ? `Me, ${t.messages.find((m) => m.fromId !== me)?.fromName ?? ""}`
                          : latest.fromName;
                    return (
                      <li key={t.threadId}>
                        <button type="button" className={`mx-row${t.threadId === openId ? " active" : ""}${t.unread ? " unread" : ""}`} onClick={() => setOpenId(t.threadId)}>
                          <span className="mx-avatar" aria-hidden>
                            {initials(folder === "sent" ? nameOf(latest.toIds[0] ?? "") : latest.fromId === me ? employee.fullName : latest.fromName)}
                          </span>
                          <span className="mx-row-body">
                            <span className="mx-row-top">
                              <span className="mx-from">
                                {who}
                                {t.messages.length > 1 && <span className="mx-thread-n">{t.messages.length}</span>}
                              </span>
                              <span className="mx-date">{listStamp(latest.sentAt, tz)}</span>
                            </span>
                            <span className="mx-subject">{t.subject}</span>
                            <span className="mx-snippet">{latest.body.replace(/\s+/g, " ").slice(0, 110)}</span>
                            {t.category && <span className="mx-cat">{t.category}</span>}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section className="mx-reader" aria-label="Message">
              {folder === "drafts" ? (
                <EmptyState title="Open a draft to keep writing" />
              ) : open ? (
                <ThreadView thread={open} me={me} tz={tz} nameOf={nameOf} emailOf={emailOf} onReply={(mode) => startFrom(open, mode)} />
              ) : (
                <EmptyState title="Select a message" />
              )}
            </section>
          </>
        )}
      </div>
    </Page>
  );
}

function ThreadView({
  thread,
  me,
  tz,
  nameOf,
  emailOf,
  onReply,
}: {
  thread: MailThread;
  me: string;
  tz: string;
  nameOf: (id: string) => string;
  emailOf: (id: string) => string;
  onReply: (mode: "reply" | "all" | "forward") => void;
}) {
  const latest = thread.latest;
  const others = [...new Set([latest.fromId, ...latest.toIds, ...latest.ccIds])].filter((id) => id !== me);
  const [expanded, setExpanded] = useState<string>(latest.id);
  return (
    <div className="mx-thread">
      <header className="mx-thread-head">
        <h2>{thread.subject}</h2>
        {thread.category && <span className="mx-cat">{thread.category}</span>}
      </header>
      <ol className="mx-msgs">
        {thread.messages.map((m: MailMessage) => {
          const isOpen = expanded === m.id || m.id === latest.id;
          return (
            <li key={m.id} className={isOpen ? "mx-msg open" : "mx-msg"}>
              <button type="button" className="mx-msg-head" onClick={() => setExpanded(isOpen && m.id !== latest.id ? "" : m.id)} aria-expanded={isOpen}>
                <span className="mx-avatar" aria-hidden>
                  {initials(m.fromName)}
                </span>
                <span className="mx-msg-who">
                  <strong>{m.fromId === me ? `${m.fromName} (me)` : m.fromName}</strong>
                  {emailOf(m.fromId) && <span className="muted"> &lt;{emailOf(m.fromId)}&gt;</span>}
                  {!isOpen && <span className="mx-snippet"> {m.body.replace(/\s+/g, " ").slice(0, 80)}</span>}
                </span>
                <span className="mx-date">{fullStamp(m.sentAt, tz)}</span>
              </button>
              {isOpen && (
                <>
                  <dl className="mx-fields">
                    <dt>From</dt>
                    <dd>{m.fromName}</dd>
                    <dt>To</dt>
                    <dd>{m.toIds.map((id) => (id === me ? "me" : nameOf(id))).join(", ")}</dd>
                    {m.ccIds.length > 0 && (
                      <>
                        <dt>Cc</dt>
                        <dd>{m.ccIds.map((id) => (id === me ? "me" : nameOf(id))).join(", ")}</dd>
                      </>
                    )}
                    <dt>Date</dt>
                    <dd>{fullStamp(m.sentAt, tz)}</dd>
                    <dt>Subject</dt>
                    <dd>{m.subject}</dd>
                  </dl>
                  <div className="mx-body">{m.body}</div>
                </>
              )}
            </li>
          );
        })}
      </ol>
      <div className="mx-reply-bar">
        <button type="button" className="btn" onClick={() => onReply("reply")}>
          Reply
        </button>
        {others.length > 1 && (
          <button type="button" className="btn-ghost" onClick={() => onReply("all")}>
            Reply all
          </button>
        )}
        <button type="button" className="btn-ghost" onClick={() => onReply("forward")}>
          Forward
        </button>
      </div>
    </div>
  );
}

function ComposeView({
  initial,
  me,
  myName,
  pickable,
  templates,
  nameOf,
  emailOf,
  canSignIn,
  onSent,
  onClosed,
}: {
  initial: ComposeState;
  me: string;
  myName: string;
  pickable: Recipient[];
  templates: { label: string; subject: string; category: MailCategory }[];
  nameOf: (id: string) => string;
  emailOf: (id: string) => string;
  canSignIn: (id: string) => boolean;
  onSent: (m: MailMessage) => void;
  onClosed: () => void;
}) {
  const [c, setC] = useState<ComposeState>(initial);
  const [error, setError] = useState("");
  const [showCc, setShowCc] = useState(initial.ccIds.length > 0);
  const [picked, setPicked] = useState("");
  const [check, setCheck] = useState<{ source: "ai" | "rules"; items: WritingSuggestion[]; text: string } | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const sendAction = useAction();
  const groups = [...new Set(pickable.map((r) => r.group))];
  const ids = useMemo(() => new Set(pickable.map((r) => r.id)), [pickable]);
  const dirty = c.subject.trim() !== "" || c.body.trim() !== "" || c.toIds.length > 0;

  useEffect(() => {
    // Replies open with the cursor above the quoted text.
    if (initial.mode === "reply" || initial.mode === "all" || initial.mode === "forward") {
      bodyRef.current?.focus();
      bodyRef.current?.setSelectionRange(0, 0);
    }
  }, [initial.mode]);

  const set = (patch: Partial<ComposeState>) => {
    setC((prev) => ({ ...prev, ...patch }));
    if (patch.body !== undefined) setCheck(null);
  };

  const addPerson = (field: "toIds" | "ccIds", id: string) => {
    if (!id) return;
    setC((prev) => ({ ...prev, [field]: prev[field].includes(id) ? prev[field] : [...prev[field], id] }));
  };
  const removePerson = (field: "toIds" | "ccIds", id: string) => setC((prev) => ({ ...prev, [field]: prev[field].filter((x) => x !== id) }));

  async function send() {
    setError("");
    const fail = (t: string) => {
      setError(t);
      return false;
    };
    if (c.toIds.length === 0) return fail("Add at least one recipient.");
    if (!c.subject.trim()) return fail("Add a subject.");
    if (!c.body.trim()) return fail("Write a message.");
    if (c.toIds.some((id) => !ids.has(id))) return fail("You can only write to your reporting line, HR, your team or people already in your mail.");
    const message = await sendMailShared({
      fromId: me,
      fromName: myName,
      toIds: c.toIds,
      ccIds: c.ccIds.filter((id) => ids.has(id)),
      subject: c.subject,
      body: c.body,
      category: c.category,
      threadId: c.threadId,
    });
    if (typeof message === "string") return fail(message);
    if (c.draftId) await deleteDraft(c.draftId);
    toast(`Mail sent to ${[...message.toIds, ...message.ccIds].map(nameOf).join(", ")}.`);
    onSent(message);
    return true;
  }

  async function save() {
    const out = await saveDraft({ id: c.draftId, ownerId: me, toIds: c.toIds, ccIds: c.ccIds, subject: c.subject, body: c.body, category: c.category, threadId: c.threadId });
    if (typeof out === "string") return out;
    setC((prev) => ({ ...prev, draftId: out.id }));
    return null;
  }

  async function runCheck() {
    if (!c.body.trim()) return "Write something to check.";
    const text = c.body;
    const out = await checkWriting(text);
    setCheck({ source: out.source, items: out.suggestions, text });
    return null;
  }

  function accept(s: WritingSuggestion) {
    if (!check) return;
    const next = applySuggestion(c.body, s);
    const shift = s.replacement.length - (s.end - s.start);
    setC((prev) => ({ ...prev, body: next }));
    setCheck({
      ...check,
      text: next,
      items: check.items.filter((x) => x !== s).map((x) => (x.start >= s.end ? { ...x, start: x.start + shift, end: x.end + shift } : x)),
    });
  }

  const offPortal = c.toIds.filter((id) => !canSignIn(id));
  const title =
    c.mode === "reply" ? "Reply" : c.mode === "all" ? "Reply all" : c.mode === "forward" ? "Forward" : c.mode === "draft" ? "Draft" : "New message";

  return (
    <form className="mx-compose" onSubmit={sendAction.submit(send)}>
      <header className="mx-compose-head">
        <h2>{title}</h2>
        {c.draftId && <span className="muted">Saved as draft</span>}
      </header>
      {c.mode === "new" && (
        <div className="mail-templates" aria-label="Quick templates">
          {templates.map((t) => (
            <button
              key={t.label}
              type="button"
              className={picked === t.label ? "mail-chip picked" : "mail-chip"}
              aria-pressed={picked === t.label}
              onClick={() => {
                setPicked(t.label);
                set({ subject: t.subject, category: t.category });
              }}
            >
              {picked === t.label ? `✓ ${t.label}` : t.label}
            </button>
          ))}
        </div>
      )}
      <div className="mx-field-row">
        <label htmlFor="mx-to">To</label>
        <div className="mx-people">
          {c.toIds.map((id) => (
            <button key={id} type="button" className="mx-person" onClick={() => removePerson("toIds", id)} aria-label={`Remove ${nameOf(id)}`}>
              {nameOf(id)} ×
            </button>
          ))}
          <select id="mx-to" value="" onChange={(e) => addPerson("toIds", e.target.value)} aria-label="Add recipient">
            <option value="">Add…</option>
            {groups.map((g) => (
              <optgroup key={g} label={g}>
                {pickable
                  .filter((r) => r.group === g && !c.toIds.includes(r.id))
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </div>
        {!showCc && (
          <button type="button" className="quiet-link" onClick={() => setShowCc(true)}>
            Cc
          </button>
        )}
      </div>
      {showCc && (
        <div className="mx-field-row">
          <label htmlFor="mx-cc">Cc</label>
          <div className="mx-people">
            {c.ccIds.map((id) => (
              <button key={id} type="button" className="mx-person" onClick={() => removePerson("ccIds", id)} aria-label={`Remove ${nameOf(id)}`}>
                {nameOf(id)} ×
              </button>
            ))}
            <select id="mx-cc" value="" onChange={(e) => addPerson("ccIds", e.target.value)} aria-label="Add Cc">
              <option value="">Add…</option>
              {pickable
                .filter((r) => !c.toIds.includes(r.id) && !c.ccIds.includes(r.id))
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} · {r.group}
                  </option>
                ))}
            </select>
          </div>
        </div>
      )}
      <div className="mx-field-row">
        <label htmlFor="mx-subject">Subject</label>
        <input id="mx-subject" value={c.subject} maxLength={300} onChange={(e) => set({ subject: e.target.value })} spellCheck />
        <select value={c.category} onChange={(e) => set({ category: e.target.value as MailCategory })} aria-label="Category">
          {MAIL_CATEGORIES.map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      </div>
      <textarea
        ref={bodyRef}
        className="mx-body-input"
        value={c.body}
        rows={14}
        spellCheck
        lang="en"
        onChange={(e) => set({ body: e.target.value })}
        aria-label="Message"
        placeholder="Write your message"
      />

      {check && (
        <div className="mx-check" aria-live="polite">
          <div className="mx-check-head">
            <strong>{check.items.length ? `${check.items.length} suggestion${check.items.length === 1 ? "" : "s"}` : "No issues found"}</strong>
            <span className="muted">{check.source === "ai" ? "HR Copilot" : "Built-in check"}</span>
            {check.items.length > 1 && (
              <button
                type="button"
                className="btn-ghost btn-tiny"
                onClick={() => {
                  setC((prev) => ({ ...prev, body: applyAll(prev.body, check.items) }));
                  setCheck({ ...check, items: [] });
                  toast("All suggestions applied.");
                }}
              >
                Accept all
              </button>
            )}
            <button type="button" className="btn-ghost btn-tiny" onClick={() => setCheck(null)}>
              Close
            </button>
          </div>
          {check.items.length > 0 && (
            <ul>
              {check.items.map((s, i) => (
                <li key={`${s.start}-${i}`}>
                  <span className="mx-check-pair">
                    <del>{s.original.trim() ? s.original : "␣"}</del> → <ins>{s.replacement.trim() ? s.replacement : "␣"}</ins>
                  </span>
                  <span className="muted">{s.message}</span>
                  <span className="mx-check-btns">
                    <button type="button" className="btn btn-tiny" onClick={() => accept(s)}>
                      Accept
                    </button>
                    <button type="button" className="btn-ghost btn-tiny" onClick={() => setCheck({ ...check, items: check.items.filter((x) => x !== s) })}>
                      Ignore
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {offPortal.length > 0 && <p className="note">{offPortal.map(nameOf).join(", ")} can't sign in yet; the mail is kept here.</p>}
      {error && <p className="note err">{error}</p>}
      <div className="mx-compose-actions">
        <SubmitButton action={sendAction} className="btn">
          Send
        </SubmitButton>
        <ActionButton className="btn-ghost" busyLabel="Checking…" doneLabel="Checked" toastError onAction={runCheck}>
          Check grammar
        </ActionButton>
        <ActionButton className="btn-ghost" disabled={!dirty} success="Draft saved." toastError onAction={save}>
          Save draft
        </ActionButton>
        <a
          className="btn-ghost"
          href={mailtoHref(c.toIds.map(emailOf).filter(Boolean), c.ccIds.map(emailOf).filter(Boolean), c.subject, c.body)}
          aria-disabled={c.toIds.length === 0}
          onClick={(e) => {
            if (c.toIds.length === 0) e.preventDefault();
          }}
        >
          Open in email app
        </a>
        <span className="mx-spacer" />
        <ActionButton
          className="btn-ghost mx-discard"
          busyLabel="Discarding…"
          doneLabel="Discarded"
          success={c.draftId ? "Draft deleted." : undefined}
          toastError
          onAction={async () => {
            if (dirty && !window.confirm(c.draftId ? "Delete this draft?" : "Discard this message?")) return false;
            const err = c.draftId ? await deleteDraft(c.draftId) : null;
            if (!err) onClosed();
            return err;
          }}
        >
          {c.draftId ? "Delete draft" : "Discard"}
        </ActionButton>
      </div>
    </form>
  );
}
