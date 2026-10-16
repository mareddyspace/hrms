import { getBasePeople, type PersonRecord } from "./peopleData.ts";

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

type Overlay = {
  upserts: LocalPersonRecord[];
  removedIds: string[];
};

function readOverlay(): Overlay {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { upserts: [], removedIds: [] };
    const parsed = JSON.parse(raw) as Overlay;
    return {
      upserts: Array.isArray(parsed.upserts) ? parsed.upserts : [],
      removedIds: Array.isArray(parsed.removedIds) ? parsed.removedIds : [],
    };
  } catch {
    return { upserts: [], removedIds: [] };
  }
}

function writeOverlay(overlay: Overlay) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overlay));
  snapshot = null;
  listeners.forEach((fn) => fn());
}

const listeners = new Set<() => void>();
let snapshot: PersonRecord[] | null = null;

export function subscribePeople(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function buildPeople(): PersonRecord[] {
  const base = getBasePeople();
  const { upserts, removedIds } = readOverlay();
  const map = new Map(base.map((p) => [p.id, p]));
  for (const id of removedIds) map.delete(id);
  for (const person of upserts) map.set(person.id, person);
  return [...map.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
}

/** Stable snapshot for useSyncExternalStore — same reference until data changes. */
export function listPeople(): PersonRecord[] {
  if (!snapshot) snapshot = buildPeople();
  return snapshot;
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

export function removePerson(id: string) {
  const overlay = readOverlay();
  overlay.upserts = overlay.upserts.filter((p) => p.id !== id);
  if (!overlay.removedIds.includes(id)) overlay.removedIds.push(id);
  writeOverlay(overlay);
}

export function resetPeopleOverlay() {
  localStorage.removeItem(STORAGE_KEY);
  snapshot = null;
  listeners.forEach((fn) => fn());
}

export function usePeopleList(): PersonRecord[] {
  return listPeople();
}
