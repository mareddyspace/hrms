import type { PersonRecord } from "./peopleData.ts";

/**
 * Effective-dated job changes for each person (hire, promotions, transfers, manager changes, exits…).
 * Written when HR edits an employee; read by the profile's lifecycle tab and the Organization change history.
 * The Hire event (and an Exit for people who left without a stored one) is derived from the record,
 * never stored per person.
 */
const KEY = "infotech.lifecycle.history.v1";

export type LifecycleEventType =
  | "Hire"
  | "Promotion"
  | "Job change"
  | "Transfer"
  | "Department change"
  | "Business unit change"
  | "Legal entity change"
  | "Reorganization"
  | "Manager change"
  | "Location change"
  | "Compensation change"
  | "Status change"
  | "Exit";

export interface LifecycleEvent {
  id: string;
  personId: string;
  personName: string;
  type: LifecycleEventType;
  effectiveDate: string;
  before: string;
  after: string;
  by: string;
  byId: string;
  recordedOn: string;
  /** True for events worked out from the record (hire, exit) rather than stored. */
  derived?: boolean;
}

let cache: LifecycleEvent[] | null = null;
const listeners = new Set<() => void>();

function read(): LifecycleEvent[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as LifecycleEvent[]) : [];
  } catch {
    return [];
  }
}

export function subscribeLifecycleHistory(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable snapshot for useSyncExternalStore, newest first. */
export function getLifecycleHistory(): LifecycleEvent[] {
  if (!cache) cache = read().sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate) || b.id.localeCompare(a.id));
  return cache;
}

export function historyFor(personId: string, events = getLifecycleHistory()): LifecycleEvent[] {
  return events.filter((e) => e.personId === personId);
}

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** A change dated after today: saved, but not in effect yet. */
export function isScheduled(event: Pick<LifecycleEvent, "effectiveDate">, today = localToday()): boolean {
  return event.effectiveDate > today;
}

/**
 * A person's full timeline, newest first: stored events plus the derived Hire event at the joining date
 * and an Exit event for people who left without one stored.
 */
export function timelineFor(
  person: PersonRecord & { exitDate?: string; exitReason?: string },
  events = getLifecycleHistory(),
): LifecycleEvent[] {
  const stored = historyFor(person.id, events);
  // The role they were hired into: the "before" of their earliest job change, else today's role.
  const firstJob = [...stored]
    .filter((e) => e.type === "Promotion" || e.type === "Job change")
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))[0];
  const out = [...stored];
  if (person.dateOfJoining) {
    out.push({
      id: `hire-${person.id}`,
      personId: person.id,
      personName: person.fullName,
      type: "Hire",
      effectiveDate: person.dateOfJoining,
      before: "—",
      after: firstJob ? firstJob.before : `${person.designation} · ${person.grade}`,
      by: "HR",
      byId: "",
      recordedOn: person.dateOfJoining,
      derived: true,
    });
  }
  if (person.employmentStatus === "Terminated" && !stored.some((e) => e.type === "Exit")) {
    const date = person.exitDate ?? "";
    if (date) {
      out.push({
        id: `exit-${person.id}`,
        personId: person.id,
        personName: person.fullName,
        type: "Exit",
        effectiveDate: date,
        before: "Active",
        after: person.exitReason ? `Left · ${person.exitReason}` : "Left",
        by: "HR",
        byId: "",
        recordedOn: date,
        derived: true,
      });
    }
  }
  return out.sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate) || b.id.localeCompare(a.id));
}

function write(events: LifecycleEvent[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(events));
  } catch {
    /* storage full — keep the in-memory copy */
  }
  cache = null;
  listeners.forEach((fn) => fn());
}

const GRADE_RANK = ["L3", "L4", "L5", "L6", "M1", "M2", "M3", "E1"];

/** Work out which lifecycle events an edit represents. */
export function diffLifecycle(
  before: PersonRecord,
  after: PersonRecord,
): { type: LifecycleEventType; before: string; after: string }[] {
  const events: { type: LifecycleEventType; before: string; after: string }[] = [];
  const gradeUp = GRADE_RANK.indexOf(after.grade) > GRADE_RANK.indexOf(before.grade) && GRADE_RANK.indexOf(before.grade) >= 0;
  if (before.grade !== after.grade || before.designation !== after.designation) {
    events.push({
      type: gradeUp ? "Promotion" : "Job change",
      before: `${before.designation} · ${before.grade}`,
      after: `${after.designation} · ${after.grade}`,
    });
  }
  const countryMoved = before.countryCode !== after.countryCode;
  if (countryMoved) {
    events.push({
      type: "Transfer",
      before: `${before.department} · ${before.countryName}`,
      after: `${after.department} · ${after.countryName}`,
    });
  } else {
    if (before.department !== after.department) {
      events.push({ type: "Department change", before: before.department || "—", after: after.department || "—" });
    } else if (before.division !== after.division || before.costCenter !== after.costCenter) {
      events.push({
        type: "Reorganization",
        before: `${before.division} · ${before.costCenter}`,
        after: `${after.division} · ${after.costCenter}`,
      });
    }
    if (before.location !== after.location) {
      events.push({ type: "Location change", before: before.location || "—", after: after.location || "—" });
    }
  }
  if (!countryMoved && before.legalEntity !== after.legalEntity) {
    events.push({ type: "Legal entity change", before: before.legalEntity || "—", after: after.legalEntity || "—" });
  }
  if (!countryMoved && before.businessUnit !== after.businessUnit) {
    events.push({ type: "Business unit change", before: before.businessUnit || "—", after: after.businessUnit || "—" });
  }
  if ((before.managerId || "") !== (after.managerId || "")) {
    events.push({
      type: "Manager change",
      before: before.managerName || "No manager",
      after: after.managerName || "No manager",
    });
  }
  if (before.employmentStatus !== after.employmentStatus) {
    events.push({
      type: after.employmentStatus === "Terminated" ? "Exit" : "Status change",
      before: before.employmentStatus,
      after: after.employmentStatus,
    });
  }
  return events;
}

/** Store one event (used for changes that are not a person-record edit, e.g. a compensation change). */
export function recordLifecycleEvent(event: Omit<LifecycleEvent, "id" | "recordedOn" | "derived">): LifecycleEvent {
  const row: LifecycleEvent = { ...event, id: `lc-${Date.now()}`, recordedOn: localToday() };
  write([row, ...read()]);
  return row;
}

/** Record the changes between two versions of a person. Returns how many events were stored. */
export function recordLifecycleChanges(
  before: PersonRecord,
  after: PersonRecord,
  effectiveDate: string,
  actor: { id: string; fullName: string },
): number {
  const changes = diffLifecycle(before, after);
  if (!changes.length) return 0;
  const today = localToday();
  const stamp = Date.now();
  const next = changes.map((c, i) => ({
    id: `lc-${stamp}-${i}`,
    personId: after.id,
    personName: after.fullName,
    type: c.type,
    effectiveDate,
    before: c.before,
    after: c.after,
    by: actor.fullName,
    byId: actor.id,
    recordedOn: today,
  }));
  write([...next, ...read()]);
  return next.length;
}
