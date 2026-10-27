import { useMemo, useState, useSyncExternalStore } from "react";
import { Banner, Card, DataTable, EmptyState, Field, MetricCard, MetricGrid, Page, StatusBadge, Tabs } from "../../components/ui.tsx";
import { formatShortDate } from "../../model.ts";
import { listPeople, subscribePeople } from "../../data/peopleLocal.ts";
import { getTalentState, subscribeTalent } from "../../data/talentLocal.ts";
import { isHr, personName } from "./shared.ts";
import { useActor } from "./useActor.ts";
import {
  LEVELS,
  MAX_SUCCESSORS,
  READINESS,
  addKeyRole,
  canAssess,
  canEditKeyRole,
  canOpenSuccession,
  canRemoveSuccessor,
  getSuccessionState,
  nominateSuccessor,
  removePlacement,
  removeSuccessor,
  reviewPerformance,
  savePlacement,
  seesAll,
  subscribeSuccession,
  successionPeople,
  visiblePeopleIds,
  type Level,
  type Placement,
  type Readiness,
} from "./successionStore.ts";
import "./talentplus.css";

type Msg = { tone: "ok" | "err" | "warn" | "info"; text: string } | null;

const BOX_NAMES: Record<string, string> = {
  "High-High": "Future leader",
  "High-Medium": "High performer",
  "High-Low": "Trusted professional",
  "Medium-High": "Growth employee",
  "Medium-Medium": "Core player",
  "Medium-Low": "Effective",
  "Low-High": "Rough diamond",
  "Low-Medium": "Inconsistent",
  "Low-Low": "Talent risk",
};

const LEVEL_TONE: Record<Level, "ok" | "warn" | "danger"> = { Low: "ok", Medium: "warn", High: "danger" };

export function SuccessionPage() {
  const actor = useActor();
  const state = useSyncExternalStore(subscribeSuccession, getSuccessionState);
  const people = useSyncExternalStore(subscribePeople, listPeople);
  useSyncExternalStore(subscribeTalent, getTalentState);
  const [tab, setTab] = useState("grid");

  const allowed = canOpenSuccession(actor);
  const visible = useMemo(() => (allowed ? visiblePeopleIds(actor) : new Set<string>()), [allowed, actor, people]);

  if (!allowed) {
    return (
      <Page title="Succession planning">
        <Card>
          <EmptyState title="Restricted" description="For HR, executives and people managers." />
        </Card>
      </Page>
    );
  }

  const placements = state.placements.filter((p) => visible.has(p.employeeId));

  return (
    <Page title="Succession planning">
      <Tabs
        tabs={[
          { id: "grid", label: "9-box grid" },
          { id: "roles", label: "Key roles" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "grid" && <NineBox placements={placements} visible={visible} />}
      {tab === "roles" && <KeyRoles visible={visible} />}
    </Page>
  );
}

/* ───────────── 9-box ───────────── */

function NineBox({ placements, visible }: { placements: Placement[]; visible: Set<string> }) {
  const actor = useActor();
  useSyncExternalStore(subscribePeople, listPeople);
  const people = successionPeople();
  const [editing, setEditing] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);

  const highRisk = placements.filter((p) => p.flightRisk === "High").length;
  const readyNow = placements.filter((p) => p.readiness === "Ready now").length;
  const assessable = people.filter((p) => visible.has(p.id) && canAssess(actor, p.id));

  return (
    <div className="stack">
      <MetricGrid>
        <MetricCard label="People placed" value={placements.length} />
        <MetricCard label="Ready now" value={readyNow} />
        <MetricCard label="High flight risk" value={highRisk} />
      </MetricGrid>
      <Card title="Talent grid">
        <div className="tp-ninebox-wrap">
          <div className="tp-axis-y">Potential →</div>
          <div className="tp-ninebox">
            {(["High", "Medium", "Low"] as Level[]).map((potential) =>
              (["Low", "Medium", "High"] as Level[]).map((performance) => {
                const key = `${performance}-${potential}`;
                const inCell = placements.filter((p) => p.performance === performance && p.potential === potential);
                const cls = key === "High-High" ? "tp-cell tp-star" : key === "Low-Low" ? "tp-cell tp-risk" : "tp-cell";
                return (
                  <div key={key} className={cls}>
                    <h3>{BOX_NAMES[key]}</h3>
                    <p className="muted">
                      Perf {performance.toLowerCase()} · pot {potential.toLowerCase()}
                    </p>
                    <ul>
                      {inCell.map((p) => (
                        <li key={p.employeeId}>
                          <button type="button" onClick={() => { setMsg(null); setEditing(p.employeeId); }} title={`Flight risk ${p.flightRisk.toLowerCase()} · ${p.readiness}`}>
                            {personName(p.employeeId)}
                            {p.flightRisk === "High" && <span className="tp-risk-dot" aria-label="High flight risk" />}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              }),
            )}
          </div>
          <div className="tp-axis-x">Performance →</div>
        </div>
      </Card>
      <PlacementForm
        key={editing ?? "new"}
        employeeId={editing}
        candidates={assessable.map((p) => ({ id: p.id, name: p.fullName, designation: p.designation }))}
        onClose={(text) => {
          setEditing(null);
          if (text) setMsg({ tone: "ok", text });
        }}
      />
      <Banner message={msg} />
      <Card title="Assessments">
        <DataTable
          headers={["Person", "Performance", "Potential", "Flight risk", "Readiness", "Updated"]}
          rows={placements.map((p) => [
            <button key="n" type="button" className="btn btn-ghost btn-tiny" onClick={() => setEditing(p.employeeId)}>
              {personName(p.employeeId)}
            </button>,
            p.performance,
            p.potential,
            <StatusBadge key="r" status={p.flightRisk} tone={LEVEL_TONE[p.flightRisk]} literal />,
            p.readiness,
            `${formatShortDate(p.updatedOn)} by ${personName(p.updatedBy)}`,
          ])}
          empty={<EmptyState title="Nobody placed yet" description="Add a person to start the grid." />}
        />
      </Card>
    </div>
  );
}

function PlacementForm({
  employeeId,
  candidates,
  onClose,
}: {
  employeeId: string | null;
  candidates: { id: string; name: string; designation: string }[];
  onClose: (message?: string) => void;
}) {
  const actor = useActor();
  const existing = employeeId ? getSuccessionState().placements.find((p) => p.employeeId === employeeId) : undefined;
  const [search, setSearch] = useState("");
  const [personId, setPersonId] = useState(employeeId ?? "");
  const prefill = personId ? reviewPerformance(personId) : null;
  const [performance, setPerformance] = useState<Level | "">(existing?.performance ?? "");
  const [potential, setPotential] = useState<Level | "">(existing?.potential ?? "");
  const [flightRisk, setFlightRisk] = useState<Level | "">(existing?.flightRisk ?? "");
  const [readiness, setReadiness] = useState<Readiness | "">(existing?.readiness ?? "");
  const [note, setNote] = useState(existing?.note ?? "");
  const [msg, setMsg] = useState<Msg>(null);
  const editable = !employeeId || canAssess(actor, employeeId);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q ? candidates.filter((c) => c.name.toLowerCase().includes(q)) : candidates;
    return list.slice(0, 200);
  }, [candidates, search]);

  function choose(id: string) {
    setPersonId(id);
    const current = getSuccessionState().placements.find((p) => p.employeeId === id);
    const fromReview = id ? reviewPerformance(id) : null;
    setPerformance(current?.performance ?? fromReview?.level ?? "");
    setPotential(current?.potential ?? "");
    setFlightRisk(current?.flightRisk ?? "");
    setReadiness(current?.readiness ?? "");
    setNote(current?.note ?? "");
  }

  function save() {
    const error = savePlacementSafe();
    if (error) setMsg({ tone: "err", text: error });
    else onClose(`${personName(personId)} saved on the grid.`);
  }

  function savePlacementSafe() {
    if (!personId) return "Choose a person.";
    if (!performance) return "Choose a performance level.";
    if (!potential) return "Choose a potential level.";
    if (!flightRisk) return "Choose a flight risk.";
    if (!readiness) return "Choose a readiness.";
    return savePlacement(actor, { employeeId: personId, performance, potential, flightRisk, readiness, note });
  }

  function remove() {
    if (!employeeId) return;
    const error = removePlacement(actor, employeeId);
    if (error) setMsg({ tone: "err", text: error });
    else onClose(`${personName(employeeId)} removed from the grid.`);
  }

  return (
    <Card title={employeeId ? `Assess ${personName(employeeId)}` : "Place a person"}>
      {!editable ? (
        <p className="note">View only. HR or their reporting line can edit.</p>
      ) : (
        <>
          <div className="form-grid-2">
            {!employeeId && (
              <>
                <Field label="Search people">
                  <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Type a name" />
                </Field>
                <Field label="Person">
                  <select value={personId} onChange={(e) => choose(e.target.value)}>
                    <option value="">Choose…</option>
                    {filtered.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} · {c.designation}
                      </option>
                    ))}
                  </select>
                </Field>
              </>
            )}
            <Field label="Performance">
              <select value={performance} onChange={(e) => setPerformance(e.target.value as Level)}>
                <option value="">Choose…</option>
                {LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Potential">
              <select value={potential} onChange={(e) => setPotential(e.target.value as Level)}>
                <option value="">Choose…</option>
                {LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Flight risk">
              <select value={flightRisk} onChange={(e) => setFlightRisk(e.target.value as Level)}>
                <option value="">Choose…</option>
                {LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Readiness">
              <select value={readiness} onChange={(e) => setReadiness(e.target.value as Readiness)}>
                <option value="">Choose…</option>
                {READINESS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Note" wide>
              <input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </div>
          {prefill && <p className="note info">Latest review rating: {prefill.rating} (suggests {prefill.level.toLowerCase()} performance).</p>}
          <Banner message={msg} />
          <div className="row-gap" style={{ marginTop: 12 }}>
            <button type="button" className="btn" onClick={save}>
              Save
            </button>
            {employeeId && (
              <>
                <button type="button" className="btn btn-ghost" onClick={() => onClose()}>
                  Cancel
                </button>
                <button type="button" className="btn btn-ghost" onClick={remove}>
                  Remove from grid
                </button>
              </>
            )}
          </div>
        </>
      )}
      {!editable && (
        <button type="button" className="btn btn-ghost" onClick={() => onClose()}>
          Close
        </button>
      )}
    </Card>
  );
}

/* ───────────── Key roles ───────────── */

function KeyRoles({ visible }: { visible: Set<string> }) {
  const actor = useActor();
  const state = useSyncExternalStore(subscribeSuccession, getSuccessionState);
  useSyncExternalStore(subscribePeople, listPeople);
  const people = successionPeople();
  const hr = isHr(actor.role);
  const all = seesAll(actor);
  const [msg, setMsg] = useState<Msg>(null);
  const [picks, setPicks] = useState<Record<string, { id: string; readiness: Readiness | "" }>>({});
  const [newTitle, setNewTitle] = useState("");
  const [incumbent, setIncumbent] = useState("");

  const nominees = people.filter((p) => visible.has(p.id) && p.id !== actor.id && canAssess(actor, p.id));
  const report = (e: string | null, ok: string) => setMsg(e ? { tone: "err", text: e } : { tone: "ok", text: ok });

  return (
    <div className="stack">
      <Banner message={msg} />
      {state.keyRoles.map((role) => {
        const shown = role.successors.filter((s) => visible.has(s.employeeId));
        const pick = picks[role.id] ?? { id: "", readiness: "" };
        return (
          <Card key={role.id} title={role.title}>
            <p className="muted" style={{ marginTop: 0 }}>
              Current holder: {personName(role.incumbentId)}
              {all ? ` · ${role.successors.length}/${MAX_SUCCESSORS} successors` : ""}
            </p>
            <DataTable
              headers={["Successor", "Readiness", "Nominated", ""]}
              rows={shown.map((s) => [
                personName(s.employeeId),
                <StatusBadge key="r" status={s.readiness} tone={s.readiness === "Ready now" ? "ok" : s.readiness === "Ready in 1–2 years" ? "info" : "neutral"} literal />,
                `${formatShortDate(s.nominatedOn)} by ${personName(s.nominatedBy)}`,
                canRemoveSuccessor(actor, role, s) ? (
                  <button key="x" type="button" className="btn btn-ghost btn-tiny" onClick={() => report(removeSuccessor(actor, role.id, s.employeeId), "Nomination removed.")}>
                    Remove
                  </button>
                ) : (
                  ""
                ),
              ])}
              empty={<p className="muted">No successors you can see yet.</p>}
            />
            {canEditKeyRole(actor, role) && role.successors.length < MAX_SUCCESSORS && (
              <div className="approval-actions">
                <select
                  aria-label={`Successor for ${role.title}`}
                  value={pick.id}
                  onChange={(e) => setPicks((p) => ({ ...p, [role.id]: { ...pick, id: e.target.value } }))}
                >
                  <option value="">Choose a successor…</option>
                  {nominees
                    .filter((p) => p.id !== role.incumbentId && !role.successors.some((s) => s.employeeId === p.id))
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.fullName} · {p.designation}
                      </option>
                    ))}
                </select>
                <select
                  aria-label="Readiness"
                  value={pick.readiness}
                  onChange={(e) => setPicks((p) => ({ ...p, [role.id]: { ...pick, readiness: e.target.value as Readiness } }))}
                >
                  <option value="">Readiness…</option>
                  {READINESS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn btn-tiny"
                  onClick={() => {
                    const e = nominateSuccessor(actor, role.id, pick.id, pick.readiness);
                    report(e, "Successor nominated.");
                    if (!e) setPicks((p) => ({ ...p, [role.id]: { id: "", readiness: "" } }));
                  }}
                >
                  Nominate
                </button>
              </div>
            )}
          </Card>
        );
      })}
      {hr && (
        <Card title="Add a key role">
          <div className="form-grid-2">
            <Field label="Role title">
              <input value={newTitle} maxLength={80} onChange={(e) => setNewTitle(e.target.value)} placeholder="e.g. Head of Finance" />
            </Field>
            <Field label="Current holder">
              <select value={incumbent} onChange={(e) => setIncumbent(e.target.value)}>
                <option value="">Choose…</option>
                {people
                  .filter((p) => p.employmentStatus !== "Terminated")
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.fullName} · {p.designation}
                    </option>
                  ))}
              </select>
            </Field>
          </div>
          <div className="row-gap" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="btn"
              onClick={() => {
                const e = addKeyRole(actor, newTitle, incumbent);
                report(e, "Key role added.");
                if (!e) {
                  setNewTitle("");
                  setIncumbent("");
                }
              }}
            >
              Add key role
            </button>
          </div>
        </Card>
      )}
    </div>
  );
}
