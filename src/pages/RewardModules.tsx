import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { API_ENABLED } from "../api/client.ts";
import {
  apiSetDocumentExpiry,
  apiSetNominees,
  apiUploadDocument,
  apiUploadVersion,
  apiWithdrawProposal,
  checkDocFile,
  downloadDocument,
  fetchDocRules,
  fetchDocument,
  fetchDocuments,
  fetchExpiringDocuments,
  fetchStatement,
  type CompStatementOut,
  type DocRules,
  type Nominee,
  type RepoDocument,
} from "../api/syncRewards.ts";
import { listPeople, subscribePeople } from "../data/peopleLocal.ts";import {
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
import { stepRoles, roleLabel, useApprovalWorkflows, type ApprovalStep } from "../data/approvalWorkflows.ts";
import { LEGAL_DISCLAIMER, LIFE_EVENT_TYPES, type Dependent, type GradeBand } from "../data/rewardData.ts";
import {
  UPLOAD_EXTENSIONS,
  activeLifeEvent,
  addLibraryDoc,
  benefitPlans,
  canAdminBenefits,
  canCloseLifeEventRow,
  canDecideBenefitFor,
  canDecideCompReview,
  canDecideEnrollmentRow,
  canVerifyDependentRow,
  formatAmount,
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
  validateUpload,
  verifyDependent,
} from "../data/rewardLocal.ts";
import { BandDialog, BonusDialog, CoverDialog, DependentDialog, NewCycleDialog, ProposeDialog } from "./RewardDialogs.tsx";
import { formatShortDate, todayISO, type DocumentGroup } from "../model.ts";
import { MaskedValue } from "../components/MaskedValue.tsx";
import { isRevealRole } from "../data/piiReveal.ts";
import { isMasked } from "../utils/mask.ts";
import { usePortal } from "../store.tsx";
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
  const tabs = [
    ...(showStructures ? [{ id: "structures", label: "Structures & ranges" }] : []),
    { id: "history", label: compTeam ? "Compensation history" : "My pay history" },
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
                } else if (API_ENABLED && r.managerId === me.id && r.status === "Pending approval" && !r.statusLabel) {
                  action = (
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => report(runRewardApi(apiWithdrawProposal(r.id), ["comp"]), `${r.employeeName}: proposal withdrawn.`)}
                    >
                      Withdraw
                    </button>
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

      {tab === "statement" && API_ENABLED && <TotalRewardsCard />}

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

/** Backend mode: the signed-in employee's total rewards statement for a year. */
function TotalRewardsCard() {
  const thisYear = Number(todayISO().slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [data, setData] = useState<CompStatementOut | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setData(undefined);
    void fetchStatement(year).then((out) => {
      if (live) setData(out);
    });
    return () => {
      live = false;
    };
  }, [year]);
  const cur = data?.currency ?? "INR";
  return (
    <Card
      title="Total rewards statement"
      action={
        <label className="filter-label">
          Year
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {[thisYear, thisYear - 1, thisYear - 2].map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </label>
      }
    >
      {data === undefined ? (
        <p className="note">Loading…</p>
      ) : data === null ? (
        <EmptyState title="No statement" description="Nothing to show for this year." />
      ) : (
        <>
          <MetricGrid>
            <MetricCard label="Base salary" value={formatAmount(data.base_salary, cur)} hint={data.grade ? `Grade ${data.grade}` : undefined} />
            <MetricCard label="Bonuses" value={formatAmount(data.bonus_total, cur)} />
            <MetricCard label="Benefits (employer cost)" value={formatAmount(data.benefits_employer_cost, cur)} />
            <MetricCard label="Total rewards" value={formatAmount(data.total_rewards, cur)} />
          </MetricGrid>
          <DataTable
            headers={["Item", "Type", "Annual value"]}
            rows={[
              ["Base salary", data.base_effective_date ? `Since ${formatShortDate(data.base_effective_date)}` : "Base", formatAmount(data.base_salary, cur)],
              ...data.bonuses.map((b) => [b.bonus_type, `Bonus · ${b.period}`, formatAmount(b.amount, b.currency)]),
              ...data.benefits.map((b) => [b.plan_name, `Benefit · ${b.plan_type}`, formatAmount(b.employer_annual_cost, b.currency)]),
            ]}
          />
          <p className="note">Benefits are shown at what the company pays for them each year.</p>
        </>
      )}
    </Card>
  );
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
  const [busy, setBusy] = useState(false);

  function start(purpose: string) {
    setEditing(purpose);
    setError(null);
    const current = nominees.filter((n) => n.nominationFor === purpose);
    setRows(current.length ? current.map((n) => ({ ...n })) : [{ nominationFor: purpose, name: "", relationship: "", sharePct: 100 }]);
  }

  async function save() {
    if (!editing) return;
    const filled = rows.filter((r) => r.name.trim());
    const total = filled.reduce((sum, r) => sum + (Number(r.sharePct) || 0), 0);
    if (filled.length && Math.round(total) !== 100) return setError(`Shares add up to ${total}%. They must total 100%.`);
    setBusy(true);
    const err = await runRewardApi(apiSetNominees(editing, filled), ["benefits"]);
    setBusy(false);
    if (err) return setError(err);
    setEditing(null);
    onSaved(`Nominees for ${editing} saved.`);
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
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
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
            <button type="submit" className="btn" disabled={busy || !editing?.trim()}>
              {busy ? "Saving…" : "Save"}
            </button>
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
      <button type="button" className="btn btn-tiny" disabled={note.trim().length < 5} onClick={async () => !(await onSend(note)) && setOpen(false)}>
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
  // Backend mode loads the window after the first render; keep the date fields in step with it.
  useEffect(() => {
    setWinStart(reward.openEnrollment.start);
    setWinEnd(reward.openEnrollment.end);
  }, [reward.openEnrollment.start, reward.openEnrollment.end]);

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

  const allPlans = benefitPlans(reward);
  const plans = allPlans.filter((p) => (canSeeOthers ? !country || p.country === country : p.country === ownCountry));
  const selectedPlan = plans.find((p) => p.id === planId) ?? plans[0];

  // HR's own pending requests go to their line manager, who sees just those rows.
  const decidesFor = (employeeId: string) =>
    !isBenefitsAdmin && (API_ENABLED ? employeeId !== employee.id : canDecideBenefitFor(demoProfile, employeeId));
  const enrollments = reward.enrollments.filter((e) =>
    canSeeOthers
      ? !country || e.country === country
      : e.employeeId === employee.id || (e.status === "Pending" && decidesFor(e.employeeId)),
  );
  const myPlanIds = new Set(reward.enrollments.filter((e) => e.employeeId === employee.id && e.status !== "Waived").map((e) => e.planId));
  const availablePlans = allPlans.filter((p) => p.country === ownCountry && !myPlanIds.has(p.id) && !p.mandatory);
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

  async function run(outcome: RewardOutcome, okText: string): Promise<string | null> {
    const error = await outcome;
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
    const plan = allPlans.find((p) => p.id === planIdToJoin);
    if (!plan) return;
    inWindow(async () => {
      const err = await run(requestEnrollment(demoProfile, plan.id), "Enrollment request sent to HR.");
      if (!err && plan.coversDependents && myDependents.length) setCover({ planId: plan.id, planName: plan.name });
    });
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
        } else if (API_ENABLED) main = <span className="muted">Ask HR to change</span>;
        else main = <ChangeRequestButton onSend={(note) => run(requestEnrollmentChange(demoProfile, e.id, note), "Change request sent to HR.")} />;
        return <span className="reward-actions">{main}{coverBtn}</span>;
      }
      return (
        <button type="button" className="quiet-link" onClick={() => join(e.planId)}>
          Request enrollment
        </button>
      );
    }
    if (canDecideEnrollmentRow(demoProfile, e)) {
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
    if (canVerifyDependentRow(demoProfile, d)) {
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
              {[...new Set(allPlans.map((p) => p.country))].map((c) => (
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
                    live && canCloseLifeEventRow(demoProfile, le) ? (
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
              <MaskedValue
                key={`${d.id}-dob`}
                value={d.dateOfBirth}
                kind="dob"
                canReveal={d.employeeId === employee.id || isRevealRole(demoProfile.role)}
                format={(dob) => (isMasked(dob) ? dob : formatShortDate(dob))}
              />,
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
          <p className="note">HR verifies dependents before they're covered.</p>
        </Card>
      )}
      {tab === "dependents" && reward.api?.benefits && (
        <NomineesCard nominees={reward.api.benefits.nominees} onSaved={(text) => setMsg({ tone: "ok", text })} />
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

const KB = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

function expiryText(d: RepoDocument): ReactNode {
  if (!d.expiryDate) return "None";
  const days = d.daysToExpiry;
  const tone = days !== undefined && days < 0 ? "danger" : days !== undefined && days <= 30 ? "warn" : "neutral";
  const label = days === undefined ? "" : days < 0 ? ` · expired ${-days}d ago` : days === 0 ? " · today" : ` · ${days}d`;
  return tone === "neutral" ? (
    formatShortDate(d.expiryDate)
  ) : (
    <StatusBadge key={`${d.id}-x`} status={`${formatShortDate(d.expiryDate)}${label}`} tone={tone} literal />
  );
}

/** Backend mode: the document repository (uploads up to the server's size limit, versions, expiry, download). */
function ApiDocumentsLibrary({ actor }: { actor: { id: string; fullName: string; role: string } }) {
  const people = useSyncExternalStore(subscribePeople, listPeople, listPeople);
  const hr = canManageLetters(actor as Parameters<typeof canManageLetters>[0]);
  const [ownerId, setOwnerId] = useState(actor.id);
  const [category, setCategory] = useState("");
  const [rules, setRules] = useState<DocRules | null>(null);
  const [docs, setDocs] = useState<RepoDocument[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expiring, setExpiring] = useState<RepoDocument[]>([]);
  const [selected, setSelected] = useState<RepoDocument | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [upload, setUpload] = useState<{ docId?: string; title?: string } | null>(null);
  const [tick, setTick] = useState(0);
  const reload = () => setTick((n) => n + 1);

  useEffect(() => {
    void fetchDocRules().then(setRules);
  }, []);
  useEffect(() => {
    let live = true;
    setDocs(null);
    void fetchDocuments(ownerId === actor.id ? undefined : ownerId).then(({ data, error }) => {
      if (!live) return;
      setDocs(data);
      setLoadError(error);
    });
    void fetchExpiringDocuments(60).then((rows) => live && setExpiring(rows));
    return () => {
      live = false;
    };
  }, [ownerId, actor.id, tick]);

  async function openDoc(id: string) {
    const full = await fetchDocument(id);
    if (!full) return setMsg({ tone: "err", text: "That document isn't available." });
    setSelected(full);
  }

  async function download(d: RepoDocument, version?: number) {
    const v = d.versions.find((x) => x.version === (version ?? d.currentVersion));
    const err = await downloadDocument(d.id, v?.fileName ?? `${d.title}.pdf`, version);
    if (err) setMsg({ tone: "err", text: err });
  }

  const shown = (docs ?? []).filter((d) => !category || d.category === category);
  // HR picks anyone; managers pick from the people below them (they see manager-visible categories only).
  const pickable = hr ? people : people.filter((p) => p.id === actor.id || isAboveInLine(actor.id, p.id) || p.managerId === actor.id);
  const sortedPeople = [...pickable].sort((a, b) => a.fullName.localeCompare(b.fullName));
  const mine = ownerId === actor.id;

  return (
    <div className="stack">
      <div className="mgr-home-grid">
        <Card
          title="Document repository"
          action={
            mine || hr ? (
              <button type="button" className="btn" onClick={() => setUpload({})}>
                Upload document
              </button>
            ) : undefined
          }
        >
          <FilterBar>
            {sortedPeople.length > 1 && (
              <label className="filter-label">
                Employee
                <select value={ownerId} onChange={(e) => (setOwnerId(e.target.value), setSelected(null))}>
                  {!sortedPeople.some((p) => p.id === actor.id) && <option value={actor.id}>{actor.fullName}</option>}
                  {sortedPeople.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.id === actor.id ? `${p.fullName} (you)` : p.fullName}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="filter-label">
              Category
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">All</option>
                {(rules?.categories ?? []).map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>
          </FilterBar>
          <Banner message={msg} />
          {loadError && <Banner message={{ tone: "err", text: loadError }} />}
          <DataTable
            headers={["Document", "Category", "Version", "Expires", "Updated", ""]}
            rows={shown.map((d) => [
              d.title,
              d.category,
              `v${d.currentVersion}`,
              expiryText(d),
              d.updatedOn,
              <span key={d.id} className="reward-actions">
                <button type="button" className="quiet-link" onClick={() => void openDoc(d.id)}>
                  Details
                </button>
                <button type="button" className="quiet-link" onClick={() => void download(d)}>
                  Download
                </button>
              </span>,
            ])}
            empty={docs === null ? <p className="note">Loading…</p> : <EmptyState title="No documents" description="Upload a document or pick another category." />}
          />
          <p className="note">
            {rules ? `PDF, Word (.docx) or images · up to ${KB(rules.maxBytes)}. ` : ""}Older versions stay available after you upload a new one.
          </p>
        </Card>
        <Card title={selected ? selected.title : "Details"}>
          {!selected ? (
            <EmptyState title="Select a document" />
          ) : (
            <ApiDocumentDetail
              doc={selected}
              canEdit={selected.category !== "Letters" && (selected.employeeId === actor.id || hr)}
              onDownload={(v) => void download(selected, v)}
              onNewVersion={() => setUpload({ docId: selected.id, title: selected.title })}
              onChanged={async (text) => {
                setMsg({ tone: "ok", text });
                reload();
                setSelected(await fetchDocument(selected.id));
              }}
              onError={(text) => setMsg({ tone: "err", text })}
            />
          )}
        </Card>
      </div>
      {expiring.length > 0 && (
        <Card title="Expiring in the next 60 days">
          <DataTable
            headers={["Employee", "Document", "Category", "Expires", ""]}
            rows={expiring.map((d) => [
              d.employeeName,
              d.title,
              d.category,
              expiryText(d),
              <button key={d.id} type="button" className="quiet-link" onClick={() => void download(d)}>
                Download
              </button>,
            ])}
          />
        </Card>
      )}
      {upload && rules && (
        <ApiUploadDialog
          rules={rules}
          documentId={upload.docId}
          title={upload.title}
          employeeId={mine ? undefined : ownerId}
          onClose={() => setUpload(null)}
          onDone={async (text) => {
            const docId = upload.docId;
            setUpload(null);
            setMsg({ tone: "ok", text });
            reload();
            if (docId) setSelected(await fetchDocument(docId));
          }}
        />
      )}
    </div>
  );
}

function ApiDocumentDetail({
  doc,
  canEdit,
  onDownload,
  onNewVersion,
  onChanged,
  onError,
}: {
  doc: RepoDocument;
  canEdit: boolean;
  onDownload: (version?: number) => void;
  onNewVersion: () => void;
  onChanged: (text: string) => void;
  onError: (text: string) => void;
}) {
  const [expiry, setExpiry] = useState(doc.expiryDate ?? "");
  useEffect(() => setExpiry(doc.expiryDate ?? ""), [doc.id, doc.expiryDate]);
  return (
    <div className="stack">
      <dl className="info-grid">
        <div className="info-fact"><dt>Employee</dt><dd>{doc.employeeName}</dd></div>
        <div className="info-fact"><dt>Category</dt><dd>{doc.category}</dd></div>
        <div className="info-fact"><dt>Expires</dt><dd>{expiryText(doc)}</dd></div>
        <div className="info-fact"><dt>Added by</dt><dd>{doc.uploadedBy || "—"}</dd></div>
      </dl>
      <DataTable
        headers={["Version", "File", "Size", "Uploaded", ""]}
        rows={[...doc.versions].reverse().map((v) => [
          v.version === doc.currentVersion ? `v${v.version} (current)` : `v${v.version}`,
          v.fileName,
          KB(v.sizeBytes),
          `${v.on}${v.uploadedBy ? ` · ${v.uploadedBy}` : ""}`,
          <button key={v.id} type="button" className="quiet-link" onClick={() => onDownload(v.version)}>
            Download
          </button>,
        ])}
      />
      {canEdit && (
        <form
          className="form-actions"
          onSubmit={async (e) => {
            e.preventDefault();
            const err = await apiSetDocumentExpiry(doc.id, expiry || null);
            if (err) onError(err);
            else onChanged(expiry ? `Expiry set to ${formatShortDate(expiry)}.` : "Expiry removed.");
          }}
        >
          <label className="filter-label">
            Expiry date
            <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
          </label>
          <button type="submit" className="btn-ghost">
            Save expiry
          </button>
          <button type="button" className="btn" onClick={onNewVersion}>
            Upload new version
          </button>
        </form>
      )}
    </div>
  );
}

function ApiUploadDialog({
  rules,
  documentId,
  title: existingTitle,
  employeeId,
  onClose,
  onDone,
}: {
  rules: DocRules;
  documentId?: string;
  title?: string;
  employeeId?: string;
  onClose: () => void;
  onDone: (text: string) => void;
}) {
  const categories = rules.categories.filter((c) => c !== "Letters");
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState(existingTitle ?? "");
  const [category, setCategory] = useState(categories[0] ?? "Other");
  const [expiry, setExpiry] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function pick(next: File | null) {
    setError(null);
    setFile(next);
    if (!next) return;
    const invalid = checkDocFile(next, rules);
    if (invalid) {
      setError(invalid);
      setFile(null);
      return;
    }
    if (!documentId && !title.trim()) setTitle(next.name.replace(/\.[^.]+$/, ""));
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!file || busy) return;
    setBusy(true);
    const err = documentId
      ? await apiUploadVersion(documentId, file, expiry || undefined)
      : await apiUploadDocument(file, { category, title, employeeId, expiryDate: expiry || undefined });
    setBusy(false);
    if (err) return setError(err);
    onDone(documentId ? `New version of ${existingTitle ?? "the document"} uploaded.` : `${title.trim()} uploaded.`);
  }

  return (
    <Dialog open title={documentId ? `New version · ${existingTitle ?? ""}` : "Upload document"} onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <Field label="File">
          <input type="file" accept={rules.contentTypes.join(",")} onChange={(e) => pick(e.target.files?.[0] ?? null)} />
        </Field>
        <p className="note">
          PDF, Word (.docx) or image · max {KB(rules.maxBytes)}.{file ? ` ${file.name} · ${KB(file.size)}` : ""}
        </p>
        {!documentId && (
          <>
            <Field label="Title">
              <input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} required />
            </Field>
            <Field label="Category">
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                {categories.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </Field>
          </>
        )}
        <Field label={documentId ? "New expiry date (optional)" : "Expiry date (optional)"}>
          <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
        </Field>
        {error && <Banner message={{ tone: "err", text: error }} />}
        <div className="dialog-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={!file || busy || (!documentId && !title.trim())}>
            {busy ? "Uploading…" : "Upload"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

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
        API_ENABLED ? undefined : (
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
        )
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

      {tab === "library" && API_ENABLED && <ApiDocumentsLibrary actor={demoProfile} />}

      {tab === "library" && !API_ENABLED && (
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
