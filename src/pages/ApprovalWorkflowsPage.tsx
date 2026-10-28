import { useEffect, useState } from "react";
import { Banner, Card, EmptyState, Field, Page, Tabs } from "../components/ui.tsx";
import { usePortal } from "../store.tsx";
import {
  DEFAULT_WORKFLOWS,
  STEP_ROLES,
  WORKFLOW_TYPES,
  approversForStep,
  roleLabel,
  saveApprovalSteps,
  useApprovalWorkflows,
  type ApprovalStep,
  type ApprovalStepRole,
  type WorkflowType,
} from "../data/approvalWorkflows.ts";

const ADMIN_ROLES = ["admin", "super_admin"];
const MAX_STEPS = 6;

/** Admin: choose who approves expense claims, travel requests and lifecycle changes, and in what order. */
export function ApprovalWorkflowsPage() {
  const { demoProfile, demoAccounts } = usePortal();
  const workflows = useApprovalWorkflows();
  const [type, setType] = useState<WorkflowType>("expense");
  const [draft, setDraft] = useState<ApprovalStep[]>(workflows[type]);
  const [previewId, setPreviewId] = useState("emp-mahesh");
  const [previewAmount, setPreviewAmount] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    setDraft(workflows[type]);
  }, [type, workflows]);

  if (!ADMIN_ROLES.includes(demoProfile.role)) {
    return (
      <Page title="Approval steps">
        <EmptyState title="Admins only" description="Ask an admin to change approval steps." />
      </Page>
    );
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(workflows[type]);
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

  function save() {
    if (draft.some((step) => !step.label.trim())) {
      setMessage({ tone: "err", text: "Every step needs a name." });
      return;
    }
    if (draft.some((step) => step.minAmount !== undefined && !(step.minAmount > 0))) {
      setMessage({ tone: "err", text: "Minimum amounts must be above zero." });
      return;
    }
    saveApprovalSteps(type, draft);
    setMessage({ tone: "ok", text: "Approval steps saved. New requests use them." });
  }

  const amount = Number(previewAmount) || 0;
  const previewSteps = draft
    .filter((step) => step.minAmount === undefined || amount >= step.minAmount)
    .map((step) => ({ step, ids: approversForStep(step, previewId) }));
  const nameOf = (id: string) => demoAccounts.find((a) => a.id === id)?.fullName ?? id;
  const showAmount = type !== "lifecycle";

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
      <div className="split">
        <Card title="Steps, in order">
          {draft.length === 0 ? (
            <p className="empty">No steps: requests are approved as soon as they're raised.</p>
          ) : (
            <ol className="approval-list" style={{ paddingLeft: 0 }}>
              {draft.map((step, index) => (
                <li key={index} className="approval-item">
                  <div className="row-between">
                    <strong>Step {index + 1}</strong>
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
                    <Field label="Approver">
                      <select
                        value={step.role}
                        onChange={(e) => {
                          const role = e.target.value as ApprovalStepRole;
                          const autoLabel = step.label === `${roleLabel(step.role)} approval`;
                          update(index, { role, ...(autoLabel ? { label: `${roleLabel(role)} approval` } : {}) });
                        }}
                      >
                        {STEP_ROLES.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    </Field>
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
                  </div>
                </li>
              ))}
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
          <p className="muted">Requests already raised keep the steps they started with.</p>
        </Card>
        <Card title="Who would approve">
          <div className="form-grid">
            <Field label="Requested by">
              <select value={previewId} onChange={(e) => setPreviewId(e.target.value)}>
                {demoAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.fullName} · {a.personaLabel}
                  </option>
                ))}
              </select>
            </Field>
            {showAmount && (
              <Field label="Amount">
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
            {previewSteps.map(({ step, ids }, index) => (
              <li key={index} className={ids.length ? undefined : "is-education"}>
                <strong>{step.label}</strong>
                <span>{ids.length ? ids.map(nameOf).join(", ") : "No one — step is skipped"}</span>
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </Page>
  );
}
