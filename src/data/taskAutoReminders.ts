import { useEffect } from "react";
import { parseISODate, todayISO } from "../model.ts";
import { usePortal } from "../store.tsx";
import { pushManagerTaskAlert, pushPersonTaskAlert } from "./collabLocal.ts";
import { isTaskAutoMode, readSentReminders, writeSentReminders } from "./taskAutoMode.ts";

function daysUntil(due: string, today: string): number {
  return Math.round((parseISODate(due).getTime() - parseISODate(today).getTime()) / 86400000);
}

/**
 * Automatic mode reminders. For every task whose owner has Automatic mode on:
 * - 1 day before due → reminder to the owner (once per task + due date)
 * - overdue → alert to the owner and their manager (once per task + due date)
 * Safe to mount in several places; sent reminders are remembered in localStorage.
 */
export function useTaskAutoReminders() {
  const { state, recordTaskAutoEvents } = usePortal();
  const today = todayISO();
  useEffect(() => {
    const sent = readSentReminders();
    const alerts: (() => void)[] = [];
    const events: { taskId: string; action: string; detail?: string }[] = [];
    for (const task of state.tasks) {
      if (task.status === "done" || task.status === "scheduled" || !task.due) continue;
      if (!isTaskAutoMode(task.employeeId)) continue;
      const log = sent[task.id] ?? {};
      const days = daysUntil(task.due, today);
      if (days < 0) {
        if (log.overdue === task.due) continue;
        sent[task.id] = { ...log, overdue: task.due };
        alerts.push(() =>
          pushPersonTaskAlert({
            recipientId: task.employeeId,
            title: `Overdue · ${task.code}`,
            body: `“${task.subject}” was due ${task.due}.`,
          }),
        );
        alerts.push(() =>
          pushManagerTaskAlert({
            title: `Overdue · ${task.code}`,
            body: `${task.owner}'s task “${task.subject}” was due ${task.due}.`,
            employeeId: task.employeeId,
          }),
        );
        events.push({ taskId: task.id, action: "Overdue reminder sent automatically", detail: "Owner and manager" });
      } else if (days <= 1) {
        if (log.soon === task.due) continue;
        sent[task.id] = { ...log, soon: task.due };
        const when = days === 0 ? "today" : "tomorrow";
        alerts.push(() =>
          pushPersonTaskAlert({
            recipientId: task.employeeId,
            title: `Due ${when} · ${task.code}`,
            body: `“${task.subject}” is due ${when}.`,
          }),
        );
        events.push({ taskId: task.id, action: "Due reminder sent automatically", detail: `Due ${when}` });
      }
    }
    if (alerts.length === 0) return;
    writeSentReminders(sent);
    // Alert ids are time-based; space the calls so each gets a unique id.
    alerts.forEach((send, i) => window.setTimeout(send, i * 2));
    recordTaskAutoEvents(events);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.tasks, today]);
}
