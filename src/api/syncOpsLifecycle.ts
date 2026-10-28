/**
 * Lifecycle actions from the backend (VITE_API_URL mode only), in the shapes lifecycleActionsStore uses.
 * GET /lifecycle/actions (mine, to_decide, all) plus each action's approval instance for the steps.
 */
import type { ApprovalStepRole } from "../data/approvalWorkflows.ts";
import { getPerson } from "../data/peopleLocal.ts";
import type {
  ActionGroup,
  ActionStep,
  JobValues,
  LifecycleAction,
  LifecycleActionStatus,
  LifecycleActionType,
  RaiseInput,
} from "../features/lifecycle/lifecycleActionsStore.ts";
import { api } from "./client.ts";
import { createApiMirror, errorText } from "./syncOps.ts";

interface LifecycleActionOut {
  id: string;
  employee_id: string;
  employee_name: string | null;
  action_type: string;
  effective_date: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  reason: string;
  status: string;
  requested_by: string;
  approval_instance_id: string | null;
  approval_status: string | null;
  current_step: number | null;
  applied_at: string | null;
  created_at: string;
}

interface ApprovalInstanceOut {
  id: string;
  steps: { roles: string[]; mode: "any" | "all"; groups: Record<string, string[]>; skipped: boolean }[];
  current_step: number;
  status: string;
  decisions: { step: number; group: string; approver_id: string; decision: string; note: string | null; at: string }[];
}

export interface AssignmentOut {
  id: number;
  employee_id: string;
  effective_from: string;
  effective_to: string | null;
  manager_id: string | null;
  manager_name: string | null;
  job_title: string;
  grade: string;
  department: string;
  location: string;
  legal_entity: string;
  employment_status: string;
}

const TYPE_TO_API: Record<LifecycleActionType, string> = {
  Transfer: "transfer",
  Promotion: "promotion",
  "Job change": "job_change",
  "Manager change": "manager_change",
  "Location change": "location_change",
  "Leave of absence": "leave_of_absence",
  "Return from leave": "return_from_leave",
  "Contract extension": "contract_extension",
  "Probation completion": "probation_completion",
  Rehire: "rehire",
};
const TYPE_FROM_API = Object.fromEntries(Object.entries(TYPE_TO_API).map(([k, v]) => [v, k])) as Record<string, LifecycleActionType>;

const STATUS: Record<string, LifecycleActionStatus> = {
  submitted: "Pending",
  scheduled: "Scheduled",
  applied: "Applied",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

const ROLE_LABEL: Record<string, string> = {
  manager: "Manager approval",
  skip_manager: "Skip-level approval",
  hr: "HR approval",
  finance: "Finance approval",
  admin: "Admin approval",
  executive: "Executive approval",
};

function nameOf(id: string | undefined | null): string {
  return id ? (getPerson(id)?.fullName ?? id) : "";
}

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

function jobValues(raw: Record<string, unknown>, base?: JobValues): JobValues {
  const pick = (key: string, fallback: string | undefined) => (key in raw ? str(raw[key]) : (fallback ?? ""));
  const managerId = pick("manager_id", base?.managerId);
  return {
    department: pick("department", base?.department),
    location: pick("location", base?.location),
    countryCode: pick("country_code", base?.countryCode),
    designation: pick("job_title", base?.designation),
    grade: pick("grade", base?.grade),
    managerId,
    managerName: "manager_id" in raw ? nameOf(managerId) : (base?.managerName ?? nameOf(managerId)),
    jobProfileId: base?.jobProfileId ?? "",
    employmentStatus: ("employment_status" in raw ? str(raw.employment_status) : base?.employmentStatus) as JobValues["employmentStatus"],
    contractEndDate: pick("contract_end_date", base?.contractEndDate),
    confirmationDate: pick("probation_end_date", base?.confirmationDate),
  };
}

function stepsOf(inst: ApprovalInstanceOut | undefined): ActionStep[] {
  if (!inst) return [];
  const out: ActionStep[] = [];
  inst.steps.forEach((s, i) => {
    if (s.skipped) return;
    const decisions = inst.decisions.filter((d) => d.step === i);
    const groups: ActionGroup[] = Object.entries(s.groups)
      .filter(([, ids]) => ids.length)
      .map(([role, ids]) => {
        const d = decisions.find((x) => x.group === role);
        return {
          role: role as ApprovalStepRole,
          label: ROLE_LABEL[role] ?? role,
          approverIds: ids,
          ...(d
            ? { decision: d.decision === "approve" ? ("Approved" as const) : ("Rejected" as const), byId: d.approver_id, by: nameOf(d.approver_id), on: d.at.slice(0, 10), note: d.note ?? undefined }
            : {}),
        };
      });
    const rejected = decisions.find((d) => d.decision !== "approve");
    const approvedGroups = groups.filter((g) => g.decision === "Approved");
    const done = rejected || (s.mode === "any" ? approvedGroups.length > 0 : groups.length > 0 && approvedGroups.length === groups.length) || (inst.status === "approved" && i < inst.steps.length);
    const last = rejected ?? decisions[decisions.length - 1];
    const step: ActionStep = {
      role: (groups[0]?.role ?? s.roles[0]) as ApprovalStepRole,
      label: groups.length > 1 ? groups.map((g) => g.label.replace(/ approval$/, "")).join(" + ") + " approval" : (groups[0]?.label ?? ROLE_LABEL[s.roles[0]] ?? s.roles[0]),
      approverIds: [...new Set(groups.flatMap((g) => g.approverIds))],
      ...(groups.length > 1 ? { mode: s.mode, groups } : {}),
      ...(done && last
        ? { decision: rejected ? ("Rejected" as const) : ("Approved" as const), byId: last.approver_id, by: nameOf(last.approver_id), on: last.at.slice(0, 10), note: last.note ?? undefined }
        : {}),
    };
    out.push(step);
  });
  return out;
}

function toAction(a: LifecycleActionOut, inst: ApprovalInstanceOut | undefined): LifecycleAction {
  const before = jobValues(a.before);
  const after = jobValues(a.after, before);
  const type = TYPE_FROM_API[a.action_type] ?? "Transfer";
  const status = STATUS[a.status] ?? "Pending";
  const leaveEnd = str(a.after.leave_end_date);
  return {
    id: a.id,
    employeeId: a.employee_id,
    employeeName: a.employee_name ?? nameOf(a.employee_id),
    type,
    effectiveDate: a.effective_date,
    reason: a.reason,
    before,
    after,
    raisedById: a.requested_by,
    raisedBy: nameOf(a.requested_by),
    raisedOn: a.created_at.slice(0, 10),
    steps: stepsOf(inst),
    status,
    ...(a.applied_at ? { appliedOn: a.applied_at.slice(0, 10) } : {}),
    ...(type === "Leave of absence" ? { leave: { type: "Leave of absence", start: a.effective_date, end: leaveEnd || a.effective_date } } : {}),
  };
}

async function loadActions(): Promise<LifecycleAction[]> {
  const lists = await Promise.all(
    (["mine", "to_decide", "all"] as const).map((view) =>
      api.get<LifecycleActionOut[]>("/lifecycle/actions", { view, limit: 500 }).catch(() => [] as LifecycleActionOut[]),
    ),
  );
  const byId = new Map<string, LifecycleActionOut>();
  for (const list of lists) for (const a of list) byId.set(a.id, a);
  const rows = [...byId.values()];
  const instances = new Map<string, ApprovalInstanceOut>();
  await Promise.all(
    rows
      .filter((a) => a.approval_instance_id)
      .map((a) =>
        api
          .get<ApprovalInstanceOut>(`/approvals/${encodeURIComponent(a.approval_instance_id!)}`)
          .then((inst) => instances.set(a.id, inst))
          .catch(() => undefined),
      ),
  );
  return rows
    .map((a) => toAction(a, instances.get(a.id)))
    .sort((x, y) => y.raisedOn.localeCompare(x.raisedOn) || y.id.localeCompare(x.id));
}

export const lifecycleMirror = createApiMirror<LifecycleAction[]>(() => [], loadActions);

/** The `after` body for POST /lifecycle/actions: only fields that change, plus the ones the type requires. */
function afterFor(input: RaiseInput): { after: Record<string, unknown>; reason: string } | string {
  const person = getPerson(input.employeeId);
  if (!person) return "Choose an employee.";
  const after: Record<string, unknown> = {};
  const set = (key: string, value: string | undefined, current: string, required = false) => {
    const v = (value ?? "").trim();
    if (v && (required || v !== current)) after[key] = v;
  };
  let reason = input.reason.trim();
  switch (input.type) {
    case "Transfer":
      set("department", input.department, person.department);
      set("location", input.location, person.location);
      if (input.countryCode && input.countryCode !== String(person.countryCode)) after.country_code = input.countryCode;
      set("manager_id", input.managerId, person.managerId || "");
      break;
    case "Promotion":
      set("job_title", input.designation, person.designation);
      set("grade", input.grade, person.grade, true);
      break;
    case "Job change":
      set("job_title", input.designation, person.designation, true);
      set("grade", input.grade, person.grade);
      break;
    case "Manager change":
      set("manager_id", input.managerId, person.managerId || "", true);
      break;
    case "Location change":
      set("location", input.location, person.location, true);
      if (input.countryCode && input.countryCode !== String(person.countryCode)) after.country_code = input.countryCode;
      break;
    case "Leave of absence":
      if (input.leaveEnd) after.leave_end_date = input.leaveEnd;
      if (input.leaveType) reason = `${input.leaveType} leave. ${reason}`;
      break;
    case "Contract extension":
      set("contract_end_date", input.contractEndDate, person.contractEndDate || "", true);
      break;
    case "Probation completion":
      after.probation_end_date = input.effectiveDate;
      break;
    case "Rehire":
      set("job_title", input.designation, person.designation);
      set("grade", input.grade, person.grade);
      set("department", input.department, person.department);
      set("location", input.location, person.location);
      set("manager_id", input.managerId, person.managerId || "");
      break;
    default:
      break;
  }
  return { after, reason };
}

async function run(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return errorText(e);
  } finally {
    await lifecycleMirror.reload();
  }
}

export function apiRaiseLifecycleAction(input: RaiseInput): Promise<string | null> {
  if (!input.employeeId) return Promise.resolve("Choose an employee.");
  if (!input.reason.trim()) return Promise.resolve("Give a reason.");
  const body = afterFor(input);
  if (typeof body === "string") return Promise.resolve(body);
  return run(() =>
    api.post("/lifecycle/actions", {
      employee_id: input.employeeId,
      action_type: TYPE_TO_API[input.type],
      effective_date: input.effectiveDate,
      after: body.after,
      reason: body.reason,
    }),
  );
}

export function apiDecideLifecycleAction(id: string, decision: "approve" | "reject", note: string): Promise<string | null> {
  if (decision === "reject" && !note.trim()) return Promise.resolve("Add a note explaining the rejection.");
  return run(() => api.post(`/lifecycle/actions/${encodeURIComponent(id)}/decision`, { decision, note: note.trim() || null }));
}

export function apiWithdrawLifecycleAction(id: string): Promise<string | null> {
  return run(() => api.post(`/lifecycle/actions/${encodeURIComponent(id)}/withdraw`));
}

/** Effective-dated job history for one person, newest first. */
export function loadAssignmentHistory(personId: string): Promise<AssignmentOut[]> {
  return api.get<AssignmentOut[]>(`/people/${encodeURIComponent(personId)}/history`);
}
