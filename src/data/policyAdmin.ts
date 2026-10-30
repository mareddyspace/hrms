/**
 * Policies HR writes in the portal: drafts, versions (v1, v2 … with a change summary and effective date), publish,
 * archive, audience (everyone / countries / departments) and acknowledgements with an optional comment.
 *
 * Backend mode (VITE_API_URL): everything lives on the server (/policies, backend/app/routers/policies.py), so a
 * policy HR publishes in one browser reaches every targeted employee in theirs. The list reloads on sign-in, when
 * the window regains focus and every minute.
 * Browser-only mode: a localStorage store shared by the demo sign-ins (other tabs follow via the storage event).
 */
import { API_ENABLED, api, apiRequest, onApiSession } from "../api/client.ts";
import { pushPersonTaskAlert } from "./collabLocal.ts";
import { getPerson } from "./peopleLocal.ts";
import type { Policy, PolicyCategory, PolicySection } from "./policyLibrary.ts";
import { DEMO_ACCOUNTS } from "../demoAccounts.ts";
import { TIMEZ_COUNTRIES, todayISO, type CountryCode, type UserRole } from "../model.ts";

export type AudienceType = "all" | "country" | "department";
export type ManagedStatus = "draft" | "published" | "archived";

export interface ManagedVersion {
  version: number;
  status: "draft" | "published";
  summary: string;
  sections: PolicySection[];
  changeSummary: string;
  effectiveDate: string;
  publishedAt?: string;
  publishedBy?: string;
}

export interface ManagedAck {
  employeeId: string;
  version: string;
  at: string;
  comment?: string;
}

export interface ManagedPolicy {
  id: string;
  title: string;
  category: string;
  status: ManagedStatus;
  audienceType: AudienceType;
  audienceValues: string[];
  requiresAck: boolean;
  /** Latest published version (0 = never published). */
  currentVersion: number;
  updatedAt: string;
  /** Newest first. Employees only get published versions. */
  versions: ManagedVersion[];
  /** Backend mode: does it apply to the signed-in person, and their latest acknowledgement. */
  targetsMe?: boolean;
  myAck?: ManagedAck;
  /** Browser-only mode: everyone's acknowledgements. */
  acks?: ManagedAck[];
}

export interface PolicyInput {
  id?: string;
  title: string;
  category: string;
  audienceType: AudienceType;
  audienceValues: string[];
  requiresAck: boolean;
  /** Editing a built-in policy at v2: the first version saved here is v3. */
  baseVersion?: number;
  summary: string;
  sections: PolicySection[];
  changeSummary: string;
  effectiveDate: string;
}

export interface PolicyPerson {
  id: string;
  name: string;
  countryCode: string;
  department: string;
  canSignIn: boolean;
}

export interface PolicyTracking {
  version: number;
  targeted: number;
  acknowledged: number;
  percent: number;
  pending: { id: string; name: string; department?: string; countryCode?: string }[];
  done: { id: string; name: string; at: string; comment?: string }[];
}

type State = { policies: ManagedPolicy[]; loaded: boolean; error: string | null };

export const POLICY_EDITOR_ROLES: UserRole[] = ["hr", "hr_admin", "hrbp", "admin"];
export const canEditPolicies = (role: UserRole) => POLICY_EDITOR_ROLES.includes(role);

const KEY = "timez.managedPolicies.v1";
const listeners = new Set<() => void>();
let state: State = { policies: [], loaded: !API_ENABLED, error: null };
const emit = () => listeners.forEach((fn) => fn());

/* ───────── Browser-only store ───────── */

function pfSeed(): ManagedPolicy {
  const today = todayISO();
  const year = Number(today.slice(0, 4));
  const effective = today < `${year}-12-01` ? `${year}-12-01` : `${year + 1}-12-01`;
  const when = new Date(`${effective}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  return {
    id: "pf-contribution-change",
    title: "Provident Fund contribution change",
    category: "Pay & tax",
    status: "published",
    audienceType: "country",
    audienceValues: ["IN"],
    requiresAck: true,
    currentVersion: 1,
    updatedAt: `${today}T09:00:00.000Z`,
    acks: [],
    versions: [
      {
        version: 1,
        status: "published",
        summary: "Applies to everyone on the India payroll.",
        changeSummary: `Employee PF contribution goes up from 12% to 13% of basic pay from ${when}.`,
        effectiveDate: effective,
        publishedAt: `${today}T09:00:00.000Z`,
        publishedBy: "Farhan Ali",
        sections: [
          {
            heading: "What changes",
            rules: [
              `From ${when}, your Provident Fund contribution is 13% of basic pay (it was 12%).`,
              "The company contribution also goes up to 13%.",
              "Your take-home pay goes down by 1% of basic pay. Your PF balance grows by the same amount, plus the company's share.",
            ],
          },
          {
            heading: "What you need to do",
            rules: ["Nothing, apart from acknowledging this change. Payroll applies it automatically.", "Questions: add a comment when you acknowledge, or ask HR through the Helpdesk."],
          },
        ],
      },
    ],
  };
}

function readLocal(): ManagedPolicy[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [pfSeed()];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ManagedPolicy[]) : [pfSeed()];
  } catch {
    return [pfSeed()];
  }
}

function writeLocal(policies: ManagedPolicy[]) {
  state = { ...state, policies };
  try {
    localStorage.setItem(KEY, JSON.stringify(policies));
  } catch {
    /* storage unavailable — keep in memory */
  }
  emit();
}

if (!API_ENABLED) {
  state = { policies: readLocal(), loaded: true, error: null };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", (e) => {
      if (e.key === KEY) {
        state = { ...state, policies: readLocal() };
        emit();
      }
    });
  }
}

/** The people the browser-only demo knows: the sign-ins and a few teammates. */
const TEAMMATE_IDS = ["emp-priya", "emp-anu", "emp-kabir", "emp-diya"];
export function localPolicyPeople(): PolicyPerson[] {
  const rows: PolicyPerson[] = DEMO_ACCOUNTS.map((a) => {
    const p = getPerson(a.id);
    return { id: a.id, name: a.fullName, countryCode: String(p?.countryCode ?? a.countryCode ?? "IN"), department: p?.department ?? a.department ?? "", canSignIn: true };
  });
  for (const id of TEAMMATE_IDS) {
    const p = getPerson(id);
    if (p && !rows.some((r) => r.id === id)) rows.push({ id, name: p.fullName, countryCode: String(p.countryCode), department: p.department ?? "", canSignIn: false });
  }
  return rows;
}

function personFacts(id: string): { countryCode: string; department: string } {
  const p = getPerson(id);
  const a = DEMO_ACCOUNTS.find((x) => x.id === id);
  return { countryCode: String(p?.countryCode ?? a?.countryCode ?? "IN"), department: p?.department ?? a?.department ?? "" };
}

export function audienceIncludes(p: Pick<ManagedPolicy, "audienceType" | "audienceValues">, who: { countryCode: string; department: string }): boolean {
  if (p.audienceType === "country") return p.audienceValues.includes(who.countryCode);
  if (p.audienceType === "department") return p.audienceValues.includes(who.department);
  return true;
}

/* ───────── Backend mode ───────── */

interface VersionOut {
  version: number;
  status: "draft" | "published";
  summary: string;
  sections: PolicySection[];
  change_summary: string;
  effective_date: string | null;
  published_at: string | null;
  published_by_name?: string | null;
}
interface PolicyOut {
  id: string;
  title: string;
  category: string;
  status: ManagedStatus;
  audience_type: AudienceType;
  audience_values: string[];
  requires_ack: boolean;
  current_version: number;
  updated_at: string;
  targets_me: boolean;
  my_ack: { version: string; acknowledged_at: string; comment: string | null } | null;
  versions: VersionOut[];
}

function fromApi(p: PolicyOut, meId: string): ManagedPolicy {
  return {
    id: p.id,
    title: p.title,
    category: p.category,
    status: p.status,
    audienceType: p.audience_type,
    audienceValues: p.audience_values,
    requiresAck: p.requires_ack,
    currentVersion: p.current_version,
    updatedAt: p.updated_at,
    targetsMe: p.targets_me,
    myAck: p.my_ack ? { employeeId: meId, version: p.my_ack.version, at: p.my_ack.acknowledged_at, comment: p.my_ack.comment ?? undefined } : undefined,
    versions: p.versions.map((v) => ({
      version: v.version,
      status: v.status,
      summary: v.summary,
      sections: v.sections,
      changeSummary: v.change_summary,
      effectiveDate: v.effective_date ?? "",
      publishedAt: v.published_at ?? undefined,
      publishedBy: v.published_by_name ?? undefined,
    })),
  };
}

let apiAccount: string | null = null;
let loading: Promise<void> | null = null;

export function reloadPolicies(): Promise<void> {
  if (!API_ENABLED || !apiAccount) return Promise.resolve();
  if (loading) return loading;
  const account = apiAccount;
  loading = api
    .get<PolicyOut[]>("/policies")
    .then((rows) => {
      if (apiAccount !== account) return;
      state = { policies: rows.map((r) => fromApi(r, account)), loaded: true, error: null };
      emit();
    })
    .catch((e: unknown) => {
      if (apiAccount !== account) return;
      state = { ...state, loaded: true, error: (e as Error).message || "Policies could not be loaded." };
      emit();
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

function upsert(row: PolicyOut) {
  const next = fromApi(row, apiAccount ?? "");
  const rest = state.policies.filter((p) => p.id !== next.id);
  state = { ...state, policies: [...rest, next].sort((a, b) => a.title.localeCompare(b.title)) };
  emit();
}

if (API_ENABLED) {
  onApiSession((accountId) => {
    apiAccount = accountId;
    state = { policies: [], loaded: false, error: null };
    emit();
    if (accountId) void reloadPolicies();
  });
  if (typeof window !== "undefined") {
    window.addEventListener("focus", () => void reloadPolicies());
    window.setInterval(() => {
      if (document.visibilityState === "visible") void reloadPolicies();
    }, 60_000);
  }
}

const errorText = (e: unknown) => (e as Error)?.message || "Something went wrong. Please try again.";

/* ───────── Reading ───────── */

export function subscribeManagedPolicies(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getManagedPolicies(): State {
  return state;
}

export const publishedVersion = (p: ManagedPolicy) => p.versions.find((v) => v.status === "published" && v.version === p.currentVersion);
export const draftVersion = (p: ManagedPolicy) => p.versions.find((v) => v.status === "draft");

/** Does a published policy apply to this person? */
export function appliesToMe(p: ManagedPolicy, meId: string): boolean {
  if (p.status !== "published" || !p.currentVersion) return false;
  if (API_ENABLED) return p.targetsMe ?? false;
  return audienceIncludes(p, personFacts(meId));
}

export function myAckOf(p: ManagedPolicy, meId: string): ManagedAck | undefined {
  if (API_ENABLED) return p.myAck;
  return (p.acks ?? []).filter((a) => a.employeeId === meId).sort((a, b) => b.at.localeCompare(a.at))[0];
}

export function needsMyAck(p: ManagedPolicy, meId: string): boolean {
  return p.requiresAck && appliesToMe(p, meId) && myAckOf(p, meId)?.version !== String(p.currentVersion);
}

/** Published policies that apply to me and still need my acknowledgement. */
export function pendingForMe(policies: ManagedPolicy[], meId: string): ManagedPolicy[] {
  return policies.filter((p) => needsMyAck(p, meId));
}

export function audienceLabel(p: Pick<ManagedPolicy, "audienceType" | "audienceValues">): string {
  if (p.audienceType === "country") return p.audienceValues.map((c) => TIMEZ_COUNTRIES.find((x) => x.code === c)?.name ?? c).join(", ");
  if (p.audienceType === "department") return p.audienceValues.join(", ");
  return "Everyone";
}

/** A published managed policy in the library's shape, so the reader can show it next to built-in ones. */
export function asLibraryPolicy(p: ManagedPolicy): Policy | null {
  const v = publishedVersion(p);
  if (!v) return null;
  return {
    id: p.id,
    title: p.title,
    category: p.category as PolicyCategory,
    appliesTo: p.audienceType === "country" ? { countries: p.audienceValues as CountryCode[] } : "all",
    version: String(p.currentVersion),
    effective: v.effectiveDate || (v.publishedAt ?? "").slice(0, 10),
    owner: "HR",
    mandatory: p.requiresAck,
    sections: v.sections,
  };
}

/* ───────── Changes (each returns an error message or null) ───────── */

function toBody(input: PolicyInput) {
  return {
    ...(input.id ? { id: input.id } : {}),
    title: input.title.trim(),
    category: input.category,
    audience_type: input.audienceType,
    audience_values: input.audienceType === "all" ? [] : input.audienceValues,
    requires_ack: input.requiresAck,
    base_version: input.baseVersion ?? 0,
    summary: input.summary.trim(),
    sections: cleanSections(input.sections),
    change_summary: input.changeSummary.trim(),
    effective_date: input.effectiveDate || null,
  };
}

export function cleanSections(sections: PolicySection[]): PolicySection[] {
  return sections
    .map((s) => ({ heading: s.heading.trim(), rules: s.rules.map((r) => r.trim()).filter(Boolean) }))
    .filter((s) => s.heading || s.rules.length)
    .map((s) => ({ heading: s.heading || "Rules", rules: s.rules }));
}

function checkInput(input: PolicyInput): string | null {
  if (input.title.trim().length < 3) return "Enter a title.";
  if (input.audienceType !== "all" && !input.audienceValues.length) return input.audienceType === "country" ? "Choose at least one country." : "Choose at least one department.";
  return null;
}

/** Saves a new policy, or changes to an existing one, as the next version's draft. Returns [error, id]. */
export async function savePolicy(input: PolicyInput, existingId?: string): Promise<[string | null, string]> {
  const invalid = checkInput(input);
  if (invalid) return [invalid, existingId ?? ""];
  if (API_ENABLED) {
    try {
      const row = existingId
        ? await apiRequest<PolicyOut>(`/policies/${encodeURIComponent(existingId)}`, { method: "PUT", body: toBody(input) })
        : await api.post<PolicyOut>("/policies", toBody(input));
      upsert(row);
      return [null, row.id];
    } catch (e) {
      return [errorText(e), existingId ?? ""];
    }
  }
  const all = readLocal();
  const id = existingId ?? input.id ?? `${input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}-${Math.random().toString(36).slice(2, 8)}`;
  let p = all.find((x) => x.id === id);
  if (!existingId && p) return ["This policy already exists here. Edit it instead.", id];
  if (p?.status === "archived") return ["Restore this policy before editing it.", id];
  if (!p) {
    p = { id, title: "", category: "", status: "draft", audienceType: "all", audienceValues: [], requiresAck: true, currentVersion: 0, updatedAt: "", versions: [], acks: [] };
    all.push(p);
  }
  p.title = input.title.trim();
  p.category = input.category;
  p.audienceType = input.audienceType;
  p.audienceValues = input.audienceType === "all" ? [] : [...new Set(input.audienceValues)].sort();
  p.requiresAck = input.requiresAck;
  p.updatedAt = new Date().toISOString();
  let draft = draftVersion(p);
  if (!draft) {
    const start = p.currentVersion || input.baseVersion || 0;
    draft = { version: start + 1, status: "draft", summary: "", sections: [], changeSummary: "", effectiveDate: "" };
    p.versions.unshift(draft);
  }
  draft.summary = input.summary.trim();
  draft.sections = cleanSections(input.sections);
  draft.changeSummary = input.changeSummary.trim();
  draft.effectiveDate = input.effectiveDate;
  writeLocal(all);
  return [null, id];
}

/** Publishes the draft as the current version and notifies everyone it applies to. Returns [error, notified]. */
export async function publishPolicy(id: string, publisherName: string): Promise<[string | null, number]> {
  if (API_ENABLED) {
    try {
      const out = await api.post<{ policy: PolicyOut; notified: number }>(`/policies/${encodeURIComponent(id)}/publish`);
      upsert(out.policy);
      return [null, out.notified];
    } catch (e) {
      return [errorText(e), 0];
    }
  }
  const all = readLocal();
  const p = all.find((x) => x.id === id);
  if (!p) return ["Policy not found.", 0];
  if (p.status === "archived") return ["Restore this policy before publishing it.", 0];
  const draft = draftVersion(p);
  if (!draft) return ["There are no changes to publish.", 0];
  if (!draft.sections.length && !draft.summary.trim()) return ["Add the policy text before publishing.", 0];
  if (p.currentVersion && !draft.changeSummary.trim()) return ["Say what changed in this version.", 0];
  draft.status = "published";
  draft.publishedAt = new Date().toISOString();
  draft.publishedBy = publisherName;
  p.currentVersion = draft.version;
  p.status = "published";
  p.updatedAt = draft.publishedAt;
  writeLocal(all);
  const people = localPolicyPeople().filter((person) => audienceIncludes(p, person) && person.canSignIn);
  const title = p.requiresAck ? `Needs your acknowledgement: ${p.title}` : `Policy updated: ${p.title}`;
  const body = (draft.changeSummary || `Version ${draft.version} is published.`) + (draft.effectiveDate ? ` Effective ${fmtDay(draft.effectiveDate)}.` : "");
  for (const person of people) pushPersonTaskAlert({ recipientId: person.id, title, body, href: `/policies?policy=${encodeURIComponent(p.id)}` });
  return [null, people.length];
}

async function simple(path: string, method: "POST" | "DELETE", local: (p: ManagedPolicy, all: ManagedPolicy[]) => string | null, id: string): Promise<string | null> {
  if (API_ENABLED) {
    try {
      upsert(await apiRequest<PolicyOut>(path, { method, ...(method === "POST" ? { body: {} } : {}) }));
      return null;
    } catch (e) {
      return errorText(e);
    }
  }
  const all = readLocal();
  const p = all.find((x) => x.id === id);
  if (!p) return "Policy not found.";
  const error = local(p, all);
  if (error) return error;
  p.updatedAt = new Date().toISOString();
  writeLocal(all);
  return null;
}

export function archivePolicy(id: string): Promise<string | null> {
  return simple(`/policies/${encodeURIComponent(id)}/archive`, "POST", (p) => {
    if (p.status === "archived") return "This policy is already archived.";
    p.status = "archived";
    return null;
  }, id);
}

export function restorePolicy(id: string): Promise<string | null> {
  return simple(`/policies/${encodeURIComponent(id)}/restore`, "POST", (p) => {
    if (p.status !== "archived") return "Only archived policies can be restored.";
    p.status = p.currentVersion ? "published" : "draft";
    return null;
  }, id);
}

export function discardDraft(id: string): Promise<string | null> {
  return simple(`/policies/${encodeURIComponent(id)}/draft`, "DELETE", (p) => {
    if (!draftVersion(p)) return "There is no draft to discard.";
    if (!p.currentVersion) return "This policy has never been published. Archive it instead.";
    p.versions = p.versions.filter((v) => v.status !== "draft");
    return null;
  }, id);
}

/** Acknowledges the current version, with an optional comment or question for HR. */
export async function acknowledgeManaged(id: string, meId: string, comment: string): Promise<string | null> {
  const note = comment.trim().slice(0, 1000);
  if (API_ENABLED) {
    try {
      upsert(await api.post<PolicyOut>(`/policies/${encodeURIComponent(id)}/acknowledge`, { comment: note || null }));
      return null;
    } catch (e) {
      return errorText(e);
    }
  }
  const all = readLocal();
  const p = all.find((x) => x.id === id);
  if (!p || !appliesToMe(p, meId)) return "Policy not found.";
  const version = String(p.currentVersion);
  if ((p.acks ?? []).some((a) => a.employeeId === meId && a.version === version)) return "You have already acknowledged this version.";
  p.acks = [...(p.acks ?? []), { employeeId: meId, version, at: new Date().toISOString(), ...(note ? { comment: note } : {}) }];
  writeLocal(all);
  if (note) {
    const who = DEMO_ACCOUNTS.find((a) => a.id === meId)?.fullName ?? "An employee";
    const hr = DEMO_ACCOUNTS.filter((a) => a.role === "hr_admin" && a.id !== meId);
    for (const h of hr) pushPersonTaskAlert({ recipientId: h.id, title: `Question on ${p.title}`, body: `${who}: ${note}`, href: `/policies?policy=${encodeURIComponent(p.id)}&tab=acks` });
  }
  return null;
}

/** Who must acknowledge the current version, who has, and their comments. */
export async function fetchTracking(id: string): Promise<{ data: PolicyTracking | null; error: string | null }> {
  if (API_ENABLED) {
    try {
      const t = await api.get<{
        version: number;
        targeted: number;
        acknowledged: number;
        percent: number;
        pending: { employee_id: string; name: string; department: string | null; country_code: string | null }[];
        done: { employee_id: string; name: string; acknowledged_at: string; comment: string | null }[];
      }>(`/policies/${encodeURIComponent(id)}/tracking`);
      return {
        data: {
          version: t.version,
          targeted: t.targeted,
          acknowledged: t.acknowledged,
          percent: t.percent,
          pending: t.pending.map((p) => ({ id: p.employee_id, name: p.name, department: p.department ?? undefined, countryCode: p.country_code ?? undefined })),
          done: t.done.map((d) => ({ id: d.employee_id, name: d.name, at: d.acknowledged_at, comment: d.comment ?? undefined })),
        },
        error: null,
      };
    } catch (e) {
      return { data: null, error: errorText(e) };
    }
  }
  const p = readLocal().find((x) => x.id === id);
  if (!p) return { data: null, error: "Policy not found." };
  return { data: localTracking(p), error: null };
}

export function localTracking(p: ManagedPolicy): PolicyTracking {
  const version = String(p.currentVersion);
  const people = localPolicyPeople().filter((person) => audienceIncludes(p, person));
  const ackOf = (pid: string) => (p.acks ?? []).find((a) => a.employeeId === pid && a.version === version);
  const done = people.filter((x) => ackOf(x.id)).map((x) => ({ id: x.id, name: x.name, at: ackOf(x.id)!.at, comment: ackOf(x.id)!.comment }));
  const pending = people.filter((x) => !ackOf(x.id)).map((x) => ({ id: x.id, name: x.name, department: x.department, countryCode: x.countryCode }));
  return { version: p.currentVersion, targeted: people.length, acknowledged: done.length, percent: people.length ? Math.round((100 * done.length) / people.length) : 0, pending, done };
}

/** Notifies everyone who hasn't acknowledged the current version yet. Returns [error, reminded]. */
export async function sendReminder(id: string): Promise<[string | null, number]> {
  if (API_ENABLED) {
    try {
      const out = await api.post<{ reminded: number }>(`/policies/${encodeURIComponent(id)}/remind`);
      return [null, out.reminded];
    } catch (e) {
      return [errorText(e), 0];
    }
  }
  const p = readLocal().find((x) => x.id === id);
  if (!p || p.status !== "published" || !p.requiresAck) return ["Only published policies that need acknowledgement have reminders.", 0];
  const pending = localTracking(p).pending.filter((x) => DEMO_ACCOUNTS.some((a) => a.id === x.id));
  for (const person of pending) {
    pushPersonTaskAlert({
      recipientId: person.id,
      title: `Reminder: acknowledge ${p.title}`,
      body: `Please read and acknowledge version ${p.currentVersion}.`,
      href: `/policies?policy=${encodeURIComponent(p.id)}`,
    });
  }
  return [null, pending.length];
}

/** Countries and departments HR can target. */
export async function audienceOptions(): Promise<{ countries: { code: string; name: string }[]; departments: string[] }> {
  const local = {
    countries: TIMEZ_COUNTRIES.map((c) => ({ code: c.code as string, name: c.name as string })),
    departments: [...new Set(localPolicyPeople().map((p) => p.department).filter(Boolean))].sort(),
  };
  if (!API_ENABLED) return local;
  try {
    return await api.get<{ countries: { code: string; name: string }[]; departments: string[] }>("/policies/audience-options");
  } catch {
    return local;
  }
}

export function fmtDay(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso;
  return new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
