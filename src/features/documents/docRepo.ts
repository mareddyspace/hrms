/**
 * Document repository for "Documents & letters": categories (with labels HR can change), upload with description and
 * expiry, versions, HR verification, expiry and preview. Backend mode: /documents (backend/app/routers/documents.py).
 * Local mode: this browser (metadata in localStorage, files in the receipt store), with the same rules.
 */
import { API_ENABLED, api, apiRequest } from "../../api/client.ts";
import { attempt, authorizedFetch, fileType } from "../../api/syncRewardsShared.ts";
import { errorText } from "../../api/syncShared.ts";
import { downloadDocument } from "../../api/syncRewards.ts";
import { loadReceipt, saveReceipt } from "../../data/receiptStore.ts";
import { uid, todayISO } from "../../model.ts";
import { createLocalStore } from "../payrequests/localStore.ts";
import { notify as notifyLocal } from "../workforce/workforceShared.ts";
import { DEMO_ACCOUNTS } from "../../demoAccounts.ts";
import { getRewardState } from "../../data/rewardLocal.ts";

export type Verification = "pending" | "verified" | "rejected" | null;

export interface CategoryConfig {
  name: string;
  label: string;
  verification: boolean;
  employeeUpload: boolean;
}

export interface RepoVersion {
  id: string;
  version: number;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: string;
  on: string;
}

export interface RepoDoc {
  id: string;
  employeeId: string;
  employeeName: string;
  category: string;
  title: string;
  description?: string;
  currentVersion: number;
  expiryDate?: string;
  daysToExpiry?: number;
  letterRequestId?: string;
  uploadedBy: string;
  createdOn: string;
  updatedOn: string;
  verification: Verification;
  verificationNote?: string;
  verifiedBy?: string;
  verifiedOn?: string;
  versions: RepoVersion[];
}

export interface RepoRules {
  categories: CategoryConfig[];
  maxBytes: number;
  contentTypes: string[];
}

/** Defaults; the backend's configuration wins in backend mode (app/services/documents.py DEFAULT_CATEGORY_CONFIG). */
export const DEFAULT_CATEGORIES: CategoryConfig[] = [
  { name: "Personal", label: "Personal", verification: false, employeeUpload: true },
  { name: "Identity", label: "Identity proofs", verification: true, employeeUpload: true },
  { name: "Education", label: "Education certificates", verification: true, employeeUpload: true },
  { name: "Employment", label: "Employment", verification: true, employeeUpload: true },
  { name: "Contracts", label: "Contracts", verification: false, employeeUpload: false },
  { name: "Certifications", label: "Certifications", verification: true, employeeUpload: true },
  { name: "Compliance", label: "Compliance", verification: false, employeeUpload: true },
  { name: "Medical", label: "Medical", verification: false, employeeUpload: true },
  { name: "Payroll", label: "Salary documents", verification: false, employeeUpload: false },
  { name: "Policies", label: "Company policies", verification: false, employeeUpload: false },
  { name: "Letters", label: "Letters", verification: false, employeeUpload: false },
  { name: "Other", label: "Other", verification: false, employeeUpload: true },
];

const HR_ROLES = ["hr", "hr_admin", "hrbp"];
export const isDocHr = (role: string) => HR_ROLES.includes(role);
export const canConfigure = (role: string) => isDocHr(role) || role === "admin" || role === "super_admin";

/* ───────────── Backend ───────────── */

interface DocOut {
  id: string;
  employee_id: string;
  employee_name: string | null;
  category: string;
  title: string;
  current_version: number;
  expiry_date: string | null;
  letter_request_id: string | null;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
  days_to_expiry: number | null;
  description?: string | null;
  verification_status?: Verification;
  verification_note?: string | null;
  verified_by?: string | null;
  verified_at?: string | null;
  versions: { id: string; version: number; file_name: string; content_type: string; size_bytes: number; uploaded_by: string | null; created_at: string }[];
}

const nameOfAccount = (id: string | null | undefined) => (id ? (DEMO_ACCOUNTS.find((a) => a.id === id)?.fullName ?? id) : "");

function fromApi(d: DocOut): RepoDoc {
  return {
    id: d.id,
    employeeId: d.employee_id,
    employeeName: d.employee_name ?? d.employee_id,
    category: d.category,
    title: d.title,
    ...(d.description ? { description: d.description } : {}),
    currentVersion: d.current_version,
    ...(d.expiry_date ? { expiryDate: d.expiry_date, daysToExpiry: d.days_to_expiry ?? undefined } : {}),
    ...(d.letter_request_id ? { letterRequestId: d.letter_request_id } : {}),
    uploadedBy: nameOfAccount(d.uploaded_by),
    createdOn: d.created_at.slice(0, 10),
    updatedOn: d.updated_at.slice(0, 10),
    verification: d.verification_status ?? null,
    ...(d.verification_note ? { verificationNote: d.verification_note } : {}),
    ...(d.verified_by ? { verifiedBy: d.verified_by, verifiedOn: d.verified_at?.slice(0, 10) } : {}),
    versions: d.versions.map((v) => ({ id: v.id, version: v.version, fileName: v.file_name, contentType: v.content_type, sizeBytes: v.size_bytes, uploadedBy: nameOfAccount(v.uploaded_by), on: v.created_at.slice(0, 10) })),
  };
}

const enc = encodeURIComponent;

/* ───────────── Local store ───────────── */

interface LocalDoc extends Omit<RepoDoc, "daysToExpiry" | "employeeName"> {
  employeeName: string;
}

const local = createLocalStore<{ docs: LocalDoc[]; categories?: CategoryConfig[] }>("timez.docRepo.v1", () => ({ docs: [] }), (saved) =>
  saved && Array.isArray((saved as { docs?: unknown }).docs) ? (saved as { docs: LocalDoc[] }) : null,
);

export function subscribeRepo(fn: () => void): () => void {
  return local.subscribe(fn);
}
export function repoVersion(): number {
  return local.version();
}

function daysTo(date?: string): number | undefined {
  if (!date) return undefined;
  return Math.round((Date.parse(date) - Date.parse(todayISO())) / 86_400_000);
}

const LEGACY_READ_ONLY = "This older library entry can't be changed here. Upload the document again to keep versions and expiry.";
const LOCAL_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"];

/* ───────────── Reading ───────────── */

export async function loadRules(): Promise<RepoRules> {
  if (API_ENABLED) {
    const r = await api.get<{ categories: string[]; max_bytes: number; content_types: string[]; category_config?: { name: string; label: string; verification: boolean; employee_upload: boolean }[] }>("/documents/rules");
    const config = r.category_config?.length
      ? r.category_config.map((c) => ({ name: c.name, label: c.label, verification: c.verification, employeeUpload: c.employee_upload }))
      : r.categories.map((name) => DEFAULT_CATEGORIES.find((c) => c.name === name) ?? { name, label: name, verification: false, employeeUpload: true });
    return { categories: config, maxBytes: r.max_bytes, contentTypes: r.content_types };
  }
  return { categories: local.get().categories ?? DEFAULT_CATEGORIES, maxBytes: 1.5 * 1024 * 1024, contentTypes: LOCAL_TYPES };
}

export async function loadDocs(employeeId: string, actorId: string): Promise<RepoDoc[]> {
  if (API_ENABLED) {
    const rows = await api.get<DocOut[]>("/documents", employeeId === actorId ? undefined : { employee_id: employeeId });
    return rows.map(fromApi);
  }
  const own = local
    .get()
    .docs.filter((d) => d.employeeId === employeeId)
    .map((d) => ({ ...d, daysToExpiry: daysTo(d.expiryDate) }));
  return [...own, ...legacyDocs(employeeId)].sort((a, b) => b.updatedOn.localeCompare(a.updatedOn));
}

/** Local mode: documents already in the older browser library (seeded demo files, issued letters), read-only. */
function legacyDocs(employeeId: string): RepoDoc[] {
  return getRewardState()
    .library.filter((d) => d.employeeId === employeeId)
    .map((d) => {
      const on = d.uploadedAt.slice(0, 10);
      const category = DEFAULT_CATEGORIES.some((c) => c.name === d.category) ? d.category : d.letterId ? "Letters" : "Other";
      return {
        id: `legacy-${d.id}`,
        employeeId: d.employeeId,
        employeeName: d.employeeName,
        category,
        title: d.name,
        description: `${d.docType}${d.sizeLabel && d.sizeLabel !== "—" ? ` · ${d.sizeLabel}` : ""}`,
        currentVersion: 1,
        uploadedBy: d.uploadedBy,
        createdOn: on,
        updatedOn: on,
        verification: null,
        versions: [],
      };
    });
}

export async function loadDoc(id: string): Promise<RepoDoc | null> {
  if (API_ENABLED) {
    try {
      return fromApi(await api.get<DocOut>(`/documents/${enc(id)}`));
    } catch {
      return null;
    }
  }
  const d = local.get().docs.find((x) => x.id === id);
  if (!d && id.startsWith("legacy-")) return legacyDocs(getRewardState().library.find((x) => `legacy-${x.id}` === id)?.employeeId ?? "").find((x) => x.id === id) ?? null;
  return d ? { ...d, daysToExpiry: daysTo(d.expiryDate) } : null;
}

export async function loadExpiring(days: number, actor: { id: string; role: string }): Promise<RepoDoc[]> {
  if (API_ENABLED) {
    try {
      return (await api.get<DocOut[]>("/documents/expiring", { days })).map(fromApi);
    } catch {
      return [];
    }
  }
  return local
    .get()
    .docs.filter((d) => (d.employeeId === actor.id || isDocHr(actor.role)) && d.expiryDate && (daysTo(d.expiryDate) ?? 999) <= days)
    .map((d) => ({ ...d, daysToExpiry: daysTo(d.expiryDate) }));
}

export async function loadVerificationQueue(actor: { id: string; role: string }): Promise<RepoDoc[]> {
  if (!isDocHr(actor.role)) return [];
  if (API_ENABLED) {
    try {
      return (await api.get<DocOut[]>("/documents/verification-queue")).map(fromApi);
    } catch {
      return [];
    }
  }
  return local.get().docs.filter((d) => d.verification === "pending" && d.employeeId !== actor.id).map((d) => ({ ...d, daysToExpiry: daysTo(d.expiryDate) }));
}

/* ───────────── Changes ───────────── */

export interface UploadInput {
  category: string;
  title: string;
  description: string;
  expiryDate?: string;
  employeeId?: string;
}

export function fileProblem(file: File, rules: RepoRules): string | null {
  if (file.size === 0) return "The file is empty.";
  if (file.size > rules.maxBytes) return `The file is larger than ${(rules.maxBytes / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB.`;
  if (!rules.contentTypes.includes(fileType(file))) return API_ENABLED ? "Upload a PDF, Word (.docx) or image file." : "Upload a PDF or image file.";
  return null;
}

type Actor = { id: string; fullName: string; role: string };

export async function uploadDoc(actor: Actor, file: File, input: UploadInput, rules: RepoRules): Promise<string | null> {
  const problem = fileProblem(file, rules);
  if (problem) return problem;
  if (!input.title.trim()) return "Give the document a name.";
  const cat = rules.categories.find((c) => c.name === input.category);
  if (!cat || cat.name === "Letters") return "Choose a category.";
  const owner = input.employeeId ?? actor.id;
  const hr = isDocHr(actor.role);
  if (!hr && owner !== actor.id) return "Only the employee or HR can add documents.";
  if (!hr && !cat.employeeUpload) return `HR adds ${cat.label.toLowerCase()} documents.`;
  if (API_ENABLED) {
    const q = new URLSearchParams({ category: input.category, title: input.title.trim(), filename: file.name });
    if (input.employeeId && input.employeeId !== actor.id) q.set("employee_id", input.employeeId);
    if (input.expiryDate) q.set("expiry_date", input.expiryDate);
    if (input.description.trim()) q.set("description", input.description.trim());
    return attempt(() => authorizedFetch(`/documents?${q.toString()}`, { method: "POST", headers: { "Content-Type": fileType(file), Accept: "application/json" }, body: file }));
  }
  try {
    const saved = await saveReceipt(file);
    const today = todayISO();
    const pending = cat.verification && owner === actor.id && !hr;
    const doc: LocalDoc = {
      id: uid("doc"),
      employeeId: owner,
      employeeName: DEMO_ACCOUNTS.find((a) => a.id === owner)?.fullName ?? owner,
      category: input.category,
      title: input.title.trim(),
      ...(input.description.trim() ? { description: input.description.trim() } : {}),
      currentVersion: 1,
      ...(input.expiryDate ? { expiryDate: input.expiryDate } : {}),
      uploadedBy: actor.fullName,
      createdOn: today,
      updatedOn: today,
      verification: pending ? "pending" : null,
      versions: [{ id: saved.id, version: 1, fileName: file.name, contentType: file.type, sizeBytes: file.size, uploadedBy: actor.fullName, on: today }],
    };
    const error = local.set({ ...local.get(), docs: [doc, ...local.get().docs] });
    if (!error && pending) for (const a of DEMO_ACCOUNTS) if (isDocHr(a.role) && a.id !== actor.id) notifyLocal(a.id, `${actor.fullName} uploaded ${doc.title}`, "It is waiting for verification.", "/documents");
    return error;
  } catch (e) {
    return errorText(e, "Couldn't save the file.");
  }
}

export async function uploadVersion(actor: Actor, doc: RepoDoc, file: File, rules: RepoRules, expiryDate?: string): Promise<string | null> {
  const problem = fileProblem(file, rules);
  if (problem) return problem;
  if (doc.category === "Letters") return "Letters get new versions only when HR regenerates them.";
  if (API_ENABLED) {
    const q = new URLSearchParams({ filename: file.name });
    if (expiryDate) q.set("expiry_date", expiryDate);
    return attempt(() => authorizedFetch(`/documents/${enc(doc.id)}/versions?${q.toString()}`, { method: "POST", headers: { "Content-Type": fileType(file), Accept: "application/json" }, body: file }));
  }
  if (doc.id.startsWith("legacy-")) return LEGACY_READ_ONLY;
  const hr = isDocHr(actor.role);
  const cat = rules.categories.find((c) => c.name === doc.category);
  if (!hr && doc.employeeId !== actor.id) return "Only the employee or HR can add versions.";
  if (!hr && cat && !cat.employeeUpload) return "HR updates documents in this category.";
  try {
    const saved = await saveReceipt(file);
    const today = todayISO();
    const pending = !!cat?.verification && doc.employeeId === actor.id && !hr;
    return local.set({
      ...local.get(),
      docs: local.get().docs.map((d) =>
        d.id === doc.id
          ? {
              ...d,
              currentVersion: d.currentVersion + 1,
              updatedOn: today,
              ...(expiryDate ? { expiryDate } : {}),
              verification: pending ? "pending" : hr && d.verification && d.verification !== "verified" ? "verified" : d.verification,
              ...(pending ? { verificationNote: undefined, verifiedBy: undefined, verifiedOn: undefined } : {}),
              versions: [...d.versions, { id: saved.id, version: d.currentVersion + 1, fileName: file.name, contentType: file.type, sizeBytes: file.size, uploadedBy: actor.fullName, on: today }],
            }
          : d,
      ),
    });
  } catch (e) {
    return errorText(e, "Couldn't save the file.");
  }
}

export async function setExpiry(actor: Actor, doc: RepoDoc, expiry: string | null): Promise<string | null> {
  if (API_ENABLED) return attempt(() => apiRequest(`/documents/${enc(doc.id)}`, { method: "PATCH", body: { expiry_date: expiry || null } }));
  if (doc.id.startsWith("legacy-")) return LEGACY_READ_ONLY;
  if (doc.employeeId !== actor.id && !isDocHr(actor.role)) return "Only the employee or HR can change the expiry.";
  return local.set({ ...local.get(), docs: local.get().docs.map((d) => (d.id === doc.id ? { ...d, expiryDate: expiry || undefined, updatedOn: todayISO() } : d)) });
}

export async function verifyDoc(actor: Actor, doc: RepoDoc, decision: "verify" | "reject", note: string): Promise<string | null> {
  if (decision === "reject" && !note.trim()) return "Say why it is rejected, so they can upload a better copy.";
  if (API_ENABLED) return attempt(() => api.post(`/documents/${enc(doc.id)}/verification`, { decision, note: note.trim() || null }));
  if (!isDocHr(actor.role) || doc.employeeId === actor.id) return "Only HR can verify someone else's documents.";
  if (doc.verification !== "pending") return "This document isn't waiting for verification.";
  const status = decision === "verify" ? "verified" : "rejected";
  const error = local.set({
    ...local.get(),
    docs: local.get().docs.map((d) => (d.id === doc.id ? { ...d, verification: status, verificationNote: note.trim() || undefined, verifiedBy: actor.fullName, verifiedOn: todayISO() } : d)),
  });
  if (!error) notifyLocal(doc.employeeId, `${doc.title} ${status}`, note.trim(), "/documents");
  return error;
}

export async function saveCategories(actor: Actor, categories: CategoryConfig[]): Promise<string | null> {
  if (!canConfigure(actor.role)) return "Only HR or an administrator can change document categories.";
  if (categories.some((c) => !c.label.trim())) return "Every category needs a name.";
  if (API_ENABLED) {
    return attempt(() =>
      apiRequest("/documents/categories", {
        method: "PUT",
        body: categories.map((c) => ({ name: c.name, label: c.label.trim(), verification: c.verification, employee_upload: c.employeeUpload })),
      }),
    );
  }
  return local.set({ ...local.get(), categories: categories.map((c) => ({ ...c, label: c.label.trim(), employeeUpload: c.name === "Letters" ? false : c.employeeUpload })) });
}

/** Downloads (or opens for preview) one version. */
export async function openVersion(doc: RepoDoc, version: RepoVersion, mode: "save" | "open"): Promise<string | null> {
  if (API_ENABLED) return downloadDocument(doc.id, version.fileName, version.version, mode);
  const dataUrl = await loadReceipt(version.id);
  if (!dataUrl) return "This file isn't available in this browser.";
  const blob = await (await fetch(dataUrl)).blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  if (mode === "save") a.download = version.fileName;
  else a.target = "_blank";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return null;
}

/** An inline preview (images and PDFs) as an object URL; the caller revokes it. */
export async function previewUrl(doc: RepoDoc, version: RepoVersion): Promise<{ url: string; type: string } | string> {
  try {
    let blob: Blob;
    if (API_ENABLED) {
      const res = await authorizedFetch(`/documents/${enc(doc.id)}/download?version=${version.version}`);
      blob = await res.blob();
    } else {
      const dataUrl = await loadReceipt(version.id);
      if (!dataUrl) return "This file isn't available in this browser.";
      blob = await (await fetch(dataUrl)).blob();
    }
    return { url: URL.createObjectURL(blob), type: version.contentType || blob.type };
  } catch (e) {
    return errorText(e, "Couldn't load the preview.");
  }
}
