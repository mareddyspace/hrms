import { todayISO } from "../../model.ts";
import { getPerson } from "../../data/peopleLocal.ts";
import {
  arrayOr,
  chainIdsOf,
  createLocalStore,
  isHr,
  isIsoDate,
  newId,
  type PlusActor,
  type PlusResult,
} from "./shared.ts";

export type QuestionKind = "rating" | "enps" | "text";

export interface SurveyQuestion {
  id: string;
  kind: QuestionKind;
  prompt: string;
}

export type SurveyAudience = { type: "all" } | { type: "department"; value: string } | { type: "country"; value: string };

export interface Survey {
  id: string;
  title: string;
  questions: SurveyQuestion[];
  audience: SurveyAudience;
  openDate: string;
  closeDate: string;
  published: boolean;
  createdBy: string;
  createdAt: string;
}

/** Anonymous: no employee id, no timestamp. `lineIds` lets managers see team aggregates only above the threshold. */
export interface SurveyResponse {
  id: string;
  surveyId: string;
  answers: Record<string, number | string>;
  department: string;
  country: string;
  lineIds: string[];
}

interface SurveyState {
  surveys: Survey[];
  responses: SurveyResponse[];
  /** surveyId → employee ids who already answered. Only used to stop double answers. */
  responded: Record<string, string[]>;
}

export const MIN_RESPONSES = 5;
export const ENPS_PROMPT = "How likely are you to recommend us as a place to work?";

export type SurveyPhase = "Draft" | "Scheduled" | "Open" | "Closed";

export function surveyPhase(survey: Survey, today = todayISO()): SurveyPhase {
  if (!survey.published) return "Draft";
  if (today < survey.openDate) return "Scheduled";
  if (today > survey.closeDate) return "Closed";
  return "Open";
}

/* ───────────── Seed ───────────── */

const PULSE_QUESTIONS: SurveyQuestion[] = [
  { id: "q1", kind: "rating", prompt: "I have the tools I need to do my job well" },
  { id: "q2", kind: "rating", prompt: "My manager gives me useful feedback" },
  { id: "q3", kind: "enps", prompt: ENPS_PROMPT },
  { id: "q4", kind: "text", prompt: "What one thing should we change?" },
];

const PULSE_ROWS: [number, number, number, string, string, string, string[]][] = [
  [5, 4, 10, "More focus time on Fridays", "Engineering", "India", ["emp-ram", "demo-ceo"]],
  [4, 4, 9, "", "Engineering", "India", ["emp-ram", "demo-ceo"]],
  [3, 2, 6, "Clearer promotion criteria", "Engineering", "India", ["emp-ram", "demo-ceo"]],
  [4, 5, 9, "Keep the hybrid policy", "Engineering", "India", ["emp-ram", "demo-ceo"]],
  [2, 3, 5, "Laptops are slow to replace", "Engineering", "India", ["emp-ram", "demo-ceo"]],
  [5, 5, 10, "", "Engineering", "India", ["emp-ram", "demo-ceo"]],
  [4, 3, 8, "Fewer status meetings", "Engineering", "India", ["emp-ram", "demo-ceo"]],
  [3, 4, 7, "", "People", "India", ["demo-hr-admin", "demo-ceo"]],
  [4, 4, 9, "Better onboarding buddies", "People", "India", ["demo-hr-admin", "demo-ceo"]],
  [5, 4, 10, "", "Product", "United States", ["demo-hiring-manager", "demo-ceo"]],
  [2, 2, 3, "Roadmap changes too often", "Product", "United States", ["demo-hiring-manager", "demo-ceo"]],
  [4, 5, 8, "", "Product", "United States", ["demo-hiring-manager", "demo-ceo"]],
  [3, 3, 6, "More learning budget", "Talent Acquisition", "United States", ["demo-hr-admin", "demo-ceo"]],
  [5, 4, 9, "", "IT", "United Kingdom", ["demo-ceo"]],
];

function defaults(): SurveyState {
  const closed: Survey = {
    id: "srv-pulse-q3",
    title: "Quarterly pulse — Q3 2026",
    questions: PULSE_QUESTIONS,
    audience: { type: "all" },
    openDate: "2026-09-01",
    closeDate: "2026-09-21",
    published: true,
    createdBy: "demo-hr-admin",
    createdAt: "2026-08-25",
  };
  const open: Survey = {
    id: "srv-hybrid-26",
    title: "Hybrid work check-in",
    questions: [
      { id: "h1", kind: "rating", prompt: "I can do focused work on office days" },
      { id: "h2", kind: "rating", prompt: "My team communicates well across locations" },
      { id: "h3", kind: "enps", prompt: ENPS_PROMPT },
      { id: "h4", kind: "text", prompt: "Anything else you want to share?" },
    ],
    audience: { type: "all" },
    openDate: "2026-10-12",
    closeDate: "2026-10-30",
    published: true,
    createdBy: "demo-hr-admin",
    createdAt: "2026-10-08",
  };
  const responses: SurveyResponse[] = PULSE_ROWS.map(([a, b, n, text, department, country, lineIds], i) => ({
    id: `rsp-seed-${i + 1}`,
    surveyId: closed.id,
    answers: (text ? { q1: a, q2: b, q3: n, q4: text } : { q1: a, q2: b, q3: n }) as Record<string, number | string>,
    department,
    country,
    lineIds,
  }));
  return {
    surveys: [open, closed],
    responses,
    responded: { [closed.id]: ["emp-mahesh", "emp-ram", "demo-recruiter", "demo-hiring-manager"] },
  };
}

function normalize(saved: unknown, base: SurveyState): SurveyState {
  const s = (saved ?? {}) as Partial<SurveyState>;
  const responded =
    s.responded && typeof s.responded === "object" && !Array.isArray(s.responded) ? (s.responded as SurveyState["responded"]) : base.responded;
  return {
    surveys: arrayOr(s.surveys, base.surveys),
    responses: arrayOr(s.responses, base.responses),
    responded,
  };
}

const store = createLocalStore<SurveyState>("kastech.surveys.v1", defaults, normalize);

export const subscribeSurveys = store.subscribe;
export const getSurveysState = store.getState;
export const resetSurveys = store.reset;

/* ───────────── Audience ───────────── */

function actorDepartment(actor: PlusActor): string {
  return getPerson(actor.id)?.department ?? actor.department ?? "";
}

function actorCountry(actor: PlusActor): string {
  return getPerson(actor.id)?.countryName ?? "";
}

export function isInAudience(survey: Survey, actor: PlusActor): boolean {
  if (survey.audience.type === "all") return true;
  if (survey.audience.type === "department") return actorDepartment(actor) === survey.audience.value;
  return actorCountry(actor) === survey.audience.value;
}

export function audienceLabel(audience: SurveyAudience): string {
  if (audience.type === "all") return "Everyone";
  return audience.type === "department" ? `Department: ${audience.value}` : `Country: ${audience.value}`;
}

export function hasResponded(surveyId: string, employeeId: string): boolean {
  return (getSurveysState().responded[surveyId] ?? []).includes(employeeId);
}

/* ───────────── HR: create and publish ───────────── */

export type SurveyDraftInput = {
  title: string;
  questions: { kind: QuestionKind; prompt: string }[];
  audience: SurveyAudience;
  openDate: string;
  closeDate: string;
};

function validateDraft(input: SurveyDraftInput, today: string): PlusResult {
  const title = input.title.trim();
  if (!title) return "Enter a survey title.";
  if (title.length > 120) return "Keep the title under 120 characters.";
  if (!input.questions.length) return "Add at least one question.";
  if (input.questions.length > 20) return "A survey can have at most 20 questions.";
  for (const [i, q] of input.questions.entries()) {
    if (!q.prompt.trim()) return `Question ${i + 1} needs wording.`;
    if (q.prompt.trim().length > 200) return `Question ${i + 1} is too long (200 characters max).`;
  }
  if (input.questions.filter((q) => q.kind === "enps").length > 1) return "Use only one eNPS question per survey.";
  if (input.audience.type !== "all" && !input.audience.value.trim()) return "Choose who the survey is for.";
  if (!isIsoDate(input.openDate)) return "Choose a valid open date.";
  if (!isIsoDate(input.closeDate)) return "Choose a valid close date.";
  if (input.openDate < today) return "The open date can't be in the past.";
  if (input.closeDate <= input.openDate) return "The close date must be after the open date.";
  return null;
}

export function createSurvey(actor: PlusActor, input: SurveyDraftInput, publish: boolean): PlusResult {
  if (!isHr(actor.role)) return "Only HR can create surveys.";
  const today = todayISO();
  const error = validateDraft(input, today);
  if (error) return error;
  return store.mutate((s) => {
    const title = input.title.trim();
    if (s.surveys.some((x) => x.title.toLowerCase() === title.toLowerCase())) return "A survey with this title already exists.";
    s.surveys.unshift({
      id: newId("srv"),
      title,
      questions: input.questions.map((q, i) => ({ id: `q${i + 1}`, kind: q.kind, prompt: q.prompt.trim() })),
      audience: input.audience.type === "all" ? { type: "all" } : { type: input.audience.type, value: input.audience.value.trim() },
      openDate: input.openDate,
      closeDate: input.closeDate,
      published: publish,
      createdBy: actor.id,
      createdAt: today,
    });
    return null;
  });
}

export function publishSurvey(actor: PlusActor, surveyId: string): PlusResult {
  if (!isHr(actor.role)) return "Only HR can publish surveys.";
  return store.mutate((s) => {
    const survey = s.surveys.find((x) => x.id === surveyId);
    if (!survey) return "Survey not found.";
    if (survey.published) return "This survey is already published.";
    const today = todayISO();
    if (survey.openDate < today) return "The open date has passed. Delete this draft and create it again with new dates.";
    if (survey.closeDate <= survey.openDate) return "The close date must be after the open date.";
    survey.published = true;
    return null;
  });
}

export function deleteDraftSurvey(actor: PlusActor, surveyId: string): PlusResult {
  if (!isHr(actor.role)) return "Only HR can delete surveys.";
  return store.mutate((s) => {
    const survey = s.surveys.find((x) => x.id === surveyId);
    if (!survey) return "Survey not found.";
    if (survey.published) return "Published surveys can't be deleted.";
    s.surveys = s.surveys.filter((x) => x.id !== surveyId);
    return null;
  });
}

/* ───────────── Employee: answer ───────────── */

export function submitResponse(actor: PlusActor, surveyId: string, answers: Record<string, number | string>): PlusResult {
  return store.mutate((s) => {
    const survey = s.surveys.find((x) => x.id === surveyId);
    if (!survey) return "Survey not found.";
    const phase = surveyPhase(survey);
    if (phase === "Draft") return "This survey isn't published.";
    if (phase === "Scheduled") return "This survey isn't open yet.";
    if (phase === "Closed") return "This survey is closed.";
    if (!isInAudience(survey, actor)) return "This survey isn't open to you.";
    const done = s.responded[surveyId] ?? [];
    if (done.includes(actor.id)) return "You've already answered this survey.";

    const clean: Record<string, number | string> = {};
    for (const [i, q] of survey.questions.entries()) {
      const value = answers[q.id];
      if (q.kind === "text") {
        const text = typeof value === "string" ? value.trim() : "";
        if (text.length > 1000) return `Answer ${i + 1} is too long (1000 characters max).`;
        if (text) clean[q.id] = text;
        continue;
      }
      const max = q.kind === "enps" ? 10 : 5;
      const min = q.kind === "enps" ? 0 : 1;
      if (typeof value !== "number" || !Number.isInteger(value)) return `Answer question ${i + 1}.`;
      if (value < min || value > max) return `Question ${i + 1} needs a score from ${min} to ${max}.`;
      clean[q.id] = value;
    }

    const response: SurveyResponse = {
      id: newId("rsp"),
      surveyId,
      answers: clean,
      department: actorDepartment(actor) || "Unknown",
      country: actorCountry(actor) || "Unknown",
      lineIds: chainIdsOf(actor.id),
    };
    // Insert at a random position so storage order can't be matched to who answered when.
    const at = Math.floor(Math.random() * (s.responses.length + 1));
    s.responses.splice(at, 0, response);
    s.responded[surveyId] = [...done, actor.id];
    return null;
  });
}

/* ───────────── Results ───────────── */

export type QuestionResult =
  | { question: SurveyQuestion; kind: "rating"; average: number; counts: number[]; answered: number }
  | { question: SurveyQuestion; kind: "enps"; score: number; promoters: number; passives: number; detractors: number; answered: number }
  | { question: SurveyQuestion; kind: "text"; comments: string[] };

export function enpsScore(scores: number[]): { score: number; promoters: number; passives: number; detractors: number } {
  const promoters = scores.filter((n) => n >= 9).length;
  const detractors = scores.filter((n) => n <= 6).length;
  const passives = scores.length - promoters - detractors;
  const score = scores.length ? Math.round(((promoters - detractors) / scores.length) * 100) : 0;
  return { score, promoters, passives, detractors };
}

export function summarize(survey: Survey, responses: SurveyResponse[]): QuestionResult[] {
  return survey.questions.map((question) => {
    const values = responses.map((r) => r.answers[question.id]).filter((v) => v !== undefined);
    if (question.kind === "text") {
      const comments = values.filter((v): v is string => typeof v === "string" && v.length > 0);
      // Sort so the order doesn't follow submission order.
      return { question, kind: "text", comments: [...comments].sort((a, b) => a.localeCompare(b)) };
    }
    const nums = values.filter((v): v is number => typeof v === "number");
    if (question.kind === "enps") return { question, kind: "enps", ...enpsScore(nums), answered: nums.length };
    const counts = [1, 2, 3, 4, 5].map((n) => nums.filter((v) => v === n).length);
    const average = nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : 0;
    return { question, kind: "rating", average, counts, answered: nums.length };
  });
}

export type ResultsAccess =
  | { scope: "all"; responses: SurveyResponse[] }
  | { scope: "team"; responses: SurveyResponse[] }
  | { scope: "too-few"; count: number }
  | { scope: "none" };

/** HR sees everything; anyone else sees only their reporting line, and only at or above the anonymity threshold. */
export function resultsFor(actor: PlusActor, surveyId: string): ResultsAccess {
  const all = getSurveysState().responses.filter((r) => r.surveyId === surveyId);
  if (isHr(actor.role)) return { scope: "all", responses: all };
  const team = all.filter((r) => r.lineIds.includes(actor.id));
  if (!team.length) return { scope: "none" };
  if (team.length < MIN_RESPONSES) return { scope: "too-few", count: team.length };
  return { scope: "team", responses: team };
}
