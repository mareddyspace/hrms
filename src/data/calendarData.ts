/** Shared work calendar — meetings, reminders, IP (in-person) days, leave, holidays, personal notes. */
import type { Note } from "./notesStore.ts";

export type CalendarEventKind =
  | "meeting"
  | "reminder"
  | "ip_day"
  | "holiday"
  | "leave"
  | "wfh"
  | "deadline"
  | "interview"
  | "note";

export type CalendarEvent = {
  id: string;
  date: string;
  endDate?: string;
  kind: CalendarEventKind;
  title: string;
  time?: string;
  location?: string;
  description?: string;
  /** When set, only that persona sees it; otherwise company-wide / all roles. */
  audienceIds?: string[];
  /** Who created a locally saved event (reminder owner / meeting organiser). Seed events have none. */
  ownerId?: string;
  /** Set for events made from a personal note (see notesStore). */
  noteId?: string;
  done?: boolean;
};

export const CALENDAR_KIND_LABEL: Record<CalendarEventKind, string> = {
  meeting: "Meeting",
  reminder: "Reminder",
  ip_day: "IP day (office)",
  holiday: "Holiday",
  leave: "Leave",
  wfh: "WFH",
  deadline: "Deadline",
  interview: "Interview",
  note: "My note",
};

/** Dated notes become calendar events; undated ones stay off the calendar. */
export function notesToEvents(notes: Note[], ownerId: string): CalendarEvent[] {
  return notes
    .filter((n) => Boolean(n.date))
    .map((n) => {
      const firstLine = n.text.split(/\r?\n/)[0] || "Note";
      return {
        id: `cal-note-${n.id}`,
        date: n.date as string,
        kind: "note" as const,
        title: firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine,
        time: n.time,
        description: n.text.trim() !== firstLine.trim() || firstLine.length > 60 ? n.text : undefined,
        audienceIds: [ownerId],
        ownerId,
        noteId: n.id,
        done: n.done,
      };
    });
}

const KEY = "kastech.calendar.reminders.v1";
const DECLINED_KEY = "kastech.calendar.declined.v1";
/** Keep the newest saved events; old ones fall off only past this many. */
const LOCAL_EVENT_LIMIT = 200;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Seed events visible to everyone (plus persona-scoped samples). */
export const CALENDAR_SEED: CalendarEvent[] = [
  {
    id: "cal-ip-1",
    date: "2026-10-14",
    kind: "ip_day",
    title: "IP day — Bengaluru office",
    time: "09:30–18:30",
    location: "Bengaluru HQ",
    description: "In-person collaboration day. Hybrid staff expected on site.",
  },
  {
    id: "cal-ip-2",
    date: "2026-10-16",
    kind: "ip_day",
    title: "IP day — Engineering floor",
    time: "09:30–18:30",
    location: "Bengaluru HQ · L3",
    description: "Sprint demos and design reviews on campus.",
  },
  {
    id: "cal-ip-3",
    date: "2026-10-21",
    kind: "ip_day",
    title: "IP day — All-hands prep",
    time: "09:30–18:30",
    location: "Bengaluru HQ",
  },
  {
    id: "cal-ip-4",
    date: "2026-10-28",
    kind: "ip_day",
    title: "IP day — Client workshop",
    time: "10:00–17:00",
    location: "Bengaluru HQ · Conf A",
  },
  {
    id: "cal-mtg-1",
    date: "2026-10-14",
    kind: "meeting",
    title: "Daily standup",
    time: "10:00–10:15",
    location: "Teams",
    description: "Engineering standup · blockers and plan for the day.",
  },
  {
    id: "cal-mtg-2",
    date: "2026-10-15",
    kind: "meeting",
    title: "1:1 with manager",
    time: "15:00–15:30",
    location: "Rooms / Zoom",
    audienceIds: ["emp-mahesh", "emp-ram"],
  },
  {
    id: "cal-mtg-3",
    date: "2026-10-16",
    kind: "meeting",
    title: "Sprint planning",
    time: "11:00–12:30",
    location: "Conf · Orion",
  },
  {
    id: "cal-mtg-4",
    date: "2026-10-17",
    kind: "meeting",
    title: "Manager sync — approvals",
    time: "14:00–14:45",
    location: "Teams",
    audienceIds: ["emp-ram", "demo-hr-admin"],
  },
  {
    id: "cal-mtg-5",
    date: "2026-10-22",
    kind: "meeting",
    title: "Q4 all-hands",
    time: "16:00–17:00",
    location: "Town hall / livestream",
    description: "Roadmap, hiring, and wellbeing updates.",
  },
  {
    id: "cal-rem-1",
    date: "2026-10-15",
    kind: "reminder",
    title: "Submit timesheet draft",
    time: "By 18:00",
    description: "Log hours before Friday standup.",
  },
  {
    id: "cal-rem-2",
    date: "2026-10-18",
    kind: "reminder",
    title: "Acknowledge leave policy",
    time: "Anytime",
    description: "Pending policy acknowledgement in Documents / Notifications.",
  },
  {
    id: "cal-rem-3",
    date: "2026-10-24",
    kind: "reminder",
    title: "Secure coding module due",
    time: "End of day",
    description: "Learning assignment reminder.",
  },
  {
    id: "cal-dead-1",
    date: "2026-10-20",
    kind: "deadline",
    title: "Mid-year review inputs due",
    time: "17:00",
  },
  {
    id: "cal-int-1",
    date: "2026-10-17",
    kind: "interview",
    title: "Panel interview — Senior Frontend",
    time: "11:30–12:30",
    location: "Conf · Vega",
    audienceIds: ["emp-ram", "demo-recruiter"],
  },
];

/** Older saved events have no ownerId — the first audience id was always the creator. */
export function listLocalReminders(): CalendarEvent[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CalendarEvent[];
    if (!Array.isArray(parsed)) return [];
    return parsed.map((e) => (e.ownerId || !e.audienceIds?.length ? e : { ...e, ownerId: e.audienceIds[0] }));
  } catch {
    return [];
  }
}

function writeLocal(events: CalendarEvent[]) {
  localStorage.setItem(KEY, JSON.stringify(events.slice(0, LOCAL_EVENT_LIMIT)));
}

/** Validation for a personal reminder: no past dates, time must be HH:MM (or empty). */
export function reminderError(input: { title: string; date: string; time?: string }, today: string, nowHm?: string): string | null {
  if (!input.title.trim()) return "Add a short reminder title.";
  if (!input.date || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return "Pick a date.";
  if (input.date < today) return "Reminders cannot be set in the past.";
  const time = input.time?.trim();
  if (time && !HM.test(time)) return "Time must be HH:MM between 00:00 and 23:59.";
  if (time && nowHm && input.date === today && time < nowHm) return "That time has already passed today.";
  return null;
}

export function saveLocalReminder(input: {
  title: string;
  date: string;
  time?: string;
  description?: string;
  ownerId: string;
}): CalendarEvent {
  const event: CalendarEvent = {
    id: `cal-local-${Date.now()}`,
    date: input.date,
    kind: "reminder",
    title: input.title.trim() || "Personal reminder",
    time: input.time?.trim() || undefined,
    description: input.description?.trim() || undefined,
    audienceIds: [input.ownerId],
    ownerId: input.ownerId,
  };
  writeLocal([event, ...listLocalReminders()]);
  return event;
}

/** Book a meeting that appears on every attendee's calendar. The organiser defaults to the first attendee. */
export function saveLocalMeeting(input: {
  title: string;
  date: string;
  time: string;
  location?: string;
  description?: string;
  attendeeIds: string[];
  ownerId?: string;
}): CalendarEvent {
  const ownerId = input.ownerId ?? input.attendeeIds[0];
  const event: CalendarEvent = {
    id: `cal-meet-${Date.now()}`,
    date: input.date,
    kind: "meeting",
    title: input.title.trim() || "Meeting",
    time: input.time,
    location: input.location?.trim() || undefined,
    description: input.description?.trim() || undefined,
    audienceIds: [...new Set(ownerId ? [ownerId, ...input.attendeeIds] : input.attendeeIds)],
    ownerId,
  };
  writeLocal([event, ...listLocalReminders()]);
  return event;
}

export function isLocalEvent(event: CalendarEvent): boolean {
  return event.id.startsWith("cal-local-") || event.id.startsWith("cal-meet-");
}

/**
 * Delete a saved event for everyone. With `actorId`, only the owner may do it
 * (their own reminder, or a meeting they organised). Returns an error message or null.
 */
export function removeLocalReminder(id: string, actorId?: string): string | null {
  const all = listLocalReminders();
  const target = all.find((e) => e.id === id);
  if (!target) return "Event not found.";
  if (actorId && target.ownerId !== actorId) {
    return target.kind === "meeting" ? "Only the organiser can cancel this meeting." : "You can only remove your own reminders.";
  }
  writeLocal(all.filter((e) => e.id !== id));
  return null;
}

function readDeclined(): Record<string, string[]> {
  try {
    const parsed = JSON.parse(localStorage.getItem(DECLINED_KEY) || "{}") as Record<string, string[]>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function declinedEventIds(personId: string): Set<string> {
  return new Set(readDeclined()[personId] ?? []);
}

/** Attendee declines a meeting — hides it from their calendar only. */
export function declineLocalMeeting(id: string, personId: string): string | null {
  const target = listLocalReminders().find((e) => e.id === id);
  if (!target || target.kind !== "meeting") return "Meeting not found.";
  if (target.ownerId === personId) return "You organised this meeting — cancel it instead.";
  const all = readDeclined();
  all[personId] = [...new Set([...(all[personId] ?? []), id])];
  localStorage.setItem(DECLINED_KEY, JSON.stringify(all));
  return null;
}

export function eventsForPerson(
  personId: string,
  holidays: { date: string; name: string }[],
): CalendarEvent[] {
  const holidayEvents: CalendarEvent[] = holidays.map((h) => ({
    id: `cal-hol-${h.date}`,
    date: h.date,
    kind: "holiday" as const,
    title: h.name,
    description: "Company holiday — office closed / leave planning.",
  }));
  const declined = declinedEventIds(personId);
  const local = listLocalReminders().filter(
    (e) => (!e.audienceIds?.length || e.audienceIds.includes(personId)) && !declined.has(e.id),
  );
  const seeded = CALENDAR_SEED.filter((e) => !e.audienceIds?.length || e.audienceIds.includes(personId));
  return [...holidayEvents, ...seeded, ...local].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return (a.time ?? "").localeCompare(b.time ?? "");
  });
}

export function eventSpansDate(event: CalendarEvent, date: string): boolean {
  if (event.date === date) return true;
  if (event.endDate && date >= event.date && date <= event.endDate) return true;
  return false;
}
