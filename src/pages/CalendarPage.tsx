import { useMemo, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { Award, BellRing, Cake } from "lucide-react";
import { useCelebrations, useYearCelebrations, type Celebration } from "../features/celebrations/celebrationsStore.ts";
import { getTalentState, subscribeTalent } from "../data/talentLocal.ts";
import { holidaysForPerson, leaveNameFor } from "../model.ts";
import {
  Banner,
  Card,
  EmptyState,
  Field,
  FilterBar,
  Page,
  StatusBadge,
  SubmitButton,
  ActionButton,
  notify,
  useAction,
} from "../components/ui.tsx";
import {
  CALENDAR_KIND_LABEL,
  calendarVersion,
  eventSpansDate,
  eventsForPerson,
  isLocalEvent,
  notesToEvents,
  reminderError,
  removeOrDeclineShared,
  saveReminderShared,
  subscribeCalendar,
  type CalendarEvent,
  type CalendarEventKind,
} from "../data/calendarData.ts";
import {
  isPrimaryWeeklyOffLabel,
  isWeeklyOffDate,
  scheduleForEmployee,
  shortHolidayName,
} from "../data/workSchedule.ts";
import { formatLongDate, formatShortDate, monthCells, monthLabel, parseISODate, todayISO } from "../model.ts";
import { usePortal } from "../store.tsx";
import { updateNote, useNotes } from "../data/notesStore.ts";
import { NoteEditor } from "../components/NotesPanel.tsx";
import "../components/notes.css";
import "./calendarYear.css";


const FILTERS: Array<{ id: "all" | CalendarEventKind; label: string }> = [
  { id: "all", label: "All" },
  { id: "meeting", label: "Meetings" },
  { id: "reminder", label: "Reminders" },
  { id: "ip_day", label: "IP days" },
  { id: "holiday", label: "Holidays" },
  { id: "leave", label: "Leave" },
  { id: "wfh", label: "WFH" },
  { id: "deadline", label: "Deadlines" },
  { id: "interview", label: "Interviews" },
  { id: "note", label: "My notes" },
  { id: "birthday", label: "Birthdays" },
  { id: "anniversary", label: "Anniversaries" },
];

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const isCelebration = (kind: CalendarEventKind) => kind === "birthday" || kind === "anniversary";

/** A birthday (day and month only) or work anniversary as a calendar event. */
function celebrationEvent(c: Celebration, meId: string): CalendarEvent {
  const mine = c.employeeId === meId;
  const who = mine ? "Your" : `${c.name}'s`;
  const title =
    c.kind === "birthday" ? (mine ? "Your birthday" : `${c.name}'s birthday`) : `${who} ${c.years ? `${c.years}-year ` : ""}work anniversary`;
  return {
    id: `cal-cel-${c.kind}-${c.employeeId}-${c.date}`,
    date: c.date,
    kind: c.kind as CalendarEventKind,
    title,
    description: [c.jobTitle, c.department].filter(Boolean).join(" · "),
    audienceIds: [meId],
    ownerId: c.employeeId,
    personName: c.name,
  } as CalendarEvent;
}

/** Title of the reminder saved for a celebration, so the page can tell it is already set. */
function reminderTitleFor(e: CalendarEvent): string {
  const name = (e as CalendarEvent & { personName?: string }).personName ?? "";
  return e.kind === "birthday" ? `Wish ${name} a happy birthday` : `Congratulate ${name} on the work anniversary`;
}

function addDays(iso: string, days: number): string {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function kindTone(kind: CalendarEventKind): "ok" | "warn" | "info" | "neutral" {
  switch (kind) {
    case "meeting":
    case "interview":
      return "info";
    case "reminder":
    case "deadline":
      return "warn";
    case "ip_day":
      return "ok";
    case "holiday":
      return "info";
    case "leave":
      return "warn";
    case "wfh":
      return "ok";
    case "birthday":
    case "anniversary":
      return "ok";
    default:
      return "neutral";
  }
}

function cellPills(events: CalendarEvent[]): { text: string; kind: string }[] {
  const pills: { text: string; kind: string }[] = [];
  const holiday = events.find((e) => e.kind === "holiday");
  if (holiday) pills.push({ text: shortHolidayName(holiday.title, 16), kind: "holiday" });
  if (events.some((e) => e.kind === "leave")) pills.push({ text: "Leave", kind: "leave" });
  if (events.some((e) => e.kind === "wfh")) pills.push({ text: "WFH", kind: "wfh" });
  if (events.some((e) => e.kind === "ip_day")) pills.push({ text: "IP day", kind: "ip_day" });
  const meetings = events.filter((e) => e.kind === "meeting" || e.kind === "interview");
  if (meetings.length === 1) pills.push({ text: shortHolidayName(meetings[0].title, 12), kind: "meeting" });
  else if (meetings.length > 1) pills.push({ text: `${meetings.length} meetings`, kind: "meeting" });
  const notes = events.filter((e) => e.kind === "note" && !e.done);
  if (notes.length === 1) pills.push({ text: shortHolidayName(notes[0].title, 12), kind: "note" });
  else if (notes.length > 1) pills.push({ text: `${notes.length} notes`, kind: "note" });
  if (events.some((e) => e.kind === "deadline")) pills.push({ text: "Deadline", kind: "deadline" });
  if (events.some((e) => e.kind === "reminder") && pills.length < 2) {
    pills.push({ text: "Reminder", kind: "reminder" });
  }
  return pills.slice(0, 2);
}

export function CalendarPage() {
  const { employee, state } = usePortal();
  const today = todayISO();
  const initial = new Date();
  const [cursor, setCursor] = useState({ year: initial.getFullYear(), month: initial.getMonth() });
  const [view, setView] = useState<"month" | "year">("month");
  const [selected, setSelected] = useState(today);
  const [filter, setFilter] = useState<"all" | CalendarEventKind>("all");
  const [tick, setTick] = useState(0);
  // Backend mode: shared reminders and meetings (re-renders when they change).
  const sharedEvents = useSyncExternalStore(subscribeCalendar, calendarVersion, calendarVersion);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(today);
  const [time, setTime] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const myNotes = useNotes(employee.id);
  const [editingNote, setEditingNote] = useState<string | null>(null);

  const schedule = useMemo(
    () =>
      scheduleForEmployee({
        shiftName: employee.shiftName,
        shiftHours: employee.shiftHours,
        countryCode: employee.countryCode,
      }),
    [employee.shiftName, employee.shiftHours, employee.countryCode],
  );

  const holidaySource = useMemo(() => {
    return holidaysForPerson(state.holidays, employee.id).map((h) => ({ date: h.date, name: h.name }));
  }, [state.holidays, employee.id]);

  const leaveEvents = useMemo((): CalendarEvent[] => {
    return state.leaveRequests
      .filter((r) => r.employeeId === employee.id && r.status === "approved")
      .map((r) => ({
        id: `cal-leave-req-${r.id}`,
        date: r.from,
        endDate: r.to,
        kind: (r.code === "wfh" || r.code === "emergency_wfh" ? "wfh" : "leave") as CalendarEventKind,
        title: r.code === "wfh" || r.code === "emergency_wfh" ? "WFH (approved)" : `Leave · ${leaveNameFor(state.leavePolicies, r.code, r.employeeId) ?? r.code}`,
        audienceIds: [employee.id],
      }));
  }, [state.leaveRequests, state.leavePolicies, employee.id]);

  // Interviews I sit on (or run as the recruiter), from Recruiting.
  const talent = useSyncExternalStore(subscribeTalent, getTalentState, getTalentState);
  const interviewEvents = useMemo((): CalendarEvent[] => {
    const reqOf = (candidateId: string) => talent.requisitions.find((r) => r.id === talent.candidates.find((c) => c.id === candidateId)?.requisitionId);
    return talent.interviews
      .filter((i) => i.panelIds?.includes(employee.id) || i.panel.includes(employee.fullName) || reqOf(i.candidateId)?.recruiterId === employee.id)
      .map((i) => ({
        id: `cal-iv-${i.id}`,
        date: i.when.slice(0, 10),
        kind: "interview" as const,
        title: `Interview: ${i.candidateName} (${i.role})`,
        time: i.when.slice(11, 16),
        description: `${i.type} · ${i.panel}${i.feedbackStatus === "Submitted" ? " · scorecard in" : ""}`,
        audienceIds: [employee.id],
      }));
  }, [talent, employee.id, employee.fullName]);

  // Birthdays (day and month only; "Hide my birthday" respected) and work anniversaries for the year on screen,
  // only for the people around you (manager, teammates, reports, the sign-in team); Celebrations lists everyone.
  const yearCelebrations = useYearCelebrations(cursor.year, employee.id);
  const celebrationEvents = useMemo(
    () => yearCelebrations.rows.filter((c) => c.kind !== "new_joiner").map((c) => celebrationEvent(c, employee.id)),
    [yearCelebrations.rows, employee.id],
  );
  // Next two weeks, across the year end too.
  const soonCelebrations = useCelebrations(employee.id, 14, true);

  const allEvents = useMemo(() => {
    const base = eventsForPerson(employee.id, holidaySource);
    const ids = new Set(base.map((e) => e.id));
    const extras = [...leaveEvents, ...interviewEvents, ...notesToEvents(myNotes, employee.id), ...celebrationEvents].filter((e) => !ids.has(e.id));
    return [...base, ...extras].sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return (a.time ?? "").localeCompare(b.time ?? "");
    });
    // tick refreshes after local reminder add/remove
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employee.id, holidaySource, leaveEvents, interviewEvents, myNotes, celebrationEvents, tick, sharedEvents]);

  const cells = monthCells(cursor.year, cursor.month);

  const visible = useMemo(() => {
    if (filter === "all") return allEvents;
    return allEvents.filter((e) => e.kind === filter);
  }, [allEvents, filter]);

  const byDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of visible) {
      const start = parseISODate(event.date);
      const end = parseISODate(event.endDate ?? event.date);
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const list = map.get(key) ?? [];
        list.push(event);
        map.set(key, list);
      }
    }
    return map;
  }, [visible]);

  const dayEvents = useMemo(
    () => visible.filter((e) => eventSpansDate(e, selected)),
    [visible, selected],
  );

  const selectedIsOff = isWeeklyOffDate(selected, schedule.weeklyOffDays);

  // Birthdays and anniversaries have their own card unless they are the filter, so they don't crowd out meetings.
  const upcoming = useMemo(
    () => visible.filter((e) => e.date >= today && (filter !== "all" || !isCelebration(e.kind))).slice(0, 12),
    [visible, today, filter],
  );

  const reminderTitles = useMemo(
    () => new Set(allEvents.filter((e) => e.kind === "reminder").map((e) => `${e.date}|${e.title}`)),
    [allEvents],
  );
  const soon = useMemo(
    () => soonCelebrations.rows.filter((c) => c.kind !== "new_joiner" && c.date >= today).map((c) => celebrationEvent(c, employee.id)),
    [soonCelebrations.rows, today, employee.id],
  );

  function move(delta: number) {
    if (view === "year") {
      setCursor({ year: cursor.year + delta, month: cursor.month });
      return;
    }
    const next = new Date(cursor.year, cursor.month + delta, 1);
    setCursor({ year: next.getFullYear(), month: next.getMonth() });
  }

  async function remindMe(e: CalendarEvent): Promise<string | null> {
    if (e.date < today) return "That day has passed.";
    const failed = await saveReminderShared({
      title: reminderTitleFor(e),
      date: e.date,
      description: e.title,
      ownerId: employee.id,
    });
    if (failed) return failed;
    setTick((n) => n + 1);
    return null;
  }

  function celebrationActions(e: CalendarEvent) {
    if (e.ownerId === employee.id) return null;
    const set = reminderTitles.has(`${e.date}|${reminderTitleFor(e)}`);
    const canWish = e.date >= addDays(today, -1) && e.date <= addDays(today, 7);
    if (e.date < today && !canWish) return null;
    return (
      <span className="cal-note-actions">
        {e.date >= today &&
          (set ? (
            <span className="muted cal-reminder-set">
              <BellRing size={13} aria-hidden /> Reminder set
            </span>
          ) : (
            <ActionButton className="btn-ghost btn-tiny" success="Reminder saved." onAction={() => remindMe(e)}>
              <BellRing size={13} aria-hidden /> Remind me
            </ActionButton>
          ))}
        {canWish && (
          <Link className="btn-ghost btn-tiny" to="/celebrations">
            Send wishes
          </Link>
        )}
      </span>
    );
  }

  const reminderAction = useAction();

  async function onAddReminder(): Promise<boolean> {
    const now = new Date();
    const nowHm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const invalid = reminderError({ title, date, time }, today, nowHm);
    if (invalid) {
      setError(invalid);
      return false;
    }
    setError("");
    const failed = await saveReminderShared({
      title: title.trim(),
      date,
      time: time.trim() || undefined,
      description: note.trim() || undefined,
      ownerId: employee.id,
    });
    if (failed) {
      setError(failed);
      return false;
    }
    setTitle("");
    setTime("");
    setNote("");
    setSelected(date);
    setTick((n) => n + 1);
    notify("Reminder saved.");
    return true;
  }

  async function onLocalAction(e: CalendarEvent, action: "remove" | "decline") {
    const err = await removeOrDeclineShared(e.id, employee.id, action);
    if (err) {
      setNotice({ tone: "err", text: err });
      return false;
    }
    const done =
      action === "decline"
        ? "Meeting declined — removed from your calendar."
        : e.kind === "meeting"
          ? "Meeting cancelled for all attendees."
          : "Reminder removed.";
    setNotice({ tone: "ok", text: done });
    setTick((n) => n + 1);
    notify(done);
    return true;
  }

  return (
    <Page
      title="My calendar"
      subtitle={`${employee.fullName} · ${schedule.workDaysLabel} · holidays for ${employee.countryName || "your country"}`}
    >
      {notice && <Banner message={notice} />}

      <FilterBar>
        <div className="chip-row" role="tablist" aria-label="Event type">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={filter === f.id ? "chip-btn active" : "chip-btn"}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </FilterBar>

      <div className="calendar-layout">
        <Card>
          <div className="row-between" style={{ marginBottom: 12 }}>
            <h2 className="card-title" style={{ margin: 0 }}>
              {view === "year" ? cursor.year : monthLabel(cursor.year, cursor.month)}
            </h2>
            <span className="form-actions">
              <span className="cal-view-switch" role="tablist" aria-label="Calendar view">
                {(["month", "year"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    role="tab"
                    aria-selected={view === v}
                    className={view === v ? "chip-btn active" : "chip-btn"}
                    onClick={() => setView(v)}
                  >
                    {v === "month" ? "Month" : "Year"}
                  </button>
                ))}
              </span>
              <button className="btn-ghost" type="button" onClick={() => move(-1)} aria-label={view === "year" ? "Previous year" : "Previous month"}>
                Previous
              </button>
              <button
                className="btn-ghost"
                type="button"
                onClick={() => {
                  const now = new Date();
                  setCursor({ year: now.getFullYear(), month: now.getMonth() });
                  setSelected(today);
                }}
              >
                Today
              </button>
              <button className="btn-ghost" type="button" onClick={() => move(1)} aria-label={view === "year" ? "Next year" : "Next month"}>
                Next
              </button>
            </span>
          </div>

          <div className="cal-legend calendar-legend">
            <span className="cal-pill meeting">Meeting</span>
            <span className="cal-pill reminder">Reminder</span>
            <span className="cal-pill ip_day">IP day</span>
            <span className="cal-pill holiday">Holiday</span>
            <span className="cal-pill leave">Leave</span>
            <span className="cal-pill wfh">WFH</span>
            <span className="cal-pill note">My notes</span>
            <span className="cal-pill weekly-off">Weekly off</span>
            <span className="cal-pill birthday">
              <Cake size={12} aria-hidden /> Birthday
            </span>
            <span className="cal-pill anniversary">
              <Award size={12} aria-hidden /> Anniversary
            </span>
          </div>
          {yearCelebrations.error && <Banner message={{ tone: "err", text: yearCelebrations.error }} />}

          {view === "year" && (
            <div className="cal-year" aria-label={`Year ${cursor.year}`}>
              {MONTH_SHORT.map((name, m) => (
                <section key={name} className="cal-year-month">
                  <button
                    type="button"
                    className="cal-year-title"
                    title={`Open ${monthLabel(cursor.year, m)}`}
                    onClick={() => {
                      setCursor({ year: cursor.year, month: m });
                      setView("month");
                    }}
                  >
                    {name}
                  </button>
                  <div className="cal-year-grid">
                    {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
                      <span key={`h-${i}`} className="cal-year-head">
                        {d}
                      </span>
                    ))}
                    {monthCells(cursor.year, m).map((cell, i) => {
                      if (!cell) return <span key={`b-${i}`} />;
                      // Someone has a birthday or anniversary most days, so the year grid marks them only when filtered to them.
                      const events = (byDate.get(cell) ?? []).filter((e) => filter !== "all" || !isCelebration(e.kind));
                      const kinds = new Set(events.map((e) => (isCelebration(e.kind) ? "celebration" : e.kind)));
                      const dot = kinds.has("holiday")
                        ? "holiday"
                        : kinds.has("leave") || kinds.has("wfh")
                          ? "leave"
                          : kinds.has("meeting") || kinds.has("interview")
                            ? "meeting"
                            : kinds.has("reminder") || kinds.has("deadline") || kinds.has("note")
                              ? "reminder"
                              : kinds.has("celebration")
                                ? "celebration"
                                : events.length
                                  ? "other"
                                  : "";
                      return (
                        <button
                          key={cell}
                          type="button"
                          title={[formatLongDate(cell), ...events.slice(0, 6).map((e) => e.title), events.length > 6 ? `+${events.length - 6} more` : ""]
                            .filter(Boolean)
                            .join(" · ")}
                          className={`cal-year-day${cell === today ? " today" : ""}${cell === selected ? " selected" : ""}${
                            isWeeklyOffDate(cell, schedule.weeklyOffDays) ? " weekly-off" : ""
                          }${dot ? ` has-${dot}` : ""}`}
                          onClick={() => setSelected(cell)}
                        >
                          {Number(cell.slice(-2))}
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}

          {view === "month" && (
          <div className="work-cal" role="grid" aria-label="Month calendar">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label) => (
              <div key={label} className="work-cal-head">
                {label}
              </div>
            ))}
            {cells.map((cell, index) => {
              if (!cell) return <div key={`blank-${index}`} className="work-cal-cell empty" />;
              const events = byDate.get(cell) ?? [];
              const weeklyOff = isWeeklyOffDate(cell, schedule.weeklyOffDays);
              const pills = cellPills(events.filter((e) => !isCelebration(e.kind)));
              const birthdays = events.filter((e) => e.kind === "birthday").length;
              const anniversaries = events.filter((e) => e.kind === "anniversary").length;
              const showOffLabel =
                weeklyOff &&
                pills.length === 0 &&
                isPrimaryWeeklyOffLabel(cell, schedule.weeklyOffDays);
              const tip = [
                formatLongDate(cell),
                weeklyOff ? `Weekly off (${schedule.weeklyOffLabels.join(", ")})` : schedule.hoursLabel,
                ...events.slice(0, 8).map((e) => e.title),
                events.length > 8 ? `+${events.length - 8} more` : "",
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <button
                  key={cell}
                  type="button"
                  title={tip}
                  className={`work-cal-cell${cell === today ? " today" : ""}${cell === selected ? " selected" : ""}${weeklyOff ? " weekly-off" : ""}`}
                  onClick={() => setSelected(cell)}
                >
                  <strong>{Number(cell.slice(-2))}</strong>
                  <ul className="work-cal-labels">
                    {pills.map((p) => (
                      <li key={`${p.kind}-${p.text}`} className={`cal-mini ${p.kind}`} title={p.text}>
                        {p.text}
                      </li>
                    ))}
                    {showOffLabel && <li className="cal-mini weekly-off">Weekly off</li>}
                  </ul>
                  {(birthdays > 0 || anniversaries > 0) && (
                    <span className="cal-cel-counts">
                      {birthdays > 0 && (
                        <span className="cal-cel birthday" aria-label={`${birthdays} birthday${birthdays === 1 ? "" : "s"}`}>
                          <Cake size={11} aria-hidden />
                          {birthdays}
                        </span>
                      )}
                      {anniversaries > 0 && (
                        <span className="cal-cel anniversary" aria-label={`${anniversaries} work anniversar${anniversaries === 1 ? "y" : "ies"}`}>
                          <Award size={11} aria-hidden />
                          {anniversaries}
                        </span>
                      )}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          )}
          <p className="note" style={{ marginTop: 10 }}>
            Shift: {schedule.shiftName} · {schedule.hoursLabel}
          </p>
        </Card>

        <div className="stack">
          <Card title={formatLongDate(selected)}>
            {selectedIsOff && dayEvents.length === 0 ? (
              <p className="note">Weekly off ({schedule.weeklyOffLabels.join(", ")})</p>
            ) : null}
            {dayEvents.length === 0 && !selectedIsOff ? (
              <EmptyState title="Nothing scheduled" />
            ) : dayEvents.length === 0 ? null : (
              <ul className="calendar-agenda">
                {dayEvents.map((e) => {
                  const note = e.noteId ? myNotes.find((n) => n.id === e.noteId) : undefined;
                  if (note && editingNote === note.id) {
                    return (
                      <li key={e.id}>
                        <NoteEditor note={note} userId={employee.id} onClose={() => setEditingNote(null)} />
                      </li>
                    );
                  }
                  return (
                  <li key={e.id}>
                    <div className="row-between">
                      <strong style={e.done ? { textDecoration: "line-through", opacity: 0.7 } : undefined}>{e.title}</strong>
                      <StatusBadge status={CALENDAR_KIND_LABEL[e.kind]} tone={kindTone(e.kind)} />
                    </div>
                    <p className="muted">
                      {[e.time, e.location].filter(Boolean).join(" · ") || CALENDAR_KIND_LABEL[e.kind]}
                    </p>
                    {e.description && <p className="note">{e.description}</p>}
                    {isLocalEvent(e) && e.kind === "meeting" && (
                      <ActionButton
                        className="btn-ghost btn-tiny"
                        onAction={() => onLocalAction(e, e.ownerId === employee.id ? "remove" : "decline")}
                      >
                        {e.ownerId === employee.id ? "Cancel meeting" : "Decline"}
                      </ActionButton>
                    )}
                    {isCelebration(e.kind) && celebrationActions(e)}
                    {isLocalEvent(e) && e.kind === "reminder" && e.ownerId === employee.id && (
                      <ActionButton className="btn-ghost btn-tiny" onAction={() => onLocalAction(e, "remove")}>
                        Remove reminder
                      </ActionButton>
                    )}
                    {note && (
                      <span className="cal-note-actions">
                        <button type="button" className="btn-ghost btn-tiny" onClick={() => setEditingNote(note.id)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn-ghost btn-tiny"
                          onClick={() => updateNote(employee.id, note.id, { done: !note.done })}
                        >
                          {note.done ? "Not done" : "Mark done"}
                        </button>
                      </span>
                    )}
                  </li>
                  );
                })}
              </ul>
            )}
            {!selectedIsOff && dayEvents.length > 0 && (
              <p className="muted" style={{ marginTop: 10 }}>
                Working day · {schedule.hoursLabel}
              </p>
            )}
          </Card>

          <Card title="Add personal reminder">
            <form className="stack" onSubmit={reminderAction.submit(onAddReminder)}>
              {error && <Banner message={{ tone: "err", text: error }} />}
              <Field label="Title">
                <input value={title} onChange={(ev) => setTitle(ev.target.value)} placeholder="e.g. Prep for client call" />
              </Field>
              <div className="form-grid-2">
                <Field label="Date">
                  <input type="date" value={date} min={today} onChange={(ev) => setDate(ev.target.value)} />
                </Field>
                <Field label="Time (optional)">
                  <input value={time} onChange={(ev) => setTime(ev.target.value)} placeholder="HH:MM, e.g. 16:00" />
                </Field>
              </div>
              <Field label="Note (optional)" wide>
                <textarea rows={2} value={note} onChange={(ev) => setNote(ev.target.value)} placeholder="Short note…" />
              </Field>
              <SubmitButton action={reminderAction} className="btn">
                Save reminder
              </SubmitButton>
            </form>
          </Card>
        </div>
      </div>

      <Card title="Upcoming">
        {upcoming.length === 0 ? (
          <EmptyState title="No upcoming items" />
        ) : (
          <ul className="calendar-upcoming">
            {upcoming.map((e) => (
              <li key={e.id}>
                <button type="button" className="calendar-upcoming-btn" onClick={() => setSelected(e.date)}>
                  <span className="muted">{formatShortDate(e.date)}</span>
                  <strong>{e.title}</strong>
                  <StatusBadge status={CALENDAR_KIND_LABEL[e.kind]} tone={kindTone(e.kind)} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Birthdays & anniversaries · next 14 days" to="/celebrations">
        {soonCelebrations.error ? (
          <Banner message={{ tone: "err", text: soonCelebrations.error }} />
        ) : soon.length === 0 ? (
          <EmptyState title="None in the next 14 days" />
        ) : (
          <ul className="calendar-agenda cal-cel-list">
            {soon.slice(0, 20).map((e) => (
              <li key={e.id}>
                <div className="row-between">
                  <button type="button" className="quiet-link cal-cel-name" onClick={() => setSelected(e.date)}>
                    {e.kind === "birthday" ? <Cake size={14} aria-hidden /> : <Award size={14} aria-hidden />}
                    <strong>{e.title}</strong>
                  </button>
                  <span className="muted">{e.date === today ? "Today" : formatShortDate(e.date).replace(/\s\d{4}$/, "")}</span>
                </div>
                {e.description && <p className="muted">{e.description}</p>}
                {celebrationActions(e)}
              </li>
            ))}
            {soon.length > 20 && <li className="muted">+{soon.length - 20} more on the calendar</li>}
          </ul>
        )}
      </Card>
    </Page>
  );
}
