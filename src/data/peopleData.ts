import { DEMO_ACCOUNTS } from "../demoAccounts.ts";
import { TIMEZ_COUNTRIES, type CountryCode } from "../model.ts";
import { buildTimezWorkforce } from "../workforce.ts";
import { TZ_HEADCOUNT } from "./dashboardMock.ts";

export type EmploymentStatus = "Active" | "On Leave" | "Contractor" | "Terminated";

export interface PersonRecord {
  id: string;
  employeeCode: string;
  fullName: string;
  email: string;
  personalEmail: string;
  mobile: string;
  photo: string;
  gender: string;
  dateOfJoining: string;
  employmentType: string;
  employmentStatus: EmploymentStatus;
  designation: string;
  jobFamily: string;
  jobProfileId: string;
  positionId: string;
  grade: string;
  department: string;
  division: string;
  businessUnit: string;
  costCenter: string;
  location: string;
  countryCode: CountryCode | string;
  countryName: string;
  legalEntity: string;
  managerId: string;
  managerName: string;
  availability: string;
  timeZone: string;
  currency: string;
  address: string;
}

export interface OrgNode {
  id: string;
  type: "company" | "country" | "legalEntity" | "businessUnit" | "division" | "department" | "costCenter" | "location";
  name: string;
  code?: string;
  headcount?: number;
  children?: OrgNode[];
  managerName?: string;
}

export interface JobFamily {
  id: string;
  name: string;
  profiles: number;
}

export interface JobProfile {
  id: string;
  familyId: string;
  familyName: string;
  title: string;
  gradeBand: string;
  description: string;
}

export interface PositionRecord {
  id: string;
  code: string;
  title: string;
  jobProfileId: string;
  jobFamily: string;
  grade: string;
  country: string;
  location: string;
  department: string;
  legalEntity: string;
  managerName: string;
  status: "Open" | "Filled" | "Frozen";
  incumbentId?: string;
  incumbentName?: string;
  requirements: string[];
  openings: number;
}

export interface Person360Extras {
  skills: { name: string; level: string }[];
  certifications: { name: string; issuer: string; year: string }[];
  education: { school: string; degree: string; year: string }[];
  experience: { company: string; title: string; from: string; to: string }[];
  goals: { name: string; progress: number }[];
  learning: { name: string; status: string; completed?: string }[];
  attendanceSummary: { present: number; wfh: number; leave: number; absent: number };
  leaveBalances: { type: string; balance: number }[];
  timesheet: { period: string; status: string; hours: number };
  documents: { name: string; category: string; updated: string }[];
  lifecycle: { date: string; event: string; detail: string }[];
  compensation: { currency: string; base: string; variable: string; grade: string; effective: string };
  benefits: { plan: string; coverage: string; status: string }[];
}

export interface OrgChangeEvent {
  id: string;
  date: string;
  type: string;
  summary: string;
  actor: string;
}

const LEGAL_BY_COUNTRY: Record<string, string> = {
  IN: "Infotech India Pvt Ltd",
  US: "Infotech Inc",
  GB: "Infotech UK Ltd",
  AU: "Infotech Australia Pty",
  CA: "Infotech Canada Inc",
  AE: "Infotech Middle East FZ",
  SA: "Infotech Saudi LLC",
  DE: "Infotech Germany GmbH",
};

const LOCATIONS: Record<string, string[]> = {
  IN: ["Bengaluru", "Hyderabad", "Pune", "Chennai"],
  US: ["San Francisco", "New York", "Austin"],
  GB: ["London", "Manchester"],
  AU: ["Sydney", "Melbourne"],
  CA: ["Toronto", "Vancouver"],
  AE: ["Dubai"],
  SA: ["Riyadh"],
  DE: ["Berlin", "Munich"],
};

const JOB_FAMILY_LIST = [
  "Engineering",
  "Product",
  "People",
  "Finance",
  "Sales",
  "Operations",
  "Customer Success",
  "Design",
];

const GRADES = ["L3", "L4", "L5", "L6", "L7", "M1", "M2"];

function hash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i += 1) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function countryForColleague(workingCountry: string) {
  return TIMEZ_COUNTRIES.find((c) => c.name === workingCountry) ?? TIMEZ_COUNTRIES[0];
}

function buildBasePeople(): PersonRecord[] {
  const workforce = buildTimezWorkforce(TZ_HEADCOUNT.global);
  const managers = [
    { id: "emp-ram", name: "Ram Krishnan" },
    { id: "demo-hr-admin", name: "Farhan Ali" },
    { id: "demo-hiring-manager", name: "Daniel Ortiz" },
    { id: "demo-hrbp", name: "Meera Iyer" },
  ];

  const fromWorkforce: PersonRecord[] = workforce.map((row, index) => {
    const country = countryForColleague(row.workingCountry);
    const locs = LOCATIONS[country.code] ?? [country.name];
    const location = locs[index % locs.length];
    const family = JOB_FAMILY_LIST[index % JOB_FAMILY_LIST.length];
    const grade = GRADES[index % GRADES.length];
    const mgr = managers[index % managers.length];
    const statusRoll = index % 23;
    const employmentStatus: EmploymentStatus =
      statusRoll === 0 ? "On Leave" : statusRoll === 1 ? "Contractor" : statusRoll === 2 ? "Terminated" : "Active";
    const profileId = `JP-${family.slice(0, 3).toUpperCase()}-${(index % 8) + 1}`;
    const positionId = `POS-${String(1000 + (index % 120)).padStart(4, "0")}`;

    return {
      id: row.id,
      employeeCode: row.employeeCode,
      fullName: row.name,
      email: row.email,
      personalEmail: row.personalEmail,
      mobile: row.mobile,
      photo: row.photo,
      gender: row.gender,
      dateOfJoining: row.dateOfJoining,
      employmentType: employmentStatus === "Contractor" ? "Contract" : "Full Time",
      employmentStatus,
      designation: row.designation,
      jobFamily: family,
      jobProfileId: profileId,
      positionId,
      grade,
      department: row.department,
      division: `${row.department} Delivery`,
      businessUnit: row.businessUnit,
      costCenter: `CC-${country.code}-${(index % 9) + 1}`,
      location,
      countryCode: country.code,
      countryName: country.name,
      legalEntity: LEGAL_BY_COUNTRY[country.code] ?? "Infotech",
      managerId: mgr.id,
      managerName: mgr.name,
      availability: row.availability,
      timeZone: country.timeZone,
      currency: country.currency,
      address: `${location}, ${country.name}`,
    };
  });

  const demoPeople: PersonRecord[] = DEMO_ACCOUNTS.map((account, index) => {
    const country =
      TIMEZ_COUNTRIES.find((c) => c.code === account.countryCode) ?? TIMEZ_COUNTRIES[0];
    const family =
      account.department === "Engineering"
        ? "Engineering"
        : account.department === "People" || account.department === "Learning"
          ? "People"
          : account.department === "Finance"
            ? "Finance"
            : account.department === "Product"
              ? "Product"
              : account.department === "Executive"
                ? "Product"
                : "Operations";
    return {
      id: account.id,
      employeeCode: account.employeeCode,
      fullName: account.fullName,
      email: account.email,
      personalEmail: account.email.replace("@infotech.com", "@mail.example"),
      mobile: account.mobile,
      photo: account.photo,
      gender: index % 2 === 0 ? "Female" : "Male",
      dateOfJoining: "2019-04-15",
      employmentType: account.employmentType,
      employmentStatus: "Active" as const,
      designation: account.designation,
      jobFamily: family,
      jobProfileId: `JP-DEMO-${account.employeeCode}`,
      positionId: `POS-DEMO-${account.employeeCode}`,
      grade: account.role === "executive" || account.role === "founder" || account.role === "cofounder" ? "L7" : "L5",
      department: account.department ?? "Engineering",
      division: `${account.department ?? "Engineering"} Leadership`,
      businessUnit: `Infotech ${account.countryName ?? "India"}`,
      costCenter: `CC-${account.countryCode ?? "IN"}-1`,
      location: account.location ?? "Bengaluru",
      countryCode: account.countryCode ?? "IN",
      countryName: account.countryName ?? "India",
      legalEntity: account.legalEntity ?? LEGAL_BY_COUNTRY.IN,
      managerId: account.role === "employee" ? "emp-ram" : account.role === "manager" ? "demo-ceo" : "demo-ceo",
      managerName:
        account.role === "employee"
          ? "Ram Krishnan"
          : account.role === "manager"
            ? "Jordan Blake"
            : "Aanya Seth",
      availability: "In Office",
      timeZone: account.timeZone,
      currency: account.currency ?? country.currency,
      address: account.address,
    };
  });

  const byCode = new Map<string, PersonRecord>();
  for (const person of fromWorkforce) byCode.set(person.employeeCode, person);
  for (const person of demoPeople) byCode.set(person.employeeCode, person);
  return [...byCode.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
}

let cachedPeople: PersonRecord[] | null = null;

export function getBasePeople(): PersonRecord[] {
  if (!cachedPeople) cachedPeople = buildBasePeople();
  return cachedPeople.map((p) => ({ ...p }));
}

export function getPerson360Extras(person: PersonRecord): Person360Extras {
  const h = hash(person.id);
  const skillPool = [
    "React",
    "TypeScript",
    "People Ops",
    "Recruiting",
    "SQL",
    "Leadership",
    "Cloud",
    "QA Automation",
    "Negotiation",
    "Payroll",
  ];
  return {
    skills: [
      { name: skillPool[h % skillPool.length], level: "Advanced" },
      { name: skillPool[(h + 3) % skillPool.length], level: "Intermediate" },
      { name: skillPool[(h + 5) % skillPool.length], level: "Working" },
    ],
    certifications: [
      { name: "Professional Scrum Master", issuer: "Scrum.org", year: "2023" },
      { name: "ISO 27001 Awareness", issuer: "Infotech L&D", year: "2025" },
    ],
    education: [
      {
        school: h % 2 === 0 ? "National Institute of Technology" : "University of London",
        degree: "B.Tech / BSc Computer Science",
        year: "2014",
      },
    ],
    experience: [
      {
        company: "Infotech",
        title: person.designation,
        from: person.dateOfJoining.slice(0, 4),
        to: "Present",
      },
      {
        company: h % 2 === 0 ? "Nova Soft" : "Northwind Labs",
        title: "Associate",
        from: "2016",
        to: person.dateOfJoining.slice(0, 4),
      },
    ],
    goals: [
      { name: "Deliver Q4 roadmap outcomes", progress: 55 + (h % 40) },
      { name: "Complete leadership curriculum", progress: 30 + (h % 50) },
    ],
    learning: [
      { name: "Workplace safety", status: "Completed", completed: "2026-03-12" },
      { name: "Secure coding fundamentals", status: h % 3 === 0 ? "Completed" : "In progress" },
      { name: "Manager essentials", status: "Assigned" },
    ],
    attendanceSummary: {
      present: 18 + (h % 4),
      wfh: 2 + (h % 3),
      leave: h % 2,
      absent: 0,
    },
    leaveBalances: [
      { type: "Privilege leave", balance: 8 + (h % 6) },
      { type: "WFH", balance: 4 + (h % 4) },
      { type: "Sick leave", balance: 5 },
    ],
    timesheet: {
      period: "Week of 13 Oct 2026",
      status: h % 4 === 0 ? "Submitted" : "Draft",
      hours: 36 + (h % 6),
    },
    documents: [
      { name: "Offer letter", category: "Employment", updated: "2024-11-04" },
      { name: "NDA", category: "Compliance", updated: "2024-11-04" },
      { name: "ID proof", category: "Personal", updated: "2025-01-18" },
    ],
    lifecycle: [
      { date: person.dateOfJoining, event: "Joined", detail: `${person.designation} · ${person.location}` },
      { date: "2025-06-01", event: "Promotion", detail: `Moved to grade ${person.grade}` },
      { date: "2026-02-15", event: "Transfer", detail: `Cost center ${person.costCenter}` },
    ],
    compensation: {
      currency: person.currency,
      base: person.currency === "INR" ? "₹18,50,000" : person.currency === "GBP" ? "£72,000" : "$95,000",
      variable: person.currency === "INR" ? "₹2,00,000" : "$12,000",
      grade: person.grade,
      effective: "2026-04-01",
    },
    benefits: [
      { plan: "Medical", coverage: "Employee + Family", status: "Enrolled" },
      { plan: "Retirement", coverage: "Standard", status: "Enrolled" },
      { plan: "Wellness", coverage: "Optional", status: "Eligible" },
    ],
  };
}

export const JOB_FAMILIES: JobFamily[] = JOB_FAMILY_LIST.map((name, i) => ({
  id: `JF-${i + 1}`,
  name,
  profiles: 4 + (i % 3),
}));

export const JOB_PROFILES: JobProfile[] = JOB_FAMILIES.flatMap((family, fi) =>
  Array.from({ length: family.profiles }, (_, pi) => ({
    id: `JP-${family.name.slice(0, 3).toUpperCase()}-${pi + 1}`,
    familyId: family.id,
    familyName: family.name,
    title:
      pi === 0
        ? `Junior ${family.name} Specialist`
        : pi === 1
          ? `${family.name} Specialist`
          : pi === 2
            ? `Senior ${family.name} Specialist`
            : `${family.name} Manager`,
    gradeBand: pi < 2 ? "L3–L4" : pi === 2 ? "L5–L6" : "M1–M2",
    description: `Standard Infotech ${family.name.toLowerCase()} profile for global hiring and career paths.`,
  })).concat(
    fi === 0
      ? [
          {
            id: "JP-ENG-SR",
            familyId: family.id,
            familyName: family.name,
            title: "Senior React Engineer",
            gradeBand: "L5–L6",
            description: "Frontend engineering with React/TypeScript delivery focus.",
          },
        ]
      : [],
  ),
);

export const POSITIONS: PositionRecord[] = [
  {
    id: "pos-221",
    code: "POS-0221",
    title: "Senior React Engineer",
    jobProfileId: "JP-ENG-SR",
    jobFamily: "Engineering",
    grade: "L5",
    country: "India",
    location: "Bengaluru",
    department: "Engineering",
    legalEntity: LEGAL_BY_COUNTRY.IN,
    managerName: "Ram Krishnan",
    status: "Open",
    requirements: ["5+ years React", "TypeScript", "Design systems"],
    openings: 3,
  },
  {
    id: "pos-218",
    code: "POS-0218",
    title: "HR Business Partner",
    jobProfileId: "JP-PEO-3",
    jobFamily: "People",
    grade: "L5",
    country: "United Kingdom",
    location: "London",
    department: "People",
    legalEntity: LEGAL_BY_COUNTRY.GB,
    managerName: "Farhan Ali",
    status: "Open",
    requirements: ["HRBP experience", "Employee relations", "Workforce planning"],
    openings: 1,
  },
  {
    id: "pos-210",
    code: "POS-0210",
    title: "Talent Sourcer",
    jobProfileId: "JP-PEO-2",
    jobFamily: "People",
    grade: "L4",
    country: "United States",
    location: "New York",
    department: "People",
    legalEntity: LEGAL_BY_COUNTRY.US,
    managerName: "Sophie Clark",
    status: "Open",
    requirements: ["Boolean search", "ATS proficiency", "Stakeholder management"],
    openings: 2,
  },
  {
    id: "pos-205",
    code: "POS-0205",
    title: "Finance Analyst",
    jobProfileId: "JP-FIN-2",
    jobFamily: "Finance",
    grade: "L4",
    country: "Canada",
    location: "Toronto",
    department: "Finance",
    legalEntity: LEGAL_BY_COUNTRY.CA,
    managerName: "Victor Lang",
    status: "Frozen",
    requirements: ["FP&A", "Excel / BI", "Month-end close"],
    openings: 1,
  },
  {
    id: "pos-filled-1",
    code: "POS-1001",
    title: "Software Engineer",
    jobProfileId: "JP-ENG-2",
    jobFamily: "Engineering",
    grade: "L4",
    country: "India",
    location: "Bengaluru",
    department: "Engineering",
    legalEntity: LEGAL_BY_COUNTRY.IN,
    managerName: "Ram Krishnan",
    status: "Filled",
    incumbentId: "emp-mahesh",
    incumbentName: "Babu Menon",
    requirements: ["JavaScript", "React", "Agile delivery"],
    openings: 0,
  },
  {
    id: "pos-filled-2",
    code: "POS-1002",
    title: "Engineering Manager",
    jobProfileId: "JP-ENG-4",
    jobFamily: "Engineering",
    grade: "M1",
    country: "India",
    location: "Bengaluru",
    department: "Engineering",
    legalEntity: LEGAL_BY_COUNTRY.IN,
    managerName: "Jordan Blake",
    status: "Filled",
    incumbentId: "emp-ram",
    incumbentName: "Ram Krishnan",
    requirements: ["Team leadership", "Delivery ownership", "Coaching"],
    openings: 0,
  },
];

export function buildOrgTree(people: PersonRecord[]): OrgNode {
  const byCountry = TIMEZ_COUNTRIES.map((country) => {
    const inCountry = people.filter((p) => p.countryCode === country.code && p.employmentStatus !== "Terminated");
    const depts = [...new Set(inCountry.map((p) => p.department))];
    return {
      id: `country-${country.code}`,
      type: "country" as const,
      name: country.name,
      code: country.code,
      headcount: inCountry.length,
      children: [
        {
          id: `le-${country.code}`,
          type: "legalEntity" as const,
          name: LEGAL_BY_COUNTRY[country.code],
          headcount: inCountry.length,
          children: [
            {
              id: `bu-${country.code}`,
              type: "businessUnit" as const,
              name: `Infotech ${country.name}`,
              headcount: inCountry.length,
              children: depts.slice(0, 6).map((dept) => {
                const inDept = inCountry.filter((p) => p.department === dept);
                const locations = [...new Set(inDept.map((p) => p.location))];
                return {
                  id: `dept-${country.code}-${dept}`,
                  type: "department" as const,
                  name: dept,
                  headcount: inDept.length,
                  managerName: inDept[0]?.managerName,
                  children: [
                    {
                      id: `div-${country.code}-${dept}`,
                      type: "division" as const,
                      name: `${dept} Delivery`,
                      headcount: inDept.length,
                      children: [
                        {
                          id: `cc-${country.code}-${dept}`,
                          type: "costCenter" as const,
                          name: inDept[0]?.costCenter ?? `CC-${country.code}`,
                          headcount: inDept.length,
                          children: locations.map((loc) => ({
                            id: `loc-${country.code}-${dept}-${loc}`,
                            type: "location" as const,
                            name: loc,
                            headcount: inDept.filter((p) => p.location === loc).length,
                          })),
                        },
                      ],
                    },
                  ],
                };
              }),
            },
          ],
        },
      ],
    };
  });

  return {
    id: "company-timez",
    type: "company",
    name: "Infotech",
    headcount: people.filter((p) => p.employmentStatus !== "Terminated").length,
    children: byCountry,
  };
}

export const ORG_CHANGE_HISTORY: OrgChangeEvent[] = [
  {
    id: "oc-1",
    date: "2026-10-01",
    type: "Transfer",
    summary: "Ravi Menon moved Platform → Shared Services (IN)",
    actor: "Meera Iyer",
  },
  {
    id: "oc-2",
    date: "2026-09-18",
    type: "Reorg",
    summary: "Customer Success split under Americas BU",
    actor: "Farhan Ali",
  },
  {
    id: "oc-3",
    date: "2026-08-12",
    type: "New entity",
    summary: "Infotech Germany GmbH cost centers activated",
    actor: "Kai Nakamura",
  },
  {
    id: "oc-4",
    date: "2026-07-02",
    type: "Manager change",
    summary: "Engineering Bengaluru reporting line → Ram Krishnan",
    actor: "Farhan Ali",
  },
];

export const FILTER_OPTIONS = {
  countries: TIMEZ_COUNTRIES.map((c) => c.name),
  legalEntities: Object.values(LEGAL_BY_COUNTRY),
  departments: [...TZ_HEADCOUNT.byDepartment.map((d) => d.name)],
  employmentStatuses: ["Active", "On Leave", "Contractor", "Terminated"] as EmploymentStatus[],
  jobFamilies: JOB_FAMILY_LIST,
};
