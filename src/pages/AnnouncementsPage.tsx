import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "react-router-dom";
import { ActionButton, Banner, EmptyState, Field, Page, StatusBadge, SubmitButton, notify, useAction } from "../components/ui.tsx";
import { canManageAnnouncement, isHrRole, type Announcement, type AnnouncementScope } from "../data/collabData.ts";
import { getCollabState, markAnnouncementRead, setAnnouncementState, subscribeCollab } from "../data/collabLocal.ts";
import {
  ANNOUNCEMENT_CATEGORIES,
  acknowledgeLocal,
  addressedTo,
  createLocalAnnouncement,
  ensureLocalAnnouncements,
  markUnreadLocal,
  pinLocal,
} from "../data/announcementsLocal.ts";
import {
  type AnnouncementReceipt,
  announcementsMirror,
  apiAcknowledgeAnnouncement,
  apiAnnouncementReceipts,
  apiCreateAnnouncement,
  apiMarkAnnouncementRead,
  apiPinAnnouncement,
  apiSetAnnouncementState,
} from "../api/syncAnnouncements.ts";
import { API_ENABLED } from "../api/client.ts";
import { usePeopleList } from "../data/peopleLocal.ts";
import { managementChain } from "../demoAccounts.ts";
import { TIMEZ_COUNTRIES } from "../model.ts";
import { usePortal } from "../store.tsx";
import "./announcements.css";
import "../styles/comms.css";

const countryLabel = (code: string) => TIMEZ_COUNTRIES.find((c) => c.code === code)?.name ?? code;
type Show = "all" | "unread" | "ack";

function dateLabel(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** "Today", "Yesterday", "3 days ago", then the date. */
function relativeLabel(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7) return `${days} days ago`;
  return dateLabel(iso);
}

function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\s]/gu, " ").trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

const catClass = (c: string) => `annx-${c.toLowerCase().replace(/[^a-z]+/g, "-")}`;
const stamp = (a: Announcement) => a.publishedAt ?? a.scheduledFor ?? "";

function audienceLabel(a: Announcement): string {
  if (a.scope === "Company") return "Everyone";
  if (a.scope === "Country") return countryLabel(a.audience);
  if (a.scope === "Team") return "Team";
  return a.audience;
}

export function AnnouncementsPage() {
  const { employee, demoProfile } = usePortal();
  const collab = useSyncExternalStore(subscribeCollab, getCollabState, getCollabState);
  const people = usePeopleList();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [show, setShow] = useState<Show>("all");
  const [stateFilter, setStateFilter] = useState("");
  const [openId, setOpenId] = useState(() => params.get("id") ?? "");
  const [error, setError] = useState("");
  const [composing, setComposing] = useState(false);
  const blank = { title: "", body: "", scope: "Company" as AnnouncementScope, audience: "", mustAcknowledge: false, category: "General", pinned: false };
  const [draft, setDraft] = useState(blank);
  const [composeError, setComposeError] = useState("");
  const [receipts, setReceipts] = useState<{ id: string; rows: AnnouncementReceipt[] } | null>(null);
  const publishAction = useAction();
  const draftAction = useAction();

  useEffect(() => {
    if (!API_ENABLED) ensureLocalAnnouncements();
  }, []);

  const actor = { id: employee.id, fullName: employee.fullName, role: demoProfile.role };
  const me = employee.id;
  const canManage = (a: Announcement) => (API_ENABLED ? !!a.serverCanManage : canManageAnnouncement(a, actor));
  const isRead = (a: Announcement) => a.readBy.includes(me);
  const isAcked = (a: Announcement) => (API_ENABLED ? !!a.acknowledged : !!a.acknowledgedBy?.includes(me));
  const needsAck = (a: Announcement) => !!a.mustAcknowledge && a.state === "Published" && !isAcked(a) && !canManage(a);
  const isImportant = (a: Announcement) => !!a.pinned || needsAck(a);
  const leadsAll = isHrRole(demoProfile.role) || ["admin", "super_admin"].includes(demoProfile.role);
  const leadsTeam = ["manager", "executive"].includes(demoProfile.role);
  const scopeOptions: AnnouncementScope[] = leadsAll ? ["Company", "Country", "Department"] : ["Team"];
  const countries = [...new Set(people.map((p) => p.countryCode).filter(Boolean))].sort();
  const departments = [...new Set(people.map((p) => p.department).filter(Boolean))].sort();

  // What this person receives (backend: the server already filters), plus drafts / scheduled posts they manage.
  const mine = useMemo(() => {
    const chain = (id: string) => managementChain(id).map((m) => m.id);
    return collab.announcements.filter((a) => {
      if (a.state !== "Published") return canManage(a);
      if (API_ENABLED || canManage(a)) return true;
      return addressedTo(a, { id: me, countryCode: employee.countryCode, department: employee.department }, chain);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collab.announcements, me, demoProfile.role, employee.countryCode, employee.department]);

  const needle = q.trim().toLowerCase();
  const list = useMemo(
    () =>
      mine
        .filter((a) => !category || (a.category ?? "General") === category)
        .filter((a) => !stateFilter || a.state === stateFilter)
        .filter((a) => (show === "unread" ? a.state === "Published" && !isRead(a) : show === "ack" ? needsAck(a) : true))
        .filter((a) => !needle || `${a.title} ${a.body} ${a.author} ${a.category ?? ""} ${audienceLabel(a)}`.toLowerCase().includes(needle))
        .sort((a, b) => stamp(b).localeCompare(stamp(a))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mine, category, stateFilter, show, needle],
  );
  const important = list.filter(isImportant);
  const latest = list.filter((a) => !isImportant(a));
  const unreadCount = mine.filter((a) => a.state === "Published" && !isRead(a)).length;
  const ackCount = mine.filter(needsAck).length;
  const categoryCount = (c: string) => mine.filter((a) => (a.category ?? "General") === c).length;

  function markRead(a: Announcement) {
    if (a.state !== "Published" || isRead(a)) return;
    if (API_ENABLED) apiMarkAnnouncementRead(a.id);
    else markAnnouncementRead(a.id, me);
  }

  // A link to one post (?id=…, from a notification or the dashboard) opens it, marks it read and scrolls to it.
  const linked = params.get("id");
  useEffect(() => {
    if (!linked) return;
    const a = mine.find((x) => x.id === linked);
    if (!a) return;
    setOpenId(a.id);
    markRead(a);
    requestAnimationFrame(() => document.getElementById(`ann-${a.id}`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked, mine.length]);

  function toggle(a: Announcement) {
    setError("");
    setReceipts(null);
    if (params.get("id")) {
      const next = new URLSearchParams(params);
      next.delete("id");
      setParams(next, { replace: true });
    }
    if (openId === a.id) {
      setOpenId("");
      return;
    }
    setOpenId(a.id);
    markRead(a);
  }

  async function save(state: "Draft" | "Published") {
    const fail = (text: string) => {
      setComposeError(text);
      return false;
    };
    if (draft.title.trim().length < 3) return fail("Add a title.");
    if (!draft.body.trim()) return fail("Write the announcement.");
    if ((draft.scope === "Country" || draft.scope === "Department") && !draft.audience) return fail(`Pick the ${draft.scope.toLowerCase()}.`);
    let newId = "";
    if (API_ENABLED) {
      const err = await apiCreateAnnouncement({ ...draft, state });
      if (err) return fail(err);
      newId = announcementsMirror.get()[0]?.id ?? "";
    } else {
      const made = createLocalAnnouncement({ ...draft, state }, actor);
      if ("error" in made) return fail(made.error);
      newId = made.id;
    }
    setComposing(false);
    setComposeError("");
    setDraft(blank);
    if (newId) setOpenId(newId);
    notify(state === "Published" ? "Announcement published." : "Draft saved.");
    return true;
  }

  async function changeState(a: Announcement, next: Announcement["state"]) {
    const err = API_ENABLED ? await apiSetAnnouncementState(a.id, next) : setAnnouncementState(a.id, next, actor);
    setError(err ?? "");
    if (!err) notify(next === "Published" ? "Announcement published." : `Moved to ${next.toLowerCase()}.`);
  }

  async function toggleReceipts(id: string) {
    if (receipts?.id === id) {
      setReceipts(null);
      return null;
    }
    const rows = await apiAnnouncementReceipts(id);
    if (typeof rows === "string") return rows;
    setReceipts({ id, rows });
    return null;
  }

  function actions(a: Announcement) {
    const manage = canManage(a);
    const canUnread = !API_ENABLED && a.state === "Published" && isRead(a) && !a.mustAcknowledge;
    if (!needsAck(a) && !manage && !canUnread && !error) return null;
    return (
      <div className="annx-actions">
        {error && <Banner message={{ tone: "err", text: error }} />}
        <div className="row-gap">
          {needsAck(a) && (
            <ActionButton
              className="btn"
              success="Acknowledged."
              toastError
              onAction={() => (API_ENABLED ? apiAcknowledgeAnnouncement(a.id) : acknowledgeLocal(a.id, me))}
            >
              Acknowledge
            </ActionButton>
          )}
          {canUnread && (
            <ActionButton className="btn-ghost" success="Marked unread." onAction={() => markUnreadLocal(a.id, me)}>
              Mark unread
            </ActionButton>
          )}
          {manage && (
            <>
              <ActionButton
                className="btn-ghost"
                success={a.pinned ? "Unpinned." : "Pinned to the top."}
                toastError
                onAction={() => (API_ENABLED ? apiPinAnnouncement(a.id, !a.pinned) : pinLocal(a.id, !a.pinned, actor))}
              >
                {a.pinned ? "Unpin" : "Pin"}
              </ActionButton>
              {a.state !== "Published" && (
                <ActionButton className="btn" toastError onAction={() => changeState(a, "Published")}>
                  Publish
                </ActionButton>
              )}
              {a.state === "Published" && (
                <ActionButton className="btn-ghost" busyLabel="Moving…" doneLabel="Moved" toastError onAction={() => changeState(a, "Draft")}>
                  Move to drafts
                </ActionButton>
              )}
              {a.receipts && (
                <ActionButton className="btn-ghost" busyLabel="Loading…" doneLabel="Loaded" toastError onAction={() => toggleReceipts(a.id)}>
                  {receipts?.id === a.id ? "Hide receipts" : `Receipts · ${a.receipts.read}/${a.receipts.audience} read`}
                </ActionButton>
              )}
            </>
          )}
        </div>
        {receipts?.id === a.id && (
          <ul className="annx-receipts" aria-label="Read receipts">
            {receipts.rows.map((r) => (
              <li key={r.personId}>
                <span className="annx-receipt-who">
                  <strong>{r.name}</strong>
                  <small>{r.department}</small>
                </span>
                <span className={r.readAt ? "annx-ok" : "muted"}>{r.readAt ? `Read ${dateLabel(r.readAt)}` : "Not read"}</span>
                {a.mustAcknowledge && (
                  <span className={r.acknowledgedAt ? "annx-ok" : "muted"}>
                    {r.acknowledgedAt ? `Acknowledged ${dateLabel(r.acknowledgedAt)}` : "Not acknowledged"}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  function card(a: Announcement) {
    const unread = a.state === "Published" && !isRead(a);
    const open = openId === a.id;
    const cat = a.category ?? "General";
    const when = stamp(a);
    return (
      <article
        key={a.id}
        id={`ann-${a.id}`}
        className={`annx-card ${catClass(cat)}${open ? " open" : ""}${unread ? " unread" : ""}${a.pinned ? " pinned" : ""}`}
      >
        <div className="annx-top">
          <span className="annx-tag">
            <span className="annx-dot" aria-hidden />
            {cat}
          </span>
          {a.pinned && <span className="annx-flag pin">Pinned</span>}
          {needsAck(a) && <span className="annx-flag ack">Acknowledge</span>}
          {a.mustAcknowledge && isAcked(a) && <span className="annx-flag done">Acknowledged</span>}
          {a.state !== "Published" && <StatusBadge status={a.state} />}
          <time className="annx-when" dateTime={when} title={dateLabel(when)}>
            {a.state === "Scheduled" && a.scheduledFor ? `Scheduled ${dateLabel(a.scheduledFor)}` : relativeLabel(when)}
          </time>
        </div>
        <h3 className="annx-title">
          <button type="button" aria-expanded={open} onClick={() => toggle(a)}>
            {unread && <span className="annx-unread" aria-label="Unread" />}
            {a.title}
          </button>
        </h3>
        <p className={open ? "annx-body" : "annx-body clamp"}>{a.body}</p>
        <div className="annx-foot">
          <span className="annx-author">
            <span className="annx-avatar" aria-hidden>
              {initials(a.author)}
            </span>
            {a.author}
          </span>
          <span className="annx-aud">To {audienceLabel(a)}</span>
          <button type="button" className="annx-more" aria-expanded={open} onClick={() => toggle(a)}>
            {open ? "Show less" : "Read more"}
          </button>
        </div>
        {open && actions(a)}
      </article>
    );
  }

  return (
    <Page
      title="Announcements"
      action={
        leadsAll || leadsTeam ? (
          <button
            type="button"
            className="btn"
            onClick={() => {
              setComposing((v) => !v);
              setComposeError("");
              setDraft({ ...blank, scope: scopeOptions[0] });
            }}
          >
            {composing ? "Close" : "New announcement"}
          </button>
        ) : undefined
      }
    >
      {composing && (
        <form className="ann-compose" onSubmit={publishAction.submit(() => save("Published"))}>
          <div className="ann-compose-grid">
            <Field label="Title" wide>
              <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} maxLength={200} />
            </Field>
            <Field label="Category">
              <select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>
                {ANNOUNCEMENT_CATEGORIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </Field>
            <Field label="Audience">
              <select value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value as AnnouncementScope, audience: "" })}>
                {scopeOptions.map((s) => (
                  <option key={s} value={s}>
                    {s === "Company" ? "Everyone" : s === "Team" ? "My team" : s}
                  </option>
                ))}
              </select>
            </Field>
            {draft.scope === "Country" && (
              <Field label="Country">
                <select value={draft.audience} onChange={(e) => setDraft({ ...draft, audience: e.target.value })}>
                  <option value="">Pick…</option>
                  {countries.map((c) => (
                    <option key={c} value={c}>
                      {countryLabel(c)}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {draft.scope === "Department" && (
              <Field label="Department">
                <select value={draft.audience} onChange={(e) => setDraft({ ...draft, audience: e.target.value })}>
                  <option value="">Pick…</option>
                  {departments.map((d) => (
                    <option key={d}>{d}</option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Message" wide>
              <textarea rows={5} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} spellCheck />
            </Field>
          </div>
          <div className="row-gap">
            <label className="ann-check">
              <input type="checkbox" checked={draft.mustAcknowledge} onChange={(e) => setDraft({ ...draft, mustAcknowledge: e.target.checked })} />
              Must acknowledge
            </label>
            <label className="ann-check">
              <input type="checkbox" checked={draft.pinned} onChange={(e) => setDraft({ ...draft, pinned: e.target.checked })} />
              Pin to top
            </label>
          </div>
          {composeError && <Banner message={{ tone: "err", text: composeError }} />}
          <div className="row-gap">
            <SubmitButton action={publishAction} className="btn">
              Publish
            </SubmitButton>
            <ActionButton className="btn-ghost" action={draftAction} onAction={() => save("Draft")}>
              Save draft
            </ActionButton>
            <button type="button" className="btn-ghost" onClick={() => setComposing(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="annx-bar">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search announcements" aria-label="Search announcements" />
        <div className="annx-seg" role="group" aria-label="Show">
          {(
            [
              ["all", "All", mine.length],
              ["unread", "Unread", unreadCount],
              ["ack", "To acknowledge", ackCount],
            ] as const
          ).map(([id, label, n]) => (
            <button key={id} type="button" className={show === id ? "active" : ""} aria-pressed={show === id} onClick={() => setShow(id)}>
              {label}
              <span className="annx-count">{n}</span>
            </button>
          ))}
        </div>
        {(leadsAll || leadsTeam) && (
          <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)} aria-label="State">
            <option value="">Any state</option>
            <option>Published</option>
            <option>Scheduled</option>
            <option>Draft</option>
          </select>
        )}
      </div>
      <div className="annx-cats" role="group" aria-label="Category">
        <button type="button" className={!category ? "annx-cat active" : "annx-cat"} aria-pressed={!category} onClick={() => setCategory("")}>
          All
        </button>
        {ANNOUNCEMENT_CATEGORIES.filter((c) => categoryCount(c) > 0 || c === category).map((c) => (
          <button
            key={c}
            type="button"
            className={`annx-cat ${catClass(c)}${category === c ? " active" : ""}`}
            aria-pressed={category === c}
            onClick={() => setCategory(category === c ? "" : c)}
          >
            <span className="annx-dot" aria-hidden />
            {c}
            <span className="annx-count">{categoryCount(c)}</span>
          </button>
        ))}
      </div>

      {list.length === 0 ? (
        <EmptyState
          title="No announcements here"
          action={
            q || category || show !== "all" || stateFilter ? (
              <button
                type="button"
                className="btn-ghost"
                onClick={() => {
                  setQ("");
                  setCategory("");
                  setShow("all");
                  setStateFilter("");
                }}
              >
                Clear filters
              </button>
            ) : undefined
          }
        />
      ) : (
        <>
          {important.length > 0 && (
            <section className="annx-section" aria-label="Pinned and important">
              <h2 className="annx-h">Pinned and important</h2>
              <div className="annx-grid featured">{important.map(card)}</div>
            </section>
          )}
          {latest.length > 0 && (
            <section className="annx-section" aria-label="Latest">
              <h2 className="annx-h">Latest</h2>
              <div className="annx-grid">{latest.map(card)}</div>
            </section>
          )}
        </>
      )}
    </Page>
  );
}
