import { todayISO } from "../../model.ts";
import { API_ENABLED, subscribeAll } from "../../api/syncOps.ts";
import { privacyApi, privacyMirror, type HistoryEntry } from "../../api/syncExperience.ts";
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

export const CONSENT_TOPICS = [
  { key: "directory-photo", label: "Use my photo in the directory" },
  { key: "birthday-team", label: "Share my birthday with my team" },
  { key: "comms-emails", label: "Marketing and internal communication emails" },
  { key: "ai-recommendations", label: "Include me in AI recommendations" },
  { key: "alumni-network", label: "Keep me in the alumni network after I leave" },
] as const;
export type ConsentKey = (typeof CONSENT_TOPICS)[number]["key"];

export type ConsentEvent = { id: string; personId: string; key: ConsentKey; granted: boolean; at: string };

export const REQUEST_TYPES = ["Access", "Correction", "Deletion"] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];
/**
 * "Closed (manual)": a correction or deletion that HR carried out by hand outside this app —
 * closing it here does not change any data itself.
 */
export type RequestStatus = "Open" | "In progress" | "Completed" | "Closed (manual)" | "Rejected" | "Withdrawn";

export const REQUEST_DUE_DAYS = 30;

export type DataRequest = {
  id: string;
  personId: string;
  type: RequestType;
  details: string;
  createdOn: string;
  dueOn: string;
  status: RequestStatus;
  handledById?: string;
  closedOn?: string;
  outcome?: string;
  /* Backend mode only. */
  personName?: string;
  countryCode?: string;
  handledByName?: string;
  history?: HistoryEntry[];
  canHandle?: boolean;
};

export type RetentionUnit = "months" | "years";
export type RetentionRule = { id: string; category: string; period: number; unit: RetentionUnit; legalBasis: string; updatedOn: string };

type PrivacyState = { consents: ConsentEvent[]; requests: DataRequest[]; retention: RetentionRule[] };

function defaults(): PrivacyState {
  return {
    consents: [
      { id: "cs-1", personId: "emp-mahesh", key: "directory-photo", granted: true, at: `${relDay(-180)}T09:12:00.000Z` },
      { id: "cs-2", personId: "emp-mahesh", key: "birthday-team", granted: true, at: `${relDay(-180)}T09:12:30.000Z` },
      { id: "cs-3", personId: "emp-mahesh", key: "comms-emails", granted: true, at: `${relDay(-180)}T09:13:00.000Z` },
      { id: "cs-4", personId: "emp-mahesh", key: "comms-emails", granted: false, at: `${relDay(-40)}T14:02:00.000Z` },
      { id: "cs-6", personId: "emp-priya", key: "directory-photo", granted: true, at: `${relDay(-200)}T09:12:00.000Z` },
      { id: "cs-7", personId: "emp-priya", key: "birthday-team", granted: true, at: `${relDay(-200)}T09:12:30.000Z` },
      { id: "cs-8", personId: "emp-oliver", key: "directory-photo", granted: true, at: `${relDay(-150)}T09:12:00.000Z` },
      { id: "cs-9", personId: "emp-oliver", key: "comms-emails", granted: false, at: `${relDay(-150)}T09:13:00.000Z` },
      { id: "cs-5", personId: "emp-ram", key: "directory-photo", granted: true, at: `${relDay(-300)}T10:00:00.000Z` },
    ],
    requests: [
      {
        id: "dsr-1",
        personId: "emp-mahesh",
        type: "Correction",
        details: "Date of joining on my profile should be 15 Apr 2019.",
        createdOn: relDay(-12),
        dueOn: relDay(18),
        status: "In progress",
        handledById: "demo-hr-admin",
      },
      {
        id: "dsr-2",
        personId: "emp-ram",
        type: "Access",
        details: "Copy of my performance review history.",
        createdOn: relDay(-34),
        dueOn: relDay(-4),
        status: "Open",
      },
      {
        id: "dsr-3",
        personId: "demo-admin",
        type: "Deletion",
        details: "Remove my old home address from the directory.",
        createdOn: relDay(-60),
        dueOn: relDay(-30),
        status: "Closed (manual)",
        handledById: "demo-hr-admin",
        closedOn: relDay(-45),
        outcome: "Old address removed from all records.",
      },
    ],
    retention: [
      { id: "rt-1", category: "Payroll and tax records", period: 8, unit: "years", legalBasis: "Legal obligation", updatedOn: "2026-01-10" },
      { id: "rt-2", category: "Recruitment — unsuccessful candidates", period: 6, unit: "months", legalBasis: "Legitimate interest", updatedOn: "2026-01-10" },
      { id: "rt-3", category: "Employee personnel file", period: 6, unit: "years", legalBasis: "Contract", updatedOn: "2026-01-10" },
      { id: "rt-4", category: "Immigration and right-to-work documents", period: 2, unit: "years", legalBasis: "Legal obligation", updatedOn: "2026-01-10" },
      { id: "rt-5", category: "Grievance and POSH case files", period: 5, unit: "years", legalBasis: "Legal obligation", updatedOn: "2026-01-10" },
      { id: "rt-6", category: "CCTV and access logs", period: 30, unit: "months", legalBasis: "Legitimate interest", updatedOn: "2026-01-10" },
    ],
  };
}

const store = createLocalStore<PrivacyState>("kastech.privacy.v1", defaults);

let apiCache: { source: unknown; state: PrivacyState } | null = null;

/** Backend mode: my consents and requests, HR's queue and the retention policy, in the local state's shape. */
function apiState(): PrivacyState {
  const source = privacyMirror.get();
  if (apiCache?.source === source) return apiCache.state;
  const me = source.me;
  const toRequest = (r: (typeof source.mine)[number]): DataRequest => ({
    id: r.id,
    personId: r.employee_id,
    type: r.kind,
    details: r.details,
    createdOn: r.created_on,
    dueOn: r.due_on,
    status: r.status as RequestStatus,
    closedOn: r.closed_on ?? undefined,
    outcome: r.outcome ?? undefined,
    personName: r.employee_name,
    countryCode: r.country_code,
    handledByName: r.handled_by_name ?? undefined,
    history: r.history,
    canHandle: r.can_handle,
  });
  const byId = new Map<string, DataRequest>();
  for (const r of [...source.mine, ...source.queue]) byId.set(r.id, toRequest(r));
  const state: PrivacyState = {
    consents: source.history
      .filter((c) => c.at)
      .map((c, i) => ({ id: `api-cs-${i}`, personId: me, key: c.topic as ConsentKey, granted: c.granted, at: c.at as string })),
    requests: [...byId.values()],
    retention: source.retention.map((r) => ({ id: r.id, category: r.category, period: r.period, unit: r.unit, legalBasis: r.legal_basis, updatedOn: r.updated_on })),
  };
  apiCache = { source, state };
  return state;
}

export const subscribePrivacy = API_ENABLED ? subscribeAll(store.subscribe, privacyMirror.subscribe) : store.subscribe;
export const getPrivacyState: () => PrivacyState = API_ENABLED ? apiState : store.getState;
export const resetPrivacy = store.reset;
export const PRIVACY_KEY = store.key;

/* ───────────── Consents ───────────── */

/** Latest choice per topic; consent is opt-in, so no record means "off". */
export function currentConsents(state: PrivacyState, personId: string): Record<ConsentKey, ConsentEvent | undefined> {
  const out = {} as Record<ConsentKey, ConsentEvent | undefined>;
  for (const topic of CONSENT_TOPICS) out[topic.key] = undefined;
  for (const event of state.consents) {
    if (event.personId !== personId) continue;
    const prev = out[event.key];
    if (!prev || event.at >= prev.at) out[event.key] = event;
  }
  return out;
}

export function setConsent(actor: ComplianceActor, key: ConsentKey, granted: boolean): ComplianceResult | Promise<ComplianceResult> {
  if (API_ENABLED) return privacyApi.consent(key, granted);
  return store.guarded((s) => {
    if (!CONSENT_TOPICS.some((t) => t.key === key)) return "Unknown consent topic.";
    const current = currentConsents(s, actor.id)[key];
    if ((current?.granted ?? false) === granted) return null;
    s.consents.push({ id: newId("cs"), personId: actor.id, key, granted, at: nowStamp() });
    return null;
  });
}

/* ───────────── Data requests ───────────── */

const CLOSED: RequestStatus[] = ["Completed", "Closed (manual)", "Rejected", "Withdrawn"];

/** Access requests are fulfilled by the data export; corrections and deletions are done by hand. */
export function closesManually(type: RequestType): boolean {
  return type !== "Access";
}

export function isRequestOpen(req: DataRequest): boolean {
  return !CLOSED.includes(req.status);
}

export function isRequestOverdue(req: DataRequest, today = todayISO()): boolean {
  return isRequestOpen(req) && today > req.dueOn;
}

export function daysLeft(req: DataRequest, today = todayISO()): number {
  return daysBetween(today, req.dueOn);
}

export function canHandleRequest(actor: ComplianceActor, req: DataRequest): boolean {
  if (req.canHandle !== undefined) return req.canHandle || (req.personId !== actor.id && !isRequestOpen(req) && isHr(actor.role));
  return isHr(actor.role) && req.personId !== actor.id;
}

export function raiseRequest(actor: ComplianceActor, type: RequestType, details: string): ComplianceResult | Promise<ComplianceResult> {
  if (API_ENABLED) return privacyApi.raise(type, details);
  return store.guarded((s) => {
    if (!REQUEST_TYPES.includes(type)) return "Choose a request type.";
    const text = details.trim();
    if (type !== "Access" && text.length < 10) return `Describe what needs ${type === "Correction" ? "correcting" : "deleting"} (at least 10 characters).`;
    if (text.length > 1000) return "Keep details under 1,000 characters.";
    if (s.requests.some((r) => r.personId === actor.id && r.type === type && isRequestOpen(r))) {
      return `You already have an open ${type.toLowerCase()} request.`;
    }
    const today = todayISO();
    s.requests.unshift({
      id: newId("dsr"),
      personId: actor.id,
      type,
      details: text,
      createdOn: today,
      dueOn: relDay(REQUEST_DUE_DAYS),
      status: "Open",
    });
    return null;
  });
}

export function withdrawRequest(actor: ComplianceActor, id: string): ComplianceResult | Promise<ComplianceResult> {
  if (API_ENABLED) return privacyApi.withdraw(id);
  return store.guarded((s) => {
    const row = s.requests.find((r) => r.id === id);
    if (!row) return "Request not found.";
    if (row.personId !== actor.id) return "Only the requester can withdraw a request.";
    if (!isRequestOpen(row)) return `This request is already ${row.status.toLowerCase()}.`;
    row.status = "Withdrawn";
    row.closedOn = todayISO();
    return null;
  });
}

export function moveRequest(actor: ComplianceActor, id: string, next: "In progress" | "Completed" | "Rejected", outcome = ""): ComplianceResult | Promise<ComplianceResult> {
  if (API_ENABLED) return privacyApi.move(id, next, outcome);
  return store.guarded((s) => {
    const row = s.requests.find((r) => r.id === id);
    if (!row) return "Request not found.";
    if (!canHandleRequest(actor, row)) return row.personId === actor.id ? "You cannot handle your own request." : "Only HR can handle data requests.";
    if (!isRequestOpen(row)) return `This request is already ${row.status.toLowerCase()}.`;
    if (next === "In progress") {
      if (row.status !== "Open") return "Only open requests can be started.";
    } else if (row.status !== "In progress") {
      return "Start the request before closing it.";
    }
    if (next === "Rejected" && outcome.trim().length < 5) return "Give a reason for rejecting the request.";
    if (next === "Completed" && closesManually(row.type) && outcome.trim().length < 5) {
      return "Say what was changed, and where.";
    }
    row.status = next === "Completed" && closesManually(row.type) ? "Closed (manual)" : next;
    row.handledById = actor.id;
    if (next !== "In progress") {
      row.closedOn = todayISO();
      row.outcome = outcome.trim() || undefined;
    }
    return null;
  });
}

/* ───────────── Retention ───────────── */

export type RetentionInput = { category: string; period: number; unit: RetentionUnit; legalBasis: string };

function validateRule(input: RetentionInput, rules: RetentionRule[], editingId?: string): ComplianceResult {
  const category = input.category.trim();
  if (!category) return "Enter a data category.";
  if (!Number.isFinite(input.period) || !Number.isInteger(input.period) || input.period <= 0) return "Retention period must be a whole number greater than 0.";
  if (input.unit === "years" ? input.period > 100 : input.period > 1200) return "Retention period is too long — check the value.";
  if (input.unit !== "months" && input.unit !== "years") return "Choose months or years.";
  if (!input.legalBasis.trim()) return "Choose a legal basis.";
  if (rules.some((r) => r.id !== editingId && r.category.trim().toLowerCase() === category.toLowerCase())) return "This data category already has a rule.";
  return null;
}

export function saveRetentionRule(actor: ComplianceActor, input: RetentionInput, id?: string): ComplianceResult | Promise<ComplianceResult> {
  if (API_ENABLED) {
    const error = validateRule(input, getPrivacyState().retention, id);
    return error ?? privacyApi.saveRetention(input, id);
  }
  return store.guarded((s) => {
    if (!isHr(actor.role)) return "Only HR can change retention policy.";
    const error = validateRule(input, s.retention, id);
    if (error) return error;
    const patch = { category: input.category.trim(), period: input.period, unit: input.unit, legalBasis: input.legalBasis.trim(), updatedOn: todayISO() };
    if (id) {
      const row = s.retention.find((r) => r.id === id);
      if (!row) return "Rule not found.";
      Object.assign(row, patch);
    } else {
      s.retention.push({ id: newId("rt"), ...patch });
    }
    return null;
  });
}

export function removeRetentionRule(actor: ComplianceActor, id: string): ComplianceResult | Promise<ComplianceResult> {
  if (API_ENABLED) return privacyApi.removeRetention(id);
  return store.guarded((s) => {
    if (!isHr(actor.role)) return "Only HR can change retention policy.";
    if (!s.retention.some((r) => r.id === id)) return "Rule not found.";
    s.retention = s.retention.filter((r) => r.id !== id);
    return null;
  });
}
