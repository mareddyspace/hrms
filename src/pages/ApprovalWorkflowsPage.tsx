import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Banner, Card, DataTable, EmptyState, Field, Page, Tabs } from "../components/ui.tsx";
import { usePortal } from "../store.tsx";
import { formatShortDate } from "../model.ts";
import {
  AMOUNT_TYPES,
  DEFAULT_WORKFLOWS,
  LINE_FROM_REQUESTER,
  PERCENT_TYPES,
  STEP_ROLES,
  WORKFLOW_TYPES,
  approversForRole,
  roleLabel,
  saveApprovalSteps,
  stepDefaultLabel,
  stepRoles,
  useWorkflowRecords,
  type ApprovalStep,
  type ApprovalStepRole,
  type ParallelMode,
  type WorkflowType,
  type WorkflowVersion,
} from "../data/approvalWorkflows.ts";
import { compensationStats, expenseStats, lifecycleStats, requisitionStats, travelStats } from "../data/workflowAnalytics.ts";
import { useTravelRequests } from "../data/travelStore.ts";
import { getLifecycleActions, subscribeLifecycleActions } from "../features/lifecycle/lifecycleActionsStore.ts";
import { getTalentState, subscribeTalent } from "../data/talentLocal.ts";
import { getRewardState, subscribeReward, type CompProposal } from "../data/rewardLocal.ts";

const ADMIN_ROLES = ["admin", "super_admin"];
const MAX_STEPS = 6;

const typeLabel = (type: WorkflowType) => WORKFLOW_TYPES.find((w) => w.id === type)?.label ?? type;
const changedText = (v: WorkflowVersion) =>
  `Version ${v.version}${v.changedBy ? ` · changed by ${v.changedBy}` : ""}${v.changedOn ? ` on ${formatShortDate(v.changedOn.slice(0, 10))}` : v.version === 1 ? " · default" : ""}`;

/** "Manager → HR + Finance (all) → Executive from 10%". */
function stepsSummary(steps: ApprovalStep[]): string {
  if (!steps.length) return "Approved on submit";
  return steps
    .map((s) => {
      const roles = stepRoles(s);
      const who = roles.length > 1 ? `${roles.map(roleLabel).join(s.mode === "any" ? " or " : " + ")}` : s.label;
      const when = [s.minAmount ? `from ${s.minAmount}` : "", s.minPercent ? `from ${s.minPercent}%` : ""].filter(Boolean).join(", ");
      return when ? `${who} (${when})` : who;
    })
    .join(" → ");
}

/** Admin: choose who approves each request type, in what order, and which steps run in parallel. */
export function ApprovalWorkflowsPage() {
  const { demoProfile, demoAccounts, state } = usePortal();
  const records = useWorkflowRecords();
  const [type, setType] = useState<WorkflowType>("expense");
  const record = records[type];
  const [draft, setDraft] = useState<ApprovalStep[]>(record.steps);
  const [previewId, setPreviewId] = useState("emp-mahesh");
  const [previewAmount, setPreviewAmount] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const travel = useTravelRequests();
  const lifecycle = useSyncExternalStore(subscribeLifecycleActions, getLifecycleActions, getLifecycleActions);
  const talent = useSyncExternalStore(subscribeTalent, getTalentState, getTalentState);
  const reward = useSyncExternalStore(subscribeReward, getRewardState, getRewardState);
  const stats = useMemo(
    () => [
      expenseStats(state.expenses),
      travelStats(travel),
      lifecycleStats(lifecycle),
      requisitionStats(talent.requisitions),
      compensationStats(reward.reviews as CompProposal[]),
    ],
    [state.expenses, travel, lifecycle, talent.requisitions, reward.reviews],
  );

  useEffect(() => {
    setDraft(record.steps);
  }, [type, record]);

  if (!ADMIN_ROLES.includes(demoProfile.role)) {
    return (
      <Page title="Approval steps">
        <EmptyState title="Admins only" description="Ask an admin to change approval steps." />
      </Page>
    );
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(record.steps);
  const update = (index: number, patch: Partial<ApprovalStep>) =>
    setDraft((steps) => steps.map((step, i) => (i === index ? { ...step, ...patch } : step)));
  const move = (index: number, by: -1 | 1) =>
    setDraft((steps) => {
      const next = [...steps];
      const target = index + by;
      if (target < 0 || target >= next.length) return steps;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });

  /** Change a step's approver roles (or parallel mode), keeping an auto-generated name in step. */
  function setRoles(index: number, roles: ApprovalStepRole[], mode: ParallelMode) {
    const step = draft[index]!;
    if (!roles.length) return;
    const oldRoles = stepRoles(step);
    const autoLabel =
      step.label === stepDefaultLabel(oldRoles, step.mode ?? "all") || step.label === `${roleLabel(step.role)} approval` || !step.label.trim();
    const next: ApprovalStep = { role: roles[0]!, label: autoLabel ? stepDefaultLabel(roles, mode) : step.label };
    if (roles.length > 1) {
      next.roles = roles;
      next.mode = mode;
    }
    if (step.minAmount !== undefined) next.minAmount = step.minAmount;
    if (step.minPercent !== undefined) next.minPercent = step.minPercent;
    setDraft((steps) => steps.map((s, i) => (i === index ? next : s)));
  }

  function save() {
    if (draft.some((step) => !step.label.trim())) {
      setMessage({ tone: "err", text: "Every step needs a name." });
      return;
    }
    if (draft.some((step) => (step.minAmount !== undefined && !(step.minAmount > 0)) || (step.minPercent !== undefined && !(step.minPercent > 0)))) {
      setMessage({ tone: "err", text: "Minimum amounts and percents must be above zero." });
      return;
    }
    saveApprovalSteps(type, draft, { id: demoProfile.id, fullName: demoProfile.fullName });
    setMessage({ tone: "ok", text: `Saved as version ${record.version + 1}. New requests use it.` });
  }

  const showAmount = AMOUNT_TYPES.includes(type);
  const showPercent = PERCENT_TYPES.includes(type);
  const lineFromSelf = LINE_FROM_REQUESTER.includes(type);
  const value = Number(previewAmount) || 0;
  const previewSteps = draft
    .filter((step) => (step.minAmount === undefined || (showAmount && value >= step.minAmount)) && (step.minPercent === undefined || (showPercent && value >= step.minPercent)))
    .map((step) => ({
      step,
      groups: stepRoles(step).map((role) => ({ role, ids: approversForRole(role, previewId, demoAccounts, lineFromSelf) })),
    }));
  const nameOf = (id: string) => demoAccounts.find((a) => a.id === id)?.fullName ?? id;

  return (
    <Page title="Approval steps">
      <Tabs
        tabs={WORKFLOW_TYPES.map((w) => ({ id: w.id, label: w.label }))}
        value={type}
        onChange={(next) => {
          setType(next as WorkflowType);
          setMessage(null);
        }}
      />
      <Banner message={message} />
      <p className="muted">{changedText(record)}</p>
      <div className="split">
        <Card title="Steps, in order">
          {draft.length === 0 ? (
            <p className="empty">No steps: requests are approved as soon as they're raised.</p>
          ) : (
            <ol className="approval-list" style={{ paddingLeft: 0 }}>
              {draft.map((step, index) => {
                const roles = stepRoles(step);
                const mode = step.mode ?? "all";
                return (
                  <li key={index} className="approval-item">
                    <div className="row-between">
                      <strong>
                        Step {index + 1}
                        {roles.length > 1 ? ` · parallel (${mode === "any" ? "any one" : "all"})` : ""}
                      </strong>
                      <span style={{ display: "inline-flex", gap: 6 }}>
                        <button type="button" className="btn-ghost btn-tiny" disabled={index === 0} onClick={() => move(index, -1)} aria-label="Move up">
                          ↑
                        </button>
                        <button
                          type="button"
                          className="btn-ghost btn-tiny"
                          disabled={index === draft.length - 1}
                          onClick={() => move(index, 1)}
                          aria-label="Move down"
                        >
                          ↓
                        </button>
                        <button type="button" className="btn-ghost btn-tiny" onClick={() => setDraft((s) => s.filter((_, i) => i !== index))}>
                          Remove
                        </button>
                      </span>
                    </div>
                    <div className="form-grid">
                      <Field label="Approvers">
                        <span style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px" }}>
                          {STEP_ROLES.map((r) => (
                            <label key={r.id} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontWeight: 400 }}>
                              <input
                                type="checkbox"
                                checked={roles.includes(r.id)}
                                disabled={roles.length === 1 && roles[0] === r.id}
                                onChange={(e) =>
                                  setRoles(index, e.target.checked ? [...roles, r.id] : roles.filter((x) => x !== r.id), mode)
                                }
                              />
                              {r.label}
                            </label>
                          ))}
                        </span>
                      </Field>
                      {roles.length > 1 && (
                        <Field label="Who must approve">
                          <select value={mode} onChange={(e) => setRoles(index, roles, e.target.value as ParallelMode)}>
                            <option value="all">All of them</option>
                            <option value="any">Any one of them</option>
                          </select>
                        </Field>
                      )}
                      <Field label="Step name">
                        <input value={step.label} onChange={(e) => update(index, { label: e.target.value })} />
                      </Field>
                      {showAmount && (
                        <Field label="Only from amount (optional)">
                          <input
                            type="number"
                            min={1}
                            value={step.minAmount ?? ""}
                            placeholder="Always"
                            onChange={(e) => update(index, { minAmount: e.target.value ? Number(e.target.value) : undefined })}
                          />
                        </Field>
                      )}
                      {showPercent && (
                        <Field label="Only from increase % (optional)">
                          <input
                            type="number"
                            min={0.1}
                            step={0.1}
                            value={step.minPercent ?? ""}
                            placeholder="Always"
                            onChange={(e) => update(index, { minPercent: e.target.value ? Number(e.target.value) : undefined })}
                          />
                        </Field>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          <div className="form-actions">
            <button
              type="button"
              className="btn-ghost"
              disabled={draft.length >= MAX_STEPS}
              onClick={() => setDraft((s) => [...s, { role: "manager", label: "Manager approval" }])}
            >
              Add step
            </button>
            <button type="button" className="btn-ghost" onClick={() => setDraft(DEFAULT_WORKFLOWS[type])}>
              Reset to default
            </button>
            <button type="button" className="btn" disabled={!dirty} onClick={save}>
              Save
            </button>
          </div>
          <p className="muted">
            Requests already raised keep the steps they started with. Parallel steps: tick more than one approver.
            {lineFromSelf ? " Here “Manager” is the hiring manager, so the department head is “Manager's manager”." : ""}
          </p>
        </Card>
        <Card title="Who would approve">
          <div className="form-grid">
            <Field label={lineFromSelf ? "Hiring manager" : type === "compensation" ? "Employee" : "Requested by"}>
              <select value={previewId} onChange={(e) => setPreviewId(e.target.value)}>
                {demoAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.fullName} · {a.personaLabel}
                  </option>
                ))}
              </select>
            </Field>
            {(showAmount || showPercent) && (
              <Field label={showPercent ? "Increase %" : "Amount"}>
                <input type="number" min={0} value={previewAmount} onChange={(e) => setPreviewAmount(e.target.value)} />
              </Field>
            )}
          </div>
          <ol className="profile-timeline" style={{ marginTop: 12 }}>
            {previewSteps.length === 0 && (
              <li>
                <strong>Approved on submit</strong>
              </li>
            )}
            {previewSteps.map(({ step, groups }, index) => {
              const any = groups.some((g) => g.ids.length);
              return (
                <li key={index} className={any ? undefined : "is-education"}>
                  <strong>
                    {step.label}
                    {groups.length > 1 ? ` · ${step.mode === "any" ? "any one" : "all"}` : ""}
                  </strong>
                  <span>
                    {!any
                      ? "No one — step is skipped"
                      : groups.length > 1
                        ? groups.map((g) => `${roleLabel(g.role)}: ${g.ids.length ? g.ids.map(nameOf).join(", ") : "no one (skipped)"}`).join(" · ")
                        : groups[0]!.ids.map(nameOf).join(", ")}
                  </span>
                </li>
              );
            })}
          </ol>
        </Card>
      </div>
      <div className="split">
        <Card title="Version history">
          <p className="muted">
            Now: {changedText(record)} · {stepsSummary(record.steps)}
          </p>
          {record.history.length === 0 ? (
            <p className="empty">No earlier versions.</p>
          ) : (
            <ul className="todo">
              {record.history.map((v) => (
                <li key={v.version}>
                  <div className="row-between">
                    <span>
                      <strong>{changedText(v)}</strong>
                      <br />
                      <span className="muted">{stepsSummary(v.steps)}</span>
                    </span>
                    <button type="button" className="btn-ghost btn-tiny" onClick={() => setDraft(v.steps)}>
                      Load
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Workflow analytics">
          <DataTable
            headers={["Workflow", "In flight", "Avg approval", "Slowest step"]}
            rows={stats.map((s) => [
              typeLabel(s.type),
              String(s.inFlight),
              s.avgDays === null ? "—" : `${s.avgDays} d (${s.completed})`,
              s.slowestStep ? `${s.slowestStep.label} · ${s.slowestStep.avgDays} d` : "—",
            ])}
          />
          <p className="muted">Days from raised to final approval; step time from the previous step.</p>
        </Card>
      </div>
    </Page>
  );
}
