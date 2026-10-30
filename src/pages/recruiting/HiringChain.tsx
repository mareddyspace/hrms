/*
 * The hiring chain, link by link: requisition → approval → job post → applications → screening → interview →
 * scorecards → offer (letter) → the candidate's answer (link) → onboarding. Trackers for a requisition and a
 * candidate, and the panels each step needs. Rules live in src/data/talentLocal.ts (and the server in backend mode).
 */
import { useMemo, useState } from "react";
import { ActionButton, Dialog, Field, StatusBadge, SubmitButton, notify, useAction } from "../../components/ui.tsx";
import {
  CLOSED_STAGES,
  PIPELINE_STAGES,
  RECOMMENDATIONS,
  SCORECARD_CRITERIA,
  type Candidate,
  type Interview,
  type OfferRecord,
  type PipelineStage,
  type Recommendation,
  type Requisition,
  type ScorecardCriterion,
} from "../../data/talentData.ts";
import {
  canRunPipeline,
  closePosting,
  getTalentState,
  hiringManagerIdOf,
  interviewStarted,
  isPostingOpen,
  isRequisitionOpen,
  nowStamp,
  offerLink,
  publishPosting,
  scheduleInterview,
  scorecardScore,
  screenCandidate,
  submitInterviewFeedback,
  talentAction,
  type Scorecard,
  type TalentActor,
  type TalentResult,
} from "../../data/talentLocal.ts";
import { DEMO_ACCOUNTS } from "../../demoAccounts.ts";
import { API_ENABLED } from "../../api/client.ts";
import { matchCandidate, needsForRequisition } from "../../features/ai/candidateMatch.ts";
import { draftJobDescription, formatJobDraft } from "../../features/ai/jobDescription.ts";
import { gradeFor } from "../../features/talentplus/jobBoardStore.ts";
import { letterDocumentHtml, offerLetterHtml } from "../../data/letterTemplates.ts";
import { formatShortDate, todayISO } from "../../model.ts";

type Talent = ReturnType<typeof getTalentState>;
type OnResult = (error: TalentResult, okText: string) => void;

function talentRun(change: () => TalentResult, done: (result: TalentResult) => void): Promise<TalentResult> {
  return new Promise((resolve) =>
    talentAction(change, (result) => {
      done(result);
      resolve(result);
    }),
  );
}

const day = (iso?: string) => (iso ? formatShortDate(iso.slice(0, 10)) : "");
const PAST_SCREENING: readonly PipelineStage[] = ["Shortlisted", "Interview", "Assessment", "Final Review", "Offer", "Hired"];

type ChainStep = { label: string; state: "done" | "current" | "stopped" | "future"; note: string };

function Chain({ steps, label }: { steps: ChainStep[]; label: string }) {
  return (
    <ol className="cp-stepper" aria-label={label}>
      {steps.map((s) => (
        <li key={s.label} className={`cp-step is-${s.state}`}>
          <span className="cp-dot">{s.state === "done" ? "✓" : s.state === "stopped" ? "×" : ""}</span>
          <span className="cp-step-name">{s.label}</span>
          <span className="cp-step-date">{s.note}</span>
        </li>
      ))}
    </ol>
  );
}

/** Mark the first not-done step as current (unless the chain stopped). */
function withCurrent(steps: ChainStep[]): ChainStep[] {
  if (steps.some((s) => s.state === "stopped")) return steps;
  const i = steps.findIndex((s) => s.state !== "done");
  return steps.map((s, idx) => (idx === i ? { ...s, state: "current" } : s));
}

/** Candidates per stage for a requisition — the one count every page uses. */
export function stageCountsFor(talent: Pick<Talent, "candidates">, reqId: string): Map<PipelineStage, number> {
  const out = new Map<PipelineStage, number>();
  for (const c of talent.candidates) if (c.requisitionId === reqId) out.set(c.stage, (out.get(c.stage) ?? 0) + 1);
  return out;
}

export function StageCounts({ talent, req }: { talent: Talent; req: Requisition }) {
  const counts = stageCountsFor(talent, req.id);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (!total) return <p className="muted">No applications yet.</p>;
  return (
    <div className="cp-chips" aria-label="Candidates per stage">
      {PIPELINE_STAGES.filter((s) => counts.get(s)).map((s) => (
        <span key={s} className="cp-chip">
          <strong>{counts.get(s)}</strong>
          {s}
        </span>
      ))}
    </div>
  );
}

/** Where the requisition is in the chain: raised → approved → posted → applications → screening → interviews → offer → hired. */
export function RequisitionChain({ req, talent }: { req: Requisition; talent: Talent }) {
  const cands = talent.candidates.filter((c) => c.requisitionId === req.id);
  const ids = new Set(cands.map((c) => c.id));
  const interviews = talent.interviews.filter((i) => ids.has(i.candidateId));
  const offers = talent.offers.filter((o) => o.requisitionId === req.id);
  const hired = cands.filter((c) => c.stage === "Hired").length;
  const screened = cands.filter((c) => PAST_SCREENING.includes(c.stage) || (c.stage === "Rejected" && (c.history ?? []).some((h) => h.stage === "Screening"))).length;
  const raised = req.history?.find((h) => h.action === "Raised");
  const approved = req.approvalStatus === "Approved" || (req.approvalStatus === "On hold" && !!req.recruiterId);
  const steps: ChainStep[] = [
    { label: "Raised", state: "done", note: `${raised?.by ?? req.hiringManager}, ${day(req.created)}` },
    {
      label: "Approved",
      state: req.approvalStatus === "Rejected" ? "stopped" : approved ? "done" : "future",
      note: req.approvalStatus === "Rejected" ? "Rejected" : approved ? day(req.decidedOn) : req.approvalStatus,
    },
    {
      label: "Posted",
      state: req.posting ? "done" : "future",
      note: req.posting ? `${req.posting.status === "Open" ? "Open" : "Closed"} · closes ${day(req.posting.closingDate)}` : "Not posted",
    },
    { label: "Applications", state: cands.length ? "done" : "future", note: String(cands.length) },
    { label: "Screening", state: screened ? "done" : "future", note: `${screened} screened` },
    { label: "Interviews", state: interviews.length ? "done" : "future", note: `${interviews.filter((i) => i.feedbackStatus === "Submitted").length}/${interviews.length} scorecards` },
    { label: "Offer", state: offers.length ? "done" : "future", note: offers.length ? `${offers.length} · ${offers[offers.length - 1]!.status}` : "None" },
    { label: "Hired", state: hired >= req.openings ? "done" : "future", note: `${hired} of ${req.openings}` },
  ];
  return <Chain steps={withCurrent(steps)} label="Requisition hiring chain" />;
}

/** Where the candidate is: applied → screened → interview → scorecards → offer → accepted → onboarding. */
export function CandidateChain({ candidate, talent }: { candidate: Candidate; talent: Talent }) {
  const hist = candidate.history ?? [];
  const reached = (s: PipelineStage) => hist.some((h) => h.stage === s);
  const rejected = candidate.stage === "Rejected" || candidate.stage === "Withdrawn";
  const ivs = talent.interviews.filter((i) => i.candidateId === candidate.id);
  const done = ivs.filter((i) => i.feedbackStatus === "Submitted");
  const offer = [...talent.offers].reverse().find((o) => o.candidateId === candidate.id);
  const joiner = talent.joiners.find((j) => j.candidateId === candidate.id);
  const applied = hist.find((h) => h.stage === "Applied");
  const screenedOk = PAST_SCREENING.some(reached);
  const stopAt = (ok: boolean) => (rejected && !ok ? "stopped" : "future");
  let stoppedOnce = false;
  const steps: ChainStep[] = [
    { label: "Applied", state: "done", note: day(applied?.enteredOn) },
    { label: "Screened", state: screenedOk ? "done" : stopAt(false), note: screenedOk ? (candidate.matchScore !== undefined ? `Match ${candidate.matchScore}%` : "Shortlisted") : rejected ? candidate.stage : "" },
    { label: "Interview", state: ivs.length ? "done" : screenedOk ? stopAt(false) : "future", note: ivs.length ? `${ivs.length} round${ivs.length === 1 ? "" : "s"}` : "" },
    {
      label: "Scorecards",
      state: ivs.length && done.length === ivs.length ? "done" : "future",
      note: ivs.length ? `${done.length}/${ivs.length}${done.length ? ` · avg ${(done.reduce((a, i) => a + (i.score ?? 0), 0) / done.length).toFixed(1)}` : ""}` : "",
    },
    { label: "Offer", state: offer && offer.status !== "Preparing" && offer.status !== "Pending approval" ? "done" : "future", note: offer ? offer.status : "" },
    {
      label: "Accepted",
      state: offer?.status === "Accepted" ? "done" : offer?.status === "Declined" ? "stopped" : "future",
      note: offer?.respondedOn ? `${offer.status} ${day(offer.respondedOn)}` : "",
    },
    { label: "Onboarding", state: joiner ? "done" : "future", note: joiner ? `Starts ${day(joiner.startDate)}` : candidate.stage === "Hired" && candidate.employeeId ? "Internal move" : "" },
  ];
  // Only the first stop shows as stopped; later steps are just not reached.
  const shown = steps.map((s) => {
    if (s.state !== "stopped") return s;
    if (stoppedOnce) return { ...s, state: "future" as const };
    stoppedOnce = true;
    return s;
  });
  return <Chain steps={withCurrent(shown)} label={`${candidate.name} hiring chain`} />;
}

/* ───────────── Job post ───────────── */

function draftFor(req: Requisition): string {
  const d = draftJobDescription({ title: req.title, familyName: req.department, gradeBand: gradeFor(req), department: req.department, location: req.location, requirements: req.requirements });
  return formatJobDraft(req.title, d).split("\n").slice(2).join("\n");
}

/** The recruiter publishes the approved requisition; it shows on the internal jobs board and (if chosen) the careers page. */
export function PostingPanel({ req, actor, onResult }: { req: Requisition; actor: TalentActor; onResult: OnResult }) {
  const canPost = canRunPipeline(actor, req) && isRequisitionOpen(req);
  const post = req.posting;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(() => ({
    title: post?.title ?? req.title,
    description: post?.description ?? "",
    location: post?.location ?? `${req.location}, ${req.country}`,
    employmentType: post?.employmentType ?? "Full-time",
    closingDate: post?.closingDate && post.closingDate >= todayISO() ? post.closingDate : addDays(30),
    onCareersSite: post?.onCareersSite ?? true,
  }));
  const action = useAction();
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const open = isPostingOpen(req);

  if (!editing) {
    return (
      <div className="stack">
        {post ? (
          <p>
            <StatusBadge status={open ? "Open" : "Closed"} literal tone={open ? "ok" : "warn"} /> <strong>{post.title}</strong> · {post.location} · closes {day(post.closingDate)}
            {post.onCareersSite ? " · on the careers page" : " · internal board only"}
            {post.publishedBy ? ` · posted by ${post.publishedBy}` : ""}
          </p>
        ) : (
          <p className="muted">{isRequisitionOpen(req) ? "Not posted yet." : "It can be posted once it is approved and has a recruiter."}</p>
        )}
        <div className="row-gap">
          {canPost && (
            <button type="button" className={post ? "btn-ghost btn-tiny" : "btn btn-tiny"} onClick={() => setEditing(true)}>
              {post ? (open ? "Edit post" : "Post again") : "Post job"}
            </button>
          )}
          {canPost && open && (
            <ActionButton className="btn-ghost btn-tiny" doneLabel="Closed" onAction={() => talentRun(() => closePosting(actor, req.id), (e) => onResult(e, `${req.id}: job post closed.`))} success={`${req.id}: job post closed.`}>
              Close post
            </ActionButton>
          )}
          {open && post?.onCareersSite && (
            <a className="btn-ghost btn-tiny" href={`/careers/${post.id}`} target="_blank" rel="noopener noreferrer">
              View on careers page
            </a>
          )}
        </div>
      </div>
    );
  }

  return (
    <form
      className="stack"
      onSubmit={action.submit(
        () => {
          const input = { ...form };
          return talentRun(() => publishPosting(actor, req.id, input), (e) => {
            onResult(e, `${input.title} is posted.`);
            if (!e) setEditing(false);
          });
        },
        { success: `${form.title} is posted.` },
      )}
    >
      <div className="form-grid-2">
        <Field label="Job title">
          <input value={form.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} />
        </Field>
        <Field label="Location">
          <input value={form.location} maxLength={200} onChange={(e) => set({ location: e.target.value })} />
        </Field>
        <Field label="Type">
          <select value={form.employmentType} onChange={(e) => set({ employmentType: e.target.value })}>
            {["Full-time", "Part-time", "Contract", "Internship"].map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </Field>
        <Field label="Closing date">
          <input type="date" min={todayISO()} value={form.closingDate} onChange={(e) => set({ closingDate: e.target.value })} />
        </Field>
        <Field label="Description" wide>
          <textarea rows={8} value={form.description} maxLength={10000} onChange={(e) => set({ description: e.target.value })} />
        </Field>
      </div>
      <label className="row-gap">
        <input type="checkbox" checked={form.onCareersSite} onChange={(e) => set({ onCareersSite: e.target.checked })} />
        Also show on the public careers page
      </label>
      <div className="row-gap">
        <SubmitButton action={action} className="btn btn-tiny" disabled={!form.title.trim() || form.description.trim().length < 20 || !form.closingDate}>
          {post ? "Save post" : "Publish"}
        </SubmitButton>
        <button type="button" className="btn-ghost btn-tiny" onClick={() => set({ description: draftFor(req) })}>
          Write with JD writer
        </button>
        <button type="button" className="btn-ghost btn-tiny" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function addDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* ───────────── Screening ───────────── */

export function ScreenPanel({ candidate, req, actor, onResult }: { candidate: Candidate; req: Requisition; actor: TalentActor; onResult: OnResult }) {
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const local = useMemo(() => (API_ENABLED ? null : matchCandidate(candidate, needsForRequisition(req))), [candidate, req]);
  if (!canRunPipeline(actor, req) || !isRequisitionOpen(req) || (candidate.stage !== "Applied" && candidate.stage !== "Screening")) return null;
  const score = local?.score;
  const run = (decision: "shortlist" | "reject") =>
    talentRun(() => screenCandidate(actor, candidate.id, decision, reason, score), (e) => {
      onResult(e, decision === "shortlist" ? `${candidate.name} shortlisted.` : `${candidate.name} rejected.`);
      if (!e) {
        setReason("");
        setRejecting(false);
      }
    });
  return (
    <div className="stack">
      <h3 className="cp-section-title">Screening</h3>
      {candidate.coverNote && <p className="note">Cover note: {candidate.coverNote}</p>}
      {local && <p className="muted">Match to job: {local.score}% ({local.band}) — a guide, not the decision.</p>}
      {rejecting && (
        <Field label="Reason">
          <input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="Why not this time" />
        </Field>
      )}
      <div className="row-gap">
        {!rejecting ? (
          <>
            <ActionButton className="btn btn-tiny" doneLabel="Shortlisted" success={`${candidate.name} shortlisted.`} onAction={() => run("shortlist")}>
              Shortlist
            </ActionButton>
            <button type="button" className="btn-ghost btn-tiny" onClick={() => setRejecting(true)}>
              Reject
            </button>
          </>
        ) : (
          <>
            <ActionButton className="btn btn-tiny" disabled={reason.trim().length < 3} doneLabel="Rejected" success={`${candidate.name} rejected.`} onAction={() => run("reject")}>
              Reject
            </ActionButton>
            <button type="button" className="btn-ghost btn-tiny" onClick={() => setRejecting(false)}>
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/* ───────────── Interviews ───────────── */

/** People who can sit on a panel: everyone with a sign-in, except the candidate (internal applicants). */
function panelOptions(candidate: Candidate) {
  return DEMO_ACCOUNTS.filter((a) => a.id !== candidate.employeeId && a.role !== "admin");
}

export function ScheduleInterview({ candidate, req, actor, onResult }: { candidate: Candidate; req: Requisition; actor: TalentActor; onResult: OnResult }) {
  const hm = hiringManagerIdOf(req);
  const [form, setForm] = useState({ when: "", type: "Technical", panelIds: hm ? [hm] : [] });
  const action = useAction();
  if (!(canRunPipeline(actor, req) && isRequisitionOpen(req) && candidate.stage === "Interview")) return null;
  const toggle = (id: string) => setForm((f) => ({ ...f, panelIds: f.panelIds.includes(id) ? f.panelIds.filter((x) => x !== id) : [...f.panelIds, id] }));
  return (
    <form
      className="cp-actions"
      onSubmit={action.submit(() => {
        const input = { ...form };
        return talentRun(() => scheduleInterview(actor, candidate.id, input), (e) => {
          onResult(e, `Interview booked for ${input.when.replace("T", " ")}.`);
          if (!e) {
            notify(`Interview with ${candidate.name} scheduled. The panel is told.`);
            setForm((f) => ({ ...f, when: "" }));
          }
        });
      })}
    >
      <Field label="Date and time">
        <input type="datetime-local" min={nowStamp()} value={form.when} onChange={(e) => setForm((f) => ({ ...f, when: e.target.value }))} />
      </Field>
      <Field label="Round">
        <select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}>
          {["Phone screen", "Technical", "Hiring manager", "Panel", "Culture"].map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </Field>
      <fieldset className="stack" style={{ border: 0, padding: 0 }}>
        <legend className="muted">Interviewers</legend>
        <span className="row-gap" style={{ flexWrap: "wrap" }}>
          {panelOptions(candidate).map((a) => (
            <label key={a.id} className="row-gap">
              <input type="checkbox" checked={form.panelIds.includes(a.id)} onChange={() => toggle(a.id)} />
              {a.fullName}
            </label>
          ))}
        </span>
      </fieldset>
      <SubmitButton action={action} className="btn btn-tiny" disabled={!form.when || !form.panelIds.length}>
        Schedule
      </SubmitButton>
    </form>
  );
}

const EMPTY_CARD = (): Scorecard => ({ ratings: {}, recommendation: "", notes: "" });

/** The interviewer's scorecard: 1–5 per criterion, a recommendation and notes. Opens once the interview has started. */
export function ScorecardForm({ interview, actor, onResult, onDone }: { interview: Interview; actor: TalentActor; onResult: OnResult; onDone?: () => void }) {
  const [card, setCard] = useState<Scorecard>(EMPTY_CARD);
  const action = useAction();
  if (!interviewStarted(interview)) return <p className="muted">The scorecard opens at {interview.when.slice(11, 16)} on {day(interview.when)}.</p>;
  const rate = (c: ScorecardCriterion, v: number) => setCard((x) => ({ ...x, ratings: { ...x.ratings, [c]: v } }));
  const complete = SCORECARD_CRITERIA.every((c) => card.ratings[c]) && !!card.recommendation && !!card.notes.trim();
  return (
    <form
      className="stack"
      onSubmit={action.submit(
        () =>
          talentRun(() => submitInterviewFeedback(actor, interview.id, card), (e) => {
            onResult(e, `Scorecard for ${interview.candidateName} submitted.`);
            if (!e) {
              setCard(EMPTY_CARD());
              onDone?.();
            }
          }),
        { success: `Scorecard for ${interview.candidateName} submitted.` },
      )}
    >
      <div className="form-grid-2">
        {SCORECARD_CRITERIA.map((c) => (
          <Field key={c} label={`${c} (1–5)`}>
            <select value={card.ratings[c] ?? ""} onChange={(e) => rate(c, Number(e.target.value))}>
              <option value="">Select…</option>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </Field>
        ))}
        <Field label="Recommendation">
          <select value={card.recommendation} onChange={(e) => setCard((x) => ({ ...x, recommendation: e.target.value as Recommendation }))}>
            <option value="">Select…</option>
            {RECOMMENDATIONS.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </Field>
        <Field label="Notes" wide>
          <textarea rows={3} value={card.notes} maxLength={5000} onChange={(e) => setCard((x) => ({ ...x, notes: e.target.value }))} placeholder="What you saw, for the hiring team" />
        </Field>
      </div>
      <p className="muted">Overall {scorecardScore(card.ratings) ?? "—"}/5 (average of the ratings).</p>
      <div>
        <SubmitButton action={action} className="btn btn-tiny" disabled={!complete}>
          Submit scorecard
        </SubmitButton>
      </div>
    </form>
  );
}

/** Every round with its scorecard, plus the combined average per criterion. */
export function ScorecardSummary({ interviews, now = nowStamp() }: { interviews: Interview[]; now?: string }) {
  const done = interviews.filter((i) => i.feedbackStatus === "Submitted");
  const avg = (c: ScorecardCriterion) => {
    const v = done.map((i) => i.ratings?.[c]).filter((x): x is number => typeof x === "number");
    return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : "—";
  };
  return (
    <div className="stack">
      <ul className="todo">
        {interviews.map((i) => (
          <li key={i.id}>
            {day(i.when)} {i.when.slice(11, 16)} · {i.type} · {i.panel} ·{" "}
            {i.feedbackStatus === "Submitted"
              ? `${i.score ?? "—"}/5${i.recommendation ? ` · ${i.recommendation}` : ""}${i.feedbackBy ? ` · ${i.feedbackBy}` : ""}${i.feedback ? ` — ${i.feedback}` : ""}`
              : interviewStarted(i, now)
                ? "Scorecard pending"
                : "Upcoming"}
          </li>
        ))}
      </ul>
      {done.some((i) => i.ratings) && (
        <div className="cp-chips" aria-label="Combined scores">
          {SCORECARD_CRITERIA.map((c) => (
            <span key={c} className="cp-chip">
              <strong>{avg(c)}</strong>
              {c}
            </span>
          ))}
          <span className="cp-chip">
            <strong>{(done.reduce((a, i) => a + (i.score ?? 0), 0) / done.length).toFixed(1)}</strong>
            Overall ({done.length} of {interviews.length})
          </span>
        </div>
      )}
    </div>
  );
}

/* ───────────── Offer letter and answer link ───────────── */

export function OfferLetterButton({ offer }: { offer: OfferRecord }) {
  const [open, setOpen] = useState(false);
  if (!offer.letter) return null;
  const html = letterDocumentHtml(offerLetterHtml(offer.letter, API_ENABLED), { title: offer.letter.title, draft: offer.status === "Preparing" || offer.status === "Pending approval" });
  return (
    <>
      <button type="button" className="btn-ghost btn-tiny" onClick={() => setOpen(true)}>
        Offer letter
      </button>
      {open && (
        <Dialog open title={`Offer letter · ${offer.candidateName}`} onClose={() => setOpen(false)} wide>
          <iframe title="Offer letter" srcDoc={html} style={{ width: "100%", height: "70vh", border: 0 }} sandbox="" />
        </Dialog>
      )}
    </>
  );
}

/** Shown to the recruiter once the offer is sent: the candidate's answer link (no sign-in) to pass on. */
export function OfferAnswerLink({ offer }: { offer: OfferRecord }) {
  if (offer.status !== "Sent" || !offer.responseToken) return null;
  const link = offerLink(offer.responseToken);
  return (
    <span className="stack">
      <span className="muted">Answer link for {offer.candidateName}:</span>
      <span className="row-gap" style={{ flexWrap: "wrap" }}>
        <input readOnly value={link} aria-label="Answer link" onFocus={(e) => e.target.select()} style={{ minWidth: 240 }} />
        <ActionButton className="btn-ghost btn-tiny" doneLabel="Copied" onAction={() => navigator.clipboard?.writeText(link).then(() => null, () => "Copy didn't work. Select the link and copy it.")}>
          Copy
        </ActionButton>
        <a className="btn-ghost btn-tiny" href={link} target="_blank" rel="noopener noreferrer">
          Open
        </a>
      </span>
    </span>
  );
}

/** Closed candidates do not count in "in progress". */
export function isActiveCandidate(c: Candidate): boolean {
  return !CLOSED_STAGES.includes(c.stage);
}
