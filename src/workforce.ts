import type { Colleague } from "./model.ts";
import { TIMEZ_COUNTRIES } from "./model.ts";
import { DEMO_ACCOUNTS, TIMEZ_PERSONAS } from "./demoAccounts.ts";

export { DEMO_ACCOUNTS, TIMEZ_PERSONAS } from "./demoAccounts.ts";

/** Year the company was founded — the earliest possible joining date. */
export const FOUNDING_YEAR = 2012;
/** Fixed "today" for the sample data, so the directory is the same on every load. */
const DATA_TODAY = "2026-10-27";

const FIRST = [
  "Aarav", "Diya", "Kabir", "Ananya", "Rohan", "Isha", "Vikram", "Meera", "Arjun", "Nisha",
  "James", "Emily", "Michael", "Olivia", "William", "Sophia", "Oliver", "Ava", "Noah", "Mia",
  "Hans", "Greta", "Omar", "Layla", "Chen", "Priya", "Sam", "Nina", "Leo", "Sara",
];
/** Gender for each first name above (same order). */
const FIRST_GENDER: Record<string, "Male" | "Female"> = {
  Aarav: "Male", Diya: "Female", Kabir: "Male", Ananya: "Female", Rohan: "Male", Isha: "Female",
  Vikram: "Male", Meera: "Female", Arjun: "Male", Nisha: "Female", James: "Male", Emily: "Female",
  Michael: "Male", Olivia: "Female", William: "Male", Sophia: "Female", Oliver: "Male", Ava: "Female",
  Noah: "Male", Mia: "Female", Hans: "Male", Greta: "Female", Omar: "Male", Layla: "Female",
  Chen: "Male", Priya: "Female", Sam: "Male", Nina: "Female", Leo: "Male", Sara: "Female",
};
const LAST = [
  "Sharma", "Patel", "Reddy", "Nair", "Khan", "Singh", "Iyer", "Das", "Smith", "Johnson",
  "Brown", "Taylor", "Wilson", "Anderson", "Thomas", "Lee", "Martin", "Garcia", "Mueller", "Schmidt",
];

export const DEPARTMENTS = ["Engineering", "Product", "People", "Finance", "Sales", "Operations", "Customer Success", "Legal"] as const;
/** Share of each country's staff per department (percent). */
const DEPARTMENT_WEIGHT: Record<string, number> = {
  Engineering: 30, Product: 10, People: 7, Finance: 8, Sales: 15, Operations: 12, "Customer Success": 12, Legal: 6,
};

/** Short codes used in position IDs, e.g. TIMEZ-ENG-IN-00125. */
export const DEPARTMENT_CODE: Record<string, string> = {
  Engineering: "ENG", Product: "PRD", People: "PPL", Finance: "FIN", Sales: "SAL", Operations: "OPS",
  "Customer Success": "CSM", Legal: "LGL", Executive: "EXE", IT: "ITS", "Talent Acquisition": "TAQ", "Total Rewards": "TRW",
};

/** Job family for each department. */
export const FAMILY_BY_DEPARTMENT: Record<string, string> = {
  Engineering: "Engineering", Product: "Product", People: "People", Finance: "Finance", Sales: "Sales",
  Operations: "Operations", "Customer Success": "Customer Success", Legal: "Legal", Executive: "Executive",
  IT: "Information Technology", "Talent Acquisition": "People", "Total Rewards": "People",
};

/** Division (blueprint §11: Business unit → Division → Department) for each department. */
export const DIVISION_BY_DEPARTMENT: Record<string, string> = {
  Engineering: "Technology", Product: "Technology", IT: "Technology",
  Sales: "Commercial", "Customer Success": "Commercial",
  People: "Corporate Services", Finance: "Corporate Services", Operations: "Corporate Services", Legal: "Corporate Services",
  "Talent Acquisition": "Corporate Services", "Total Rewards": "Corporate Services",
  Executive: "Executive Office",
};
export const DIVISION_ORDER = ["Executive Office", "Technology", "Commercial", "Corporate Services"];

/** Staff job titles per department with their grade (grade follows the title's level). */
const STAFF_TITLES: Record<string, { title: string; grade: string }[]> = {
  Engineering: [
    { title: "Software Engineer", grade: "L4" }, { title: "Senior Engineer", grade: "L5" },
    { title: "QA Analyst", grade: "L4" }, { title: "Data Analyst", grade: "L4" }, { title: "Associate Engineer", grade: "L3" },
  ],
  Product: [
    { title: "Product Manager", grade: "L4" }, { title: "Designer", grade: "L4" },
    { title: "Product Analyst", grade: "L3" }, { title: "Senior Product Manager", grade: "L5" },
  ],
  People: [
    { title: "HR Generalist", grade: "L4" }, { title: "Talent Acquisition Specialist", grade: "L4" },
    { title: "HR Business Partner", grade: "L5" }, { title: "HR Coordinator", grade: "L3" },
  ],
  Finance: [
    { title: "Finance Analyst", grade: "L4" }, { title: "Accountant", grade: "L4" },
    { title: "Payroll Specialist", grade: "L4" }, { title: "Senior Accountant", grade: "L5" },
  ],
  Sales: [
    { title: "Account Executive", grade: "L4" }, { title: "Sales Development Representative", grade: "L3" },
    { title: "Senior Account Executive", grade: "L5" },
  ],
  Operations: [
    { title: "Operations Analyst", grade: "L4" }, { title: "Facilities Coordinator", grade: "L3" },
    { title: "Senior Operations Analyst", grade: "L5" },
  ],
  "Customer Success": [
    { title: "Customer Success Manager", grade: "L4" }, { title: "Support Engineer", grade: "L4" },
    { title: "Implementation Consultant", grade: "L5" },
  ],
  Legal: [
    { title: "Legal Counsel", grade: "L5" }, { title: "Compliance Analyst", grade: "L4" },
    { title: "Contracts Manager", grade: "L5" }, { title: "Paralegal", grade: "L3" },
  ],
};

export const COUNTRY_HEAD_TITLE = "Country Manager";
export const headTitle = (dept: string) => `Head of ${dept}`;
export const leadTitle = (dept: string) => `${dept} Team Lead`;

/** Every job title used in the company with its family and grade — the job profile catalog. */
export const JOB_CATALOG: { family: string; title: string; grade: string }[] = [
  { family: "Executive", title: "Chief Executive Officer", grade: "E1" },
  { family: "Executive", title: COUNTRY_HEAD_TITLE, grade: "M3" },
  ...DEPARTMENTS.flatMap((dept) => [
    ...STAFF_TITLES[dept].map((t) => ({ family: FAMILY_BY_DEPARTMENT[dept], ...t })),
    { family: FAMILY_BY_DEPARTMENT[dept], title: leadTitle(dept), grade: "L6" },
    { family: FAMILY_BY_DEPARTMENT[dept], title: headTitle(dept), grade: "M2" },
  ]),
  { family: "Engineering", title: "Engineering Manager", grade: "M1" },
  { family: "Product", title: "Director of Product", grade: "M2" },
  { family: "People", title: "HR Director", grade: "M2" },
  { family: "People", title: "Talent Acquisition Lead", grade: "L6" },
  { family: "People", title: "Compensation & Benefits Manager", grade: "M1" },
  { family: "Information Technology", title: "Platform Administrator", grade: "L5" },
];

/** Grade for a job title: catalog first, then by the level words in the title. */
export function gradeForTitle(title: string): string {
  const known = JOB_CATALOG.find((j) => j.title.toLowerCase() === title.trim().toLowerCase());
  if (known) return known.grade;
  const t = title.toLowerCase();
  if (/chief|ceo|cfo|cto|coo/.test(t)) return "E1";
  if (/country manager|vice president|\bvp\b/.test(t)) return "M3";
  if (/head of|director/.test(t)) return "M2";
  if (/manager/.test(t)) return "M1";
  if (/lead|principal|staff/.test(t)) return "L6";
  if (/senior|counsel|consultant/.test(t)) return "L5";
  if (/associate|junior|coordinator|representative|intern|paralegal/.test(t)) return "L3";
  return "L4";
}

/** Engineering teammates on Ram's team who are not sign-in personas (ids used across leave, tasks, shifts). */
export const TEAMMATES: {
  id: string; employeeCode: string; name: string; title: string; gender: "Male" | "Female"; dateOfJoining: string; mobile: string;
}[] = [
  { id: "emp-priya", employeeCode: "EMP1203", name: "Priya Nair", title: "Senior Engineer", gender: "Female", dateOfJoining: "2020-07-06", mobile: "+91 98450 31203" },
  { id: "emp-anu", employeeCode: "EMP1204", name: "Anu Rao", title: "Software Engineer", gender: "Female", dateOfJoining: "2021-02-15", mobile: "+91 98450 31204" },
  { id: "emp-kabir", employeeCode: "EMP1201", name: "Kabir Sharma", title: "Senior Engineer", gender: "Male", dateOfJoining: "2018-11-12", mobile: "+91 98450 31201" },
  { id: "emp-diya", employeeCode: "EMP1202", name: "Diya Patel", title: "QA Analyst", gender: "Female", dateOfJoining: "2022-05-09", mobile: "+91 98450 31202" },
];
export const TEAMMATE_MANAGER_ID = "emp-ram";

/** Personas that lead a country's department themselves (their teams report to them, not a generated head). */
const PERSONA_HEADS: Record<string, string> = {
  "IN:Engineering": "emp-ram",
  "IN:People": "demo-hr-admin",
};
const CEO_ID = "demo-ceo";

/**
 * Seats once held by retired sign-in accounts: the US Compensation & Benefits persona (now an HR Generalist) and the
 * US Hiring Manager, who led US Product (now a generated Head of Product under the US country head). They still
 * count toward the country's headcount and are filled by a generated person in the normal hierarchy. They are built
 * after every country so all other generated ids, names and positions stay exactly where they were. A seat with
 * `head` was a department head: the loop keeps the department shaped as before (no generated head, the team under a
 * placeholder), and the placeholder is replaced by the seat's id once it exists.
 */
const RETIRED_SEATS: {
  country: string; dept: (typeof DEPARTMENTS)[number]; title: string; grade: string; dateOfJoining: string; head?: boolean;
}[] = [
  { country: "US", dept: "People", title: "HR Generalist", grade: "L4", dateOfJoining: "2016-09-19" },
  { country: "US", dept: "Product", title: headTitle("Product"), grade: "M2", dateOfJoining: "2017-08-07", head: true },
];
const retiredHeadPlaceholder = (country: string, dept: string) => `retired-head:${country}:${dept}`;
/** Department-head seats for the generation loop: persona heads, plus retired head seats (filled after the loop). */
const LOOP_HEADS: Record<string, string> = {
  ...PERSONA_HEADS,
  ...Object.fromEntries(RETIRED_SEATS.filter((r) => r.head).map((r) => [`${r.country}:${r.dept}`, retiredHeadPlaceholder(r.country, r.dept)])),
};
/** Names of retired sign-in accounts, never reused for generated people (keeps every generated name where it was). */
const RETIRED_NAMES = ["Daniel Ortiz"];

export const LOCATIONS: Record<string, string[]> = {
  IN: ["Bengaluru", "Hyderabad", "Pune", "Chennai"],
  US: ["New York", "San Francisco", "Austin"],
  GB: ["London", "Manchester"],
  AU: ["Sydney", "Melbourne"],
  CA: ["Toronto", "Vancouver"],
  AE: ["Dubai"],
  SA: ["Riyadh"],
  DE: ["Berlin", "Munich"],
};

const AVAIL: Colleague["availability"][] = ["In Office", "Work From Home", "In Office", "Remote"];

/** A generated employee: a directory colleague plus their place in the reporting line. */
export interface WorkforceRow extends Colleague {
  managerId: string;
  countryCode: string;
  location: string;
  grade: string;
  positionId: string;
  status: "Active" | "On Leave" | "Contractor";
}

const pad = (n: number, width: number) => String(n).padStart(width, "0");

/** Small deterministic pseudo-random number in [0, 1) from an integer seed. */
function rand(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function digits(seed: number, count: number): string {
  let out = "";
  for (let i = 0; i < count; i += 1) out += String(Math.floor(rand(seed * 31 + i) * 10));
  return out;
}

/** A phone number in the country's own format. */
export function phoneFor(countryCode: string, location: string, seed: number): string {
  const d = digits(seed, 8);
  switch (countryCode) {
    case "IN":
      return `+91 9${d.slice(0, 4)} ${d.slice(4, 8)}${digits(seed + 7, 1)}`;
    case "US": {
      const area = location === "San Francisco" ? "415" : location === "Austin" ? "512" : "212";
      return `+1 ${area} 555 0${d.slice(0, 3)}`;
    }
    case "CA":
      return `+1 ${location === "Vancouver" ? "604" : "416"} 555 0${d.slice(0, 3)}`;
    case "GB":
      return location === "Manchester" ? `+44 161 496 0${d.slice(0, 3)}` : `+44 20 7946 0${d.slice(0, 3)}`;
    case "AU":
      return `+61 4${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5, 8)}`;
    case "AE":
      return `+971 50 ${d.slice(0, 3)} ${d.slice(3, 7)}`;
    case "SA":
      return `+966 5${d.slice(0, 1)} ${d.slice(1, 4)} ${d.slice(4, 8)}`;
    case "DE":
      return `+49 151 ${d.slice(0, 4)} ${d.slice(4, 8)}`;
    default:
      return `+${d}`;
  }
}

function isoFromDays(days: number): string {
  const d = new Date(Date.UTC(1970, 0, 1) + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}
function daysFromIso(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}
function addMonths(iso: string, months: number, plusDays = 0): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1 + months, Math.min(d, 28)));
  return isoFromDays(Math.round(date.getTime() / 86_400_000) + plusDays);
}

const FIRST_DAY = daysFromIso(`${FOUNDING_YEAR}-04-02`);
const TODAY_DAY = daysFromIso(DATA_TODAY);

/** Joining date between two day numbers, never in the future. */
function joinBetween(seed: number, from: number, to: number): string {
  const day = Math.min(TODAY_DAY - 1, from + Math.floor(rand(seed) * Math.max(1, to - from)));
  return isoFromDays(day);
}

/** Split `total` across departments by weight; every department gets at least `min`. */
function allocate(total: number, min: (dept: string) => number): Record<string, number> {
  const out: Record<string, number> = {};
  let left = total;
  for (const dept of DEPARTMENTS) {
    out[dept] = min(dept);
    left -= out[dept];
  }
  const weightSum = DEPARTMENTS.reduce((s, d) => s + DEPARTMENT_WEIGHT[d], 0);
  const raw = DEPARTMENTS.map((d) => ({ d, share: (left * DEPARTMENT_WEIGHT[d]) / weightSum }));
  let given = 0;
  for (const r of raw) {
    const whole = Math.floor(r.share);
    out[r.d] += whole;
    given += whole;
  }
  raw.sort((a, b) => (b.share % 1) - (a.share % 1));
  for (let i = 0; i < left - given; i += 1) out[raw[i % raw.length].d] += 1;
  return out;
}

/**
 * Build the TimeZ workforce across 8 countries. Personas and Ram's named teammates count towards
 * each country's headcount, so the whole company (generated + named) adds up to the blueprint.
 *
 * Reporting line in every country: country head (reports to the CEO) → department head → team leads
 * (about 8 reports each) → staff, all in the same country and department. Where a persona leads a
 * department (Ram for India Engineering, Farhan for India People) that team reports to them.
 */
export function buildTimezWorkforce(_total = 500): WorkforceRow[] {
  void _total;
  const rows: WorkforceRow[] = [];
  const named = [
    ...DEMO_ACCOUNTS.map((a) => ({ name: a.fullName, country: a.countryCode ?? "IN" })),
    ...TEAMMATES.map((t) => ({ name: t.name, country: "IN" })),
  ];
  const usedNames = new Set([...named.map((n) => n.name), ...RETIRED_NAMES]);
  let nameIndex = 0;
  const nextName = (): { first: string; last: string } => {
    for (;;) {
      const k = nameIndex;
      nameIndex += 1;
      const first = FIRST[k % FIRST.length];
      const generatedLast = LAST[(k + Math.floor(k / FIRST.length)) % LAST.length];
      // "Isha Reddy" is retired from the sample data; that one combination uses Kapoor instead.
      const last = first === "Isha" && generatedLast === "Reddy" ? "Kapoor" : generatedLast;
      const full = `${first} ${last}`;
      if (usedNames.has(full)) continue;
      usedNames.add(full);
      return { first, last };
    }
  };

  let seq = 1;
  type Country = (typeof TIMEZ_COUNTRIES)[number];
  const makeFor = (country: Country, input: {
      title: string; grade: string; dept: string; managerId: string; location: string;
      dateOfJoining: string; status?: WorkforceRow["status"];
    }): WorkforceRow => {
      const { first, last } = nextName();
      const code = `TZ${pad(seq, 4)}`;
      const status = input.status ?? "Active";
      const row: WorkforceRow = {
        id: `wf-${code}`,
        name: `${first} ${last}`,
        employeeCode: code,
        designation: input.title,
        department: input.dept,
        email: `${first.toLowerCase()}.${last.toLowerCase()}.${code.toLowerCase()}@timez.com`,
        personalEmail: `${first.toLowerCase()}.${last.toLowerCase()}@example.com`,
        mobile: phoneFor(country.code, input.location, seq),
        managerName: "",
        availability: status === "On Leave" ? "On Leave" : AVAIL[seq % AVAIL.length],
        companyCode: "TimeZ",
        businessUnit: `TimeZ ${country.name}`,
        practice: input.dept,
        subPractice: input.title,
        gender: FIRST_GENDER[first] ?? "Female",
        dateOfJoining: input.dateOfJoining,
        workingCountry: country.name,
        photo: "/profile.svg",
        managerId: input.managerId,
        countryCode: country.code,
        location: input.location,
        grade: input.grade,
        positionId: `TIMEZ-${DEPARTMENT_CODE[input.dept] ?? "GEN"}-${country.code}-${pad(seq, 5)}`,
        status,
      };
      seq += 1;
      rows.push(row);
      return row;
    };

  for (const country of TIMEZ_COUNTRIES) {
    const locs = LOCATIONS[country.code] ?? [country.name];
    // Retired seats are filled after the loop but still counted here, so the country total stays exact.
    const namedHere =
      named.filter((n) => n.country === country.code).length + RETIRED_SEATS.filter((r) => r.country === country.code).length;
    const generated = country.headcount - namedHere;
    const make = (input: Parameters<typeof makeFor>[1]) => makeFor(country, input);

    // Country head.
    const head = make({
      title: COUNTRY_HEAD_TITLE,
      grade: "M3",
      dept: "Executive",
      managerId: CEO_ID,
      location: locs[0],
      dateOfJoining: joinBetween(seq * 7, FIRST_DAY + 30, daysFromIso("2016-12-31")),
    });

    const perDept = allocate(generated - 1, (dept) => (LOOP_HEADS[`${country.code}:${dept}`] ? 1 : 2));
    for (const dept of DEPARTMENTS) {
      const count = perDept[dept];
      const personaHead = LOOP_HEADS[`${country.code}:${dept}`];
      let deptHeadId = personaHead;
      let remaining = count;
      if (!deptHeadId) {
        const deptHead = make({
          title: headTitle(dept),
          grade: "M2",
          dept,
          managerId: head.id,
          location: locs[0],
          dateOfJoining: joinBetween(seq * 7, FIRST_DAY + 60, daysFromIso("2020-12-31")),
        });
        deptHeadId = deptHead.id;
        remaining -= 1;
      }
      if (remaining <= 0) continue;
      const leadCount = remaining > 8 ? Math.ceil(remaining / 9) : 0;
      const leadIds: string[] = [];
      for (let i = 0; i < leadCount; i += 1) {
        const lead = make({
          title: leadTitle(dept),
          grade: "L6",
          dept,
          managerId: deptHeadId,
          location: locs[i % locs.length],
          dateOfJoining: joinBetween(seq * 7, FIRST_DAY + 120, daysFromIso("2023-06-30")),
        });
        leadIds.push(lead.id);
      }
      const staffCount = remaining - leadCount;
      const titles = STAFF_TITLES[dept];
      for (let i = 0; i < staffCount; i += 1) {
        const managerIndex = leadIds.length ? i % leadIds.length : -1;
        const managerId = managerIndex >= 0 ? leadIds[managerIndex] : deptHeadId;
        const t = titles[(seq + i) % titles.length];
        // About one in ten people joined in the last 12 months.
        const recent = seq % 9 === 4;
        let dateOfJoining = recent
          ? isoFromDays(TODAY_DAY - 1 - Math.floor(rand(seq * 17) * 364))
          : joinBetween(seq * 7, FIRST_DAY + 150, TODAY_DAY - 366);
        // Three India engineers whose probation is due soon, overdue and pending (6-month probation).
        if (country.code === "IN" && dept === "Engineering" && i < 3) {
          dateOfJoining = addMonths(DATA_TODAY, -6, [18, -9, 35][i]);
        }
        const roll = seq % 23;
        const status: WorkforceRow["status"] =
          i >= 3 && roll === 0 ? "On Leave" : i >= 3 && roll === 1 ? "Contractor" : "Active";
        make({
          title: t.title,
          grade: t.grade,
          dept,
          managerId,
          location: locs[(seq + i) % locs.length],
          dateOfJoining,
          status,
        });
      }
    }
  }

  // Fill retired seats under that country's department (a team lead with the fewest reports, else the department head).
  // A retired department head reports to the country head and takes over the team that waited under the placeholder.
  for (const seat of RETIRED_SEATS) {
    const country = TIMEZ_COUNTRIES.find((c) => c.code === seat.country);
    if (!country) continue;
    const locs = LOCATIONS[seat.country] ?? [country.name];
    if (seat.head) {
      const countryHeadId = rows.find((r) => r.countryCode === seat.country && r.designation === COUNTRY_HEAD_TITLE)?.id ?? CEO_ID;
      const head = makeFor(country, { title: seat.title, grade: seat.grade, dept: seat.dept, managerId: countryHeadId, location: locs[0], dateOfJoining: seat.dateOfJoining });
      const placeholder = retiredHeadPlaceholder(seat.country, seat.dept);
      for (const row of rows) if (row.managerId === placeholder) row.managerId = head.id;
      continue;
    }
    const inDept = rows.filter((r) => r.countryCode === seat.country && r.department === seat.dept);
    const deptHeadId = PERSONA_HEADS[`${seat.country}:${seat.dept}`] ?? inDept.find((r) => r.designation === headTitle(seat.dept))?.id;
    const reportsTo = (id: string) => rows.filter((r) => r.managerId === id).length;
    const leads = inDept.filter((r) => r.designation === leadTitle(seat.dept)).sort((a, b) => reportsTo(a.id) - reportsTo(b.id));
    const managerId =
      leads[0]?.id ?? deptHeadId ?? rows.find((r) => r.countryCode === seat.country && r.designation === COUNTRY_HEAD_TITLE)?.id ?? CEO_ID;
    makeFor(country, { title: seat.title, grade: seat.grade, dept: seat.dept, managerId, location: locs[0], dateOfJoining: seat.dateOfJoining });
  }

  // Fill in manager names now that everyone exists.
  const nameById = new Map<string, string>([
    ...DEMO_ACCOUNTS.map((a) => [a.id, a.fullName] as [string, string]),
    ...rows.map((r) => [r.id, r.name] as [string, string]),
  ]);
  for (const row of rows) row.managerName = nameById.get(row.managerId) ?? "";
  return rows;
}

export function countryRollup() {
  return TIMEZ_COUNTRIES.map((country) => ({
    code: country.code,
    name: country.name,
    currency: country.currency,
    timeZone: country.timeZone,
    headcount: country.headcount,
  }));
}

void TIMEZ_PERSONAS;
