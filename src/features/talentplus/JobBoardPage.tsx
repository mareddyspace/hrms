import { useEffect, useState, useSyncExternalStore } from "react";
import { API_ENABLED } from "../../api/client.ts";
import { Link } from "react-router-dom";
import { ActionButton, notify, Banner, Card, DataTable, Dialog, EmptyState, Field, MetricCard, MetricGrid, Page, StatusBadge, Tabs } from "../../components/ui.tsx";
import { formatShortDate } from "../../model.ts";
import { candidateHref, getTalentState, subscribeTalent, talentAction } from "../../data/talentLocal.ts";
import { myApplicationsMirror } from "../../api/syncTalent.ts";
import { myReferralsMirror } from "../../api/syncExperience.ts";
import "../../styles/experience.css";
import type { Requisition } from "../../data/talentData.ts";
import { isHr } from "./shared.ts";
import { useActor } from "./useActor.ts";
import {
  RELATIONSHIPS,
  applyBlocker,
  applyInternally,
  bonusStatus,
  getJobBoardState,
  gradeFor,
  isOpenPosting,
  isRecruitingDesk,
  allInternalApplications,
  markBonusPaid,
  moveReferral,
  myInternalApplications,
  nextStages,
  postingById,
  submitReferral,
  setJobBoardViewer,
  withdrawMyApplication,
  subscribeJobBoard,
  type Referral,
  type Stage,
} from "./jobBoardStore.ts";
import { MaskedValue } from "../../components/MaskedValue.tsx";
import { managementChain } from "../../demoAccounts.ts";
import "./talentplus.css";

type Msg = { tone: "ok" | "err" | "warn" | "info"; text: string } | null;

const STAGE_TONE: Record<Stage, "ok" | "warn" | "danger" | "info" | "neutral"> = {
  Submitted: "neutral",
  Screening: "info",
  Interview: "warn",
  Hired: "ok",
  "Not selected": "danger",
};

function StageBadge({ stage }: { stage: Stage }) {
  return <StatusBadge status={stage} tone={STAGE_TONE[stage]} literal />;
}

function postingTitle(id: string): string {
  const req = postingById(id);
  return req ? `${req.title} (${req.id})` : id;
}

export function InternalJobBoardPage() {
  const actor = useActor();
  const desk = isRecruitingDesk(actor);
  const [tab, setTab] = useState("roles");
  const tabs = [
    { id: "roles", label: "Open roles" },
    { id: "mine", label: "My activity" },
    ...(desk ? [{ id: "review", label: "Review" }] : []),
  ];
  return (
    <Page title="Internal jobs">
      <Tabs tabs={tabs} value={tabs.some((t) => t.id === tab) ? tab : "roles"} onChange={setTab} />
      {tab === "roles" && <OpenRoles />}
      {tab === "mine" && <MyActivity />}
      {tab === "review" && desk && <Review />}
    </Page>
  );
}

/* ───────────── Open roles ───────────── */

function OpenRoles() {
  const actor = useActor();
  const talent = useSyncExternalStore(subscribeTalent, getTalentState);
  useSyncExternalStore(subscribeJobBoard, getJobBoardState);
  const postings = talent.requisitions.filter(isOpenPosting);
  const [applyFor, setApplyFor] = useState<Requisition | null>(null);
  const [referFor, setReferFor] = useState<Requisition | null>(null);
  const [msg, setMsg] = useState<Msg>(null);

  return (
    <div className="stack">
      <Banner message={msg} />
      {postings.length ? (
        <ul className="approval-list">
          {postings.map((req) => {
            const blocker = applyBlocker(actor, req);
            return (
              <li key={req.id} className="approval-item">
                <div className="row-between">
                  <strong>{req.posting?.title ?? req.title}</strong>
                  <span className="pill">{gradeFor(req)}</span>
                </div>
                <p className="muted">
                  {req.department} · {req.posting?.location ?? `${req.location}, ${req.country}`} · {req.posting?.employmentType ?? "Full-time"} · {req.openings} {req.openings === 1 ? "opening" : "openings"} ·
                  apply by {req.posting ? formatShortDate(req.posting.closingDate) : "—"}
                </p>
                {req.posting?.description && <p className="jb-desc">{req.posting.description.length > 280 ? `${req.posting.description.slice(0, 280)}…` : req.posting.description}</p>}
                <div className="approval-actions">
                  <button type="button" className="btn btn-tiny" disabled={!!blocker} onClick={() => setApplyFor(req)}>
                    Apply
                  </button>
                  <button type="button" className="btn btn-ghost btn-tiny" onClick={() => setReferFor(req)}>
                    Refer someone
                  </button>
                  {blocker && <span className="muted">{blocker}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <Card>
          <EmptyState title="No open roles" />
        </Card>
      )}
      {applyFor && (
        <ApplyDialog
          req={applyFor}
          onClose={(text) => {
            setApplyFor(null);
            if (text) setMsg({ tone: "ok", text });
          }}
        />
      )}
      {referFor && (
        <ReferDialog
          req={referFor}
          onClose={(text) => {
            setReferFor(null);
            if (text) setMsg({ tone: "ok", text });
          }}
        />
      )}
    </div>
  );
}

function ApplyDialog({ req, onClose }: { req: Requisition; onClose: (message?: string) => void }) {
  const actor = useActor();
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<Msg>(null);
  // Nobody above the CEO to tell.
  const hasManager = managementChain(actor.id).length > 0;
  const told = hasManager ? " Your manager has been notified." : "";
  function submit(): Promise<string | null> {
    return new Promise((resolve) =>
      talentAction(
        () => applyInternally(actor, req.id, note),
        (error) => {
          if (error) setMsg({ tone: "err", text: error });
          else onClose(`Applied for ${req.title}. It is in the recruiter's pipeline.${told}`);
          resolve(error);
        },
      ),
    );
  }
  return (
    <Dialog
      open
      title={`Apply for ${req.title}`}
      onClose={() => onClose()}
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={() => onClose()}>
            Cancel
          </button>
          <ActionButton className="btn" onAction={submit} success={`Application for ${req.title} sent.${told}`}>
            Submit application
          </ActionButton>
        </>
      }
    >
      {hasManager && <p className="note">Your manager will be told that you applied.</p>}
      <Field label="Why are you interested? (optional)">
        <textarea rows={4} maxLength={3000} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <Banner message={msg} />
    </Dialog>
  );
}

function ReferDialog({ req, onClose }: { req: Requisition; onClose: (message?: string) => void }) {
  const actor = useActor();
  const [form, setForm] = useState({ name: "", email: "", phone: "", relationship: "", linkedIn: "", note: "" });
  const [msg, setMsg] = useState<Msg>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  async function submit() {
    const error = await submitReferral(actor, { postingId: req.id, ...form });
    if (error) setMsg({ tone: "err", text: error });
    else onClose(`Referral for ${form.name.trim()} submitted.`);
    return error;
  }
  return (
    <Dialog
      open
      title={`Refer for ${req.title}`}
      onClose={() => onClose()}
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={() => onClose()}>
            Cancel
          </button>
          <ActionButton className="btn" onAction={submit} success={`Referral for ${form.name.trim() || "your contact"} sent to the recruiting team.`}>
            Submit referral
          </ActionButton>
        </>
      }
    >
      <div className="form-grid-2">
        <Field label="Full name">
          <input value={form.name} maxLength={80} onChange={set("name")} />
        </Field>
        <Field label="Email">
          <input type="email" value={form.email} onChange={set("email")} />
        </Field>
        <Field label="Phone (optional)">
          <input type="tel" value={form.phone} onChange={set("phone")} />
        </Field>
        <Field label="How you know them">
          <select value={form.relationship} onChange={set("relationship")}>
            <option value="">Choose…</option>
            {RELATIONSHIPS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </Field>
        <Field label="LinkedIn (optional)" wide>
          <input type="url" value={form.linkedIn} placeholder="https://www.linkedin.com/in/…" onChange={set("linkedIn")} />
        </Field>
        <Field label="Note (optional)" wide>
          <textarea rows={3} maxLength={500} value={form.note} onChange={set("note")} />
        </Field>
      </div>
      <Banner message={msg} />
    </Dialog>
  );
}

/* ───────────── My activity ───────────── */

function BonusCell({ referral }: { referral: Referral }) {
  const bonus = bonusStatus(referral);
  if (!bonus) return <span className="muted">—</span>;
  return (
    <span className="row-gap">
      <StatusBadge status={bonus.label} tone={bonus.tone} literal />
      {bonus.payableOn && bonus.label === "Bonus pending" && <span className="muted">from {formatShortDate(bonus.payableOn)}</span>}
    </span>
  );
}

function MyActivity() {
  const actor = useActor();
  setJobBoardViewer(actor.id);
  const state = useSyncExternalStore(subscribeJobBoard, getJobBoardState);
  useSyncExternalStore(subscribeTalent, getTalentState);
  useSyncExternalStore(myApplicationsMirror.subscribe, myApplicationsMirror.get);
  const [msg, setMsg] = useState<Msg>(null);
  const [opened, setOpened] = useState<string | null>(null);
  useEffect(() => {
    if (!API_ENABLED) return;
    void myApplicationsMirror.reload(); // stages move in the recruiter's pipeline
    void myReferralsMirror.reload();
  }, []);
  const apps = myInternalApplications(actor.id);
  const refs = state.referrals.filter((r) => r.referrerId === actor.id);
  const hired = refs.filter((r) => r.status === "Hired").length;

  return (
    <div className="stack">
      <MetricGrid>
        <MetricCard label="Applications" value={apps.length} />
        <MetricCard label="Referrals" value={refs.length} />
        <MetricCard label="Referrals hired" value={hired} />
      </MetricGrid>
      <Banner message={msg} />
      <Card title="My applications">
        <DataTable
          headers={API_ENABLED ? ["Role", "Applied", "Last update", "Status", ""] : ["Role", "Applied", "Status"]}
          rows={apps.flatMap((a) => {
            const row = [postingTitle(a.postingId), formatShortDate(a.submittedOn)];
            if (!API_ENABLED) return [[...row, <StageBadge key="s" stage={a.status} />]];
            const main = [
              ...row,
              formatShortDate(a.updatedOn),
              <StageBadge key="s" stage={a.status} />,
              <span key="a" className="row-gap">
                {a.timeline && a.timeline.length > 0 && (
                  <button type="button" className="btn btn-ghost btn-tiny" onClick={() => setOpened(opened === a.id ? null : a.id)}>
                    {opened === a.id ? "Hide progress" : "Progress"}
                  </button>
                )}
                {a.canWithdraw && (
                  <ActionButton
                    className="btn btn-ghost btn-tiny"
                    busyLabel="Withdrawing…"
                    doneLabel="Withdrawn"
                    onAction={async () => {
                      if (!window.confirm(`Withdraw your application for ${postingTitle(a.postingId)}? The recruiter will be told.`)) return false;
                      const error = await withdrawMyApplication(a.id);
                      setMsg(error ? { tone: "err", text: error } : { tone: "ok", text: "Application withdrawn." });
                      return error;
                    }}
                  >
                    Withdraw
                  </ActionButton>
                )}
              </span>,
            ];
            if (opened !== a.id || !a.timeline) return [main];
            const steps = (
              <ol key="t" className="xp-timeline">
                {a.timeline.map((t, i) => (
                  <li key={`${t.stage}-${i}`} className={i === a.timeline!.length - 1 ? "current" : undefined}>
                    <span className="xp-dot" aria-hidden />
                    <div>
                      <strong>{t.stage}</strong>
                      {t.at && <span className="muted"> · {formatShortDate(t.at.slice(0, 10))}</span>}
                      {t.text && <p className="xp-note">{t.text}</p>}
                    </div>
                  </li>
                ))}
              </ol>
            );
            return [main, [steps, "", "", "", ""]];
          })}
          empty={<EmptyState title="No applications" description="Apply from Open roles." />}
        />
      </Card>
      <Card title="My referrals">
        <DataTable
          headers={API_ENABLED ? ["Candidate", "Role", "Referred", "Last update", "Status"] : ["Candidate", "Role", "Referred", "Status", "Referral bonus"]}
          rows={refs.map((r) =>
            API_ENABLED
              ? [r.name, postingTitle(r.postingId), formatShortDate(r.submittedOn), formatShortDate(r.updatedOn), <StageBadge key="s" stage={r.status} />]
              : [r.name, postingTitle(r.postingId), formatShortDate(r.submittedOn), <StageBadge key="s" stage={r.status} />, <BonusCell key="b" referral={r} />],
          )}
          empty={<EmptyState title="No referrals" description="Refer from Open roles." />}
        />
      </Card>
    </div>
  );
}

/* ───────────── Review (recruiter / HR) ───────────── */

function MoveButtons({ current, disabled, onMove }: { current: Stage; disabled?: string; onMove: (s: Stage) => string | null }) {
  const options = nextStages(current);
  if (disabled) return <span className="muted">{disabled}</span>;
  if (!options.length) return <span className="muted">Closed</span>;
  return (
    <span className="row-gap">
      {options.map((s) => (
        <ActionButton
          key={s}
          className={s === "Not selected" ? "btn btn-ghost btn-tiny" : "btn btn-tiny"}
          busyLabel={s === "Not selected" ? "Updating…" : undefined}
          doneLabel={s === "Not selected" ? "Updated" : undefined}
          onAction={() => onMove(s)}
        >
          {s === "Not selected" ? "Not selected" : `Move to ${s.toLowerCase()}`}
        </ActionButton>
      ))}
    </span>
  );
}

function Review() {
  const actor = useActor();
  const state = useSyncExternalStore(subscribeJobBoard, getJobBoardState);
  useSyncExternalStore(subscribeTalent, getTalentState);
  const [msg, setMsg] = useState<Msg>(null);
  const report = (e: string | null, ok: string) => {
    setMsg(e ? { tone: "err", text: e } : { tone: "ok", text: ok });
    if (!e) notify(ok);
    return e;
  };
  const hr = isHr(actor.role);
  const internal = allInternalApplications();

  return (
    <div className="stack">
      <MetricGrid>
        <MetricCard label="Internal applications" value={internal.length} />
        <MetricCard label="Referrals" value={state.referrals.length} />
        <MetricCard label="In interview" value={[...internal, ...state.referrals].filter((x) => x.status === "Interview").length} />
      </MetricGrid>
      <Banner message={msg} />
      <Card title="Internal applications">
        <DataTable
          headers={["Employee", "Role", "Applied", "Status", "Note", ""]}
          rows={internal.map((a) => [
            a.employeeName,
            postingTitle(a.postingId),
            formatShortDate(a.submittedOn),
            <StageBadge key="s" stage={a.status} />,
            a.note || <span className="muted">—</span>,
            a.employeeId === actor.id ? (
              <span key="m" className="muted">Your own application</span>
            ) : (
              <Link key="m" className="quiet-link" to={candidateHref(a.id)}>
                Open in pipeline
              </Link>
            ),
          ])}
          empty={<EmptyState title="No internal applications" />}
        />
      </Card>
      <Card title="Referrals">
        <DataTable
          headers={API_ENABLED ? ["Candidate", "Role", "Referred by", "Contact", "Status", ""] : ["Candidate", "Role", "Referred by", "Contact", "Status", "Bonus", "Update"]}
          rows={state.referrals.map((r) => {
            const bonus = bonusStatus(r);
            if (API_ENABLED) {
              // Referrals are candidates in the job's pipeline: recruiting moves them there.
              return [
                r.name,
                postingTitle(r.postingId),
                `${r.referrerName} (${r.relationship.toLowerCase()})`,
                r.email,
                <StageBadge key="s" stage={r.status} />,
                <Link key="m" className="quiet-link" to={candidateHref(r.id)}>
                  Open in pipeline
                </Link>,
              ];
            }
            return [
              <span key="n">
                {r.name}
                {r.linkedIn && (
                  <>
                    {" · "}
                    <a href={r.linkedIn} target="_blank" rel="noopener noreferrer">
                      LinkedIn
                    </a>
                  </>
                )}
              </span>,
              postingTitle(r.postingId),
              `${r.referrerName} (${r.relationship.toLowerCase()})`,
              <span key="c">
                {r.email}
                {r.phone && <br />}
                {r.phone && <MaskedValue value={r.phone} kind="phone" canReveal={hr || actor.role === "recruiter"} />}
              </span>,
              <StageBadge key="s" stage={r.status} />,
              <span key="b" className="row-gap">
                <BonusCell referral={r} />
                {hr && bonus?.label === "Bonus payable" && r.referrerId !== actor.id && (
                  <ActionButton className="btn btn-tiny" doneLabel="Paid" onAction={() => report(markBonusPaid(actor, r.id), `Referral bonus for ${r.referrerName} marked as paid.`)}>
                    Mark paid
                  </ActionButton>
                )}
              </span>,
              <MoveButtons
                key="m"
                current={r.status}
                disabled={r.referrerId === actor.id ? "Your own referral" : undefined}
                onMove={(s) => report(moveReferral(actor, r.id, s), `${r.name} moved to ${s.toLowerCase()}.`)}
              />,
            ];
          })}
          empty={<EmptyState title="No referrals" />}
        />
      </Card>
    </div>
  );
}
