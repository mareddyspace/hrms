/** Personal, employment and background sections of a profile, with own-profile editing and HR correction requests. */
import { useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { BadgeCheck, Briefcase, Clock3, GraduationCap, IdCard, ShieldAlert, ShieldCheck, Target } from "lucide-react";
import { ActionButton, Banner, Card, DataTable, Dialog, EmptyState, Field, StatusBadge, SubmitButton, notify, useAction } from "../components/ui.tsx";
import {
  NATIONALITIES,
  PROFILE_LANGUAGES,
  WORK_ARRANGEMENTS,
  type EducationRecord,
  type ExperienceRecord,
  type PersonRecord,
} from "../data/peopleData.ts";
import { listPeople } from "../data/peopleLocal.ts";
import {
  CORRECTION_FIELD_LABEL,
  canDecideCorrection,
  currentFieldValue,
  decideProfileCorrection,
  requestProfileCorrection,
  saveOwnBackground,
  checkOwnBackground,
  ownBackgroundUpdate,
  useProfileCorrections,
  withdrawProfileCorrection,
  type CorrectionField,
  type ProfileCorrection,
} from "../data/profileCorrections.ts";
import type { DemoAccount } from "../demoAccounts.ts";
import { formatShortDate } from "../model.ts";
import { MaskedValue } from "../components/MaskedValue.tsx";
import { useProfileCode } from "../components/ProfileCodeDialog.tsx";
import { canRevealPersonal, personRevealer } from "../data/piiReveal.ts";
import { isMasked } from "../utils/mask.ts";
import { canReadAllBgv, getBgvState, subscribeBgv, type BgvCheck, type CheckType } from "../features/compliance/bgvStore.ts";

type Msg = { tone: "ok" | "err"; text: string } | null;

function Fact({ label, value, action }: { label: string; value?: ReactNode; action?: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {value || value === 0 ? value : <span className="muted">—</span>}
        {action && <> {action}</>}
      </dd>
    </div>
  );
}

function CorrectButton({ onClick, pending }: { onClick: () => void; pending: boolean }) {
  if (pending) return <span className="muted pi-correct">· correction pending</span>;
  return (
    <button type="button" className="quiet-link pi-correct" onClick={onClick}>
      Request correction
    </button>
  );
}

function monthLabel(value: string): string {
  return /^\d{4}-\d{2}/.test(value) ? formatShortDate(`${value.slice(0, 7)}-01`).replace(/^\d+\s/, "") : value;
}

/**
 * "Request correction" links for HR-owned fields on your own profile, and the dialog they open.
 * `correct(field)` is undefined on someone else's profile.
 */
export function useCorrectionUi(record: PersonRecord | undefined, viewer: DemoAccount, isMe: boolean) {
  const corrections = useProfileCorrections();
  const [correcting, setCorrecting] = useState<CorrectionField | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const pending = (field: CorrectionField) =>
    Boolean(record) && corrections.some((c) => c.personId === record!.id && c.field === field && c.status === "Pending");
  const correct = (field: CorrectionField): ReactNode =>
    isMe && record ? <CorrectButton pending={pending(field)} onClick={() => setCorrecting(field)} /> : undefined;
  const ui = (
    <>
      <Banner message={msg} />
      {isMe && record && correcting && (
        <CorrectionDialog
          record={record}
          field={correcting}
          viewer={viewer}
          onClose={() => setCorrecting(null)}
          onSent={() => {
            setCorrecting(null);
            setMsg({ tone: "ok", text: "Correction sent to HR." });
          }}
        />
      )}
    </>
  );
  return { correct, ui };
}

/* ───────────── Verification ───────────── */

type VerifyState = "verified" | "pending" | "failed" | "none" | "expired";

const VERIFY_LABEL: Record<VerifyState, string> = {
  verified: "Verified",
  pending: "Pending",
  failed: "Not verified",
  none: "Not verified",
  expired: "Expired",
};

function verifyState(check: BgvCheck | undefined, started: boolean): VerifyState {
  if (!check) return "none";
  if (check.status === "Clear") return "verified";
  if (check.status === "Discrepancy" || check.status === "Unable to verify") return "failed";
  return started ? "pending" : "none";
}

function verifyMeta(check: BgvCheck | undefined, state: VerifyState): string {
  if (!check) return "No verification on file";
  if (state === "verified") return `Verified by ${check.vendor || "HR"}${check.completedOn ? ` · ${formatShortDate(check.completedOn)}` : ""}`;
  if (state === "failed") return `${check.status}${check.vendor ? ` · ${check.vendor}` : ""}${check.completedOn ? ` · ${formatShortDate(check.completedOn)}` : ""}`;
  if (check.status === "In progress") return `In progress${check.vendor ? ` with ${check.vendor}` : ""}${check.initiatedOn ? ` since ${formatShortDate(check.initiatedOn)}` : ""}`;
  return "Not started yet";
}

export function VerifyBadge({ state }: { state: VerifyState }) {
  const Icon = state === "verified" ? ShieldCheck : state === "pending" ? Clock3 : ShieldAlert;
  return (
    <span className={`verify-badge ${state}`}>
      <Icon size={13} aria-hidden /> {VERIFY_LABEL[state]}
    </span>
  );
}

const CHECK_ORDER: CheckType[] = ["Identity", "Education", "Previous employment", "Address", "Criminal record", "Reference"];
const CHECK_LABEL: Partial<Record<CheckType, string>> = { Identity: "ID check", "Previous employment": "Employment check" };

/**
 * Education and previous jobs with their background-verification status (who verified, when), plus the ID and
 * other checks. Check details: the person and HR. Managers above see the education and job history only.
 */
export function BackgroundCard({ record, isMe, viewer, onEdit }: { record: PersonRecord; isMe: boolean; viewer: DemoAccount; onEdit?: () => void }) {
  const bgv = useSyncExternalStore(subscribeBgv, getBgvState, getBgvState);
  const file = bgv.records.find((r) => r.subjectKind === "employee" && r.subjectId === record.id);
  const showChecks = isMe || canReadAllBgv(viewer.role);
  const started = Boolean(file?.consent);
  const check = (t: CheckType) => file?.checks.find((c) => c.type === t);
  const eduState = verifyState(check("Education"), started);
  const expState = verifyState(check("Previous employment"), started);
  const checks = CHECK_ORDER.map((t) => ({ type: t, check: check(t), state: verifyState(check(t), started) }));
  const verifiedCount = checks.filter((c) => c.state === "verified").length;
  const education = record.education ?? [];
  const experience = record.experience ?? [];

  return (
    <Card
      title="Background & verification"
      className="bgv-card"
      action={
        onEdit ? (
          <button type="button" className="btn-ghost btn-tiny" onClick={onEdit}>
            Edit
          </button>
        ) : undefined
      }
    >
      {showChecks && (
        <div className="bgv-summary">
          <span className="bgv-summary-icon" aria-hidden>
            <BadgeCheck size={20} />
          </span>
          <div>
            <strong>
              {file ? `${verifiedCount} of ${checks.length} checks verified` : "Background verification not started"}
            </strong>
            <span className="muted">
              {file?.consent ? `Consent given ${formatShortDate(file.consent.givenOn)}` : file ? "Waiting for consent" : "HR starts verification"}
            </span>
          </div>
          {canReadAllBgv(viewer.role) && !isMe && (
            <Link to="/talent/background-checks" className="btn-ghost btn-tiny">
              Open checks
            </Link>
          )}
        </div>
      )}

      <section className="bgv-section">
        <h3 className="bgv-head">
          <GraduationCap size={16} aria-hidden /> Education
        </h3>
        {education.length === 0 ? (
          <p className="muted">None listed.</p>
        ) : (
          <ul className="bgv-list">
            {education.map((e, i) => (
              <li key={`${e.degree}-${i}`}>
                <div>
                  <strong>{e.degree}</strong>
                  <span className="muted">
                    {e.institution} · {e.year}
                  </span>
                </div>
                {showChecks && (
                  <div className="bgv-status">
                    <VerifyBadge state={eduState} />
                    <span className="muted">{verifyMeta(check("Education"), eduState)}</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="bgv-section">
        <h3 className="bgv-head">
          <Briefcase size={16} aria-hidden /> Previous employment
        </h3>
        {experience.length === 0 ? (
          <p className="muted">None listed.</p>
        ) : (
          <ul className="bgv-list">
            {experience.map((x, i) => (
              <li key={`${x.employer}-${i}`}>
                <div>
                  <strong>{x.title}</strong>
                  <span className="muted">
                    {x.employer} · {monthLabel(x.from)} – {monthLabel(x.to)}
                  </span>
                </div>
                {showChecks && (
                  <div className="bgv-status">
                    <VerifyBadge state={expState} />
                    <span className="muted">{verifyMeta(check("Previous employment"), expState)}</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {showChecks && (
        <section className="bgv-section">
          <h3 className="bgv-head">
            <IdCard size={16} aria-hidden /> Verification checks
          </h3>
          <ul className="bgv-checks">
            {checks.map((c) => (
              <li key={c.type}>
                <span className="bgv-check-name">{CHECK_LABEL[c.type] ?? c.type}</span>
                <VerifyBadge state={c.state} />
                <span className="muted bgv-check-meta">{verifyMeta(c.check, c.state)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="bgv-section">
        <h3 className="bgv-head">
          <Target size={16} aria-hidden /> Career goals
        </h3>
        {record.careerGoals ? <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{record.careerGoals}</p> : <p className="muted">Not added yet.</p>}
      </section>
    </Card>
  );
}

/* ───────────── Sections ───────────── */

/**
 * The short profile (no full record below it): personal, employment and background cards.
 * With `compact`, only background and correction requests (the record tabs show the rest).
 */
export function ProfileDetailsCards({
  record,
  isMe,
  canSeePersonal,
  canSeeWork,
  viewer,
  compact = false,
}: {
  record: PersonRecord;
  isMe: boolean;
  canSeePersonal: boolean;
  canSeeWork: boolean;
  viewer: DemoAccount;
  compact?: boolean;
}) {
  const corrections = useProfileCorrections();
  const [editing, setEditing] = useState<OwnEditMode | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const { correct, ui } = useCorrectionUi(record, viewer, isMe);
  const languages = record.spokenLanguages ?? [];

  return (
    <>
      <Banner message={msg} />
      {ui}
      {!compact && canSeePersonal && (
        <Card
          title="Personal"
          action={
            isMe ? (
              <button type="button" className="quiet-link" onClick={() => setEditing("personal")}>
                Edit
              </button>
            ) : undefined
          }
        >
          <dl className="profile-facts">
            <Fact label="Legal name" value={record.fullName} action={correct("fullName")} />
            <Fact label="Middle name" value={record.middleName} action={correct("middleName")} />
            <Fact label="Preferred name" value={record.preferredName} />
            <Fact
              label="Date of birth"
              value={
                record.dateOfBirth ? (
                  <MaskedValue
                    value={record.dateOfBirth}
                    kind="dob"
                    canReveal={canRevealPersonal(viewer, record.id, isMe ? record.id : "", canSeePersonal)}
                    onReveal={personRevealer(record.id, "date_of_birth", record.dateOfBirth)}
                    format={(dob) => (isMasked(dob) ? dob : formatShortDate(dob))}
                  />
                ) : (
                  ""
                )
              }
              action={correct("dateOfBirth")}
            />
            <Fact label="Nationality" value={record.nationality} action={correct("nationality")} />
            <Fact label="Preferred language" value={record.preferredLanguage} />
            <Fact label="Languages" value={languages.join(", ")} />
          </dl>
        </Card>
      )}

      {!compact && (
        <Card title="Employment">
          <dl className="profile-facts">
            <Fact label="Job title" value={record.designation} action={correct("designation")} />
            <Fact label="Department" value={record.department} action={correct("department")} />
            <Fact
              label="Manager"
              value={record.managerId ? <Link to={`/people/${record.managerId}`}>{record.managerName}</Link> : record.managerName}
              action={correct("managerId")}
            />
            <Fact label="Work arrangement" value={record.workArrangement} action={correct("workArrangement")} />
            {record.company && <Fact label="Company" value={record.company} />}
            {canSeePersonal && <Fact label="Employment type" value={record.employmentType} />}
          </dl>
          {isMe && <p className="note">Managed by HR.</p>}
        </Card>
      )}

      {(isMe || canSeeWork) && <BackgroundCard record={record} isMe={isMe} viewer={viewer} onEdit={isMe ? () => setEditing("background") : undefined} />}

      <CorrectionsCard record={record} isMe={isMe} viewer={viewer} rows={corrections} />

      {isMe && editing && (
        <OwnDetailsEditor
          mode={editing}
          record={record}
          viewer={viewer}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setMsg({ tone: "ok", text: editing === "personal" ? "Personal details saved." : "Background saved." });
          }}
        />
      )}
    </>
  );
}

/* ───────────── Correction requests ───────────── */

function statusTone(status: ProfileCorrection["status"]): "ok" | "warn" | "danger" | "neutral" {
  if (status === "Approved") return "ok";
  if (status === "Rejected") return "danger";
  if (status === "Withdrawn") return "neutral";
  return "warn";
}

/** Your own requests on your profile; for HR, open requests for this person (or everyone's, on HR's own profile). */
function CorrectionsCard({ record, isMe, viewer, rows }: { record: PersonRecord; isMe: boolean; viewer: DemoAccount; rows: ProfileCorrection[] }) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<Msg>(null);
  const hrQueue = rows.filter((c) => canDecideCorrection(viewer, c) && (isMe || c.personId === record.id));
  const mine = isMe ? rows.filter((c) => c.personId === record.id) : [];
  if (!hrQueue.length && !mine.length) return null;

  async function decide(row: ProfileCorrection, decision: "approve" | "reject") {
    const error = await decideProfileCorrection(viewer, row.id, decision, notes[row.id] ?? "");
    setMsg(error ? { tone: "err", text: error } : { tone: "ok", text: decision === "approve" ? "Correction approved and applied." : "Correction rejected." });
    if (!error) notify(decision === "approve" ? `Correction approved for ${row.personName}.` : `Correction rejected for ${row.personName}.`);
    return error;
  }

  return (
    <Card title="Profile correction requests">
      <div className="stack">
        <Banner message={msg} />
        {hrQueue.length > 0 && (
          <DataTable
            headers={["Employee", "Field", "Current", "Requested", "Reason", "Note", ""]}
            rows={hrQueue.map((c) => [
              <Link key={`p-${c.id}`} to={`/people/${c.personId}`}>
                {c.personName}
              </Link>,
              CORRECTION_FIELD_LABEL[c.field],
              c.currentValue || "—",
              <strong key={`r-${c.id}`}>{c.requestedValue || "—"}</strong>,
              c.reason,
              <input
                key={`n-${c.id}`}
                aria-label="Note"
                value={notes[c.id] ?? ""}
                maxLength={300}
                placeholder="Required to reject"
                onChange={(e) => setNotes({ ...notes, [c.id]: e.target.value })}
              />,
              <span key={`a-${c.id}`} className="row-gap">
                <ActionButton className="btn btn-tiny" onAction={() => decide(c, "approve")}>
                  Approve
                </ActionButton>
                <ActionButton className="btn-ghost btn-tiny" onAction={() => decide(c, "reject")}>
                  Reject
                </ActionButton>
              </span>,
            ])}
          />
        )}
        {mine.length > 0 && (
          <DataTable
            headers={["Field", "Requested", "Raised", "Status", "Note", ""]}
            rows={mine.map((c) => [
              CORRECTION_FIELD_LABEL[c.field],
              c.requestedValue || "—",
              formatShortDate(c.requestedOn),
              <StatusBadge key={`s-${c.id}`} status={c.status} tone={statusTone(c.status)} literal />,
              c.decisionNote || "—",
              c.status === "Pending" ? (
                <ActionButton
                  key={`w-${c.id}`}
                  className="quiet-link"
                  success="Correction request withdrawn."
                  onAction={async () => {
                    const error = await withdrawProfileCorrection(viewer, c.id);
                    setMsg(error ? { tone: "err", text: error } : { tone: "ok", text: "Request withdrawn." });
                    return error;
                  }}
                >
                  Withdraw
                </ActionButton>
              ) : (
                ""
              ),
            ])}
            empty={<EmptyState title="No requests" />}
          />
        )}
      </div>
    </Card>
  );
}

function CorrectionDialog({
  record,
  field,
  viewer,
  onClose,
  onSent,
}: {
  record: PersonRecord;
  field: CorrectionField;
  viewer: DemoAccount;
  onClose: () => void;
  onSent: () => void;
}) {
  const [value, setValue] = useState(field === "managerId" ? "" : currentFieldValue(record, field));
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const managers = useMemo(
    () => listPeople().filter((p) => p.id !== record.id && p.employmentStatus !== "Terminated").sort((a, b) => a.fullName.localeCompare(b.fullName)),
    [record.id],
  );
  const label = CORRECTION_FIELD_LABEL[field];
  const sendAction = useAction();

  async function submit() {
    const manager = field === "managerId" ? managers.find((p) => p.id === value) : undefined;
    const result = await requestProfileCorrection(viewer, {
      field,
      requestedValue: manager ? manager.fullName : value,
      requestedId: manager?.id,
      reason,
    });
    if (result) {
      setError(result);
      return false;
    }
    onSent();
    return true;
  }

  let input: ReactNode;
  if (field === "dateOfBirth") input = <input type="date" value={value} onChange={(e) => setValue(e.target.value)} required />;
  else if (field === "nationality")
    input = (
      <select value={value} onChange={(e) => setValue(e.target.value)}>
        {!NATIONALITIES.includes(value) && <option value={value}>{value || "Choose…"}</option>}
        {NATIONALITIES.map((n) => (
          <option key={n}>{n}</option>
        ))}
      </select>
    );
  else if (field === "workArrangement")
    input = (
      <select value={value} onChange={(e) => setValue(e.target.value)}>
        {WORK_ARRANGEMENTS.map((w) => (
          <option key={w}>{w}</option>
        ))}
      </select>
    );
  else if (field === "managerId")
    input = (
      <select value={value} onChange={(e) => setValue(e.target.value)} required>
        <option value="">Choose…</option>
        {managers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.fullName} · {p.designation}
          </option>
        ))}
      </select>
    );
  else input = <input value={value} maxLength={80} onChange={(e) => setValue(e.target.value)} />;

  return (
    <Dialog open title={`Request correction: ${label}`} onClose={onClose}>
      <form className="stack" onSubmit={sendAction.submit(submit, { success: "Correction request sent to HR." })}>
        <p className="muted" style={{ margin: 0 }}>
          On record: <strong>{currentFieldValue(record, field) || "—"}</strong>
        </p>
        <Field label={`Correct ${label.toLowerCase()}`} wide required>
          {input}
        </Field>
        <Field label="Reason" wide required>
          <textarea rows={3} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="e.g. spelling differs from my passport" required />
        </Field>
        {error && <p className="note err">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <SubmitButton action={sendAction} className="btn">
            Send to HR
          </SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}

/* ───────────── Own details editor ───────────── */

export type OwnEditMode = "personal" | "background";

/**
 * Your own preferred name and languages ("personal") or education, previous jobs and career goals ("background").
 * Saving goes through the verification code: the server (or the local rules) asks for one when a personal detail
 * such as the preferred name changes.
 */
export function OwnDetailsEditor({
  mode,
  record,
  viewer,
  onClose,
  onSaved,
}: {
  mode: OwnEditMode;
  record: PersonRecord;
  viewer: DemoAccount;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [preferredName, setPreferredName] = useState(record.preferredName ?? "");
  const [preferredLanguage, setPreferredLanguage] = useState(record.preferredLanguage ?? "");
  const [languages, setLanguages] = useState<string[]>(record.spokenLanguages ?? []);
  const [newLanguage, setNewLanguage] = useState("");
  const [education, setEducation] = useState<EducationRecord[]>(record.education ?? []);
  const [experience, setExperience] = useState<ExperienceRecord[]>(record.experience ?? []);
  const [careerGoals, setCareerGoals] = useState(record.careerGoals ?? "");
  const [error, setError] = useState("");
  const languageChoices = [...new Set([...PROFILE_LANGUAGES, ...languages])];

  function addLanguage() {
    const clean = newLanguage.trim();
    if (clean && !languages.includes(clean)) setLanguages([...languages, clean]);
    setNewLanguage("");
  }

  const saveAction = useAction();
  const codeFlow = useProfileCode();

  async function submit() {
    setError("");
    if (mode === "personal" && !preferredLanguage.trim()) {
      setError("Choose your preferred language.");
      return false;
    }
    const input = { preferredName, preferredLanguage, spokenLanguages: languages, education, experience, careerGoals };
    const invalid = checkOwnBackground(input);
    if (invalid) {
      setError(invalid);
      return false;
    }
    // Personal details (preferred name, languages) need a code from your TimeZ inbox; the server decides in backend mode.
    const localChanges: Record<string, unknown> = {};
    if (preferredName.trim() !== (record.preferredName ?? "").trim()) localChanges.preferredName = preferredName.trim();
    if (preferredLanguage.trim() !== (record.preferredLanguage ?? "").trim()) localChanges.preferredLanguage = preferredLanguage.trim();
    if (languages.join("|") !== (record.spokenLanguages ?? []).join("|")) localChanges.spokenLanguages = languages;
    const result = await codeFlow.start({
      userId: viewer.id,
      apiChanges: ownBackgroundUpdate(input),
      localChanges,
      save: (otp) => saveOwnBackground(viewer, input, otp ?? undefined),
      onSaved,
    });
    if (typeof result === "string") setError(result);
    return result === true;
  }

  const setEdu = (i: number, patch: Partial<EducationRecord>) => setEducation(education.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  const setExp = (i: number, patch: Partial<ExperienceRecord>) => setExperience(experience.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  return (
    <>
      <Dialog open wide title={mode === "personal" ? "Edit personal details" : "Edit background"} onClose={onClose}>
        <form className="stack" onSubmit={saveAction.submit(submit, { success: mode === "personal" ? "Personal details saved." : "Background saved." })}>
          {mode === "personal" && (
            <>
              <div className="form-grid-2">
                <Field label="Preferred name">
                  <input value={preferredName} maxLength={40} onChange={(e) => setPreferredName(e.target.value)} />
                </Field>
                <Field label="Preferred language" required>
                  <select value={preferredLanguage} onChange={(e) => setPreferredLanguage(e.target.value)}>
                    <option value="">Choose…</option>
                    {languageChoices.map((l) => (
                      <option key={l}>{l}</option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label="Languages you speak" wide>
                <div className="row-gap" style={{ flexWrap: "wrap" }}>
                  {languages.map((l) => (
                    <button key={l} type="button" className="btn-ghost btn-tiny" onClick={() => setLanguages(languages.filter((x) => x !== l))} aria-label={`Remove ${l}`}>
                      {l} ×
                    </button>
                  ))}
                  <input
                    list="profile-language-options"
                    value={newLanguage}
                    maxLength={30}
                    placeholder="Add a language"
                    onChange={(e) => setNewLanguage(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addLanguage();
                      }
                    }}
                  />
                  <datalist id="profile-language-options">
                    {PROFILE_LANGUAGES.filter((l) => !languages.includes(l)).map((l) => (
                      <option key={l} value={l} />
                    ))}
                  </datalist>
                  <button type="button" className="btn-ghost btn-tiny" onClick={addLanguage} disabled={!newLanguage.trim()}>
                    Add
                  </button>
                </div>
              </Field>
              <p className="note">Legal name, date of birth and nationality: use Request correction.</p>
            </>
          )}

          {mode === "background" && (
            <>
              <h3 className="profile-subhead">Education</h3>
              {education.length === 0 && <p className="muted">None added.</p>}
              {education.map((e, i) => (
                <div key={i} className="row-gap" style={{ flexWrap: "wrap", alignItems: "end" }}>
                  <Field label="Degree" required>
                    <input value={e.degree} maxLength={80} onChange={(ev) => setEdu(i, { degree: ev.target.value })} />
                  </Field>
                  <Field label="Institution" required>
                    <input value={e.institution} maxLength={100} onChange={(ev) => setEdu(i, { institution: ev.target.value })} />
                  </Field>
                  <Field label="Year" required>
                    <input type="number" value={e.year || ""} min={1950} max={2040} onChange={(ev) => setEdu(i, { year: Number(ev.target.value) })} style={{ width: 90 }} />
                  </Field>
                  <button type="button" className="quiet-link" onClick={() => setEducation(education.filter((_, j) => j !== i))}>
                    Remove
                  </button>
                </div>
              ))}
              <div>
                <button type="button" className="btn-ghost btn-tiny" onClick={() => setEducation([...education, { degree: "", institution: "", year: new Date().getFullYear() }])}>
                  Add education
                </button>
              </div>

              <h3 className="profile-subhead">Previous employment</h3>
              {experience.length === 0 && <p className="muted">None added.</p>}
              {experience.map((x, i) => (
                <div key={i} className="row-gap" style={{ flexWrap: "wrap", alignItems: "end" }}>
                  <Field label="Company" required>
                    <input value={x.employer} maxLength={80} onChange={(ev) => setExp(i, { employer: ev.target.value })} />
                  </Field>
                  <Field label="Title" required>
                    <input value={x.title} maxLength={80} onChange={(ev) => setExp(i, { title: ev.target.value })} />
                  </Field>
                  <Field label="From" required>
                    <input type="date" value={x.from} onChange={(ev) => setExp(i, { from: ev.target.value })} />
                  </Field>
                  <Field label="To" required>
                    <input type="date" value={x.to} onChange={(ev) => setExp(i, { to: ev.target.value })} />
                  </Field>
                  <button type="button" className="quiet-link" onClick={() => setExperience(experience.filter((_, j) => j !== i))}>
                    Remove
                  </button>
                </div>
              ))}
              <div>
                <button type="button" className="btn-ghost btn-tiny" onClick={() => setExperience([...experience, { employer: "", title: "", from: "", to: "" }])}>
                  Add experience
                </button>
              </div>

              <Field label="Career goals" wide>
                <textarea rows={4} value={careerGoals} maxLength={1000} onChange={(e) => setCareerGoals(e.target.value)} placeholder="Where do you want to grow next?" />
              </Field>
            </>
          )}
          {error && <p className="note err">{error}</p>}
          <div className="dialog-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <SubmitButton action={saveAction} className="btn">
              Save
            </SubmitButton>
          </div>
        </form>
      </Dialog>
      {codeFlow.dialog}
    </>
  );
}
