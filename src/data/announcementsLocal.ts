/**
 * Announcements in local mode: the company news a real employee receives (same posts the backend seeds in
 * backend/app/services/announcement_samples.py), who each post is addressed to, acknowledge, pin and new posts.
 * Backend mode uses /announcements (src/api/syncAnnouncements.ts) instead.
 */
import type { Announcement, AnnouncementScope } from "./collabData.ts";
import { canManageAnnouncement } from "./collabData.ts";
import { getCollabState, updateCollab } from "./collabLocal.ts";
import { TIMEZ_COUNTRIES } from "../model.ts";

export const ANNOUNCEMENT_CATEGORIES = ["Holiday", "Policy", "Event", "IT", "Wellness", "People", "Leadership", "General"] as const;
export type AnnouncementCategory = (typeof ANNOUNCEMENT_CATEGORIES)[number];

type Seed = [id: string, title: string, category: AnnouncementCategory, scope: AnnouncementScope, audience: string, at: string,
  author: string, authorId: string | undefined, body: string, opts?: { ack?: boolean; pinned?: boolean }];

const SEED: Seed[] = [
  ["an-ceo-q3", "A note from Jordan: Q3 results and the road to 2027", "Leadership", "Company", "All TimeZ", "2026-10-29T08:00:00Z",
    "Jordan Blake", "demo-ceo",
    "Team,\n\nQ3 closed at 112% of plan, led by the Northwind and Maple programmes. Thank you for the long weeks around the October releases.\n\nFor Q4 our focus is simple: ship the clinic portal on time, keep client escalations under 48 hours and finish the hiring plan for Bengaluru and Austin.\n\nI'll take questions at the all-hands on 12 November.\n\nJordan",
    { pinned: true }],
  ["an-it-maint-nov8", "Planned maintenance: VPN and email, Sat 8 Nov", "IT", "Company", "All TimeZ", "2026-10-28T11:00:00Z",
    "Alex Morgan", "demo-admin",
    "VPN, email and the portal will be unavailable on Saturday 8 November from 22:00 to 02:00 UTC while we upgrade the network gateways.\n\nSave your work and sign out before the window."],
  ["an-it-mfa", "Two-step sign-in required from 15 November", "IT", "Company", "All TimeZ", "2026-10-27T09:30:00Z",
    "Alex Morgan", "demo-admin",
    "From 15 November every account needs two-step sign-in (an authenticator app). Set it up under My profile > Security.",
    { ack: true }],
  ["an-policy-travel", "Travel and expense policy updated", "Policy", "Company", "All TimeZ", "2026-10-22T06:00:00Z",
    "Farhan Ali", "demo-hr-admin",
    "Changes from 1 November:\n- Book flights at least 14 days ahead unless your manager approves.\n- Hotel caps updated per city.\n- Submit receipts within 30 days.",
    { ack: true }],
  ["an-joiners-oct", "Welcome to our October joiners", "People", "Company", "All TimeZ", "2026-10-20T07:00:00Z",
    "Farhan Ali", "demo-hr-admin",
    "Please welcome 14 new colleagues who joined in October across Engineering, Sales and Customer Success. Say hello on Messages."],
  ["an-wellness-nov", "Wellbeing week: free counselling and fitness sessions", "Wellness", "Company", "All TimeZ", "2026-10-24T05:00:00Z",
    "Farhan Ali", "demo-hr-admin",
    "From 10 to 14 November: confidential counselling slots, desk-yoga at lunch and a step challenge."],
  ["an-in-diwali", "Diwali: India offices closed Monday 9 November", "Holiday", "Country", "IN", "2026-10-26T04:00:00Z",
    "Farhan Ali", "demo-hr-admin",
    "Bengaluru, Hyderabad and Pune offices are closed on Monday 9 November for Diwali. On-call staff earn a comp-off day.",
    { pinned: true }],
  ["an-in-diwali-party", "Diwali celebration at the Bengaluru office", "Event", "Country", "IN", "2026-10-25T09:00:00Z",
    "Farhan Ali", "demo-hr-admin", "Thursday 6 November from 16:00 on the 5th floor terrace: rangoli contest, sweets and a team photo."],
  ["an-in-hybrid", "Hybrid work: three office days from 1 December", "Policy", "Country", "IN", "2026-10-23T10:00:00Z",
    "Farhan Ali", "demo-hr-admin", "From 1 December India teams work from the office Tuesday to Thursday.", { ack: true }],
  ["an-us-thanksgiving", "Thanksgiving: US offices closed 26-27 November", "Holiday", "Country", "US", "2026-10-27T15:00:00Z",
    "Farhan Ali", "demo-hr-admin", "Austin and New York offices are closed on Thursday 26 and Friday 27 November."],
  ["an-us-enrolment", "Benefits open enrolment closes 15 November", "People", "Country", "US", "2026-10-21T14:00:00Z",
    "Farhan Ali", "demo-hr-admin", "Review your medical, dental and 401(k) choices for 2027 under Benefits."],
  ["an-gb-closure", "UK office closure over Christmas", "Holiday", "Country", "GB", "2026-10-28T09:00:00Z",
    "Farhan Ali", "demo-hr-admin", "The London office closes from 24 December and reopens on 4 January."],
  ["an-eng-hackday", "Engineering hack day, Friday 14 November", "Event", "Department", "Engineering", "2026-10-27T05:30:00Z",
    "Ram Krishnan", "emp-ram", "No sprint work on 14 November. Pitch an idea by 7 November; teams of up to four."],
  ["an-ta-referrals", "Referral bonus doubled for engineering roles", "People", "Department", "Talent Acquisition", "2026-10-24T16:00:00Z",
    "Sophie Clark", "demo-recruiter", "Until 31 December referral bonuses for engineering hires are doubled."],
  ["an-people-payroll-cutoff", "November payroll cut-off: 20 November", "People", "Department", "People", "2026-10-29T07:00:00Z",
    "Farhan Ali", "demo-hr-admin", "Changes after 20 November move to the December run."],
  ["an-exec-board", "Board pack due 20 November", "Leadership", "Department", "Executive", "2026-10-28T17:00:00Z",
    "Jordan Blake", "demo-ceo", "Function heads: send your Q4 board slides to the CEO office by 20 November."],
];

const EARLIER: Record<string, AnnouncementCategory> = { "an-1": "Event", "an-2": "Holiday", "an-3": "Policy", "an-4": "Event", "an-5": "People" };

/** Adds the sample posts this browser does not have yet (insert-once by id) and fills in missing categories. */
export function ensureLocalAnnouncements(): void {
  const have = new Set(getCollabState().announcements.map((a) => a.id));
  const missing = SEED.filter(([id]) => !have.has(id));
  const needsCategory = getCollabState().announcements.some((a) => !a.category && EARLIER[a.id]);
  if (!missing.length && !needsCategory) return;
  updateCollab((s) => {
    for (const [id, title, category, scope, audience, at, author, authorId, body, opts] of missing) {
      s.announcements.push({
        id, title, body, scope, audience, state: "Published", publishedAt: at, author, authorId, readBy: [],
        category, pinned: !!opts?.pinned, mustAcknowledge: !!opts?.ack, acknowledgedBy: [],
      });
    }
    for (const a of s.announcements) if (!a.category && EARLIER[a.id]) a.category = EARLIER[a.id];
  });
}

const countryCode = (text: string) =>
  text.length === 2 ? text.toUpperCase() : TIMEZ_COUNTRIES.find((c) => c.name.toLowerCase() === text.toLowerCase())?.code ?? text;

/** Local mode: whether a published post is addressed to this person. */
export function addressedTo(
  a: Announcement,
  me: { id: string; countryCode?: string; department?: string },
  managerChain: (id: string) => string[],
): boolean {
  if (a.scope === "Company") return true;
  if (a.scope === "Country") return !!me.countryCode && countryCode(a.audience) === me.countryCode.toUpperCase();
  if (a.scope === "Department") return !!me.department && a.audience.toLowerCase() === me.department.toLowerCase();
  return !!a.authorId && (a.authorId === me.id || managerChain(me.id).includes(a.authorId));
}

export function acknowledgeLocal(id: string, userId: string): string | null {
  const a = getCollabState().announcements.find((x) => x.id === id);
  if (!a) return "Announcement not found.";
  if (!a.mustAcknowledge) return "This announcement doesn't need an acknowledgement.";
  updateCollab((s) => {
    const row = s.announcements.find((x) => x.id === id);
    if (!row) return;
    row.acknowledgedBy = [...new Set([...(row.acknowledgedBy ?? []), userId])];
    if (!row.readBy.includes(userId)) row.readBy.push(userId);
  });
  return null;
}

export function markUnreadLocal(id: string, userId: string): void {
  updateCollab((s) => {
    const row = s.announcements.find((x) => x.id === id);
    if (row) row.readBy = row.readBy.filter((u) => u !== userId);
  });
}

export function pinLocal(id: string, pinned: boolean, actor: { id: string; fullName: string; role: string }): string | null {
  const a = getCollabState().announcements.find((x) => x.id === id);
  if (!a) return "Announcement not found.";
  if (!canManageAnnouncement(a, actor)) return "Only whoever manages this announcement can pin it.";
  updateCollab((s) => {
    const row = s.announcements.find((x) => x.id === id);
    if (row) row.pinned = pinned;
  });
  return null;
}

export function createLocalAnnouncement(
  input: { title: string; body: string; scope: AnnouncementScope; audience: string; state: "Draft" | "Published"; mustAcknowledge: boolean; category: string; pinned: boolean },
  actor: { id: string; fullName: string; role: string },
): { id: string } | { error: string } {
  if (!canManageAnnouncement({ scope: input.scope, author: actor.fullName, authorId: actor.id }, actor)) {
    return { error: "Only HR or admins publish announcements; managers post to their own team." };
  }
  const id = `an-local-${Date.now()}`;
  updateCollab((s) => {
    s.announcements.unshift({
      id,
      title: input.title.trim(),
      body: input.body.trim(),
      scope: input.scope,
      audience: input.audience.trim() || (input.scope === "Company" ? "All TimeZ" : "My team"),
      state: input.state,
      publishedAt: input.state === "Published" ? new Date().toISOString() : undefined,
      author: actor.fullName,
      authorId: actor.id,
      readBy: [actor.id],
      mustAcknowledge: input.mustAcknowledge,
      acknowledgedBy: [],
      category: input.category,
      pinned: input.pinned,
    });
  });
  return { id };
}
