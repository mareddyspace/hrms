import type { Task } from "../model.ts";
import { parseISODate, todayISO } from "../model.ts";

const DUE_SOON_DAYS = 3;

export function taskProgress(task: Task): number {
  if (typeof task.progressPct === "number") return Math.max(0, Math.min(100, Math.round(task.progressPct)));
  if (task.status === "done") return 100;
  if (task.status === "scheduled") return 0;
  if (task.status === "progress") {
    const ratio = task.hoursSpent / Math.max(task.estimatedHours, 0.25);
    return Math.max(10, Math.min(90, Math.round(ratio * 100)));
  }
  if (task.accepted) return 5;
  return 0;
}

export function isTaskOverdue(task: Task, today = todayISO()): boolean {
  return task.status !== "done" && task.status !== "scheduled" && !!task.due && task.due < today;
}

export function isTaskDueSoon(task: Task, today = todayISO()): boolean {
  if (task.status === "done" || task.status === "scheduled" || !task.due || task.due < today) return false;
  const from = parseISODate(today).getTime();
  const to = parseISODate(task.due).getTime();
  const days = Math.round((to - from) / 86400000);
  return days >= 0 && days <= DUE_SOON_DAYS;
}

export function taskStatusLabel(task: Task): string {
  if (task.status === "done") return "Completed";
  if (task.status === "scheduled") return "Scheduled";
  if (task.blocked) return "Blocked";
  if (task.inReview) return "Action required";
  if (task.status === "progress") return "In progress";
  if (task.accepted) return "Open";
  return "To do";
}

/** Single primary next step for the assignee (or manager reviewing). */
export function nextTaskActionHint(task: Task): string {
  if (task.status === "done") return "No further action — this task is complete.";
  if (task.status === "scheduled") return "Waiting for your manager to release this task.";
  if (task.blocked) return "Resolve or clear the blocker, or request help from your manager.";
  if (task.inReview) return "Submitted for review — the reviewer marks it complete, or returns it if more work is needed.";
  if (task.status === "open" && !task.accepted) return "Accept this task to acknowledge the assignment.";
  if (task.status === "open") return "Start the task when you are ready to begin work.";
  if (task.status === "progress") return "Update progress, then submit for review when finished.";
  return "Review this task and choose the next action.";
}

export function isTaskBlocked(task: Task): boolean {
  return Boolean(task.blocked) && task.status !== "done";
}

export function ensureTaskExtras(task: Task): Task {
  const progressPct = taskProgress(task);
  return {
    ...task,
    progressPct,
    accepted: task.accepted ?? task.status !== "open",
    inReview: task.inReview ?? false,
    dependsOn: task.dependsOn ?? "",
    projectName: task.projectName ?? task.client,
    peopleIds: task.peopleIds ?? [],
    subtasks: task.subtasks ?? [],
    attachments: task.attachments ?? [],
    comments: task.comments ?? [],
    activity: task.activity ?? [
      {
        id: `${task.id}-act-0`,
        at: task.createdAt,
        actor: task.assignedBy,
        action: "Assigned",
        detail: `Assigned to ${task.owner}`,
      },
    ],
  };
}
