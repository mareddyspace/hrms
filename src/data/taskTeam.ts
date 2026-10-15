import { EMPLOYEE } from "../seed.ts";

/** Assignable team roster for manager task assignment (demo). */
export interface TaskTeamPerson {
  id: string;
  shortName: string;
  fullName: string;
  department: string;
  role: string;
}

export const TASK_TEAM: TaskTeamPerson[] = [
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
    role: "L&D Lead",
  },
  {
    id: "emp-anu",
    shortName: "Anu",
    fullName: "Anu Rao",
    department: "Engineering",
    role: "Performance Mgr",
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

export function taskPersonById(id: string): TaskTeamPerson | undefined {
  return TASK_TEAM.find((p) => p.id === id);
}

export function taskPersonLabel(id: string): string {
  return taskPersonById(id)?.shortName ?? id;
}
