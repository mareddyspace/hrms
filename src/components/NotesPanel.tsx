import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Bell, Check, Pencil, RotateCcw, StickyNote, Trash2, X } from "lucide-react";
import {
  addNote,
  countTodayNotes,
  deleteNote,
  dueReminders,
  noteTitle,
  nowInZone,
  restoreNote,
  sortNotes,
  updateNote,
  useNotes,
  type Note,
  type NoteColor,
} from "../data/notesStore.ts";
import { SubmitButton, notify, useAction } from "./ui.tsx";
import "./notes.css";

const COLORS: NoteColor[] = ["yellow", "blue", "green", "pink"];

function useToday(timeZone?: string) {
  const [now, setNow] = useState(() => nowInZone(timeZone));
  useEffect(() => {
    setNow(nowInZone(timeZone));
    const id = window.setInterval(() => setNow(nowInZone(timeZone)), 30_000);
    return () => window.clearInterval(id);
  }, [timeZone]);
  return now;
}

export function formatNoteWhen(note: Note, today: string): string {
  if (!note.date) return "";
  let day = note.date;
  if (note.date === today) day = "Today";
  else {
    const d = new Date(`${note.date}T00:00:00`);
    if (!Number.isNaN(d.getTime())) day = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  }
  return note.time ? `${day} · ${note.time}` : day;
}

/** Edit form for one note — used in the panel and on the calendar. */
export function NoteEditor({
  note,
  userId,
  onClose,
}: {
  note: Note;
  userId: string;
  onClose: () => void;
}) {
  const [text, setText] = useState(note.text);
  const [date, setDate] = useState(note.date ?? "");
  const [time, setTime] = useState(note.time ?? "");
  const [remind, setRemind] = useState(Boolean(note.remind));
  const [color, setColor] = useState<NoteColor | undefined>(note.color);
  const uid = useId();

  const saveAction = useAction();

  function save() {
    if (!text.trim()) return false;
    updateNote(userId, note.id, { text, date, time, remind: remind && Boolean(date && time), color });
    onClose();
    return true;
  }

  return (
    <form
      className="note-editor"
      onSubmit={saveAction.submit(save, { success: "Note saved." })}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <label className="sr-only" htmlFor={`${uid}-text`}>
        Note
      </label>
      <textarea id={`${uid}-text`} rows={3} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
      <div className="note-when-row">
        <label>
          <span className="sr-only">Date</span>
          <input type="date" value={date} aria-label="Date" onChange={(e) => setDate(e.target.value)} />
        </label>
        <label>
          <span className="sr-only">Time</span>
          <input type="time" value={time} aria-label="Time" disabled={!date} onChange={(e) => setTime(e.target.value)} />
        </label>
        {date && (
          <button type="button" className="btn-ghost btn-tiny" onClick={() => { setDate(""); setTime(""); }}>
            Clear date
          </button>
        )}
      </div>
      <div className="note-when-row">
        <label className="note-check">
          <input type="checkbox" checked={remind && Boolean(date && time)} disabled={!date || !time} onChange={(e) => setRemind(e.target.checked)} />
          Remind me
        </label>
        <span className="note-colors" role="radiogroup" aria-label="Colour">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={color === c}
              aria-label={c}
              className={`note-swatch ${c}${color === c ? " on" : ""}`}
              onClick={() => setColor(color === c ? undefined : c)}
            />
          ))}
        </span>
      </div>
      <div className="note-editor-actions">
        <button type="button" className="btn-ghost btn-tiny" onClick={onClose}>
          Cancel
        </button>
        <SubmitButton action={saveAction} className="btn btn-tiny" disabled={!text.trim()}>
          Save
        </SubmitButton>
      </div>
    </form>
  );
}

/** Top-bar Notes button, its panel, and in-app reminder toasts. */
export function NotesButton({ userId, timeZone }: { userId: string; timeZone?: string }) {
  const notes = useNotes(userId);
  const now = useToday(timeZone);
  const today = now.date;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [remind, setRemind] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [undo, setUndo] = useState<Note | null>(null);
  const [toasts, setToasts] = useState<Note[]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const sorted = useMemo(() => sortNotes(notes, today), [notes, today]);
  const todayCount = countTodayNotes(notes, today);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent | TouchEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [open]);

  // Undo bar fades after a few seconds.
  useEffect(() => {
    if (!undo) return;
    const id = window.setTimeout(() => setUndo(null), 6000);
    return () => window.clearTimeout(id);
  }, [undo]);

  // Reminders: show each one once when its time arrives.
  useEffect(() => {
    const due = dueReminders(notes, now);
    if (due.length === 0) return;
    due.forEach((n) => updateNote(userId, n.id, { reminded: true }));
    setToasts((current) => [...current, ...due.filter((n) => !current.some((c) => c.id === n.id))].slice(-3));
  }, [notes, now, userId]);

  function close() {
    setOpen(false);
    setEditing(null);
    btnRef.current?.focus();
  }

  function onKeyDown(event: ReactKeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  }

  const addAction = useAction({ doneMs: 1200 });

  function onAdd() {
    if (!text.trim()) return false;
    addNote(userId, { text, date, time, remind, timeZone });
    notify(date ? "Note added to your calendar." : "Note added.");
    setText("");
    setDate("");
    setTime("");
    setRemind(false);
    return true;
  }

  const submitAdd = addAction.submit(onAdd);

  function onDelete(note: Note) {
    deleteNote(userId, note.id);
    setUndo(note);
  }

  return (
    <div className="notes-wrap" ref={wrapRef} onKeyDown={onKeyDown}>
      <button
        ref={btnRef}
        type="button"
        className="top-icon-btn"
        aria-label="Notes"
        title="Notes"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <StickyNote size={18} strokeWidth={1.75} />
        {todayCount > 0 && (
          <span className="notes-count" aria-label={`${todayCount} today`}>
            {todayCount > 9 ? "9+" : todayCount}
          </span>
        )}
      </button>

      {open && (
        <>
          <button type="button" className="notes-scrim" aria-label="Close notes" onClick={close} tabIndex={-1} />
          <div className="notes-panel" id={panelId} role="dialog" aria-label="Notes">
            <div className="notes-head">
              <strong>My notes</strong>
              <button type="button" className="notes-icon" aria-label="Close" onClick={close}>
                <X size={16} />
              </button>
            </div>

            <form className="notes-add" onSubmit={submitAdd}>
              <label className="sr-only" htmlFor={`${panelId}-new`}>
                New note
              </label>
              <textarea
                id={`${panelId}-new`}
                rows={2}
                value={text}
                placeholder="Write a note…"
                autoFocus
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submitAdd(e);
                }}
              />
              <div className="note-when-row">
                <input type="date" aria-label="Date (optional)" value={date} onChange={(e) => setDate(e.target.value)} />
                <input
                  type="time"
                  aria-label="Time (optional)"
                  value={time}
                  disabled={!date}
                  onChange={(e) => setTime(e.target.value)}
                />
                <label className="note-check" title="Remind me at this time">
                  <input type="checkbox" checked={remind} disabled={!date || !time} onChange={(e) => setRemind(e.target.checked)} />
                  <Bell size={14} aria-hidden /> <span className="sr-only">Remind me</span>
                </label>
                <SubmitButton action={addAction} className="btn btn-tiny" disabled={!text.trim()}>
                  Add
                </SubmitButton>
              </div>
              {date && <p className="notes-hint">Shows on your calendar.</p>}
            </form>

            {undo && (
              <div className="notes-undo" role="status">
                Note deleted.
                <button
                  type="button"
                  className="btn-ghost btn-tiny"
                  onClick={() => {
                    restoreNote(userId, undo);
                    setUndo(null);
                  }}
                >
                  <RotateCcw size={13} aria-hidden /> Undo
                </button>
              </div>
            )}

            {sorted.length === 0 ? (
              <p className="notes-empty">No notes yet.</p>
            ) : (
              <ul className="notes-list">
                {sorted.map((note) => (
                  <li key={note.id} className={`note-item${note.done ? " done" : ""}${note.color ? ` c-${note.color}` : ""}`}>
                    {editing === note.id ? (
                      <NoteEditor note={note} userId={userId} onClose={() => setEditing(null)} />
                    ) : (
                      <>
                        <button
                          type="button"
                          className="notes-icon"
                          aria-label={note.done ? "Mark not done" : "Mark done"}
                          aria-pressed={Boolean(note.done)}
                          onClick={() => updateNote(userId, note.id, { done: !note.done })}
                        >
                          <span className={`note-tick${note.done ? " on" : ""}`}>{note.done && <Check size={12} />}</span>
                        </button>
                        <div className="note-body">
                          <p className="note-text">{note.text}</p>
                          {note.date && (
                            <span className={`note-when${note.date === today && !note.done ? " today" : ""}`}>
                              {formatNoteWhen(note, today)}
                              {note.remind && <Bell size={11} aria-label="Reminder on" />}
                            </span>
                          )}
                        </div>
                        <button type="button" className="notes-icon" aria-label="Edit note" onClick={() => setEditing(note.id)}>
                          <Pencil size={14} />
                        </button>
                        <button type="button" className="notes-icon" aria-label="Delete note" onClick={() => onDelete(note)}>
                          <Trash2 size={14} />
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {toasts.length > 0 && (
        <div className="notes-toasts" role="status" aria-live="polite">
          {toasts.map((n) => (
            <div key={n.id} className="notes-toast">
              <StickyNote size={16} aria-hidden />
              <div>
                <strong>Reminder{n.time ? ` · ${n.time}` : ""}</strong>
                <p>{noteTitle(n, 80)}</p>
              </div>
              <button
                type="button"
                className="notes-icon"
                aria-label="Dismiss reminder"
                onClick={() => setToasts((t) => t.filter((x) => x.id !== n.id))}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
