/**
 * Backend mode for the employee experience pages: company assets (/assets), immigration and ID documents
 * (/immigration) and the privacy centre (/privacy). Rules live on the server (backend/app/services/experience.py);
 * the mirrors only hold what the signed-in person may see.
 */
import { api, apiRequest, apiSessionMe, isApiAdmin, isApiHr } from "./client.ts";
import { createApiMirror, errorText } from "./syncOps.ts";

const enc = encodeURIComponent;

export type HistoryEntry = { at: string; action: string; by_name: string; note: string | null; status: string | null };

/* ───────────── assets ───────────── */
export type AssetRow = {
  id: string;
  tag: string;
  name: string;
  category: string;
  serial_no: string | null;
  status: "in_stock" | "assigned" | "in_repair" | "lost" | "retired";
  employee_id: string | null;
  employee_name: string | null;
  assigned_on: string | null;
  condition: string;
  country_code: string | null;
  notes: string | null;
  history: HistoryEntry[];
};

export type AssetRequestKind = "new" | "repair" | "lost" | "return";

export type AssetRequestRow = {
  id: string;
  employee_id: string;
  employee_name: string;
  kind: AssetRequestKind;
  category: string;
  item: string;
  reason: string;
  needed_by: string | null;
  asset_id: string | null;
  status: string;
  manager_name: string | null;
  decision_note: string | null;
  created_at: string;
  closed_on: string | null;
  history: HistoryEntry[];
  can_cancel: boolean;
  can_approve: boolean;
  can_complete: boolean;
};

export type AssetMeta = { categories: string[]; conditions: string[]; is_it: boolean; is_hr: boolean; has_team: boolean };

export type AssetsState = {
  meta: AssetMeta;
  mine: AssetRow[];
  team: AssetRow[];
  inventory: AssetRow[];
  myRequests: AssetRequestRow[];
  manage: AssetRequestRow[];
};

const emptyAssets = (): AssetsState => ({
  meta: { categories: [], conditions: [], is_it: false, is_hr: false, has_team: false },
  mine: [],
  team: [],
  inventory: [],
  myRequests: [],
  manage: [],
});

export const assetsMirror = createApiMirror<AssetsState>(emptyAssets, async () => {
  const meta = await api.get<AssetMeta>("/assets/meta");
  const elevated = meta.is_it || meta.is_hr || meta.has_team;
  const [mine, team, inventory, myRequests, manage] = await Promise.all([
    api.get<AssetRow[]>("/assets", { view: "mine" }),
    elevated ? api.get<AssetRow[]>("/assets", { view: "team" }) : Promise.resolve([] as AssetRow[]),
    meta.is_it ? api.get<AssetRow[]>("/assets", { view: "all" }) : Promise.resolve([] as AssetRow[]),
    api.get<AssetRequestRow[]>("/assets/requests", { view: "mine" }),
    elevated ? api.get<AssetRequestRow[]>("/assets/requests", { view: "manage" }) : Promise.resolve([] as AssetRequestRow[]),
  ]);
  return { meta, mine, team, inventory, myRequests, manage };
});

/** Runs a change and reloads the assets mirror; resolves to null or the error message. */
async function runAssets(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return errorText(e);
  } finally {
    await assetsMirror.reload();
  }
}

export const assetsApi = {
  request: (input: { kind: AssetRequestKind; category?: string; item?: string; reason: string; assetId?: string; neededBy?: string }) =>
    runAssets(() =>
      api.post("/assets/requests", {
        kind: input.kind,
        category: input.category ?? "",
        item: input.item ?? "",
        reason: input.reason.trim(),
        asset_id: input.assetId || null,
        needed_by: input.neededBy || null,
      }),
    ),
  managerDecision: (id: string, approve: boolean, note: string) =>
    runAssets(() => api.post(`/assets/requests/${enc(id)}/manager-decision`, { approve, note: note.trim() })),
  complete: (id: string, action: "fulfil" | "resolve" | "receive" | "reject", note: string, assetId?: string, condition?: string) =>
    runAssets(() =>
      api.post(`/assets/requests/${enc(id)}/complete`, { action, note: note.trim(), asset_id: assetId || null, condition: condition || null }),
    ),
  cancel: (id: string) => runAssets(() => api.post(`/assets/requests/${enc(id)}/cancel`)),
  save: (input: { tag: string; name: string; category: string; serial_no?: string; condition: string; country_code?: string; notes?: string }, id?: string) =>
    runAssets(() =>
      id ? apiRequest(`/assets/${enc(id)}`, { method: "PUT", body: input }) : api.post("/assets", input),
    ),
  assign: (id: string, employeeId: string, note: string) => runAssets(() => api.post(`/assets/${enc(id)}/assign`, { employee_id: employeeId, note })),
  recover: (id: string, condition: string, note: string) => runAssets(() => api.post(`/assets/${enc(id)}/recover`, { condition, note })),
  retire: (id: string, note: string) => runAssets(() => api.post(`/assets/${enc(id)}/retire`, { note })),
};

/* ───────────── immigration documents ───────────── */
export type ApiDocument = {
  id: string;
  employee_id: string;
  employee_name: string;
  country_code: string;
  doc_type: string;
  number: string;
  number_masked: boolean;
  issuing_country: string;
  issue_date: string;
  expiry_date: string;
  days_left: number;
  status: string;
  sponsor: string | null;
  renewal_in_progress: boolean;
  verification: "pending" | "verified" | "rejected";
  verification_note: string | null;
  verified_by_name: string | null;
  verified_on: string | null;
  updated_on: string;
  history: HistoryEntry[];
  can_edit: boolean;
  can_verify: boolean;
  can_remove: boolean;
};

type ImmigrationMeta = { is_hr: boolean; has_team: boolean };
export type ApiImmigrationState = { meta: ImmigrationMeta; mine: ApiDocument[]; team: ApiDocument[]; all: ApiDocument[] };

export const immigrationMirror = createApiMirror<ApiImmigrationState>(
  () => ({ meta: { is_hr: false, has_team: false }, mine: [], team: [], all: [] }),
  async () => {
    const meta = await api.get<ImmigrationMeta>("/immigration/meta");
    const [mine, team, all] = await Promise.all([
      api.get<ApiDocument[]>("/immigration/documents", { view: "mine" }),
      meta.has_team ? api.get<ApiDocument[]>("/immigration/documents", { view: "team" }) : Promise.resolve([] as ApiDocument[]),
      meta.is_hr ? api.get<ApiDocument[]>("/immigration/documents", { view: "all" }) : Promise.resolve([] as ApiDocument[]),
    ]);
    return { meta, mine, team, all };
  },
);

async function runImmigration(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return errorText(e);
  } finally {
    await immigrationMirror.reload();
  }
}

export type ApiDocInput = {
  personId: string;
  type: string;
  number: string;
  issuingCountry: string;
  issueDate: string;
  expiryDate: string;
  sponsor: string;
  recordExpired: boolean;
};

const docBody = (input: ApiDocInput) => ({
  employee_id: input.personId || null,
  doc_type: input.type,
  number: input.number.trim(),
  issuing_country: input.issuingCountry,
  issue_date: input.issueDate,
  expiry_date: input.expiryDate,
  sponsor: input.sponsor.trim() || null,
  record_expired: input.recordExpired,
});

export const immigrationApi = {
  add: (input: ApiDocInput) => runImmigration(() => api.post("/immigration/documents", docBody(input))),
  update: (id: string, input: ApiDocInput) =>
    runImmigration(() => apiRequest(`/immigration/documents/${enc(id)}`, { method: "PUT", body: docBody(input) })),
  verify: (id: string, approve: boolean, note: string) =>
    runImmigration(() => api.post(`/immigration/documents/${enc(id)}/verify`, { approve, note: note.trim() })),
  renewal: (id: string, value: boolean) => runImmigration(() => api.post(`/immigration/documents/${enc(id)}/renewal`, { value, note: "" })),
  remove: (id: string) => runImmigration(() => apiRequest(`/immigration/documents/${enc(id)}`, { method: "DELETE" })),
};

/* ───────────── privacy ───────────── */
export type ApiConsent = { topic: string; granted: boolean; at: string | null };
export type ApiPrivacyRequest = {
  id: string;
  employee_id: string;
  employee_name: string;
  country_code: string;
  kind: "Access" | "Correction" | "Deletion";
  details: string;
  created_on: string;
  due_on: string;
  status: string;
  handled_by_name: string | null;
  closed_on: string | null;
  outcome: string | null;
  history: HistoryEntry[];
  can_handle: boolean;
  can_withdraw: boolean;
};
export type ApiRetention = { id: string; category: string; period: number; unit: "months" | "years"; legal_basis: string; updated_on: string };
export type ApiPrivacyState = {
  /** My employee id (consents carry no owner field). */
  me: string;
  current: ApiConsent[];
  history: ApiConsent[];
  mine: ApiPrivacyRequest[];
  queue: ApiPrivacyRequest[];
  retention: ApiRetention[];
};

export const privacyMirror = createApiMirror<ApiPrivacyState>(
  () => ({ me: "", current: [], history: [], mine: [], queue: [], retention: [] }),
  async (accountId) => {
    const who = await apiSessionMe();
    const hr = isApiHr(who.role) || isApiAdmin(who.role);
    const me = who.employee_id ?? accountId;
    const [consents, mine, queue, retention] = await Promise.all([
      api.get<{ current: ApiConsent[]; history: ApiConsent[] }>("/privacy/consents").catch(() => ({ current: [], history: [] })),
      api.get<ApiPrivacyRequest[]>("/privacy/requests", { view: "mine" }),
      hr ? api.get<ApiPrivacyRequest[]>("/privacy/requests", { view: "queue" }) : Promise.resolve([] as ApiPrivacyRequest[]),
      api.get<ApiRetention[]>("/privacy/retention"),
    ]);
    return { me, current: consents.current, history: consents.history, mine, queue, retention };
  },
);

async function runPrivacy(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return errorText(e);
  } finally {
    await privacyMirror.reload();
  }
}

export const privacyApi = {
  consent: (topic: string, granted: boolean) => runPrivacy(() => apiRequest(`/privacy/consents/${enc(topic)}`, { method: "PUT", body: { granted } })),
  raise: (kind: string, details: string) => runPrivacy(() => api.post("/privacy/requests", { kind, details: details.trim() })),
  withdraw: (id: string) => runPrivacy(() => api.post(`/privacy/requests/${enc(id)}/withdraw`)),
  move: (id: string, status: string, outcome: string) => runPrivacy(() => api.post(`/privacy/requests/${enc(id)}/move`, { status, outcome: outcome.trim() })),
  saveRetention: (input: { category: string; period: number; unit: string; legalBasis: string }, id?: string) =>
    runPrivacy(() => {
      const body = { category: input.category.trim(), period: input.period, unit: input.unit, legal_basis: input.legalBasis };
      return id ? apiRequest(`/privacy/retention/${enc(id)}`, { method: "PUT", body }) : api.post("/privacy/retention", body);
    }),
  removeRetention: (id: string) => runPrivacy(() => apiRequest(`/privacy/retention/${enc(id)}`, { method: "DELETE" })),
  /** The server's copy of everything it holds about me (audited on the server). */
  myData: () => apiRequest<Record<string, unknown> & { summary: { section: string; count: number }[] }>("/privacy/my-data"),
};

/* ───────────── internal jobs: referrals and applicant actions ───────────── */
export type MyReferralRow = {
  id: string;
  requisition_id: string;
  title: string;
  name: string;
  email: string;
  stage: string;
  referred_on: string;
  updated_on: string;
};

/** People I referred (stage from the job's pipeline). */
export const myReferralsMirror = createApiMirror<MyReferralRow[]>(() => [], () => api.get<MyReferralRow[]>("/recruiting/my-referrals"));

export const jobsApi = {
  refer: async (reqId: string, input: { name: string; email: string; phone: string; relationship: string; linkedIn: string; note: string }) => {
    try {
      await api.post(`/recruiting/requisitions/${enc(reqId)}/refer`, {
        name: input.name.trim(),
        email: input.email.trim(),
        phone: input.phone.trim() || null,
        relationship: input.relationship,
        linkedin: input.linkedIn.trim() || null,
        note: input.note.trim() || null,
      });
      return null;
    } catch (e) {
      return errorText(e);
    } finally {
      await myReferralsMirror.reload();
    }
  },
  /** Take back my internal application (before an offer). */
  withdraw: async (candidateId: string, reload: () => Promise<void>) => {
    try {
      await api.post(`/recruiting/my-applications/${enc(candidateId)}/withdraw`);
      return null;
    } catch (e) {
      return errorText(e);
    } finally {
      await reload();
    }
  },
};
