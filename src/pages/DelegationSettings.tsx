import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Banner, Card, Field, StatusBadge } from "../components/ui.tsx";
import { API_ENABLED } from "../api/client.ts";
import {
  activeDelegationFor,
  apiCreateDelegation,
  apiEndDelegation,
  loadApiDelegations,
  createDelegation,
  delegateCandidates,
  DELEGATION_SCOPES,
  endDelegation,
  getDelegationState,
  historyFor,
  personLabel,
  prefsFor,
  savePrefs,
  scopeText,
  subscribeDelegations,
  type Delegation,
  type DelegationScope,
} from "../data/delegations.ts";
import { formatShortDate, todayISO } from "../model.ts";

function statusOf(d: Delegation, today: string): { text: string; tone: "ok" | "info" | "neutral" } {
  if (d.endedOn) return { text: "Ended", tone: "neutral" };
  if (d.to < today) return { text: "Finished", tone: "neutral" };
  if (d.from > today) return { text: "Scheduled", tone: "info" };
  return { text: "Active", tone: "ok" };
}

/** "Delegate approvals" section on the Approvals page (blueprint §25). Shown to anyone with people below them. */
export function DelegationSettings({ myId }: { myId: string }) {
  useSyncExternalStore(subscribeDelegations, getDelegationState, getDelegationState);
  const today = todayISO();
  const candidates = useMemo(() => delegateCandidates(myId), [myId]);
  const prefs = prefsFor(myId);
  const history = historyFor(myId);
  const current = activeDelegationFor(myId, today);

  const [delegateId, setDelegateId] = useState("");
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [note, setNote] = useState("");
  const [allTypes, setAllTypes] = useState(true);
  const [picked, setPicked] = useState<DelegationScope[]>([]);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const report = (error: string | null, success: string) => setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: success });

  // Backend mode: delegations are kept on the server, which applies them when approvals are decided.
  useEffect(() => {
    if (API_ENABLED) void loadApiDelegations().then((error) => error && setMessage({ tone: "err", text: error }));
  }, [myId]);

  async function submit() {
    const input = { delegatorId: myId, delegateId, from, to, note, scope: allTypes ? ("all" as const) : picked };
    const error = API_ENABLED ? await apiCreateDelegation(input) : createDelegation(input);
    report(error, `Approvals delegated to ${personLabel(delegateId)} until ${formatShortDate(to)}.`);
    if (!error) {
      setNote("");
      setDelegateId("");
    }
  }

  const autoDefault = candidates.find((c) => c.relation === "Your manager");

  return (
    <Card title="Delegate approvals">
      <Banner message={message} />
      {current && (
        <p className="note info">
          {current.auto ? "Automatic cover while you're on leave: " : ""}Delegated to {personLabel(current.delegateId)} until{" "}
          {formatShortDate(current.to)} · {scopeText(current.scope)}
        </p>
      )}
      <p className="muted">
        Your delegate decides your team's requests for the dates you set — never their own.
      </p>
      <div className="form-grid">
        <Field label="Delegate to">
          <select value={delegateId} onChange={(e) => setDelegateId(e.target.value)}>
            <option value="">Choose…</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} — {c.relation}
              </option>
            ))}
          </select>
        </Field>
        <Field label="From">
          <input type="date" value={from} min={today} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <input type="date" value={to} min={from || today} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="Note (optional)">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Travelling for the client visit" />
        </Field>
        <Field label="Request types" wide>
          <span className="row-wrap">
            <label>
              <input type="checkbox" checked={allTypes} onChange={(e) => setAllTypes(e.target.checked)} /> All request types
            </label>
            {!allTypes &&
              DELEGATION_SCOPES.map((s) => (
                <label key={s.id}>
                  <input
                    type="checkbox"
                    checked={picked.includes(s.id)}
                    onChange={(e) => setPicked((prev) => (e.target.checked ? [...prev, s.id] : prev.filter((x) => x !== s.id)))}
                  />{" "}
                  {s.label}
                </label>
              ))}
          </span>
        </Field>
      </div>
      <div className="approval-actions">
        <button type="button" className="btn btn-tiny" onClick={() => void submit()}>
          Delegate
        </button>
      </div>

      {!API_ENABLED && (
      <div className="form-grid">
        <Field label="While I'm on approved leave" wide>
          <label>
            <input
              type="checkbox"
              checked={prefs.autoOnLeave}
              onChange={(e) =>
                report(savePrefs(myId, { ...prefs, autoOnLeave: e.target.checked }), e.target.checked ? "Automatic cover turned on." : "Automatic cover turned off.")
              }
            />{" "}
            Delegate automatically while I'm on approved leave
          </label>
        </Field>
        {prefs.autoOnLeave && (
          <Field label="Cover during leave">
            <select
              value={prefs.autoDelegateId ?? ""}
              onChange={(e) => report(savePrefs(myId, { ...prefs, autoDelegateId: e.target.value || undefined }), "Leave cover saved.")}
            >
              <option value="">{autoDefault ? `My manager (${autoDefault.name})` : "My manager"}</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {c.relation}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      )}

      {history.length > 0 && (
        <ul className="approval-list">
          {history.map((d) => {
            const st = statusOf(d, today);
            return (
              <li key={d.id} className="approval-item">
                <div className="row-between">
                  <strong>{personLabel(d.delegateId)}</strong>
                  <StatusBadge status={st.text} tone={st.tone} literal />
                </div>
                <span>
                  {formatShortDate(d.from)} – {formatShortDate(d.to)} · {scopeText(d.scope)}
                  {d.endedOn ? ` · ended ${formatShortDate(d.endedOn)}` : ""}
                </span>
                {d.note && <span className="muted">{d.note}</span>}
                {!d.endedOn && d.to >= today && (
                  <div className="approval-actions">
                    <button type="button" className="btn-ghost btn-tiny" onClick={async () => report(API_ENABLED ? await apiEndDelegation(d.id) : endDelegation(d.id, myId), "Delegation ended.")}>
                      {d.from > today ? "Cancel" : "End now"}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
