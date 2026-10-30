/**
 * Messages in backend mode (/chat): conversations, members, messages and read state come from the server, so the
 * other people in a conversation see them on their own sign-in. Local mode keeps using collabLocal.ts.
 */
import type { Conversation } from "../data/collabData.ts";
import { api, apiSessionAccount } from "./client.ts";
import { createApiMirror, errorText } from "./syncOps.ts";
import { utcIso } from "./syncShared.ts";
import { keepFresh } from "./syncShare.ts";

interface ConversationOut {
  id: string;
  kind: "direct" | "group";
  title: string;
  restricted: Conversation["restricted"] | null;
  participant_ids: string[];
  participant_names: string[];
  is_member: boolean;
  messages: { id: string; from_id: string; from_name: string; text: string; attachment_name: string | null; at: string; read_by: string[] }[];
}

function fromApi(c: ConversationOut): Conversation {
  return {
    id: c.id,
    kind: c.kind,
    title: c.title,
    participantIds: c.participant_ids,
    participantNames: c.participant_names,
    restricted: c.restricted ?? undefined,
    messages: c.messages.map((m) => ({
      id: m.id,
      fromId: m.from_id,
      fromName: m.from_name,
      text: m.text,
      at: utcIso(m.at),
      readBy: m.read_by,
      attachmentName: m.attachment_name ?? undefined,
    })),
  };
}

export const chatMirror = createApiMirror<Conversation[]>(
  () => [],
  async () => (await api.get<ConversationOut[]>("/chat/conversations")).map(fromApi),
);
keepFresh(() => chatMirror.reload(), 30_000);

function upsert(c: ConversationOut): Conversation {
  const row = fromApi(c);
  const list = chatMirror.get();
  chatMirror.set(list.some((x) => x.id === row.id) ? list.map((x) => (x.id === row.id ? row : x)) : [row, ...list]);
  return row;
}

const enc = encodeURIComponent;

export async function apiSendChat(conversationId: string, text: string, attachmentName?: string): Promise<string | null> {
  try {
    upsert(await api.post<ConversationOut>(`/chat/conversations/${enc(conversationId)}/messages`, { text, attachment_name: attachmentName ?? null }));
    return null;
  } catch (e) {
    return errorText(e);
  }
}

/** Marks the thread read here at once and on the server in the background. */
export function apiMarkChatRead(conversationId: string): void {
  const me = apiSessionAccount();
  if (!me) return;
  const list = chatMirror.get();
  chatMirror.set(
    list.map((c) =>
      c.id !== conversationId ? c : { ...c, messages: c.messages.map((m) => (m.readBy.includes(me) ? m : { ...m, readBy: [...m.readBy, me] })) },
    ),
  );
  void api.post<ConversationOut>(`/chat/conversations/${enc(conversationId)}/read`).then(upsert, (e) => console.warn("Could not mark read", e));
}

/** Prefix for a direct chat that is still being opened on the server ("dm:<person id>"). */
export const PENDING_DIRECT = "dm:";

/**
 * Opens (or reuses) the direct chat with this person. Returns "dm:<person id>" straight away; the Messages page
 * resolves it to the real conversation once the server answers (so callers can navigate synchronously).
 */
export function apiStartDirect(personId: string): string {
  const existing = findDirect(personId);
  if (existing) return existing.id;
  void api
    .post<ConversationOut>("/chat/conversations", { kind: "direct", member_ids: [personId] })
    .then(upsert, (e) => console.warn("Could not open the chat", e));
  return `${PENDING_DIRECT}${personId}`;
}

export function findDirect(personId: string, list: Conversation[] = chatMirror.get()): Conversation | undefined {
  return list.find((c) => c.kind === "direct" && !c.restricted && c.participantIds.length === 2 && c.participantIds.includes(personId));
}

export async function apiCreateGroup(title: string, memberIds: string[]): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    const row = upsert(await api.post<ConversationOut>("/chat/conversations", { kind: "group", title, member_ids: memberIds }));
    return { ok: true, id: row.id };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}
