import { TIMEZ_COUNTRIES } from "../model.ts";
import { appendAuditEntries } from "./auditTrail.ts";
import {
  JOB_PROFILES,
  LEGAL_BY_COUNTRY,
  divisionForDepartment,
  familyForDepartment,
  type JobFamily,
  type JobProfile,
  type OrgNode,
  type OrgNodeType,
  type PersonRecord,
  type PositionRecord,
} from "./peopleData.ts";
import { API_ENABLED, subscribeAll } from "../api/syncOps.ts";
import {
  apiCreateJobFamily,
  apiCreateJobProfile,
  apiCreateOrgUnit,
  apiCreatePosition,
  apiDeactivateJobProfile,
  apiDeactivateOrgUnit,
  apiDeactivatePosition,
  apiUpdateJobProfile,
  apiUpdateOrgUnit,
  apiUpdatePosition,
  cleanOrgCode,
  makeOrgCode,
  orgMirror,
  type ApiOrgData,
  type ApiOrgUnitType,
  type OrgUnitOut,
} from "../api/syncOpsOrg.ts";

/**
 * Local edits on top of the seeded organisation: org units (legal entity, business unit, division,
 * department, cost center, location), job profiles and positions. Seed data stays as-is; this overlay
 * renames, adds and deactivates, and keeps a change log.
 */
const KEY = "infotech.org.overlay.v1";

export type OrgUnitType = "legalEntity" | "businessUnit" | "division" | "department" | "costCenter" | "location";

export const ORG_UNIT_TYPES: { id: OrgUnitType; label: string; parent: OrgUnitType | "country" }[] = [
  { id: "legalEntity", label: "Legal entity", parent: "country" },
  { id: "businessUnit", label: "Business unit", parent: "legalEntity" },
  { id: "division", label: "Division", parent: "businessUnit" },
  { id: "department", label: "Department", parent: "division" },
  { id: "costCenter", label: "Cost center", parent: "department" },
  { id: "location", label: "Location", parent: "costCenter" },
];

export function unitTypeLabel(type: OrgUnitType): string {
  return ORG_UNIT_TYPES.find((t) => t.id === type)?.label ?? type;
}

export function parentTypeOf(type: OrgUnitType): OrgUnitType | "country" {
  return ORG_UNIT_TYPES.find((t) => t.id === type)?.parent ?? "country";
}

/** One org unit as listed and edited. Seed units have a key built from type, country and seed name. */
export interface OrgUnit {
  key: string;
  type: OrgUnitType;
  countryCode: string;
  /** Current display name. */
  name: string;
  /** Name stored on person and position records (the original name). */
  value: string;
  code: string;
  /** Key of the parent unit; empty for legal entities (parent is the country). */
  parentKey: string;
  active: boolean;
  added: boolean;
  headcount: number;
}

type UnitEdit = { name?: string; code?: string; active?: boolean };
type AddedUnit = Omit<OrgUnit, "headcount" | "added" | "value">;

export interface PositionDef {
  id: string;
  code: string;
  title: string;
  jobFamily: string;
  jobProfileId: string;
  grade: string;
  department: string;
  countryCode: string;
  location: string;
  headcount: number;
  status: "Open" | "Frozen";
  requirements: string[];
}

type PositionEdit = Partial<Omit<PositionDef, "id">> & { active?: boolean };
type ProfileEdit = Partial<Pick<JobProfile, "title" | "familyName" | "gradeBand" | "description">> & { active?: boolean };

export type OrgChangeEntity = "Org unit" | "Position" | "Job profile";
export type OrgChangeAction = "Added" | "Updated" | "Deactivated" | "Reactivated";

export interface OrgChange {
  id: string;
  date: string;
  at: string;
  entity: OrgChangeEntity;
  entityId: string;
  name: string;
  action: OrgChangeAction;
  before: string;
  after: string;
  by: string;
  byId: string;
}

interface OrgOverlay {
  unitEdits: Record<string, UnitEdit>;
  addedUnits: AddedUnit[];
  positionEdits: Record<string, PositionEdit>;
  addedPositions: (PositionDef & { active: boolean })[];
  profileEdits: Record<string, ProfileEdit>;
  addedProfiles: (JobProfile & { active: boolean })[];
  changes: OrgChange[];
  /** Backend mode only: org units, job families, profiles and positions from the API. */
  api?: ApiOrgData;
}

export type OrgActor = { id: string; fullName: string };

function empty(): OrgOverlay {
  return { unitEdits: {}, addedUnits: [], positionEdits: {}, addedPositions: [], profileEdits: {}, addedProfiles: [], changes: [] };
}

function read(): OrgOverlay {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty();
    const saved = JSON.parse(raw) as Partial<OrgOverlay>;
    const base = empty();
    const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
    return {
      unitEdits: obj(saved.unitEdits) as OrgOverlay["unitEdits"],
      addedUnits: Array.isArray(saved.addedUnits) ? saved.addedUnits : base.addedUnits,
      positionEdits: obj(saved.positionEdits) as OrgOverlay["positionEdits"],
      addedPositions: Array.isArray(saved.addedPositions) ? saved.addedPositions : base.addedPositions,
      profileEdits: obj(saved.profileEdits) as OrgOverlay["profileEdits"],
      addedProfiles: Array.isArray(saved.addedProfiles) ? saved.addedProfiles : base.addedProfiles,
      changes: Array.isArray(saved.changes) ? saved.changes : base.changes,
    };
  } catch {
    return empty();
  }
}

let cache: OrgOverlay | null = null;
const listeners = new Set<() => void>();

function subscribeLocalOverlay(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const subscribeOrgOverlay: (listener: () => void) => () => void = API_ENABLED
  ? subscribeAll(subscribeLocalOverlay, orgMirror.subscribe)
  : subscribeLocalOverlay;

let composedOverlay: { local: OrgOverlay; api: ApiOrgData; out: OrgOverlay } | null = null;

/** Stable snapshot for useSyncExternalStore. In backend mode it also carries the API's org data. */
export function getOrgOverlay(): OrgOverlay {
  if (!cache) cache = read();
  if (!API_ENABLED) return cache;
  const api = orgMirror.get();
  if (composedOverlay?.local !== cache || composedOverlay.api !== api) composedOverlay = { local: cache, api, out: { ...cache, api } };
  return composedOverlay.out;
}

function write(next: OrgOverlay): string | null {
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    return "Could not save. Please try again.";
  }
  cache = next;
  listeners.forEach((fn) => fn());
  return null;
}

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function changeRow(
  actor: OrgActor,
  entity: OrgChangeEntity,
  entityId: string,
  name: string,
  action: OrgChangeAction,
  before: string,
  after: string,
): OrgChange {
  return {
    id: `org-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    date: localToday(),
    at: new Date().toISOString(),
    entity,
    entityId,
    name,
    action,
    before,
    after,
    by: actor.fullName,
    byId: actor.id,
  };
}

function audit(actor: OrgActor, entity: OrgChangeEntity, entityId: string, created: boolean, changes: { field: string; before: string; after: string }[]) {
  appendAuditEntries([
    {
      at: new Date().toISOString(),
      actorId: actor.id,
      actorName: actor.fullName,
      entity,
      entityId,
      action: created ? "Created" : "Updated",
      changes,
    },
  ]);
}

function fieldDiff<T extends object>(before: T, after: T, fields: (keyof T)[]) {
  const show = (v: unknown) => (v === undefined || v === null || v === "" ? "—" : Array.isArray(v) ? v.join(", ") : String(v));
  return fields
    .filter((f) => JSON.stringify(before[f]) !== JSON.stringify(after[f]))
    .map((f) => ({ field: String(f), before: show(before[f]), after: show(after[f]) }));
}

function summary(diff: { field: string; before: string; after: string }[], side: "before" | "after"): string {
  return diff.map((d) => `${d.field}: ${d[side]}`).join(" · ") || "—";
}

/* ───────────── Org units ───────────── */

export function seedUnitKey(type: OrgUnitType, countryCode: string, name: string): string {
  return `${type}:${countryCode}:${name}`;
}

const unitsCache = new WeakMap<object, Map<OrgOverlay, OrgUnit[]>>();

/** Every org unit (seeded from the directory, plus added ones) with local edits applied. */
export function listOrgUnits(people: PersonRecord[], overlay = getOrgOverlay()): OrgUnit[] {
  if (overlay.api) return apiOrgUnits(people, overlay.api);
  const byOverlay = unitsCache.get(people);
  const hit = byOverlay?.get(overlay);
  if (hit) return hit;
  const active = people.filter((p) => p.employmentStatus !== "Terminated");
  const seeds = new Map<string, OrgUnit>();
  const add = (type: OrgUnitType, cc: string, name: string, parentKey: string, code = "") => {
    if (!name) return;
    const key = seedUnitKey(type, cc, name);
    const row = seeds.get(key);
    if (row) row.headcount += 1;
    else seeds.set(key, { key, type, countryCode: cc, name, value: name, code, parentKey, active: true, added: false, headcount: 1 });
  };
  for (const country of TIMEZ_COUNTRIES) {
    const cc = country.code;
    const le = LEGAL_BY_COUNTRY[cc];
    const bu = `TimeZ ${country.name}`;
    const leKey = seedUnitKey("legalEntity", cc, le);
    const buKey = seedUnitKey("businessUnit", cc, bu);
    // Country-level units exist even with nobody there yet.
    seeds.set(leKey, { key: leKey, type: "legalEntity", countryCode: cc, name: le, value: le, code: `LE-${cc}`, parentKey: "", active: true, added: false, headcount: 0 });
    seeds.set(buKey, { key: buKey, type: "businessUnit", countryCode: cc, name: bu, value: bu, code: `BU-${cc}`, parentKey: leKey, active: true, added: false, headcount: 0 });
    for (const p of active.filter((x) => String(x.countryCode) === cc)) {
      seeds.get(leKey)!.headcount += 1;
      seeds.get(buKey)!.headcount += 1;
      const division = p.division || divisionForDepartment(p.department);
      const divKey = seedUnitKey("division", cc, division);
      const deptKey = seedUnitKey("department", cc, p.department);
      const ccKey = seedUnitKey("costCenter", cc, p.costCenter);
      add("division", cc, division, buKey);
      add("department", cc, p.department, divKey);
      add("costCenter", cc, p.costCenter, deptKey, p.costCenter);
      add("location", cc, p.location, ccKey);
    }
  }
  const out: OrgUnit[] = [...seeds.values()].map((u) => {
    const edit = overlay.unitEdits[u.key];
    return edit ? { ...u, name: edit.name ?? u.name, code: edit.code ?? u.code, active: edit.active ?? u.active } : u;
  });
  for (const a of overlay.addedUnits) {
    const edit = overlay.unitEdits[a.key];
    out.push({
      ...a,
      value: a.name,
      name: edit?.name ?? a.name,
      code: edit?.code ?? a.code,
      active: edit?.active ?? a.active,
      added: true,
      headcount: 0,
    });
  }
  const order = ORG_UNIT_TYPES.map((t) => t.id);
  out.sort((a, b) => a.countryCode.localeCompare(b.countryCode) || order.indexOf(a.type) - order.indexOf(b.type) || a.name.localeCompare(b.name));
  const m = byOverlay ?? new Map<OrgOverlay, OrgUnit[]>();
  m.clear();
  m.set(overlay, out);
  unitsCache.set(people, m);
  return out;
}

/**
 * Active units of a type (optionally in one country), for pickers elsewhere. `value` is what person and
 * position records store (the original name); `label` is the current display name.
 */
export function unitOptions(people: PersonRecord[], type: OrgUnitType, countryCode?: string): { value: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const u of listOrgUnits(people)) {
    if (u.type !== type || !u.active || (countryCode && u.countryCode !== countryCode)) continue;
    if (!seen.has(u.value)) seen.set(u.value, u.name);
  }
  return [...seen.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
}

/** Active location options, for transfer and location-change forms. */
export function locationOptions(people: PersonRecord[]): { location: string; label: string; countryCode: string; countryName: string }[] {
  const seen = new Set<string>();
  const out: { location: string; label: string; countryCode: string; countryName: string }[] = [];
  for (const u of listOrgUnits(people)) {
    if (u.type !== "location" || !u.active) continue;
    const id = `${u.countryCode}|${u.value}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      location: u.value,
      label: u.name,
      countryCode: u.countryCode,
      countryName: TIMEZ_COUNTRIES.find((c) => c.code === u.countryCode)?.name ?? u.countryCode,
    });
  }
  return out.sort((a, b) => a.countryName.localeCompare(b.countryName) || a.label.localeCompare(b.label));
}
/** Apply renames, deactivations and added units to the built org tree. */
export function applyOrgOverlay(tree: OrgNode, people: PersonRecord[], overlay = getOrgOverlay()): OrgNode {
  if (overlay.api) return apiApplyTree(tree, people, overlay.api);
  const units = listOrgUnits(people, overlay);
  const byParent = new Map<string, OrgUnit[]>();
  for (const u of units) {
    if (!u.added) continue;
    const key = u.parentKey || `country:${u.countryCode}`;
    byParent.set(key, [...(byParent.get(key) ?? []), u]);
  }
  const addedNode = (u: OrgUnit): OrgNode => ({
    id: `added-${u.key}`,
    unitKey: u.key,
    type: u.type as OrgNodeType,
    name: u.name,
    code: u.code || undefined,
    headcount: 0,
    inactive: !u.active,
    children: (byParent.get(u.key) ?? []).map(addedNode),
  });
  const visit = (node: OrgNode, cc: string): OrgNode => {
    const country = node.type === "country" ? String(node.code ?? cc) : cc;
    let next: OrgNode = node;
    let key = node.type === "country" ? `country:${country}` : "";
    if (ORG_UNIT_TYPES.some((t) => t.id === node.type)) {
      key = seedUnitKey(node.type as OrgUnitType, country, node.name);
      const edit = overlay.unitEdits[key];
      next = edit
        ? { ...node, unitKey: key, name: edit.name ?? node.name, code: edit.code ?? node.code, inactive: edit.active === false }
        : { ...node, unitKey: key };
    }
    const kids = node.children?.map((c) => visit(c, country));
    // Added units go under the first matching parent node only.
    const extra = key && !placed.has(key) ? (byParent.get(key) ?? []).map(addedNode) : [];
    if (key) placed.add(key);
    if (kids || extra.length) next = { ...next, children: [...(kids ?? []), ...extra] };
    return next;
  };
  const placed = new Set<string>();
  return visit(tree, "");
}

function validName(name: string): string | null {
  const n = name.trim();
  if (!n) return "Enter a name.";
  if (n.length > 80) return "Name must be 80 characters or fewer.";
  if (n.includes(":")) return "Name cannot contain a colon.";
  return null;
}

export function addOrgUnit(
  actor: OrgActor,
  people: PersonRecord[],
  input: { type: OrgUnitType; countryCode: string; name: string; code: string; parentKey: string },
): string | null | Promise<string | null> {
  const err = validName(input.name);
  if (err) return err;
  if (API_ENABLED) return apiAddUnit(input);
  if (!TIMEZ_COUNTRIES.some((c) => c.code === input.countryCode)) return "Choose a country.";
  const units = listOrgUnits(people);
  const parentType = parentTypeOf(input.type);
  if (parentType !== "country") {
    const parent = units.find((u) => u.key === input.parentKey);
    if (!parent || parent.type !== parentType || parent.countryCode !== input.countryCode) return `Choose a ${unitTypeLabel(parentType).toLowerCase()}.`;
    if (!parent.active) return "The parent unit is inactive.";
  }
  const name = input.name.trim();
  if (units.some((u) => u.type === input.type && u.countryCode === input.countryCode && u.name.toLowerCase() === name.toLowerCase())) {
    return `A ${unitTypeLabel(input.type).toLowerCase()} with this name already exists in this country.`;
  }
  const overlay = getOrgOverlay();
  const unit: AddedUnit = {
    key: `ou-${Date.now().toString(36)}`,
    type: input.type,
    countryCode: input.countryCode,
    name,
    code: input.code.trim(),
    parentKey: parentType === "country" ? "" : input.parentKey,
    active: true,
  };
  const label = `${unitTypeLabel(unit.type)} · ${unit.countryCode}`;
  const error = write({
    ...overlay,
    addedUnits: [...overlay.addedUnits, unit],
    changes: [changeRow(actor, "Org unit", unit.key, `${name} (${label})`, "Added", "—", name), ...overlay.changes],
  });
  if (!error) audit(actor, "Org unit", unit.key, true, [{ field: "name", before: "—", after: name }, { field: "type", before: "—", after: label }]);
  return error;
}

export function updateOrgUnit(
  actor: OrgActor,
  people: PersonRecord[],
  key: string,
  patch: { name?: string; code?: string; active?: boolean },
): string | null | Promise<string | null> {
  const unit = listOrgUnits(people).find((u) => u.key === key);
  if (!unit) return "Unit not found.";
  if (API_ENABLED) return apiEditUnit(unit, patch);
  const next = { name: patch.name?.trim() ?? unit.name, code: patch.code?.trim() ?? unit.code, active: patch.active ?? unit.active };
  if (patch.name !== undefined) {
    const err = validName(next.name);
    if (err) return err;
    const clash = listOrgUnits(people).some(
      (u) => u.key !== key && u.type === unit.type && u.countryCode === unit.countryCode && u.name.toLowerCase() === next.name.toLowerCase(),
    );
    if (clash) return `Another ${unitTypeLabel(unit.type).toLowerCase()} in this country has this name.`;
  }
  const diff = fieldDiff(unit as { name: string; code: string; active: boolean }, next, ["name", "code", "active"]);
  if (!diff.length) return "Nothing changed.";
  const overlay = getOrgOverlay();
  const action: OrgChangeAction =
    next.active !== unit.active ? (next.active ? "Reactivated" : "Deactivated") : "Updated";
  const label = `${next.name} (${unitTypeLabel(unit.type)} · ${unit.countryCode})`;
  const error = write({
    ...overlay,
    unitEdits: { ...overlay.unitEdits, [key]: { ...overlay.unitEdits[key], ...next } },
    changes: [changeRow(actor, "Org unit", key, label, action, summary(diff, "before"), summary(diff, "after")), ...overlay.changes],
  });
  if (!error) audit(actor, "Org unit", key, false, diff);
  return error;
}

/* ───────────── Job profiles ───────────── */

/** Seed profiles plus added ones, with edits; inactive ones are flagged. */
export function listJobProfiles(overlay = getOrgOverlay()): JobProfile[] {
  if (overlay.api) return apiJobProfiles(overlay.api);
  const seed = JOB_PROFILES.map((p) => {
    const e = overlay.profileEdits[p.id];
    return e ? { ...p, ...stripActive(e), inactive: e.active === false } : p;
  });
  const added = overlay.addedProfiles.map((p) => {
    const e = overlay.profileEdits[p.id];
    const { active, ...rest } = p;
    return { ...rest, ...(e ? stripActive(e) : {}), inactive: (e?.active ?? active) === false };
  });
  return [...seed, ...added];
}

function stripActive<T extends { active?: boolean }>(edit: T): Omit<T, "active"> {
  const { active: _active, ...rest } = edit;
  return rest;
}

export function listJobFamilies(profiles: JobProfile[]): JobFamily[] {
  const names = [...new Set(profiles.map((p) => p.familyName))];
  return names.map((name, i) => ({
    id: profiles.find((p) => p.familyName === name)?.familyId ?? `JF-${i + 1}`,
    name,
    profiles: profiles.filter((p) => p.familyName === name && !p.inactive).length,
  }));
}

export const GRADE_OPTIONS = ["L3", "L4", "L5", "L6", "M1", "M2", "M3", "E1"];

/**
 * Synchronous callers (e.g. the AI job-description writer) get null as soon as a backend save starts;
 * a failure is logged. Use saveJobProfileAsync to wait for the API's answer.
 */
export function saveJobProfile(
  actor: OrgActor,
  id: string | null,
  input: { title: string; familyName: string; gradeBand: string; description: string },
): string | null {
  const result = saveJobProfileAsync(actor, id, input);
  if (typeof result !== "object" || result === null) return result;
  void result.then((error) => error && console.warn("Job profile save failed:", error));
  return null;
}

export function saveJobProfileAsync(
  actor: OrgActor,
  id: string | null,
  input: { title: string; familyName: string; gradeBand: string; description: string },
): string | null | Promise<string | null> {
  const title = input.title.trim();
  if (!title) return "Enter a title.";
  if (title.length > 80) return "Title must be 80 characters or fewer.";
  if (!input.familyName.trim()) return "Choose a job family.";
  if (!input.gradeBand.trim()) return "Choose a grade band.";
  const profiles = listJobProfiles();
  if (profiles.some((p) => p.id !== id && p.title.toLowerCase() === title.toLowerCase() && p.familyName === input.familyName)) {
    return "This family already has a profile with this title.";
  }
  if (API_ENABLED) return apiSaveProfile(id, { title, familyName: input.familyName.trim(), gradeBand: input.gradeBand.trim(), description: input.description.trim() });
  const overlay = getOrgOverlay();
  const values = { title, familyName: input.familyName.trim(), gradeBand: input.gradeBand.trim(), description: input.description.trim() };
  if (!id) {
    const familyId = profiles.find((p) => p.familyName === values.familyName)?.familyId ?? `JF-${values.familyName}`;
    const newId = `JP-NEW-${Date.now().toString(36).toUpperCase()}`;
    const error = write({
      ...overlay,
      addedProfiles: [...overlay.addedProfiles, { id: newId, familyId, ...values, active: true }],
      changes: [changeRow(actor, "Job profile", newId, `${title} (${values.familyName})`, "Added", "—", `${title} · ${values.gradeBand}`), ...overlay.changes],
    });
    if (!error) audit(actor, "Job profile", newId, true, fieldDiff({ title: "", familyName: "", gradeBand: "", description: "" }, values, ["title", "familyName", "gradeBand", "description"]));
    return error;
  }
  const current = profiles.find((p) => p.id === id);
  if (!current) return "Profile not found.";
  const diff = fieldDiff(current, { ...current, ...values }, ["title", "familyName", "gradeBand", "description"]);
  if (!diff.length) return "Nothing changed.";
  const error = write({
    ...overlay,
    profileEdits: { ...overlay.profileEdits, [id]: { ...overlay.profileEdits[id], ...values } },
    changes: [changeRow(actor, "Job profile", id, `${title} (${values.familyName})`, "Updated", summary(diff, "before"), summary(diff, "after")), ...overlay.changes],
  });
  if (!error) audit(actor, "Job profile", id, false, diff);
  return error;
}

export function setJobProfileActive(actor: OrgActor, id: string, active: boolean): string | null | Promise<string | null> {
  const current = listJobProfiles().find((p) => p.id === id);
  if (!current) return "Profile not found.";
  if (!current.inactive === active) return "Nothing changed.";
  if (API_ENABLED) return active ? apiUpdateJobProfile(id, { active: true }) : apiDeactivateJobProfile(id);
  const overlay = getOrgOverlay();
  const error = write({
    ...overlay,
    profileEdits: { ...overlay.profileEdits, [id]: { ...overlay.profileEdits[id], active } },
    changes: [
      changeRow(actor, "Job profile", id, `${current.title} (${current.familyName})`, active ? "Reactivated" : "Deactivated", active ? "Inactive" : "Active", active ? "Active" : "Inactive"),
      ...overlay.changes,
    ],
  });
  if (!error) audit(actor, "Job profile", id, false, [{ field: "active", before: String(!active), after: String(active) }]);
  return error;
}

/* ───────────── Positions ───────────── */

/**
 * Positions with the overlay applied: seeded vacancies take edits, added positions are appended, and every
 * position gets headcount / filled / vacant. One-person positions (an employee's own) are filled by them.
 */
export function applyPositionOverlay(positions: PositionRecord[], people: PersonRecord[], overlay = getOrgOverlay()): PositionRecord[] {
  if (overlay.api) return apiPositions(positions, people, overlay.api);
  const managerFor = (cc: string, dept: string) => {
    const group = people.filter((p) => String(p.countryCode) === cc && p.department === dept && p.employmentStatus !== "Terminated");
    const ids = new Set(group.map((p) => p.id));
    return group.find((p) => !p.managerId || !ids.has(p.managerId))?.fullName ?? "";
  };
  const countryName = (cc: string) => TIMEZ_COUNTRIES.find((c) => c.code === cc)?.name ?? cc;
  const out = positions.map((p): PositionRecord => {
    if (p.incumbentId) return { ...p, headcount: 1, filled: 1, openings: 0 };
    const e = overlay.positionEdits[p.id];
    const merged: PositionRecord = e
      ? {
          ...p,
          ...(e.title !== undefined ? { title: e.title } : {}),
          ...(e.jobFamily !== undefined ? { jobFamily: e.jobFamily } : {}),
          ...(e.jobProfileId !== undefined ? { jobProfileId: e.jobProfileId } : {}),
          ...(e.grade !== undefined ? { grade: e.grade } : {}),
          ...(e.department !== undefined ? { department: e.department } : {}),
          ...(e.location !== undefined ? { location: e.location } : {}),
          ...(e.countryCode !== undefined ? { country: countryName(e.countryCode), legalEntity: LEGAL_BY_COUNTRY[e.countryCode] ?? p.legalEntity } : {}),
          ...(e.status !== undefined ? { status: e.status } : {}),
          ...(e.requirements !== undefined ? { requirements: e.requirements } : {}),
          ...(e.headcount !== undefined ? { openings: e.headcount } : {}),
        }
      : p;
    return { ...merged, headcount: merged.openings, filled: 0, inactive: e?.active === false };
  });
  for (const a of overlay.addedPositions) {
    const e = overlay.positionEdits[a.id];
    const def: PositionDef = { ...a, ...(e ? stripActive(e) : {}) };
    out.push({
      id: def.id,
      code: def.code,
      title: def.title,
      jobProfileId: def.jobProfileId,
      jobFamily: def.jobFamily,
      grade: def.grade,
      country: countryName(def.countryCode),
      location: def.location,
      department: def.department,
      legalEntity: LEGAL_BY_COUNTRY[def.countryCode] ?? "",
      managerName: managerFor(def.countryCode, def.department),
      status: def.status,
      requirements: def.requirements,
      openings: def.headcount,
      headcount: def.headcount,
      filled: 0,
      inactive: (e?.active ?? a.active) === false,
      added: true,
    });
  }
  return out;
}

/** The editable fields of a vacant position (seeded or added). */
export function positionDefFor(p: PositionRecord, overlay = getOrgOverlay()): PositionDef {
  const fromApi = overlay.api?.positions.find((x) => x.id === p.id);
  if (fromApi) {
    return {
      id: p.id,
      code: p.code,
      title: p.title,
      jobFamily: p.jobFamily,
      jobProfileId: p.jobProfileId,
      grade: p.grade,
      department: p.department,
      countryCode: fromApi.country_code,
      location: p.location,
      headcount: fromApi.headcount,
      status: fromApi.status === "frozen" ? "Frozen" : "Open",
      requirements: p.requirements,
    };
  }
  const added = overlay.addedPositions.find((a) => a.id === p.id);
  const cc = added?.countryCode ?? overlay.positionEdits[p.id]?.countryCode ?? TIMEZ_COUNTRIES.find((c) => c.name === p.country)?.code ?? "IN";
  return {
    id: p.id,
    code: p.code,
    title: p.title,
    jobFamily: p.jobFamily,
    jobProfileId: p.jobProfileId,
    grade: p.grade,
    department: p.department,
    countryCode: cc,
    location: p.location,
    headcount: p.headcount ?? p.openings,
    status: p.status === "Frozen" ? "Frozen" : "Open",
    requirements: p.requirements,
  };
}

const POSITION_FIELDS: (keyof PositionDef)[] = ["title", "jobFamily", "jobProfileId", "grade", "department", "countryCode", "location", "headcount", "status", "requirements"];

export function savePosition(
  actor: OrgActor,
  existing: PositionRecord | null,
  input: Omit<PositionDef, "id" | "code" | "jobFamily"> & { jobFamily?: string },
): string | null | Promise<string | null> {
  const title = input.title.trim();
  if (!title) return "Enter a title.";
  if (title.length > 80) return "Title must be 80 characters or fewer.";
  if (!input.department) return "Choose a department.";
  if (!input.location) return "Choose a location.";
  if (!input.grade) return "Choose a grade.";
  if (!Number.isInteger(input.headcount) || input.headcount < 1 || input.headcount > 500) return "Headcount must be a whole number from 1 to 500.";
  if (existing?.incumbentId) return "Filled positions change through lifecycle actions.";
  if (API_ENABLED) return apiSavePosition(existing, input);
  const overlay = getOrgOverlay();
  const values: Omit<PositionDef, "id" | "code"> = {
    title,
    jobFamily: input.jobFamily || familyForDepartment(input.department),
    jobProfileId: input.jobProfileId,
    grade: input.grade,
    department: input.department,
    countryCode: input.countryCode,
    location: input.location,
    headcount: input.headcount,
    status: input.status,
    requirements: input.requirements.map((r) => r.trim()).filter(Boolean).slice(0, 12),
  };
  if (!existing) {
    const n = 93000 + overlay.addedPositions.length + 1;
    const id = `pos-new-${Date.now().toString(36)}`;
    const code = `TIMEZ-${values.department.slice(0, 3).toUpperCase()}-${values.countryCode}-${n}`;
    const error = write({
      ...overlay,
      addedPositions: [...overlay.addedPositions, { id, code, ...values, active: true }],
      changes: [changeRow(actor, "Position", id, `${title} · ${code}`, "Added", "—", `${values.headcount} seat${values.headcount === 1 ? "" : "s"} · ${values.grade} · ${values.location}`), ...overlay.changes],
    });
    if (!error) audit(actor, "Position", id, true, [{ field: "title", before: "—", after: title }, { field: "headcount", before: "—", after: String(values.headcount) }]);
    return error;
  }
  const before = positionDefFor(existing, overlay);
  const after: PositionDef = { ...before, ...values };
  const diff = fieldDiff(before, after, POSITION_FIELDS);
  if (!diff.length) return "Nothing changed.";
  const patch: PositionEdit = {};
  for (const f of POSITION_FIELDS) (patch as Record<string, unknown>)[f] = after[f];
  const error = write({
    ...overlay,
    positionEdits: { ...overlay.positionEdits, [existing.id]: { ...overlay.positionEdits[existing.id], ...patch } },
    changes: [changeRow(actor, "Position", existing.id, `${title} · ${existing.code}`, "Updated", summary(diff, "before"), summary(diff, "after")), ...overlay.changes],
  });
  if (!error) audit(actor, "Position", existing.id, false, diff);
  return error;
}

export function setPositionActive(actor: OrgActor, position: PositionRecord, active: boolean): string | null | Promise<string | null> {
  if (position.incumbentId) return "Filled positions close when the person moves or leaves.";
  if (!position.inactive === active) return "Nothing changed.";
  if (API_ENABLED) {
    if (!getOrgOverlay().api?.positions.some((x) => x.id === position.id)) return "Only positions kept on the server can change here.";
    return active ? apiUpdatePosition(position.id, { active: true }) : apiDeactivatePosition(position.id);
  }
  const overlay = getOrgOverlay();
  const error = write({
    ...overlay,
    positionEdits: { ...overlay.positionEdits, [position.id]: { ...overlay.positionEdits[position.id], active } },
    changes: [
      changeRow(actor, "Position", position.id, `${position.title} · ${position.code}`, active ? "Reactivated" : "Deactivated", active ? "Inactive" : "Active", active ? "Active" : "Inactive"),
      ...overlay.changes,
    ],
  });
  if (!error) audit(actor, "Position", position.id, false, [{ field: "active", before: String(!active), after: String(active) }]);
  return error;
}

/* ───────────── Backend mode (VITE_API_URL): the API's org units, profiles and positions ───────────── */

const TYPE_TO_API: Record<OrgUnitType, ApiOrgUnitType> = {
  legalEntity: "legal_entity",
  businessUnit: "business_unit",
  division: "division",
  department: "department",
  costCenter: "cost_centre",
  location: "location",
};
const TYPE_FROM_API: Partial<Record<ApiOrgUnitType, OrgUnitType>> = {
  legal_entity: "legalEntity",
  business_unit: "businessUnit",
  division: "division",
  department: "department",
  team: "department",
  cost_centre: "costCenter",
  location: "location",
};
const CODE_PREFIX: Record<OrgUnitType, string> = {
  legalEntity: "LE",
  businessUnit: "BU",
  division: "DIV",
  department: "DEPT",
  costCenter: "CC",
  location: "LOC",
};

/** Country of a unit: its own, else its parent's, else the one in a cost-centre code (CC-IN-ENG). */
function apiCountryOf(u: OrgUnitOut, byId: Map<string, OrgUnitOut>): string {
  for (let cur: OrgUnitOut | undefined = u, hops = 0; cur && hops < 10; cur = cur.parent_id ? byId.get(cur.parent_id) : undefined, hops++) {
    if (cur.country_code) return cur.country_code;
  }
  return u.code.match(/^CC-([A-Z]{2})-/)?.[1] ?? "";
}

function personField(p: PersonRecord, type: OrgUnitType): string {
  switch (type) {
    case "legalEntity":
      return p.legalEntity;
    case "businessUnit":
      return p.businessUnit;
    case "division":
      return p.division || divisionForDepartment(p.department);
    case "department":
      return p.department;
    case "costCenter":
      return p.costCenter;
    default:
      return p.location;
  }
}

const apiUnitsCache = new WeakMap<object, { api: ApiOrgData; out: OrgUnit[] }>();

function apiOrgUnits(people: PersonRecord[], api: ApiOrgData): OrgUnit[] {
  const hit = apiUnitsCache.get(people);
  if (hit?.api === api) return hit.out;
  const byId = new Map(api.units.map((u) => [u.id, u]));
  const active = people.filter((p) => p.employmentStatus !== "Terminated");
  const out: OrgUnit[] = [];
  for (const u of api.units) {
    const type = TYPE_FROM_API[u.type];
    if (!type) continue;
    const cc = apiCountryOf(u, byId);
    const parent = u.parent_id ? byId.get(u.parent_id) : undefined;
    const names = new Set([u.name.toLowerCase(), u.code.toLowerCase()]);
    out.push({
      key: u.id,
      type,
      countryCode: cc,
      name: u.name,
      value: u.name,
      code: u.code,
      parentKey: parent && parent.type !== "company" ? parent.id : "",
      active: u.active,
      added: false,
      headcount: active.filter((p) => names.has(personField(p, type).toLowerCase()) && (!cc || String(p.countryCode) === cc)).length,
    });
  }
  const order = ORG_UNIT_TYPES.map((t) => t.id);
  out.sort((a, b) => a.countryCode.localeCompare(b.countryCode) || order.indexOf(a.type) - order.indexOf(b.type) || a.name.localeCompare(b.name));
  apiUnitsCache.set(people, { api, out });
  return out;
}

/** The directory tree with the API's names, codes and inactive flags on matching units. */
function apiApplyTree(tree: OrgNode, people: PersonRecord[], api: ApiOrgData): OrgNode {
  const units = apiOrgUnits(people, api);
  const find = (type: OrgUnitType, name: string, cc: string) =>
    units.find((u) => u.type === type && u.value.toLowerCase() === name.toLowerCase() && (!u.countryCode || u.countryCode === cc)) ??
    units.find((u) => u.type === type && u.code.toLowerCase() === name.toLowerCase());
  const visit = (node: OrgNode, cc: string): OrgNode => {
    const country = node.type === "country" ? String(node.code ?? cc) : cc;
    let next: OrgNode = node;
    if (ORG_UNIT_TYPES.some((t) => t.id === node.type)) {
      const unit = find(node.type as OrgUnitType, node.name, country);
      if (unit) next = { ...node, unitKey: unit.key, code: unit.code || node.code, inactive: !unit.active };
    }
    return node.children ? { ...next, children: node.children.map((c) => visit(c, country)) } : next;
  };
  return visit(tree, "");
}

async function apiAddUnit(input: { type: OrgUnitType; countryCode: string; name: string; code: string; parentKey: string }): Promise<string | null> {
  const api = getOrgOverlay().api;
  const name = input.name.trim();
  if (api?.units.some((u) => TYPE_FROM_API[u.type] === input.type && u.name.toLowerCase() === name.toLowerCase() && (u.country_code ?? "") === input.countryCode)) {
    return `A ${unitTypeLabel(input.type).toLowerCase()} with this name already exists.`;
  }
  const company = api?.units.find((u) => u.type === "company");
  return apiCreateOrgUnit({
    code: cleanOrgCode(input.code) || makeOrgCode(input.countryCode ? `${CODE_PREFIX[input.type]}-${input.countryCode}` : CODE_PREFIX[input.type], name),
    name,
    type: TYPE_TO_API[input.type],
    parent_id: input.parentKey || company?.id || null,
    country_code: input.countryCode || null,
  });
}

async function apiEditUnit(unit: OrgUnit, patch: { name?: string; code?: string; active?: boolean }): Promise<string | null> {
  if (patch.active === false && unit.active) return apiDeactivateOrgUnit(unit.key);
  const body: { name?: string; code?: string; active?: boolean } = {};
  if (patch.name !== undefined && patch.name.trim() !== unit.name) {
    const err = validName(patch.name);
    if (err) return err;
    body.name = patch.name.trim();
  }
  if (patch.code !== undefined && cleanOrgCode(patch.code) && cleanOrgCode(patch.code) !== unit.code) body.code = cleanOrgCode(patch.code);
  if (patch.active === true && !unit.active) body.active = true;
  if (!Object.keys(body).length) return "Nothing changed.";
  return apiUpdateOrgUnit(unit.key, body);
}

function apiJobProfiles(api: ApiOrgData): JobProfile[] {
  const families = new Map(api.families.map((f) => [f.id, f.name]));
  return api.profiles.map((p) => ({
    id: p.id,
    familyId: p.family_id ?? "",
    familyName: (p.family_id && families.get(p.family_id)) || "Other",
    title: p.title,
    gradeBand: p.grade ?? "",
    description: p.description ?? "",
    ...(p.active ? {} : { inactive: true }),
  }));
}

async function apiSaveProfile(id: string | null, values: { title: string; familyName: string; gradeBand: string; description: string }): Promise<string | null> {
  const api = getOrgOverlay().api;
  let familyId = api?.families.find((f) => f.name.toLowerCase() === values.familyName.toLowerCase())?.id ?? null;
  if (!familyId && values.familyName && values.familyName !== "Other") {
    const created = await apiCreateJobFamily({ code: makeOrgCode("JF", values.familyName), name: values.familyName });
    if (typeof created === "string") return created;
    familyId = created.id;
  }
  const body = { title: values.title, family_id: familyId, grade: values.gradeBand || null, description: values.description || null };
  if (!id) return apiCreateJobProfile({ code: makeOrgCode("JP", values.title), ...body });
  return apiUpdateJobProfile(id, body);
}

function apiPositions(seed: PositionRecord[], people: PersonRecord[], api: ApiOrgData): PositionRecord[] {
  const units = new Map(api.units.map((u) => [u.id, u]));
  const profiles = new Map(api.profiles.map((p) => [p.id, p]));
  const families = new Map(api.families.map((f) => [f.id, f.name]));
  const countryName = (cc: string) => TIMEZ_COUNTRIES.find((c) => c.code === cc)?.name ?? cc;
  // People's own seats come from the directory; vacancies and budgeted seats come from the API.
  // Their job profile: the API profile with the same title when the directory doesn't name one the API knows.
  const profileByTitle = new Map(api.profiles.filter((p) => p.active).map((p) => [p.title.toLowerCase(), p.id]));
  const own = seed.filter((p) => p.incumbentId).map((p): PositionRecord => ({
    ...p,
    jobProfileId: profiles.has(p.jobProfileId) ? p.jobProfileId : (profileByTitle.get(p.title.toLowerCase()) ?? p.jobProfileId),
    headcount: 1,
    filled: 1,
    openings: 0,
  }));
  const fromApi = api.positions.map((p): PositionRecord => {
    const profile = profiles.get(p.profile_id);
    const department = (p.department_id && units.get(p.department_id)?.name) || "";
    const manager = p.manager_id ? people.find((x) => x.id === p.manager_id)?.fullName ?? "" : "";
    const vacant = Math.max(0, p.headcount - p.filled);
    return {
      id: p.id,
      code: p.code,
      title: p.title ?? profile?.title ?? p.code,
      jobProfileId: p.profile_id,
      jobFamily: (profile?.family_id && families.get(profile.family_id)) || familyForDepartment(department),
      grade: p.grade ?? profile?.grade ?? "",
      country: countryName(p.country_code),
      location: (p.location_id && units.get(p.location_id)?.name) || "",
      department,
      legalEntity: LEGAL_BY_COUNTRY[p.country_code] ?? "",
      managerName: manager,
      status: p.status === "frozen" ? "Frozen" : vacant === 0 ? "Filled" : "Open",
      requirements: profile?.required_skills ?? [],
      openings: vacant,
      headcount: p.headcount,
      filled: p.filled,
      ...(p.active ? {} : { inactive: true }),
      added: true,
    };
  });
  return [...own, ...fromApi];
}

async function apiSavePosition(
  existing: PositionRecord | null,
  input: Omit<PositionDef, "id" | "code" | "jobFamily"> & { jobFamily?: string },
): Promise<string | null> {
  const api = getOrgOverlay().api;
  if (!api) return "Still loading. Try again.";
  if (!input.jobProfileId) return "Choose a job profile.";
  const department = api.units.find((u) => (u.type === "department" || u.type === "team") && u.name === input.department);
  const location = api.units.find((u) => u.type === "location" && u.name === input.location);
  const body = {
    profile_id: input.jobProfileId,
    department_id: department?.id ?? null,
    location_id: location?.id ?? null,
    grade: input.grade || null,
    headcount: input.headcount,
    status: input.status === "Frozen" ? ("frozen" as const) : ("open" as const),
  };
  if (!existing) return apiCreatePosition({ ...body, country_code: input.countryCode, manager_id: null, filled: 0 });
  if (!api.positions.some((p) => p.id === existing.id)) return "Only positions kept on the server can change here.";
  return apiUpdatePosition(existing.id, body);
}

export function canEditOrganisation(role: string): boolean {
  return role === "hr" || role === "hr_admin" || role === "hrbp" || role === "admin" || role === "super_admin";
}
