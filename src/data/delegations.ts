import { DEMO_ACCOUNTS, RETIRED_ACCOUNT_IDS, RETIRED_COUNTRY_MANAGER_IDS, managementChain, mentionsRetiredAccount } from "../demoAccounts.ts";
import { todayISO } from "../model.ts";
import { getPerson, listPeople, managerChainIds } from "./peopleLocal.ts";
import { API_ENABLED, api } from "../api/client.ts";
import { apiDelete, errorText } from "../api/syncShared.ts";

/**
 * Approval delegation (blueprint §25): someone who decides requests hands that authority to a colleague
 * for a date window — explicitly, or automatically while they are on approved leave.
 */

export type DelegationScope = "leave" | "expenses" | "timesheets" | "attendance" | "others";

export const DELEGATION_SCOPES: { id: DelegationScope; label: string }[] = [
  { id: "leave", label: "Leave" },
  { id: "expenses", label: "Expenses & claims" },
  { id: "timesheets", label: "Timesheets" },
  { id: "attendance", label: "Attendance corrections" },
  { id: "others", label: "Others (assets, software, cabs, shifts)" },
];

export type Delegation = {
  id: string;
  delegatorId: string;
  delegateId: string;
  from: string;
  to: string;
  note?: string;
  /** "all" or the request types handed over. */
  scope: "all" | DelegationScope[];
  createdOn: string;
  /** Set when the delegator ends it early (or replaces it). */
  endedOn?: string;
  /** True for the automatic delegation derived from approved leave; never stored. */
  auto?: boolean;
};

export type DelegationPrefs = {
  /** Delegate automatically while on approved (non-WFH) leave. Default on. */
  autoOnLeave: boolean;
  /** Who covers during leave; defaults to the person's own manager. */
  autoDelegateId?: string;
};

type State = { delegations: Delegation[]; prefs: Record<string, DelegationPrefs> };

/** Minimal leave shape — what auto-delegation needs. */
export type LeaveLike = { employeeId: string; status: string; code: string; from: string; to: string };

const KEY = "hrms.approvalDelegations.v1";
const PORTAL_KEY = "kastech.ess.state.v1";

const listeners = new Set<() => void>();
let cache: State | null = null;

function read(): State {
  try {
    const raw = localStorage.getItem(KEY);
    const saved = raw ? (JSON.parse(raw) as Partial<State>) : null;
    // Delegations and preferences that involve a retired sign-in account (the Compensation persona) are dropped, as are
    // those set up by or handed to a Country Manager (they no longer sign in).
    const cm = (id: string | undefined) => Boolean(id && RETIRED_COUNTRY_MANAGER_IDS.has(id));
    const delegations = (Array.isArray(saved?.delegations) ? saved.delegations : []).filter(
      (d) => !mentionsRetiredAccount(d) && !cm(d.delegatorId) && !cm(d.delegateId),
    );
    const prefs: Record<string, DelegationPrefs> = {};
    for (const [id, pref] of Object.entries(saved?.prefs && typeof saved.prefs === "object" ? saved.prefs : {})) {
      if (!RETIRED_ACCOUNT_IDS.has(id) && !cm(id) && !cm(pref?.autoDelegateId) && !mentionsRetiredAccount(pref)) prefs[id] = pref;
    }
    return { delegations, prefs };
  } catch {
    return { delegations: [], prefs: {} };
  }
}

export function getDelegationState(): State {
  if (!cache) cache = read();
  return cache;
}

function write(next: State): string | null {
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    return "Could not save. Please try again.";
  }
  cache = next;
  listeners.forEach((fn) => fn());
  return null;
}

export function subscribeDelegations(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) {
      cache = null;
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

// ---------- Leave source for automatic delegation ----------

let knownLeaves: LeaveLike[] | null = null;

/** The portal store hands its leave list over on every check; non-React callers fall back to the saved state. */
export function noteLeaves(leaves: readonly LeaveLike[] | undefined) {
  if (leaves) knownLeaves = leaves as LeaveLike[];
}

function leaves(): LeaveLike[] {
  if (knownLeaves) return knownLeaves;
  try {
    const raw = localStorage.getItem(PORTAL_KEY);
    const parsed = raw ? (JSON.parse(raw) as { leaveRequests?: LeaveLike[] }) : null;
    knownLeaves = Array.isArray(parsed?.leaveRequests) ? parsed.leaveRequests : [];
  } catch {
    knownLeaves = [];
  }
  return knownLeaves;
}

const isWfh = (code: string) => code === "wfh" || code === "emergency_wfh";

// ---------- Reporting line ----------

/** Everyone above this person, nearest first — personas and the people directory combined. */
export function chainIds(personId: string): string[] {
  const out: string[] = [];
  for (const id of [...managementChain(personId, DEMO_ACCOUNTS).map((m) => m.id), ...managerChainIds(personId)]) {
    if (id !== personId && !out.includes(id)) out.push(id);
  }
  return out;
}

export function isAboveInLine(managerId: string, personId: string): boolean {
  return managerId !== personId && chainIds(personId).includes(managerId);
}

export function personLabel(id: string): string {
  return DEMO_ACCOUNTS.find((a) => a.id === id)?.fullName ?? getPerson(id)?.fullName ?? id;
}

function everyoneIds(): string[] {
  const ids = new Set<string>(DEMO_ACCOUNTS.map((a) => a.id));
  // Joiners who haven't started (Onboarding) can't cover approvals yet.
  for (const p of listPeople()) if (p.employmentStatus !== "Terminated" && p.employmentStatus !== "Onboarding") ids.add(p.id);
  return [...ids];
}

/** Anyone with people below them decides requests and so may delegate. */
export function hasReports(personId: string): boolean {
  return everyoneIds().some((id) => id !== personId && isAboveInLine(personId, id));
}

/** Who may cover: their own manager, a peer under the same manager, or someone below them. Never themselves. */
export function delegateCandidates(delegatorId: string): { id: string; name: string; relation: string }[] {
  const myManager = chainIds(delegatorId)[0];
  const out: { id: string; name: string; relation: string }[] = [];
  const add = (id: string, relation: string) => {
    if (id === delegatorId || out.some((c) => c.id === id)) return;
    out.push({ id, name: personLabel(id), relation });
  };
  if (myManager) add(myManager, "Your manager");
  const all = everyoneIds();
  if (myManager) for (const id of all) if (chainIds(id)[0] === myManager) add(id, "Peer");
  for (const id of all) if (isAboveInLine(delegatorId, id)) add(id, "Reports to you");
  return out;
}

// ---------- Active delegations ----------

export function covers(d: Delegation, scope: DelegationScope | "any"): boolean {
  return scope === "any" || d.scope === "all" || d.scope.includes(scope);
}

function explicitActive(delegatorId: string, today: string): Delegation | undefined {
  return getDelegationState().delegations.find(
    (d) => d.delegatorId === delegatorId && !d.endedOn && d.from <= today && today <= d.to,
  );
}

export function prefsFor(personId: string): DelegationPrefs {
  return getDelegationState().prefs[personId] ?? { autoOnLeave: true };
}

/** The approved non-WFH leave covering today, if the person is away. */
export function leaveCovering(personId: string, today = todayISO()): LeaveLike | undefined {
  return leaves().find((r) => r.employeeId === personId && r.status === "approved" && !isWfh(r.code) && r.from <= today && today <= r.to);
}

/** The delegation in force for this delegator today: an explicit one wins over the automatic leave cover. */
export function activeDelegationFor(delegatorId: string, today = todayISO()): Delegation | undefined {
  const explicit = explicitActive(delegatorId, today);
  if (explicit) return explicit;
  const prefs = prefsFor(delegatorId);
  if (!prefs.autoOnLeave) return undefined;
  const leave = leaveCovering(delegatorId, today);
  if (!leave) return undefined;
  const delegateId = prefs.autoDelegateId ?? chainIds(delegatorId)[0];
  if (!delegateId || delegateId === delegatorId) return undefined;
  return {
    id: `auto-${delegatorId}-${leave.from}`,
    delegatorId,
    delegateId,
    from: leave.from,
    to: leave.to,
    scope: "all",
    createdOn: leave.from,
    note: "On approved leave",
    auto: true,
  };
}

/**
 * The delegation that lets `actorId` decide this person's request, if any. Never for their own requests,
 * and never for someone above the delegate (no one approves their own boss).
 */
export function delegatedAuthority(
  actorId: string,
  personId: string,
  scope: DelegationScope | "any" = "any",
  today = todayISO(),
): Delegation | null {
  if (!actorId || actorId === personId) return null;
  if (isAboveInLine(personId, actorId)) return null;
  for (const delegatorId of chainIds(personId)) {
    if (delegatorId === actorId) continue;
    const d = activeDelegationFor(delegatorId, today);
    if (d && d.delegateId === actorId && covers(d, scope)) return d;
  }
  return null;
}

/** Delegations other people have handed to this person and that are in force now. */
export function delegationsTo(actorId: string, today = todayISO()): Delegation[] {
  const out: Delegation[] = [];
  for (const id of everyoneIds()) {
    const d = activeDelegationFor(id, today);
    if (d && d.delegateId === actorId) out.push(d);
  }
  return out;
}

// ---------- Changes ----------

export function createDelegation(input: {
  delegatorId: string;
  delegateId: string;
  from: string;
  to: string;
  note?: string;
  scope: "all" | DelegationScope[];
}): string | null {
  const { delegatorId, delegateId, from, to } = input;
  if (!hasReports(delegatorId)) return "Only people who decide requests for others can delegate approvals.";
  if (!delegateId) return "Choose who will decide on your behalf.";
  if (delegateId === delegatorId) return "You cannot delegate to yourself.";
  if (!delegateCandidates(delegatorId).some((c) => c.id === delegateId)) {
    return "Choose your manager, a peer under the same manager, or someone in your team.";
  }
  if (activeDelegationFor(delegateId)?.delegateId === delegatorId) {
    return `${personLabel(delegateId)} has delegated their approvals to you — choose someone else.`;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return "Choose the start and end dates.";
  if (to < from) return "The end date must be on or after the start date.";
  if (to < todayISO()) return "The end date has already passed.";
  if (input.scope !== "all" && input.scope.length === 0) return "Pick at least one request type.";
  const state = getDelegationState();
  const overlaps = state.delegations.some((d) => d.delegatorId === delegatorId && !d.endedOn && d.from <= to && from <= d.to);
  if (overlaps) return "You already have a delegation in those dates. End it first.";
  const row: Delegation = {
    id: `dlg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    delegatorId,
    delegateId,
    from,
    to,
    note: input.note?.trim() || undefined,
    scope: input.scope,
    createdOn: todayISO(),
  };
  return write({ ...state, delegations: [row, ...state.delegations] });
}

/** Ends a delegation now (it stays in history). */
export function endDelegation(id: string, actorId: string): string | null {
  const state = getDelegationState();
  const row = state.delegations.find((d) => d.id === id);
  if (!row) return "Delegation not found.";
  if (row.delegatorId !== actorId) return "Only the person who set this delegation can end it.";
  if (row.endedOn) return "This delegation has already ended.";
  const today = todayISO();
  return write({
    ...state,
    delegations: state.delegations.map((d) =>
      d.id === id ? { ...d, endedOn: today, to: d.to < today ? d.to : d.from > today ? d.from : today } : d,
    ),
  });
}

export function savePrefs(personId: string, prefs: DelegationPrefs): string | null {
  if (prefs.autoDelegateId && !delegateCandidates(personId).some((c) => c.id === prefs.autoDelegateId)) {
    return "Choose your manager, a peer under the same manager, or someone in your team.";
  }
  const state = getDelegationState();
  return write({ ...state, prefs: { ...state.prefs, [personId]: prefs } });
}

export function historyFor(delegatorId: string): Delegation[] {
  return getDelegationState().delegations.filter((d) => d.delegatorId === delegatorId);
}

export function scopeText(scope: Delegation["scope"]): string {
  if (scope === "all") return "All request types";
  return scope.map((s) => DELEGATION_SCOPES.find((x) => x.id === s)?.label ?? s).join(", ");
}

/** Decisions taken under delegation carry this prefix in their note. */
export const ON_BEHALF_PREFIX = "On behalf of ";

export function onBehalfNote(delegatorId: string, note?: string): string {
  const text = note?.trim();
  return `${ON_BEHALF_PREFIX}${personLabel(delegatorId)}${text ? ` — ${text}` : ""}`;
}

/** Splits a stored decision note back into "on behalf of" name and the remaining note. */
export function parseOnBehalf(note?: string): { onBehalfOf?: string; note?: string } {
  if (!note?.startsWith(ON_BEHALF_PREFIX)) return { note };
  const rest = note.slice(ON_BEHALF_PREFIX.length);
  const cut = rest.indexOf(" — ");
  return cut < 0 ? { onBehalfOf: rest } : { onBehalfOf: rest.slice(0, cut), note: rest.slice(cut + 3) };
}

// ---------- Backend mode (VITE_API_URL): delegations live on the server ----------

/** backend/app/schemas/approval_chains.py DelegationOut */
interface DelegationOut {
  id: string;
  delegator_id: string;
  delegate_id: string;
  from: string;
  to: string;
  types: string[] | null;
  note: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

/** Portal scope -> server approval type ("other" = every other type). */
const SCOPE_TO_TYPE: Record<DelegationScope, string> = {
  leave: "leave",
  expenses: "expense",
  timesheets: "timesheet",
  attendance: "attendance_correction",
  others: "other",
};

function fromApi(d: DelegationOut): Delegation {
  const scopes = d.types
    ? DELEGATION_SCOPES.map((s) => s.id).filter((id) => d.types!.includes(SCOPE_TO_TYPE[id]))
    : null;
  return {
    id: d.id,
    delegatorId: d.delegator_id,
    delegateId: d.delegate_id,
    from: d.from,
    to: d.to,
    ...(d.note ? { note: d.note } : {}),
    scope: scopes && scopes.length ? scopes : "all",
    createdOn: d.created_at.slice(0, 10),
    ...(d.active ? {} : { endedOn: d.updated_at.slice(0, 10) }),
  };
}

/** Loads the delegations I gave or received from the API into this store (backend mode). */
export async function loadApiDelegations(): Promise<string | null> {
  if (!API_ENABLED) return null;
  try {
    const rows = await api.get<DelegationOut[]>("/delegations", { include_ended: true });
    cache = { ...getDelegationState(), delegations: rows.map(fromApi) };
    listeners.forEach((fn) => fn());
    return null;
  } catch (error) {
    return errorText(error, "Could not load delegations.");
  }
}

/** Backend mode: create on the server (it checks dates, overlaps and loops), then reload. */
export async function apiCreateDelegation(input: {
  delegateId: string;
  from: string;
  to: string;
  note?: string;
  scope: "all" | DelegationScope[];
}): Promise<string | null> {
  if (!input.delegateId) return "Choose who will decide on your behalf.";
  if (input.scope !== "all" && input.scope.length === 0) return "Pick at least one request type.";
  try {
    await api.post("/delegations", {
      delegate_id: input.delegateId,
      from: input.from,
      to: input.to,
      note: input.note?.trim() || null,
      types: input.scope === "all" ? null : input.scope.map((s) => SCOPE_TO_TYPE[s]),
    });
  } catch (error) {
    return errorText(error, "Could not save. Try again.");
  }
  return loadApiDelegations();
}

export async function apiEndDelegation(id: string): Promise<string | null> {
  try {
    await apiDelete(`/delegations/${encodeURIComponent(id)}`);
  } catch (error) {
    return errorText(error, "Could not end it. Try again.");
  }
  return loadApiDelegations();
}
