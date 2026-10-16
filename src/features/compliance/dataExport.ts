import { getPerson } from "../../data/peopleLocal.ts";
import { documentsForPerson, IMMIGRATION_KEY } from "./immigrationStore.ts";
import { CONSENT_TOPICS, getPrivacyState, PRIVACY_KEY } from "./privacyStore.ts";
import { casesForExport, GRIEVANCE_KEY } from "./grievanceStore.ts";
import { bgvSummaryForPerson, BGV_KEY } from "./bgvStore.ts";
import { privacyLawFor, personCountry, type ComplianceActor } from "./shared.ts";

/** Keys never read for the export: credentials, sessions and UI preferences. */
const SKIP_KEY = /pass(word)?|session|login|otp|lock|remember|token|secret|theme|sidebar|migrate/i;
/** Fields stripped from any exported record. */
const SECRET_FIELD = /pass(word)?|otp|token|secret|pin$/i;
/** Fields that tie a record to its owner. */
const OWNER_FIELDS = [
  "id",
  "employeeId",
  "employeeCode",
  "personId",
  "ownerId",
  "userId",
  "requesterId",
  "applicantId",
  "fromId",
  "toId",
  "email",
  "fullName",
  "employeeName",
  "ownerName",
  "name",
];
/** Compliance stores are exported explicitly, with their own visibility rules. */
const HANDLED_KEYS = new Set([IMMIGRATION_KEY, PRIVACY_KEY, GRIEVANCE_KEY, BGV_KEY]);

type Identity = Set<string>;

function identityFor(actor: ComplianceActor): Identity {
  const person = getPerson(actor.id);
  const values = [actor.id, actor.fullName, actor.email, person?.employeeCode, person?.email, person?.personalEmail, person?.fullName];
  return new Set(values.filter((v): v is string => !!v && v.trim().length > 0).map((v) => v.trim().toLowerCase()));
}

function belongsTo(record: Record<string, unknown>, me: Identity): boolean {
  return OWNER_FIELDS.some((field) => {
    const value = record[field];
    return typeof value === "string" && me.has(value.trim().toLowerCase());
  });
}

function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_FIELD.test(k)) continue;
      out[k] = stripSecrets(v);
    }
    return out;
  }
  return value;
}

/** Collects list items (records) that belong to the person, anywhere in a stored value. */
function collect(node: unknown, me: Identity, path: string, out: { path: string; record: unknown }[]) {
  if (Array.isArray(node)) {
    node.forEach((item, index) => {
      if (item && typeof item === "object" && !Array.isArray(item) && belongsTo(item as Record<string, unknown>, me)) {
        out.push({ path, record: stripSecrets(item) });
      } else {
        collect(item, me, `${path}[${index}]`, out);
      }
    });
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) collect(v, me, path ? `${path}.${k}` : k, out);
  }
}

function otherStores(me: Identity): Record<string, { path: string; record: unknown }[]> {
  const result: Record<string, { path: string; record: unknown }[]> = {};
  let keys: string[] = [];
  try {
    keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((k): k is string => !!k);
  } catch {
    return result;
  }
  for (const key of keys.sort()) {
    if (HANDLED_KEYS.has(key) || SKIP_KEY.test(key)) continue;
    let parsed: unknown;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const found: { path: string; record: unknown }[] = [];
    collect(parsed, me, "", found);
    if (found.length) result[key] = found;
  }
  return result;
}

export function buildMyDataExport(actor: ComplianceActor) {
  const me = identityFor(actor);
  const person = getPerson(actor.id);
  const country = personCountry(actor.id);
  const privacy = getPrivacyState();
  const labelOf = (key: string) => CONSENT_TOPICS.find((t) => t.key === key)?.label ?? key;

  const idDocuments = documentsForPerson(actor.id).map(({ verifiedById: _v, updatedById: _u, ...doc }) => doc);
  const consents = privacy.consents.filter((c) => c.personId === actor.id).map((c) => ({ consent: labelOf(c.key), granted: c.granted, at: c.at }));
  const dataRequests = privacy.requests.filter((r) => r.personId === actor.id).map(({ handledById: _h, ...r }) => r);
  const cases = casesForExport(actor.id);
  const backgroundVerification = bgvSummaryForPerson(actor);
  const stores = otherStores(me);

  const summary = [
    { section: "Profile", count: person ? 1 : 0 },
    { section: "ID documents", count: idDocuments.length },
    { section: "Consents", count: consents.length },
    { section: "Data requests", count: dataRequests.length },
    { section: "Cases you raised", count: cases.length },
    { section: "Background verification", count: backgroundVerification.length },
    ...Object.entries(stores).map(([key, rows]) => ({ section: `App data · ${key}`, count: rows.length })),
  ];

  return {
    exportedAt: new Date().toISOString(),
    subject: { id: actor.id, name: actor.fullName, employeeCode: person?.employeeCode, email: person?.email ?? actor.email },
    applicableLaw: privacyLawFor(country.code),
    profile: person ? stripSecrets(person) : null,
    idDocuments,
    consents,
    dataRequests,
    cases,
    backgroundVerification,
    appData: stores,
    summary,
  };
}

export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
