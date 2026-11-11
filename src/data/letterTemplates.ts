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

/** Contact and registration lines printed on the letterhead and footer, per country. */
export const ENTITY_CONTACT: Record<string, { phone: string; email: string; registration: string }> = {
  IN: { phone: "+91 80 4710 2200", email: "hr.in@timez.com", registration: "CIN U72900KA2015PTC081234" },
  US: { phone: "+1 212 555 0142", email: "hr.us@timez.com", registration: "EIN 84-2917365" },
  GB: { phone: "+44 20 7946 0321", email: "hr.uk@timez.com", registration: "Company No. 10293847 (England & Wales)" },
  AU: { phone: "+61 2 9067 4410", email: "hr.au@timez.com", registration: "ABN 51 824 753 556" },
  CA: { phone: "+1 416 555 0187", email: "hr.ca@timez.com", registration: "BN 81729 4563 RC0001" },
  AE: { phone: "+971 4 555 0193", email: "hr.ae@timez.com", registration: "DED Licence 784512" },
  SA: { phone: "+966 11 555 0174", email: "hr.sa@timez.com", registration: "CR 1010654321" },
  DE: { phone: "+49 30 5557 1290", email: "hr.de@timez.com", registration: "HRB 214587 B, Amtsgericht Charlottenburg" },
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
    countryCode: c,
    referenceNo: esc(meta.referenceNo),
    date: esc(letterDate(meta.date, c)),
    title: esc(b.title),
    toWhom: b.toWhom,
    addressee: b.toWhom ? "" : `<strong>${esc(fields.employeeName)}</strong><br>${esc(fields.title)}, ${esc(fields.department)}<br>Employee ID ${esc(fields.employeeCode)}`,
    salute: b.toWhom ? "To whom it may concern," : `Dear ${esc(fields.employeeName)},`,
    paragraphs,
    approval,
    signatory: meta.approval ? esc(meta.approval.by) : "",
    footer,
  });
}

/** The letterhead block: logo mark, brand, legal entity and contact lines. */
function letterhead(entity: string, address: string, countryCode: string): string {
  const contact = ENTITY_CONTACT[countryCode] ?? ENTITY_CONTACT.IN;
  return `<header class="lh">
  <div class="lh-brand">
    <div class="lh-mark" aria-hidden="true">TZ</div>
    <div>
      <div class="lh-name">TimeZ</div>
      <div class="lh-entity">${entity}</div>
    </div>
  </div>
  <div class="lh-contact">${address}<br>${esc(contact.phone)} · ${esc(contact.email)}<br>www.timez.com</div>
</header>
<div class="lh-rule" aria-hidden="true"></div>`;
}

/** The letter layout: TimeZ letterhead, ref and date, addressee, subject, body, signatory, registered office footer. */
export function letterShell(p: {
  entity: string;
  address: string;
  countryCode?: string;
  referenceNo: string;
  date: string;
  title: string;
  /** Certificates addressed "To whom it may concern" get a centred title; addressed letters a Subject line. */
  toWhom?: boolean;
  addressee: string;
  salute: string;
  paragraphs: string[];
  approval: string;
  /** The approver's name, printed above the signatory title (escaped). */
  signatory?: string;
  footer: string;
}): string {
  const c = p.countryCode || "IN";
  const contact = ENTITY_CONTACT[c] ?? ENTITY_CONTACT.IN;
  const heading = p.toWhom ? `<h1>${p.title}</h1>` : `<p class="subject"><span>Subject:</span> ${p.title}</p>`;
  return `${letterhead(p.entity, p.address, c)}
<table class="meta" role="presentation"><tr>
  <td><span class="k">Ref. No.</span> ${p.referenceNo}</td>
  <td class="r"><span class="k">Date</span> ${p.date}</td>
</tr></table>
${p.addressee ? `<div class="to"><span class="k">To</span>${p.addressee}</div>` : ""}
${heading}
<p class="salute">${p.salute}</p>
<div class="body">
${p.paragraphs.map((x) => `<p>${x}</p>`).join("\n")}
</div>
<p class="close">Yours sincerely,</p>
<div class="sign">
  <p class="for">For <strong>${p.entity}</strong></p>
  <div class="sign-line"></div>
  ${p.signatory ? `<p class="sig-name">${p.signatory}</p>` : ""}
  <p class="sig-title">Authorised Signatory<br>Human Resources</p>
  <p class="approval">${p.approval}</p>
</div>
<footer class="foot">
  <div><strong>Registered office:</strong> ${p.entity}, ${p.address}</div>
  <div>${esc(contact.registration)} · ${p.footer}</div>
  <div class="foot-note">This letter is issued electronically from TimeZ HRMS. Verify it with HR quoting the reference number above.</div>
</footer>`;
}

/** Backend preview: server paragraphs carry escaped values and <b> markup only; anything else is escaped. */
export function serverParagraph(p: string): string {
  return p.replace(/<(?!\/?b>|br\s*\/?>)/gi, "&lt;").replace(/<(\/?)b>/gi, "<$1strong>");
}

/** A full letter from the server's preview (fields + paragraphs), in the same layout as the PDF. */
export function serverLetterBody(
  preview: { title: string; paragraphs: string[]; fields: Record<string, string>; letter_type: string },
  meta: { referenceNo: string; date: string; approval: string; footer: string; ownText?: string; signatory?: string },
): string {
  const f = preview.fields;
  const c = f.country_code ?? "";
  const toWhom = TO_WHOM_TYPES.has(preview.letter_type);
  return letterShell({
    entity: esc(f.legal_entity ?? ""),
    address: esc(ENTITY_ADDRESS[c] ?? ENTITY_ADDRESS.IN),
    countryCode: c,
    referenceNo: esc(meta.referenceNo),
    date: esc(letterDate(meta.date, c)),
    title: esc(preview.title),
    toWhom,
    signatory: meta.signatory ? esc(meta.signatory) : "",
    addressee: toWhom ? "" : `<strong>${esc(f.employee_name ?? "")}</strong><br>${esc(f.title ?? "")}, ${esc(f.department ?? "")}<br>Employee ID ${esc(f.employee_code ?? "")}`,
    salute: toWhom ? "To whom it may concern," : `Dear ${esc(f.employee_name ?? "")},`,
    paragraphs: withOwnParagraph(preview.paragraphs.map(serverParagraph), meta.ownText ? esc(meta.ownText) : ""),
    approval: esc(meta.approval),
    footer: esc(meta.footer),
  });
}

/** Letters addressed "To whom it may concern" (the rest are addressed to the employee). */
const TO_WHOM_TYPES = new Set(["Employment", "Experience", "NOC", "Visa/Travel", "Address proof", "Internship", "Salary certificate", "Bonafide"]);

const PRINT_CSS = `
@page { size: A4; margin: 14mm 16mm 16mm; }
* { box-sizing: border-box; }
html, body { margin: 0; background: #fff; color: #1d2433; }
body { font: 11pt/1.6 Georgia, "Times New Roman", serif; }
.page { position: relative; max-width: 178mm; margin: 0 auto; min-height: 265mm; display: flex; flex-direction: column; }
.lh { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; padding-bottom: 10px; }
.lh-brand { display: flex; align-items: center; gap: 10px; }
.lh-mark { width: 38px; height: 38px; border-radius: 8px; background: #1d3d6e; color: #fff; display: grid; place-items: center; font: 700 13pt Arial, Helvetica, sans-serif; letter-spacing: .02em; }
.lh-name { font: 700 19pt/1.1 Arial, Helvetica, sans-serif; color: #1d3d6e; letter-spacing: .01em; }
.lh-entity { font: 600 9pt/1.3 Arial, Helvetica, sans-serif; color: #33415c; margin-top: 2px; }
.lh-contact { font: 8.5pt/1.45 Arial, Helvetica, sans-serif; color: #5a6475; text-align: right; max-width: 82mm; }
.lh-rule { height: 4px; border-top: 2px solid #1d3d6e; border-bottom: 1px solid #c9a227; margin-bottom: 16px; }
.meta { width: 100%; border-collapse: collapse; font: 9.5pt Arial, Helvetica, sans-serif; color: #1d2433; margin-bottom: 16px; }
.meta td { padding: 0; } .meta .r { text-align: right; }
.k { display: inline-block; font: 600 8pt Arial, Helvetica, sans-serif; color: #5a6475; text-transform: uppercase; letter-spacing: .06em; margin-right: 6px; }
.to { margin: 0 0 16px; font-size: 10.5pt; line-height: 1.5; }
.to .k { display: block; margin-bottom: 2px; }
h1 { font: 700 13pt Arial, Helvetica, sans-serif; text-align: center; text-transform: uppercase; letter-spacing: .08em; margin: 4px 0 18px; text-decoration: underline; text-underline-offset: 4px; }
.subject { font: 700 10.5pt Arial, Helvetica, sans-serif; margin: 0 0 14px; }
.subject span { text-decoration: underline; text-underline-offset: 3px; }
p { margin: 0 0 10px; }
.body p { text-align: justify; }
.salute { margin-bottom: 12px; }
.close { margin-top: 18px; }
.sign { margin-top: 6px; break-inside: avoid; }
.sign .for { margin-bottom: 0; }
.sign-line { width: 58mm; border-bottom: 1px solid #333; height: 16mm; margin-bottom: 6px; }
.sig-name { font-weight: 700; margin: 0; }
.sig-title { margin: 0; font-size: 10pt; color: #33415c; }
.approval { font: 8.5pt Arial, Helvetica, sans-serif; color: #1d3d6e; margin-top: 6px; }
.foot { margin-top: auto; padding-top: 10px; border-top: 1px solid #c9ced8; font: 7.8pt/1.5 Arial, Helvetica, sans-serif; color: #5a6475; text-align: center; }
.foot-note { color: #8a93a3; }
.watermark { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; z-index: 10; }
.watermark span { transform: rotate(-35deg); font: 700 110pt Arial, Helvetica, sans-serif; color: rgba(200, 40, 40, .13); letter-spacing: .1em; }
@media screen { body { background: #e9ecf1; padding: 20px 12px; } .page { background: #fff; padding: 14mm 16mm 12mm; max-width: 210mm; min-height: 297mm; box-shadow: 0 2px 10px rgba(0,0,0,.14); border-radius: 2px; } }
@media screen and (max-width: 640px) { .page { padding: 18px; min-height: 0; } .lh { flex-direction: column; align-items: flex-start; } .lh-contact { text-align: left; } }
@media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } .page { min-height: 265mm; } }
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
    countryCode: c,
    referenceNo: "Offer",
    date: esc(letterDate(letter.date, c)),
    title: esc(letter.title),
    addressee: `<strong>${esc(name)}</strong><br>${esc(f.title ?? "")}, ${esc(f.department ?? "")}`,
    salute: `Dear ${esc(name)},`,
    paragraphs: fromServer ? letter.paragraphs.map(serverParagraph) : letter.paragraphs,
    approval: "Approved by the hiring manager and HR",
    footer: "Accept or decline using the link you received.",
  });
}
