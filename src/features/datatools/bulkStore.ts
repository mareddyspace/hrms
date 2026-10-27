import { listPeople, removePerson, upsertPerson, type LocalPersonRecord } from "../../data/peopleLocal.ts";
import { todayISO } from "../../model.ts";
import { buildImportRecords, validateImport, type RawImportRow } from "./importRules.ts";
import { canMassUpdate, describeChange, planMassUpdate, type MassChange } from "./massUpdateRules.ts";
import { isHrOrAdmin, newId, type DataToolsActor, type DataToolsResult } from "./shared.ts";

const KEY = "kastech.bulkdata.v1";
const MAX_HISTORY = 30;

export interface BulkHistoryEntry {
  id: string;
  kind: "import" | "mass_update";
  at: string;
  actorId: string;
  actorName: string;
  fileName?: string;
  summary: string;
  created: number;
  updated: number;
  skipped: number;
  /** Records as they were before this change (only kept on the newest entry). */
  snapshots: LocalPersonRecord[];
  /** Ids of people this change created (only kept on the newest entry). */
  createdIds: string[];
  undoneAt?: string;
  undoneBy?: string;
}

export interface BulkState {
  history: BulkHistoryEntry[];
}

function defaults(): BulkState {
  return { history: [] };
}

function isEntry(value: unknown): value is BulkHistoryEntry {
  const e = value as BulkHistoryEntry;
  return (
    !!e &&
    typeof e.id === "string" &&
    (e.kind === "import" || e.kind === "mass_update") &&
    typeof e.at === "string" &&
    typeof e.actorName === "string" &&
    typeof e.created === "number" &&
    typeof e.updated === "number" &&
    typeof e.skipped === "number"
  );
}

function read(): BulkState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw) as Partial<BulkState>;
    const history = Array.isArray(parsed?.history) ? parsed.history.filter(isEntry) : [];
    return {
      history: history.map((e) => ({
        ...e,
        summary: typeof e.summary === "string" ? e.summary : "",
        snapshots: Array.isArray(e.snapshots) ? e.snapshots : [],
        createdIds: Array.isArray(e.createdIds) ? e.createdIds.filter((id) => typeof id === "string") : [],
      })),
    };
  } catch {
    return defaults();
  }
}

let cache: BulkState | null = null;
const listeners = new Set<() => void>();

function write(state: BulkState): DataToolsResult {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    return "Could not save. Please try again.";
  }
  cache = state;
  listeners.forEach((fn) => fn());
  return null;
}

export function subscribeBulk(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable snapshot for useSyncExternalStore — same reference until data changes. */
export function getBulkState(): BulkState {
  if (!cache) cache = read();
  return cache;
}

/** Only the newest entry can be undone, and only once. */
export function undoableEntry(state: BulkState = getBulkState()): BulkHistoryEntry | undefined {
  const last = state.history[0];
  return last && !last.undoneAt ? last : undefined;
}

function guard(actor: DataToolsActor): DataToolsResult {
  return isHrOrAdmin(actor.role) ? null : "Only HR and admins can make bulk changes.";
}

/** Record the entry first (with undo data), then apply the people writes; trims older undo data. */
function recordAndApply(entry: BulkHistoryEntry, records: LocalPersonRecord[]): DataToolsResult {
  const current = getBulkState();
  const older = current.history.slice(0, MAX_HISTORY - 1).map((e) => ({ ...e, snapshots: [], createdIds: [] }));
  const saved = write({ history: [entry, ...older] });
  if (saved) return saved;
  let written = 0;
  for (const record of records) {
    try {
      upsertPerson(record);
      written += 1;
    } catch {
      break;
    }
  }
  if (written < records.length) {
    return `Storage ran out after ${written} of ${records.length} records. Undo the last change to roll back.`;
  }
  return null;
}

export function commitImport(
  actor: DataToolsActor,
  fileName: string,
  rows: RawImportRow[],
  options: { validOnly: boolean },
): DataToolsResult {
  const denied = guard(actor);
  if (denied) return denied;
  if (!rows.length) return "There are no rows to import.";
  const people = listPeople();
  const validated = validateImport(rows, people, todayISO());
  const errors = validated.filter((r) => r.action === "error").length;
  if (errors && !options.validOnly) return `${errors} row${errors === 1 ? " has" : "s have"} errors. Fix them or choose to import valid rows only.`;
  const created = validated.filter((r) => r.action === "create");
  const updated = validated.filter((r) => r.action === "update");
  if (!created.length && !updated.length) return "Nothing to import — every row is unchanged or has errors.";

  const records = buildImportRecords(validated, people);
  const byId = new Map(people.map((p) => [p.id, p as LocalPersonRecord]));
  const snapshots = records.map((r) => byId.get(r.id)).filter((p): p is LocalPersonRecord => !!p);
  const entry: BulkHistoryEntry = {
    id: newId("imp"),
    kind: "import",
    at: new Date().toISOString(),
    actorId: actor.id,
    actorName: actor.fullName,
    fileName: fileName.slice(0, 120),
    summary: `Imported ${fileName.slice(0, 60)}`,
    created: created.length,
    updated: updated.length,
    skipped: validated.length - created.length - updated.length,
    snapshots,
    createdIds: created.map((r) => r.targetId),
  };
  return recordAndApply(entry, records);
}

export function commitMassUpdate(actor: DataToolsActor, ids: string[], change: MassChange): DataToolsResult {
  const denied = guard(actor);
  if (denied) return denied;
  if (!canMassUpdate(actor.role)) return "Only HR can make mass updates.";
  const people = listPeople();
  const plan = planMassUpdate(actor, ids, change, people, todayISO());
  if (plan.error) return plan.error;
  if (!plan.changes.length) return "Nobody would change — everyone selected was skipped.";
  const entry: BulkHistoryEntry = {
    id: newId("mass"),
    kind: "mass_update",
    at: new Date().toISOString(),
    actorId: actor.id,
    actorName: actor.fullName,
    summary: describeChange(change, people),
    created: 0,
    updated: plan.changes.length,
    skipped: plan.skipped.length,
    snapshots: plan.changes.map((c) => c.before),
    createdIds: [],
  };
  return recordAndApply(entry, plan.changes.map((c) => c.after));
}

export function undoLast(actor: DataToolsActor): DataToolsResult {
  const denied = guard(actor);
  if (denied) return denied;
  const entry = undoableEntry();
  if (!entry) return "There is nothing to undo.";
  if (entry.kind === "mass_update" && !canMassUpdate(actor.role)) return "Only HR can undo a mass update.";
  if (!entry.snapshots.length && !entry.createdIds.length) return "This change has no undo data.";
  try {
    for (const snapshot of entry.snapshots) upsertPerson(snapshot);
    for (const id of entry.createdIds) removePerson(id);
  } catch {
    return "Storage is full, so the undo could not finish. Free some space and try again.";
  }
  const state = getBulkState();
  return write({
    history: state.history.map((e) =>
      e.id === entry.id ? { ...e, undoneAt: new Date().toISOString(), undoneBy: actor.fullName, snapshots: [], createdIds: [] } : e,
    ),
  });
}
