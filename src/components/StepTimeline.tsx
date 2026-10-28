import { formatShortDate } from "../model.ts";
import type { DecisionInfo } from "../model.ts";
import { isAllParallel, type SavedDecision, type SavedStep } from "../data/expenseFlow.ts";

type Props = {
  status: string;
  submittedOn?: string;
  steps?: SavedStep[];
  currentStep?: number;
  stepDecisions?: SavedDecision[];
  decided?: DecisionInfo;
  /** Show a final "Paid" stage (expense claims). */
  paid?: { show: boolean; on?: string; by?: string; reference?: string };
  nameOf?: (id: string) => string;
};

const dated = (iso?: string) => (iso ? formatShortDate(iso) : "");

type Row = { key: string; title: string; detail: string; done: boolean; sub?: boolean };

const decidedText = (d: SavedDecision) => `${d.byName} · ${dated(d.on)}${d.note ? ` · “${d.note}”` : ""}`;

/**
 * Submitted → each approval step → Approved (→ Paid), with who decided and when. A parallel step lists each
 * approver group under it ("all of" or "any of").
 */
export function StepTimeline({ status, submittedOn, steps, currentStep = 0, stepDecisions = [], decided, paid, nameOf }: Props) {
  const rows: Row[] = [];
  rows.push({ key: "sub", title: "Submitted", detail: dated(submittedOn), done: true });
  const closed = status === "rejected" || status === "withdrawn";
  const names = (ids: string[]) => (nameOf ? ids.map(nameOf).join(", ") : "");

  if (steps?.length) {
    steps.forEach((step, index) => {
      if (isAllParallel(step)) {
        const forStep = stepDecisions.filter((x) => x.step === index);
        const rejected = forStep.find((x) => x.decision === "rejected");
        const allDone = step.groups.every((_, g) => forStep.some((x) => x.group === g && x.decision === "approved"));
        if (closed && !forStep.length) return;
        rows.push({
          key: `s${index}`,
          title: `${step.label}${rejected ? " · declined" : allDone ? " · approved" : ""}`,
          detail: index === currentStep && !closed && !allDone ? "Waiting · all must approve" : "All must approve",
          done: allDone || !!rejected,
        });
        step.groups.forEach((group, g) => {
          const d = forStep.find((x) => x.group === g);
          if (d) {
            rows.push({ key: `s${index}g${g}`, title: `${group.label} · ${d.decision === "approved" ? "approved" : "declined"}`, detail: decidedText(d), done: true, sub: true });
          } else if (!closed) {
            const who = names(group.approverIds);
            rows.push({ key: `s${index}g${g}`, title: group.label, detail: index === currentStep ? `Waiting${who ? ` · ${who}` : ""}` : who, done: false, sub: true });
          }
        });
        return;
      }
      const d = stepDecisions.find((x) => x.step === index);
      const anyOf = step.groups && step.groups.length > 1 ? ` (any of ${step.groups.map((g) => g.label.replace(/ approval$/, "")).join(", ")})` : "";
      if (d) {
        rows.push({
          key: `s${index}`,
          title: `${step.label} · ${d.decision === "approved" ? "approved" : "declined"}`,
          detail: decidedText(d),
          done: true,
        });
      } else if (!closed) {
        const who = names(step.approverIds);
        rows.push({
          key: `s${index}`,
          title: `${step.label}${anyOf}`,
          detail: index === currentStep ? `Waiting${who ? ` · ${who}` : ""}` : who,
          done: false,
        });
      }
    });
  } else if (decided?.decidedByName && status !== "withdrawn") {
    rows.push({
      key: "dec",
      title: status === "rejected" ? "Declined" : "Approved",
      detail: `${decided.decidedByName} · ${dated(decided.decidedOn)}${decided.decisionNote ? ` · “${decided.decisionNote}”` : ""}`,
      done: true,
    });
  }

  if (status === "withdrawn") rows.push({ key: "wd", title: "Withdrawn", detail: "", done: true });
  else if (status !== "rejected") {
    const approved = status === "approved" || status === "paid";
    if (steps?.length || !approved) rows.push({ key: "ap", title: "Approved", detail: approved ? dated(decided?.decidedOn) : "", done: approved });
    if (paid?.show) {
      rows.push({
        key: "paid",
        title: "Paid",
        detail: status === "paid" ? [dated(paid.on), paid.reference ? `ref ${paid.reference}` : "", paid.by ?? ""].filter(Boolean).join(" · ") : "",
        done: status === "paid",
      });
    }
  }

  return (
    <ol className="profile-timeline" style={{ marginTop: 6 }}>
      {rows.map((row) => (
        <li
          key={row.key}
          className={row.done ? undefined : "is-education"}
          style={{ ...(row.done ? {} : { opacity: 0.6 }), ...(row.sub ? { marginLeft: 16 } : {}) }}
        >
          <strong>{row.title}</strong>
          {row.detail && <span>{row.detail}</span>}
        </li>
      ))}
    </ol>
  );
}
