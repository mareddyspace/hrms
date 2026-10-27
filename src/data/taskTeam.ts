import { DEMO_ACCOUNTS, managementChain } from "../demoAccounts.ts";
import { EMPLOYEE } from "../seed.ts";

/** Assignable team roster for manager task assignment (demo). */
export interface TaskTeamPerson {
  id: string;
  shortName: string;
  fullName: string;
  department: string;
  role: string;
}

const FICTIONAL_TEAM: TaskTeamPerson[] = [
  {
    id: EMPLOYEE.id,
    shortName: "Babu",
    fullName: "Babu Menon",
    department: "Engineering",
    role: "Software Engineer",
  },
  {
    id: "emp-priya",
    shortName: "Priya",
    fullName: "Priya Nair",
    department: "Engineering",
    role: "Senior Engineer",
  },
  {
    id: "emp-anu",
    shortName: "Anu",
    fullName: "Anu Rao",
    department: "Engineering",
    role: "Software Engineer",
  },
  {
    id: "emp-kabir",
    shortName: "Kabir",
    fullName: "Kabir Sharma",
    department: "Engineering",
    role: "Senior Engineer",
  },
  {
    id: "emp-diya",
    shortName: "Diya",
    fullName: "Diya Patel",
    department: "Engineering",
    role: "QA Analyst",
  },
];

/** Fictional teammates plus every demo persona, so any manager has a roster of real reports. */
export const TASK_TEAM: TaskTeamPerson[] = [
  ...FICTIONAL_TEAM,
  ...DEMO_ACCOUNTS.filter((a) => !FICTIONAL_TEAM.some((p) => p.id === a.id)).map((a) => ({
    id: a.id,
    shortName: a.fullName.split(" ")[0],
    fullName: a.fullName,
    department: a.department ?? "",
    role: a.designation,
  })),
];

/** People this manager may assign tasks to: anyone below them in the demo reporting line. */
export function taskTeamFor(managerId: string): TaskTeamPerson[] {
  return TASK_TEAM.filter((p) => managementChain(p.id).some((m) => m.id === managerId));
}

export function taskPersonById(id: string): TaskTeamPerson | undefined {
  return TASK_TEAM.find((p) => p.id === id);
}

export function taskPersonLabel(id: string): string {
  return taskPersonById(id)?.shortName ?? id;
}
