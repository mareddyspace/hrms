/**
 * Profile edits, profile correction requests and the Copilot action audit on the server (VITE_API_URL mode only).
 * backend/app/routers/profile.py
 */
import { ApiError, apiRequest, type PersonFullOut } from "./client.ts";
import { loadApiPeople } from "./portalSync.ts";

const enc = encodeURIComponent;

/** Fields the signed-in person may change on their own record (PATCH /people/me). */
export interface ApiSelfProfileUpdate {
  preferred_name?: string | null;
  mobile?: string | null;
  personal_email?: string | null;
  address_line?: string | null;
  address_city?: string | null;
  address_postcode?: string | null;
  address_country?: string | null;
  emergency_name?: string | null;
  emergency_relationship?: string | null;
  emergency_phone?: string | null;
  preferred_language?: string | null;
  languages?: string[];
  education?: { degree: string; institution: string; year: number }[];
  experience?: { employer: string; title: string; from: string; to: string }[];
  career_goals?: string | null;
  /** Code from POST /people/me/otp; needed when mobile or personal_email changes. */
  otp_code?: string;
}

/** HR / admin edits (PATCH /people/{id}): the employee fields plus HR-owned ones. */
export interface ApiHrProfileUpdate extends ApiSelfProfileUpdate {
  first_name?: string | null;
  middle_name?: string | null;
  last_name?: string | null;
  nationality?: string | null;
  work_arrangement?: "Office" | "Hybrid" | "Remote" | null;
  date_of_birth?: string | null;
  gender?: string | null;
  company?: string | null;
}

export type ApiCorrectionField =
  | "full_name"
  | "middle_name"
  | "date_of_birth"
  | "nationality"
  | "job_title"
  | "department"
  | "manager_id"
  | "work_arrangement";

export interface ProfileCorrectionOut {
  id: string;
  employee_id: string;
  employee_name: string | null;
  field: ApiCorrectionField;
  current_value: string | null;
  requested_value: string | null;
  requested_label: string | null;
  reason: string;
  status: "pending" | "approved" | "rejected" | "withdrawn";
  requested_by: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
  can_decide: boolean;
}

const message = (error: unknown, fallback: string) => (error instanceof ApiError || error instanceof Error ? error.message : fallback);

/** Remove blank keys that were never set, keep explicit clears ("" becomes null). */
function body<T extends object>(input: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) if (v !== undefined) out[k] = typeof v === "string" ? v.trim() || null : v;
  return out as T;
}

export type ApiOtpField = "mobile" | "personal_email";

/**
 * Asks the server to send a 6-digit code (10 minutes, 5 tries) for changing your own mobile or personal email.
 * devCode is only filled when the server runs with OTP_DEV_ECHO=true.
 */
export async function apiRequestProfileOtp(
  field: ApiOtpField,
  newValue: string,
): Promise<{ error: string | null; sentTo?: string; devCode?: string }> {
  try {
    const out = await apiRequest<{ field: string; sent_to: string; expires_at: string; dev_code: string | null }>(
      "/people/me/otp",
      { method: "POST", body: { field, new_value: newValue.trim() } },
    );
    return { error: null, sentTo: out.sent_to, devCode: out.dev_code ?? undefined };
  } catch (error) {
    return { error: message(error, "Could not send the code. Try again.") };
  }
}

/** null when saved, else the reason. Reloads the directory so every page shows the server values. */
export async function apiUpdateOwnProfile(input: ApiSelfProfileUpdate): Promise<string | null> {
  try {
    await apiRequest<PersonFullOut>("/people/me", { method: "PATCH", body: body(input) });
  } catch (error) {
    return message(error, "Could not save. Try again.");
  }
  await loadApiPeople().catch(() => undefined);
  return null;
}

export async function apiUpdatePerson(personId: string, input: ApiHrProfileUpdate): Promise<string | null> {
  try {
    await apiRequest<PersonFullOut>(`/people/${enc(personId)}`, { method: "PATCH", body: body(input) });
  } catch (error) {
    return message(error, "Could not save. Try again.");
  }
  await loadApiPeople().catch(() => undefined);
  return null;
}

/** Your own requests plus, for HR / admin, everyone's in scope. */
export function apiListCorrections(): Promise<ProfileCorrectionOut[]> {
  return apiRequest<ProfileCorrectionOut[]>("/profile-corrections", { query: { limit: 500 } });
}

export async function apiRequestCorrection(
  personId: string,
  input: { field: ApiCorrectionField; requested_value: string; reason: string },
): Promise<string | null> {
  try {
    await apiRequest<ProfileCorrectionOut>(`/people/${enc(personId)}/corrections`, { method: "POST", body: input });
    return null;
  } catch (error) {
    return message(error, "Could not send the request.");
  }
}

export async function apiDecideCorrection(id: string, decision: "approve" | "reject", note: string): Promise<string | null> {
  try {
    await apiRequest<ProfileCorrectionOut>(`/profile-corrections/${enc(id)}/decide`, {
      method: "POST",
      body: { decision, note: note.trim() || null },
    });
  } catch (error) {
    return message(error, "Could not save the decision.");
  }
  if (decision === "approve") await loadApiPeople().catch(() => undefined);
  return null;
}

export async function apiWithdrawCorrection(id: string): Promise<string | null> {
  try {
    await apiRequest<ProfileCorrectionOut>(`/profile-corrections/${enc(id)}/withdraw`, { method: "POST" });
    return null;
  } catch (error) {
    return message(error, "Could not withdraw the request.");
  }
}

/** Copilot action shown / confirmed / cancelled. The summary must not carry personal values. Never throws. */
export async function apiAuditAiAction(action: string, status: "proposed" | "confirmed" | "cancelled", summary: string): Promise<void> {
  try {
    await apiRequest("/ai/actions/audit", { method: "POST", body: { action, status, summary: summary.slice(0, 200) } });
  } catch {
    /* audit is best effort from the browser; the change itself is audited by the server */
  }
}
