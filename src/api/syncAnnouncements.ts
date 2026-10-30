/**
 * Announcements in backend mode (/announcements): HR / admins publish to everyone, a country or a department,
 * managers to their team; "must acknowledge" posts collect read receipts. Local mode keeps collabLocal.ts.
 */
import type { Announcement, AnnouncementScope, AnnouncementState } from "../data/collabData.ts";
import { api, apiSessionAccount } from "./client.ts";
import { createApiMirror, errorText } from "./syncOps.ts";
import { utcIso } from "./syncShared.ts";
import { keepFresh } from "./syncShare.ts";

interface AnnouncementOut {
  id: string;
  title: string;
  body: string;
  scope: AnnouncementScope;
  audience: string;
  state: AnnouncementState;
  published_at: string | null;
  scheduled_for: string | null;
  author_id: string | null;
  author_name: string;
  must_acknowledge: boolean;
  read: boolean;
  acknowledged: boolean;
  can_manage: boolean;
  audience_count: number | null;
  read_count: number | null;
  ack_count: number | null;
}

export interface AnnouncementReceipt {
  personId: string;
  name: string;
  department: string;
  countryCode: string;
  readAt?: string;
  acknowledgedAt?: string;
}

function fromApi(a: AnnouncementOut): Announcement {
  const me = apiSessionAccount();
  return {
    id: a.id,
    title: a.title,
    body: a.body,
    scope: a.scope,
    audience: a.audience,
    state: a.state,
    publishedAt: utcIso(a.published_at),
    scheduledFor: utcIso(a.scheduled_for),
    author: a.author_name,
    authorId: a.author_id ?? undefined,
    readBy: a.read && me ? [me] : [],
    mustAcknowledge: a.must_acknowledge,
    acknowledged: a.acknowledged,
    serverCanManage: a.can_manage,
    ...(a.audience_count !== null ? { receipts: { audience: a.audience_count, read: a.read_count ?? 0, acknowledged: a.ack_count ?? 0 } } : {}),
  };
}

export const announcementsMirror = createApiMirror<Announcement[]>(
  () => [],
  async () => (await api.get<AnnouncementOut[]>("/announcements")).map(fromApi),
);
keepFresh(() => announcementsMirror.reload(), 120_000);

function upsert(a: AnnouncementOut) {
  const row = fromApi(a);
  const list = announcementsMirror.get();
  announcementsMirror.set(list.some((x) => x.id === row.id) ? list.map((x) => (x.id === row.id ? row : x)) : [row, ...list]);
}

const enc = encodeURIComponent;

async function send(path: string, body?: unknown): Promise<string | null> {
  try {
    upsert(await api.post<AnnouncementOut>(path, body));
    return null;
  } catch (e) {
    return errorText(e);
  }
}

export function apiMarkAnnouncementRead(id: string): void {
  const row = announcementsMirror.get().find((a) => a.id === id);
  const me = apiSessionAccount();
  if (!row || !me || row.readBy.includes(me) || row.state !== "Published") return;
  void send(`/announcements/${enc(id)}/read`);
}

export const apiAcknowledgeAnnouncement = (id: string) => send(`/announcements/${enc(id)}/acknowledge`);
export const apiSetAnnouncementState = (id: string, state: AnnouncementState) => send(`/announcements/${enc(id)}/state`, { state });

export function apiCreateAnnouncement(input: {
  title: string;
  body: string;
  scope: AnnouncementScope;
  audience: string;
  state: "Draft" | "Published";
  mustAcknowledge: boolean;
}): Promise<string | null> {
  return send("/announcements", {
    title: input.title.trim(),
    body: input.body.trim(),
    scope: input.scope,
    audience: input.audience.trim(),
    state: input.state,
    must_acknowledge: input.mustAcknowledge,
  });
}

export async function apiAnnouncementReceipts(id: string): Promise<AnnouncementReceipt[] | string> {
  try {
    const rows = await api.get<{ person_id: string; name: string; department: string; country_code: string; read_at: string | null; acknowledged_at: string | null }[]>(
      `/announcements/${enc(id)}/receipts`,
    );
    return rows.map((r) => ({
      personId: r.person_id,
      name: r.name,
      department: r.department,
      countryCode: r.country_code,
      readAt: utcIso(r.read_at),
      acknowledgedAt: utcIso(r.acknowledged_at),
    }));
  } catch (e) {
    return errorText(e);
  }
}
