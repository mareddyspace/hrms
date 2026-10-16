import { useMemo, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import {
  Banner,
  Card,
  DataTable,
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
  COURSES,
  LEARNING_PATHS,
  LEVEL_RANK,
  PERF_CYCLES,
  PIPELINE_STAGES,
  SKILL_LIBRARY,
  TARGET_ROLES,
  type Certification,
  type Enrollment,
  type PipelineStage,
} from "../data/talentData.ts";
import {
  allowedStageMoves,
  canAcknowledgePolicies,
  canEditGoal,
  canEditOnboarding,
  canEditOnboardingTask,
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
  setCandidateStage,
  setJoinerPolicyAck,
  setOnboardingTaskStatus,
  setOfferStatus,
  setRequisitionApproval,
  skillProfileFor,
  submitInterviewFeedback,
  subscribeTalent,
  updateEmployeeSkill,
  updateEnrollmentProgress,
  updateGoalProgress,
  updateReview,
  verifyCertificationRenewal,
} from "../data/talentLocal.ts";
import { accountHasNavAccess } from "../demoAccounts.ts";
import { candidateAccess } from "../data/rbac.ts";
import { LocaleContextBanner, RegionalFilter } from "../locale/RegionalFilter.tsx";
import { useLocale } from "../locale/LocaleContext.tsx";
import { maskEmail, todayISO } from "../model.ts";
import { usePortal } from "../store.tsx";
import { Award, Download, Eye } from "lucide-react";
import {
  CertificateDialog,
  credentialCode,
  downloadCertificatePng,
  type CertificateDoc,
} from "../components/CertificateViewer.tsx";
import { canManagePeople } from "../data/peoplePermissions.ts";
import { FeedbackPanel, OneOnOnePanel } from "./PerformanceCheckIns.tsx";

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
  const [tab, setTab] = useState("reqs");
  const [q, setQ] = useState("");
  const [stageFilter, setStageFilter] = useState("");
  const [selectedCand, setSelectedCand] = useState(talent.candidates[0]?.id ?? "");
  const [selectedReq, setSelectedReq] = useState(talent.requisitions[0]?.id ?? "");
  const [fbInterview, setFbInterview] = useState("");
  const [fbScore, setFbScore] = useState("4");
  const [fbText, setFbText] = useState("");
  const [offerCand, setOfferCand] = useState("");
  const [offerNote, setOfferNote] = useState("");
  const [notice, setNotice] = useState<Notice>(null);

  // Recruiter, HR and hiring managers edit; others with nav access (admin, executive…) read only.
  const canEdit = canEditRecruiting(actor.role);
  const canOpen = canEdit || accountHasNavAccess(actor, "recruiting");

  const candAccess = candidateAccess(demoProfile, true);
  const canSeeCandidates = candAccess !== "hidden";
  const maskCandidates = candAccess === "masked";

  const regionReqs = useMemo(
    () => talent.requisitions.filter((r) => matchesRegion(undefined, r.country)),
    [talent.requisitions, matchesRegion],
  );

  const candidates = useMemo(() => {
    if (!canSeeCandidates) return [];
    return talent.candidates.filter((c) => {
      if (!matchesRegion(undefined, c.country)) return false;
      if (stageFilter && c.stage !== stageFilter) return false;
      if (q && !`${c.name} ${c.role} ${c.email}`.toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    });
  }, [talent.candidates, q, stageFilter, matchesRegion, canSeeCandidates]);

  if (!canOpen) return <NotAuthorized module="Recruiting" />;

  const candidate = candidates.find((c) => c.id === selectedCand) ?? candidates[0];
  const requisition = regionReqs.find((r) => r.id === selectedReq) ?? regionReqs[0];
  const reqMoves = requisition && canEdit ? requisitionMoves(actor, requisition) : [];
  const feedbackInterviews = talent.interviews.filter(
    (i) => i.feedbackStatus === "Pending" && canSubmitInterviewFeedback(actor, i),
  );
  const offerCandidates = canEdit ? offerEligibleCandidates(talent) : [];

  const stageCounts = PIPELINE_STAGES.map((stage) => ({
    label: stage.replace("Final Review", "Final"),
    value: candidates.filter((c) => c.stage === stage).length,
  }));

  const openReqs = regionReqs.filter((r) => r.approvalStatus === "Approved").length;
  const pendingFeedback = talent.interviews.filter((i) => i.feedbackStatus === "Pending").length;
  const offersOut = talent.offers.filter((o) => o.status === "Sent" || o.status === "Preparing").length;

  function submitFeedback() {
    const score = Number(fbScore);
    const error = submitInterviewFeedback(actor, fbInterview, score, fbText);
    setNotice(noticeFor(error, "Interview feedback submitted."));
    if (!error) {
      setFbInterview("");
      setFbText("");
    }
  }

  function prepareOffer() {
    const error = createOffer(actor, offerCand, offerNote);
    setNotice(noticeFor(error, "Offer created in Preparing."));
    if (!error) {
      setOfferCand("");
      setOfferNote("");
    }
  }

  return (
    <Page title="Recruiting">
      <LocaleContextBanner />
      <p className="note">
        Candidate access for {demoProfile.personaLabel}: <strong>{candAccess}</strong>
        {maskCandidates ? " · contact details masked" : ""}
        {!canEdit ? " · read-only" : ""}
      </p>
      <Banner message={notice} />
      <MetricGrid>
        <MetricCard label="Open approved reqs" value={openReqs} />
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
          { id: "reqs", label: "Requisitions" },
          { id: "pipeline", label: "Pipeline" },
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
              rows={regionReqs.map((r) => [
                r.id,
                r.title,
                r.department,
                `${r.location}, ${r.country}`,
                String(r.openings),
                <StatusBadge
                  key={r.id}
                  status={r.approvalStatus}
                  tone={
                    r.approvalStatus === "Approved"
                      ? "ok"
                      : r.approvalStatus === "Rejected" || r.approvalStatus === "On hold"
                        ? "warn"
                        : "info"
                  }
                />,
                <button key={`${r.id}-v`} type="button" className="quiet-link" onClick={() => { setSelectedReq(r.id); }}>
                  Details
                </button>,
              ])}
            />
          </Card>
          {requisition && (
            <Card title={`Requisition · ${requisition.id}`}>
              <dl className="info-grid">
                <div className="info-fact"><dt>Title</dt><dd>{requisition.title}</dd></div>
                <div className="info-fact"><dt>Hiring manager</dt><dd>{requisition.hiringManager}</dd></div>
                <div className="info-fact"><dt>Recruiter</dt><dd>{requisition.recruiter}</dd></div>
                <div className="info-fact"><dt>Created</dt><dd>{requisition.created}</dd></div>
                <div className="info-fact"><dt>Summary</dt><dd>{requisition.stageSummary}</dd></div>
                <div className="info-fact"><dt>Approval</dt><dd>{requisition.approvalStatus}</dd></div>
              </dl>
              {reqMoves.length > 0 ? (
                <div className="row-gap">
                  {reqMoves.map((next) => (
                    <button
                      key={next}
                      type="button"
                      className={next === "Approved" || next === "Pending approval" ? "btn btn-tiny" : "btn-ghost btn-tiny"}
                      onClick={() =>
                        setNotice(noticeFor(setRequisitionApproval(actor, requisition.id, next), `${requisition.id} → ${next}.`))
                      }
                    >
                      {next === "Pending approval" ? "Submit for approval" : next === "On hold" ? "Put on hold" : next === "Approved" ? "Approve" : "Reject"}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="muted">
                  {!canEdit
                    ? "Read-only."
                    : requisition.approvalStatus === "Approved" || requisition.approvalStatus === "Rejected"
                      ? "This requisition has been decided."
                      : "Waiting for an HR approver other than the hiring manager."}
                </p>
              )}
            </Card>
          )}
        </div>
      )}

      {tab === "pipeline" && (
        <div className="mgr-home-grid">
          <Card title="Recruitment pipeline">
            <MiniBars items={stageCounts} />
          </Card>
          <Card title="Move candidate stage (human-controlled)">
            {candidates.length === 0 ? (
              <EmptyState title="No candidates" description="Adjust filters to see pipeline rows." />
            ) : (
              <DataTable
                headers={["Candidate", "Role", "Stage", "Advance"]}
                rows={candidates.map((c) => {
                  const moves = canEdit ? allowedStageMoves(c, talent.offers) : [];
                  return [
                    c.name,
                    c.role,
                    <StatusBadge key={c.id} status={c.stage} tone={c.stage === "Rejected" || c.stage === "Withdrawn" ? "warn" : "info"} />,
                    <select
                      key={`${c.id}-stage`}
                      value={c.stage}
                      disabled={moves.length === 0}
                      onChange={(e) =>
                        setNotice(noticeFor(setCandidateStage(actor, c.id, e.target.value as PipelineStage), `${c.name} → ${e.target.value}.`))
                      }
                    >
                      {[c.stage, ...moves].map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>,
                  ];
                })}
              />
            )}
            {canEdit && <p className="muted">Move one stage forward, or to Rejected / Withdrawn. Hired needs an accepted offer.</p>}
          </Card>
        </div>
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
                <button key={`${c.id}-o`} type="button" className="quiet-link" onClick={() => setSelectedCand(c.id)}>
                  Profile
                </button>,
              ])}
              empty={<EmptyState title="No matches" description="Try clearing search or stage filter." />}
            />
          </Card>
          {candidate && canSeeCandidates && (
            <Card title={`Profile · ${candidate.name}`}>
              <dl className="info-grid">
                <div className="info-fact">
                  <dt>Email</dt>
                  <dd>{maskCandidates ? maskEmail(candidate.email) : candidate.email}</dd>
                </div>
                <div className="info-fact">
                  <dt>Phone</dt>
                  <dd>{maskCandidates ? "••••••••" : candidate.phone}</dd>
                </div>
                <div className="info-fact"><dt>Requisition</dt><dd>{candidate.requisitionId}</dd></div>
                <div className="info-fact"><dt>Source</dt><dd>{candidate.source}</dd></div>
                <div className="info-fact"><dt>Experience</dt><dd>{candidate.experienceYears} years</dd></div>
                <div className="info-fact"><dt>Skills</dt><dd>{candidate.skills.join(", ")}</dd></div>
              </dl>
              <p className="note">{maskCandidates ? "Resume details limited for this role." : candidate.resumeNote}</p>
            </Card>
          )}
          {!canSeeCandidates && (
            <EmptyState
              title="Candidates restricted"
              description={`${demoProfile.personaLabel} cannot view candidate profiles under current RBAC rules.`}
            />
          )}
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
                <StatusBadge key={i.id} status={i.feedbackStatus} tone={i.feedbackStatus === "Submitted" ? "ok" : "warn"} />,
              ])}
            />
          </Card>
          <Card title="Submit interview feedback">
            {feedbackInterviews.length === 0 ? (
              <EmptyState
                title="Nothing to submit"
                description="Feedback can be submitted by the interview panel, recruiters or HR for pending interviews."
              />
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
          <Card title="Offer preparation status">
            <DataTable
              headers={["Candidate", "Role", "Status", "Package", "Sent", "Actions"]}
              rows={talent.offers.map((o) => {
                const moves = canEdit ? offerMoves(o) : [];
                return [
                  o.candidateName,
                  o.role,
                  <StatusBadge key={o.id} status={o.status} />,
                  o.packageNote,
                  o.sentOn ?? "—",
                  <select
                    key={`${o.id}-st`}
                    value={o.status}
                    disabled={moves.length === 0}
                    onChange={(e) =>
                      setNotice(
                        noticeFor(
                          setOfferStatus(actor, o.id, e.target.value as typeof o.status),
                          `${o.candidateName}'s offer → ${e.target.value}.`,
                        ),
                      )
                    }
                  >
                    {[o.status, ...moves].map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>,
                ];
              })}
              empty={<EmptyState title="No offers" description="Create offers from Final Review candidates." />}
            />
          </Card>
          {canEdit && (
            <Card title="Prepare an offer">
              {offerCandidates.length === 0 ? (
                <EmptyState title="No eligible candidates" description="Offers can be prepared for candidates at Final Review or Offer without an open offer." />
              ) : (
                <div className="form-grid-2">
                  <Field label="Candidate">
                    <select value={offerCand} onChange={(e) => setOfferCand(e.target.value)}>
                      <option value="">Select…</option>
                      {offerCandidates.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} · {c.role} ({c.stage})
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Package note">
                    <input value={offerNote} onChange={(e) => setOfferNote(e.target.value)} placeholder="Level, band, location…" />
                  </Field>
                  <div>
                    <button type="button" className="btn" disabled={!offerCand || !offerNote.trim()} onClick={prepareOffer}>
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
        <div className="mgr-home-grid">
          <Card title="Candidates by stage">
            <MiniBars items={stageCounts} />
          </Card>
          <Card title="Recruitment analytics">
            <ul className="todo">
              <li>Avg time-to-hire: 34 days</li>
              <li>Interviews this week: {talent.interviews.length}</li>
              <li>Offers accepted: {talent.offers.filter((o) => o.status === "Accepted").length}</li>
              <li>Reqs pending approval: {talent.requisitions.filter((r) => r.approvalStatus === "Pending approval").length}</li>
            </ul>
          </Card>
        </div>
      )}
    </Page>
  );
}

/* ───────────────────────────── ONBOARDING ── */

export function OnboardingPage() {
  const talent = useTalent();
  const { demoProfile } = usePortal();
  const actor = demoProfile;
  const [selected, setSelected] = useState(talent.joiners[0]?.id ?? "");
  const [ownerFilter, setOwnerFilter] = useState("");
  const [notice, setNotice] = useState<Notice>(null);

  const isStaff = canEditOnboarding(actor.role) || actor.role === "hiring_manager";
  if (!isStaff && !accountHasNavAccess(actor, "onboarding")) return <NotAuthorized module="Onboarding" />;

  const joiner = talent.joiners.find((j) => j.id === selected) ?? talent.joiners[0];
  const tasks = talent.tasks.filter(
    (t) => t.joinerId === joiner?.id && (!ownerFilter || t.owner === ownerFilter),
  );
  const canAck = joiner ? canAcknowledgePolicies(actor, joiner) : false;

  return (
    <Page title="Onboarding">
      <Banner message={notice} />
      <MetricGrid>
        <MetricCard label="Active joiners" value={talent.joiners.length} />
        <MetricCard
          label="Pre-boarding"
          value={talent.joiners.filter((j) => j.overallStatus === "Pre-boarding").length}
        />
        <MetricCard
          label="Open tasks"
          value={talent.tasks.filter((t) => t.status !== "Done").length}
        />
        <MetricCard
          label="Policy pending"
          value={talent.joiners.filter((j) => j.policyAck === "Pending").length}
        />
      </MetricGrid>

      <div className="mgr-home-grid">
        <Card title="New joiner list">
          <DataTable
            headers={["Name", "Role", "Start", "Country", "Status", ""]}
            rows={talent.joiners.map((j) => [
              j.name,
              j.role,
              j.startDate,
              j.country,
              <StatusBadge key={j.id} status={j.overallStatus} />,
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
              <div className="info-fact"><dt>Documents</dt><dd>{joiner.docsStatus}</dd></div>
              <div className="info-fact"><dt>Policy acknowledgement</dt><dd>{joiner.policyAck}</dd></div>
            </dl>
            <Progress value={joiner.preboardingPct} label="Checklist complete" />
            <div className="row-gap" style={{ marginTop: 8 }}>
              {canAck && (
                <button
                  type="button"
                  className="btn"
                  disabled={joiner.policyAck === "Complete"}
                  onClick={() =>
                    setNotice(noticeFor(setJoinerPolicyAck(actor, joiner.id, "Complete"), "Policies acknowledged."))
                  }
                >
                  {sameName(joiner.name, actor.fullName) ? "Acknowledge policies" : "Record acknowledgement (HR)"}
                </button>
              )}
              <Link to="/policies" className="btn-ghost">
                View policies
              </Link>
            </div>
            {!canAck && joiner.policyAck === "Pending" && (
              <p className="muted">Policies are acknowledged by the joiner (or HR on their behalf).</p>
            )}
          </Card>
        )}
      </div>

      <Card
        title="Onboarding checklist"
        action={
          <label className="filter-label">
            Owner
            <select value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)}>
              <option value="">All (HR / IT / Manager / Employee)</option>
              {(["HR", "IT", "Manager", "Employee"] as const).map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          </label>
        }
      >
        {!joiner ? (
          <EmptyState title="Select a joiner" description="Choose someone from the list above." />
        ) : (
          <DataTable
            headers={["Task", "Owner", "Category", "Due", "Status", "Update"]}
            rows={tasks.map((t) => [
              t.title,
              t.owner,
              t.category,
              t.due,
              <StatusBadge key={t.id} status={t.status} tone={t.status === "Done" ? "ok" : "warn"} />,
              <select
                key={`${t.id}-u`}
                value={t.status}
                disabled={!canEditOnboardingTask(actor, t, joiner)}
                onChange={(e) =>
                  setNotice(noticeFor(setOnboardingTaskStatus(actor, t.id, e.target.value as typeof t.status)))
                }
              >
                {(["Pending", "In progress", "Done"] as const).map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>,
            ])}
            empty={<EmptyState title="No tasks" description="No checklist items for this filter." />}
          />
        )}
      </Card>
    </Page>
  );
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/* ───────────────────────────── PERFORMANCE ── */

export function PerformancePage() {
  const { employee, demoProfile, demoAccounts, canApproveLeaveFor } = usePortal();
  const actor = demoProfile;
  const talent = useTalent();
  const [tab, setTab] = useState("goals");
  const [cycleId, setCycleId] = useState(PERF_CYCLES[0]?.id ?? "");
  const [notice, setNotice] = useState<Notice>(null);
  const cycle = PERF_CYCLES.find((c) => c.id === cycleId) ?? PERF_CYCLES[0];

  // Yourself, anyone below you in the reporting line, or everyone for HR.
  const canView = (employeeId: string) => employeeId === actor.id || canApproveLeaveFor(employeeId);
  const myGoals = talent.goals.filter((g) => g.cycleId === cycleId && canView(g.ownerId));
  const reviews = talent.reviews.filter((r) => r.cycleId === cycleId && canView(r.employeeId));
  const review = (id: string, patch: Parameters<typeof updateReview>[2]) => setNotice(noticeFor(updateReview(actor, id, patch)));

  return (
    <Page title="Performance">
      <FilterBar>
        <label className="filter-label">
          Performance cycle
          <select value={cycleId} onChange={(e) => setCycleId(e.target.value)}>
            {PERF_CYCLES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.status}
              </option>
            ))}
          </select>
        </label>
      </FilterBar>

      {cycle && (
        <MetricGrid>
          <MetricCard label="Cycle" value={cycle.name} hint={`${cycle.start} → ${cycle.end}`} />
          <MetricCard label="Status" value={cycle.status} />
          <MetricCard label="Completion" value={`${cycle.completionPct}%`} />
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
          { id: "360", label: "360 feedback" },
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
        <Card title="Goals, OKRs and KPIs">
          <DataTable
            headers={["Owner", "Type", "Title", "Progress", "Adjust"]}
            rows={myGoals.map((g) => [
              g.ownerName,
              g.type,
              g.title,
              <Progress key={g.id} value={g.progress} />,
              <input
                key={`${g.id}-p`}
                type="range"
                min={0}
                max={100}
                value={g.progress}
                disabled={!canEditGoal(actor, g)}
                onChange={(e) => setNotice(noticeFor(updateGoalProgress(actor, g.id, Number(e.target.value))))}
              />,
            ])}
            empty={<EmptyState title="No goals" description="No goals for this cycle and persona." />}
          />
        </Card>
      )}

      {tab === "feedback" && <FeedbackPanel me={employee} people={demoAccounts} feedback={talent.feedback} />}

      {tab === "checkins" && <OneOnOnePanel me={actor} people={demoAccounts} meetings={talent.oneOnOnes} />}

      {tab === "self" && (
        <Card title="Self-assessment">
          <DataTable
            headers={["Employee", "Status", "Action"]}
            rows={reviews.map((r) => [
              r.employeeName,
              <StatusBadge key={r.id} status={r.selfStatus} literal />,
              <select
                key={`${r.id}-self`}
                value={r.selfStatus}
                disabled={r.employeeId !== actor.id}
                title={r.employeeId !== actor.id ? "Only the employee can update their self-assessment" : undefined}
                onChange={(e) => review(r.id, { selfStatus: e.target.value as typeof r.selfStatus })}
              >
                {(["Not started", "Draft", "Submitted"] as const).map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>,
            ])}
            empty={<EmptyState title="No reviews" description="No reviews in view for this cycle." />}
          />
        </Card>
      )}

      {tab === "manager" && (
        <Card title="Manager assessment">
          <DataTable
            headers={["Employee", "Status", "Action"]}
            rows={reviews.map((r) => [
              r.employeeName,
              <StatusBadge key={r.id} status={r.managerStatus} literal />,
              <select
                key={`${r.id}-mgr`}
                value={r.managerStatus}
                disabled={!canApproveLeaveFor(r.employeeId)}
                onChange={(e) => review(r.id, { managerStatus: e.target.value as typeof r.managerStatus })}
              >
                {(["Not started", "Draft", "Submitted"] as const).map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>,
            ])}
            empty={<EmptyState title="No reviews" description="No reviews in view for this cycle." />}
          />
        </Card>
      )}

      {tab === "360" && (
        <Card title="360-degree feedback">
          <DataTable
            headers={["Employee", "360 status", "Update"]}
            rows={reviews.map((r) => [
              r.employeeName,
              <StatusBadge key={r.id} status={r.feedback360Status} literal />,
              <select
                key={`${r.id}-360`}
                value={r.feedback360Status}
                disabled={!canApproveLeaveFor(r.employeeId)}
                onChange={(e) => review(r.id, { feedback360Status: e.target.value as typeof r.feedback360Status })}
              >
                {(["Not started", "In progress", "Complete"] as const).map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>,
            ])}
            empty={<EmptyState title="No reviews" description="No reviews in view for this cycle." />}
          />
        </Card>
      )}

      {tab === "reviews" && (
        <Card title="Review status, ratings and development plans">
          <DataTable
            headers={["Employee", "Self", "Manager", "360", "Rating", "Dev plan"]}
            rows={reviews.map((r) => {
              const canManage = canApproveLeaveFor(r.employeeId);
              const canRate = canManage && r.managerStatus === "Submitted";
              return [
                r.employeeName,
                r.selfStatus,
                r.managerStatus,
                r.feedback360Status,
                <select
                  key={`${r.id}-rate`}
                  value={r.rating ?? ""}
                  disabled={!canRate}
                  title={canManage && !canRate ? "Submit the manager assessment first" : undefined}
                  onChange={(e) => review(r.id, { rating: e.target.value || undefined })}
                >
                  <option value="">— Select (human) —</option>
                  {["Needs improvement", "Solid", "Strong", "Exceptional"].map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>,
                <input
                  key={`${r.id}-dp`}
                  value={r.developmentPlan ?? ""}
                  readOnly={!canManage}
                  onChange={(e) => review(r.id, { developmentPlan: e.target.value })}
                  placeholder="Development plan…"
                  style={{ minWidth: 160 }}
                />,
              ];
            })}
            empty={<EmptyState title="No reviews" description="No reviews in view for this cycle." />}
          />
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
  if (!c.expiresOn) return { label: "No expiry", tone: "ok" };
  const days = daysUntil(c.expiresOn, today);
  if (days < 0) return { label: "Expired", tone: "danger" };
  if (days <= CERT_EXPIRY_WARNING_DAYS) return { label: `Expires in ${days} days`, tone: "warn" };
  return { label: "Valid", tone: "ok" };
}

export function LearningPage() {
  const { employee, demoProfile } = usePortal();
  const talent = useTalent();
  const [tab, setTab] = useState("catalog");
  const [viewing, setViewing] = useState<CertificateDoc | null>(null);
  // Certificates are personal records: employees see their own, HR sees everyone's.
  const seesAllCertificates = canManagePeople(demoProfile.role);
  const [q, setQ] = useState("");
  const [mandatoryOnly, setMandatoryOnly] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  // New expiry dates typed for renewals of certifications without a fixed validity.
  const [renewExpiry, setRenewExpiry] = useState<Record<string, string>>({});

  const catalog = COURSES.filter((c) => {
    if (mandatoryOnly && !c.mandatory) return false;
    if (q && !`${c.title} ${c.category}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  const today = todayISO();
  const mine = talent.enrollments.filter((e) => e.employeeId === employee.id || e.employeeName === employee.fullName);
  const enrolledCourseIds = new Set(mine.map((e) => e.courseId));
  const overdue = mine.filter((e) => e.status !== "Completed" && e.due && e.due < today);
  const myCerts = talent.certifications.filter((c) => c.employeeId === employee.id);
  const visibleCerts = seesAllCertificates ? talent.certifications : myCerts;
  const courseCertificates: CertificateDoc[] = talent.enrollments
    .filter((e) => e.status === "Completed" && (seesAllCertificates || e.employeeId === employee.id))
    .map((e) => {
      const course = COURSES.find((c) => c.id === e.courseId);
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
    credentialId: `${c.issuer.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase()}-${credentialCode(c.id + c.employeeId)}`,
  });
  const certsNeedingRenewal = myCerts.filter((c) => certStatus(c, today).tone !== "ok" && !c.renewalStatus);
  const teamEnrollments = seesAllCertificates ? talent.enrollments.filter((e) => e.employeeId !== employee.id) : [];

  return (
    <Page title="Learning">
      <MetricGrid>
        <MetricCard label="Catalog courses" value={COURSES.length} />
        <MetricCard label="My enrollments" value={mine.length} />
        <MetricCard label="Completed" value={mine.filter((e) => e.status === "Completed").length} />
        <MetricCard label="Mandatory open" value={mine.filter((e) => e.status !== "Completed" && COURSES.find((c) => c.id === e.courseId)?.mandatory).length} />
        <MetricCard label="Overdue" value={overdue.length} hint={overdue.length ? "Finish these first" : "Nothing overdue"} />
      </MetricGrid>

      {(overdue.length > 0 || certsNeedingRenewal.length > 0) && (
        <Banner
          message={{
            tone: "warn",
            text: [
              overdue.length
                ? `${overdue.length} course${overdue.length > 1 ? "s are" : " is"} overdue: ${overdue
                    .map((e) => COURSES.find((c) => c.id === e.courseId)?.title ?? e.courseId)
                    .join(", ")}.`
                : "",
              certsNeedingRenewal.length
                ? `${certsNeedingRenewal.length} certification${certsNeedingRenewal.length > 1 ? "s need" : " needs"} renewal (see Certifications).`
                : "",
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
          ...(seesAllCertificates ? [{ id: "team", label: "Team completions" }] : []),
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
            headers={["Course", "Category", "Hours", "Mandatory", "Level", ""]}
            rows={catalog.map((c) => [
              c.title,
              c.category,
              String(c.durationHours),
              c.mandatory ? "Yes" : "No",
              c.level,
              enrolledCourseIds.has(c.id) ? (
                <button key={c.id} type="button" className="btn-ghost" disabled>
                  Enrolled
                </button>
              ) : (
                <button
                  key={c.id}
                  type="button"
                  className="btn-ghost"
                  onClick={() => enrollInCourse(c.id, employee.id, employee.fullName)}
                >
                  Enroll
                </button>
              ),
            ])}
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
                  .map((id) => `${isDone(id) ? "✓ " : ""}${COURSES.find((c) => c.id === id)?.title ?? id}`)
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
              const course = COURSES.find((c) => c.id === e.courseId);
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
                    <input
                      type="range"
                      min={0}
                      max={SELF_PROGRESS_CAP}
                      value={Math.min(e.progress, SELF_PROGRESS_CAP)}
                      aria-label="Self-reported progress"
                      onChange={(ev) =>
                        setNotice(noticeFor(updateEnrollmentProgress(employee, e.id, Number(ev.target.value))))
                      }
                    />
                    {e.progress >= SELF_PROGRESS_CAP && <span className="muted">Final assessment pending — HR confirms completion</span>}
                  </span>
                ),
              ];
            })}
            empty={<EmptyState title="No enrollments" description="Enroll from the catalog to track progress." />}
          />
        </Card>
      )}

      {tab === "certs" && (
        <div className="stack">
          <Card title={`Course certificates${courseCertificates.length ? ` (${courseCertificates.length})` : ""}`}>
            {courseCertificates.length === 0 ? (
              <EmptyState title="No certificates yet" description="Finish a course to earn its completion certificate." />
            ) : (
              <ul className="cert-grid">
                {courseCertificates.map((doc) => (
                  <li key={doc.id} className="cert-tile">
                    <span className="cert-tile-icon" aria-hidden>
                      <Award size={22} />
                    </span>
                    <strong>{doc.title}</strong>
                    <span className="muted">
                      {seesAllCertificates ? `${doc.recipient} · ` : ""}Completed {doc.issuedOn}
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
              headers={[
                ...(seesAllCertificates ? ["Employee"] : []),
                "Certification",
                "Issuer",
                "Earned",
                "Expires",
                "Status",
                "",
              ]}
              rows={[...visibleCerts]
                .sort((a, b) => (a.expiresOn ?? "9999").localeCompare(b.expiresOn ?? "9999"))
                .map((c) => {
                  const status = certStatus(c, today);
                  const doc = certificateFor(c);
                  return [
                    ...(seesAllCertificates ? [c.employeeName] : []),
                    c.name,
                    c.issuer,
                    c.earnedOn,
                    c.expiresOn ?? "—",
                    <span key={c.id} className="row-gap">
                      <StatusBadge status={status.label} tone={status.tone} literal />
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
                      <button type="button" className="btn-ghost btn-tiny" onClick={() => void downloadCertificatePng(doc)}>
                        <Download size={14} aria-hidden /> Download
                      </button>
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
                              setNotice(
                                noticeFor(
                                  requestCertificationRenewal(employee, c.id, renewExpiry[c.id]),
                                  "Renewal recorded — HR will verify it before the dates change.",
                                ),
                              )
                            }
                          >
                            Record renewal
                          </button>
                        </>
                      )}
                      {seesAllCertificates && c.employeeId !== employee.id && c.renewalStatus === "Pending verification" && (
                        <button
                          type="button"
                          className="btn btn-tiny"
                          onClick={() =>
                            setNotice(noticeFor(verifyCertificationRenewal(employee, c.id), `Renewal verified for ${c.employeeName}.`))
                          }
                        >
                          Verify renewal
                        </button>
                      )}
                    </span>,
                  ];
                })}
              empty={<EmptyState title="No certifications on file" description="Ask HR to add an external certification to your record." />}
            />
          </Card>
        </div>
      )}

      {tab === "team" && seesAllCertificates && (
        <Card title="Team course completions">
          <DataTable
            headers={["Employee", "Course", "Status", "Progress", ""]}
            rows={teamEnrollments.map((e) => [
              e.employeeName,
              COURSES.find((c) => c.id === e.courseId)?.title ?? e.courseId,
              <StatusBadge key={e.id} status={e.status} literal />,
              <Progress key={`${e.id}-p`} value={e.progress} />,
              e.status === "Completed" ? (
                <span key={`${e.id}-a`} className="muted">Done {e.completedOn ?? ""}</span>
              ) : (
                <button
                  key={`${e.id}-a`}
                  type="button"
                  className="btn btn-tiny"
                  onClick={() =>
                    setNotice(noticeFor(completeEnrollment(employee, e.id), `Course marked complete for ${e.employeeName}.`))
                  }
                >
                  Mark complete
                </button>
              ),
            ])}
            empty={<EmptyState title="No enrollments" description="No one else is enrolled yet." />}
          />
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
  const [targetId, setTargetId] = useState(TARGET_ROLES[1]?.id ?? "");
  const skills = skillProfileFor(talent, demoProfile.id);
  const setSkill = (skillId: string, patch: { level?: string; targetLevel?: string }) =>
    updateEmployeeSkill(demoProfile, demoProfile.id, skillId, patch);
  const target = TARGET_ROLES.find((t) => t.id === targetId) ?? TARGET_ROLES[0];

  const gaps = useMemo(() => {
    if (!target) return [];
    return Object.entries(target.required).map(([skillId, need]) => {
      const def = SKILL_LIBRARY.find((s) => s.id === skillId);
      const current = skills.find((s) => s.skillId === skillId);
      const have = current?.level ?? "Awareness";
      const gap = (LEVEL_RANK[need] ?? 0) - (LEVEL_RANK[have] ?? 0);
      return {
        skillId,
        name: def?.name ?? skillId,
        have,
        need,
        gap,
      };
    });
  }, [target, skills]);

  const recommendations = useMemo(() => {
    const needing = gaps.filter((g) => g.gap > 0).map((g) => g.name.toLowerCase());
    return COURSES.filter((c) => needing.some((n) => c.title.toLowerCase().includes(n.split(" ")[0]) || c.category.toLowerCase().includes("engineering") || c.category.toLowerCase().includes("leadership"))).slice(0, 4);
  }, [gaps]);

  return (
    <Page title="Skills & Career">
      <Tabs
        tabs={[
          { id: "library", label: "Skills library" },
          { id: "profile", label: "My skills profile" },
          { id: "gap", label: "Target role & gaps" },
          { id: "recs", label: "Recommended development" },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "library" && (
        <Card title="Skills library">
          <DataTable
            headers={["Skill", "Category", "Proficiency scale"]}
            rows={SKILL_LIBRARY.map((s) => [s.name, s.category, s.levels.join(" → ")])}
          />
        </Card>
      )}

      {tab === "profile" && (
        <Card title="Employee skills profile">
          <DataTable
            headers={["Skill", "Current level", "Personal target"]}
            rows={skills.map((s) => [
              s.skillName,
              <select key={`${s.skillId}-c`} value={s.level} onChange={(e) => setSkill(s.skillId, { level: e.target.value })}>
                {(SKILL_LIBRARY.find((x) => x.id === s.skillId)?.levels ?? []).map((lvl) => (
                  <option key={lvl} value={lvl}>{lvl}</option>
                ))}
              </select>,
              <select
                key={`${s.skillId}-t`}
                value={s.targetLevel}
                onChange={(e) => setSkill(s.skillId, { targetLevel: e.target.value })}
              >
                {(SKILL_LIBRARY.find((x) => x.id === s.skillId)?.levels ?? []).map((lvl) => (
                  <option key={lvl} value={lvl}>{lvl}</option>
                ))}
              </select>,
            ])}
          />
        </Card>
      )}

      {tab === "gap" && (
        <div className="stack">
          <FilterBar>
            <label className="filter-label">
              Target role
              <select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                {TARGET_ROLES.map((t) => (
                  <option key={t.id} value={t.id}>{t.title}</option>
                ))}
              </select>
            </label>
          </FilterBar>
          <Card title={`Skill gap vs ${target?.title ?? "role"}`}>
            <DataTable
              headers={["Skill", "You have", "Role needs", "Gap"]}
              rows={gaps.map((g) => [
                g.name,
                g.have,
                g.need,
                g.gap <= 0 ? (
                  <StatusBadge key={g.skillId} status="On track" tone="ok" />
                ) : (
                  <StatusBadge key={g.skillId} status={`+${g.gap} level`} tone="warn" />
                ),
              ])}
            />
          </Card>
        </div>
      )}

      {tab === "recs" && (
        <div className="mgr-home-grid">
          <Card title="Recommended courses">
            {recommendations.length === 0 ? (
              <EmptyState title="No gaps" description="You meet the selected target role skill bar." />
            ) : (
              <ul className="todo">
                {recommendations.map((c) => (
                  <li key={c.id}>
                    {c.title} · {c.category} · {c.durationHours}h{" "}
                    <Link to="/programs">Open Learning</Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Development activities">
            <ul className="todo">
              <li>Pair with a tech lead on a design review</li>
              <li>Complete Manager essentials path (if leadership gap)</li>
              <li>Shadow an interview panel</li>
              <li>
                Draft a career plan with <Link to="/ai/copilot">Copilot</Link>
              </li>
            </ul>
          </Card>
        </div>
      )}
    </Page>
  );
}

/** Aliases matching existing App routes */
export function EvaluationsPage() {
  return <PerformancePage />;
}

export function ProgramsPage() {
  return <LearningPage />;
}
