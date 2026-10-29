/**
 * Effective-dated organization (backend migration 0013): version history of org units, job profiles and
 * positions, the org tree "as of" a past day, and the extra job profile details. API mode only.
 */
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  apiOrgHistory,
  apiOrgUnitsAsOf,
  apiUpdateJobProfile,
  apiUpdateOrgUnit,
  orgMirror,
  type OrgHistoryEntity,
  type OrgUnitOut,
  type OrgVersionOut,
} from "../../api/syncOpsOrg.ts";
import { Banner, DataTable, EmptyState, Field, StatusBadge, SubmitButton, useAction } from "../../components/ui.tsx";

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const FIELD_LABEL: Record<string, string> = {
  name: "Name",
  title: "Title",
  code: "Code",
  parent_id: "Parent",
  manager_id: "Manager",
  headcount: "Headcount",
  grade: "Grade",
  job_level: "Job level",
  experience_min_years: "Min experience",
  experience_max_years: "Max experience",
  education: "Education",
  responsibilities: "Responsibilities",
  description: "Description",
  family_id: "Job family",
  profile_id: "Job profile",
  department_id: "Department",
  location_id: "Location",
  country_code: "Country",
  filled: "Filled",
  status: "Status",
  active: "Active",
  required_skills: "Required skills",
  preferred_skills: "Preferred skills",
  type: "Type",
};

const CHANGE_LABEL: Record<string, string> = {
  created: "Created",
  updated: "Changed",
  deactivated: "Deactivated",
  reactivated: "Reactivated",
  baseline: "Starting record",
};

function show(value: unknown, unitName: (id: string) => string, field: string): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.join(", ") || "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if ((field === "parent_id" || field === "department_id" || field === "location_id") && typeof value === "string") return unitName(value);
  return String(value);
}

function useOrgApi() {
  return useSyncExternalStore(orgMirror.subscribe, orgMirror.get, orgMirror.get);
}

/** Version list for one record, newest first: what changed, from when, by whom. */
export function OrgHistoryList({ entity, id }: { entity: OrgHistoryEntity; id: string }) {
  const org = useOrgApi();
  const [rows, setRows] = useState<OrgVersionOut[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setRows(null);
    apiOrgHistory(entity, id)
      .then((r) => live && setRows(r))
      .catch((e) => live && setError(e instanceof Error ? e.message : "Couldn't load history."));
    return () => {
      live = false;
    };
  }, [entity, id]);
  const unitName = (uid: string) => org.units.find((u) => u.id === uid)?.name ?? uid;
  if (error) return <Banner message={{ tone: "err", text: error }} />;
  if (!rows) return <p className="muted">Loading…</p>;
  return (
    <DataTable
      headers={["From", "To", "Change", "Details", "By"]}
      rows={rows.map((v, i) => {
        const previous = rows[i + 1]?.snapshot;
        const fields = v.changed_fields.length ? v.changed_fields : [];
        const details = fields.length
          ? fields
              .map((f) => `${FIELD_LABEL[f] ?? f}: ${previous ? show(previous[f], unitName, f) + " → " : ""}${show(v.snapshot[f], unitName, f)}`)
              .join("; ")
          : String(v.snapshot.name ?? v.snapshot.title ?? v.snapshot.code ?? "");
        return [
          v.effective_from,
          v.effective_to ?? "Now",
          <StatusBadge key={`c-${v.id}`} status={CHANGE_LABEL[v.change] ?? v.change} tone={v.effective_to ? "neutral" : "ok"} literal />,
          v.reason ? `${details} (${v.reason})` : details,
          v.changed_by_name ?? (v.changed_by ? v.changed_by : "—"),
        ];
      })}
      empty={<EmptyState title="No history yet" />}
    />
  );
}

/** The org tree as it stood on a chosen day (from the server's version history). */
export function AsOfOrgTree() {
  const [day, setDay] = useState(todayIso());
  const [units, setUnits] = useState<OrgUnitOut[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<OrgUnitOut | null>(null);
  useEffect(() => {
    if (!day) return;
    let live = true;
    setUnits(null);
    setError(null);
    apiOrgUnitsAsOf(day)
      .then((rows) => live && setUnits(rows))
      .catch((e) => live && setError(e instanceof Error ? e.message : "Couldn't load the structure."));
    return () => {
      live = false;
    };
  }, [day]);

  const children = useMemo(() => {
    const map = new Map<string, OrgUnitOut[]>();
    const ids = new Set((units ?? []).map((u) => u.id));
    for (const u of units ?? []) {
      const parent = u.parent_id && ids.has(u.parent_id) ? u.parent_id : "";
      map.set(parent, [...(map.get(parent) ?? []), u]);
    }
    for (const list of map.values()) list.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
    return map;
  }, [units]);

  const render = (parent: string, depth: number): ReactNode =>
    (children.get(parent) ?? []).map((u) => (
      <li key={u.id} className="org-tree-node" style={{ marginLeft: depth ? 16 : 0 }}>
        <div className="org-tree-row">
          <span className="org-tree-spacer" />
          <div>
            <strong>{u.name}</strong>
            <span className="muted">
              {" "}
              · {u.type.replace(/_/g, " ")} · {u.code}
              {typeof u.headcount === "number" ? ` · Budget ${u.headcount}` : ""}
              {u.effective_from ? ` · since ${u.effective_from}` : ""}
            </span>{" "}
            <button type="button" className="btn-ghost btn-tiny" onClick={() => setHistoryFor(u)}>
              History
            </button>
          </div>
        </div>
        {depth < 8 && children.get(u.id)?.length ? <ul className="org-tree-list">{render(u.id, depth + 1)}</ul> : null}
      </li>
    ));

  return (
    <div className="stack">
      <label className="filter-label">
        As of date
        <input type="date" value={day} max={todayIso()} onChange={(e) => setDay(e.target.value)} />
      </label>
      {error && <Banner message={{ tone: "err", text: error }} />}
      {!units ? (
        <p className="muted">Loading…</p>
      ) : units.length ? (
        <ul className="org-tree-list">{render("", 0)}</ul>
      ) : (
        <EmptyState title="No units on this date" />
      )}
      {historyFor && (
        <div className="stack">
          <div className="row-gap">
            <strong>History: {historyFor.name}</strong>
            <button type="button" className="btn-ghost btn-tiny" onClick={() => setHistoryFor(null)}>
              Close
            </button>
          </div>
          <OrgHistoryList entity="units" id={historyFor.id} />
        </div>
      )}
    </div>
  );
}

/** Dated change of an org unit's manager, headcount budget or parent, plus its history. */
export function UnitDatedChange({ unitId, canEdit, onDone }: { unitId: string; canEdit: boolean; onDone?: (text: string) => void }) {
  const org = useOrgApi();
  const unit = org.units.find((u) => u.id === unitId);
  const [effective, setEffective] = useState(todayIso());
  const [headcount, setHeadcount] = useState(unit?.headcount == null ? "" : String(unit.headcount));
  const [managerId, setManagerId] = useState(unit?.manager_id ?? "");
  const [parentId, setParentId] = useState(unit?.parent_id ?? "");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const act = useAction();
  if (!unit) return null;

  async function save() {
    if (!unit) return false;
    const patch: Parameters<typeof apiUpdateOrgUnit>[1] = { effective_from: effective || null, reason: reason.trim() || null };
    const hc = headcount.trim() === "" ? null : Number(headcount);
    if (hc !== null && (!Number.isInteger(hc) || hc < 0)) {
      setNote({ tone: "err", text: "Headcount must be a whole number." });
      return false;
    }
    if (hc !== (unit.headcount ?? null)) patch.headcount = hc;
    if ((managerId.trim() || null) !== (unit.manager_id ?? null)) patch.manager_id = managerId.trim() || null;
    if ((parentId || null) !== (unit.parent_id ?? null)) patch.parent_id = parentId || null;
    if (!("headcount" in patch) && !("manager_id" in patch) && !("parent_id" in patch)) {
      setNote({ tone: "err", text: "Nothing changed." });
      return false;
    }
    const error = await apiUpdateOrgUnit(unit.id, patch);
    if (error) {
      setNote({ tone: "err", text: error });
      return false;
    }
    setNote({ tone: "ok", text: "Saved with history." });
    setReason("");
    onDone?.("Saved with history.");
    return true;
  }

  const parents = org.units.filter((u) => u.active && u.id !== unit.id).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="stack">
      {canEdit && (
        <form className="stack" onSubmit={act.submit(save, { success: `${unit.name}: dated change saved.` })}>
          <div className="form-grid">
            <Field label="Parent unit">
              <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
                <option value="">None</option>
                {parents.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.type.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Manager (employee ID)">
              <input value={managerId} onChange={(e) => setManagerId(e.target.value)} placeholder="emp-…" />
            </Field>
            <Field label="Headcount budget">
              <input value={headcount} onChange={(e) => setHeadcount(e.target.value)} inputMode="numeric" />
            </Field>
            <Field label="Effective from">
              <input type="date" value={effective} max={todayIso()} onChange={(e) => setEffective(e.target.value)} />
            </Field>
            <Field label="Reason" wide>
              <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
            </Field>
          </div>
          <div className="form-actions">
            <SubmitButton action={act} className="btn-ghost">
              Save dated change
            </SubmitButton>
          </div>
          <Banner message={note} />
        </form>
      )}
      <strong>History</strong>
      <OrgHistoryList entity="units" id={unit.id} />
    </div>
  );
}

/** Job level, experience, education and responsibilities of a job profile (with history). */
export function JobProfileDetails({ profileId, canEdit }: { profileId: string; canEdit: boolean }) {
  const org = useOrgApi();
  const row = org.profiles.find((p) => p.id === profileId);
  const [level, setLevel] = useState(row?.job_level ?? "");
  const [minYears, setMinYears] = useState(row?.experience_min_years == null ? "" : String(row.experience_min_years));
  const [maxYears, setMaxYears] = useState(row?.experience_max_years == null ? "" : String(row.experience_max_years));
  const [education, setEducation] = useState(row?.education ?? "");
  const [duties, setDuties] = useState((row?.responsibilities ?? []).join("\n"));
  const [effective, setEffective] = useState(todayIso());
  const [note, setNote] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const act = useAction();
  useEffect(() => {
    setLevel(row?.job_level ?? "");
    setMinYears(row?.experience_min_years == null ? "" : String(row.experience_min_years));
    setMaxYears(row?.experience_max_years == null ? "" : String(row.experience_max_years));
    setEducation(row?.education ?? "");
    setDuties((row?.responsibilities ?? []).join("\n"));
  }, [row]);
  if (!row) return null;

  const years = (v: string) => (v.trim() === "" ? null : Number(v));

  async function save() {
    const lo = years(minYears);
    const hi = years(maxYears);
    if ([lo, hi].some((v) => v !== null && (!Number.isInteger(v) || v < 0 || v > 60))) {
      setNote({ tone: "err", text: "Experience must be 0 to 60 years." });
      return false;
    }
    const error = await apiUpdateJobProfile(profileId, {
      job_level: level.trim() || null,
      experience_min_years: lo,
      experience_max_years: hi,
      education: education.trim() || null,
      responsibilities: duties.split("\n").map((s) => s.trim()).filter(Boolean),
      effective_from: effective || null,
    });
    setNote(error ? { tone: "err", text: error } : { tone: "ok", text: "Saved." });
    return !error;
  }

  const experience =
    row.experience_min_years != null || row.experience_max_years != null
      ? `${row.experience_min_years ?? 0}–${row.experience_max_years ?? "+"} years`
      : "—";

  return (
    <div className="stack">
      {!canEdit && (
        <div className="stack-tight">
          <p>Job level: {row.job_level || "—"}</p>
          <p>Experience: {experience}</p>
          <p>Education: {row.education || "—"}</p>
          <p>Responsibilities: {row.responsibilities?.length ? row.responsibilities.join("; ") : "—"}</p>
        </div>
      )}
      {canEdit && (
        <form className="stack" onSubmit={act.submit(save, { success: "Job profile details saved." })}>
          <div className="form-grid">
            <Field label="Job level">
              <input value={level} onChange={(e) => setLevel(e.target.value)} maxLength={32} placeholder="e.g. L4, Senior" />
            </Field>
            <Field label="Min experience (years)">
              <input value={minYears} onChange={(e) => setMinYears(e.target.value)} inputMode="numeric" />
            </Field>
            <Field label="Max experience (years)">
              <input value={maxYears} onChange={(e) => setMaxYears(e.target.value)} inputMode="numeric" />
            </Field>
            <Field label="Education">
              <input value={education} onChange={(e) => setEducation(e.target.value)} maxLength={200} />
            </Field>
            <Field label="Responsibilities (one per line)" wide>
              <textarea rows={4} value={duties} onChange={(e) => setDuties(e.target.value)} />
            </Field>
            <Field label="Effective from">
              <input type="date" value={effective} max={todayIso()} onChange={(e) => setEffective(e.target.value)} />
            </Field>
          </div>
          <div className="form-actions">
            <SubmitButton action={act} className="btn-ghost">
              Save details
            </SubmitButton>
            <button type="button" className="btn-ghost" onClick={() => setShowHistory((v) => !v)}>
              {showHistory ? "Hide history" : "History"}
            </button>
          </div>
          <Banner message={note} />
        </form>
      )}
      {!canEdit && (
        <button type="button" className="btn-ghost btn-tiny" onClick={() => setShowHistory((v) => !v)}>
          {showHistory ? "Hide history" : "History"}
        </button>
      )}
      {showHistory && <OrgHistoryList entity="job-profiles" id={profileId} />}
    </div>
  );
}
