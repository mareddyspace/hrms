import { useState, type FormEvent } from "react";
import { Banner, Card, EmptyState, Field, StatusBadge } from "../components/ui.tsx";
import type { DemoAccount } from "../demoAccounts.ts";
import {
  PRAISE_BADGES,
  type CheckInItem,
  type FeedbackItem,
  type OneOnOne,
  type PraiseBadge,
} from "../data/talentData.ts";
import {
  addCheckInItem,
  addFeedback,
  answerFeedbackRequest,
  isMeetingInFuture,
  scheduleOneOnOne,
  setOneOnOneStatus,
  toggleCheckInItem,
  updateOneOnOne,
  type TalentActor,
} from "../data/talentLocal.ts";
import { todayISO } from "../model.ts";

type Person = Pick<DemoAccount, "id" | "fullName">;
type OrgPerson = Pick<DemoAccount, "id" | "fullName" | "reportsToId">;

/* ───────────────────────────── FEEDBACK & PRAISE ── */

type FeedbackKind = FeedbackItem["kind"];

const KIND_HELP: Record<FeedbackKind, string> = {
  Praise: "Public — shows on the praise wall for everyone.",
  Feedback: "Private — only the recipient sees it.",
  Request: "Ask a colleague for feedback.",
};

export function FeedbackPanel({
  me,
  people,
  feedback,
}: {
  me: TalentActor;
  people: Person[];
  feedback: FeedbackItem[];
}) {
  const others = people.filter((p) => p.id !== me.id);
  const [kind, setKind] = useState<FeedbackKind>("Praise");
  const [toId, setToId] = useState(others[0]?.id ?? "");
  const [badge, setBadge] = useState<PraiseBadge>(PRAISE_BADGES[0]);
  const [message, setMessage] = useState("");
  const [banner, setBanner] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const praise = feedback.filter((f) => f.kind === "Praise");
  const receivedPrivate = feedback.filter((f) => f.kind === "Feedback" && f.toId === me.id);
  const requestsForMe = feedback.filter((f) => f.kind === "Request" && f.toId === me.id && f.status === "Open");
  const myRequests = feedback.filter((f) => f.kind === "Request" && f.fromId === me.id);

  function submit(event: FormEvent) {
    event.preventDefault();
    const to = others.find((p) => p.id === toId);
    if (!to) return setBanner({ tone: "err", text: "Choose a colleague." });
    if (message.trim().length < 10) return setBanner({ tone: "err", text: "Write at least 10 characters." });
    const error = addFeedback({
      kind,
      fromId: me.id,
      fromName: me.fullName,
      toId: to.id,
      toName: to.fullName,
      message: message.trim(),
      ...(kind === "Praise" ? { badge } : null),
      ...(kind === "Request" ? { aboutName: me.fullName, status: "Open" as const } : null),
    });
    if (error) return setBanner({ tone: "err", text: error });
    setMessage("");
    setBanner({
      tone: "ok",
      text:
        kind === "Praise"
          ? `Praise posted for ${to.fullName}.`
          : kind === "Feedback"
            ? `Private feedback sent to ${to.fullName}.`
            : `Feedback request sent to ${to.fullName}.`,
    });
  }

  return (
    <div className="stack">
      <Card title="Give or request feedback">
        <form className="stack" onSubmit={submit}>
          <div className="soft-tabs" role="group" aria-label="Feedback type">
            {(["Praise", "Feedback", "Request"] as const).map((k) => (
              <button
                key={k}
                type="button"
                className={kind === k ? "soft-tab active" : "soft-tab"}
                onClick={() => setKind(k)}
              >
                {k === "Feedback" ? "Private feedback" : k === "Request" ? "Request feedback" : "Praise"}
              </button>
            ))}
          </div>
          <p className="muted">{KIND_HELP[kind]}</p>
          <div className="form-grid-2">
            <Field label={kind === "Request" ? "Ask" : "To"}>
              <select value={toId} onChange={(e) => setToId(e.target.value)}>
                {others.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.fullName}
                  </option>
                ))}
              </select>
            </Field>
            {kind === "Praise" && (
              <Field label="Badge">
                <select value={badge} onChange={(e) => setBadge(e.target.value as PraiseBadge)}>
                  {PRAISE_BADGES.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </div>
          <Field label={kind === "Request" ? "Question" : "Message"} wide>
            <textarea
              rows={3}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={
                kind === "Request"
                  ? "What would you like feedback on?"
                  : "Be specific: what did they do and what was the impact?"
              }
            />
          </Field>
          <div>
            <button className="btn" type="submit">
              {kind === "Praise" ? "Post praise" : kind === "Feedback" ? "Send feedback" : "Send request"}
            </button>
          </div>
          <Banner message={banner} />
        </form>
      </Card>

      {requestsForMe.length > 0 && (
        <Card title={`Waiting for your feedback (${requestsForMe.length})`}>
          <ul className="feedback-list">
            {requestsForMe.map((r) => (
              <RequestRow key={r.id} request={r} me={me} />
            ))}
          </ul>
        </Card>
      )}

      <div className="feedback-columns">
        <Card title="Praise wall">
          {praise.length === 0 ? (
            <EmptyState title="No praise yet" description="Be the first to recognise a colleague." />
          ) : (
            <ul className="feedback-list">
              {praise.map((p) => (
                <li key={p.id} className="feedback-item praise">
                  <div className="row-between">
                    <strong>
                      {p.fromName} → {p.toName}
                    </strong>
                    {p.badge && <span className="praise-badge">{p.badge}</span>}
                  </div>
                  <p>{p.message}</p>
                  <span className="muted">{p.createdOn}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="stack">
          <Card title="Private feedback for you">
            {receivedPrivate.length === 0 ? (
              <EmptyState title="Nothing yet" />
            ) : (
              <ul className="feedback-list">
                {receivedPrivate.map((f) => (
                  <li key={f.id} className="feedback-item">
                    <strong>{f.fromName}</strong>
                    <p>{f.message}</p>
                    <span className="muted">{f.createdOn}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Your requests">
            {myRequests.length === 0 ? (
              <EmptyState title="No requests" />
            ) : (
              <ul className="feedback-list">
                {myRequests.map((r) => (
                  <li key={r.id} className="feedback-item">
                    <div className="row-between">
                      <strong>{r.toName}</strong>
                      <StatusBadge status={r.status ?? "Open"} tone={r.status === "Answered" ? "ok" : "info"} literal />
                    </div>
                    <p>{r.message}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function RequestRow({ request, me }: { request: FeedbackItem; me: TalentActor }) {
  const [reply, setReply] = useState("");
  const [error, setError] = useState("");
  return (
    <li className="feedback-item">
      <strong>{request.fromName} asks:</strong>
      <p>{request.message}</p>
      <div className="row-gap">
        <input aria-label="Your feedback"
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          placeholder="Your feedback (sent privately)…"
          style={{ flex: 1 }}
        />
        <button
          type="button"
          className="btn btn-tiny"
          disabled={reply.trim().length < 10}
          onClick={() => setError(answerFeedbackRequest(me, request.id, reply) ?? "")}
        >
          Send
        </button>
      </div>
      {error && <Banner message={{ tone: "err", text: error }} />}
    </li>
  );
}

/* ───────────────────────────── 1:1 CHECK-INS ── */

export function OneOnOnePanel({
  me,
  people,
  meetings,
}: {
  me: TalentActor;
  people: OrgPerson[];
  meetings: OneOnOne[];
}) {
  const mine = meetings
    .filter((m) => m.managerId === me.id || m.employeeId === me.id)
    .sort((a, b) => (a.status === b.status ? a.date.localeCompare(b.date) : a.status === "Upcoming" ? -1 : 1));
  const [selectedId, setSelectedId] = useState(mine[0]?.id ?? "");
  const selected = mine.find((m) => m.id === selectedId) ?? mine[0];
  // 1:1s are only with your own manager or your direct reports.
  const myManagerId = people.find((p) => p.id === me.id)?.reportsToId;
  const myManager = people.find((p) => p.id === myManagerId);
  const directReports = people.filter((p) => p.reportsToId === me.id && p.id !== me.id);
  const others = [...(myManager ? [myManager] : []), ...directReports];
  const [withId, setWithId] = useState(others[0]?.id ?? "");
  const [date, setDate] = useState(todayISO());
  const [time, setTime] = useState("10:00");
  const [banner, setBanner] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  function schedule(event: FormEvent) {
    event.preventDefault();
    const other = others.find((p) => p.id === withId);
    if (!other) return setBanner({ tone: "err", text: "Choose your manager or a direct report." });
    const [manager, report] = other.id === myManager?.id ? [other, me] : [me, other];
    const result = scheduleOneOnOne(me, {
      managerId: manager.id,
      managerName: manager.fullName,
      employeeId: report.id,
      employeeName: report.fullName,
      date,
      time,
    });
    if ("error" in result) return setBanner({ tone: "err", text: result.error });
    setBanner({ tone: "ok", text: `1:1 with ${other.fullName} scheduled.` });
    setSelectedId(result.id);
  }

  return (
    <div className="checkin-layout">
      <div className="stack">
        <Card title="Schedule a 1:1">
          <form className="stack" onSubmit={schedule}>
            <Field label="With">
              <select value={withId} onChange={(e) => setWithId(e.target.value)} disabled={others.length === 0}>
                {others.length === 0 && <option value="">No manager or direct reports</option>}
                {others.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.fullName}
                    {p.id === myManager?.id ? " (your manager)" : " (direct report)"}
                  </option>
                ))}
              </select>
            </Field>
            <div className="form-grid-2">
              <Field label="Date">
                <input type="date" value={date} min={todayISO()} onChange={(e) => setDate(e.target.value)} />
              </Field>
              <Field label="Time">
                <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              </Field>
            </div>
            <div>
              <button className="btn" type="submit" disabled={others.length === 0}>
                Schedule
              </button>
            </div>
            <Banner message={banner} />
          </form>
        </Card>
        <Card title="Your 1:1s">
          {mine.length === 0 ? (
            <EmptyState title="No 1:1s yet" />
          ) : (
            <ul className="checkin-list">
              {mine.map((m) => {
                const other = m.managerId === me.id ? m.employeeName : m.managerName;
                const openActions = m.actionItems.filter((i) => !i.done).length;
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      className={m.id === selected?.id ? "checkin-row active" : "checkin-row"}
                      onClick={() => setSelectedId(m.id)}
                    >
                      <span>
                        <strong>{other}</strong>
                        <span className="muted">
                          {m.date} · {m.time}
                          {openActions > 0 ? ` · ${openActions} open action${openActions > 1 ? "s" : ""}` : ""}
                        </span>
                      </span>
                      <StatusBadge status={m.status} tone={m.status === "Completed" ? "ok" : "info"} literal />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      {selected ? (
        <MeetingDetail key={selected.id} meeting={selected} me={me} />
      ) : (
        <Card>
          <EmptyState title="Pick a 1:1" />
        </Card>
      )}
    </div>
  );
}

function MeetingDetail({ meeting, me }: { meeting: OneOnOne; me: TalentActor }) {
  const other = meeting.managerId === me.id ? meeting.employeeName : meeting.managerName;
  const [notes, setNotes] = useState(meeting.notes);
  const [error, setError] = useState("");
  const notStarted = isMeetingInFuture(meeting);
  return (
    <Card title={`1:1 with ${other} · ${meeting.date} ${meeting.time}`}>
      <div className="stack">
        <ChecklistSection
          title="Agenda"
          hint="Either of you can add points."
          items={meeting.agenda}
          onAdd={(text) => setError(addCheckInItem(me, meeting.id, "agenda", text) ?? "")}
          onToggle={(id) => setError(toggleCheckInItem(me, meeting.id, "agenda", id) ?? "")}
        />
        <ChecklistSection
          title="Action items"
          items={meeting.actionItems}
          onAdd={(text) => setError(addCheckInItem(me, meeting.id, "actionItems", text) ?? "")}
          onToggle={(id) => setError(toggleCheckInItem(me, meeting.id, "actionItems", id) ?? "")}
        />
        <Field label="Shared notes" wide>
          <textarea
            rows={4}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => notes !== meeting.notes && setError(updateOneOnOne(me, meeting.id, (m) => void (m.notes = notes)) ?? "")}
            placeholder="Key points, decisions, how they are feeling…"
          />
        </Field>
        <div className="row-gap">
          {meeting.status === "Upcoming" ? (
            <button
              type="button"
              className="btn"
              disabled={notStarted}
              title={notStarted ? "Available once the meeting has started" : undefined}
              onClick={() => setError(setOneOnOneStatus(me, meeting.id, "Completed", notes) ?? "")}
            >
              Mark as completed
            </button>
          ) : (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setError(setOneOnOneStatus(me, meeting.id, "Upcoming") ?? "")}
            >
              Reopen
            </button>
          )}
          {notStarted && meeting.status === "Upcoming" && <span className="muted">Can be completed once it has started.</span>}
        </div>
        {error && <Banner message={{ tone: "err", text: error }} />}
      </div>
    </Card>
  );
}

function ChecklistSection({
  title,
  hint,
  items,
  onAdd,
  onToggle,
}: {
  title: string;
  hint?: string;
  items: CheckInItem[];
  onAdd: (text: string) => void;
  onToggle: (id: string) => void;
}) {
  const [text, setText] = useState("");
  function add(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    onAdd(text.trim());
    setText("");
  }
  return (
    <section>
      <h3 className="checkin-heading">{title}</h3>
      {hint && <p className="muted">{hint}</p>}
      <ul className="checklist">
        {items.map((item) => (
          <li key={item.id}>
            <label className={item.done ? "done" : undefined}>
              <input type="checkbox" checked={item.done} onChange={() => onToggle(item.id)} />
              <span>{item.text}</span>
            </label>
          </li>
        ))}
      </ul>
      <form className="row-gap" onSubmit={add}>
        <input aria-label={`Add ${title.toLowerCase()}`} value={text} onChange={(e) => setText(e.target.value)} placeholder={`Add ${title.toLowerCase()}…`} style={{ flex: 1 }} />
        <button type="submit" className="btn-ghost btn-tiny">
          Add
        </button>
      </form>
    </section>
  );
}
