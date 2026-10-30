/**
 * Software catalogue and licences: browser store (local mode) or the backend (/software, VITE_API_URL mode).
 * Titles that need approval go Manager → IT; the rest are granted straight away while seats last.
 */
import { api, API_ENABLED, apiRequest } from "../../api/client.ts";
import { apiRun, createApiMirror } from "../../api/syncOps.ts";
import { todayISO, uid } from "../../model.ts";
import { addMonthsISO } from "../lifecycle/lifecycleShared.ts";
import { loadScopes, stepsFromApi } from "./cashStore.ts";
import { createLocalStore } from "./localStore.ts";
import { buildSteps, canActOnStep, decideStep, isItRole, stepViews, waitingStatus, type Actor, type FlowStep, type StepView } from "./rules.ts";

export interface SoftwareTitle {
  id: string;
  name: string;
  category: string;
  vendor: string;
  monthlyCost: number;
  currency: string;
  needsApproval: boolean;
  /** 0 = unlimited. */
  seats: number;
  seatsUsed: number;
  active: boolean;
}

export type SoftwareStatus = "Submitted" | "Manager approved" | "Active" | "Rejected" | "Withdrawn" | "Returned" | "Revoked" | "Expired";

export interface SoftwareView {
  id: string;
  employeeId: string;
  employeeName: string;
  titleId: string;
  titleName: string;
  category: string;
  monthlyCost: number;
  currency: string;
  reason: string;
  durationMonths: number | null;
  status: SoftwareStatus;
  submittedOn: string;
  assignedOn?: string;
  expiresOn?: string;
  endedOn?: string;
  endedBy?: string;
  licenceKey?: string;
  direct: boolean;
  steps: StepView[];
  canDecide: boolean;
  canWithdraw: boolean;
  canReturn: boolean;
  canRevoke: boolean;
}

const CATALOGUE: Omit<SoftwareTitle, "seatsUsed">[] = [
  ["sw-slack", "Slack", "Communication", "Salesforce", 8.75, false, 0],
  ["sw-zoom", "Zoom Pro", "Communication", "Zoom", 13.33, false, 200],
  ["sw-m365", "Microsoft 365", "Office", "Microsoft", 12.5, false, 0],
  ["sw-notion", "Notion", "Productivity", "Notion Labs", 10, false, 150],
  ["sw-figma", "Figma Professional", "Design", "Figma", 15, true, 40],
  ["sw-adobe", "Adobe Creative Cloud", "Design", "Adobe", 59.99, true, 15],
  ["sw-jetbrains", "JetBrains All Products", "Development", "JetBrains", 28.9, true, 60],
  ["sw-copilot", "GitHub Copilot", "Development", "GitHub", 19, true, 80],
  ["sw-postman", "Postman Team", "Development", "Postman", 14, false, 100],
  ["sw-tableau", "Tableau Creator", "Analytics", "Salesforce", 75, true, 10],
  ["sw-jira", "Jira Software", "Project management", "Atlassian", 8.15, false, 0],
  ["sw-1password", "1Password", "Security", "1Password", 7.99, false, 0],
].map(([id, name, category, vendor, monthlyCost, needsApproval, seats]) => ({
  id: id as string,
  name: name as string,
  category: category as string,
  vendor: vendor as string,
  monthlyCost: monthlyCost as number,
  currency: "USD",
  needsApproval: needsApproval as boolean,
  seats: seats as number,
  active: true,
}));

/* ───────────── Local ───────────── */

interface SoftwareRow {
  id: string;
  employeeId: string;
  employeeName: string;
  titleId: string;
  reason: string;
  durationMonths: number | null;
  status: SoftwareStatus;
  submittedOn: string;
  steps: FlowStep[];
  raisedById: string;
  assignedOn?: string;
  expiresOn?: string;
  endedOn?: string;
  endedBy?: string;
  licenceKey?: string;
}

type LocalState = { rows: SoftwareRow[]; titles: Record<string, { seats?: number; needsApproval?: boolean; active?: boolean }> };

const local = createLocalStore<LocalState>("timez.software.v2", () => ({ rows: [], titles: {} }), (saved) => {
  const s = saved as Partial<LocalState> | null;
  return s && Array.isArray(s.rows) ? { rows: s.rows, titles: s.titles ?? {} } : null;
});

const PENDING: SoftwareStatus[] = ["Submitted", "Manager approved"];

function liveStatus(row: { status: SoftwareStatus; expiresOn?: string }, today = todayISO()): SoftwareStatus {
  return row.status === "Active" && row.expiresOn && row.expiresOn < today ? "Expired" : row.status;
}

function localTitles(): SoftwareTitle[] {
  const { rows, titles } = local.get();
  return CATALOGUE.map((t) => {
    const edit = titles[t.id] ?? {};
    return {
      ...t,
      ...edit,
      seatsUsed: rows.filter((r) => r.titleId === t.id && liveStatus(r) === "Active").length,
    } as SoftwareTitle;
  });
}

function licenceKey(): string {
  const hex = () => Math.random().toString(16).slice(2, 8).toUpperCase().padEnd(6, "0");
  return `LIC-${hex()}-${hex().slice(0, 4)}`;
}

function grant(row: SoftwareRow) {
  const today = todayISO();
  row.status = "Active";
  row.assignedOn = today;
  row.expiresOn = row.durationMonths ? addMonthsISO(today, row.durationMonths) : undefined;
  row.licenceKey = licenceKey();
}

function toView(row: SoftwareRow, actor: Actor, titles: SoftwareTitle[]): SoftwareView {
  const title = titles.find((t) => t.id === row.titleId);
  const status = liveStatus(row);
  return {
    id: row.id,
    employeeId: row.employeeId,
    employeeName: row.employeeName,
    titleId: row.titleId,
    titleName: title?.name ?? row.titleId,
    category: title?.category ?? "",
    monthlyCost: title?.monthlyCost ?? 0,
    currency: title?.currency ?? "USD",
    reason: row.reason,
    durationMonths: row.durationMonths,
    status,
    submittedOn: row.submittedOn,
    assignedOn: row.assignedOn,
    expiresOn: row.expiresOn,
    endedOn: row.endedOn,
    endedBy: row.endedBy,
    licenceKey: row.licenceKey,
    direct: row.raisedById !== row.employeeId,
    steps: stepViews(row.steps),
    canDecide: PENDING.includes(status) && canActOnStep(actor, row.employeeId, row.steps),
    canWithdraw: PENDING.includes(status) && actor.id === row.employeeId,
    canReturn: status === "Active" && actor.id === row.employeeId,
    canRevoke: status === "Active" && isItRole(actor.role) && actor.id !== row.employeeId,
  };
}

function mutate(id: string, fn: (row: SoftwareRow) => string | null): string | null {
  const state = local.get();
  const index = state.rows.findIndex((r) => r.id === id);
  if (index < 0) return "Request not found.";
  const row = structuredClone(state.rows[index]);
  const error = fn(row);
  if (error) return error;
  const rows = state.rows.slice();
  rows[index] = row;
  return local.set({ ...state, rows });
}

/* ───────────── Backend ───────────── */

interface TitleOut {
  id: string;
  name: string;
  category: string;
  vendor: string;
  monthly_cost: number;
  currency: string;
  needs_approval: boolean;
  seats: number;
  seats_used: number;
  active: boolean;
}

interface SoftwareOut {
  id: string;
  employee_id: string;
  employee_name: string | null;
  title_id: string;
  title_name: string;
  category: string;
  monthly_cost: number;
  currency: string;
  reason: string;
  duration_months: number | null;
  status: SoftwareStatus;
  submitted_on: string;
  assigned_on: string | null;
  expires_on: string | null;
  ended_on: string | null;
  ended_by: string | null;
  licence_key: string | null;
  direct: boolean;
  steps: Parameters<typeof stepsFromApi>[0];
  can_decide: boolean;
  can_withdraw: boolean;
  can_return: boolean;
  can_revoke: boolean;
}

const titleFromApi = (t: TitleOut): SoftwareTitle => ({
  id: t.id,
  name: t.name,
  category: t.category,
  vendor: t.vendor,
  monthlyCost: t.monthly_cost,
  currency: t.currency,
  needsApproval: t.needs_approval,
  seats: t.seats,
  seatsUsed: t.seats_used,
  active: t.active,
});

const fromApi = (r: SoftwareOut): SoftwareView => ({
  id: r.id,
  employeeId: r.employee_id,
  employeeName: r.employee_name ?? r.employee_id,
  titleId: r.title_id,
  titleName: r.title_name,
  category: r.category,
  monthlyCost: r.monthly_cost,
  currency: r.currency,
  reason: r.reason,
  durationMonths: r.duration_months,
  status: r.status,
  submittedOn: r.submitted_on,
  assignedOn: r.assigned_on ?? undefined,
  expiresOn: r.expires_on ?? undefined,
  endedOn: r.ended_on ?? undefined,
  endedBy: r.ended_by ?? undefined,
  licenceKey: r.licence_key ?? undefined,
  direct: r.direct,
  steps: stepsFromApi(r.steps),
  canDecide: r.can_decide,
  canWithdraw: r.can_withdraw,
  canReturn: r.can_return,
  canRevoke: r.can_revoke,
});

/** Roles the API lets see every software request (IT_ROLES in backend/app/services/self_service.py). */
const IT_SCOPE_ROLES: ReadonlySet<string> = new Set(["admin", "super_admin", "it_admin"]);

export const softwareMirror = createApiMirror<{ rows: SoftwareView[]; titles: SoftwareTitle[] }>(
  () => ({ rows: [], titles: [] }),
  async () => {
    const [rows, titles] = await Promise.all([
      loadScopes<SoftwareOut>("/software/requests", IT_SCOPE_ROLES),
      api.get<TitleOut[]>("/software/catalogue").catch(() => [] as TitleOut[]),
    ]);
    return {
      rows: rows.map(fromApi).sort((a, b) => b.submittedOn.localeCompare(a.submittedOn) || b.id.localeCompare(a.id)),
      titles: titles.map(titleFromApi),
    };
  },
);

/* ───────────── Reading ───────────── */

export function subscribeSoftware(listener: () => void): () => void {
  return API_ENABLED ? softwareMirror.subscribe(listener) : local.subscribe(listener);
}

export function getSoftwareSnapshot(): object {
  return API_ENABLED ? softwareMirror.get() : local.get();
}

export function softwareTitles(): SoftwareTitle[] {
  return API_ENABLED ? softwareMirror.get().titles : localTitles();
}

export function softwareViews(actor: Actor): SoftwareView[] {
  if (API_ENABLED) return softwareMirror.get().rows;
  const titles = localTitles();
  return local
    .get()
    .rows.map((r) => toView(r, actor, titles))
    .sort((a, b) => b.submittedOn.localeCompare(a.submittedOn) || b.id.localeCompare(a.id));
}

export function softwareWaitingOn(actor: Actor): SoftwareView[] {
  if (API_ENABLED) return [];
  return softwareViews(actor).filter((v) => v.canDecide);
}

/* ───────────── Changes ───────────── */

export async function requestSoftware(
  actor: Actor,
  input: { titleId: string; reason: string; durationMonths: number | null; employeeId?: string; employeeName?: string },
): Promise<string | null> {
  const forOther = Boolean(input.employeeId && input.employeeId !== actor.id);
  if (!forOther && !input.reason.trim()) return "Say why you need it.";
  if (input.durationMonths !== null && (input.durationMonths < 1 || input.durationMonths > 24)) return "Choose 1 to 24 months, or ongoing.";
  if (API_ENABLED) {
    return apiRun(
      () =>
        api.post("/software/requests", {
          title_id: input.titleId,
          reason: input.reason.trim(),
          duration_months: input.durationMonths,
          ...(forOther ? { employee_id: input.employeeId } : {}),
        }),
      softwareMirror,
    );
  }
  if (forOther && !isItRole(actor.role)) return "Only IT can assign software to someone else.";
  const title = localTitles().find((t) => t.id === input.titleId);
  if (!title || !title.active) return "This software is no longer offered.";
  const employeeId = forOther ? input.employeeId! : actor.id;
  const existing = local.get().rows.filter((r) => r.employeeId === employeeId && r.titleId === title.id);
  if (existing.some((r) => liveStatus(r) === "Active")) return forOther ? `${input.employeeName ?? "They"} already has ${title.name}.` : `You already have ${title.name}.`;
  if (existing.some((r) => PENDING.includes(r.status))) return `A request for ${title.name} is already waiting.`;
  const instant = forOther || !title.needsApproval;
  if (instant && title.seats && title.seatsUsed >= title.seats) return `No ${title.name} seats left. Ask IT to add seats.`;
  const row: SoftwareRow = {
    id: uid("swr"),
    employeeId,
    employeeName: forOther ? (input.employeeName ?? employeeId) : actor.fullName,
    titleId: title.id,
    reason: input.reason.trim(),
    durationMonths: input.durationMonths,
    status: "Submitted",
    submittedOn: todayISO(),
    steps: instant ? [] : buildSteps(employeeId, { kind: "it", label: "IT" }),
    raisedById: actor.id,
  };
  if (instant) grant(row);
  const state = local.get();
  return local.set({ ...state, rows: [row, ...state.rows] });
}

export async function decideSoftware(actor: Actor, id: string, decision: "approve" | "reject", note: string): Promise<string | null> {
  if (decision === "reject" && !note.trim()) return "Add a note saying why.";
  if (API_ENABLED) {
    return apiRun(() => api.post(`/software/requests/${encodeURIComponent(id)}/decision`, { decision, note: note.trim() || null }), softwareMirror);
  }
  return mutate(id, (row) => {
    if (!PENDING.includes(row.status)) return `This request is already ${row.status.toLowerCase()}.`;
    const result = decideStep(actor, row.employeeId, row.steps, decision, note);
    if (typeof result === "string") return result;
    row.steps = result.steps;
    if (result.outcome === "approved") grant(row);
    else row.status = result.outcome === "rejected" ? "Rejected" : waitingStatus(result.steps);
    return null;
  });
}

function endLocal(actor: Actor, id: string, how: "Returned" | "Revoked" | "Withdrawn"): string | null {
  return mutate(id, (row) => {
    if (how === "Withdrawn") {
      if (row.employeeId !== actor.id) return "Only the person who asked can withdraw it.";
      if (!PENDING.includes(row.status)) return "It can only be withdrawn while it waits.";
      row.status = "Withdrawn";
      return null;
    }
    if (liveStatus(row) !== "Active") return "This licence is not active.";
    if (how === "Returned" && row.employeeId !== actor.id) return "Only the licence holder can return it.";
    if (how === "Revoked" && (!isItRole(actor.role) || row.employeeId === actor.id)) return "Only IT can revoke a licence.";
    row.status = how;
    row.endedOn = todayISO();
    row.endedBy = actor.fullName;
    return null;
  });
}

export async function endSoftware(actor: Actor, id: string, how: "Returned" | "Revoked" | "Withdrawn"): Promise<string | null> {
  if (API_ENABLED) {
    const tail = how === "Returned" ? "return" : how === "Revoked" ? "revoke" : "withdraw";
    return apiRun(() => api.post(`/software/requests/${encodeURIComponent(id)}/${tail}`), softwareMirror);
  }
  return endLocal(actor, id, how);
}

export async function updateTitle(actor: Actor, id: string, change: { seats?: number; needsApproval?: boolean; active?: boolean }): Promise<string | null> {
  if (!isItRole(actor.role)) return "Only IT can change the catalogue.";
  if (change.seats !== undefined && (!Number.isInteger(change.seats) || change.seats < 0)) return "Seats must be 0 (no limit) or more.";
  if (API_ENABLED) {
    return apiRun(
      () =>
        apiRequest(`/software/catalogue/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: { seats: change.seats, needs_approval: change.needsApproval, active: change.active },
        }),
      softwareMirror,
    );
  }
  const state = local.get();
  return local.set({ ...state, titles: { ...state.titles, [id]: { ...state.titles[id], ...change } } });
}
