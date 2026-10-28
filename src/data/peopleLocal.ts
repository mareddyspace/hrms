import { DEMO_ACCOUNTS, RETIRED_ACCOUNT_IDS, RETIRED_COUNTRY_MANAGER_IDS, RETIRED_SEAT_SUCCESSOR } from "../demoAccounts.ts";
import { ensureProfileDetails, getBasePeople, type PersonRecord } from "./peopleData.ts";

const STORAGE_KEY = "infotech.people.overlay.v2";

/**
 * Exit details kept on the local overlay only (the base PersonRecord type has no exit fields).
 * They ride along on the stored record, so `getExitDetails` reads them back from any person.
 */
export type PersonExitDetails = { exitDate?: string; exitReason?: string };
export type LocalPersonRecord = PersonRecord & PersonExitDetails;

export function getExitDetails(person: PersonRecord): PersonExitDetails {
  const { exitDate, exitReason } = person as LocalPersonRecord;
  return { exitDate, exitReason };
}

export function isTerminated(person: Pick<PersonRecord, "employmentStatus"> | undefined | null): boolean {
  return person?.employmentStatus === "Terminated";
}

/** A future-dated change HR saved: only the changed fields, applied once the effective date arrives. */
export interface ScheduledPersonChange {
  id: string;
  personId: string;
  effectiveDate: string;
  patch: Partial<LocalPersonRecord>;
  by: string;
  recordedOn: string;
}

type Overlay = {
  upserts: LocalPersonRecord[];
  removedIds: string[];
  /** Added later — older stored overlays have no list and read as empty. */
  scheduled: ScheduledPersonChange[];
};

function readOverlay(): Overlay {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { upserts: [], removedIds: [], scheduled: [] };
    const parsed = JSON.parse(raw) as Partial<Overlay>;
    // Records saved for a retired sign-in account (Compensation, Hiring Manager) are dropped, so headcount stays
    // exact; saved records that reported to one move to the seat that took over their team.
    // Sign-in personas report only through other sign-in people, so a saved persona record whose manager does not
    // sign in (a Country Manager or a generated head) moves back to its sign-in manager. A saved Country Manager record that still
    // carries their old sign-in identity (CMG code) goes back to the generated one.
    const reassign = (p: LocalPersonRecord): LocalPersonRecord => {
      const successor = RETIRED_SEAT_SUCCESSOR[p.managerId];
      if (successor) return { ...p, managerId: successor.id, managerName: successor.fullName };
      const persona = DEMO_ACCOUNTS.find((a) => a.id === p.id);
      const managerSignsIn = DEMO_ACCOUNTS.some((a) => a.id === p.managerId);
      if (persona && !managerSignsIn && (persona.reportsToId ?? "") !== p.managerId) {
        const manager = DEMO_ACCOUNTS.find((a) => a.id === persona.reportsToId);
        return { ...p, managerId: manager?.id ?? "", managerName: manager?.fullName ?? "" };
      }
      return p;
    };
    const staleSignIn = (p: LocalPersonRecord) => RETIRED_COUNTRY_MANAGER_IDS.has(p.id) && /^CMG/.test(p.employeeCode ?? "");
    return {
      upserts: Array.isArray(parsed.upserts)
        ? parsed.upserts.filter((p) => !RETIRED_ACCOUNT_IDS.has(p.id) && !staleSignIn(p)).map(reassign)
        : [],
      removedIds: Array.isArray(parsed.removedIds) ? parsed.removedIds.filter((id) => !RETIRED_ACCOUNT_IDS.has(id)) : [],
      scheduled: Array.isArray(parsed.scheduled) ? parsed.scheduled.filter((c) => !RETIRED_ACCOUNT_IDS.has(c.personId)) : [],
    };
  } catch {
    return { upserts: [], removedIds: [], scheduled: [] };
  }
}

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function writeOverlay(overlay: Overlay) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overlay));
  snapshot = null;
  listeners.forEach((fn) => fn());
}

const listeners = new Set<() => void>();
let snapshot: PersonRecord[] | null = null;

/* ───────────── Backend directory (VITE_API_URL) ───────────── */

/** People loaded from the API after sign-in; when set they replace the generated directory. */
let apiPeople: PersonRecord[] | null = null;
/** People the API returned with basic fields only (outside the viewer's scope). */
let apiBasicIds = new Set<string>();

export function setApiPeople(people: PersonRecord[] | null, basicIds: Iterable<string> = []) {
  apiPeople = people;
  apiBasicIds = new Set(basicIds);
  snapshot = null;
  listeners.forEach((fn) => fn());
}

/** True while the directory comes from the backend. */
export function usingApiPeople(): boolean {
  return apiPeople !== null;
}

/** True when the backend sent only the basic directory card for this person. */
export function isBasicOnly(id: string): boolean {
  return apiPeople !== null && apiBasicIds.has(id);
}

export function subscribePeople(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function buildPeople(): PersonRecord[] {
  const fromApi = apiPeople !== null;
  const base = apiPeople ? apiPeople.map((p) => ({ ...p })) : getBasePeople();
  const { upserts, removedIds, scheduled } = readOverlay();
  const map = new Map<string, PersonRecord>(base.map((p) => [p.id, p]));
  // With the backend the API list is the directory as is: local (browser-only) edits are not applied.
  if (fromApi) return [...map.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
  for (const id of removedIds) map.delete(id);
  // Records saved before the personal/background fields existed keep the seed values for anything they lack.
  for (const person of upserts) map.set(person.id, ensureProfileDetails({ ...(map.get(person.id) ?? {}), ...person }));
  // Future-dated changes take effect once their date has arrived, oldest first.
  const today = localToday();
  for (const change of [...scheduled].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))) {
    if (change.effectiveDate > today) continue;
    const current = map.get(change.personId);
    if (current) map.set(change.personId, { ...current, ...change.patch });
  }
  return [...map.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
}

/** Changes saved for a future date that have not taken effect yet (all people, or one person). */
export function pendingScheduledChanges(personId?: string): ScheduledPersonChange[] {
  const today = localToday();
  return readOverlay()
    .scheduled.filter((c) => c.effectiveDate > today && (!personId || c.personId === personId))
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
}

/** Save only the fields that differ, to apply on `effectiveDate`. */
export function schedulePersonChange(
  before: PersonRecord,
  after: LocalPersonRecord,
  effectiveDate: string,
  actor: { fullName: string },
): ScheduledPersonChange | null {
  const patch: Partial<LocalPersonRecord> = {};
  for (const key of Object.keys(after) as (keyof LocalPersonRecord)[]) {
    if (JSON.stringify(after[key]) !== JSON.stringify(before[key as keyof PersonRecord])) {
      (patch as Record<string, unknown>)[key] = after[key];
    }
  }
  if (!Object.keys(patch).length) return null;
  const overlay = readOverlay();
  const change: ScheduledPersonChange = {
    id: `sch-${Date.now()}`,
    personId: after.id,
    effectiveDate,
    patch,
    by: actor.fullName,
    recordedOn: localToday(),
  };
  overlay.scheduled.push(change);
  writeOverlay(overlay);
  return change;
}

/** Stable snapshot for useSyncExternalStore — same reference until data changes. */
export function listPeople(): PersonRecord[] {
  if (!snapshot) snapshot = buildPeople();
  return snapshot;
}

/** The directory record when HR or an approved change has edited it locally (not just the seed). */
export function editedPerson(id: string): PersonRecord | undefined {
  const { upserts } = readOverlay();
  if (!upserts.some((p) => p.id === id || p.employeeCode === id)) return undefined;
  return getPerson(id);
}

export function getPerson(id: string): PersonRecord | undefined {
  return listPeople().find((p) => p.id === id || p.employeeCode === id);
}

export function upsertPerson(person: LocalPersonRecord) {
  const overlay = readOverlay();
  overlay.removedIds = overlay.removedIds.filter((rid) => rid !== person.id);
  const idx = overlay.upserts.findIndex((p) => p.id === person.id);
  if (idx >= 0) overlay.upserts[idx] = person;
  else overlay.upserts.push(person);
  writeOverlay(overlay);
}

/**
 * Deactivate someone instead of deleting them: the record stays (history, approvals and letters
 * still point at it) but the person is marked Terminated and can no longer sign in.
 */
export function deactivatePerson(id: string, reason = "Deactivated", date = new Date().toISOString().slice(0, 10)) {
  const person = getPerson(id);
  if (!person) return;
  upsertPerson({
    ...(person as LocalPersonRecord),
    employmentStatus: "Terminated",
    exitDate: (person as LocalPersonRecord).exitDate ?? date,
    exitReason: (person as LocalPersonRecord).exitReason ?? reason,
  });
}

/** @deprecated People are never hard-deleted — this now deactivates the record. */
export function removePerson(id: string) {
  deactivatePerson(id);
}

/**
 * Whether this person may still sign in. False once their exit is completed (status Terminated).
 * Unknown ids (not in the directory) are treated as active.
 */
export function isAccountActive(personId: string): boolean {
  const person = getPerson(personId);
  return !person || person.employmentStatus !== "Terminated";
}

/* ───────────── Reporting line ───────────── */

type ReportIndex = { snapshot: PersonRecord[]; byId: Map<string, PersonRecord>; children: Map<string, string[]> };
let reportIndex: ReportIndex | null = null;

function index(): ReportIndex {
  const people = listPeople();
  if (reportIndex && reportIndex.snapshot === people) return reportIndex;
  const byId = new Map(people.map((p) => [p.id, p]));
  const children = new Map<string, string[]>();
  for (const p of people) {
    if (!p.managerId || p.managerId === p.id) continue;
    const list = children.get(p.managerId) ?? [];
    list.push(p.id);
    children.set(p.managerId, list);
  }
  reportIndex = { snapshot: people, byId, children };
  return reportIndex;
}

/** Everyone above this person, nearest first (manager, their manager, …). Never includes the person. */
export function managerChainIds(personId: string): string[] {
  const { byId } = index();
  const chain: string[] = [];
  const seen = new Set<string>([personId]);
  let current = byId.get(personId)?.managerId;
  while (current && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = byId.get(current)?.managerId;
  }
  return chain;
}

/** True when `managerId` sits above `personId` in the reporting line. */
export function isAbove(managerId: string, personId: string): boolean {
  return managerId !== personId && managerChainIds(personId).includes(managerId);
}

/** Direct reports (people whose manager is this person), excluding people who have left. */
export function directReportIds(managerId: string, includeLeft = false): string[] {
  const { children, byId } = index();
  return (children.get(managerId) ?? []).filter((id) => includeLeft || byId.get(id)?.employmentStatus !== "Terminated");
}

/** Everyone below this person in the reporting line (direct and indirect), excluding people who have left. */
export function allReportIds(managerId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([managerId]);
  const queue = [...directReportIds(managerId)];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    queue.push(...directReportIds(id));
  }
  return out;
}

/** Would giving `personId` this manager create a loop (the manager reports to the person)? */
export function wouldCreateLoop(personId: string, managerId: string): boolean {
  if (!managerId) return false;
  if (managerId === personId) return true;
  return managerChainIds(managerId).includes(personId);
}

export function resetPeopleOverlay() {
  localStorage.removeItem(STORAGE_KEY);
  snapshot = null;
  listeners.forEach((fn) => fn());
}

export function usePeopleList(): PersonRecord[] {
  return listPeople();
}
