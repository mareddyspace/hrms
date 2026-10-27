import { useSyncExternalStore } from "react";

/** Per-person "Automatic mode" for Tasks. Default ON. Stored in localStorage keyed by user id. */
const KEY = "hrms.taskAutoMode.v1";
const listeners = new Set<() => void>();

function readAll(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

let cache = readAll();

export function isTaskAutoMode(userId: string): boolean {
  return cache[userId] !== false;
}

export function setTaskAutoMode(userId: string, on: boolean) {
  cache = { ...cache, [userId]: on };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* storage unavailable — keep in memory */
  }
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    cache = readAll();
    fn();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("storage", onStorage);
  };
}

export function useTaskAutoMode(userId: string): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(
    subscribe,
    () => isTaskAutoMode(userId),
    () => true,
  );
  return [on, (next: boolean) => setTaskAutoMode(userId, next)];
}

/** Which automatic reminders were already sent, per task, keyed by the due date they were sent for. */
const SENT_KEY = "hrms.taskAutoReminders.v1";
type SentLog = Record<string, { soon?: string; overdue?: string }>;

export function readSentReminders(): SentLog {
  try {
    const raw = localStorage.getItem(SENT_KEY);
    return raw ? (JSON.parse(raw) as SentLog) : {};
  } catch {
    return {};
  }
}

export function writeSentReminders(log: SentLog) {
  try {
    localStorage.setItem(SENT_KEY, JSON.stringify(log));
  } catch {
    /* ignore */
  }
}
