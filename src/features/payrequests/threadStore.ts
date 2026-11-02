/**
 * Thread of a self-service request: comments, "more information" requests, supporting files and the audit trail.
 * Backend mode: /requests/{type}/{id}/... (backend/app/routers/request_extras.py). Local mode: this browser
 * (comments in localStorage, files in the receipt store), with the same rules.
 */
import { API_ENABLED, api } from "../../api/client.ts";
import { authorizedFetch } from "../../api/syncRewardsShared.ts";
import { downloadBlob, errorText } from "../../api/syncShared.ts";
import { notify as notifyLocal } from "../workforce/workforceShared.ts";
import { openReceipt, receiptFileError, saveReceipt } from "../../data/receiptStore.ts";
import { uid } from "../../model.ts";
import { createLocalStore } from "./localStore.ts";

export type ThreadEntity = "expense" | "travel" | "cash_advance" | "encashment" | "overtime" | "document";
export type CommentKind = "comment" | "info_request" | "info_reply";
export type FilePurpose = "supporting" | "settlement" | "booking";

export interface ThreadComment {
  id: string;
  authorId: string | null;
  authorName: string;
  kind: CommentKind;
  body: string;
  at: string;
}

export interface ThreadFile {
  id: string;
  purpose: FilePurpose;
  name: string;
  type: string;
  size: number;
  by?: string;
  at: string;
}

export interface ThreadAudit {
  action: string;
  actor: string;
  at: string;
}

export interface Thread {
  comments: ThreadComment[];
  files: ThreadFile[];
  audit: ThreadAudit[];
  infoOpen: boolean;
  canComment: boolean;
  canRequestInfo: boolean;
  canAttach: boolean;
}

/** Who is looking, and what the page already knows about the request (local mode works the rights out from it). */
export interface ThreadContext {
  actorId: string;
  actorName: string;
  ownerId: string;
  /** The request waits on this person now. */
  canDecide: boolean;
  /** HR / finance / admin who can see it. */
  reviewer: boolean;
  label: string;
  href: string;
}

/* ───────────── Local store ───────────── */

interface LocalThread {
  comments: ThreadComment[];
  files: ThreadFile[];
  audit: ThreadAudit[];
}

const local = createLocalStore<{ threads: Record<string, LocalThread> }>(
  "timez.requestThreads.v1",
  () => ({ threads: {} }),
  (saved) => (saved && typeof (saved as { threads?: unknown }).threads === "object" ? (saved as { threads: Record<string, LocalThread> }) : null),
);

const key = (type: ThreadEntity, id: string) => `${type}:${id}`;

function localThread(type: ThreadEntity, id: string): LocalThread {
  return local.get().threads[key(type, id)] ?? { comments: [], files: [], audit: [] };
}

function saveLocal(type: ThreadEntity, id: string, next: LocalThread): string | null {
  return local.set({ threads: { ...local.get().threads, [key(type, id)]: next } });
}

export function infoOpen(comments: { kind: CommentKind; at: string }[]): boolean {
  const asked = comments.filter((c) => c.kind === "info_request").map((c) => c.at).sort();
  const replied = comments.filter((c) => c.kind === "info_reply").map((c) => c.at).sort();
  return asked.length > 0 && (replied.length === 0 || asked[asked.length - 1] > replied[replied.length - 1]);
}

/** Local mode: which of these requests have an unanswered question. */
export function localInfoOpen(type: ThreadEntity, id: string): boolean {
  return infoOpen(localThread(type, id).comments);
}

export function subscribeThreads(listener: () => void): () => void {
  return local.subscribe(listener);
}

export function threadsVersion(): number {
  return local.version();
}

/** Local mode: note an event in the request's trail (submitted, approved, …). */
export function recordLocalEvent(type: ThreadEntity, id: string, action: string, actor: string): void {
  if (API_ENABLED) return;
  const t = localThread(type, id);
  saveLocal(type, id, { ...t, audit: [...t.audit, { action, actor, at: new Date().toISOString() }] });
}

/* ───────────── Backend shapes ───────────── */

interface ThreadOut {
  comments: { id: string; author_id: string | null; author_name: string; kind: CommentKind; body: string; created_at: string }[];
  attachments: { id: string; purpose: FilePurpose; file_name: string; content_type: string; size_bytes: number; uploaded_by_name: string | null; created_at: string }[];
  audit: { action: string; actor: string; at: string }[];
  info_open: boolean;
  can_comment: boolean;
  can_request_info: boolean;
  can_attach: boolean;
}

function fromApi(t: ThreadOut): Thread {
  return {
    comments: t.comments.map((c) => ({ id: c.id, authorId: c.author_id, authorName: c.author_name, kind: c.kind, body: c.body, at: c.created_at })),
    files: t.attachments.map((a) => ({ id: a.id, purpose: a.purpose, name: a.file_name, type: a.content_type, size: a.size_bytes, by: a.uploaded_by_name ?? undefined, at: a.created_at })),
    audit: t.audit,
    infoOpen: t.info_open,
    canComment: t.can_comment,
    canRequestInfo: t.can_request_info,
    canAttach: t.can_attach,
  };
}

const path = (type: ThreadEntity, id: string) => `/requests/${type}/${encodeURIComponent(id)}`;

/* ───────────── Reading ───────────── */

export async function loadThread(type: ThreadEntity, id: string, ctx: ThreadContext): Promise<Thread> {
  if (API_ENABLED) return fromApi(await api.get<ThreadOut>(`${path(type, id)}/thread`));
  const t = localThread(type, id);
  const owner = ctx.actorId === ctx.ownerId;
  const canInfo = !owner && (ctx.canDecide || ctx.reviewer);
  return {
    comments: t.comments,
    files: t.files,
    audit: t.audit,
    infoOpen: infoOpen(t.comments),
    canComment: owner || canInfo,
    canRequestInfo: canInfo,
    canAttach: owner || ctx.reviewer,
  };
}

/** Backend mode: ids with an unanswered question (lists that don't carry the flag themselves). */
export async function loadOpenInfo(type: ThreadEntity, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  if (!API_ENABLED) return new Set(ids.filter((id) => localInfoOpen(type, id)));
  const query = ids.slice(0, 500).map((id) => `ids=${encodeURIComponent(id)}`).join("&");
  try {
    return new Set(await api.get<string[]>(`/requests/${type}/open-info?${query}`));
  } catch {
    return new Set();
  }
}

/* ───────────── Changes ───────────── */

export async function addComment(type: ThreadEntity, id: string, ctx: ThreadContext, body: string, requestInfo: boolean): Promise<string | null> {
  const text = body.trim();
  if (!text) return requestInfo ? "Say what information you need." : "Write a comment first.";
  if (API_ENABLED) {
    try {
      await api.post(`${path(type, id)}/comments`, { body: text, request_info: requestInfo });
      return null;
    } catch (e) {
      return errorText(e);
    }
  }
  const t = localThread(type, id);
  const owner = ctx.actorId === ctx.ownerId;
  const canInfo = !owner && (ctx.canDecide || ctx.reviewer);
  if (requestInfo && !canInfo) return "Only the people deciding this request can ask for more information.";
  if (!owner && !canInfo) return "Only the requester and the people deciding it can comment.";
  const kind: CommentKind = requestInfo ? "info_request" : owner && infoOpen(t.comments) ? "info_reply" : "comment";
  const at = new Date().toISOString();
  const error = saveLocal(type, id, {
    ...t,
    comments: [...t.comments, { id: uid("rc"), authorId: ctx.actorId, authorName: ctx.actorName, kind, body: text.slice(0, 2000), at }],
    audit: [...t.audit, { action: `${type}_${kind}`, actor: ctx.actorName, at }],
  });
  if (error) return error;
  if (owner) {
    const askers = new Set(t.comments.filter((c) => c.kind === "info_request" && c.authorId).map((c) => c.authorId as string));
    askers.forEach((rid) => notifyLocal(rid, `${ctx.actorName} ${kind === "info_reply" ? "answered your question on" : "commented on"} a ${ctx.label}`, text, ctx.href));
  } else {
    notifyLocal(ctx.ownerId, requestInfo ? `More information needed on your ${ctx.label}` : `${ctx.actorName} commented on your ${ctx.label}`, text, ctx.href);
  }
  return null;
}

export const ATTACH_TYPES = "application/pdf,image/png,image/jpeg,image/gif,image/webp";

export async function addFile(type: ThreadEntity, id: string, ctx: ThreadContext, file: File, purpose: FilePurpose): Promise<string | null> {
  const problem = receiptFileError(file);
  if (problem) return problem.replace("Receipts", "Files").replace("Receipt", "File");
  if (API_ENABLED) {
    try {
      const q = new URLSearchParams({ purpose, filename: file.name });
      await authorizedFetch(`${path(type, id)}/attachments?${q.toString()}`, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream", Accept: "application/json" },
        body: file,
      });
      return null;
    } catch (e) {
      return errorText(e);
    }
  }
  if (!(ctx.actorId === ctx.ownerId || ctx.reviewer)) return "Only the requester, HR or finance can add files.";
  const t = localThread(type, id);
  if (t.files.length >= 10) return "Up to 10 files per request.";
  try {
    const saved = await saveReceipt(file);
    const at = new Date().toISOString();
    return saveLocal(type, id, {
      ...t,
      files: [...t.files, { id: saved.id, purpose, name: saved.name, type: saved.type, size: saved.size, by: ctx.actorName, at }],
      audit: [...t.audit, { action: `${type}_file_added`, actor: ctx.actorName, at }],
    });
  } catch (e) {
    return errorText(e, "Couldn't save the file.");
  }
}

/** Opens (or downloads) a file. Returns an error message or null. */
export async function openFile(f: ThreadFile, download = false): Promise<string | null> {
  if (!API_ENABLED) return openReceipt({ id: f.id, name: f.name, type: f.type, size: f.size }, download);
  try {
    const blob = await downloadBlob(`/requests/attachments/${encodeURIComponent(f.id)}`);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    if (download) link.download = f.name;
    else link.target = "_blank";
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return null;
  } catch (e) {
    return errorText(e, "Couldn't open the file.");
  }
}

/** Local mode: the files of a request (e.g. settlement receipts must exist before settling). */
export function localFiles(type: ThreadEntity, id: string): ThreadFile[] {
  return localThread(type, id).files;
}
