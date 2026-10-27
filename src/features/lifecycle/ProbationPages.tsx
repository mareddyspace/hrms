import { useMemo, useState, useSyncExternalStore, type FormEvent } from "react";
import {
  Banner,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  MetricCard,
  MetricGrid,
  Page,
  StatusBadge,
  Tabs,
} from "../../components/ui.tsx";
import { getPerson, listPeople, subscribePeople } from "../../data/peopleLocal.ts";
import { formatShortDate } from "../../model.ts";
import { usePortal } from "../../store.tsx";
import { PROBATION_POLICY, isHrRole, probationLabel } from "./lifecycleShared.ts";
import {
  DUE_WINDOW_DAYS,
  MAX_EXTENSIONS,
  canFinaliseProbation,
  canReview,
  finaliseProbation,
  getProbationState,
  probationViewFor,
  submitProbationReview,
  subscribeProbation,
  trackedProbations,
  type ProbationStatus,
  type ProbationView,
  type Recommendation,
} from "./probationStore.ts";
import "./lifecycle.css";

type Message = { tone: "ok" | "err" | "warn" | "info"; text: string } | null;

function useProbationData() {
  const people = useSyncExternalStore(subscribePeople, listPeople);
  const state = useSyncExternalStore(subscribeProbation, getProbationState);
  return { people, state };
}

function statusTone(status: ProbationStatus): "ok" | "warn" | "danger" | "info" {
  if (status === "Confirmed") return "ok";
  if (status === "Not confirmed") return "danger";
  if (status === "Review pending HR") return "info";
  return "warn";
}

function DueLabel({ view }: { view: ProbationView }) {
  if (view.status === "Confirmed" || view.status === "Not confirmed") return <span className="muted">Closed</span>;
  if (view.overdue) return <StatusBadge status={`Overdue ${-view.daysLeft}d`} tone="danger" literal />;
  if (view.daysLeft === 0) return <StatusBadge status="Ends today" tone="warn" literal />;
  return <span>{view.daysLeft} days</span>;
}

/* ───────────── My probation ───────────── */

export function MyProbationPage() {
  const { employee } = usePortal();
  useProbationData();
  const person = getPerson(employee.id);

  if (!person) {
    return (
      <Page title="My probation">
        <EmptyState title="No directory record" description="Ask HR to add your joining details." />
      </Page>
    );
  }

  const view = probationViewFor(person);
  const lastDecision = [...(view.record?.reviews ?? [])].reverse().find((r) => r.outcome === "Approved");
  const country = String(person.countryCode);

  return (
    <Page title="My probation">
      <Card title="Status">
        <dl className="lc-facts">
          <div>
            <dt>Status</dt>
            <dd>
              <StatusBadge status={view.status === "Review pending HR" ? "Under review" : view.status} tone={statusTone(view.status)} literal />
            </dd>
          </div>
          <div>
            <dt>Joined</dt>
            <dd>{formatShortDate(view.joiningDate)}</dd>
          </div>
          <div>
            <dt>Probation length</dt>
            <dd>
              {probationLabel(country)} · {person.countryName}
            </dd>
          </div>
          <div>
            <dt>{view.status === "Confirmed" ? "Probation ended" : "Probation ends"}</dt>
            <dd>{formatShortDate(view.endDate)}</dd>
          </div>
          {(view.status === "In probation" || view.status === "Review pending HR") && (
            <div>
              <dt>Time left</dt>
              <dd>{view.overdue ? "Review overdue" : `${view.daysLeft} days`}</dd>
            </div>
          )}
          {lastDecision?.decidedOn && (
            <div>
              <dt>Last decision</dt>
              <dd>
                {lastDecision.recommendation === "Extend"
                  ? `Extended by ${lastDecision.extendMonths} month${lastDecision.extendMonths === 1 ? "" : "s"}`
                  : lastDecision.recommendation === "Confirm"
                    ? "Confirmed"
                    : "Not confirmed"}{" "}
                · {formatShortDate(lastDecision.decidedOn)}
              </dd>
            </div>
          )}
        </dl>
      </Card>
      {(view.record?.extensions.length ?? 0) > 0 && (
        <Card title="Extensions">
          <DataTable
            headers={["Approved", "Months", "Reason"]}
            rows={view.record!.extensions.map((e) => [formatShortDate(e.approvedOn), e.months, e.reason])}
          />
        </Card>
      )}
      <Card title="Probation by country">
        <DataTable headers={["Country", "Probation"]} rows={PROBATION_POLICY.map((p) => [p.country, probationLabel(p.code)])} />
      </Card>
    </Page>
  );
}

/* ───────────── Reviews (managers + HR) ───────────── */

function ReviewForm({ view, onDone }: { view: ProbationView; onDone: (m: Message) => void }) {
  const { demoProfile } = usePortal();
  const [recommendation, setRecommendation] = useState<Recommendation>("Confirm");
  const [months, setMonths] = useState(1);
  const [reason, setReason] = useState("");
  const [rating, setRating] = useState(0);
  const [comments, setComments] = useState("");
  const [error, setError] = useState<string | null>(null);
  const extensionsUsed = view.record?.extensions.length ?? 0;

  function submit(event: FormEvent) {
    event.preventDefault();
    const result = submitProbationReview(demoProfile, view.person.id, {
      recommendation,
      extendMonths: recommendation === "Extend" ? months : undefined,
      reason,
      rating,
      comments,
    });
    if (result) setError(result);
    else onDone({ tone: "ok", text: `Review for ${view.person.fullName} sent for a decision.` });
  }

  return (
    <form className="stack" onSubmit={submit}>
      <Banner message={error ? { tone: "err", text: error } : null} />
      <p className="muted">
        Probation ends {formatShortDate(view.endDate)} · extensions used {extensionsUsed} of {MAX_EXTENSIONS}
      </p>
      <div className="lc-grid">
        <Field label="Recommendation">
          <select value={recommendation} onChange={(e) => setRecommendation(e.target.value as Recommendation)}>
            <option>Confirm</option>
            <option disabled={extensionsUsed >= MAX_EXTENSIONS}>Extend</option>
            <option>Not confirm</option>
          </select>
        </Field>
        {recommendation === "Extend" && (
          <Field label="Extend by">
            <select value={months} onChange={(e) => setMonths(Number(e.target.value))}>
              <option value={1}>1 month</option>
              <option value={2}>2 months</option>
              <option value={3}>3 months</option>
            </select>
          </Field>
        )}
        {recommendation !== "Confirm" && (
          <Field label="Reason" wide>
            <input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} required />
          </Field>
        )}
        <div className="field wide">
          <span>Rating</span>
          <div className="lc-rating" role="group" aria-label="Rating">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" className="btn-ghost btn-tiny" aria-pressed={rating === n} onClick={() => setRating(n)}>
                {n}
              </button>
            ))}
          </div>
        </div>
        <Field label="Comments" wide>
          <textarea value={comments} maxLength={2000} onChange={(e) => setComments(e.target.value)} required />
        </Field>
      </div>
      <div>
        <button className="btn" type="submit">
          Submit review
        </button>
      </div>
    </form>
  );
}

function FinaliseForm({ view, onDone }: { view: ProbationView; onDone: (m: Message) => void }) {
  const { demoProfile } = usePortal();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const review = view.pendingReview;
  if (!review) return <p className="muted">No review is waiting.</p>;

  function decide(decision: "approve" | "return") {
    let warning: string | null = null;
    const result = finaliseProbation(demoProfile, view.person.id, decision, note, (text) => {
      warning = text;
    });
    if (result) {
      setError(result);
      return;
    }
    if (warning) onDone({ tone: "warn", text: warning });
    else if (decision === "return") onDone({ tone: "ok", text: "Review returned to the manager." });
    else if (review!.recommendation === "Confirm") onDone({ tone: "ok", text: `${view.person.fullName} confirmed. Confirmation letter requested.` });
    else if (review!.recommendation === "Extend") onDone({ tone: "ok", text: `Probation extended by ${review!.extendMonths} month(s).` });
    else onDone({ tone: "ok", text: `${view.person.fullName} marked not confirmed. Exit started.` });
  }

  return (
    <div className="stack">
      <Banner message={error ? { tone: "err", text: error } : null} />
      <dl className="lc-facts">
        <div>
          <dt>Recommendation</dt>
          <dd>
            {review.recommendation}
            {review.recommendation === "Extend" ? ` · ${review.extendMonths} month(s)` : ""}
          </dd>
        </div>
        <div>
          <dt>Rating</dt>
          <dd>{review.rating} / 5</dd>
        </div>
        <div>
          <dt>Reviewer</dt>
          <dd>
            {review.submittedBy} · {formatShortDate(review.submittedOn)}
          </dd>
        </div>
        {review.reason && (
          <div style={{ gridColumn: "1 / -1" }}>
            <dt>Reason</dt>
            <dd>{review.reason}</dd>
          </div>
        )}
        <div style={{ gridColumn: "1 / -1" }}>
          <dt>Comments</dt>
          <dd>{review.comments}</dd>
        </div>
      </dl>
      <Field label="Note">
        <input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="Required when returning" />
      </Field>
      <div className="row-gap">
        <button className="btn" type="button" onClick={() => decide("approve")}>
          Approve {review.recommendation.toLowerCase()}
        </button>
        <button className="btn-ghost" type="button" onClick={() => decide("return")}>
          Return to reviewer
        </button>
      </div>
    </div>
  );
}

export function ProbationReviewsPage() {
  const { demoProfile } = usePortal();
  const { people, state } = useProbationData();
  const [tab, setTab] = useState("due");
  const [message, setMessage] = useState<Message>(null);
  const [dialog, setDialog] = useState<{ mode: "review" | "finalise"; id: string } | null>(null);
  const actor = demoProfile;
  const hr = isHrRole(actor.role);

  const views = useMemo(
    () => trackedProbations(people).filter((v) => v.person.id !== actor.id && (hr || canReview(actor, v.person.id))),
    // `state` is listed so the list refreshes after reviews change.
    [people, state, actor.id, hr],
  );
  const due = views.filter((v) => v.due && v.status === "In probation");
  const pending = views.filter((v) => v.status === "Review pending HR");
  const overdue = views.filter((v) => v.overdue);
  const rows = tab === "due" ? due : tab === "pending" ? pending : views;
  const selected = dialog ? views.find((v) => v.person.id === dialog.id) : undefined;

  return (
    <Page title="Probation reviews">
      <Banner message={message} />
      <MetricGrid>
        <MetricCard label={`Due in ${DUE_WINDOW_DAYS} days`} value={due.length} />
        <MetricCard label="Overdue" value={overdue.length} />
        <MetricCard label="Awaiting decision" value={pending.length} />
        <MetricCard label="Tracked" value={views.length} />
      </MetricGrid>
      <Card>
        <div className="stack">
          <Tabs
            tabs={[
              { id: "due", label: `Due (${due.length})` },
              { id: "pending", label: `Awaiting decision (${pending.length})` },
              { id: "all", label: "All" },
            ]}
            value={tab}
            onChange={setTab}
          />
          <DataTable
            headers={["Employee", "Joined", "Ends", "Left", "Extensions", "Status", ""]}
            rows={rows.map((v) => {
              const reviewable = v.status === "In probation" && v.due && canReview(actor, v.person.id);
              const finalisable = canFinaliseProbation(actor, v);
              return [
                <div>
                  <strong>{v.person.fullName}</strong>
                  <p className="muted">
                    {v.person.designation} · {v.person.countryName}
                  </p>
                </div>,
                formatShortDate(v.joiningDate),
                formatShortDate(v.endDate),
                <DueLabel view={v} />,
                `${v.record?.extensions.length ?? 0} of ${MAX_EXTENSIONS}`,
                <StatusBadge status={v.status} tone={statusTone(v.status)} literal />,
                reviewable ? (
                  <button className="btn-ghost btn-tiny" type="button" onClick={() => setDialog({ mode: "review", id: v.person.id })}>
                    Review
                  </button>
                ) : finalisable ? (
                  <button className="btn-ghost btn-tiny" type="button" onClick={() => setDialog({ mode: "finalise", id: v.person.id })}>
                    Finalise
                  </button>
                ) : (
                  <span className="muted">—</span>
                ),
              ];
            })}
            empty={<EmptyState title="No probations" />}
          />
        </div>
      </Card>
      <Dialog
        open={Boolean(selected && dialog)}
        title={selected ? `${dialog?.mode === "finalise" ? "Finalise" : "Probation review"} · ${selected.person.fullName}` : "Probation"}
        onClose={() => setDialog(null)}
      >
        {selected && dialog?.mode === "review" && (
          <ReviewForm
            view={selected}
            onDone={(m) => {
              setMessage(m);
              setDialog(null);
            }}
          />
        )}
        {selected && dialog?.mode === "finalise" && (
          <FinaliseForm
            view={selected}
            onDone={(m) => {
              setMessage(m);
              setDialog(null);
            }}
          />
        )}
      </Dialog>
    </Page>
  );
}
