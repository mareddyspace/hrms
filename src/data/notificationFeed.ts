import type { AppNotification } from "./collabData.ts";
import { notificationFeedFor, type NotifFeedItem } from "./collabLocal.ts";
import { getTickets, isOpenTicket } from "./ticketStore.ts";
import type { PortalState } from "../model.ts";

/** The parts of portal state used to tell whether a notification's item is already handled. */
export type NotifPortalContext = Pick<PortalState, "leaveRequests" | "tasks" | "orgTimesheets">;

/** True once the leave, timesheet, task or ticket a notification points at no longer needs this user. */
export function portalNotificationDone(n: AppNotification, userId: string, portal?: NotifPortalContext): boolean {
  const ref = n.ref;
  if (!ref) return false;
  switch (ref.kind) {
    case "ticket": {
      const ticket = getTickets().find((t) => t.id === ref.id);
      return !!ticket && (!isOpenTicket(ticket) || ticket.assigneeId !== userId);
    }
    case "leave": {
      if (!portal) return false;
      const leave = portal.leaveRequests.find((r) => r.id === ref.id);
      return !leave || leave.status !== "pending";
    }
    case "timesheet": {
      if (!portal) return false;
      const sheet = portal.orgTimesheets.find((r) => r.id === ref.id);
      return !sheet || sheet.status !== "submitted";
    }
    case "timesheetSubmit": {
      if (!portal) return false;
      const sheet = portal.orgTimesheets.find((r) => r.id === ref.id);
      return !!sheet && sheet.status !== "draft" && sheet.status !== "missing";
    }
    case "task": {
      if (!portal) return false;
      const task = portal.tasks.find((t) => t.code === ref.id || t.id === ref.id);
      return !!task && task.status === "done";
    }
    default:
      return false;
  }
}

/** Notification Center rows for one user (newest first, duplicates collapsed, handled items marked done). */
export function buildNotificationFeed(userId: string, portal?: NotifPortalContext, role?: string): NotifFeedItem[] {
  return notificationFeedFor(userId, role, (n) => portalNotificationDone(n, userId, portal));
}

/**
 * Unread count shown on the Notification Center page and the shell bell / sidebar badge.
 * Both must call this with the same portal state so the numbers always match.
 */
export function countUnreadNotificationsFor(userId: string, portal?: NotifPortalContext, role?: string): number {
  return buildNotificationFeed(userId, portal, role).filter((i) => i.unread).length;
}
