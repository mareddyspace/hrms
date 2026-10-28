/**
 * Engagement surveys and recognition from the backend (VITE_API_URL mode only).
 * Maps backend/app/routers/engagement.py shapes into the stores' own shapes.
 */
import { TIMEZ_COUNTRIES } from "../model.ts";
import { api, type MeOut } from "./client.ts";
import type {
  ApiSurveyResults,
  EngagementPoint,
  QuestionKind,
  QuestionResult,
  Survey,
  SurveyAudience,
  SurveyState,
} from "../features/talentplus/surveysStore.ts";
import type { Kudos, Redemption, RedemptionStatus, RecognitionState, Reward } from "../features/recognition/recognitionStore.ts";
import type { PraiseBadge } from "../data/talentData.ts";

const RESULT_ROLES = new Set(["hr", "hr_admin", "hrbp", "admin", "executive"]);
const HR_ROLES = new Set(["hr", "hr_admin", "hrbp"]);

const enc = encodeURIComponent;

/* ───────── Surveys ───────── */

interface SurveyApi {
  id: string;
  title: string;
  kind: string;
  questions: { id: string; kind: QuestionKind; prompt: string }[];
  anonymous: boolean;
  audience_type: "all" | "department" | "country";
  audience_value: string | null;
  open_date: string;
  close_date: string;
  published: boolean;
  closed_at: string | null;
  phase: string;
  responded: boolean;
}

interface BucketApi {
  name: string;
  responses: number;
  suppressed: boolean;
  engagement: number | null;
  enps: number | null;
}

interface ResultsApi {
  survey_id: string;
  phase: string;
  responses: number;
  audience: number;
  participation_pct: number;
  threshold: number;
  suppressed: boolean;
  engagement: number | null;
  enps: number | null;
  questions: Record<string, unknown>[];
  departments: BucketApi[];
  countries: BucketApi[];
}

interface TrendApi {
  survey_id: string;
  title: string;
  kind: string;
  closed_on: string;
  responses: number;
  participation_pct: number;
  engagement: number | null;
  enps: number | null;
}

const countryName = (code: string) => TIMEZ_COUNTRIES.find((c) => c.code === code)?.name ?? code;
const countryCode = (name: string) => TIMEZ_COUNTRIES.find((c) => c.name === name)?.code ?? name;

function toSurvey(s: SurveyApi): Survey {
  const audience: SurveyAudience =
    s.audience_type === "department" && s.audience_value
      ? { type: "department", value: s.audience_value }
      : s.audience_type === "country" && s.audience_value
        ? { type: "country", value: countryName(s.audience_value) }
        : { type: "all" };
  return {
    id: s.id,
    title: s.title,
    questions: s.questions.map((q) => ({ id: q.id, kind: q.kind, prompt: q.prompt })),
    audience,
    openDate: s.open_date,
    closeDate: s.close_date,
    published: s.published,
    createdBy: "",
    createdAt: "",
    ...(s.closed_at ? { closedAt: s.closed_at } : {}),
  };
}

function toResults(survey: Survey, r: ResultsApi): ApiSurveyResults {
  const questions: QuestionResult[] = [];
  for (const raw of r.questions) {
    const question = survey.questions.find((q) => q.id === raw.id);
    if (!question) continue;
    if (raw.kind === "text") {
      questions.push({ question, kind: "text", comments: (raw.comments as string[]) ?? [] });
    } else if (raw.kind === "enps") {
      const answered = Number(raw.answered ?? 0);
      const promoters = Number(raw.promoters ?? 0);
      const detractors = Number(raw.detractors ?? 0);
      questions.push({ question, kind: "enps", score: Number(raw.score ?? 0), promoters, detractors, passives: answered - promoters - detractors, answered });
    } else {
      questions.push({ question, kind: "rating", average: Number(raw.average ?? 0), counts: (raw.counts as number[]) ?? [0, 0, 0, 0, 0], answered: Number(raw.answered ?? 0) });
    }
  }
  const bucket = (b: BucketApi) => ({ name: b.name, responses: b.responses, suppressed: b.suppressed, engagement: b.engagement, enps: b.enps });
  return {
    surveyId: r.survey_id,
    phase: r.phase,
    responses: r.responses,
    audience: r.audience,
    participationPct: r.participation_pct,
    threshold: r.threshold,
    suppressed: r.suppressed,
    engagement: r.engagement,
    enps: r.enps,
    questions,
    departments: r.departments.map(bucket),
    countries: r.countries.map((b) => ({ ...bucket(b), name: countryName(b.name) })),
  };
}

export async function loadApiSurveys(accountId: string): Promise<SurveyState> {
  const [me, rows] = await Promise.all([api.get<MeOut>("/auth/me"), api.get<SurveyApi[]>("/surveys")]);
  const who = me.employee_id ?? accountId;
  const surveys = rows.map(toSurvey);
  const responded: Record<string, string[]> = {};
  for (const r of rows) if (r.responded) responded[r.id] = [who];
  const state: SurveyState = { surveys, responses: [], responded, apiResults: {}, apiTrend: [] };
  if (RESULT_ROLES.has(me.role)) {
    const published = surveys.filter((s) => s.published);
    const [results, trend] = await Promise.all([
      Promise.all(published.map((s) => api.get<ResultsApi>(`/surveys/${enc(s.id)}/results`).then((r) => toResults(s, r)))),
      api.get<TrendApi[]>("/surveys/trend"),
    ]);
    for (const r of results) state.apiResults![r.surveyId] = r;
    state.apiTrend = trend.map(
      (p): EngagementPoint => ({
        surveyId: p.survey_id,
        title: p.title,
        closedOn: p.closed_on,
        responses: p.responses,
        engagement: p.engagement,
        enps: p.enps,
        departments: (state.apiResults![p.survey_id]?.departments ?? []).map((d) => ({
          department: d.name,
          responses: d.responses,
          engagement: d.engagement,
          enps: d.enps,
        })),
      }),
    );
  }
  return state;
}

export async function apiCreateSurvey(
  input: { title: string; questions: { kind: QuestionKind; prompt: string }[]; audience: SurveyAudience; openDate: string; closeDate: string },
  publish: boolean,
) {
  await api.post("/surveys", {
    title: input.title.trim(),
    kind: "pulse",
    anonymous: true,
    questions: input.questions.map((q) => ({ kind: q.kind, prompt: q.prompt.trim() })),
    audience_type: input.audience.type,
    audience_value:
      input.audience.type === "all" ? null : input.audience.type === "country" ? countryCode(input.audience.value) : input.audience.value,
    open_date: input.openDate,
    close_date: input.closeDate,
    publish,
  });
}

export const apiPublishSurvey = (id: string) => api.post(`/surveys/${enc(id)}/publish`);
export const apiCloseSurvey = (id: string) => api.post(`/surveys/${enc(id)}/close`);
export const apiAnswerSurvey = (id: string, answers: Record<string, number | string>) =>
  api.post(`/surveys/${enc(id)}/responses`, { answers });

/* ───────── Recognition ───────── */

interface KudosApi {
  id: string;
  from_id: string;
  from_name: string | null;
  to_id: string;
  to_name: string | null;
  value: string;
  message: string;
  points: number;
  created_at: string;
  likes: number;
  liked_by_me: boolean;
}

interface PointsApi {
  employee_id: string;
  received: number;
  spent: number;
  balance: number;
  given_this_month: number;
  allowance_left: number;
}

interface RewardApi {
  id: string;
  name: string;
  description: string;
  points: number;
  needs_date: boolean;
}

interface RedemptionApi {
  id: string;
  employee_id: string;
  employee_name: string | null;
  reward_id: string;
  reward_name: string | null;
  points: number;
  note: string;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
}

function toKudos(k: KudosApi, me: string): Kudos {
  // The API gives a like count and whether I liked it; others stay anonymous placeholders.
  const others = Math.max(0, k.likes - (k.liked_by_me ? 1 : 0));
  return {
    id: k.id,
    fromId: k.from_id,
    fromName: k.from_name ?? k.from_id,
    toId: k.to_id,
    toName: k.to_name ?? k.to_id,
    value: k.value as PraiseBadge,
    message: k.message,
    points: k.points,
    createdOn: k.created_at.slice(0, 10),
    createdAt: k.created_at,
    likes: [...(k.liked_by_me ? [me] : []), ...Array.from({ length: others }, (_, i) => `like-${k.id}-${i}`)],
  };
}

function toRedemption(r: RedemptionApi, nameOf: (id: string) => string | undefined): Redemption {
  return {
    id: r.id,
    personId: r.employee_id,
    personName: r.employee_name ?? r.employee_id,
    rewardId: r.reward_id,
    rewardName: r.reward_name ?? r.reward_id,
    points: r.points,
    note: r.note,
    status: r.status as RedemptionStatus,
    requestedOn: r.created_at.slice(0, 10),
    decidedByName: r.decided_by ? (nameOf(r.decided_by) ?? r.decided_by) : undefined,
    decidedOn: r.decided_at ? r.decided_at.slice(0, 10) : undefined,
    decisionNote: r.decision_note ?? undefined,
  };
}

export async function loadApiRecognition(accountId: string, praiseLikes: Record<string, string[]>): Promise<RecognitionState> {
  const me = await api.get<MeOut>("/auth/me");
  const who = me.employee_id ?? accountId;
  const hr = HR_ROLES.has(me.role);
  const [kudos, points, rewards, mine, all] = await Promise.all([
    api.get<KudosApi[]>("/recognition/kudos", { limit: 200 }),
    api.get<PointsApi>("/recognition/points"),
    api.get<RewardApi[]>("/recognition/rewards"),
    api.get<RedemptionApi[]>("/recognition/redemptions", { view: "mine" }),
    hr ? api.get<RedemptionApi[]>("/recognition/redemptions", { view: "all" }) : Promise.resolve([] as RedemptionApi[]),
  ]);
  const names = new Map<string, string>();
  for (const k of kudos) {
    if (k.from_name) names.set(k.from_id, k.from_name);
    if (k.to_name) names.set(k.to_id, k.to_name);
  }
  for (const r of [...mine, ...all]) if (r.employee_name) names.set(r.employee_id, r.employee_name);
  if (me.employee_id && me.full_name) names.set(me.employee_id, me.full_name);
  const seen = new Set<string>();
  const redemptions = [...all, ...mine]
    .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((r) => toRedemption(r, (id) => names.get(id)));
  return {
    kudos: kudos.map((k) => toKudos(k, who)),
    redemptions,
    praiseLikes,
    apiPoints: {
      personId: points.employee_id,
      received: points.received,
      spent: points.spent,
      balance: points.balance,
      givenThisMonth: points.given_this_month,
      allowanceLeft: points.allowance_left,
    },
    apiRewards: rewards.map((r): Reward => ({ id: r.id, name: r.name, description: r.description, points: r.points, needsDate: r.needs_date || undefined })),
  };
}

export const apiGiveKudos = (input: { toId: string; value: string; message: string; points: number }) =>
  api.post("/recognition/kudos", { to_id: input.toId, value: input.value, message: input.message.trim().replace(/\s+/g, " "), points: input.points });
export const apiToggleKudosLike = (id: string) => api.post(`/recognition/kudos/${enc(id)}/like`);
export const apiRedeem = (rewardId: string, note: string) => api.post("/recognition/redemptions", { reward_id: rewardId, note: note.trim() });
export const apiCancelRedemption = (id: string) => api.post(`/recognition/redemptions/${enc(id)}/cancel`);
export const apiDecideRedemption = (id: string, fulfil: boolean, note: string) =>
  api.post(`/recognition/redemptions/${enc(id)}/decision`, { decision: fulfil ? "fulfil" : "decline", note: note.trim() || null });
