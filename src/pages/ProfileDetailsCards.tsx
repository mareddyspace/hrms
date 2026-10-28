/** Personal, employment and background sections of a profile, with own-profile editing and HR correction requests. */
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Banner, Card, DataTable, Dialog, EmptyState, Field, StatusBadge } from "../components/ui.tsx";
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
  useProfileCorrections,
  withdrawProfileCorrection,
  type CorrectionField,
  type ProfileCorrection,
} from "../data/profileCorrections.ts";
import type { DemoAccount } from "../demoAccounts.ts";
import { formatShortDate } from "../model.ts";

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
  if (pending) return <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>· correction pending</span>;
  return (
    <button type="button" className="quiet-link" style={{ fontSize: 12, fontWeight: 400 }} onClick={onClick}>
      Request correction
    </button>
  );
}

function monthLabel(value: string): string {
  return /^\d{4}-\d{2}/.test(value) ? formatShortDate(`${value.slice(0, 7)}-01`).replace(/^\d+\s/, "") : value;
}

/* ───────────── Sections ───────────── */

export function ProfileDetailsCards({
  record,
  isMe,
  canSeePersonal,
  canSeeWork,
  viewer,
}: {
  record: PersonRecord;
  isMe: boolean;
  canSeePersonal: boolean;
  canSeeWork: boolean;
  viewer: DemoAccount;
}) {
  const corrections = useProfileCorrections();
  const [correcting, setCorrecting] = useState<CorrectionField | null>(null);
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const pending = (field: CorrectionField) => corrections.some((c) => c.personId === record.id && c.field === field && c.status === "Pending");
  const correct = (field: CorrectionField) => (isMe ? <CorrectButton pending={pending(field)} onClick={() => setCorrecting(field)} /> : undefined);
  const languages = record.spokenLanguages ?? [];

  return (
    <>
      <Banner message={msg} />
      {canSeePersonal && (
        <Card
          title="Personal"
          action={
            isMe ? (
              <button type="button" className="quiet-link" onClick={() => setEditing(true)}>
                Edit
              </button>
            ) : undefined
          }
        >
          <dl className="profile-facts">
            <Fact label="Legal name" value={record.fullName} action={correct("fullName")} />
            <Fact label="Middle name" value={record.middleName} action={correct("middleName")} />
            <Fact label="Preferred name" value={record.preferredName} />
            <Fact label="Date of birth" value={record.dateOfBirth ? formatShortDate(record.dateOfBirth) : ""} action={correct("dateOfBirth")} />
            <Fact label="Nationality" value={record.nationality} action={correct("nationality")} />
            <Fact label="Preferred language" value={record.preferredLanguage} />
            <Fact label="Languages" value={languages.join(", ")} />
          </dl>
        </Card>
      )}

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
          {canSeePersonal && <Fact label="Employment type" value={record.employmentType} />}
          {canSeePersonal && record.contractEndDate && <Fact label="Contract ends" value={formatShortDate(record.contractEndDate)} />}
          {canSeePersonal && record.confirmationDate && <Fact label="Confirmed" value={formatShortDate(record.confirmationDate)} />}
          {canSeePersonal && record.leaveOfAbsence && (
            <Fact
              label="Leave of absence"
              value={`${record.leaveOfAbsence.type} · ${formatShortDate(record.leaveOfAbsence.start)} – ${formatShortDate(record.leaveOfAbsence.end)}`}
            />
          )}
        </dl>
        {isMe && <p className="note">Job details are managed by HR. Use Request correction if something is wrong.</p>}
      </Card>

      {(isMe || canSeeWork) && (
        <Card
          title="Background"
          action={
            isMe ? (
              <button type="button" className="quiet-link" onClick={() => setEditing(true)}>
                Edit
              </button>
            ) : undefined
          }
        >
          <div className="stack">
            <section>
              <h3 className="profile-subhead">Education</h3>
              {(record.education ?? []).length === 0 ? (
                <p className="muted">None listed.</p>
              ) : (
                <ul className="todo">
                  {(record.education ?? []).map((e, i) => (
                    <li key={`${e.degree}-${i}`}>
                      <strong>{e.degree}</strong> · {e.institution} · {e.year}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section>
              <h3 className="profile-subhead">Previous experience</h3>
              {(record.experience ?? []).length === 0 ? (
                <p className="muted">None listed.</p>
              ) : (
                <ul className="todo">
                  {(record.experience ?? []).map((x, i) => (
                    <li key={`${x.employer}-${i}`}>
                      <strong>{x.title}</strong> · {x.employer} · {monthLabel(x.from)} – {monthLabel(x.to)}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section>
              <h3 className="profile-subhead">Career goals</h3>
              {record.careerGoals ? <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{record.careerGoals}</p> : <p className="muted">Not added yet.</p>}
            </section>
          </div>
        </Card>
      )}

      <CorrectionsCard record={record} isMe={isMe} viewer={viewer} rows={corrections} />

      {isMe && editing && (
        <BackgroundEditor
          record={record}
          viewer={viewer}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            setMsg({ tone: "ok", text: "Profile details saved." });
          }}
        />
      )}
      {isMe && correcting && (
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

  function decide(row: ProfileCorrection, decision: "approve" | "reject") {
    const error = decideProfileCorrection(viewer, row.id, decision, notes[row.id] ?? "");
    setMsg(error ? { tone: "err", text: error } : { tone: "ok", text: decision === "approve" ? "Correction approved and applied." : "Correction rejected." });
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
                <button type="button" className="btn btn-tiny" onClick={() => decide(c, "approve")}>
                  Approve
                </button>
                <button type="button" className="btn-ghost btn-tiny" onClick={() => decide(c, "reject")}>
                  Reject
                </button>
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
                <button
                  key={`w-${c.id}`}
                  type="button"
                  className="quiet-link"
                  onClick={() => {
                    const error = withdrawProfileCorrection(viewer, c.id);
                    setMsg(error ? { tone: "err", text: error } : { tone: "ok", text: "Request withdrawn." });
                  }}
                >
                  Withdraw
                </button>
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

  function submit(event: FormEvent) {
    event.preventDefault();
    const manager = field === "managerId" ? managers.find((p) => p.id === value) : undefined;
    const result = requestProfileCorrection(viewer, {
      field,
      requestedValue: manager ? manager.fullName : value,
      requestedId: manager?.id,
      reason,
    });
    if (result) setError(result);
    else onSent();
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
      <form className="stack" onSubmit={submit}>
        <p className="muted" style={{ margin: 0 }}>
          On record: <strong>{currentFieldValue(record, field) || "—"}</strong>
        </p>
        <Field label={`Correct ${label.toLowerCase()}`} wide>
          {input}
        </Field>
        <Field label="Reason" wide>
          <textarea rows={3} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="e.g. spelling differs from my passport" required />
        </Field>
        {error && <p className="note err">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn">
            Send to HR
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/* ───────────── Own background editor ───────────── */

function BackgroundEditor({ record, viewer, onClose, onSaved }: { record: PersonRecord; viewer: DemoAccount; onClose: () => void; onSaved: () => void }) {
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

  function submit(event: FormEvent) {
    event.preventDefault();
    const result = saveOwnBackground(viewer, { preferredName, preferredLanguage, spokenLanguages: languages, education, experience, careerGoals });
    if (result) setError(result);
    else onSaved();
  }

  const setEdu = (i: number, patch: Partial<EducationRecord>) => setEducation(education.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  const setExp = (i: number, patch: Partial<ExperienceRecord>) => setExperience(experience.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  return (
    <Dialog open wide title="Edit profile details" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <div className="form-grid-2">
          <Field label="Preferred name">
            <input value={preferredName} maxLength={40} onChange={(e) => setPreferredName(e.target.value)} />
          </Field>
          <Field label="Preferred language">
            <select value={preferredLanguage} onChange={(e) => setPreferredLanguage(e.target.value)}>
              <option value="">Not set</option>
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

        <h3 className="profile-subhead">Education</h3>
        {education.map((e, i) => (
          <div key={i} className="row-gap" style={{ flexWrap: "wrap", alignItems: "end" }}>
            <Field label="Degree">
              <input value={e.degree} maxLength={80} onChange={(ev) => setEdu(i, { degree: ev.target.value })} />
            </Field>
            <Field label="Institution">
              <input value={e.institution} maxLength={100} onChange={(ev) => setEdu(i, { institution: ev.target.value })} />
            </Field>
            <Field label="Year">
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

        <h3 className="profile-subhead">Previous experience</h3>
        {experience.map((x, i) => (
          <div key={i} className="row-gap" style={{ flexWrap: "wrap", alignItems: "end" }}>
            <Field label="Company">
              <input value={x.employer} maxLength={80} onChange={(ev) => setExp(i, { employer: ev.target.value })} />
            </Field>
            <Field label="Title">
              <input value={x.title} maxLength={80} onChange={(ev) => setExp(i, { title: ev.target.value })} />
            </Field>
            <Field label="From">
              <input type="date" value={x.from} onChange={(ev) => setExp(i, { from: ev.target.value })} />
            </Field>
            <Field label="To">
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
        <p className="note">Name, date of birth, nationality, job and work arrangement are managed by HR.</p>
        {error && <p className="note err">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn">
            Save
          </button>
        </div>
      </form>
    </Dialog>
  );
}
