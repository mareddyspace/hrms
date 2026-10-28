// Export the front end's policy library (src/data/policyLibrary.ts) to backend/seed/policies.json, so the
// API's HR Copilot can quote the same rules the portal shows (app/services/policy_kb.py).
// Run from the repo root:  node --experimental-strip-types scripts/export-policies.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "backend", "seed");
mkdirSync(outDir, { recursive: true });

// Some front-end modules read Vite's import.meta.env; give them an empty one outside Vite.
const hook = `export async function load(url, context, next) {
  const out = await next(url, context);
  if (url.includes("/src/") && out.source) {
    const text = typeof out.source === "string" ? out.source : new TextDecoder().decode(out.source);
    if (text.includes("import.meta.env")) return { ...out, source: text.replaceAll("import.meta.env", "({})") };
  }
  return out;
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);

const { policyCatalog } = await import("../src/data/policyLibrary.ts");
const { createSeed } = await import("../src/seed.ts");

const seed = createSeed();
const holidaysFor = (code) => seed.holidays.filter((h) => (h.countryCode ?? "IN") === code);

const policies = policyCatalog(holidaysFor).map((p) => {
  const scope = p.appliesTo === "all" ? {} : p.appliesTo;
  return {
    id: p.id,
    title: p.title,
    category: p.category,
    version: p.version,
    effective: p.effective,
    owner: p.owner,
    mandatory: p.mandatory,
    countries: scope.countries ?? [],
    legal_entities: scope.legalEntities ?? [],
    roles: scope.roles ?? [],
    employment: scope.employment ?? null,
    sections: p.sections.map((s) => ({ heading: s.heading, rules: s.rules })),
  };
});

writeFileSync(join(outDir, "policies.json"), JSON.stringify(policies, null, 2) + "\n", "utf8");
console.log(`policies.json: ${policies.length} policies`);
