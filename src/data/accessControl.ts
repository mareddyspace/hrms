import { useSyncExternalStore } from "react";
import {
  DEMO_ACCOUNTS,
  PAGE_ACCESS_KEY,
  accountDefaultNavAccess,
  accountHasNavAccess,
  getPageAccessOverrides,
  setPageAccessOverrides,
  type DemoAccount,
  type PageAccessOverride,
} from "../demoAccounts.ts";
import { TIMEZ_COUNTRIES, type CountryCode } from "../model.ts";
import { localeLinks, navGroups, pinnedNavLinks } from "../nav.ts";
import { appendAuditEntries } from "./auditTrail.ts";
import { allReportIds, directReportIds, listPeople } from "./peopleLocal.ts";
import { API_ENABLED, apiRun, createApiMirror } from "../api/syncOps.ts";
import { apiPutDataScope, apiPutPageAccess, apiResetPageAccess, loadApiAccess, type ApiAccessData } from "../api/syncOpsAdmin.ts";

/* —— Data scope —— */

export type DataScope = "own" | "direct" | "line" | "department" | "country" | "entity" | "business_unit" | "location" | "global";

export const DATA_SCOPES: { id: DataScope; label: string; hint: string }[] = [
  { id: "own", label: "Own", hint: "Only their own record" },
  { id: "direct", label: "Direct reports", hint: "Self and direct reports" },
  { id: "line", label: "Whole reporting line", hint: "Everyone below them" },
  { id: "department", label: "Department", hint: "Their department" },
  { id: "country", label: "Country", hint: "Their country" },
  { id: "entity", label: "Legal entity", hint: "Their legal entity" },
  { id: "business_unit", label: "Business unit", hint: "Their business unit" },
  { id: "location", label: "Location", hint: "Their work location" },
  { id: "global", label: "Global", hint: "Everyone" },
];

export type DataScopeSetting = {
  scope: DataScope;
  /** HR only: limit to these countries. Empty = no country limit. */
  countries: CountryCode[];
};

const SCOPE_KEY = "timez.access.scopes.v1";
const COUNTRY_CODES = new Set<string>(TIMEZ_COUNTRIES.map((c) => c.code));
const SCOPE_IDS = new Set<string>(DATA_SCOPES.map((s) => s.id));

const listeners = new Set<() => void>();
let version = 0;
let scopeCache: Record<string, DataScopeSetting> | null = null;

function notify() {
  version += 1;
  listeners.forEach((fn) => fn());
}

export function subscribeAccess(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAccessVersion() {
  return version;
}

/** Re-renders when page access or data scope changes. */
export function useAccessVersion(): number {
  return useSyncExternalStore(subscribeAccess, getAccessVersion, getAccessVersion);
}

function isHrRole(role: string): boolean {
  return role === "hr" || role === "hr_admin" || role === "hrbp";
}

/* —— Backend mode (VITE_API_URL): data scope and page access live on the server —— */

const accessMirror = createApiMirror<ApiAccessData | null>(() => null, loadApiAccess);

function apiAccessAccount(accountId: string) {
  return accessMirror.get()?.accounts.find((a) => a.account_id === accountId);
}

if (API_ENABLED) {
  // The server's page edits replace this browser's copy, so the menu and route guards follow them.
  accessMirror.subscribe(() => {
    const data = accessMirror.get();
    const map: Record<string, PageAccessOverride> = {};
    for (const a of data?.accounts ?? []) {
      if (a.page_access.custom) map[a.account_id] = { grant: a.page_access.grant, revoke: a.page_access.revoke };
    }
    if (data?.mine.custom) map[data.me] = { grant: data.mine.grant, revoke: data.mine.revoke };
    setPageAccessOverrides(map);
    scopeCache = null;
    notify();
  });
}

/** Defaults: managers see their whole reporting line; everyone else the company directory. */
export function defaultDataScope(account: Pick<DemoAccount, "role">): DataScopeSetting {
  if (API_ENABLED) {
    // The server's rule: HR, admin and executives see everyone; everyone else their reporting line.
    const global = isHrRole(account.role) || account.role === "admin" || account.role === "executive";
    return { scope: global ? "global" : "line", countries: [] };
  }
  if (account.role === "manager") return { scope: "line", countries: [] };
  return { scope: "global", countries: [] };
}

function readScopes(): Record<string, DataScopeSetting> {
  if (scopeCache) return scopeCache;
  try {
    const raw = localStorage.getItem(SCOPE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, Partial<DataScopeSetting>>) : {};
    const out: Record<string, DataScopeSetting> = {};
    for (const [id, v] of Object.entries(parsed ?? {})) {
      if (!v || !SCOPE_IDS.has(String(v.scope))) continue;
      out[id] = {
        scope: v.scope as DataScope,
        countries: (Array.isArray(v.countries) ? v.countries : []).filter((c): c is CountryCode => COUNTRY_CODES.has(c)),
      };
    }
    scopeCache = out;
  } catch {
    scopeCache = {};
  }
  return scopeCache;
}

function writeScopes(map: Record<string, DataScopeSetting>) {
  scopeCache = map;
  try {
    localStorage.setItem(SCOPE_KEY, JSON.stringify(map));
  } catch {
    /* keep in memory */
  }
  notify();
}

export function hasCustomDataScope(accountId: string): boolean {
  if (API_ENABLED) return Boolean(apiAccessAccount(accountId)?.data_scope.custom);
  return Boolean(readScopes()[accountId]);
}

/** The data scope for a sign-in account (saved setting, else the role default). */
export function dataScopeFor(accountId: string): DataScopeSetting {
  if (API_ENABLED) {
    const row = apiAccessAccount(accountId)?.data_scope;
    if (row && SCOPE_IDS.has(row.scope)) {
      return { scope: row.scope as DataScope, countries: row.countries.filter((c): c is CountryCode => COUNTRY_CODES.has(c)) };
    }
    const account = DEMO_ACCOUNTS.find((a) => a.id === accountId);
    return account ? defaultDataScope(account) : { scope: "own", countries: [] };
  }
  const saved = readScopes()[accountId];
  if (saved) return saved;
  const account = DEMO_ACCOUNTS.find((a) => a.id === accountId);
  return account ? defaultDataScope(account) : { scope: "own", countries: [] };
}

export function dataScopeLabel(setting: DataScopeSetting): string {
  const base = DATA_SCOPES.find((s) => s.id === setting.scope)?.label ?? setting.scope;
  return setting.countries.length ? `${base} · ${setting.countries.join(", ")}` : base;
}

export type ScopedPerson = {
  id: string;
  department?: string;
  countryCode?: string;
  legalEntity?: string;
  businessUnit?: string;
  location?: string;
};

type Viewer = { id: string; department?: string; countryCode?: string; legalEntity?: string; businessUnit?: string; location?: string };

function viewerFacts(viewerId: string): Viewer {
  const person = listPeople().find((p) => p.id === viewerId);
  const account = DEMO_ACCOUNTS.find((a) => a.id === viewerId);
  return {
    id: viewerId,
    department: person?.department ?? account?.department,
    countryCode: String(person?.countryCode ?? account?.countryCode ?? ""),
    legalEntity: person?.legalEntity ?? account?.legalEntity,
    businessUnit: person?.businessUnit,
    location: person?.location ?? account?.location,
  };
}

/**
 * Builds a test for "may this viewer see this person". Build once and reuse it for lists —
 * reporting-line scopes walk the directory once here, not per row.
 */
export function personFilterFor(viewerId: string): (person: ScopedPerson) => boolean {
  const setting = dataScopeFor(viewerId);
  const viewer = viewerFacts(viewerId);
  const countries = new Set<string>(setting.countries);
  const ids =
    setting.scope === "direct"
      ? new Set([viewerId, ...directReportIds(viewerId)])
      : setting.scope === "line"
        ? new Set([viewerId, ...allReportIds(viewerId)])
        : null;
  return (person) => {
    // People always see themselves.
    if (person.id === viewerId) return true;
    if (countries.size && !countries.has(String(person.countryCode ?? ""))) return false;
    switch (setting.scope) {
      case "own":
        return false;
      case "direct":
      case "line":
        return ids!.has(person.id);
      case "department":
        return Boolean(viewer.department) && person.department === viewer.department;
      case "country":
        return Boolean(viewer.countryCode) && String(person.countryCode ?? "") === viewer.countryCode;
      case "entity":
        return Boolean(viewer.legalEntity) && person.legalEntity === viewer.legalEntity;
      case "business_unit":
        return Boolean(viewer.businessUnit) && person.businessUnit === viewer.businessUnit;
      case "location":
        return Boolean(viewer.location) && person.location === viewer.location;
      default:
        return true;
    }
  };
}

export function canSeePerson(viewerId: string, person: ScopedPerson): boolean {
  return personFilterFor(viewerId)(person);
}

type Actor = { id: string; name: string };

export function saveDataScope(accountId: string, next: DataScopeSetting, actor: Actor): string | null | Promise<string | null> {
  const account = DEMO_ACCOUNTS.find((a) => a.id === accountId);
  if (!account) return "Unknown account.";
  if (!SCOPE_IDS.has(next.scope)) return "Pick a data scope.";
  const countries = isHrRole(account.role) ? next.countries.filter((c) => COUNTRY_CODES.has(c)) : [];
  // Backend mode: the API applies the scope on every request and audits the change.
  if (API_ENABLED) return apiRun(() => apiPutDataScope(accountId, next.scope, countries), accessMirror);
  const before = dataScopeFor(accountId);
  const clean: DataScopeSetting = { scope: next.scope, countries };
  if (dataScopeLabel(before) === dataScopeLabel(clean)) return null;
  const map = { ...readScopes() };
  const def = defaultDataScope(account);
  if (dataScopeLabel(def) === dataScopeLabel(clean)) delete map[accountId];
  else map[accountId] = clean;
  writeScopes(map);
  appendAuditEntries([
    {
      at: new Date().toISOString(),
      actorId: actor.id,
      actorName: actor.name,
      entity: "Data scope",
      entityId: accountId,
      subjectId: accountId,
      action: "Updated",
      changes: [{ field: "data scope", before: dataScopeLabel(before), after: dataScopeLabel(clean) }],
    },
  ]);
  return null;
}

/* —— Page access —— */

export type PageEntry = { id: string; label: string; group: string };

/** Every menu page an admin can switch on or off. Home stays on for everyone. */
export const LOCKED_PAGE_IDS: readonly string[] = ["home"];

export function pageCatalog(): PageEntry[] {
  const seen = new Set<string>();
  const out: PageEntry[] = [];
  const add = (id: string, label: string, group: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, label, group });
  };
  for (const link of pinnedNavLinks) add(link.id, link.label, "Me");
  for (const group of navGroups) for (const link of group.links) add(link.id, link.label, group.label);
  add("locale", localeLinks[0].label, "Settings");
  add("accessroles", "Roles & permissions", "Admin");
  add("aisettings", "AI settings", "Admin");
  return out;
}

const PAY_IDS: readonly string[] = ["compensation", "payslips", "paypreview"];

export function hasCustomPageAccess(accountId: string): boolean {
  return Boolean(getPageAccessOverrides()[accountId]);
}

function writePages(map: Record<string, PageAccessOverride>) {
  setPageAccessOverrides(map);
  try {
    localStorage.setItem(PAGE_ACCESS_KEY, JSON.stringify(map));
  } catch {
    /* keep in memory */
  }
  notify();
}

/** Pages this account can open now. */
export function effectivePageIds(account: DemoAccount): string[] {
  return pageCatalog()
    .map((p) => p.id)
    .filter((id) => accountHasNavAccess(account, id));
}

/**
 * Saves the pages an account may open. Returns an error, or null when saved.
 * Admins can't edit their own pages, and pay pages can only be granted by someone who holds them.
 */
export function savePageAccess(account: DemoAccount, wanted: string[], actor: DemoAccount): string | null | Promise<string | null> {
  if (actor.role !== "admin" && actor.role !== "super_admin") return "Only Admin can change page access.";
  if (account.id === actor.id) return "You can't change page access on your own account.";
  const want = new Set([...wanted, ...LOCKED_PAGE_IDS]);
  const before = new Set(effectivePageIds(account));
  const baseline = (id: string) => account.navAccess.includes("*") || account.navAccess.includes(id as never);
  const grant: string[] = [];
  const revoke: string[] = [];
  for (const { id } of pageCatalog()) {
    if (want.has(id) && !baseline(id)) grant.push(id);
    if (!want.has(id) && baseline(id)) revoke.push(id);
  }
  const newPay = grant.filter((id) => PAY_IDS.includes(id) && !before.has(id) && !accountHasNavAccess(actor, id));
  if (newPay.length) return "You can't grant pay access you don't hold yourself.";
  const added = [...want].filter((id) => !before.has(id));
  const removed = [...before].filter((id) => !want.has(id));
  if (!added.length && !removed.length) return null;
  if (API_ENABLED) return apiRun(() => apiPutPageAccess(account.id, grant, revoke), accessMirror);
  const map = { ...getPageAccessOverrides() };
  map[account.id] = { grant, revoke };
  writePages(map);
  const label = (id: string) => pageCatalog().find((p) => p.id === id)?.label ?? id;
  appendAuditEntries([
    {
      at: new Date().toISOString(),
      actorId: actor.id,
      actorName: actor.fullName,
      entity: "Page access",
      entityId: account.id,
      subjectId: account.id,
      action: "Updated",
      changes: [
        ...(added.length ? [{ field: "pages added", before: "—", after: added.map(label).join(", ") }] : []),
        ...(removed.length ? [{ field: "pages removed", before: removed.map(label).join(", "), after: "—" }] : []),
      ],
    },
  ]);
  return null;
}

/** Drops the page edits for an account so it goes back to its role's default pages. */
export function resetPageAccess(account: DemoAccount, actor: DemoAccount): string | null | Promise<string | null> {
  if (actor.role !== "admin" && actor.role !== "super_admin") return "Only Admin can change page access.";
  if (account.id === actor.id) return "You can't change page access on your own account.";
  if (API_ENABLED) return apiRun(() => apiResetPageAccess(account.id), accessMirror);
  const map = { ...getPageAccessOverrides() };
  if (!map[account.id]) return null;
  const before = effectivePageIds(account);
  delete map[account.id];
  writePages(map);
  const after = pageCatalog()
    .map((p) => p.id)
    .filter((id) => accountDefaultNavAccess(account, id));
  appendAuditEntries([
    {
      at: new Date().toISOString(),
      actorId: actor.id,
      actorName: actor.fullName,
      entity: "Page access",
      entityId: account.id,
      subjectId: account.id,
      action: "Updated",
      changes: [{ field: "pages", before: `${before.length} pages (custom)`, after: `${after.length} pages (role default)` }],
    },
  ]);
  return null;
}
