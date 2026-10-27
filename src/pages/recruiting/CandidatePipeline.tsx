import { useMemo, useState } from "react";
import { DataTable, EmptyState, Field, MetricCard, MetricGrid, StatusBadge } from "../../components/ui.tsx";
import { CLOSED_STAGES, PIPELINE_STAGES, type Candidate, type Interview, type PipelineStage, type Requisition, type StageStep } from "../../data/talentData.ts";
import {
  canRunPipeline,
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
  const rows = stepperRows(candidate, info, now);
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
      <ol className="cp-stepper" aria-label="Candidate pipeline">
        {rows.map((r) => (
          <li key={r.stage} className={`cp-step is-${r.state}${r.state === "current" && info.overdue ? " is-overdue" : ""}`}>
            <span className="cp-dot">{r.state === "done" ? "✓" : r.state === "stopped" ? "×" : ""}</span>
            <span className="cp-step-name">{r.stage}</span>
            <span className="cp-step-date">{r.step ? fmtDate(r.step.enteredOn) : "—"}</span>
            {r.days !== undefined && <span className="cp-step-days">{plural(r.days, "day")}</span>}
          </li>
        ))}
      </ol>
      {info.exit && (
        <p className="cp-exit">
          {info.exit.stage} on {fmtDate(info.exit.enteredOn)} at {rows.find((r) => r.state === "stopped")?.stage ?? "—"}
          {info.exit.note ? ` · ${info.exit.note}` : ""}
        </p>
      )}

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

/* ───────────── Recruiter / hiring manager view ───────────── */

function weekBounds(today: string): [string, string] {
  const d = parseStamp(today);
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  return [nowStamp(monday).slice(0, 10), nowStamp(sunday).slice(0, 10)];
}

export function MyPipeline({
  actor,
  talent,
  candidates,
  onOpen,
}: {
  actor: TalentActor;
  talent: Talent;
  candidates: Candidate[];
  onOpen: (id: string) => void;
}) {
  const now = nowStamp();
  const today = now.slice(0, 10);
  const [weekStart, weekEnd] = weekBounds(today);
  const reqs = myPipelineRequisitions(actor, talent.requisitions);
  const reqIds = new Set(reqs.map((r) => r.id));
  const mine = candidates.filter((c) => reqIds.has(c.requisitionId));
  const rows = mine
    .map((c) => ({ c, req: reqs.find((r) => r.id === c.requisitionId), info: pipelineInfo(c, reqs.find((r) => r.id === c.requisitionId), now) }))
    .sort((a, b) => Number(a.info.closed) - Number(b.info.closed) || Number(b.info.overdue) - Number(a.info.overdue) || b.info.daysInStage - a.info.daysInStage);
  const active = rows.filter((r) => !r.info.closed);
  const overdue = active.filter((r) => r.info.overdue);
  const mineIds = new Set(mine.map((c) => c.id));
  const weekInterviews = talent.interviews
    .filter((i) => mineIds.has(i.candidateId))
    .filter((i) => i.when.slice(0, 10) >= weekStart && i.when.slice(0, 10) <= weekEnd)
    .sort((a, b) => a.when.localeCompare(b.when));
  const todayInterviews = weekInterviews.filter((i) => i.when.startsWith(today));
  const nextInterviewOf = (id: string) => talent.interviews.filter((i) => i.candidateId === id && i.when.replace(" ", "T") >= now).sort((a, b) => a.when.localeCompare(b.when))[0];

  if (reqs.length === 0) return <EmptyState title="No requisitions" description="None assigned to you yet." />;

  return (
    <div className="stack">
      <p className="muted">
        {isHrRole(actor.role) ? "All requisitions." : `${reqs.length} requisition${reqs.length === 1 ? "" : "s"}: ${reqs.map((r) => r.id).join(", ")}.`}
      </p>
      <MetricGrid>
        <MetricCard label="Active candidates" value={active.length} />
        <MetricCard label="Overdue" value={overdue.length} hint={`Over ${STUCK_DAYS} days in a stage`} />
        <MetricCard label="Interviews today" value={todayInterviews.length} />
        <MetricCard label="Interviews this week" value={weekInterviews.length} hint={`${fmtDate(weekStart)} – ${fmtDate(weekEnd)}`} />
      </MetricGrid>

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

      <DataTable
        headers={["Candidate", "Req", "Stage", "Progress", "Since", "In stage", "Applied", "Next interview"]}
        rows={rows.map(({ c, req, info }) => [
          <button key={c.id} type="button" className="quiet-link" onClick={() => onOpen(c.id)}>
            {c.name}
          </button>,
          req ? `${req.id}${req.approvalStatus !== "Approved" ? ` (${req.approvalStatus.toLowerCase()})` : ""}` : c.requisitionId,
          <StatusBadge key={`${c.id}-s`} status={c.stage} literal tone={EXIT.includes(c.stage) ? "warn" : c.stage === "Hired" ? "ok" : "info"} />,
          <MiniStepper key={`${c.id}-m`} candidate={c} />,
          fmtDate(info.current.enteredOn),
          info.closed ? "—" : (
            <span key={`${c.id}-d`} className={info.overdue ? "cp-flag" : ""}>
              {plural(info.daysInStage, "day")}
              {info.overdue ? " · Overdue" : ""}
            </span>
          ),
          fmtDate(info.applied?.enteredOn),
          (() => {
            const n = nextInterviewOf(c.id);
            return n ? `${fmtDateTime(n.when)} · ${n.panel}` : "—";
          })(),
        ])}
        empty={<EmptyState title="No candidates" description="No candidates on your requisitions." />}
      />
    </div>
  );
}
