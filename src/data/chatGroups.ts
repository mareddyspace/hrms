/**
 * Group chat membership: add people, remove people (the group's creator), leave, rename.
 * Backend mode goes through /chat (syncChat.ts); local mode edits the conversations kept by collabLocal.ts.
 */
import { API_ENABLED } from "../api/client.ts";
import { apiAddGroupMembers, apiRemoveGroupMember, apiRenameGroup } from "../api/syncChat.ts";
import type { Conversation } from "./collabData.ts";
import { getCollabState, updateCollab } from "./collabLocal.ts";

/** The creator removes others; groups without a known creator let any member manage them. */
export function canRemoveOthers(c: Conversation, selfId: string): boolean {
  return c.kind === "group" && c.participantIds.includes(selfId) && (!c.createdBy || c.createdBy === selfId);
}

function note(c: Conversation, selfId: string, selfName: string, text: string) {
  c.messages.push({
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    fromId: selfId,
    fromName: selfName,
    text,
    at: new Date().toISOString(),
    readBy: [selfId],
  });
}

function localGroup(id: string, selfId: string): Conversation | string {
  const c = getCollabState().conversations.find((x) => x.id === id);
  if (!c) return "Conversation not found.";
  if (c.kind !== "group") return "Only group chats have members to change.";
  if (!c.participantIds.includes(selfId)) return "Only group members can change the group.";
  return c;
}

export async function addGroupMembers(
  id: string,
  people: { id: string; name: string }[],
  self: { id: string; name: string },
): Promise<string | null> {
  if (people.length === 0) return "Pick at least one person.";
  if (API_ENABLED) return apiAddGroupMembers(id, people.map((p) => p.id));
  const found = localGroup(id, self.id);
  if (typeof found === "string") return found;
  const fresh = people.filter((p) => !found.participantIds.includes(p.id));
  if (fresh.length === 0) return "Those people are already in the group.";
  updateCollab((s) => {
    const c = s.conversations.find((x) => x.id === id);
    if (!c) return;
    c.participantIds = [...c.participantIds, ...fresh.map((p) => p.id)];
    c.participantNames = [...c.participantNames, ...fresh.map((p) => p.name)];
    note(c, self.id, self.name, `Added ${fresh.map((p) => p.name).join(", ")}.`);
  });
  return null;
}

export async function removeGroupMember(id: string, personId: string, self: { id: string; name: string }): Promise<string | null> {
  if (API_ENABLED) return apiRemoveGroupMember(id, personId);
  const found = localGroup(id, self.id);
  if (typeof found === "string") return found;
  const idx = found.participantIds.indexOf(personId);
  if (idx < 0) return "That person is not in this group.";
  if (personId !== self.id && !canRemoveOthers(found, self.id)) return "Only the person who created the group can remove others.";
  const name = found.participantNames[idx] ?? personId;
  updateCollab((s) => {
    const c = s.conversations.find((x) => x.id === id);
    if (!c) return;
    const at = c.participantIds.indexOf(personId);
    c.participantIds = c.participantIds.filter((_, i) => i !== at);
    c.participantNames = c.participantNames.filter((_, i) => i !== at);
    note(c, self.id, self.name, personId === self.id ? `${self.name} left the group.` : `Removed ${name}.`);
  });
  return null;
}

export async function renameGroup(id: string, title: string, self: { id: string; name: string }): Promise<string | null> {
  const clean = title.trim();
  if (!clean) return "Give the group a name.";
  if (API_ENABLED) return apiRenameGroup(id, clean);
  const found = localGroup(id, self.id);
  if (typeof found === "string") return found;
  if (found.title === clean) return null;
  updateCollab((s) => {
    const c = s.conversations.find((x) => x.id === id);
    if (!c) return;
    c.title = clean;
    note(c, self.id, self.name, `Renamed the group to “${clean}”.`);
  });
  return null;
}
