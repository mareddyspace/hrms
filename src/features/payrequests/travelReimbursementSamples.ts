/**
 * Sample travel reimbursement history for local (offline) mode, shown until the person files their own trip-linked
 * claims. Mirrors backend/app/seed_reimbursements.py: one past trip, four claims (paid, approved, pending, declined).
 */
import { addDaysISO, todayISO } from "../../model.ts";

export interface TravelClaimRow {
  id: string;
  date: string;
  submittedOn?: string;
  category: string;
  description: string;
  amount: number;
  currency: string;
  status: "submitted" | "approved" | "rejected" | "withdrawn" | "paid";
  tripId: string;
  tripLabel: string;
  tripDates: string;
  approver: string;
  decisionNote?: string;
  paidOn?: string;
  paymentRef?: string;
  receipts: number;
  sample?: boolean;
}

const AMOUNTS: Record<string, { fare: number; hotel: number; meals: number; cab: number }> = {
  INR: { fare: 8640, hotel: 7350, meals: 1860, cab: 1240 },
  GBP: { fare: 148.6, hotel: 236, meals: 54.2, cab: 38.5 },
  USD: { fare: 412.8, hotel: 538, meals: 96.4, cab: 64 },
};
const ROUTES: Record<string, [string, string, string]> = {
  INR: ["Kochi", "Bengaluru", "Client integration sprint"],
  GBP: ["London", "Edinburgh", "Data centre migration review"],
  USD: ["New York", "Boston", "Customer workshop"],
};

export function sampleTravelClaims(currency: string, managerName: string, today = todayISO()): TravelClaimRow[] {
  const amounts = AMOUNTS[currency] ?? AMOUNTS.USD;
  const [from, to, purpose] = ROUTES[currency] ?? ROUTES.USD;
  const start = addDaysISO(today, -24);
  const end = addDaysISO(start, 3);
  const trip = { tripId: "sample-trip", tripLabel: `${purpose} · ${from} → ${to}`, tripDates: `${start} to ${end}` };
  const approver = managerName || "Your manager";
  const row = (id: string, day: number, category: string, description: string, amount: number, status: TravelClaimRow["status"]): TravelClaimRow => ({
    id: `sample-${id}`,
    date: addDaysISO(start, day),
    submittedOn: addDaysISO(end, 1),
    category,
    description: `${description}: ${from} to ${to}`,
    amount,
    currency,
    status,
    ...trip,
    approver: status === "submitted" ? `Waiting on ${approver}` : approver,
    receipts: 1,
    sample: true,
  });
  return [
    { ...row("fare", 0, "Travel", "Return fare for the trip", amounts.fare, "paid"), paidOn: addDaysISO(end, 9), paymentRef: "TRV-SAMPLE-01" },
    { ...row("hotel", 2, "Accommodation", "Hotel, three nights", amounts.hotel, "approved"), decisionNote: "Matches the trip and receipts." },
    row("meals", 1, "Food", "Meals while travelling", amounts.meals, "submitted"),
    { ...row("cab", 1, "Transportation", "Local cabs between the hotel and the office", amounts.cab, "rejected"), decisionNote: "Covered by the per diem; not claimable separately." },
  ];
}
