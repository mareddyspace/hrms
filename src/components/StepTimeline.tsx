import { formatShortDate } from "../model.ts";
import type { DecisionInfo, ExpenseApprovalStep, ExpenseStepDecision } from "../model.ts";

type Props = {
  status: string;
  submittedOn?: string;
  steps?: ExpenseApprovalStep[];
  currentStep?: number;
  stepDecisions?: ExpenseStepDecision[];
  decided?: DecisionInfo;
  /** Show a final "Paid" stage (expense claims). */
  paid?: { show: boolean; on?: string; by?: string; reference?: string };
  nameOf?: (id: string) => string;
};

const dated = (iso?: string) => (iso ? formatShortDate(iso) : "");

/** Submitted → each approval step → Approved (→ Paid), with who decided and when. */
export function StepTimeline({ status, submittedOn, steps, currentStep = 0, stepDecisions = [], decided, paid, nameOf }: Props) {
  const rows: { key: string; title: string; detail: string; done: boolean }[] = [];
  rows.push({ key: "sub", title: "Submitted", detail: dated(submittedOn), done: true });
  const closed = status === "rejected" || status === "withdrawn";

  if (steps?.length) {
    steps.forEach((step, index) => {
      const d = stepDecisions.find((x) => x.step === index);
      if (d) {
        rows.push({
          key: `s${index}`,
          title: `${step.label} · ${d.decision === "approved" ? "approved" : "declined"}`,
          detail: `${d.byName} · ${dated(d.on)}${d.note ? ` · “${d.note}”` : ""}`,
          done: true,
        });
      } else if (!closed) {
        const who = nameOf ? step.approverIds.map(nameOf).join(", ") : "";
        rows.push({
          key: `s${index}`,
          title: step.label,
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
        <li key={row.key} className={row.done ? undefined : "is-education"} style={row.done ? undefined : { opacity: 0.6 }}>
          <strong>{row.title}</strong>
          {row.detail && <span>{row.detail}</span>}
        </li>
      ))}
    </ol>
  );
}
