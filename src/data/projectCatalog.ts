/**
 * Sample project details (description, milestones, team, tasks, budget) for the projects people log time to.
 * Keyed by project id; local ids (p-…) and backend ids (prj-…) both resolve here.
 */

export type ProjectHealth = "On track" | "At risk" | "Delayed" | "Completed";

export interface ProjectMilestone {
  name: string;
  due: string;
  done: boolean;
}

export interface ProjectTask {
  id: string;
  title: string;
  due: string;
  status: "To do" | "In progress" | "In review" | "Done";
  estimate: number;
}

export interface ProjectActivity {
  date: string;
  who: string;
  text: string;
}

export interface ProjectDetail {
  description: string;
  client: string;
  start: string;
  end: string;
  health: ProjectHealth;
  progress: number;
  myRole: string;
  /** Hours budgeted for the viewer on this project. */
  myBudgetHours: number;
  manager: string;
  team: { name: string; role: string }[];
  milestones: ProjectMilestone[];
  tasks: ProjectTask[];
  activity: ProjectActivity[];
}

const northwind: ProjectDetail = {
  description: "Rebuild of the Northwind invoicing and payment collection system, moving billing runs off the legacy batch jobs.",
  client: "Northwind Retail",
  start: "2024-11-04",
  end: "2026-12-18",
  health: "On track",
  progress: 72,
  myRole: "Frontend developer",
  myBudgetHours: 320,
  manager: "Ram Krishnan",
  team: [
    { name: "Ram Krishnan", role: "Project manager" },
    { name: "Priya Nair", role: "Tech lead" },
    { name: "Kabir Sharma", role: "Backend developer" },
    { name: "Anu Rao", role: "QA engineer" },
  ],
  milestones: [
    { name: "Discovery and design", due: "2025-01-31", done: true },
    { name: "Invoice engine", due: "2025-06-30", done: true },
    { name: "Payment gateway", due: "2026-03-31", done: true },
    { name: "Customer self-service", due: "2026-11-13", done: false },
    { name: "Go-live", due: "2026-12-18", done: false },
  ],
  tasks: [
    { id: "NW-412", title: "Invoice list filters and export", due: "2026-11-06", status: "In progress", estimate: 12 },
    { id: "NW-418", title: "Payment status timeline", due: "2026-11-12", status: "To do", estimate: 8 },
    { id: "NW-401", title: "Dunning email preview", due: "2026-10-23", status: "In review", estimate: 6 },
    { id: "NW-388", title: "Credit note form", due: "2026-10-09", status: "Done", estimate: 10 },
  ],
  activity: [
    { date: "2026-10-27", who: "Anu Rao", text: "Passed QA on the credit note form" },
    { date: "2026-10-24", who: "Priya Nair", text: "Moved go-live review to 4 Dec" },
    { date: "2026-10-21", who: "Ram Krishnan", text: "Signed off the payment gateway milestone" },
  ],
};

const maple: ProjectDetail = {
  description: "Patient portal for Maple Health clinics: appointments, reports and secure messages with doctors.",
  client: "Maple Health",
  start: "2026-02-02",
  end: "2027-03-26",
  health: "At risk",
  progress: 41,
  myRole: "Full-stack developer",
  myBudgetHours: 240,
  manager: "Ram Krishnan",
  team: [
    { name: "Ram Krishnan", role: "Project manager" },
    { name: "Diya Patel", role: "UX designer" },
    { name: "Kabir Sharma", role: "Backend developer" },
  ],
  milestones: [
    { name: "Requirements sign-off", due: "2026-03-13", done: true },
    { name: "Appointments module", due: "2026-08-28", done: true },
    { name: "Lab reports", due: "2026-11-27", done: false },
    { name: "Secure messaging", due: "2027-02-12", done: false },
    { name: "Launch", due: "2027-03-26", done: false },
  ],
  tasks: [
    { id: "MC-207", title: "Lab report viewer", due: "2026-11-10", status: "In progress", estimate: 16 },
    { id: "MC-211", title: "Report download as PDF", due: "2026-11-20", status: "To do", estimate: 6 },
    { id: "MC-199", title: "Appointment reminders", due: "2026-10-16", status: "Done", estimate: 8 },
  ],
  activity: [
    { date: "2026-10-28", who: "Ram Krishnan", text: "Flagged lab reports as at risk: client data feed is late" },
    { date: "2026-10-22", who: "Diya Patel", text: "Shared lab report designs" },
    { date: "2026-10-16", who: "Kabir Sharma", text: "Released appointment reminders" },
  ],
};

const library: ProjectDetail = {
  description: "New public website for City Library with catalogue search and event booking.",
  client: "City Library",
  start: "2024-02-05",
  end: "2024-10-31",
  health: "Completed",
  progress: 100,
  myRole: "Frontend developer",
  myBudgetHours: 400,
  manager: "Ram Krishnan",
  team: [
    { name: "Ram Krishnan", role: "Project manager" },
    { name: "Diya Patel", role: "UX designer" },
  ],
  milestones: [
    { name: "Design", due: "2024-03-29", done: true },
    { name: "Catalogue search", due: "2024-07-12", done: true },
    { name: "Launch", due: "2024-10-31", done: true },
  ],
  tasks: [{ id: "CL-88", title: "Event booking page", due: "2024-09-20", status: "Done", estimate: 14 }],
  activity: [{ date: "2024-10-31", who: "Ram Krishnan", text: "Project closed" }],
};

const hrms: ProjectDetail = {
  description: "The TimeZ HRMS portal itself: leave, time, pay and people modules.",
  client: "TimeZ (internal)",
  start: "2026-01-05",
  end: "2026-12-31",
  health: "On track",
  progress: 64,
  myRole: "Developer",
  myBudgetHours: 200,
  manager: "Ram Krishnan",
  team: [
    { name: "Ram Krishnan", role: "Product owner" },
    { name: "Priya Nair", role: "Tech lead" },
    { name: "Anu Rao", role: "QA engineer" },
  ],
  milestones: [
    { name: "Leave and attendance", due: "2026-03-31", done: true },
    { name: "Timesheets", due: "2026-06-30", done: true },
    { name: "Payroll", due: "2026-09-30", done: true },
    { name: "Shifts and roster", due: "2026-11-27", done: false },
    { name: "Year-end release", due: "2026-12-31", done: false },
  ],
  tasks: [
    { id: "HR-301", title: "Roster grid colours", due: "2026-11-05", status: "In progress", estimate: 6 },
    { id: "HR-305", title: "Optional holiday picker", due: "2026-11-14", status: "To do", estimate: 8 },
    { id: "HR-290", title: "Team timesheet review", due: "2026-10-30", status: "In review", estimate: 10 },
  ],
  activity: [
    { date: "2026-10-28", who: "Priya Nair", text: "Merged team timesheet review" },
    { date: "2026-10-20", who: "Ram Krishnan", text: "Planned the year-end release" },
  ],
};

const internal: ProjectDetail = {
  description: "Meetings, training, hiring interviews and admin time.",
  client: "TimeZ (internal)",
  start: "2026-01-01",
  end: "2026-12-31",
  health: "On track",
  progress: 83,
  myRole: "Member",
  myBudgetHours: 160,
  manager: "Ram Krishnan",
  team: [{ name: "Everyone", role: "Members" }],
  milestones: [
    { name: "H1 training plan", due: "2026-06-30", done: true },
    { name: "H2 training plan", due: "2026-12-31", done: false },
  ],
  tasks: [{ id: "INT-12", title: "Complete security awareness course", due: "2026-11-30", status: "To do", estimate: 2 }],
  activity: [{ date: "2026-10-15", who: "HR", text: "Opened H2 training sign-ups" }],
};

const acme: ProjectDetail = {
  description: "Customer portal for Acme Corp: orders, returns and support tickets in one place.",
  client: "Acme Corp",
  start: "2026-04-06",
  end: "2027-01-29",
  health: "On track",
  progress: 55,
  myRole: "Frontend developer",
  myBudgetHours: 180,
  manager: "Ram Krishnan",
  team: [
    { name: "Ram Krishnan", role: "Project manager" },
    { name: "Kabir Sharma", role: "Backend developer" },
  ],
  milestones: [
    { name: "Orders", due: "2026-07-31", done: true },
    { name: "Returns", due: "2026-11-20", done: false },
    { name: "Support tickets", due: "2027-01-29", done: false },
  ],
  tasks: [
    { id: "AC-140", title: "Return request form", due: "2026-11-09", status: "In progress", estimate: 10 },
    { id: "AC-133", title: "Order history paging", due: "2026-10-19", status: "Done", estimate: 4 },
  ],
  activity: [{ date: "2026-10-26", who: "Kabir Sharma", text: "Returns API ready for testing" }],
};

const globex: ProjectDetail = {
  description: "Moving Globex's on-premise apps to the cloud with zero downtime.",
  client: "Globex Ltd",
  start: "2026-05-04",
  end: "2027-02-26",
  health: "Delayed",
  progress: 33,
  myRole: "Developer",
  myBudgetHours: 120,
  manager: "Ram Krishnan",
  team: [
    { name: "Ram Krishnan", role: "Project manager" },
    { name: "Priya Nair", role: "Cloud architect" },
  ],
  milestones: [
    { name: "Assessment", due: "2026-06-12", done: true },
    { name: "Pilot migration", due: "2026-10-16", done: false },
    { name: "Full cut-over", due: "2027-02-26", done: false },
  ],
  tasks: [{ id: "GX-57", title: "Pilot app smoke tests", due: "2026-11-04", status: "In progress", estimate: 8 }],
  activity: [{ date: "2026-10-19", who: "Priya Nair", text: "Pilot moved two weeks: firewall approval pending" }],
};

const CATALOG: Record<string, ProjectDetail> = {
  "p-north": northwind,
  "p-maple": maple,
  "p-library": library,
  "p-timez-hrms": hrms,
  "prj-hrms": hrms,
  "p-internal": internal,
  "prj-internal": internal,
  "prj-acme": acme,
  "prj-globex": globex,
};

/** Details for a project, or a plain fallback built from what the project record knows. */
export function projectDetail(
  project: { id: string; client: string; startDate: string; endDate: string; status: string; maxHours: number | null },
  viewerRole?: string,
): ProjectDetail {
  const known = CATALOG[project.id];
  // The sample role and hours budget are a delivery engineer's; leaders see the project as its sponsor / owner.
  if (known && viewerRole && viewerRole !== "employee") {
    const lead = viewerRole === "executive" ? "Executive sponsor" : viewerRole === "manager" ? "Engineering manager" : "Stakeholder";
    return { ...known, myRole: lead, myBudgetHours: viewerRole === "executive" ? 0 : known.myBudgetHours };
  }
  if (known) return known;
  return {
    description: "",
    client: project.client,
    start: project.startDate,
    end: project.endDate,
    health: project.status === "previous" ? "Completed" : "On track",
    progress: project.status === "previous" ? 100 : 0,
    myRole: "Member",
    myBudgetHours: 0,
    manager: "",
    team: [],
    milestones: [],
    tasks: [],
    activity: [],
  };
}
