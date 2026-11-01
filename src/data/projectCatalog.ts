/**
 * Sample project details for browser-only (local) mode: description, dates, budget, manager, team roles, milestones,
 * tasks, an update and activity for the projects in the local sample (src/seed.ts). Backend mode gets the same content
 * from the database (backend/app/seed_projects.py). See projectStore.ts.
 */
import type { LocalProject, TaskStatus } from "./projectStore.ts";

const BABU = "emp-mahesh";
const RAM = "emp-ram";

type Seed = {
  id: string;
  code: string;
  description: string;
  start: string;
  end: string;
  budget: number;
  teamHours: number;
  teamApproved: number;
  myTitle: string;
  myBudget: number;
  myDuties: string;
  others: [string, string, string][];
  milestones: [string, string, boolean, string][];
  tasks: [string, string, string, TaskStatus, number, string, string][];
  activity: [string, string, string][];
  update?: string;
};

const SEEDS: Seed[] = [
  {
    id: "p-north",
    code: "NW-BILLING",
    description: "Rebuild of the Northwind invoicing and payment collection system, moving billing runs off the legacy batch jobs.",
    start: "2024-11-04",
    end: "2026-12-18",
    budget: 2400,
    teamHours: 1710,
    teamApproved: 1640,
    myTitle: "Frontend developer",
    myBudget: 320,
    myDuties: "Invoice and payment screens, exports and front-end tests.",
    others: [
      ["Priya Nair", "Tech lead", "Architecture, code reviews and release planning."],
      ["Kabir Sharma", "Backend developer", "Invoice engine and payment gateway APIs."],
      ["Anu Rao", "QA engineer", "Test plans, regression runs and UAT support."],
    ],
    milestones: [
      ["Discovery and design", "2025-01-31", true, "Workshops with finance, process maps and screen designs."],
      ["Invoice engine", "2025-06-30", true, "New invoice generation replacing the nightly batch."],
      ["Payment gateway", "2026-03-31", true, "Card and bank payments with reconciliation."],
      ["Customer self-service", "2026-11-13", false, "Customers see, download and dispute invoices."],
      ["Go-live", "2026-12-18", false, "Cut-over from the legacy billing system."],
    ],
    tasks: [
      ["NW-412", "Invoice list filters and export", "2026-11-06", "in_progress", 12, BABU, "Filter invoices by status, customer and date, and export the list to Excel."],
      ["NW-418", "Payment status timeline", "2026-11-12", "todo", 8, BABU, "Show each payment's steps (initiated, authorised, settled) on the invoice page."],
      ["NW-401", "Dunning email preview", "2026-10-23", "in_review", 6, BABU, "Preview the reminder email before it is sent to a customer."],
      ["NW-388", "Credit note form", "2026-10-09", "done", 10, BABU, "Raise a credit note against an invoice."],
      ["NW-420", "Go-live cut-over plan", "2026-12-04", "todo", 16, RAM, "Plan the switch from the legacy system."],
    ],
    activity: [
      ["2026-10-27", "Ram Krishnan", "Signed off the payment gateway milestone"],
      ["2026-10-24", "Ram Krishnan", "Moved the go-live review to 4 Dec"],
    ],
    update: "Customer self-service is on track for 13 Nov. Go-live review moved to 4 Dec.",
  },
  {
    id: "p-maple",
    code: "MAPLE-PORTAL",
    description: "Patient portal for Maple Health clinics: appointments, reports and secure messages with doctors.",
    start: "2026-02-02",
    end: "2027-03-26",
    budget: 1600,
    teamHours: 760,
    teamApproved: 700,
    myTitle: "Full-stack developer",
    myBudget: 240,
    myDuties: "Lab report viewer and downloads, appointment reminders.",
    others: [
      ["Diya Patel", "UX designer", "Screen designs and usability tests with clinic staff."],
      ["Kabir Sharma", "Backend developer", "Clinic data feed and messaging APIs."],
    ],
    milestones: [
      ["Requirements sign-off", "2026-03-13", true, "Scope agreed with the clinic leads."],
      ["Appointments module", "2026-08-28", true, "Booking, rescheduling and reminders."],
      ["Lab reports", "2026-11-27", false, "Patients see and download their lab reports."],
      ["Secure messaging", "2027-02-12", false, "Messages between patients and doctors."],
      ["Launch", "2027-03-26", false, "Live for all clinics."],
    ],
    tasks: [
      ["MC-207", "Lab report viewer", "2026-11-10", "in_progress", 16, BABU, "Show a patient's lab results with reference ranges."],
      ["MC-211", "Report download as PDF", "2026-11-20", "todo", 6, BABU, "Download a lab report as a PDF."],
      ["MC-199", "Appointment reminders", "2026-10-16", "done", 8, BABU, "Text and email reminders a day before."],
    ],
    activity: [
      ["2026-10-28", "Ram Krishnan", "Flagged lab reports as at risk: the clinic data feed is late"],
      ["2026-10-22", "Diya Patel", "Shared lab report designs"],
    ],
    update: "Lab reports are at risk: the clinic's data feed is two weeks late. We are building against sample data.",
  },
  {
    id: "p-library",
    code: "CL-WEB",
    description: "New public website for City Library with catalogue search and event booking.",
    start: "2024-02-05",
    end: "2024-10-31",
    budget: 900,
    teamHours: 820,
    teamApproved: 820,
    myTitle: "Frontend developer",
    myBudget: 400,
    myDuties: "Catalogue search and event booking pages.",
    others: [["Diya Patel", "UX designer", "Site design and accessibility review."]],
    milestones: [
      ["Design", "2024-03-29", true, "Site map and page designs."],
      ["Catalogue search", "2024-07-12", true, "Search across the library catalogue."],
      ["Launch", "2024-10-31", true, "Site live."],
    ],
    tasks: [["CL-88", "Event booking page", "2024-09-20", "done", 14, BABU, "Book a seat at a library event."]],
    activity: [["2024-10-31", "Ram Krishnan", "Project closed"]],
  },
  {
    id: "p-timez-hrms",
    code: "TZ-HRMS",
    description: "The TimeZ HRMS portal itself: leave, time, pay and people modules.",
    start: "2026-01-05",
    end: "2026-12-31",
    budget: 1200,
    teamHours: 690,
    teamApproved: 650,
    myTitle: "Developer",
    myBudget: 200,
    myDuties: "Roster and holiday screens, timesheet review.",
    others: [
      ["Priya Nair", "Tech lead", "Architecture and code reviews."],
      ["Anu Rao", "QA engineer", "Regression tests for every release."],
    ],
    milestones: [
      ["Leave and attendance", "2026-03-31", true, "Leave requests, balances and attendance."],
      ["Timesheets", "2026-06-30", true, "Daily timesheets with approvals."],
      ["Payroll", "2026-09-30", true, "Monthly payroll runs and payslips."],
      ["Shifts and roster", "2026-11-27", false, "Rosters, swaps and comp-off."],
      ["Year-end release", "2026-12-31", false, "Year-end fixes and reports."],
    ],
    tasks: [
      ["HR-301", "Roster grid colours", "2026-11-05", "in_progress", 6, BABU, "Colour each shift on the roster grid."],
      ["HR-305", "Optional holiday picker", "2026-11-14", "todo", 8, BABU, "Pick optional holidays from the list."],
      ["HR-290", "Team timesheet review", "2026-10-30", "in_review", 10, BABU, "Managers approve days in one place."],
    ],
    activity: [
      ["2026-10-28", "Priya Nair", "Merged team timesheet review"],
      ["2026-10-20", "Ram Krishnan", "Planned the year-end release"],
    ],
  },
  {
    id: "p-internal",
    code: "TZ-INT",
    description: "Meetings, training, hiring interviews and admin time.",
    start: "2026-01-01",
    end: "2026-12-31",
    budget: 600,
    teamHours: 410,
    teamApproved: 400,
    myTitle: "Member",
    myBudget: 160,
    myDuties: "Team meetings, training and interviews.",
    others: [],
    milestones: [
      ["H1 training plan", "2026-06-30", true, "Training for the first half of the year."],
      ["H2 training plan", "2026-12-31", false, "Training for the second half of the year."],
    ],
    tasks: [["INT-12", "Complete security awareness course", "2026-11-30", "todo", 2, BABU, "The yearly security course in Learning."]],
    activity: [["2026-10-15", "Farhan Ali", "Opened H2 training sign-ups"]],
  },
];

/** The local sample as project-store records (new copies each call). */
export function CATALOG_FOR_STORE(): Record<string, LocalProject> {
  const out: Record<string, LocalProject> = {};
  for (const s of SEEDS) {
    out[s.id] = {
      id: s.id,
      code: s.code,
      description: s.description,
      start: s.start,
      end: s.end,
      budgetHours: s.budget,
      managerId: RAM,
      managerName: "Ram Krishnan",
      teamHours: s.teamHours,
      teamApprovedHours: s.teamApproved,
      members: [
        { employeeId: RAM, name: "Ram Krishnan", jobTitle: "Engineering Manager", role: "lead", title: "Project manager", responsibilities: "Plans the work, runs reviews, approves time and owns the client relationship." },
        { employeeId: BABU, name: "Babu Menon", jobTitle: "Software Engineer", role: "member", title: s.myTitle, responsibilities: s.myDuties, budgetHours: s.myBudget },
        ...s.others.map(([name, title, duties]) => ({ employeeId: `name:${name}`, name, jobTitle: title, role: "member", title, responsibilities: duties })),
      ],
      milestones: s.milestones.map(([name, due, done, description], i) => ({ id: `pm-${s.id}-${i}`, name, description, due, completedOn: done ? due : null })),
      tasks: s.tasks.map(([code, title, due, status, estimate, assigneeId, description]) => ({
        id: `pt-${code.toLowerCase()}`,
        code,
        title,
        description,
        assigneeId,
        assigneeName: assigneeId === BABU ? "Babu Menon" : "Ram Krishnan",
        milestoneId: null,
        due,
        estimate,
        status,
      })),
      posts: s.update ? [{ id: `pp-${s.id}`, authorId: RAM, authorName: "Ram Krishnan", kind: "update", body: s.update, at: "2026-10-28T10:00:00.000Z" }] : [],
      documents: [],
      activity: s.activity.map(([on, who, text], i) => ({ id: `pa-${s.id}-${i}`, who, text, on })),
    };
  }
  return out;
}
