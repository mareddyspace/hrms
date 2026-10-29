import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Card, EmptyState, Page, SubmitButton, Tabs, notify as toast, useAction } from "../components/ui.tsx";
import { usePortal } from "../store.tsx";
import { managementChain } from "../demoAccounts.ts";
import { allReportIds, getPerson } from "../data/peopleLocal.ts";
import { pushPersonTaskAlert } from "../data/collabLocal.ts";
import {
  MAIL_CATEGORIES,
  inboxThreads,
  mailtoHref,
  markThreadRead,
  sendMail,
  sentThreads,
  threadFor,
  useMail,
} from "../data/mailStore.ts";
import type { MailCategory, MailThread } from "../data/mailStore.ts";
import "./mail.css";

const HR_ID = "demo-hr-admin";

const TEMPLATES: { label: string; subject: string; category: MailCategory }[] = [
  { label: "Leave request discussion", subject: "Leave request discussion", category: "Leave" },
  { label: "Attendance issue", subject: "Attendance issue", category: "Attendance" },
  { label: "Work from home request", subject: "Work from home request", category: "Work from home" },
  { label: "General", subject: "", category: "General" },
];

type View = "inbox" | "sent" | "compose";

type Recipient = { id: string; name: string; email: string; group: string };

function when(iso: string, timeZone: string): string {
  try {
    return new Date(iso).toLocaleString("en-GB", { timeZone, dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

function replySubject(subject: string): string {
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

export function MailPage() {
  const { employee, demoAccounts } = usePortal();
  const messages = useMail();
  const [params, setParams] = useSearchParams();
  const me = employee.id;

  const nameOf = (id: string) => getPerson(id)?.fullName ?? demoAccounts.find((a) => a.id === id)?.fullName ?? id;
  const emailOf = (id: string) => getPerson(id)?.email ?? demoAccounts.find((a) => a.id === id)?.email ?? "";
  const canSignIn = (id: string) => demoAccounts.some((a) => a.id === id);

  const chain = useMemo(() => managementChain(me, demoAccounts), [me, demoAccounts]);
  const manager = chain[0];

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

  const threadParam = params.get("thread");
  const [view, setView] = useState<View>(() => (params.get("compose") ? "compose" : "inbox"));
  const [openId, setOpenId] = useState<string | null>(threadParam);

  // Compose state
  const [toId, setToId] = useState("");
  const [ccIds, setCcIds] = useState<string[]>([]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [category, setCategory] = useState<MailCategory>("General");
  const [error, setError] = useState("");
  const [sentNote, setSentNote] = useState<{ text: string; href: string } | null>(null);

  // Deep links: /mail?thread=…, /mail?compose=manager&subject=…, /mail?to=<id>
  useEffect(() => {
    if (threadParam) {
      setOpenId(threadParam);
      setView(messages.some((m) => m.threadId === threadParam && m.fromId !== me) ? "inbox" : "sent");
    }
    const compose = params.get("compose");
    const to = params.get("to");
    if (compose || to) {
      setView("compose");
      const target = to && recipients.some((r) => r.id === to) ? to : compose === "manager" ? manager?.id ?? "" : "";
      setToId(target);
      const presetSubject = params.get("subject");
      if (presetSubject) setSubject(presetSubject.slice(0, 120));
    }
    // Only react to the URL, not to every mail change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const inbox = useMemo(() => inboxThreads(messages, me), [messages, me]);
  const sent = useMemo(() => sentThreads(messages, me), [messages, me]);
  const open = openId ? threadFor(messages, me, openId) : undefined;

  useEffect(() => {
    if (open && open.unread > 0) markThreadRead(open.threadId, me);
  }, [open, me]);

  function startCompose(target?: string, template?: (typeof TEMPLATES)[number]) {
    setView("compose");
    setSentNote(null);
    setError("");
    if (target !== undefined) setToId(target);
    if (template) {
      setSubject(template.subject);
      setCategory(template.category);
    }
  }

  function writeToManager() {
    setCcIds([]);
    setSubject("");
    setBody("");
    setCategory("General");
    startCompose(manager?.id ?? "");
  }

  const sendAction = useAction();

  function fail(text: string) {
    setError(text);
    return false;
  }

  function onSend() {
    setError("");
    if (!toId) return fail("Choose who to send this to.");
    if (!subject.trim()) return fail("Add a subject.");
    if (!body.trim()) return fail("Write a message.");
    if (!recipients.some((r) => r.id === toId)) return fail("You can only write to your reporting line, HR or your team here.");
    const message = sendMail({
      fromId: me,
      fromName: employee.fullName,
      toIds: [toId],
      ccIds: ccIds.filter((id) => recipients.some((r) => r.id === id)),
      subject,
      body,
      category,
    });
    notify(message.toIds.concat(message.ccIds), message.subject, message.threadId);
    setSentNote({
      text: `Sent to ${[...message.toIds, ...message.ccIds].map(nameOf).join(", ")}.`,
      href: mailtoHref(message.toIds.map(emailOf).filter(Boolean), message.ccIds.map(emailOf).filter(Boolean), message.subject, message.body),
    });
    toast(`Mail sent to ${[...message.toIds, ...message.ccIds].map(nameOf).join(", ")}.`);
    setSubject("");
    setBody("");
    setCcIds([]);
    return true;
  }

  function notify(ids: string[], subj: string, threadId: string) {
    for (const id of ids) {
      if (!canSignIn(id)) continue; // stored; they'll see it in Mail if they sign in
      pushPersonTaskAlert({
        recipientId: id,
        title: `New mail from ${employee.fullName}`,
        body: subj,
        href: `/mail?thread=${encodeURIComponent(threadId)}`,
      });
    }
  }

  const tabs = [
    { id: "inbox", label: `Inbox${inbox.some((t) => t.unread) ? ` (${inbox.reduce((n, t) => n + t.unread, 0)})` : ""}` },
    { id: "sent", label: "Sent" },
    { id: "compose", label: "Compose" },
  ];

  const list = view === "sent" ? sent : inbox;
  const toRecipient = recipients.find((r) => r.id === toId);
  const groups = [...new Set(recipients.map((r) => r.group))];

  return (
    <Page
      title="Mail"
      subtitle={`Times in ${employee.timeZone}`}
      action={
        manager ? (
          <button className="btn" type="button" onClick={writeToManager}>
            Write to my manager
          </button>
        ) : undefined
      }
    >
      <Tabs
        tabs={tabs}
        value={view}
        onChange={(id) => {
          setView(id as View);
          setSentNote(null);
          if (id !== "compose") setOpenId(null);
          if (params.toString()) setParams({}, { replace: true });
        }}
      />

      {view === "compose" ? (
        <Card title="New message">
          <form className="mail-compose" onSubmit={sendAction.submit(onSend)}>
            <div className="mail-templates" aria-label="Quick templates">
              {TEMPLATES.map((t) => (
                <button key={t.label} type="button" className="btn-ghost mail-chip" onClick={() => startCompose(undefined, t)}>
                  {t.label}
                </button>
              ))}
            </div>
            <div className="form-grid">
              <label className="field">
                <span>To</span>
                <select value={toId} onChange={(e) => setToId(e.target.value)} required>
                  <option value="">Choose…</option>
                  {groups.map((g) => (
                    <optgroup key={g} label={g}>
                      {recipients
                        .filter((r) => r.group === g)
                        .map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                    </optgroup>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Category</span>
                <select value={category} onChange={(e) => setCategory(e.target.value as MailCategory)}>
                  {MAIL_CATEGORIES.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Cc (optional)</span>
                <select
                  value=""
                  onChange={(e) => e.target.value && setCcIds((ids) => (ids.includes(e.target.value) ? ids : [...ids, e.target.value]))}
                >
                  <option value="">Add…</option>
                  {recipients
                    .filter((r) => r.id !== toId && !ccIds.includes(r.id))
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name} · {r.group}
                      </option>
                    ))}
                </select>
                {ccIds.length > 0 && (
                  <span className="mail-cc-list">
                    {ccIds.map((id) => (
                      <button key={id} type="button" className="mail-cc" onClick={() => setCcIds((ids) => ids.filter((x) => x !== id))}>
                        {nameOf(id)} ×
                      </button>
                    ))}
                  </span>
                )}
              </label>
              <label className="field">
                <span>Subject</span>
                <input value={subject} maxLength={120} onChange={(e) => setSubject(e.target.value)} required />
              </label>
              <label className="field wide">
                <span>Message</span>
                <textarea value={body} rows={8} onChange={(e) => setBody(e.target.value)} required />
              </label>
            </div>
            {toRecipient && !canSignIn(toRecipient.id) && (
              <p className="note">{toRecipient.name} isn't on the portal yet. The message is kept here; you can also send it from your email app.</p>
            )}
            {error && <p className="note err">{error}</p>}
            {sentNote && (
              <p className="note ok">
                {sentNote.text}{" "}
                <a href={sentNote.href} className="mail-link">
                  Open in email app
                </a>
              </p>
            )}
            <div className="mail-actions">
              <SubmitButton action={sendAction} className="btn">
                Send
              </SubmitButton>
              <a
                className="btn-ghost"
                href={mailtoHref(
                  toRecipient?.email ? [toRecipient.email] : [],
                  ccIds.map(emailOf).filter(Boolean),
                  subject,
                  body,
                )}
                aria-disabled={!toRecipient?.email}
                onClick={(e) => {
                  if (!toRecipient?.email) e.preventDefault();
                }}
              >
                Open in email app
              </a>
            </div>
            <p className="note">
              For anyone else in the company, use <Link to="/chat">Messages</Link>.
            </p>
          </form>
        </Card>
      ) : (
        <div className="mail-layout">
          <Card className="mail-list-card">
            {list.length === 0 ? (
              <EmptyState
                title={view === "sent" ? "Nothing sent yet" : "No mail yet"}
                action={
                  manager ? (
                    <button className="btn" type="button" onClick={writeToManager}>
                      Write to my manager
                    </button>
                  ) : undefined
                }
              />
            ) : (
              <ul className="mail-list">
                {list.map((t) => (
                  <ThreadRow
                    key={t.threadId}
                    thread={t}
                    me={me}
                    active={t.threadId === openId}
                    timeZone={employee.timeZone}
                    nameOf={nameOf}
                    sentView={view === "sent"}
                    onOpen={() => setOpenId(t.threadId)}
                  />
                ))}
              </ul>
            )}
          </Card>
          <div className="mail-reader">
            {open ? (
              <ThreadView
                key={open.threadId}
                thread={open}
                me={me}
                myName={employee.fullName}
                timeZone={employee.timeZone}
                nameOf={nameOf}
                emailOf={emailOf}
                onSent={(ids, subj) => notify(ids, subj, open.threadId)}
                canSignIn={canSignIn}
              />
            ) : (
              <Card>
                <EmptyState title="Select a conversation" description="Open a message to read it and reply." />
              </Card>
            )}
          </div>
        </div>
      )}
    </Page>
  );
}

function ThreadRow({
  thread,
  me,
  active,
  timeZone,
  nameOf,
  sentView,
  onOpen,
}: {
  thread: MailThread;
  me: string;
  active: boolean;
  timeZone: string;
  nameOf: (id: string) => string;
  sentView: boolean;
  onOpen: () => void;
}) {
  const latest = thread.latest;
  const who = sentView
    ? `To ${[...new Set(thread.messages.filter((m) => m.fromId === me).flatMap((m) => m.toIds))].map(nameOf).join(", ")}`
    : latest.fromId === me
      ? `You → ${latest.toIds.map(nameOf).join(", ")}`
      : latest.fromName;
  return (
    <li>
      <button type="button" className={`mail-row${active ? " active" : ""}${thread.unread ? " unread" : ""}`} onClick={onOpen}>
        <span className="mail-row-top">
          <span className="mail-row-who">{who}</span>
          <span className="mail-row-time">{when(latest.sentAt, timeZone)}</span>
        </span>
        <span className="mail-row-subject" title={thread.subject}>
          {thread.subject}
          {thread.messages.length > 1 && <span className="mail-count">{thread.messages.length}</span>}
        </span>
        <span className="mail-row-snippet">{latest.body.replace(/\s+/g, " ").slice(0, 90)}</span>
        {thread.category && <span className="pill mail-cat">{thread.category}</span>}
      </button>
    </li>
  );
}

function ThreadView({
  thread,
  me,
  myName,
  timeZone,
  nameOf,
  emailOf,
  onSent,
  canSignIn,
}: {
  thread: MailThread;
  me: string;
  myName: string;
  timeZone: string;
  nameOf: (id: string) => string;
  emailOf: (id: string) => string;
  onSent: (ids: string[], subject: string) => void;
  canSignIn: (id: string) => boolean;
}) {
  const [mode, setMode] = useState<"reply" | "all" | null>(null);
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const latest = thread.latest;

  const replyTo = latest.fromId === me ? latest.toIds : [latest.fromId];
  const allIds = [...new Set([latest.fromId, ...latest.toIds, ...latest.ccIds])].filter((id) => id !== me);
  const toIds = replyTo;
  const ccIds = mode === "all" ? allIds.filter((id) => !replyTo.includes(id)) : [];
  const subject = replySubject(thread.subject);

  const replyAction = useAction();

  function send() {
    if (!body.trim()) {
      setError("Write a reply.");
      return false;
    }
    const message = sendMail({ fromId: me, fromName: myName, toIds, ccIds, subject, body, category: thread.category, threadId: thread.threadId });
    onSent([...message.toIds, ...message.ccIds], message.subject);
    const offline = [...message.toIds, ...message.ccIds].filter((id) => !canSignIn(id));
    setNote(
      `Sent to ${[...message.toIds, ...message.ccIds].map(nameOf).join(", ")}.` +
        (offline.length ? ` ${offline.map(nameOf).join(", ")} can't sign in yet; use your email app to reach them too.` : ""),
    );
    toast(`Reply sent to ${[...message.toIds, ...message.ccIds].map(nameOf).join(", ")}.`);
    setBody("");
    setMode(null);
    setError("");
    return true;
  }

  return (
    <Card title={thread.subject} action={thread.category ? <span className="pill">{thread.category}</span> : undefined}>
      <ol className="mail-thread">
        {thread.messages.map((m) => (
          <li key={m.id} className="mail-msg">
            <div className="mail-msg-head">
              <strong>{m.fromId === me ? "You" : m.fromName}</strong>
              <span className="mail-row-time">{when(m.sentAt, timeZone)}</span>
            </div>
            <div className="mail-msg-to">
              To {m.toIds.map((id) => (id === me ? "you" : nameOf(id))).join(", ")}
              {m.ccIds.length > 0 && <> · Cc {m.ccIds.map((id) => (id === me ? "you" : nameOf(id))).join(", ")}</>}
            </div>
            <p className="mail-msg-body">{m.body}</p>
          </li>
        ))}
      </ol>
      {note && (
        <p className="note ok">
          {note}
        </p>
      )}
      {mode ? (
        <form className="mail-reply" onSubmit={replyAction.submit(send)}>
          <p className="note">
            {mode === "all" ? "Reply all" : "Reply"} to {toIds.map(nameOf).join(", ")}
            {ccIds.length > 0 && <> · Cc {ccIds.map(nameOf).join(", ")}</>}
          </p>
          <textarea value={body} rows={5} onChange={(e) => setBody(e.target.value)} aria-label="Reply" autoFocus />
          {error && <p className="note err">{error}</p>}
          <div className="mail-actions">
            <SubmitButton action={replyAction} className="btn">
              Send
            </SubmitButton>
            <a className="btn-ghost" href={mailtoHref(toIds.map(emailOf).filter(Boolean), ccIds.map(emailOf).filter(Boolean), subject, body)}>
              Open in email app
            </a>
            <button className="btn-ghost" type="button" onClick={() => setMode(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="mail-actions">
          <button className="btn" type="button" onClick={() => setMode("reply")}>
            Reply
          </button>
          {allIds.length > 1 && (
            <button className="btn-ghost" type="button" onClick={() => setMode("all")}>
              Reply all
            </button>
          )}
        </div>
      )}
    </Card>
  );
}
