import { useEffect, useMemo, useState, useSyncExternalStore, type InputHTMLAttributes } from "react";
import { getPerson } from "../data/peopleLocal.ts";
import { hasStarted } from "../data/peopleData.ts";
import { API_ENABLED } from "../api/client.ts";
import { apiMyRecruitingActivity, type ActivityOut } from "../api/syncTalent.ts";
import { Link } from "react-router-dom";
import {
  Banner,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  FilterBar,
  MetricCard,
  MetricGrid,
  Page,
  StatusBadge,
  Tabs,
} from "../components/ui.tsx";
import {
  LEARNING_PATHS,
  LEVEL_RANK,
  PIPELINE_STAGES,
  RATINGS,
  SKILL_LIBRARY,
  TARGET_ROLES,
  starterSkillsFor,
  type Certification,
  type Enrollment,
  type OfferRecord,
  type OfferStatus,
  type OnboardingJoiner,
  type OnboardingTask,
  type PreboardingForm,
  EQUIPMENT_ITEMS,
  EQUIPMENT_LABEL,
  type Requisition,
  type PerfGoal,
  type PerfReview,
} from "../data/talentData.ts";
import {
  advanceCycle,
  allCycles,
  createReviewCycle,
  pending360For,
  type CycleInput,
  approveOffer,
  averageTimeToHire,
  bandFor,
  canRaiseRequisition,
  myPipelineRequisitions,
  raiseRequisition,
  recruiterOptions,
  DEFAULT_RECRUITER_ID,
  canApproveOffer,
  isHiringManagerOf,
  isTaskOwner,
  needsCompApproval,
  offerApprovalNeeded,
  requisitionApprovalCompletes,
  requisitionApprovers,
  requisitionFlowSteps,
  requisitionWaitingFor,
  canAcknowledgePolicies,
  isJoinerSelf,
  canEditGoal,
  canViewReview,
  canWriteManagerReview,
  courseOpenTo,
  cycleCompletion,
  cycleStatusOf,
  earnedCertificate,
  goalOwnerOptions,
  goalWeightTotal,
  inReviewCycle,
  isAboveInChain,
  isCertExpired,
  isHrRole,
  nextCycleStatus,
  PASS_MARK,
  releaseRating,
  saveGoal,
  saveManagerAssessment,
  saveSelfAssessment,
  set360Status,
  setRating,
  verifyCertification,
  visibleRating,
  type GoalInput,
  courseCatalog,
  talentAction,
  talentApiNotice,
  clearTalentApiNotice,
  type TalentActor,
  canEditOnboarding,
  canEditRecruiting,
  canSubmitInterviewFeedback,
  completeEnrollment,
  createOffer,
  enrollInCourse,
  getTalentState,
  offerEligibleCandidates,
  offerMoves,
  requestCertificationRenewal,
  requisitionMoves,
  SELF_PROGRESS_CAP,
  setJoinerPolicyAck,
  setOnboardingTaskStatus,
  submitPreboarding,
  setOfferStatus,
  setRequisitionApproval,
  skillProfileFor,
  SKILL_LEVELS,
  submitInterviewFeedback,
  subscribeTalent,
  updateEmployeeSkill,
  updateEnrollmentProgress,
  updateGoalProgress,
  verifyCertificationRenewal,
} from "../data/talentLocal.ts";
import { accountHasNavAccess } from "../demoAccounts.ts";
import { candidateAccess } from "../data/rbac.ts";
import { RegionalFilter } from "../locale/RegionalFilter.tsx";
import { useLocale } from "../locale/LocaleContext.tsx";
import { TIMEZ_COUNTRIES, maskEmail, todayISO } from "../model.ts";
import { money } from "../countryPay.ts";
import { GRADE_BANDS } from "../data/rewardData.ts";
import { usePortal } from "../store.tsx";
import { MaskedValue } from "../components/MaskedValue.tsx";
import { canRevealCandidate, candidateRevealer } from "../data/piiReveal.ts";
import { Award, Download, Eye } from "lucide-react";
import {
  CertificateDialog,
  credentialCode,
  downloadCertificatePng,
  type CertificateDoc,
} from "../components/CertificateViewer.tsx";
import { canManagePeople } from "../data/peoplePermissions.ts";
import { DevPlanEditor, FeedbackPanel, OneOnOnePanel, Pending360Requests, Reviewers360 } from "./PerformanceCheckIns.tsx";
import { CandidateCards, CandidatePipelineView, CompareCandidates, MyPipeline, PipelineByMonth, RequisitionTracker } from "./recruiting/CandidatePipeline.tsx";
import { canSeeTeamInterests, CareerInterestsPanel, RoleMatchesPanel, SkillsLibraryPanel, TeamInterestsPanel } from "./CareerPanels.tsx";
import { apiTargetRoles } from "../api/syncCareer.ts";

function useTalent() {
  return useSyncExternalStore(subscribeTalent, getTalentState, getTalentState);
}

function Progress({ value, label }: { value: number; label?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="dash-progress">
      {label && (
        <div className="dash-progress-meta">
          <span>{label}</span>
          <span>{pct}%</span>
        </div>
      )}
      <div className="dash-progress-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="dash-progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/**
 * Range input for progress. Without the backend each move is saved at once (as before); in backend mode the value
 * is sent once the person lets go, and `settled` is called when the server has answered.
 */
function ProgressSlider({
  value,
  onCommit,
  ...rest
}: { value: number; onCommit: (value: number, settled: () => void) => void } & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type">) {
  const [draft, setDraft] = useState<number | null>(null);
  if (!API_ENABLED) return <input {...rest} type="range" value={value} onChange={(e) => onCommit(Number(e.target.value), () => {})} />;
  const commit = () => {
    if (draft === null) return;
    if (draft === value) setDraft(null);
    else onCommit(draft, () => setDraft(null));
  };
  return <input {...rest} type="range" value={draft ?? value} onChange={(e) => setDraft(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} onBlur={commit} />;
}

function MiniBars({ items }: { items: { label: string; value: number }[] }) {
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <ul className="mini-bars">
      {items.map((item) => (
        <li key={item.label}>
          <span className="mini-bars-label">{item.label}</span>
          <div className="mini-bars-track">
            <div className="mini-bars-fill" style={{ width: `${(item.value / max) * 100}%` }} />
          </div>
          <span className="mini-bars-value">{item.value}</span>
        </li>
      ))}
    </ul>
  );
}

/* ───────────────────────────── RECRUITING ── */

type Notice = { tone: "ok" | "err"; text: string } | null;

/** Turns a TalentResult into a banner message. */
function noticeFor(error: string | null, okText?: string): Notice {
  if (error) return { tone: "err", text: error };
  return okText ? { tone: "ok", text: okText } : null;
}

/** Backend mode: a change made on another page (e.g. Approvals) that the server refused. */
function TalentApiNotice() {
  const text = useSyncExternalStore(subscribeTalent, talentApiNotice, talentApiNotice);
  if (!text) return null;
  return (
    <p className="note" role="alert">
      {text}{" "}
      <button type="button" className="quiet-link" onClick={clearTalentApiNotice}>
        Dismiss
      </button>
    </p>
  );
}

const ACTIVITY_LABEL: Record<string, string> = {
  requisition_raised: "Raised requisition",
  requisition_on_hold: "Put requisition on hold",
  requisition_resumed: "Resumed requisition",
  candidate_added: "Added candidate",
  candidate_updated: "Updated candidate",
  candidate_stage_moved: "Moved candidate",
  candidate_cv_uploaded: "Uploaded CV",
  interview_scheduled: "Scheduled interview",
  interview_feedback_submitted: "Gave interview feedback",
  offer_created: "Prepared offer",
  offer_submitted: "Submitted offer",
  offer_approved: "Approved offer",
  offer_step_approved: "Approved offer step",
  offer_sent_back: "Sent offer back",
  offer_sent: "Sent offer",
  offer_accepted: "Recorded offer accepted",
  offer_declined: "Recorded offer declined",
  offer_withdrawn: "Withdrew offer",
};

/** Backend mode: recruiting actions I took in the last 90 days (loaded when opened). */
function MyRecruitingActivity() {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ActivityOut[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    let live = true;
    apiMyRecruitingActivity(90, 30)
      .then((r) => live && setRows(r))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : "Could not load your activity."));
    return () => {
      live = false;
    };
  }, [open]);
  return (
    <details className="card" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>My recent recruiting activity</summary>
      {error ? (
        <p className="muted">{error}</p>
      ) : !rows ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted">Nothing in the last 90 days.</p>
      ) : (
        <ul className="todo">
          {rows.map((r, i) => {
            const stage = typeof r.details?.stage === "string" && r.action === "candidate_stage_moved" ? ` → ${r.details.stage}` : "";
            return (
              <li key={`${r.at}-${i}`}>
                {new Date(r.at).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })} ·{" "}
                {ACTIVITY_LABEL[r.action] ?? r.action.replace(/_/g, " ")} · {r.entity_id ?? r.entity}
                {stage}
              </li>
            );
          })}
        </ul>
      )}
    </details>
  );
}

function NotAuthorized({ module }: { module: string }) {
  return (
    <Page title={module}>
      <EmptyState title="Not authorized" description={`Your role does not have access to ${module}.`} />
    </Page>
  );
}

export function RecruitingPage() {
  const talent = useTalent();
  const { demoProfile } = usePortal();
  const actor = demoProfile;
  const { matchesRegion, t } = useLocale();
  const [tab, setTab] = useState(() => (actor.role === "recruiter" ? "mine" : "reqs"));
  const [openCand, setOpenCand] = useState<string | null>(null);
  const [assignTo, setAssignTo] = useState(DEFAULT_RECRUITER_ID);
  const [raiseOpen, setRaiseOpen] = useState(false);
  const [raiseForm, setRaiseForm] = useState({ title: "", department: "", country: "", location: "", openings: "1" });
  const [q, setQ] = useState("");
  const [stageFilter, setStageFilter] = useState("");
  const [selectedCand, setSelectedCand] = useState(talent.candidates[0]?.id ?? "");
  const [selectedReq, setSelectedReq] = useState(talent.requisitions[0]?.id ?? "");
  const [fbInterview, setFbInterview] = useState("");
  const [fbScore, setFbScore] = useState("4");
  const [fbText, setFbText] = useState("");
  const [offerForm, setOfferForm] = useState({ candidateId: "", grade: "", baseSalary: "", startDate: "", packageNote: "" });
  const [reqNote, setReqNote] = useState("");
  const [notice, setNotice] = useState<Notice>(null);

  // Recruiters, HR and hiring managers work here; others with nav access read only.
  const canEdit = canEditRecruiting(actor.role) || talent.requisitions.some((r) => isHiringManagerOf(actor, r));
  const canOpen = canEdit || accountHasNavAccess(actor, "recruiting");

  const candAccess = candidateAccess(demoProfile, true);
  const maskCandidates = candAccess === "masked";
  // A hiring manager always sees their own requisitions' candidates.
  const hmReqIds = useMemo(
    () => new Set(talent.requisitions.filter((r) => isHiringManagerOf(actor, r)).map((r) => r.id)),
    [talent.requisitions, actor],
  );
  const accessFor = (c: { requisitionId: string }) =>
    hmReqIds.has(c.requisitionId) ? "full" : candAccess;
  const canSeeCandidates = candAccess !== "hidden" || hmReqIds.size > 0;

  const regionReqs = useMemo(
    () => talent.requisitions.filter((r) => matchesRegion(undefined, r.country)),
    [talent.requisitions, matchesRegion],
  );
  // Position counts and the requisition list: HR and executives see all; recruiters their assigned ones; managers their own.
  const scopeAll = isHrRole(actor.role) || ["executive", "founder", "cofounder"].includes(actor.role);
  const scopeReqs = scopeAll ? regionReqs : myPipelineRequisitions(actor, regionReqs);
  const showMine = isHrRole(actor.role) || myPipelineRequisitions(actor, talent.requisitions).length > 0;

  const candidates = useMemo(() => {
    if (!canSeeCandidates) return [];
    return talent.candidates.filter((c) => {
      if (accessFor(c) === "hidden") return false;
      if (!matchesRegion(undefined, c.country)) return false;
      if (stageFilter && c.stage !== stageFilter) return false;
      if (q && !`${c.name} ${c.role} ${c.email}`.toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [talent.candidates, q, stageFilter, matchesRegion, canSeeCandidates, hmReqIds, candAccess]);

  // Your own pipeline covers every requisition you work, whichever region the top bar shows.
  const pipelineCandidates = canSeeCandidates
    ? talent.candidates.filter(
        (c) =>
          accessFor(c) !== "hidden" &&
          (!stageFilter || c.stage === stageFilter) &&
          (!q || `${c.name} ${c.role} ${c.email}`.toLowerCase().includes(q.toLowerCase())),
      )
    : [];

  if (!canOpen) return <NotAuthorized module="Recruiting" />;

  const reqById = (id: string) => talent.requisitions.find((r) => r.id === id);
  const candidate = candidates.find((c) => c.id === selectedCand) ?? candidates[0];
  const requisition = scopeReqs.find((r) => r.id === selectedReq) ?? scopeReqs[0];
  const openCandidate = openCand ? talent.candidates.find((c) => c.id === openCand && accessFor(c) !== "hidden") : undefined;
  const reqMoves = requisition ? requisitionMoves(actor, requisition) : [];
  const feedbackInterviews = talent.interviews.filter(
    (i) => i.feedbackStatus === "Pending" && canSubmitInterviewFeedback(actor, i),
  );
  const offerCandidates = offerEligibleCandidates(talent, actor);
  const offerCandidate = offerCandidates.find((c) => c.id === offerForm.candidateId);
  const offerReq = offerCandidate ? reqById(offerCandidate.requisitionId) : undefined;
  const offerCurrency = TIMEZ_COUNTRIES.find((c) => c.name === offerReq?.country)?.currency ?? "";
  const offerBand = offerReq && offerForm.grade ? bandFor({ grade: offerForm.grade }, offerReq) : undefined;

  const stageCounts = PIPELINE_STAGES.map((stage) => ({
    label: stage.replace("Final Review", "Final"),
    value: candidates.filter((c) => c.stage === stage).length,
  }));

  const approvedReqs = scopeReqs.filter((r) => r.approvalStatus === "Approved");
  const totalPositions = approvedReqs.reduce((n, r) => n + r.openings, 0);
  const filledPositions = approvedReqs.reduce(
    (n, r) => n + Math.min(r.openings, talent.candidates.filter((c) => c.requisitionId === r.id && c.stage === "Hired").length),
    0,
  );
  const awaitingReqs = scopeReqs.filter((r) => r.approvalStatus === "Pending approval");
  const onHoldReqs = scopeReqs.filter((r) => r.approvalStatus === "On hold");
  const pendingFeedback = talent.interviews.filter((i) => i.feedbackStatus === "Pending").length;
  const offersOut = talent.offers.filter((o) => ["Preparing", "Pending approval", "Approved", "Sent"].includes(o.status)).length;
  const timeToHire = averageTimeToHire(talent);

  function submitFeedback() {
    const score = Number(fbScore);
    talentAction(() => submitInterviewFeedback(actor, fbInterview, score, fbText), (error) => {
      setNotice(noticeFor(error, "Interview feedback submitted."));
      if (!error) {
        setFbInterview("");
        setFbText("");
      }
    });
  }

  function prepareOffer() {
    const input = {
      candidateId: offerForm.candidateId,
      grade: offerForm.grade,
      baseSalary: Number(offerForm.baseSalary),
      startDate: offerForm.startDate,
      packageNote: offerForm.packageNote,
    };
    talentAction(() => createOffer(actor, input), (error) => {
      setNotice(noticeFor(error, "Offer created."));
      if (!error) setOfferForm({ candidateId: "", grade: "", baseSalary: "", startDate: "", packageNote: "" });
    });
  }

  return (
    <Page title="Recruiting">
      {(maskCandidates || !canEdit) && (
        <p className="note">
          {maskCandidates ? "Contact details are masked for your role." : ""}
          {!canEdit ? " Read-only." : ""}
        </p>
      )}
      <Banner message={notice} />
      <TalentApiNotice />
      {API_ENABLED && canEdit && <MyRecruitingActivity />}
      <MetricGrid>
        <MetricCard label="Total positions" value={totalPositions} hint={`${approvedReqs.length} approved req${approvedReqs.length === 1 ? "" : "s"}`} />
        <MetricCard label="Open" value={totalPositions - filledPositions} />
        <MetricCard label="Filled" value={filledPositions} />
        <MetricCard
          label="Awaiting approval"
          value={awaitingReqs.length}
          hint={`${awaitingReqs.reduce((n, r) => n + r.openings, 0)} positions`}
        />
        <MetricCard label="On hold" value={onHoldReqs.length} hint={`${onHoldReqs.reduce((n, r) => n + r.openings, 0)} positions`} />
      </MetricGrid>
      <MetricGrid>
        <MetricCard label="Candidates (region)" value={candidates.length} />
        <MetricCard label="Pending feedback" value={pendingFeedback} />
        <MetricCard label="Offers in flight" value={offersOut} />
      </MetricGrid>

      <FilterBar>
        <RegionalFilter label={t("locale.region")} />
        <label className="filter-label">
          Search candidates
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, role, email…" />
        </label>
        <label className="filter-label">
          Pipeline stage
          <select value={stageFilter} onChange={(e) => setStageFilter(e.target.value)}>
            <option value="">All</option>
            {PIPELINE_STAGES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
      </FilterBar>

      <Tabs
        tabs={[
          ...(showMine ? [{ id: "mine", label: isHrRole(actor.role) ? "All pipelines" : "My pipeline" }] : []),
          { id: "reqs", label: "Requisitions" },
          { id: "pipeline", label: "Pipeline" },
          { id: "month", label: "By month" },
          { id: "candidates", label: "Candidates" },
          { id: "interviews", label: "Interviews" },
          { id: "offers", label: "Offers" },
          { id: "analytics", label: "Analytics" },
        ]}
        value={tab}
        onChange={(id) => {
          setTab(id);
          setNotice(null);
        }}
      />

      {tab === "reqs" && (
        <div className="mgr-home-grid">
          <Card title="Job requisitions">
            <DataTable
              headers={["ID", "Title", "Dept", "Location", "Openings", "Approval", ""]}
              rows={scopeReqs.map((r) => [
                r.id,
                r.title,
                r.department,
                `${r.location}, ${r.country}`,
                String(r.openings),
                <StatusBadge
                  key={r.id}
                  status={r.approvalStatus}
                  literal
                  tone={r.approvalStatus === "Approved" ? "ok" : r.approvalStatus === "Rejected" || r.approvalStatus === "On hold" ? "warn" : "info"}
                />,
                <button key={`${r.id}-v`} type="button" className="quiet-link" onClick={() => {
                    setSelectedReq(r.id);
                    setReqNote("");
                    setTimeout(() => document.getElementById("req-detail")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
                  }}>
                  Details
                </button>,
              ])}
              empty={<EmptyState title="No requisitions" description="None in your scope." />}
            />
            {canRaiseRequisition(actor) && (
              <div className="stack" style={{ marginTop: 12 }}>
                {!raiseOpen ? (
                  <div>
                    <button type="button" className="btn btn-tiny" onClick={() => setRaiseOpen(true)}>
                      Raise requisition
                    </button>
                  </div>
                ) : (
                  <div className="form-grid-2">
                    <Field label="Job title">
                      <input value={raiseForm.title} onChange={(e) => setRaiseForm((f) => ({ ...f, title: e.target.value }))} />
                    </Field>
                    <Field label="Department">
                      <input value={raiseForm.department} onChange={(e) => setRaiseForm((f) => ({ ...f, department: e.target.value }))} />
                    </Field>
                    <Field label="Country">
                      <select value={raiseForm.country} onChange={(e) => setRaiseForm((f) => ({ ...f, country: e.target.value }))}>
                        <option value="">Select…</option>
                        {TIMEZ_COUNTRIES.map((c) => (
                          <option key={c.code} value={c.name}>{c.name}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Location">
                      <input value={raiseForm.location} onChange={(e) => setRaiseForm((f) => ({ ...f, location: e.target.value }))} />
                    </Field>
                    <Field label="Openings">
                      <input type="number" min={1} max={50} value={raiseForm.openings} onChange={(e) => setRaiseForm((f) => ({ ...f, openings: e.target.value }))} />
                    </Field>
                    <div className="row-gap">
                      <button
                        type="button"
                        className="btn btn-tiny"
                        onClick={() => {
                          const input = { ...raiseForm, openings: Number(raiseForm.openings) };
                          talentAction(() => raiseRequisition(actor, input), (error) => {
                            setNotice(noticeFor(error, "Requisition raised. Sent for approval."));
                            if (!error) {
                              setRaiseOpen(false);
                              setRaiseForm({ title: "", department: "", country: "", location: "", openings: "1" });
                            }
                          });
                        }}
                      >
                        Send for approval
                      </button>
                      <button type="button" className="btn-ghost btn-tiny" onClick={() => setRaiseOpen(false)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </Card>
          {requisition && (
            <div id="req-detail">
            <Card title={`Requisition · ${requisition.id}`}>
              <RequisitionTracker req={requisition} />
              <p className="muted">
                Approval:{" "}
                {requisitionFlowSteps(requisition)
                  .map((s) =>
                    s.groups && s.groups.length > 1
                      ? `${s.label} (${s.mode === "any" ? "any of" : "all of"} ${s.groups.map((g) => g.label.replace(/ approval$/, "")).join(", ")})`
                      : s.label,
                  )
                  .join(" → ") || "none"}
                {requisition.workflowVersion ? ` · workflow v${requisition.workflowVersion}` : ""}
              </p>
              <dl className="info-grid">
                <div className="info-fact"><dt>Title</dt><dd>{requisition.title}</dd></div>
                <div className="info-fact"><dt>Hiring manager</dt><dd>{requisition.hiringManager}</dd></div>
                <div className="info-fact"><dt>Recruiter</dt><dd>{requisition.recruiter || "Not assigned"}</dd></div>
                <div className="info-fact"><dt>Created</dt><dd>{requisition.created}</dd></div>
                <div className="info-fact"><dt>Status</dt><dd>{requisition.stageSummary}</dd></div>
                <div className="info-fact">
                  <dt>Approval</dt>
                  <dd>
                    {requisition.approvalStatus}
                    {requisition.approver ? ` · ${requisition.approver}, ${requisition.decidedOn ?? ""}` : ""}
                  </dd>
                </div>
              </dl>
              {reqMoves.length > 0 ? (
                <div className="stack">
                  {reqMoves.some((m) => m !== "Pending approval") && (
                    <input aria-label="Requisition note" value={reqNote} maxLength={200} onChange={(e) => setReqNote(e.target.value)} placeholder="Note (optional)" />
                  )}
                  {reqMoves.includes("Approved") && !requisition.recruiterId && requisitionApprovalCompletes(actor, requisition) && (
                    <Field label="Assign recruiter">
                      <select value={assignTo} onChange={(e) => setAssignTo(e.target.value)}>
                        {recruiterOptions().map((a) => (
                          <option key={a.id} value={a.id}>{a.fullName}</option>
                        ))}
                      </select>
                    </Field>
                  )}
                  <div className="row-gap">
                    {reqMoves.map((next) => (
                      <button
                        key={next}
                        type="button"
                        className={next === "Approved" || next === "Pending approval" ? "btn btn-tiny" : "btn-ghost btn-tiny"}
                        onClick={() => {
                          const before = requisitionWaitingFor(requisition);
                          talentAction(() => setRequisitionApproval(actor, requisition.id, next, reqNote, assignTo), (error) => {
                            const after = getTalentState().requisitions.find((r) => r.id === requisition.id);
                            const okText =
                              next === "Approved" && after?.approvalStatus === "Pending approval"
                                ? `${requisition.id}: approved. ${requisitionWaitingFor(after) === before ? "Waiting for the other approvers." : `Now with ${requisitionWaitingFor(after).split(" · ")[0]!.toLowerCase()}.`}`
                                : next === "Pending approval"
                                  ? `${requisition.id}: sent for approval.`
                                  : `${requisition.id}: ${next}.`;
                            setNotice(noticeFor(error, okText));
                            if (!error) setReqNote("");
                          });
                        }}
                      >
                        {next === "Pending approval" ? "Send for approval" : next === "On hold" ? "Put on hold" : next === "Approved" ? (requisition.recruiterId || !requisitionApprovalCompletes(actor, requisition) ? "Approve" : "Approve & assign") : "Reject"}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="muted">
                  {requisition.approvalStatus === "Pending approval" || requisition.approvalStatus === "On hold"
                    ? `Waiting for ${requisitionWaitingFor(requisition) || "HR"} (${requisitionApprovers(requisition).map((a) => a.fullName).join(", ") || "no approver available"}).`
                    : requisition.approvalStatus === "Draft"
                      ? "Draft."
                      : ""}
                </p>
              )}
              {(requisition.history ?? []).length > 0 && (
                <>
                  <h3 style={{ fontSize: 14, marginTop: 12 }}>History</h3>
                  <ul className="todo">
                    {requisition.history.map((h, i) => (
                      <li key={i}>
                        {h.on} · {h.action} by {h.by}
                        {h.note ? ` · ${h.note}` : ""}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </Card>
            </div>
          )}
        </div>
      )}

      {tab === "pipeline" && (
        <div className="stack">
          <Card title="Recruitment pipeline">
            <MiniBars items={stageCounts} />
          </Card>
          <Card title="Candidates">
            {canSeeCandidates ? (
              <CandidateCards actor={actor} talent={talent} candidates={pipelineCandidates} onOpen={setOpenCand} onResult={(error, okText) => setNotice(noticeFor(error, okText))} />
            ) : (
              <EmptyState title="Candidates restricted" description="Your role can't view candidates." />
            )}
          </Card>
          {API_ENABLED && canSeeCandidates && (
            <Card title="Compare candidates">
              <CompareCandidates actor={actor} talent={talent} candidates={pipelineCandidates} />
            </Card>
          )}
        </div>
      )}

      {tab === "mine" && showMine && (
        <Card title={isHrRole(actor.role) ? "All pipelines" : "My pipeline"}>
          <MyPipeline actor={actor} talent={talent} candidates={pipelineCandidates} onOpen={setOpenCand} onResult={(error, okText) => setNotice(noticeFor(error, okText))} />
        </Card>
      )}

      {tab === "month" && (
        <Card title="Pipeline by month">
          {canSeeCandidates ? (
            <PipelineByMonth candidates={candidates} talent={talent} onOpen={setOpenCand} />
          ) : (
            <EmptyState title="Candidates restricted" description="Your role can't view candidates." />
          )}
        </Card>
      )}

      {tab === "candidates" && (
        <div className="mgr-home-grid">
          <Card title="Candidate directory">
            <DataTable
              headers={["Name", "Role", "Country", "Stage", ""]}
              rows={candidates.map((c) => [
                c.name,
                c.role,
                c.country,
                c.stage,
                <span key={`${c.id}-o`} className="row-gap">
                  <button type="button" className="quiet-link" onClick={() => {
                    setSelectedCand(c.id);
                    setTimeout(() => document.getElementById("cand-detail")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
                  }}>
                    Profile
                  </button>
                  <button type="button" className="quiet-link" onClick={() => setOpenCand(c.id)}>
                    Pipeline
                  </button>
                </span>,
              ])}
              empty={<EmptyState title="No matches" description="Try clearing search or stage filter." />}
            />
          </Card>
          {candidate && canSeeCandidates && (
            <div id="cand-detail">
            <Card title={`Profile · ${candidate.name}`}>
              <dl className="info-grid">
                <div className="info-fact">
                  <dt>Email</dt>
                  <dd>{accessFor(candidate) === "masked" ? maskEmail(candidate.email) : candidate.email}</dd>
                </div>
                <div className="info-fact">
                  <dt>Phone</dt>
                  <dd>
                    <MaskedValue
                      value={candidate.phone}
                      kind="phone"
                      canReveal={accessFor(candidate) !== "masked" && canRevealCandidate(demoProfile)}
                      onReveal={candidateRevealer(candidate.id, candidate.phone)}
                    />
                  </dd>
                </div>
                <div className="info-fact"><dt>Requisition</dt><dd>{candidate.requisitionId}</dd></div>
                <div className="info-fact"><dt>Source</dt><dd>{candidate.source}</dd></div>
                <div className="info-fact"><dt>Experience</dt><dd>{candidate.experienceYears} years</dd></div>
                <div className="info-fact"><dt>Skills</dt><dd>{candidate.skills.join(", ")}</dd></div>
              </dl>
              <p className="note">{accessFor(candidate) === "masked" ? "Resume details limited for this role." : candidate.resumeNote}</p>
            </Card>
            </div>
          )}
          {!canSeeCandidates && <EmptyState title="Candidates restricted" description="Your role can't view candidate profiles." />}
        </div>
      )}

      {tab === "interviews" && (
        <div className="mgr-home-grid">
          <Card title="Interview schedule">
            <DataTable
              headers={["When", "Candidate", "Role", "Panel", "Feedback"]}
              rows={talent.interviews.map((i) => [
                i.when,
                i.candidateName,
                i.role,
                i.panel,
                <StatusBadge key={i.id} status={i.feedbackStatus} literal tone={i.feedbackStatus === "Submitted" ? "ok" : "warn"} />,
              ])}
            />
          </Card>
          <Card title="Submit interview feedback">
            {feedbackInterviews.length === 0 ? (
              <EmptyState title="Nothing to submit" description="No pending interviews for you." />
            ) : (
              <>
                <Field label="Interview">
                  <select value={fbInterview} onChange={(e) => setFbInterview(e.target.value)}>
                    <option value="">Select…</option>
                    {feedbackInterviews.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.candidateName} · {i.when}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Score (1–5)">
                  <input type="number" min={1} max={5} step={1} value={fbScore} onChange={(e) => setFbScore(e.target.value)} />
                </Field>
                <Field label="Feedback notes" wide>
                  <textarea rows={3} value={fbText} onChange={(e) => setFbText(e.target.value)} placeholder="Observations for the hiring panel…" />
                </Field>
                <button type="button" className="btn" disabled={!fbInterview || !fbText.trim()} onClick={submitFeedback}>
                  Submit feedback
                </button>
              </>
            )}
          </Card>
        </div>
      )}

      {tab === "offers" && (
        <div className="stack">
          <Card title="Offers">
            <DataTable
              headers={["Candidate", "Role", "Grade", "Base", "Start", "Status", "Approvals", "Actions"]}
              rows={talent.offers.map((o) => {
                const req = reqById(o.requisitionId);
                return [
                  o.candidateName,
                  o.role,
                  o.grade,
                  money(o.baseSalary, o.currency),
                  o.startDate,
                  <span key={o.id} className="stack">
                    <StatusBadge status={o.status} literal />
                    {o.responseNote && (
                      <span className="muted">
                        {o.responseNote} ({[o.responseRecordedBy, o.respondedOn].filter(Boolean).join(", ")})
                      </span>
                    )}
                  </span>,
                  o.approvals.length ? o.approvals.map((a) => `${a.role}: ${a.by}, ${a.on}`).join(" · ") : "—",
                  <OfferActions key={`${o.id}-a`} offer={o} req={req} actor={actor} onResult={setNotice} />,
                ];
              })}
              empty={<EmptyState title="No offers" description="Create offers once the hiring manager moves a candidate to Offer." />}
            />
          </Card>
          {canEdit && (
            <Card title="Prepare an offer">
              {offerCandidates.length === 0 ? (
                <EmptyState title="No eligible candidates" description="Needs a candidate the hiring manager moved to Offer." />
              ) : (
                <div className="form-grid-2">
                  <Field label="Candidate">
                    <select value={offerForm.candidateId} onChange={(e) => setOfferForm((f) => ({ ...f, candidateId: e.target.value }))}>
                      <option value="">Select…</option>
                      {offerCandidates.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} · {c.role} ({c.stage})
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Grade">
                    <select value={offerForm.grade} onChange={(e) => setOfferForm((f) => ({ ...f, grade: e.target.value }))}>
                      <option value="">Select…</option>
                      {[...new Set(GRADE_BANDS.map((b) => b.grade))].map((g) => (
                        <option key={g} value={g}>{g}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label={`Annual base${offerCurrency ? ` (${offerCurrency})` : ""}`}>
                    <input type="number" min={0} value={offerForm.baseSalary} onChange={(e) => setOfferForm((f) => ({ ...f, baseSalary: e.target.value }))} />
                  </Field>
                  <Field label="Start date">
                    <input type="date" min={todayISO()} value={offerForm.startDate} onChange={(e) => setOfferForm((f) => ({ ...f, startDate: e.target.value }))} />
                  </Field>
                  <Field label="Note" wide>
                    <input value={offerForm.packageNote} onChange={(e) => setOfferForm((f) => ({ ...f, packageNote: e.target.value }))} placeholder="Location, benefits…" />
                  </Field>
                  {offerReq && offerForm.grade && (
                    <p className="note">
                      {offerBand ? `Band ${offerBand.min} – ${offerBand.max}.` : "No band for this grade and country."}
                      {offerForm.baseSalary && needsCompApproval({ grade: offerForm.grade, baseSalary: Number(offerForm.baseSalary) }, offerReq)
                        ? " Above band — HR's approval covers the exception."
                        : ""}
                    </p>
                  )}
                  <div>
                    <button
                      type="button"
                      className="btn"
                      disabled={!offerForm.candidateId || !offerForm.grade || !offerForm.baseSalary || !offerForm.startDate}
                      onClick={prepareOffer}
                    >
                      Create offer
                    </button>
                  </div>
                </div>
              )}
            </Card>
          )}
        </div>
      )}

      {tab === "analytics" && (
        <Card title="Recruitment analytics">
          <ul className="todo">
            <li>Average time to hire: {timeToHire === null ? "—" : `${timeToHire} days`} (approval to accepted offer)</li>
            <li>Interviews awaiting feedback: {pendingFeedback}</li>
            <li>Offers accepted: {talent.offers.filter((o) => o.status === "Accepted").length}</li>
            <li>Reqs pending approval: {talent.requisitions.filter((r) => r.approvalStatus === "Pending approval").length}</li>
          </ul>
        </Card>
      )}

      {openCandidate && (
        <Dialog open title={`${openCandidate.name} · ${openCandidate.role}`} onClose={() => setOpenCand(null)} wide>
          <Banner message={notice} />
          <CandidatePipelineView
            candidate={openCandidate}
            talent={talent}
            actor={actor}
            onResult={(error, okText) => setNotice(noticeFor(error, okText))}
          />
        </Dialog>
      )}
    </Page>
  );
}

const OFFER_ACTION_LABEL: Partial<Record<OfferStatus, string>> = {
  "Pending approval": "Submit for approval",
  Preparing: "Send back",
  Sent: "Mark as sent",
  Withdrawn: "Withdraw",
};

function OfferActions({
  offer,
  req,
  actor,
  onResult,
}: {
  offer: OfferRecord;
  req: Requisition | undefined;
  actor: TalentActor;
  onResult: (n: Notice) => void;
}) {
  const [answer, setAnswer] = useState<"Accepted" | "Declined" | null>(null);
  const [note, setNote] = useState("");
  const moves = offerMoves(actor, offer, req);
  const canApprove = canApproveOffer(actor, offer, req);
  const step = offer.status === "Pending approval" ? offerApprovalNeeded(offer, req) : null;

  if (answer) {
    return (
      <span className="stack">
        <input aria-label="Answer note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="How was the answer received?" />
        <span className="row-gap">
          <button
            type="button"
            className="btn btn-tiny"
            disabled={note.trim().length < 5}
            onClick={() => {
              talentAction(() => setOfferStatus(actor, offer.id, answer, note), (error) => {
                onResult(noticeFor(error, `${offer.candidateName}'s answer recorded.`));
                if (!error) setAnswer(null);
              });
            }}
          >
            Save
          </button>
          <button type="button" className="btn-ghost btn-tiny" onClick={() => setAnswer(null)}>
            Cancel
          </button>
        </span>
      </span>
    );
  }

  const buttons = moves.filter((m) => m !== "Accepted" && m !== "Declined");
  const canRecord = moves.includes("Accepted");
  if (!canApprove && buttons.length === 0 && !canRecord) {
    return <span className="muted">{step ? `Waiting for ${step === "Hiring manager" ? "hiring manager" : step} approval` : "—"}</span>;
  }
  return (
    <span className="row-gap">
      {canApprove && (
        <button type="button" className="btn btn-tiny" onClick={() => talentAction(() => approveOffer(actor, offer.id), (res) => onResult(noticeFor(res, `Offer for ${offer.candidateName} approved.`)))}>
          {step === "Hiring manager" ? "Agree" : "Approve"}
        </button>
      )}
      {buttons.map((m) => (
        <button
          key={m}
          type="button"
          className={m === "Withdrawn" || m === "Preparing" ? "btn-ghost btn-tiny" : "btn btn-tiny"}
          onClick={() => talentAction(() => setOfferStatus(actor, offer.id, m), (res) => onResult(noticeFor(res, `${offer.candidateName}'s offer: ${m}.`)))}
        >
          {OFFER_ACTION_LABEL[m] ?? m}
        </button>
      ))}
      {canRecord && (
        <>
          <button type="button" className="btn-ghost btn-tiny" onClick={() => setAnswer("Accepted")}>
            Record candidate's acceptance
          </button>
          <button type="button" className="btn-ghost btn-tiny" onClick={() => setAnswer("Declined")}>
            Record decline
          </button>
        </>
      )}
    </span>
  );
}

/* ───────────────────────────── ONBOARDING ── */

function TaskStatusCell({
  task,
  joiner,
  actor,
  onResult,
}: {
  task: OnboardingTask;
  joiner: OnboardingJoiner;
  actor: TalentActor;
  onResult: (n: Notice) => void;
}) {
  const owner = isTaskOwner(actor, task, joiner);
  const [reason, setReason] = useState("");
  if (!owner && !isHrRole(actor.role)) return <span className="muted">{task.owner}</span>;
  return (
    <span className="stack">
      <select aria-label="Task status"
        value={task.status}
        disabled={!owner && reason.trim().length < 5}
        title={!owner ? "Add a reason first" : undefined}
        onChange={(e) => {
          const next = e.target.value as OnboardingTask["status"];
          talentAction(() => setOnboardingTaskStatus(actor, task.id, next, reason), (error) => {
            onResult(noticeFor(error));
            if (!error) setReason("");
          });
        }}
      >
        {(["Pending", "In progress", "Done"] as const).map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>
      {!owner && <input aria-label="Reason" value={reason} maxLength={120} onChange={(e) => setReason(e.target.value)} placeholder={`Reason (owner: ${task.owner})`} />}
      {task.overrideNote && <span className="muted">{task.overrideNote}</span>}
    </span>
  );
}

const IT_SYSTEMS = ["Email", "VPN", "Slack", "Jira", "GitHub", "Finance tools", "HR portal"] as const;

function emptyPreboarding(joiner: OnboardingJoiner): PreboardingForm {
  return (
    joiner.preboarding ?? {
      personal: { confirmed: false },
      emergencyContact: { name: "", relationship: "", phone: "" },
      equipment: ["laptop"],
      itRequest: { systems: ["Email"] },
    }
  );
}

/** Pre-boarding form: the joiner (or HR) confirms details and asks for equipment and IT access. */
function PreboardingCard({ joiner, actor, onResult }: { joiner: OnboardingJoiner; actor: TalentActor; onResult: (n: Notice) => void }) {
  const [form, setForm] = useState<PreboardingForm>(() => emptyPreboarding(joiner));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when another joiner opens or the form was saved
  useEffect(() => setForm(emptyPreboarding(joiner)), [joiner.id, joiner.preboardingOn]);
  const editable = canAcknowledgePolicies(actor, joiner) && joiner.overallStatus !== "Completed";
  const set = (patch: Partial<PreboardingForm>) => setForm((f) => ({ ...f, ...patch }));
  const toggle = <T extends string>(list: readonly T[], item: T): T[] => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

  if (!editable) {
    const p = joiner.preboarding;
    return (
      <Card title="Pre-boarding form">
        {!p ? (
          <p className="muted">Not filled in yet.</p>
        ) : (
          <dl className="info-grid">
            <div className="info-fact"><dt>Details confirmed</dt><dd>{p.personal.confirmed ? "Yes" : "No"}</dd></div>
            <div className="info-fact"><dt>Emergency contact</dt><dd>{p.emergencyContact.name} ({p.emergencyContact.relationship})</dd></div>
            <div className="info-fact"><dt>Equipment</dt><dd>{p.equipment.map((e) => EQUIPMENT_LABEL[e]).join(", ") || "—"}</dd></div>
            <div className="info-fact"><dt>IT access</dt><dd>{p.itRequest.systems.join(", ") || "—"}</dd></div>
          </dl>
        )}
      </Card>
    );
  }

  function save() {
    talentAction(() => submitPreboarding(actor, joiner.id, form), (error) => onResult(noticeFor(error, "Pre-boarding form saved. IT tasks added.")));
  }

  return (
    <Card title="Pre-boarding form" action={joiner.preboardingOn ? <span className="muted">Sent {joiner.preboardingOn}</span> : undefined}>
      <div className="form-grid-2">
        <Field label="Preferred name">
          <input value={form.personal.preferredName ?? ""} maxLength={200}
            onChange={(e) => set({ personal: { ...form.personal, preferredName: e.target.value } })} />
        </Field>
        <Field label="Mobile">
          <input value={form.personal.mobile ?? ""} maxLength={40}
            onChange={(e) => set({ personal: { ...form.personal, mobile: e.target.value } })} />
        </Field>
        <Field label="Personal email">
          <input type="email" value={form.personal.personalEmail ?? ""} maxLength={200}
            onChange={(e) => set({ personal: { ...form.personal, personalEmail: e.target.value } })} />
        </Field>
        <Field label="Address">
          <input value={form.personal.address ?? ""} maxLength={500}
            onChange={(e) => set({ personal: { ...form.personal, address: e.target.value } })} />
        </Field>
        <Field label="Emergency contact">
          <input value={form.emergencyContact.name} maxLength={200} placeholder="Name"
            onChange={(e) => set({ emergencyContact: { ...form.emergencyContact, name: e.target.value } })} />
        </Field>
        <Field label="Relationship">
          <input value={form.emergencyContact.relationship} maxLength={60}
            onChange={(e) => set({ emergencyContact: { ...form.emergencyContact, relationship: e.target.value } })} />
        </Field>
        <Field label="Contact phone">
          <input value={form.emergencyContact.phone} maxLength={40}
            onChange={(e) => set({ emergencyContact: { ...form.emergencyContact, phone: e.target.value } })} />
        </Field>
        <Field label="IT notes">
          <input value={form.itRequest.notes ?? ""} maxLength={1000}
            onChange={(e) => set({ itRequest: { ...form.itRequest, notes: e.target.value } })} />
        </Field>
      </div>
      <fieldset className="stack" style={{ border: 0, padding: 0, marginTop: 8 }}>
        <legend className="muted">Equipment</legend>
        <span className="row-gap">
          {EQUIPMENT_ITEMS.map((item) => (
            <label key={item} className="row-gap">
              <input type="checkbox" checked={form.equipment.includes(item)} onChange={() => set({ equipment: toggle(form.equipment, item) })} />
              {EQUIPMENT_LABEL[item]}
            </label>
          ))}
        </span>
      </fieldset>
      <fieldset className="stack" style={{ border: 0, padding: 0, marginTop: 8 }}>
        <legend className="muted">IT access</legend>
        <span className="row-gap">
          {IT_SYSTEMS.map((sys) => (
            <label key={sys} className="row-gap">
              <input type="checkbox" checked={form.itRequest.systems.includes(sys)}
                onChange={() => set({ itRequest: { ...form.itRequest, systems: toggle(form.itRequest.systems, sys) } })} />
              {sys}
            </label>
          ))}
        </span>
      </fieldset>
      <label className="row-gap" style={{ marginTop: 8 }}>
        <input type="checkbox" checked={form.personal.confirmed} onChange={(e) => set({ personal: { ...form.personal, confirmed: e.target.checked } })} />
        My personal details are correct
      </label>
      <div className="row-gap" style={{ marginTop: 8 }}>
        <button type="button" className="btn" onClick={save}>
          {joiner.preboarding ? "Update form" : "Send form"}
        </button>
      </div>
    </Card>
  );
}

export function OnboardingPage() {
  const talent = useTalent();
  const { demoProfile } = usePortal();
  const actor = demoProfile;
  const [selected, setSelected] = useState(talent.joiners[0]?.id ?? "");
  const [ownerFilter, setOwnerFilter] = useState("");
  const [notice, setNotice] = useState<Notice>(null);

  const isStaff = canEditOnboarding(actor.role);
  if (!isStaff && !accountHasNavAccess(actor, "onboarding")) return <NotAuthorized module="Onboarding" />;

  const joiner = talent.joiners.find((j) => j.id === selected) ?? talent.joiners[0];
  const tasks = talent.tasks.filter(
    (t) => t.joinerId === joiner?.id && (!ownerFilter || t.owner === ownerFilter),
  );
  const canAck = joiner ? canAcknowledgePolicies(actor, joiner) : false;
  const ackForJoiner = joiner ? canAck && !isJoinerSelf(actor, joiner) : false;

  return (
    <Page title="Onboarding">
      <Banner message={notice} />
      <MetricGrid>
        <MetricCard label="Joiners" value={talent.joiners.filter((j) => j.overallStatus !== "Completed").length} />
        <MetricCard label="Pre-boarding" value={talent.joiners.filter((j) => j.overallStatus === "Pre-boarding").length} />
        <MetricCard label="Open tasks" value={talent.tasks.filter((t) => t.status !== "Done").length} />
        <MetricCard label="Policy pending" value={talent.joiners.filter((j) => j.policyAck === "Pending").length} />
      </MetricGrid>

      <div className="mgr-home-grid">
        <Card title="New joiners">
          <DataTable
            headers={["Name", "Role", "Start", "Country", "Status", ""]}
            rows={talent.joiners.map((j) => [
              j.name,
              j.role,
              j.startDate,
              j.country,
              <StatusBadge key={j.id} status={j.overallStatus} literal />,
              <button key={`${j.id}-o`} type="button" className="quiet-link" onClick={() => setSelected(j.id)}>
                Open
              </button>,
            ])}
          />
        </Card>

        {joiner && (
          <Card title={`${joiner.name} · onboarding`}>
            <dl className="info-grid">
              <div className="info-fact"><dt>Manager</dt><dd>{joiner.manager}</dd></div>
              <div className="info-fact"><dt>Requisition</dt><dd>{joiner.requisitionId ?? "—"}</dd></div>
              <div className="info-fact"><dt>Documents</dt><dd>{joiner.docsStatus}</dd></div>
              <div className="info-fact">
                <dt>Policy acknowledgement</dt>
                <dd>
                  {joiner.policyAck}
                  {joiner.policyAck === "Complete" && joiner.policyAckOn
                    ? ` · ${joiner.policyAckOn}${joiner.policyAckByHr ? `, recorded by HR (${joiner.policyAckBy})` : ""}`
                    : ""}
                </dd>
              </div>
              <div className="info-fact">
                <dt>Directory</dt>
                <dd>
                  {!joiner.personId ? "Not added yet" : joiner.overallStatus === "Completed" ? "Active" : "Onboarding"}
                  {joiner.personId && (
                    <>
                      {" · "}
                      <Link to={`/people/${joiner.personId}`} className="quiet-link">Profile</Link>
                    </>
                  )}
                </dd>
              </div>
            </dl>
            <Progress value={joiner.preboardingPct} label="Checklist complete" />
            <div className="row-gap" style={{ marginTop: 8 }}>
              {canAck && (
                <button
                  type="button"
                  className="btn"
                  disabled={joiner.policyAck === "Complete"}
                  onClick={() =>
                    talentAction(() => setJoinerPolicyAck(actor, joiner.id, "Complete"), (res) => setNotice(noticeFor(res,
                        ackForJoiner ? `Recorded for ${joiner.name}.` : "Policies acknowledged.",
                      ),
                    ))
                  }
                >
                  {ackForJoiner ? "Record acknowledgment" : "Acknowledge policies"}
                </button>
              )}
              <Link to="/policies" className="btn-ghost">
                View policies
              </Link>
            </div>
            {!canAck && joiner.policyAck === "Pending" && <p className="muted">Waiting for {joiner.name} to acknowledge.</p>}
          </Card>
        )}
      </div>

      {joiner && <PreboardingCard joiner={joiner} actor={actor} onResult={setNotice} />}

      <Card
        title="Onboarding checklist"
        action={
          <label className="filter-label">
            Owner
            <select value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)}>
              <option value="">All</option>
              {(["HR", "IT", "Manager", "Employee"] as const).map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          </label>
        }
      >
        {!joiner ? (
          <EmptyState title="Select a joiner" />
        ) : (
          <DataTable
            headers={["Task", "Owner", "Category", "Due", "After", "Status", "Update"]}
            rows={tasks.map((t) => [
              t.title,
              t.owner,
              t.category,
              t.due,
              (t.dependsOn ?? [])
                .map((k) => talent.tasks.find((x) => x.joinerId === t.joinerId && x.key === k)?.title ?? k)
                .join(", ") || "—",
              <StatusBadge key={t.id} status={t.status} literal tone={t.status === "Done" ? "ok" : "warn"} />,
              <TaskStatusCell key={`${t.id}-u`} task={t} joiner={joiner} actor={actor} onResult={setNotice} />,
            ])}
            empty={<EmptyState title="No tasks" description="No checklist items for this filter." />}
          />
        )}
      </Card>
    </Page>
  );
}

/* ───────────────────────────── PERFORMANCE ── */

const GOAL_TYPES = ["Goal", "OKR", "KPI"] as const;

function AssessmentEditor({
  text,
  status,
  editable,
  onSave,
}: {
  text?: string;
  status: PerfReview["selfStatus"];
  editable: boolean;
  onSave: (text: string, submit: boolean) => void;
}) {
  const [draft, setDraft] = useState(text ?? "");
  if (!editable) return <p className="muted">{text || "—"}</p>;
  return (
    <div className="stack">
      <textarea aria-label="Summary" rows={3} maxLength={1000} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Summary…" />
      <div className="row-gap">
        <button type="button" className="btn-ghost btn-tiny" onClick={() => onSave(draft, false)}>
          Save draft
        </button>
        <button type="button" className="btn btn-tiny" disabled={draft.trim().length < 10} onClick={() => onSave(draft, true)}>
          Submit
        </button>
        {status === "Draft" && <span className="muted">Draft saved</span>}
      </div>
    </div>
  );
}

function CycleDialog({ actor, onClose }: { actor: TalentActor; onClose: (message?: string) => void }) {
  const [form, setForm] = useState<CycleInput>({ name: "", start: "", end: "", selfReviewDue: "", managerReviewDue: "" });
  const [error, setError] = useState("");
  const set = (patch: Partial<CycleInput>) => setForm((f) => ({ ...f, ...patch }));

  function save() {
    talentAction(() => createReviewCycle(actor, form), (err) => {
      if (err) setError(err);
      else onClose(`${form.name.trim()} created. Move it to Active to open reviews.`);
    });
  }

  return (
    <Dialog open title="New review cycle" onClose={() => onClose()}>
      <div className="form-grid-2">
        <Field label="Name" wide>
          <input value={form.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. H1 2027 review" />
        </Field>
        <Field label="Start">
          <input type="date" value={form.start} onChange={(e) => set({ start: e.target.value })} />
        </Field>
        <Field label="End">
          <input type="date" value={form.end} min={form.start || undefined} onChange={(e) => set({ end: e.target.value })} />
        </Field>
        <Field label="Self-review due">
          <input type="date" value={form.selfReviewDue} onChange={(e) => set({ selfReviewDue: e.target.value })} />
        </Field>
        <Field label="Manager review due">
          <input type="date" value={form.managerReviewDue} onChange={(e) => set({ managerReviewDue: e.target.value })} />
        </Field>
      </div>
      {error && <Banner message={{ tone: "err", text: error }} />}
      <div className="dialog-actions">
        <button type="button" className="btn-ghost" onClick={() => onClose()}>
          Cancel
        </button>
        <button type="button" className="btn" onClick={save}>
          Create
        </button>
      </div>
    </Dialog>
  );
}

function GoalDialog({
  initial,
  actor,
  onClose,
}: {
  initial: GoalInput;
  actor: TalentActor;
  onClose: (message?: string) => void;
}) {
  const [form, setForm] = useState(initial);
  const [error, setError] = useState("");
  const owners = goalOwnerOptions(actor);
  const set = (patch: Partial<GoalInput>) => setForm((f) => ({ ...f, ...patch }));
  const talent = useTalent();
  const others = goalWeightTotal(talent.goals, form.ownerId, form.cycleId, form.id);

  function save() {
    talentAction(() => saveGoal(actor, form), (err) => {
      if (err) setError(err);
      else onClose(form.id ? "Goal updated." : "Goal added.");
    });
  }

  return (
    <Dialog open title={form.id ? "Edit goal" : "Add goal"} onClose={() => onClose()}>
      <div className="form-grid-2">
        <Field label="Owner">
          <select value={form.ownerId} disabled={!!form.id} onChange={(e) => set({ ownerId: e.target.value })}>
            {owners.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Type">
          <select value={form.type} onChange={(e) => set({ type: e.target.value as PerfGoal["type"] })}>
            {GOAL_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </Field>
        <Field label="Title" wide>
          <input value={form.title} maxLength={120} onChange={(e) => set({ title: e.target.value })} />
        </Field>
        <Field label="Target">
          <input value={form.target} maxLength={60} onChange={(e) => set({ target: e.target.value })} placeholder="e.g. ≥ 85%" />
        </Field>
        <Field label="Period">
          <input value={form.period} maxLength={40} onChange={(e) => set({ period: e.target.value })} />
        </Field>
        <Field label={`Weight % (others: ${others}%)`}>
          <input type="number" min={1} max={100} value={form.weight} onChange={(e) => set({ weight: Number(e.target.value) })} />
        </Field>
      </div>
      {error && <Banner message={{ tone: "err", text: error }} />}
      <div className="dialog-actions">
        <button type="button" className="btn-ghost" onClick={() => onClose()}>
          Cancel
        </button>
        <button type="button" className="btn" onClick={save}>
          Save
        </button>
      </div>
    </Dialog>
  );
}

export function PerformancePage() {
  const { demoProfile, demoAccounts } = usePortal();
  const actor = demoProfile;
  const talent = useTalent();
  const [tab, setTab] = useState("goals");
  const cycles = allCycles(talent);
  const [cycleId, setCycleId] = useState(cycles[0]?.id ?? "");
  const [notice, setNotice] = useState<Notice>(null);
  const [goalForm, setGoalForm] = useState<GoalInput | null>(null);
  const [cycleOpen, setCycleOpen] = useState(false);
  const cycle = cycles.find((c) => c.id === cycleId) ?? cycles[0];
  const status = cycleStatusOf(talent, cycleId);
  const next = nextCycleStatus(status);
  const closed = status === "Closed";
  const hr = isHrRole(actor.role);
  const inCycle = inReviewCycle(actor.id);

  const goals = talent.goals.filter((g) => g.cycleId === cycleId && canViewReview(actor, g.ownerId));
  // Pre-boarding joiners aren't reviewed until they start.
  const started = (id: string) => {
    const person = getPerson(id);
    return !person || hasStarted(person);
  };
  const reviews = talent.reviews.filter((r) => r.cycleId === cycleId && canViewReview(actor, r.employeeId) && started(r.employeeId));
  const run = (error: string | null, okText?: string) => setNotice(noticeFor(error, okText));
  const asked360 = pending360For(talent, actor.id);

  const owners = [...new Map(goals.map((g) => [g.ownerId, g.ownerName])).entries()];
  const offWeight = owners
    .map(([id, name]) => ({ name, total: goalWeightTotal(talent.goals, id, cycleId) }))
    .filter((o) => o.total !== 100);

  const newGoal = (): GoalInput => ({
    ownerId: actor.id,
    type: "Goal",
    title: "",
    target: "",
    weight: Math.max(1, 100 - goalWeightTotal(talent.goals, actor.id, cycleId)),
    period: cycle ? `${cycle.start} – ${cycle.end}` : "",
    cycleId,
  });

  return (
    <Page title="Performance">
      <FilterBar>
        <label className="filter-label">
          Performance cycle
          <select value={cycleId} onChange={(e) => setCycleId(e.target.value)}>
            {cycles.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.status}
              </option>
            ))}
          </select>
        </label>
        {hr && next && (
          <button type="button" className="btn-ghost" onClick={() => talentAction(() => advanceCycle(actor, cycleId), (res) => run(res, `Cycle moved to ${next}.`))}>
            Move to {next}
          </button>
        )}
        {hr && (
          <button type="button" className="btn-ghost" onClick={() => setCycleOpen(true)}>
            New cycle
          </button>
        )}
      </FilterBar>

      {cycle && (
        <MetricGrid>
          <MetricCard label="Cycle" value={cycle.name} hint={`${cycle.start} → ${cycle.end}`} />
          <MetricCard
            label="Status"
            value={status}
            hint={cycle.selfReviewDue ? `Self due ${cycle.selfReviewDue} · manager due ${cycle.managerReviewDue ?? "—"}` : undefined}
          />
          <MetricCard label="Completion" value={`${cycleCompletion(talent, cycleId)}%`} hint="Assessments submitted" />
          <MetricCard label="Reviews in view" value={reviews.length} />
        </MetricGrid>
      )}

      <Tabs
        tabs={[
          { id: "goals", label: "Goals / OKRs / KPIs" },
          { id: "feedback", label: "Feedback & praise" },
          { id: "checkins", label: "1:1 check-ins" },
          { id: "self", label: "Self-assessment" },
          { id: "manager", label: "Manager assessment" },
          { id: "360", label: asked360.length ? `360 feedback (${asked360.length})` : "360 feedback" },
          { id: "reviews", label: "Ratings & plans" },
        ]}
        value={tab}
        onChange={(id) => {
          setTab(id);
          setNotice(null);
        }}
      />

      <Banner message={notice} />

      {tab === "goals" && (
        <Card
          title="Goals, OKRs and KPIs"
          action={
            !closed ? (
              <button type="button" className="btn btn-tiny" onClick={() => setGoalForm(newGoal())}>
                Add goal
              </button>
            ) : undefined
          }
        >
          {offWeight.length > 0 && (
            <Banner
              message={{
                tone: "warn",
                text: `Weights should total 100%: ${offWeight.map((o) => `${o.name} ${o.total}%`).join(", ")}.`,
              }}
            />
          )}
          <DataTable
            headers={["Owner", "Type", "Title", "Target", "Weight", "Period", "Progress", "Adjust", ""]}
            rows={goals.map((g) => {
              const editable = canEditGoal(actor, g) && !closed;
              return [
                g.ownerName,
                g.type,
                g.title,
                g.target || "—",
                `${g.weight ?? 0}%`,
                g.period || "—",
                <Progress key={g.id} value={g.progress} />,
                <ProgressSlider
                  aria-label="Goal progress"
                  key={`${g.id}-p`}
                  min={0}
                  max={100}
                  value={g.progress}
                  disabled={!editable}
                  onCommit={(v, settled) => talentAction(() => updateGoalProgress(actor, g.id, v), (res) => {
                    settled();
                    run(res);
                  })}
                />,
                editable ? (
                  <button
                    key={`${g.id}-e`}
                    type="button"
                    className="btn-ghost btn-tiny"
                    onClick={() =>
                      setGoalForm({
                        id: g.id,
                        ownerId: g.ownerId,
                        type: g.type,
                        title: g.title,
                        target: g.target ?? "",
                        weight: g.weight ?? 0,
                        period: g.period ?? "",
                        cycleId: g.cycleId,
                      })
                    }
                  >
                    Edit
                  </button>
                ) : (
                  ""
                ),
              ];
            })}
            empty={<EmptyState title="No goals" description="No goals in this cycle yet." />}
          />
        </Card>
      )}

      {cycleOpen && (
        <CycleDialog
          actor={actor}
          onClose={(message) => {
            setCycleOpen(false);
            if (message) {
              setNotice({ tone: "ok", text: message });
              const created = allCycles(getTalentState()).at(-1);
              if (created) setCycleId(created.id);
            }
          }}
        />
      )}

      {goalForm && (
        <GoalDialog
          initial={goalForm}
          actor={actor}
          onClose={(message) => {
            setGoalForm(null);
            if (message) setNotice({ tone: "ok", text: message });
          }}
        />
      )}

      {tab === "feedback" && <FeedbackPanel me={actor} people={demoAccounts} feedback={talent.feedback} />}

      {tab === "checkins" && <OneOnOnePanel me={actor} people={demoAccounts} meetings={talent.oneOnOnes} />}

      {tab === "self" && (
        <Card title="Self-assessment">
          {!inCycle && <p className="muted">You are not in this review cycle.</p>}
          {reviews.length === 0 ? (
            <EmptyState title="No reviews" description="No reviews in view for this cycle." />
          ) : (
            <ul className="feedback-list">
              {reviews.map((r) => (
                <li key={r.id} className="feedback-item">
                  <div className="row-between">
                    <strong>{r.employeeName}</strong>
                    <StatusBadge status={r.selfStatus} literal />
                  </div>
                  <AssessmentEditor
                    key={`${r.id}-${r.selfStatus}`}
                    text={r.selfText}
                    status={r.selfStatus}
                    editable={r.employeeId === actor.id && r.selfStatus !== "Submitted" && status === "Active"}
                    onSave={(text, submit) =>
                      talentAction(() => saveSelfAssessment(actor, r.id, text, submit), (res) => run(res, submit ? "Self-assessment submitted." : "Draft saved."))
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {tab === "manager" && (
        <Card title="Manager assessment">
          {reviews.length === 0 ? (
            <EmptyState title="No reviews" description="No reviews in view for this cycle." />
          ) : (
            <ul className="feedback-list">
              {reviews.map((r) => {
                const isOwn = r.employeeId === actor.id;
                const writer = canWriteManagerReview(actor, r.employeeId);
                return (
                  <li key={r.id} className="feedback-item">
                    <div className="row-between">
                      <strong>{r.employeeName}</strong>
                      <StatusBadge status={r.managerStatus} literal />
                    </div>
                    {isOwn && !r.released ? (
                      <p className="muted">Shared when your rating is released.</p>
                    ) : (
                      <AssessmentEditor
                        key={`${r.id}-${r.managerStatus}`}
                        text={r.managerText}
                        status={r.managerStatus}
                        editable={writer && r.managerStatus !== "Submitted" && status === "Active"}
                        onSave={(text, submit) =>
                          talentAction(() => saveManagerAssessment(actor, r.id, text, submit), (res) => run(res, submit ? "Manager assessment submitted." : "Draft saved."))
                        }
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}

      {tab === "360" && (
        <div className="stack">
          <Pending360Requests me={actor} requests={asked360} onResult={run} />
          <Card title="360-degree feedback">
            <p className="muted">Up to 3 reviewers.</p>
            {reviews.length === 0 ? (
              <EmptyState title="No reviews" description="No reviews in view for this cycle." />
            ) : (
              <ul className="feedback-list">
                {reviews.map((r) => (
                  <li key={r.id} className="feedback-item">
                    <div className="row-between">
                      <strong>{r.employeeName}</strong>
                      <select
                        aria-label="360 feedback status"
                        value={r.feedback360Status}
                        disabled={!canWriteManagerReview(actor, r.employeeId) || status !== "Active"}
                        onChange={(e) => talentAction(() => set360Status(actor, r.id, e.target.value as PerfReview["feedback360Status"]), (res) => run(res))}
                      >
                        {(["Not started", "In progress", "Complete"] as const).map((s) => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </select>
                    </div>
                    <Reviewers360 me={actor} review={r} open={status === "Planning" || status === "Active"} onResult={run} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      {tab === "reviews" && (
        <Card title="Ratings and development plans">
          <DataTable
            headers={["Employee", "Self", "Manager", "360", "Rating", "Released"]}
            rows={reviews.map((r) => {
              const writer = canWriteManagerReview(actor, r.employeeId);
              const canRate = writer && !r.released && (status === "Active" || status === "Calibration");
              const ready = r.selfStatus === "Submitted" && r.managerStatus === "Submitted";
              const shown = visibleRating(actor, r);
              const canRelease = hr && status === "Calibration" && !!r.rating && !r.released && r.employeeId !== actor.id;
              return [
                r.employeeName,
                r.selfStatus,
                r.managerStatus,
                r.feedback360Status,
                canRate ? (
                  <select aria-label="Rating"
                    key={`${r.id}-rate`}
                    value={r.rating ?? ""}
                    disabled={!ready}
                    title={!ready ? "Needs both assessments submitted" : undefined}
                    onChange={(e) => talentAction(() => setRating(actor, r.id, e.target.value || undefined), (res) => run(res))}
                  >
                    <option value="">Select…</option>
                    {RATINGS.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                ) : (
                  shown ?? (r.employeeId === actor.id && r.rating ? "Not released" : "—")
                ),
                r.released ? (
                  `${r.releasedOn ?? ""}`
                ) : canRelease ? (
                  <button key={`${r.id}-rel`} type="button" className="btn btn-tiny" onClick={() => talentAction(() => releaseRating(actor, r.id), (res) => run(res, `Rating released to ${r.employeeName}.`))}>
                    Release
                  </button>
                ) : (
                  "No"
                ),
              ];
            })}
            empty={<EmptyState title="No reviews" description="No reviews in view for this cycle." />}
          />
        </Card>
      )}

      {tab === "reviews" && reviews.length > 0 && (
        <Card title="Development plans">
          <ul className="feedback-list">
            {reviews.map((r) => (
              <li key={r.id} className="feedback-item">
                <strong>{r.employeeName}</strong>
                <DevPlanEditor me={actor} review={r} open={!closed} onResult={run} />
              </li>
            ))}
          </ul>
        </Card>
      )}
    </Page>
  );
}

/* ───────────────────────────── LEARNING ── */

const DUE_SOON_DAYS = 7;
const CERT_EXPIRY_WARNING_DAYS = 60;

function daysUntil(iso: string, today: string): number {
  return Math.round((Date.parse(iso) - Date.parse(today)) / 86_400_000);
}

/** Due-date status for an enrollment, the way compliance LMS tools flag mandatory training. */
function dueStatus(e: Enrollment, today: string): { label: string; tone: "ok" | "warn" | "danger" | "neutral" } {
  if (e.status === "Completed") return { label: e.completedOn ? `Done ${e.completedOn}` : "Done", tone: "ok" };
  if (!e.due) return { label: "No due date", tone: "neutral" };
  const days = daysUntil(e.due, today);
  if (days < 0) return { label: `Overdue by ${-days} day${days === -1 ? "" : "s"}`, tone: "danger" };
  if (days === 0) return { label: "Due today", tone: "warn" };
  if (days <= DUE_SOON_DAYS) return { label: `Due in ${days} day${days === 1 ? "" : "s"}`, tone: "warn" };
  return { label: `Due ${e.due}`, tone: "neutral" };
}

function certStatus(c: Certification, today: string): { label: string; tone: "ok" | "warn" | "danger" | "neutral" } {
  if (isCertExpired(c, today)) return { label: `Expired ${c.expiresOn}`, tone: "danger" };
  if (!c.expiresOn) return { label: "No expiry", tone: "ok" };
  const days = daysUntil(c.expiresOn, today);
  if (days <= CERT_EXPIRY_WARNING_DAYS) return { label: `Expires in ${days} days`, tone: "warn" };
  return { label: "Valid", tone: "ok" };
}

function ScoreCompletion({ onSubmit }: { onSubmit: (score: number) => void }) {
  const [score, setScore] = useState("");
  return (
    <span className="row-gap">
      <input type="number" min={0} max={100} value={score} onChange={(e) => setScore(e.target.value)} placeholder="Score" aria-label="Assessment score" style={{ width: 72 }} />
      <button type="button" className="btn btn-tiny" disabled={score === ""} onClick={() => onSubmit(Number(score))}>
        Record score
      </button>
    </span>
  );
}

export function LearningPage() {
  const { employee, demoProfile } = usePortal();
  const talent = useTalent();
  const [tab, setTab] = useState("catalog");
  const [viewing, setViewing] = useState<CertificateDoc | null>(null);
  const hr = canManagePeople(demoProfile.role);
  const [q, setQ] = useState("");
  const [mandatoryOnly, setMandatoryOnly] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  // New expiry dates typed for renewals of certifications without a fixed validity.
  const [renewExpiry, setRenewExpiry] = useState<Record<string, string>>({});
  const [credIds, setCredIds] = useState<Record<string, string>>({});

  const catalog = courseCatalog().filter((c) => {
    if (mandatoryOnly && !c.mandatory) return false;
    if (q && !`${c.title} ${c.category}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  const today = todayISO();
  const mine = talent.enrollments.filter((e) => e.employeeId === employee.id);
  const enrolledCourseIds = new Set(mine.map((e) => e.courseId));
  const overdue = mine.filter((e) => e.status !== "Completed" && e.due && e.due < today);
  const myCerts = talent.certifications.filter((c) => c.employeeId === employee.id);
  const visibleCerts = hr ? talent.certifications : myCerts;
  const courseCertificates: CertificateDoc[] = talent.enrollments
    .filter((e) => earnedCertificate(e) && (hr || e.employeeId === employee.id))
    .map((e) => {
      const course = courseCatalog().find((c) => c.id === e.courseId);
      return {
        id: `course-${e.id}`,
        kind: "course" as const,
        title: course?.title ?? e.courseId,
        recipient: e.employeeName,
        issuer: "Learning & Development",
        issuedOn: e.completedOn ?? today,
        credentialId: `INF-${credentialCode(e.id + e.employeeId)}`,
        details: course ? `${course.durationHours} hour${course.durationHours === 1 ? "" : "s"} · ${course.category}` : undefined,
      };
    })
    .sort((a, b) => b.issuedOn.localeCompare(a.issuedOn));
  const certificateFor = (c: Certification): CertificateDoc => ({
    id: c.id,
    kind: "professional",
    title: c.name,
    recipient: c.employeeName,
    issuer: c.issuer,
    issuedOn: c.earnedOn,
    expiresOn: c.expiresOn,
    credentialId: c.verifiedBy ? c.credentialId : undefined,
    verified: !!c.verifiedBy,
    expired: isCertExpired(c, today),
  });
  const certsNeedingRenewal = myCerts.filter((c) => certStatus(c, today).tone !== "ok" && !c.renewalStatus);
  // HR sees everyone; managers see the people below them.
  const teamEnrollments = talent.enrollments.filter(
    (e) => e.employeeId !== employee.id && (hr || isAboveInChain(demoProfile.id, e.employeeId)),
  );
  const showTeam = hr || teamEnrollments.length > 0;

  return (
    <Page title="Learning">
      <MetricGrid>
        <MetricCard label="Catalog courses" value={courseCatalog().length} />
        <MetricCard label="My enrollments" value={mine.length} />
        <MetricCard label="Completed" value={mine.filter((e) => e.status === "Completed").length} />
        <MetricCard label="Mandatory open" value={mine.filter((e) => e.status !== "Completed" && courseCatalog().find((c) => c.id === e.courseId)?.mandatory).length} />
        <MetricCard label="Overdue" value={overdue.length} />
      </MetricGrid>

      {(overdue.length > 0 || certsNeedingRenewal.length > 0) && (
        <Banner
          message={{
            tone: "warn",
            text: [
              overdue.length
                ? `Overdue: ${overdue.map((e) => courseCatalog().find((c) => c.id === e.courseId)?.title ?? e.courseId).join(", ")}.`
                : "",
              certsNeedingRenewal.length ? `${certsNeedingRenewal.length} certification${certsNeedingRenewal.length > 1 ? "s need" : " needs"} renewal.` : "",
            ]
              .filter(Boolean)
              .join(" "),
          }}
        />
      )}

      <FilterBar>
        <label className="filter-label">
          Search catalog
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Course or category…" />
        </label>
        <label className="filter-label" style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 18 }}>
          <input type="checkbox" checked={mandatoryOnly} onChange={(e) => setMandatoryOnly(e.target.checked)} />
          Mandatory only
        </label>
      </FilterBar>

      <Tabs
        tabs={[
          { id: "catalog", label: "Catalog" },
          { id: "paths", label: "Learning paths" },
          { id: "mine", label: "My learning" },
          { id: "certs", label: "Certifications" },
          ...(showTeam ? [{ id: "team", label: "Team completions" }] : []),
        ]}
        value={tab}
        onChange={(id) => {
          setTab(id);
          setNotice(null);
        }}
      />

      <Banner message={notice} />

      {tab === "catalog" && (
        <Card title="Course catalog">
          <DataTable
            headers={["Course", "Category", "Hours", "Mandatory", "For", ""]}
            rows={catalog.map((c) => {
              const open = courseOpenTo(c, demoProfile);
              return [
                c.title,
                c.category,
                String(c.durationHours),
                c.mandatory ? "Yes" : "No",
                c.audience,
                enrolledCourseIds.has(c.id) ? (
                  <button key={c.id} type="button" className="btn-ghost" disabled>
                    Enrolled
                  </button>
                ) : !open ? (
                  <span key={c.id} className="muted">Not for your role</span>
                ) : (
                  <button
                    key={c.id}
                    type="button"
                    className="btn-ghost"
                    onClick={() => talentAction(() => enrollInCourse(demoProfile, c.id), (res) => setNotice(noticeFor(res, `Enrolled in ${c.title}.`)))}
                  >
                    Enroll
                  </button>
                ),
              ];
            })}
            empty={<EmptyState title="No courses" description="No catalog rows match filters." />}
          />
        </Card>
      )}

      {tab === "paths" && (
        <Card title="Learning paths">
          <DataTable
            headers={["Path", "Audience", "Courses", "Your progress"]}
            rows={LEARNING_PATHS.map((p) => {
              const isDone = (id: string) => mine.some((e) => e.courseId === id && e.status === "Completed");
              const done = p.courses.filter(isDone).length;
              return [
                p.title,
                p.audience,
                p.courses
                  .map((id) => `${isDone(id) ? "✓ " : ""}${courseCatalog().find((c) => c.id === id)?.title ?? id}`)
                  .join(" · "),
                <Progress key={p.id} value={(done / p.courses.length) * 100} label={`${done} of ${p.courses.length} courses`} />,
              ];
            })}
          />
        </Card>
      )}

      {tab === "mine" && (
        <Card title="Completion status">
          <DataTable
            headers={["Course", "Status", "Due", "Progress", "Update"]}
            rows={[...mine]
              // Open courses first, soonest due date at the top.
              .sort(
                (a, b) =>
                  Number(a.status === "Completed") - Number(b.status === "Completed") ||
                  (a.due ?? "9999").localeCompare(b.due ?? "9999"),
              )
              .map((e) => {
                const course = courseCatalog().find((c) => c.id === e.courseId);
                const due = dueStatus(e, today);
                return [
                  <span key={`${e.id}-t`}>
                    {course?.title ?? e.courseId}
                    {course?.mandatory && (
                      <span className="pill pill-mandatory" style={{ marginLeft: 6 }}>
                        Mandatory
                      </span>
                    )}
                  </span>,
                  <StatusBadge key={e.id} status={e.status} literal />,
                  <StatusBadge key={`${e.id}-due`} status={due.label} tone={due.tone} literal />,
                  <Progress key={`${e.id}-p`} value={e.progress} />,
                  e.status === "Completed" ? (
                    <span key={`${e.id}-r`} className="muted">Completed</span>
                  ) : (
                    <span key={`${e.id}-r`} className="learning-progress-input">
                      <ProgressSlider
                        min={0}
                        max={SELF_PROGRESS_CAP}
                        value={Math.min(e.progress, SELF_PROGRESS_CAP)}
                        aria-label="Progress"
                        onCommit={(v, settled) => talentAction(() => updateEnrollmentProgress(demoProfile, e.id, v), (res) => {
                          settled();
                          setNotice(noticeFor(res));
                        })}
                      />
                      {e.progress >= SELF_PROGRESS_CAP && <span className="muted">Waiting for HR to confirm</span>}
                    </span>
                  ),
                ];
              })}
            empty={<EmptyState title="No enrollments" description="Enroll from the catalog." />}
          />
        </Card>
      )}

      {tab === "certs" && (
        <div className="stack">
          <Card title={`Course certificates${courseCertificates.length ? ` (${courseCertificates.length})` : ""}`}>
            {courseCertificates.length === 0 ? (
              <EmptyState title="No certificates yet" description="Finish a course to earn its certificate." />
            ) : (
              <ul className="cert-grid">
                {courseCertificates.map((doc) => (
                  <li key={doc.id} className="cert-tile">
                    <span className="cert-tile-icon" aria-hidden>
                      <Award size={22} />
                    </span>
                    <strong>{doc.title}</strong>
                    <span className="muted">
                      {hr ? `${doc.recipient} · ` : ""}Completed {doc.issuedOn}
                    </span>
                    {doc.details && <span className="muted">{doc.details}</span>}
                    <span className="cert-tile-id">{doc.credentialId}</span>
                    <div className="cert-tile-actions">
                      <button type="button" className="btn btn-tiny" onClick={() => setViewing(doc)}>
                        <Eye size={14} aria-hidden /> View
                      </button>
                      <button type="button" className="btn-ghost btn-tiny" onClick={() => void downloadCertificatePng(doc)}>
                        <Download size={14} aria-hidden /> Download
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Professional certifications">
            <DataTable
              headers={[...(hr ? ["Employee"] : []), "Certification", "Issuer", "Earned", "Expires", "Status", ""]}
              rows={[...visibleCerts]
                .sort((a, b) => (a.expiresOn ?? "9999").localeCompare(b.expiresOn ?? "9999"))
                .map((c) => {
                  const status = certStatus(c, today);
                  const doc = certificateFor(c);
                  const expired = isCertExpired(c, today);
                  return [
                    ...(hr ? [c.employeeName] : []),
                    c.name,
                    c.issuer,
                    c.earnedOn,
                    c.expiresOn ?? "—",
                    <span key={c.id} className="row-gap">
                      <StatusBadge status={status.label} tone={status.tone} literal />
                      {!c.verifiedBy && <StatusBadge status="Not verified" tone="neutral" literal />}
                      {c.renewalStatus && (
                        <StatusBadge
                          status={`Renewal ${c.renewalStatus.toLowerCase()}${c.renewalRequestedOn ? ` · ${c.renewalRequestedOn}` : ""}`}
                          tone="info"
                          literal
                        />
                      )}
                    </span>,
                    <span key={`${c.id}-a`} className="row-gap cert-row-actions">
                      <button type="button" className="btn-ghost btn-tiny" onClick={() => setViewing(doc)}>
                        <Eye size={14} aria-hidden /> View
                      </button>
                      {!expired && (
                        <button type="button" className="btn-ghost btn-tiny" onClick={() => void downloadCertificatePng(doc)}>
                          <Download size={14} aria-hidden /> Download
                        </button>
                      )}
                      {c.employeeId === employee.id && status.tone !== "ok" && !c.renewalStatus && (
                        <>
                          {!c.validityYears && (
                            <input
                              type="date"
                              aria-label="New expiry date"
                              min={today}
                              value={renewExpiry[c.id] ?? ""}
                              onChange={(e) => setRenewExpiry((prev) => ({ ...prev, [c.id]: e.target.value }))}
                            />
                          )}
                          <button
                            type="button"
                            className="btn btn-tiny"
                            disabled={!c.validityYears && !renewExpiry[c.id]}
                            onClick={() =>
                              talentAction(() => requestCertificationRenewal(demoProfile, c.id, renewExpiry[c.id]), (res) => setNotice(noticeFor(res,
                                  "Renewal recorded. HR will verify it.",
                                ),
                              ))
                            }
                          >
                            Record renewal
                          </button>
                        </>
                      )}
                      {hr && c.employeeId !== employee.id && c.renewalStatus === "Pending verification" && (
                        <button
                          type="button"
                          className="btn btn-tiny"
                          onClick={() => talentAction(() => verifyCertificationRenewal(demoProfile, c.id), (res) => setNotice(noticeFor(res, `Renewal verified for ${c.employeeName}.`)))}
                        >
                          Verify renewal
                        </button>
                      )}
                      {hr && c.employeeId !== employee.id && !c.verifiedBy && !expired && !c.renewalStatus && (
                        <>
                          <input
                            value={credIds[c.id] ?? ""}
                            onChange={(e) => setCredIds((prev) => ({ ...prev, [c.id]: e.target.value }))}
                            placeholder="Credential ID"
                            aria-label="Credential ID"
                            style={{ width: 120 }}
                          />
                          <button
                            type="button"
                            className="btn btn-tiny"
                            onClick={() =>
                              talentAction(() => verifyCertification(demoProfile, c.id, credIds[c.id] ?? ""), (res) => setNotice(noticeFor(res, `${c.name} verified.`)))
                            }
                          >
                            Verify
                          </button>
                        </>
                      )}
                    </span>,
                  ];
                })}
              empty={<EmptyState title="No certifications on file" description="Ask HR to add one." />}
            />
          </Card>
        </div>
      )}

      {tab === "team" && showTeam && (
        <Card title="Team course completions">
          <DataTable
            headers={["Employee", "Course", "Status", "Progress", ""]}
            rows={teamEnrollments.map((e) => [
              e.employeeName,
              courseCatalog().find((c) => c.id === e.courseId)?.title ?? e.courseId,
              <StatusBadge key={e.id} status={e.status} literal />,
              <Progress key={`${e.id}-p`} value={e.progress} />,
              e.status === "Completed" ? (
                <span key={`${e.id}-a`} className="muted">
                  Done {e.completedOn ?? ""}
                  {e.assessmentScore !== undefined ? ` · score ${e.assessmentScore}` : ""}
                </span>
              ) : !hr ? (
                ""
              ) : e.progress >= SELF_PROGRESS_CAP ? (
                <button
                  key={`${e.id}-a`}
                  type="button"
                  className="btn btn-tiny"
                  onClick={() => talentAction(() => completeEnrollment(demoProfile, e.id), (res) => setNotice(noticeFor(res, `Course marked complete for ${e.employeeName}.`)))}
                >
                  Mark complete
                </button>
              ) : (
                <ScoreCompletion
                  key={`${e.id}-a`}
                  onSubmit={(score) =>
                    talentAction(() => completeEnrollment(demoProfile, e.id, score), (res) => setNotice(noticeFor(res, `Passed. Course complete for ${e.employeeName}.`)))
                  }
                />
              ),
            ])}
            empty={<EmptyState title="No enrollments" description="No one else is enrolled yet." />}
          />
          {hr && <p className="note">Mark complete at {SELF_PROGRESS_CAP}% progress, or record a score (pass mark {PASS_MARK}).</p>}
        </Card>
      )}

      <CertificateDialog doc={viewing} onClose={() => setViewing(null)} />
    </Page>
  );
}

/* ───────────────────────────── SKILLS & CAREER ── */

export function SkillsCareerPage() {
  const { demoProfile } = usePortal();
  const talent = useTalent();
  const [tab, setTab] = useState("profile");
  const [notice, setNotice] = useState<Notice>(null);
  const track = starterSkillsFor(demoProfile.id).track;
  const roles = (apiTargetRoles() ?? TARGET_ROLES).filter((t) => t.track === track);
  const [targetId, setTargetId] = useState(roles[0]?.id ?? "");
  const skills = skillProfileFor(talent, demoProfile.id);
  const setSkill = (skillId: string, patch: { level?: string; targetLevel?: string }) =>
    talentAction(() => updateEmployeeSkill(demoProfile, demoProfile.id, skillId, patch), (res) => setNotice(noticeFor(res)));
  const target = roles.find((t) => t.id === targetId) ?? roles[0];

  const gaps = useMemo(() => {
    if (!target) return [];
    return Object.entries(target.required).map(([skillId, need]) => {
      const def = SKILL_LIBRARY.find((s) => s.id === skillId);
      const have = skills.find((s) => s.skillId === skillId)?.level ?? "None";
      const gap = (LEVEL_RANK[need] ?? 0) - (LEVEL_RANK[have] ?? 0);
      return { skillId, name: def?.name ?? skillId, have, need, gap };
    });
  }, [target, skills]);

  const myEnrollments = talent.enrollments.filter((e) => e.employeeId === demoProfile.id);
  const recommendations = useMemo(() => {
    const needing = new Set(gaps.filter((g) => g.gap > 0).map((g) => g.skillId));
    return courseCatalog().filter(
      (c) =>
        c.skills.some((s) => needing.has(s)) &&
        courseOpenTo(c, demoProfile) &&
        !myEnrollments.some((e) => e.courseId === c.id && e.status === "Completed"),
    ).slice(0, 4);
  }, [gaps, demoProfile, myEnrollments]);

  const seesTeamInterests = canSeeTeamInterests(demoProfile);

  return (
    <Page title="Skills & career">
      <Tabs
        tabs={[
          { id: "library", label: "Skills library" },
          { id: "profile", label: "My skills profile" },
          { id: "interests", label: "Career interests" },
          { id: "matches", label: "Role matches" },
          { id: "gap", label: "Target role & gaps" },
          { id: "recs", label: "Recommended courses" },
          ...(seesTeamInterests ? [{ id: "team", label: "Team interests" }] : []),
        ]}
        value={tab}
        onChange={setTab}
      />

      <Banner message={notice} />

      {tab === "interests" && <CareerInterestsPanel me={demoProfile} />}
      {tab === "matches" && <RoleMatchesPanel me={demoProfile} />}
      {tab === "team" && seesTeamInterests && <TeamInterestsPanel me={demoProfile} />}

      {tab === "library" && <SkillsLibraryPanel me={demoProfile} />}

      {tab === "profile" && (
        <Card title="My skills">
          <DataTable
            headers={["Skill", "Current level", "Personal target"]}
            rows={skills.map((s) => {
              const levels = SKILL_LIBRARY.find((x) => x.id === s.skillId)?.levels ?? SKILL_LEVELS;
              return [
                s.skillName,
                <select aria-label="Current level" key={`${s.skillId}-c`} value={s.level} onChange={(e) => setSkill(s.skillId, { level: e.target.value })}>
                  {levels.map((lvl) => (
                    <option key={lvl} value={lvl}>{lvl}</option>
                  ))}
                </select>,
                <select aria-label="Target level" key={`${s.skillId}-t`} value={s.targetLevel} onChange={(e) => setSkill(s.skillId, { targetLevel: e.target.value })}>
                  {levels.map((lvl) => (
                    <option key={lvl} value={lvl}>{lvl}</option>
                  ))}
                </select>,
              ];
            })}
          />
        </Card>
      )}

      {tab === "gap" &&
        (!target ? (
          <Card>
            <EmptyState title="No target role" description="There is no next role set for your position." />
          </Card>
        ) : (
          <div className="stack">
            <FilterBar>
              <label className="filter-label">
                Target role
                <select value={target.id} onChange={(e) => setTargetId(e.target.value)}>
                  {roles.map((t) => (
                    <option key={t.id} value={t.id}>{t.title}</option>
                  ))}
                </select>
              </label>
            </FilterBar>
            <Card title={`Skill gap vs ${target.title}`}>
              <DataTable
                headers={["Skill", "You have", "Role needs", "Gap"]}
                rows={gaps.map((g) => [
                  g.name,
                  g.have,
                  g.need,
                  g.gap <= 0 ? (
                    <StatusBadge key={g.skillId} status="On track" tone="ok" />
                  ) : (
                    <StatusBadge key={g.skillId} status={`+${g.gap} level${g.gap > 1 ? "s" : ""}`} tone="warn" />
                  ),
                ])}
              />
            </Card>
          </div>
        ))}

      {tab === "recs" && (
        <Card title={target ? `Courses for ${target.title}` : "Recommended courses"}>
          {recommendations.length === 0 ? (
            <EmptyState title="Nothing to suggest" description="No open courses match your skill gaps." />
          ) : (
            <ul className="todo">
              {recommendations.map((c) => (
                <li key={c.id}>
                  {c.title} · {c.category} · {c.durationHours}h
                  {myEnrollments.some((e) => e.courseId === c.id) ? " · Enrolled " : " "}
                  <Link to="/programs">Open learning</Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </Page>
  );
}
