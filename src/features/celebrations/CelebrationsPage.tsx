import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Banner, Card, EmptyState, Page, SubmitButton, Tabs, notify, useAction } from "../../components/ui.tsx";
import { usePortal } from "../../store.tsx";
import {
  KIND_LABEL,
  celebrationText,
  dayMonth,
  defaultWish,
  getHideBirthday,
  sendWish,
  setHideBirthday,
  useCelebrations,
  type Celebration,
} from "./celebrationsStore.ts";
import "./celebrations.css";

type Actor = { id: string; fullName: string; role: ReturnType<typeof usePortal>["demoProfile"]["role"] };

function useActor(): Actor {
  const { demoProfile } = usePortal();
  return { id: demoProfile.id, fullName: demoProfile.fullName, role: demoProfile.role };
}

function WishForm({ c, actor, onDone, onCancel }: { c: Celebration; actor: Actor; onDone: () => void; onCancel: () => void }) {
  const [message, setMessage] = useState(defaultWish(c.kind));
  const act = useAction();
  return (
    <form
      className="cel-compose"
      onSubmit={act.submit(() => sendWish(actor, c, message), { success: `Wishes sent to ${c.name}.`, onSuccess: onDone, toastError: true })}
    >
      <textarea aria-label={`Message to ${c.name}`} rows={2} maxLength={500} value={message} onChange={(e) => setMessage(e.target.value)} />
      <span className="cel-actions" style={{ marginLeft: 0 }}>
        <SubmitButton action={act} className="btn btn-tiny" busyLabel="Sending…" doneLabel="Sent">
          Send
        </SubmitButton>
        <button type="button" className="btn-ghost btn-tiny" onClick={onCancel}>
          Cancel
        </button>
      </span>
    </form>
  );
}

/** One row: date, person, what, and Send wishes (not for yourself). */
export function CelebrationRow({ c, actor, onSent }: { c: Celebration; actor: Actor; onSent: () => void }) {
  const [open, setOpen] = useState(false);
  const self = c.employeeId === actor.id;
  return (
    <li className="cel-row">
      <span className="cel-when">{dayMonth(c.date)}</span>
      <span className="cel-main">
        <Link to={`/people/${c.employeeId}`}>{c.name}</Link>
        <small>
          {KIND_LABEL[c.kind]}
          {c.kind === "anniversary" ? ` · ${celebrationText(c)}` : ""}
          {c.department ? ` · ${c.department}` : ""}
        </small>
      </span>
      {!self && !open && (
        <span className="cel-actions">
          {c.wishedByMe ? (
            <span className="muted">Wished</span>
          ) : (
            <button type="button" className="btn-ghost btn-tiny" onClick={() => setOpen(true)}>
              {c.kind === "new_joiner" ? "Welcome" : "Send wishes"}
            </button>
          )}
        </span>
      )}
      {open && (
        <WishForm
          c={c}
          actor={actor}
          onCancel={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            onSent();
          }}
        />
      )}
    </li>
  );
}

function PrivacyCard({ actorId }: { actorId: string }) {
  const [hide, setHide] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getHideBirthday(actorId)
      .then(setHide)
      .catch(() => setHide(false));
  }, [actorId]);
  return (
    <Card title="Privacy">
      <label className="cel-check">
        <input
          type="checkbox"
          checked={Boolean(hide)}
          disabled={hide === null}
          onChange={async (e) => {
            const next = e.target.checked;
            const problem = await setHideBirthday(actorId, next);
            setError(problem);
            if (!problem) {
              setHide(next);
              notify(next ? "Your birthday is hidden." : "Your birthday is shown to colleagues.");
            }
          }}
        />
        Hide my birthday
      </label>
      {error && <p className="note err">{error}</p>}
    </Card>
  );
}

export function CelebrationsPage() {
  const actor = useActor();
  const [tab, setTab] = useState("week");
  const { rows, loading, error, reload } = useCelebrations(actor.id, tab === "week" ? 7 : 31);
  const [kind, setKind] = useState("all");
  const shown = rows.filter((r) => kind === "all" || r.kind === kind);
  return (
    <Page title="Celebrations">
      <Tabs
        tabs={[
          { id: "week", label: "This week" },
          { id: "month", label: "Next 30 days" },
        ]}
        value={tab}
        onChange={setTab}
      />
      <Banner message={error ? { tone: "err", text: error } : null} />
      <Card
        title={`${shown.length} ${shown.length === 1 ? "celebration" : "celebrations"}`}
        action={
          <select aria-label="Show" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="all">All</option>
            <option value="birthday">Birthdays</option>
            <option value="anniversary">Work anniversaries</option>
            <option value="new_joiner">New joiners</option>
          </select>
        }
      >
        {loading ? (
          <p className="empty">Loading…</p>
        ) : shown.length ? (
          <ul className="cel-list">
            {shown.map((c) => (
              <CelebrationRow key={`${c.kind}-${c.employeeId}`} c={c} actor={actor} onSent={() => void reload()} />
            ))}
          </ul>
        ) : (
          <EmptyState title="Nothing to celebrate yet" description="" />
        )}
      </Card>
      <PrivacyCard actorId={actor.id} />
    </Page>
  );
}

/** Home: "Celebrations this week" (up to 6). */
export function CelebrationsHomeCard() {
  const actor = useActor();
  const { rows, loading, reload } = useCelebrations(actor.id, 7);
  const top = rows.slice(0, 6);
  return (
    <Card title="Celebrations this week" to="/celebrations">
      {loading ? (
        <p className="empty">Loading…</p>
      ) : top.length ? (
        <ul className="cel-list">
          {top.map((c) => (
            <CelebrationRow key={`${c.kind}-${c.employeeId}`} c={c} actor={actor} onSent={() => void reload()} />
          ))}
        </ul>
      ) : (
        <p className="empty">None this week</p>
      )}
      {rows.length > top.length && (
        <p className="note">
          <Link to="/celebrations">{rows.length - top.length} more</Link>
        </p>
      )}
    </Card>
  );
}
