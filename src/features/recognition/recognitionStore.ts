import { todayISO } from "../../model.ts";
import { DEMO_ACCOUNTS } from "../../demoAccounts.ts";
import { TASK_TEAM } from "../../data/taskTeam.ts";
import { PRAISE_BADGES, type FeedbackItem, type PraiseBadge } from "../../data/talentData.ts";
import { pushPersonTaskAlert } from "../../data/collabLocal.ts";
import { appendAuditEntries } from "../../data/auditTrail.ts";
import { listPeople } from "../../data/peopleLocal.ts";
import { arrayOr, createLocalStore, isHr, newId, personName, type PlusActor, type PlusResult } from "../talentplus/shared.ts";
import { API_ENABLED, apiRun, createApiMirror, subscribeAll } from "../../api/syncOps.ts";
import {
  apiCancelRedemption,
  apiDecideRedemption,
  apiGiveKudos,
  apiRedeem,
  apiToggleKudosLike,
  loadApiRecognition,
} from "../../api/syncOpsEngagement.ts";

const ROUTE = "/recognition";

export const MONTHLY_ALLOWANCE = 100;
export const MAX_POINTS_PER_KUDOS = 50;
export const RECOGNITION_VALUES: readonly PraiseBadge[] = PRAISE_BADGES;

export interface Kudos {
  id: string;
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  value: PraiseBadge;
  message: string;
  points: number;
  createdOn: string;
  createdAt: string;
  likes: string[];
}

export interface Reward {
  id: string;
  name: string;
  description: string;
  points: number;
  /** Day-off rewards need a preferred date in the note. */
  needsDate?: boolean;
}

export const REWARDS: Reward[] = [
  { id: "rw-coffee", name: "Coffee voucher", description: "₹500 café voucher, sent by email", points: 50 },
  { id: "rw-swag", name: "Swag pack", description: "Hoodie, bottle and stickers", points: 120 },
  { id: "rw-voucher", name: "Gift voucher", description: "₹2,000 shopping voucher", points: 200 },
  { id: "rw-dayoff", name: "Extra day off", description: "One paid day off — HR adds it to your leave", points: 300, needsDate: true },
];

export type RedemptionStatus = "Requested" | "Fulfilled" | "Declined" | "Cancelled";

export interface Redemption {
  id: string;
  personId: string;
  personName: string;
  rewardId: string;
  rewardName: string;
  points: number;
  note: string;
  status: RedemptionStatus;
  requestedOn: string;
  decidedByName?: string;
  decidedOn?: string;
  decisionNote?: string;
}

/** Backend mode: the signed-in person's points as the API counts them. */
export interface ApiPoints {
  personId: string;
  received: number;
  spent: number;
  balance: number;
  givenThisMonth: number;
  allowanceLeft: number;
}

export interface RecognitionState {
  kudos: Kudos[];
  redemptions: Redemption[];
  /** Likes on praise posted from Performance (feedback id → people who liked it). */
  praiseLikes: Record<string, string[]>;
  /** Backend mode only. */
  apiPoints?: ApiPoints;
  /** Backend mode only: the reward catalogue. */
  apiRewards?: Reward[];
}

function seedKudos(): Kudos[] {
  const k = (id: string, fromId: string, toId: string, value: PraiseBadge, points: number, createdOn: string, message: string, likes: string[] = []): Kudos => ({
    id,
    fromId,
    fromName: personName(fromId),
    toId,
    toName: personName(toId),
    value,
    message,
    points,
    createdOn,
    createdAt: `${createdOn}T10:00:00.000Z`,
    likes,
  });
  return [
    k("kd-seed-1", "emp-ram", "emp-mahesh", "Ownership", 40, "2026-10-20", "Stayed with the release until every timesheet bug was closed. Thank you!", ["emp-priya", "emp-kabir"]),
    k("kd-seed-2", "emp-priya", "emp-mahesh", "Teamwork", 20, "2026-10-14", "Paired with me on the leave calendar and made it far simpler.", ["emp-ram"]),
    k("kd-seed-3", "demo-hr-admin", "emp-ram", "Mentorship", 30, "2026-10-09", "Great coaching for the new joiners this month.", ["demo-ceo"]),
    k("kd-seed-4", "demo-ceo", "demo-hr-admin", "Customer first", 50, "2026-09-26", "The benefits enrolment went smoothly for every country. Well done.", ["emp-ram", "demo-admin"]),
    k("kd-seed-5", "emp-kabir", "emp-diya", "Innovation", 15, "2026-10-22", "Your regression scripts cut our test run in half.", []),
  ];
}

function defaults(): RecognitionState {
  return { kudos: seedKudos(), redemptions: [], praiseLikes: {} };
}

function normalize(saved: unknown, base: RecognitionState): RecognitionState {
  const s = (saved ?? {}) as Partial<RecognitionState>;
  const likes = s.praiseLikes && typeof s.praiseLikes === "object" && !Array.isArray(s.praiseLikes) ? s.praiseLikes : base.praiseLikes;
  return { kudos: arrayOr(s.kudos, base.kudos), redemptions: arrayOr(s.redemptions, base.redemptions), praiseLikes: likes };
}

const store = createLocalStore<RecognitionState>("kastech.recognition.v1", defaults, normalize);

/**
 * Backend mode: kudos, likes, points, rewards and redemptions come from the API (in memory only).
 * Likes on Performance praise stay in this browser, as before.
 */
const mirror = createApiMirror<RecognitionState>(
  () => ({ kudos: [], redemptions: [], praiseLikes: {} }),
  (accountId) => loadApiRecognition(accountId, {}),
);
let composed: { api: RecognitionState; local: RecognitionState; out: RecognitionState } | null = null;

function composedState(): RecognitionState {
  const api = mirror.get();
  const local = store.getState();
  if (composed?.api !== api || composed.local !== local) composed = { api, local, out: { ...api, praiseLikes: local.praiseLikes } };
  return composed.out;
}

export const subscribeRecognition = API_ENABLED ? subscribeAll(store.subscribe, mirror.subscribe) : store.subscribe;
export const getRecognitionState: () => RecognitionState = API_ENABLED ? composedState : store.getState;
export const resetRecognition = store.reset;

/** Rewards on offer: the API catalogue in backend mode, otherwise the built-in list. */
export function rewardCatalogue(state: RecognitionState = getRecognitionState()): Reward[] {
  return state.apiRewards ?? REWARDS;
}

/** The API's own count, when it is for this person (backend mode). */
function apiPointsFor(personId: string, state: RecognitionState): ApiPoints | undefined {
  return state.apiPoints?.personId === personId ? state.apiPoints : undefined;
}

/* ───────────── Helpers ───────────── */

function alert(recipientId: string, title: string, body: string) {
  try {
    pushPersonTaskAlert({ recipientId, title, body, href: ROUTE });
  } catch {
    // Notifications are best-effort.
  }
}

function audit(actor: PlusActor, entity: string, entityId: string, subjectId: string, action: "Created" | "Updated", changes: { field: string; before: string; after: string }[]) {
  try {
    appendAuditEntries([{ at: new Date().toISOString(), actorId: actor.id, actorName: actor.fullName, entity, entityId, subjectId, action, changes }]);
  } catch {
    // The audit trail is best-effort.
  }
}

const monthOf = (iso: string) => iso.slice(0, 7);

/** Everyone who can receive kudos: sign-in people and their teammates. */
export function recognitionPeople(): { id: string; fullName: string; department: string }[] {
  if (API_ENABLED) {
    return listPeople()
      .filter((p) => p.employmentStatus !== "Terminated")
      .map((p) => ({ id: p.id, fullName: p.fullName, department: p.department ?? "" }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
  }
  const seen = new Set<string>();
  return TASK_TEAM.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)))
    .map((p) => ({ id: p.id, fullName: p.fullName, department: p.department }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export function pointsGivenThisMonth(personId: string, state: RecognitionState = getRecognitionState(), today = todayISO()): number {
  const api = apiPointsFor(personId, state);
  if (api) return api.givenThisMonth;
  return state.kudos.filter((k) => k.fromId === personId && monthOf(k.createdOn) === monthOf(today)).reduce((a, k) => a + k.points, 0);
}

export function allowanceLeft(personId: string, state: RecognitionState = getRecognitionState()): number {
  const api = apiPointsFor(personId, state);
  if (api) return api.allowanceLeft;
  return Math.max(0, MONTHLY_ALLOWANCE - pointsGivenThisMonth(personId, state));
}

export function pointsReceived(personId: string, state: RecognitionState = getRecognitionState()): number {
  const api = apiPointsFor(personId, state);
  if (api) return api.received;
  return state.kudos.filter((k) => k.toId === personId).reduce((a, k) => a + k.points, 0);
}

/** Points held for open requests or spent on fulfilled ones. */
export function pointsSpent(personId: string, state: RecognitionState = getRecognitionState()): number {
  const api = apiPointsFor(personId, state);
  if (api) return api.spent;
  return state.redemptions
    .filter((r) => r.personId === personId && (r.status === "Requested" || r.status === "Fulfilled"))
    .reduce((a, r) => a + r.points, 0);
}

export function pointsBalance(personId: string, state: RecognitionState = getRecognitionState()): number {
  const api = apiPointsFor(personId, state);
  if (api) return api.balance;
  return pointsReceived(personId, state) - pointsSpent(personId, state);
}

/* ───────────── Kudos ───────────── */

export type KudosInput = { toId: string; value: string; message: string; points: number };

export function giveKudos(actor: PlusActor, input: KudosInput): PlusResult | Promise<PlusResult> {
  const message = input.message.trim().replace(/\s+/g, " ");
  if (!input.toId) return "Pick a colleague.";
  if (input.toId === actor.id) return "You can't give kudos to yourself.";
  if (!recognitionPeople().some((p) => p.id === input.toId)) return "Pick a colleague from the list.";
  if (!RECOGNITION_VALUES.includes(input.value as PraiseBadge)) return "Pick a value.";
  if (message.length < 10) return "Write at least 10 characters.";
  if (message.length > 500) return "Keep the message under 500 characters.";
  if (!Number.isInteger(input.points) || input.points < 0) return "Points must be a whole number.";
  if (input.points > MAX_POINTS_PER_KUDOS) return `Up to ${MAX_POINTS_PER_KUDOS} points per kudos.`;
  // Backend mode: the API checks the allowance, notifies and audits.
  if (API_ENABLED) return apiRun(() => apiGiveKudos({ ...input, message }), mirror);
  const today = todayISO();
  const result = store.mutate((s) => {
    const left = MONTHLY_ALLOWANCE - pointsGivenThisMonth(actor.id, s, today);
    if (input.points > left) return left > 0 ? `You have ${left} points left this month.` : "You've used this month's points. You can still send kudos without points.";
    const now = Date.now();
    const duplicate = s.kudos.some(
      (k) => k.fromId === actor.id && k.toId === input.toId && k.message.toLowerCase() === message.toLowerCase() && now - Date.parse(k.createdAt) < 10 * 60 * 1000,
    );
    if (duplicate) return "You already sent this message to them.";
    s.kudos.unshift({
      id: newId("kd"),
      fromId: actor.id,
      fromName: actor.fullName,
      toId: input.toId,
      toName: personName(input.toId),
      value: input.value as PraiseBadge,
      message,
      points: input.points,
      createdOn: today,
      createdAt: new Date(now).toISOString(),
      likes: [],
    });
    return null;
  });
  if (result) return result;
  alert(input.toId, "You received kudos", `${actor.fullName} recognised you for ${input.value}${input.points ? ` (+${input.points} points)` : ""}.`);
  if (input.points) {
    audit(actor, "Recognition points", input.toId, input.toId, "Created", [{ field: "Points given", before: "", after: String(input.points) }]);
  }
  return null;
}

/** Like or unlike a wall post (kudos or praise from Performance). */
export function toggleLike(actor: PlusActor, itemId: string): PlusResult | Promise<PlusResult> {
  if (API_ENABLED && mirror.get().kudos.some((k) => k.id === itemId)) return apiRun(() => apiToggleKudosLike(itemId), mirror);
  return store.mutate((s) => {
    const kudos = s.kudos.find((k) => k.id === itemId);
    if (kudos) {
      kudos.likes = kudos.likes.includes(actor.id) ? kudos.likes.filter((id) => id !== actor.id) : [...kudos.likes, actor.id];
      return null;
    }
    const current = s.praiseLikes[itemId] ?? [];
    s.praiseLikes[itemId] = current.includes(actor.id) ? current.filter((id) => id !== actor.id) : [...current, actor.id];
    return null;
  });
}

export interface WallItem {
  id: string;
  source: "kudos" | "praise";
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  value?: string;
  message: string;
  points: number;
  createdOn: string;
  createdAt: string;
  likes: string[];
}

/** Kudos plus public praise posted in Performance, newest first. */
export function wallItems(state: RecognitionState, feedback: FeedbackItem[]): WallItem[] {
  const kudos: WallItem[] = state.kudos.map((k) => ({ ...k, source: "kudos" }));
  const praise: WallItem[] = feedback
    .filter((f) => f.kind === "Praise")
    .map((f) => ({
      id: f.id,
      source: "praise",
      fromId: f.fromId,
      fromName: f.fromName,
      toId: f.toId,
      toName: f.toName,
      value: f.badge,
      message: f.message,
      points: 0,
      createdOn: f.createdOn,
      createdAt: f.createdAt ?? `${f.createdOn}T09:00:00.000Z`,
      likes: state.praiseLikes[f.id] ?? [],
    }));
  return [...kudos, ...praise].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/* ───────────── Rewards ───────────── */

export function redeemReward(actor: PlusActor, rewardId: string, note: string): PlusResult | Promise<PlusResult> {
  const reward = rewardCatalogue().find((r) => r.id === rewardId);
  if (!reward) return "That reward is no longer available.";
  const text = note.trim();
  if (reward.needsDate && text.length < 3) return "Add your preferred date.";
  if (text.length > 300) return "Keep the note under 300 characters.";
  if (API_ENABLED) return apiRun(() => apiRedeem(rewardId, text), mirror);
  const id = newId("rd");
  const result = store.mutate((s) => {
    const balance = pointsBalance(actor.id, s);
    if (balance < reward.points) return `You need ${reward.points} points — you have ${balance}.`;
    if (s.redemptions.some((r) => r.personId === actor.id && r.rewardId === rewardId && r.status === "Requested")) {
      return "You already have an open request for this reward.";
    }
    s.redemptions.unshift({
      id,
      personId: actor.id,
      personName: actor.fullName,
      rewardId,
      rewardName: reward.name,
      points: reward.points,
      note: text,
      status: "Requested",
      requestedOn: todayISO(),
    });
    return null;
  });
  if (result) return result;
  for (const hr of DEMO_ACCOUNTS.filter((a) => isHr(a.role) && a.id !== actor.id)) {
    alert(hr.id, "Reward request", `${actor.fullName} redeemed ${reward.points} points for ${reward.name}.`);
  }
  audit(actor, "Reward redemption", id, actor.id, "Created", [{ field: "Reward", before: "", after: `${reward.name} (${reward.points} points)` }]);
  return null;
}

export function cancelRedemption(actor: PlusActor, id: string): PlusResult | Promise<PlusResult> {
  if (API_ENABLED) return apiRun(() => apiCancelRedemption(id), mirror);
  return store.mutate((s) => {
    const row = s.redemptions.find((r) => r.id === id);
    if (!row) return "Request not found.";
    if (row.personId !== actor.id) return "Only the requester can cancel.";
    if (row.status !== "Requested") return "This request is already closed.";
    row.status = "Cancelled";
    row.decidedOn = todayISO();
    return null;
  });
}

/** HR fulfils or declines a request. Declined points go back to the person. */
export function decideRedemption(actor: PlusActor, id: string, fulfil: boolean, note: string): PlusResult | Promise<PlusResult> {
  if (!isHr(actor.role)) return "Only HR can fulfil reward requests.";
  const text = note.trim();
  if (!fulfil && text.length < 3) return "Add a reason for declining.";
  if (API_ENABLED) return apiRun(() => apiDecideRedemption(id, fulfil, text), mirror);
  let row: Redemption | undefined;
  const result = store.mutate((s) => {
    row = s.redemptions.find((r) => r.id === id);
    if (!row) return "Request not found.";
    if (row.personId === actor.id) return "Someone else in HR must handle your own request.";
    if (row.status !== "Requested") return "This request is already closed.";
    row.status = fulfil ? "Fulfilled" : "Declined";
    row.decidedByName = actor.fullName;
    row.decidedOn = todayISO();
    row.decisionNote = text || undefined;
    return null;
  });
  if (result || !row) return result;
  alert(
    row.personId,
    fulfil ? "Reward on its way" : "Reward request declined",
    fulfil ? `${row.rewardName} is fulfilled.${text ? ` ${text}` : ""}` : `${row.rewardName}: ${text}. Your ${row.points} points are back.`,
  );
  audit(actor, "Reward redemption", row.id, row.personId, "Updated", [{ field: "Status", before: "Requested", after: row.status }]);
  return null;
}
