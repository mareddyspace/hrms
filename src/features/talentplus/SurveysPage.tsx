import { useMemo, useState, useSyncExternalStore } from "react";
import {
  Banner,
  Card,
  DataTable,
  EmptyState,
  Field,
  MetricCard,
  MetricGrid,
  Page,
  StatusBadge,
  Tabs,
} from "../../components/ui.tsx";
import { TIMEZ_COUNTRIES, formatShortDate, todayISO } from "../../model.ts";
import { listPeople, subscribePeople } from "../../data/peopleLocal.ts";
import { isHr } from "./shared.ts";
import { useActor } from "./useActor.ts";
import {
  ENPS_PROMPT,
  MIN_RESPONSES,
  audienceLabel,
  createSurvey,
  deleteDraftSurvey,
  getSurveysState,
  hasResponded,
  isInAudience,
  publishSurvey,
  resultsFor,
  submitResponse,
  subscribeSurveys,
  summarize,
  surveyPhase,
  type QuestionKind,
  type QuestionResult,
  type Survey,
  type SurveyAudience,
  type SurveyPhase,
  type SurveyResponse,
} from "./surveysStore.ts";
import "./talentplus.css";

type Msg = { tone: "ok" | "err" | "warn" | "info"; text: string } | null;

const PHASE_TONE: Record<SurveyPhase, "ok" | "warn" | "neutral" | "info"> = {
  Draft: "neutral",
  Scheduled: "info",
  Open: "ok",
  Closed: "neutral",
};

function PhaseBadge({ survey }: { survey: Survey }) {
  const phase = surveyPhase(survey);
  return <StatusBadge status={phase} tone={PHASE_TONE[phase]} literal />;
}

export function EngagementSurveysPage() {
  const actor = useActor();
  const state = useSyncExternalStore(subscribeSurveys, getSurveysState);
  const hr = isHr(actor.role);
  const [tab, setTab] = useState("open");
  const tabs = [
    { id: "open", label: "Open surveys" },
    { id: "results", label: hr ? "Results" : "Team results" },
    ...(hr ? [{ id: "manage", label: "Manage" }] : []),
  ];

  return (
    <Page title="Engagement surveys">
      <Tabs tabs={tabs} value={tabs.some((t) => t.id === tab) ? tab : "open"} onChange={setTab} />
      {tab === "open" && <OpenSurveys surveys={state.surveys} />}
      {tab === "results" && <Results surveys={state.surveys} />}
      {tab === "manage" && hr && <Manage surveys={state.surveys} />}
    </Page>
  );
}

/* ───────────── Answer ───────────── */

function OpenSurveys({ surveys }: { surveys: Survey[] }) {
  const actor = useActor();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const mine = surveys.filter((s) => surveyPhase(s) === "Open" && isInAudience(s, actor));
  const active = mine.find((s) => s.id === activeId) ?? null;

  if (active && !hasResponded(active.id, actor.id)) {
    return (
      <AnswerForm
        survey={active}
        onCancel={() => setActiveId(null)}
        onDone={() => {
          setActiveId(null);
          setMsg({ tone: "ok", text: "Thanks — your answers were submitted anonymously." });
        }}
      />
    );
  }

  return (
    <Card title="Surveys for you">
      <Banner message={msg} />
      {mine.length ? (
        <ul className="approval-list">
          {mine.map((s) => {
            const done = hasResponded(s.id, actor.id);
            return (
              <li key={s.id} className="approval-item">
                <div className="row-between">
                  <strong>{s.title}</strong>
                  {done ? <StatusBadge status="Submitted" tone="ok" literal /> : <PhaseBadge survey={s} />}
                </div>
                <p className="muted">
                  {s.questions.length} questions · closes {formatShortDate(s.closeDate)}
                </p>
                {!done && (
                  <div className="approval-actions">
                    <button type="button" className="btn btn-tiny" onClick={() => { setMsg(null); setActiveId(s.id); }}>
                      Answer survey
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState title="No open surveys" description="You'll see surveys here when HR opens one for you." />
      )}
    </Card>
  );
}

function Scale({ min, max, value, onChange, label }: { min: number; max: number; value?: number; onChange: (n: number) => void; label: string }) {
  const values = Array.from({ length: max - min + 1 }, (_, i) => min + i);
  return (
    <div className="tp-scale" role="group" aria-label={label}>
      {values.map((n) => (
        <button key={n} type="button" aria-pressed={value === n} onClick={() => onChange(n)}>
          {n}
        </button>
      ))}
    </div>
  );
}

function AnswerForm({ survey, onCancel, onDone }: { survey: Survey; onCancel: () => void; onDone: () => void }) {
  const actor = useActor();
  const [answers, setAnswers] = useState<Record<string, number | string>>({});
  const [msg, setMsg] = useState<Msg>(null);
  const set = (id: string, v: number | string) => setAnswers((a) => ({ ...a, [id]: v }));

  function submit() {
    const error = submitResponse(actor, survey.id, answers);
    if (error) setMsg({ tone: "err", text: error });
    else onDone();
  }

  return (
    <Card title={survey.title}>
      <p className="note info">Your answers are anonymous and can't be edited after you submit.</p>
      {survey.questions.map((q, i) => (
        <div key={q.id} className="tp-question">
          <p>
            {i + 1}. {q.prompt}
          </p>
          {q.kind === "rating" && (
            <>
              <Scale min={1} max={5} value={answers[q.id] as number | undefined} onChange={(n) => set(q.id, n)} label={q.prompt} />
              <div className="tp-scale-ends" style={{ maxWidth: 240 }}>
                <span>Strongly disagree</span>
                <span>Strongly agree</span>
              </div>
            </>
          )}
          {q.kind === "enps" && (
            <>
              <Scale min={0} max={10} value={answers[q.id] as number | undefined} onChange={(n) => set(q.id, n)} label={q.prompt} />
              <div className="tp-scale-ends">
                <span>Not at all likely</span>
                <span>Extremely likely</span>
              </div>
            </>
          )}
          {q.kind === "text" && (
            <textarea
              maxLength={1000}
              value={(answers[q.id] as string | undefined) ?? ""}
              onChange={(e) => set(q.id, e.target.value)}
              placeholder="Optional"
              aria-label={q.prompt}
            />
          )}
        </div>
      ))}
      <Banner message={msg} />
      <div className="row-gap" style={{ marginTop: 12 }}>
        <button type="button" className="btn" onClick={submit}>
          Submit answers
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </Card>
  );
}

/* ───────────── Results ───────────── */

function Results({ surveys }: { surveys: Survey[] }) {
  const actor = useActor();
  const hr = isHr(actor.role);
  const visible = surveys.filter((s) => s.published && surveyPhase(s) !== "Scheduled");
  const [surveyId, setSurveyId] = useState(visible.find((s) => surveyPhase(s) === "Closed")?.id ?? visible[0]?.id ?? "");
  const survey = visible.find((s) => s.id === surveyId) ?? visible[0];

  if (!survey) return <EmptyState title="No results yet" description="Results appear once a survey has opened." />;
  const access = resultsFor(actor, survey.id);

  return (
    <div className="stack">
      <Card>
        <Field label="Survey">
          <select value={survey.id} onChange={(e) => setSurveyId(e.target.value)}>
            {visible.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title} ({surveyPhase(s).toLowerCase()})
              </option>
            ))}
          </select>
        </Field>
      </Card>
      {access.scope === "none" && (
        <Card>
          <EmptyState
            title={hr ? "No responses yet" : "No team results"}
            description={hr ? "Nobody has answered this survey yet." : "There are no responses from your team for this survey."}
          />
        </Card>
      )}
      {access.scope === "too-few" && (
        <Card>
          <EmptyState title="Not enough responses to keep answers anonymous" description={`Team results show once at least ${MIN_RESPONSES} people respond.`} />
        </Card>
      )}
      {(access.scope === "all" || access.scope === "team") && (
        <ResultsView survey={survey} responses={access.responses} scope={access.scope} />
      )}
    </div>
  );
}

function ResultsView({ survey, responses, scope }: { survey: Survey; responses: SurveyResponse[]; scope: "all" | "team" }) {
  const summary = useMemo(() => summarize(survey, responses), [survey, responses]);
  const enps = summary.find((r) => r.kind === "enps");
  const ratings = summary.filter((r): r is Extract<QuestionResult, { kind: "rating" }> => r.kind === "rating");
  const avg = ratings.length ? Math.round((ratings.reduce((a, r) => a + r.average, 0) / ratings.length) * 10) / 10 : null;
  const tooFew = scope === "all" && responses.length < MIN_RESPONSES;

  return (
    <>
      <MetricGrid>
        <MetricCard label={scope === "team" ? "Team responses" : "Responses"} value={responses.length} />
        {enps && enps.kind === "enps" && <MetricCard label="eNPS" value={tooFew ? "—" : enps.score > 0 ? `+${enps.score}` : enps.score} hint="Promoters minus detractors" />}
        {avg !== null && <MetricCard label="Average rating" value={tooFew ? "—" : `${avg} / 5`} />}
      </MetricGrid>
      {tooFew ? (
        <Card>
          <EmptyState title="Not enough responses to keep answers anonymous" description={`Results show once at least ${MIN_RESPONSES} people respond.`} />
        </Card>
      ) : (
        <>
          {summary.map((r) => (
            <Card key={r.question.id} title={r.question.prompt}>
              {r.kind === "rating" && (
                <div className="tp-bars">
                  {[5, 4, 3, 2, 1].map((n) => {
                    const count = r.counts[n - 1];
                    const pct = r.answered ? Math.round((count / r.answered) * 100) : 0;
                    return (
                      <div key={n} className="tp-bar">
                        <span>{n}</span>
                        <div className="tp-bar-track">
                          <div className="tp-bar-fill" style={{ width: `${pct}%` }} />
                        </div>
                        <span>{count}</span>
                      </div>
                    );
                  })}
                  <p className="muted">Average {r.average} from {r.answered} answers</p>
                </div>
              )}
              {r.kind === "enps" && (
                <MetricGrid>
                  <MetricCard label="Promoters (9–10)" value={r.promoters} />
                  <MetricCard label="Passives (7–8)" value={r.passives} />
                  <MetricCard label="Detractors (0–6)" value={r.detractors} />
                </MetricGrid>
              )}
              {r.kind === "text" &&
                (r.comments.length ? (
                  <ul className="tp-comments">
                    {r.comments.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">No comments.</p>
                ))}
            </Card>
          ))}
          {scope === "all" && <Breakdown survey={survey} responses={responses} />}
        </>
      )}
    </>
  );
}

function Breakdown({ survey, responses }: { survey: Survey; responses: SurveyResponse[] }) {
  const enpsQ = survey.questions.find((q) => q.kind === "enps");
  const groups = new Map<string, SurveyResponse[]>();
  for (const r of responses) groups.set(r.department, [...(groups.get(r.department) ?? []), r]);
  const rows = [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dept, list]) => {
      if (list.length < MIN_RESPONSES) return [dept, "Fewer than 5", "Hidden to protect anonymity"];
      const scores = enpsQ ? list.map((r) => r.answers[enpsQ.id]).filter((v): v is number => typeof v === "number") : [];
      const p = scores.filter((n) => n >= 9).length;
      const d = scores.filter((n) => n <= 6).length;
      const score = scores.length ? Math.round(((p - d) / scores.length) * 100) : 0;
      return [dept, String(list.length), enpsQ ? (score > 0 ? `+${score}` : String(score)) : "—"];
    });
  return (
    <Card title="By department">
      <DataTable headers={["Department", "Responses", "eNPS"]} rows={rows} />
    </Card>
  );
}

/* ───────────── Manage (HR) ───────────── */

type DraftQuestion = { kind: QuestionKind; prompt: string };

const KIND_LABEL: Record<QuestionKind, string> = { rating: "Rating 1–5", enps: "eNPS 0–10", text: "Free text" };

function Manage({ surveys }: { surveys: Survey[] }) {
  const actor = useActor();
  const people = useSyncExternalStore(subscribePeople, listPeople);
  const departments = useMemo(() => [...new Set(people.map((p) => p.department).filter(Boolean))].sort(), [people]);
  const today = todayISO();
  const [title, setTitle] = useState("");
  const [questions, setQuestions] = useState<DraftQuestion[]>([
    { kind: "rating", prompt: "" },
    { kind: "enps", prompt: ENPS_PROMPT },
    { kind: "text", prompt: "" },
  ]);
  const [audType, setAudType] = useState<SurveyAudience["type"]>("all");
  const [audValue, setAudValue] = useState("");
  const [openDate, setOpenDate] = useState(today);
  const [closeDate, setCloseDate] = useState("");
  const [msg, setMsg] = useState<Msg>(null);
  const [listMsg, setListMsg] = useState<Msg>(null);

  function save(publish: boolean) {
    const audience: SurveyAudience = audType === "all" ? { type: "all" } : { type: audType, value: audValue };
    const error = createSurvey(actor, { title, questions, audience, openDate, closeDate }, publish);
    if (error) {
      setMsg({ tone: "err", text: error });
      return;
    }
    setMsg({ tone: "ok", text: publish ? "Survey published." : "Draft saved." });
    setTitle("");
    setQuestions([{ kind: "rating", prompt: "" }, { kind: "enps", prompt: ENPS_PROMPT }, { kind: "text", prompt: "" }]);
    setCloseDate("");
  }

  const updateQ = (i: number, patch: Partial<DraftQuestion>) =>
    setQuestions((qs) => qs.map((q, j) => (j === i ? { ...q, ...patch, prompt: patch.kind === "enps" ? ENPS_PROMPT : patch.prompt ?? q.prompt } : q)));

  const rows = surveys.map((s) => {
    const count = getSurveysState().responses.filter((r) => r.surveyId === s.id).length;
    return [
      s.title,
      audienceLabel(s.audience),
      `${formatShortDate(s.openDate)} – ${formatShortDate(s.closeDate)}`,
      <PhaseBadge key="p" survey={s} />,
      String(count),
      !s.published ? (
        <div key="a" className="row-gap">
          <button type="button" className="btn btn-tiny" onClick={() => { const e = publishSurvey(actor, s.id); setListMsg(e ? { tone: "err", text: e } : { tone: "ok", text: "Survey published." }); }}>
            Publish
          </button>
          <button type="button" className="btn btn-ghost btn-tiny" onClick={() => { const e = deleteDraftSurvey(actor, s.id); setListMsg(e ? { tone: "err", text: e } : { tone: "ok", text: "Draft deleted." }); }}>
            Delete
          </button>
        </div>
      ) : (
        <span key="a" className="muted">—</span>
      ),
    ];
  });

  return (
    <div className="stack">
      <Card title="All surveys">
        <Banner message={listMsg} />
        <DataTable headers={["Survey", "Audience", "Dates", "Status", "Responses", ""]} rows={rows} />
      </Card>
      <Card title="New survey">
        <div className="form-grid-2">
          <Field label="Title" wide>
            <input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Audience">
            <select value={audType} onChange={(e) => { setAudType(e.target.value as SurveyAudience["type"]); setAudValue(""); }}>
              <option value="all">Everyone</option>
              <option value="department">A department</option>
              <option value="country">A country</option>
            </select>
          </Field>
          {audType !== "all" && (
            <Field label={audType === "department" ? "Department" : "Country"}>
              <select value={audValue} onChange={(e) => setAudValue(e.target.value)}>
                <option value="">Choose…</option>
                {(audType === "department" ? departments : TIMEZ_COUNTRIES.map((c) => c.name)).map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Opens">
            <input type="date" min={today} value={openDate} onChange={(e) => setOpenDate(e.target.value)} />
          </Field>
          <Field label="Closes">
            <input type="date" min={openDate || today} value={closeDate} onChange={(e) => setCloseDate(e.target.value)} />
          </Field>
        </div>
        <h3 style={{ margin: "16px 0 8px", fontSize: 15 }}>Questions</h3>
        <div className="stack">
          {questions.map((q, i) => (
            <div key={i} className="tp-qrow">
              <select value={q.kind} aria-label={`Question ${i + 1} type`} onChange={(e) => updateQ(i, { kind: e.target.value as QuestionKind, prompt: q.kind === "enps" ? "" : q.prompt })}>
                {(Object.keys(KIND_LABEL) as QuestionKind[]).map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </select>
              <input
                value={q.prompt}
                maxLength={200}
                readOnly={q.kind === "enps"}
                placeholder={q.kind === "text" ? "e.g. What should we change?" : "e.g. I feel recognised for my work"}
                aria-label={`Question ${i + 1}`}
                onChange={(e) => updateQ(i, { prompt: e.target.value })}
              />
              <button type="button" className="btn btn-ghost btn-tiny" onClick={() => setQuestions((qs) => qs.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
          ))}
          <div>
            <button type="button" className="btn btn-ghost btn-tiny" onClick={() => setQuestions((qs) => [...qs, { kind: "rating", prompt: "" }])}>
              Add question
            </button>
          </div>
        </div>
        <Banner message={msg} />
        <div className="row-gap" style={{ marginTop: 12 }}>
          <button type="button" className="btn" onClick={() => save(true)}>
            Publish survey
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => save(false)}>
            Save draft
          </button>
        </div>
      </Card>
    </div>
  );
}
