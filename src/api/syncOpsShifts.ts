/**
 * Shifts and rosters from the backend (VITE_API_URL mode only), mapped to the shift store's own shapes.
 * See backend/app/routers/shifts.py.
 */
import { addDaysISO, todayISO } from "../model.ts";
import { ApiError, api, apiSessionMe } from "./client.ts";
import { apiPut } from "./syncShared.ts";
import type {
  CompOffCredit,
  CoverageRule,
  CoverageSlot,
  CoverageStatus,
  RosterWeek,
  ShiftAssignment,
  ShiftDef,
  ShiftSwap,
  SwapStatus,
} from "../features/workforce/shiftsStore.ts";

const enc = encodeURIComponent;

interface ShiftTypeOut {
  id: string;
  name: string;
  start: string;
  end: string;
  weekend_only: boolean;
  active: boolean;
  break_minutes?: number;
  location?: string | null;
}

interface RosterShiftOut {
  id: string;
  employee_id: string;
  work_date: string;
  shift_id: string;
  manager_id: string;
}

interface CoverageSlotOut {
  date: string;
  shift_id: string;
  shift_name: string;
  required: number;
  assigned: number;
  on_leave: string[];
  status: string;
}

interface RosterWeekOut {
  manager_id: string;
  week_start: string;
  status: string;
  published_at?: string | null;
  published_with_gaps?: boolean;
  shifts: RosterShiftOut[];
  coverage: CoverageSlotOut[];
  gaps: CoverageSlotOut[];
}

interface ShiftSwapOut {
  id: string;
  work_date: string;
  requester_id: string;
  teammate_id: string;
  requester_shift_id: string;
  teammate_shift_id: string;
  reason: string;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
}

interface CoverageMinimumOut {
  scope: string;
  shift_id: string;
  weekday: number;
  minimum: number;
}

interface CompOffCreditOut {
  id: string;
  employee_id: string;
  employee_name: string;
  worked_date: string;
  days: number;
  reason: string;
  granted_by_name: string;
  granted_on: string;
  expires_on: string;
  expired: boolean;
}

/** Comp-off as the API counts it: my balance and credits, and (managers) the team's credits and off-day shifts to credit. */
export interface ApiCompOff {
  earned: number;
  used: number;
  pending: number;
  available: number;
  fromRoster: number;
  fromOvertime: number;
  credits: CompOffCredit[];
  teamCredits: CompOffCredit[];
  candidates: { personId: string; date: string; shiftName: string; reason: string }[];
}

interface CompOffOut {
  earned: number;
  used: number;
  pending: number;
  available: number;
  from_roster: number;
  from_overtime: number;
  credits: CompOffCreditOut[];
  team_credits: CompOffCreditOut[];
  candidates: { employee_id: string; employee_name: string; work_date: string; shift_name: string; reason: string }[];
}

const toCredit = (c: CompOffCreditOut): CompOffCredit => ({
  id: c.id,
  personId: c.employee_id,
  workedDate: c.worked_date,
  reason: c.reason,
  grantedById: "",
  grantedByName: c.granted_by_name,
  grantedOn: c.granted_on,
  expiresOn: c.expires_on,
});

const toCompOff = (o: CompOffOut): ApiCompOff => ({
  earned: o.earned,
  used: o.used,
  pending: o.pending,
  available: o.available,
  fromRoster: o.from_roster,
  fromOvertime: o.from_overtime,
  credits: o.credits.map(toCredit),
  teamCredits: o.team_credits.map(toCredit),
  candidates: o.candidates.map((c) => ({ personId: c.employee_id, date: c.work_date, shiftName: c.shift_name, reason: c.reason })),
});

/** One roster week as the API counts it (coverage and gaps include approved leave). */
export interface ApiRosterWeek {
  week: RosterWeek;
  rows: ShiftAssignment[];
  coverage: CoverageSlot[];
  gaps: CoverageSlot[];
}

/** What the shift store keeps from the API. */
export interface ApiShiftData {
  me: string;
  shifts: ShiftDef[];
  /** Key `${managerId}|${weekStart}`. */
  rosters: Record<string, ApiRosterWeek>;
  /** My own published shifts (any roster). */
  mine: ShiftAssignment[];
  swaps: ShiftSwap[];
  coverage: CoverageRule[];
  compOff: ApiCompOff | null;
}

export const rosterKey = (managerId: string, weekStart: string) => `${managerId}|${weekStart}`;

const toShift = (s: ShiftTypeOut): ShiftDef => ({
  id: s.id,
  name: s.name,
  start: s.start,
  end: s.end,
  weekendOnly: s.weekend_only,
  active: s.active,
  breakMinutes: s.break_minutes ?? 60,
  location: s.location ?? "",
});

const toRow = (r: RosterShiftOut): ShiftAssignment => ({
  id: r.id,
  personId: r.employee_id,
  date: r.work_date,
  shiftId: r.shift_id,
  managerId: r.manager_id,
});

const toSlot = (s: CoverageSlotOut): CoverageSlot => ({
  date: s.date,
  shiftId: s.shift_id,
  required: s.required,
  assigned: s.assigned,
  onLeave: s.on_leave,
  status: s.status as CoverageStatus,
});

function toRoster(w: RosterWeekOut, names: (id: string) => string): ApiRosterWeek {
  return {
    week: {
      managerId: w.manager_id,
      weekStart: w.week_start,
      status: w.status === "published" ? "published" : "draft",
      ...(w.published_at ? { publishedOn: w.published_at.slice(0, 10), publishedByName: names(w.manager_id) } : {}),
    },
    rows: w.shifts.map(toRow),
    coverage: w.coverage.map(toSlot),
    gaps: w.gaps.map(toSlot),
  };
}

function toSwap(s: ShiftSwapOut, names: (id: string) => string): ShiftSwap {
  return {
    id: s.id,
    date: s.work_date,
    requesterId: s.requester_id,
    teammateId: s.teammate_id,
    requesterShiftId: s.requester_shift_id,
    teammateShiftId: s.teammate_shift_id,
    reason: s.reason,
    status: s.status as SwapStatus,
    requestedOn: s.created_at.slice(0, 10),
    ...(s.decided_by ? { decidedByName: names(s.decided_by) } : {}),
    ...(s.decided_at ? { decidedOn: s.decided_at.slice(0, 10) } : {}),
    ...(s.decision_note ? { decisionNote: s.decision_note } : {}),
  };
}

function mondayOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return addDaysISO(iso, -((d.getUTCDay() + 6) % 7));
}

/** Weeks loaded up front: last week to five weeks ahead. */
function defaultWeeks(): string[] {
  const monday = mondayOf(todayISO());
  return [-7, 0, 7, 14, 21, 28, 35].map((d) => addDaysISO(monday, d));
}

export async function loadRosterWeek(managerId: string, weekStart: string, names: (id: string) => string): Promise<ApiRosterWeek> {
  return toRoster(await api.get<RosterWeekOut>("/shifts/roster", { week_start: weekStart, manager_id: managerId }), names);
}

export async function loadApiShifts(accountId: string, names: (id: string) => string, extraWeeks: string[] = []): Promise<ApiShiftData> {
  const me = (await apiSessionMe()).employee_id ?? accountId;
  const weeks = [...new Set([...defaultWeeks(), ...extraWeeks])];
  const [types, mine, swapsMine, swapsToDecide, coverage, rosters, compOff] = await Promise.all([
    api.get<ShiftTypeOut[]>("/shifts/types"),
    api.get<RosterShiftOut[]>("/shifts/mine", { from_date: addDaysISO(todayISO(), -30) }),
    api.get<ShiftSwapOut[]>("/shifts/swaps", { view: "mine" }),
    api.get<ShiftSwapOut[]>("/shifts/swaps", { view: "to_decide" }).catch(() => [] as ShiftSwapOut[]),
    api.get<CoverageMinimumOut[]>("/shifts/coverage"),
    Promise.all(weeks.map((w) => loadRosterWeek(me, w, names).catch(() => null))),
    // A server without comp-off credits (404) still shows rosters and swaps.
    api.get<CompOffOut>("/shifts/comp-off").catch(() => null),
  ]);
  const swaps = new Map<string, ShiftSwap>();
  for (const s of [...swapsMine, ...swapsToDecide]) swaps.set(s.id, toSwap(s, names));
  const byKey: Record<string, ApiRosterWeek> = {};
  for (const r of rosters) if (r) byKey[rosterKey(r.week.managerId, r.week.weekStart)] = r;
  return {
    me,
    shifts: types.map(toShift),
    rosters: byKey,
    mine: mine.map(toRow),
    swaps: [...swaps.values()].sort((a, b) => b.requestedOn.localeCompare(a.requestedOn)),
    coverage: coverage.map((c) => ({ scope: c.scope, shiftId: c.shift_id, weekday: c.weekday, min: c.minimum })),
    compOff: compOff ? toCompOff(compOff) : null,
  };
}

/** A manager credits one comp-off day for a published shift worked on a weekly off or holiday. */
export const apiGrantCompOff = (personId: string, date: string) => api.post("/shifts/comp-off/grant", { employee_id: personId, work_date: date });

/** The 409 for under-covered shifts carries {message, gaps}; the client only reads string details. */
async function withGapMessage<T>(run: () => Promise<T>, fallback: string): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && e.message === "That didn't work. Try again.") throw new ApiError(409, fallback);
    throw e;
  }
}

export const apiSaveShiftType = (input: { id?: string; name: string; start: string; end: string; weekendOnly: boolean; active: boolean; breakMinutes?: number; location?: string }) =>
  api.post<ShiftTypeOut>("/shifts/types", {
    id: input.id ?? null,
    name: input.name.trim(),
    start: input.start,
    end: input.end,
    weekend_only: input.weekendOnly,
    active: input.active,
    break_minutes: input.breakMinutes ?? 60,
    location: input.location?.trim() || null,
  });

export async function apiAssignShift(personId: string, date: string, shiftId: string | null, names: (id: string) => string) {
  return toRoster(await api.post<RosterWeekOut>("/shifts/roster/assign", { employee_id: personId, work_date: date, shift_id: shiftId }), names);
}

export async function apiPublishWeek(weekStart: string, allowGaps: boolean, gapText: string, names: (id: string) => string) {
  const out = await withGapMessage(
    () => api.post<RosterWeekOut>("/shifts/roster/publish", { week_start: weekStart, allow_gaps: allowGaps }),
    `Under-covered: ${gapText}. Fill these shifts or publish anyway.`,
  );
  return toRoster(out, names);
}

export const apiRequestSwap = (input: { teammateId: string; date: string; reason: string }) =>
  api.post("/shifts/swaps", { teammate_id: input.teammateId, work_date: input.date, reason: input.reason.trim() });
/** Colleagues I can ask to swap with on this day (same published roster, another shift, can sign in and respond). */
export const apiSwapPartners = (date: string) =>
  api.get<{ id: string; full_name: string }[]>(`/shifts/swaps/partners?work_date=${enc(date)}`);
export const apiRespondSwap = (id: string, accept: boolean) => api.post(`/shifts/swaps/${enc(id)}/respond`, { accept });
export const apiCancelSwap = (id: string) => api.post(`/shifts/swaps/${enc(id)}/cancel`);
export const apiDecideSwap = (id: string, approve: boolean, note: string, allowGaps: boolean) =>
  withGapMessage(
    () =>
      api.post(`/shifts/swaps/${enc(id)}/decision`, {
        decision: approve ? "approve" : "reject",
        note: note.trim() || null,
        allow_gaps: allowGaps,
      }),
    "This swap leaves a shift under-covered. Approve anyway to go ahead.",
  );
export const apiSetCoverage = (scope: string, shiftId: string, weekday: number, min: number) =>
  apiPut("/shifts/coverage", { scope, shift_id: shiftId, weekday, minimum: min });
