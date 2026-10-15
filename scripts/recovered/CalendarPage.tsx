import { useMemo, useState, type FormEvent } from "react";
import {
  Banner,
  Card,
  EmptyState,
  Field,
  FilterBar,
  Page,
  StatusBadge,
} from "../components/ui.tsx";
import {
  CALENDAR_KIND_LABEL,
  eventSpansDate,
  eventsForPerson,
  removeLocalReminder,
  saveLocalReminder,
  type CalendarEvent,
  type CalendarEventKind,
} from "../data/calendarData.ts";
import { formatLongDate, monthCells, monthLabel, parseISODate, todayISO } from "../model.ts";
import { usePortal } from "../store.tsx";

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

  const allEvents = useMemo(
    () => eventsForPerson(employee.id, state.holidays),
    // tick refreshes after local reminder add/remove
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [employee.id, state.holidays, tick],
  );

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
        const key = d.toISOString().slice(0, 10);
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

  const upcoming = useMemo(
    () => visible.filter((e) => e.date >= today).slice(0, 12),
    [visible, today],
  );

  function move(delta: number) {
    const next = new Date(cursor.year, cursor.month + delta, 1);
    setCursor({ year: next.getFullYear(), month: next.getMonth() });
  }

  function onAddReminder(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) {
      setError("Add a short reminder title.");
      return;
    }
    if (!date) {
      setError("Pick a date.");
      return;
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
  }

  return (
    <Page
      title="My calendar"
      subtitle={`${employee.fullName} · IP days, meetings, reminders, leave & holidays — shared for every role`}
    >
      <Banner
        message={{
          tone: "ok",
          text: "Demo calendar for everyone. Company holidays, IP (in-person) days, meetings, and reminders. Personal reminders save in this browser only.",
        }}
      />

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
              const weekday = parseISODate(cell).getDay();
              const weekend = weekday === 0 || weekday === 6;
              return (
                <button
                  key={cell}
                  type="button"
                  className={`work-cal-cell${cell === today ? " today" : ""}${cell === selected ? " selected" : ""}${weekend ? " weekend" : ""}`}
                  onClick={() => setSelected(cell)}
                >
                  <strong>{Number(cell.slice(-2))}</strong>
                  <ul className="work-cal-dots">
                    {events.slice(0, 3).map((e) => (
                      <li key={e.id} className={`dot ${e.kind}`} title={e.title} />
                    ))}
                    {events.length > 3 && <li className="more">+{events.length - 3}</li>}
                  </ul>
                </button>
              );
            })}
          </div>
        </Card>

        <div className="stack">
          <Card title={formatLongDate(selected)}>
            {dayEvents.length === 0 ? (
              <EmptyState title="Nothing scheduled" description="No meetings, IP days, or reminders on this date for your filters." />
            ) : (
              <ul className="calendar-agenda">
                {dayEvents.map((e) => (
                  <li key={e.id}>
                    <div className="row-between">
                      <strong>{e.title}</strong>
                      <StatusBadge status={CALENDAR_KIND_LABEL[e.kind]} tone={kindTone(e.kind)} />
                    </div>
                    <p className="muted">
                      {[e.time, e.location].filter(Boolean).join(" · ") || CALENDAR_KIND_LABEL[e.kind]}
                    </p>
                    {e.description && <p className="note">{e.description}</p>}
                    {e.id.startsWith("cal-local-") && (
                      <button
                        type="button"
                        className="btn-ghost btn-tiny"
                        onClick={() => {
                          removeLocalReminder(e.id);
                          setTick((n) => n + 1);
                        }}
                      >
                        Remove reminder
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Add personal reminder">
            <form className="stack" onSubmit={onAddReminder}>
              {error && <Banner message={{ tone: "err", text: error }} />}
              <Field label="Title">
                <input value={title} onChange={(ev) => setTitle(ev.target.value)} placeholder="e.g. Prep for client call" />
              </Field>
              <div className="form-grid-2">
                <Field label="Date">
                  <input type="date" value={date} onChange={(ev) => setDate(ev.target.value)} />
                </Field>
                <Field label="Time (optional)">
                  <input value={time} onChange={(ev) => setTime(ev.target.value)} placeholder="e.g. 16:00" />
                </Field>
              </div>
              <Field label="Note (optional)" wide>
                <textarea rows={2} value={note} onChange={(ev) => setNote(ev.target.value)} placeholder="Short note…" />
              </Field>
              <button className="btn" type="submit">
                Save reminder
              </button>
            </form>
          </Card>
        </div>
      </div>

      <Card title="Upcoming">
        {upcoming.length === 0 ? (
          <EmptyState title="No upcoming items" description="Try another filter or add a personal reminder." />
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
