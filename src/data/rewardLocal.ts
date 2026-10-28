import { DEMO_ACCOUNTS, managementChain, type DemoAccount } from "../demoAccounts.ts";
import { formatShortDate, parseISODate, toISO, todayISO } from "../model.ts";
import { appendAuditEntries, type AuditEntry } from "./auditTrail.ts";
import { pushPersonTaskAlert } from "./collabLocal.ts";
import { resolveFlow, workflowVersion, type FlowDecision, type FlowStep } from "./approvalWorkflows.ts";
import { decideFlowStep, isWaitingOn, stepText, waitingApproverIds, type SteppedRequest } from "./expenseFlow.ts";
import { getBasePeople } from "./peopleData.ts";
import { canManagePeople } from "./peoplePermissions.ts";
import { canManageLetters } from "./rbac.ts";
import {
  BENEFIT_ENROLLMENTS,
  BENEFIT_HISTORY,
  BENEFIT_PLANS,
  BONUSES,
  COMP_CYCLES,
  COMP_HISTORY,
  COMP_REVIEWS,
  DEPENDENTS,
  DOC_LIBRARY_SEED,
  GRADE_BANDS,
  LETTER_REQUESTS,
  OPEN_ENROLLMENT_SEED,
  SENSITIVE_LETTER_TYPES,
  type BenefitChangeRequest,
  type BenefitEnrollment,
  type BenefitHistoryRow,
  type BenefitPlan,
  type BonusRecord,
  type CompCycle,
  type CompHistoryRow,
  type CompReviewItem,
  type Dependent,
  type DocLibraryItem,
  type EnrollmentWindow,
  type GradeBand,
  type LetterRequest,
  type LetterStatus,
  type LetterType,
  type LifeEvent,
} from "./rewardData.ts";

// v4: the Compensation persona was retired (HR owns compensation & benefits) — older data is replaced.
// v5: the Hiring Manager persona was retired — his pay, benefits and documents left the seed; older data is replaced.
const KEY = "timez.reward.state.v5";
const OLD_KEYS = ["timez.reward.state.v1", "timez.reward.state.v2", "timez.reward.state.v3", "timez.reward.state.v4"];

type RewardState = {
  cycles: CompCycle[];
  bands: GradeBand[];
  reviews: CompReviewItem[];
  history: CompHistoryRow[];
  bonuses: BonusRecord[];
  enrollments: BenefitEnrollment[];
  changeRequests: BenefitChangeRequest[];
  letters: LetterRequest[];
  library: DocLibraryItem[];
  dependents: Dependent[];
  lifeEvents: LifeEvent[];
  benefitHistory: BenefitHistoryRow[];
  openEnrollment: EnrollmentWindow;
};

/** Mutations return null on success or a user-facing error message. */
export type RewardResult = string | null;

function defaults(): RewardState {
  return {
    cycles: structuredClone(COMP_CYCLES),
    bands: structuredClone(GRADE_BANDS),
    reviews: structuredClone(COMP_REVIEWS),
    history: structuredClone(COMP_HISTORY),
    bonuses: structuredClone(BONUSES),
    enrollments: structuredClone(BENEFIT_ENROLLMENTS),
    changeRequests: [],
    letters: structuredClone(LETTER_REQUESTS),
    library: structuredClone(DOC_LIBRARY_SEED),
    dependents: structuredClone(DEPENDENTS),
    lifeEvents: [],
    benefitHistory: structuredClone(BENEFIT_HISTORY),
    openEnrollment: structuredClone(OPEN_ENROLLMENT_SEED),
  };
}

/** Plans everyone in a country is enrolled in automatically (India PF, UK pension). */
function withAutoEnrollments(state: RewardState): RewardState {
  for (const person of DEMO_ACCOUNTS) {
    for (const plan of BENEFIT_PLANS) {
      if (!plan.autoEnrolled || plan.country !== person.countryName) continue;
      if (state.enrollments.some((e) => e.employeeId === person.id && e.planId === plan.id)) continue;
      state.enrollments.push({
        id: `be-auto-${person.id}-${plan.id}`,
        employeeId: person.id,
        employeeName: person.fullName,
        planId: plan.id,
        planName: plan.name,
        country: plan.country,
        status: "Enrolled",
        effective: "2026-01-01",
      });
    }
  }
  return state;
}

function read(): RewardState {
  const base = defaults();
  try {
    OLD_KEYS.forEach((k) => localStorage.removeItem(k));
    const raw = localStorage.getItem(KEY);
    if (!raw) return withAutoEnrollments(base);
    const parsed = JSON.parse(raw) as Partial<RewardState>;
    const list = <K extends keyof RewardState>(key: K): RewardState[K] =>
      (Array.isArray(parsed[key]) ? parsed[key] : base[key]) as RewardState[K];
    const win = parsed.openEnrollment;
    return withAutoEnrollments({
      cycles: list("cycles"),
      bands: list("bands"),
      reviews: list("reviews"),
      history: list("history"),
      bonuses: list("bonuses"),
      enrollments: list("enrollments"),
      changeRequests: list("changeRequests"),
      letters: list("letters"),
      library: list("library"),
      dependents: list("dependents"),
      lifeEvents: list("lifeEvents"),
      benefitHistory: list("benefitHistory"),
      openEnrollment: win && typeof win.start === "string" && typeof win.end === "string" ? win : base.openEnrollment,
    });
  } catch {
    return withAutoEnrollments(base);
  }
}

const listeners = new Set<() => void>();
let cache: RewardState | null = null;

function write(state: RewardState): RewardResult {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Usually the storage quota — keep the previous cache so UI and storage agree.
    return "Could not save — storage is full. Remove large uploads and try again.";
  }
  cache = state;
  listeners.forEach((fn) => fn());
  return null;
}

export function subscribeReward(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable snapshot for useSyncExternalStore — same reference until data changes. */
export function getRewardState(): RewardState {
  if (!cache) cache = read();
  return cache;
}

/** Mutator returns an error string to abort without writing. */
export function updateReward(mutator: (state: RewardState) => RewardResult | void): RewardResult {
  const state = structuredClone(getRewardState());
  const error = mutator(state);
  if (error) return error;
  return write(state);
}

/* ───────────── Compensation reviews ───────────── */

type Actor = Pick<DemoAccount, "id" | "fullName" | "role">;

function chainIds(employeeId: string): string[] {
  return managementChain(employeeId, DEMO_ACCOUNTS).map((m) => m.id);
}

/** True when `actorId` sits above `employeeId` in the reporting line. */
export function isAboveInLine(actorId: string, employeeId: string): boolean {
  return actorId !== employeeId && chainIds(employeeId).includes(actorId);
}

/** HR roles that own compensation & benefits decisions. */
const PAY_HR_ROLES = new Set<string>(["hr", "hr_admin"]);

export function isPayHr(actor: Pick<DemoAccount, "role">): boolean {
  return PAY_HR_ROLES.has(actor.role);
}

/**
 * Who decides a pay / benefits item about `subjectId`: any HR sign-in account other than the subject (and other
 * than anyone in `skip`). When HR is the subject (HR's own pay), the subject's line manager decides instead —
 * the nearest person above them who isn't skipped. Never the subject.
 */
export function payDecidersFor(
  subjectId: string,
  isDecider: (a: DemoAccount) => boolean = isPayHr,
  skip: (a: Pick<DemoAccount, "id" | "fullName">) => boolean = () => false,
): { id: string; fullName: string }[] {
  const pool = DEMO_ACCOUNTS.filter((a) => isDecider(a) && a.id !== subjectId && !skip(a));
  if (pool.length) return pool.map((a) => ({ id: a.id, fullName: a.fullName }));
  const manager = managementChain(subjectId, DEMO_ACCOUNTS).find((m) => m.id !== subjectId && !skip(m));
  return manager ? [{ id: manager.id, fullName: manager.fullName }] : [];
}

/* ── Money ── */

const CURRENCY_SYMBOL: Record<string, string> = { INR: "₹", USD: "$", GBP: "£", CAD: "C$", EUR: "€", AUD: "A$", AED: "AED ", SAR: "SAR " };

/** "₹17,40,000" → 1740000. Returns NaN when there are no digits. */
export function parseAmount(value: string): number {
  const digits = value.replace(/[^\d.]/g, "");
  return digits ? Number(digits) : Number.NaN;
}

export function formatAmount(amount: number, currency: string): string {
  const rounded = Math.round(amount);
  const grouped = rounded.toLocaleString(currency === "INR" ? "en-IN" : "en-US");
  return `${CURRENCY_SYMBOL[currency] ?? `${currency} `}${grouped}`;
}

/* ── Audit ── */

type AuditLog = (
  entityId: string,
  subjectId: string | undefined,
  action: AuditEntry["action"],
  changes: AuditEntry["changes"],
) => void;

/** Runs a reward update and, only if it saved, writes the collected entries to the central audit log. */
function withCompAudit(actor: Actor, mutate: (s: RewardState, log: AuditLog) => RewardResult | void): RewardResult {
  const entries: Omit<AuditEntry, "id">[] = [];
  const log: AuditLog = (entityId, subjectId, action, changes) =>
    entries.push({ at: new Date().toISOString(), actorId: actor.id, actorName: actor.fullName, entity: "Compensation", entityId, subjectId, action, changes });
  const result = updateReward((s) => mutate(s, log));
  if (!result) appendAuditEntries(entries);
  return result;
}

/* ── Cycles ── */

export function cycleById(state: Pick<RewardState, "cycles">, id: string): CompCycle | undefined {
  return state.cycles.find((c) => c.id === id);
}

/** Proposals can be made and submitted only while a cycle is open. */
export function cycleTakesProposals(cycle: CompCycle | undefined): boolean {
  return !!cycle && (cycle.status === "Open" || cycle.status === "Manager review");
}

function windowLabel(from: string, to: string): string {
  return `${formatShortDate(from)} – ${formatShortDate(to)}`;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** HR sets up a new compensation review cycle. */
export function createCompCycle(
  actor: Actor,
  input: { name: string; effectiveDate: string; budgetPct: number; opensOn: string; closesOn: string; countries: string[] },
): RewardResult {
  if (!isPayHr(actor)) return "Only HR can create review cycles.";
  const name = input.name.trim();
  if (name.length < 3) return "Give the cycle a name.";
  if (![input.effectiveDate, input.opensOn, input.closesOn].every((d) => ISO_DATE.test(d))) return "Fill in all three dates.";
  if (input.closesOn < input.opensOn) return "The close date must be after the open date.";
  if (input.effectiveDate < input.opensOn) return "The effective date can't be before the cycle opens.";
  if (!Number.isFinite(input.budgetPct) || input.budgetPct <= 0 || input.budgetPct > 50) return "Budget must be between 0.1% and 50%.";
  if (!input.countries.length) return "Pick at least one country.";
  const today = todayISO();
  let createdId = "";
  const result = withCompAudit(actor, (s, log) => {
    if (s.cycles.some((c) => c.name.toLowerCase() === name.toLowerCase())) return "A cycle with this name already exists.";
    createdId = `cc-local-${Date.now()}`;
    const status: CompCycle["status"] = input.opensOn <= today && today <= input.closesOn ? "Open" : input.closesOn < today ? "Closed" : "Planning";
    s.cycles.unshift({
      id: createdId,
      name,
      status,
      window: windowLabel(input.opensOn, input.closesOn),
      countries: [...input.countries],
      effectiveDate: input.effectiveDate,
      budgetPct: Math.round(input.budgetPct * 10) / 10,
      opensOn: input.opensOn,
      closesOn: input.closesOn,
      createdBy: actor.fullName,
    });
    log(createdId, undefined, "Created", [
      { field: "Cycle", before: "", after: name },
      { field: "Budget", before: "", after: `${input.budgetPct}%` },
      { field: "Window", before: "", after: windowLabel(input.opensOn, input.closesOn) },
      { field: "Status", before: "", after: status },
    ]);
  });
  if (!result) notifyCycle(createdId);
  return result;
}

function notifyCycle(cycleId: string) {
  const cycle = cycleById(getRewardState(), cycleId);
  if (!cycle || cycle.status !== "Open") return;
  DEMO_ACCOUNTS.filter((a) => DEMO_ACCOUNTS.some((b) => isAboveInLine(a.id, b.id))).forEach((a) =>
    pushPersonTaskAlert({
      recipientId: a.id,
      title: `${cycle.name} is open`,
      body: `Propose pay changes for your team by ${cycle.closesOn ? formatShortDate(cycle.closesOn) : "the close date"}.`,
      href: "/compensation",
    }),
  );
}

/** HR opens or closes a cycle by hand. */
export function setCompCycleStatus(actor: Actor, id: string, status: "Open" | "Closed"): RewardResult {
  if (!isPayHr(actor)) return "Only HR can open or close review cycles.";
  const result = withCompAudit(actor, (s, log) => {
    const cycle = cycleById(s, id);
    if (!cycle) return "Cycle not found.";
    if (cycle.status === status) return `This cycle is already ${status.toLowerCase()}.`;
    log(id, undefined, "Updated", [{ field: "Status", before: cycle.status, after: status }]);
    cycle.status = status;
  });
  if (!result && status === "Open") notifyCycle(id);
  return result;
}

/** Latest recorded grade and base for an employee. */
export function currentPay(state: Pick<RewardState, "history">, employeeId: string): CompHistoryRow | undefined {
  return state.history
    .filter((h) => h.employeeId === employeeId)
    .sort((a, b) => b.effective.localeCompare(a.effective))[0];
}

/** People `actor` may propose for: anyone below them in the line; HR, anyone but themselves. */
export function canProposeFor(actor: Actor, employeeId: string): boolean {
  if (actor.id === employeeId) return false;
  return isPayHr(actor) || isAboveInLine(actor.id, employeeId);
}

/** A manager (or HR) proposes a pay change inside an open cycle. Saved as a draft unless `submit` is set. */
export function createCompProposal(
  actor: Actor,
  input: { cycleId: string; employeeId: string; proposedGrade: string; proposedBase: number; bonus: number; currentBase?: number; currentGrade?: string; submit?: boolean },
): RewardResult {
  const person = DEMO_ACCOUNTS.find((a) => a.id === input.employeeId);
  if (!person) return "Employee not found.";
  if (!canProposeFor(actor, person.id)) return "You can only propose for people below you in the reporting line.";
  let submitted: { ids: string[]; employeeName: string; body: string } | null = null;
  const result = withCompAudit(actor, (s, log) => {
    const cycle = cycleById(s, input.cycleId);
    if (!cycle) return "Cycle not found.";
    if (!cycleTakesProposals(cycle)) return `${cycle.name} is not open for proposals.`;
    if (person.countryName && !cycle.countries.includes(person.countryName)) return `${cycle.name} doesn't cover ${person.countryName}.`;
    if (s.reviews.some((r) => r.cycleId === cycle.id && r.employeeId === person.id && r.status !== "Rejected")) {
      return `${person.fullName} already has a proposal in this cycle.`;
    }
    const pay = currentPay(s, person.id);
    const currency = person.currency ?? "INR";
    const currentBase = pay ? parseAmount(pay.base) : input.currentBase ?? Number.NaN;
    const currentGrade = pay?.grade ?? input.currentGrade?.trim() ?? "";
    if (!Number.isFinite(currentBase) || currentBase <= 0) return "Enter the current base pay.";
    if (!currentGrade) return "Enter the current grade.";
    if (!input.proposedGrade.trim()) return "Pick the proposed grade.";
    if (!Number.isFinite(input.proposedBase) || input.proposedBase <= 0) return "Enter the proposed base pay.";
    if (input.proposedBase < currentBase) return "The proposed base can't be below the current base.";
    if (!Number.isFinite(input.bonus) || input.bonus < 0) return "Bonus can't be negative.";
    const pct = Math.round(((input.proposedBase - currentBase) / currentBase) * 1000) / 10;
    const id = `cr-local-${Date.now()}`;
    const proposedBase = formatAmount(input.proposedBase, currency);
    const bonus = input.bonus ? formatAmount(input.bonus, currency) : "";
    const row: CompProposal = {
      id,
      cycleId: cycle.id,
      employeeId: person.id,
      employeeName: person.fullName,
      managerId: actor.id,
      managerName: actor.fullName,
      currentGrade,
      proposedGrade: input.proposedGrade.trim(),
      currentBase: formatAmount(currentBase, currency),
      proposedBase,
      proposedIncreasePct: pct,
      currency,
      status: "Draft",
      bonusProposal: bonus,
    };
    if (input.submit) {
      startCompApproval(row, actor.id);
      if (!row.steps?.length) return "No one can approve this proposal.";
      submitted = { ids: waitingApproverIds(compFlow(row)), employeeName: row.employeeName, body: `${row.steps[0]!.label} · proposed by ${actor.fullName}` };
    }
    const status = row.status;
    s.reviews.unshift(row);
    log(id, person.id, "Created", [
      { field: "Cycle", before: "", after: cycle.name },
      { field: "Base", before: formatAmount(currentBase, currency), after: proposedBase },
      { field: "Grade", before: currentGrade, after: input.proposedGrade.trim() },
      ...(bonus ? [{ field: "Bonus proposal", before: "", after: bonus }] : []),
      { field: "Status", before: "", after: status },
    ]);
  });
  const sent = submitted as { ids: string[]; employeeName: string; body: string } | null;
  if (!result && sent) compAlert(sent.ids, sent.employeeName, sent.body);
  return result;
}

/* Proposals submitted now follow the "compensation" approval workflow (HR → finance/admin → an executive for large
   increases by default), fixed at submission. Older proposals (no steps) keep the line → HR rule. */

/** A proposal row with the workflow fields newer proposals carry. */
export type CompProposal = CompReviewItem & {
  steps?: FlowStep[];
  currentStep?: number;
  stepDecisions?: FlowDecision[];
  submittedOn?: string;
  workflowVersion?: number;
};

const NO_LINE_OVERRIDE = () => false;

function compFlow(row: CompProposal): SteppedRequest {
  const open = row.status === "Pending approval" || row.status === "Pending final approval";
  return { employeeId: row.employeeId, status: open ? "pending" : "closed", steps: row.steps, currentStep: row.currentStep ?? 0, stepDecisions: row.stepDecisions ?? [] };
}

/** Status for the open step: the last step shows as final approval. */
function stepStatus(row: CompProposal): CompReviewItem["status"] {
  return (row.currentStep ?? 0) >= (row.steps?.length ?? 1) - 1 ? "Pending final approval" : "Pending approval";
}

/** Fix the workflow steps when a proposal is submitted. With nobody to approve, HR (or, for HR's pay, their line manager) decides. */
function startCompApproval(row: CompProposal, proposerId: string) {
  let steps = resolveFlow("compensation", row.employeeId, { percent: row.proposedIncreasePct, excludeIds: [proposerId] });
  if (!steps.length) {
    const ids = payDecidersFor(row.employeeId, isPayHr, (a) => a.id === proposerId).map((a) => a.id);
    steps = ids.length ? [{ role: "hr", label: "Final approval", approverIds: ids }] : [];
  }
  row.steps = steps;
  row.currentStep = 0;
  row.stepDecisions = [];
  row.submittedOn = todayISO();
  row.workflowVersion = workflowVersion("compensation");
  row.status = stepStatus(row);
}

function compAlert(ids: string[], employeeName: string, body: string) {
  for (const recipientId of new Set(ids)) {
    pushPersonTaskAlert({ recipientId, title: `Pay proposal to approve · ${employeeName}`, body, href: "/compensation" });
  }
}

/**
 * Who may decide the row now. Workflow proposals: the open step's approvers. Older ones: line step = above the
 * employee, never the proposer; final step = HR (or, for HR's own pay, their line manager).
 */
export function canDecideCompReview(actor: Actor, row: CompProposal): boolean {
  if (actor.id === row.employeeId || actor.id === row.managerId) return false;
  if (cycleById(getRewardState(), row.cycleId)?.status === "Closed") return false;
  if (row.steps?.length) return isWaitingOn(compFlow(row), actor.id, NO_LINE_OVERRIDE);
  if (row.status === "Pending approval") return isAboveInLine(actor.id, row.employeeId);
  if (row.status === "Pending final approval") {
    if (row.lineApprover === actor.fullName) return false;
    return payDecidersFor(row.employeeId, isPayHr, (a) => a.id === row.managerId || a.fullName === row.lineApprover).some(
      (a) => a.id === actor.id,
    );
  }
  return false;
}

/** "HR approval ✓ Farhan · Compensation approval (waiting)" for workflow proposals; older ones show the line approver. */
export function compApprovalText(row: CompProposal): string {
  if (!row.steps?.length) return row.lineApprover ? `${row.lineApprover} · ${row.lineApprovedOn ?? ""}` : "—";
  const decisions = row.stepDecisions ?? [];
  const open = row.status === "Pending approval" || row.status === "Pending final approval";
  return row.steps
    .map((step, index) => {
      const done = decisions.filter((d) => d.step === index);
      const waiting = open && index === (row.currentStep ?? 0);
      if (done.length && !waiting) return `${step.label} ${done.some((d) => d.decision === "rejected") ? "✗" : "✓"} ${done.map((d) => d.byName).join(", ")}`;
      if (waiting) return `${step.label} (waiting${done.length ? `; ✓ ${done.map((d) => d.byName).join(", ")}` : ""})`;
      return step.label;
    })
    .join(" · ");
}

/** The proposer sends a draft for approval. */
export function submitCompReview(actor: Actor, id: string): RewardResult {
  let alert: { ids: string[]; employeeName: string; body: string } | null = null;
  const result = withCompAudit(actor, (s, log) => {
    const row = s.reviews.find((r) => r.id === id) as CompProposal | undefined;
    if (!row) return "Proposal not found.";
    if (row.managerId !== actor.id) return "Only the person who proposed this can submit it.";
    if (row.status !== "Draft") return "Only drafts can be submitted.";
    if (!cycleTakesProposals(cycleById(s, row.cycleId))) return "This review cycle is not open.";
    startCompApproval(row, actor.id);
    if (!row.steps?.length) return "No one can approve this proposal.";
    log(row.id, row.employeeId, "Updated", [{ field: "Status", before: "Draft", after: row.status }]);
    alert = { ids: waitingApproverIds(compFlow(row)), employeeName: row.employeeName, body: `${row.steps[0]!.label} · proposed by ${actor.fullName}` };
  });
  const sent = alert as { ids: string[]; employeeName: string; body: string } | null;
  if (!result && sent) compAlert(sent.ids, sent.employeeName, sent.body);
  return result;
}

/** Final approval: record the new pay (and bonus) in history. */
function applyApprovedProposal(s: RewardState, row: CompProposal, log: AuditLog, before: string, today: string) {
  const cycle = cycleById(s, row.cycleId);
  const effective = cycle?.effectiveDate ?? today;
  s.history.unshift({
    id: `ch-${row.id}`,
    employeeId: row.employeeId,
    employeeName: row.employeeName,
    effective,
    event: cycle?.name ?? "Compensation review",
    grade: row.proposedGrade,
    base: row.proposedBase,
    currency: row.currency,
    managerId: row.managerId,
  });
  log(row.id, row.employeeId, "Updated", [
    { field: "Status", before, after: "Approved" },
    { field: "Base", before: row.currentBase, after: row.proposedBase },
    ...(row.currentGrade !== row.proposedGrade ? [{ field: "Grade", before: row.currentGrade, after: row.proposedGrade }] : []),
    { field: "Effective", before: "", after: effective },
  ]);
  if (row.bonusProposal) {
    s.bonuses.unshift({
      id: `bn-${row.id}`,
      employeeId: row.employeeId,
      employeeName: row.employeeName,
      type: "Annual incentive",
      period: cycle?.name.split(" ")[0] ?? today.slice(0, 4),
      amount: row.bonusProposal,
      currency: row.currency,
      status: "Accrued",
    });
    log(`bn-${row.id}`, row.employeeId, "Created", [{ field: "Bonus", before: "", after: row.bonusProposal }]);
  }
}

export function decideCompReview(actor: Actor, id: string, decision: "Approved" | "Rejected"): RewardResult {
  let notify: { to: string; title: string; body: string } | null = null;
  let nextAlert: { ids: string[]; employeeName: string; body: string } | null = null;
  const result = withCompAudit(actor, (s, log) => {
    const row = s.reviews.find((r) => r.id === id) as CompProposal | undefined;
    if (!row) return "Proposal not found.";
    if (row.employeeId === actor.id) return "You cannot decide your own compensation.";
    if (row.managerId === actor.id) return "You cannot approve your own proposal.";
    if (!canDecideCompReview(actor, row)) {
      if (row.steps?.length) {
        const flow = compFlow(row);
        return flow.status === "pending" ? `This proposal is waiting for ${stepText(flow).split(" · ")[0]!.toLowerCase()}.` : "This proposal has already been decided.";
      }
      return row.status === "Pending final approval"
        ? "HR makes the final decision (for HR's own pay, their line manager)."
        : "Only someone above the employee in their reporting line can approve this.";
    }
    const today = todayISO();
    const before = row.status;

    // Workflow proposals: decide the open step.
    if (row.steps?.length) {
      const res = decideFlowStep(compFlow(row), actor, decision === "Approved" ? "approved" : "rejected", undefined, NO_LINE_OVERRIDE, today);
      if (typeof res === "string") return res;
      if (!(row.stepDecisions ?? []).length && decision === "Approved") {
        row.lineApprover = actor.fullName;
        row.lineApprovedOn = today;
      }
      row.stepDecisions = [...(row.stepDecisions ?? []), ...res.entries];
      if (res.outcome === "rejected") {
        row.status = "Rejected";
        row.approver = actor.fullName;
        row.decidedOn = today;
        log(row.id, row.employeeId, "Updated", [{ field: "Status", before, after: "Rejected" }]);
        notify = { to: row.managerId, title: `Pay proposal rejected · ${row.employeeName}`, body: `${actor.fullName} rejected the proposal (${res.step.label.toLowerCase()}).` };
        return;
      }
      if (res.outcome === "waiting" || res.outcome === "advanced") {
        row.currentStep = res.currentStep;
        row.status = stepStatus(row);
        log(row.id, row.employeeId, "Updated", [
          ...res.entries.map((e) => ({ field: e.label, before: "Pending", after: "Approved" })),
          ...(row.status !== before ? [{ field: "Status", before, after: row.status }] : []),
        ]);
        if (res.outcome === "advanced") {
          nextAlert = { ids: waitingApproverIds(compFlow(row)), employeeName: row.employeeName, body: `${res.next?.label ?? "Next step"} · ${row.proposedIncreasePct}% increase` };
        }
        return;
      }
      row.status = "Approved";
      row.approver = actor.fullName;
      row.decidedOn = today;
      applyApprovedProposal(s, row, log, before, today);
      notify = { to: row.managerId, title: `Pay proposal approved · ${row.employeeName}`, body: `${actor.fullName} gave final approval.` };
      return;
    }

    // Older proposals: line approval, then HR's final decision.
    if (decision === "Rejected") {
      row.status = "Rejected";
      row.approver = actor.fullName;
      row.decidedOn = today;
      log(row.id, row.employeeId, "Updated", [{ field: "Status", before, after: "Rejected" }]);
      notify = { to: row.managerId, title: `Pay proposal rejected · ${row.employeeName}`, body: `${actor.fullName} rejected the proposal.` };
      return;
    }
    if (row.status === "Pending approval") {
      row.status = "Pending final approval";
      row.lineApprover = actor.fullName;
      row.lineApprovedOn = today;
      log(row.id, row.employeeId, "Updated", [{ field: "Status", before, after: row.status }]);
      return;
    }
    row.status = "Approved";
    row.approver = actor.fullName;
    row.decidedOn = today;
    applyApprovedProposal(s, row, log, before, today);
    notify = { to: row.managerId, title: `Pay proposal approved · ${row.employeeName}`, body: `${actor.fullName} gave final approval.` };
  });
  const sent = notify as { to: string; title: string; body: string } | null;
  if (!result && sent) pushPersonTaskAlert({ recipientId: sent.to, title: sent.title, body: sent.body, href: "/compensation" });
  const next = nextAlert as { ids: string[]; employeeName: string; body: string } | null;
  if (!result && next) compAlert(next.ids, next.employeeName, next.body);
  return result;
}

/* ── Grade bands ── */

/** HR changes a salary range. Amounts are whole numbers in the band's currency. */
export function updateGradeBand(actor: Actor, id: string, input: { min: number; mid: number; max: number }): RewardResult {
  if (!isPayHr(actor)) return "Only HR can change salary ranges.";
  const { min, mid, max } = input;
  if (![min, mid, max].every((n) => Number.isFinite(n) && n > 0)) return "Enter min, mid and max.";
  if (!(min <= mid && mid <= max)) return "Min must be at most mid, and mid at most max.";
  return withCompAudit(actor, (s, log) => {
    const band = s.bands.find((b) => b.id === id);
    if (!band) return "Range not found.";
    const next = { min: formatAmount(min, band.currency), mid: formatAmount(mid, band.currency), max: formatAmount(max, band.currency) };
    const changes = (["min", "mid", "max"] as const)
      .filter((k) => band[k] !== next[k])
      .map((k) => ({ field: `${band.grade} ${band.family} ${band.country} ${k}`, before: band[k], after: next[k] }));
    if (!changes.length) return "Nothing changed.";
    Object.assign(band, next);
    log(band.id, undefined, "Updated", changes);
  });
}

/* ── Bonuses ── */

export function addBonus(actor: Actor, input: { employeeId: string; type: string; period: string; amount: number }): RewardResult {
  if (!isPayHr(actor)) return "Only HR can record bonuses.";
  if (input.employeeId === actor.id) return "Someone else must record your own bonus.";
  const person = DEMO_ACCOUNTS.find((a) => a.id === input.employeeId);
  if (!person) return "Employee not found.";
  if (!input.type.trim() || !input.period.trim()) return "Fill in the type and period.";
  if (!Number.isFinite(input.amount) || input.amount <= 0) return "Enter the amount.";
  const currency = person.currency ?? "INR";
  return withCompAudit(actor, (s, log) => {
    const id = `bn-local-${Date.now()}`;
    const amount = formatAmount(input.amount, currency);
    s.bonuses.unshift({
      id,
      employeeId: person.id,
      employeeName: person.fullName,
      type: input.type.trim(),
      period: input.period.trim(),
      amount,
      currency,
      status: "Accrued",
    });
    log(id, person.id, "Created", [
      { field: "Bonus", before: "", after: amount },
      { field: "Type", before: "", after: input.type.trim() },
      { field: "Period", before: "", after: input.period.trim() },
    ]);
  });
}

export function setBonusStatus(actor: Actor, id: string, status: BonusRecord["status"]): RewardResult {
  if (!isPayHr(actor)) return "Only HR can change bonus status.";
  return withCompAudit(actor, (s, log) => {
    const row = s.bonuses.find((b) => b.id === id);
    if (!row) return "Bonus not found.";
    if (row.employeeId === actor.id) return "Someone else must update your own bonus.";
    if (row.status !== "Accrued") return "Only accrued bonuses can be changed.";
    log(row.id, row.employeeId, "Updated", [
      { field: "Status", before: row.status, after: status },
      { field: "Amount", before: row.amount, after: status === "Forfeited" ? "0" : row.amount },
    ]);
    row.status = status;
  });
}

/** Share of the cycle budget used by live proposals (approved or in progress), against current base. */
export function cycleBudgetUse(state: Pick<RewardState, "reviews">, cycleId: string): { usedPct: number; count: number } {
  const rows = state.reviews.filter((r) => r.cycleId === cycleId && r.status !== "Rejected");
  const current = rows.reduce((sum, r) => sum + (parseAmount(r.currentBase) || 0), 0);
  const proposed = rows.reduce((sum, r) => sum + (parseAmount(r.proposedBase) || 0), 0);
  return { usedPct: current ? Math.round(((proposed - current) / current) * 1000) / 10 : 0, count: rows.length };
}

/* ───────────── Benefits ───────────── */

export function canAdminBenefits(actor: Pick<DemoAccount, "role">): boolean {
  return canManagePeople(actor.role);
}

/** Who may decide a benefits request for `employeeId`: HR (benefits admins), never the employee; HR's own requests go to their line manager. */
export function canDecideBenefitFor(actor: Pick<DemoAccount, "id" | "role">, employeeId: string): boolean {
  if (actor.id === employeeId) return false;
  return payDecidersFor(employeeId, (a) => canAdminBenefits(a)).some((a) => a.id === actor.id);
}

export function isMandatoryPlan(planId: string): boolean {
  return !!BENEFIT_PLANS.find((p) => p.id === planId)?.mandatory;
}

export function isAutoPlan(planId: string): boolean {
  return !!BENEFIT_PLANS.find((p) => p.id === planId)?.autoEnrolled;
}

function addDays(iso: string, days: number): string {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + days);
  return toISO(d);
}

function alertBenefitsHr(employeeId: string, title: string, body: string) {
  payDecidersFor(employeeId, (a) => canAdminBenefits(a)).forEach((a) =>
    pushPersonTaskAlert({ recipientId: a.id, title, body, href: "/benefits" }),
  );
}

function logBenefit(s: RewardState, employeeId: string, event: string, detail: string) {
  s.benefitHistory.unshift({ id: `bh-local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, employeeId, date: todayISO(), event, detail });
}

/* ── Eligibility ── */

let peopleCache: ReturnType<typeof getBasePeople> | null = null;
function personFacts(employeeId: string) {
  if (!peopleCache) peopleCache = getBasePeople();
  const person = peopleCache.find((p) => p.id === employeeId);
  const account = DEMO_ACCOUNTS.find((a) => a.id === employeeId);
  return {
    country: account?.countryName ?? person?.countryName ?? "",
    employmentType: account?.employmentType ?? person?.employmentType ?? "",
    joined: person?.dateOfJoining ?? "",
    grade: person?.grade ?? "",
  };
}

function monthsBetween(from: string, to: string): number {
  const a = parseISODate(from);
  const b = parseISODate(to);
  let months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (b.getDate() < a.getDate()) months -= 1;
  return months;
}

/** Plan rules, in plain words. */
export function eligibilityRules(plan: BenefitPlan): string[] {
  const rules = [`Works in ${plan.country}`];
  const e = plan.eligibility;
  if (e?.excludeEmploymentTypes?.length) rules.push(`Not ${e.excludeEmploymentTypes.join(" or ").toLowerCase()} staff`);
  if (e?.minServiceMonths) rules.push(`At least ${e.minServiceMonths} month${e.minServiceMonths === 1 ? "" : "s"} of service`);
  if (e?.grades?.length) rules.push(`Grade ${e.grades.join(", ")}`);
  return rules;
}

/** Checks a plan's rules against the person. */
export function planEligibility(plan: BenefitPlan, employeeId: string, today = todayISO()): { eligible: boolean; reason: string } {
  const f = personFacts(employeeId);
  if (f.country !== plan.country) return { eligible: false, reason: `Only for staff in ${plan.country}` };
  const e = plan.eligibility;
  const type = f.employmentType.toLowerCase();
  if (e?.excludeEmploymentTypes?.some((t) => type.includes(t.toLowerCase()))) return { eligible: false, reason: `Not open to ${f.employmentType.toLowerCase()} staff` };
  if (e?.minServiceMonths && f.joined) {
    const served = monthsBetween(f.joined, today);
    if (served < e.minServiceMonths) {
      const from = parseISODate(f.joined);
      from.setMonth(from.getMonth() + e.minServiceMonths);
      return { eligible: false, reason: `Needs ${e.minServiceMonths} months of service (eligible from ${formatShortDate(toISO(from))})` };
    }
  }
  if (e?.grades?.length && !e.grades.includes(f.grade)) return { eligible: false, reason: `Grade ${f.grade || "unknown"} is not covered` };
  return { eligible: true, reason: "" };
}

/* ── Enrollment windows ── */

export type ChangeWindow = { open: boolean; text: string; lifeEventId?: string };

export function openEnrollmentIsOpen(win: EnrollmentWindow, today = todayISO()): boolean {
  if (win.override === "open") return true;
  if (win.override === "closed") return false;
  return win.start <= today && today <= win.end;
}

export function openEnrollmentLabel(win: EnrollmentWindow): string {
  return windowLabel(win.start, win.end);
}

export function activeLifeEvent(state: Pick<RewardState, "lifeEvents">, employeeId: string, today = todayISO()): LifeEvent | undefined {
  return state.lifeEvents.find((e) => e.employeeId === employeeId && e.status === "Open" && today <= e.windowEnds);
}

/** Whether `employeeId` may make benefit elections or changes today, and why. */
export function changeWindowFor(state: Pick<RewardState, "lifeEvents" | "openEnrollment">, employeeId: string, today = todayISO()): ChangeWindow {
  if (openEnrollmentIsOpen(state.openEnrollment, today)) {
    return { open: true, text: `Open enrollment is open${state.openEnrollment.override === "open" ? "" : ` until ${formatShortDate(state.openEnrollment.end)}`}.` };
  }
  const event = activeLifeEvent(state, employeeId, today);
  if (event) return { open: true, text: `${event.type} window is open until ${formatShortDate(event.windowEnds)}.`, lifeEventId: event.id };
  return {
    open: false,
    text: `Changes are allowed only during open enrollment (${openEnrollmentLabel(state.openEnrollment)}) or within 30 days of a life event.`,
  };
}

function windowError(s: RewardState, employeeId: string): string | null {
  const w = changeWindowFor(s, employeeId);
  return w.open ? null : w.text;
}

/** HR sets the open enrollment dates (clears any manual open/close). */
export function setOpenEnrollmentDates(actor: DemoAccount, start: string, end: string): RewardResult {
  if (!canAdminBenefits(actor)) return "Only HR can change the enrollment window.";
  if (!ISO_DATE.test(start) || !ISO_DATE.test(end)) return "Fill in both dates.";
  if (end < start) return "The end date must be after the start date.";
  return updateReward((s) => {
    s.openEnrollment = { year: Number(end.slice(0, 4)) + (Number(end.slice(5, 7)) >= 10 ? 1 : 0), start, end, updatedBy: actor.fullName };
  });
}

/** HR opens or closes open enrollment now, or goes back to the dates (null). */
export function setOpenEnrollmentOverride(actor: DemoAccount, override: "open" | "closed" | null): RewardResult {
  if (!canAdminBenefits(actor)) return "Only HR can open or close enrollment.";
  return updateReward((s) => {
    s.openEnrollment = { ...s.openEnrollment, override: override ?? undefined, updatedBy: actor.fullName };
  });
}

/** Employee reports a life event; it opens a 30-day change window from the event date. */
export function raiseLifeEvent(actor: DemoAccount, type: string, eventDate: string): RewardResult {
  const today = todayISO();
  if (!type) return "Pick the life event.";
  if (!ISO_DATE.test(eventDate)) return "Enter the event date.";
  if (eventDate > today) return "The event date can't be in the future.";
  const windowEnds = addDays(eventDate, 30);
  if (windowEnds < today) return "Life events must be reported within 30 days.";
  const result = updateReward((s) => {
    if (s.lifeEvents.some((e) => e.employeeId === actor.id && e.type === type && e.eventDate === eventDate)) return "You have already reported this event.";
    s.lifeEvents.unshift({
      id: `le-${Date.now()}`,
      employeeId: actor.id,
      employeeName: actor.fullName,
      type,
      eventDate,
      raisedOn: today,
      windowEnds,
      status: "Open",
    });
    logBenefit(s, actor.id, "Life event", `${type} on ${formatShortDate(eventDate)} · changes allowed until ${formatShortDate(windowEnds)}`);
  });
  if (!result) alertBenefitsHr(actor.id, `Life event · ${actor.fullName}`, `${type} on ${formatShortDate(eventDate)}. Benefit changes open until ${formatShortDate(windowEnds)}.`);
  return result;
}

/** HR closes a life-event window early. */
export function closeLifeEvent(actor: DemoAccount, id: string): RewardResult {
  return updateReward((s) => {
    const row = s.lifeEvents.find((e) => e.id === id);
    if (!row) return "Life event not found.";
    if (!canDecideBenefitFor(actor, row.employeeId)) return "Only HR can close a life event window.";
    if (row.status !== "Open") return "This window is already closed.";
    row.status = "Closed";
    row.closedBy = actor.fullName;
  });
}

/* ── Dependents ── */

export type DependentInput = { name: string; relationship: string; dateOfBirth: string; gender?: string };

function checkDependent(input: DependentInput): string | null {
  if (input.name.trim().length < 2) return "Enter the dependent's name.";
  if (!input.relationship) return "Pick the relationship.";
  if (!ISO_DATE.test(input.dateOfBirth)) return "Enter the date of birth.";
  if (input.dateOfBirth > todayISO()) return "Date of birth can't be in the future.";
  return null;
}

export function addDependent(actor: DemoAccount, input: DependentInput): RewardResult {
  const error = checkDependent(input);
  if (error) return error;
  const name = input.name.trim();
  const result = updateReward((s) => {
    if (s.dependents.some((d) => d.employeeId === actor.id && d.name.toLowerCase() === name.toLowerCase())) return `${name} is already on file.`;
    s.dependents.push({
      id: `dep-local-${Date.now()}`,
      employeeId: actor.id,
      name,
      relationship: input.relationship,
      dateOfBirth: input.dateOfBirth,
      gender: input.gender || undefined,
      coveredPlans: [],
      verification: "Pending",
    });
    logBenefit(s, actor.id, "Dependent add", `Added ${name} (${input.relationship})`);
  });
  if (!result) alertBenefitsHr(actor.id, `Verify dependent · ${actor.fullName}`, `${name} (${input.relationship}) was added.`);
  return result;
}

export function updateDependent(actor: DemoAccount, id: string, input: DependentInput): RewardResult {
  const error = checkDependent(input);
  if (error) return error;
  let changed = false;
  const result = updateReward((s) => {
    const row = s.dependents.find((d) => d.id === id);
    if (!row || row.employeeId !== actor.id) return "You can only edit your own dependents.";
    const next = { name: input.name.trim(), relationship: input.relationship, dateOfBirth: input.dateOfBirth, gender: input.gender || undefined };
    changed = next.name !== row.name || next.relationship !== row.relationship || next.dateOfBirth !== row.dateOfBirth;
    if (!changed && next.gender === row.gender) return "Nothing changed.";
    Object.assign(row, next);
    if (changed) {
      row.verification = "Pending";
      row.verifiedBy = undefined;
      row.verifiedOn = undefined;
    }
    logBenefit(s, actor.id, "Dependent edit", `Updated ${row.name}`);
  });
  if (!result && changed) alertBenefitsHr(actor.id, `Verify dependent · ${actor.fullName}`, `${input.name.trim()} was edited.`);
  return result;
}

export function removeDependent(actor: DemoAccount, id: string): RewardResult {
  return updateReward((s) => {
    const row = s.dependents.find((d) => d.id === id);
    if (!row || row.employeeId !== actor.id) return "You can only remove your own dependents.";
    if (row.coveredPlans.length) return `${row.name} is covered under ${row.coveredPlans.join(", ")}. Remove them from cover first.`;
    s.dependents = s.dependents.filter((d) => d.id !== id);
    logBenefit(s, actor.id, "Dependent remove", `Removed ${row.name}`);
  });
}

export function verifyDependent(actor: DemoAccount, id: string, status: "Verified" | "Rejected"): RewardResult {
  let target: Dependent | undefined;
  const result = updateReward((s) => {
    const row = s.dependents.find((d) => d.id === id);
    if (!row) return "Dependent not found.";
    if (!canDecideBenefitFor(actor, row.employeeId)) return "Only HR can verify dependents (HR's own go to their line manager).";
    if (row.verification === status) return `Already ${status.toLowerCase()}.`;
    if (status === "Rejected" && row.coveredPlans.length) return `${row.name} is covered under a plan. Remove cover first.`;
    row.verification = status;
    row.verifiedBy = actor.fullName;
    row.verifiedOn = todayISO();
    target = { ...row };
  });
  const t = target as Dependent | undefined;
  if (!result && t) {
    pushPersonTaskAlert({ recipientId: t.employeeId, title: `Dependent ${status.toLowerCase()}`, body: `${t.name} was ${status.toLowerCase()} by ${actor.fullName}.`, href: "/benefits" });
  }
  return result;
}

/** Sets which of the employee's verified dependents a plan covers. Only inside a change window. */
export function setPlanDependents(actor: DemoAccount, planId: string, dependentIds: string[]): RewardResult {
  const plan = BENEFIT_PLANS.find((p) => p.id === planId);
  if (!plan) return "Plan not found.";
  if (!plan.coversDependents) return "This plan doesn't cover dependents.";
  return updateReward((s) => {
    const enrollment = s.enrollments.find((e) => e.employeeId === actor.id && e.planId === planId);
    if (!enrollment || (enrollment.status !== "Enrolled" && enrollment.status !== "Pending")) return "Join the plan first.";
    const blocked = windowError(s, actor.id);
    if (blocked) return blocked;
    const mine = s.dependents.filter((d) => d.employeeId === actor.id);
    const wanted = new Set(dependentIds);
    const unverified = mine.find((d) => wanted.has(d.id) && d.verification !== "Verified" && !d.coveredPlans.includes(plan.name));
    if (unverified) return `${unverified.name} must be verified by HR before they can be covered.`;
    const added: string[] = [];
    const removed: string[] = [];
    for (const d of mine) {
      const has = d.coveredPlans.includes(plan.name);
      if (wanted.has(d.id) && !has) {
        d.coveredPlans.push(plan.name);
        added.push(d.name);
      } else if (!wanted.has(d.id) && has) {
        d.coveredPlans = d.coveredPlans.filter((n) => n !== plan.name);
        removed.push(d.name);
      }
    }
    if (!added.length && !removed.length) return "Nothing changed.";
    const parts = [added.length ? `added ${added.join(", ")}` : "", removed.length ? `removed ${removed.join(", ")}` : ""].filter(Boolean);
    logBenefit(s, actor.id, "Dependent cover", `${plan.name}: ${parts.join("; ")}`);
  });
}

/* ── Elections ── */

/** Employee asks to join a plan in their own country (creates a Pending row). */
export function requestEnrollment(actor: DemoAccount, planId: string, dependentIds: string[] = []): RewardResult {
  const plan = BENEFIT_PLANS.find((p) => p.id === planId);
  if (!plan) return "Plan not found.";
  if (plan.country !== actor.countryName) return "You can only enroll in plans for your own country.";
  if (plan.mandatory) return "You are enrolled in this plan automatically.";
  const check = planEligibility(plan, actor.id);
  if (!check.eligible) return `Not eligible: ${check.reason}.`;
  return updateReward((s) => {
    const win = changeWindowFor(s, actor.id);
    if (!win.open) return win.text;
    const existing = s.enrollments.find((e) => e.employeeId === actor.id && e.planId === planId);
    if (existing) {
      if (existing.status === "Pending") return "A request for this plan is already pending.";
      if (existing.status === "Enrolled") return "You are already enrolled in this plan.";
      existing.status = "Pending";
      existing.lifeEventId = win.lifeEventId;
    } else {
      s.enrollments.unshift({
        id: `be-local-${Date.now()}`,
        employeeId: actor.id,
        employeeName: actor.fullName,
        planId: plan.id,
        planName: plan.name,
        country: plan.country,
        status: "Pending",
        effective: todayISO(),
        lifeEventId: win.lifeEventId,
      });
    }
    if (plan.coversDependents && dependentIds.length) {
      const wanted = new Set(dependentIds);
      const mine = s.dependents.filter((d) => d.employeeId === actor.id && wanted.has(d.id));
      const unverified = mine.find((d) => d.verification !== "Verified");
      if (unverified) return `${unverified.name} must be verified by HR before they can be covered.`;
      mine.forEach((d) => d.coveredPlans.includes(plan.name) || d.coveredPlans.push(plan.name));
    }
    logBenefit(s, actor.id, "Enrollment", `Requested ${plan.name}`);
  });
}

export function pendingChangeFor(state: Pick<RewardState, "changeRequests">, enrollmentId: string): BenefitChangeRequest | undefined {
  return state.changeRequests.find((c) => c.enrollmentId === enrollmentId && c.status === "Pending");
}

/** Employee asks HR to change an enrolled plan. The enrollment stays active until HR acts. */
export function requestEnrollmentChange(actor: DemoAccount, enrollmentId: string, note: string): RewardResult {
  return updateReward((s) => {
    const row = s.enrollments.find((e) => e.id === enrollmentId);
    if (!row || row.employeeId !== actor.id) return "You can only change your own enrollments.";
    if (row.status !== "Enrolled") return "Only active enrollments can be changed.";
    if (isMandatoryPlan(row.planId)) return "This is a statutory plan and cannot be changed.";
    const blocked = windowError(s, actor.id);
    if (blocked) return blocked;
    if (pendingChangeFor(s, row.id)) return "A change request for this plan is already with HR.";
    const text = note.trim();
    if (text.length < 5) return "Say what you want to change.";
    s.changeRequests.unshift({
      id: `bcr-${Date.now()}`,
      enrollmentId: row.id,
      employeeId: actor.id,
      employeeName: actor.fullName,
      planName: row.planName,
      note: text.slice(0, 200),
      status: "Pending",
      requestedOn: todayISO(),
    });
  });
}

export function decideChangeRequest(actor: DemoAccount, id: string, status: "Done" | "Declined"): RewardResult {
  return updateReward((s) => {
    const row = s.changeRequests.find((c) => c.id === id);
    if (!row) return "Request not found.";
    if (row.employeeId === actor.id) return "Someone else must handle your own request.";
    if (!canDecideBenefitFor(actor, row.employeeId)) return "Only HR can handle change requests (HR's own go to their line manager).";
    if (row.status !== "Pending") return "This request is already closed.";
    row.status = status;
    row.decidedBy = actor.fullName;
    row.decidedOn = todayISO();
    logBenefit(s, row.employeeId, "Change request", `${row.planName}: ${status === "Done" ? "done" : "declined"}`);
  });
}

/** HR decides a pending enrollment request. */
export function decideEnrollment(
  actor: DemoAccount,
  enrollmentId: string,
  status: "Enrolled" | "Waived",
): RewardResult {
  return updateReward((s) => {
    const row = s.enrollments.find((e) => e.id === enrollmentId);
    if (!row) return "Enrollment not found.";
    if (row.employeeId === actor.id) return "Someone else must decide your own request.";
    if (!canDecideBenefitFor(actor, row.employeeId)) return "Only HR can decide enrollment requests (HR's own go to their line manager).";
    if (row.status !== "Pending") return "Only pending requests can be decided.";
    if (status === "Waived" && isMandatoryPlan(row.planId)) return "Statutory plans cannot be waived.";
    row.status = status;
    if (status === "Enrolled") row.effective = todayISO();
    if (status === "Waived") {
      // Waived plans no longer cover anyone.
      s.dependents.forEach((d) => {
        if (d.employeeId === row.employeeId) d.coveredPlans = d.coveredPlans.filter((n) => n !== row.planName);
      });
    }
    logBenefit(s, row.employeeId, "Enrollment", `${row.planName}: ${status === "Enrolled" ? "enrolled" : "waived"}`);
  });
}

/* ───────────── Letters ───────────── */

const OPEN_LETTER_STATUSES: LetterStatus[] = ["Draft", "Pending approval", "Approved"];

type LetterActor = Pick<DemoAccount, "id" | "fullName" | "role">;

const isLetterHr = (actor: Pick<DemoAccount, "role">) => canManageLetters(actor as DemoAccount);

function isRequester(actor: LetterActor, row: LetterRequest): boolean {
  return row.requestedById ? row.requestedById === actor.id : row.requestedBy === actor.fullName;
}

/**
 * Who may approve a letter: any HR sign-in account other than the subject. When the subject is the
 * only HR account (HR's own letter), the subject's line manager approves instead — never the subject.
 */
export function letterApprovers(row: Pick<LetterRequest, "employeeId">): { id: string; fullName: string }[] {
  const hr = DEMO_ACCOUNTS.filter((a) => isLetterHr(a) && a.id !== row.employeeId);
  if (hr.length) return hr.map((a) => ({ id: a.id, fullName: a.fullName }));
  const manager = managementChain(row.employeeId).find((m) => m.id !== row.employeeId);
  return manager ? [{ id: manager.id, fullName: manager.fullName }] : [];
}

export function canApproveLetter(actor: LetterActor, row: LetterRequest): boolean {
  if (actor.id === row.employeeId) return false;
  return letterApprovers(row).some((a) => a.id === actor.id);
}

/** Salary revision / promotion letters stay hidden from their subject until issued. */
export function canViewLetter(actor: DemoAccount, row: LetterRequest): boolean {
  if (row.employeeId === actor.id) {
    return row.status === "Issued" || !SENSITIVE_LETTER_TYPES.includes(row.type);
  }
  if (isLetterHr(actor)) return true;
  return isRequester(actor, row) || canApproveLetter(actor, row);
}

/** Valid next statuses for this actor. Approval itself goes through approveLetter (it generates the document). */
export function nextLetterStatuses(actor: DemoAccount, row: LetterRequest): LetterStatus[] {
  switch (row.status) {
    case "Draft":
      return isRequester(actor, row) ? ["Pending approval"] : [];
    case "Pending approval":
    case "Approved":
      return canApproveLetter(actor, row) ? ["Approved", "Rejected"] : [];
    default:
      return [];
  }
}

/** Submit a draft or reject a request. Approving is done by approveLetter in letterService. */
export function setLetterStatus(actor: DemoAccount, id: string, status: LetterStatus): RewardResult {
  if (status === "Approved" || status === "Issued") return "Approve the letter to generate it.";
  return updateReward((s) => {
    const row = s.letters.find((l) => l.id === id);
    if (!row) return "Letter request not found.";
    if (!nextLetterStatuses(actor, row).includes(status)) {
      return `You cannot move this letter from ${row.status} to ${status}.`;
    }
    row.status = status;
    if (status === "Rejected") {
      row.approver = actor.fullName;
      row.approverId = actor.id;
      row.decidedOn = todayISO();
    }
  });
}

/** Raw request — also used by exit and probation flows. Checks on who may request what live in letterService. */
export function addLetterRequest(
  actor: LetterActor,
  input: { employeeId: string; employeeName: string; type: LetterType; note: string; details?: string; effectiveDate?: string },
): RewardResult {
  if (input.employeeId !== actor.id && !isLetterHr(actor)) {
    return "You can only request letters for yourself.";
  }
  return updateReward((s) => {
    const open = s.letters.some(
      (l) => l.employeeId === input.employeeId && l.type === input.type && OPEN_LETTER_STATUSES.includes(l.status),
    );
    if (open) return `There is already an open ${input.type} letter request for ${input.employeeName}.`;
    s.letters.unshift({
      id: `ltr-local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      employeeId: input.employeeId,
      employeeName: input.employeeName,
      type: input.type,
      status: "Pending approval",
      requestedBy: actor.fullName,
      requestedById: actor.id,
      requestedOn: todayISO(),
      note: input.note,
      details: input.details?.trim() || undefined,
      effectiveDate: input.effectiveDate || undefined,
      previewBody: `${input.type} letter for ${input.employeeName}. Generated once approved.`,
    });
  });
}

/* ───────────── Document library ───────────── */

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
export const UPLOAD_EXTENSIONS = ["pdf", "png", "jpg", "jpeg", "webp", "txt", "csv"];

export function validateUpload(file: { name: string; size: number }): RewardResult {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!UPLOAD_EXTENSIONS.includes(ext)) {
    return `Unsupported file type. Allowed: ${UPLOAD_EXTENSIONS.join(", ")}.`;
  }
  if (file.size > MAX_UPLOAD_BYTES) return "File is larger than 2 MB.";
  return null;
}

export function addLibraryDoc(doc: Omit<DocLibraryItem, "id" | "uploadedAt">): RewardResult {
  return updateReward((s) => {
    s.library.unshift({
      ...doc,
      id: `dl-local-${Date.now()}`,
      uploadedAt: new Date().toISOString(),
    });
  });
}
