/**
 * Two-step sign-in (TOTP + backup codes), signed-in devices and the admin MFA rule (backend /security, migration 0013).
 * API mode only.
 */
import { apiRequest } from "./client.ts";

export interface MfaStatus {
  enabled: boolean;
  enabled_at: string | null;
  backup_codes_left: number;
  required_by_policy: boolean;
  setup_required: boolean;
}

export interface MfaSetup {
  secret: string;
  otpauth_uri: string;
  issuer: string;
  account_name: string;
}

export interface SignedInDevice {
  session_id: string;
  started_at: string | null;
  last_used_at: string | null;
  expires_at: string;
  ip: string | null;
  user_agent: string | null;
  current: boolean;
}

export interface AdminAccountRow {
  account_id: string;
  email: string;
  role: string;
  full_name: string | null;
}

export const getMfaStatus = () => apiRequest<MfaStatus>("/security/mfa");
export const startMfaSetup = () => apiRequest<MfaSetup>("/security/mfa/setup", { method: "POST", body: {} });
export const enableMfa = (code: string) =>
  apiRequest<{ backup_codes: string[] }>("/security/mfa/enable", { method: "POST", body: { code: code.trim() } });
export const disableMfa = (password: string) =>
  apiRequest<MfaStatus>("/security/mfa/disable", { method: "POST", body: { password } });
export const renewBackupCodes = (password: string) =>
  apiRequest<{ backup_codes: string[] }>("/security/mfa/backup-codes", { method: "POST", body: { password } });

export const getMfaPolicy = () => apiRequest<{ require_mfa_admin_hr: boolean }>("/security/mfa-policy");
export const setMfaPolicy = (on: boolean) =>
  apiRequest<{ require_mfa_admin_hr: boolean }>("/security/mfa-policy", { method: "PUT", body: { require_mfa_admin_hr: on } });

export const listMySessions = () => apiRequest<SignedInDevice[]>("/security/sessions");
export const revokeSession = (id: string) =>
  apiRequest<{ revoked: number }>(`/security/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
export const revokeOtherSessions = () => apiRequest<{ revoked: number }>("/security/sessions/revoke-others", { method: "POST", body: {} });

export const listAccounts = () => apiRequest<AdminAccountRow[]>("/admin/accounts");
export const listAccountSessions = (accountId: string) =>
  apiRequest<SignedInDevice[]>(`/security/accounts/${encodeURIComponent(accountId)}/sessions`);
export const revokeAccountSessions = (accountId: string) =>
  apiRequest<{ revoked: number }>(`/security/accounts/${encodeURIComponent(accountId)}/sessions/revoke`, { method: "POST", body: {} });

/** "Chrome on Windows" from a user agent string (best effort). */
export function deviceLabel(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : null;
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? ua.slice(0, 60);
}
