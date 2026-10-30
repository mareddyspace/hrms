/* Roster grid pieces: shift colours, night/weekend markers, hours, and the editable person × day grid. */
import type { DragEvent } from "react";
import { addDaysISO, parseISODate } from "../../model.ts";
import type { ShiftAssignment, ShiftDef, ShiftState } from "./shiftsStore.ts";
import { isWeekend } from "./workforceShared.ts";

const KNOWN: Record<string, number> = { "sh-morning": 0, "sh-general": 1, "sh-evening": 2, "sh-night": 3, "sh-weekend": 4 };
const PALETTE = ["amber", "green", "blue", "violet", "teal", "rose", "slate"];

export function shiftColor(shift: ShiftDef | undefined): string {
  if (!shift) return "";
  if (shift.id in KNOWN) return PALETTE[KNOWN[shift.id]!]!;
  let h = 0;
  for (const ch of shift.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Paid length of a shift in hours (crossing midnight counts through to the next day). */
export function shiftHours(shift: ShiftDef | undefined): number {
  if (!shift) return 0;
  let span = minutes(shift.end) - minutes(shift.start);
  if (span <= 0) span += 1440;
  return span / 60;
}

/** Shifts that cross midnight or start in the late evening. */
export function isNightShift(shift: ShiftDef | undefined): boolean {
  if (!shift) return false;
  return minutes(shift.end) <= minutes(shift.start) || minutes(shift.start) >= 20 * 60;
}

export function ShiftChip({ shift, short = false }: { shift: ShiftDef | undefined; short?: boolean }) {
  if (!shift) return <span className="muted">—</span>;
  const night = isNightShift(shift);
  return (
    <span className={`wf-chip c-${shiftColor(shift)}${night ? " night" : ""}`} title={`${shift.name} ${shift.start}–${shift.end}${night ? " · night" : ""}`}>
      {short ? shift.name.slice(0, 1) : shift.name}
      {night && !short && <span className="wf-night-mark"> ☾</span>}
    </span>
  );
}

export function monthDates(year: number, monthIndex: number): string[] {
  const first = `${year}-${String(monthIndex + 1).padStart(2, "0")}-01`;
  const days = new Date(year, monthIndex + 1, 0).getDate();
  return Array.from({ length: days }, (_, i) => addDaysISO(first, i));
}

export function hoursFor(personId: string, dates: string[], state: ShiftState): number {
  const set = new Set(dates);
  return state.assignments
    .filter((a) => a.personId === personId && set.has(a.date))
    .reduce((sum, a) => sum + shiftHours(state.shifts.find((s) => s.id === a.shiftId)), 0);
}

export type CellInfo = {
  current?: ShiftAssignment;
  shift?: ShiftDef;
  locked: boolean;
  onLeave: boolean;
};

/** Drag data for a shift id (from the palette or another cell). */
export const DRAG_TYPE = "text/x-shift";

export function dragShift(e: DragEvent, shiftId: string) {
  e.dataTransfer.setData(DRAG_TYPE, shiftId);
  e.dataTransfer.effectAllowed = "copy";
}

export function droppedShift(e: DragEvent): string | null {
  const id = e.dataTransfer.getData(DRAG_TYPE);
  return id || (e.dataTransfer.types.includes(DRAG_TYPE) ? "" : null);
}

export function dayHead(iso: string): { dow: string; day: string; weekend: boolean } {
  const d = parseISODate(iso);
  return {
    dow: d.toLocaleDateString("en-IN", { weekday: "short" }),
    day: String(d.getDate()),
    weekend: isWeekend(iso),
  };
}
