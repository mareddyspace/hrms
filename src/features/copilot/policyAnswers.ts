/**
 * Policy answers from the same library the Policies page shows (src/data/policyLibrary.ts),
 * already filtered to the asker by policyAppliesTo. Every answer cites the policy, version,
 * effective date and section it came from. Policies that don't apply to the asker are never quoted.
 */
import type { CopilotContext, CopilotSource } from "../../data/platformData.ts";
import type { Policy, PolicySection } from "../../data/policyLibrary.ts";
import { TIMEZ_COUNTRIES } from "../../model.ts";
import type { RawCopilotAnswer } from "./answers.ts";

const STOP = new Set([
  "policy", "policies", "what", "whats", "about", "tell", "with", "does", "have", "that", "this", "there", "where", "which",
  "when", "your", "mine", "from", "into", "rule", "rules", "show", "give", "please", "know", "need", "should", "would", "could",
  "the", "and", "for", "are", "can", "how", "our", "any", "who", "get", "say", "says", "much", "many",
]);

const COUNTRY_ALIASES: Record<string, string[]> = {
  IN: ["india", "indian"],
  US: ["united states", "usa", "america", "american"],
  GB: ["united kingdom", "uk", "britain", "british", "england"],
  AU: ["australia", "australian"],
  CA: ["canada", "canadian"],
  AE: ["united arab emirates", "uae", "dubai", "emirates"],
  SA: ["saudi arabia", "saudi", "ksa"],
  DE: ["germany", "german"],
};

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Link that opens the policy (and section) on the Policies page. */
export function policyHref(policyId: string, section?: string): string {
  return `/policies?policy=${encodeURIComponent(policyId)}${section ? `&section=${slug(section)}` : ""}`;
}

export function sourceOf(policy: Policy, section: PolicySection | string): CopilotSource {
  const heading = typeof section === "string" ? section : section.heading;
  return { title: policy.title, version: policy.version, effective: policy.effective, section: heading, to: policyHref(policy.id, heading) };
}

/** A country other than the asker's named in the question, by code. */
function otherCountryIn(q: string, ownCode: string | undefined): string | null {
  for (const c of TIMEZ_COUNTRIES) {
    if (c.code === ownCode) continue;
    const names = COUNTRY_ALIASES[c.code] ?? [c.name.toLowerCase()];
    if (names.some((n) => new RegExp(`(?:^|\\s)${n}(?=\\s|$)`).test(q))) return c.code;
  }
  return null;
}

const stem = (w: string) => w.replace(/(ies)$/, "y").replace(/(es|s)$/, "");

function keywords(q: string): string[] {
  return q
    .split(" ")
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map(stem);
}

function textHits(text: string, words: string[]): number {
  const toks = new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).map(stem));
  return words.filter((w) => toks.has(w)).length;
}

function sectionScore(s: PolicySection, words: string[]): number {
  return textHits(s.heading, words) * 3 + textHits(s.rules.join(" "), words);
}

function policyScore(p: Policy, words: string[]): number {
  const best = Math.max(0, ...p.sections.map((s) => sectionScore(s, words)));
  return textHits(p.title, words) * 4 + textHits(p.category, words) * 2 + best;
}

function scope(p: Policy) {
  return p.appliesTo === "all" ? {} : p.appliesTo;
}

/** Policy in the person's own library for a catalog id (their text has their holidays and shift). */
function own(ctx: CopilotContext, id: string): Policy | undefined {
  return ctx.policyLibrary?.find((p) => p.id === id);
}

export const NOT_AVAILABLE = (title: string) => `That policy (${title}) doesn't apply to you, so I can't share it. Policies lists the ones that do.`;

/**
 * Answers a policy question, or returns null when nothing in the library matches.
 * `deniedOnly`: only return an answer when the match is a policy the asker can't see.
 */
export function policyLibraryAnswer(q: string, ctx: CopilotContext, deniedOnly = false): RawCopilotAnswer | null {
  const mine = ctx.policyLibrary ?? [];
  const catalog = ctx.policyCatalog ?? mine;
  if (!catalog.length) return null;
  const words = keywords(q);
  if (!words.length) return null;
  const otherCountry = otherCountryIn(q, ctx.countryCode);
  const country = otherCountry ?? ctx.countryCode ?? "IN";
  // Global policies (any audience) plus the country asked about — or the asker's own country.
  const candidates = catalog.filter((p) => {
    const countries = scope(p).countries;
    return !countries?.length || countries.includes(country as never);
  });
  const applies = (p: Policy) => mine.some((m) => m.id === p.id);
  let best: Policy | null = null;
  let bestScore = 0;
  let bestOwn: Policy | null = null;
  let bestOwnScore = 0;
  for (const p of candidates) {
    const s = policyScore(p, words) + (otherCountry && scope(p).countries?.length ? 2 : 0);
    if (s > bestScore) {
      best = p;
      bestScore = s;
    }
    if (applies(p) && s > bestOwnScore) {
      bestOwn = p;
      bestOwnScore = s;
    }
  }
  if (!best) return null;
  // Refuse only when a policy the asker can't see is clearly what was asked about: it beats every
  // policy they can see and was named (title or category) or sits in another country.
  const named = textHits(`${best.title} ${best.category}`, words) > 0;
  if (!applies(best) && (bestOwnScore >= bestScore || !(named || otherCountry))) best = bestOwn;
  if (!best) return null;
  if (!applies(best)) {
    return { kind: "text", summary: NOT_AVAILABLE(best.title), links: [{ label: "Policies", to: "/policies" }], denied: true };
  }
  if (deniedOnly) return null;
  const policy = own(ctx, best.id) ?? best;
  const ranked = policy.sections
    .map((s) => ({ s, score: sectionScore(s, words) }))
    .sort((a, b) => b.score - a.score);
  const top = ranked[0]?.score ? ranked.filter((r) => r.score > 0).slice(0, 2).map((r) => r.s) : policy.sections.slice(0, 1);
  const lead = top[0];
  const rules = lead.rules.slice(0, 3).join(" ");
  return {
    kind: "text",
    summary: `${policy.title} — ${lead.heading}: ${rules}${lead.rules.length > 3 ? " …" : ""}`,
    links: [{ label: "Policies", to: "/policies" }],
    sources: top.map((s) => sourceOf(policy, s)),
  };
}

/** Sources for leave answers: the asker's own country leave policy, picked section(s). */
export function leaveSources(ctx: CopilotContext, headings: string[]): CopilotSource[] | undefined {
  const policy = ctx.policyLibrary?.find((p) => p.category === "Leave");
  if (!policy) return undefined;
  const out = headings
    .map((h) => policy.sections.find((s) => s.heading === h))
    .filter((s): s is PolicySection => !!s)
    .map((s) => sourceOf(policy, s));
  return out.length ? out : [sourceOf(policy, policy.sections[0]?.heading ?? "")];
}
