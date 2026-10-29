/**
 * Shared helpers for the compensation, benefits and documents sync (VITE_API_URL mode only):
 * error text, names, countries, money and authorized file transfers (uploads and downloads).
 */
import { getPerson } from "../data/peopleLocal.ts";
import { TIMEZ_COUNTRIES } from "../model.ts";
import { API_URL, ApiError, apiRequest } from "./client.ts";

export type Outcome = string | null;

/** Runs an API call; returns null on success or a short message to show. 403 → "Not available". */
export async function attempt(fn: () => Promise<unknown>): Promise<Outcome> {
  try {
    await fn();
    return null;
  } catch (error) {
    if (error instanceof ApiError) return error.message || "That didn't work. Try again.";
    console.error(error);
    return "That didn't work. Try again.";
  }
}

/** Value of a call, or the fallback when it fails (missing access, network…). */
export async function orElse<T>(promise: Promise<T>, fallback: T): Promise<T> {
  try {
    return await promise;
  } catch {
    return fallback;
  }
}

export const enc = encodeURIComponent;

export function nameOf(id: string | null | undefined, fallback?: string | null): string {
  if (!id) return fallback ?? "";
  return getPerson(id)?.fullName ?? fallback ?? id;
}

export function countryName(code: string | null | undefined): string {
  if (!code) return "";
  return TIMEZ_COUNTRIES.find((c) => c.code === code)?.name ?? code;
}

export function countryCode(name: string): string {
  return TIMEZ_COUNTRIES.find((c) => c.name === name || c.code === name)?.code ?? name;
}

const CURRENCY_SYMBOL: Record<string, string> = { INR: "₹", USD: "$", GBP: "£", CAD: "C$", EUR: "€", AUD: "A$", AED: "AED ", SAR: "SAR " };

export function money(amount: number | null | undefined, currency: string): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return "";
  const grouped = Math.round(amount).toLocaleString(currency === "INR" ? "en-IN" : "en-US");
  return `${CURRENCY_SYMBOL[currency] ?? `${currency} `}${grouped}`;
}

export const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "");

/* ───────── Files (raw bodies, so not through apiRequest) ───────── */

const TOKEN_KEY = "timez.api.tokens";

function accessToken(): string | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    return raw ? ((JSON.parse(raw) as { access?: string }).access ?? null) : null;
  } catch {
    return null;
  }
}

async function errorFrom(res: Response): Promise<ApiError> {
  let detail: unknown = null;
  try {
    detail = ((await res.json()) as { detail?: unknown }).detail;
  } catch {
    /* not JSON */
  }
  if (typeof detail === "string" && detail.trim()) return new ApiError(res.status, detail);
  if (res.status === 403) return new ApiError(403, "Not available.");
  if (res.status === 404) return new ApiError(404, "Not found.");
  return new ApiError(res.status, res.status >= 500 ? "Something went wrong on the server. Try again." : "That didn't work. Try again.");
}

/** fetch with the bearer token; on 401 lets the client refresh the session once, then retries. */
export async function authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const go = () =>
    fetch(`${API_URL}/api/v1${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${accessToken() ?? ""}` },
    });
  let res: Response;
  try {
    res = await go();
    if (res.status === 401) {
      await apiRequest("/auth/me").catch(() => undefined);
      res = await go();
    }
  } catch {
    throw new ApiError(0, "The server is starting up. Try again in about 30 seconds.");
  }
  if (!res.ok) throw await errorFrom(res);
  return res;
}

const EXT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export function fileType(file: File): string {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return file.type || EXT_TYPES[ext] || "application/octet-stream";
}

function fileNameFrom(res: Response, fallback: string): string {
  const cd = res.headers.get("content-disposition") ?? "";
  const star = cd.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (star) {
    try {
      return decodeURIComponent(star);
    } catch {
      /* fall through */
    }
  }
  return cd.match(/filename="?([^";]+)"?/i)?.[1] ?? fallback;
}

/** Downloads a file from the API and saves it (or opens it in a new tab). */
export async function fetchFile(path: string, fallbackName: string, mode: "save" | "open" = "save"): Promise<Outcome> {
  return attempt(async () => {
    const res = await authorizedFetch(path);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    if (mode === "open") {
      const win = window.open(url, "_blank");
      if (!win) saveUrl(url, fileNameFrom(res, fallbackName));
    } else {
      saveUrl(url, fileNameFrom(res, fallbackName));
    }
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  });
}

function saveUrl(url: string, name: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
}
