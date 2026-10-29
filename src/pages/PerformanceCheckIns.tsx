import { useState } from "react";
import { ActionButton, Banner, Card, EmptyState, Field, StatusBadge, SubmitButton, notify, useAction } from "../components/ui.tsx";
import type { DemoAccount } from "../demoAccounts.ts";
import {
  PRAISE_BADGES,
  type CheckInItem,
  type DevActionStatus,
  type FeedbackItem,
  type OneOnOne,
  type PerfReview,
  type PraiseBadge,
  type Reviewer360,
} from "../data/talentData.ts";
import {
  addCheckInItem,
  addDevAction,
  addFeedback,
  answerFeedbackRequest,
  canEditDevPlan,
  canNominate360,
  canSee360Responses,
  DEV_ACTION_STATUSES,
  devActionsOf,
  isMeetingInFuture,
  MAX_360_REVIEWERS,
  nominate360Reviewer,
  remove360Reviewer,
  removeDevAction,
  reviewer360Options,
  scheduleOneOnOne,
  setOneOnOneStatus,
  submit360Response,
  toggleCheckInItem,
  updateDevAction,
  updateOneOnOne,
  talentAction,
  type TalentActor,
  type TalentResult,
} from "../data/talentLocal.ts";
import { todayISO } from "../model.ts";

/** talentAction as a promise, so action buttons stay busy until the change (or backend call) finishes. */
function talentRun(change: () => TalentResult, done: (result: TalentResult) => void): Promise<TalentResult> {
  return new Promise((resolve) =>
    talentAction(change, (result) => {
      done(result);
      resolve(result);
    }),
  );
}

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
  const sendAction = useAction();

  const praise = feedback.filter((f) => f.kind === "Praise");
  const receivedPrivate = feedback.filter((f) => f.kind === "Feedback" && f.toId === me.id);
  const requestsForMe = feedback.filter((f) => f.kind === "Request" && f.toId === me.id && f.status === "Open");
  const myRequests = feedback.filter((f) => f.kind === "Request" && f.fromId === me.id);

  function submit() {
    const to = others.find((p) => p.id === toId);
    if (!to) {
      setBanner({ tone: "err", text: "Choose a colleague." });
      return false;
    }
    if (message.trim().length < 10) {
      setBanner({ tone: "err", text: "Write at least 10 characters." });
      return false;
    }
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
    if (error) {
      setBanner({ tone: "err", text: error });
      return false;
    }
    setMessage("");
    const okText =
      kind === "Praise"
        ? `Praise posted for ${to.fullName}.`
        : kind === "Feedback"
          ? `Private feedback sent to ${to.fullName}.`
          : `Feedback request sent to ${to.fullName}.`;
    setBanner({ tone: "ok", text: okText });
    notify(okText);
    return true;
  }

  return (
    <div className="stack">
      <Card title="Give or request feedback">
        <form className="stack" onSubmit={sendAction.submit(submit)}>
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
            <SubmitButton action={sendAction} className="btn">
              {kind === "Praise" ? "Post praise" : kind === "Feedback" ? "Send feedback" : "Send request"}
            </SubmitButton>
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
        <ActionButton
          className="btn btn-tiny"
          disabled={reply.trim().length < 10}
          success={`Feedback sent to ${request.fromName}.`}
          onAction={() => talentRun(() => answerFeedbackRequest(me, request.id, reply), (res) => setError(res ?? ""))}
        >
          Send
        </ActionButton>
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
  const scheduleAction = useAction();

  function schedule() {
    const other = others.find((p) => p.id === withId);
    if (!other) {
      setBanner({ tone: "err", text: "Choose your manager or a direct report." });
      return false;
    }
    const [manager, report] = other.id === myManager?.id ? [other, me] : [me, other];
    const result = scheduleOneOnOne(me, {
      managerId: manager.id,
      managerName: manager.fullName,
      employeeId: report.id,
      employeeName: report.fullName,
      date,
      time,
    });
    if ("error" in result) {
      setBanner({ tone: "err", text: result.error });
      return false;
    }
    setBanner({ tone: "ok", text: `1:1 with ${other.fullName} scheduled.` });
    notify(`1:1 with ${other.fullName} scheduled for ${date} at ${time}.`);
    setSelectedId(result.id);
    return true;
  }

  return (
    <div className="checkin-layout">
      <div className="stack">
        <Card title="Schedule a 1:1">
          <form className="stack" onSubmit={scheduleAction.submit(schedule)}>
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
              <SubmitButton action={scheduleAction} className="btn" disabled={others.length === 0}>
                Schedule
              </SubmitButton>
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
          onAdd={(text) => talentRun(() => addCheckInItem(me, meeting.id, "agenda", text), (res) => setError(res ?? ""))}
          onToggle={(id) => talentAction(() => toggleCheckInItem(me, meeting.id, "agenda", id), (res) => setError(res ?? ""))}
        />
        <ChecklistSection
          title="Action items"
          items={meeting.actionItems}
          onAdd={(text) => talentRun(() => addCheckInItem(me, meeting.id, "actionItems", text), (res) => setError(res ?? ""))}
          onToggle={(id) => talentAction(() => toggleCheckInItem(me, meeting.id, "actionItems", id), (res) => setError(res ?? ""))}
        />
        <Field label="Shared notes" wide>
          <textarea
            rows={4}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => notes !== meeting.notes && talentAction(() => updateOneOnOne(me, meeting.id, (m) => void (m.notes = notes)), (res) => setError(res ?? ""))}
            placeholder="Key points, decisions, how they are feeling…"
          />
        </Field>
        <div className="row-gap">
          {meeting.status === "Upcoming" ? (
            <ActionButton
              className="btn"
              disabled={notStarted}
              title={notStarted ? "Available once the meeting has started" : undefined}
              doneLabel="Completed"
              success={`1:1 with ${other} marked as completed.`}
              onAction={() => talentRun(() => setOneOnOneStatus(me, meeting.id, "Completed", notes), (res) => setError(res ?? ""))}
            >
              Mark as completed
            </ActionButton>
          ) : (
            <ActionButton
              className="btn-ghost"
              busyLabel="Reopening…"
              doneLabel="Reopened"
              success={`1:1 with ${other} reopened.`}
              onAction={() => talentRun(() => setOneOnOneStatus(me, meeting.id, "Upcoming"), (res) => setError(res ?? ""))}
            >
              Reopen
            </ActionButton>
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
  onAdd: (text: string) => Promise<TalentResult>;
  onToggle: (id: string) => void;
}) {
  const [text, setText] = useState("");
  const addAction = useAction();
  async function add() {
    if (!text.trim()) return false;
    const error = await onAdd(text.trim());
    if (error) return false;
    setText("");
    return true;
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
      <form className="row-gap" onSubmit={addAction.submit(add)}>
        <input aria-label={`Add ${title.toLowerCase()}`} value={text} onChange={(e) => setText(e.target.value)} placeholder={`Add ${title.toLowerCase()}…`} style={{ flex: 1 }} />
        <SubmitButton action={addAction} className="btn-ghost btn-tiny">
          Add
        </SubmitButton>
      </form>
    </section>
  );
}

/* ───────────────────────────── 360 FEEDBACK ── */

type Result = (error: string | null, okText?: string) => void;

/** Requests addressed to me: a 1–5 rating and a comment each. */
export function Pending360Requests({ me, requests, onResult }: { me: TalentActor; requests: { review: PerfReview; reviewer: Reviewer360 }[]; onResult: Result }) {
  if (requests.length === 0) return null;
  return (
    <Card title="360 feedback asked of you">
      <ul className="feedback-list">
        {requests.map(({ review }) => (
          <li key={review.id} className="feedback-item">
            <Answer360Form me={me} review={review} onResult={onResult} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Answer360Form({ me, review, onResult }: { me: TalentActor; review: PerfReview; onResult: Result }) {
  const [rating, setRating] = useState("4");
  const [comment, setComment] = useState("");
  const sendAction = useAction();
  return (
    <form
      className="stack"
      onSubmit={sendAction.submit(
        () =>
          talentRun(() => submit360Response(me, review.id, Number(rating), comment), (error) => {
            onResult(error, `360 feedback sent for ${review.employeeName}.`);
            if (!error) setComment("");
          }),
        { success: `360 feedback sent for ${review.employeeName}.` },
      )}
    >
      <strong>{review.employeeName}</strong>
      <div className="form-grid-2">
        <Field label="Rating (1–5)">
          <select value={rating} onChange={(e) => setRating(e.target.value)}>
            {[5, 4, 3, 2, 1].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </Field>
        <Field label="Comment" wide>
          <textarea rows={2} maxLength={600} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="What they do well, and one thing to work on" />
        </Field>
      </div>
      <div>
        <SubmitButton action={sendAction} className="btn btn-tiny" disabled={comment.trim().length < 5}>
          Send
        </SubmitButton>
      </div>
    </form>
  );
}

/** Nominees for one review: the employee or manager adds up to 3; managers and HR read the answers. */
export function Reviewers360({ me, review, open, onResult }: { me: TalentActor; review: PerfReview; open: boolean; onResult: Result }) {
  const list = review.reviewers360 ?? [];
  const canEdit = open && canNominate360(me, review);
  const showAnswers = canSee360Responses(me, review);
  const options = reviewer360Options(review);
  const [pick, setPick] = useState("");
  return (
    <div className="stack">
      {list.length === 0 ? (
        <p className="muted">No reviewers yet.</p>
      ) : (
        <ul className="todo">
          {list.map((r) => (
            <li key={r.reviewerId}>
              <strong>{r.reviewerName}</strong> · {r.respondedOn ? `answered ${r.respondedOn}` : "waiting"}
              {showAnswers && r.respondedOn ? ` · ${r.rating}/5 · ${r.comment}` : ""}
              {canEdit && !r.respondedOn && (
                <>
                  {" "}
                  <button type="button" className="quiet-link" onClick={() => talentAction(() => remove360Reviewer(me, review.id, r.reviewerId), (res) => onResult(res, "Reviewer removed."))}>
                    Remove
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && list.length < MAX_360_REVIEWERS && (
        <div className="row-gap">
          <select aria-label="Nominate reviewer" value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Choose reviewer…</option>
            {options.map((a) => (
              <option key={a.id} value={a.id}>{a.fullName}</option>
            ))}
          </select>
          <ActionButton
            className="btn btn-tiny"
            disabled={!pick}
            busyLabel="Sending…"
            doneLabel="Nominated"
            onAction={() => {
              const name = options.find((a) => a.id === pick)?.fullName ?? "Reviewer";
              return talentRun(() => nominate360Reviewer(me, review.id, pick), (error) => {
                onResult(error, `${name} asked for 360 feedback.`);
                if (!error) {
                  setPick("");
                  notify(`360 feedback request sent to ${name}.`);
                }
              });
            }}
          >
            Nominate
          </ActionButton>
          <span className="muted">{list.length}/{MAX_360_REVIEWERS}</span>
        </div>
      )}
    </div>
  );
}

/* ───────────────────────────── DEVELOPMENT PLAN ── */

export function DevPlanEditor({ me, review, open, onResult }: { me: TalentActor; review: PerfReview; open: boolean; onResult: Result }) {
  const actions = devActionsOf(review);
  const editable = open && canEditDevPlan(me, review);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const addAction = useAction();
  return (
    <div className="stack">
      {actions.length === 0 ? (
        <p className="muted">No actions yet.</p>
      ) : (
        <ul className="todo">
          {actions.map((a) => (
            <li key={a.id} className="row-gap">
              <span style={{ flex: 1 }}>{a.title}</span>
              {editable ? (
                <>
                  <input
                    type="date"
                    aria-label="Due date"
                    value={a.due}
                    onChange={(e) => talentAction(() => updateDevAction(me, review.id, a.id, { due: e.target.value }), (res) => onResult(res))}
                  />
                  <select
                    aria-label="Action status"
                    value={a.status}
                    onChange={(e) => talentAction(() => updateDevAction(me, review.id, a.id, { status: e.target.value as DevActionStatus }), (res) => onResult(res))}
                  >
                    {DEV_ACTION_STATUSES.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                  <button type="button" className="quiet-link" onClick={() => talentAction(() => removeDevAction(me, review.id, a.id), (res) => onResult(res, "Action removed."))}>
                    Remove
                  </button>
                </>
              ) : (
                <>
                  <span className="muted">{a.due ? `Due ${a.due}` : "No due date"}</span>
                  <StatusBadge status={a.status} literal tone={a.status === "Done" ? "ok" : a.status === "In progress" ? "info" : "neutral"} />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <form
          className="row-gap"
          onSubmit={addAction.submit(
            () =>
              talentRun(() => addDevAction(me, review.id, { title, due }), (error) => {
                onResult(error, "Action added.");
                if (!error) {
                  setTitle("");
                  setDue("");
                }
              }),
            { success: `Development action added for ${review.employeeName}.` },
          )}
        >
          <input aria-label="New action" value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} placeholder="New action" style={{ minWidth: 200 }} />
          <input type="date" aria-label="Due date" value={due} onChange={(e) => setDue(e.target.value)} />
          <SubmitButton action={addAction} className="btn btn-tiny" disabled={title.trim().length < 3}>
            Add
          </SubmitButton>
        </form>
      )}
    </div>
  );
}
