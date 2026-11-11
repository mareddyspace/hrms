/**
 * Tasks in backend mode (/tasks). The portal keeps working on its own task list (store.tsx); this module loads
 * the tasks the server lets this person see into that list, and sends every task that changed locally back to the
 * server (which checks who may change it and notifies the other side). Local mode: nothing here runs.
 */
import type { Task } from "../model.ts";
import { notify } from "../components/ui.tsx";
import { API_ENABLED, ApiError, api, apiRequest, apiSessionAccount, onApiSession, sessionLoad } from "./client.ts";
import { errorText } from "./syncOps.ts";
import { apiDelete, downloadBlob, uploadRaw } from "./syncShared.ts";
import { keepFresh } from "./syncShare.ts";

interface TaskOut {
  id: string;
  data: Task;
  version: number;
}

/** Key order doesn't matter when comparing a task with the server's copy. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const known = new Map<string, { json: string; version: number }>();
const pending = new Set<string>();
let loaded = false;
let latest: Task[] = [];
let apply: ((tasks: Task[], keepIds: Set<string>) => void) | null = null;
let seq = 0;

async function load(): Promise<void> {
  const who = apiSessionAccount();
  if (!who || !apply) return;
  const mine = ++seq;
  try {
    const rows = await api.get<TaskOut[]>("/tasks");
    if (mine !== seq || apiSessionAccount() !== who) return;
    known.clear();
    rows.forEach((r) => known.set(r.id, { json: stable(r.data), version: r.version }));
    loaded = true;
    apply(
      rows.map((r) => r.data),
      new Set(pending),
    );
  } catch (error) {
    console.warn("Could not load tasks from the server", error);
  }
}

if (API_ENABLED) {
  queueMicrotask(() =>
    onApiSession(() => {
      seq += 1;
      known.clear();
      pending.clear();
      loaded = false;
    }),
  );
  // Loaded with the other module data once the home is shown.
  queueMicrotask(() => sessionLoad(() => load()));
  keepFresh(load, 30_000);
}

/** store.tsx registers how to put the server's tasks into the portal state. */
export function bindSharedTasks(onLoad: (tasks: Task[], keepIds: Set<string>) => void): () => void {
  apply = onLoad;
  if (apiSessionAccount()) void load();
  return () => {
    if (apply === onLoad) apply = null;
  };
}

/** The server's tasks, keeping local copies of tasks whose change is still being sent. */
export function mergeSharedTasks(local: Task[], server: Task[], keepIds: Set<string>): Task[] {
  const byId = new Map(local.map((t) => [t.id, t]));
  const out = server.map((t) => (keepIds.has(t.id) ? (byId.get(t.id) ?? t) : t));
  const ids = new Set(out.map((t) => t.id));
  return [...out, ...local.filter((t) => keepIds.has(t.id) && !ids.has(t.id))];
}

/** Sends every task that differs from the server's copy (called after each change to the task list). */
export function pushTaskChanges(tasks: Task[]): void {
  latest = tasks;
  if (!loaded) return;
  for (const task of tasks) {
    if (pending.has(task.id)) continue;
    const json = stable(task);
    const was = known.get(task.id);
    if (was?.json === json) continue;
    pending.add(task.id);
    void apiRequest<TaskOut>(`/tasks/${encodeURIComponent(task.id)}`, {
      method: "PUT",
      body: { data: task, base_version: was?.version ?? null },
    })
      .then((out) => {
        known.set(out.id, { json: stable(out.data), version: out.version });
        pending.delete(task.id);
        // The server may add to the task (cc for @mentions, the attached files): take its copy.
        if (stable(out.data) !== json) void load();
        else pushTaskChanges(latest); // a later change made while this one was on its way
      })
      .catch((error) => {
        pending.delete(task.id);
        notify(error instanceof ApiError && error.status === 409 ? error.message : `Task not saved: ${errorText(error)}`, "err");
        void load(); // back to what the server has
      });
  }
}

/* ───────── Attachments (stored on the server; PDF or image up to 5 MB) ───────── */

const FILE_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_FILE = 5 * 1024 * 1024;
const OFFLINE = "Files can be attached when TimeZ is connected to the server.";

/** Checks a file before it is sent; null when it can be uploaded. */
export function checkWorkFile(file: File): string | null {
  if (!FILE_TYPES.includes(file.type)) return "Attach a PDF or an image (PNG, JPG, WebP, GIF).";
  if (file.size > MAX_FILE) return "The file is larger than 5 MB.";
  return null;
}

async function afterFileChange(run: () => Promise<TaskOut>): Promise<string | null> {
  try {
    const out = await run();
    known.set(out.id, { json: stable(out.data), version: out.version });
    await load();
    return null;
  } catch (error) {
    return errorText(error);
  }
}

export async function uploadTaskFile(taskId: string, file: File): Promise<string | null> {
  if (!API_ENABLED) return OFFLINE;
  const bad = checkWorkFile(file);
  if (bad) return bad;
  if (pending.has(taskId) || !known.has(taskId)) return "Save the task first, then attach files.";
  return afterFileChange(() => uploadRaw<TaskOut>(`/tasks/${encodeURIComponent(taskId)}/attachments`, file, file.type, file.name));
}

export async function removeTaskFile(taskId: string, fileId: string): Promise<string | null> {
  if (!API_ENABLED) return OFFLINE;
  return afterFileChange(() => apiDelete<TaskOut>(`/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(fileId)}`));
}

/** Opens an attached file in a new tab (fetched with the sign-in token). */
export async function openWorkFile(path: string): Promise<string | null> {
  if (!API_ENABLED) return OFFLINE;
  try {
    const url = URL.createObjectURL(await downloadBlob(path));
    window.open(url, "_blank", "noopener,noreferrer");
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return null;
  } catch (error) {
    return errorText(error);
  }
}

export const taskFilePath = (taskId: string, fileId: string) =>
  `/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(fileId)}/file`;
