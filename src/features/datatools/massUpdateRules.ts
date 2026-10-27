import { FILTER_OPTIONS, type EmploymentStatus, type PersonRecord } from "../../data/peopleData.ts";
import type { LocalPersonRecord } from "../../data/peopleLocal.ts";
import { DEMO_ACCOUNTS, managementChain } from "../../demoAccounts.ts";
import { HR_ROLES, cleanText, looksLikeFormula, type DataToolsActor } from "./shared.ts";

/** Mass update is an HR tool: platform admins and line managers cannot use it. */
export function canMassUpdate(role: DataToolsActor["role"]): boolean {
  return HR_ROLES.includes(role);
}

/** Everyone above the actor (directory manager chain plus the persona chain). */
function actorChain(actorId: string, people: readonly PersonRecord[]): Set<string> {
  const byId = new Map(people.map((p) => [p.id, p]));
  const chain = new Set<string>();
  let cursor = byId.get(actorId)?.managerId;
  while (cursor && !chain.has(cursor) && cursor !== actorId) {
    chain.add(cursor);
    cursor = byId.get(cursor)?.managerId;
  }
  for (const manager of managementChain(actorId, DEMO_ACCOUNTS)) chain.add(manager.id);
  return chain;
}

export const MAX_MASS_UPDATE = 1000;

export type MassChange =
  | { kind: "manager"; managerId: string }
  | { kind: "department"; department: string }
  | { kind: "location"; location: string }
  | { kind: "status"; status: EmploymentStatus };

export interface MassPlan {
  error: string | null;
  changes: { before: LocalPersonRecord; after: LocalPersonRecord }[];
  skipped: { person: PersonRecord; reason: string }[];
}

export function describeChange(change: MassChange, people: readonly PersonRecord[]): string {
  switch (change.kind) {
    case "manager":
      return `Manager → ${people.find((p) => p.id === change.managerId)?.fullName ?? change.managerId}`;
    case "department":
      return `Department → ${change.department}`;
    case "location":
      return `Location → ${change.location}`;
    case "status":
      return `Status → ${change.status}`;
  }
}

/** Work out exactly who would change, and why anyone else is skipped. Pure — used for preview and commit. */
export function planMassUpdate(
  actor: DataToolsActor,
  ids: readonly string[],
  change: MassChange,
  people: readonly PersonRecord[],
  today: string,
): MassPlan {
  void today;
  const plan: MassPlan = { error: null, changes: [], skipped: [] };
  const fail = (error: string) => ({ ...plan, error });
  if (!canMassUpdate(actor.role)) return fail("Only HR can make mass updates.");
  const unique = [...new Set(ids)];
  if (!unique.length) return fail("Select at least one person.");
  if (unique.length > MAX_MASS_UPDATE) return fail(`Select at most ${MAX_MASS_UPDATE} people at a time.`);
  const byId = new Map(people.map((p) => [p.id, p as LocalPersonRecord]));

  let manager: PersonRecord | undefined;
  let location = "";
  if (change.kind === "manager") {
    manager = byId.get(change.managerId);
    if (!manager) return fail("Choose a new manager from the directory.");
    if (manager.employmentStatus === "Terminated") return fail("A terminated employee cannot be a manager.");
  } else if (change.kind === "department") {
    if (!FILTER_OPTIONS.departments.includes(change.department)) return fail("Choose a department from the list.");
  } else if (change.kind === "location") {
    location = cleanText(change.location);
    if (location.length < 2 || location.length > 60) return fail("Location must be 2–60 characters.");
    if (looksLikeFormula(location) || !/^[\p{L}][\p{L}\p{M}0-9 .,'()-]*$/u.test(location)) return fail("Location contains characters that are not allowed.");
  } else {
    if (!FILTER_OPTIONS.employmentStatuses.includes(change.status)) return fail("Choose an employment status from the list.");
    if (change.status === "Terminated") return fail("Terminations go through the exit workflow, not mass update.");
  }
  const aboveActor = actorChain(actor.id, people);

  // Manager chain for loop checks: walking up from the new manager must never reach the person.
  const chainOf = (id: string): Set<string> => {
    const seen = new Set<string>();
    let cursor = byId.get(id)?.managerId;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = byId.get(cursor)?.managerId;
    }
    return seen;
  };
  const managerChain = manager ? chainOf(manager.id) : new Set<string>();

  for (const id of unique) {
    const person = byId.get(id);
    if (!person) continue;
    const skip = (reason: string) => plan.skipped.push({ person, reason });
    if (person.id === actor.id) {
      skip("You cannot change your own record.");
      continue;
    }
    if (aboveActor.has(person.id)) {
      skip("Above you in your reporting line.");
      continue;
    }
    switch (change.kind) {
      case "manager": {
        if (person.id === manager!.id) skip("Would become their own manager.");
        else if (managerChain.has(person.id)) skip(`${manager!.fullName} reports to them — this would create a loop.`);
        else if (person.managerId === manager!.id) skip("Already reports to this manager.");
        else if (person.employmentStatus === "Terminated") skip("Terminated — reporting line is frozen.");
        else plan.changes.push({ before: person, after: { ...person, managerId: manager!.id, managerName: manager!.fullName } });
        break;
      }
      case "department": {
        if (person.department === change.department) skip("Already in this department.");
        else plan.changes.push({ before: person, after: { ...person, department: change.department } });
        break;
      }
      case "location": {
        if (person.location.toLowerCase() === location.toLowerCase()) skip("Already at this location.");
        else plan.changes.push({ before: person, after: { ...person, location } });
        break;
      }
      case "status": {
        if (person.employmentStatus === change.status) skip(`Already ${change.status}.`);
        else if (person.employmentStatus === "Terminated") skip("Terminated — reactivate through the exit workflow.");
        else plan.changes.push({ before: person, after: { ...person, employmentStatus: change.status, exitDate: undefined, exitReason: undefined } });
        break;
      }
    }
  }
  return plan;
}

/** People terminated by this plan who still have active direct reports (outside the plan). */
export function orphanedReports(plan: MassPlan, people: readonly PersonRecord[]): number {
  const leaving = new Set(plan.changes.filter((c) => c.after.employmentStatus === "Terminated").map((c) => c.after.id));
  if (!leaving.size) return 0;
  return people.filter((p) => leaving.has(p.managerId) && !leaving.has(p.id) && p.employmentStatus !== "Terminated").length;
}
