import { addDaysISO, parseISODate, todayISO, type Holiday, type LeaveRequest } from "../../model.ts";
import { taskTeamFor } from "../../data/taskTeam.ts";
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
  weekStartOf,
  type WorkforceActor,
  type WorkforceResult,
} from "./workforceShared.ts";

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

interface ShiftState {
  shifts: ShiftDef[];
  assignments: ShiftAssignment[];
  weeks: RosterWeek[];
  swaps: ShiftSwap[];
  credits: CompOffCredit[];
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
  };
}

const store = createStore<ShiftState>(KEY, defaults, keepArrays);

export const subscribeShifts = store.subscribe;
/** Stable snapshot for useSyncExternalStore. */
export const getShiftState = store.getState;
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
): WorkforceResult {
  if (!isHrRole(actor.role)) return "Only HR can manage shift types.";
  const name = input.name.trim();
  if (name.length < 2) return "Enter a shift name.";
  if (name.length > 40) return "Shift name must be 40 characters or fewer.";
  if (!TIME_RE.test(input.start) || !TIME_RE.test(input.end)) return "Times must be in 24-hour HH:MM format.";
  if (input.start === input.end) return "Start and end time can't be the same.";
  const length = (toMinutes(input.end) - toMinutes(input.start) + 1440) % 1440;
  if (length < 4 * 60 || length > 12 * 60) return "A shift must be between 4 and 12 hours long.";
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

export function setShiftActive(actor: WorkforceActor, id: string, active: boolean): WorkforceResult {
  if (!isHrRole(actor.role)) return "Only HR can manage shift types.";
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

export function teamIdsFor(managerId: string): string[] {
  return taskTeamFor(managerId).map((p) => p.id);
}

/** Put a shift on a person/day, or clear it with shiftId null. */
export function assignShift(
  actor: WorkforceActor,
  ctx: RosterContext,
  personId: string,
  date: string,
  shiftId: string | null,
): WorkforceResult {
  if (!isISODate(date)) return "Pick a valid date.";
  if (personId === actor.id) return "You can't roster yourself.";
  if (!teamIdsFor(actor.id).includes(personId)) return `${personName(personId)} isn't in your team.`;
  if (date <= todayISO()) return "Past days and today are locked.";
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

export function publishWeek(actor: WorkforceActor, ctx: RosterContext, weekStart: string): WorkforceResult {
  if (weekStartOf(weekStart) !== weekStart) return "Pick a week starting on Monday.";
  if (addDaysISO(weekStart, 6) < todayISO()) return "That week is over.";
  return store.mutate((s) => {
    const dates = weekDates(weekStart);
    const rows = s.assignments.filter((a) => a.managerId === actor.id && dates.includes(a.date));
    if (!rows.length) return "Add at least one shift before publishing.";
    const week = rosterWeek(actor.id, weekStart, s);
    if (week?.status === "published") return "This week is already published.";
    const conflicts = weekConflicts(s, ctx, actor.id, weekStart);
    if (conflicts.length) return conflicts[0];
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
): WorkforceResult {
  const { teammateId, date } = input;
  const reason = input.reason.trim();
  if (!isISODate(date)) return "Pick a valid date.";
  if (date <= todayISO()) return "Swaps are only for upcoming days.";
  if (!teammateId) return "Pick a teammate.";
  if (teammateId === actor.id) return "Pick someone other than yourself.";
  if (reason.length < 3) return "Add a short reason.";
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

export function respondSwap(actor: WorkforceActor, id: string, accept: boolean): WorkforceResult {
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

export function cancelSwap(actor: WorkforceActor, id: string): WorkforceResult {
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

export function decideSwap(
  actor: WorkforceActor,
  ctx: RosterContext,
  id: string,
  approve: boolean,
  note = "",
): WorkforceResult {
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
      rows[0].shiftId = swap.teammateShiftId;
      rows[1].shiftId = swap.requesterShiftId;
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
    .map((a) => ({ assignment: a, reason: compOffReason(a.date, ctx.holidays) ?? "" }))
    .filter((c) => c.reason)
    .sort((x, y) => y.assignment.date.localeCompare(x.assignment.date));
}

export function grantCompOff(actor: WorkforceActor, ctx: RosterContext, personId: string, date: string): WorkforceResult {
  if (!canDecideFor(actor, personId)) return "Only someone above them in the reporting line can grant comp-off.";
  const today = todayISO();
  if (date >= today) return "Comp-off can be granted only after the day has passed.";
  if (addDaysISO(date, COMP_OFF_VALID_DAYS) < today) return `Too late — that day is more than ${COMP_OFF_VALID_DAYS} days ago.`;
  const reason = compOffReason(date, ctx.holidays);
  if (!reason) return `${fmt(date)} is a regular working day — no comp-off.`;
  return store.mutate((s) => {
    const row = s.assignments.find((a) => a.personId === personId && a.date === date);
    if (!row || !isPublished(s, row)) return `${personName(personId)} wasn't on the published roster on ${fmt(date)}.`;
    if (leaveOn(personId, date, ctx.leaves)) return `${personName(personId)} was on approved leave that day.`;
    if (s.credits.some((c) => c.personId === personId && c.workedDate === date)) return "Comp-off for that day is already granted.";
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
