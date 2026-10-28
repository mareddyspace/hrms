/**
 * Per-user policy acknowledgements: {policyId, version, at}. Small localStorage store.
 * Backend mode (VITE_API_URL set): kept in memory and loaded from /documents/policy-acks; acknowledging posts there.
 */
import { API_ENABLED, onApiSession } from "../api/client.ts";
import { apiAcknowledgePolicy, apiMe, fetchPolicyAcks, type PolicyAckOut } from "../api/syncRewards.ts";
import { RETIRED_SIGN_IN_IDS } from "../demoAccounts.ts";

export interface PolicyAck {
  policyId: string;
  version: string;
  at: string;
}

type AckState = Record<string, PolicyAck[]>;

const KEY = "kastech.policyAcks.v1";
const listeners = new Set<() => void>();
let cache: AckState | null = null;

function read(): AckState {
  if (cache) return cache;
  if (API_ENABLED) {
    cache = {};
    return cache;
  }
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    cache = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ...(parsed as AckState) } : {};
    // Acknowledgements of a retired sign-in account (Compensation persona, Country Managers) are dropped.
    for (const id of RETIRED_SIGN_IN_IDS) delete cache[id];
  } catch {
    cache = {};
  }
  return cache;
}

function write(next: AckState) {
  cache = next;
  if (!API_ENABLED) {
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable — keep in memory */
    }
  }
  listeners.forEach((fn) => fn());
}

/* ───────── Backend mode ───────── */

let apiAccount: string | null = null;
let myEmployeeId: string | null = null;

/** Merges API rows into the state (newest first per person and policy). */
function mergeApi(base: AckState, rows: PolicyAckOut[], replaceFor?: string): AckState {
  const next: AckState = { ...base };
  if (replaceFor) next[replaceFor] = [];
  const sorted = [...rows].sort((a, b) => b.acknowledged_at.localeCompare(a.acknowledged_at));
  for (const r of sorted) {
    const list = (next[r.employee_id] ?? []).filter((a) => a !== undefined);
    if (list.some((a) => a.policyId === r.policy_id && a.at >= r.acknowledged_at)) continue;
    next[r.employee_id] = [
      { policyId: r.policy_id, version: r.policy_version, at: r.acknowledged_at },
      ...list.filter((a) => a.policyId !== r.policy_id),
    ];
  }
  return next;
}

async function loadMine(accountId: string) {
  const [me, rows] = await Promise.all([apiMe(accountId).catch(() => null), fetchPolicyAcks()]);
  if (apiAccount !== accountId) return;
  myEmployeeId = me?.employee_id ?? accountId;
  write(mergeApi(read(), rows, myEmployeeId));
}

/** HR: loads everyone's acknowledgements (in scope) for these policies. No-op outside backend mode. */
export async function loadPolicyAcksFor(policyIds: string[]): Promise<void> {
  if (!API_ENABLED || !apiAccount) return;
  const account = apiAccount;
  const lists = await Promise.all([...new Set(policyIds)].map((id) => fetchPolicyAcks(id)));
  if (apiAccount !== account) return;
  write(mergeApi(read(), lists.flat()));
}

if (API_ENABLED) {
  onApiSession((accountId) => {
    apiAccount = accountId;
    myEmployeeId = null;
    write({});
    if (accountId) void loadMine(accountId);
  });
}

/**
 * Backend mode: records the acknowledgement on the server, then reloads yours. Returns an error message or null.
 * Browser-only mode: same as acknowledgePolicy.
 */
export async function acknowledgePolicyAsync(userId: string, policyId: string, version: string): Promise<string | null> {
  if (!API_ENABLED) {
    acknowledgePolicy(userId, policyId, version);
    return null;
  }
  const error = await apiAcknowledgePolicy(policyId, version);
  if (!error && apiAccount) await loadMine(apiAccount);
  return error;
}

if (typeof window !== "undefined" && !API_ENABLED) {
  window.addEventListener("storage", (event) => {
    if (event.key === KEY) {
      cache = null;
      listeners.forEach((fn) => fn());
    }
  });
}

export function subscribePolicyAcks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPolicyAcks(): AckState {
  return read();
}

/** The latest acknowledgement a user gave for a policy (any version). */
export function latestAck(state: AckState, userId: string, policyId: string): PolicyAck | undefined {
  return (state[userId] ?? []).find((a) => a.policyId === policyId);
}

/** True only when the user acknowledged this exact version. */
export function hasAcknowledged(state: AckState, userId: string, policyId: string, version: string): boolean {
  return latestAck(state, userId, policyId)?.version === version;
}

export function acknowledgePolicy(userId: string, policyId: string, version: string): PolicyAck {
  const state = read();
  const ack: PolicyAck = { policyId, version, at: new Date().toISOString() };
  const others = (state[userId] ?? []).filter((a) => a.policyId !== policyId);
  write({ ...state, [userId]: [ack, ...others] });
  if (API_ENABLED) {
    // Shown straight away; the server's copy replaces it (or it is dropped if the save fails).
    void apiAcknowledgePolicy(policyId, version).then((error) => {
      if (error) console.warn(`Policy acknowledgement not saved: ${error}`);
      if (apiAccount) void loadMine(apiAccount);
    });
  }
  return ack;
}
