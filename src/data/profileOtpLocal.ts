/**
 * Local mode (no VITE_API_URL): verification codes for changes to your own personal details, same rules as
 * backend/app/services/profile_otp.py. The code goes to your TimeZ Mail inbox from "TimeZ Security" and to the
 * email outbox; only hashes of the code and the new values are kept. 10 minutes, 5 tries, then locked for
 * 15 minutes; a new code 30 seconds after the last.
 */
import { sendMail } from "./mailStore.ts";
import { queueEmailForNotification } from "./emailOutbox.ts";
import type { ProfileCodeSent } from "../api/syncProfile.ts";

const KEY = "timez.profileOtp.v1";
const CODE_MS = 10 * 60_000;
const LOCK_MS = 15 * 60_000;
const RESEND_MS = 30_000;
const MAX_ATTEMPTS = 5;
export const SECURITY_SENDER_ID = "timez-security";

interface OpenCode {
  codeHash: string;
  changesHash: string;
  issuedAt: number;
  expiresAt: number;
  attempts: number;
}
interface Entry {
  open?: OpenCode;
  lockedUntil?: number;
}

function readAll(): Record<string, Entry> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, Entry>;
  } catch {
    return {};
  }
}

function writeEntry(userId: string, entry: Entry) {
  const all = readAll();
  all[userId] = entry;
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* private window: codes then last only as long as the page */
  }
}

async function hash(text: string): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  let h = 0;
  for (const ch of text) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  return String(h);
}

const canon = (changes: Record<string, unknown>) =>
  JSON.stringify(Object.keys(changes).sort().map((k) => [k, changes[k] ?? null]));

function lockMessage(until: number): string {
  const minutes = Math.max(1, Math.ceil((until - Date.now()) / 60_000));
  return `Too many wrong codes. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

function randomCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(n).padStart(6, "0");
}

/** Sends a code for exactly these changes (only the personal-detail fields that differ). */
export async function sendLocalProfileCode(userId: string, changes: Record<string, unknown>): Promise<ProfileCodeSent> {
  if (!Object.keys(changes).length) return { error: null, required: false };
  const entry = readAll()[userId] ?? {};
  const now = Date.now();
  if (entry.lockedUntil && entry.lockedUntil > now) return { error: lockMessage(entry.lockedUntil), required: true };
  if (entry.open && now - entry.open.issuedAt < RESEND_MS) {
    const wait = Math.ceil((RESEND_MS - (now - entry.open.issuedAt)) / 1000);
    return { error: `Wait ${wait} seconds before sending another code.`, required: true };
  }
  const code = randomCode();
  const expiresAt = now + CODE_MS;
  writeEntry(userId, {
    open: { codeHash: await hash(`${userId}|code|${code}`), changesHash: await hash(`${userId}|${canon(changes)}`), issuedAt: now, expiresAt, attempts: 0 },
  });
  const text = `Your code is ${code}. It expires in 10 minutes.`;
  sendMail({ fromId: SECURITY_SENDER_ID, fromName: "TimeZ Security", toIds: [userId], subject: "Your TimeZ verification code", body: text, category: "General" });
  queueEmailForNotification({ recipientId: userId, category: "System", title: "Your TimeZ verification code", body: text, href: "/mail" });
  return { error: null, required: true, inboxHref: "/mail", expiresAt, resendAfter: RESEND_MS / 1000 };
}

/** null when the code matches these changes (it is then used up), else the reason. */
export async function checkLocalProfileCode(userId: string, changes: Record<string, unknown>, code: string): Promise<string | null> {
  const entry = readAll()[userId] ?? {};
  const now = Date.now();
  if (entry.lockedUntil && entry.lockedUntil > now) return lockMessage(entry.lockedUntil);
  if (!/^\d{6}$/.test(code.trim())) return "Enter the 6-digit code.";
  const open = entry.open;
  if (!open) return "Send a verification code first.";
  if (now > open.expiresAt) {
    writeEntry(userId, {});
    return "That code has expired. Send a new one.";
  }
  if ((await hash(`${userId}|code|${code.trim()}`)) !== open.codeHash) {
    const attempts = open.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      writeEntry(userId, { lockedUntil: now + LOCK_MS });
      return "Too many wrong codes. Try again in 15 minutes.";
    }
    writeEntry(userId, { open: { ...open, attempts } });
    const left = MAX_ATTEMPTS - attempts;
    return `That code is not correct. ${left} ${left === 1 ? "try" : "tries"} left.`;
  }
  if ((await hash(`${userId}|${canon(changes)}`)) !== open.changesHash) return "The code was sent for different details. Send a new one.";
  writeEntry(userId, {});
  return null;
}
