/**
 * Claim categories on the reimbursement form: the extra fields each one asks for, and the policy text shown with it.
 * The money rules come from the configured country limits (src/countryPay.ts CLAIM_LIMITS, backend
 * app/services/expenses.py): the per-claim maximum, the receipt threshold and the 90-day claim window. No other limit
 * is applied here, so nothing on this page is invented.
 */
export interface CategoryField {
  key: string;
  label: string;
  required?: boolean;
  type?: "text" | "number" | "date";
  placeholder?: string;
}

export interface ClaimCategory {
  name: string;
  fields: CategoryField[];
  /** What the claim needs, in addition to the country limits. */
  guidance: string;
  /** Suggests linking an approved trip. */
  tripRelated?: boolean;
}

export const CLAIM_CATEGORIES: ClaimCategory[] = [
  {
    name: "Travel",
    tripRelated: true,
    fields: [
      { key: "from", label: "From", required: true, placeholder: "City" },
      { key: "to", label: "To", required: true, placeholder: "City" },
      { key: "carrier", label: "Airline / rail / bus operator", placeholder: "e.g. IndiGo" },
      { key: "ticket", label: "Ticket / PNR number" },
    ],
    guidance: "Tickets and fares for business trips. Link the approved trip when there is one.",
  },
  {
    name: "Food",
    fields: [
      { key: "merchant", label: "Restaurant / merchant", required: true },
      { key: "attendees", label: "People attending", type: "number", placeholder: "1" },
    ],
    guidance: "Meals while travelling or with clients. Name the people attending for a group meal.",
  },
  {
    name: "Accommodation",
    tripRelated: true,
    fields: [
      { key: "hotel", label: "Hotel / property", required: true },
      { key: "check_in", label: "Check-in", type: "date", required: true },
      { key: "check_out", label: "Check-out", type: "date", required: true },
    ],
    guidance: "Hotel stays on business trips. The invoice should show the dates and the room charge.",
  },
  {
    name: "Transportation",
    tripRelated: true,
    fields: [
      { key: "mode", label: "Mode", required: true, placeholder: "Taxi, metro, fuel…" },
      { key: "route", label: "Route", placeholder: "From → to" },
      { key: "distance_km", label: "Distance (km)", type: "number" },
    ],
    guidance: "Local travel for work: taxis, public transport, parking and fuel.",
  },
  {
    name: "Internet",
    fields: [
      { key: "provider", label: "Provider", required: true },
      { key: "billing_period", label: "Billing period", required: true, placeholder: "e.g. Oct 2026" },
    ],
    guidance: "Home or mobile internet used for work. Attach the bill for the billing period.",
  },
  {
    name: "Medical",
    fields: [
      { key: "provider", label: "Hospital / pharmacy", required: true },
      { key: "patient", label: "Patient", placeholder: "Self or dependent" },
    ],
    guidance: "Medical costs covered for reimbursement. Attach the bill or prescription.",
  },
  { name: "Supplies", fields: [{ key: "items", label: "Items", required: true }], guidance: "Office or work supplies bought for the job." },
  { name: "Other", fields: [], guidance: "Anything else work related. Explain it in the description." },
];

export const CLAIM_CATEGORY_NAMES = CLAIM_CATEGORIES.map((c) => c.name);

export function categoryOf(name: string): ClaimCategory {
  return CLAIM_CATEGORIES.find((c) => c.name === name) ?? { name, fields: [], guidance: "" };
}

/** Required category fields that are empty, plus date order for stays. */
export function detailsProblem(category: string, details: Record<string, string>): string | null {
  const c = categoryOf(category);
  const missing = c.fields.filter((f) => f.required && !details[f.key]?.trim());
  if (missing.length) return `Fill in ${missing.map((f) => f.label.toLowerCase()).join(", ")}.`;
  if (details.check_in && details.check_out && details.check_out < details.check_in) return "Check-out can't be before check-in.";
  for (const f of c.fields) if (f.type === "number" && details[f.key] && !(Number(details[f.key]) >= 0)) return `${f.label} must be a number.`;
  return null;
}

/** Only this category's fields, trimmed, empty ones dropped. */
export function cleanDetails(category: string, details: Record<string, string>): Record<string, string> {
  const keys = new Set(categoryOf(category).fields.map((f) => f.key));
  return Object.fromEntries(Object.entries(details).filter(([k, v]) => keys.has(k) && v.trim()).map(([k, v]) => [k, v.trim()]));
}

export function detailLabel(category: string, key: string): string {
  return categoryOf(category).fields.find((f) => f.key === key)?.label ?? key.replace(/_/g, " ");
}
