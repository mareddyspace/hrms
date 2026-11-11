/**
 * Who gets which holiday (same rules as backend/app/services/holiday_rules.py, migration 0032).
 *
 * - type: national | regional | company | optional. Untyped rows (older saved data) are classified like the server's
 *   sample data, else treated as national.
 * - regions: states / cities; empty = the whole country. A person matches by work location or that location's state.
 * - legalEntity: only that entity's people.
 * Optional holidays are never days off by themselves: people pick them as leave (type "optional").
 */
import type { Holiday, HolidayType } from "../model.ts";

export const HOLIDAY_TYPES: HolidayType[] = ["national", "regional", "company", "optional"];
export const HOLIDAY_TYPE_LABEL: Record<HolidayType, string> = {
  national: "National",
  regional: "Regional",
  company: "Company",
  optional: "Optional",
};

/** Work location (city) -> state / province. */
export const CITY_REGION: Record<string, string> = {
  bengaluru: "Karnataka",
  bangalore: "Karnataka",
  mysuru: "Karnataka",
  hyderabad: "Telangana",
  mumbai: "Maharashtra",
  pune: "Maharashtra",
  chennai: "Tamil Nadu",
  coimbatore: "Tamil Nadu",
  kochi: "Kerala",
  thiruvananthapuram: "Kerala",
  "new delhi": "Delhi",
  delhi: "Delhi",
  gurugram: "Haryana",
  noida: "Uttar Pradesh",
  kolkata: "West Bengal",
  ahmedabad: "Gujarat",
  "new york": "New York",
  "san francisco": "California",
  austin: "Texas",
  london: "England",
  manchester: "England",
  edinburgh: "Scotland",
  sydney: "New South Wales",
  melbourne: "Victoria",
  toronto: "Ontario",
  vancouver: "British Columbia",
  montreal: "Quebec",
  dubai: "Dubai",
  "abu dhabi": "Abu Dhabi",
  riyadh: "Riyadh",
  jeddah: "Makkah",
  berlin: "Berlin",
  munich: "Bavaria",
  frankfurt: "Hesse",
};

/** Offices per country (the sample directory's work locations), for the location filter. */
export const OFFICES: Record<string, string[]> = {
  IN: ["Bengaluru", "Hyderabad", "Mumbai", "Chennai", "Kochi"],
  US: ["Austin", "New York", "San Francisco"],
  GB: ["London", "Manchester"],
  AU: ["Melbourne", "Sydney"],
  CA: ["Toronto", "Vancouver"],
  AE: ["Abu Dhabi", "Dubai"],
  SA: ["Jeddah", "Riyadh"],
  DE: ["Berlin", "Frankfurt", "Munich"],
};

/** States / regions that offices sit in, per country (for the regional holiday editor). */
export function regionsOf(country: string): string[] {
  const out = new Set<string>();
  for (const city of OFFICES[country] ?? []) {
    const region = regionOf(city);
    if (region) out.add(region);
  }
  return [...out].sort();
}

export function regionOf(location: string | undefined): string | undefined {
  return CITY_REGION[(location ?? "").trim().toLowerCase()];
}

const IN_STATES: [string, string[]][] = [
  ["sankranti", ["Karnataka", "Telangana", "Tamil Nadu"]],
  ["pongal", ["Karnataka", "Telangana", "Tamil Nadu"]],
  ["ugadi", ["Karnataka", "Telangana", "Maharashtra"]],
  ["may day", ["Karnataka", "Maharashtra"]],
  ["ganesh", ["Maharashtra", "Telangana"]],
  ["onam", ["Kerala"]],
];
const NAME_RULES: Record<string, [string, HolidayType][]> = {
  IN: [
    ["republic day", "national"],
    ["independence day", "national"],
    ["gandhi jayanti", "national"],
    ["new year", "company"],
    ["dussehra", "company"],
    ["diwali", "company"],
    ["christmas", "company"],
    ["founders", "company"],
    ["sankranti", "regional"],
    ["ugadi", "regional"],
    ["may day", "regional"],
    ["ganesh", "regional"],
    ["onam", "regional"],
    ["", "optional"],
  ],
  US: [["day after thanksgiving", "company"]],
  CA: [
    ["family day", "regional"],
    ["civic holiday", "regional"],
  ],
  AU: [
    ["labour day", "regional"],
    ["melbourne cup", "regional"],
  ],
  DE: [
    ["fronleichnam", "regional"],
    ["heilige drei", "regional"],
  ],
};
const OTHER_REGIONS: Record<string, [string, string[]][]> = {
  CA: [
    ["family day", ["Ontario", "British Columbia"]],
    ["civic holiday", ["Ontario", "British Columbia"]],
  ],
  AU: [
    ["labour day (victoria)", ["Victoria"]],
    ["labour day", ["New South Wales"]],
    ["melbourne cup", ["Victoria"]],
  ],
  DE: [
    ["fronleichnam", ["Bavaria", "Hesse"]],
    ["heilige drei", ["Bavaria"]],
  ],
};
const ADMIN_ID = /^h-[a-z]{2}-[0-9a-z]{6,12}$/; // added by HR on this screen (typed when saved)

/** Type and regions for a sample holiday saved before holidays had types. */
export function classify(h: Pick<Holiday, "id" | "name" | "countryCode">): { type: HolidayType; regions?: string[] } {
  const country = h.countryCode ?? "IN";
  const low = h.name.toLowerCase();
  if (!h.id.startsWith("h-") || (ADMIN_ID.test(h.id) && !/^h-[a-z]{2}-\d{2}-\d{2}$/.test(h.id))) return { type: "national" };
  for (const [fragment, type] of NAME_RULES[country] ?? []) {
    if (!low.includes(fragment)) continue;
    if (type !== "regional") return { type };
    const pool = country === "IN" ? IN_STATES : (OTHER_REGIONS[country] ?? []);
    const regions = pool.find(([k]) => low.includes(k))?.[1];
    return regions ? { type, regions } : { type: "national" };
  }
  return { type: "national" };
}

export function holidayKind(h: Holiday): HolidayType {
  return h.holidayType ?? classify(h).type;
}

export function holidayRegions(h: Holiday): string[] {
  if (h.regions?.length) return h.regions;
  if (h.holidayType) return [];
  return classify(h).regions ?? [];
}

export interface Place {
  location?: string;
  legalEntity?: string;
  calendar?: string;
}

const norm = (s: string | undefined) => (s ?? "").trim().toLowerCase();

/** Whether a holiday is a day off for someone at `place` (no location: only whole-country holidays). */
export function appliesAt(h: Holiday, place: Place, includeOptional = false): boolean {
  if (holidayKind(h) === "optional" && !includeOptional) return false;
  if (h.legalEntity && place.legalEntity && norm(h.legalEntity) !== norm(place.legalEntity)) return false;
  const regions = holidayRegions(h);
  if (!regions.length) return true;
  const mine = new Set([norm(place.location), norm(regionOf(place.location))].filter(Boolean));
  return regions.some((r) => mine.has(norm(r)));
}

/** "Karnataka, Telangana" or "Whole country". */
export function appliesText(h: Holiday): string {
  const regions = holidayRegions(h);
  const parts = [regions.length ? regions.join(", ") : "Whole country"];
  if (h.legalEntity) parts.push(h.legalEntity);
  return parts.join(" · ");
}
