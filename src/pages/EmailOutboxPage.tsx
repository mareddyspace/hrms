import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Banner,
  Card,
  DataTable,
  EmptyState,
  FilterBar,
  MetricCard,
  MetricGrid,
  Page,
  StatusBadge,
} from "../components/ui.tsx";
import { appendAuditEntries } from "../data/auditTrail.ts";
import { ADMIN_ROLES } from "../data/collabData.ts";
import {
  clearSentEmails,
  markEmailsSentAnywhere,
  useEmailOutbox,
  type EmailEvent,
  type EmailStatus,
} from "../data/emailOutbox.ts";
import { usePortal } from "../store.tsx";

const CHANNEL_LABEL: Record<string, string> = {
  approvals: "Approvals",
  announcements: "Announcements",
  integrations: "Integration alerts",
  general: "General",
};

function formatWhen(iso: string | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** Admin view of emails queued alongside notifications, with simulated sending. */
export function EmailOutboxPage() {
  const { employee, demoProfile } = usePortal();
  const rows = useEmailOutbox();
  const [status, setStatus] = useState<EmailStatus | "all">("Queued");
  const [channel, setChannel] = useState("all");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "info" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const isAdmin = ADMIN_ROLES.includes(demoProfile.role);

  const channels = useMemo(() => Array.from(new Set(rows.map((r) => r.channel))).sort(), [rows]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (status === "all" || r.status === status) &&
        (channel === "all" || r.channel === channel) &&
        (!q || `${r.to} ${r.recipientName} ${r.subject} ${r.body}`.toLowerCase().includes(q)),
    );
  }, [rows, status, channel, query]);
  const queued = rows.filter((r) => r.status === "Queued").length;
  const sent = rows.length - queued;
  const open = rows.find((r) => r.id === openId) ?? null;

  function audit(count: number, what: string) {
    appendAuditEntries([
      {
        at: new Date().toISOString(),
        actorId: employee.id,
        actorName: employee.fullName,
        entity: "Email outbox",
        entityId: "email-outbox",
        action: "Updated",
        changes: [{ field: what, before: "", after: `${count} ${count === 1 ? "email" : "emails"}` }],
      },
    ]);
  }

  async function markOne(row: EmailEvent) {
    const out = await markEmailsSentAnywhere([row.id]);
    if ("error" in out) return setMessage({ tone: "err", text: out.error });
    if (out.count > 0) {
      audit(1, "Marked sent");
      setMessage({ tone: "ok", text: `Marked sent to ${row.to}.` });
    }
  }

  async function sendAll() {
    if (busy) return;
    setBusy(true);
    const out = await markEmailsSentAnywhere("all");
    setBusy(false);
    if ("error" in out) return setMessage({ tone: "err", text: out.error });
    const count = out.count;
    if (count > 0) audit(count, "Sent queued");
    setMessage(count ? { tone: "ok", text: `${count} ${count === 1 ? "email" : "emails"} sent.` } : { tone: "info", text: "Nothing queued." });
  }

  function clearSent() {
    const count = clearSentEmails();
    setMessage(count ? { tone: "ok", text: `Cleared ${count} sent ${count === 1 ? "email" : "emails"}.` } : { tone: "info", text: "No sent emails to clear." });
  }

  if (!isAdmin) {
    return (
      <Page title="Email outbox">
        <EmptyState title="Admins only" description="Ask an administrator for access." />
      </Page>
    );
  }

  return (
    <Page
      title="Email outbox"
      action={
        <button type="button" className="btn" disabled={queued === 0 || busy} onClick={() => void sendAll()}>
          Send all queued
        </button>
      }
    >
      <MetricGrid>
        <MetricCard label="Queued" value={queued} />
        <MetricCard label="Sent" value={sent} />
        <MetricCard label="Total" value={rows.length} />
      </MetricGrid>
      <Banner message={message} />
      <FilterBar>
        <label className="filter-label">
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value as EmailStatus | "all")}>
            <option value="Queued">Queued</option>
            <option value="Sent">Sent</option>
            <option value="all">All</option>
          </select>
        </label>
        <label className="filter-label">
          Channel
          <select value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="all">All channels</option>
            {channels.map((c) => (
              <option key={c} value={c}>{CHANNEL_LABEL[c] ?? c}</option>
            ))}
          </select>
        </label>
        <label className="filter-label">
          Search
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Recipient or subject" />
        </label>
        <button type="button" className="btn-ghost" disabled={sent === 0} onClick={clearSent}>
          Clear sent
        </button>
      </FilterBar>
      <div className="collab-split">
        <Card title="Emails">
          <DataTable
            headers={["To", "Subject", "Channel", "Queued", "Status", ""]}
            rows={filtered.map((r) => [
              <span key={`${r.id}-to`}>
                {r.recipientName}
                <div className="muted">{r.to}</div>
              </span>,
              r.subject,
              CHANNEL_LABEL[r.channel] ?? r.channel,
              formatWhen(r.createdAt),
              <StatusBadge key={`${r.id}-s`} status={r.status} tone={r.status === "Sent" ? "ok" : "warn"} literal />,
              <span key={`${r.id}-a`} className="row-gap">
                <button type="button" className="quiet-link" onClick={() => setOpenId(r.id)}>
                  View
                </button>
                {r.status === "Queued" && (
                  <button type="button" className="quiet-link" onClick={() => void markOne(r)}>
                    Mark sent
                  </button>
                )}
              </span>,
            ])}
            empty={<EmptyState title="No emails" description="Emails appear here when people get notifications." />}
          />
        </Card>
        <Card title="Preview">
          {!open ? (
            <EmptyState title="Select an email" description="View the message as it will be sent." />
          ) : (
            <div className="stack">
              <dl className="kv">
                <dt>To</dt>
                <dd>{`${open.recipientName} <${open.to}>`}</dd>
                <dt>Subject</dt>
                <dd>{open.subject}</dd>
                <dt>Channel</dt>
                <dd>{CHANNEL_LABEL[open.channel] ?? open.channel}</dd>
                <dt>Queued</dt>
                <dd>{formatWhen(open.createdAt)}</dd>
                <dt>Status</dt>
                <dd>{open.status === "Sent" ? `Sent ${formatWhen(open.sentAt)}` : "Queued"}</dd>
              </dl>
              <p>{open.body}</p>
              {open.link && (
                <p className="muted">
                  Link: <a href={open.link}>{open.link}</a>
                </p>
              )}
              <Link to="/admin" className="quiet-link">Admin settings</Link>
            </div>
          )}
        </Card>
      </div>
    </Page>
  );
}

export default EmailOutboxPage;
