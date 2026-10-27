/**
 * Question clean-up for Copilot: lower-case, strip punctuation, fix common typos and fold synonyms,
 * so "how many leavs i hav" and "nxt holliday" read like "how many leaves i have" / "next holiday".
 */

/** Frequent misspellings and chat shorthand → the word Copilot's rules look for. */
const TYPOS: Record<string, string> = {
  leav: "leave",
  leavs: "leaves",
  leves: "leaves",
  lave: "leave",
  laeve: "leave",
  leaev: "leave",
  levae: "leave",
  lv: "leave",
  lvs: "leaves",
  hav: "have",
  hv: "have",
  u: "you",
  ur: "your",
  r: "are",
  nxt: "next",
  nex: "next",
  hw: "how",
  hwo: "how",
  wat: "what",
  wht: "what",
  whats: "what is",
  wats: "what is",
  whos: "who is",
  wen: "when",
  whn: "when",
  tmrw: "tomorrow",
  tmr: "tomorrow",
  tomorow: "tomorrow",
  tommorow: "tomorrow",
  tommorrow: "tomorrow",
  "2day": "today",
  tday: "today",
  wk: "week",
  thx: "thanks",
  pls: "please",
  plz: "please",
  holliday: "holiday",
  hoilday: "holiday",
  holiady: "holiday",
  holidy: "holiday",
  holyday: "holiday",
  holidya: "holiday",
  hoilidays: "holidays",
  hollidays: "holidays",
  holidys: "holidays",
  holydays: "holidays",
  payslp: "payslip",
  paysilp: "payslip",
  pyslip: "payslip",
  salery: "salary",
  sallary: "salary",
  salry: "salary",
  manger: "manager",
  manegar: "manager",
  managr: "manager",
  mgr: "manager",
  boss: "manager",
  aproval: "approval",
  approvel: "approval",
  aprovals: "approvals",
  approvels: "approvals",
  apporval: "approval",
  aprove: "approve",
  pendng: "pending",
  pendin: "pending",
  attendence: "attendance",
  attendace: "attendance",
  atendance: "attendance",
  timesheat: "timesheet",
  timeshet: "timesheet",
  timesheeet: "timesheet",
  polcy: "policy",
  polici: "policy",
  policey: "policy",
  mandetory: "mandatory",
  mandatary: "mandatory",
  manditory: "mandatory",
  compulsory: "mandatory",
  cources: "courses",
  cource: "course",
  coures: "courses",
  traning: "training",
  trainning: "training",
  sik: "sick",
  seek: "sick",
  casul: "casual",
  shfit: "shift",
  shif: "shift",
  heacount: "headcount",
  hedcount: "headcount",
  attriton: "attrition",
  atrition: "attrition",
  balence: "balance",
  balanace: "balance",
  remaning: "remaining",
  remainig: "remaining",
  availble: "available",
  avalable: "available",
  emplyees: "employees",
  employes: "employees",
  joinee: "joiner",
  joinees: "joiners",
  gaols: "goals",
  calender: "calendar",
  decemeber: "december",
  decmber: "december",
  novmber: "november",
  janurary: "january",
  feburary: "february",
  sept: "september",
};

/** Multi-word synonyms folded to one phrase the rules know. Order matters: longer phrases first. */
const PHRASES: [RegExp, string][] = [
  [/\btime ?off\b/g, "leave"],
  [/\bdays? off\b/g, "leave"],
  [/\bannual leaves?\b/g, "pto"],
  [/\bprivilege leaves?\b/g, "pto"],
  [/\bearned leaves?\b/g, "pto"],
  [/\bvacations?\b/g, "pto"],
  [/\bpaid time off\b/g, "pto"],
  [/\bsalary slips?\b/g, "payslip"],
  [/\bpay ?slips?\b/g, "payslip"],
  [/\bpay ?stubs?\b/g, "payslip"],
  [/\bpay ?checks?\b/g, "payslip"],
  [/\bwage slips?\b/g, "payslip"],
  [/\btake ?home\b/g, "net pay"],
  [/\bin hand\b/g, "net pay"],
  [/\bwork from home\b/g, "wfh"],
  [/\bcomp ?offs?\b/g, "comp off"],
  [/\bcompensatory off\b/g, "comp off"],
  [/\bloss of pay\b/g, "unpaid"],
  [/\blwp\b/g, "unpaid"],
  [/\blop\b/g, "unpaid"],
  [/\bhow much\b/g, "how many"],
  [/\bhow many no of\b/g, "how many"],
  [/\bno of\b/g, "how many"],
  [/\bnumber of\b/g, "how many"],
  [/\bcount of\b/g, "how many"],
  [/\bhead count\b/g, "headcount"],
  [/\bjoined\b/g, "joiners"],
  [/\bnew hires?\b/g, "joiners"],
  [/\bnew joiners?\b/g, "joiners"],
  [/\bopen (?:roles|positions?|jobs?|reqs?|requisitions?|vacanc(?:y|ies))\b/g, "open positions"],
  [/\bvacanc(?:y|ies)\b/g, "open positions"],
  [/\bjob openings?\b/g, "open positions"],
  [/\bregularis(?:e|ation)\b/g, "attendance correction"],
  [/\bregulariz(?:e|ation)\b/g, "attendance correction"],
  [/\bmissed (?:check ?out|punch|check ?in)\b/g, "attendance correction"],
];

/** Words worth fuzzy-correcting (one edit away) when no exact typo entry exists. */
const VOCAB = [
  "leave", "leaves", "holiday", "holidays", "payslip", "salary", "manager", "approval", "approvals", "pending",
  "attendance", "timesheet", "policy", "mandatory", "courses", "training", "balance", "remaining", "available",
  "headcount", "attrition", "shift", "goals", "learning", "december", "november", "january", "february",
  "september", "october", "reports", "deductions", "correction", "performance", "review", "expense", "expenses",
];

function oneEditAway(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    // Adjacent swap ("hloiday") counts as one edit.
    if (la === lb && a[i + 1] === b[j] && a[i] === b[j + 1]) {
      i += 2;
      j += 2;
      continue;
    }
    if (la > lb) i++;
    else if (lb > la) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (la - i) + (lb - j) <= 1;
}

function fixWord(word: string): string {
  if (TYPOS[word]) return TYPOS[word];
  if (word.length < 5 || VOCAB.includes(word)) return word;
  // Plurals and stems ("report" / "reports") are real words, not typos.
  const near = VOCAB.find((v) => Math.abs(v.length - word.length) <= 1 && !v.startsWith(word) && !word.startsWith(v) && oneEditAway(word, v));
  return near ?? word;
}

/** Normalised question: lower case, no punctuation, typos fixed, synonyms folded. */
export function normalizeQuestion(question: string): string {
  let q = question
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/\b(\w+)'s\b/g, "$1s")
    .replace(/'/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  q = q
    .split(" ")
    .map(fixWord)
    .join(" ");
  for (const [re, to] of PHRASES) q = q.replace(re, to);
  return q.replace(/\s+/g, " ").trim();
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_SHORT = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** 1–12 when the question names a month ("holidays in dec"), else null. "may" only counts after in/during/for. */
export function monthIn(q: string): number | null {
  for (let i = 0; i < 12; i++) {
    if (i === 4) {
      if (/\b(?:in|during|for|of|on) may\b/.test(q)) return 5;
      continue;
    }
    if (new RegExp(`\\b(?:${MONTHS[i]}|${MONTH_SHORT[i]})\\b`).test(q)) return i + 1;
  }
  return null;
}

/** True when any listed word or phrase appears as whole words. */
export function hasWord(q: string, words: readonly string[]): boolean {
  return words.some((w) => new RegExp(`(?:^|\\s)${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`).test(q));
}
