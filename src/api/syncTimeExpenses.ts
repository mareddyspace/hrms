/**
 * Expense claims (with receipts and their approval steps) and travel requests from the API, in the portal's
 * Expense / TravelRequest shapes. Backend mode only.
 */
import type { Expense, ExpenseReceipt } from "../model.ts";
import type { TravelInput, TravelMode, TravelRequest } from "../data/travelStore.ts";
import { api } from "./client.ts";
import {
  createMirror,
  downloadBlob,
  loadInstances,
  mutate,
  nameOf,
  stepsFromInstance,
  uploadRaw,
  utcIso,
  type ApprovalInstanceOut,
} from "./syncShared.ts";

export interface ReceiptOut {
  id: string;
  claim_id: string | null;
  file_name: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
}

export interface ExpenseClaimOut {
  id: string;
  employee_id: string;
  employee_name: string | null;
  category: string;
  amount: number;
  currency: string;
  date: string;
  description: string;
  trip_id: string | null;
  status: "submitted" | "approved" | "rejected" | "withdrawn" | "paid" | string;
  approval_instance_id: string | null;
  approval_status: string | null;
  current_step: number | null;
  paid_on: string | null;
  payment_reference: string | null;
  paid_by: string | null;
  created_at: string;
  receipts: ReceiptOut[];
}

export interface TravelRequestOut {
  id: string;
  employee_id: string;
  employee_name: string | null;
  purpose: string;
  from_location: string;
  to_location: string;
  start_date: string;
  end_date: string;
  mode: "air" | "rail" | "road" | "sea" | "other" | string;
  estimated_cost: number;
  currency: string;
  advance_amount: number;
  status: "submitted" | "approved" | "rejected" | "withdrawn" | string;
  approval_instance_id: string | null;
  approval_status: string | null;
  current_step: number | null;
  created_at: string;
}

export interface ExpenseRulesOut {
  country_code: string;
  currency: string;
  max_claim: number;
  receipt_required_over: number;
  max_cash_advance: number;
  claim_window_days: number;
  finance_threshold: number;
  categories: string[];
  max_receipt_bytes: number;
  receipt_types: string[];
}

/** Decision fields for a finished request, from the instance's last decision. */
function decisionOf(status: string, instance: ApprovalInstanceOut | undefined) {
  const last = instance?.decisions[instance.decisions.length - 1];
  if (!last || (status !== "approved" && status !== "rejected" && status !== "paid")) return {};
  return {
    decidedById: last.approver_id,
    decidedByName: nameOf(last.approver_id),
    decidedOn: utcIso(last.at).slice(0, 10),
    ...(last.note ? { decisionNote: last.note } : {}),
  };
}

function toReceipt(r: ReceiptOut): ExpenseReceipt {
  return { id: r.id, name: r.file_name, type: r.content_type, size: r.size_bytes };
}

function toExpense(c: ExpenseClaimOut, instance: ApprovalInstanceOut | undefined): Expense {
  const flow = instance ? stepsFromInstance(instance) : undefined;
  const status: Expense["status"] = (["submitted", "approved", "rejected", "withdrawn", "paid"] as const).includes(c.status as Expense["status"])
    ? (c.status as Expense["status"])
    : "submitted";
  return {
    id: c.id,
    employeeId: c.employee_id,
    date: c.date,
    category: c.category,
    amount: c.amount,
    currency: c.currency,
    description: c.description,
    projectId: "",
    status,
    submittedOn: utcIso(c.created_at).slice(0, 10),
    ...(flow ? { steps: flow.steps, currentStep: flow.currentStep, stepDecisions: flow.stepDecisions } : {}),
    ...(c.receipts[0] ? { receipt: toReceipt(c.receipts[0]) } : {}),
    ...(c.trip_id ? { tripId: c.trip_id } : {}),
    ...(c.paid_on ? { paidOn: c.paid_on, paymentRef: c.payment_reference ?? "", paidById: c.paid_by ?? "", paidByName: nameOf(c.paid_by) } : {}),
    ...decisionOf(c.status, instance),
  };
}

const TO_MODE: Record<string, TravelMode> = { air: "Flight", rail: "Train", road: "Car", sea: "Other", other: "Other" };
const FROM_MODE: Record<TravelMode, string> = { Flight: "air", Train: "rail", Bus: "road", Car: "road", Other: "other" };

function toTrip(t: TravelRequestOut, instance: ApprovalInstanceOut | undefined): TravelRequest {
  const flow = instance ? stepsFromInstance(instance) : { steps: [], currentStep: 0, stepDecisions: [] };
  const status: TravelRequest["status"] =
    t.status === "submitted" ? "pending" : t.status === "approved" || t.status === "rejected" ? t.status : "withdrawn";
  return {
    id: t.id,
    employeeId: t.employee_id,
    employeeName: t.employee_name ?? nameOf(t.employee_id),
    purpose: t.purpose,
    fromCity: t.from_location,
    toCity: t.to_location,
    departOn: t.start_date,
    returnOn: t.end_date,
    mode: TO_MODE[t.mode] ?? "Other",
    estimatedCost: t.estimated_cost,
    currency: t.currency,
    advanceNeeded: t.advance_amount > 0,
    ...(t.advance_amount > 0 ? { advanceAmount: t.advance_amount } : {}),
    status,
    submittedOn: utcIso(t.created_at).slice(0, 10),
    steps: flow.steps,
    currentStep: flow.currentStep,
    stepDecisions: flow.stepDecisions,
    ...decisionOf(t.status, instance),
  };
}

interface RawClaims {
  expenses: ExpenseClaimOut[];
  trips: TravelRequestOut[];
  /** Claim and trip ids whose open step waits on this user. */
  toDecide: string[];
  instances: Map<string, ApprovalInstanceOut>;
}

export interface ApiClaimsState {
  expenses: Expense[];
  trips: TravelRequest[];
  toDecide: Set<string>;
  /** Approval instance id of each claim / trip. */
  instanceOf: Map<string, string>;
}

const emptyClaims = (): ApiClaimsState => ({ expenses: [], trips: [], toDecide: new Set(), instanceOf: new Map() });

function merge<T extends { id: string; created_at: string }>(...lists: T[][]): T[] {
  const byId = new Map<string, T>();
  for (const list of lists) for (const item of list) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

async function loadClaims(): Promise<RawClaims> {
  const [mineX, allX, decideX, mineT, allT, decideT] = await Promise.all([
    api.get<ExpenseClaimOut[]>("/expenses", { view: "mine", limit: 200 }),
    // Everyone in the user's scope (Finance and admin: every claim, for the payment queue).
    api.get<ExpenseClaimOut[]>("/expenses", { view: "all", limit: 200 }),
    api.get<ExpenseClaimOut[]>("/expenses", { view: "to_decide", limit: 200 }),
    api.get<TravelRequestOut[]>("/travel", { view: "mine", limit: 200 }),
    api.get<TravelRequestOut[]>("/travel", { view: "all", limit: 200 }),
    api.get<TravelRequestOut[]>("/travel", { view: "to_decide", limit: 200 }),
  ]);
  const expenses = merge(mineX, allX, decideX);
  const trips = merge(mineT, allT, decideT);
  const instances = await loadInstances([...expenses, ...trips].map((x) => x.approval_instance_id));
  return { expenses, trips, toDecide: [...decideX, ...decideT].map((x) => x.id), instances };
}

export const claimsMirror = createMirror<RawClaims, ApiClaimsState>(emptyClaims, loadClaims, (raw) => {
  const instanceOf = new Map<string, string>();
  for (const x of [...raw.expenses, ...raw.trips]) if (x.approval_instance_id) instanceOf.set(x.id, x.approval_instance_id);
  return {
    expenses: raw.expenses.map((c) => toExpense(c, raw.instances.get(c.approval_instance_id ?? ""))),
    trips: raw.trips.map((t) => toTrip(t, raw.instances.get(t.approval_instance_id ?? ""))),
    toDecide: new Set(raw.toDecide),
    instanceOf,
  };
});

/* ───────── Expense changes ───────── */

export function apiAddExpense(input: { date: string; category: string; amount: number; description: string; tripId?: string; receiptId?: string }) {
  return mutate(
    () =>
      api.post<ExpenseClaimOut>("/expenses", {
        category: input.category,
        amount: input.amount,
        currency: null,
        date: input.date,
        description: input.description.trim(),
        trip_id: input.tripId || null,
        receipt_ids: input.receiptId ? [input.receiptId] : [],
      }),
    claimsMirror,
  );
}

export function apiDecideExpense(id: string, decision: "approve" | "reject", note?: string) {
  const text = note?.trim() || (decision === "reject" ? "Declined." : "");
  return mutate(() => api.post<ExpenseClaimOut>(`/expenses/${encodeURIComponent(id)}/decision`, { decision, note: text || null }), claimsMirror);
}

export function apiWithdrawExpense(id: string) {
  return mutate(() => api.post<ExpenseClaimOut>(`/expenses/${encodeURIComponent(id)}/withdraw`), claimsMirror);
}

export function apiPayExpense(id: string, paidOn: string, reference: string) {
  return mutate(
    () => api.post<ExpenseClaimOut>(`/expenses/${encodeURIComponent(id)}/pay`, { paid_on: paidOn, payment_reference: reference.trim() }),
    claimsMirror,
  );
}

/** Uploads a receipt before the claim is filed (raw body, its own Content-Type, ?filename=). */
export async function apiUploadReceipt(file: File): Promise<ExpenseReceipt> {
  const out = await uploadRaw<ReceiptOut>("/expenses/receipts", file, file.type || "application/octet-stream", file.name);
  return toReceipt(out);
}

export function apiReceiptBlob(receiptId: string): Promise<Blob> {
  return downloadBlob(`/expenses/receipts/${encodeURIComponent(receiptId)}`);
}

export function loadExpenseRules(): Promise<ExpenseRulesOut> {
  return api.get<ExpenseRulesOut>("/expenses/rules");
}

/* ───────── Travel changes ───────── */

export function apiSubmitTravel(input: TravelInput) {
  return mutate(
    () =>
      api.post<TravelRequestOut>("/travel", {
        purpose: input.purpose.trim(),
        from_location: input.fromCity.trim(),
        to_location: input.toCity.trim(),
        start_date: input.departOn,
        end_date: input.returnOn,
        mode: FROM_MODE[input.mode] ?? "other",
        estimated_cost: input.estimatedCost,
        currency: /^[A-Z]{3}$/.test(input.currency) ? input.currency : null,
        advance_amount: input.advanceNeeded ? (input.advanceAmount ?? 0) : 0,
      }),
    claimsMirror,
  );
}

export function apiDecideTravel(id: string, decision: "approve" | "reject", note?: string) {
  const text = note?.trim() || (decision === "reject" ? "Declined." : "");
  return mutate(() => api.post<TravelRequestOut>(`/travel/${encodeURIComponent(id)}/decision`, { decision, note: text || null }), claimsMirror);
}

export function apiWithdrawTravel(id: string) {
  return mutate(() => api.post<TravelRequestOut>(`/travel/${encodeURIComponent(id)}/withdraw`), claimsMirror);
}
