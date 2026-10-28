import { useEffect, useSyncExternalStore } from "react";
import { findDemoById, managementChain } from "../demoAccounts.ts";
import { todayISO } from "../model.ts";
import { usePortal } from "../store.tsx";
import { getAttendanceState, subscribeAttendance } from "./attendanceLocal.ts";
import { hrRequestClockRunning, hrRequestOverdue } from "./collabData.ts";
import { getCollabState, pushPersonTaskAlert, subscribeCollab } from "./collabLocal.ts";

const SENT_KEY = "timez.approvalReminders.sent.v1";
/** Items waiting longer than this get a reminder. */
const WAITING_MS = 2 * 86_400_000;
/** HR requests due within this window count as "near SLA". */
const NEAR_SLA_MS = 4 * 3_600_000;
/** How often the check runs while the portal is open. */
const CHECK_EVERY_MS = 30 * 60_000;

type SentLog = Record<string, string>;

function readSent(): SentLog {
  try {
    const raw = localStorage.getItem(SENT_KEY);
    const parsed = raw ? (JSON.parse(raw) as SentLog) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeSent(log: SentLog, today: string) {
  // Only today's keys matter for "once per item per day"; drop older ones so the log stays small.
  const kept: SentLog = {};
  for (const [key, day] of Object.entries(log)) if (day === today) kept[key] = day;
  try {
    localStorage.setItem(SENT_KEY, JSON.stringify(kept));
  } catch {
    /* storage blocked: reminders may repeat on the next load */
  }
}

function ageMs(dateOrIso: string, now: number): number {
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(dateOrIso) ? `${dateOrIso}T00:00:00` : dateOrIso;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : now - t;
}

function days(ms: number): number {
  return Math.max(1, Math.floor(ms / 86_400_000));
}

type Reminder = { key: string; recipientId: string; title: string; body: string; href: string };

/**
 * Reminds approvers about items that have waited on them for more than 2 days: leave requests,
 * attendance corrections, and HR requests near or past their SLA (to the HR owner). Runs on load and
 * every 30 minutes; each item is reminded at most once per day (sent keys kept in localStorage).
 * Safe to mount once in the Shell.
 */
export function useApprovalReminders() {
  const { state } = usePortal();
  const attendance = useSyncExternalStore(subscribeAttendance, getAttendanceState, getAttendanceState);
  const collab = useSyncExternalStore(subscribeCollab, getCollabState, getCollabState);

  useEffect(() => {
    function run() {
      const now = Date.now();
      const today = todayISO();
      const sent = readSent();
      const due: Reminder[] = [];

      for (const leave of state.leaveRequests) {
        if (leave.status !== "pending") continue;
        const waited = ageMs(leave.appliedOn, now);
        if (waited <= WAITING_MS) continue;
        const approver = managementChain(leave.employeeId)[0];
        if (!approver) continue;
        const name = findDemoById(leave.employeeId)?.fullName ?? "A team member";
        due.push({
          key: `leave:${leave.id}`,
          recipientId: approver.id,
          title: `Approve leave · ${name}`,
          body: `${leave.code} leave ${leave.from}${leave.to !== leave.from ? ` to ${leave.to}` : ""} has waited ${days(waited)} days for your decision.`,
          href: "/approvals",
        });
      }

      for (const c of attendance.corrections) {
        if (c.status !== "Pending" || !c.managerId) continue;
        const waited = ageMs(c.createdAt, now);
        if (waited <= WAITING_MS) continue;
        due.push({
          key: `correction:${c.id}`,
          recipientId: c.managerId,
          title: `Approve attendance correction · ${c.employeeName}`,
          body: `Correction for ${c.date} has waited ${days(waited)} days for your decision.`,
          href: "/attendance",
        });
      }

      for (const r of collab.hrRequests) {
        if (!r.assigneeId || !r.dueAt || !hrRequestClockRunning(r)) continue;
        const left = Date.parse(r.dueAt) - now;
        if (Number.isNaN(left) || left > NEAR_SLA_MS) continue;
        const overdue = hrRequestOverdue(r, now);
        due.push({
          key: `hr:${r.id}`,
          recipientId: r.assigneeId,
          title: `${overdue ? "HR request overdue" : "HR request due soon"} · ${r.subject}`,
          body: overdue
            ? `${r.category} request from ${r.requesterName ?? "an employee"} is past its due time.`
            : `${r.category} request from ${r.requesterName ?? "an employee"} is due within 4 hours.`,
          href: `/help?request=${encodeURIComponent(r.id)}`,
        });
      }

      const fresh = due.filter((d) => sent[d.key] !== today);
      if (fresh.length === 0) return;
      fresh.forEach((d) => {
        sent[d.key] = today;
      });
      writeSent(sent, today);
      // Notification ids are time-based; space the calls so each gets a unique id.
      fresh.forEach((d, i) =>
        window.setTimeout(
          () => pushPersonTaskAlert({ recipientId: d.recipientId, title: d.title, body: d.body, href: d.href }),
          i * 2,
        ),
      );
    }

    run();
    const timer = window.setInterval(run, CHECK_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [state.leaveRequests, attendance.corrections, collab.hrRequests]);
}
