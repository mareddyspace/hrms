import { FILTER_OPTIONS, type EmploymentStatus, type PersonRecord } from "../../data/peopleData.ts";
import type { LocalPersonRecord } from "../../data/peopleLocal.ts";
import { cleanText, isValidISODate, looksLikeFormula, type DataToolsActor } from "./shared.ts";

export const MAX_MASS_UPDATE = 1000;

export type MassChange =
  | { kind: "manager"; managerId: string }
  | { kind: "department"; department: string }
  | { kind: "location"; location: string }
  | { kind: "status"; status: EmploymentStatus; exitDate?: string; exitReason?: string };

export interface MassPlan {
  error: string | null;
  changes: { before: LocalPersonRecord; after: LocalPersonRecord }[];
  skipped: { person: PersonRecord; reason: string }[];
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
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
      return `Status → ${change.status}${change.status === "Terminated" && change.exitDate ? ` (exit ${change.exitDate})` : ""}`;
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
  const plan: MassPlan = { error: null, changes: [], skipped: [] };
  const fail = (error: string) => ({ ...plan, error });
  const unique = [...new Set(ids)];
  if (!unique.length) return fail("Select at least one person.");
  if (unique.length > MAX_MASS_UPDATE) return fail(`Select at most ${MAX_MASS_UPDATE} people at a time.`);
  const byId = new Map(people.map((p) => [p.id, p as LocalPersonRecord]));

  let manager: PersonRecord | undefined;
  let location = "";
  let exitReason = "";
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
    if (change.status === "Terminated") {
      if (!change.exitDate) return fail("Exit date is required to terminate.");
      if (!isValidISODate(change.exitDate)) return fail("Exit date must be a real date in YYYY-MM-DD format.");
      if (change.exitDate > addDays(today, 90)) return fail("Exit date can be at most 90 days from today.");
      exitReason = cleanText(change.exitReason);
      if (exitReason.length < 3) return fail("Exit reason is required (at least 3 characters).");
      if (exitReason.length > 200) return fail("Exit reason must be 200 characters or fewer.");
      if (looksLikeFormula(exitReason)) return fail("Exit reason cannot start with =, +, - or @.");
    }
  }

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
        else if (change.status === "Terminated" && person.id === actor.id) skip("You cannot terminate yourself.");
        else if (change.status === "Terminated" && change.exitDate! < person.dateOfJoining) skip(`Exit date is before their joining date (${person.dateOfJoining}).`);
        else if (change.status === "Terminated") {
          plan.changes.push({ before: person, after: { ...person, employmentStatus: "Terminated", exitDate: change.exitDate, exitReason } });
        } else {
          plan.changes.push({ before: person, after: { ...person, employmentStatus: change.status, exitDate: undefined, exitReason: undefined } });
        }
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
