import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { ActionButton, Card, EmptyState, Page, notify } from "../components/ui.tsx";
import { NOTIF_CATEGORIES, notifPrefKey, type NotifCategory, type NotifPrefs } from "../data/collabData.ts";
import {
  deleteNotifications,
  getCollabState,
  markNotificationsRead,
  markNotificationsUnread,
  notifPrefsFor,
  setNotifPrefs,
  subscribeCollab,
  type NotifFeedItem,
} from "../data/collabLocal.ts";
import { buildNotificationFeed } from "../data/notificationFeed.ts";
import { getTickets, subscribeTickets } from "../data/ticketStore.ts";
import { usePortal } from "../store.tsx";
import { readableDates } from "../model.ts";
import "./notifications.css";

const PAGE_SIZE = 50;
const DAY_MS = 86_400_000;

type Bucket = "Today" | "Yesterday" | "Earlier this week" | "Older";
const BUCKETS: Bucket[] = ["Today", "Yesterday", "Earlier this week", "Older"];

/* ── Time helpers (always in the viewer's own time zone) ── */

function safeZone(timeZone: string | undefined): string | undefined {
  if (!timeZone) return undefined;
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return timeZone;
  } catch {
    return undefined;
  }
}

/** Day number (days since epoch) of a moment, as a calendar date in the given zone. */
function dayNumber(ms: number, timeZone?: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(ms)
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return Math.floor(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / DAY_MS);
}

function bucketOf(ms: number, now: number, timeZone?: string): Bucket {
  const today = dayNumber(now, timeZone);
  const diff = today - dayNumber(ms, timeZone);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  // Day 0 of the epoch was a Thursday; weeks start on Monday.
  const sinceMonday = (today + 3) % 7;
  return diff <= sinceMonday ? "Earlier this week" : "Older";
}

function relativeLabel(ms: number, now: number, timeZone?: string): string {
  const mins = Math.round((now - ms) / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 24 * 60 && dayNumber(ms, timeZone) === dayNumber(now, timeZone)) return `${Math.floor(mins / 60)} h ago`;
  const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit" }).format(ms);
  const days = dayNumber(now, timeZone) - dayNumber(ms, timeZone);
  if (days === 1) return `Yesterday, ${time}`;
  if (days > 1 && days < 7) {
    return `${new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short" }).format(ms)}, ${time}`;
  }
  const sameYear =
    new Intl.DateTimeFormat("en", { timeZone, year: "numeric" }).format(ms) ===
    new Intl.DateTimeFormat("en", { timeZone, year: "numeric" }).format(now);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(ms);
}

function fullStamp(ms: number, timeZone?: string): string {
  // dateStyle/timeStyle can't be combined with timeZoneName, so the zone is added separately.
  try {
    const stamp = new Intl.DateTimeFormat("en-GB", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(ms);
    return timeZone ? `${stamp} (${timeZone})` : stamp;
  } catch {
    return new Date(ms).toLocaleString();
  }
}

function atMs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** Re-render every minute so "5 min ago" stays true. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

const PREF_LABELS: Record<NotifCategory, string> = {
  Approvals: "Approvals waiting on me",
  Leave: "Leave",
  Tasks: "Tasks",
  Tickets: "Tickets",
  Mail: "Mail",
  Messages: "Chat messages",
  Attendance: "Attendance, timesheets, shifts",
  Holidays: "Holidays",
  Pay: "Pay and expenses",
  Recruiting: "Recruiting and internal jobs",
  System: "Announcements and other updates",
};

export function NotificationCenterPage() {
  const { employee, demoProfile, state } = usePortal();
  const userId = employee.id;
  const role = demoProfile.role;
  const timeZone = safeZone(employee.timeZone);
  const collab = useSyncExternalStore(subscribeCollab, getCollabState, getCollabState);
  const tickets = useSyncExternalStore(subscribeTickets, getTickets, getTickets);
  const now = useNow();

  const [category, setCategory] = useState<NotifCategory | "">("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [prefs, setPrefs] = useState<NotifPrefs>(() => notifPrefsFor(userId, collab));

  useEffect(() => {
    setPrefs(notifPrefsFor(userId, collab));
  }, [collab.prefsByUser, userId]);

  // Same function the shell badge uses (countUnreadNotificationsFor), so the counts always match.
  const feed = useMemo(
    () => buildNotificationFeed(userId, state, role),
    // collab and tickets are read inside buildNotificationFeed; listed so the feed refreshes when they change.
    [userId, role, state, collab, tickets],
  );
  const unreadTotal = feed.filter((i) => i.unread).length;
  const clearable = feed.filter((i) => !i.unread);

  const needle = query.trim().toLowerCase();
  const searched = useMemo(
    () =>
      feed.filter((i) => {
        if (unreadOnly && !i.unread) return false;
        if (!needle) return true;
        return `${i.head.title} ${i.head.body} ${i.head.category}`.toLowerCase().includes(needle);
      }),
    [feed, unreadOnly, needle],
  );
  const categoryCounts = useMemo(() => {
    const counts = new Map<NotifCategory, number>();
    searched.forEach((i) => counts.set(i.head.category, (counts.get(i.head.category) ?? 0) + 1));
    return counts;
  }, [searched]);
  const list = category ? searched.filter((i) => i.head.category === category) : searched;
  const shown = list.slice(0, limit);

  const groups = useMemo(() => {
    const out = new Map<Bucket, NotifFeedItem[]>();
    shown.forEach((item) => {
      const bucket = bucketOf(atMs(item.head.at), now, timeZone);
      out.set(bucket, [...(out.get(bucket) ?? []), item]);
    });
    return BUCKETS.filter((b) => out.has(b)).map((b) => ({ bucket: b, items: out.get(b)! }));
  }, [shown, now, timeZone]);

  useEffect(() => {
    setLimit(PAGE_SIZE);
  }, [category, unreadOnly, needle]);

  function flash(text: string) {
    notify(text);
  }

  function markAllRead() {
    markNotificationsRead(feed.filter((i) => i.unread).flatMap((i) => i.ids), userId);
    flash("All marked as read.");
  }

  function clearRead() {
    const ids = clearable.flatMap((i) => i.ids);
    deleteNotifications(ids, userId);
    flash(`Cleared ${clearable.length}.`);
  }

  function savePrefs() {
    setNotifPrefs(prefs, userId);
    setPrefsOpen(false);
    flash("Preferences saved.");
  }

  const filterChips: { id: NotifCategory | ""; label: string; count: number }[] = [
    { id: "", label: "All", count: searched.length },
    ...NOTIF_CATEGORIES.filter((c) => (categoryCounts.get(c) ?? 0) > 0 || c === category).map((c) => ({
      id: c,
      label: c,
      count: categoryCounts.get(c) ?? 0,
    })),
  ];

  return (
    <Page
      title="Notifications"
      subtitle={unreadTotal ? `${unreadTotal} unread` : "All caught up"}
      action={
        <div className="row-gap">
          <button type="button" className="btn-ghost" onClick={() => setPrefsOpen((v) => !v)} aria-expanded={prefsOpen}>
            Preferences
          </button>
          <ActionButton className="btn-ghost" onAction={clearRead} disabled={clearable.length === 0} busyLabel="Clearing…" doneLabel="Cleared">
            Clear read
          </ActionButton>
          <ActionButton className="btn-ghost" onAction={markAllRead} disabled={unreadTotal === 0}>
            Mark all read
          </ActionButton>
        </div>
      }
    >
      {prefsOpen && (
        <Card title="Notify me about">
          <div className="nc-prefs">
            {NOTIF_CATEGORIES.map((c) => {
              const key = notifPrefKey(c);
              return (
                <label key={c} className="nc-pref">
                  <input type="checkbox" checked={prefs[key]} onChange={(e) => setPrefs({ ...prefs, [key]: e.target.checked })} />
                  {PREF_LABELS[c]}
                </label>
              );
            })}
          </div>
          <label className="nc-pref nc-pref-digest">
            <input
              type="checkbox"
              checked={prefs.emailDigest}
              onChange={(e) => setPrefs({ ...prefs, emailDigest: e.target.checked })}
            />
            Daily email digest of unread items
          </label>
          <p className="muted nc-hint">Turned-off categories are not delivered and are hidden here.</p>
          <div className="row-gap">
            <ActionButton className="btn" onAction={savePrefs}>
              Save
            </ActionButton>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setPrefs(notifPrefsFor(userId, collab));
                setPrefsOpen(false);
              }}
            >
              Cancel
            </button>
          </div>
        </Card>
      )}

      <div className="nc-toolbar">
        <input
          type="search"
          className="nc-search"
          placeholder="Search notifications"
          aria-label="Search notifications"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="chip-row" role="group" aria-label="Show">
          <button type="button" className={unreadOnly ? "chip-btn" : "chip-btn active"} onClick={() => setUnreadOnly(false)}>
            All
          </button>
          <button type="button" className={unreadOnly ? "chip-btn active" : "chip-btn"} onClick={() => setUnreadOnly(true)}>
            Unread · {unreadTotal}
          </button>
        </div>
      </div>
      <div className="chip-row nc-cats" role="group" aria-label="Category">
        {filterChips.map((chip) => (
          <button
            key={chip.id || "all"}
            type="button"
            className={category === chip.id ? "chip-btn active" : "chip-btn"}
            aria-pressed={category === chip.id}
            onClick={() => setCategory(chip.id)}
          >
            {chip.label} · {chip.count}
          </button>
        ))}
      </div>

      <Card>
        {list.length === 0 ? (
          feed.length === 0 ? (
            <EmptyState title="No notifications" />
          ) : unreadOnly && !needle && !category ? (
            <EmptyState title="All caught up" />
          ) : (
            <EmptyState title="No matches" />
          )
        ) : (
          <>
            {groups.map(({ bucket, items }) => (
              <section key={bucket} className="nc-group" aria-label={bucket}>
                <h3 className="nc-group-title">{bucket}</h3>
                <ul className="nc-list">
                  {items.map((item) => (
                    <NotificationRow key={item.key} item={item} userId={userId} now={now} timeZone={timeZone} />
                  ))}
                </ul>
              </section>
            ))}
            {list.length > shown.length && (
              <button type="button" className="btn-ghost nc-more" onClick={() => setLimit((n) => n + PAGE_SIZE)}>
                Show more ({list.length - shown.length})
              </button>
            )}
          </>
        )}
      </Card>
    </Page>
  );
}

function NotificationRow({
  item,
  userId,
  now,
  timeZone,
}: {
  item: NotifFeedItem;
  userId: string;
  now: number;
  timeZone?: string;
}) {
  const n = item.head;
  const ms = atMs(n.at);
  const href = n.href || "/notifications";
  const open = () => markNotificationsRead(item.ids, userId);
  const cls = ["nc-item", item.unread ? "unread" : "", item.done ? "done" : ""].filter(Boolean).join(" ");

  return (
    <li className={cls}>
      <span className="nc-dot" aria-hidden />
      <div className="nc-main">
        <Link to={href} className="nc-title" onClick={open}>
          {n.title}
        </Link>
        {item.count > 1 && (
          <span className="nc-count" title={`${item.count} alike`}>
            ×{item.count}
          </span>
        )}
        {item.done && <span className="nc-done">Done</span>}
        {item.unread && <span className="sr-only">Unread</span>}
        {n.body && <p className="nc-body">{readableDates(n.body)}</p>}
        <div className="nc-meta">
          <span>{n.category}</span>
          <span aria-hidden>·</span>
          <time dateTime={n.at} title={fullStamp(ms, timeZone)}>
            {relativeLabel(ms, now, timeZone)}
          </time>
        </div>
      </div>
      <div className="nc-actions">
        <Link to={href} className={item.done ? "btn-ghost" : "btn"} onClick={open}>
          {item.done ? "View" : n.actionLabel || "Open"}
        </Link>
        {item.read ? (
          <button type="button" className="btn-ghost" onClick={() => markNotificationsUnread(item.ids, userId)}>
            Mark unread
          </button>
        ) : (
          <button type="button" className="btn-ghost" onClick={open}>
            Mark read
          </button>
        )}
        <button
          type="button"
          className="btn-ghost nc-delete"
          aria-label={`Delete “${n.title}”`}
          title="Delete"
          onClick={() => deleteNotifications(item.ids, userId)}
        >
          ×
        </button>
      </div>
    </li>
  );
}
