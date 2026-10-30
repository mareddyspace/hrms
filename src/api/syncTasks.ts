/**
 * Tasks in backend mode (/tasks). The portal keeps working on its own task list (store.tsx); this module loads
 * the tasks the server lets this person see into that list, and sends every task that changed locally back to the
 * server (which checks who may change it and notifies the other side). Local mode: nothing here runs.
 */
import type { Task } from "../model.ts";
import { notify } from "../components/ui.tsx";
import { API_ENABLED, ApiError, api, apiRequest, apiSessionAccount, onApiSession } from "./client.ts";
import { errorText } from "./syncOps.ts";
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
    onApiSession((who) => {
      seq += 1;
      known.clear();
      pending.clear();
      loaded = false;
      if (who) void load();
    }),
  );
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
        pushTaskChanges(latest); // a later change made while this one was on its way
      })
      .catch((error) => {
        pending.delete(task.id);
        notify(error instanceof ApiError && error.status === 409 ? error.message : `Task not saved: ${errorText(error)}`, "err");
        void load(); // back to what the server has
      });
  }
}
