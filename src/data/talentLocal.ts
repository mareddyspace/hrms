import {
  CANDIDATES,
  ENROLLMENTS,
  INTERVIEWS,
  OFFERS,
  ONBOARDING_JOINERS,
  ONBOARDING_TASKS,
  PERF_GOALS,
  PERF_REVIEWS,
  REQUISITIONS,
  type Candidate,
  type Enrollment,
  type Interview,
  type OfferRecord,
  type OnboardingJoiner,
  type OnboardingTask,
  type PerfGoal,
  type PerfReview,
  type PipelineStage,
  type Requisition,
} from "./talentData.ts";

const KEY = "timez.talent.state.v1";

type TalentState = {
  requisitions: Requisition[];
  candidates: Candidate[];
  interviews: Interview[];
  offers: OfferRecord[];
  joiners: OnboardingJoiner[];
  tasks: OnboardingTask[];
  goals: PerfGoal[];
  reviews: PerfReview[];
  enrollments: Enrollment[];
};

function defaults(): TalentState {
  return {
    requisitions: structuredClone(REQUISITIONS),
    candidates: structuredClone(CANDIDATES),
    interviews: structuredClone(INTERVIEWS),
    offers: structuredClone(OFFERS),
    joiners: structuredClone(ONBOARDING_JOINERS),
    tasks: structuredClone(ONBOARDING_TASKS),
    goals: structuredClone(PERF_GOALS),
    reviews: structuredClone(PERF_REVIEWS),
    enrollments: structuredClone(ENROLLMENTS),
  };
}

function read(): TalentState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    return { ...defaults(), ...JSON.parse(raw) };
  } catch {
    return defaults();
  }
}

function write(state: TalentState) {
  localStorage.setItem(KEY, JSON.stringify(state));
  listeners.forEach((fn) => fn());
}

const listeners = new Set<() => void>();

export function subscribeTalent(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getTalentState(): TalentState {
  return read();
}

export function updateTalent(mutator: (state: TalentState) => void) {
  const state = read();
  mutator(state);
  write(state);
}

export function setCandidateStage(id: string, stage: PipelineStage) {
  updateTalent((s) => {
    const row = s.candidates.find((c) => c.id === id);
    if (row) row.stage = stage;
  });
}

export function submitInterviewFeedback(id: string, score: number, feedback: string) {
  updateTalent((s) => {
    const row = s.interviews.find((i) => i.id === id);
    if (row) {
      row.feedbackStatus = "Submitted";
      row.score = score;
      row.feedback = feedback;
    }
  });
}

export function setOfferStatus(id: string, status: OfferRecord["status"]) {
  updateTalent((s) => {
    const row = s.offers.find((o) => o.id === id);
    if (row) {
      row.status = status;
      if (status === "Sent" && !row.sentOn) row.sentOn = new Date().toISOString().slice(0, 10);
    }
  });
}

export function setRequisitionApproval(id: string, approvalStatus: Requisition["approvalStatus"]) {
  updateTalent((s) => {
    const row = s.requisitions.find((r) => r.id === id);
    if (row) row.approvalStatus = approvalStatus;
  });
}

export function setOnboardingTaskStatus(id: string, status: OnboardingTask["status"]) {
  updateTalent((s) => {
    const row = s.tasks.find((t) => t.id === id);
    if (row) row.status = status;
  });
}

export function setJoinerPolicyAck(id: string, policyAck: OnboardingJoiner["policyAck"]) {
  updateTalent((s) => {
    const row = s.joiners.find((j) => j.id === id);
    if (row) row.policyAck = policyAck;
  });
}

export function updateGoalProgress(id: string, progress: number) {
  updateTalent((s) => {
    const row = s.goals.find((g) => g.id === id);
    if (row) row.progress = Math.max(0, Math.min(100, progress));
  });
}

export function updateReview(
  id: string,
  patch: Partial<Pick<PerfReview, "selfStatus" | "managerStatus" | "feedback360Status" | "rating" | "developmentPlan">>,
) {
  updateTalent((s) => {
    const row = s.reviews.find((r) => r.id === id);
    if (row) Object.assign(row, patch);
  });
}

export function updateEnrollmentProgress(id: string, progress: number) {
  updateTalent((s) => {
    const row = s.enrollments.find((e) => e.id === id);
    if (!row) return;
    row.progress = Math.max(0, Math.min(100, progress));
    if (row.progress >= 100) {
      row.status = "Completed";
      row.completedOn = new Date().toISOString().slice(0, 10);
    } else if (row.progress > 0) row.status = "In progress";
  });
}

export function enrollInCourse(courseId: string, employeeId: string, employeeName: string) {
  updateTalent((s) => {
    if (s.enrollments.some((e) => e.courseId === courseId && e.employeeId === employeeId)) return;
    s.enrollments.push({
      id: `en-local-${Date.now()}`,
      courseId,
      employeeId,
      employeeName,
      status: "Assigned",
      progress: 0,
    });
  });
}

export function resetTalentState() {
  localStorage.removeItem(KEY);
  listeners.forEach((fn) => fn());
}
