/** Shared work calendar — meetings, reminders, IP (in-person) days, leave, holidays. */

export type CalendarEventKind =
  | "meeting"
  | "reminder"
  | "ip_day"
  | "holiday"
  | "leave"
  | "wfh"
  | "deadline"
  | "interview";

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
};

const KEY = "kastech.calendar.reminders.v1";

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
    audienceIds: ["emp-ram", "demo-recruiter", "demo-hiring-manager"],
  },
  {
    id: "cal-leave-1",
    date: "2026-10-20",
    endDate: "2026-10-20",
    kind: "leave",
    title: "PTO — sample (team)",
    description: "Demo leave marker for calendar planning.",
  },
  {
    id: "cal-wfh-1",
    date: "2026-10-15",
    kind: "wfh",
    title: "WFH day",
    description: "Approved work-from-home (demo).",
    audienceIds: ["emp-mahesh"],
  },
];

export function listLocalReminders(): CalendarEvent[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CalendarEvent[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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
  };
  const next = [event, ...listLocalReminders()].slice(0, 40);
  localStorage.setItem(KEY, JSON.stringify(next));
  return event;
}

export function removeLocalReminder(id: string) {
  const next = listLocalReminders().filter((e) => e.id !== id);
  localStorage.setItem(KEY, JSON.stringify(next));
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
  const local = listLocalReminders().filter(
    (e) => !e.audienceIds?.length || e.audienceIds.includes(personId),
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
