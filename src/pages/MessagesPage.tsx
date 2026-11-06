import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { ActionButton, Banner, EmptyState, Page, StatusBadge, SubmitButton, notify, useAction } from "../components/ui.tsx";
import { CHAT_PEOPLE, type ChatAvailability, type Conversation } from "../data/collabData.ts";
import { API_ENABLED } from "../api/client.ts";
import { PENDING_DIRECT, apiChatContacts, apiCreateGroup, apiMessageTeam, apiOpenDirect, apiSendChat, findDirect, type ChatContacts } from "../api/syncChat.ts";
import { usePeopleList } from "../data/peopleLocal.ts";
import {
  conversationUnreadCount,
  createGroupConversation,
  getCollabState,
  listConversationsForUser,
  markConversationRead,
  sendChatMessage,
  startDirectChat,
  subscribeCollab,
} from "../data/collabLocal.ts";
import { addGroupMembers, canRemoveOthers, removeGroupMember, renameGroup } from "../data/chatGroups.ts";
import { usePortal } from "../store.tsx";
import "./messages.css";

/** Someone you can message: the chat contacts plus everyone in the directory. */
interface Contact {
  id: string;
  name: string;
  sub: string;
  availability?: ChatAvailability;
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, "en", { sensitivity: "base" });

function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\s]/gu, " ").trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

function timeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function stampLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function availabilityTone(status: ChatAvailability): "ok" | "warn" | "neutral" {
  if (status === "Online") return "ok";
  if (status === "Away" || status === "Busy") return "warn";
  return "neutral";
}

function Avatar({ name, group }: { name: string; group?: boolean }) {
  return (
    <span className={group ? "chatx-avatar group" : "chatx-avatar"} aria-hidden>
      {group ? "#" : initials(name)}
    </span>
  );
}

const RELATION_LABEL = { manager: "Your manager", team: "Your team", teammate: "Teammate", hr: "HR" } as const;

/** Backend mode: who this person may start a chat with (the server's reporting-line + HR rule). */
function useAllowedContacts(): ChatContacts | null {
  const [allowed, setAllowed] = useState<ChatContacts | null>(null);
  useEffect(() => {
    if (!API_ENABLED) return;
    let live = true;
    apiChatContacts().then((c) => live && setAllowed(c), () => undefined);
    return () => {
      live = false;
    };
  }, []);
  return allowed;
}

function useContacts(selfId: string, allowed: ChatContacts | null): Contact[] {
  const directory = usePeopleList();
  return useMemo(() => {
    if (allowed && !allowed.anyone) {
      // Only your manager, teammates, your team and HR (the server refuses anyone else).
      return allowed.contacts
        .map((c) => ({ id: c.id, name: c.name, sub: [RELATION_LABEL[c.relation], c.job_title].filter(Boolean).join(" · ") }))
        .sort(byName);
    }
    const map = new Map<string, Contact>();
    for (const p of CHAT_PEOPLE) map.set(p.id, { id: p.id, name: p.name, sub: `${p.title} · ${p.department}`, availability: p.availability });
    for (const p of directory) {
      if (map.has(p.id) || /exit|terminat|inactive|left/i.test(String(p.employmentStatus))) continue;
      map.set(p.id, { id: p.id, name: p.fullName, sub: [p.designation, p.department].filter(Boolean).join(" · ") });
    }
    map.delete(selfId);
    return [...map.values()].sort(byName);
  }, [directory, selfId, allowed]);
}

const matches = (c: Contact, q: string) => !q || `${c.name} ${c.sub}`.toLowerCase().includes(q);

/** Search + tick list of people (new group, add members). */
function PeoplePicker({
  contacts,
  exclude,
  picked,
  onToggle,
}: {
  contacts: Contact[];
  exclude: string[];
  picked: string[];
  onToggle: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const list = contacts.filter((c) => !exclude.includes(c.id) && matches(c, needle));
  return (
    <div className="chatx-picker">
      {picked.length > 0 && (
        <div className="chatx-chips">
          {picked.map((id) => (
            <button key={id} type="button" className="chatx-chip" onClick={() => onToggle(id)} aria-label={`Remove ${contacts.find((c) => c.id === id)?.name ?? id}`}>
              {contacts.find((c) => c.id === id)?.name ?? id} ×
            </button>
          ))}
        </div>
      )}
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people" aria-label="Search people" />
      <ul className="chatx-pick-list">
        {list.slice(0, 60).map((c) => (
          <li key={c.id}>
            <label>
              <input type="checkbox" checked={picked.includes(c.id)} onChange={() => onToggle(c.id)} />
              <Avatar name={c.name} />
              <span>
                <strong>{c.name}</strong>
                <span className="muted">{c.sub}</span>
              </span>
            </label>
          </li>
        ))}
        {list.length === 0 && <li className="muted chatx-pad">No people found.</li>}
        {list.length > 60 && <li className="muted chatx-pad">{list.length - 60} more. Type to narrow the list.</li>}
      </ul>
    </div>
  );
}

export function MessagingPage() {
  const { employee, demoProfile } = usePortal();
  const collab = useSyncExternalStore(subscribeCollab, getCollabState, getCollabState);
  const allowed = useAllowedContacts();
  const contacts = useContacts(employee.id, allowed);
  const hasTeam = !!allowed?.contacts.some((c) => c.relation === "team") || (allowed?.anyone ?? false);
  const [teamText, setTeamText] = useState("");
  const [teamOpen, setTeamOpen] = useState(false);
  const self = { id: employee.id, name: employee.fullName };
  const [searchParams, setSearchParams] = useSearchParams();
  const [filter, setFilter] = useState<"all" | "direct" | "group" | "people">("all");
  const [q, setQ] = useState("");
  const [activeId, setActiveId] = useState(() => searchParams.get("c") ?? "");
  const [text, setText] = useState("");
  const [attachName, setAttachName] = useState<string | undefined>();
  const [error, setError] = useState("");
  const [panel, setPanel] = useState<"none" | "members">("none");
  const [dialog, setDialog] = useState<"none" | "direct" | "group">("none");
  const [groupTitle, setGroupTitle] = useState("");
  const [groupPicked, setGroupPicked] = useState<string[]>([]);
  const [dialogError, setDialogError] = useState("");
  const [addPicked, setAddPicked] = useState<string[]>([]);
  const [renameDraft, setRenameDraft] = useState("");
  const [peopleShown, setPeopleShown] = useState(40);
  const markedReadRef = useRef<string | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const sendAction = useAction({ doneMs: 1000 });
  const groupAction = useAction();

  const all = useMemo(
    () => listConversationsForUser(employee.id, demoProfile.role),
    [collab.conversations, employee.id, demoProfile.role],
  );
  /** A one-to-one chat is named after the other person. */
  const titleOf = (c: Conversation) => {
    if (c.kind !== "direct") return c.title;
    const other = c.participantNames.find((_, i) => c.participantIds[i] !== employee.id);
    if (!c.title.startsWith(employee.fullName)) return c.participantIds.includes(employee.id) && other ? other : c.title;
    return other ? other + c.title.slice(employee.fullName.length) : c.title;
  };

  const needle = q.trim().toLowerCase();
  const conversations = useMemo(
    () =>
      all
        .filter((c) => {
          if (filter === "direct" || filter === "group") {
            if (c.kind !== filter) return false;
          }
          if (!needle) return true;
          const blob = `${titleOf(c)} ${c.participantNames.join(" ")} ${c.messages?.at(-1)?.text ?? ""}`.toLowerCase();
          return blob.includes(needle);
        })
        .sort((a, b) => titleOf(a).localeCompare(titleOf(b), "en", { sensitivity: "base" })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [all, filter, needle, employee.id],
  );
  const peopleHits = useMemo(() => contacts.filter((c) => matches(c, needle)), [contacts, needle]);

  // ?c=<id> (or ?c=dm:<person>) from a profile, org chart or notification opens that chat; also later in the session.
  const linked = searchParams.get("c");
  useEffect(() => {
    if (linked) setActiveId(linked);
  }, [linked]);

  const pendingPerson = activeId.startsWith(PENDING_DIRECT) ? activeId.slice(PENDING_DIRECT.length) : "";
  const active = all.find((c) => c.id === activeId) ?? null;

  useEffect(() => {
    if (pendingPerson) {
      const opened = findDirect(pendingPerson, all);
      if (opened) setActiveId(opened.id);
      return;
    }
    if (activeId && all.some((c) => c.id === activeId)) return;
    if (conversations[0]) setActiveId(conversations[0].id);
  }, [all, activeId, pendingPerson, conversations]);

  useEffect(() => {
    if (!active?.id || markedReadRef.current === active.id) return;
    markedReadRef.current = active.id;
    markConversationRead(active.id, employee.id);
  }, [active?.id, employee.id]);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [active?.id, active?.messages?.length]);

  useEffect(() => {
    setRenameDraft(active?.title ?? "");
    setAddPicked([]);
  }, [active?.id, active?.title]);

  function openChat(id: string) {
    markedReadRef.current = null;
    setActiveId(id);
    setError("");
    if (searchParams.get("c")) {
      const next = new URLSearchParams(searchParams);
      next.delete("c");
      setSearchParams(next, { replace: true });
    }
  }

  async function messagePerson(person: Contact) {
    setDialog("none");
    if (API_ENABLED) {
      setActiveId(`${PENDING_DIRECT}${person.id}`);
      const res = await apiOpenDirect(person.id);
      if (!res.ok) {
        setActiveId("");
        setError(res.error);
        notify(res.error, "err");
        return;
      }
      openChat(res.id);
      return;
    }
    openChat(startDirectChat(person.id, person.name, employee.id, employee.fullName));
  }

  async function createGroup() {
    if (!groupTitle.trim()) {
      setDialogError("Give the group a name.");
      return false;
    }
    if (groupPicked.length === 0) {
      setDialogError("Pick at least one person.");
      return false;
    }
    const members = contacts.filter((c) => groupPicked.includes(c.id));
    let id: string;
    if (API_ENABLED) {
      const made = await apiCreateGroup(groupTitle.trim(), members.map((m) => m.id));
      if (!made.ok) {
        setDialogError(made.error);
        return false;
      }
      id = made.id;
    } else {
      id = createGroupConversation({
        title: groupTitle,
        selfId: employee.id,
        selfName: employee.fullName,
        memberIds: members.map((m) => m.id),
        memberNames: members.map((m) => m.name),
      });
    }
    notify(`Group "${groupTitle.trim()}" created.`);
    setDialog("none");
    setGroupTitle("");
    setGroupPicked([]);
    setDialogError("");
    setFilter("all");
    openChat(id);
    return true;
  }

  async function send() {
    if (!active) {
      setError("Pick a conversation first.");
      return false;
    }
    if (!text.trim() && !attachName) {
      setError("Type a message or attach a file.");
      return false;
    }
    const body = text.trim() || `(Attachment) ${attachName}`;
    const failure = API_ENABLED
      ? await apiSendChat(active.id, body, attachName)
      : sendChatMessage(active.id, employee.id, employee.fullName, body, attachName);
    if (failure) {
      setError(failure);
      return false;
    }
    setError("");
    setText("");
    setAttachName(undefined);
    return true;
  }

  function onComposerKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendAction.run(send);
    }
  }

  const members = active
    ? active.participantIds
        .map((id, i) => ({ id, name: active.participantNames[i] ?? id }))
        .sort((a, b) => (a.id === employee.id ? -1 : b.id === employee.id ? 1 : byName(a, b)))
    : [];
  const peer = active?.kind === "direct" ? contacts.find((c) => active.participantIds.includes(c.id)) : undefined;
  const isGroupMember = active?.kind === "group" && active.participantIds.includes(employee.id);
  const mayRemove = active ? canRemoveOthers(active, employee.id) : false;
  const sorted = active ? [...(active.messages ?? [])].sort((a, b) => a.at.localeCompare(b.at)) : [];

  return (
    <Page
      title="Messages"
      action={
        <div className="row-gap">
          {API_ENABLED && hasTeam && (
            <button type="button" className="btn-ghost" onClick={() => setTeamOpen((v) => !v)}>
              Message my team
            </button>
          )}
          <button type="button" className="btn-ghost" onClick={() => setDialog("direct")}>
            New message
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setDialogError("");
              setDialog("group");
            }}
          >
            New group
          </button>
        </div>
      }
    >
      {teamOpen && (
        <div className="chatx-team card">
          <label className="chatx-label" htmlFor="team-msg">Message everyone who reports to you</label>
          <textarea id="team-msg" rows={2} maxLength={4000} value={teamText} onChange={(e) => setTeamText(e.target.value)} placeholder="e.g. Stand-up moves to 11:00 today." />
          <div className="row-gap">
            <ActionButton
              className="btn btn-tiny"
              disabled={!teamText.trim()}
              success="Sent to your team."
              toastError
              onAction={async () => {
                const res = await apiMessageTeam(teamText.trim());
                if (!res.ok) return res.error;
                setTeamText("");
                setTeamOpen(false);
                setActiveId(res.id);
                return null;
              }}
            >
              Send to team
            </ActionButton>
            <button type="button" className="btn-ghost btn-tiny" onClick={() => setTeamOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <div className="chatx-shell">
        <aside className="chatx-side" aria-label="Conversations">
          <div className="chatx-side-head">
            <input
              type="search"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPeopleShown(40);
              }}
              placeholder="Search people or chats"
              aria-label="Search people or chats"
            />
            <div className="chatx-tabs" role="tablist">
              {(
                [
                  ["all", "All"],
                  ["direct", "Direct"],
                  ["group", "Groups"],
                  ["people", "People"],
                ] as const
              ).map(([id, label]) => (
                <button key={id} type="button" role="tab" aria-selected={filter === id} className={filter === id ? "active" : undefined} onClick={() => setFilter(id)}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="chatx-side-list">
            {filter !== "people" && (
              <>
                {needle && <p className="chatx-section">Chats</p>}
                {conversations.length === 0 ? (
                  <p className="muted chatx-pad">{needle ? "No chats match." : "No chats yet."}</p>
                ) : (
                  <ul className="chatx-convs">
                    {conversations.map((c) => {
                      const last = c.messages?.at(-1);
                      const unread = conversationUnreadCount(c, employee.id);
                      return (
                        <li key={c.id}>
                          <button type="button" className={active?.id === c.id ? "chatx-conv active" : "chatx-conv"} onClick={() => openChat(c.id)}>
                            <Avatar name={titleOf(c)} group={c.kind === "group"} />
                            <span className="chatx-conv-body">
                              <span className="chatx-conv-top">
                                <strong>{titleOf(c)}</strong>
                                {last && <span className="chatx-time">{timeLabel(last.at)}</span>}
                              </span>
                              <span className="chatx-conv-bottom">
                                <span className="chatx-snippet">
                                  {last ? `${last.fromId === employee.id ? "You: " : c.kind === "group" ? `${last.fromName.split(" ")[0]}: ` : ""}${last.text}` : "No messages yet"}
                                </span>
                                {unread > 0 && <span className="chatx-unread">{unread}</span>}
                              </span>
                              {c.restricted && <span className="chatx-tag">{c.restricted === "compensation" ? "Pay confidential" : "HR confidential"}</span>}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}

            {(filter === "people" || needle) && (
              <>
                <p className="chatx-section">People</p>
                {peopleHits.length === 0 ? (
                  <p className="muted chatx-pad">No people match.</p>
                ) : (
                  <ul className="chatx-people">
                    {peopleHits.slice(0, filter === "people" ? peopleShown : 12).map((p) => (
                      <li key={p.id}>
                        <Avatar name={p.name} />
                        <span className="chatx-person-body">
                          <strong>{p.name}</strong>
                          <span className="muted">{p.sub}</span>
                        </span>
                        <button type="button" className="btn-ghost btn-tiny" onClick={() => void messagePerson(p)}>
                          Message
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {filter === "people" && peopleHits.length > peopleShown && (
                  <button type="button" className="btn-ghost chatx-more" onClick={() => setPeopleShown((n) => n + 60)}>
                    Show more ({peopleHits.length - peopleShown})
                  </button>
                )}
              </>
            )}
          </div>
        </aside>

        <section className="chatx-main" aria-label="Conversation">
          {pendingPerson && !active ? (
            <div className="chatx-empty">
              <p className="muted">Opening chat…</p>
            </div>
          ) : !active ? (
            <div className="chatx-empty">
              <EmptyState title="No chat open" description="Pick a chat or message someone." />
              {error && <Banner message={{ tone: "err", text: error }} />}
            </div>
          ) : (
            <>
              <header className="chatx-head">
                <Avatar name={titleOf(active)} group={active.kind === "group"} />
                <div className="chatx-head-text">
                  <strong>{titleOf(active)}</strong>
                  <span className="muted">
                    {active.kind === "group"
                      ? `${active.participantIds.length} members`
                      : peer
                        ? peer.sub
                        : "Direct message"}
                  </span>
                </div>
                {peer?.availability && <StatusBadge status={peer.availability} tone={availabilityTone(peer.availability)} />}
                {active.restricted && (
                  <StatusBadge status={active.restricted === "compensation" ? "Pay confidential" : "HR confidential"} tone="danger" />
                )}
                {active.kind === "group" && (
                  <button
                    type="button"
                    className={panel === "members" ? "btn-ghost active" : "btn-ghost"}
                    aria-expanded={panel === "members"}
                    onClick={() => setPanel((p) => (p === "members" ? "none" : "members"))}
                  >
                    Members
                  </button>
                )}
              </header>

              <div className={panel === "members" && active.kind === "group" ? "chatx-body with-panel" : "chatx-body"}>
                <div className="chatx-thread" ref={threadRef} role="log" aria-live="polite">
                  {sorted.length === 0 ? (
                    <p className="muted chatx-pad" style={{ textAlign: "center" }}>
                      No messages yet. Say hello.
                    </p>
                  ) : (
                    sorted.map((m, i) => {
                      const mine = m.fromId === employee.id;
                      const prev = sorted[i - 1];
                      const showName = !mine && active.kind === "group" && prev?.fromId !== m.fromId;
                      const newDay = !prev || new Date(prev.at).toDateString() !== new Date(m.at).toDateString();
                      return (
                        <div key={m.id}>
                          {newDay && (
                            <div className="chatx-day">
                              <span>{new Date(m.at).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}</span>
                            </div>
                          )}
                          <div className={mine ? "chatx-row mine" : "chatx-row"}>
                            <div className="chatx-bubble">
                              {showName && <span className="chatx-from">{m.fromName}</span>}
                              <p>{m.text}</p>
                              {m.attachmentName && <span className="chatx-attach">📎 {m.attachmentName}</span>}
                              <span className="chatx-stamp" title={stampLabel(m.at)}>
                                {new Date(m.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                                {mine && active.participantIds.some((p) => p !== employee.id && m.readBy.includes(p)) ? " · Read" : ""}
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                {panel === "members" && active.kind === "group" && (
                  <aside className="chatx-panel" aria-label="Group members">
                    {isGroupMember && (
                      <div className="chatx-panel-block">
                        <label className="chatx-label" htmlFor="chatx-rename">
                          Group name
                        </label>
                        <div className="row-gap">
                          <input id="chatx-rename" value={renameDraft} onChange={(e) => setRenameDraft(e.target.value)} />
                          <ActionButton
                            className="btn-ghost btn-tiny"
                            disabled={!renameDraft.trim() || renameDraft.trim() === active.title}
                            success="Group renamed."
                            toastError
                            onAction={() => renameGroup(active.id, renameDraft, self)}
                          >
                            Save
                          </ActionButton>
                        </div>
                      </div>
                    )}
                    <div className="chatx-panel-block">
                      <span className="chatx-label">Members ({members.length})</span>
                      <ul className="chatx-members">
                        {members.map((m) => (
                          <li key={m.id}>
                            <Avatar name={m.name} />
                            <span>
                              {m.name}
                              {m.id === employee.id && <span className="muted"> (you)</span>}
                              {active.createdBy === m.id && <span className="muted"> · creator</span>}
                            </span>
                            {m.id !== employee.id && mayRemove && (
                              <ActionButton
                                className="btn-ghost btn-tiny"
                                success={`${m.name} removed.`}
                                toastError
                                onAction={() => removeGroupMember(active.id, m.id, self)}
                              >
                                Remove
                              </ActionButton>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                    {isGroupMember && (
                      <div className="chatx-panel-block">
                        <span className="chatx-label">Add people</span>
                        <PeoplePicker
                          contacts={contacts}
                          exclude={active.participantIds}
                          picked={addPicked}
                          onToggle={(id) => setAddPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))}
                        />
                        <ActionButton
                          className="btn btn-tiny"
                          disabled={addPicked.length === 0}
                          success={() => `Added ${addPicked.length} ${addPicked.length === 1 ? "person" : "people"}.`}
                          toastError
                          onAction={() =>
                            addGroupMembers(
                              active.id,
                              contacts.filter((c) => addPicked.includes(c.id)).map((c) => ({ id: c.id, name: c.name })),
                              self,
                            )
                          }
                          onSuccess={() => setAddPicked([])}
                        >
                          Add to group
                        </ActionButton>
                      </div>
                    )}
                    {isGroupMember && (
                      <ActionButton
                        className="btn-ghost chatx-leave"
                        busyLabel="Leaving…"
                        doneLabel="Left"
                        success={`You left ${active.title}.`}
                        toastError
                        onAction={async () => {
                          if (!window.confirm(`Leave "${active.title}"?`)) return false;
                          const err = await removeGroupMember(active.id, employee.id, self);
                          if (!err) {
                            setPanel("none");
                            if (API_ENABLED) setActiveId("");
                          }
                          return err;
                        }}
                      >
                        Leave group
                      </ActionButton>
                    )}
                  </aside>
                )}
              </div>

              <form className="chatx-composer" onSubmit={sendAction.submit(send)}>
                {error && <Banner message={{ tone: "err", text: error }} />}
                {attachName && (
                  <div className="chatx-attach-chip">
                    📎 {attachName}
                    <button type="button" className="btn-ghost btn-tiny" onClick={() => setAttachName(undefined)} aria-label="Remove attachment">
                      ×
                    </button>
                  </div>
                )}
                <div className="chatx-compose-row">
                  <label className="btn-ghost chatx-attach-btn" title="Attach a file">
                    Attach
                    <input
                      type="file"
                      hidden
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) setAttachName(file.name);
                        setError("");
                        e.target.value = "";
                      }}
                    />
                  </label>
                  <textarea
                    rows={1}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={onComposerKey}
                    placeholder={`Message ${titleOf(active)}`}
                    aria-label="Message"
                    spellCheck
                  />
                  <SubmitButton action={sendAction} className="btn">
                    Send
                  </SubmitButton>
                </div>
              </form>
            </>
          )}
        </section>
      </div>

      {dialog !== "none" && (
        <div className="modal-root" role="presentation">
          <button className="modal-scrim" type="button" aria-label="Close" onClick={() => setDialog("none")} />
          <div className="modal-card chatx-dialog" role="dialog" aria-modal="true" aria-labelledby="chatx-dialog-title">
            <h2 id="chatx-dialog-title">{dialog === "direct" ? "New message" : "New group"}</h2>
            {dialog === "direct" ? (
              <DirectPicker contacts={contacts} onPick={(p) => void messagePerson(p)} />
            ) : (
              <form className="stack" onSubmit={groupAction.submit(createGroup)}>
                <label className="field">
                  <span>Group name</span>
                  <input value={groupTitle} onChange={(e) => setGroupTitle(e.target.value)} placeholder="e.g. Sprint sync" maxLength={200} />
                </label>
                <span className="chatx-label">Members</span>
                <PeoplePicker
                  contacts={contacts}
                  exclude={[]}
                  picked={groupPicked}
                  onToggle={(id) => setGroupPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))}
                />
                {dialogError && <Banner message={{ tone: "err", text: dialogError }} />}
                <div className="form-actions">
                  <button type="button" className="btn-ghost" onClick={() => setDialog("none")}>
                    Cancel
                  </button>
                  <SubmitButton action={groupAction} className="btn">
                    Create group
                  </SubmitButton>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </Page>
  );
}

function DirectPicker({ contacts, onPick }: { contacts: Contact[]; onPick: (p: Contact) => void }) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const list = contacts.filter((c) => matches(c, needle));
  return (
    <div className="chatx-picker">
      <input type="search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people" aria-label="Search people" />
      <ul className="chatx-pick-list">
        {list.slice(0, 60).map((c) => (
          <li key={c.id}>
            <button type="button" className="chatx-pick-btn" onClick={() => onPick(c)}>
              <Avatar name={c.name} />
              <span>
                <strong>{c.name}</strong>
                <span className="muted">{c.sub}</span>
              </span>
            </button>
          </li>
        ))}
        {list.length === 0 && <li className="muted chatx-pad">No people found.</li>}
      </ul>
    </div>
  );
}
