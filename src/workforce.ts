import type { Colleague } from "./model.ts";
import { TIMEZ_COUNTRIES } from "./model.ts";
import { DEMO_ACCOUNTS, TIMEZ_PERSONAS } from "./demoAccounts.ts";

export { DEMO_ACCOUNTS, TIMEZ_PERSONAS } from "./demoAccounts.ts";

const FIRST = [
  "Aarav", "Diya", "Kabir", "Ananya", "Rohan", "Isha", "Vikram", "Meera", "Arjun", "Nisha",
  "James", "Emily", "Michael", "Olivia", "William", "Sophia", "Oliver", "Ava", "Noah", "Mia",
  "Hans", "Greta", "Omar", "Layla", "Chen", "Priya", "Sam", "Nina", "Leo", "Sara",
];
const LAST = [
  "Sharma", "Patel", "Reddy", "Nair", "Khan", "Singh", "Iyer", "Das", "Smith", "Johnson",
  "Brown", "Taylor", "Wilson", "Anderson", "Thomas", "Lee", "Martin", "Garcia", "Mueller", "Schmidt",
];
const DEPARTMENTS = ["Engineering", "Product", "People", "Finance", "Sales", "Operations", "Customer Success", "Legal"];
/** Job titles that belong to each department, so a person's title always fits their department. */
const TITLES_BY_DEPARTMENT: Record<string, string[]> = {
  Engineering: ["Software Engineer", "Senior Engineer", "QA Analyst", "Data Analyst"],
  Product: ["Product Manager", "Designer", "Product Analyst"],
  People: ["HR Business Partner", "Talent Acquisition Specialist", "HR Generalist"],
  Finance: ["Finance Analyst", "Accountant", "Payroll Specialist"],
  Sales: ["Account Executive", "Sales Development Representative", "Sales Manager"],
  Operations: ["Operations Lead", "Operations Analyst", "Facilities Coordinator"],
  "Customer Success": ["Customer Success Manager", "Support Engineer", "Implementation Consultant"],
  Legal: ["Legal Counsel", "Compliance Analyst", "Contracts Manager"],
};
const AVAIL: Colleague["availability"][] = ["In Office", "Work From Home", "On Leave", "Remote"];

/** Build the standard Infotech 500-employee directory across 8 countries. */
export function buildTimezWorkforce(total = 500): Colleague[] {
  const rows: Colleague[] = [];
  let seq = 1;
  for (const country of TIMEZ_COUNTRIES) {
    for (let i = 0; i < country.headcount; i += 1) {
      // Every first name pairs with a different last name on each pass, so names stay unique
      // for up to FIRST.length * LAST.length (600) employees.
      const k = seq - 1;
      const first = FIRST[k % FIRST.length];
      // "Isha Reddy" is retired from the sample data; that one combination uses Kapoor instead.
      const generatedLast = LAST[(k + Math.floor(k / FIRST.length)) % LAST.length];
      const last = first === "Isha" && generatedLast === "Reddy" ? "Kapoor" : generatedLast;
      const code = `TZ${String(seq).padStart(4, "0")}`;
      const dept = DEPARTMENTS[seq % DEPARTMENTS.length];
      const deptTitles = TITLES_BY_DEPARTMENT[dept];
      const title = deptTitles[Math.floor(seq / DEPARTMENTS.length) % deptTitles.length];
      rows.push({
        id: `wf-${code}`,
        name: `${first} ${last}`,
        employeeCode: code,
        designation: title,
        department: dept,
        email: `${first.toLowerCase()}.${last.toLowerCase()}.${code.toLowerCase()}@infotech.com`,
        personalEmail: `${first.toLowerCase()}.${last.toLowerCase()}@example.com`,
        mobile: `+${9000000000 + seq}`,
        managerName: seq % 7 === 0 ? "Ram Krishnan" : "Farhan Ali",
        availability: AVAIL[seq % AVAIL.length],
        companyCode: "Infotech",
        businessUnit: `Infotech ${country.name}`,
        practice: dept,
        subPractice: title,
        gender: seq % 2 === 0 ? "Female" : "Male",
        dateOfJoining: `20${14 + (seq % 10)}-${String((seq % 12) + 1).padStart(2, "0")}-15`,
        workingCountry: country.name,
        photo: "/profile.svg",
      });
      seq += 1;
      if (rows.length >= total) return rows;
    }
  }
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

void DEMO_ACCOUNTS;
void TIMEZ_PERSONAS;
