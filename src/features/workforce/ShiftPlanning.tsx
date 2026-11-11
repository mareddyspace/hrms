/* Shift planning pieces: legend, availability, team calendar, bulk assign, repeat week and unpublish dialogs. */
import { useMemo, useState, useSyncExternalStore } from "react";
import { ActionButton, Banner, Card, DataTable, Dialog, EmptyState, Field, notify } from "../../components/ui.tsx";
import { addDaysISO, parseISODate, todayISO } from "../../model.ts";
import { scheduleForEmployee } from "../../data/workSchedule.ts";
import { getPerson } from "../../data/peopleLocal.ts";
import { ShiftChip } from "./rosterUi.tsx";
import {
  addAvailability,
  bulkAssign,
  copyWeek,
  getShiftState,
  isOvernight,
  paidHours,
  removeAvailability,
  shiftById,
  subscribeShifts,
  teamCalendarRows,
  unpublishWeek,
  weekDates,
  WEEKDAY_NAMES,
  type Availability,
  type BulkResult,
  type RosterContext,
  type ShiftDef,
} from "./shiftsStore.ts";
import { fmt, personName, rosterTeamFor, shortDay, weekStartOf, type WorkforceActor } from "./workforceShared.ts";
import "../../styles/shifts.css";

type Msg = { tone: "ok" | "err" | "warn" | "info"; text: string } | null;
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

function useShifts() {
  return useSyncExternalStore(subscribeShifts, getShiftState, getShiftState);
}

/** Weekly offs from the person's country schedule (Sat/Sun by default; Fri/Sat in some countries). */
export function weeklyOffFor(personId: string, date: string): boolean {
  const offs = scheduleForEmployee({ countryCode: getPerson(personId)?.countryCode }).weeklyOffDays;
  return offs.includes(parseISODate(date).getDay());
}

export function ShiftLegend({ shifts }: { shifts: ShiftDef[] }) {
  if (!shifts.length) return null;
  return (
    <div className="sh-legend" aria-label="Shift legend">
      {shifts.map((s) => (
        <span key={s.id} className="sh-legend-item">
          <ShiftChip shift={s} />
          <span className="muted">
            {s.start}–{s.end}
            {isOvernight(s) ? " (+1)" : ""} · {paidHours(s)} h
          </span>
        </span>
      ))}
    </div>
  );
}

function whenText(a: Availability): string {
  return a.date ? shortDay(a.date) : `Every ${WEEKDAY_NAMES[a.weekday ?? 0]}`;
}

/** Bulk result as one line: what was applied, skipped (with the first reasons) and warned. */
export function bulkMessage(out: BulkResult | string, verb: string): Msg {
  if (typeof out === "string") return { tone: "err", text: out };
  const parts = [`${verb} ${out.applied}.`];
  if (out.skipped.length) {
    const first = out.skipped.slice(0, 2).map((s) => `${personName(s.personId)} ${shortDay(s.date)}: ${s.message}`);
    parts.push(`Skipped ${out.skipped.length}: ${first.join(" · ")}${out.skipped.length > 2 ? " …" : ""}`);
  }
  if (out.warnings.length) parts.push(`${out.warnings.length} to check: ${out.warnings[0]!.message}`);
  return { tone: out.skipped.length || out.warnings.length ? "warn" : "ok", text: parts.join(" ") };
}

// ---------- availability ----------

const BLANK = { kind: "unavailable" as "unavailable" | "preferred", repeat: "date" as "date" | "weekly", date: "", weekday: "1", shiftId: "", note: "" };

export function AvailabilityTab({ actor }: { actor: WorkforceActor }) {
  const data = useShifts();
  const [form, setForm] = useState(BLANK);
  const [msg, setMsg] = useState<Msg>(null);
  const mine = (data.availability ?? []).filter((a) => a.personId === actor.id && (!a.date || a.date > todayISO()));
  const teamIds = new Set(rosterTeamFor(actor.id).map((p) => p.id));
  const team = (data.availability ?? []).filter((a) => teamIds.has(a.personId) && (!a.date || a.date > todayISO()));
  const active = data.shifts.filter((s) => s.active);

  async function save() {
    const error = await addAvailability(actor, {
      kind: form.kind,
      ...(form.repeat === "date" ? { date: form.date } : { weekday: Number(form.weekday) }),
      ...(form.kind === "preferred" ? { shiftId: form.shiftId } : {}),
      note: form.note,
    });
    setMsg(error ? { tone: "err", text: error } : null);
    if (!error) setForm(BLANK);
    return error;
  }

  const row = (a: Availability, own: boolean) => [
    ...(own ? [] : [personName(a.personId)]),
    whenText(a),
    a.kind === "preferred" ? <ShiftChip key="s" shift={shiftById(a.shiftId ?? "", data)} /> : <span key="s" className="sh-unavail">Unavailable</span>,
    a.note ?? "",
    ...(own
      ? [
          <ActionButton key="r" className="btn-ghost btn-tiny" busyLabel="Removing…" doneLabel="Removed" success="Availability removed." onAction={() => removeAvailability(actor, a.id)} onError={(m) => setMsg({ tone: "err", text: m })}>
            Remove
          </ActionButton>,
        ]
      : []),
  ];

  return (
    <>
      <Banner message={msg} />
      <Card title="My availability">
        <DataTable headers={["When", "Availability", "Note", ""]} rows={mine.map((a) => row(a, true))} empty={<EmptyState title="No availability set" />} />
      </Card>
      <Card title="Add availability">
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
          }}
        >
          <div className="form-grid-2">
            <Field label="Type">
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value === "preferred" ? "preferred" : "unavailable" })}>
                <option value="unavailable">Unavailable</option>
                <option value="preferred">Preferred shift</option>
              </select>
            </Field>
            <Field label="Repeats">
              <select value={form.repeat} onChange={(e) => setForm({ ...form, repeat: e.target.value === "weekly" ? "weekly" : "date" })}>
                <option value="date">One date</option>
                <option value="weekly">Every week</option>
              </select>
            </Field>
            {form.repeat === "date" ? (
              <Field label="Date" required>
                <input type="date" min={addDaysISO(todayISO(), 1)} max={addDaysISO(todayISO(), 365)} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
              </Field>
            ) : (
              <Field label="Weekday" required>
                <select value={form.weekday} onChange={(e) => setForm({ ...form, weekday: e.target.value })}>
                  {WEEK_ORDER.map((d) => (
                    <option key={d} value={d}>
                      {WEEKDAY_NAMES[d]}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {form.kind === "preferred" && (
              <Field label="Shift" required>
                <select value={form.shiftId} onChange={(e) => setForm({ ...form, shiftId: e.target.value })}>
                  <option value="">Pick a shift</option>
                  {active.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} {s.start}–{s.end}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Note" wide>
              <input value={form.note} maxLength={300} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </Field>
          </div>
          <div className="row-gap">
            <ActionButton className="btn" busyLabel="Saving…" doneLabel="Saved" success="Availability saved." onAction={save}>
              Save
            </ActionButton>
          </div>
        </form>
      </Card>
      {teamIds.size > 0 && (
        <Card title="Team availability">
          <DataTable headers={["Person", "When", "Availability", "Note"]} rows={team.map((a) => row(a, false))} empty={<EmptyState title="No one on your team has set availability" />} />
        </Card>
      )}
    </>
  );
}

// ---------- team calendar ----------

/** Weeks the calendar shows: last week to five weeks ahead (what backend mode loads). */
const CAL_MIN = -1;
const CAL_MAX = 5;

export function TeamCalendar({ actor }: { actor: WorkforceActor }) {
  const data = useShifts();
  const today = todayISO();
  const [offset, setOffset] = useState(0);
  const weekStart = addDaysISO(weekStartOf(today), offset * 7);
  const days = weekDates(weekStart);
  const rows = useMemo(() => teamCalendarRows(actor, days, data), [actor, days.join(), data]); // eslint-disable-line react-hooks/exhaustive-deps
  const people = [...new Map(rows.map((r) => [r.personId, r.name])).entries()].sort((a, b) => (a[0] === actor.id ? -1 : b[0] === actor.id ? 1 : a[1].localeCompare(b[1])));
  const used = data.shifts.filter((s) => rows.some((r) => r.shiftId === s.id));
  return (
    <Card
      title={`Week of ${fmt(weekStart)}`}
      action={
        <div className="row-gap">
          <button className="btn-ghost btn-tiny" type="button" disabled={offset <= CAL_MIN} onClick={() => setOffset(offset - 1)}>
            Previous
          </button>
          {offset !== 0 && (
            <button className="btn-ghost btn-tiny" type="button" onClick={() => setOffset(0)}>
              This week
            </button>
          )}
          <button className="btn-ghost btn-tiny" type="button" disabled={offset >= CAL_MAX} onClick={() => setOffset(offset + 1)}>
            Next
          </button>
        </div>
      }
    >
      {people.length === 0 ? (
        <EmptyState title="No published shifts this week" />
      ) : (
        <div className="stack">
          <div className="table-scroll">
            <table className="sh-cal">
              <thead>
                <tr>
                  <th>Person</th>
                  {days.map((d) => (
                    <th key={d} className={d === today ? "today" : undefined}>
                      {shortDay(d)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {people.map(([id, name]) => (
                  <tr key={id} className={id === actor.id ? "me" : undefined}>
                    <th scope="row">{id === actor.id ? `${name} (you)` : name}</th>
                    {days.map((d) => {
                      const r = rows.find((x) => x.personId === id && x.date === d);
                      return <td key={d}>{r ? <ShiftChip shift={shiftById(r.shiftId, data)} /> : <span className="muted">Off</span>}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ShiftLegend shifts={used} />
        </div>
      )}
    </Card>
  );
}

// ---------- roster dialogs ----------

export function BulkAssignDialog({
  actor,
  ctx,
  dates,
  onClose,
  onDone,
}: {
  actor: WorkforceActor;
  ctx: RosterContext;
  dates: string[];
  onClose: () => void;
  onDone: (msg: Msg) => void;
}) {
  const data = useShifts();
  const today = todayISO();
  const open = dates.filter((d) => d > today);
  const team = rosterTeamFor(actor.id, dates[dates.length - 1]);
  const [people, setPeople] = useState<string[]>([]);
  const [days, setDays] = useState<string[]>(open.filter((d) => !weeklyOffFor(actor.id, d)));
  const [shiftId, setShiftId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  async function apply() {
    if (shiftId === "") return "Pick a shift (or Clear).";
    const out = await bulkAssign(actor, ctx, people, days, shiftId === "clear" ? null : shiftId, weeklyOffFor);
    if (typeof out === "string") {
      setError(out);
      return out;
    }
    onDone(bulkMessage(out, shiftId === "clear" ? "Cleared" : "Assigned"));
    if (out.applied) notify(`${shiftId === "clear" ? "Cleared" : "Assigned"} ${out.applied} ${out.applied === 1 ? "shift" : "shifts"}.`);
    onClose();
    return null;
  }

  return (
    <Dialog
      open
      wide
      title="Bulk assign"
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <ActionButton className="btn" busyLabel="Assigning…" onAction={apply} onError={setError}>
            Apply
          </ActionButton>
        </>
      }
    >
      <div className="stack">
        {error && <p className="note err">{error}</p>}
        <fieldset className="sh-pick">
          <legend>People</legend>
          <label className="row-gap">
            <input type="checkbox" checked={people.length === team.length && team.length > 0} onChange={(e) => setPeople(e.target.checked ? team.map((p) => p.id) : [])} />
            <span>Everyone</span>
          </label>
          {team.map((p) => (
            <label key={p.id} className="row-gap">
              <input type="checkbox" checked={people.includes(p.id)} onChange={() => setPeople(toggle(people, p.id))} />
              <span>{p.fullName}</span>
            </label>
          ))}
        </fieldset>
        <fieldset className="sh-pick">
          <legend>Days</legend>
          {open.length === 0 && <span className="muted">No upcoming days in this view.</span>}
          {open.map((d) => (
            <label key={d} className="row-gap">
              <input type="checkbox" checked={days.includes(d)} onChange={() => setDays(toggle(days, d))} />
              <span>{shortDay(d)}</span>
            </label>
          ))}
        </fieldset>
        <Field label="Shift" required>
          <select value={shiftId} onChange={(e) => setShiftId(e.target.value)}>
            <option value="">Pick a shift</option>
            {data.shifts
              .filter((s) => s.active)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} {s.start}–{s.end}
                </option>
              ))}
            <option value="clear">Clear these days</option>
          </select>
        </Field>
      </div>
    </Dialog>
  );
}

export function RepeatWeekDialog({ actor, ctx, weekStart, onClose, onDone }: { actor: WorkforceActor; ctx: RosterContext; weekStart: string; onClose: () => void; onDone: (msg: Msg) => void }) {
  const [weeks, setWeeks] = useState("1");
  const [error, setError] = useState<string | null>(null);
  async function apply() {
    const out = await copyWeek(actor, ctx, weekStart, addDaysISO(weekStart, 7), Number(weeks), weeklyOffFor);
    if (typeof out === "string") {
      setError(out);
      return out;
    }
    onDone(bulkMessage(out, "Copied"));
    if (out.applied) notify(`Copied ${out.applied} ${out.applied === 1 ? "shift" : "shifts"}.`);
    onClose();
    return null;
  }
  return (
    <Dialog
      open
      title={`Repeat week of ${fmt(weekStart)}`}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <ActionButton className="btn" busyLabel="Copying…" onAction={apply} onError={setError}>
            Repeat
          </ActionButton>
        </>
      }
    >
      <div className="stack">
        {error && <p className="note err">{error}</p>}
        <Field label="Following weeks">
          <select value={weeks} onChange={(e) => setWeeks(e.target.value)}>
            {[1, 2, 3, 4, 6, 8].map((n) => (
              <option key={n} value={n}>
                {n} {n === 1 ? "week" : "weeks"} (to {fmt(addDaysISO(weekStart, 7 * n + 6))})
              </option>
            ))}
          </select>
        </Field>
        <p className="muted">Days that already have a shift are kept.</p>
      </div>
    </Dialog>
  );
}

export function UnpublishDialog({ actor, weekStart, onClose, onDone }: { actor: WorkforceActor; weekStart: string; onClose: () => void; onDone: (msg: Msg) => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function apply() {
    const out = await unpublishWeek(actor, weekStart, reason);
    if (out) {
      setError(out);
      return out;
    }
    onDone({ tone: "ok", text: "Week is back in draft. Your team was told." });
    onClose();
    return null;
  }
  return (
    <Dialog
      open
      title={`Unpublish week of ${fmt(weekStart)}`}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <ActionButton className="btn danger" busyLabel="Unpublishing…" success="Roster back in draft." onAction={apply} onError={setError}>
            Unpublish
          </ActionButton>
        </>
      }
    >
      <div className="stack">
        {error && <p className="note err">{error}</p>}
        <Field label="Reason for your team" required>
          <textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <p className="muted">Open swap requests in this week are cancelled.</p>
      </div>
    </Dialog>
  );
}
