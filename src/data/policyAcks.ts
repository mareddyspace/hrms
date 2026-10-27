/** Per-user policy acknowledgements: {policyId, version, at}. Small localStorage store. */
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
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable — keep in memory */
  }
  listeners.forEach((fn) => fn());
}

if (typeof window !== "undefined") {
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
  return ack;
}
