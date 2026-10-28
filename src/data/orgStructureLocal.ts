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

export function subscribeOrgOverlay(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable snapshot for useSyncExternalStore. */
export function getOrgOverlay(): OrgOverlay {
  if (!cache) cache = read();
  return cache;
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
): string | null {
  const err = validName(input.name);
  if (err) return err;
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
): string | null {
  const unit = listOrgUnits(people).find((u) => u.key === key);
  if (!unit) return "Unit not found.";
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

export function saveJobProfile(
  actor: OrgActor,
  id: string | null,
  input: { title: string; familyName: string; gradeBand: string; description: string },
): string | null {
  const title = input.title.trim();
  if (!title) return "Enter a title.";
  if (title.length > 80) return "Title must be 80 characters or fewer.";
  if (!input.familyName.trim()) return "Choose a job family.";
  if (!input.gradeBand.trim()) return "Choose a grade band.";
  const profiles = listJobProfiles();
  if (profiles.some((p) => p.id !== id && p.title.toLowerCase() === title.toLowerCase() && p.familyName === input.familyName)) {
    return "This family already has a profile with this title.";
  }
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

export function setJobProfileActive(actor: OrgActor, id: string, active: boolean): string | null {
  const current = listJobProfiles().find((p) => p.id === id);
  if (!current) return "Profile not found.";
  if (!current.inactive === active) return "Nothing changed.";
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
): string | null {
  const title = input.title.trim();
  if (!title) return "Enter a title.";
  if (title.length > 80) return "Title must be 80 characters or fewer.";
  if (!input.department) return "Choose a department.";
  if (!input.location) return "Choose a location.";
  if (!input.grade) return "Choose a grade.";
  if (!Number.isInteger(input.headcount) || input.headcount < 1 || input.headcount > 500) return "Headcount must be a whole number from 1 to 500.";
  if (existing?.incumbentId) return "Filled positions change through lifecycle actions.";
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

export function setPositionActive(actor: OrgActor, position: PositionRecord, active: boolean): string | null {
  if (position.incumbentId) return "Filled positions close when the person moves or leaves.";
  if (!position.inactive === active) return "Nothing changed.";
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

export function canEditOrganisation(role: string): boolean {
  return role === "hr" || role === "hr_admin" || role === "hrbp" || role === "admin" || role === "super_admin";
}
