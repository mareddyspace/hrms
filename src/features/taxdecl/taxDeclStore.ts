/**
 * Tax-saving declarations with proofs. Backend mode: /tax-declarations (app/routers/tax_declarations.py), kept in
 * memory. Local mode: this browser (timez.taxDeclarations.v1), with the same rules: sections and caps per country
 * (src/countryPay.ts), draft -> submitted -> verified | rejected, edits only before the year's deadline, a proof
 * file before submitting, Finance / HR verify other people's items, rejection needs a reason.
 *
 * Verified items feed the payslips' tax (old regime in India) through declarationsForPay().
 */
import { useSyncExternalStore } from "react";
import { API_ENABLED, api, apiRequest, apiSessionMe } from "../../api/client.ts";
import { apiRun, createApiMirror } from "../../api/syncOps.ts";
import { authorizedFetch, fetchFile, fileType } from "../../api/syncRewardsShared.ts";
import { declarableTaxYears, money, payRulesFor, taxYearStartFor } from "../../countryPay.ts";
import { DEMO_ACCOUNTS } from "../../demoAccounts.ts";
import { getTaxRegime } from "../../data/taxRegime.ts";
import { todayISO, type CountryCode, type InvestmentProof } from "../../model.ts";
import { createLocalStore } from "../payrequests/localStore.ts";
import { notify } from "../workforce/workforceShared.ts";
import { saveFile } from "../payroll/pdfDoc.ts";

export type DeclStatus = "draft" | "submitted" | "verified" | "rejected";

export interface DeclDoc {
  id: string;
  fileName: string;
  contentType: string;
  size: number;
  uploadedAt: string;
  /** Local mode only: the file itself. */
  dataUrl?: string;
}

export interface DeclHistory {
  at: string;
  by?: string;
  byName?: string;
  action: string;
  note?: string;
}

export interface Declaration {
  id: string;
  employeeId: string;
  employeeName?: string;
  employeeCode?: string;
  countryCode: string;
  financialYear: string;
  regime?: string;
  section: string;
  sectionLabel: string;
  title: string;
  amount: number;
  verifiedAmount?: number;
  currency: string;
  status: DeclStatus;
  employeeNote?: string;
  submittedAt?: string;
  decidedByName?: string;
  decidedAt?: string;
  decisionNote?: string;
  createdAt: string;
  updatedAt: string;
  editable: boolean;
  documents: DeclDoc[];
  history: DeclHistory[];
}

export interface DeclSection {
  code: string;
  label: string;
  cap?: number;
  proof: string;
}

export interface DeclYear {
  financialYear: string;
  opensOn: string;
  deadline: string;
  proofDeadline?: string;
  locked: boolean;
  open: boolean;
  daysLeft: number;
}

export interface DeclConfig {
  countryCode: string;
  currency: string;
  hasDeclarations: boolean;
  sections: DeclSection[];
  years: DeclYear[];
  regime?: string;
  regimeEditable: boolean;
  regimeNote: string;
  verifier: boolean;
}

export type Actor = { id: string; fullName: string; role: string; countryCode?: CountryCode | string };
export type DeclInput = { financialYear: string; section: string; title: string; amount: number; note?: string };

const VERIFY_ROLES = new Set(["hr", "hr_admin", "hrbp", "finance", "payroll", "compensation"]);
const MAX_LOCAL_FILE = 1024 * 1024; // browser storage: keep proofs small in local mode
const MAX_FILE = 5 * 1024 * 1024;
const ALLOWED = new Set(["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"]);

export const PROOF_HINT: Record<string, string> = {
  "80C": "Investment statement or premium receipt",
  "80CCD(1B)": "NPS contribution statement",
  "80D": "Premium receipt",
  "80D-parents": "Premium receipt",
  HRA: "Rent receipts or rental agreement (landlord PAN above ₹1 lakh a year)",
  "24(b)": "Lender's interest certificate",
  LTA: "Travel tickets and boarding passes",
  "80E": "Lender's interest certificate",
  "80G": "Donation receipt with the trust's 80G number",
  "80TTA": "Bank interest certificate",
};

/* ───────────── Local store ───────────── */

interface LocalWindow {
  countryCode: string;
  financialYear: string;
  opensOn: string;
  deadline: string;
  proofDeadline?: string;
  locked: boolean;
}
interface LocalState {
  items: Declaration[];
  windows: LocalWindow[];
  imported: string[];
}

const local = createLocalStore<LocalState>("timez.taxDeclarations.v1", () => ({ items: [], windows: [], imported: [] }), (saved) => {
  const s = saved as Partial<LocalState> | null;
  return s && Array.isArray(s.items) ? { items: s.items, windows: Array.isArray(s.windows) ? s.windows : [], imported: Array.isArray(s.imported) ? s.imported : [] } : null;
});

const nameOf = (id?: string) => (id ? (DEMO_ACCOUNTS.find((a) => a.id === id)?.fullName ?? id) : undefined);
const codeOf = (id: string) => DEMO_ACCOUNTS.find((a) => a.id === id)?.employeeCode;
const countryOf = (id: string) => (DEMO_ACCOUNTS.find((a) => a.id === id)?.countryCode ?? "IN") as CountryCode;
const nowIso = () => new Date().toISOString();
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T00:00:00`).getTime() - new Date(`${a}T00:00:00`).getTime()) / 86_400_000);
}

/** Local mode windows: saved by Finance / HR, else the tax year start to 15 days before it ends. */
function localYears(country: CountryCode): DeclYear[] {
  const rules = payRulesFor(country);
  const today = todayISO();
  const start = taxYearStartFor(rules, today);
  return declarableTaxYears(rules, today).map((label, i) => {
    const y = start + i;
    const first = `${y}-${String(rules.taxYearStart.month).padStart(2, "0")}-${String(rules.taxYearStart.day).padStart(2, "0")}`;
    const last = addDays(`${y + 1}-${first.slice(5)}`, -1);
    const saved = local.get().windows.find((w) => w.countryCode === country && w.financialYear === label);
    const w = saved ?? { opensOn: first, deadline: addDays(last, -15), proofDeadline: addDays(last, -10), locked: false };
    const open = !w.locked && w.opensOn <= today && today <= w.deadline;
    return { financialYear: label, opensOn: w.opensOn, deadline: w.deadline, proofDeadline: w.proofDeadline, locked: w.locked, open, daysLeft: Math.max(0, daysBetween(today, w.deadline)) };
  });
}

function localSections(country: CountryCode): DeclSection[] {
  return payRulesFor(country).declarations.map((d) => ({ code: d.code, label: d.label, cap: d.cap, proof: PROOF_HINT[d.code] ?? "Proof document" }));
}

function localConfig(actor: Actor): DeclConfig {
  const country = (actor.countryCode ?? "IN") as CountryCode;
  const rules = payRulesFor(country);
  const years = localYears(country);
  const regime = country === "IN" ? getTaxRegime(actor.id) : undefined;
  const editable = Boolean(regime && years[0]?.open);
  return {
    countryCode: country,
    currency: rules.currency,
    hasDeclarations: rules.declarations.length > 0,
    sections: localSections(country),
    years,
    regime,
    regimeEditable: editable,
    regimeNote: !regime ? "" : editable ? `You can change the regime until ${years[0].deadline}.` : "The regime for this tax year is closed; Finance can reopen it.",
    verifier: VERIFY_ROLES.has(actor.role),
  };
}

const LEGACY_STATUS: Record<InvestmentProof["status"], DeclStatus> = { submitted: "submitted", verified: "verified", rejected: "rejected", withdrawn: "draft" };

/** Local mode: adopt the declarations saved by the earlier page (portal state) once. */
let importQueued = false;
function importLegacy(legacy: InvestmentProof[] | undefined): void {
  if (API_ENABLED || !legacy?.length || importQueued) return;
  if (!legacy.some((p) => !local.get().imported.includes(p.id))) return;
  // Read during render: save after it (a store change notifies other components).
  importQueued = true;
  queueMicrotask(() => {
    importQueued = false;
    adoptLegacy(legacy);
  });
}

function adoptLegacy(legacy: InvestmentProof[]): void {
  const state = local.get();
  const fresh = legacy.filter((p) => !state.imported.includes(p.id));
  if (!fresh.length) return;
  const items = [...state.items];
  for (const p of fresh) {
    const country = countryOf(p.employeeId);
    const label = localSections(country).find((s) => s.code === p.section)?.label ?? p.section;
    const at = `${p.submittedOn}T09:00:00.000Z`;
    items.push({
      id: `td-${p.id}`,
      employeeId: p.employeeId,
      employeeName: nameOf(p.employeeId),
      employeeCode: codeOf(p.employeeId),
      countryCode: country,
      financialYear: p.financialYear,
      regime: country === "IN" ? "old" : undefined,
      section: p.section,
      sectionLabel: label,
      title: p.title,
      amount: p.amount,
      verifiedAmount: p.status === "verified" ? p.amount : undefined,
      currency: p.currency ?? payRulesFor(country).currency,
      status: LEGACY_STATUS[p.status],
      submittedAt: p.status === "withdrawn" ? undefined : at,
      decidedByName: p.decidedByName,
      decidedAt: p.decidedOn,
      decisionNote: p.decisionNote,
      createdAt: at,
      updatedAt: at,
      editable: false,
      documents: [],
      history: [
        { at, by: p.employeeId, byName: nameOf(p.employeeId), action: p.status === "withdrawn" ? "Saved as draft" : "Submitted for verification" },
        ...(p.status === "verified" || p.status === "rejected"
          ? [{ at: p.decidedOn ? `${p.decidedOn}T09:00:00.000Z` : at, byName: p.decidedByName, action: p.status === "verified" ? "Verified" : "Rejected", note: p.decisionNote }]
          : []),
      ],
    });
  }
  local.set({ ...state, items, imported: [...state.imported, ...fresh.map((p) => p.id)] });
}

function localEditable(item: Declaration): boolean {
  if (item.status !== "draft" && item.status !== "rejected") return false;
  const y = localYears(item.countryCode as CountryCode).find((w) => w.financialYear === item.financialYear);
  return Boolean(y?.open);
}

/* ───────────── Backend ───────────── */

interface DocOut { id: string; file_name: string; content_type: string; size_bytes: number; uploaded_at: string }
interface HistOut { at: string; by: string | null; by_name: string | null; action: string; note: string | null }
interface DeclOut {
  id: string; employee_id: string; employee_name: string | null; employee_code: string | null; country_code: string;
  financial_year: string; regime: string | null; section: string; section_label: string; title: string; amount: number;
  verified_amount: number | null; currency: string; status: DeclStatus; employee_note: string | null; submitted_at: string | null;
  decided_by_name: string | null; decided_at: string | null; decision_note: string | null; created_at: string; updated_at: string;
  editable: boolean; documents: DocOut[]; history: HistOut[];
}
interface ConfigOut {
  country_code: string; currency: string; has_declarations: boolean;
  sections: { code: string; label: string; cap: number | null; proof: string }[];
  years: { financial_year: string; opens_on: string; deadline: string; proof_deadline: string | null; locked: boolean; open: boolean; days_left: number }[];
  regime: string | null; regime_editable: boolean; regime_note: string; verifier: boolean;
}

const o = <T>(v: T | null | undefined) => (v == null ? undefined : v);

function fromApi(d: DeclOut): Declaration {
  return {
    id: d.id, employeeId: d.employee_id, employeeName: o(d.employee_name), employeeCode: o(d.employee_code), countryCode: d.country_code,
    financialYear: d.financial_year, regime: o(d.regime), section: d.section, sectionLabel: d.section_label, title: d.title,
    amount: d.amount, verifiedAmount: o(d.verified_amount), currency: d.currency, status: d.status, employeeNote: o(d.employee_note),
    submittedAt: o(d.submitted_at), decidedByName: o(d.decided_by_name), decidedAt: o(d.decided_at), decisionNote: o(d.decision_note),
    createdAt: d.created_at, updatedAt: d.updated_at, editable: d.editable,
    documents: d.documents.map((x) => ({ id: x.id, fileName: x.file_name, contentType: x.content_type, size: x.size_bytes, uploadedAt: x.uploaded_at })),
    history: d.history.map((h) => ({ at: h.at, by: o(h.by), byName: o(h.by_name), action: h.action, note: o(h.note) })),
  };
}

function configFromApi(c: ConfigOut): DeclConfig {
  return {
    countryCode: c.country_code, currency: c.currency, hasDeclarations: c.has_declarations,
    sections: c.sections.map((s) => ({ code: s.code, label: s.label, cap: o(s.cap), proof: s.proof })),
    years: c.years.map((y) => ({ financialYear: y.financial_year, opensOn: y.opens_on, deadline: y.deadline, proofDeadline: o(y.proof_deadline), locked: y.locked, open: y.open, daysLeft: y.days_left })),
    regime: o(c.regime), regimeEditable: c.regime_editable, regimeNote: c.regime_note, verifier: c.verifier,
  };
}

const mirror = createApiMirror<{ config: DeclConfig | null; mine: Declaration[]; queue: Declaration[] }>(
  () => ({ config: null, mine: [], queue: [] }),
  async () => {
    const [config, mine] = await Promise.all([api.get<ConfigOut>("/tax-declarations/config"), api.get<DeclOut[]>("/tax-declarations/mine")]);
    const queue = config.verifier ? await api.get<DeclOut[]>("/tax-declarations/queue", { status: "all" }).catch(() => [] as DeclOut[]) : [];
    return { config: configFromApi(config), mine: mine.map(fromApi), queue: queue.map(fromApi) };
  },
);

/* ───────────── Reading ───────────── */

function subscribe(listener: () => void): () => void {
  return API_ENABLED ? mirror.subscribe(listener) : local.subscribe(listener);
}
function snapshot(): object {
  return API_ENABLED ? mirror.get() : local.get();
}

/** Re-renders when declarations change. */
export function useDeclarationsVersion(): object {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function declarationsLoaded(): boolean {
  return !API_ENABLED || mirror.loaded();
}

export function declarationsError(): string | null {
  return API_ENABLED ? mirror.lastError() : null;
}

export function reloadDeclarations(): Promise<void> {
  return API_ENABLED ? mirror.reload() : Promise.resolve();
}

export function declConfig(actor: Actor): DeclConfig | null {
  return API_ENABLED ? mirror.get().config : localConfig(actor);
}

export function myDeclarations(actor: Actor, legacy?: InvestmentProof[]): Declaration[] {
  if (API_ENABLED) return mirror.get().mine;
  importLegacy(legacy);
  return local
    .get()
    .items.filter((d) => d.employeeId === actor.id)
    .map((d) => ({ ...d, editable: localEditable(d) }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Finance / HR: other people's submitted and decided items (never drafts, never mine). */
export function verifyQueue(actor: Actor, legacy?: InvestmentProof[]): Declaration[] {
  if (API_ENABLED) return mirror.get().queue;
  if (!VERIFY_ROLES.has(actor.role)) return [];
  importLegacy(legacy);
  return local
    .get()
    .items.filter((d) => d.employeeId !== actor.id && d.status !== "draft")
    .map((d) => ({ ...d, editable: false }))
    .sort((a, b) => (b.submittedAt ?? "").localeCompare(a.submittedAt ?? ""));
}

const PROOF_STATUS: Record<DeclStatus, InvestmentProof["status"]> = { draft: "withdrawn", submitted: "submitted", verified: "verified", rejected: "rejected" };

function asProof(d: Declaration): InvestmentProof {
  return {
    id: d.id,
    employeeId: d.employeeId,
    section: d.section,
    title: d.title,
    amount: d.status === "verified" && d.verifiedAmount != null ? d.verifiedAmount : d.amount,
    financialYear: d.financialYear,
    currency: d.currency,
    status: PROOF_STATUS[d.status],
    submittedOn: (d.submittedAt ?? d.createdAt).slice(0, 10),
    decidedByName: d.decidedByName,
    decidedOn: d.decidedAt?.slice(0, 10),
    decisionNote: d.decisionNote,
  };
}

/**
 * Declarations in the shape the payslips, approvals and home pages read (drafts left out). Verified amounts are
 * what was verified. Backend mode: mine and (for Finance / HR) the ones I verify. Local mode: everyone's.
 */
export function declarationsAsProofs(legacy?: InvestmentProof[]): InvestmentProof[] {
  if (API_ENABLED) {
    const { mine, queue } = mirror.get();
    return [...mine, ...queue].filter((d) => d.status !== "draft").map(asProof);
  }
  importLegacy(legacy);
  return local.get().items.filter((d) => d.status !== "draft").map(asProof);
}

/** Changes whenever declarations change (payslip cache key). */
export function declarationsVersion(): string {
  if (API_ENABLED) {
    const m = mirror.get();
    return m.mine.map((d) => `${d.id}:${d.status}:${d.verifiedAmount ?? ""}`).join(",");
  }
  return String(local.version());
}

/* ───────────── Changes ───────────── */

function mutate(id: string, actor: Actor, fn: (d: Declaration) => string | null): string | null {
  const state = local.get();
  const index = state.items.findIndex((d) => d.id === id);
  if (index < 0) return "Declaration not found.";
  const item = structuredClone(state.items[index]);
  const error = fn(item);
  if (error) return error;
  item.updatedAt = nowIso();
  const items = state.items.slice();
  items[index] = item;
  void actor;
  return local.set({ ...state, items });
}

function log(item: Declaration, actor: Actor, action: string, note?: string) {
  item.history = [...item.history, { at: nowIso(), by: actor.id, byName: actor.fullName, action, ...(note ? { note } : {}) }];
}

function checkLocal(actor: Actor, input: DeclInput, excludeId?: string): string | null {
  const cfg = localConfig(actor);
  if (!cfg.hasDeclarations) return "There are no tax declarations in your country.";
  if (cfg.regime && cfg.regime !== "old") return "The new tax regime has no deductions to declare. Switch to the old regime first.";
  const year = cfg.years.find((y) => y.financialYear === input.financialYear);
  if (!year) return "Choose the current or next tax year.";
  if (!year.open) return year.locked ? `Declarations for ${year.financialYear} are closed by Finance.` : `Declarations for ${year.financialYear} are not open (deadline ${year.deadline}).`;
  const section = cfg.sections.find((s) => s.code === input.section);
  if (!section) return "Choose a section from the list.";
  if (!input.title.trim()) return "Enter a title.";
  if (!Number.isFinite(input.amount) || input.amount <= 0) return "Enter an amount above zero.";
  if (section.cap != null) {
    const used = local
      .get()
      .items.filter((d) => d.employeeId === actor.id && d.financialYear === input.financialYear && d.section === section.code && d.status !== "rejected" && d.id !== excludeId)
      .reduce((s, d) => s + (d.status === "verified" && d.verifiedAmount != null ? d.verifiedAmount : d.amount), 0);
    if (used + input.amount > section.cap) return `${section.code} allows up to ${money(section.cap, cfg.currency)} a year; ${money(used, cfg.currency)} is already declared.`;
  }
  return null;
}

async function sniffOk(file: File): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const s = String.fromCharCode(...head);
  return s.startsWith("%PDF") || s.startsWith("\x89PNG") || (head[0] === 0xff && head[1] === 0xd8) || s.startsWith("GIF8") || (s.startsWith("RIFF") && s.slice(8, 12) === "WEBP");
}

/** Type and size check before any upload (the server checks again). */
export async function checkProofFile(file: File): Promise<string | null> {
  const type = fileType(file);
  if (!ALLOWED.has(type)) return "Attach a PDF or an image (PNG, JPG, GIF, WebP).";
  if (file.size > (API_ENABLED ? MAX_FILE : MAX_LOCAL_FILE)) return API_ENABLED ? "The file is larger than 5 MB." : "In this demo (browser storage) proofs can be up to 1 MB.";
  if (!(await sniffOk(file))) return "The file's content doesn't match a PDF or image.";
  return null;
}

export async function createDeclaration(actor: Actor, input: DeclInput): Promise<{ error: string | null; id?: string }> {
  if (API_ENABLED) {
    let id: string | undefined;
    const error = await apiRun(async () => {
      const out = await api.post<DeclOut>("/tax-declarations", { financial_year: input.financialYear, section: input.section, title: input.title.trim(), amount: input.amount, note: input.note?.trim() || null });
      id = out.id;
    }, mirror);
    return { error, id };
  }
  const problem = checkLocal(actor, input);
  if (problem) return { error: problem };
  const cfg = localConfig(actor);
  const section = cfg.sections.find((s) => s.code === input.section)!;
  const at = nowIso();
  const item: Declaration = {
    id: uid("td"), employeeId: actor.id, employeeName: actor.fullName, employeeCode: codeOf(actor.id), countryCode: cfg.countryCode,
    financialYear: input.financialYear, regime: cfg.regime, section: section.code, sectionLabel: section.label, title: input.title.trim(),
    amount: Math.round(input.amount * 100) / 100, currency: cfg.currency, status: "draft", employeeNote: input.note?.trim() || undefined,
    createdAt: at, updatedAt: at, editable: true, documents: [], history: [{ at, by: actor.id, byName: actor.fullName, action: "Saved as draft" }],
  };
  const state = local.get();
  const error = local.set({ ...state, items: [item, ...state.items] });
  return { error, id: item.id };
}

export async function updateDeclaration(actor: Actor, id: string, input: DeclInput): Promise<string | null> {
  if (API_ENABLED) {
    return apiRun(() => apiRequest(`/tax-declarations/${encodeURIComponent(id)}`, { method: "PUT", body: { financial_year: input.financialYear, section: input.section, title: input.title.trim(), amount: input.amount, note: input.note?.trim() || null } }), mirror);
  }
  const problem = checkLocal(actor, input, id);
  if (problem) return problem;
  return mutate(id, actor, (d) => {
    if (d.employeeId !== actor.id) return "Declaration not found.";
    if (d.status !== "draft" && d.status !== "rejected") return "Only drafts and rejected items can be changed. Withdraw a submitted item first.";
    if (d.financialYear !== input.financialYear) return "The tax year of an item can't change; add a new item instead.";
    const section = localSections(d.countryCode as CountryCode).find((s) => s.code === input.section)!;
    Object.assign(d, { section: section.code, sectionLabel: section.label, title: input.title.trim(), amount: input.amount, employeeNote: input.note?.trim() || undefined });
    if (d.status === "rejected") d.status = "draft";
    log(d, actor, "Edited");
    return null;
  });
}

export async function deleteDeclaration(actor: Actor, id: string): Promise<string | null> {
  if (API_ENABLED) return apiRun(() => apiRequest(`/tax-declarations/${encodeURIComponent(id)}`, { method: "DELETE" }), mirror);
  const state = local.get();
  const item = state.items.find((d) => d.id === id && d.employeeId === actor.id);
  if (!item) return "Declaration not found.";
  if (!localEditable(item)) return item.status === "draft" || item.status === "rejected" ? "The deadline for this tax year has passed." : "Only drafts and rejected items can be deleted. Withdraw a submitted item first.";
  return local.set({ ...state, items: state.items.filter((d) => d.id !== id) });
}

export async function submitDeclaration(actor: Actor, id: string): Promise<string | null> {
  if (API_ENABLED) return apiRun(() => api.post(`/tax-declarations/${encodeURIComponent(id)}/submit`), mirror);
  const cfg = localConfig(actor);
  if (cfg.regime && cfg.regime !== "old") return "The new tax regime has no deductions to declare. Switch to the old regime first.";
  let label = "";
  const error = mutate(id, actor, (d) => {
    if (d.employeeId !== actor.id) return "Declaration not found.";
    if (d.status !== "draft" && d.status !== "rejected") return "This item has already been submitted.";
    if (!localEditable(d)) return "The deadline for this tax year has passed.";
    if (!d.documents.length) return "Attach a proof file before submitting.";
    d.status = "submitted";
    d.submittedAt = nowIso();
    d.decidedAt = d.decidedByName = d.decisionNote = undefined;
    d.verifiedAmount = undefined;
    d.regime = cfg.regime;
    log(d, actor, "Submitted for verification");
    label = `${d.section} · ${d.financialYear}`;
    return null;
  });
  if (!error) {
    for (const a of DEMO_ACCOUNTS) if (a.id !== actor.id && VERIFY_ROLES.has(a.role)) notify(a.id, `Verify tax proof: ${actor.fullName}`, label, "/investment?tab=verify");
  }
  return error;
}

export async function withdrawDeclaration(actor: Actor, id: string): Promise<string | null> {
  if (API_ENABLED) return apiRun(() => api.post(`/tax-declarations/${encodeURIComponent(id)}/withdraw`), mirror);
  return mutate(id, actor, (d) => {
    if (d.employeeId !== actor.id) return "Declaration not found.";
    if (d.status !== "submitted") return "Only items waiting for verification can be withdrawn.";
    const y = localYears(d.countryCode as CountryCode).find((w) => w.financialYear === d.financialYear);
    if (!y?.open) return "The deadline for this tax year has passed.";
    d.status = "draft";
    d.submittedAt = undefined;
    log(d, actor, "Withdrawn to draft");
    return null;
  });
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.readAsDataURL(file);
  });
}

export async function uploadProof(actor: Actor, id: string, file: File): Promise<string | null> {
  const problem = await checkProofFile(file);
  if (problem) return problem;
  if (API_ENABLED) {
    return apiRun(async () => {
      await authorizedFetch(`/tax-declarations/${encodeURIComponent(id)}/documents?${new URLSearchParams({ filename: file.name })}`, {
        method: "POST",
        headers: { "Content-Type": fileType(file) },
        body: file,
      });
    }, mirror);
  }
  const dataUrl = await readDataUrl(file);
  return mutate(id, actor, (d) => {
    if (d.employeeId !== actor.id) return "Declaration not found.";
    if (!localEditable(d)) return "Proofs can be added to drafts and rejected items before the deadline.";
    if (d.documents.length >= 5) return "Up to 5 files per item.";
    d.documents = [...d.documents, { id: uid("tdd"), fileName: file.name.replace(/[^\w.\- ()]/g, "_").slice(0, 200), contentType: fileType(file), size: file.size, uploadedAt: nowIso(), dataUrl }];
    log(d, actor, "Proof added", file.name);
    return null;
  });
}

export async function removeProof(actor: Actor, id: string, docId: string): Promise<string | null> {
  if (API_ENABLED) return apiRun(() => apiRequest(`/tax-declarations/${encodeURIComponent(id)}/documents/${encodeURIComponent(docId)}`, { method: "DELETE" }), mirror);
  return mutate(id, actor, (d) => {
    if (d.employeeId !== actor.id) return "Declaration not found.";
    if (!localEditable(d)) return "Proofs of a submitted item can't be removed. Withdraw it first.";
    const doc = d.documents.find((x) => x.id === docId);
    if (!doc) return "File not found.";
    d.documents = d.documents.filter((x) => x.id !== docId);
    log(d, actor, "Proof removed", doc.fileName);
    return null;
  });
}

export async function downloadProof(item: Declaration, doc: DeclDoc): Promise<string | null> {
  if (API_ENABLED) return fetchFile(`/tax-declarations/${encodeURIComponent(item.id)}/documents/${encodeURIComponent(doc.id)}`, doc.fileName);
  const found = local.get().items.find((d) => d.id === item.id)?.documents.find((x) => x.id === doc.id);
  if (!found?.dataUrl) return "This file isn't stored in this browser.";
  const blob = await (await fetch(found.dataUrl)).blob();
  saveFile(blob, found.fileName);
  return null;
}

export async function decideDeclaration(actor: Actor, id: string, decision: "verify" | "reject", note: string, verifiedAmount?: number): Promise<string | null> {
  if (decision === "reject" && !note.trim()) return "Say why the proof is rejected.";
  if (API_ENABLED) {
    return apiRun(() => api.post(`/tax-declarations/${encodeURIComponent(id)}/decision`, { decision, note: note.trim() || null, verified_amount: verifiedAmount ?? null }), mirror);
  }
  if (!VERIFY_ROLES.has(actor.role)) return "Only Finance or HR can verify tax declarations.";
  let target: Declaration | null = null;
  const error = mutate(id, actor, (d) => {
    if (d.employeeId === actor.id) return "You can't verify your own declarations.";
    if (d.status !== "submitted") return d.status === "verified" || d.status === "rejected" ? "This item has already been reviewed." : "This item isn't submitted.";
    if (decision === "reject") {
      d.status = "rejected";
      d.verifiedAmount = undefined;
    } else {
      const allowed = verifiedAmount ?? d.amount;
      if (!(allowed > 0) || allowed > d.amount) return "The verified amount must be above zero and no more than the amount declared.";
      d.status = "verified";
      d.verifiedAmount = allowed;
    }
    d.decidedByName = actor.fullName;
    d.decidedAt = nowIso();
    d.decisionNote = note.trim() || undefined;
    log(d, actor, d.status === "verified" ? "Verified" : "Rejected", note.trim() || undefined);
    target = d;
    return null;
  });
  const done = target as Declaration | null;
  if (!error && done) notify(done.employeeId, `Tax proof ${done.status}: ${done.section} · ${done.financialYear}`, done.decisionNote ?? (done.status === "verified" ? "It now counts toward your tax (old regime)." : ""), `/investment?item=${done.id}`);
  return error;
}

export async function setDeclarationWindow(actor: Actor, w: { countryCode: string; financialYear: string; opensOn: string; deadline: string; proofDeadline?: string; locked: boolean }): Promise<string | null> {
  if (w.deadline < w.opensOn) return "The deadline must be after the opening date.";
  if (w.proofDeadline && w.proofDeadline < w.deadline) return "The proof deadline can't be before the declaration deadline.";
  if (API_ENABLED) {
    return apiRun(() => apiRequest("/tax-declarations/admin/window", { method: "PUT", body: { country_code: w.countryCode, financial_year: w.financialYear, opens_on: w.opensOn, deadline: w.deadline, proof_deadline: w.proofDeadline || null, locked: w.locked } }), mirror);
  }
  if (!VERIFY_ROLES.has(actor.role)) return "Only Finance or HR can set declaration deadlines.";
  const state = local.get();
  const windows = state.windows.filter((x) => !(x.countryCode === w.countryCode && x.financialYear === w.financialYear));
  return local.set({ ...state, windows: [...windows, { ...w }] });
}

/** The person's role, for backend pages that need to know before the config loads. */
export async function sessionRole(): Promise<string> {
  return API_ENABLED ? ((await apiSessionMe().catch(() => null))?.role ?? "") : "";
}
