/**
 * Helpdesk extras: subcategories per category (same as backend/app/services/desk.py SUBCATEGORIES), the FAQ list
 * with categories, policy shortcuts and "Helpful / Not helpful" votes (backend: /desk/faq-votes; local: this browser).
 */
import { useSyncExternalStore } from "react";
import { API_ENABLED, api } from "../api/client.ts";
import { createApiMirror, errorText } from "../api/syncOps.ts";
import { FAQ_ITEMS, type FaqItem, type HrRequestCategory } from "./collabData.ts";

export const HR_REQUEST_SUBCATEGORIES: Record<HrRequestCategory, string[]> = {
  "Payroll provider": ["Payslip query", "Salary not credited", "Tax / deductions", "Bank details", "Reimbursement"],
  Benefits: ["Health insurance", "Retirement / pension", "Wellness", "Enrolment change"],
  Documents: ["Employment letter", "Salary certificate", "Experience letter", "Visa / travel letter"],
  "IT access": ["New system access", "Password / sign-in", "Laptop / hardware", "VPN / network", "Software install"],
  Leave: ["Leave balance", "Leave policy", "Holiday calendar", "Long leave / sabbatical"],
  "Profile correction": ["Name / personal details", "Bank details", "Emergency contact", "Job details"],
  Other: ["General question", "Feedback", "Workplace concern"],
};

export const CONTACT_PREFERENCES = [
  { id: "email", label: "Email" },
  { id: "phone", label: "Phone" },
  { id: "chat", label: "Chat" },
] as const;
export type ContactPreference = (typeof CONTACT_PREFERENCES)[number]["id"];

const MORE_FAQ: FaqItem[] = [
  { id: "faq-pay-1", topic: "Payroll", question: "When is salary credited?", answer: "On the last working day of the month. If it falls on a bank holiday, the working day before.", policyLink: "/payslips" },
  { id: "faq-pay-2", topic: "Payroll", question: "How do I change my bank account?", answer: "Raise a Profile correction request (Bank details) with a cancelled cheque or bank letter. Changes after the 20th apply next month." },
  { id: "faq-leave-2", topic: "Leave", question: "Can I carry forward unused leave?", answer: "Up to the limit in your country's leave policy. Carried days show in your balance from 1 January.", policyLink: "/policies" },
  { id: "faq-leave-3", topic: "Leave", question: "How do I apply for work from home?", answer: "Leave > Apply > Work from home. Your manager approves it like leave.", policyLink: "/leave" },
  { id: "faq-it-1", topic: "IT", question: "I'm locked out of my account. What now?", answer: "Use Forgot password on the sign-in page. If two-step sign-in fails, raise an IT access request (Password / sign-in) from a colleague's device or call the IT desk." },
  { id: "faq-it-2", topic: "IT", question: "How do I get access to a new system?", answer: "Raise an IT access request (New system access) with the system name and your manager's approval in the description." },
  { id: "faq-ben-2", topic: "Benefits", question: "How do I add a dependant to health insurance?", answer: "Within 30 days of the life event, raise a Benefits request (Health insurance) with the certificate attached.", policyLink: "/benefits" },
  { id: "faq-doc-2", topic: "Documents", question: "How long does an employment letter take?", answer: "Usually two working days. Signed letters appear under Documents > Letters.", policyLink: "/documents" },
  { id: "faq-travel-1", topic: "Travel & expenses", question: "How soon must I submit expense claims?", answer: "Within 30 days of the expense, with receipts.", policyLink: "/expenses" },
];

export const HELP_FAQ: FaqItem[] = [...FAQ_ITEMS, ...MORE_FAQ];

export const POLICY_SHORTCUTS: { label: string; topic: string; to: string }[] = [
  { label: "Leave policy", topic: "Leave", to: "/policies" },
  { label: "Holiday calendar", topic: "Leave", to: "/holidays" },
  { label: "Working time & attendance", topic: "Attendance", to: "/policies" },
  { label: "Travel & expense policy", topic: "Travel & expenses", to: "/policies" },
  { label: "Benefits", topic: "Benefits", to: "/benefits" },
  { label: "Pay & tax", topic: "Payroll", to: "/payslips" },
  { label: "Code of conduct", topic: "Conduct", to: "/policies" },
  { label: "Data privacy & security", topic: "IT", to: "/policies" },
];

/* ───────── FAQ votes ───────── */

export interface FaqVote {
  helpful: number;
  notHelpful: number;
  /** My vote: true helpful, false not helpful, undefined none. */
  mine?: boolean;
}

const LOCAL_KEY = "timez.helpdesk.faqVotes.v1";
type LocalVotes = Record<string, Record<string, boolean>>; // faq id -> person id -> helpful
const localListeners = new Set<() => void>();
let localCache: LocalVotes | null = null;

function readLocal(): LocalVotes {
  if (localCache) return localCache;
  try {
    localCache = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "{}") as LocalVotes;
  } catch {
    localCache = {};
  }
  return localCache;
}

const mirror = createApiMirror<Record<string, FaqVote>>(
  () => ({}),
  async () => {
    const out = await api.get<Record<string, { helpful: number; not_helpful: number; mine: boolean | null }>>("/desk/faq-votes");
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { helpful: v.helpful, notHelpful: v.not_helpful, mine: v.mine ?? undefined }]));
  },
);

const subscribe = (fn: () => void) => {
  if (API_ENABLED) return mirror.subscribe(fn);
  localListeners.add(fn);
  return () => {
    localListeners.delete(fn);
  };
};
const snapshot = () => (API_ENABLED ? mirror.get() : readLocal());

/** Vote counts per FAQ id for this person. */
export function useFaqVotes(userId: string): Record<string, FaqVote> {
  const snap = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (API_ENABLED) return snap as Record<string, FaqVote>;
  const local = snap as LocalVotes;
  return Object.fromEntries(
    Object.entries(local).map(([id, byPerson]) => {
      const values = Object.values(byPerson);
      return [id, { helpful: values.filter(Boolean).length, notHelpful: values.filter((v) => !v).length, mine: byPerson[userId] }];
    }),
  );
}

export async function voteFaq(faqId: string, helpful: boolean, userId: string): Promise<string | null> {
  if (API_ENABLED) {
    try {
      const v = await api.post<{ helpful: number; not_helpful: number; mine: boolean | null }>(`/desk/faq/${encodeURIComponent(faqId)}/vote`, { helpful });
      mirror.set({ ...mirror.get(), [faqId]: { helpful: v.helpful, notHelpful: v.not_helpful, mine: v.mine ?? undefined } });
      return null;
    } catch (e) {
      return errorText(e);
    }
  }
  const next = { ...readLocal(), [faqId]: { ...(readLocal()[faqId] ?? {}), [userId]: helpful } };
  localCache = next;
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(next));
  } catch {
    /* keep in memory */
  }
  localListeners.forEach((fn) => fn());
  return null;
}
