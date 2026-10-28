// Export the front end's seed data to backend/seed/*.json: the six sign-in accounts (with their employee records),
// leave policies, holidays and countries. The 500-person directory comes from
// backend/seed/TimeZ_500_Employee_Sample_HCM_Data.xlsx, not from the front end's generated people.
// Run from the repo root:  node --experimental-strip-types scripts/export-seed.mjs
// (or: npx tsx scripts/export-seed.mjs)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "backend", "seed");
mkdirSync(outDir, { recursive: true });

const { getBasePeople } = await import("../src/data/peopleData.ts");
const { createSeed } = await import("../src/seed.ts");
const { DEMO_ACCOUNTS } = await import("../src/demoAccounts.ts");
const { TIMEZ_COUNTRIES } = await import("../src/model.ts");

const accountIds = new Set(DEMO_ACCOUNTS.map((a) => a.id));
const people = getBasePeople().filter((p) => accountIds.has(p.id)).map((p) => ({
  id: p.id,
  employee_code: p.employeeCode,
  full_name: p.fullName,
  first_name: p.firstName ?? null,
  middle_name: p.middleName ?? null,
  last_name: p.lastName ?? null,
  preferred_name: p.preferredName ?? null,
  email: p.email,
  personal_email: p.personalEmail ?? null,
  mobile: p.mobile ?? null,
  photo: p.photo ?? null,
  country_code: p.countryCode,
  country_name: p.countryName,
  legal_entity: p.legalEntity,
  business_unit: p.businessUnit,
  division: p.division,
  department: p.department,
  cost_centre: p.costCenter,
  location: p.location,
  job_title: p.designation,
  job_family: p.jobFamily,
  position_id: p.positionId,
  grade: p.grade,
  employment_type: p.employmentType,
  employment_status: p.employmentStatus,
  joining_date: p.dateOfJoining,
  manager_id: p.managerId || null,
  time_zone: p.timeZone,
  currency: p.currency,
  date_of_birth: p.dateOfBirth ?? null,
  gender: p.gender,
}));

const accounts = DEMO_ACCOUNTS.map((a) => ({
  id: a.id,
  email: a.email,
  role: a.role,
  employee_id: a.id,
  password: a.password,
  reports_to_id: a.reportsToId ?? null,
  employee: people.find((p) => p.id === a.id),
}));

const seed = createSeed();
const policies = seed.leavePolicies;
const holidays = seed.holidays.map((h) => ({ id: h.id, date: h.date, name: h.name, country_code: h.countryCode ?? "IN" }));
const countries = TIMEZ_COUNTRIES.map((c) => ({ code: c.code, name: c.name, currency: c.currency, time_zone: c.timeZone }));

const write = (name, data) => {
  writeFileSync(join(outDir, name), JSON.stringify(data, null, 2) + "\n", "utf8");
  console.log(`${name}: ${Array.isArray(data) ? data.length : Object.keys(data).length} records`);
};
write("accounts.json", accounts);
write("leave_policies.json", policies);
write("holidays.json", holidays);
write("countries.json", countries);

// Sanity: each sign-in account has its employee record, with the expected reporting line.
for (const a of accounts) {
  const p = a.employee;
  if (!p) throw new Error(`Account ${a.id} missing from people`);
  if ((p.manager_id ?? null) !== (a.reports_to_id ?? null)) {
    throw new Error(`Account ${a.id}: manager ${p.manager_id} != reportsToId ${a.reports_to_id}`);
  }
}
console.log("Accounts linked to people with matching reporting lines.");
