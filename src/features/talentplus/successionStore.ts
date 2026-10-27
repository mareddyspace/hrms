import { todayISO } from "../../model.ts";
import { listPeople } from "../../data/peopleLocal.ts";
import { getTalentState } from "../../data/talentLocal.ts";
import {
  arrayOr,
  createLocalStore,
  isExecutive,
  isHr,
  isInReportingLine,
  isTopOfOrg,
  lookupPerson,
  newId,
  type OrgPerson,
  type PlusActor,
  type PlusResult,
} from "./shared.ts";

export const LEVELS = ["Low", "Medium", "High"] as const;
export type Level = (typeof LEVELS)[number];
export const READINESS = ["Ready now", "Ready in 1–2 years", "Ready in 3+ years"] as const;
export type Readiness = (typeof READINESS)[number];

export interface Placement {
  employeeId: string;
  performance: Level;
  potential: Level;
  flightRisk: Level;
  readiness: Readiness;
  note: string;
  updatedBy: string;
  updatedOn: string;
}

export interface Successor {
  employeeId: string;
  readiness: Readiness;
  nominatedBy: string;
  nominatedOn: string;
}

export interface KeyRole {
  id: string;
  title: string;
  incumbentId: string;
  successors: Successor[];
  /** Executive roles (CEO, HR Director): only HR and the CEO edit their succession. */
  executive?: boolean;
}

interface SuccessionState {
  placements: Placement[];
  keyRoles: KeyRole[];
}

export const MAX_SUCCESSORS = 3;

/** Ram's team, the same set used for tasks, leave and timesheets. */
const RAM_TEAM = ["emp-priya", "emp-anu", "emp-kabir", "emp-diya"];

/* ───────────── Seed ───────────── */

function defaults(): SuccessionState {
  const placements: Placement[] = [
    { employeeId: "emp-mahesh", performance: "Medium", potential: "High", flightRisk: "Medium", readiness: "Ready in 1–2 years", note: "Strong system design growth.", updatedBy: "emp-ram", updatedOn: "2026-09-30" },
    { employeeId: "emp-ram", performance: "High", potential: "High", flightRisk: "Low", readiness: "Ready now", note: "", updatedBy: "demo-ceo", updatedOn: "2026-09-28" },
    { employeeId: "demo-recruiter", performance: "High", potential: "Medium", flightRisk: "Medium", readiness: "Ready in 1–2 years", note: "", updatedBy: "demo-hr-admin", updatedOn: "2026-09-26" },
    { employeeId: "demo-admin", performance: "Low", potential: "Medium", flightRisk: "Low", readiness: "Ready in 3+ years", note: "", updatedBy: "demo-ceo", updatedOn: "2026-09-25" },
  ];
  const mix: [Level, Level, Level][] = [
    ["High", "Medium", "Low"],
    ["Medium", "Low", "Medium"],
    ["Low", "Low", "High"],
    ["Medium", "Medium", "Low"],
  ];
  RAM_TEAM.forEach((id, i) => {
    const [performance, potential, flightRisk] = mix[i];
    placements.push({ employeeId: id, performance, potential, flightRisk, readiness: "Ready in 3+ years", note: "", updatedBy: "emp-ram", updatedOn: "2026-09-30" });
  });
  return {
    placements,
    keyRoles: [
      {
        id: "kr-eng-mgr",
        title: "Engineering Manager",
        incumbentId: "emp-ram",
        successors: [{ employeeId: "emp-mahesh", readiness: "Ready in 1–2 years", nominatedBy: "demo-ceo", nominatedOn: "2026-09-30" }],
      },
      {
        id: "kr-hr-dir",
        title: "HR Director",
        incumbentId: "demo-hr-admin",
        executive: true,
        successors: [{ employeeId: "demo-recruiter", readiness: "Ready in 3+ years", nominatedBy: "demo-ceo", nominatedOn: "2026-09-20" }],
      },
      {
        id: "kr-ceo",
        title: "Chief Executive Officer",
        incumbentId: "demo-ceo",
        executive: true,
        successors: [
          { employeeId: "emp-ram", readiness: "Ready in 3+ years", nominatedBy: "demo-hr-admin", nominatedOn: "2026-09-20" },
        ],
      },
    ],
  };
}

function normalize(saved: unknown, base: SuccessionState): SuccessionState {
  const s = (saved ?? {}) as Partial<SuccessionState>;
  return { placements: arrayOr(s.placements, base.placements), keyRoles: arrayOr(s.keyRoles, base.keyRoles) };
}

// v2: Ram's team re-seeded with his real reports, executive roles flagged.
// v3: the Compensation persona was retired. v4: the Hiring Manager persona was retired.
try {
  ["kastech.succession.v1", "kastech.succession.v2", "kastech.succession.v3"].forEach((k) => localStorage.removeItem(k));
} catch {
  /* ignore */
}
const store = createLocalStore<SuccessionState>("kastech.succession.v4", defaults, normalize);

export const subscribeSuccession = store.subscribe;
export const getSuccessionState = store.getState;
export const resetSuccession = store.reset;

/* ───────────── People ───────────── */

let peopleCache: { source: unknown; list: OrgPerson[] } | null = null;

/** Directory people plus Ram's teammates (who are not directory records). */
export function successionPeople(): OrgPerson[] {
  const source = listPeople();
  if (peopleCache?.source === source) return peopleCache.list;
  const list: OrgPerson[] = source.map((p) => ({ id: p.id, fullName: p.fullName, designation: p.designation, employmentStatus: p.employmentStatus }));
  for (const id of RAM_TEAM) {
    if (!list.some((p) => p.id === id)) {
      const person = lookupPerson(id);
      if (person) list.push(person);
    }
  }
  peopleCache = { source, list };
  return list;
}

/* ───────────── Permissions ───────────── */

/** HR and executives see the whole organisation. */
export function seesAll(actor: PlusActor): boolean {
  return isHr(actor.role) || isExecutive(actor.role);
}

/** Employees are restricted; everyone else needs at least one person in their reporting line. */
export function canOpenSuccession(actor: PlusActor): boolean {
  if (seesAll(actor)) return true;
  if (actor.role === "employee") return false;
  return successionPeople().some((p) => isInReportingLine(actor.id, p.id));
}

export function canSeePerson(actor: PlusActor, employeeId: string): boolean {
  if (!canOpenSuccession(actor)) return false;
  if (seesAll(actor)) return true;
  return isInReportingLine(actor.id, employeeId);
}

/** HR or executives (any person but themselves) or anyone above the person. Nobody assesses the CEO. */
export function canAssess(actor: PlusActor, employeeId: string): boolean {
  if (actor.id === employeeId) return false;
  if (isTopOfOrg(employeeId)) return false;
  if (isHr(actor.role) || isExecutive(actor.role)) return true;
  if (actor.role === "employee") return false;
  return isInReportingLine(actor.id, employeeId);
}

/** Who may change a key role's successors: never the role holder; executive roles only HR and the CEO. */
export function canEditKeyRole(actor: PlusActor, role: KeyRole): boolean {
  if (role.incumbentId === actor.id) return false;
  if (role.executive || isTopOfOrg(role.incumbentId)) return isHr(actor.role) || isTopOfOrg(actor.id);
  return canOpenSuccession(actor);
}

export function canRemoveSuccessor(actor: PlusActor, role: KeyRole, successor: Successor): boolean {
  if (!canEditKeyRole(actor, role)) return false;
  if (successor.employeeId === actor.id) return false;
  return isHr(actor.role) || isExecutive(actor.role) || successor.nominatedBy === actor.id;
}

/** People this persona may view on the grid. */
export function visiblePeopleIds(actor: PlusActor): Set<string> {
  if (!canOpenSuccession(actor)) return new Set();
  const people = successionPeople().filter((p) => p.employmentStatus !== "Terminated");
  if (seesAll(actor)) return new Set(people.map((p) => p.id));
  return new Set(people.filter((p) => isInReportingLine(actor.id, p.id)).map((p) => p.id));
}

/* ───────────── Prefill from reviews ───────────── */

const RATING_TO_LEVEL: Record<string, Level> = {
  Exceptional: "High",
  Strong: "High",
  Solid: "Medium",
  "Needs improvement": "Low",
};

export function reviewPerformance(employeeId: string): { level: Level; rating: string } | null {
  const review = getTalentState().reviews.find((r) => r.employeeId === employeeId && r.rating);
  if (!review?.rating) return null;
  const level = RATING_TO_LEVEL[review.rating];
  return level ? { level, rating: review.rating } : null;
}

/* ───────────── Mutations ───────────── */

function isLevel(v: string): v is Level {
  return (LEVELS as readonly string[]).includes(v);
}
function isReadiness(v: string): v is Readiness {
  return (READINESS as readonly string[]).includes(v);
}

export type PlacementInput = Omit<Placement, "updatedBy" | "updatedOn">;

export function savePlacement(actor: PlusActor, input: PlacementInput): PlusResult {
  if (!input.employeeId) return "Choose a person.";
  const person = lookupPerson(input.employeeId);
  if (!person) return "That person isn't in the directory.";
  if (person.employmentStatus === "Terminated") return "You can't assess someone who has left.";
  if (input.employeeId === actor.id) return "You can't place yourself on the grid.";
  if (isTopOfOrg(input.employeeId)) return "The CEO is not placed on the grid.";
  if (!canAssess(actor, input.employeeId)) return "You can only assess people in your reporting line.";
  if (!isLevel(input.performance)) return "Choose a performance level.";
  if (!isLevel(input.potential)) return "Choose a potential level.";
  if (!isLevel(input.flightRisk)) return "Choose a flight risk.";
  if (!isReadiness(input.readiness)) return "Choose a readiness.";
  if (input.note.length > 300) return "Keep the note under 300 characters.";
  return store.mutate((s) => {
    const row: Placement = { ...input, note: input.note.trim(), updatedBy: actor.id, updatedOn: todayISO() };
    const i = s.placements.findIndex((p) => p.employeeId === input.employeeId);
    if (i >= 0) s.placements[i] = row;
    else s.placements.push(row);
    return null;
  });
}

export function removePlacement(actor: PlusActor, employeeId: string): PlusResult {
  if (!canAssess(actor, employeeId)) return "You can only change people in your reporting line.";
  return store.mutate((s) => {
    if (!s.placements.some((p) => p.employeeId === employeeId)) return "This person isn't on the grid.";
    s.placements = s.placements.filter((p) => p.employeeId !== employeeId);
    return null;
  });
}

export function addKeyRole(actor: PlusActor, title: string, incumbentId: string): PlusResult {
  if (!isHr(actor.role)) return "Only HR can add key roles.";
  const clean = title.trim();
  if (!clean) return "Enter the role title.";
  if (clean.length > 80) return "Keep the role title under 80 characters.";
  if (!incumbentId) return "Choose the current role holder.";
  if (!lookupPerson(incumbentId)) return "That person isn't in the directory.";
  return store.mutate((s) => {
    if (s.keyRoles.some((r) => r.title.toLowerCase() === clean.toLowerCase())) return "This key role is already listed.";
    s.keyRoles.push({ id: newId("kr"), title: clean, incumbentId, successors: [], executive: isTopOfOrg(incumbentId) || undefined });
    return null;
  });
}

export function nominateSuccessor(actor: PlusActor, roleId: string, employeeId: string, readiness: string): PlusResult {
  if (!canOpenSuccession(actor)) return "You don't have access to succession planning.";
  if (!employeeId) return "Choose a successor.";
  if (!isReadiness(readiness)) return "Choose a readiness.";
  const person = lookupPerson(employeeId);
  if (!person) return "That person isn't in the directory.";
  if (person.employmentStatus === "Terminated") return "You can't nominate someone who has left.";
  if (employeeId === actor.id) return "You can't nominate yourself.";
  if (!canAssess(actor, employeeId)) return "You can only nominate people in your reporting line.";
  return store.mutate((s) => {
    const role = s.keyRoles.find((r) => r.id === roleId);
    if (!role) return "Key role not found.";
    if (role.incumbentId === actor.id) return "You can't pick successors for your own role.";
    if (!canEditKeyRole(actor, role)) return "Only HR and the CEO pick successors for this role.";
    if (role.incumbentId === employeeId) return "A person can't succeed themselves.";
    if (role.successors.some((x) => x.employeeId === employeeId)) return "This person is already nominated for this role.";
    if (role.successors.length >= MAX_SUCCESSORS) return `A key role can have at most ${MAX_SUCCESSORS} successors.`;
    role.successors.push({ employeeId, readiness, nominatedBy: actor.id, nominatedOn: todayISO() });
    return null;
  });
}

export function removeSuccessor(actor: PlusActor, roleId: string, employeeId: string): PlusResult {
  return store.mutate((s) => {
    const role = s.keyRoles.find((r) => r.id === roleId);
    if (!role) return "Key role not found.";
    const row = role.successors.find((x) => x.employeeId === employeeId);
    if (!row) return "This person isn't nominated for this role.";
    if (role.incumbentId === actor.id) return "You can't change successors for your own role.";
    if (employeeId === actor.id) return "You can't change your own nomination.";
    if (!canRemoveSuccessor(actor, role, row)) return "Only HR or the person who nominated them can remove this nomination.";
    role.successors = role.successors.filter((x) => x.employeeId !== employeeId);
    return null;
  });
}
