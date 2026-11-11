import { DocumentRepository } from "../features/documents/DocumentRepository.tsx";
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { API_ENABLED } from "../api/client.ts";
import { Link } from "react-router-dom";
import { money } from "../countryPay.ts";
import { asDetailView } from "../data/payslipGenerator.ts";
import { PLAN_PAY_LINES } from "../data/taxRules.ts";
import { apiSetNominees, apiWithdrawProposal, type Nominee } from "../api/syncRewards.ts";
import {
  ActionButton,
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
  SubmitButton,
  Tabs,
  notify,
  useAction,
} from "../components/ui.tsx";
import {
  canViewSalaryAmount,
  displayMoney,
  formatCompAmount,
  getCompensationAccess,
  hasModuleAccess,
} from "../data/peoplePermissions.ts";
import { DEMO_ACCOUNTS } from "../demoAccounts.ts";
import { stepRoles, roleLabel, useApprovalWorkflows, type ApprovalStep } from "../data/approvalWorkflows.ts";
import { LIFE_EVENT_TYPES, type Dependent, type GradeBand } from "../data/rewardData.ts";
import {
  activeLifeEvent,
  benefitPlans,
  canAdminBenefits,
  canCloseLifeEventRow,
  canDecideBenefitFor,
  canDecideCompReview,
  canDecideEnrollmentRow,
  canVerifyDependentRow,
  cancelEnrollment,
  dependentCover,
  uploadDependentDoc,
  runRewardApi,
  type CompProposal,
  type RewardOutcome,
  canProposeFor,
  compApprovalText,
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
  verifyDependent,
} from "../data/rewardLocal.ts";
import { BandDialog, BonusDialog, CoverDialog, DependentDialog, NewCycleDialog, ProposeDialog } from "./RewardDialogs.tsx";
import { downloadDependentDoc, downloadPlanFile, downloadPlanSummary, uploadPlanFile } from "../features/benefits/benefitDocs.ts";
import { formatShortDate, parseISODate, todayISO } from "../model.ts";
import { MaskedValue } from "../components/MaskedValue.tsx";
import { isRevealRole } from "../data/piiReveal.ts";
import { isMasked } from "../utils/mask.ts";
import { usePortal } from "../store.tsx";
import { BonusesCard, PayHistoryCard, TotalRewardsCard } from "./CompensationParts.tsx";
import { LetterHistoryPanel, LetterRequestsPanel, LetterViewerDialog, MyLettersPanel, type OpenLetter } from "./LettersPanel.tsx";

function useReward() {
  return useSyncExternalStore(subscribeReward, getRewardState, getRewardState);
}

function ScopeNote({ text }: { text: string }) {
  return <p className="note">{text}</p>;
}

/* ───────────────────────────── COMPENSATION ── */

/** "HR", "Finance or Admin", "Executive (from 10%)". */
function stepSummary(step: ApprovalStep): string {
  const roles = stepRoles(step).map(roleLabel).join(step.mode === "any" ? " or " : " + ");
  return step.minPercent ? `${roles} (from ${step.minPercent}%)` : roles;
}

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
  // Open on something readable: the ranges first only for people who see their amounts, else pay history first.
  const structuresTab = showStructures ? [{ id: "structures", label: "Structures & ranges" }] : [];
  const rangesReadable = access.ranges === "full";
  const tabs = [
    ...(rangesReadable ? structuresTab : []),
    { id: "history", label: compTeam ? "Compensation history" : "My pay history" },
    ...(rangesReadable ? [] : structuresTab),
    ...(showCycles ? [{ id: "cycles", label: "Review cycles" }] : []),
    { id: "bonuses", label: compTeam ? "Bonus & incentives" : "My bonuses" },
    ...(API_ENABLED ? [{ id: "statement", label: "Total rewards" }] : []),
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
  const report = async (outcome: RewardOutcome, ok: string) => {
    const error = await outcome;
    setReviewMsg(error ? { tone: "err", text: error } : { tone: "ok", text: ok });
    if (!error) notify(ok);
    return error;
  };
  const done = (text: string) => {
    setDialog(null);
    setEditBand(null);
    setReviewMsg({ tone: "ok", text });
  };

  // Pay amounts: your own, or everyone's for HR (compensation & benefits) / Finance.
  // Backend mode: the server only returns pay the viewer may see.
  const seesPay = (employeeId: string) =>
    API_ENABLED || employeeId === me.id || canViewSalaryAmount(me, employeeId, { selfId: me.id }) !== "hidden";
  const visibleHistory = reward.history.filter((row) => seesPay(row.employeeId));
  const visibleBonuses = reward.bonuses.filter((row) => seesPay(row.employeeId));

  // Proposals: never your own; HR sees the cycle, others only people below them.
  const visibleReviews = useMemo(
    () =>
      reward.reviews.filter(
        (row) =>
          row.cycleId === cycle?.id &&
          row.employeeId !== me.id &&
          // Backend mode: the server already scoped the list (proposed by you, waiting on you, or HR's scope).
          (API_ENABLED || compTeam || isAboveInLine(me.id, row.employeeId)),
      ),
    [reward.reviews, cycle?.id, compTeam, me.id],
  );
  const amountAccess = (row: CompProposal) => {
    if (row.payVisible !== undefined) return row.payVisible ? ("full" as const) : ("hidden" as const);
    return isAboveInLine(me.id, row.employeeId) ? ("full" as const) : canViewSalaryAmount(me, row.employeeId, { selfId: me.id });
  };
  const myDecisions = reward.reviews.filter((r) => canDecideCompReview(me, r)).length;
  const compSteps = useApprovalWorkflows().compensation;

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
      <ApiLoadNote />
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
        <PayHistoryCard rows={visibleHistory} compTeam={compTeam} title={compTeam ? "Compensation history" : "My pay history"} />
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
                    <ActionButton className="btn-ghost" busyLabel="Opening…" doneLabel="Opened" onAction={() => report(setCompCycleStatus(me, cycle.id, "Open"), `${cycle.name} is open.`)}>
                      {cycle.status === "Closed" ? "Reopen" : "Open now"}
                    </ActionButton>
                  ) : (
                    <ActionButton className="btn-ghost" busyLabel="Closing…" doneLabel="Closed" onAction={() => report(setCompCycleStatus(me, cycle.id, "Closed"), `${cycle.name} is closed.`)}>
                      Close cycle
                    </ActionButton>
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
            <p className="note">
              Approval: {compSteps.length ? compSteps.map(stepSummary).join(" → ") : "HR"}. The proposer never approves. Proposals keep the steps they were submitted with.
            </p>
            {cycle && !cycleTakesProposals(cycle) && (
              <Banner
                message={{ tone: "info", text: cycle.status === "Closed" ? "This cycle is closed." : `This cycle is in ${cycle.status.toLowerCase()} and not taking proposals.` }}
              />
            )}
            <DataTable
              headers={["Employee", "Proposed by", "Grade", "Current", "Proposed", "Incr %", "Bonus", "Status", "Approvals", "Final", "Action"]}
              rows={visibleReviews.map((r) => {
                const vis = amountAccess(r);
                let action: ReactNode = <span className="muted">—</span>;
                if (canDecideCompReview(me, r)) {
                  action = (
                    <span className="reward-actions">
                      <ActionButton className="btn" onAction={() => report(decideCompReview(me, r.id, "Approved"), `${r.employeeName}: approved.`)}>
                        Approve
                      </ActionButton>
                      <ActionButton className="btn-ghost" onAction={() => report(decideCompReview(me, r.id, "Rejected"), `${r.employeeName}: rejected.`)}>
                        Reject
                      </ActionButton>
                    </span>
                  );
                } else if (r.status === "Draft" && r.managerId === me.id && cycleTakesProposals(cycle)) {
                  action = (
                    <ActionButton className="btn" onAction={() => report(submitCompReview(me, r.id), `${r.employeeName}: submitted.`)}>
                      Submit
                    </ActionButton>
                  );
                } else if (API_ENABLED && r.managerId === me.id && r.status === "Pending approval" && !r.statusLabel) {
                  action = (
                    <ActionButton
                      className="btn-ghost"
                      onAction={() => report(runRewardApi(apiWithdrawProposal(r.id), ["comp"]), `${r.employeeName}: proposal withdrawn.`)}
                    >
                      Withdraw
                    </ActionButton>
                  );
                }
                return [
                  r.employeeName,
                  r.managerName,
                  `${r.currentGrade} → ${formatCompAmount(r.payVisible === false ? "full" : vis, r.proposedGrade, "•••")}`,
                  displayMoney(r.currentBase, vis),
                  displayMoney(r.proposedBase, vis),
                  formatCompAmount(r.payVisible === false ? "full" : vis, `${r.proposedIncreasePct}%`, "•••"),
                  displayMoney(r.bonusProposal, vis),
                  <StatusBadge key={r.id} status={r.statusLabel ?? r.status} tone={r.statusLabel ? "neutral" : COMP_STATUS_TONE[r.status]} literal />,
                  compApprovalText(r),
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
        <BonusesCard
          rows={visibleBonuses}
          compTeam={compTeam}
          title={compTeam ? "Bonus and incentive records" : "My bonuses"}
          action={
            payHr ? (
              <button type="button" className="btn" onClick={() => setDialog("bonus")}>
                Record bonus
              </button>
            ) : undefined
          }
          renderAction={
            payHr
              ? (b) =>
                  b.status === "Accrued" && b.employeeId !== me.id ? (
                    <span className="reward-actions">
                      <ActionButton className="btn-ghost" doneLabel="Paid" onAction={() => report(setBonusStatus(me, b.id, "Paid"), `${b.employeeName}: bonus marked paid.`)}>
                        Mark paid
                      </ActionButton>
                      <ActionButton className="btn-ghost" busyLabel="Updating…" doneLabel="Forfeited" onAction={() => report(setBonusStatus(me, b.id, "Forfeited"), `${b.employeeName}: bonus forfeited.`)}>
                        Forfeit
                      </ActionButton>
                    </span>
                  ) : (
                    "—"
                  )
              : undefined
          }
        />
      )}

      {tab === "statement" && API_ENABLED && (
        <TotalRewardsCard
          selfId={me.id}
          others={compTeam ? [...new Map(visibleHistory.map((h) => [h.employeeId, { id: h.employeeId, name: h.employeeName }])).values()].sort((x, y) => x.name.localeCompare(y.name)) : []}
        />
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

/** Backend mode: "Loading…" until the first load, or the load error. */
function ApiLoadNote() {
  const reward = useReward();
  if (!reward.api) return null;
  if (reward.api.error) return <Banner message={{ tone: "err", text: reward.api.error }} />;
  if (!reward.api.loaded) return <p className="note">Loading from the server…</p>;
  return null;
}

/** True when anyone in the demo org reports (directly or not) to this person. */
function demoAccountsBelow(id: string): boolean {
  return DEMO_ACCOUNTS.some((a) => isAboveInLine(id, a.id));
}

/* ───────────────────────────── BENEFITS ── */

/** Backend mode: beneficiaries (nominees) per purpose, e.g. Provident Fund. Shares must add up to 100%. */
function NomineesCard({ nominees, onSaved }: { nominees: Nominee[]; onSaved: (text: string) => void }) {
  const purposes = [...new Set(nominees.map((n) => n.nominationFor))];
  const [editing, setEditing] = useState<string | null>(null);
  const [rows, setRows] = useState<Nominee[]>([]);
  const [error, setError] = useState<string | null>(null);
  const saveAct = useAction();

  function start(purpose: string) {
    setEditing(purpose);
    setError(null);
    const current = nominees.filter((n) => n.nominationFor === purpose);
    setRows(current.length ? current.map((n) => ({ ...n })) : [{ nominationFor: purpose, name: "", relationship: "", sharePct: 100 }]);
  }

  async function save() {
    if (!editing) return false;
    const filled = rows.filter((r) => r.name.trim());
    const total = filled.reduce((sum, r) => sum + (Number(r.sharePct) || 0), 0);
    if (filled.length && Math.round(total) !== 100) {
      setError(`Shares add up to ${total}%. They must total 100%.`);
      return false;
    }
    const err = await runRewardApi(apiSetNominees(editing, filled), ["benefits"]);
    if (err) {
      setError(err);
      return false;
    }
    setEditing(null);
    notify(`Nominees for ${editing} saved.`);
    onSaved(`Nominees for ${editing} saved.`);
    return true;
  }

  const update = (i: number, patch: Partial<Nominee>) => setRows((list) => list.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Card
      title="Beneficiaries"
      action={
        <button type="button" className="btn-ghost" onClick={() => start(purposes.length ? "" : "General")}>
          Add nomination
        </button>
      }
    >
      <DataTable
        headers={["For", "Name", "Relationship", "Share", "Date of birth", ""]}
        rows={nominees.map((n, i) => [
          n.nominationFor,
          n.name,
          n.relationship,
          `${n.sharePct}%`,
          <MaskedValue
            key={`${n.nominationFor}-${i}-dob`}
            value={n.dateOfBirth}
            kind="dob"
            canReveal
            format={(dob) => (isMasked(dob) ? dob : formatShortDate(dob))}
          />,
          i === nominees.findIndex((x) => x.nominationFor === n.nominationFor) ? (
            <button key={`${n.nominationFor}-e`} type="button" className="quiet-link" onClick={() => start(n.nominationFor)}>
              Edit
            </button>
          ) : (
            ""
          ),
        ])}
        empty={<EmptyState title="No beneficiaries" description="Name who receives benefits such as provident fund or life cover." />}
      />
      <Dialog open={editing !== null} title={editing ? `Nominees · ${editing}` : "New nomination"} onClose={() => setEditing(null)}>
        <form className="stack" onSubmit={saveAct.submit(save)}>
          {!purposes.includes(editing ?? "") && (
            <Field label="Nomination for">
              <input value={editing ?? ""} maxLength={64} onChange={(e) => setEditing(e.target.value)} placeholder="e.g. Provident Fund" required />
            </Field>
          )}
          {rows.map((r, i) => (
            <div key={i} className="form-grid">
              <Field label="Name">
                <input value={r.name} maxLength={200} onChange={(e) => update(i, { name: e.target.value })} />
              </Field>
              <Field label="Relationship">
                <input value={r.relationship} maxLength={32} onChange={(e) => update(i, { relationship: e.target.value })} />
              </Field>
              <Field label="Share (%)">
                <input type="number" min={1} max={100} value={r.sharePct} onChange={(e) => update(i, { sharePct: Number(e.target.value) })} />
              </Field>
              <Field label="Date of birth (optional)">
                <input type="date" value={r.dateOfBirth ?? ""} max={todayISO()} onChange={(e) => update(i, { dateOfBirth: e.target.value || undefined })} />
              </Field>
            </div>
          ))}
          <button type="button" className="quiet-link" onClick={() => setRows((list) => [...list, { nominationFor: editing ?? "", name: "", relationship: "", sharePct: 0 }])}>
            Add another nominee
          </button>
          <p className="note">Leave every name empty and save to remove this nomination.</p>
          {error && <Banner message={{ tone: "err", text: error }} />}
          <div className="dialog-actions">
            <button type="button" className="btn-ghost" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <SubmitButton action={saveAct} className="btn" disabled={!editing?.trim()}>
              Save
            </SubmitButton>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}

function ChangeRequestButton({ onSend }: { onSend: (note: string) => RewardOutcome }) {
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
      <ActionButton
        className="btn btn-tiny"
        disabled={note.trim().length < 5}
        onAction={async () => {
          const error = await onSend(note);
          if (!error) setOpen(false);
          return error;
        }}
      >
        Send
      </ActionButton>
    </span>
  );
}

export function BenefitsPage() {
  const { demoProfile, employee, demoAccounts, payslipViews } = usePortal();
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
  // Backend mode loads the window after the first render; keep the date fields in step with it.
  useEffect(() => {
    setWinStart(reward.openEnrollment.start);
    setWinEnd(reward.openEnrollment.end);
  }, [reward.openEnrollment.start, reward.openEnrollment.end]);
  const datesAct = useAction();
  const eventAct = useAction();

  const isBenefitsAdmin = canAdminBenefits(demoProfile);
  const canSeeOthers = isBenefitsAdmin;

  // Everyone can browse another country's plans (default: your own); enrolling stays within your own country.
  // HR also sees everyone's enrollments, dependents and history for the chosen country.
  const ownCountry = employee.countryName ?? "";
  const [hrCountry, setHrCountry] = useState(ownCountry);
  const country = hrCountry;
  const [entity, setEntity] = useState("");
  const [planQuery, setPlanQuery] = useState("");
  const [planType, setPlanType] = useState("");
  const [enrollQuery, setEnrollQuery] = useState("");
  const [enrollStatus, setEnrollStatus] = useState("");
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyEvent, setHistoryEvent] = useState("");
  const [docTitle, setDocTitle] = useState("");
  const [docFile, setDocFile] = useState<File | null>(null);
  const [docKey, setDocKey] = useState(0);

  const countryOf = (employeeId: string) =>
    demoAccounts.find((a) => a.id === employeeId)?.countryName ??
    reward.enrollments.find((e) => e.employeeId === employeeId)?.country ??
    "";
  const inScope = (employeeId: string) =>
    canSeeOthers ? !country || countryOf(employeeId) === country : employeeId === employee.id;
  const nameOf = (employeeId: string) => demoAccounts.find((a) => a.id === employeeId)?.fullName ?? employeeId;

  const allPlans = benefitPlans(reward);
  const countryPlans = allPlans.filter((p) => !country || p.country === country);
  const entities = [...new Set([...countryPlans.map((p) => p.legalEntity).filter((e): e is string => Boolean(e)), ...(country === ownCountry && employee.legalEntity ? [employee.legalEntity] : [])])];
  const needle = planQuery.trim().toLowerCase();
  const plans = countryPlans.filter(
    (p) =>
      (!entity || !p.legalEntity || p.legalEntity === entity) &&
      (!planType || p.category === planType) &&
      (!needle || [p.name, p.provider, p.category, p.summary, p.coverage ?? ""].some((t) => t.toLowerCase().includes(needle))),
  );
  const selectedPlan = plans.find((p) => p.id === planId) ?? plans[0];

  // Plans paid through payroll (PF, 401(k), pension, super): this month's amounts from your latest payslip.
  const latestSlip = payslipViews[0] ? asDetailView(payslipViews[0]) : null;
  function payslipAmounts(planIdToCheck: string, planCountry: string): string | null {
    const map = PLAN_PAY_LINES[planIdToCheck];
    if (!map || !latestSlip || planCountry !== ownCountry) return null;
    const pick = (lines: { name: string; amount: number }[], names: string[]) =>
      lines.filter((l) => names.includes(l.name)).reduce((acc, l) => acc + l.amount, 0);
    const you = pick(latestSlip.deductions, map.employee);
    const company = pick(latestSlip.employerContributions, map.employer);
    if (!you && !company) return null;
    const c = latestSlip.currency;
    return [you ? `You ${money(you, c)}` : "", company ? `company ${money(company, c)}` : ""].filter(Boolean).join(" · ") + " a month";
  }

  // HR's own pending requests go to their line manager, who sees just those rows.
  const decidesFor = (employeeId: string) =>
    !isBenefitsAdmin && (API_ENABLED ? employeeId !== employee.id : canDecideBenefitFor(demoProfile, employeeId));
  const enrollments = reward.enrollments.filter((e) =>
    canSeeOthers
      ? !country || e.country === country
      : e.employeeId === employee.id || (e.status === "Pending" && decidesFor(e.employeeId)),
  );
  const myPlanIds = new Set(reward.enrollments.filter((e) => e.employeeId === employee.id && e.status !== "Waived" && e.status !== "Cancelled").map((e) => e.planId));
  const myEnrollments = reward.enrollments.filter((e) => e.employeeId === employee.id);
  const enrollNeedle = enrollQuery.trim().toLowerCase();
  const enrollmentsShown = enrollments.filter(
    (e) => (!enrollStatus || e.status === enrollStatus) && (!enrollNeedle || `${e.employeeName} ${e.planName}`.toLowerCase().includes(enrollNeedle)),
  );
  const availablePlans = allPlans.filter((p) => p.country === ownCountry && !myPlanIds.has(p.id) && !p.mandatory);
  const changeRequests = reward.changeRequests.filter((c) =>
    canSeeOthers ? inScope(c.employeeId) : c.employeeId === employee.id || (c.status === "Pending" && decidesFor(c.employeeId)),
  );

  const myDependents = reward.dependents.filter((d) => d.employeeId === employee.id);
  const dependents = reward.dependents.filter(
    (d) => inScope(d.employeeId) || (d.verification === "Pending" && decidesFor(d.employeeId)),
  );
  const historyAll = reward.benefitHistory.filter((h) => (API_ENABLED ? true : inScope(h.employeeId)));
  const historyNeedle = historyQuery.trim().toLowerCase();
  const history = historyAll.filter(
    (h) => (!historyEvent || h.event === historyEvent) && (!historyNeedle || `${h.event} ${h.detail} ${nameOf(h.employeeId)}`.toLowerCase().includes(historyNeedle)),
  );
  const lifeEvents = reward.lifeEvents.filter((e) =>
    canSeeOthers ? inScope(e.employeeId) : e.employeeId === employee.id || decidesFor(e.employeeId),
  );
  const changeWin = changeWindowFor(reward, employee.id);
  const myEvent = activeLifeEvent(reward, employee.id);
  const oe = reward.openEnrollment;
  const oeOpen = openEnrollmentIsOpen(oe);
  const activeMine = myEnrollments.filter((e) => e.status === "Enrolled");
  const companyCost = activeMine.reduce((acc, e) => {
    const p = allPlans.find((x) => x.id === e.planId);
    if (p?.employerAnnualCost) acc.set(p.currency ?? "", (acc.get(p.currency ?? "") ?? 0) + p.employerAnnualCost);
    return acc;
  }, new Map<string, number>());
  const daysLeft = oe.end ? Math.round((parseISODate(oe.end).getTime() - parseISODate(todayISO()).getTime()) / 86_400_000) : null;
  const coveredBy = (planName: string, employeeId: string) =>
    reward.dependents.filter((d) => d.employeeId === employeeId && d.coveredPlans.includes(planName)).map((d) => d.name);

  async function run(outcome: RewardOutcome, okText: string): Promise<string | null> {
    const error = await outcome;
    setMsg(error ? { tone: "err", text: error } : { tone: "ok", text: okText });
    if (!error) notify(okText);
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

  async function join(planIdToJoin: string) {
    const plan = allPlans.find((p) => p.id === planIdToJoin);
    if (!plan) return false;
    if (!changeWin.open) {
      setMsg({ tone: "err", text: changeWin.text });
      return false;
    }
    const err = await run(requestEnrollment(demoProfile, plan.id), "Enrollment request sent to HR.");
    if (!err && plan.coversDependents && myDependents.length) setCover({ planId: plan.id, planName: plan.name });
    return err;
  }

  function eligibilityCell(planIdToCheck: string): ReactNode {
    const plan = allPlans.find((p) => p.id === planIdToCheck);
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
      const plan = allPlans.find((p) => p.id === e.planId);
      const coverBtn =
        plan?.coversDependents && (e.status === "Enrolled" || e.status === "Pending") ? (
          <button type="button" className="quiet-link" onClick={() => inWindow(() => setCover({ planId: e.planId, planName: e.planName }))}>
            Dependents
          </button>
        ) : null;
      const cancelBtn = (label: string) => (
        <ActionButton className="quiet-link" busyLabel="Cancelling…" doneLabel="Cancelled" onAction={() => run(cancelEnrollment(demoProfile, e.id), `${e.planName}: ${label.toLowerCase()} done.`)}>
          {label}
        </ActionButton>
      );
      if (e.status === "Pending") return <span className="reward-actions"><span className="muted">Awaiting HR</span>{coverBtn}{cancelBtn("Withdraw request")}</span>;
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
        } else if (API_ENABLED) main = null;
        else main = <ChangeRequestButton onSend={(note) => run(requestEnrollmentChange(demoProfile, e.id, note), "Change request sent to HR.")} />;
        return (
          <span className="reward-actions">
            {main}
            {coverBtn}
            {!mandatory && (changeWin.open ? cancelBtn("Cancel enrollment") : null)}
          </span>
        );
      }
      return (
        <ActionButton className="quiet-link" onAction={() => join(e.planId)}>
          Request enrollment
        </ActionButton>
      );
    }
    if (canDecideEnrollmentRow(demoProfile, e)) {
      return (
        <span className="reward-actions">
          <ActionButton className="btn" onAction={() => run(decideEnrollment(demoProfile, e.id, "Enrolled"), `${e.employeeName} enrolled in ${e.planName}.`)}>
            Enroll
          </ActionButton>
          {!mandatory && (
            <ActionButton className="btn-ghost" busyLabel="Updating…" doneLabel="Waived" onAction={() => run(decideEnrollment(demoProfile, e.id, "Waived"), `${e.employeeName} waived ${e.planName}.`)}>
              Waive
            </ActionButton>
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
          <label className="quiet-link" style={{ cursor: "pointer" }}>
            {d.docName ? "Replace proof" : "Upload proof"}
            <input
              type="file"
              accept="application/pdf,image/png,image/jpeg,image/gif,image/webp"
              style={{ display: "none" }}
              onChange={(ev) => {
                const f = ev.target.files?.[0];
                ev.target.value = "";
                if (f) void run(uploadDependentDoc(demoProfile, d.id, f), `Proof uploaded for ${d.name}.`);
              }}
            />
          </label>
          <button type="button" className="quiet-link" onClick={() => setDepDialog(d)}>
            Edit
          </button>
          <ActionButton className="quiet-link" onAction={() => run(removeDependent(demoProfile, d.id), `${d.name} removed.`)}>
            Remove
          </ActionButton>
        </span>
      );
    }
    if (canVerifyDependentRow(demoProfile, d)) {
      return (
        <span className="reward-actions">
          <ActionButton className="btn" busyLabel="Verifying…" doneLabel="Verified" onAction={() => run(verifyDependent(demoProfile, d.id, "Verified"), `${d.name} verified.`)}>
            Verify
          </ActionButton>
          {d.verification !== "Rejected" && (
            <ActionButton className="btn-ghost" onAction={() => run(verifyDependent(demoProfile, d.id, "Rejected"), `${d.name} rejected.`)}>
              Reject
            </ActionButton>
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
          <select
            value={hrCountry}
            onChange={(e) => {
              setHrCountry(e.target.value);
              setEntity("");
              setPlanId("");
            }}
          >
            {canSeeOthers && <option value="">All countries</option>}
            {[...new Set([ownCountry, ...allPlans.map((p) => p.country)].filter(Boolean))].map((c) => (
              <option key={c} value={c}>
                {c}
                {c === ownCountry ? " (yours)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-label">
          Legal entity
          <select value={entity} onChange={(e) => setEntity(e.target.value)}>
            <option value="">All entities</option>
            {entities.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>
      </FilterBar>
      {country && country !== ownCountry && (
        <Banner message={{ tone: "info", text: `Showing ${country} plans for reference. You can enroll only in plans for ${ownCountry || "your own country"}.` }} />
      )}

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
        <Card title="Your coverage">
          <MetricGrid>
            <MetricCard label="Plans you're in" value={activeMine.length} hint={activeMine.map((e) => e.planName).join(", ") || "None yet"} />
            <MetricCard label="Requests with HR" value={myEnrollments.filter((e) => e.status === "Pending").length} />
            <MetricCard label="Dependents covered" value={myDependents.filter((d) => d.coveredPlans.length > 0).length} hint={`${myDependents.length} on file`} />
            <MetricCard
              label="Company pays a year"
              value={companyCost.size ? [...companyCost].map(([cur, amt]) => money(amt, cur || undefined)).join(" + ") : "—"}
              hint="Employer contribution for your plans"
            />
            <MetricCard
              label="Enrollment window"
              value={oeOpen ? "Open" : "Closed"}
              hint={oeOpen && daysLeft != null && daysLeft >= 0 ? `Closes ${formatShortDate(oe.end)} (${daysLeft} day${daysLeft === 1 ? "" : "s"} left)` : openEnrollmentLabel(oe)}
            />
          </MetricGrid>
          {oeOpen && daysLeft != null && daysLeft >= 0 && daysLeft <= 7 && (
            <Banner message={{ tone: "warn", text: `Open enrollment closes in ${daysLeft} day${daysLeft === 1 ? "" : "s"}. Review your plans and dependents.` }} />
          )}
        </Card>
      )}
      {tab === "plans" && (
        <Card title="My plans" action={myEnrollments.length ? <span className="muted">{activeMine.length} active</span> : undefined}>
          <DataTable
            headers={["Plan", "Status", "Effective", "Dependents covered"]}
            rows={myEnrollments.map((e) => [
              <button key={e.id} type="button" className="quiet-link" onClick={() => setPlanId(e.planId)}>
                {e.planName}
              </button>,
              <StatusBadge key={`${e.id}-s`} status={e.status} literal />,
              e.effective || "—",
              coveredBy(e.planName, e.employeeId).join(", ") || "—",
            ])}
            empty={<EmptyState title="No plans yet" description="Plans you join show here with their status." />}
          />
        </Card>
      )}
      {tab === "plans" && (
        <div className="mgr-home-grid">
          <Card title={`Benefit plans · ${country || "All countries"}`}>
            <div className="form-actions" style={{ justifyContent: "flex-start", flexWrap: "wrap", marginTop: 0 }}>
              <label className="filter-label">
                Search
                <input type="search" value={planQuery} placeholder="Plan, provider or cover" onChange={(e) => setPlanQuery(e.target.value)} />
              </label>
              <label className="filter-label">
                Type
                <select value={planType} onChange={(e) => setPlanType(e.target.value)}>
                  <option value="">All types</option>
                  {[...new Set(countryPlans.map((p) => p.category))].map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <DataTable
              headers={["Plan", "Category", "Provider", "Employee cost", "Your eligibility", ""]}
              rows={plans.map((p) => [
                <>
                  {p.name}{" "}
                  {p.mandatory ? <span className="reward-tag">Mandatory</span> : p.autoEnrolled ? <span className="reward-tag">Automatic</span> : null}
                </>,
                p.category,
                p.provider,
                <>
                  {p.employeeCost}
                  {payslipAmounts(p.id, p.country) && <div className="note">{payslipAmounts(p.id, p.country)}</div>}
                </>,
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
              <dl className="info-grid">
                <div className="info-fact"><dt>Provider</dt><dd>{selectedPlan.provider}</dd></div>
                <div className="info-fact"><dt>Type</dt><dd>{selectedPlan.category}</dd></div>
                <div className="info-fact"><dt>Country · entity</dt><dd>{selectedPlan.country} · {selectedPlan.legalEntity ?? "all entities"}</dd></div>
                <div className="info-fact"><dt>Employee contribution</dt><dd>{selectedPlan.employeeCost || "—"}</dd></div>
                <div className="info-fact">
                  <dt>Employer contribution</dt>
                  <dd>{selectedPlan.employerAnnualCost ? `${money(selectedPlan.employerAnnualCost, selectedPlan.currency)} a year per member` : "—"}</dd>
                </div>
                <div className="info-fact"><dt>Dependents</dt><dd>{selectedPlan.coversDependents ? "Can be covered" : "Employee only"}</dd></div>
              </dl>
              {selectedPlan.coverage && (
                <>
                  <h3 style={{ fontSize: 14, marginTop: 12 }}>Coverage</h3>
                  <p>{selectedPlan.coverage}</p>
                </>
              )}
              {selectedPlan.terms && (
                <>
                  <h3 style={{ fontSize: 14, marginTop: 12 }}>Terms</h3>
                  <p className="note">{selectedPlan.terms}</p>
                </>
              )}
              {payslipAmounts(selectedPlan.id, selectedPlan.country) && (
                <p className="note">
                  On your {latestSlip?.label} payslip: {payslipAmounts(selectedPlan.id, selectedPlan.country)}.{" "}
                  <Link to="/payslips">Payslips</Link>
                </p>
              )}
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
              <h3 style={{ fontSize: 14, marginTop: 12 }}>Policy documents</h3>
              <ul className="todo">
                <li>
                  Plan summary (PDF){" "}
                  <ActionButton className="quiet-link" busyLabel="Preparing…" doneLabel="Downloaded" onAction={() => downloadPlanSummary(selectedPlan)} success={`${selectedPlan.name} summary downloaded.`} toastError>
                    Download
                  </ActionButton>
                </li>
                {(selectedPlan.files ?? []).map((f) => (
                  <li key={f.id}>
                    {f.title} <span className="muted">· {f.fileName}</span>{" "}
                    <ActionButton className="quiet-link" busyLabel="Downloading…" doneLabel="Downloaded" onAction={() => downloadPlanFile(selectedPlan, f)} toastError>
                      Download
                    </ActionButton>
                  </li>
                ))}
              </ul>
              {API_ENABLED && isBenefitsAdmin && (
                <form
                  className="form-actions"
                  style={{ justifyContent: "flex-start", flexWrap: "wrap" }}
                  onSubmit={(ev) => {
                    ev.preventDefault();
                    if (!docFile) {
                      setMsg({ tone: "err", text: "Choose a PDF to upload." });
                      return;
                    }
                    void run(uploadPlanFile(selectedPlan, docTitle, docFile), `${docTitle.trim()} added to ${selectedPlan.name}.`).then((e) => {
                      if (!e) {
                        setDocTitle("");
                        setDocFile(null);
                        setDocKey((k) => k + 1);
                      }
                    });
                  }}
                >
                  <input aria-label="Document title" placeholder="Document title, e.g. Policy wording" value={docTitle} maxLength={200} onChange={(ev) => setDocTitle(ev.target.value)} />
                  <input key={docKey} aria-label="Policy file" type="file" accept="application/pdf,image/png,image/jpeg" onChange={(ev) => setDocFile(ev.target.files?.[0] ?? null)} />
                  <button className="btn-ghost" type="submit">
                    Upload policy document
                  </button>
                </form>
              )}
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
                    <ActionButton className="btn-ghost" busyLabel="Closing…" doneLabel="Closed" onAction={() => run(setOpenEnrollmentOverride(demoProfile, "closed"), "Open enrollment closed.")}>
                      Close now
                    </ActionButton>
                  ) : (
                    <ActionButton className="btn-ghost" busyLabel="Opening…" doneLabel="Opened" onAction={() => run(setOpenEnrollmentOverride(demoProfile, "open"), "Open enrollment opened.")}>
                      Open now
                    </ActionButton>
                  )}
                  {oe.override && (
                    <ActionButton className="btn-ghost" busyLabel="Updating…" onAction={() => run(setOpenEnrollmentOverride(demoProfile, null), "Window follows its dates again.")}>
                      Use dates
                    </ActionButton>
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
                onSubmit={datesAct.submit(() => run(setOpenEnrollmentDates(demoProfile, winStart, winEnd), "Enrollment dates saved."))}
              >
                <label className="filter-label">
                  Start
                  <input type="date" value={winStart} onChange={(ev) => setWinStart(ev.target.value)} />
                </label>
                <label className="filter-label">
                  End
                  <input type="date" value={winEnd} onChange={(ev) => setWinEnd(ev.target.value)} />
                </label>
                <SubmitButton action={datesAct} className="btn-ghost">
                  Save dates
                </SubmitButton>
              </form>
            )}
          </Card>

          <Card title="Life events">
            {myEvent ? (
              <p className="note">Your {myEvent.type.toLowerCase()} window is open until {formatShortDate(myEvent.windowEnds)}.</p>
            ) : (
              <form
                className="form-actions"
                onSubmit={eventAct.submit(() => run(raiseLifeEvent(demoProfile, eventType, eventDate), `${eventType} reported. You can change benefits for 30 days.`))}
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
                <SubmitButton action={eventAct} className="btn" busyLabel="Reporting…" doneLabel="Reported">
                  Report event
                </SubmitButton>
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
                    live && canCloseLifeEventRow(demoProfile, le) ? (
                      <ActionButton key={`${le.id}-a`} className="btn-ghost" busyLabel="Closing…" doneLabel="Closed" onAction={() => run(closeLifeEvent(demoProfile, le.id), "Life event window closed.")}>
                        Close window
                      </ActionButton>
                    ) : (
                      le.closedBy ? `Closed by ${le.closedBy}` : "—"
                    ),
                  ];
                })}
              />
            )}
          </Card>

          <Card title="Enrollment status">
            <div className="form-actions" style={{ justifyContent: "flex-start", flexWrap: "wrap", marginTop: 0 }}>
              <label className="filter-label">
                Search
                <input type="search" value={enrollQuery} placeholder={canSeeOthers ? "Employee or plan" : "Plan"} onChange={(e) => setEnrollQuery(e.target.value)} />
              </label>
              <label className="filter-label">
                Status
                <select value={enrollStatus} onChange={(e) => setEnrollStatus(e.target.value)}>
                  <option value="">Any status</option>
                  {["Pending", "Enrolled", "Waived", "Cancelled"].map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <DataTable
              headers={["Employee", "Plan", "Country", "Status", "Effective", "Dependents", "Action"]}
              rows={enrollmentsShown.map((e) => [
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
                      <ActionButton className="btn" busyLabel="Updating…" doneLabel="Done" onAction={() => run(decideChangeRequest(demoProfile, c.id, "Done"), "Change marked done.")}>
                        Done
                      </ActionButton>
                      <ActionButton className="btn-ghost" onAction={() => run(decideChangeRequest(demoProfile, c.id, "Declined"), "Change declined.")}>
                        Decline
                      </ActionButton>
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
                      <ActionButton key={p.id} className="quiet-link" onAction={() => join(p.id)}>
                        Request enrollment
                      </ActionButton>
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
            headers={[...(canSeeOthers ? ["Employee"] : []), "Name", "Relationship", "Date of birth", "Gender", "Covered plans", "Can be covered", "Proof", "Verification", "Action"]}
            rows={dependents.map((d) => [
              ...(canSeeOthers ? [nameOf(d.employeeId)] : []),
              d.name,
              d.relationship,
              <MaskedValue
                key={`${d.id}-dob`}
                value={d.dateOfBirth}
                kind="dob"
                canReveal={d.employeeId === employee.id || isRevealRole(demoProfile.role)}
                format={(dob) => (isMasked(dob) ? dob : formatShortDate(dob))}
              />,
              d.gender ?? "—",
              d.coveredPlans.join(", ") || "—",
              (() => {
                const cov = dependentCover(d);
                return cov.eligible ? (
                  <StatusBadge key={`${d.id}-c`} status="Eligible" tone="ok" literal />
                ) : (
                  <span key={`${d.id}-c`} className="muted">No – {cov.note}</span>
                );
              })(),
              d.docName ? (
                <ActionButton key={`${d.id}-p`} className="quiet-link" busyLabel="Downloading…" doneLabel="Downloaded" onAction={() => downloadDependentDoc(d)} toastError>
                  {d.docName}
                </ActionButton>
              ) : (
                <span key={`${d.id}-p`} className="muted">None</span>
              ),
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
          <p className="note">HR verifies dependents (with a proof of relationship) before they're covered. Children are covered until age 25.</p>
        </Card>
      )}
      {tab === "dependents" && reward.api?.benefits && (
        <NomineesCard nominees={reward.api.benefits.nominees} onSaved={(text) => setMsg({ tone: "ok", text })} />
      )}

      {tab === "history" && (
        <Card title="Benefit history">
          <div className="form-actions" style={{ justifyContent: "flex-start", flexWrap: "wrap", marginTop: 0 }}>
            <label className="filter-label">
              Search
              <input type="search" value={historyQuery} placeholder="Plan, dependent or event" onChange={(e) => setHistoryQuery(e.target.value)} />
            </label>
            <label className="filter-label">
              Event
              <select value={historyEvent} onChange={(e) => setHistoryEvent(e.target.value)}>
                <option value="">All events</option>
                {[...new Set(historyAll.map((h) => h.event))].map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            </label>
          </div>
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

/**
 * Documents & letters: the document repository (both modes: src/features/documents/DocumentRepository.tsx) and the
 * letter panels (src/pages/LettersPanel.tsx).
 */
export function DocumentsLettersPage() {
  const { demoProfile, employee, state } = usePortal();
  const [tab, setTab] = useState("library");
  const [openLetter, setOpenLetter] = useState<OpenLetter>(null);
  const portalDocs = state.documents.filter((d) => d.employeeId === employee.id);

  return (
    <Page title="Documents & letters">
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

      {tab === "library" && <DocumentRepository actor={demoProfile} />}

      {tab === "letters" && <LetterRequestsPanel actor={demoProfile} onOpen={setOpenLetter} />}

      {tab === "history" && <LetterHistoryPanel actor={demoProfile} onOpen={setOpenLetter} />}

      {tab === "personal" && (
        <>
          <MyLettersPanel actor={demoProfile} onOpen={setOpenLetter} />
          {portalDocs.length > 0 && (
            <Card title="My ESS documents">
              <DataTable
                headers={["Name", "Category", "Type", "Expires"]}
                rows={portalDocs.map((d) => [d.name, d.category, d.docType, d.expires || "None"])}
              />
            </Card>
          )}
          <Card title="My documents">
            <button type="button" className="btn-ghost" onClick={() => setTab("library")}>
              Open my document library
            </button>
          </Card>
        </>
      )}

      <LetterViewerDialog actor={demoProfile} open={openLetter} onClose={() => setOpenLetter(null)} />
    </Page>
  );
}

/** Route alias used by App `/documents` */
export function DocumentsPage() {
  return <DocumentsLettersPage />;
}
