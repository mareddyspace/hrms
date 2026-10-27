import { todayISO } from "../../model.ts";
import { listPeople } from "../../data/peopleLocal.ts";
import {
  createLocalStore,
  daysBetween,
  isHr,
  newId,
  nowStamp,
  relDay,
  type ComplianceActor,
  type ComplianceResult,
} from "./shared.ts";

export const CASE_CATEGORIES = ["Grievance", "Harassment/POSH", "Discrimination", "Ethics/whistleblowing", "Safety"] as const;
export type CaseCategory = (typeof CASE_CATEGORIES)[number];
export type CaseStatus = "Open" | "Investigating" | "Resolved" | "Closed";

export const POSH_SLA_DAYS = 90;

/** Internal Committee for POSH cases. Members with an account can see and act on POSH cases. */
export const ICC_MEMBERS: { id?: string; name: string; seat: string }[] = [
  { id: "demo-hr-admin", name: "Farhan Ali", seat: "Presiding officer" },
  { name: "Kavitha Rao", seat: "External member" },
];

export type CaseEntry = {
  id: string;
  at: string;
  kind: "filed" | "status" | "note" | "comment";
  text: string;
  authorId: string;
  /** Shown instead of the author's name — "Reporter" for the reporter's own entries. */
  authorLabel: string;
  confidential: boolean;
  status?: CaseStatus;
};

export type CaseRecord = {
  id: string;
  /** Private code the reporter uses to look the case up. */
  code: string;
  category: CaseCategory;
  description: string;
  /** Stored for follow-up only — never shown in the UI. */
  reporterId: string;
  anonymous: boolean;
  againstId?: string;
  againstName?: string;
  createdOn: string;
  status: CaseStatus;
  resolution?: string;
  closedOn?: string;
  timeline: CaseEntry[];
};

type GrievanceState = { cases: CaseRecord[] };

function entry(at: string, kind: CaseEntry["kind"], text: string, authorId: string, authorLabel: string, confidential = false, status?: CaseStatus): CaseEntry {
  return { id: newId("ce"), at, kind, text, authorId, authorLabel, confidential, status };
}

function defaults(): GrievanceState {
  const workforce = listPeople().filter((p) => !p.id.startsWith("demo-") && !p.id.startsWith("emp-"));
  const w1 = workforce[3];
  const w2 = workforce[11];
  const w3 = workforce[17];
  const cases: CaseRecord[] = [
    {
      id: "gc-1",
      code: "CASE-4KQ7-M2XP",
      category: "Grievance",
      description: "On-call rota has put me on weekend duty four weekends in a row while others have none. I raised it in standup but nothing changed.",
      reporterId: "emp-mahesh",
      anonymous: false,
      createdOn: relDay(-20),
      status: "Investigating",
      timeline: [
        entry(`${relDay(-20)}T08:40:00.000Z`, "filed", "Case raised.", "emp-mahesh", "Reporter"),
        entry(`${relDay(-18)}T10:05:00.000Z`, "status", "Reviewing rota data for the last quarter.", "demo-hr-admin", "Farhan Ali", false, "Investigating"),
        entry(`${relDay(-15)}T12:30:00.000Z`, "note", "Rota tool shows 4 of the last 6 weekends assigned to the same engineer.", "demo-hr-admin", "Farhan Ali", true),
        entry(`${relDay(-14)}T09:00:00.000Z`, "comment", "Thanks — happy to share my calendar if useful.", "emp-mahesh", "Reporter"),
      ],
    },
    {
      id: "gc-2",
      code: "CASE-9TBR-3HWD",
      category: "Discrimination",
      description: "I was left out of the promotion shortlist after returning from parental leave, despite meeting every listed criterion.",
      reporterId: "emp-mahesh",
      anonymous: false,
      againstId: "emp-ram",
      againstName: "Ram Krishnan",
      createdOn: relDay(-6),
      status: "Open",
      timeline: [entry(`${relDay(-6)}T15:10:00.000Z`, "filed", "Case raised.", "emp-mahesh", "Reporter")],
    },
    {
      id: "gc-4",
      code: "CASE-6PLZ-8VNA",
      category: "Ethics/whistleblowing",
      description: "A vendor invoice for the office fit-out appears to have been split into smaller amounts to stay under the approval limit.",
      reporterId: "emp-ram",
      anonymous: true,
      createdOn: relDay(-30),
      status: "Investigating",
      timeline: [
        entry(`${relDay(-30)}T11:00:00.000Z`, "filed", "Case raised.", "emp-ram", "Reporter"),
        entry(`${relDay(-27)}T09:15:00.000Z`, "status", "Finance audit requested.", "demo-hr-admin", "Farhan Ali", false, "Investigating"),
      ],
    },
  ];
  if (w1 && w2) {
    cases.push({
      id: "gc-3",
      code: "CASE-2MFE-7QJC",
      category: "Harassment/POSH",
      description: "Repeated unwelcome comments about my appearance in team chats and during client visits, after I asked for it to stop.",
      reporterId: w1.id,
      anonymous: true,
      againstId: w2.id,
      againstName: w2.fullName,
      createdOn: relDay(-96),
      status: "Investigating",
      timeline: [
        entry(`${relDay(-96)}T07:30:00.000Z`, "filed", "Case raised.", w1.id, "Reporter"),
        entry(`${relDay(-92)}T10:00:00.000Z`, "status", "Referred to the Internal Committee.", "demo-hr-admin", "Farhan Ali", false, "Investigating"),
        entry(`${relDay(-60)}T14:00:00.000Z`, "note", "Two witness statements recorded; respondent hearing pending.", "demo-hr-admin", "Farhan Ali", true),
      ],
    });
  }
  if (w3) {
    cases.push({
      id: "gc-5",
      code: "CASE-5WYU-4GKS",
      category: "Safety",
      description: "Fire exit on level 3 is blocked by stored furniture most mornings.",
      reporterId: w3.id,
      anonymous: false,
      createdOn: relDay(-40),
      status: "Resolved",
      resolution: "Furniture moved to storage; facilities added the exit to the daily walk-round checklist.",
      closedOn: relDay(-33),
      timeline: [
        entry(`${relDay(-40)}T08:00:00.000Z`, "filed", "Case raised.", w3.id, "Reporter"),
        entry(`${relDay(-39)}T09:00:00.000Z`, "status", "Facilities notified.", "demo-hr-admin", "Farhan Ali", false, "Investigating"),
        entry(`${relDay(-33)}T16:00:00.000Z`, "status", "Furniture moved to storage; facilities added the exit to the daily walk-round checklist.", "demo-hr-admin", "Farhan Ali", false, "Resolved"),
      ],
    });
  }
  return { cases };
}

const store = createLocalStore<GrievanceState>("kastech.grievance.v2", defaults);

export const subscribeGrievance = store.subscribe;
export const getGrievanceState = store.getState;
export const resetGrievance = store.reset;
export const GRIEVANCE_KEY = store.key;

/* ───────────── Visibility ───────────── */

export function isPosh(c: Pick<CaseRecord, "category">): boolean {
  return c.category === "Harassment/POSH";
}

export function isIccMember(actorId: string): boolean {
  return ICC_MEMBERS.some((m) => m.id === actorId);
}

function isAgainst(actor: ComplianceActor, c: CaseRecord): boolean {
  return !!c.againstId && c.againstId === actor.id;
}

/** HR for every case; ICC members additionally for POSH. Never the reporter or the person named. */
export function canManageCase(actor: ComplianceActor, c: CaseRecord): boolean {
  if (isAgainst(actor, c) || c.reporterId === actor.id) return false;
  return isHr(actor.role) || (isPosh(c) && isIccMember(actor.id));
}

export function isReporter(actor: ComplianceActor, c: CaseRecord): boolean {
  return c.reporterId === actor.id && !isAgainst(actor, c);
}

export function canSeeCase(actor: ComplianceActor, c: CaseRecord): boolean {
  return isReporter(actor, c) || canManageCase(actor, c);
}

export function isCaseOpen(c: CaseRecord): boolean {
  return c.status === "Open" || c.status === "Investigating";
}

export function slaDueOn(c: CaseRecord): string | undefined {
  if (!isPosh(c)) return undefined;
  const [y, m, d] = c.createdOn.split("-").map(Number);
  const due = new Date(Date.UTC(y, m - 1, d + POSH_SLA_DAYS));
  return due.toISOString().slice(0, 10);
}

export function isSlaOverdue(c: CaseRecord, today = todayISO()): boolean {
  const due = slaDueOn(c);
  return !!due && isCaseOpen(c) && today > due;
}

export function slaDaysLeft(c: CaseRecord, today = todayISO()): number | undefined {
  const due = slaDueOn(c);
  return due ? daysBetween(today, due) : undefined;
}

/** What the reporter is allowed to see — no confidential notes. */
export function reporterTimeline(c: CaseRecord): CaseEntry[] {
  return c.timeline.filter((e) => !e.confidential);
}

/** Case looked up by private code. The person named in it never gets a result. */
export function findCaseByCode(actor: ComplianceActor, code: string): CaseRecord | undefined {
  const wanted = code.trim().toUpperCase();
  if (!wanted) return undefined;
  const found = getGrievanceState().cases.find((c) => c.code === wanted);
  return found && !isAgainst(actor, found) ? found : undefined;
}

/* ───────────── Mutations ───────────── */

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makeCode(existing: CaseRecord[]): string {
  for (;;) {
    const part = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
    const code = `CASE-${part()}-${part()}`;
    if (!existing.some((c) => c.code === code)) return code;
  }
}

export type CaseInput = { category: CaseCategory; description: string; againstId?: string; anonymous: boolean };

export function raiseCase(actor: ComplianceActor, input: CaseInput): { code: string } | { error: string } {
  let code = "";
  const error = store.guarded((s) => {
    if (!CASE_CATEGORIES.includes(input.category)) return "Choose a category.";
    const text = input.description.trim();
    if (text.length < 20) return "Describe what happened in at least 20 characters.";
    if (text.length > 4000) return "Keep the description under 4,000 characters.";
    let againstName: string | undefined;
    if (input.againstId) {
      if (input.againstId === actor.id) return "You cannot name yourself in a case.";
      const person = listPeople().find((p) => p.id === input.againstId);
      if (!person) return "Choose the person from the list.";
      againstName = person.fullName;
    }
    code = makeCode(s.cases);
    const at = nowStamp();
    s.cases.unshift({
      id: newId("gc"),
      code,
      category: input.category,
      description: text,
      reporterId: actor.id,
      anonymous: input.anonymous,
      againstId: input.againstId || undefined,
      againstName,
      createdOn: todayISO(),
      status: "Open",
      timeline: [entry(at, "filed", "Case raised.", actor.id, "Reporter")],
    });
    return null;
  });
  return error ? { error } : { code };
}

const TRANSITIONS: Record<CaseStatus, CaseStatus[]> = {
  Open: ["Investigating", "Closed"],
  Investigating: ["Resolved", "Closed"],
  Resolved: ["Closed"],
  Closed: [],
};

export function caseMoves(c: CaseRecord): CaseStatus[] {
  return TRANSITIONS[c.status];
}

export function setCaseStatus(actor: ComplianceActor, id: string, next: CaseStatus, note: string): ComplianceResult {
  return store.guarded((s) => {
    const row = s.cases.find((c) => c.id === id);
    if (!row) return "Case not found.";
    if (!canManageCase(actor, row)) return isPosh(row) ? "Only HR or the Internal Committee can update this case." : "Only HR can update this case.";
    if (!TRANSITIONS[row.status].includes(next)) return `A case cannot move from ${row.status} to ${next}.`;
    const text = note.trim();
    if (next === "Resolved" && text.length < 10) return "Add a resolution note (at least 10 characters).";
    if (next === "Closed" && row.status !== "Resolved" && text.length < 10) return "Add a reason for closing (at least 10 characters).";
    row.status = next;
    if (next === "Resolved") row.resolution = text;
    if (next === "Resolved" || next === "Closed") row.closedOn = todayISO();
    row.timeline.push(entry(nowStamp(), "status", text || `Moved to ${next}.`, actor.id, actor.fullName, false, next));
    return null;
  });
}

export function addCaseNote(actor: ComplianceActor, id: string, text: string, confidential: boolean): ComplianceResult {
  return store.guarded((s) => {
    const row = s.cases.find((c) => c.id === id);
    if (!row) return "Case not found.";
    const body = text.trim();
    if (body.length < 2) return "Write a note first.";
    if (body.length > 2000) return "Keep notes under 2,000 characters.";
    if (canManageCase(actor, row)) {
      row.timeline.push(entry(nowStamp(), "note", body, actor.id, actor.fullName, confidential));
      return null;
    }
    if (isReporter(actor, row)) {
      if (row.status === "Closed") return "This case is closed.";
      row.timeline.push(entry(nowStamp(), "comment", body, actor.id, "Reporter", false));
      return null;
    }
    return "You cannot comment on this case.";
  });
}

/** Reporter comment via private code (anonymous follow-up). */
export function addCommentByCode(actor: ComplianceActor, code: string, text: string): ComplianceResult {
  const found = findCaseByCode(actor, code);
  if (!found) return "No case found for that code.";
  return store.guarded((s) => {
    const row = s.cases.find((c) => c.id === found.id);
    if (!row) return "Case not found.";
    if (row.status === "Closed") return "This case is closed.";
    const body = text.trim();
    if (body.length < 2) return "Write a comment first.";
    if (body.length > 2000) return "Keep comments under 2,000 characters.";
    row.timeline.push(entry(nowStamp(), "comment", body, "", "Reporter", false));
    return null;
  });
}

/** Cases for the reporter's own data export (no confidential notes, no internal ids). */
export function casesForExport(personId: string) {
  return getGrievanceState()
    .cases.filter((c) => c.reporterId === personId && c.againstId !== personId)
    .map((c) => ({
      code: c.code,
      category: c.category,
      description: c.description,
      anonymous: c.anonymous,
      createdOn: c.createdOn,
      status: c.status,
      resolution: c.resolution,
      timeline: reporterTimeline(c).map(({ at, kind, text, status }) => ({ at, kind, text, status })),
    }));
}
