/**
 * HR cases and the HR service desk from the backend (VITE_API_URL mode only), mapped to the shapes the
 * grievance store and the collab store already use.
 */
import { API_URL, ApiError, api, apiSessionMe, isApiAdmin, isApiHr, type MeOut } from "./client.ts";
import { downloadBlob } from "./syncShared.ts";
import type { CaseCategory, CaseEntry, CaseRecord, CaseStatus } from "../features/compliance/grievanceStore.ts";
import type { HrRequest, HrRequestCategory, HrRequestPriority } from "../data/collabData.ts";

/** A file on a case or HR request (backend mode). */
export interface ApiFile {
  id: string;
  name: string;
  contentType: string;
  size: number;
  at: string;
  confidential?: boolean;
  byReporter?: boolean;
}

/** Saves a downloaded file through the browser. */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Backend times are UTC; some come without a zone suffix. */
export function utcIso(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  return /[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`;
}

const enc = encodeURIComponent;

/* ───────── HR cases ───────── */

interface HrCaseEntryOut {
  id: string;
  kind: string;
  text: string;
  author: string;
  confidential: boolean;
  status: string | null;
  created_at: string;
}

interface HrCaseOut {
  id: string;
  code: string;
  category: string;
  description: string;
  anonymous: boolean;
  status: string;
  priority: string;
  view: "reporter" | "manager";
  reporter_id?: string | null;
  reporter_name?: string | null;
  against_id?: string | null;
  against_name?: string | null;
  assignee_id?: string | null;
  assignee_name?: string | null;
  resolution?: string | null;
  closed_on?: string | null;
  archived_on?: string | null;
  escalated_at?: string | null;
  escalation_count?: number;
  created_at: string;
  timeline: HrCaseEntryOut[];
  files?: {
    id: string;
    file_name: string;
    content_type: string;
    size_bytes: number;
    confidential: boolean;
    by_reporter: boolean;
    created_at: string;
  }[];
}

function toEntryKind(kind: string): CaseEntry["kind"] {
  if (kind === "filed" || kind === "status" || kind === "comment") return kind;
  return "note"; // note, escalation
}

function toCase(c: HrCaseOut, myId: string): CaseRecord {
  return {
    id: c.id,
    code: c.code,
    category: c.category as CaseCategory,
    description: c.description,
    // The reporter's own view: it is me. HR's view: only when the case is not anonymous.
    reporterId: c.view === "reporter" ? myId : (c.reporter_id ?? ""),
    anonymous: c.anonymous,
    againstId: c.against_id ?? undefined,
    againstName: c.against_name ?? undefined,
    createdOn: (utcIso(c.created_at) ?? "").slice(0, 10),
    status: c.status as CaseStatus,
    resolution: c.resolution ?? undefined,
    closedOn: c.closed_on ?? undefined,
    assigneeId: c.assignee_id ?? undefined,
    archivedOn: c.archived_on ?? undefined,
    priority: c.priority,
    escalationCount: c.escalation_count ?? 0,
    escalatedAt: utcIso(c.escalated_at),
    files: (c.files ?? []).map((f) => ({
      id: f.id,
      name: f.file_name,
      contentType: f.content_type,
      size: f.size_bytes,
      at: utcIso(f.created_at) ?? f.created_at,
      confidential: f.confidential,
      byReporter: f.by_reporter,
    })),
    timeline: c.timeline.map((e) => ({
      id: e.id,
      at: utcIso(e.created_at) ?? e.created_at,
      kind: toEntryKind(e.kind),
      text: e.kind === "escalation" ? `Escalated: ${e.text}` : e.text,
      authorId: e.author === "Reporter" ? (c.view === "reporter" ? myId : "") : "",
      authorLabel: e.author,
      confidential: e.confidential,
      status: (e.status as CaseStatus | null) ?? undefined,
    })),
  };
}

let meCache: { account: string; employeeId: string } | null = null;

async function myEmployeeId(accountId: string): Promise<string> {
  if (meCache?.account === accountId) return meCache.employeeId;
  const me = await api.get<MeOut>("/auth/me");
  meCache = { account: accountId, employeeId: me.employee_id ?? accountId };
  return meCache.employeeId;
}

/** Cases I raised plus cases I work (HR / committee), newest first. */
export async function loadApiCases(accountId: string): Promise<CaseRecord[]> {
  const myId = await myEmployeeId(accountId);
  const [mine, manage] = await Promise.all([
    api.get<HrCaseOut[]>("/cases", { view: "mine" }),
    api.get<HrCaseOut[]>("/cases", { view: "manage" }).catch(() => [] as HrCaseOut[]),
  ]);
  const byId = new Map<string, CaseRecord>();
  for (const c of [...mine, ...manage]) byId.set(c.id, toCase(c, myId));
  return [...byId.values()].sort((a, b) => (b.timeline[0]?.at ?? b.createdOn).localeCompare(a.timeline[0]?.at ?? a.createdOn));
}

export async function apiRaiseCase(input: { category: string; description: string; againstId?: string; anonymous: boolean }) {
  return api.post<{ id: string; code: string; status: string }>("/cases", {
    category: input.category,
    description: input.description.trim(),
    against_id: input.againstId || null,
    anonymous: input.anonymous,
  });
}

export const apiCaseStatus = (id: string, status: string, note: string) =>
  api.post(`/cases/${enc(id)}/status`, { status, note: note.trim() });

export const apiAssignCase = (id: string, assigneeId: string) =>
  api.post(`/cases/${enc(id)}/assign`, { assignee_id: assigneeId || null });

export const apiCaseNote = (id: string, text: string, confidential: boolean) =>
  api.post(`/cases/${enc(id)}/notes`, { text: text.trim(), confidential });

export const apiCaseComment = (id: string, text: string) => api.post(`/cases/${enc(id)}/comments`, { text: text.trim() });

export const apiEscalateCase = (id: string, reason: string) => api.post(`/cases/${enc(id)}/escalate`, { reason: reason.trim() });

export const apiUploadCaseFile = (id: string, file: File, confidential: boolean) =>
  uploadFile(`/cases/${enc(id)}/files`, file, confidential ? { confidential: "true" } : {});

export async function apiDownloadCaseFile(caseId: string, file: ApiFile) {
  saveBlob(await downloadBlob(`/cases/${enc(caseId)}/files/${enc(file.id)}`), file.name);
}

/* ───────── HR service desk ───────── */

interface DeskCommentOut {
  id: number;
  author_id: string | null;
  author_name?: string | null;
  text: string;
  system: boolean;
  created_at: string;
}

interface DeskTicketOut {
  id: string;
  requester_id: string;
  requester_name?: string | null;
  category: string;
  subject: string;
  description: string;
  priority: string;
  status: string;
  assignee_id: string | null;
  submitted_at: string;
  due_at: string;
  first_response_at: string | null;
  resolved_at: string | null;
  satisfaction: number | null;
  satisfaction_comment: string | null;
  escalated_at?: string | null;
  escalation_level?: number;
  overdue?: boolean;
  comments?: DeskCommentOut[];
  files?: { id: string; file_name: string; content_type: string; size_bytes: number; uploaded_by: string | null; created_at: string }[];
}

function toRequest(t: DeskTicketOut): HrRequest {
  const submitted = utcIso(t.submitted_at) ?? t.submitted_at;
  const comments = t.comments ?? [];
  const last = comments.length ? utcIso(comments[comments.length - 1].created_at) : undefined;
  return {
    id: t.id,
    category: t.category as HrRequestCategory,
    subject: t.subject,
    description: t.description,
    status: t.status as HrRequest["status"],
    requesterId: t.requester_id,
    requesterName: t.requester_name ?? undefined,
    createdAt: submitted.slice(0, 10),
    updatedAt: (last ?? submitted).slice(0, 10),
    comments: comments.map((c) => ({
      at: utcIso(c.created_at) ?? c.created_at,
      author: c.author_name ?? (c.system ? "System" : "HR"),
      text: c.text,
    })),
    submittedAt: submitted,
    assigneeId: t.assignee_id ?? "",
    priority: t.priority as HrRequestPriority,
    dueAt: utcIso(t.due_at),
    firstResponseAt: utcIso(t.first_response_at),
    satisfaction: t.satisfaction ?? undefined,
    satisfactionComment: t.satisfaction_comment ?? undefined,
    escalatedAt: utcIso(t.escalated_at),
    overdue: t.overdue ?? false,
    files: (t.files ?? []).map((f) => ({
      id: f.id,
      name: f.file_name,
      contentType: f.content_type,
      size: f.size_bytes,
      at: utcIso(f.created_at) ?? f.created_at,
    })),
  };
}

/** Requests I raised, those assigned to me and (HR / admin) the whole queue, with comments. */
export async function loadApiHrRequests(): Promise<HrRequest[]> {
  const [raised, mine, all] = await Promise.all([
    api.get<DeskTicketOut[]>("/desk/requests", { queue: "raised", limit: 500 }),
    api.get<DeskTicketOut[]>("/desk/requests", { queue: "mine", limit: 500 }),
    // The whole queue is for the HR desk (HR and admin) only.
    apiSessionMe().then((me) =>
      isApiHr(me.role) || isApiAdmin(me.role)
        ? api.get<DeskTicketOut[]>("/desk/requests", { queue: "all", limit: 500 }).catch(() => [] as DeskTicketOut[])
        : ([] as DeskTicketOut[]),
    ),
  ]);
  const ids = [...new Set([...raised, ...mine, ...all].map((t) => t.id))];
  // The list leaves out comments; read each request in full.
  const full = await Promise.all(ids.map((id) => api.get<DeskTicketOut>(`/desk/requests/${enc(id)}`)));
  return full.map(toRequest).sort((a, b) => (b.submittedAt ?? "").localeCompare(a.submittedAt ?? ""));
}

export async function apiCreateHrRequest(input: { category: string; subject: string; description: string; priority?: string }) {
  const out = await api.post<DeskTicketOut>("/desk/requests", {
    category: input.category,
    subject: input.subject.trim(),
    description: input.description.trim(),
    priority: input.priority ?? "Normal",
  });
  return out.id;
}

export const apiHrComment = (id: string, text: string) => api.post(`/desk/requests/${enc(id)}/comments`, { text: text.trim() });
export const apiHrStatus = (id: string, status: string) => api.post(`/desk/requests/${enc(id)}/status`, { status });
export const apiHrAssign = (id: string, assigneeId: string) =>
  api.post(`/desk/requests/${enc(id)}/assign`, { assignee_id: assigneeId || null });
export const apiHrRate = (id: string, rating: number, comment?: string) =>
  api.post(`/desk/requests/${enc(id)}/rating`, { rating, comment: comment?.trim() || null });
export const apiHrEscalate = (id: string) => api.post(`/desk/requests/${enc(id)}/escalate`);
export const apiHrUploadFile = (id: string, file: File) => uploadFile(`/desk/requests/${enc(id)}/files`, file, {});
export async function apiHrDownloadFile(ticketId: string, file: ApiFile) {
  saveBlob(await downloadBlob(`/desk/requests/${enc(ticketId)}/files/${enc(file.id)}`), file.name);
}

/** Raw-body upload (the API reads the bytes; the name and flags ride in the query). */
async function uploadFile(path: string, file: File, query: Record<string, string>): Promise<unknown> {
  const params = new URLSearchParams({ ...query, filename: file.name });
  const send = () => {
    let token: string | null = null;
    try {
      token = (JSON.parse(sessionStorage.getItem("timez.api.tokens") ?? "null") as { access?: string } | null)?.access ?? null;
    } catch {
      token = null;
    }
    return fetch(`${API_URL}/api/v1${path}?${params}`, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream", Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: file,
    });
  };
  let res: Response;
  try {
    res = await send();
    if (res.status === 401) {
      await api.get("/auth/me"); // refreshes the session (or ends it)
      res = await send();
    }
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(0, "The server is starting up. Try again in about 30 seconds.");
  }
  if (!res.ok) {
    let message = res.status === 413 ? "The file is too large." : "That didn't work. Try again.";
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body.detail === "string") message = body.detail;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, message);
  }
  return res.json();
}
