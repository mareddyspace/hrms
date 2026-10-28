/**
 * Who may press "Show" on a masked personal detail, and where the full value comes from.
 * - The person themselves: always (no audit).
 * - HR / admin within their data scope: yes; in backend mode the value comes from the audited reveal endpoint.
 * - Managers and everyone else: masked only.
 */
import { API_ENABLED } from "../api/client.ts";
import { apiCanReveal, revealPersonDetail, type RevealField } from "../api/portalSync.ts";
import { apiRevealCandidatePhone } from "../api/syncTalent.ts";
import type { DemoAccount } from "../demoAccounts.ts";
import { isMasked } from "../utils/mask.ts";

const REVEAL_ROLES = new Set(["hr", "hr_admin", "hrbp", "admin"]);

export function isRevealRole(role: string): boolean {
  return REVEAL_ROLES.has(role);
}

/** inScope: the viewer's data scope covers this person (e.g. ProfileAccess.personal). */
export function canRevealPersonal(viewer: DemoAccount, personId: string, selfId: string, inScope: boolean): boolean {
  if (personId === selfId) return true;
  if (API_ENABLED && apiCanReveal(personId)) return true;
  return isRevealRole(viewer.role) && inScope;
}

/**
 * The onReveal for MaskedValue: in backend mode, a masked value is fetched from /people/{id}/reveal.
 * Undefined means MaskedValue shows the value it already holds (local mode).
 */
export function personRevealer(
  personId: string,
  field: RevealField,
  value: string | null | undefined,
): (() => Promise<string | null>) | undefined {
  if (!API_ENABLED || !isMasked(value)) return undefined;
  return () => revealPersonDetail(personId, field);
}

/** Candidate phone: the recruiter and HR / admin can press Show (backend: audited reveal). */
export function canRevealCandidate(viewer: DemoAccount): boolean {
  return viewer.role === "recruiter" || isRevealRole(viewer.role);
}

export function candidateRevealer(candidateId: string, phone: string | null | undefined): (() => Promise<string | null>) | undefined {
  if (!API_ENABLED || !isMasked(phone)) return undefined;
  return () => apiRevealCandidatePhone(candidateId);
}
