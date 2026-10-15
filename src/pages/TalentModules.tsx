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
  AI_GUARDRAIL,
  CERTIFICATIONS,
  COURSES,
  DEFAULT_EMPLOYEE_SKILLS,
  LEARNING_PATHS,
  LEVEL_RANK,
  PERF_CYCLES,
  PIPELINE_STAGES,
  SKILL_LIBRARY,
  TARGET_ROLES,
  type PipelineStage,
} from "../data/talentData.ts";
import {
  enrollInCourse,
  getTalentState,
  setCandidateStage,
  setJoinerPolicyAck,
  setOnboardingTaskStatus,
  setOfferStatus,
  setRequisitionApproval,
  submitInterviewFeedback,
  subscribeTalent,
  updateEnrollmentProgress,
  updateGoalProgress,
  updateReview,
} from "../data/talentLocal.ts";
import { candidateAccess } from "../data/rbac.ts";
import { LocaleContextBanner, RegionalFilter } from "../locale/RegionalFilter.tsx";
import { useLocale } from "../locale/LocaleContext.tsx";
import { maskEmail } from "../model.ts";
import { usePortal } from "../store.tsx";

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

function Guardrail() {
  return <Banner message={{ tone: "ok", text: AI_GUARDRAIL }} />;
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

export function RecruitingPage() {
  const talent = useTalent();
  const { demoProfile } = usePortal();
  const { matchesRegion, t } = useLocale();
  const [tab, setTab] = useState("reqs");
  const [q, setQ] = useState("");
  const [stageFilter, setStageFilter] = useState("");
  const [selectedCand, setSelectedCand] = useState(talent.candidates[0]?.id ?? "");
  const [selectedReq, setSelectedReq] = useState(talent.requisitions[0]?.id ?? "");
  const [fbInterview, setFbInterview] = useState("");
  const [fbScore, setFbScore] = useState(4);
  const [fbText, setFbText] = useState("");

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

  const candidate = candidates.find((c) => c.id === selectedCand) ?? candidates[0];
  const requisition = regionReqs.find((r) => r.id === selectedReq) ?? regionReqs[0];

  const stageCounts = PIPELINE_STAGES.map((stage) => ({
    label: stage.replace("Final Review", "Final"),
    value: candidates.filter((c) => c.stage === stage).length,
  }));

  const openReqs = regionReqs.filter((r) => r.approvalStatus === "Approved").length;
  const pendingFeedback = talent.interviews.filter((i) => i.feedbackStatus === "Pending").length;
  const offersOut = talent.offers.filter((o) => o.status === "Sent" || o.status === "Preparing").length;

  return (
    <Page title="Recruiting" subtitle="Requisitions, candidates, pipeline, interviews, offers & analytics">
      <Guardrail />
      <LocaleContextBanner />
      <p className="note">
        Candidate access for {demoProfile.personaLabel}: <strong>{candAccess}</strong>
        {maskCandidates ? " · contact details masked for this demo role" : ""}
      </p>
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
        onChange={setTab}
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
              </dl>
              <Field label="Human approval status (demo)">
                <select
                  value={requisition.approvalStatus}
                  onChange={(e) =>
                    setRequisitionApproval(requisition.id, e.target.value as typeof requisition.approvalStatus)
                  }
                >
                  {(["Draft", "Pending approval", "Approved", "Rejected", "On hold"] as const).map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </Field>
              <p className="note">Approval is always a human action in this prototype.</p>
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
                rows={candidates.map((c) => [
                  c.name,
                  c.role,
                  <StatusBadge key={c.id} status={c.stage} tone="info" />,
                  <select
                    key={`${c.id}-stage`}
                    value={c.stage}
                    onChange={(e) => setCandidateStage(c.id, e.target.value as PipelineStage)}
                  >
                    {PIPELINE_STAGES.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>,
                ])}
              />
            )}
            <p className="note">Stage changes do not auto-hire. Hired requires selecting Hired explicitly.</p>
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
              <p className="note">
                AI resume tips are advisory only via <Link to="/ai/copilot">Copilot</Link> — not hiring decisions.
              </p>
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
            <Field label="Interview">
              <select value={fbInterview} onChange={(e) => setFbInterview(e.target.value)}>
                <option value="">Select…</option>
                {talent.interviews
                  .filter((i) => i.feedbackStatus === "Pending")
                  .map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.candidateName} · {i.when}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Score (1–5)">
              <input
                type="number"
                min={1}
                max={5}
                value={fbScore}
                onChange={(e) => setFbScore(Number(e.target.value))}
              />
            </Field>
            <Field label="Feedback notes" wide>
              <textarea rows={3} value={fbText} onChange={(e) => setFbText(e.target.value)} placeholder="Observations for the hiring panel…" />
            </Field>
            <button
              type="button"
              className="btn"
              disabled={!fbInterview || !fbText.trim()}
              onClick={() => {
                submitInterviewFeedback(fbInterview, fbScore, fbText.trim());
                setFbInterview("");
                setFbText("");
              }}
            >
              Submit feedback
            </button>
            <p className="note">Feedback informs humans; it does not auto-advance pipeline stages.</p>
          </Card>
        </div>
      )}

      {tab === "offers" && (
        <Card title="Offer preparation status">
          <DataTable
            headers={["Candidate", "Role", "Status", "Package", "Actions"]}
            rows={talent.offers.map((o) => [
              o.candidateName,
              o.role,
              <StatusBadge key={o.id} status={o.status} />,
              o.packageNote,
              <select
                key={`${o.id}-st`}
                value={o.status}
                onChange={(e) => setOfferStatus(o.id, e.target.value as typeof o.status)}
              >
                {(["Preparing", "Sent", "Accepted", "Declined", "Withdrawn"] as const).map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>,
            ])}
            empty={<EmptyState title="No offers" description="Create offers from Final Review candidates (demo list)." />}
          />
          <p className="note">Sending or accepting an offer is a human-controlled status change.</p>
        </Card>
      )}

      {tab === "analytics" && (
        <div className="mgr-home-grid">
          <Card title="Candidates by stage">
            <MiniBars items={stageCounts} />
          </Card>
          <Card title="Recruitment analytics (demo)">
            <ul className="todo">
              <li>Avg time-to-hire (demo): 34 days</li>
              <li>Interviews this week: {talent.interviews.length}</li>
              <li>Offers accepted: {talent.offers.filter((o) => o.status === "Accepted").length}</li>
              <li>Reqs pending approval: {talent.requisitions.filter((r) => r.approvalStatus === "Pending approval").length}</li>
            </ul>
            <p className="note">Charts are illustrative; no automated reject/hire recommendations are applied.</p>
          </Card>
        </div>
      )}
    </Page>
  );
}

/* ───────────────────────────── ONBOARDING ── */

export function OnboardingPage() {
  const talent = useTalent();
  const [selected, setSelected] = useState(talent.joiners[0]?.id ?? "");
  const [ownerFilter, setOwnerFilter] = useState("");
  const joiner = talent.joiners.find((j) => j.id === selected) ?? talent.joiners[0];
  const tasks = talent.tasks.filter(
    (t) => t.joinerId === joiner?.id && (!ownerFilter || t.owner === ownerFilter),
  );

  return (
    <Page title="Onboarding" subtitle="New joiners, pre-boarding, documents, policies & checklists">
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
            <Progress value={joiner.preboardingPct} label="Pre-boarding data collection" />
            <div className="row-gap" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="btn"
                disabled={joiner.policyAck === "Complete"}
                onClick={() => setJoinerPolicyAck(joiner.id, "Complete")}
              >
                Mark policies acknowledged
              </button>
              <Link to="/policies" className="btn-ghost">
                View policies
              </Link>
            </div>
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
                onChange={(e) => setOnboardingTaskStatus(t.id, e.target.value as typeof t.status)}
              >
                {(["Pending", "In progress", "Done"] as const).map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>,
            ])}
            empty={<EmptyState title="No tasks" description="No checklist items for this filter." />}
          />
        )}
        <p className="note">
          Categories cover documents, equipment, account provisioning, orientation, training, and policy tasks.
        </p>
      </Card>
    </Page>
  );
}

/* ───────────────────────────── PERFORMANCE ── */

export function PerformancePage() {
  const { employee, demoProfile } = usePortal();
  const talent = useTalent();
  const [tab, setTab] = useState("goals");
  const [cycleId, setCycleId] = useState(PERF_CYCLES[0]?.id ?? "");
  const cycle = PERF_CYCLES.find((c) => c.id === cycleId) ?? PERF_CYCLES[0];

  const myGoals = talent.goals.filter(
    (g) => g.cycleId === cycleId && (g.ownerId === employee.id || demoProfile.role !== "employee"),
  );
  const reviews = talent.reviews.filter((r) => r.cycleId === cycleId);

  return (
    <Page title="Performance" subtitle="Goals, OKRs, KPIs, cycles, assessments, 360 feedback & development plans">
      <Guardrail />
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
          { id: "self", label: "Self-assessment" },
          { id: "manager", label: "Manager assessment" },
          { id: "360", label: "360 feedback" },
          { id: "reviews", label: "Ratings & plans" },
        ]}
        value={tab}
        onChange={setTab}
      />

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
                onChange={(e) => updateGoalProgress(g.id, Number(e.target.value))}
              />,
            ])}
            empty={<EmptyState title="No goals" description="No goals for this cycle and persona." />}
          />
        </Card>
      )}

      {tab === "self" && (
        <Card title="Self-assessment">
          <DataTable
            headers={["Employee", "Status", "Action"]}
            rows={reviews
              .filter((r) => r.employeeId === employee.id || demoProfile.role !== "employee")
              .map((r) => [
                r.employeeName,
                <StatusBadge key={r.id} status={r.selfStatus} />,
                <select
                  key={`${r.id}-self`}
                  value={r.selfStatus}
                  onChange={(e) =>
                    updateReview(r.id, { selfStatus: e.target.value as typeof r.selfStatus })
                  }
                >
                  {(["Not started", "Draft", "Submitted"] as const).map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>,
              ])}
          />
          <p className="note">Submitting self-assessment does not set a final rating.</p>
        </Card>
      )}

      {tab === "manager" && (
        <Card title="Manager assessment">
          <DataTable
            headers={["Employee", "Status", "Action"]}
            rows={reviews.map((r) => [
              r.employeeName,
              <StatusBadge key={r.id} status={r.managerStatus} />,
              <select
                key={`${r.id}-mgr`}
                value={r.managerStatus}
                onChange={(e) =>
                  updateReview(r.id, { managerStatus: e.target.value as typeof r.managerStatus })
                }
              >
                {(["Not started", "Draft", "Submitted"] as const).map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>,
            ])}
          />
          <p className="note">Manager assessment is a human workflow step — not AI-authored.</p>
        </Card>
      )}

      {tab === "360" && (
        <Card title="360-degree feedback">
          <DataTable
            headers={["Employee", "360 status", "Update"]}
            rows={reviews.map((r) => [
              r.employeeName,
              <StatusBadge key={r.id} status={r.feedback360Status} />,
              <select
                key={`${r.id}-360`}
                value={r.feedback360Status}
                onChange={(e) =>
                  updateReview(r.id, { feedback360Status: e.target.value as typeof r.feedback360Status })
                }
              >
                {(["Not started", "In progress", "Complete"] as const).map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>,
            ])}
          />
        </Card>
      )}

      {tab === "reviews" && (
        <Card title="Review status, ratings and development plans">
          <DataTable
            headers={["Employee", "Self", "Manager", "360", "Rating", "Dev plan"]}
            rows={reviews.map((r) => [
              r.employeeName,
              r.selfStatus,
              r.managerStatus,
              r.feedback360Status,
              <select
                key={`${r.id}-rate`}
                value={r.rating ?? ""}
                onChange={(e) => updateReview(r.id, { rating: e.target.value || undefined })}
              >
                <option value="">— Select (human) —</option>
                {["Needs improvement", "Solid", "Strong", "Exceptional"].map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>,
              <input
                key={`${r.id}-dp`}
                value={r.developmentPlan ?? ""}
                onChange={(e) => updateReview(r.id, { developmentPlan: e.target.value })}
                placeholder="Development plan…"
                style={{ minWidth: 160 }}
              />,
            ])}
          />
          <p className="note">{reviews[0]?.finalDecisionNote ?? AI_GUARDRAIL}</p>
        </Card>
      )}
    </Page>
  );
}

/* ───────────────────────────── LEARNING ── */

export function LearningPage() {
  const { employee } = usePortal();
  const talent = useTalent();
  const [tab, setTab] = useState("catalog");
  const [q, setQ] = useState("");
  const [mandatoryOnly, setMandatoryOnly] = useState(false);

  const catalog = COURSES.filter((c) => {
    if (mandatoryOnly && !c.mandatory) return false;
    if (q && !`${c.title} ${c.category}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  const mine = talent.enrollments.filter((e) => e.employeeId === employee.id || e.employeeName === employee.fullName);

  return (
    <Page title="Learning" subtitle="Course catalog, paths, mandatory training, completion & certifications">
      <MetricGrid>
        <MetricCard label="Catalog courses" value={COURSES.length} />
        <MetricCard label="My enrollments" value={mine.length} />
        <MetricCard label="Completed" value={mine.filter((e) => e.status === "Completed").length} />
        <MetricCard label="Mandatory open" value={mine.filter((e) => e.status !== "Completed" && COURSES.find((c) => c.id === e.courseId)?.mandatory).length} />
      </MetricGrid>

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
        ]}
        value={tab}
        onChange={setTab}
      />

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
              <button
                key={c.id}
                type="button"
                className="btn-ghost"
                onClick={() => enrollInCourse(c.id, employee.id, employee.fullName)}
              >
                Enroll
              </button>,
            ])}
            empty={<EmptyState title="No courses" description="No catalog rows match filters." />}
          />
        </Card>
      )}

      {tab === "paths" && (
        <Card title="Learning paths">
          <DataTable
            headers={["Path", "Audience", "Courses"]}
            rows={LEARNING_PATHS.map((p) => [
              p.title,
              p.audience,
              p.courses.map((id) => COURSES.find((c) => c.id === id)?.title ?? id).join(" · "),
            ])}
          />
        </Card>
      )}

      {tab === "mine" && (
        <Card title="Completion status">
          <DataTable
            headers={["Course", "Status", "Progress", "Update"]}
            rows={mine.map((e) => {
              const course = COURSES.find((c) => c.id === e.courseId);
              return [
                course?.title ?? e.courseId,
                <StatusBadge key={e.id} status={e.status} />,
                <Progress key={`${e.id}-p`} value={e.progress} />,
                <input
                  key={`${e.id}-r`}
                  type="range"
                  min={0}
                  max={100}
                  value={e.progress}
                  onChange={(ev) => updateEnrollmentProgress(e.id, Number(ev.target.value))}
                />,
              ];
            })}
            empty={<EmptyState title="No enrollments" description="Enroll from the catalog to track progress." />}
          />
        </Card>
      )}

      {tab === "certs" && (
        <Card title="Certifications">
          <DataTable
            headers={["Employee", "Certification", "Issuer", "Earned"]}
            rows={CERTIFICATIONS.map((c) => [c.employeeName, c.name, c.issuer, c.earnedOn])}
          />
        </Card>
      )}
    </Page>
  );
}

/* ───────────────────────────── SKILLS & CAREER ── */

export function SkillsCareerPage() {
  const [tab, setTab] = useState("profile");
  const [targetId, setTargetId] = useState(TARGET_ROLES[1]?.id ?? "");
  const [skills, setSkills] = useState(DEFAULT_EMPLOYEE_SKILLS);
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
    <Page title="Skills & Career" subtitle="Skills library, proficiency, target roles, gaps and development recommendations">
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
        <Card title="Employee skills profile (demo — editable locally)">
          <DataTable
            headers={["Skill", "Current level", "Personal target"]}
            rows={skills.map((s, idx) => [
              s.skillName,
              <select
                key={`${s.skillId}-c`}
                value={s.level}
                onChange={(e) => {
                  const next = [...skills];
                  next[idx] = { ...s, level: e.target.value };
                  setSkills(next);
                }}
              >
                {(SKILL_LIBRARY.find((x) => x.id === s.skillId)?.levels ?? []).map((lvl) => (
                  <option key={lvl} value={lvl}>{lvl}</option>
                ))}
              </select>,
              <select
                key={`${s.skillId}-t`}
                value={s.targetLevel}
                onChange={(e) => {
                  const next = [...skills];
                  next[idx] = { ...s, targetLevel: e.target.value };
                  setSkills(next);
                }}
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
              <EmptyState title="No gaps" description="You meet the selected target role skill bar (demo)." />
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
              <li>Shadow an interview panel (human-led hiring practice)</li>
              <li>
                Draft a career plan with <Link to="/ai/copilot">Copilot</Link> — suggestions only, not promotions
              </li>
            </ul>
            <Banner message={{ tone: "ok", text: AI_GUARDRAIL }} />
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
