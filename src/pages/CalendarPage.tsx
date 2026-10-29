import { useMemo, useState } from "react";
import { holidaysForPerson } from "../model.ts";
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
  eventSpansDate,
  declineLocalMeeting,
  eventsForPerson,
  isLocalEvent,
  notesToEvents,
  reminderError,
  removeLocalReminder,
  saveLocalReminder,
  type CalendarEvent,
  type CalendarEventKind,
} from "../data/calendarData.ts";
import {
  isPrimaryWeeklyOffLabel,
  isWeeklyOffDate,
  scheduleForEmployee,
  shortHolidayName,
} from "../data/workSchedule.ts";
import { formatLongDate, monthCells, monthLabel, parseISODate, todayISO } from "../model.ts";
import { usePortal } from "../store.tsx";
import { updateNote, useNotes } from "../data/notesStore.ts";
import { NoteEditor } from "../components/NotesPanel.tsx";
import "../components/notes.css";


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
];

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
  const [selected, setSelected] = useState(today);
  const [filter, setFilter] = useState<"all" | CalendarEventKind>("all");
  const [tick, setTick] = useState(0);
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
        title: r.code === "wfh" || r.code === "emergency_wfh" ? "WFH (approved)" : `Leave · ${r.code}`,
        audienceIds: [employee.id],
      }));
  }, [state.leaveRequests, employee.id]);

  const allEvents = useMemo(() => {
    const base = eventsForPerson(employee.id, holidaySource);
    const ids = new Set(base.map((e) => e.id));
    const extras = [...leaveEvents, ...notesToEvents(myNotes, employee.id)].filter((e) => !ids.has(e.id));
    return [...base, ...extras].sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return (a.time ?? "").localeCompare(b.time ?? "");
    });
    // tick refreshes after local reminder add/remove
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employee.id, holidaySource, leaveEvents, myNotes, tick]);

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

  const upcoming = useMemo(
    () => visible.filter((e) => e.date >= today).slice(0, 12),
    [visible, today],
  );

  function move(delta: number) {
    const next = new Date(cursor.year, cursor.month + delta, 1);
    setCursor({ year: next.getFullYear(), month: next.getMonth() });
  }

  const reminderAction = useAction();

  function onAddReminder(): boolean {
    const now = new Date();
    const nowHm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const invalid = reminderError({ title, date, time }, today, nowHm);
    if (invalid) {
      setError(invalid);
      return false;
    }
    setError("");
    saveLocalReminder({
      title: title.trim(),
      date,
      time: time.trim() || undefined,
      description: note.trim() || undefined,
      ownerId: employee.id,
    });
    setTitle("");
    setTime("");
    setNote("");
    setSelected(date);
    setTick((n) => n + 1);
    notify("Reminder saved.");
    return true;
  }

  function onLocalAction(e: CalendarEvent, action: "remove" | "decline") {
    const err = action === "decline" ? declineLocalMeeting(e.id, employee.id) : removeLocalReminder(e.id, employee.id);
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
              {monthLabel(cursor.year, cursor.month)}
            </h2>
            <span className="form-actions">
              <button className="btn-ghost" type="button" onClick={() => move(-1)}>
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
              <button className="btn-ghost" type="button" onClick={() => move(1)}>
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
          </div>

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
              const pills = cellPills(events);
              const showOffLabel =
                weeklyOff &&
                pills.length === 0 &&
                isPrimaryWeeklyOffLabel(cell, schedule.weeklyOffDays);
              const tip = [
                formatLongDate(cell),
                weeklyOff ? `Weekly off (${schedule.weeklyOffLabels.join(", ")})` : schedule.hoursLabel,
                ...events.map((e) => e.title),
              ].join(" · ");
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
                </button>
              );
            })}
          </div>
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
                  <span className="muted">{e.date}</span>
                  <strong>{e.title}</strong>
                  <StatusBadge status={CALENDAR_KIND_LABEL[e.kind]} tone={kindTone(e.kind)} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Page>
  );
}
