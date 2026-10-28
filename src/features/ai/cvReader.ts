import { findSkills } from "./skillVocab.ts";

export type CvFields = {
  name: string;
  email: string;
  phone: string;
  experienceYears: number | null;
  currentTitle: string;
  currentCompany: string;
  education: string[];
  /** Skills in the company skills library. */
  librarySkills: string[];
  /** Other skills we recognised. */
  otherSkills: string[];
};

const DEGREE = /\b(ph\.?d|doctorate|m\.?b\.?a|master'?s?|m\.?sc|m\.?s\b|m\.?tech|m\.?e\b|m\.?a\b|bachelor'?s?|b\.?sc|b\.?s\b|b\.?tech|b\.?e\b|b\.?a\b|b\.?com|bca|mca|diploma|degree|university|college)/i;
const HEADINGS = /^(curriculum vitae|resume|résumé|cv|profile|summary|experience|work experience|employment|education|skills|contact|projects|certifications?)\s*:?$/i;
const PRESENT = /\b(present|current|now|till date|to date)\b/i;
const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec";

function clean(line: string): string {
  return line.replace(/^[\s•\-*·|]+/, "").replace(/\s+/g, " ").trim();
}

function findName(lines: string[]): string {
  for (const l of lines) {
    const m = l.match(/^(?:name|full name)\s*[:\-]\s*(.+)$/i);
    if (m) return m[1].trim();
  }
  for (const l of lines.slice(0, 6)) {
    if (HEADINGS.test(l) || /@|\d|http/i.test(l)) continue;
    const words = l.split(" ");
    if (words.length >= 2 && words.length <= 4 && words.every((w) => /^[A-Z][A-Za-z'’.-]*$/.test(w))) return l;
  }
  return "";
}

function findPhone(text: string): string {
  const m = text.match(/(\+?\d[\d\s().-]{7,}\d)/g) ?? [];
  // Skip year ranges like "2018 - 2021".
  const hit = m.find((p) => p.replace(/\D/g, "").length >= 9 && !/^\s*(19|20)\d{2}\s*[-–]\s*(19|20)\d{2}\s*$/.test(p));
  return hit ? hit.trim() : "";
}

/** Stated years ("8+ years"), otherwise the span from the earliest job start to today or the latest end. */
function findYears(text: string, thisYear: number): number | null {
  const stated = [...text.matchAll(/(\d{1,2})\s*\+?\s*(?:years?|yrs?)(?:\s+of)?(?:\s+\w+){0,3}\s+experience/gi)].map((m) => Number(m[1]));
  const loose = [...text.matchAll(/(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b/gi)].map((m) => Number(m[1]));
  const best = stated.length ? Math.max(...stated) : NaN;
  if (!Number.isNaN(best) && best < 50) return best;
  const ranges = [
    ...text.matchAll(new RegExp(`(?:(?:${MONTHS})[a-z]*\\.?\\s+)?((?:19|20)\\d{2})\\s*(?:-|–|—|to)\\s*(?:(?:${MONTHS})[a-z]*\\.?\\s+)?((?:19|20)\\d{2}|present|current|now|till date|to date)`, "gi")),
  ];
  // Ignore education years where possible: ranges on lines with degree words.
  const work = ranges.filter((m) => {
    const start = text.lastIndexOf("\n", m.index ?? 0);
    const end = text.indexOf("\n", m.index ?? 0);
    return !DEGREE.test(text.slice(start + 1, end < 0 ? undefined : end));
  });
  if (work.length) {
    const starts = work.map((m) => Number(m[1]));
    const ends = work.map((m) => (/^\d/.test(m[2]) ? Number(m[2]) : thisYear));
    const span = Math.max(...ends) - Math.min(...starts);
    if (span >= 0 && span < 50) return span;
  }
  if (loose.length && Math.max(...loose) < 50) return Math.max(...loose);
  return null;
}

function splitRole(line: string): { title: string; company: string } {
  const noDates = line
    .replace(new RegExp(`\\(?\\s*(?:(?:${MONTHS})[a-z]*\\.?\\s+)?(?:19|20)\\d{2}.*$`, "i"), "")
    .replace(PRESENT, "")
    .replace(/[\s,|–—-]+$/, "")
    .trim();
  const parts = noDates.split(/\s+at\s+|\s+@\s+|\s+[|–—-]\s+|,\s+/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) return { title: parts[0], company: parts[1] };
  return { title: parts[0] ?? "", company: "" };
}

function findCurrentRole(lines: string[]): { title: string; company: string } {
  for (const l of lines) {
    const m = l.match(/^(?:current (?:role|title|position)|designation|title)\s*[:\-]\s*(.+)$/i);
    if (m) return splitRole(m[1]);
  }
  const companyLine = lines.find((l) => /^(?:current )?(?:company|employer)\s*[:\-]/i.test(l));
  const withPresent = lines.find((l) => PRESENT.test(l) && !DEGREE.test(l) && /[a-z]/i.test(l.replace(PRESENT, "")));
  if (withPresent) {
    const role = splitRole(withPresent);
    // "Jan 2021 – Present" on its own line: the role is on the line above.
    if (!role.title) {
      const i = lines.indexOf(withPresent);
      if (i > 0) return splitRole(lines[i - 1]);
    }
    if (!role.company && companyLine) role.company = companyLine.split(/[:\-]/).slice(1).join("-").trim();
    return role;
  }
  if (companyLine) return { title: "", company: companyLine.split(/[:\-]/).slice(1).join("-").trim() };
  return { title: "", company: "" };
}

/** Pull candidate details out of pasted CV text. Rules only; every field is a suggestion. */
export function readCv(text: string, thisYear = new Date().getFullYear()): CvFields {
  const lines = text.split(/\r?\n/).map(clean).filter(Boolean);
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? "";
  const skills = findSkills(text);
  const role = findCurrentRole(lines);
  const education = lines.filter((l) => DEGREE.test(l) && !/@/.test(l) && l.length < 160 && !HEADINGS.test(l)).slice(0, 3);
  let name = findName(lines);
  if (!name && email) {
    name = email
      .split("@")[0]
      .split(/[._-]+/)
      .filter((w) => /^[a-z]+$/i.test(w))
      .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
      .join(" ");
  }
  return {
    name,
    email: email.toLowerCase(),
    phone: findPhone(text),
    experienceYears: findYears(text, thisYear),
    currentTitle: role.title.slice(0, 80),
    currentCompany: role.company.slice(0, 80),
    education,
    librarySkills: skills.filter((s) => s.libraryId).map((s) => s.name),
    otherSkills: skills.filter((s) => !s.libraryId).map((s) => s.name),
  };
}
