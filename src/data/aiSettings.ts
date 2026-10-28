import { useSyncExternalStore } from "react";
import { appendAuditEntries } from "./auditTrail.ts";
import { AI_AGENTS } from "./platformData.ts";
import { policyCatalog, type Policy } from "./policyLibrary.ts";
import { API_ENABLED, createApiMirror, errorText } from "../api/syncOps.ts";
import { apiPutAiSettings, loadApiAiSettings } from "../api/syncOpsAdmin.ts";

/** AI features an admin can switch off. */
export type AiFeatureKey = "employee360" | "cvReading" | "jdWriter" | "documentAssistant" | "plainAnalytics" | "homeSummaries";

export const AI_FEATURES: { key: AiFeatureKey; label: string; hint: string }[] = [
  { key: "employee360", label: "Employee 360 summary", hint: "Short summary on a person's profile" },
  { key: "cvReading", label: "CV reading", hint: "Pulls details from uploaded CVs" },
  { key: "jdWriter", label: "Job description writer", hint: "Drafts job descriptions" },
  { key: "documentAssistant", label: "Document assistant", hint: "Helps draft letters and documents" },
  { key: "plainAnalytics", label: "Plain-language analytics", hint: "Ask analytics questions in words" },
  { key: "homeSummaries", label: "Home summaries", hint: "AI summary cards on Home" },
];

type AiSettingsState = {
  /** Stored as "off" lists so new policies and agents start switched on. */
  disabledPolicies: string[];
  disabledAgents: string[];
  disabledFeatures: AiFeatureKey[];
};

const KEY = "timez.ai.settings.v1";
const FEATURE_KEYS = new Set<string>(AI_FEATURES.map((f) => f.key));
const EMPTY: AiSettingsState = { disabledPolicies: [], disabledAgents: [], disabledFeatures: [] };

const listeners = new Set<() => void>();
let cache: AiSettingsState | null = null;
let policyCache: Policy[] | null = null;

/** Every policy in the library (all countries). */
export function knowledgePolicies(): Policy[] {
  if (!policyCache) policyCache = policyCatalog(() => []);
  return policyCache;
}

function strings(list: unknown): string[] {
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
}

/* Backend mode (VITE_API_URL): the switches live on the server and apply to everyone. */
const aiMirror = createApiMirror<AiSettingsState | null>(
  () => null,
  async () => {
    const out = await loadApiAiSettings();
    return {
      disabledPolicies: out.disabled_policies,
      disabledAgents: out.disabled_agents,
      disabledFeatures: out.disabled_features.filter((k): k is AiFeatureKey => FEATURE_KEYS.has(k)),
    };
  },
);
let apiSaveError: string | null = null;
if (API_ENABLED) aiMirror.subscribe(() => listeners.forEach((fn) => fn()));

/** Backend mode: the last save error (shown on the AI settings page), or null. */
export function aiSettingsError(): string | null {
  return apiSaveError;
}

export function getAiSettings(): AiSettingsState {
  if (API_ENABLED) return aiMirror.get() ?? EMPTY;
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<AiSettingsState>) : {};
    cache = {
      disabledPolicies: strings(parsed.disabledPolicies),
      disabledAgents: strings(parsed.disabledAgents),
      disabledFeatures: strings(parsed.disabledFeatures).filter((k): k is AiFeatureKey => FEATURE_KEYS.has(k)),
    };
  } catch {
    cache = EMPTY;
  }
  return cache;
}

export function subscribeAiSettings(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAiSettings(): AiSettingsState {
  return useSyncExternalStore(subscribeAiSettings, getAiSettings, getAiSettings);
}

function write(next: AiSettingsState, actor: { id: string; name: string }, field: string, before: string, after: string) {
  if (API_ENABLED) {
    // Shown at once; the server keeps it and audits the change.
    aiMirror.set(next);
    apiPutAiSettings({ disabled_policies: next.disabledPolicies, disabled_agents: next.disabledAgents, disabled_features: next.disabledFeatures })
      .then(
        () => {
          apiSaveError = null;
        },
        (e) => {
          apiSaveError = errorText(e);
        },
      )
      .finally(() => void aiMirror.reload());
    return;
  }
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* keep in memory */
  }
  listeners.forEach((fn) => fn());
  appendAuditEntries([
    {
      at: new Date().toISOString(),
      actorId: actor.id,
      actorName: actor.name,
      entity: "AI settings",
      entityId: "ai-settings",
      action: "Updated",
      changes: [{ field, before, after }],
    },
  ]);
}

const onOff = (on: boolean) => (on ? "On" : "Off");

/** Policy ids Copilot may answer from, or null when every policy is enabled. */
export function enabledPolicyIds(): string[] | null {
  const off = getAiSettings().disabledPolicies;
  if (!off.length) return null;
  const offSet = new Set(off);
  return knowledgePolicies()
    .map((p) => p.id)
    .filter((id) => !offSet.has(id));
}

export function policyEnabled(id: string): boolean {
  return !getAiSettings().disabledPolicies.includes(id);
}

export function agentEnabled(id: string): boolean {
  return !getAiSettings().disabledAgents.includes(id);
}

export function aiFeatureOn(key: AiFeatureKey): boolean {
  return !getAiSettings().disabledFeatures.includes(key);
}

type Actor = { id: string; name: string };

function toggleIn<T extends string>(list: T[], id: T, on: boolean): T[] {
  const rest = list.filter((x) => x !== id);
  return on ? rest : [...rest, id];
}

export function setPoliciesEnabled(ids: string[], on: boolean, actor: Actor): void {
  const state = getAiSettings();
  const idSet = new Set(ids);
  const changed = ids.filter((id) => policyEnabled(id) !== on);
  if (!changed.length) return;
  const disabledPolicies = on ? state.disabledPolicies.filter((x) => !idSet.has(x)) : [...new Set([...state.disabledPolicies, ...ids])];
  const titles = changed.map((id) => {
    const p = knowledgePolicies().find((x) => x.id === id);
    return p ? `${p.title}` : id;
  });
  const label = titles.length > 3 ? `${titles.length} policies` : titles.join(", ");
  write({ ...state, disabledPolicies }, actor, `knowledge source · ${label}`, onOff(!on), onOff(on));
}

export function setAgentEnabled(id: string, on: boolean, actor: Actor): void {
  if (agentEnabled(id) === on) return;
  const state = getAiSettings();
  const name = AI_AGENTS.find((a) => a.id === id)?.name ?? id;
  write({ ...state, disabledAgents: toggleIn(state.disabledAgents, id, on) }, actor, `agent · ${name}`, onOff(!on), onOff(on));
}

export function setAiFeature(key: AiFeatureKey, on: boolean, actor: Actor): void {
  if (aiFeatureOn(key) === on) return;
  const state = getAiSettings();
  const label = AI_FEATURES.find((f) => f.key === key)?.label ?? key;
  write({ ...state, disabledFeatures: toggleIn(state.disabledFeatures, key, on) }, actor, `feature · ${label}`, onOff(!on), onOff(on));
}
