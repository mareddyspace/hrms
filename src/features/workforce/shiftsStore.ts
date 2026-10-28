import { addDaysISO, holidaysForPerson, parseISODate, todayISO, type Holiday, type LeaveRequest } from "../../model.ts";
import { appendAuditEntries } from "../../data/auditTrail.ts";
import {
  canDecideFor,
  createStore,
  daysBetween,
  fmt,
  isHrRole,
  isISODate,
  isWeekend,
  keepArrays,
  newId,
  notify,
  personName,
  rosterTeamFor,
  weekStartOf,
  type WorkforceActor,
  swapPartnerError,
  type WorkforceResult,
} from "./workforceShared.ts";
import { API_ENABLED, apiRun, createApiMirror, errorText, subscribeAll } from "../../api/syncOps.ts";
import { getPerson } from "../../data/peopleLocal.ts";
import { nameOf } from "../../api/syncShared.ts";
import {
  apiAssignShift,
  apiCancelSwap,
  apiDecideSwap,
  apiPublishWeek,
  apiRequestSwap,
  apiRespondSwap,
  apiSaveShiftType,
  apiSetCoverage,
  loadApiShifts,
  loadRosterWeek,
  rosterKey,
  type ApiRosterWeek,
  type ApiShiftData,
} from "../../api/syncOpsShifts.ts";

const KEY = "kastech.shifts.v2";
const ROUTE = "/workforce/shifts";

export const MIN_REST_HOURS = 11;
export const MAX_DAYS_PER_WEEK = 6;
export const COMP_OFF_VALID_DAYS = 90;

export interface ShiftDef {
  id: string;
  name: string;
  /** "HH:MM", 24-hour */
  start: string;
  end: string;
  weekendOnly: boolean;
  active: boolean;
}

export interface ShiftAssignment {
  id: string;
  personId: string;
  date: string;
  shiftId: string;
  /** Manager whose roster this row belongs to. */
  managerId: string;
}

export interface RosterWeek {
  managerId: string;
  weekStart: string;
  status: "draft" | "published";
  publishedOn?: string;
  publishedByName?: string;
}

export type SwapStatus = "awaiting_teammate" | "awaiting_manager" | "approved" | "declined" | "rejected" | "cancelled";

export interface ShiftSwap {
  id: string;
  date: string;
  requesterId: string;
  teammateId: string;
  requesterShiftId: string;
  teammateShiftId: string;
  reason: string;
  status: SwapStatus;
  requestedOn: string;
  decidedByName?: string;
  decidedOn?: string;
  decisionNote?: string;
}

export interface CompOffCredit {
  id: string;
  personId: string;
  workedDate: string;
  reason: string;
  grantedById: string;
  grantedByName: string;
  grantedOn: string;
  expiresOn: string;
}

/** Minimum people needed on a shift on one weekday. scope is a manager id (their team) or "*" (company default). */
export interface CoverageRule {
  scope: string;
  shiftId: string;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
  min: number;
}

export interface ShiftState {
  /** Backend mode only: roster weeks as the API counts them (key `${managerId}|${weekStart}`). */
  apiRosters?: Record<string, ApiRosterWeek>;
  shifts: ShiftDef[];
  assignments: ShiftAssignment[];
  weeks: RosterWeek[];
  swaps: ShiftSwap[];
  credits: CompOffCredit[];
  coverage: CoverageRule[];
  /** Coverage alerts already sent (manager|date|shift|leave), so each goes out once. */
  coverageAlerts: string[];
}

/** Calendar facts the rules need from the portal store. */
export interface RosterContext {
  leaves: LeaveRequest[];
  holidays: Holiday[];
}

const SEED_SHIFTS: ShiftDef[] = [
  { id: "sh-morning", name: "Morning", start: "06:00", end: "14:00", weekendOnly: false, active: true },
  { id: "sh-general", name: "General", start: "09:30", end: "18:30", weekendOnly: false, active: true },
  { id: "sh-evening", name: "Evening", start: "14:00", end: "22:00", weekendOnly: false, active: true },
  { id: "sh-night", name: "Night", start: "22:00", end: "06:00", weekendOnly: false, active: true },
  { id: "sh-weekend", name: "Weekend support", start: "09:00", end: "17:00", weekendOnly: true, active: true },
];

function seedAssignments(): ShiftAssignment[] {
  const rows: ShiftAssignment[] = [];
  const add = (personId: string, shiftId: string, dates: string[]) => {
    for (const date of dates) rows.push({ id: `sa-${personId}-${date}`, personId, date, shiftId, managerId: "emp-ram" });
  };
  const week = (monday: string, offsets: number[]) => offsets.map((o) => addDaysISO(monday, o));
  // Week of 28 Sep (2 Oct is Gandhi Jayanti)
  add("emp-mahesh", "sh-general", week("2026-09-28", [0, 1, 2, 3, 4]));
  add("emp-kabir", "sh-morning", week("2026-09-28", [0, 1, 2, 3]));
  add("emp-kabir", "sh-weekend", ["2026-10-03"]);
  add("emp-priya", "sh-evening", week("2026-09-28", [0, 1, 2, 3, 4]));
  add("emp-diya", "sh-night", week("2026-09-28", [0, 1, 2]));
  // Week of 12 Oct
  add("emp-mahesh", "sh-general", week("2026-10-12", [0, 1, 2, 3, 4]));
  add("emp-priya", "sh-evening", week("2026-10-12", [0, 1, 2, 3]));
  add("emp-kabir", "sh-morning", week("2026-10-12", [0, 1, 2, 3, 4]));
  add("emp-kabir", "sh-weekend", ["2026-10-17"]);
  add("emp-diya", "sh-night", week("2026-10-12", [0, 1, 2]));
  // Week of 19 Oct (20 Oct is Dussehra)
  add("emp-mahesh", "sh-general", week("2026-10-19", [0, 2, 3, 4]));
  add("emp-priya", "sh-evening", week("2026-10-19", [0, 1, 2, 3, 4]));
  add("emp-kabir", "sh-morning", week("2026-10-19", [0, 1, 2, 3, 4]));
  add("emp-diya", "sh-general", week("2026-10-19", [0, 1, 2, 3, 4]));
  add("emp-anu", "sh-weekend", ["2026-10-24", "2026-10-25"]);
  // Week of 26 Oct — still a draft
  add("emp-mahesh", "sh-general", week("2026-10-26", [0, 1, 2, 3, 4]));
  add("emp-kabir", "sh-morning", week("2026-10-26", [0, 1, 2, 3, 4]));
  return rows;
}

function defaults(): ShiftState {
  return {
    shifts: structuredClone(SEED_SHIFTS),
    assignments: seedAssignments(),
    weeks: [
      { managerId: "emp-ram", weekStart: "2026-09-28", status: "published", publishedOn: "2026-09-24", publishedByName: "Ram Krishnan" },
      { managerId: "emp-ram", weekStart: "2026-10-12", status: "published", publishedOn: "2026-10-08", publishedByName: "Ram Krishnan" },
      { managerId: "emp-ram", weekStart: "2026-10-19", status: "published", publishedOn: "2026-10-14", publishedByName: "Ram Krishnan" },
      { managerId: "emp-ram", weekStart: "2026-10-26", status: "draft" },
    ],
    swaps: [
      {
        id: "sw-priya-babu",
        date: addDaysISO(todayISO(), 3),
        requesterId: "emp-priya",
        teammateId: "emp-mahesh",
        requesterShiftId: "sh-evening",
        teammateShiftId: "sh-general",
        reason: "Doctor appointment in the evening",
        status: "awaiting_teammate",
        requestedOn: addDaysISO(todayISO(), -1),
      },
    ],
    credits: [
      {
        id: "co-kabir-1003",
        personId: "emp-kabir",
        workedDate: "2026-10-03",
        reason: "Weekly off (Saturday)",
        grantedById: "emp-ram",
        grantedByName: "Ram Krishnan",
        grantedOn: "2026-10-05",
        expiresOn: addDaysISO("2026-10-03", COMP_OFF_VALID_DAYS),
      },
      {
        id: "co-babu-0411",
        personId: "emp-mahesh",
        workedDate: "2026-04-11",
        reason: "Weekly off (Saturday)",
        grantedById: "emp-ram",
        grantedByName: "Ram Krishnan",
        grantedOn: "2026-04-13",
        expiresOn: addDaysISO("2026-04-11", COMP_OFF_VALID_DAYS),
      },
      {
        id: "co-babu-0627",
        personId: "emp-mahesh",
        workedDate: "2026-06-27",
        reason: "Weekly off (Saturday)",
        grantedById: "emp-ram",
        grantedByName: "Ram Krishnan",
        grantedOn: "2026-06-29",
        expiresOn: addDaysISO("2026-06-27", COMP_OFF_VALID_DAYS),
      },
    ],
    coverage: [],
    coverageAlerts: [],
  };
}

const store = createStore<ShiftState>(KEY, defaults, keepArrays);

/* ---------- backend mode (VITE_API_URL): shift types, rosters, swaps and coverage from the API ---------- */

/** Roster weeks the page asked for beyond the default window; reloaded with the rest. */
const extraWeeks = new Set<string>();
const shiftNames = (id: string) => nameOf(id) || id;

const mirror = createApiMirror<ApiShiftData | null>(
  () => null,
  (accountId) => loadApiShifts(accountId, shiftNames, [...extraWeeks]),
);

let composed: { api: ApiShiftData | null; local: ShiftState; out: ShiftState } | null = null;

function composeState(api: ApiShiftData | null, local: ShiftState): ShiftState {
  const empty = { shifts: [], assignments: [], weeks: [], swaps: [], coverage: [] };
  if (!api) return { ...empty, credits: local.credits, coverageAlerts: local.coverageAlerts, apiRosters: {} };
  const rows = new Map<string, ShiftAssignment>();
  const weeks = new Map<string, RosterWeek>();
  for (const [key, r] of Object.entries(api.rosters)) {
    weeks.set(key, r.week);
    for (const row of r.rows) rows.set(row.id, row);
  }
  // My shifts on other rosters are published (the API returns only published ones).
  for (const row of api.mine) {
    rows.set(row.id, row);
    const key = rosterKey(row.managerId, weekStartOf(row.date));
    if (!weeks.has(key)) weeks.set(key, { managerId: row.managerId, weekStart: weekStartOf(row.date), status: "published" });
  }
  return {
    shifts: api.shifts,
    assignments: [...rows.values()],
    weeks: [...weeks.values()],
    swaps: api.swaps,
    coverage: api.coverage,
    credits: local.credits,
    coverageAlerts: local.coverageAlerts,
    apiRosters: api.rosters,
  };
}

function apiShiftState(): ShiftState {
  const api = mirror.get();
  const local = store.getState();
  if (composed?.api !== api || composed.local !== local) composed = { api, local, out: composeState(api, local) };
  return composed.out;
}

function mergeRoster(r: ApiRosterWeek) {
  const api = mirror.get();
  if (!api) return;
  mirror.set({ ...api, rosters: { ...api.rosters, [rosterKey(r.week.managerId, r.week.weekStart)]: r } });
}

/** Backend mode: makes sure a manager's roster week is loaded (the page calls this when the week changes). */
export function ensureRosterWeek(managerId: string, weekStart: string): void {
  if (!API_ENABLED) return;
  const api = mirror.get();
  if (!api || api.rosters[rosterKey(managerId, weekStart)]) return;
  if (managerId === api.me) extraWeeks.add(weekStart);
  loadRosterWeek(managerId, weekStart, shiftNames).then(mergeRoster, (e) => console.warn("Roster load failed", e));
}

async function apiChange(run: () => Promise<unknown>): Promise<WorkforceResult> {
  try {
    await run();
    return null;
  } catch (e) {
    return errorText(e);
  }
}

export const subscribeShifts = API_ENABLED ? subscribeAll(store.subscribe, mirror.subscribe) : store.subscribe;
/** Stable snapshot for useSyncExternalStore. */
export const getShiftState: () => ShiftState = API_ENABLED ? apiShiftState : store.getState;
export const resetShiftState = store.reset;

// ---------- helpers ----------

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function dayNumber(iso: string): number {
  const d = parseISODate(iso);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
}

function spanOf(date: string, shift: ShiftDef): [number, number] {
  const start = dayNumber(date) * 1440 + toMinutes(shift.start);
  let end = dayNumber(date) * 1440 + toMinutes(shift.end);
  if (end <= start) end += 1440;
  return [start, end];
}

export function shiftLabel(shift: ShiftDef | undefined): string {
  return shift ? `${shift.name} ${shift.start}–${shift.end}` : "—";
}

export function shiftById(id: string, state: ShiftState = getShiftState()): ShiftDef | undefined {
  return state.shifts.find((s) => s.id === id);
}

const LEAVE_NAMES: Record<string, string> = {
  pto: "PTO",
  sick: "sick",
  casual: "casual",
  unpaid: "unpaid",
  bereavement: "bereavement",
  comp_off: "comp-off",
};

/** Approved leave that keeps someone off work on this date (work-from-home does not). */
export function leaveOn(personId: string, date: string, leaves: LeaveRequest[]): LeaveRequest | undefined {
  return leaves.find(
    (l) =>
      l.employeeId === personId &&
      l.status === "approved" &&
      l.code !== "wfh" &&
      l.code !== "emergency_wfh" &&
      l.from <= date &&
      l.to >= date,
  );
}

export function holidayOn(date: string, holidays: Holiday[]): Holiday | undefined {
  return holidays.find((h) => h.date === date);
}

export function weekDates(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDaysISO(weekStart, i));
}

export function rosterWeek(managerId: string, weekStart: string, state: ShiftState = getShiftState()): RosterWeek | undefined {
  return state.weeks.find((w) => w.managerId === managerId && w.weekStart === weekStart);
}

function isPublished(state: ShiftState, a: ShiftAssignment): boolean {
  return rosterWeek(a.managerId, weekStartOf(a.date), state)?.status === "published";
}

/**
 * Check one proposed shift against every roster rule. `others` is everything already rostered
 * for the person (excluding rows being replaced). Returns the broken rule, or null.
 */
function ruleError(
  state: ShiftState,
  ctx: RosterContext,
  personId: string,
  date: string,
  shift: ShiftDef,
  others: ShiftAssignment[],
): string | null {
  const who = personName(personId);
  if (shift.weekendOnly && !isWeekend(date)) return `${shift.name} runs only on Saturdays and Sundays.`;

  const sameDay = others.find((a) => a.date === date);
  if (sameDay) {
    return `One shift per day: ${who} is already on ${shiftById(sameDay.shiftId, state)?.name ?? "a shift"} on ${fmt(date)}.`;
  }

  const leave = leaveOn(personId, date, ctx.leaves);
  if (leave) return `Leave rule: ${who} is on approved ${LEAVE_NAMES[leave.code] ?? leave.code} leave on ${fmt(date)}.`;

  const [start, end] = spanOf(date, shift);
  for (const other of others) {
    if (Math.abs(daysBetween(other.date, date)) > 1) continue;
    const otherShift = shiftById(other.shiftId, state);
    if (!otherShift) continue;
    const [oStart, oEnd] = spanOf(other.date, otherShift);
    const earlierFirst = oStart < start;
    const gap = earlierFirst ? start - oEnd : oStart - end;
    if (gap < MIN_REST_HOURS * 60) {
      const [first, firstDate, second, secondDate] = earlierFirst
        ? [otherShift, other.date, shift, date]
        : [shift, date, otherShift, other.date];
      const hours = Math.max(0, gap) / 60;
      return `Rest rule: ${who} needs ${MIN_REST_HOURS} h between shifts — ${first.name} on ${fmt(firstDate)} ends ${first.end}, ${second.name} on ${fmt(secondDate)} starts ${second.start} (${hours % 1 ? hours.toFixed(1) : hours} h).`;
    }
  }

  const monday = weekStartOf(date);
  const daysThisWeek = new Set(others.filter((a) => weekStartOf(a.date) === monday).map((a) => a.date));
  daysThisWeek.add(date);
  if (daysThisWeek.size > MAX_DAYS_PER_WEEK) {
    return `Weekly limit: ${who} would work ${daysThisWeek.size} days in the week of ${fmt(monday)} (max ${MAX_DAYS_PER_WEEK}).`;
  }
  return null;
}

function othersFor(state: ShiftState, personId: string, excludeIds: string[]): ShiftAssignment[] {
  return state.assignments.filter((a) => a.personId === personId && !excludeIds.includes(a.id));
}

// ---------- shift definitions (HR) ----------

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function saveShift(
  actor: WorkforceActor,
  input: { id?: string; name: string; start: string; end: string; weekendOnly: boolean },
): WorkforceResult | Promise<WorkforceResult> {
  if (!isHrRole(actor.role)) return "Only HR can manage shift types.";
  const name = input.name.trim();
  if (name.length < 2) return "Enter a shift name.";
  if (name.length > 40) return "Shift name must be 40 characters or fewer.";
  if (!TIME_RE.test(input.start) || !TIME_RE.test(input.end)) return "Times must be in 24-hour HH:MM format.";
  if (input.start === input.end) return "Start and end time can't be the same.";
  const length = (toMinutes(input.end) - toMinutes(input.start) + 1440) % 1440;
  if (length < 4 * 60 || length > 12 * 60) return "A shift must be between 4 and 12 hours long.";
  if (API_ENABLED) {
    const s = getShiftState();
    if (s.shifts.some((x) => x.id !== input.id && x.name.toLowerCase() === name.toLowerCase())) return `A shift called "${name}" already exists.`;
    const existing = input.id ? s.shifts.find((x) => x.id === input.id) : undefined;
    if (input.id && !existing) return "That shift no longer exists.";
    return apiRun(() => apiSaveShiftType({ ...input, name, active: existing?.active ?? true }), mirror);
  }
  return store.mutate((s) => {
    if (s.shifts.some((x) => x.id !== input.id && x.name.toLowerCase() === name.toLowerCase())) return `A shift called "${name}" already exists.`;
    if (input.id) {
      const existing = s.shifts.find((x) => x.id === input.id);
      if (!existing) return "That shift no longer exists.";
      const today = todayISO();
      const upcoming = s.assignments.filter((a) => a.shiftId === input.id && a.date >= today);
      if (upcoming.length && (existing.start !== input.start || existing.end !== input.end || existing.weekendOnly !== input.weekendOnly)) {
        return `${existing.name} is on ${upcoming.length} upcoming roster ${upcoming.length === 1 ? "day" : "days"} — clear those before changing its hours.`;
      }
      Object.assign(existing, { name, start: input.start, end: input.end, weekendOnly: input.weekendOnly });
    } else {
      s.shifts.push({ id: newId("sh"), name, start: input.start, end: input.end, weekendOnly: input.weekendOnly, active: true });
    }
    return null;
  });
}

export function setShiftActive(actor: WorkforceActor, id: string, active: boolean): WorkforceResult | Promise<WorkforceResult> {
  if (!isHrRole(actor.role)) return "Only HR can manage shift types.";
  if (API_ENABLED) {
    const shift = getShiftState().shifts.find((x) => x.id === id);
    if (!shift) return "That shift no longer exists.";
    return apiRun(() => apiSaveShiftType({ ...shift, active }), mirror);
  }
  return store.mutate((s) => {
    const shift = s.shifts.find((x) => x.id === id);
    if (!shift) return "That shift no longer exists.";
    if (!active) {
      const today = todayISO();
      const upcoming = s.assignments.filter((a) => a.shiftId === id && a.date >= today).length;
      if (upcoming) return `${shift.name} is on ${upcoming} upcoming roster ${upcoming === 1 ? "day" : "days"} — clear those first.`;
    }
    shift.active = active;
    return null;
  });
}

// ---------- roster (managers) ----------

/** People a manager rosters on this day (pre-boarding joiners only from their start date). */
export function teamIdsFor(managerId: string, onDate?: string): string[] {
  return rosterTeamFor(managerId, onDate).map((p) => p.id);
}

/** Put a shift on a person/day, or clear it with shiftId null. */
export function assignShift(
  actor: WorkforceActor,
  ctx: RosterContext,
  personId: string,
  date: string,
  shiftId: string | null,
): WorkforceResult | Promise<WorkforceResult> {
  if (!isISODate(date)) return "Pick a valid date.";
  if (personId === actor.id) return "You can't roster yourself.";
  if (!API_ENABLED && shiftId && !teamIdsFor(actor.id, date).includes(personId)) {
    const joining = getPerson(personId)?.dateOfJoining;
    return joining && joining > date ? `${personName(personId)} starts on ${fmt(joining)}.` : `${personName(personId)} isn't in your team.`;
  }
  if (!API_ENABLED && !shiftId && !teamIdsFor(actor.id, "9999-12-31").includes(personId)) return `${personName(personId)} isn't in your team.`;
  if (date <= todayISO()) return "Past days and today are locked.";
  // Backend mode: the API checks every roster rule, notifies and returns the updated week.
  if (API_ENABLED) return apiChange(async () => mergeRoster(await apiAssignShift(personId, date, shiftId, shiftNames)));
  return store.mutate((s) => {
    const existing = s.assignments.find((a) => a.personId === personId && a.date === date);
    if (existing && existing.managerId !== actor.id) return `${personName(personId)} is on another manager's roster that day.`;
    const week = rosterWeek(actor.id, weekStartOf(date), s);
    if (!shiftId) {
      if (!existing) return null;
      s.assignments = s.assignments.filter((a) => a.id !== existing.id);
      if (week?.status === "published") {
        notify(personId, "Shift removed", `Your shift on ${fmt(date)} was removed from the roster.`, ROUTE);
      }
      return null;
    }
    const shift = shiftById(shiftId, s);
    if (!shift) return "That shift no longer exists.";
    if (!shift.active) return `${shift.name} is no longer in use.`;
    if (existing?.shiftId === shiftId) return null;
    const error = ruleError(s, ctx, personId, date, shift, othersFor(s, personId, existing ? [existing.id] : []));
    if (error) return error;
    if (existing) existing.shiftId = shiftId;
    else s.assignments.push({ id: newId("sa"), personId, date, shiftId, managerId: actor.id });
    if (!week) s.weeks.push({ managerId: actor.id, weekStart: weekStartOf(date), status: "draft" });
    if (week?.status === "published") {
      notify(personId, "Shift changed", `You're now on ${shift.name} (${shift.start}–${shift.end}) on ${fmt(date)}.`, ROUTE);
    }
    return null;
  });
}

/** Every rule problem in a manager's week (e.g. leave approved after the shift was planned). */
export function weekConflicts(state: ShiftState, ctx: RosterContext, managerId: string, weekStart: string): string[] {
  const dates = weekDates(weekStart);
  const rows = state.assignments.filter((a) => a.managerId === managerId && dates.includes(a.date));
  const problems: string[] = [];
  for (const row of rows) {
    const shift = shiftById(row.shiftId, state);
    if (!shift) continue;
    const error = ruleError(state, ctx, row.personId, row.date, shift, othersFor(state, row.personId, [row.id]));
    if (error && !problems.includes(error)) problems.push(error);
  }
  return problems;
}

/** Publishes the week. Under-covered shifts block publishing unless `allowGaps` is set (the manager chose "Publish anyway"). */
export function publishWeek(actor: WorkforceActor, ctx: RosterContext, weekStart: string, allowGaps = false): WorkforceResult | Promise<WorkforceResult> {
  if (weekStartOf(weekStart) !== weekStart) return "Pick a week starting on Monday.";
  if (addDaysISO(weekStart, 6) < todayISO()) return "That week is over.";
  if (API_ENABLED) {
    const state = getShiftState();
    const gapText = describeGaps(coverageGaps(state, ctx, actor.id, weekStart), state) || "some shifts";
    return apiChange(async () => mergeRoster(await apiPublishWeek(weekStart, allowGaps, gapText, shiftNames)));
  }
  return store.mutate((s) => {
    const dates = weekDates(weekStart);
    const rows = s.assignments.filter((a) => a.managerId === actor.id && dates.includes(a.date));
    if (!rows.length) return "Add at least one shift before publishing.";
    const week = rosterWeek(actor.id, weekStart, s);
    if (week?.status === "published") return "This week is already published.";
    const conflicts = weekConflicts(s, ctx, actor.id, weekStart);
    if (conflicts.length) return conflicts[0];
    const gaps = coverageGaps(s, ctx, actor.id, weekStart);
    if (gaps.length && !allowGaps) return `Under-covered: ${describeGaps(gaps, s)}. Fill these shifts or publish anyway.`;
    const record: RosterWeek = {
      managerId: actor.id,
      weekStart,
      status: "published",
      publishedOn: todayISO(),
      publishedByName: actor.fullName,
    };
    s.weeks = [...s.weeks.filter((w) => !(w.managerId === actor.id && w.weekStart === weekStart)), record];
    for (const personId of new Set(rows.map((r) => r.personId))) {
      notify(personId, "Roster published", `Your shifts for the week of ${fmt(weekStart)} are ready.`, ROUTE);
    }
    if (gaps.length) {
      audit(actor, "Roster week", `${actor.id}:${weekStart}`, "Updated", [
        { field: "Published with gaps", before: "", after: describeGaps(gaps, s) },
      ]);
    }
    return null;
  });
}

/** Published shifts for one person, oldest first. */
export function publishedShiftsFor(personId: string, state: ShiftState = getShiftState()): ShiftAssignment[] {
  return state.assignments
    .filter((a) => a.personId === personId && isPublished(state, a))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- swaps ----------

export function requestSwap(
  actor: WorkforceActor,
  ctx: RosterContext,
  input: { teammateId: string; date: string; reason: string },
): WorkforceResult | Promise<WorkforceResult> {
  const { teammateId, date } = input;
  const reason = input.reason.trim();
  if (!isISODate(date)) return "Pick a valid date.";
  if (date <= todayISO()) return "Swaps are only for upcoming days.";
  if (!teammateId) return "Pick a teammate.";
  if (teammateId === actor.id) return "Pick someone other than yourself.";
  if (!API_ENABLED) {
    const partnerError = swapPartnerError(teammateId, date);
    if (partnerError) return partnerError;
  }
  if (reason.length < 3) return "Add a short reason.";
  if (API_ENABLED) return apiRun(() => apiRequestSwap({ teammateId, date, reason }), mirror);
  return store.mutate((s) => {
    const mine = publishedShiftsFor(actor.id, s).find((a) => a.date === date);
    if (!mine) return `You're not on the published roster on ${fmt(date)}.`;
    const theirs = publishedShiftsFor(teammateId, s).find((a) => a.date === date);
    if (!theirs) return `${personName(teammateId)} isn't on the published roster on ${fmt(date)}.`;
    if (mine.managerId !== theirs.managerId) return "You can only swap with someone on the same team roster.";
    if (mine.shiftId === theirs.shiftId) return "You're both on the same shift that day.";
    const open = s.swaps.some(
      (w) => w.date === date && (w.status === "awaiting_teammate" || w.status === "awaiting_manager") &&
        [w.requesterId, w.teammateId].some((id) => id === actor.id || id === teammateId),
    );
    if (open) return "There's already an open swap for one of you on that day.";
    const error = swapRuleError(s, ctx, mine, theirs);
    if (error) return error;
    s.swaps.unshift({
      id: newId("sw"),
      date,
      requesterId: actor.id,
      teammateId,
      requesterShiftId: mine.shiftId,
      teammateShiftId: theirs.shiftId,
      reason,
      status: "awaiting_teammate",
      requestedOn: todayISO(),
    });
    notify(teammateId, "Shift swap request", `${actor.fullName} wants to swap shifts with you on ${fmt(date)}.`, ROUTE);
    return null;
  });
}

function swapRuleError(s: ShiftState, ctx: RosterContext, a: ShiftAssignment, b: ShiftAssignment): string | null {
  const shiftForA = shiftById(b.shiftId, s);
  const shiftForB = shiftById(a.shiftId, s);
  if (!shiftForA || !shiftForB) return "One of the shifts no longer exists.";
  return (
    ruleError(s, ctx, a.personId, a.date, shiftForA, othersFor(s, a.personId, [a.id])) ??
    ruleError(s, ctx, b.personId, b.date, shiftForB, othersFor(s, b.personId, [b.id]))
  );
}

function liveSwapRows(s: ShiftState, swap: ShiftSwap): [ShiftAssignment, ShiftAssignment] | string {
  const mine = s.assignments.find((a) => a.personId === swap.requesterId && a.date === swap.date);
  const theirs = s.assignments.find((a) => a.personId === swap.teammateId && a.date === swap.date);
  if (!mine || !theirs || mine.shiftId !== swap.requesterShiftId || theirs.shiftId !== swap.teammateShiftId) {
    return "The roster changed since this request — ask for a new swap.";
  }
  return [mine, theirs];
}

export function respondSwap(actor: WorkforceActor, id: string, accept: boolean): WorkforceResult | Promise<WorkforceResult> {
  if (API_ENABLED) return apiRun(() => apiRespondSwap(id, accept), mirror);
  return store.mutate((s) => {
    const swap = s.swaps.find((w) => w.id === id);
    if (!swap) return "That request no longer exists.";
    if (swap.teammateId !== actor.id) return "Only the teammate asked can respond.";
    if (swap.status !== "awaiting_teammate") return "This request has already moved on.";
    if (swap.date <= todayISO()) return "That date has passed.";
    swap.status = accept ? "awaiting_manager" : "declined";
    if (!accept) {
      swap.decidedByName = actor.fullName;
      swap.decidedOn = todayISO();
    }
    notify(
      swap.requesterId,
      accept ? "Swap accepted" : "Swap declined",
      `${actor.fullName} ${accept ? "accepted — waiting for manager approval" : "declined"} the swap on ${fmt(swap.date)}.`,
      ROUTE,
    );
    return null;
  });
}

export function cancelSwap(actor: WorkforceActor, id: string): WorkforceResult | Promise<WorkforceResult> {
  if (API_ENABLED) return apiRun(() => apiCancelSwap(id), mirror);
  return store.mutate((s) => {
    const swap = s.swaps.find((w) => w.id === id);
    if (!swap) return "That request no longer exists.";
    if (swap.requesterId !== actor.id) return "Only the requester can cancel.";
    if (swap.status !== "awaiting_teammate" && swap.status !== "awaiting_manager") return "This request is already closed.";
    swap.status = "cancelled";
    swap.decidedOn = todayISO();
    return null;
  });
}

export function canApproveSwap(actor: WorkforceActor, swap: ShiftSwap): boolean {
  return canDecideFor(actor, swap.requesterId) && canDecideFor(actor, swap.teammateId);
}

/**
 * Approve or reject a swap. Approval re-checks every roster rule and coverage: if the swap would leave a
 * shift below its minimum it is refused unless `allowGaps` is set, and then the roster owner is alerted.
 */
export function decideSwap(
  actor: WorkforceActor,
  ctx: RosterContext,
  id: string,
  approve: boolean,
  note = "",
  allowGaps = false,
): WorkforceResult | Promise<WorkforceResult> {
  if (API_ENABLED) {
    if (!approve && note.trim().length < 3) return "Add a reason for rejecting.";
    return apiRun(() => apiDecideSwap(id, approve, note, allowGaps), mirror);
  }
  return store.mutate((s) => {
    const swap = s.swaps.find((w) => w.id === id);
    if (!swap) return "That request no longer exists.";
    if (!canApproveSwap(actor, swap)) return "Only the manager of both people (or HR) can decide this swap.";
    if (swap.status !== "awaiting_manager") return "This swap isn't waiting for approval.";
    if (!approve && note.trim().length < 3) return "Add a reason for rejecting.";
    if (approve) {
      if (swap.date <= todayISO()) return "That date has passed.";
      const rows = liveSwapRows(s, swap);
      if (typeof rows === "string") return rows;
      const error = swapRuleError(s, ctx, rows[0], rows[1]);
      if (error) return error;
      const ownerId = rows[0].managerId;
      const before = coverageGaps(s, ctx, ownerId, weekStartOf(swap.date)).filter((g) => g.date === swap.date);
      rows[0].shiftId = swap.teammateShiftId;
      rows[1].shiftId = swap.requesterShiftId;
      const fresh = newGaps(before, coverageGaps(s, ctx, ownerId, weekStartOf(swap.date)).filter((g) => g.date === swap.date));
      if (fresh.length && !allowGaps) return `This swap leaves ${describeGaps(fresh, s)} under-covered.`;
      if (fresh.length && ownerId !== actor.id) {
        notify(ownerId, "Coverage alert", `A swap approved by ${actor.fullName} leaves ${describeGaps(fresh, s)} under-covered.`, ROUTE);
      }
    }
    swap.status = approve ? "approved" : "rejected";
    swap.decidedByName = actor.fullName;
    swap.decidedOn = todayISO();
    swap.decisionNote = note.trim() || undefined;
    for (const pid of [swap.requesterId, swap.teammateId]) {
      notify(pid, approve ? "Shift swap approved" : "Shift swap rejected", `${actor.fullName} ${approve ? "approved" : "rejected"} the swap on ${fmt(swap.date)}.`, ROUTE);
    }
    return null;
  });
}

// ---------- comp-off ----------

export interface CompOffCandidate {
  assignment: ShiftAssignment;
  reason: string;
}

/** Why a worked day earns comp-off (weekly off or company holiday), or null. */
export function compOffReason(date: string, holidays: Holiday[]): string | null {
  const holiday = holidayOn(date, holidays);
  if (holiday) return `Holiday (${holiday.name})`;
  const day = parseISODate(date).getDay();
  if (day === 6) return "Weekly off (Saturday)";
  if (day === 0) return "Weekly off (Sunday)";
  return null;
}

/** Past published shifts on weekly offs or holidays that this actor may still credit. */
export function compOffCandidates(actor: WorkforceActor, ctx: RosterContext, state: ShiftState = getShiftState()): CompOffCandidate[] {
  const today = todayISO();
  return state.assignments
    .filter(
      (a) =>
        a.date < today &&
        addDaysISO(a.date, COMP_OFF_VALID_DAYS) >= today &&
        canDecideFor(actor, a.personId) &&
        isPublished(state, a) &&
        !leaveOn(a.personId, a.date, ctx.leaves) &&
        !state.credits.some((c) => c.personId === a.personId && c.workedDate === a.date),
    )
    .map((a) => ({ assignment: a, reason: compOffReason(a.date, holidaysForPerson(ctx.holidays, a.personId)) ?? "" }))
    .filter((c) => c.reason)
    .sort((x, y) => y.assignment.date.localeCompare(x.assignment.date));
}

export function grantCompOff(actor: WorkforceActor, ctx: RosterContext, personId: string, date: string): WorkforceResult {
  if (!canDecideFor(actor, personId)) return "Only someone above them in the reporting line can grant comp-off.";
  const today = todayISO();
  if (date >= today) return "Comp-off can be granted only after the day has passed.";
  if (addDaysISO(date, COMP_OFF_VALID_DAYS) < today) return `Too late — that day is more than ${COMP_OFF_VALID_DAYS} days ago.`;
  const reason = compOffReason(date, holidaysForPerson(ctx.holidays, personId));
  if (!reason) return `${fmt(date)} is a regular working day — no comp-off.`;
  if (API_ENABLED) {
    // Comp-off credits stay in this browser; the worked shift comes from the API roster.
    const live = getShiftState();
    const row = live.assignments.find((a) => a.personId === personId && a.date === date);
    if (!row || !isPublished(live, row)) return `${personName(personId)} wasn't on the published roster on ${fmt(date)}.`;
    if (leaveOn(personId, date, ctx.leaves)) return `${personName(personId)} was on approved leave that day.`;
    if (live.credits.some((c) => c.personId === personId && c.workedDate === date)) return "Comp-off for that day is already granted.";
  }
  return store.mutate((s) => {
    if (!API_ENABLED) {
      const row = s.assignments.find((a) => a.personId === personId && a.date === date);
      if (!row || !isPublished(s, row)) return `${personName(personId)} wasn't on the published roster on ${fmt(date)}.`;
      if (leaveOn(personId, date, ctx.leaves)) return `${personName(personId)} was on approved leave that day.`;
      if (s.credits.some((c) => c.personId === personId && c.workedDate === date)) return "Comp-off for that day is already granted.";
    }
    s.credits.unshift({
      id: newId("co"),
      personId,
      workedDate: date,
      reason,
      grantedById: actor.id,
      grantedByName: actor.fullName,
      grantedOn: today,
      expiresOn: addDaysISO(date, COMP_OFF_VALID_DAYS),
    });
    notify(personId, "Comp-off credited", `1 comp-off day for working on ${fmt(date)}. Use it by ${fmt(addDaysISO(date, COMP_OFF_VALID_DAYS))}.`, ROUTE);
    return null;
  });
}

export function creditsFor(personId: string, state: ShiftState = getShiftState()): CompOffCredit[] {
  return state.credits.filter((c) => c.personId === personId).sort((a, b) => b.workedDate.localeCompare(a.workedDate));
}

export function isCreditExpired(credit: CompOffCredit, today = todayISO()): boolean {
  return credit.expiresOn < today;
}

/**
 * Comp-off days earned in `year`: credits already used before they expired, plus credits still valid.
 * `takenDates` are the person's comp-off leave days (approved or pending); each uses the oldest valid credit.
 */
export function compOffCreditsFor(employeeId: string, year: number, takenDates: string[] = []): number {
  const today = todayISO();
  const credits = getShiftState()
    .credits.filter((c) => c.personId === employeeId && Number(c.workedDate.slice(0, 4)) === year)
    .sort((a, b) => a.workedDate.localeCompare(b.workedDate));
  const used = new Set<string>();
  for (const day of [...takenDates].sort()) {
    const credit = credits.find((c) => !used.has(c.id) && c.workedDate < day && day <= c.expiresOn);
    if (credit) used.add(credit.id);
  }
  return credits.filter((c) => used.has(c.id) || c.expiresOn >= today).length;
}

// ---------- coverage (minimum staffing) ----------

export const MAX_COVERAGE = 20;
/** Company scope for coverage rules; a manager's own rules override it for their team. */
export const COMPANY_SCOPE = "*";
export const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Starting minimums before HR or a manager changes them: one person on each day shift on weekdays, one on weekend support. */
const DEFAULT_MINIMUMS: Record<string, { weekday: number; weekend: number }> = {
  "sh-morning": { weekday: 1, weekend: 0 },
  "sh-general": { weekday: 1, weekend: 0 },
  "sh-evening": { weekday: 1, weekend: 0 },
  "sh-night": { weekday: 0, weekend: 0 },
  "sh-weekend": { weekday: 0, weekend: 1 },
};

export type CoverageStatus = "under" | "ok" | "over" | "none";

export interface CoverageSlot {
  date: string;
  shiftId: string;
  required: number;
  /** People rostered and not on approved leave. */
  assigned: number;
  /** Rostered people who are on approved leave that day. */
  onLeave: string[];
  status: CoverageStatus;
}

/** Minimum for a scope, falling back to the company rule and then the starting default. */
export function coverageMinimum(scope: string, shiftId: string, weekday: number, state: ShiftState = getShiftState()): number {
  const own = state.coverage.find((r) => r.scope === scope && r.shiftId === shiftId && r.weekday === weekday);
  if (own) return own.min;
  const company = state.coverage.find((r) => r.scope === COMPANY_SCOPE && r.shiftId === shiftId && r.weekday === weekday);
  if (company) return company.min;
  const shift = shiftById(shiftId, state);
  if (!shift) return 0;
  const seed = DEFAULT_MINIMUMS[shiftId] ?? { weekday: 0, weekend: 0 };
  const weekend = weekday === 0 || weekday === 6;
  if (shift.weekendOnly && !weekend) return 0;
  return weekend ? seed.weekend : seed.weekday;
}

/** True when the scope has its own rule for this slot (not inherited). */
export function hasOwnCoverageRule(scope: string, shiftId: string, weekday: number, state: ShiftState = getShiftState()): boolean {
  return state.coverage.some((r) => r.scope === scope && r.shiftId === shiftId && r.weekday === weekday);
}

/** Required headcount on a manager's roster for a date; holidays need no one. */
export function requiredOn(state: ShiftState, ctx: RosterContext, managerId: string, shiftId: string, date: string): number {
  if (holidayOn(date, holidaysForPerson(ctx.holidays, managerId))) return 0;
  const shift = shiftById(shiftId, state);
  if (!shift || !shift.active) return 0;
  if (shift.weekendOnly && !isWeekend(date)) return 0;
  return coverageMinimum(managerId, shiftId, parseISODate(date).getDay(), state);
}

/** Assigned vs required for every shift on every day of a manager's week. */
export function weekCoverage(state: ShiftState, ctx: RosterContext, managerId: string, weekStart: string): CoverageSlot[] {
  const fromApi = state.apiRosters?.[rosterKey(managerId, weekStart)];
  if (fromApi) return fromApi.coverage;
  const slots: CoverageSlot[] = [];
  for (const shift of state.shifts) {
    for (const date of weekDates(weekStart)) {
      const rows = state.assignments.filter((a) => a.managerId === managerId && a.date === date && a.shiftId === shift.id);
      if ((!shift.active || (shift.weekendOnly && !isWeekend(date))) && !rows.length) continue;
      const onLeave = rows.filter((a) => leaveOn(a.personId, date, ctx.leaves)).map((a) => a.personId);
      const assigned = rows.length - onLeave.length;
      const required = requiredOn(state, ctx, managerId, shift.id, date);
      const status: CoverageStatus =
        assigned < required ? "under" : required > 0 && assigned > required ? "over" : required === 0 && assigned === 0 ? "none" : "ok";
      slots.push({ date, shiftId: shift.id, required, assigned, onLeave, status });
    }
  }
  return slots;
}

/** Upcoming under-covered slots in a manager's week (past days and today are left out). */
export function coverageGaps(state: ShiftState, ctx: RosterContext, managerId: string, weekStart: string): CoverageSlot[] {
  const today = todayISO();
  const fromApi = state.apiRosters?.[rosterKey(managerId, weekStart)];
  if (fromApi) return fromApi.gaps.filter((c) => c.date > today).sort((a, b) => a.date.localeCompare(b.date));
  return weekCoverage(state, ctx, managerId, weekStart)
    .filter((c) => c.status === "under" && c.date > today)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function newGaps(before: CoverageSlot[], after: CoverageSlot[]): CoverageSlot[] {
  return after.filter((a) => {
    const prev = before.find((b) => b.date === a.date && b.shiftId === a.shiftId);
    return !prev || a.assigned < prev.assigned;
  });
}

export function describeGaps(gaps: CoverageSlot[], state: ShiftState = getShiftState()): string {
  const parts = gaps.slice(0, 3).map((g) => `${shiftById(g.shiftId, state)?.name ?? "Shift"} on ${fmt(g.date)} (${g.assigned} of ${g.required})`);
  return parts.join(", ") + (gaps.length > 3 ? ` and ${gaps.length - 3} more` : "");
}

/** Slots this swap would push below minimum — shown as a warning before approval. */
export function swapCoverageImpact(ctx: RosterContext, swapId: string, state: ShiftState = getShiftState()): CoverageSlot[] {
  const swap = state.swaps.find((w) => w.id === swapId);
  if (!swap) return [];
  const draft = structuredClone(state);
  const rows = liveSwapRows(draft, swap);
  if (typeof rows === "string") return [];
  const ownerId = rows[0].managerId;
  const week = weekStartOf(swap.date);
  const before = coverageGaps(draft, ctx, ownerId, week).filter((g) => g.date === swap.date);
  rows[0].shiftId = swap.teammateShiftId;
  rows[1].shiftId = swap.requesterShiftId;
  return newGaps(before, coverageGaps(draft, ctx, ownerId, week).filter((g) => g.date === swap.date));
}

/** HR sets any scope (including the company default); a manager sets their own team's. */
export function canSetCoverage(actor: WorkforceActor, scope: string): boolean {
  if (isHrRole(actor.role)) return true;
  return scope === actor.id && teamIdsFor(actor.id).length > 0;
}

export function setCoverageMinimum(actor: WorkforceActor, scope: string, shiftId: string, weekday: number, min: number): WorkforceResult | Promise<WorkforceResult> {
  if (!canSetCoverage(actor, scope)) return scope === COMPANY_SCOPE ? "Only HR can set company minimums." : "You can set minimums for your own team only.";
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return "Pick a day.";
  if (!Number.isInteger(min) || min < 0 || min > MAX_COVERAGE) return `Minimum must be a whole number from 0 to ${MAX_COVERAGE}.`;
  // Backend mode: the API keeps the rule (and audits it); roster coverage is reloaded with it.
  if (API_ENABLED) return apiRun(() => apiSetCoverage(scope, shiftId, weekday, min), mirror);
  return store.mutate((s) => {
    const shift = shiftById(shiftId, s);
    if (!shift) return "That shift no longer exists.";
    if (shift.weekendOnly && weekday !== 0 && weekday !== 6 && min > 0) return `${shift.name} runs only on weekends.`;
    const before = coverageMinimum(scope, shiftId, weekday, s);
    s.coverage = [
      ...s.coverage.filter((r) => !(r.scope === scope && r.shiftId === shiftId && r.weekday === weekday)),
      { scope, shiftId, weekday, min },
    ];
    if (before !== min) {
      const where = scope === COMPANY_SCOPE ? "company" : `${personName(scope)}'s team`;
      audit(actor, "Shift coverage", `${scope}:${shiftId}:${weekday}`, "Updated", [
        { field: `${shift.name} minimum, ${WEEKDAY_NAMES[weekday]} (${where})`, before: String(before), after: String(min) },
      ]);
    }
    return null;
  });
}

/** Drops a scope's own minimums so it follows the company rule (or the defaults) again. */
/** False in backend mode: the API keeps a scope's own minimums (set each one instead). */
export const CAN_RESET_COVERAGE = !API_ENABLED;

export function resetCoverage(actor: WorkforceActor, scope: string): WorkforceResult {
  if (!canSetCoverage(actor, scope)) return "You can reset your own team's minimums only.";
  if (API_ENABLED) return "Set each minimum instead — resetting isn't available here.";
  return store.mutate((s) => {
    const removed = s.coverage.filter((r) => r.scope === scope).length;
    if (!removed) return "These minimums already use the defaults.";
    s.coverage = s.coverage.filter((r) => r.scope !== scope);
    audit(actor, "Shift coverage", scope, "Removed", [{ field: "Own minimums", before: `${removed} rules`, after: "Defaults" }]);
    return null;
  });
}

/**
 * Alerts each roster owner once when approved leave drops a published, upcoming shift below its minimum.
 * Safe to call often — after a leave decision or when the roster page opens.
 */
export function checkCoverageAlerts(ctx: RosterContext): void {
  if (API_ENABLED) return; // the backend sends coverage alerts
  const state = getShiftState();
  const today = todayISO();
  const fresh: { key: string; managerId: string; text: string }[] = [];
  for (const week of state.weeks) {
    if (week.status !== "published" || addDaysISO(week.weekStart, 6) <= today) continue;
    for (const slot of coverageGaps(state, ctx, week.managerId, week.weekStart)) {
      for (const personId of slot.onLeave) {
        const leave = leaveOn(personId, slot.date, ctx.leaves);
        const key = `${week.managerId}|${slot.date}|${slot.shiftId}|${leave?.id ?? personId}`;
        if (state.coverageAlerts.includes(key) || fresh.some((f) => f.key === key)) continue;
        fresh.push({
          key,
          managerId: week.managerId,
          text: `${personName(personId)} is on leave — ${shiftById(slot.shiftId, state)?.name ?? "a shift"} on ${fmt(slot.date)} has ${slot.assigned} of ${slot.required} needed.`,
        });
      }
    }
  }
  if (!fresh.length) return;
  store.mutate((s) => {
    s.coverageAlerts = [...s.coverageAlerts, ...fresh.map((f) => f.key)].slice(-500);
    for (const f of fresh) notify(f.managerId, "Coverage alert", f.text, ROUTE);
    return null;
  });
}

function audit(
  actor: WorkforceActor,
  entity: string,
  entityId: string,
  action: "Created" | "Updated" | "Removed",
  changes: { field: string; before: string; after: string }[],
) {
  try {
    appendAuditEntries([{ at: new Date().toISOString(), actorId: actor.id, actorName: actor.fullName, entity, entityId, action, changes }]);
  } catch {
    // The audit trail is best-effort.
  }
}
