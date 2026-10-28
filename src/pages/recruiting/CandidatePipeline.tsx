import { useMemo, useState } from "react";
import { DataTable, EmptyState, Field, MetricCard, MetricGrid, StatusBadge } from "../../components/ui.tsx";
import { CLOSED_STAGES, PIPELINE_STAGES, type Candidate, type Interview, type PipelineStage, type Requisition, type StageStep } from "../../data/talentData.ts";
import {
  addCandidate,
  canRunPipeline,
  candidateIntakeRequisitions,
  candidateHistory,
  getTalentState,
  isHrRole,
  isRequisitionOpen,
  myPipelineRequisitions,
  nowStamp,
  requisitionSteps,
  scheduleInterview,
  setCandidateStage,
  stageMovesFor,
  type TalentActor,
  type TalentResult,
} from "../../data/talentLocal.ts";
import "./candidatePipeline.css";

type Talent = ReturnType<typeof getTalentState>;

/** Blueprint stages shown on the stepper (exits are shown separately). */
const MAIN_STAGES: readonly PipelineStage[] = PIPELINE_STAGES.filter((s) => s !== "Rejected" && s !== "Withdrawn");
const EXIT: readonly PipelineStage[] = ["Rejected", "Withdrawn"];
/** A candidate is overdue after this many days in one open stage. */
export const STUCK_DAYS = 7;
const DAY = 86_400_000;

/* ───────────── Date helpers ───────────── */

/** Accepts "2026-09-12", "2026-09-12T10:30" or "2026-09-12 10:30" as local time. */
function parseStamp(s: string): Date {
  const [d, t = "00:00"] = s.trim().split(/[T ]/);
  const [y, m, day] = d.split("-").map(Number);
  const [hh, mm] = t.split(":").map(Number);
  return new Date(y, (m || 1) - 1, day || 1, hh || 0, mm || 0);
}

export function fmtDate(s: string | undefined): string {
  if (!s) return "—";
  return parseStamp(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtDateTime(s: string): string {
  const time = s.includes("T") || s.includes(" ") ? ` · ${s.slice(11, 16)}` : "";
  return `${fmtDate(s)}${time}`;
}

/** Whole calendar days from a to b. */
function daysBetween(a: string, b: string): number {
  const da = parseStamp(a.slice(0, 10));
  const db = parseStamp(b.slice(0, 10));
  return Math.max(0, Math.round((db.getTime() - da.getTime()) / DAY));
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/* ───────────── Pipeline maths ───────────── */

export type PipelineInfo = {
  history: StageStep[];
  applied?: StageStep;
  current: StageStep;
  closed: boolean;
  exit?: StageStep;
  /** Days in the current stage (to now, or to the close date). */
  daysInStage: number;
  /** Days since applying (to now, or to the close date). */
  totalDays: number;
  overdue: boolean;
};

export function pipelineInfo(c: Candidate, req: Requisition | undefined, now = nowStamp()): PipelineInfo {
  const history = candidateHistory(c);
  const current = history[history.length - 1];
  const closed = CLOSED_STAGES.includes(c.stage);
  const applied = history.find((h) => h.stage === "Applied") ?? history[0];
  const end = closed ? current.enteredOn : now;
  const daysInStage = closed ? 0 : daysBetween(current.enteredOn, now);
  return {
    history,
    applied,
    current,
    closed,
    exit: EXIT.includes(c.stage) ? current : undefined,
    daysInStage,
    totalDays: applied ? daysBetween(applied.enteredOn, end) : 0,
    overdue: !closed && !!req && isRequisitionOpen(req) && daysInStage > STUCK_DAYS,
  };
}

type StepState = "done" | "current" | "stopped" | "future";

/** Each blueprint stage: when it was reached, days spent there, and its state. */
function stepperRows(c: Candidate, info: PipelineInfo, now: string) {
  const { history } = info;
  const lastMain = [...history].reverse().find((h) => MAIN_STAGES.includes(h.stage));
  const reachedIdx = lastMain ? MAIN_STAGES.indexOf(lastMain.stage) : 0;
  return MAIN_STAGES.map((stage, i) => {
    const idx = history.map((h) => h.stage).lastIndexOf(stage);
    const step = idx >= 0 ? history[idx] : undefined;
    const next = idx >= 0 ? history[idx + 1] : undefined;
    let state: StepState = "future";
    if (i < reachedIdx) state = "done";
    else if (i === reachedIdx) state = info.exit ? "stopped" : c.stage === "Hired" ? "done" : "current";
    const days = step && stage !== "Hired" ? daysBetween(step.enteredOn, next ? next.enteredOn : now) : undefined;
    return { stage, step, state, days: state === "future" ? undefined : days };
  });
}

/* ───────────── Small pieces ───────────── */

/** Compact dots, one per blueprint stage. */
export function MiniStepper({ candidate }: { candidate: Candidate }) {
  const info = pipelineInfo(candidate, undefined);
  const rows = stepperRows(candidate, info, nowStamp());
  return (
    <span className="cp-mini" aria-label={`Stage: ${candidate.stage}`} title={candidate.stage}>
      {rows.map((r) => (
        <span key={r.stage} className={`is-${r.state}`} />
      ))}
    </span>
  );
}

/** Manager raised → HR approved → recruiter assigned. */
export function RequisitionTracker({ req }: { req: Requisition }) {
  const steps = requisitionSteps(req);
  const firstOpen = steps.findIndex((s) => !s.done);
  return (
    <ol className="cp-stepper" aria-label="Requisition progress">
      {steps.map((s, i) => (
        <li key={s.label} className={`cp-step is-${s.done ? "done" : i === firstOpen ? "current" : "future"}`}>
          <span className="cp-dot">{s.done ? "✓" : ""}</span>
          <span className="cp-step-name">{s.label}</span>
          <span className="cp-step-date">{s.done ? `${s.by ?? ""}${s.on ? `, ${fmtDate(s.on)}` : ""}` : req.approvalStatus === "On hold" && i === 1 ? "On hold" : "Pending"}</span>
        </li>
      ))}
    </ol>
  );
}

function interviewsOf(talent: Talent, candidateId: string): Interview[] {
  return talent.interviews.filter((i) => i.candidateId === candidateId).sort((a, b) => a.when.localeCompare(b.when));
}

/** What has to happen next for this candidate, and who does it. */
export function nextActionFor(c: Candidate, talent: Talent, req: Requisition | undefined, now = nowStamp()): { text: string; owner: string } | null {
  const recruiter = req?.recruiter || "Recruiter";
  const manager = req?.hiringManager || "Hiring manager";
  const ivs = interviewsOf(talent, c.id);
  const offer = [...talent.offers].reverse().find((o) => o.candidateId === c.id);
  switch (c.stage) {
    case "Applied":
      return { text: "Review CV and start screening", owner: recruiter };
    case "Screening":
      return { text: "Phone screen, then shortlist or reject", owner: recruiter };
    case "Shortlisted":
      return { text: "Share with hiring manager and book an interview", owner: recruiter };
    case "Interview": {
      const upcoming = ivs.find((i) => i.when.replace(" ", "T") >= now);
      if (upcoming) return { text: `Interview on ${fmtDateTime(upcoming.when)}`, owner: upcoming.panel };
      const pending = ivs.find((i) => i.feedbackStatus === "Pending");
      if (pending) return { text: "Submit interview feedback", owner: pending.panel };
      if (ivs.length === 0) return { text: "Schedule the interview", owner: recruiter };
      return { text: "Move to assessment or reject", owner: recruiter };
    }
    case "Assessment":
      return { text: "Review assessment and send to final review", owner: recruiter };
    case "Final Review":
      return { text: "Decide: offer or reject", owner: manager };
    case "Offer":
      if (!offer || offer.status === "Preparing") return { text: "Prepare the offer", owner: recruiter };
      if (offer.status === "Pending approval") return { text: "Approve the offer", owner: `${manager} / HR` };
      if (offer.status === "Approved") return { text: "Send the offer", owner: recruiter };
      if (offer.status === "Sent") return { text: "Waiting for the candidate to reply", owner: c.name };
      if (offer.status === "Accepted") return { text: "Mark as hired", owner: recruiter };
      return { text: `Offer ${offer.status.toLowerCase()}`, owner: recruiter };
    case "Hired":
      return { text: "Onboarding", owner: "HR" };
    default:
      return null;
  }
}

/** The full stage line with the date each stage was reached and days spent there. */
export function CandidateStepper({ candidate, req, now = nowStamp() }: { candidate: Candidate; req?: Requisition; now?: string }) {
  const info = pipelineInfo(candidate, req, now);
  const rows = stepperRows(candidate, info, now);
  return (
    <ol className="cp-stepper" aria-label={`${candidate.name} pipeline`}>
      {rows.map((r) => (
        <li key={r.stage} className={`cp-step is-${r.state}${r.state === "current" && info.overdue ? " is-overdue" : ""}`}>
          <span className="cp-dot">{r.state === "done" ? "✓" : r.state === "stopped" ? "×" : ""}</span>
          <span className="cp-step-name">{r.stage}</span>
          <span className="cp-step-date">{r.step ? fmtDate(r.step.enteredOn) : "—"}</span>
          {r.days !== undefined && <span className="cp-step-days">{plural(r.days, "day")}</span>}
        </li>
      ))}
    </ol>
  );
}

/* ───────────── Per-candidate pipeline ───────────── */

export function CandidatePipelineView({
  candidate,
  talent,
  actor,
  onResult,
}: {
  candidate: Candidate;
  talent: Talent;
  actor: TalentActor;
  onResult: (error: TalentResult, okText: string) => void;
}) {
  const now = nowStamp();
  const req = talent.requisitions.find((r) => r.id === candidate.requisitionId);
  const info = pipelineInfo(candidate, req, now);
  const next = nextActionFor(candidate, talent, req, now);
  const interviews = interviewsOf(talent, candidate.id);
  const nextInterview = interviews.find((i) => i.when.replace(" ", "T") >= now);
  const offer = [...talent.offers].reverse().find((o) => o.candidateId === candidate.id);
  const moves = stageMovesFor(actor, candidate, talent.offers, req);
  const canSchedule = !!req && canRunPipeline(actor, req) && isRequisitionOpen(req) && candidate.stage === "Interview";

  const [target, setTarget] = useState("");
  const [note, setNote] = useState("");
  const [iv, setIv] = useState({ when: "", panel: req?.hiringManager ?? "", type: "Interview" });

  const log = [...info.history].reverse();

  return (
    <div>
      <CandidateStepper candidate={candidate} req={req} now={now} />
      {info.exit && (
        <p className="cp-exit">
          {info.exit.stage} on {fmtDate(info.exit.enteredOn)} at {stepperRows(candidate, info, now).find((r) => r.state === "stopped")?.stage ?? "—"}
          {info.exit.note ? ` · ${info.exit.note}` : ""}
        </p>
      )}

      {next && (
        <div className="cp-next">
          <span className="cp-next-label">Next step</span>
          <strong>{next.text}</strong>
          <span className="muted">Owner: {next.owner}</span>
        </div>
      )}

      <h3 className="cp-section-title">Candidate</h3>
      <dl className="cp-facts">
        <div className="cp-fact"><dt>Role</dt><dd>{candidate.role}</dd></div>
        <div className="cp-fact"><dt>Email</dt><dd><a href={`mailto:${candidate.email}`}>{candidate.email}</a></dd></div>
        <div className="cp-fact"><dt>Phone</dt><dd>{candidate.phone || "—"}</dd></div>
        <div className="cp-fact"><dt>Country</dt><dd>{candidate.country}</dd></div>
        <div className="cp-fact"><dt>Source</dt><dd>{candidate.source}</dd></div>
        <div className="cp-fact"><dt>Experience</dt><dd>{plural(candidate.experienceYears, "year")}</dd></div>
      </dl>
      {candidate.skills.length > 0 && (
        <p className="cp-skills">
          {candidate.skills.map((sk) => (
            <span key={sk} className="cp-skill">{sk}</span>
          ))}
        </p>
      )}
      {candidate.resumeNote && <p className="muted">{candidate.resumeNote}</p>}

      <h3 className="cp-section-title">Progress</h3>
      <dl className="cp-facts">
        <div className="cp-fact"><dt>Applied</dt><dd>{fmtDate(info.applied?.enteredOn)}</dd></div>
        <div className="cp-fact">
          <dt>{info.closed ? "Days to close" : "Days since applied"}</dt>
          <dd>{info.totalDays}</dd>
        </div>
        <div className="cp-fact">
          <dt>Current stage</dt>
          <dd>
            {candidate.stage}
            {!info.closed && ` · ${plural(info.daysInStage, "day")}`}
            {info.overdue && <span className="cp-flag"> · Overdue</span>}
          </dd>
        </div>
        <div className="cp-fact"><dt>Requisition</dt><dd>{req ? `${req.id} · ${req.approvalStatus}` : candidate.requisitionId}</dd></div>
        <div className="cp-fact"><dt>Recruiter</dt><dd>{req?.recruiter || "Not assigned"}</dd></div>
        <div className="cp-fact"><dt>Hiring manager</dt><dd>{req?.hiringManager ?? "—"}</dd></div>
      </dl>

      <h3 className="cp-section-title">Interviews</h3>
      {interviews.length === 0 ? (
        <p className="muted">None scheduled.</p>
      ) : (
        <ul className="todo">
          {interviews.map((i) => (
            <li key={i.id}>
              {i === nextInterview ? <strong>Next: </strong> : null}
              {fmtDateTime(i.when)} · {i.type} · {i.panel} · {i.feedbackStatus === "Submitted" ? `Feedback ${i.score}/5` : "Feedback pending"}
            </li>
          ))}
        </ul>
      )}
      {canSchedule && (
        <div className="cp-actions">
          <Field label="Date and time">
            <input type="datetime-local" min={now} value={iv.when} onChange={(e) => setIv((f) => ({ ...f, when: e.target.value }))} />
          </Field>
          <Field label="Panel">
            <input value={iv.panel} onChange={(e) => setIv((f) => ({ ...f, panel: e.target.value }))} placeholder="Names" />
          </Field>
          <Field label="Type">
            <input value={iv.type} onChange={(e) => setIv((f) => ({ ...f, type: e.target.value }))} />
          </Field>
          <button
            type="button"
            className="btn btn-tiny"
            disabled={!iv.when || !iv.panel.trim()}
            onClick={() => {
              const error = scheduleInterview(actor, candidate.id, iv);
              onResult(error, `Interview booked for ${fmtDateTime(iv.when)}.`);
              if (!error) setIv((f) => ({ ...f, when: "" }));
            }}
          >
            Schedule
          </button>
        </div>
      )}

      {offer && (
        <>
          <h3 className="cp-section-title">Offer</h3>
          <ul className="todo">
            <li>
              {offer.status} · {offer.grade}
              {offer.createdOn ? ` · prepared ${fmtDate(offer.createdOn)} by ${offer.createdBy}` : ` · by ${offer.createdBy}`}
            </li>
            {offer.approvals.map((a) => (
              <li key={a.role}>{a.role} approved · {a.by}, {fmtDate(a.on)}</li>
            ))}
            {offer.sentOn && <li>Sent {fmtDate(offer.sentOn)}</li>}
            {offer.respondedOn && (
              <li>
                {offer.status === "Declined" ? "Declined" : "Accepted"} {fmtDate(offer.respondedOn)} · start {fmtDate(offer.startDate)}
              </li>
            )}
          </ul>
        </>
      )}

      {moves.length > 0 && (
        <>
          <h3 className="cp-section-title">{candidate.stage === "Final Review" ? "Final Review decision" : "Move stage"}</h3>
          <div className="cp-actions">
            <Field label="To">
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">Select…</option>
                {moves.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </Field>
            <Field label="Note">
              <input value={note} maxLength={160} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
            </Field>
            <button
              type="button"
              className="btn btn-tiny"
              disabled={!target}
              onClick={() => {
                const error = setCandidateStage(actor, candidate.id, target as PipelineStage, note);
                onResult(error, target === "Hired" ? `${candidate.name} hired. Onboarding started.` : `${candidate.name} → ${target}.`);
                if (!error) {
                  setTarget("");
                  setNote("");
                }
              }}
            >
              Move
            </button>
          </div>
        </>
      )}

      <h3 className="cp-section-title">Activity</h3>
      <ul className="cp-log">
        {log.map((h, i) => (
          <li key={`${h.enteredOn}-${h.stage}-${i}`}>
            <time>{fmtDateTime(h.enteredOn)}</time>
            <strong>{h.stage}</strong> · {h.stage === "Applied" ? h.by : `by ${h.by}`}
            {h.note ? ` · ${h.note}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ───────────── Pipeline by month ───────────── */

const MOVE_WORD: Record<PipelineStage, string> = {
  Applied: "applied",
  Screening: "screened",
  Shortlisted: "shortlisted",
  Interview: "to interview",
  Assessment: "assessed",
  "Final Review": "final review",
  Offer: "to offer",
  Hired: "hired",
  Rejected: "rejected",
  Withdrawn: "withdrew",
};

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + by, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(month: string): string {
  return parseStamp(`${month}-01`).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

export function PipelineByMonth({
  candidates,
  talent,
  onOpen,
}: {
  candidates: Candidate[];
  talent: Talent;
  onOpen: (id: string) => void;
}) {
  const [month, setMonth] = useState(() => nowStamp().slice(0, 7));
  const now = nowStamp();

  const applied = useMemo(
    () =>
      candidates
        .map((c) => ({ c, info: pipelineInfo(c, talent.requisitions.find((r) => r.id === c.requisitionId), now) }))
        .filter(({ info }) => info.applied?.enteredOn.startsWith(month))
        .sort((a, b) => (a.info.applied?.enteredOn ?? "").localeCompare(b.info.applied?.enteredOn ?? "")),
    [candidates, talent.requisitions, month, now],
  );

  const moveCounts = useMemo(() => {
    const counts = new Map<PipelineStage, number>();
    for (const c of candidates) {
      for (const h of candidateHistory(c)) {
        if (h.enteredOn.startsWith(month)) counts.set(h.stage, (counts.get(h.stage) ?? 0) + 1);
      }
    }
    return PIPELINE_STAGES.filter((s) => counts.has(s)).map((s) => ({ stage: s, n: counts.get(s)! }));
  }, [candidates, month]);

  return (
    <div className="stack">
      <div className="cp-month-nav">
        <button type="button" className="btn-ghost btn-tiny" onClick={() => setMonth((m) => shiftMonth(m, -1))} aria-label="Previous month">
          ‹
        </button>
        <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} aria-label="Month" />
        <button type="button" className="btn-ghost btn-tiny" onClick={() => setMonth((m) => shiftMonth(m, 1))} aria-label="Next month">
          ›
        </button>
        <strong>{monthLabel(month)}</strong>
      </div>
      <div>
        <h3 className="cp-section-title">Stage moves</h3>
        {moveCounts.length === 0 ? (
          <p className="muted">No moves this month.</p>
        ) : (
          <div className="cp-chips">
            {moveCounts.map((m) => (
              <span key={m.stage} className="cp-chip">
                <strong>{m.n}</strong>
                {MOVE_WORD[m.stage]}
              </span>
            ))}
          </div>
        )}
      </div>
      <div>
        <h3 className="cp-section-title">Applied in {monthLabel(month)} · {applied.length}</h3>
        <DataTable
          headers={["Candidate", "Role", "Applied", "Stage", "Progress", "In stage"]}
          rows={applied.map(({ c, info }) => [
            <button key={c.id} type="button" className="quiet-link" onClick={() => onOpen(c.id)}>
              {c.name}
            </button>,
            c.role,
            fmtDate(info.applied?.enteredOn),
            <StatusBadge key={`${c.id}-s`} status={c.stage} literal tone={EXIT.includes(c.stage) ? "warn" : c.stage === "Hired" ? "ok" : "info"} />,
            <MiniStepper key={`${c.id}-m`} candidate={c} />,
            info.closed ? "—" : <span key={`${c.id}-d`} className={info.overdue ? "cp-flag" : ""}>{plural(info.daysInStage, "day")}</span>,
          ])}
          empty={<EmptyState title="No applications" description="Nobody applied this month." />}
        />
      </div>
    </div>
  );
}

/* ───────────── Add candidate ───────────── */

const EMPTY_CANDIDATE = { name: "", email: "", source: "", appliedOn: "" };

/** The recruiter or HR adds a candidate to an approved requisition; they start at Applied. */
export function AddCandidateForm({
  actor,
  talent,
  onResult,
}: {
  actor: TalentActor;
  talent: Talent;
  onResult: (error: TalentResult, okText: string) => void;
}) {
  const reqs = candidateIntakeRequisitions(actor, talent.requisitions);
  const [open, setOpen] = useState(false);
  const [reqId, setReqId] = useState("");
  const [form, setForm] = useState(() => ({ ...EMPTY_CANDIDATE, appliedOn: nowStamp().slice(0, 10) }));
  if (reqs.length === 0) return null;
  const req = reqs.find((r) => r.id === reqId) ?? reqs[0];
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  if (!open) {
    return (
      <div>
        <button type="button" className="btn btn-tiny" onClick={() => setOpen(true)}>
          Add candidate
        </button>
      </div>
    );
  }

  return (
    <form
      className="cp-actions"
      onSubmit={(e) => {
        e.preventDefault();
        const error = addCandidate(actor, { requisitionId: req.id, ...form });
        onResult(error, `${form.name.trim()} added to ${req.id} at ${PIPELINE_STAGES[0]}.`);
        if (!error) {
          setForm({ ...EMPTY_CANDIDATE, appliedOn: nowStamp().slice(0, 10) });
          setOpen(false);
        }
      }}
    >
      <Field label="Requisition">
        <select value={req.id} onChange={(e) => setReqId(e.target.value)}>
          {reqs.map((r) => (
            <option key={r.id} value={r.id}>{r.id} · {r.title}</option>
          ))}
        </select>
      </Field>
      <Field label="Name">
        <input value={form.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <Field label="Email">
        <input type="email" value={form.email} maxLength={120} onChange={(e) => set({ email: e.target.value })} />
      </Field>
      <Field label="Source">
        <input value={form.source} maxLength={40} list="cp-sources" onChange={(e) => set({ source: e.target.value })} placeholder="e.g. LinkedIn" />
        <datalist id="cp-sources">
          {["LinkedIn", "Referral", "Careers site", "Job board", "Agency"].map((src) => (
            <option key={src} value={src} />
          ))}
        </datalist>
      </Field>
      <Field label="Applied">
        <input type="date" value={form.appliedOn} max={nowStamp().slice(0, 10)} onChange={(e) => set({ appliedOn: e.target.value })} />
      </Field>
      <div className="row-gap">
        <button type="submit" className="btn btn-tiny" disabled={!form.name.trim() || !form.email.trim() || !form.source.trim() || !form.appliedOn}>
          Add
        </button>
        <button type="button" className="btn-ghost btn-tiny" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/* ───────────── Recruiter / hiring manager view ───────────── */

function weekBounds(today: string): [string, string] {
  const d = parseStamp(today);
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  return [nowStamp(monday).slice(0, 10), nowStamp(sunday).slice(0, 10)];
}

type CardRow = { c: Candidate; req: Requisition | undefined; info: PipelineInfo };

function cardRows(candidates: Candidate[], talent: Talent, now: string): CardRow[] {
  return candidates
    .map((c) => {
      const req = talent.requisitions.find((r) => r.id === c.requisitionId);
      return { c, req, info: pipelineInfo(c, req, now) };
    })
    .sort((a, b) => Number(a.info.closed) - Number(b.info.closed) || Number(b.info.overdue) - Number(a.info.overdue) || b.info.daysInStage - a.info.daysInStage);
}

/** One card per candidate: their details, where they are in the pipeline, and what happens next. */
export function CandidateCards({
  actor,
  talent,
  candidates,
  onOpen,
  onResult,
}: {
  actor: TalentActor;
  talent: Talent;
  candidates: Candidate[];
  onOpen: (id: string) => void;
  onResult?: (error: TalentResult, okText: string) => void;
}) {
  const now = nowStamp();
  const rows = cardRows(candidates, talent, now);
  const active = rows.filter((r) => !r.info.closed);
  const [show, setShow] = useState<"active" | "closed" | "all">("active");
  const shown = show === "active" ? active : show === "closed" ? rows.filter((r) => r.info.closed) : rows;
  const nextInterviewOf = (id: string) => talent.interviews.filter((i) => i.candidateId === id && i.when.replace(" ", "T") >= now).sort((a, b) => a.when.localeCompare(b.when))[0];

  return (
    <div className="stack">
      <div className="cp-filter" role="group" aria-label="Show candidates">
        {(["active", "closed", "all"] as const).map((v) => (
          <button key={v} type="button" className="btn-ghost btn-tiny" aria-pressed={show === v} onClick={() => setShow(v)}>
            {v === "active" ? `Active (${active.length})` : v === "closed" ? `Closed (${rows.length - active.length})` : `All (${rows.length})`}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <EmptyState title="No candidates" description={show === "active" ? "No active candidates." : "No candidates here."} />
      ) : (
        <div className="cp-cards">
          {shown.map(({ c, req, info }) => {
            const next = nextActionFor(c, talent, req, now);
            const upcoming = nextInterviewOf(c.id);
            const moves = req && req.approvalStatus === "Approved" ? stageMovesFor(actor, c, talent.offers, req) : [];
            return (
              <article key={c.id} className={`cp-card${info.overdue ? " is-overdue" : ""}`}>
                <header className="cp-card-head">
                  <div>
                    <button type="button" className="quiet-link cp-card-name" onClick={() => onOpen(c.id)}>
                      {c.name}
                    </button>
                    <span className="muted"> · {c.role} · {req ? req.id : c.requisitionId}</span>
                    <div className="muted cp-card-meta">
                      {c.email} · {c.phone || "no phone"} · {c.country} · {c.source} · {plural(c.experienceYears, "yr")} exp
                      {req?.recruiter ? ` · Recruiter ${req.recruiter}` : ""}
                    </div>
                  </div>
                  <StatusBadge status={c.stage} literal tone={EXIT.includes(c.stage) ? "warn" : c.stage === "Hired" ? "ok" : "info"} />
                </header>
                <CandidateStepper candidate={c} req={req} now={now} />
                <footer className="cp-card-foot">
                  {next ? (
                    <span>
                      <strong>Next:</strong> {next.text} <span className="muted">· {next.owner}</span>
                    </span>
                  ) : (
                    <span className="muted">{info.exit ? `${info.exit.stage} ${fmtDate(info.exit.enteredOn)}${info.exit.note ? ` · ${info.exit.note}` : ""}` : "Closed"}</span>
                  )}
                  <span className="muted">
                    Applied {fmtDate(info.applied?.enteredOn)}
                    {!info.closed && ` · ${plural(info.daysInStage, "day")} in stage`}
                    {upcoming && ` · Interview ${fmtDateTime(upcoming.when)}`}
                    {info.overdue && <span className="cp-flag"> · Overdue</span>}
                  </span>
                  <span className="cp-card-actions">
                    {onResult && moves.length > 0 && (
                      <select
                        aria-label={`Move ${c.name}`}
                        value=""
                        onChange={(e) => {
                          const target = e.target.value as PipelineStage;
                          if (!target) return;
                          onResult(setCandidateStage(actor, c.id, target), target === "Hired" ? `${c.name} hired. Onboarding started.` : `${c.name} → ${target}.`);
                        }}
                      >
                        <option value="">Move to…</option>
                        {moves.map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    )}
                    <button type="button" className="btn btn-tiny" onClick={() => onOpen(c.id)}>
                      Open
                    </button>
                  </span>
                </footer>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

type MyAction = { at: string; candidateId?: string; candidateName: string; text: string; note?: string };

/** Everything this person did in recruiting: stage moves, interviews, offers, candidates added. */
function actionsBy(actor: TalentActor, talent: Talent): MyAction[] {
  const out: MyAction[] = [];
  const isMe = (name?: string, id?: string) => (id ? id === actor.id : name === actor.fullName);
  for (const c of talent.candidates) {
    for (const h of candidateHistory(c)) {
      if (!isMe(h.by, h.byId)) continue;
      out.push({
        at: h.enteredOn,
        candidateId: c.id,
        candidateName: c.name,
        text: h.stage === "Applied" ? `Added ${c.name} to ${c.requisitionId}` : `Moved ${c.name} to ${h.stage}`,
        note: h.note,
      });
    }
  }
  for (const o of talent.offers) {
    if (!isMe(o.createdBy, o.createdById)) continue;
    if (o.createdOn) out.push({ at: o.createdOn, candidateId: o.candidateId, candidateName: o.candidateName, text: `Prepared offer for ${o.candidateName} (${o.grade})` });
    if (o.sentOn) out.push({ at: o.sentOn, candidateId: o.candidateId, candidateName: o.candidateName, text: `Sent offer to ${o.candidateName}` });
    if (o.respondedOn && o.responseRecordedBy === actor.fullName) {
      out.push({ at: o.respondedOn, candidateId: o.candidateId, candidateName: o.candidateName, text: `Recorded ${o.candidateName}'s answer: ${o.status}` });
    }
  }
  for (const r of talent.requisitions) {
    if (r.recruiterId !== actor.id) continue;
    const step = requisitionSteps(r).find((s) => s.label.toLowerCase().includes("recruiter") && s.done);
    if (step?.on) out.push({ at: step.on, candidateName: "", text: `Assigned ${r.id} · ${r.title}` });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** The person's own recruiting work: workload, this week's interviews and everything they did. */
export function MyPipeline({
  actor,
  talent,
  candidates,
  onOpen,
  onResult,
}: {
  actor: TalentActor;
  talent: Talent;
  candidates: Candidate[];
  onOpen: (id: string) => void;
  onResult?: (error: TalentResult, okText: string) => void;
}) {
  const now = nowStamp();
  const today = now.slice(0, 10);
  const [weekStart, weekEnd] = weekBounds(today);
  const reqs = myPipelineRequisitions(actor, talent.requisitions);
  const reqIds = new Set(reqs.map((r) => r.id));
  const mine = candidates.filter((c) => reqIds.has(c.requisitionId));
  const rows = cardRows(mine, talent, now);
  const active = rows.filter((r) => !r.info.closed);
  const overdue = active.filter((r) => r.info.overdue);
  const mineIds = new Set(mine.map((c) => c.id));
  const weekInterviews = talent.interviews
    .filter((i) => mineIds.has(i.candidateId))
    .filter((i) => i.when.slice(0, 10) >= weekStart && i.when.slice(0, 10) <= weekEnd)
    .sort((a, b) => a.when.localeCompare(b.when));
  const todayInterviews = weekInterviews.filter((i) => i.when.startsWith(today));
  const actions = actionsBy(actor, talent);
  const [limit, setLimit] = useState(15);
  const hires = actions.filter((a) => a.text.includes(" to Hired")).length;

  if (reqs.length === 0) return <EmptyState title="No requisitions" description="None assigned to you yet." />;

  return (
    <div className="stack">
      <p className="muted">
        {isHrRole(actor.role) ? "All requisitions." : `${reqs.length} requisition${reqs.length === 1 ? "" : "s"}: ${reqs.map((r) => r.id).join(", ")}.`}
      </p>
      {onResult && <AddCandidateForm actor={actor} talent={talent} onResult={onResult} />}
      <MetricGrid>
        <MetricCard label="Active candidates" value={active.length} />
        <MetricCard label="Overdue" value={overdue.length} hint={`Over ${STUCK_DAYS} days in a stage`} />
        <MetricCard label="Interviews this week" value={weekInterviews.length} hint={`${todayInterviews.length} today`} />
        <MetricCard label="My actions" value={actions.length} hint={`${hires} hire${hires === 1 ? "" : "s"}`} />
      </MetricGrid>

      <div>
        <h3 className="cp-section-title">Needs my action</h3>
        {(() => {
          const todo = active
            .map((r) => ({ ...r, next: nextActionFor(r.c, talent, r.req, now) }))
            .filter((r) => r.next && r.req?.recruiterId === actor.id && r.next.owner === (r.req?.recruiter || "Recruiter"));
          return todo.length === 0 ? (
            <p className="muted">Nothing waiting on you.</p>
          ) : (
            <ul className="todo">
              {todo.map((r) => (
                <li key={r.c.id}>
                  <button type="button" className="quiet-link" onClick={() => onOpen(r.c.id)}>
                    {r.c.name}
                  </button>{" "}
                  · {r.c.stage} · {r.next!.text}
                  {r.info.overdue && <span className="cp-flag"> · Overdue</span>}
                </li>
              ))}
            </ul>
          );
        })()}
      </div>

      <div>
        <h3 className="cp-section-title">This week's interviews</h3>
        {weekInterviews.length === 0 ? (
          <p className="muted">None this week.</p>
        ) : (
          <ul className="todo">
            {weekInterviews.map((i) => (
              <li key={i.id}>
                {i.when.startsWith(today) ? <strong>Today </strong> : null}
                {fmtDateTime(i.when)} ·{" "}
                <button type="button" className="quiet-link" onClick={() => onOpen(i.candidateId)}>
                  {i.candidateName}
                </button>{" "}
                · {i.type} · {i.panel}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3 className="cp-section-title">What I did</h3>
        {actions.length === 0 ? (
          <p className="muted">No actions yet.</p>
        ) : (
          <>
            <ul className="cp-log">
              {actions.slice(0, limit).map((a, i) => (
                <li key={`${a.at}-${i}`}>
                  <time>{fmtDateTime(a.at)}</time>
                  {a.candidateId ? (
                    <button type="button" className="quiet-link" onClick={() => onOpen(a.candidateId!)}>
                      {a.text}
                    </button>
                  ) : (
                    <span>{a.text}</span>
                  )}
                  {a.note ? <span className="muted"> · {a.note}</span> : null}
                </li>
              ))}
            </ul>
            {actions.length > limit && (
              <button type="button" className="btn-ghost btn-tiny" onClick={() => setLimit((n) => n + 20)}>
                Show more ({actions.length - limit})
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
