/**
 * Copilot "do" answers: letter drafts from templates and prepared self-service changes.
 * Nothing here writes data — the answer carries a draft or a form, and the person confirms it in the
 * chat (see CopilotExtras). Letters always go to approval; profile edits still need the OTP.
 */
import type { CopilotAction, CopilotAnswer, CopilotLetterDraft } from "../../data/platformData.ts";
import type { DemoAccount } from "../../demoAccounts.ts";
import type { PersonRecord } from "../../data/peopleData.ts";
import { appendAuditEntries } from "../../data/auditTrail.ts";
import { API_ENABLED } from "../../api/client.ts";
import { apiAuditAiAction } from "../../api/syncProfile.ts";
import { aiFeatureOn } from "../../data/aiSettings.ts";
import { canRequestType, previewLetter } from "../../data/letterService.ts";
import { FIELD_LABELS, type LetterFields } from "../../data/letterTemplates.ts";
import { canManageLetters } from "../../data/rbac.ts";
import { LETTER_TEMPLATES, letterTemplate, type CompHistoryRow, type LetterRequest, type LetterType } from "../../data/rewardData.ts";
import { addDaysISO, maskAddress, maskMobile, parseISODate, toISO, type LeaveCode } from "../../model.ts";
import { analyticsAnswer, isAnalyticsQuestion, plainText, type AnalyticsSources } from "./analytics.ts";

type Raw = CopilotAnswer;

/* ───────────── audit ───────────── */

/** "Copilot action" audit rows: one when Copilot prepares something, one when the person confirms it. */
export function logCopilotAction(
  stage: "Proposed" | "Confirmed" | "Cancelled",
  actor: { id: string; name: string },
  what: { action?: CopilotAction; letter?: CopilotLetterDraft },
  result?: string,
): void {
  // Backend mode: the server audit gets the action and stage, never the personal values.
  if (API_ENABLED) {
    const a = what.action;
    const name = a?.kind === "profile" ? `update_${a.field}` : a?.kind === "leave" ? "apply_leave" : what.letter ? "request_letter" : "other";
    const summary =
      a?.kind === "profile"
        ? a.field === "mobile" ? "Mobile number change" : "Address change"
        : a?.kind === "leave"
          ? `Leave request: ${a.codeName}`
          : what.letter
            ? `Letter: ${what.letter.label}`
            : "";
    void apiAuditAiAction(name, stage === "Proposed" ? "proposed" : stage === "Confirmed" ? "confirmed" : "cancelled", result ? `${summary} · ${result}` : summary);
  }
  const changes: { field: string; before: string; after: string }[] = [{ field: "status", before: stage === "Proposed" ? "—" : "Proposed", after: stage }];
  let subjectId = actor.id;
  if (what.action?.kind === "profile") {
    // Audit rows never hold the full number or address.
    const mask = (v: string) => (what.action?.kind === "profile" && what.action.field === "mobile" ? maskMobile(v) : maskAddress(v));
    changes.push({ field: what.action.field, before: mask(what.action.current), after: mask(what.action.proposed) || "—" });
  } else if (what.action?.kind === "leave") {
    const a = what.action;
    changes.push({ field: "leave", before: "—", after: `${a.codeName} · ${a.from || "?"}${a.to && a.to !== a.from ? ` to ${a.to}` : ""}${a.half ? ` · ${a.half} half` : ""}` });
  } else if (what.letter) {
    subjectId = what.letter.employeeId;
    changes.push({ field: "letter", before: "—", after: `${what.letter.label} for ${what.letter.employeeName}` });
  }
  if (result) changes.push({ field: "result", before: "—", after: result });
  appendAuditEntries([
    {
      at: new Date().toISOString(),
      actorId: actor.id,
      actorName: actor.name,
      entity: "Copilot action",
      entityId: `ca-${Date.now().toString(36)}`,
      subjectId,
      action: stage === "Proposed" ? "Created" : "Updated",
      changes,
    },
  ]);
}

/* ───────────── letters ───────────── */

const LETTER_WORDS: [RegExp, LetterType][] = [
  [/\bsalary revision|revision letter|increment letter|pay revision\b/, "Salary revision"],
  [/\bpromotion\b/, "Promotion"],
  [/\bexperience\b/, "Experience"],
  [/\breliev/, "Relieving"],
  [/\bappointment\b/, "Appointment"],
  [/\boffer letter\b/, "Offer"],
  [/\bconfirmation\b/, "Confirmation"],
  [/\btransfer\b/, "Transfer"],
  [/\bnoc\b|no objection/, "NOC"],
  [/\bvisa\b|\btravel letter\b/, "Visa/Travel"],
  [/\baddress proof\b|proof of address\b/, "Address proof"],
  [/\bemployment (certificate|letter|verification)\b|\bverification letter\b|\bbonafide\b|\bbona fide\b/, "Employment"],
];

const SELF_WORDS = /\b(me|myself|my|mine|i)\b/;

export interface LetterSources {
  viewer: DemoAccount;
  today: string;
  people: readonly PersonRecord[];
  history: CompHistoryRow[];
}

function findPeople(name: string, people: readonly PersonRecord[]): PersonRecord[] {
  const n = name.trim().toLowerCase();
  if (n.length < 2) return [];
  const live = people.filter((p) => p.fullName);
  const exact = live.filter((p) => p.fullName.toLowerCase() === n);
  if (exact.length) return exact;
  const starts = live.filter((p) => p.fullName.toLowerCase().startsWith(`${n} `) || p.fullName.toLowerCase().startsWith(n));
  if (starts.length) return starts;
  return live.filter((p) => p.fullName.toLowerCase().split(" ").includes(n));
}

/** Person named in "… letter for Babu", "Babu's experience letter", "promotion letter of Ram Krishnan". */
function namedIn(question: string): string | null {
  const q = question.toLowerCase().replace(/[’`]/g, "'");
  const poss = q.match(/\b([a-z][a-z.-]+(?: [a-z][a-z.-]+)?)'s (?:[a-z/ ]+ )?(?:letter|certificate|noc)\b/)?.[1];
  const after = q.match(/\b(?:for|of|to)\s+([a-z][a-z.-]+(?:\s+[a-z][a-z.-]+)?)\s*(?:[.?!,]|$|\s+(?:from|effective|with|on|dated|please|asap|today|tomorrow))/)?.[1];
  const pick = [after, poss].find((x) => x && !SELF_WORDS.test(x) && !/\b(him|her|them|travel|visa|passport|bank|loan|a|an|the|approval|purpose|employment|job|new|this|that)\b/.test(x));
  return pick?.trim() ?? null;
}

export function letterAnswer(question: string, src: LetterSources): Raw | null {
  const q = plainText(question);
  if (!/\b(letter|letters|certificate|noc|no objection)\b/.test(q)) return null;
  if (!/\b(prepare|draft|create|generate|write|make|need|want|issue|get|request|give|send|produce|can you|could you|please)\b/.test(q) && !/\b(letter|certificate|noc) (for|of)\b/.test(q)) return null;
  if (/\b(how do i|how to|where (do|can) i|status of|what is the status|track)\b/.test(q)) return null;

  const hr = canManageLetters(src.viewer);
  const type = LETTER_WORDS.find(([re]) => re.test(q))?.[1];
  const allowedTypes = LETTER_TEMPLATES.filter((t) => hr || t.employeeCanRequest).map((t) => t.label);
  if (!type) {
    return {
      kind: "text",
      summary: `Which letter do you need? I can prepare: ${allowedTypes.join(", ")}.`,
      links: [{ label: "Documents", to: "/documents" }],
    };
  }

  // Who the letter is for.
  const name = namedIn(question);
  const found = name ? findPeople(name, src.people) : [];
  let person: PersonRecord | undefined;
  // "NOC for higher studies": the words after "for" are a purpose, not a person.
  if (name && found.length) {
    if (!hr && !found.some((p) => p.id === src.viewer.id)) {
      return {
        kind: "text",
        denied: true,
        summary: "Only HR prepares letters for other people. You can request your own letters here.",
        links: [{ label: "Documents", to: "/documents" }],
      };
    }
    if (!hr) found.splice(0, found.length, ...found.filter((p) => p.id === src.viewer.id));
    if (found.length > 1) {
      return {
        kind: "text",
        summary: `More than one person matches "${name}": ${found.slice(0, 5).map((p) => p.fullName).join(", ")}. Which one?`,
      };
    }
    person = found[0];
  } else if (name && hr && !letterTemplate(type).detailsLabel) {
    return { kind: "text", summary: `I couldn't find "${name}" in the directory. Try their full name.`, links: [{ label: "Directory", to: "/directory" }] };
  } else {
    person = src.people.find((p) => p.id === src.viewer.id);
  }
  const employeeId = person?.id ?? src.viewer.id;
  const employeeName = person?.fullName ?? src.viewer.fullName;
  const self = employeeId === src.viewer.id;

  const blocked = canRequestType(src.viewer, type, employeeId);
  if (blocked) {
    return { kind: "text", denied: !self || !hr, summary: `${blocked}${self ? ` You can request: ${allowedTypes.join(", ")}.` : ""}`, links: [{ label: "Documents", to: "/documents" }] };
  }

  const template = letterTemplate(type);
  const row: LetterRequest = {
    id: "copilot-draft",
    employeeId,
    employeeName,
    type,
    status: "Draft",
    requestedBy: src.viewer.fullName,
    requestedById: src.viewer.id,
    requestedOn: src.today,
    note: "",
    previewBody: "",
  };
  const purpose = name && !found.length ? (question.match(/\b(?:for|to)\s+(.+)$/i)?.[1] ?? "").replace(/[.?!]+$/, "").trim().slice(0, 200) : "";
  const details = template.detailsLabel ? detailsIn(question) || purpose : "";
  const preview = previewLetter({ ...row, details: details || undefined }, src.history);
  const show: (keyof LetterFields)[] = ["employeeName", "employeeCode", "title", "department", "grade", "joiningDate", "manager", "countryName", "legalEntity"];
  if (type === "Experience" || type === "Relieving") show.push("lastWorkingDay");
  if (type === "Address proof") show.push("address");
  if (template.payLetter && hr) show.push("salary", "previousSalary");
  show.push("effectiveDate");
  const fields = show
    .filter((k) => preview.fields[k]?.trim())
    .map((k) => ({ label: FIELD_LABELS[k], value: k === "joiningDate" || k === "lastWorkingDay" || k === "effectiveDate" ? fmtLong(preview.fields[k]) : preview.fields[k] }));
  const missing = preview.missing.filter((m) => !(template.detailsLabel && m === template.detailsLabel && details));
  const draft: CopilotLetterDraft = {
    employeeId,
    employeeName,
    type,
    label: template.label,
    fields,
    missing,
    detailsLabel: template.detailsLabel,
    details: details || undefined,
    needsEffectiveDate: hr && missing.includes(FIELD_LABELS.effectiveDate),
  };
  return {
    kind: "text",
    summary: `I've prepared ${/^[aeiou]/i.test(template.label) ? "an" : "a"} ${template.label.toLowerCase()} for ${self ? "you" : employeeName} from the ${template.label} template.${missing.length ? ` Missing: ${missing.join(", ")}.` : " All required fields are filled."} Nothing is issued until it's approved.`,
    letterDraft: draft,
    links: [{ label: "Documents", to: "/documents" }],
  };
}

function detailsIn(question: string): string {
  const m = question.match(/\b(?:purpose(?: is)?|reason(?: is)?|destination(?: is)?|travel(?:ling)? to|trip to|going to|visiting|needed for|required for)\s*:?\s*(.+)$/i);
  return (m?.[1] ?? "").replace(/[.?!]+$/, "").trim().slice(0, 200);
}

function fmtLong(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? parseISODate(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : iso;
}

/* ───────────── prepared actions ───────────── */

export interface ActionSources {
  today: string;
  currentAddress: string;
  currentMobile: string;
  leaveRows: { code: string; name: string; available: number }[];
  /** True when the word is a colleague's first name (not the viewer's). */
  isPersonName?: (word: string) => boolean;
}

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Dates mentioned in the message, in the order they appear. */
export function datesIn(text: string, today: string): string[] {
  const q = ` ${text.toLowerCase().replace(/[,]/g, " ").replace(/\s+/g, " ")} `;
  const found: { at: number; iso: string }[] = [];
  const add = (at: number, iso: string) => found.push({ at, iso });
  const t = parseISODate(today);
  for (const m of q.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) add(m.index ?? 0, `${m[1]}-${m[2]}-${m[3]}`);
  for (const m of q.matchAll(/\bday after tomorrow\b/g)) add(m.index ?? 0, addDaysISO(today, 2));
  for (const m of q.matchAll(/\b(today|tonight)\b/g)) add(m.index ?? 0, today);
  for (const m of q.matchAll(/(?<!after )\btomorrow\b/g)) add(m.index ?? 0, addDaysISO(today, 1));
  for (const m of q.matchAll(/\b(next|this|coming|on)?\s?(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|sday|urday|rsday)?\b/g)) {
    const idx = DAYS.findIndex((d) => d.startsWith(m[2]));
    if (idx < 0) continue;
    let diff = (idx - t.getDay() + 7) % 7 || 7;
    // "next Friday" when Friday is still this week means the one after.
    const todayMon = (t.getDay() + 6) % 7;
    if (m[1] === "next" && todayMon + diff <= 6) diff += 7;
    add(m.index ?? 0, addDaysISO(today, diff));
  }
  const monthDay = (mon: string, day: string) => {
    const mi = MONTHS.findIndex((x) => mon.startsWith(x));
    const d = Number(day);
    if (mi < 0 || d < 1 || d > 31) return null;
    let y = t.getFullYear();
    const iso = toISO(new Date(y, mi, d));
    if (iso < addDaysISO(today, -60)) y += 1;
    return toISO(new Date(y, mi, d));
  };
  for (const m of q.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?(?: of)? (jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/g)) {
    const iso = monthDay(m[2], m[1]);
    if (iso) add(m.index ?? 0, iso);
  }
  for (const m of q.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]* (\d{1,2})(?:st|nd|rd|th)?\b/g)) {
    const iso = monthDay(m[1], m[2]);
    if (iso) add(m.index ?? 0, iso);
  }
  if (/\bnext week\b/.test(q)) {
    const mondayNext = addDaysISO(today, ((8 - t.getDay()) % 7) || 7);
    add(q.indexOf("next week"), mondayNext);
    add(q.indexOf("next week") + 1, addDaysISO(mondayNext, 4));
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.iso).filter((iso, i, all) => all.indexOf(iso) === i);
}

const CODE_WORDS: [RegExp, LeaveCode][] = [
  [/\b(sick|unwell|ill|fever|doctor|medical)\b/, "sick"],
  [/\b(wfh|work from home|working from home|remote)\b/, "wfh"],
  [/\b(comp off|compoff|compensatory)\b/, "comp_off"],
  [/\bcasual\b/, "casual"],
  [/\b(unpaid|lwp|loss of pay)\b/, "unpaid"],
  [/\b(bereavement|funeral)\b/, "bereavement"],
  [/\b(pto|annual|vacation|privilege|earned|holiday trip)\b/, "pto"],
];

export function actionAnswer(question: string, src: ActionSources): Raw | null {
  const q = plainText(question);
  const asksHow = /^ (how|where|what|when|can i|could i|do i|is it|why) /.test(q) && !/\b(apply|book)\b.*\b(for me|it)\b/.test(q);

  // Someone else's record.
  const other = q.match(/ (?:update|change) ([a-z]+)s (address|phone|mobile|number) /);
  if (other && !["my", "your", "our"].includes(other[1])) {
    return { kind: "text", denied: true, summary: "I can only prepare changes to your own profile. HR updates other people's records.", links: [{ label: "My profile", to: "/info" }] };
  }

  // Address.
  if (
    !asksHow &&
    (/ (moved|moving|relocated|shifted)( house| home)?( to| into)? /.test(q) && !/ moved to (a new )?(team|role|department|project|manager) /.test(q) ||
      / (new|change|changed|update|updated|correct) (my )?(home |postal |residential |current )?address /.test(q) ||
      / address (has )?(changed|is now|update) /.test(q))
  ) {
    const m = question.match(/(?:address(?: is| to)?(?: now)?|moved to|moving to|relocated to|shifted to|new address)\s*(?:is|:|-)?\s*(.+)$/i);
    let proposed = (m?.[1] ?? "").replace(/[.]+$/, "").trim();
    if (proposed.length < 6 || /^(a |an |the |my )?(new |different |another )?(address|place|house|home|flat|apartment|city|location)\b/i.test(proposed)) proposed = "";
    const action: CopilotAction = { kind: "profile", field: "address", current: src.currentAddress, proposed };
    return {
      kind: "text",
      summary: proposed
        ? "I've prepared an address change. Check it, verify with the code, then confirm."
        : "I've opened an address change. Enter the new address, verify with the code, then confirm.",
      action,
      links: [{ label: "My profile", to: "/info" }],
    };
  }

  // Phone.
  if (!asksHow && / (phone|mobile|cell|contact number|phone number|mobile number) /.test(q) && / (new|change|changed|update|updated|is now|switch|switched) /.test(q) && !/ (manager|hr|helpdesk|emergency) /.test(q)) {
    const digits = question.match(/\+?\d[\d\s-]{6,18}\d/)?.[0]?.replace(/-/g, " ").replace(/\s+/g, " ").trim() ?? "";
    const action: CopilotAction = { kind: "profile", field: "mobile", current: src.currentMobile, proposed: digits };
    return {
      kind: "text",
      summary: digits ? "I've prepared a mobile number change. Verify with the code, then confirm." : "I've opened a mobile number change. Enter the new number, verify with the code, then confirm.",
      action,
      links: [{ label: "My profile", to: "/info" }],
    };
  }

  // Leave.
  const sickToday = / (i am|im|feeling|i feel) (sick|unwell|ill|not well) /.test(q);
  const leaveWord = / (leave|leaves|day off|days off|time off|pto|wfh|work from home|sick day|vacation|comp off) /.test(q) || / (be|being|take|taking) (the day |a day )?off /.test(q);
  const verb = / (apply|book|take|taking|request|put in|need|want|log|mark|going to be|will be|be) /.test(q);
  const halfDay = / (half day|half a day|halfday) /.test(q);
  const dated = leaveWord && (halfDay || datesIn(question, src.today).length > 0) && !/ (taken|used|by|per|across|department|departments|team|company|everyone) /.test(q);
  if (!asksHow && ((leaveWord && (verb || dated)) || sickToday) && !/ (balance|policy|policies|rules|status|how many|approve|approved|reject|who|whos) /.test(q)) {
    const forWho = q.match(/ (?:apply|book|request) (?:a )?(?:leave |wfh )?for ([a-z]+) /)?.[1];
    if (forWho && src.isPersonName?.(forWho)) {
      return { kind: "text", denied: true, summary: "I can only apply leave for you. Each person applies for their own leave.", links: [{ label: "Leave", to: "/leave" }] };
    }
    const dates = datesIn(question, src.today);
    const from = dates[0] ?? (sickToday ? src.today : "");
    let to = dates[1] && dates[1] >= from ? dates[1] : from;
    const nDays = q.match(/ for (\d{1,2}|two|three|four|five) (working )?days /)?.[1];
    if (from && nDays && !dates[1]) {
      const n = { two: 2, three: 3, four: 4, five: 5 }[nDays as "two"] ?? Number(nDays);
      to = addDaysISO(from, Math.max(1, n) - 1);
    }
    const options = src.leaveRows.map((r) => ({ code: r.code as LeaveCode, name: r.name, available: r.available }));
    const named = sickToday ? "sick" : CODE_WORDS.find(([re]) => re.test(q))?.[1];
    const fallback = options.find((o) => o.code === "pto" && o.available > 0) ?? options.find((o) => o.code === "casual" && o.available > 0) ?? options.find((o) => o.available > 0) ?? options[0];
    const pick = options.find((o) => o.code === named) ?? fallback;
    if (!pick) return null;
    const half = halfDay || / (first|second) half /.test(q) ? (/ (afternoon|second half) /.test(q) ? "second" : "first") : undefined;
    const reason = (question.match(/\b(?:because(?: of)?|due to|reason(?: is)?:?|as I(?:'m| am| have))\s+(.+)$/i)?.[1] ?? "").replace(/[.]+$/, "").trim() || (pick.code === "sick" ? "Not feeling well" : "");
    const action: CopilotAction = { kind: "leave", code: pick.code, codeName: pick.name, from, to, half: from && from === to ? half : undefined, reason, options };
    const when = from ? (from === to ? fmtDay(from) : `${fmtDay(from)} to ${fmtDay(to)}`) : "";
    return {
      kind: "text",
      summary: from
        ? `I've prepared ${pick.name.toLowerCase()} for ${when}${action.half ? ` (${action.half} half)` : ""}. You have ${pick.available} day${pick.available === 1 ? "" : "s"} available. Check the details and confirm to apply.`
        : `I've opened a ${pick.name.toLowerCase()} request. Pick the dates, add a reason and confirm to apply.`,
      action,
      links: [{ label: "Leave", to: "/leave" }],
    };
  }
  return null;
}

function fmtDay(iso: string): string {
  return parseISODate(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

/* ───────────── combined ───────────── */

export interface AssistSources {
  analytics: () => AnalyticsSources;
  letters: () => LetterSources;
  actions: () => ActionSources;
}

/** The assist hook for CopilotContext: prepared actions, then letters, then analytics. */
export function buildAssist(src: AssistSources): (question: string) => Raw | null {
  return (question: string) => {
    const action = actionAnswer(question, src.actions());
    if (action) return action;
    if (aiFeatureOn("documentAssistant")) {
      const letter = letterAnswer(question, src.letters());
      if (letter) return letter;
    }
    if (aiFeatureOn("plainAnalytics")) {
      const analytics = analyticsAnswer(question, src.analytics());
      if (analytics) return analytics;
    } else if (isAnalyticsQuestion(question)) {
      return { kind: "text", summary: "Analytics questions are turned off in AI settings.", links: [{ label: "Analytics", to: "/analytics" }] };
    }
    return null;
  };
}
