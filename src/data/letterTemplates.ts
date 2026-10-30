/**
 * Letter templates (blueprint §24 / §39). Pure functions: merge fields in, escaped HTML out.
 * Wording varies by country where the legal meaning differs (e.g. at-will in the US, relieving letters in India).
 */
import { COUNTRY_PAY, legalEntityFor } from "../countryPay.ts";
import type { CountryCode } from "../model.ts";
import { LETTER_TEMPLATES, type LetterTemplateInfo, type LetterType } from "./rewardData.ts";

/* ───────────── Letter types ───────────── */

/** Letter types added here on top of the stored request types. */
export const EXTRA_LETTER_TYPES = ["Internship", "Warning", "Termination"] as const;
export type FullLetterType = LetterType | (typeof EXTRA_LETTER_TYPES)[number];

export interface LetterInfo extends Omit<LetterTemplateInfo, "type"> {
  type: FullLetterType;
  /** Raised by HR only and decided by a second approver (never the person who raised it). */
  secondApproval?: boolean;
}

const EXTRA_TEMPLATES: LetterInfo[] = [
  {
    type: "Internship",
    label: "Internship certificate",
    description: "Internship period, role and team.",
    employeeCanRequest: true,
    payLetter: false,
    effectiveInput: true,
  },
  {
    type: "Warning",
    label: "Warning letter",
    description: "Formal warning about conduct or performance. Needs a second approver.",
    employeeCanRequest: false,
    payLetter: false,
    detailsLabel: "Issue and expected improvement",
    secondApproval: true,
  },
  {
    type: "Termination",
    label: "Termination letter",
    description: "Ends employment from a stated date, with the reason. Needs a second approver.",
    employeeCanRequest: false,
    payLetter: false,
    detailsLabel: "Reason for termination",
    effectiveInput: true,
    secondApproval: true,
  },
];

/** Every letter type that can be requested, in display order. */
export const ALL_LETTER_TEMPLATES: LetterInfo[] = [
  ...LETTER_TEMPLATES.filter((t) => !EXTRA_TEMPLATES.some((x) => x.type === t.type)),
  ...EXTRA_TEMPLATES,
];

export function letterInfo(type: FullLetterType | string): LetterInfo {
  return ALL_LETTER_TEMPLATES.find((t) => t.type === type) ?? ALL_LETTER_TEMPLATES[0];
}

/** Warning and termination letters: HR raises them and someone else approves. */
export function needsSecondApproval(type: FullLetterType | string): boolean {
  return Boolean(ALL_LETTER_TEMPLATES.find((t) => t.type === type)?.secondApproval);
}

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
  /** Nationality on the employee record (visa letters). */
  nationality: string;
  /** End of an internship or contract. */
  endDate: string;
  /** "Add your own text": a paragraph the requester asked to include. */
  customText: string;
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
  nationality: "Nationality",
  endDate: "End date",
  customText: "Your own text",
};

const BASE_REQUIRED: (keyof LetterFields)[] = ["employeeName", "employeeCode", "title", "department", "countryName", "legalEntity", "joiningDate"];

const EXTRA_REQUIRED: Record<FullLetterType, (keyof LetterFields)[]> = {
  Internship: ["endDate"],
  Warning: ["details", "manager"],
  Termination: ["details", "effectiveDate"],
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
  "Salary certificate": ["salary"],
  Bonafide: [],
};

/** Labels of required fields that are missing. Generation is blocked while this is non-empty. */
export function missingFields(type: FullLetterType, fields: LetterFields): string[] {
  const keys = [...BASE_REQUIRED, ...(EXTRA_REQUIRED[type] ?? [])];
  return keys
    .filter((k) => !(fields[k] ?? "").trim())
    .map((k) =>
      k === "details"
        ? letterInfo(type).detailsLabel ?? FIELD_LABELS.details
        : k === "effectiveDate" && type === "Termination"
          ? "Termination date"
          : k === "endDate" && type === "Internship"
            ? "Internship end date (effective date)"
            : FIELD_LABELS[k],
    );
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

const TYPE_CODE: Record<FullLetterType, string> = {
  Internship: "INT",
  Warning: "WRN",
  Termination: "TRM",
  Employment: "EMP",
  Experience: "EXP",
  Relieving: "REL",
  Offer: "OFR",
  Appointment: "APT",
  Confirmation: "CNF",
  Promotion: "PRM",
  "Salary revision": "INC",
  Transfer: "TRF",
  NOC: "NOC",
  "Visa/Travel": "VIS",
  "Address proof": "ADR",
  "Salary certificate": "SLC",
  Bonafide: "BON",
};

export function entityFor(countryCode: string): string {
  return legalEntityFor((countryCode || "IN") as CountryCode);
}

export function referenceNumber(type: FullLetterType, countryCode: string, serial: number, isoDate: string): string {
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
function body(type: FullLetterType, f: LetterFields): Body {
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
        title: "Increment Letter",
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
          `${name}${f.nationality ? `, ${esc(f.nationality)} national,` : ""} is employed with ${entity} as ${role} since ${d(f.joiningDate)}.`,
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
    case "Salary certificate":
      return {
        title: "Salary Certificate",
        toWhom: true,
        paragraphs: [
          `This is to certify that ${name} is employed with ${entity} as ${role} since ${d(f.joiningDate)}.`,
          `Their current annual base salary is <strong>${esc(f.salary)}</strong>, paid monthly, before statutory deductions.`,
          noLiability,
        ],
      };
    case "Bonafide":
      return {
        title: "Bonafide Certificate",
        toWhom: true,
        paragraphs: [`This is to certify that ${name} is a bonafide employee of ${entity}, working as ${role} since ${d(f.joiningDate)}.`, noLiability],
      };
    case "Internship":
      return {
        title: "Internship Certificate",
        toWhom: true,
        paragraphs: [
          `This is to certify that ${name} completed an internship with ${entity} from ${d(f.joiningDate)} to ${d(f.endDate)}, working as ${role}.`,
          f.manager ? `The internship was supervised by ${esc(f.manager)}. During this period their conduct and work were satisfactory.` : "During this period their conduct and work were satisfactory.",
          "We wish them every success.",
        ],
      };
    case "Warning":
      return {
        title: c === "DE" ? "Warning Letter (Abmahnung)" : "Warning Letter",
        toWhom: false,
        paragraphs: [
          `This letter is a formal warning about the following: <strong>${esc(f.details)}</strong>.`,
          `This was discussed with you by your line manager, ${esc(f.manager)}. You are expected to show immediate and lasting improvement. Further issues of this kind may lead to further disciplinary action, up to and including termination of employment.`,
          c === "GB"
            ? "You have the right to appeal this warning in writing to Human Resources within 5 working days."
            : c === "DE"
              ? "A copy of this warning is placed on your personnel file. You may submit a written response, which will be filed with it."
              : "A copy of this letter is placed on your personnel file. You may reply in writing to Human Resources within 7 days.",
          "Please sign a copy of this letter to confirm you have received it.",
        ],
      };
    case "Termination":
      return {
        title: "Termination of Employment",
        toWhom: false,
        paragraphs: [
          `This letter confirms that your employment with ${entity} as ${role} ends with effect from <strong>${d(f.effectiveDate)}</strong>.`,
          `Reason: ${esc(f.details)}.`,
          c === "US"
            ? "Employment with the company is at-will. Information on final pay, benefits continuation and any severance is sent separately."
            : c === "GB"
              ? "You will receive pay for your statutory or contractual notice, whichever is longer, and any accrued holiday. You have the right to appeal this decision in writing within 5 working days."
              : c === "DE"
                ? "The statutory or contractual notice period applies. Your final settlement and employment reference (Arbeitszeugnis) will follow."
                : c === "AE" || c === "SA"
                  ? "Your end-of-service gratuity, notice pay and accrued leave will be settled as per labour law and your contract."
                  : "Your full and final settlement, including notice pay and accrued leave, will be processed as per your appointment terms and company policy.",
          "Please return all company property and complete the exit handover by your last working day.",
        ],
      };
    default:
      return { title: letterInfo(type).label, toWhom: true, paragraphs: [`${name} is employed with ${entity} as ${role}.`, noLiability] };
  }
}

/** Puts the requester's own paragraph before the closing "issued at the employee's request" line. */
export function withOwnParagraph(paragraphs: string[], own: string | undefined): string[] {
  const text = (own ?? "").trim();
  if (!text) return paragraphs;
  const last = paragraphs[paragraphs.length - 1] ?? "";
  const at = paragraphs.length > 1 && last.includes("request") ? paragraphs.length - 1 : paragraphs.length;
  return [...paragraphs.slice(0, at), text, ...paragraphs.slice(at)];
}

/**
 * Words "Add your own text" as a plain letter sentence when no AI is available:
 * drops "mention / please add…", turns first person into third person, capitalises and ends with a full stop.
 */
export function plainOwnParagraph(text: string, employeeName: string): string {
  let t = text.trim().replace(/\s+/g, " ");
  if (!t) return "";
  t = t.replace(/^(please\s+)?(mention|add|include|state|say|write|note)\s+(that\s+)?/i, "");
  const swaps: [RegExp, string][] = [
    [/\bI'm\b|\bI am\b/gi, "the employee is"],
    [/\bI've\b|\bI have\b/gi, "the employee has"],
    [/\bI'll\b|\bI will\b/gi, "the employee will"],
    [/\bI'd\b/gi, "the employee would"],
    [/\bI\b/g, "the employee"],
    [/\bmy\b/gi, "their"],
    [/\bme\b/gi, "them"],
    [/\bmine\b/gi, "theirs"],
    [/\bmyself\b/gi, "themselves"],
  ];
  for (const [re, to] of swaps) t = t.replace(re, to);
  // The first mention reads better with the name.
  if (employeeName) t = t.replace(/^the employee\b/i, employeeName);
  t = t.charAt(0).toUpperCase() + t.slice(1);
  if (!/[.!?]$/.test(t)) t += ".";
  return t.slice(0, 1200);
}

export interface LetterRenderMeta {
  type: FullLetterType;
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
  const paragraphs = withOwnParagraph(b.paragraphs, fields.customText ? esc(fields.customText) : "");
  return letterShell({
    entity,
    address: esc(ENTITY_ADDRESS[c] ?? ENTITY_ADDRESS.IN),
    referenceNo: esc(meta.referenceNo),
    date: esc(letterDate(meta.date, c)),
    title: esc(b.title),
    addressee: b.toWhom ? "" : `${esc(fields.employeeName)}<br>${esc(fields.title)}, ${esc(fields.department)}<br>Employee ID ${esc(fields.employeeCode)}`,
    salute: b.toWhom ? "To whom it may concern," : `Dear ${esc(fields.employeeName)},`,
    paragraphs,
    approval,
    footer,
  });
}

/** The letter layout: TimeZ letterhead, ref and date, addressee, title, body, signatory. All parts are trusted markup. */
export function letterShell(p: {
  entity: string;
  address: string;
  referenceNo: string;
  date: string;
  title: string;
  addressee: string;
  salute: string;
  paragraphs: string[];
  approval: string;
  footer: string;
}): string {
  return `<header class="lh">
  <div class="lh-name">TimeZ</div>
  <div class="lh-addr">${p.entity} · ${p.address}</div>
</header>
<div class="meta"><span>Ref: ${p.referenceNo}</span><span>${p.date}</span></div>
${p.addressee ? `<p class="to">${p.addressee}</p>` : ""}
<h1>${p.title}</h1>
<p class="salute">${p.salute}</p>
${p.paragraphs.map((x) => `<p>${x}</p>`).join("\n")}
<div class="sign">
  <p>For ${p.entity}</p>
  <div class="sign-line"></div>
  <p><strong>Authorised Signatory</strong><br>Human Resources, TimeZ</p>
  <p class="approval">${p.approval}</p>
</div>
<footer class="foot">${p.footer}</footer>`;
}

/** Backend preview: server paragraphs carry escaped values and <b> markup only; anything else is escaped. */
export function serverParagraph(p: string): string {
  return p.replace(/<(?!\/?b>|br\s*\/?>)/gi, "&lt;").replace(/<(\/?)b>/gi, "<$1strong>");
}

/** A full letter from the server's preview (fields + paragraphs), in the same layout as the PDF. */
export function serverLetterBody(
  preview: { title: string; paragraphs: string[]; fields: Record<string, string>; letter_type: string },
  meta: { referenceNo: string; date: string; approval: string; footer: string; ownText?: string },
): string {
  const f = preview.fields;
  const c = f.country_code ?? "";
  const toWhom = TO_WHOM_TYPES.has(preview.letter_type);
  return letterShell({
    entity: esc(f.legal_entity ?? ""),
    address: esc(ENTITY_ADDRESS[c] ?? ENTITY_ADDRESS.IN),
    referenceNo: esc(meta.referenceNo),
    date: esc(letterDate(meta.date, c)),
    title: esc(preview.title),
    addressee: toWhom ? "" : `${esc(f.employee_name ?? "")}<br>${esc(f.title ?? "")}, ${esc(f.department ?? "")}<br>Employee ID ${esc(f.employee_code ?? "")}`,
    salute: toWhom ? "To whom it may concern," : `Dear ${esc(f.employee_name ?? "")},`,
    paragraphs: withOwnParagraph(preview.paragraphs.map(serverParagraph), meta.ownText ? esc(meta.ownText) : ""),
    approval: esc(meta.approval),
    footer: esc(meta.footer),
  });
}

/** Letters addressed "To whom it may concern" (the rest are addressed to the employee). */
const TO_WHOM_TYPES = new Set(["Employment", "Experience", "NOC", "Visa/Travel", "Address proof", "Internship", "Salary certificate", "Bonafide"]);

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
.to { margin: 0 0 14px; font-size: 10.5pt; }
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

export function letterFileName(type: FullLetterType, employeeCode: string, version?: number): string {
  const label = letterInfo(type).label.replace(/[^A-Za-z0-9]+/g, "-");
  return `${label}-${employeeCode || "employee"}${version ? `-v${version}` : "-DRAFT"}`;
}

/* ───────────── Offer letter for a candidate (hiring chain) ───────────── */

/** The Offer template filled for a candidate: title and paragraphs (trusted markup, values escaped). */
export function offerLetterContent(fields: LetterFields): { title: string; paragraphs: string[] } {
  const b = body("Offer", fields);
  return { title: b.title, paragraphs: withOwnParagraph(b.paragraphs, fields.customText ? esc(fields.customText) : "") };
}

/**
 * The candidate's offer letter in the letter layout. `paragraphs` come from offerLetterContent or from the server
 * (escaped values with <b> markup only).
 */
export function offerLetterHtml(letter: { title: string; paragraphs: string[]; date: string; fields: Record<string, string> }, fromServer: boolean): string {
  const f = letter.fields;
  const c = f.country_code ?? f.countryCode ?? "";
  const name = f.employee_name ?? f.employeeName ?? "";
  return letterShell({
    entity: esc(f.legal_entity ?? f.legalEntity ?? ""),
    address: esc(ENTITY_ADDRESS[c] ?? ENTITY_ADDRESS.IN),
    referenceNo: "Offer",
    date: esc(letterDate(letter.date, c)),
    title: esc(letter.title),
    addressee: `${esc(name)}<br>${esc(f.title ?? "")}, ${esc(f.department ?? "")}`,
    salute: `Dear ${esc(name)},`,
    paragraphs: fromServer ? letter.paragraphs.map(serverParagraph) : letter.paragraphs,
    approval: "Approved by the hiring manager and HR",
    footer: "Accept or decline using the link you received.",
  });
}
