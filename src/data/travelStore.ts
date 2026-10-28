/** Travel requests: raised by an employee, decided step by step (approval workflow "travel"). Saved in this browser. */
import { useSyncExternalStore } from "react";
import type { DecisionInfo } from "../model.ts";
import { todayISO, uid } from "../model.ts";
import { money } from "../countryPay.ts";
import { appendAuditEntries } from "./auditTrail.ts";
import { pushPersonTaskAlert } from "./collabLocal.ts";
import { resolveFlow, workflowVersion, type FlowDecision, type FlowStep } from "./approvalWorkflows.ts";
import { decideFlowStep, isWaitingOn, waitingApproverIds } from "./expenseFlow.ts";
import { API_ENABLED } from "../api/client.ts";
import { apiDecideTravel, apiSubmitTravel, apiWithdrawTravel, claimsMirror } from "../api/syncTimeExpenses.ts";

export const TRAVEL_MODES = ["Flight", "Train", "Bus", "Car", "Other"] as const;
export type TravelMode = (typeof TRAVEL_MODES)[number];

export interface TravelRequest extends DecisionInfo {
  id: string;
  employeeId: string;
  employeeName: string;
  purpose: string;
  fromCity: string;
  toCity: string;
  departOn: string;
  returnOn: string;
  mode: TravelMode;
  estimatedCost: number;
  currency: string;
  advanceNeeded: boolean;
  advanceAmount?: number;
  status: "pending" | "approved" | "rejected" | "withdrawn";
  submittedOn: string;
  /** Fixed when the request is raised; later workflow changes don't affect it. */
  steps: FlowStep[];
  currentStep: number;
  stepDecisions: FlowDecision[];
  /** Workflow version the steps came from. */
  workflowVersion?: number;
}

export type TravelInput = Pick<
  TravelRequest,
  "purpose" | "fromCity" | "toCity" | "departOn" | "returnOn" | "mode" | "estimatedCost" | "currency" | "advanceNeeded" | "advanceAmount"
>;

export interface TravelActor {
  id: string;
  fullName: string;
}

const KEY = "kastech.travel.v1";
const EMPTY: TravelRequest[] = [];
const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cached: TravelRequest[] = EMPTY;

function read(): TravelRequest[] {
  // Backend mode: requests come from the API (kept in memory).
  if (API_ENABLED) return claimsMirror.get().trips;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    raw = null;
  }
  if (raw === cachedRaw) return cached;
  cachedRaw = raw;
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    cached = Array.isArray(parsed) ? (parsed as TravelRequest[]) : EMPTY;
  } catch {
    cached = EMPTY;
  }
  return cached;
}

function write(next: TravelRequest[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    cachedRaw = undefined;
    cached = next;
  }
  listeners.forEach((fn) => fn());
}

export function subscribeTravel(fn: () => void) {
  listeners.add(fn);
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) fn();
  };
  window.addEventListener("storage", onStorage);
  const off = API_ENABLED ? claimsMirror.subscribe(fn) : undefined;
  return () => {
    listeners.delete(fn);
    window.removeEventListener("storage", onStorage);
    off?.();
  };
}

export function getTravelRequests(): TravelRequest[] {
  return read();
}

export function useTravelRequests(): TravelRequest[] {
  return useSyncExternalStore(subscribeTravel, read, read);
}

function tripText(t: Pick<TravelRequest, "fromCity" | "toCity" | "departOn">): string {
  return `${t.fromCity} → ${t.toCity} · ${t.departOn}`;
}

/** Short label for dropdowns and claim rows. */
export function tripLabel(t: TravelRequest): string {
  return `${t.purpose} · ${t.fromCity} → ${t.toCity} (${t.departOn})`;
}

function audit(actor: TravelActor, t: TravelRequest, action: "Created" | "Updated", changes: { field: string; before: string; after: string }[]) {
  appendAuditEntries([
    {
      at: new Date().toISOString(),
      actorId: actor.id,
      actorName: actor.fullName,
      entity: "Travel request",
      entityId: t.id,
      subjectId: t.employeeId,
      action,
      changes,
    },
  ]);
}

export async function submitTravel(actor: TravelActor, input: TravelInput): Promise<string | null> {
  const purpose = input.purpose.trim();
  const fromCity = input.fromCity.trim();
  const toCity = input.toCity.trim();
  if (!purpose) return "Enter the trip purpose.";
  if (!fromCity || !toCity) return "Enter the from and to cities.";
  if (fromCity.toLowerCase() === toCity.toLowerCase()) return "From and to cities must differ.";
  if (!input.departOn || !input.returnOn) return "Enter the travel dates.";
  if (input.departOn < todayISO()) return "Departure can't be in the past.";
  if (input.returnOn < input.departOn) return "Return date must be on or after departure.";
  if (!TRAVEL_MODES.includes(input.mode)) return "Choose a travel mode.";
  if (!Number.isFinite(input.estimatedCost) || input.estimatedCost <= 0) return "Enter the estimated cost.";
  if (input.advanceNeeded) {
    const advance = input.advanceAmount ?? 0;
    if (!Number.isFinite(advance) || advance <= 0) return "Enter the advance amount.";
    if (advance > input.estimatedCost) return "Advance can't be more than the estimated cost.";
  }
  const overlap = read().some(
    (t) =>
      t.employeeId === actor.id &&
      (t.status === "pending" || t.status === "approved") &&
      t.departOn <= input.returnOn &&
      input.departOn <= t.returnOn,
  );
  if (overlap) return "You already have a trip on these dates.";
  // Backend mode: the API fixes the approval steps and tells the approvers.
  if (API_ENABLED) return apiSubmitTravel({ ...input, purpose, fromCity, toCity });

  const steps = resolveFlow("travel", actor.id, { amount: input.estimatedCost });
  const today = todayISO();
  const request: TravelRequest = {
    id: uid("trv"),
    employeeId: actor.id,
    employeeName: actor.fullName,
    purpose,
    fromCity,
    toCity,
    departOn: input.departOn,
    returnOn: input.returnOn,
    mode: input.mode,
    estimatedCost: input.estimatedCost,
    currency: input.currency,
    advanceNeeded: input.advanceNeeded,
    advanceAmount: input.advanceNeeded ? input.advanceAmount : undefined,
    status: steps.length === 0 ? "approved" : "pending",
    submittedOn: today,
    steps,
    currentStep: 0,
    stepDecisions: [],
    workflowVersion: workflowVersion("travel"),
    ...(steps.length === 0
      ? { decidedById: actor.id, decidedByName: actor.fullName, decidedOn: today, decisionNote: "Approved automatically — no approver for this request" }
      : {}),
  };
  write([request, ...read()]);
  audit(actor, request, "Created", [
    { field: "Trip", before: "", after: tripText(request) },
    { field: "Estimated cost", before: "", after: money(request.estimatedCost, request.currency) },
    { field: "Status", before: "", after: request.status },
  ]);
  for (const recipientId of steps[0]?.approverIds ?? []) {
    pushPersonTaskAlert({
      recipientId,
      title: "Travel request to review",
      body: `${actor.fullName} · ${tripText(request)} · ${steps[0]!.label}`,
      href: "/travel",
    });
  }
  return null;
}

export function canDecideTravel(t: TravelRequest, myId: string, canApprove: (employeeId: string) => boolean): boolean {
  // Backend mode: the API says whose step it is.
  if (API_ENABLED) return t.status === "pending" && claimsMirror.get().toDecide.has(t.id);
  return isWaitingOn(t, myId, canApprove);
}

export async function decideTravel(
  actor: TravelActor,
  id: string,
  decision: "approved" | "rejected",
  note: string | undefined,
  canApprove: (employeeId: string) => boolean,
): Promise<string | null> {
  const all = read();
  const t = all.find((item) => item.id === id);
  if (!t) return "Travel request not found.";
  if (t.employeeId === actor.id) return "You cannot decide your own request.";
  if (t.status !== "pending") return "This request has already been decided.";
  if (API_ENABLED) {
    if (!canDecideTravel(t, actor.id, canApprove)) return "This request isn't waiting on you.";
    return apiDecideTravel(id, decision === "approved" ? "approve" : "reject", note);
  }
  const today = todayISO();
  const cleanNote = note?.trim() || undefined;
  const result = decideFlowStep(t, actor, decision, cleanNote, canApprove, today);
  if (typeof result === "string") return result;
  const { step, outcome } = result;
  const stepDecisions = [...t.stepDecisions, ...result.entries];
  const updated: TravelRequest =
    outcome === "waiting" || outcome === "advanced"
      ? { ...t, stepDecisions, currentStep: result.currentStep, steps: result.steps }
      : {
          ...t,
          stepDecisions,
          status: decision,
          decidedById: actor.id,
          decidedByName: actor.fullName,
          decidedOn: today,
          decisionNote: cleanNote,
        };
  write(all.map((item) => (item.id === id ? updated : item)));
  audit(actor, updated, "Updated", [
    ...result.entries.map((e) => ({ field: e.label, before: "pending", after: decision })),
    ...(updated.status !== t.status ? [{ field: "Status", before: t.status, after: updated.status }] : []),
  ]);
  if (outcome === "waiting") return null;
  const next = result.next;
  if (next) {
    for (const recipientId of waitingApproverIds(updated)) {
      pushPersonTaskAlert({
        recipientId,
        title: "Travel request to review",
        body: `${t.employeeName} · ${tripText(t)} · ${next.label}`,
        href: "/travel",
      });
    }
    pushPersonTaskAlert({
      recipientId: t.employeeId,
      title: "Travel request moved on",
      body: `${step.label} done by ${actor.fullName}. Now with ${next.label.toLowerCase()}.`,
      href: "/travel",
    });
  } else {
    pushPersonTaskAlert({
      recipientId: t.employeeId,
      title: decision === "approved" ? "Travel request approved" : "Travel request declined",
      body: `${tripText(t)} · by ${actor.fullName}${cleanNote ? ` · “${cleanNote}”` : ""}`,
      href: "/travel",
    });
  }
  return null;
}

export async function withdrawTravel(actor: TravelActor, id: string): Promise<string | null> {
  const all = read();
  const t = all.find((item) => item.id === id);
  if (!t) return "Travel request not found.";
  if (t.employeeId !== actor.id) return "Only the person who raised this request can withdraw it.";
  if (t.status !== "pending") return "Only open requests can be withdrawn.";
  if (API_ENABLED) return apiWithdrawTravel(id);
  const updated: TravelRequest = { ...t, status: "withdrawn" };
  write(all.map((item) => (item.id === id ? updated : item)));
  audit(actor, updated, "Updated", [{ field: "Status", before: "pending", after: "withdrawn" }]);
  return null;
}

/** Approved trips this person can file claims against. */
export function approvedTripsFor(employeeId: string): TravelRequest[] {
  return read().filter((t) => t.employeeId === employeeId && t.status === "approved");
}
