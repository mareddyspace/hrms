/**
 * Personal and background details for every person in the directory (blueprint §8–9):
 * name parts, date of birth, nationality, work arrangement, education, experience and dependents.
 * Named personas are hand-written; everyone else is generated deterministically from their id,
 * so the same person always gets the same details and the details agree with their record
 * (adult at joining, degree after age 20, previous jobs end before joining Infotech).
 */

export type WorkArrangement = "Office" | "Hybrid" | "Remote";
export const WORK_ARRANGEMENTS: WorkArrangement[] = ["Office", "Hybrid", "Remote"];

export interface EducationRecord {
  degree: string;
  institution: string;
  year: number;
}

export interface ExperienceRecord {
  employer: string;
  title: string;
  from: string;
  to: string;
}

export interface DependentRecord {
  name: string;
  relation: "Spouse" | "Child" | "Parent";
  dateOfBirth: string;
}

export interface PersonProfileDetails {
  firstName: string;
  middleName?: string;
  lastName: string;
  preferredName: string;
  dateOfBirth: string;
  nationality: string;
  workArrangement: WorkArrangement;
  education: EducationRecord[];
  experience: ExperienceRecord[];
  dependents: DependentRecord[];
}

/** What the generator needs to know about a person. */
export interface ProfileSeedInput {
  id: string;
  fullName: string;
  gender: string;
  dateOfJoining: string;
  grade: string;
  department: string;
  countryCode: string;
  availability?: string;
}

/** Fixed reference date for generated data, so ages never drift between loads. */
const SEED_YEAR = 2026;

export const NATIONALITY_BY_COUNTRY: Record<string, string> = {
  IN: "Indian",
  US: "American",
  GB: "British",
  AU: "Australian",
  CA: "Canadian",
  AE: "Emirati",
  SA: "Saudi",
  DE: "German",
};

/** Nationalities offered in forms: the eight operating countries plus common expat ones. */
export const NATIONALITIES = [
  ...Object.values(NATIONALITY_BY_COUNTRY),
  "Egyptian",
  "Filipino",
  "Irish",
  "Pakistani",
  "Other",
];

/** Share of each country's staff who are expats. The Gulf offices are mostly expat. */
const EXPAT_SHARE: Record<string, number> = { AE: 0.6, SA: 0.4, DE: 0.18, GB: 0.15, AU: 0.15, CA: 0.15, US: 0.1, IN: 0.04 };
const EXPAT_POOL = ["Indian", "British", "American", "Filipino", "Egyptian", "Pakistani", "Irish", "German", "Canadian"];

const INSTITUTIONS: Record<string, string[]> = {
  Indian: ["Anna University", "VIT Vellore", "University of Mumbai", "Bangalore University", "NIT Trichy", "Manipal University", "University of Delhi"],
  American: ["University of Texas at Austin", "Arizona State University", "Penn State University", "University of Michigan", "Ohio State University"],
  British: ["University of Manchester", "University of Leeds", "King's College London", "University of Bristol"],
  Australian: ["University of Sydney", "Monash University", "UNSW Sydney"],
  Canadian: ["University of Toronto", "University of Waterloo", "University of British Columbia"],
  Emirati: ["Khalifa University", "American University of Sharjah", "UAE University"],
  Saudi: ["King Saud University", "King Fahd University of Petroleum and Minerals", "King Abdulaziz University"],
  German: ["Technical University of Munich", "RWTH Aachen University", "Humboldt University of Berlin"],
  Egyptian: ["Cairo University", "Ain Shams University"],
  Filipino: ["University of the Philippines", "Ateneo de Manila University"],
  Pakistani: ["University of Karachi", "LUMS Lahore"],
  Irish: ["Trinity College Dublin", "University College Dublin"],
};

const DEGREES: Record<string, { ug: string[]; pg: string[] }> = {
  Engineering: { ug: ["BSc Computer Science", "BEng Electronics", "BSc Software Engineering"], pg: ["MSc Computer Science", "MSc Software Systems"] },
  Product: { ug: ["BEng Computer Science", "BA Economics"], pg: ["MBA"] },
  People: { ug: ["BA Psychology", "BBA"], pg: ["MBA, Human Resources", "MA Industrial Relations"] },
  Finance: { ug: ["BCom", "BSc Economics"], pg: ["MBA, Finance", "MSc Accounting"] },
  Sales: { ug: ["BBA", "BA Communication"], pg: ["MBA, Marketing"] },
  Operations: { ug: ["BSc Logistics", "BBA"], pg: ["MBA, Operations"] },
  "Customer Success": { ug: ["BA English", "BBA"], pg: ["MBA"] },
  Legal: { ug: ["LLB"], pg: ["LLM"] },
  Executive: { ug: ["BSc Economics", "BEng Mechanical"], pg: ["MBA"] },
  IT: { ug: ["BSc Information Technology"], pg: ["MSc Information Systems"] },
};
DEGREES["Talent Acquisition"] = DEGREES.People;
DEGREES["Total Rewards"] = DEGREES.Finance;

const EMPLOYERS = [
  "Northwind Systems", "Bluefin Analytics", "Contoso Services", "Fabrikam Labs", "Globex Solutions", "Lakeside Software",
  "Brightpath Consulting", "Orbit Retail", "Pinecrest Logistics", "Summit Financial", "Harbor Health", "Crestline Media",
];

const PRIOR_ROLE: Record<string, string[]> = {
  Engineering: ["Associate Software Engineer", "Software Engineer", "Senior Software Engineer"],
  Product: ["Business Analyst", "Associate Product Manager", "Product Manager"],
  People: ["HR Associate", "HR Generalist", "HR Manager"],
  Finance: ["Accounts Associate", "Financial Analyst", "Senior Financial Analyst"],
  Sales: ["Sales Associate", "Account Executive", "Senior Account Executive"],
  Operations: ["Operations Associate", "Operations Analyst", "Operations Manager"],
  "Customer Success": ["Support Associate", "Customer Support Specialist", "Account Manager"],
  Legal: ["Legal Associate", "Associate Counsel", "Counsel"],
  Executive: ["Business Analyst", "Manager", "Director"],
  IT: ["IT Support Analyst", "Systems Administrator", "IT Lead"],
  "Talent Acquisition": ["Recruiting Coordinator", "Recruiter", "Senior Recruiter"],
  "Total Rewards": ["Compensation Analyst", "Senior Compensation Analyst", "Rewards Manager"],
};

const GRADE_AGE: Record<string, number> = { L3: 25, L4: 29, L5: 33, L6: 37, M1: 39, M2: 43, M3: 47, E1: 52 };
const FEMALE_NAMES = ["Anita", "Sarah", "Maria", "Lena", "Aisha", "Emma", "Kavya", "Nora", "Fatima", "Grace"];
const MALE_NAMES = ["Rahul", "David", "Ahmed", "Lukas", "Tom", "Vikram", "Ben", "Omar", "Daniel", "Arun"];
const CHILD_NAMES = ["Aryan", "Zoe", "Kian", "Mira", "Leo", "Ira", "Noah", "Ella", "Sami", "Tara"];

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic number in [0, 1) for this person and a slot. */
function roll(id: string, slot: number): number {
  const x = Math.sin((hash(id) % 100000) * 12.9898 + slot * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function pick<T>(list: T[], id: string, slot: number): T {
  return list[Math.floor(roll(id, slot) * list.length) % list.length];
}

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** Month index (year * 12 + month - 1) of an ISO date. */
function monthIndex(date: string): number {
  const [y, m] = date.split("-").map(Number);
  return y * 12 + (m - 1);
}
function fromMonthIndex(index: number, day: number): string {
  return iso(Math.floor(index / 12), (index % 12) + 1, day);
}

export function splitName(fullName: string): Pick<PersonProfileDetails, "firstName" | "middleName" | "lastName"> {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { firstName: parts[0] ?? "", lastName: "" };
  return {
    firstName: parts[0],
    middleName: parts.length > 2 ? parts.slice(1, -1).join(" ") : undefined,
    lastName: parts[parts.length - 1],
  };
}

export function joinName(first: string, middle: string | undefined, last: string): string {
  return [first, middle, last].map((s) => (s ?? "").trim()).filter(Boolean).join(" ");
}

/** Whole years between two ISO dates. */
export function ageOn(dateOfBirth: string, on: string): number {
  const [by, bm, bd] = dateOfBirth.split("-").map(Number);
  const [y, m, d] = on.split("-").map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

/* ───────────── Personas (hand-written) ───────────── */

const PERSONA_DETAILS: Record<string, Omit<PersonProfileDetails, "firstName" | "lastName"> & { firstName?: string; lastName?: string }> = {
  "emp-mahesh": {
    preferredName: "Babu",
    dateOfBirth: "1994-08-21",
    nationality: "Indian",
    workArrangement: "Hybrid",
    education: [{ degree: "BTech Computer Science", institution: "College of Engineering Trivandrum", year: 2016 }],
    experience: [{ employer: "Northwind Systems", title: "Associate Software Engineer", from: "2016-07-04", to: "2019-04-26" }],
    dependents: [
      { name: "Ananya Menon", relation: "Spouse", dateOfBirth: "1995-03-11" },
      { name: "Arjun Menon", relation: "Child", dateOfBirth: "2025-05-30" },
    ],
  },
  "emp-ram": {
    preferredName: "Ram",
    dateOfBirth: "1985-02-09",
    nationality: "Indian",
    workArrangement: "Office",
    education: [
      { degree: "BE Computer Science", institution: "Anna University", year: 2006 },
      { degree: "MTech Software Systems", institution: "BITS Pilani", year: 2010 },
    ],
    experience: [
      { employer: "Bluefin Analytics", title: "Software Engineer", from: "2006-07-03", to: "2010-12-31" },
      { employer: "Globex Solutions", title: "Senior Software Engineer", from: "2011-01-10", to: "2014-05-30" },
    ],
    dependents: [
      { name: "Lakshmi Ram", relation: "Spouse", dateOfBirth: "1987-07-02" },
      { name: "Nila Ram", relation: "Child", dateOfBirth: "2016-04-11" },
    ],
  },
  "demo-hr-admin": {
    middleName: "Ahmed",
    preferredName: "Farhan",
    dateOfBirth: "1982-11-30",
    nationality: "Indian",
    workArrangement: "Office",
    education: [
      { degree: "BA Psychology", institution: "University of Delhi", year: 2003 },
      { degree: "MBA, Human Resources", institution: "XLRI Jamshedpur", year: 2006 },
    ],
    experience: [
      { employer: "Brightpath Consulting", title: "HR Executive", from: "2006-06-01", to: "2010-08-31" },
      { employer: "Harbor Health", title: "HR Manager", from: "2010-09-15", to: "2014-12-31" },
    ],
    dependents: [
      { name: "Sana Ali", relation: "Spouse", dateOfBirth: "1985-04-18" },
      { name: "Zara Ali", relation: "Child", dateOfBirth: "2013-09-05" },
    ],
  },
  "demo-recruiter": {
    preferredName: "Sophie",
    dateOfBirth: "1990-06-14",
    nationality: "American",
    workArrangement: "Hybrid",
    education: [{ degree: "BA Communication", institution: "University of Texas at Austin", year: 2012 }],
    experience: [
      { employer: "Crestline Media", title: "Recruiting Coordinator", from: "2012-08-01", to: "2015-03-31" },
      { employer: "Summit Financial", title: "Recruiter", from: "2015-04-13", to: "2018-01-19" },
    ],
    dependents: [],
  },
  "demo-hiring-manager": {
    preferredName: "Dan",
    dateOfBirth: "1983-09-03",
    nationality: "American",
    workArrangement: "Hybrid",
    education: [
      { degree: "BS Computer Science", institution: "UC San Diego", year: 2005 },
      { degree: "MBA", institution: "UCLA Anderson", year: 2011 },
    ],
    experience: [
      { employer: "Lakeside Software", title: "Software Engineer", from: "2005-07-05", to: "2009-08-31" },
      { employer: "Orbit Retail", title: "Product Manager", from: "2011-07-11", to: "2017-07-28" },
    ],
    dependents: [{ name: "Sam Ortiz", relation: "Spouse", dateOfBirth: "1984-12-20" }],
  },
  "demo-ceo": {
    middleName: "Alexander",
    preferredName: "Jordan",
    dateOfBirth: "1974-04-22",
    nationality: "American",
    workArrangement: "Hybrid",
    education: [
      { degree: "BA Economics", institution: "University of Michigan", year: 1996 },
      { degree: "MBA", institution: "Northwestern University (Kellogg)", year: 2002 },
    ],
    experience: [
      { employer: "Summit Financial", title: "Analyst", from: "1996-07-01", to: "2000-08-31" },
      { employer: "Globex Solutions", title: "VP Operations", from: "2002-07-01", to: "2011-12-30" },
    ],
    dependents: [
      { name: "Claire Blake", relation: "Spouse", dateOfBirth: "1976-08-09" },
      { name: "Ethan Blake", relation: "Child", dateOfBirth: "2008-02-14" },
      { name: "Lily Blake", relation: "Child", dateOfBirth: "2011-10-03" },
    ],
  },
  "demo-admin": {
    preferredName: "Alex",
    dateOfBirth: "1991-10-08",
    nationality: "British",
    workArrangement: "Office",
    education: [{ degree: "BSc Computer Science", institution: "University of Manchester", year: 2013 }],
    experience: [
      { employer: "Crestline Media", title: "IT Support Analyst", from: "2013-09-02", to: "2016-10-31" },
      { employer: "Pinecrest Logistics", title: "Systems Administrator", from: "2016-11-14", to: "2019-12-20" },
    ],
    dependents: [],
  },
};

/* ───────────── Generator ───────────── */

function generate(input: ProfileSeedInput): PersonProfileDetails {
  const { id } = input;
  const names = splitName(input.fullName);
  const joinYear = Number(input.dateOfJoining.slice(0, 4)) || SEED_YEAR;

  // Date of birth: older for senior grades, always at least 22 when they joined and 21–62 today.
  const minAge = Math.max(23, SEED_YEAR - joinYear + 22);
  const target = (GRADE_AGE[input.grade] ?? 31) + Math.floor(roll(id, 1) * 7) - 2;
  const age = Math.min(62, Math.max(minAge, target));
  const birthYear = SEED_YEAR - age;
  const dateOfBirth = iso(birthYear, 1 + Math.floor(roll(id, 2) * 12), 1 + Math.floor(roll(id, 3) * 28));

  // Nationality: mostly the work country, some expats.
  const local = NATIONALITY_BY_COUNTRY[input.countryCode] ?? "Other";
  const expat = roll(id, 4) < (EXPAT_SHARE[input.countryCode] ?? 0.1);
  const nationality = expat ? pick(EXPAT_POOL.filter((n) => n !== local), id, 5) : local;

  const availability = input.availability ?? "";
  const workArrangement: WorkArrangement =
    availability === "Remote" ? "Remote" : availability === "Work From Home" ? "Hybrid" : roll(id, 6) < 0.3 ? "Hybrid" : "Office";

  // Education: a first degree at 21–22 (always after DOB + 20); seniors sometimes add a postgraduate degree.
  const degrees = DEGREES[input.department] ?? DEGREES.Operations;
  const schools = INSTITUTIONS[nationality] ?? INSTITUTIONS[local] ?? INSTITUTIONS.British;
  const ugYear = birthYear + 21 + (roll(id, 7) < 0.5 ? 0 : 1);
  const education: EducationRecord[] = [{ degree: pick(degrees.ug, id, 8), institution: pick(schools, id, 9), year: ugYear }];
  const senior = !["L3", "L4"].includes(input.grade);
  const pgYear = ugYear + 2;
  if (senior && roll(id, 10) < 0.45 && pgYear < joinYear) {
    education.push({ degree: pick(degrees.pg, id, 11), institution: pick(schools, id, 12), year: pgYear });
  }

  // Experience: previous employers from graduation until the month before joining Infotech.
  const careerStart = monthIndex(iso(education[education.length - 1].year, 7, 1));
  const joinMonth = monthIndex(input.dateOfJoining);
  const span = joinMonth - 1 - careerStart;
  const experience: ExperienceRecord[] = [];
  if (span >= 9) {
    const count = span > 84 ? 3 : span > 36 ? 2 : 1;
    const roles = PRIOR_ROLE[input.department] ?? PRIOR_ROLE.Operations;
    const firstEmployer = Math.floor(roll(id, 13) * EMPLOYERS.length);
    let start = careerStart;
    for (let i = 0; i < count; i += 1) {
      const last = i === count - 1;
      const end = last ? joinMonth - 1 : start + Math.floor(span / count) - 1;
      experience.push({
        employer: EMPLOYERS[(firstEmployer + i * 5) % EMPLOYERS.length],
        title: roles[Math.min(i + (count === 1 && span > 48 ? 1 : 0), roles.length - 1)],
        from: fromMonthIndex(start, 1),
        to: fromMonthIndex(end, 28),
      });
      start = end + 1;
    }
  }

  // Dependents: a spouse for some, children for some of those, a parent for some in India.
  const dependents: DependentRecord[] = [];
  const lastName = names.lastName || names.firstName;
  if (age >= 27 && roll(id, 14) < 0.6) {
    const spouseFirst = input.gender === "Female" ? pick(MALE_NAMES, id, 15) : pick(FEMALE_NAMES, id, 15);
    const spouseYear = birthYear + Math.floor(roll(id, 16) * 7) - 3;
    dependents.push({
      name: `${spouseFirst} ${lastName}`,
      relation: "Spouse",
      dateOfBirth: iso(spouseYear, 1 + Math.floor(roll(id, 17) * 12), 1 + Math.floor(roll(id, 18) * 28)),
    });
    const kids = age >= 31 ? (roll(id, 19) < 0.45 ? 1 : roll(id, 19) < 0.8 ? 2 : 0) : 0;
    for (let k = 0; k < kids; k += 1) {
      const year = Math.min(SEED_YEAR - 1, birthYear + 28 + k * 3 + Math.floor(roll(id, 20 + k) * 3));
      dependents.push({
        name: `${pick(CHILD_NAMES, id, 22 + k)} ${lastName}`,
        relation: "Child",
        dateOfBirth: iso(year, 1 + Math.floor(roll(id, 24 + k) * 12), 1 + Math.floor(roll(id, 26 + k) * 28)),
      });
    }
  }
  if (input.countryCode === "IN" && roll(id, 28) < 0.25) {
    const parentFirst = roll(id, 29) < 0.5 ? pick(FEMALE_NAMES, id, 30) : pick(MALE_NAMES, id, 30);
    dependents.push({ name: `${parentFirst} ${lastName}`, relation: "Parent", dateOfBirth: iso(birthYear - 27, 6, 15) });
  }

  return {
    ...names,
    firstName: names.firstName,
    lastName: names.lastName,
    preferredName: names.firstName,
    dateOfBirth,
    nationality,
    workArrangement,
    education,
    experience,
    dependents,
  };
}

/** Full profile details for a person: hand-written for personas, generated for everyone else. */
export function profileDetailsFor(input: ProfileSeedInput): PersonProfileDetails {
  const persona = PERSONA_DETAILS[input.id];
  const names = splitName(input.fullName);
  if (persona) {
    return {
      ...persona,
      firstName: persona.firstName ?? names.firstName,
      middleName: persona.middleName ?? names.middleName,
      lastName: persona.lastName ?? names.lastName,
    };
  }
  return generate(input);
}
