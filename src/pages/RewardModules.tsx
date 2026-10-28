import { useMemo, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
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
  downloadText,
} from "../components/ui.tsx";
import {
  canManageLetters,
  canViewSalaryAmount,
  displayMoney,
  formatCompAmount,
  getCompensationAccess,
  hasModuleAccess,
} from "../data/peoplePermissions.ts";
import { DEMO_ACCOUNTS } from "../demoAccounts.ts";
import { BENEFIT_PLANS, LEGAL_DISCLAIMER, LIFE_EVENT_TYPES, type Dependent, type GradeBand } from "../data/rewardData.ts";
import {
  UPLOAD_EXTENSIONS,
  activeLifeEvent,
  addLibraryDoc,
  canAdminBenefits,
  canDecideBenefitFor,
  canDecideCompReview,
  canProposeFor,
  changeWindowFor,
  closeLifeEvent,
  cycleBudgetUse,
  cycleTakesProposals,
  decideChangeRequest,
  decideCompReview,
  decideEnrollment,
  eligibilityRules,
  getRewardState,
  isAboveInLine,
  isMandatoryPlan,
  isPayHr,
  openEnrollmentIsOpen,
  openEnrollmentLabel,
  pendingChangeFor,
  planEligibility,
  raiseLifeEvent,
  removeDependent,
  requestEnrollment,
  requestEnrollmentChange,
  setBonusStatus,
  setCompCycleStatus,
  setOpenEnrollmentDates,
  setOpenEnrollmentOverride,
  submitCompReview,
  subscribeReward,
  validateUpload,
  verifyDependent,
} from "../data/rewardLocal.ts";
import { BandDialog, BonusDialog, CoverDialog, DependentDialog, NewCycleDialog, ProposeDialog } from "./RewardDialogs.tsx";
import { formatShortDate, todayISO, type DocumentGroup } from "../model.ts";
import { usePortal } from "../store.tsx";
import { LetterHistoryPanel, LetterRequestsPanel, LetterViewerDialog, MyLettersPanel, type OpenLetter } from "./LettersPanel.tsx";

function useReward() {
  return useSyncExternalStore(subscribeReward, getRewardState, getRewardState);
}

function ScopeNote({ text }: { text: string }) {
  return <p className="note">{text}</p>;
}

/* ───────────────────────────── COMPENSATION ── */

const STRUCTURE_ROLES = ["finance", "hr", "hr_admin", "hrbp", "manager", "executive", "founder", "cofounder"];

const COMP_STATUS_TONE: Record<string, "ok" | "warn" | "danger" | "info" | "neutral"> = {
  Draft: "neutral",
  "Pending approval": "warn",
  "Pending final approval": "info",
  Approved: "ok",
  Rejected: "danger",
};

export function CompensationPage() {
  const { demoProfile } = usePortal();
  const reward = useReward();
  const me = demoProfile;
  const access = getCompensationAccess(me);
  const compTeam = access.peopleScope === "global";
  const leadsPeople = demoAccountsBelow(me.id);
  const showStructures = STRUCTURE_ROLES.includes(me.role);
  const showCycles = compTeam || leadsPeople;
  const tabs = [
    ...(showStructures ? [{ id: "structures", label: "Structures & ranges" }] : []),
    { id: "history", label: compTeam ? "Compensation history" : "My pay history" },
    ...(showCycles ? [{ id: "cycles", label: "Review cycles" }] : []),
    { id: "bonuses", label: compTeam ? "Bonus & incentives" : "My bonuses" },
  ];
  const [tab, setTab] = useState(tabs[0].id);
  const cycles = reward.cycles;
  const [cycleId, setCycleId] = useState(cycles.find((c) => c.status !== "Closed")?.id ?? cycles[0]?.id ?? "");
  const [country, setCountry] = useState("");
  const [reviewMsg, setReviewMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [dialog, setDialog] = useState<"cycle" | "propose" | "bonus" | null>(null);
  const [editBand, setEditBand] = useState<GradeBand | null>(null);
  const payHr = isPayHr(me);

  const moduleOk = hasModuleAccess(me, "compensation") || access.module;
  const bands = reward.bands.filter((b) => !country || b.country === country);
  const cycle = cycles.find((c) => c.id === cycleId) ?? cycles[0];
  const budget = cycle ? cycleBudgetUse(reward, cycle.id) : null;
  const canPropose = cycleTakesProposals(cycle) && DEMO_ACCOUNTS.some((a) => canProposeFor(me, a.id));
  const grades = [...new Set(reward.bands.map((b) => b.grade))].sort();
  const report = (error: string | null, ok: string) => setReviewMsg(error ? { tone: "err", text: error } : { tone: "ok", text: ok });
  const done = (text: string) => {
    setDialog(null);
    setEditBand(null);
    setReviewMsg({ tone: "ok", text });
  };

  // Pay amounts: your own, or everyone's for HR (compensation & benefits) / Finance.
  const seesPay = (employeeId: string) => employeeId === me.id || canViewSalaryAmount(me, employeeId, { selfId: me.id }) !== "hidden";
  const visibleHistory = reward.history.filter((row) => seesPay(row.employeeId));
  const visibleBonuses = reward.bonuses.filter((row) => seesPay(row.employeeId));

  // Proposals: never your own; HR sees the cycle, others only people below them.
  const visibleReviews = useMemo(
    () =>
      reward.reviews.filter(
        (row) => row.cycleId === cycleId && row.employeeId !== me.id && (compTeam || isAboveInLine(me.id, row.employeeId)),
      ),
    [reward.reviews, cycleId, compTeam, me.id],
  );
  const amountAccess = (employeeId: string) =>
    isAboveInLine(me.id, employeeId) ? ("full" as const) : canViewSalaryAmount(me, employeeId, { selfId: me.id });
  const myDecisions = reward.reviews.filter((r) => canDecideCompReview(me, r)).length;

  if (!moduleOk) {
    return (
      <Page title="Compensation">
        <EmptyState title="No access" description="You don't have access to compensation." />
      </Page>
    );
  }

  return (
    <Page title="Compensation">
      <MetricGrid>
        {compTeam || leadsPeople ? (
          <>
            <MetricCard label="Open cycle" value={cycle?.status ?? "—"} hint={cycle?.name} />
            <MetricCard label="Proposals in view" value={visibleReviews.length} />
            <MetricCard label="Waiting for you" value={myDecisions} />
          </>
        ) : (
          <>
            <MetricCard label="Current grade" value={visibleHistory.find((h) => h.employeeId === me.id)?.grade ?? "—"} />
            <MetricCard label="Pay changes" value={visibleHistory.length} />
            <MetricCard label="Bonuses" value={visibleBonuses.length} />
          </>
        )}
      </MetricGrid>

      <Tabs tabs={tabs} value={tabs.some((t) => t.id === tab) ? tab : tabs[0].id} onChange={setTab} />
      {tab !== "cycles" && <Banner message={reviewMsg} />}

      {tab === "structures" && showStructures && (
        <Card title="Grades and salary ranges">
          <FilterBar>
            <label className="filter-label">
              Country
              <select value={country} onChange={(e) => setCountry(e.target.value)}>
                <option value="">All</option>
                {[...new Set(reward.bands.map((b) => b.country))].map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>
          </FilterBar>
          <DataTable
            headers={["Grade", "Family", "Country", "Currency", "Min", "Mid", "Max", ...(payHr ? [""] : [])]}
            rows={bands.map((b) => [
              ...(access.ranges === "full"
                ? [b.grade, b.family, b.country, b.currency, b.min, b.mid, b.max]
                : [b.grade, b.family, b.country, b.currency, "••••", "••••", "••••"]),
              ...(payHr
                ? [
                    <button key={b.id} type="button" className="quiet-link" onClick={() => setEditBand(b)}>
                      Edit
                    </button>,
                  ]
                : []),
            ])}
          />
        </Card>
      )}

      {tab === "history" && (
        <Card title={compTeam ? "Compensation history" : "My pay history"}>
          <DataTable
            headers={[...(compTeam ? ["Employee"] : []), "Effective", "Event", "Grade", "Base"]}
            rows={visibleHistory.map((row) => [...(compTeam ? [row.employeeName] : []), row.effective, row.event, row.grade, row.base])}
            empty={<EmptyState title="No pay changes" description="Nothing recorded yet." />}
          />
        </Card>
      )}

      {tab === "cycles" && showCycles && (
        <div className="stack">
          <FilterBar>
            <label className="filter-label">
              Cycle
              <select value={cycle?.id ?? ""} onChange={(e) => setCycleId(e.target.value)}>
                {cycles.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.status}
                  </option>
                ))}
              </select>
            </label>
            {payHr && (
              <button type="button" className="btn" onClick={() => setDialog("cycle")}>
                New cycle
              </button>
            )}
          </FilterBar>
          <Banner message={reviewMsg} />
          {cycle && (
            <Card
              title={cycle.name}
              action={
                payHr ? (
                  cycle.status === "Planning" || cycle.status === "Closed" ? (
                    <button type="button" className="btn-ghost" onClick={() => report(setCompCycleStatus(me, cycle.id, "Open"), `${cycle.name} is open.`)}>
                      {cycle.status === "Closed" ? "Reopen" : "Open now"}
                    </button>
                  ) : (
                    <button type="button" className="btn-ghost" onClick={() => report(setCompCycleStatus(me, cycle.id, "Closed"), `${cycle.name} is closed.`)}>
                      Close cycle
                    </button>
                  )
                ) : undefined
              }
            >
              <dl className="info-grid">
                <div className="info-fact"><dt>Status</dt><dd><StatusBadge status={cycle.status} literal /></dd></div>
                <div className="info-fact"><dt>Window</dt><dd>{cycle.window}</dd></div>
                <div className="info-fact"><dt>Countries</dt><dd>{cycle.countries.join(", ")}</dd></div>
                {cycle.effectiveDate && <div className="info-fact"><dt>New pay effective</dt><dd>{formatShortDate(cycle.effectiveDate)}</dd></div>}
                {cycle.budgetPct !== undefined && (
                  <div className="info-fact">
                    <dt>Budget</dt>
                    <dd>
                      {cycle.budgetPct}%{compTeam && budget ? ` · ${budget.usedPct}% proposed` : ""}
                    </dd>
                  </div>
                )}
                {cycle.createdBy && <div className="info-fact"><dt>Created by</dt><dd>{cycle.createdBy}</dd></div>}
              </dl>
            </Card>
          )}
          <Card
            title="Increase proposals"
            action={
              canPropose ? (
                <button type="button" className="btn" onClick={() => setDialog("propose")}>
                  Propose
                </button>
              ) : undefined
            }
          >
            <p className="note">Approval: someone above the employee (not the proposer), then HR. HR's own pay is finalised by their line manager.</p>
            {cycle && !cycleTakesProposals(cycle) && (
              <Banner
                message={{ tone: "info", text: cycle.status === "Closed" ? "This cycle is closed." : `This cycle is in ${cycle.status.toLowerCase()} and not taking proposals.` }}
              />
            )}
            <DataTable
              headers={["Employee", "Proposed by", "Grade", "Current", "Proposed", "Incr %", "Bonus", "Status", "Line approval", "Final", "Action"]}
              rows={visibleReviews.map((r) => {
                const vis = amountAccess(r.employeeId);
                let action: ReactNode = <span className="muted">—</span>;
                if (canDecideCompReview(me, r)) {
                  action = (
                    <span className="reward-actions">
                      <button type="button" className="btn" onClick={() => report(decideCompReview(me, r.id, "Approved"), `${r.employeeName}: approved.`)}>
                        Approve
                      </button>
                      <button type="button" className="btn-ghost" onClick={() => report(decideCompReview(me, r.id, "Rejected"), `${r.employeeName}: rejected.`)}>
                        Reject
                      </button>
                    </span>
                  );
                } else if (r.status === "Draft" && r.managerId === me.id && cycleTakesProposals(cycle)) {
                  action = (
                    <button type="button" className="btn" onClick={() => report(submitCompReview(me, r.id), `${r.employeeName}: submitted.`)}>
                      Submit
                    </button>
                  );
                }
                return [
                  r.employeeName,
                  r.managerName,
                  `${r.currentGrade} → ${formatCompAmount(vis, r.proposedGrade, "•••")}`,
                  displayMoney(r.currentBase, vis),
                  displayMoney(r.proposedBase, vis),
                  formatCompAmount(vis, `${r.proposedIncreasePct}%`, "•••"),
                  displayMoney(r.bonusProposal, vis),
                  <StatusBadge key={r.id} status={r.status} tone={COMP_STATUS_TONE[r.status]} literal />,
                  r.lineApprover ? `${r.lineApprover} · ${r.lineApprovedOn ?? ""}` : "—",
                  r.approver ? `${r.approver} · ${r.decidedOn ?? ""}` : "—",
                  <span key={`${r.id}-a`}>{action}</span>,
                ];
              })}
              empty={<EmptyState title="No proposals" description="Nothing in this cycle for you." />}
            />
          </Card>
        </div>
      )}

      {tab === "bonuses" && (
        <Card
          title={compTeam ? "Bonus and incentive records" : "My bonuses"}
          action={
            payHr ? (
              <button type="button" className="btn" onClick={() => setDialog("bonus")}>
                Record bonus
              </button>
            ) : undefined
          }
        >
          <DataTable
            headers={[...(compTeam ? ["Employee"] : []), "Type", "Period", "Amount", "Status", ...(payHr ? [""] : [])]}
            rows={visibleBonuses.map((b) => [
              ...(compTeam ? [b.employeeName] : []),
              b.type,
              b.period,
              b.amount,
              <StatusBadge key={b.id} status={b.status} literal />,
              ...(payHr
                ? [
                    b.status === "Accrued" && b.employeeId !== me.id ? (
                      <span key={`${b.id}-a`} className="reward-actions">
                        <button type="button" className="btn-ghost" onClick={() => report(setBonusStatus(me, b.id, "Paid"), `${b.employeeName}: bonus marked paid.`)}>
                          Mark paid
                        </button>
                        <button type="button" className="btn-ghost" onClick={() => report(setBonusStatus(me, b.id, "Forfeited"), `${b.employeeName}: bonus forfeited.`)}>
                          Forfeit
                        </button>
                      </span>
                    ) : (
                      "—"
                    ),
                  ]
                : []),
            ])}
            empty={<EmptyState title="No bonuses" description="Nothing recorded yet." />}
          />
        </Card>
      )}

      {dialog === "cycle" && (
        <NewCycleDialog
          actor={me}
          countries={[...new Set(reward.bands.map((b) => b.country))]}
          onClose={() => setDialog(null)}
          onDone={(text) => {
            done(text);
            setCycleId(getRewardState().cycles[0]?.id ?? "");
          }}
        />
      )}
      {dialog === "propose" && cycle && <ProposeDialog actor={me} cycle={cycle} grades={grades} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === "bonus" && <BonusDialog actor={me} onClose={() => setDialog(null)} onDone={done} />}
      {editBand && <BandDialog actor={me} band={editBand} onClose={() => setEditBand(null)} onDone={done} />}
    </Page>
  );
}

/** True when anyone in the demo org reports (directly or not) to this person. */
function demoAccountsBelow(id: string): boolean {
  return DEMO_ACCOUNTS.some((a) => isAboveInLine(id, a.id));
}

/* ───────────────────────────── BENEFITS ── */

function ChangeRequestButton({ onSend }: { onSend: (note: string) => string | null }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  if (!open) {
    return (
      <button type="button" className="quiet-link" onClick={() => setOpen(true)}>
        Request change
      </button>
    );
  }
  return (
    <span className="row-gap">
      <input aria-label="What should change" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="What should change?" />
      <button type="button" className="btn btn-tiny" disabled={note.trim().length < 5} onClick={() => !onSend(note) && setOpen(false)}>
        Send
      </button>
    </span>
  );
}

export function BenefitsPage() {
  const { demoProfile, employee, demoAccounts } = usePortal();
  const reward = useReward();
  const [tab, setTab] = useState("plans");
  const [planId, setPlanId] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [depDialog, setDepDialog] = useState<Dependent | "new" | null>(null);
  const [cover, setCover] = useState<{ planId: string; planName: string } | null>(null);
  const [eventType, setEventType] = useState(LIFE_EVENT_TYPES[0]);
  const [eventDate, setEventDate] = useState(todayISO());
  const [winStart, setWinStart] = useState(reward.openEnrollment.start);
  const [winEnd, setWinEnd] = useState(reward.openEnrollment.end);

  const isBenefitsAdmin = canAdminBenefits(demoProfile);
  const canSeeOthers = isBenefitsAdmin;

  // Employees are locked to their own country; HR can browse any country.
  const ownCountry = employee.countryName ?? "";
  const [hrCountry, setHrCountry] = useState(ownCountry);
  const country = canSeeOthers ? hrCountry : ownCountry;

  const countryOf = (employeeId: string) =>
    demoAccounts.find((a) => a.id === employeeId)?.countryName ??
    reward.enrollments.find((e) => e.employeeId === employeeId)?.country ??
    "";
  const inScope = (employeeId: string) =>
    canSeeOthers ? !country || countryOf(employeeId) === country : employeeId === employee.id;
  const nameOf = (employeeId: string) => demoAccounts.find((a) => a.id === employeeId)?.fullName ?? employeeId;

  const plans = BENEFIT_PLANS.filter((p) => (canSeeOthers ? !country || p.country === country : p.country === ownCountry));
  const selectedPlan = plans.find((p) => p.id === planId) ?? plans[0];

  // HR's own pending requests go to their line manager, who sees just those rows.
  const decidesFor = (employeeId: string) => !isBenefitsAdmin && canDecideBenefitFor(demoProfile, employeeId);
  const enrollments = reward.enrollments.filter((e) =>
    canSeeOthers
      ? !country || e.country === country
      : e.employeeId === employee.id || (e.status === "Pending" && decidesFor(e.employeeId)),
  );
  const myPlanIds = new Set(reward.enrollments.filter((e) => e.employeeId === employee.id && e.status !== "Waived").map((e) => e.planId));
  const availablePlans = BENEFIT_PLANS.filter((p) => p.country === ownCountry && !myPlanIds.has(p.id) && !p.mandatory);
  const changeRequests = reward.changeRequests.filter((c) =>
    canSeeOthers ? inScope(c.employeeId) : c.employeeId === employee.id || (c.status === "Pending" && decidesFor(c.employeeId)),
  );

  const myDependents = reward.dependents.filter((d) => d.employeeId === employee.id);
  const dependents = reward.dependents.filter(
    (d) => inScope(d.employeeId) || (d.verification === "Pending" && decidesFor(d.employeeId)),
  );
  const history = reward.benefitHistory.filter((h) => inScope(h.employeeId));
  const lifeEvents = reward.lifeEvents.filter((e) =>
    canSeeOthers ? inScope(e.employeeId) : e.employeeId === employee.id || decidesFor(e.employeeId),
  );
  const changeWin = changeWindowFor(reward, employee.id);
  const myEvent = activeLifeEvent(reward, employee.id);
  const oe = reward.openEnrollment;
  const oeOpen = openEnrollmentIsOpen(oe);
  const coveredBy = (planName: string, employeeId: string) =>
    reward.dependents.filter((d) => d.employeeId === employeeId && d.coveredPlans.includes(planName)).map((d) => d.name);

  function run(error: string | null, okText: string) {
    setMsg(error ? { tone: "err", text: error } : { tone: "ok", text: okText });
    return error;
  }

  /** Elections and changes only inside a window; outside it, say why instead of acting. */
  function inWindow(action: () => void) {
    if (!changeWin.open) {
      setMsg({ tone: "err", text: changeWin.text });
      return;
    }
    action();
  }

  function join(planIdToJoin: string) {
    const plan = BENEFIT_PLANS.find((p) => p.id === planIdToJoin);
    if (!plan) return;
    inWindow(() => {
      const err = run(requestEnrollment(demoProfile, plan.id), "Enrollment request sent to HR.");
      if (!err && plan.coversDependents && myDependents.length) setCover({ planId: plan.id, planName: plan.name });
    });
  }

  function eligibilityCell(planIdToCheck: string): ReactNode {
    const plan = BENEFIT_PLANS.find((p) => p.id === planIdToCheck);
    if (!plan) return "—";
    const check = planEligibility(plan, employee.id);
    return check.eligible ? (
      <StatusBadge key={`${plan.id}-el`} status="Eligible" tone="ok" literal />
    ) : (
      <span key={`${plan.id}-el`} className="muted">Not eligible – {check.reason}</span>
    );
  }

  function enrollmentAction(e: (typeof enrollments)[number]): ReactNode {
    const mandatory = isMandatoryPlan(e.planId);
    if (e.employeeId === employee.id) {
      const plan = BENEFIT_PLANS.find((p) => p.id === e.planId);
      const coverBtn =
        plan?.coversDependents && (e.status === "Enrolled" || e.status === "Pending") ? (
          <button type="button" className="quiet-link" onClick={() => inWindow(() => setCover({ planId: e.planId, planName: e.planName }))}>
            Dependents
          </button>
        ) : null;
      if (e.status === "Pending") return <span className="reward-actions"><span className="muted">Awaiting HR</span>{coverBtn}</span>;
      if (e.status === "Enrolled") {
        let main: ReactNode;
        if (mandatory) main = <span className="muted">Mandatory</span>;
        else if (pendingChangeFor(reward, e.id)) main = <span className="muted">Change requested</span>;
        else if (!changeWin.open) {
          main = (
            <button type="button" className="quiet-link" onClick={() => setMsg({ tone: "err", text: changeWin.text })}>
              Request change
            </button>
          );
        } else main = <ChangeRequestButton onSend={(note) => run(requestEnrollmentChange(demoProfile, e.id, note), "Change request sent to HR.")} />;
        return <span className="reward-actions">{main}{coverBtn}</span>;
      }
      return (
        <button type="button" className="quiet-link" onClick={() => join(e.planId)}>
          Request enrollment
        </button>
      );
    }
    if (e.status === "Pending" && canDecideBenefitFor(demoProfile, e.employeeId)) {
      return (
        <span className="reward-actions">
          <button type="button" className="btn" onClick={() => run(decideEnrollment(demoProfile, e.id, "Enrolled"), `${e.employeeName} enrolled in ${e.planName}.`)}>
            Enroll
          </button>
          {!mandatory && (
            <button type="button" className="btn-ghost" onClick={() => run(decideEnrollment(demoProfile, e.id, "Waived"), `${e.employeeName} waived ${e.planName}.`)}>
              Waive
            </button>
          )}
        </span>
      );
    }
    return "—";
  }

  function dependentAction(d: Dependent): ReactNode {
    if (d.employeeId === employee.id) {
      return (
        <span className="reward-actions">
          <button type="button" className="quiet-link" onClick={() => setDepDialog(d)}>
            Edit
          </button>
          <button type="button" className="quiet-link" onClick={() => run(removeDependent(demoProfile, d.id), `${d.name} removed.`)}>
            Remove
          </button>
        </span>
      );
    }
    if (d.verification !== "Verified" && canDecideBenefitFor(demoProfile, d.employeeId)) {
      return (
        <span className="reward-actions">
          <button type="button" className="btn" onClick={() => run(verifyDependent(demoProfile, d.id, "Verified"), `${d.name} verified.`)}>
            Verify
          </button>
          {d.verification !== "Rejected" && (
            <button type="button" className="btn-ghost" onClick={() => run(verifyDependent(demoProfile, d.id, "Rejected"), `${d.name} rejected.`)}>
              Reject
            </button>
          )}
        </span>
      );
    }
    return d.verifiedBy ? `${d.verifiedBy} · ${d.verifiedOn ?? ""}` : "—";
  }

  if (!hasModuleAccess(demoProfile, "benefits")) {
    return (
      <Page title="Benefits">
        <EmptyState title="No access" description="You don't have access to benefits." />
      </Page>
    );
  }

  return (
    <Page title="Benefits">
      <FilterBar>
        <label className="filter-label">
          Country
          {canSeeOthers ? (
            <select value={hrCountry} onChange={(e) => setHrCountry(e.target.value)}>
              <option value="">All countries</option>
              {[...new Set(BENEFIT_PLANS.map((p) => p.country))].map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          ) : (
            <select aria-label="Country" value={ownCountry} disabled>
              <option value={ownCountry}>{ownCountry || "Not set"}</option>
            </select>
          )}
        </label>
      </FilterBar>

      <Banner message={msg} />

      <Tabs
        tabs={[
          { id: "plans", label: "Plans" },
          { id: "enrollment", label: "Enrollment" },
          { id: "dependents", label: "Dependents" },
          { id: "history", label: "Benefit history" },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "plans" && (
        <div className="mgr-home-grid">
          <Card title={`Benefit plans · ${country || "All countries"}`}>
            <DataTable
              headers={["Plan", "Category", "Provider", "Employee cost", "Your eligibility", ""]}
              rows={plans.map((p) => [
                <>
                  {p.name}
                  {p.mandatory ? <span className="reward-tag">Mandatory</span> : p.autoEnrolled ? <span className="reward-tag">Automatic</span> : null}
                </>,
                p.category,
                p.provider,
                p.employeeCost,
                eligibilityCell(p.id),
                <button key={p.id} type="button" className="quiet-link" onClick={() => setPlanId(p.id)}>
                  Details
                </button>,
              ])}
              empty={<EmptyState title="No plans" description="No benefit plans for this country." />}
            />
          </Card>
          {selectedPlan && (
            <Card title={selectedPlan.name}>
              <p>{selectedPlan.summary}</p>
              <p className="note">Provider: {selectedPlan.provider}</p>
              {selectedPlan.mandatory ? (
                <p className="note">Statutory. Enrollment is automatic and can't be waived.</p>
              ) : selectedPlan.autoEnrolled ? (
                <p className="note">You are enrolled automatically. Ask HR to opt out.</p>
              ) : null}
              {selectedPlan.coversDependents && <p className="note">You can add verified dependents to this plan.</p>}
              <h3 style={{ fontSize: 14, marginTop: 12 }}>Who can join</h3>
              <ul className="todo">
                {eligibilityRules(selectedPlan).map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              <p className="note">You: {eligibilityCell(selectedPlan.id)}</p>
              <h3 style={{ fontSize: 14, marginTop: 12 }}>Plan documents</h3>
              <ul className="todo">
                {selectedPlan.documents.map((d) => (
                  <li key={d}>
                    {d}{" "}
                    <button
                      type="button"
                      className="quiet-link"
                      onClick={() => downloadText(`${d}.txt`, `${d}\n\n${LEGAL_DISCLAIMER}\n\nPlan summary for ${selectedPlan.name}.`)}
                    >
                      Download (.txt)
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}

      {tab === "enrollment" && (
        <div className="stack">
          <Card
            title="Enrollment window"
            action={
              isBenefitsAdmin ? (
                <span className="reward-actions">
                  {oeOpen ? (
                    <button type="button" className="btn-ghost" onClick={() => run(setOpenEnrollmentOverride(demoProfile, "closed"), "Open enrollment closed.")}>
                      Close now
                    </button>
                  ) : (
                    <button type="button" className="btn-ghost" onClick={() => run(setOpenEnrollmentOverride(demoProfile, "open"), "Open enrollment opened.")}>
                      Open now
                    </button>
                  )}
                  {oe.override && (
                    <button type="button" className="btn-ghost" onClick={() => run(setOpenEnrollmentOverride(demoProfile, null), "Window follows its dates again.")}>
                      Use dates
                    </button>
                  )}
                </span>
              ) : undefined
            }
          >
            <dl className="info-grid">
              <div className="info-fact"><dt>Open enrollment</dt><dd>{openEnrollmentLabel(oe)}</dd></div>
              <div className="info-fact">
                <dt>Status</dt>
                <dd>
                  <StatusBadge status={oeOpen ? "Open" : "Closed"} tone={oeOpen ? "ok" : "neutral"} literal />
                  {oe.override && <span className="muted"> · set by {oe.updatedBy ?? "HR"}</span>}
                </dd>
              </div>
              <div className="info-fact"><dt>Plan year</dt><dd>{oe.year}</dd></div>
            </dl>
            <Banner message={{ tone: changeWin.open ? "info" : "warn", text: changeWin.text }} />
            {isBenefitsAdmin && (
              <form
                className="form-actions"
                onSubmit={(ev) => {
                  ev.preventDefault();
                  run(setOpenEnrollmentDates(demoProfile, winStart, winEnd), "Enrollment dates saved.");
                }}
              >
                <label className="filter-label">
                  Start
                  <input type="date" value={winStart} onChange={(ev) => setWinStart(ev.target.value)} />
                </label>
                <label className="filter-label">
                  End
                  <input type="date" value={winEnd} onChange={(ev) => setWinEnd(ev.target.value)} />
                </label>
                <button type="submit" className="btn-ghost">
                  Save dates
                </button>
              </form>
            )}
          </Card>

          <Card title="Life events">
            <p className="note">A life event lets you change benefits for 30 days from the event date.</p>
            {myEvent ? (
              <p className="note">Your {myEvent.type.toLowerCase()} window is open until {formatShortDate(myEvent.windowEnds)}.</p>
            ) : (
              <form
                className="form-actions"
                onSubmit={(ev) => {
                  ev.preventDefault();
                  run(raiseLifeEvent(demoProfile, eventType, eventDate), `${eventType} reported. You can change benefits for 30 days.`);
                }}
              >
                <label className="filter-label">
                  Event
                  <select value={eventType} onChange={(ev) => setEventType(ev.target.value)}>
                    {LIFE_EVENT_TYPES.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </label>
                <label className="filter-label">
                  Date
                  <input type="date" value={eventDate} max={todayISO()} onChange={(ev) => setEventDate(ev.target.value)} />
                </label>
                <button type="submit" className="btn">
                  Report event
                </button>
              </form>
            )}
            {lifeEvents.length > 0 && (
              <DataTable
                headers={[...(canSeeOthers ? ["Employee"] : []), "Event", "Date", "Window until", "Status", ""]}
                rows={lifeEvents.map((le) => {
                  const live = le.status === "Open" && todayISO() <= le.windowEnds;
                  return [
                    ...(canSeeOthers ? [le.employeeName] : []),
                    le.type,
                    formatShortDate(le.eventDate),
                    formatShortDate(le.windowEnds),
                    <StatusBadge key={le.id} status={live ? "Open" : "Closed"} tone={live ? "ok" : "neutral"} literal />,
                    live && canDecideBenefitFor(demoProfile, le.employeeId) ? (
                      <button key={`${le.id}-a`} type="button" className="btn-ghost" onClick={() => run(closeLifeEvent(demoProfile, le.id), "Life event window closed.")}>
                        Close window
                      </button>
                    ) : (
                      le.closedBy ? `Closed by ${le.closedBy}` : "—"
                    ),
                  ];
                })}
              />
            )}
          </Card>

          <Card title="Enrollment status">
            <DataTable
              headers={["Employee", "Plan", "Country", "Status", "Effective", "Dependents", "Action"]}
              rows={enrollments.map((e) => [
                e.employeeName,
                e.planName,
                e.country,
                <StatusBadge key={e.id} status={e.status} literal />,
                e.effective,
                coveredBy(e.planName, e.employeeId).join(", ") || "—",
                <span key={`${e.id}-a`}>{enrollmentAction(e)}</span>,
              ])}
              empty={<EmptyState title="No enrollments" />}
            />
            {!canSeeOthers && <ScopeNote text="Requests go to HR." />}
          </Card>
          {changeRequests.length > 0 && (
            <Card title="Change requests">
              <DataTable
                headers={["Requested", "Employee", "Plan", "Change", "Status", ""]}
                rows={changeRequests.map((c) => [
                  c.requestedOn,
                  c.employeeName,
                  c.planName,
                  c.note,
                  <StatusBadge key={c.id} status={c.status} literal />,
                  c.status === "Pending" && canDecideBenefitFor(demoProfile, c.employeeId) ? (
                    <span key={`${c.id}-a`} className="reward-actions">
                      <button type="button" className="btn" onClick={() => run(decideChangeRequest(demoProfile, c.id, "Done"), "Change marked done.")}>
                        Done
                      </button>
                      <button type="button" className="btn-ghost" onClick={() => run(decideChangeRequest(demoProfile, c.id, "Declined"), "Change declined.")}>
                        Decline
                      </button>
                    </span>
                  ) : (
                    c.decidedBy ? `${c.decidedBy} · ${c.decidedOn ?? ""}` : "—"
                  ),
                ])}
              />
            </Card>
          )}
          {availablePlans.length > 0 && (
            <Card title="Plans you can join">
              <DataTable
                headers={["Plan", "Category", "Employee cost", "Eligibility", ""]}
                rows={availablePlans.map((p) => {
                  const ok = planEligibility(p, employee.id).eligible;
                  return [
                    p.name,
                    p.category,
                    p.employeeCost,
                    eligibilityCell(p.id),
                    ok ? (
                      <button key={p.id} type="button" className="quiet-link" onClick={() => join(p.id)}>
                        Request enrollment
                      </button>
                    ) : (
                      "—"
                    ),
                  ];
                })}
              />
            </Card>
          )}
        </div>
      )}

      {tab === "dependents" && (
        <Card
          title="Dependents"
          action={
            <button type="button" className="btn" onClick={() => setDepDialog("new")}>
              Add dependent
            </button>
          }
        >
          <DataTable
            headers={[...(canSeeOthers ? ["Employee"] : []), "Name", "Relationship", "Date of birth", "Gender", "Covered plans", "Verification", "Action"]}
            rows={dependents.map((d) => [
              ...(canSeeOthers ? [nameOf(d.employeeId)] : []),
              d.name,
              d.relationship,
              d.dateOfBirth ? formatShortDate(d.dateOfBirth) : "—",
              d.gender ?? "—",
              d.coveredPlans.join(", ") || "—",
              <StatusBadge
                key={`${d.id}-v`}
                status={d.verification ?? "Verified"}
                tone={d.verification === "Rejected" ? "danger" : d.verification === "Pending" ? "warn" : "ok"}
                literal
              />,
              <span key={`${d.id}-a`}>{dependentAction(d)}</span>,
            ])}
            empty={<EmptyState title="No dependents on file" />}
          />
          <p className="note">HR checks new and edited dependents before they can be added to a plan. Cover changes need an open enrollment or life event window.</p>
        </Card>
      )}

      {tab === "history" && (
        <Card title="Benefit history">
          <DataTable
            headers={[...(canSeeOthers ? ["Employee"] : []), "Date", "Event", "Detail"]}
            rows={history.map((h) => [...(canSeeOthers ? [nameOf(h.employeeId)] : []), h.date, h.event, h.detail])}
            empty={<EmptyState title="No history" description="No benefit events yet." />}
          />
        </Card>
      )}

      {depDialog && (
        <DependentDialog
          actor={demoProfile}
          row={depDialog === "new" ? null : depDialog}
          onClose={() => setDepDialog(null)}
          onDone={(text) => {
            setDepDialog(null);
            setMsg({ tone: "ok", text });
          }}
        />
      )}
      {cover && (
        <CoverDialog
          actor={demoProfile}
          planId={cover.planId}
          planName={cover.planName}
          dependents={myDependents}
          onClose={() => setCover(null)}
          onDone={(text) => {
            setCover(null);
            setMsg({ tone: "ok", text });
          }}
        />
      )}
    </Page>
  );
}

/* ───────────────────────────── DOCUMENTS & LETTERS ── */

/** Library categories → portal DocumentGroup for the ESS mirror. */
const PORTAL_GROUP: Record<string, DocumentGroup> = {
  Identity: "Immigration",
  Compliance: "Employment",
  Onboarding: "Onboarding",
  Benefits: "Employment",
  Other: "Employment",
};

export function DocumentsLettersPage() {
  const { demoProfile, employee, state, addDocument } = usePortal();
  const reward = useReward();
  const [tab, setTab] = useState("library");
  const [category, setCategory] = useState("");
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [openLetter, setOpenLetter] = useState<OpenLetter>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadName, setUploadName] = useState("");
  const [uploadCategory, setUploadCategory] = useState("Identity");
  const [uploadPreview, setUploadPreview] = useState("");
  const [uploadFileLabel, setUploadFileLabel] = useState("");
  const [uploadError, setUploadError] = useState("");

  const canLetters = canManageLetters(demoProfile);
  const portalDocs = state.documents.filter((d) => d.employeeId === employee.id);

  const library = reward.library.filter((d) => {
    if (canLetters) return !category || d.category === category;
    return d.employeeId === employee.id && (!category || d.category === category);
  });

  const previewDoc = library.find((d) => d.id === previewId) ?? null;
  const categories = [...new Set(reward.library.map((d) => d.category))];

  function resetUpload() {
    setUploadName("");
    setUploadPreview("");
    setUploadFileLabel("");
    setUploadError("");
  }

  function onFilePicked(file: File | null) {
    resetUpload();
    if (!file) return;
    const invalid = validateUpload(file);
    if (invalid) {
      setUploadError(invalid);
      return;
    }
    setUploadName(file.name.replace(/\.[^.]+$/, ""));
    setUploadFileLabel(`${file.name} · ${(file.size / 1024).toFixed(0)} KB`);
    const reader = new FileReader();
    if (file.type.startsWith("text/") || /\.(txt|csv)$/i.test(file.name)) {
      reader.onload = () => {
        const text = String(reader.result ?? "").slice(0, 4000);
        setUploadPreview(`Preview of ${file.name}:\n\n${text || "(empty file)"}`);
      };
      reader.readAsText(file);
    } else if (file.type.startsWith("image/")) {
      reader.onload = () => {
        setUploadPreview(String(reader.result ?? ""));
      };
      reader.readAsDataURL(file);
    } else {
      setUploadPreview(`File details\nName: ${file.name}\nType: ${file.type || "unknown"}\nSize: ${file.size} bytes`);
    }
  }

  function saveUpload(event: FormEvent) {
    event.preventDefault();
    if (!uploadName.trim() || uploadError) return;
    const error = addLibraryDoc({
      employeeId: employee.id,
      employeeName: employee.fullName,
      name: uploadName.trim(),
      category: uploadCategory,
      docType: "Upload",
      uploadedBy: employee.fullName,
      sizeLabel: uploadFileLabel || "—",
      preview: uploadPreview || uploadName.trim(),
      isDemoFile: false,
    });
    if (error) {
      setUploadError(error);
      return;
    }
    // Mirror a short metadata line into portal documents (never the binary data URL)
    const mirrorError = addDocument({
      name: uploadName.trim(),
      category: PORTAL_GROUP[uploadCategory] ?? "Employment",
      docType: "Upload",
      expires: "",
      body: `${uploadCategory} upload · ${uploadFileLabel || uploadName.trim()} · stored in the document library.`,
    });
    if (mirrorError) {
      setUploadError(`Saved to the library, but not to My ESS documents: ${mirrorError}`);
      return;
    }
    setUploadOpen(false);
    resetUpload();
  }

  return (
    <Page
      title="Documents & letters"
      action={
        <button
          type="button"
          className="btn"
          onClick={() => {
            resetUpload();
            setUploadOpen(true);
          }}
        >
          Upload document
        </button>
      }
    >

      <Tabs
        tabs={[
          { id: "library", label: "Document library" },
          { id: "letters", label: "Letters & templates" },
          { id: "history", label: "Request & approval history" },
          { id: "personal", label: "My letters & documents" },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "library" && (
        <div className="mgr-home-grid">
          <Card title="Employee document library">
            <FilterBar>
              <label className="filter-label">
                Category
                <select value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="">All</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </label>
            </FilterBar>
            <DataTable
              headers={["Document", "Employee", "Category", "Type", "Uploaded", "Size", ""]}
              rows={library.map((d) => [
                <>
                  {d.name}
                </>,
                d.employeeName,
                d.category,
                d.docType,
                d.uploadedAt.slice(0, 10),
                d.sizeLabel,
                <button key={d.id} type="button" className="quiet-link" onClick={() => setPreviewId(d.id)}>
                  Preview
                </button>,
              ])}
              empty={<EmptyState title="No documents" description="Upload a document or switch category." />}
            />
          </Card>
          <Card title="Preview">
            {!previewDoc ? (
              <EmptyState title="Select a document" />
            ) : previewDoc.preview.startsWith("data:image") ? (
              <div>
                <p className="note">{previewDoc.name}</p>
                <img src={previewDoc.preview} alt="" style={{ maxWidth: "100%", borderRadius: 8 }} />
              </div>
            ) : (
              <pre className="doc-preview-pre">{previewDoc.preview}</pre>
            )}
            {previewDoc?.letterId && (
              <button
                type="button"
                className="btn"
                style={{ marginTop: 8, marginRight: 8 }}
                onClick={() => setOpenLetter({ letterId: previewDoc.letterId!, docId: previewDoc.docId })}
              >
                Open letter
              </button>
            )}
            {previewDoc && !previewDoc.letterId && (
              <button
                type="button"
                className="btn-ghost"
                style={{ marginTop: 8 }}
                onClick={() =>
                  downloadText(
                    `${previewDoc.name}.txt`,
                    previewDoc.preview.startsWith("data:")
                      ? `${previewDoc.name}\n${LEGAL_DISCLAIMER}`
                      : previewDoc.preview,
                  )
                }
              >
                Download
              </button>
            )}
          </Card>
        </div>
      )}

      {tab === "letters" && <LetterRequestsPanel actor={demoProfile} onOpen={setOpenLetter} />}

      {tab === "history" && <LetterHistoryPanel actor={demoProfile} onOpen={setOpenLetter} />}

      {tab === "personal" && (
        <>
          <MyLettersPanel actor={demoProfile} onOpen={setOpenLetter} />
          <Card title="My documents">
            <DataTable
              headers={["Name", "Category", "Type", "Expires"]}
              rows={portalDocs.map((d) => [d.name, d.category, d.docType, d.expires || "None"])}
              empty={<EmptyState title="No ESS documents" />}
            />
          </Card>
        </>
      )}

      <LetterViewerDialog actor={demoProfile} open={openLetter} onClose={() => setOpenLetter(null)} />

      <Dialog open={uploadOpen} title="Upload document" onClose={() => setUploadOpen(false)}>
        <form className="stack" onSubmit={saveUpload}>
          <Field label="File">
            <input
              type="file"
              accept={UPLOAD_EXTENSIONS.map((ext) => `.${ext}`).join(",")}
              onChange={(e) => onFilePicked(e.target.files?.[0] ?? null)}
            />
          </Field>
          <p className="note">PDF, PNG, JPG, WEBP, TXT or CSV · max 2 MB.</p>
          {uploadFileLabel && <p className="note">{uploadFileLabel}</p>}
          {uploadError && <Banner message={{ tone: "err", text: uploadError }} />}
          <Field label="Display name">
            <input value={uploadName} onChange={(e) => setUploadName(e.target.value)} required />
          </Field>
          <Field label="Category">
            <select value={uploadCategory} onChange={(e) => setUploadCategory(e.target.value)}>
              {Object.keys(PORTAL_GROUP).map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </Field>
          <div className="dialog-actions">
            <button type="button" className="btn-ghost" onClick={() => setUploadOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="btn" disabled={!uploadName.trim() || !!uploadError}>
              Save to library
            </button>
          </div>
        </form>
      </Dialog>
    </Page>
  );
}

/** Route alias used by App `/documents` */
export function DocumentsPage() {
  return <DocumentsLettersPage />;
}
