/**
 * Letter templates (blueprint §24 / §39). Pure functions: merge fields in, escaped HTML out.
 * Wording varies by country where the legal meaning differs (e.g. at-will in the US, relieving letters in India).
 */
import { COUNTRY_PAY, legalEntityFor } from "../countryPay.ts";
import type { CountryCode } from "../model.ts";
import { letterTemplate, type LetterType } from "./rewardData.ts";

/** Everything a template can use. Empty string = not known. */
export interface LetterFields {
  employeeName: string;
  employeeCode: string;
  title: string;
  department: string;
  grade: string;
  joiningDate: string;
  lastWorkingDay: string;
  manager: string;
  countryCode: string;
  countryName: string;
  legalEntity: string;
  address: string;
  /** Formatted salary, pay letters only. */
  salary: string;
  previousSalary: string;
  effectiveDate: string;
  details: string;
}

export const FIELD_LABELS: Record<keyof LetterFields, string> = {
  employeeName: "Employee name",
  employeeCode: "Employee code",
  title: "Job title",
  department: "Department",
  grade: "Grade",
  joiningDate: "Joining date",
  lastWorkingDay: "Last working day",
  manager: "Line manager",
  countryCode: "Country",
  countryName: "Country",
  legalEntity: "Legal entity",
  address: "Address",
  salary: "Salary (compensation record)",
  previousSalary: "Previous salary",
  effectiveDate: "Effective date",
  details: "Details",
};

const BASE_REQUIRED: (keyof LetterFields)[] = ["employeeName", "employeeCode", "title", "department", "countryName", "legalEntity", "joiningDate"];

const EXTRA_REQUIRED: Record<LetterType, (keyof LetterFields)[]> = {
  Employment: [],
  Experience: ["lastWorkingDay"],
  Relieving: ["lastWorkingDay"],
  Offer: ["grade", "salary"],
  Appointment: ["grade", "manager", "salary"],
  Confirmation: ["effectiveDate"],
  Promotion: ["grade", "salary", "effectiveDate"],
  "Salary revision": ["salary", "effectiveDate"],
  Transfer: ["details", "effectiveDate"],
  NOC: ["details"],
  "Visa/Travel": ["details"],
  "Address proof": ["address"],
};

/** Labels of required fields that are missing. Generation is blocked while this is non-empty. */
export function missingFields(type: LetterType, fields: LetterFields): string[] {
  const keys = [...BASE_REQUIRED, ...EXTRA_REQUIRED[type]];
  return keys
    .filter((k) => !fields[k].trim())
    .map((k) => (k === "details" ? letterTemplate(type).detailsLabel ?? FIELD_LABELS.details : FIELD_LABELS[k]));
}

/* ───────────── Letterhead ───────────── */

const ENTITY_ADDRESS: Record<string, string> = {
  IN: "Prestige Tech Park, Outer Ring Road, Bengaluru 560103, India",
  US: "350 Fifth Avenue, Suite 4200, New York, NY 10118, United States",
  GB: "20 Finsbury Circus, London EC2M 7EA, United Kingdom",
  AU: "1 Martin Place, Sydney NSW 2000, Australia",
  CA: "100 King Street West, Toronto, ON M5X 1A9, Canada",
  AE: "Dubai Internet City, Building 3, Dubai, United Arab Emirates",
  SA: "King Fahd Road, Olaya, Riyadh 12214, Saudi Arabia",
  DE: "Friedrichstraße 68, 10117 Berlin, Germany",
};

const TYPE_CODE: Record<LetterType, string> = {
  Employment: "EMP",
  Experience: "EXP",
  Relieving: "REL",
  Offer: "OFR",
  Appointment: "APT",
  Confirmation: "CNF",
  Promotion: "PRM",
  "Salary revision": "SAL",
  Transfer: "TRF",
  NOC: "NOC",
  "Visa/Travel": "VIS",
  "Address proof": "ADR",
};

export function entityFor(countryCode: string): string {
  return legalEntityFor((countryCode || "IN") as CountryCode);
}

export function referenceNumber(type: LetterType, countryCode: string, serial: number, isoDate: string): string {
  return `INF-${countryCode || "IN"}/HR/${TYPE_CODE[type]}/${isoDate.slice(0, 4)}/${String(serial).padStart(4, "0")}`;
}

export function localeFor(countryCode: string): string {
  return COUNTRY_PAY[countryCode as CountryCode]?.locale ?? "en-GB";
}

/** Long date in the person's locale, e.g. "27 October 2026" or "October 27, 2026". */
export function letterDate(iso: string, countryCode: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [y, m, d] = iso.split("-").map(Number);
  try {
    return new Intl.DateTimeFormat(localeFor(countryCode), { day: "numeric", month: "long", year: "numeric" }).format(new Date(y, m - 1, d));
  } catch {
    return iso;
  }
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/* ───────────── Bodies ───────────── */

type Body = { title: string; toWhom: boolean; paragraphs: string[] };

/** Builds the title and paragraphs. Values are escaped here; the strings are trusted markup afterwards. */
function body(type: LetterType, f: LetterFields): Body {
  const c = f.countryCode;
  const d = (iso: string) => esc(letterDate(iso, c));
  const name = `<strong>${esc(f.employeeName)}</strong> (${esc(f.employeeCode)})`;
  const role = `${esc(f.title)}, ${esc(f.department)}`;
  const entity = esc(f.legalEntity);
  const noLiability =
    c === "AE" || c === "SA" ? "This certificate is issued at the employee's request without any liability on the company." : "This letter is issued at the employee's request.";

  switch (type) {
    case "Employment":
      return {
        title: c === "US" ? "Employment Verification" : "Employment Certificate",
        toWhom: true,
        paragraphs: [
          `This is to certify that ${name} has been employed with ${entity} since ${d(f.joiningDate)} and currently works as ${role}.`,
          c === "US" ? "Employment with the company is at-will." : "The employee is in active service as of the date of this letter.",
          noLiability,
        ],
      };
    case "Experience":
      return {
        title: "Experience Letter",
        toWhom: true,
        paragraphs: [
          `This is to certify that ${name} was employed with ${entity} from ${d(f.joiningDate)} to ${d(f.lastWorkingDay)}. Their last position was ${role}.`,
          "During this period their conduct and performance were satisfactory. We wish them well.",
          ...(c === "DE" ? ["A qualified reference (Arbeitszeugnis) is available on request."] : []),
        ],
      };
    case "Relieving":
      if (c === "US") {
        return {
          title: "Separation Letter",
          toWhom: false,
          paragraphs: [`This confirms that your employment with ${entity} as ${role} ended on ${d(f.lastWorkingDay)}.`, "Final pay and benefit details are sent separately."],
        };
      }
      if (c === "GB") {
        return {
          title: "Confirmation of Leaving",
          toWhom: false,
          paragraphs: [`This confirms that your employment with ${entity} as ${role} ended on ${d(f.lastWorkingDay)}.`, "Your P45 is issued with your final payslip."],
        };
      }
      return {
        title: "Relieving Letter",
        toWhom: false,
        paragraphs: [
          `Further to your resignation, you are relieved from your duties as ${role} with ${entity} at the close of business on ${d(f.lastWorkingDay)}.`,
          "Your full and final settlement will be processed as per company policy. We thank you for your service.",
        ],
      };
    case "Offer":
      return {
        title: "Offer of Employment",
        toWhom: false,
        paragraphs: [
          `We are pleased to offer you the position of ${esc(f.title)} (grade ${esc(f.grade)}) in ${esc(f.department)} with ${entity}, starting ${d(f.joiningDate)}.`,
          `Your annual base salary will be <strong>${esc(f.salary)}</strong>, subject to applicable deductions.`,
          c === "US"
            ? "Employment with the company is at-will. This offer is subject to background verification and work authorization."
            : c === "GB"
              ? "This offer is subject to right-to-work checks. A written statement of particulars follows on joining."
              : "This offer is subject to background verification and submission of joining documents.",
        ],
      };
    case "Appointment":
      return {
        title: "Letter of Appointment",
        toWhom: false,
        paragraphs: [
          `You are appointed as ${esc(f.title)} (grade ${esc(f.grade)}) in ${esc(f.department)} with ${entity}, effective ${d(f.joiningDate)}. You will report to ${esc(f.manager)}.`,
          `Your annual base salary is <strong>${esc(f.salary)}</strong>.`,
          c === "IN"
            ? "Your employment is governed by the company's standing orders and policies, as amended from time to time."
            : "Your employment is governed by your contract and the company's policies.",
        ],
      };
    case "Confirmation":
      return {
        title: "Confirmation of Employment",
        toWhom: false,
        paragraphs: [
          `We are pleased to confirm your employment as ${role} with ${entity}, effective ${d(f.effectiveDate)}, on successful completion of your probation.`,
          "All other terms of your employment remain unchanged.",
        ],
      };
    case "Promotion":
      return {
        title: "Promotion Letter",
        toWhom: false,
        paragraphs: [
          `We are pleased to inform you that you have been promoted to grade <strong>${esc(f.grade)}</strong> as ${role}, effective ${d(f.effectiveDate)}.`,
          `Your revised annual base salary is <strong>${esc(f.salary)}</strong>.`,
          "All other terms of your employment remain unchanged.",
        ],
      };
    case "Salary revision":
      return {
        title: "Salary Revision Letter",
        toWhom: false,
        paragraphs: [
          f.previousSalary
            ? `Your annual base salary is revised from ${esc(f.previousSalary)} to <strong>${esc(f.salary)}</strong>, effective ${d(f.effectiveDate)}.`
            : `Your annual base salary is revised to <strong>${esc(f.salary)}</strong>, effective ${d(f.effectiveDate)}.`,
          "This information is confidential. All other terms remain unchanged.",
        ],
      };
    case "Transfer":
      return {
        title: "Transfer Letter",
        toWhom: false,
        paragraphs: [
          `You are transferred from ${role} to <strong>${esc(f.details)}</strong>, effective ${d(f.effectiveDate)}.`,
          "Your grade, pay and continuity of service are unchanged unless stated otherwise in writing.",
        ],
      };
    case "NOC":
      return {
        title: "No Objection Certificate",
        toWhom: true,
        paragraphs: [
          `${name}, ${role}, has been employed with ${entity} since ${d(f.joiningDate)}.`,
          `The company has no objection to the employee's request for: <strong>${esc(f.details)}</strong>.`,
          noLiability,
        ],
      };
    case "Visa/Travel":
      return {
        title: c === "DE" || c === "GB" ? "Visa Support Letter" : "Visa / Travel Letter",
        toWhom: true,
        paragraphs: [
          `${name} is employed with ${entity} as ${role} since ${d(f.joiningDate)}.`,
          `The employee intends to travel as follows: <strong>${esc(f.details)}</strong>. The employee will resume duties on return.`,
          noLiability,
        ],
      };
    case "Address proof":
      return {
        title: "Address Confirmation",
        toWhom: true,
        paragraphs: [
          `This is to certify that ${name}, ${role}, is employed with ${entity}.`,
          `As per company records, the employee's residential address is: <strong>${esc(f.address)}</strong>.`,
          noLiability,
        ],
      };
  }
}

export interface LetterRenderMeta {
  type: LetterType;
  /** ISO date printed on the letter. */
  date: string;
  referenceNo: string;
  /** Final letters carry the approver; drafts show "Pending approval". */
  approval?: { by: string; on: string };
  docId?: string;
  version?: number;
}

/** The letter body markup (no <html> shell). Stored as-is when a final letter is generated. */
export function renderLetterBody(fields: LetterFields, meta: LetterRenderMeta): string {
  const c = fields.countryCode;
  const b = body(meta.type, fields);
  const entity = esc(fields.legalEntity);
  const approval = meta.approval
    ? `Approved by ${esc(meta.approval.by)} on ${esc(letterDate(meta.approval.on, c))}`
    : "Pending approval";
  const footer = meta.docId ? `Document ${esc(meta.docId)} · version ${meta.version ?? 1}` : "Draft preview — not valid until approved";
  return `<header class="lh">
  <div class="lh-name">${entity}</div>
  <div class="lh-addr">${esc(ENTITY_ADDRESS[c] ?? ENTITY_ADDRESS.IN)}</div>
</header>
<div class="meta"><span>Ref: ${esc(meta.referenceNo)}</span><span>${esc(letterDate(meta.date, c))}</span></div>
<h1>${esc(b.title)}</h1>
<p class="salute">${b.toWhom ? "To whom it may concern," : `Dear ${esc(fields.employeeName)},`}</p>
${b.paragraphs.map((p) => `<p>${p}</p>`).join("\n")}
<div class="sign">
  <p>For ${entity}</p>
  <div class="sign-line"></div>
  <p><strong>Authorised Signatory</strong><br>Human Resources</p>
  <p class="approval">${approval}</p>
</div>
<footer class="foot">${footer}</footer>`;
}

const PRINT_CSS = `
@page { size: A4; margin: 18mm 18mm 20mm; }
* { box-sizing: border-box; }
html, body { margin: 0; background: #fff; color: #1d2433; }
body { font: 11pt/1.55 Georgia, "Times New Roman", serif; }
.page { position: relative; max-width: 174mm; margin: 0 auto; padding: 8mm 0; min-height: 250mm; display: flex; flex-direction: column; }
.lh { border-bottom: 2px solid #1d3d6e; padding-bottom: 8px; margin-bottom: 14px; }
.lh-name { font: 700 17pt/1.2 Arial, Helvetica, sans-serif; color: #1d3d6e; letter-spacing: .02em; }
.lh-addr { font: 9pt/1.4 Arial, Helvetica, sans-serif; color: #555; }
.meta { display: flex; justify-content: space-between; font: 9.5pt Arial, Helvetica, sans-serif; color: #333; margin-bottom: 18px; }
h1 { font: 700 14pt Arial, Helvetica, sans-serif; text-align: center; text-transform: uppercase; letter-spacing: .06em; margin: 6px 0 18px; }
p { margin: 0 0 10px; }
.salute { margin-bottom: 12px; }
.sign { margin-top: 28px; }
.sign-line { width: 55mm; border-bottom: 1px solid #333; height: 14mm; margin-bottom: 4px; }
.approval { font: 9pt Arial, Helvetica, sans-serif; color: #1d3d6e; margin-top: 6px; }
.foot { margin-top: auto; padding-top: 14px; border-top: 1px solid #ccc; font: 8pt Arial, Helvetica, sans-serif; color: #777; text-align: center; }
.watermark { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; z-index: 10; }
.watermark span { transform: rotate(-35deg); font: 700 110pt Arial, Helvetica, sans-serif; color: rgba(200, 40, 40, .13); letter-spacing: .1em; }
@media screen { body { background: #eef0f4; padding: 16px; } .page { background: #fff; padding: 16mm 18mm; max-width: 210mm; box-shadow: 0 1px 6px rgba(0,0,0,.15); } }
@media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
`;

/** A complete, print-ready HTML document (A4). Drafts get a DRAFT watermark. */
export function letterDocumentHtml(bodyHtml: string, options: { title: string; draft: boolean; lang?: string }): string {
  return `<!doctype html>
<html lang="${esc(options.lang ?? "en")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(options.title)}</title>
<style>${PRINT_CSS}</style>
</head>
<body>
${options.draft ? '<div class="watermark" aria-hidden="true"><span>DRAFT</span></div>' : ""}
<main class="page">
${bodyHtml}
</main>
</body>
</html>`;
}

export function letterFileName(type: LetterType, employeeCode: string, version?: number): string {
  const label = letterTemplate(type).label.replace(/[^A-Za-z0-9]+/g, "-");
  return `${label}-${employeeCode || "employee"}${version ? `-v${version}` : "-DRAFT"}`;
}
