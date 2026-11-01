import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "react-router-dom";
import { ActionButton, Banner, DataTable, EmptyState, Field, Page, StatusBadge, SubmitButton, notify, useAction } from "../components/ui.tsx";
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

const countryLabel = (code: string) => TIMEZ_COUNTRIES.find((c) => c.code === code)?.name ?? code;
type Show = "all" | "unread" | "ack" | "pinned";

function dateLabel(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

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
  const [selectedId, setSelectedId] = useState(() => params.get("id") ?? "");
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

  const linked = params.get("id");
  useEffect(() => {
    if (linked) setSelectedId(linked);
  }, [linked]);

  const actor = { id: employee.id, fullName: employee.fullName, role: demoProfile.role };
  const me = employee.id;
  const canManage = (a: Announcement) => (API_ENABLED ? !!a.serverCanManage : canManageAnnouncement(a, actor));
  const isRead = (a: Announcement) => a.readBy.includes(me);
  const isAcked = (a: Announcement) => (API_ENABLED ? !!a.acknowledged : !!a.acknowledgedBy?.includes(me));
  const needsAck = (a: Announcement) => !!a.mustAcknowledge && a.state === "Published" && !isAcked(a) && !canManage(a);
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
        .filter((a) =>
          show === "unread" ? a.state === "Published" && !isRead(a) : show === "ack" ? needsAck(a) : show === "pinned" ? !!a.pinned : true,
        )
        .filter((a) => !needle || `${a.title} ${a.body} ${a.author} ${a.category ?? ""} ${audienceLabel(a)}`.toLowerCase().includes(needle))
        .sort((a, b) => {
          if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
          return (b.publishedAt ?? b.scheduledFor ?? "").localeCompare(a.publishedAt ?? a.scheduledFor ?? "");
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mine, category, stateFilter, show, needle],
  );
  const unreadCount = mine.filter((a) => a.state === "Published" && !isRead(a)).length;
  const ackCount = mine.filter(needsAck).length;
  const pinnedCount = mine.filter((a) => a.pinned).length;
  const categoryCount = (c: string) => mine.filter((a) => (a.category ?? "General") === c).length;

  const selected = list.find((a) => a.id === selectedId) ?? mine.find((a) => a.id === selectedId) ?? list[0] ?? null;

  function markRead(a: Announcement) {
    if (a.state !== "Published" || isRead(a)) return;
    if (API_ENABLED) apiMarkAnnouncementRead(a.id);
    else markAnnouncementRead(a.id, me);
  }

  // Opening a post marks it read.
  useEffect(() => {
    if (selected) markRead(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  function open(a: Announcement) {
    setSelectedId(a.id);
    setError("");
    if (params.get("id")) {
      const next = new URLSearchParams(params);
      next.delete("id");
      setParams(next, { replace: true });
    }
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
    if (newId) setSelectedId(newId);
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

      <div className="ann-toolbar">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search announcements" aria-label="Search announcements" />
        <div className="ann-chips" role="group" aria-label="Show">
          {(
            [
              ["all", `All · ${mine.length}`],
              ["unread", `Unread · ${unreadCount}`],
              ["ack", `To acknowledge · ${ackCount}`],
              ["pinned", `Pinned · ${pinnedCount}`],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" className={show === id ? "chip-btn active" : "chip-btn"} aria-pressed={show === id} onClick={() => setShow(id)}>
              {label}
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
      <div className="ann-chips ann-cats" role="group" aria-label="Category">
        <button type="button" className={!category ? "chip-btn active" : "chip-btn"} onClick={() => setCategory("")}>
          All categories
        </button>
        {ANNOUNCEMENT_CATEGORIES.filter((c) => categoryCount(c) > 0 || c === category).map((c) => (
          <button key={c} type="button" className={category === c ? "chip-btn active" : "chip-btn"} aria-pressed={category === c} onClick={() => setCategory(c)}>
            <span className={`ann-dot cat-${c.toLowerCase()}`} aria-hidden /> {c} · {categoryCount(c)}
          </button>
        ))}
      </div>

      <div className="ann-layout">
        <section className="ann-list" aria-label="Announcements">
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
            <ul>
              {list.map((a) => {
                const unread = a.state === "Published" && !isRead(a);
                return (
                  <li key={a.id}>
                    <button type="button" className={`ann-item${selected?.id === a.id ? " active" : ""}${unread ? " unread" : ""}`} onClick={() => open(a)}>
                      <span className="ann-item-top">
                        <span className={`ann-tag cat-${(a.category ?? "General").toLowerCase()}`}>{a.category ?? "General"}</span>
                        {a.pinned && <span className="ann-pin">Pinned</span>}
                        {needsAck(a) && <span className="ann-ack">Acknowledge</span>}
                        {a.state !== "Published" && <StatusBadge status={a.state} />}
                        <span className="ann-date">{dateLabel(a.publishedAt ?? a.scheduledFor)}</span>
                      </span>
                      <strong className="ann-title">
                        {unread && <span className="ann-unread-dot" aria-label="Unread" />}
                        {a.title}
                      </strong>
                      <span className="ann-snippet">{a.body.replace(/\s+/g, " ").slice(0, 110)}</span>
                      <span className="ann-meta">
                        {a.author} · {audienceLabel(a)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <article className="ann-reader" aria-label="Announcement">
          {!selected ? (
            <EmptyState title="Pick an announcement" />
          ) : (
            <>
              <header className="ann-reader-head">
                <div className="ann-item-top">
                  <span className={`ann-tag cat-${(selected.category ?? "General").toLowerCase()}`}>{selected.category ?? "General"}</span>
                  {selected.pinned && <span className="ann-pin">Pinned</span>}
                  <StatusBadge status={selected.state} />
                  {selected.mustAcknowledge && (
                    <StatusBadge status={isAcked(selected) ? "Acknowledged" : "Must acknowledge"} tone={isAcked(selected) ? "ok" : "warn"} />
                  )}
                </div>
                <h2>{selected.title}</h2>
                <p className="muted">
                  {selected.author} · {audienceLabel(selected)}
                  {selected.publishedAt ? ` · ${dateLabel(selected.publishedAt)}` : ""}
                  {selected.scheduledFor ? ` · Scheduled ${dateLabel(selected.scheduledFor)}` : ""}
                </p>
              </header>
              <div className="ann-body">{selected.body}</div>

              {error && <Banner message={{ tone: "err", text: error }} />}

              <div className="ann-actions">
                {needsAck(selected) && (
                  <ActionButton
                    className="btn"
                    success="Acknowledged."
                    toastError
                    onAction={() => (API_ENABLED ? apiAcknowledgeAnnouncement(selected.id) : acknowledgeLocal(selected.id, me))}
                  >
                    Acknowledge
                  </ActionButton>
                )}
                {!API_ENABLED && selected.state === "Published" && isRead(selected) && !selected.mustAcknowledge && (
                  <ActionButton className="btn-ghost" success="Marked unread." onAction={() => markUnreadLocal(selected.id, me)}>
                    Mark unread
                  </ActionButton>
                )}
                {canManage(selected) && (
                  <>
                    <ActionButton
                      className="btn-ghost"
                      success={selected.pinned ? "Unpinned." : "Pinned to the top."}
                      toastError
                      onAction={() => (API_ENABLED ? apiPinAnnouncement(selected.id, !selected.pinned) : pinLocal(selected.id, !selected.pinned, actor))}
                    >
                      {selected.pinned ? "Unpin" : "Pin"}
                    </ActionButton>
                    {selected.state !== "Published" && (
                      <ActionButton className="btn" toastError onAction={() => changeState(selected, "Published")}>
                        Publish
                      </ActionButton>
                    )}
                    {selected.state === "Published" && (
                      <ActionButton className="btn-ghost" busyLabel="Moving…" doneLabel="Moved" toastError onAction={() => changeState(selected, "Draft")}>
                        Move to drafts
                      </ActionButton>
                    )}
                    {selected.receipts && (
                      <ActionButton className="btn-ghost" busyLabel="Loading…" doneLabel="Loaded" toastError onAction={() => toggleReceipts(selected.id)}>
                        {receipts?.id === selected.id ? "Hide receipts" : `Receipts · ${selected.receipts.read}/${selected.receipts.audience} read`}
                      </ActionButton>
                    )}
                  </>
                )}
              </div>

              {receipts?.id === selected.id && (
                <DataTable
                  headers={["Name", "Department", "Read", ...(selected.mustAcknowledge ? ["Acknowledged"] : [])]}
                  rows={receipts.rows.map((r) => [
                    r.name,
                    r.department,
                    r.readAt ? dateLabel(r.readAt) : "—",
                    ...(selected.mustAcknowledge ? [r.acknowledgedAt ? dateLabel(r.acknowledgedAt) : "—"] : []),
                  ])}
                />
              )}
            </>
          )}
        </article>
      </div>
    </Page>
  );
}
