/**
 * Client for the TimeZ HRMS API (backend/). Used only when VITE_API_URL is set at build/dev time;
 * without it the portal keeps everything in the browser as before.
 *
 * Tokens live in memory and sessionStorage (never localStorage), so they end with the browser tab.
 */

const RAW_URL = (import.meta.env.VITE_API_URL as string | undefined)?.trim() ?? "";

/** Base URL without a trailing slash, e.g. http://localhost:8000. Empty when the backend is off. */
export const API_URL = RAW_URL.replace(/\/+$/, "");

/** True when the portal talks to the backend for sign-in, people and leave. */
export const API_ENABLED = API_URL !== "";

const API_PREFIX = "/api/v1";
const TOKEN_KEY = "timez.api.tokens";

interface Tokens {
  access: string;
  refresh: string;
}

let tokens: Tokens | null = readTokens();

function readTokens(): Tokens | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    const parsed = raw ? (JSON.parse(raw) as Tokens) : null;
    return parsed?.access && parsed.refresh ? parsed : null;
  } catch {
    return null;
  }
}

function saveTokens(next: Tokens | null) {
  tokens = next;
  try {
    if (next) sessionStorage.setItem(TOKEN_KEY, JSON.stringify(next));
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage blocked: memory only */
  }
}

export function hasTokens(): boolean {
  return tokens !== null;
}

export function clearTokens() {
  // Sign-out: end this device's session on the server too (fire and forget).
  const refresh = tokens?.refresh;
  if (refresh && API_ENABLED) {
    try {
      void fetch(urlFor("/auth/logout"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refresh }),
        keepalive: true,
      }).catch(() => undefined);
    } catch {
      /* ignore */
    }
  }
  saveTokens(null);
}

/* ───────── Session-ended listeners (refresh failed) ───────── */

const sessionEndedListeners = new Set<() => void>();

/** Called when the session can't be refreshed any more; the portal signs out. */
export function onSessionEnded(listener: () => void): () => void {
  sessionEndedListeners.add(listener);
  return () => {
    sessionEndedListeners.delete(listener);
  };
}

function endSession() {
  saveTokens(null);
  announceApiSession(null);
  sessionEndedListeners.forEach((fn) => fn());
}

/* ───────── Session listeners (who is signed in to the API) ───────── */

const sessionListeners = new Set<(accountId: string | null) => void>();
let currentAccountId: string | null = null;

/** The signed-in account id while an API session is active, else null. */
export function apiSessionAccount(): string | null {
  return currentAccountId;
}

/**
 * Module stores load their data from the API when a session starts (sign-in or reload while signed in)
 * and drop it when it ends. Called straight away with the current account if one is already signed in.
 */
export function onApiSession(listener: (accountId: string | null) => void): () => void {
  sessionListeners.add(listener);
  if (currentAccountId) listener(currentAccountId);
  return () => {
    sessionListeners.delete(listener);
  };
}

/** The portal calls this after sign-in or a reload (account id) and on sign-out (null). */
export function announceApiSession(accountId: string | null) {
  if (accountId === currentAccountId) return;
  currentAccountId = accountId;
  sessionMe = null;
  sessionListeners.forEach((fn) => {
    try {
      fn(accountId);
    } catch (error) {
      console.error("Session listener failed", error);
    }
  });
}

/* ───────── Who is signed in (cached per session) ───────── */

let sessionMe: { account: string; me: Promise<MeOut> } | null = null;

/**
 * GET /auth/me once per session, so loaders can skip lists the role isn't allowed to see (no expected 403s).
 */
export function apiSessionMe(): Promise<MeOut> {
  const account = currentAccountId ?? "";
  if (!sessionMe || sessionMe.account !== account) {
    const me = api.get<MeOut>("/auth/me");
    sessionMe = { account, me };
    me.catch(() => {
      if (sessionMe?.me === me) sessionMe = null;
    });
  }
  return sessionMe.me;
}

/** Backend role groups (app/services/scope.py and the routers). */
export const API_HR_ROLES = new Set(["hr_admin", "hr", "hrbp"]);
export const API_ADMIN_ROLES = new Set(["admin", "super_admin"]);
export const isApiHr = (role: string) => API_HR_ROLES.has(role);
export const isApiAdmin = (role: string) => API_ADMIN_ROLES.has(role);

/* ───────── Errors ───────── */

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

/** FastAPI errors: {detail: "text"} or {detail: [{msg, loc}]} for validation errors. */
function messageFrom(body: unknown, status: number): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string" && detail.trim()) return detail;
  if (Array.isArray(detail) && detail.length) {
    const first = detail[0] as { msg?: string; loc?: unknown[] };
    const field = Array.isArray(first.loc) ? first.loc[first.loc.length - 1] : undefined;
    const msg = (first.msg ?? "Check the details and try again.").replace(/^Value error, /, "");
    return field && typeof field === "string" ? `${field}: ${msg}` : msg;
  }
  if (status === 0) return "The server is starting up. Try again in about 30 seconds.";
  if (status >= 500) return "Something went wrong on the server. Try again.";
  return "That didn't work. Try again.";
}

/* ───────── Requests ───────── */

type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Query;
  /** Skip the bearer token (sign-in, refresh). */
  anonymous?: boolean;
}

function urlFor(path: string, query?: Query): string {
  const url = new URL(`${API_URL}${API_PREFIX}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (!options.anonymous && tokens) headers.Authorization = `Bearer ${tokens.access}`;
  try {
    return await fetch(urlFor(path, options.query), {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError(0, messageFrom(null, 0));
  }
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) throw new ApiError(res.status, messageFrom(body, res.status));
  return body as T;
}

/** One refresh at a time; parallel 401s wait for the same attempt. */
let refreshing: Promise<boolean> | null = null;

async function refreshTokens(): Promise<boolean> {
  if (!tokens) return false;
  refreshing ??= (async () => {
    try {
      const res = await send("/auth/refresh", { method: "POST", body: { refresh_token: tokens!.refresh }, anonymous: true });
      if (!res.ok) return false;
      const out = (await res.json()) as TokenOut;
      saveTokens({ access: out.access_token, refresh: out.refresh_token });
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** JSON request with the bearer token; on 401 refreshes once and retries, and signs out if that fails. */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let res = await send(path, options);
  if (res.status === 401 && !options.anonymous) {
    if (await refreshTokens()) res = await send(path, options);
    if (res.status === 401) {
      endSession();
      throw new ApiError(401, "Your session has ended. Sign in again.");
    }
  }
  return parse<T>(res);
}

export const api = {
  get: <T>(path: string, query?: Query) => apiRequest<T>(path, { query }),
  post: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: "POST", body: body ?? {} }),
};

/* ───────── Response shapes (backend/app/schemas) ───────── */

export interface TokenOut {
  access_token: string;
  refresh_token: string;
  token_type: "bearer";
  expires_in: number;
  /** Previous sign-in time, on sign-in only. */
  last_login_at?: string | null;
  must_change_password?: boolean;
  /** Two-step sign-in: no tokens yet; send mfa_token and a code to /auth/mfa/verify. */
  mfa_required?: boolean;
  mfa_token?: string | null;
  /** The admin rule needs this account to set up two-step sign-in first. */
  mfa_setup_required?: boolean;
}

export interface MeOut {
  account_id: string;
  email: string;
  role: string;
  employee_id: string | null;
  full_name: string | null;
  country_code: string | null;
  last_login_at: string | null;
  must_change_password?: boolean;
  scope: "self" | "team" | "global";
  scope_countries: string[] | null;
}

export interface PersonBasicOut {
  view: "basic";
  id: string;
  full_name: string;
  preferred_name: string | null;
  job_title: string;
  department: string;
  location: string;
  country_code: string;
  email: string;
  manager_id: string | null;
  manager_name: string | null;
  photo: string | null;
  company?: string;
}

export interface PersonFullOut extends Omit<PersonBasicOut, "view"> {
  view: "full";
  employee_code: string;
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
  personal_email: string | null;
  mobile: string | null;
  legal_entity: string;
  business_unit: string;
  division: string | null;
  cost_centre: string | null;
  job_family: string | null;
  position_id: string | null;
  grade: string;
  employment_type: string;
  employment_status: string;
  joining_date: string;
  time_zone: string;
  currency: string;
  date_of_birth: string | null;
  gender: string | null;
  holiday_calendar: string | null;
  leave_policy_name: string | null;
  payroll_status: string | null;
  ai_profile_status: string | null;
  // Profile details (backend migration 0008). address_line, address_postcode and emergency_phone arrive masked.
  nationality?: string | null;
  address_line?: string | null;
  address_city?: string | null;
  address_postcode?: string | null;
  address_country?: string | null;
  emergency_name?: string | null;
  emergency_relationship?: string | null;
  emergency_phone?: string | null;
  work_arrangement?: string | null;
  preferred_language?: string | null;
  languages?: string[];
  education?: { degree: string; institution: string; year: number }[];
  experience?: { employer: string; title: string; from: string; to: string }[];
  career_goals?: string | null;
  direct_report_count?: number | null;
  /** Caller may fetch full values from /people/{id}/reveal (self, or HR / admin in scope). Personal fields arrive masked. */
  can_reveal?: boolean;
}

export type PersonOut = PersonBasicOut | PersonFullOut;

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export interface LeavePolicyOut {
  code: string;
  name: string;
  country_code: string;
  quota: number;
  carry_forward_max: number;
  accrual: string;
  half_day_allowed: boolean;
  effective_from: string;
  effective_to: string | null;
}

export interface LeaveBalanceOut {
  code: string;
  name: string;
  quota: number;
  carried_over: number;
  used: number;
  pending: number;
  left: number;
  available: number;
  accrual: string;
}

export interface LeaveBalancesOut {
  employee_id: string;
  year: number;
  balances: LeaveBalanceOut[];
}

export interface LeaveRequestOut {
  id: string;
  employee_id: string;
  employee_name: string | null;
  leave_code: string;
  from: string;
  to: string;
  half: "none" | "first" | "second" | string;
  days: number;
  reason: string;
  status: "pending" | "approved" | "rejected" | "withdrawn" | "cancelled" | string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
}

export interface NotificationOut {
  id: number;
  title: string;
  body: string;
  href: string | null;
  read_at: string | null;
  created_at: string;
}

/* ───────── Auth ───────── */

/** Message (and ApiError status 428) when the password was right and a code from the authenticator app is needed. */
export const MFA_CODE_NEEDED = "Enter the 6-digit code from your authenticator app.";

/** Pending second step of a two-step sign-in (memory only, short-lived on the server). */
let pendingMfa: { email: string; token: string } | null = null;
let mfaSetupRequired = false;

/** True after a sign-in where the admin rule needs this account to turn on two-step sign-in. */
export function apiMfaSetupRequired(): boolean {
  return mfaSetupRequired;
}

/**
 * Sign in; keeps the tokens and returns the account plus the previous sign-in time.
 * With two-step sign-in on, the first call throws ApiError(428, MFA_CODE_NEEDED); call again with the code.
 */
export async function apiLogin(
  email: string,
  password: string,
  mfaCode?: string,
): Promise<{ me: MeOut; previousLoginAt: string | null; mustChangePassword: boolean }> {
  let out: TokenOut;
  if (mfaCode && pendingMfa && pendingMfa.email === email.toLowerCase()) {
    try {
      out = await apiRequest<TokenOut>("/auth/mfa/verify", {
        method: "POST",
        body: { mfa_token: pendingMfa.token, code: mfaCode.trim() },
        anonymous: true,
      });
    } catch (error) {
      if (error instanceof ApiError && error.message.startsWith("Sign-in timed out")) pendingMfa = null;
      throw error;
    }
  } else {
    out = await apiRequest<TokenOut>("/auth/login", { method: "POST", body: { email, password }, anonymous: true });
  }
  if (out.mfa_required && out.mfa_token) {
    pendingMfa = { email: email.toLowerCase(), token: out.mfa_token };
    throw new ApiError(428, MFA_CODE_NEEDED);
  }
  pendingMfa = null;
  mfaSetupRequired = Boolean(out.mfa_setup_required);
  saveTokens({ access: out.access_token, refresh: out.refresh_token });
  try {
    const me = await api.get<MeOut>("/auth/me");
    return {
      me,
      previousLoginAt: out.last_login_at ?? null,
      mustChangePassword: Boolean(out.must_change_password ?? me.must_change_password),
    };
  } catch (error) {
    saveTokens(null);
    throw error;
  }
}

/** Change the signed-in account's password (also clears a required change after a long gap). */
export async function apiChangePassword(currentPassword: string, newPassword: string): Promise<void> {
  await apiRequest<void>("/auth/change-password", {
    method: "POST",
    body: { current_password: currentPassword, new_password: newPassword },
  });
}
