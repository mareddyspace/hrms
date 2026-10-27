/** Personal notes — per user, saved in this browser. Notes with a date also show on the calendar. */
import { useSyncExternalStore } from "react";

export type NoteColor = "yellow" | "blue" | "green" | "pink";

export type Note = {
  id: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  /** "YYYY-MM-DD" in the owner's time zone, as entered. */
  date?: string;
  /** "HH:MM" in the owner's time zone, as entered. */
  time?: string;
  /** IANA time zone the date/time were entered in. */
  timeZone?: string;
  remind?: boolean;
  /** Set once the in-app reminder has been shown. */
  reminded?: boolean;
  done?: boolean;
  color?: NoteColor;
};

export type NoteInput = Partial<Pick<Note, "text" | "date" | "time" | "timeZone" | "remind" | "done" | "color" | "reminded">>;

const KEY = "kastech.notes.v1";
const LIMIT = 300;
const EMPTY: Note[] = [];
const listeners = new Set<() => void>();

let cachedRaw: string | null | undefined;
let cachedAll: Record<string, Note[]> = {};

function readAll(): Record<string, Note[]> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    raw = null;
  }
  if (raw === cachedRaw) return cachedAll;
  cachedRaw = raw;
  try {
    const parsed = raw ? (JSON.parse(raw) as Record<string, Note[]>) : {};
    cachedAll = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    cachedAll = {};
  }
  return cachedAll;
}

function writeAll(all: Record<string, Note[]>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage full or blocked — keep going in memory */
    cachedAll = all;
  }
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) fn();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("storage", onStorage);
  };
}

export function getNotes(userId: string): Note[] {
  const list = readAll()[userId];
  return Array.isArray(list) ? list : EMPTY;
}

export function useNotes(userId: string): Note[] {
  return useSyncExternalStore(
    subscribe,
    () => getNotes(userId),
    () => EMPTY,
  );
}

function setUserNotes(userId: string, next: Note[]) {
  writeAll({ ...readAll(), [userId]: next.slice(0, LIMIT) });
}

const clean = (value?: string) => (value && value.trim() ? value.trim() : undefined);

export function addNote(userId: string, input: NoteInput & { text: string }): Note {
  const now = new Date().toISOString();
  const note: Note = {
    id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    text: input.text.trim(),
    createdAt: now,
    updatedAt: now,
    date: clean(input.date),
    time: clean(input.date) ? clean(input.time) : undefined,
    timeZone: input.timeZone,
    remind: Boolean(input.remind && clean(input.date) && clean(input.time)),
    color: input.color,
  };
  setUserNotes(userId, [note, ...getNotes(userId)]);
  return note;
}

export function updateNote(userId: string, id: string, patch: NoteInput) {
  setUserNotes(
    userId,
    getNotes(userId).map((note) => {
      if (note.id !== id) return note;
      const next: Note = { ...note, ...patch, updatedAt: new Date().toISOString() };
      if ("date" in patch) next.date = clean(patch.date);
      if ("time" in patch) next.time = clean(patch.time);
      if (!next.date) next.time = undefined;
      if (!next.date || !next.time) next.remind = false;
      // A new date or time re-arms the reminder.
      if (("date" in patch && patch.date !== note.date) || ("time" in patch && patch.time !== note.time)) next.reminded = false;
      if (patch.text !== undefined) next.text = patch.text.trim();
      return next;
    }),
  );
}

export function deleteNote(userId: string, id: string): Note | undefined {
  const list = getNotes(userId);
  const target = list.find((note) => note.id === id);
  setUserNotes(
    userId,
    list.filter((note) => note.id !== id),
  );
  return target;
}

/** Put a deleted note back (undo). */
export function restoreNote(userId: string, note: Note) {
  const list = getNotes(userId);
  if (list.some((n) => n.id === note.id)) return;
  setUserNotes(userId, [note, ...list]);
}

/** Today's date and time ("YYYY-MM-DD", "HH:MM") in a time zone. */
export function nowInZone(timeZone?: string): { date: string; time: string } {
  const now = new Date();
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
    return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
  } catch {
    const pad = (n: number) => String(n).padStart(2, "0");
    return {
      date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
      time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    };
  }
}

/** Today first, then upcoming, then undated, then past; done notes last. */
export function sortNotes(notes: Note[], today: string): Note[] {
  const rank = (n: Note) => (n.done ? 4 : !n.date ? 2 : n.date === today ? 0 : n.date > today ? 1 : 3);
  return [...notes].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r) return r;
    const d = (a.date ?? "").localeCompare(b.date ?? "");
    if (d) return rank(a) === 3 ? -d : d;
    const t = (a.time ?? "99").localeCompare(b.time ?? "99");
    if (t) return t;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

export function countTodayNotes(notes: Note[], today: string): number {
  return notes.filter((n) => !n.done && n.date === today).length;
}

/** Notes whose reminder time has arrived and has not been shown yet. */
export function dueReminders(notes: Note[], now: { date: string; time: string }): Note[] {
  return notes.filter(
    (n) =>
      n.remind &&
      !n.reminded &&
      !n.done &&
      n.date &&
      n.time &&
      (n.date < now.date || (n.date === now.date && n.time <= now.time)),
  );
}

export function noteTitle(note: Note, max = 60): string {
  const line = note.text.split("\n")[0] || "Note";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
