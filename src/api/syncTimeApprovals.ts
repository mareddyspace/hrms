/**
 * The approvals inbox from the API (GET /approvals/pending): everything waiting on the signed-in user.
 * Backend mode only. The Approvals page marks its existing rows as actionable from this list and adds rows for
 * request types it has no list of its own for; decisions go through each area's own endpoint.
 */
import { API_ENABLED, api, apiSessionAccount } from "./client.ts";
import { attendanceMirror } from "./syncAttendance.ts";
import { claimsMirror } from "./syncTimeExpenses.ts";
import { timeMirror } from "./syncTimeSheets.ts";
import { createMirror, mutate, utcIso } from "./syncShared.ts";

export interface PendingItemOut {
  kind: "leave" | "attendance_correction" | "timesheet_week" | "approval" | string;
  type: string;
  id: string;
  employee_id: string;
  employee_name: string | null;
  summary: string;
  submitted_at: string | null;
  href: string;
}

export interface ApiPendingState {
  items: PendingItemOut[];
  /** Ids waiting on me: leave request, correction, timesheet week and approval instance ids. */
  ids: Set<string>;
}

export const pendingMirror = createMirror<PendingItemOut[], ApiPendingState>(
  () => ({ items: [], ids: new Set() }),
  () => api.get<PendingItemOut[]>("/approvals/pending"),
  (items) => ({
    items: items.map((i) => ({ ...i, submitted_at: utcIso(i.submitted_at) ?? null })),
    ids: new Set(items.map((i) => i.id)),
  }),
);

// Any decision in my areas changes what's waiting.
let timer: number | undefined;
const refresh = () => {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void pendingMirror.reload(), 300);
};
if (API_ENABLED && typeof window !== "undefined") {
  queueMicrotask(() => {
    attendanceMirror.subscribe(refresh);
    claimsMirror.subscribe(refresh);
    timeMirror.subscribe(refresh);
  });
  // New requests from others arrive without a change here: check again every minute while signed in.
  window.setInterval(() => {
    if (apiSessionAccount()) void pendingMirror.reload();
  }, 60000);
}

/** Decide a generic approval instance (types without a page of their own here). */
export function apiDecideInstance(instanceId: string, decision: "approve" | "reject", note?: string) {
  const text = note?.trim() || (decision === "reject" ? "Declined." : "");
  return mutate(
    () => api.post(`/approvals/${encodeURIComponent(instanceId)}/decision`, { decision, note: text || null }),
    pendingMirror,
  );
}

/** Reload everything in this area (e.g. after the Approvals page opens). */
export function reloadTimeArea() {
  void attendanceMirror.reload();
  void timeMirror.reload();
  void claimsMirror.reload();
  void pendingMirror.reload();
}
