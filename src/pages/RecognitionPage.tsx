import { useMemo, useState, useSyncExternalStore, type FormEvent } from "react";
import { Heart } from "lucide-react";
import { Banner, Card, DataTable, EmptyState, Field, MetricCard, MetricGrid, Page, StatusBadge, Tabs } from "../components/ui.tsx";
import { usePortal } from "../store.tsx";
import { formatShortDate } from "../model.ts";
import { getTalentState, subscribeTalent } from "../data/talentLocal.ts";
import { isHr, type PlusActor } from "../features/talentplus/shared.ts";
import {
  allowanceLeft,
  cancelRedemption,
  decideRedemption,
  getRecognitionState,
  giveKudos,
  MAX_POINTS_PER_KUDOS,
  MONTHLY_ALLOWANCE,
  pointsBalance,
  pointsReceived,
  RECOGNITION_VALUES,
  recognitionPeople,
  redeemReward,
  rewardCatalogue,
  subscribeRecognition,
  toggleLike,
  wallItems,
  type RedemptionStatus,
  type WallItem,
} from "../features/recognition/recognitionStore.ts";
import "../features/recognition/recognition.css";

type Msg = { tone: "ok" | "err" | "warn" | "info"; text: string } | null;

function useRecognition() {
  return useSyncExternalStore(subscribeRecognition, getRecognitionState, getRecognitionState);
}

function result(error: string | null, ok: string): Msg {
  return error ? { tone: "err", text: error } : { tone: "ok", text: ok };
}

const STATUS_TONE: Record<RedemptionStatus, "ok" | "warn" | "danger" | "neutral"> = {
  Requested: "warn",
  Fulfilled: "ok",
  Declined: "danger",
  Cancelled: "neutral",
};

export function RecognitionPage() {
  const { demoProfile } = usePortal();
  const actor: PlusActor = useMemo(
    () => ({ id: demoProfile.id, fullName: demoProfile.fullName, role: demoProfile.role, department: demoProfile.department }),
    [demoProfile.id, demoProfile.fullName, demoProfile.role, demoProfile.department],
  );
  const data = useRecognition();
  const hr = isHr(actor.role);
  const open = data.redemptions.filter((r) => r.status === "Requested" && r.personId !== actor.id).length;
  const tabs = [
    { id: "wall", label: "Wall" },
    { id: "rewards", label: "Rewards" },
    ...(hr ? [{ id: "fulfil", label: open ? `Requests (${open})` : "Requests" }] : []),
  ];
  const [tab, setTab] = useState("wall");
  const active = tabs.some((t) => t.id === tab) ? tab : "wall";

  return (
    <Page title="Recognition">
      <MetricGrid>
        <MetricCard label="Points balance" value={pointsBalance(actor.id, data)} hint="To spend on rewards" />
        <MetricCard label="Left to give" value={allowanceLeft(actor.id, data)} hint={`Of ${MONTHLY_ALLOWANCE} this month`} />
        <MetricCard label="Points received" value={pointsReceived(actor.id, data)} />
      </MetricGrid>
      <Tabs tabs={tabs} value={active} onChange={setTab} />
      {active === "wall" && <Wall actor={actor} />}
      {active === "rewards" && <Rewards actor={actor} />}
      {active === "fulfil" && hr && <Fulfilment actor={actor} />}
    </Page>
  );
}

/* ───────────── Wall ───────────── */

const BLANK = { toId: "", value: RECOGNITION_VALUES[0] as string, message: "", points: "0" };

function Wall({ actor }: { actor: PlusActor }) {
  const data = useRecognition();
  const talent = useSyncExternalStore(subscribeTalent, getTalentState, getTalentState);
  const [form, setForm] = useState(BLANK);
  const [msg, setMsg] = useState<Msg>(null);
  const [filter, setFilter] = useState("all");
  const people = recognitionPeople().filter((p) => p.id !== actor.id);
  const left = allowanceLeft(actor.id, data);
  const items = wallItems(data, talent.feedback).filter((i) =>
    filter === "received" ? i.toId === actor.id : filter === "given" ? i.fromId === actor.id : true,
  );

  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const points = form.points === "" ? 0 : Number(form.points);
    setBusy(true);
    const error = await giveKudos(actor, { ...form, points });
    setBusy(false);
    const name = people.find((p) => p.id === form.toId)?.fullName ?? "them";
    setMsg(result(error, `Kudos sent to ${name}.`));
    if (!error) setForm(BLANK);
  }

  return (
    <>
      <Card title="Give kudos">
        <form className="stack" onSubmit={submit}>
          <Banner message={msg} />
          <div className="form-grid-2">
            <Field label="Colleague">
              <select value={form.toId} onChange={(e) => setForm({ ...form, toId: e.target.value })}>
                <option value="">Pick a colleague</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.fullName}
                    {p.department ? ` · ${p.department}` : ""}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Value">
              <select value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })}>
                {RECOGNITION_VALUES.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </Field>
            <Field label="Message" wide>
              <textarea rows={3} maxLength={500} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} placeholder="What did they do, and why did it matter?" />
            </Field>
            <Field label={`Points (optional, ${left} left this month)`}>
              <input
                type="number"
                min={0}
                max={Math.min(MAX_POINTS_PER_KUDOS, left)}
                step={5}
                value={form.points}
                onChange={(e) => setForm({ ...form, points: e.target.value })}
              />
            </Field>
          </div>
          <div className="row-gap">
            <button className="btn" type="submit" disabled={busy}>Send kudos</button>
          </div>
        </form>
      </Card>
      <Card
        title="Recognition wall"
        action={
          <select aria-label="Show" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">Everyone</option>
            <option value="received">Received by me</option>
            <option value="given">Given by me</option>
          </select>
        }
      >
        {items.length === 0 ? (
          <EmptyState title="Nothing here yet" description="Kudos and praise show up here." />
        ) : (
          <ul className="rc-feed">
            {items.map((item) => (
              <WallPost key={item.id} item={item} actor={actor} onError={(text) => setMsg({ tone: "err", text })} />
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function WallPost({ item, actor, onError }: { item: WallItem; actor: PlusActor; onError: (text: string) => void }) {
  const liked = item.likes.includes(actor.id);
  return (
    <li className="rc-post">
      <div className="rc-post-head">
        <span>
          <strong>{item.fromName}</strong> <span className="muted">recognised</span> <strong>{item.toName}</strong>
        </span>
        <span className="muted">{formatShortDate(item.createdOn)}</span>
      </div>
      <div className="row-gap rc-tags">
        {item.value && <span className="pill">{item.value}</span>}
        {item.points > 0 && <span className="rc-points">+{item.points} points</span>}
        {item.source === "praise" && <span className="muted">From Performance</span>}
      </div>
      <p className="rc-message">{item.message}</p>
      <button
        type="button"
        className={`rc-like${liked ? " on" : ""}`}
        aria-pressed={liked}
        onClick={async () => {
          const error = await toggleLike(actor, item.id);
          if (error) onError(error);
        }}
      >
        <Heart size={14} aria-hidden /> {item.likes.length || ""} {liked ? "Liked" : "Like"}
      </button>
    </li>
  );
}

/* ───────────── Rewards ───────────── */

function Rewards({ actor }: { actor: PlusActor }) {
  const data = useRecognition();
  const [msg, setMsg] = useState<Msg>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const balance = pointsBalance(actor.id, data);
  const mine = data.redemptions.filter((r) => r.personId === actor.id);

  return (
    <>
      <Banner message={msg} />
      <Card title="Rewards">
        <div className="rc-rewards">
          {rewardCatalogue(data).map((r) => (
            <article key={r.id} className="rc-reward">
              <h3>{r.name}</h3>
              <p className="muted">{r.description}</p>
              <p className="rc-points">{r.points} points</p>
              <input
                aria-label={`${r.name} note`}
                placeholder={r.needsDate ? "Preferred date" : "Note (optional)"}
                value={notes[r.id] ?? ""}
                maxLength={300}
                onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })}
              />
              <button
                className="btn btn-tiny"
                type="button"
                disabled={balance < r.points}
                onClick={async () => {
                  const error = await redeemReward(actor, r.id, notes[r.id] ?? "");
                  setMsg(result(error, `${r.name} requested — HR will fulfil it.`));
                  if (!error) setNotes({ ...notes, [r.id]: "" });
                }}
              >
                {balance < r.points ? `Need ${r.points - balance} more` : "Redeem"}
              </button>
            </article>
          ))}
        </div>
      </Card>
      <Card title="My requests">
        <DataTable
          headers={["Reward", "Points", "Requested", "Status", ""]}
          rows={mine.map((r) => [
            <span key="r">
              {r.rewardName}
              {r.decisionNote && <span className="muted rc-block">{r.decisionNote}</span>}
            </span>,
            String(r.points),
            formatShortDate(r.requestedOn),
            <StatusBadge key="s" status={r.status} tone={STATUS_TONE[r.status]} literal />,
            r.status === "Requested" ? (
              <button key="c" className="btn-ghost btn-tiny" type="button" onClick={async () => setMsg(result(await cancelRedemption(actor, r.id), "Request cancelled — points returned."))}>
                Cancel
              </button>
            ) : (
              ""
            ),
          ])}
          empty={<EmptyState title="No requests yet" />}
        />
      </Card>
    </>
  );
}

/* ───────────── Fulfilment (HR) ───────────── */

function Fulfilment({ actor }: { actor: PlusActor }) {
  const data = useRecognition();
  const [msg, setMsg] = useState<Msg>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const open = data.redemptions.filter((r) => r.status === "Requested");
  const closed = data.redemptions.filter((r) => r.status !== "Requested").slice(0, 20);

  return (
    <>
      <Banner message={msg} />
      <Card title="Open requests">
        {open.length === 0 ? (
          <EmptyState title="No open requests" />
        ) : (
          <ul className="approval-list">
            {open.map((r) => (
              <li key={r.id} className="approval-item">
                <strong>{r.personName}</strong>
                <span>
                  {r.rewardName} · {r.points} points · {formatShortDate(r.requestedOn)}
                </span>
                {r.note && <p className="muted">{r.note}</p>}
                {r.personId === actor.id ? (
                  <p className="muted">Your own request — another HR member handles it.</p>
                ) : (
                  <div className="approval-actions">
                    <input
                      aria-label="Note"
                      placeholder="Note (needed to decline)"
                      value={notes[r.id] ?? ""}
                      onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })}
                    />
                    <button className="btn btn-tiny" type="button" onClick={async () => setMsg(result(await decideRedemption(actor, r.id, true, notes[r.id] ?? ""), `Marked fulfilled for ${r.personName}.`))}>
                      Fulfil
                    </button>
                    <button className="btn-ghost btn-tiny" type="button" onClick={async () => setMsg(result(await decideRedemption(actor, r.id, false, notes[r.id] ?? ""), "Request declined — points returned."))}>
                      Decline
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {closed.length > 0 && (
        <Card title="Recent">
          <DataTable
            headers={["Person", "Reward", "Points", "Status", "By"]}
            rows={closed.map((r) => [
              r.personName,
              r.rewardName,
              String(r.points),
              <StatusBadge key="s" status={r.status} tone={STATUS_TONE[r.status]} literal />,
              r.decidedByName ?? "—",
            ])}
          />
        </Card>
      )}
    </>
  );
}
