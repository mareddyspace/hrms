/**
 * The profile's detail cards (Personal, Contact, Employment, Background & verification) are read-only. Changes go
 * through one "Edit profile" dialog (ProfileEditDialog) opened from the profile header: your own profile saves
 * directly (with a code from your TimeZ inbox for personal details), and HR / admin in scope edit someone else's
 * directly. Job title, department, manager and grade stay HR-only and are not in the dialog for yourself.
 */
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { BadgeCheck, Briefcase, Clock3, GraduationCap, IdCard, Pencil, ShieldAlert, ShieldCheck, Target } from "lucide-react";
import { Card, Dialog, Field, SubmitButton, useAction } from "../components/ui.tsx";
import {
  NATIONALITIES,
  PROFILE_LANGUAGES,
  WORK_ARRANGEMENTS,
  type EducationRecord,
  type ExperienceRecord,
  type PersonRecord,
  type WorkArrangement,
} from "../data/peopleData.ts";
import { getPerson, listPeople, subscribePeople, upsertPerson, type LocalPersonRecord } from "../data/peopleLocal.ts";
import { checkOwnBackground } from "../data/profileCorrections.ts";
import { appendAuditEntries } from "../data/auditTrail.ts";
import type { DemoAccount } from "../demoAccounts.ts";
import { formatShortDate, todayISO } from "../model.ts";
import { API_ENABLED } from "../api/client.ts";
import { revealPersonDetail } from "../api/portalSync.ts";
import { apiUpdateOwnProfile, apiUpdatePerson, type ApiHrProfileUpdate } from "../api/syncProfile.ts";
import { MaskedValue } from "../components/MaskedValue.tsx";
import { useProfileCode } from "../components/ProfileCodeDialog.tsx";
import { canRevealPersonal, personRevealer } from "../data/piiReveal.ts";
import { saveProfileExtras, profileExtrasFor, useProfileExtras } from "../data/profileExtras.ts";
import { usePortal } from "../store.tsx";
import { isMasked } from "../utils/mask.ts";
import { bgvRecordForPerson, canReadAllBgv, getBgvState, subscribeBgv, type BgvCheck, type CheckType } from "../features/compliance/bgvStore.ts";
import "../styles/profile.css";

function Fact({ label, value, wide = false }: { label: string; value?: ReactNode; wide?: boolean }) {
  const empty = value === "" || value === undefined || value === null;
  return (
    <div className={`pi-item${wide ? " wide" : ""}`}>
      <dt>{label}</dt>
      <dd>{empty ? <span className="muted">—</span> : value}</dd>
    </div>
  );
}

function monthLabel(value: string): string {
  return /^\d{4}-\d{2}/.test(value) ? formatShortDate(`${value.slice(0, 7)}-01`).replace(/^\d+\s/, "") : value;
}

function tenure(dateOfJoining: string, today: string): string {
  const [y1, m1] = dateOfJoining.split("-").map(Number);
  const [y2, m2] = today.split("-").map(Number);
  const months = (y2 - y1) * 12 + (m2 - m1);
  if (months < 1) return "joined this month";
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return [years ? `${years} yr${years > 1 ? "s" : ""}` : "", rest ? `${rest} mo` : ""].filter(Boolean).join(" ");
}

/** Whose profile the card shows: your own (isMe), or (HR / admin in scope) someone you may edit. */
export type ProfileEditRights = { isMe: boolean; canHrEdit: boolean };

/* ───────────── Personal ───────────── */

export function PersonalCard({ record, viewer, rights, onEdit }: { record: PersonRecord; viewer: DemoAccount; rights: ProfileEditRights; onEdit?: () => void }) {
  const extras = useProfileExtras(record.id);
  const languages = record.spokenLanguages ?? [];

  return (
    <Card title="Personal" className="prof-card" action={onEdit ? <button type="button" className="btn-ghost btn-tiny" onClick={onEdit}><Pencil size={13} aria-hidden /> Edit</button> : undefined}>
      <dl className="pi-grid two">
        <Fact label="Legal name" value={record.fullName} />
        <Fact label="Preferred name" value={extras.preferredName || record.preferredName} />
        <Fact
          label="Date of birth"
          value={
            record.dateOfBirth ? (
              <MaskedValue
                value={record.dateOfBirth}
                kind="dob"
                canReveal={canRevealPersonal(viewer, record.id, rights.isMe ? record.id : "", true)}
                onReveal={personRevealer(record.id, "date_of_birth", record.dateOfBirth)}
                format={(dob) => (isMasked(dob) ? dob : formatShortDate(dob))}
              />
            ) : (
              ""
            )
          }
        />
        <Fact label="Gender" value={record.gender} />
        <Fact label="Nationality" value={record.nationality} />
        <Fact label="Preferred language" value={record.preferredLanguage} />
        <Fact
          label="Languages"
          wide
          value={
            languages.length ? (
              <span className="pi-chips">
                {languages.map((l) => (
                  <span key={l} className="pi-chip">
                    {l}
                  </span>
                ))}
              </span>
            ) : (
              ""
            )
          }
        />
      </dl>
    </Card>
  );
}

/* ───────────── Contact ───────────── */

/** Contact, home address and emergency contact. `extra` adds rows (LinkedIn) under the work email. */
export function ContactCard({ record, viewer, rights, extra, onEdit }: { record: PersonRecord; viewer: DemoAccount; rights: ProfileEditRights; extra?: ReactNode; onEdit?: () => void }) {
  const { employee } = usePortal();
  const extras = useProfileExtras(record.id);
  const isSelf = rights.isMe;
  const canReveal = canRevealPersonal(viewer, record.id, isSelf ? record.id : "", true);
  // Self-maintained details win over the HR record offline; backend mode shows the server record.
  const personalEmail = extras.personalEmail || record.personalEmail;
  const mobile = API_ENABLED ? record.mobile || (isSelf ? employee.mobile : "") : isSelf ? employee.mobile || record.mobile : record.mobile;
  const address = API_ENABLED ? record.address : isSelf ? employee.address || record.address : record.address;
  const emergencyName = API_ENABLED ? record.emergencyName ?? "" : extras.emergencyName || record.emergencyName || "";
  const emergencyPhone = API_ENABLED ? record.emergencyPhone ?? "" : extras.emergencyPhone || record.emergencyPhone || "";
  const emergencyRelation = API_ENABLED ? record.emergencyRelationship ?? "" : extras.emergencyRelation || record.emergencyRelationship || "";
  const revealAddress =
    API_ENABLED && isMasked(address)
      ? async () => {
          const [line, postcode] = await Promise.all([
            record.addressLine ? revealPersonDetail(record.id, "address_line") : Promise.resolve(null),
            record.addressPostcode ? revealPersonDetail(record.id, "address_postcode") : Promise.resolve(null),
          ]);
          return [line, record.addressCity, postcode, record.addressCountry].filter(Boolean).join(", ");
        }
      : undefined;

  return (
    <Card title="Contact" className="prof-card" action={onEdit ? <button type="button" className="btn-ghost btn-tiny" onClick={onEdit}><Pencil size={13} aria-hidden /> Edit</button> : undefined}>
      <dl className="pi-grid two">
        <Fact label="Work email" wide value={<a href={`mailto:${record.email}`}>{record.email}</a>} />
        {extra && <Fact label="LinkedIn" wide value={extra} />}
        <Fact
          label="Personal email"
          wide
          value={personalEmail ? <MaskedValue value={personalEmail} kind="email" canReveal={canReveal} onReveal={personRevealer(record.id, "personal_email", personalEmail)} /> : ""}
        />
        <Fact label="Mobile" value={mobile ? <MaskedValue value={mobile} kind="phone" canReveal={canReveal} onReveal={personRevealer(record.id, "mobile", mobile)} /> : ""} />
        <Fact label="Time zone" value={record.timeZone} />
        <Fact label="Home address" wide value={address ? <MaskedValue value={address} kind="address" canReveal={canReveal} onReveal={revealAddress} /> : ""} />
        <Fact
          label="Emergency contact"
          wide
          value={
            emergencyName ? (
              <span className="prof-inline">
                <span>
                  {emergencyName}
                  {emergencyRelation ? ` (${emergencyRelation})` : ""}
                </span>
                {emergencyPhone && (
                  <MaskedValue value={emergencyPhone} kind="phone" canReveal={canReveal} onReveal={personRevealer(record.id, "emergency_phone", emergencyPhone)} />
                )}
              </span>
            ) : (
              ""
            )
          }
        />
      </dl>
    </Card>
  );
}

/* ───────────── Employment ───────────── */

export function EmploymentCard({
  record,
  canSeePersonal,
  canSeeWork,
  onEdit,
}: {
  record: PersonRecord;
  viewer?: DemoAccount;
  rights?: ProfileEditRights;
  canSeePersonal: boolean;
  canSeeWork: boolean;
  /** Edits the work arrangement (job, department and manager stay with HR's job record). */
  onEdit?: () => void;
}) {
  const today = todayISO();
  const showHiring = canSeePersonal || canSeeWork;

  return (
    <Card title="Employment" className="prof-card" action={onEdit ? <button type="button" className="btn-ghost btn-tiny" onClick={onEdit}><Pencil size={13} aria-hidden /> Edit</button> : undefined}>
      <dl className="pi-grid two">
        <Fact label="Job title" value={record.designation} />
        <Fact label="Department" value={record.department} />
        <Fact
          label="Manager"
          value={record.managerId ? <Link to={`/people/${record.managerId}`}>{record.managerName || "Manager"}</Link> : record.managerName || "Top of the company"}
        />
        <Fact label="Work arrangement" value={record.workArrangement} />
        {canSeePersonal && <Fact label="Employment type" value={record.employmentType} />}
        {canSeePersonal && record.dateOfJoining && (
          <Fact label="Joined" value={`${formatShortDate(record.dateOfJoining)} · ${tenure(record.dateOfJoining, today)}`} />
        )}
        <Fact label="Company" value={record.company || record.legalEntity} />
        <Fact label="Work location" value={[record.location, record.countryName].filter(Boolean).join(", ")} />
        {showHiring && <Fact label="Hired by" value={record.hiredBy} />}
        {showHiring && <Fact label="Hiring manager" value={record.hiringManager} />}
      </dl>
    </Card>
  );
}

/* ───────────── Verification ───────────── */

type VerifyState = "verified" | "pending" | "failed" | "none" | "expired" | "notstarted";

const VERIFY_LABEL: Record<VerifyState, string> = {
  verified: "Verified",
  pending: "In progress",
  failed: "Not verified",
  none: "Not verified",
  expired: "Expired",
  notstarted: "Not started",
};

function verifyState(check: BgvCheck | undefined, started: boolean): VerifyState {
  if (!check) return "notstarted";
  if (check.status === "Clear") return "verified";
  if (check.status === "Discrepancy" || check.status === "Unable to verify") return "failed";
  return started && check.status === "In progress" ? "pending" : "notstarted";
}

function verifyMeta(check: BgvCheck | undefined, state: VerifyState): string {
  if (!check) return "No verification on file";
  if (state === "verified") return `${check.vendor || "HR"}${check.completedOn ? ` · ${formatShortDate(check.completedOn)}` : ""}`;
  if (state === "failed") return `${check.status}${check.vendor ? ` · ${check.vendor}` : ""}${check.completedOn ? ` · ${formatShortDate(check.completedOn)}` : ""}`;
  if (check.status === "In progress") return `${check.vendor ? `With ${check.vendor}` : "Started"}${check.initiatedOn ? ` since ${formatShortDate(check.initiatedOn)}` : ""}`;
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
 * Education and previous jobs with their background-verification status (vendor, when), plus the ID and other
 * checks. Check details: the person and HR. Managers above see the education and job history only.
 */
export function BackgroundCard({ record, viewer, rights, onEdit }: { record: PersonRecord; viewer: DemoAccount; rights: ProfileEditRights; onEdit?: () => void }) {
  const bgv = useSyncExternalStore(subscribeBgv, getBgvState, getBgvState);
  const people = useSyncExternalStore(subscribePeople, listPeople, listPeople);
  // Saved verification, or the default file everyone has from joining.
  const file = bgvRecordForPerson(record.id, bgv, people);
  const isMe = rights.isMe;
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
    <Card title="Background & verification" className="prof-card bgv-card" action={onEdit ? <button type="button" className="btn-ghost btn-tiny" onClick={onEdit}><Pencil size={13} aria-hidden /> Edit</button> : undefined}>
      {showChecks && (
        <div className="bgv-summary">
          <span className="bgv-summary-icon" aria-hidden>
            <BadgeCheck size={20} />
          </span>
          <div>
            <strong>{file ? `${verifiedCount} of ${checks.length} checks verified` : "Background verification not started"}</strong>
            <span className="muted">
              {file?.consent
                ? `Consent given ${formatShortDate(file.consent.givenOn)}${file.checks[0]?.vendor ? ` · ${file.checks[0].vendor}` : ""}`
                : file
                  ? "Waiting for consent"
                  : "HR starts verification"}
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
 * The detail cards for a profile: Personal (self, reporting line, HR), Employment and Background & verification
 * (self, HR, reporting line). `contact` adds the Contact card after Personal. Editing is the header's Edit profile.
 */
export function ProfileDetailsCards({
  record,
  isMe,
  canSeePersonal,
  canSeeWork,
  viewer,
  canHrEdit = false,
  contact,
}: {
  record: PersonRecord;
  isMe: boolean;
  canSeePersonal: boolean;
  canSeeWork: boolean;
  viewer: DemoAccount;
  canHrEdit?: boolean;
  /** Rendered after the Personal card (the full Contact card on a full profile). */
  contact?: ReactNode;
}) {
  const rights: ProfileEditRights = { isMe, canHrEdit: canHrEdit && !isMe };

  return (
    <>
      {canSeePersonal && <PersonalCard record={record} viewer={viewer} rights={rights} />}
      {contact}
      <EmploymentCard record={record} canSeePersonal={canSeePersonal} canSeeWork={canSeeWork} />
      {(isMe || canSeeWork) && <BackgroundCard record={record} viewer={viewer} rights={rights} />}
    </>
  );
}

/* ───────────── One Edit profile dialog ───────────── */

const GENDERS = ["Female", "Male", "Non-binary", "Unspecified"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

function validPhone(value: string): boolean {
  const digits = value.replace(/\D/g, "").length;
  return /^\+?[\d ()-]+$/.test(value.trim()) && digits >= 8 && digits <= 15;
}

interface ProfileForm {
  firstName: string;
  middleName: string;
  lastName: string;
  preferredName: string;
  dateOfBirth: string;
  gender: string;
  nationality: string;
  preferredLanguage: string;
  languages: string[];
  personalEmail: string;
  mobile: string;
  /** Local mode: one address line. */
  address: string;
  addressLine: string;
  addressCity: string;
  addressPostcode: string;
  addressCountry: string;
  emergencyName: string;
  emergencyRelationship: string;
  emergencyPhone: string;
  workArrangement: string;
  education: EducationRecord[];
  experience: ExperienceRecord[];
  careerGoals: string;
}

/** Fields that arrive masked from the server: they start blank, and blank means "keep what is on file". */
type MaskedKey = "dateOfBirth" | "personalEmail" | "mobile" | "addressLine" | "addressPostcode" | "emergencyPhone";

function startForm(record: PersonRecord, isSelf: boolean, own: { mobile: string; address: string }): { form: ProfileForm; masked: Set<MaskedKey> } {
  const person = getPerson(record.id) ?? record;
  const extras = profileExtrasFor(record.id);
  const masked = new Set<MaskedKey>();
  const keep = (key: MaskedKey, value: string | undefined) => {
    if (isMasked(value)) {
      masked.add(key);
      return "";
    }
    return value ?? "";
  };
  const parts = person.fullName.trim().split(/\s+/);
  const local = !API_ENABLED;
  const form: ProfileForm = {
    firstName: person.firstName ?? parts[0] ?? "",
    middleName: person.middleName ?? (parts.length > 2 ? parts.slice(1, -1).join(" ") : ""),
    lastName: person.lastName ?? (parts.length > 1 ? parts[parts.length - 1] : ""),
    preferredName: (local && extras.preferredName) || person.preferredName || "",
    dateOfBirth: keep("dateOfBirth", person.dateOfBirth),
    gender: person.gender ?? "",
    nationality: person.nationality ?? "",
    preferredLanguage: person.preferredLanguage ?? "",
    languages: person.spokenLanguages ?? [],
    personalEmail: keep("personalEmail", (local && extras.personalEmail) || person.personalEmail),
    mobile: keep("mobile", local && isSelf ? own.mobile || person.mobile : person.mobile),
    address: local && isSelf ? own.address || person.address || "" : person.address || "",
    addressLine: keep("addressLine", person.addressLine),
    addressCity: person.addressCity ?? "",
    addressPostcode: keep("addressPostcode", person.addressPostcode),
    addressCountry: person.addressCountry ?? "",
    emergencyName: (local && extras.emergencyName) || person.emergencyName || "",
    emergencyRelationship: (local && extras.emergencyRelation) || person.emergencyRelationship || "",
    emergencyPhone: keep("emergencyPhone", (local && extras.emergencyPhone) || person.emergencyPhone),
    workArrangement: person.workArrangement ?? "",
    education: person.education ?? [],
    experience: person.experience ?? [],
    careerGoals: person.careerGoals ?? "",
  };
  return { form, masked };
}

const API_KEY: Record<Exclude<keyof ProfileForm, "address">, keyof ApiHrProfileUpdate> = {
  firstName: "first_name",
  middleName: "middle_name",
  lastName: "last_name",
  preferredName: "preferred_name",
  dateOfBirth: "date_of_birth",
  gender: "gender",
  nationality: "nationality",
  preferredLanguage: "preferred_language",
  languages: "languages",
  personalEmail: "personal_email",
  mobile: "mobile",
  addressLine: "address_line",
  addressCity: "address_city",
  addressPostcode: "address_postcode",
  addressCountry: "address_country",
  emergencyName: "emergency_name",
  emergencyRelationship: "emergency_relationship",
  emergencyPhone: "emergency_phone",
  workArrangement: "work_arrangement",
  education: "education",
  experience: "experience",
  careerGoals: "career_goals",
};

const LABEL: Record<keyof ProfileForm, string> = {
  firstName: "First name",
  middleName: "Middle name",
  lastName: "Last name",
  preferredName: "Preferred name",
  dateOfBirth: "Date of birth",
  gender: "Gender",
  nationality: "Nationality",
  preferredLanguage: "Preferred language",
  languages: "Languages",
  personalEmail: "Personal email",
  mobile: "Mobile",
  address: "Home address",
  addressLine: "Address line",
  addressCity: "City",
  addressPostcode: "Postcode",
  addressCountry: "Country",
  emergencyName: "Emergency contact",
  emergencyRelationship: "Emergency relationship",
  emergencyPhone: "Emergency phone",
  workArrangement: "Work arrangement",
  education: "Education",
  experience: "Previous employment",
  careerGoals: "Career goals",
};

/** Kept out of the browser audit trail as values. */
const SENSITIVE = new Set<keyof ProfileForm>(["dateOfBirth", "personalEmail", "mobile", "address", "addressLine", "addressPostcode", "emergencyPhone"]);
/** Personal details that need a code from your TimeZ inbox (local mode; the server decides in backend mode). */
const CODE_FIELDS = new Set<keyof ProfileForm>([
  "firstName", "middleName", "lastName", "preferredName", "dateOfBirth", "preferredLanguage", "languages",
  "personalEmail", "mobile", "address", "emergencyName", "emergencyRelationship", "emergencyPhone",
]);

const clean = (value: ProfileForm[keyof ProfileForm]): unknown =>
  typeof value === "string"
    ? value.trim()
    : value;

const brief = (value: unknown): string => {
  if (value === undefined || value === null || value === "") return "—";
  if (Array.isArray(value)) return value.length ? value.map((v) => (typeof v === "object" ? Object.values(v as object).join(" ") : String(v))).join("; ").slice(0, 80) : "—";
  return String(value).slice(0, 80);
};

/**
 * Edit profile: personal, contact, emergency contact, background and work arrangement in one dialog. Your own
 * profile saves directly through PATCH /people/me (with a code when a personal detail changes); HR / admin in
 * scope save someone else's through PATCH /people/{id}. Job fields are HR-only: `onEditJob` (HR) opens that form.
 */
export type ProfileSection = "personal" | "contact" | "work" | "background";
const SECTION_TITLE: Record<ProfileSection, string> = {
  personal: "personal details",
  contact: "contact details",
  work: "work arrangement",
  background: "background",
};

export function ProfileEditDialog({
  record,
  viewer,
  isSelf,
  onClose,
  onSaved,
  onEditJob,
  section,
}: {
  record: PersonRecord;
  viewer: DemoAccount;
  isSelf: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
  onEditJob?: () => void;
  /** Edit one section only (the card's own Edit button); all sections when left out. */
  section?: ProfileSection;
}) {
  const show = (part: ProfileSection) => !section || section === part;
  const { employee, updateProfile } = usePortal();
  const [{ form: initial, masked }] = useState(() => startForm(record, isSelf, { mobile: employee.mobile, address: employee.address }));
  const [form, setForm] = useState<ProfileForm>(initial);
  const [newLanguage, setNewLanguage] = useState("");
  const [photo, setPhoto] = useState("");
  const [error, setError] = useState("");
  const saveAction = useAction();
  const codeFlow = useProfileCode();
  const set = <K extends keyof ProfileForm>(key: K, value: ProfileForm[K]) => setForm((prev) => ({ ...prev, [key]: value }));
  const text = (key: keyof ProfileForm) => (e: { target: { value: string } }) => set(key, e.target.value as never);
  const languageChoices = [...new Set([...PROFILE_LANGUAGES, ...form.languages])];
  const unchanged = (key: MaskedKey) => (masked.has(key) ? "Unchanged" : "");

  function addLanguage() {
    const value = newLanguage.trim();
    if (value && !form.languages.includes(value)) set("languages", [...form.languages, value]);
    setNewLanguage("");
  }

  function readPhoto(file: File) {
    setError("");
    if (!PHOTO_TYPES.includes(file.type)) return setError("Choose a JPEG, PNG or WebP image.");
    if (file.size > MAX_PHOTO_BYTES) return setError("That photo is larger than 5 MB.");
    const reader = new FileReader();
    reader.onerror = () => setError("Could not read that file. Try another photo.");
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => setError("That file is not a valid image.");
      image.onload = () => {
        const size = 320;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d");
        if (!context) return setError("Could not process that photo in this browser.");
        const scale = Math.max(size / image.width, size / image.height);
        context.drawImage(image, (size - image.width * scale) / 2, (size - image.height * scale) / 2, image.width * scale, image.height * scale);
        setPhoto(canvas.toDataURL("image/jpeg", 0.86));
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  }

  /** The fields that changed (a masked field left blank keeps its value). */
  function changedKeys(): (keyof ProfileForm)[] {
    const keys = (Object.keys(form) as (keyof ProfileForm)[]).filter((key) => (API_ENABLED ? key !== "address" : !["addressLine", "addressCity", "addressPostcode", "addressCountry"].includes(key)));
    return keys.filter((key) => {
      if (masked.has(key as MaskedKey) && !String(form[key]).trim()) return false;
      return JSON.stringify(clean(form[key])) !== JSON.stringify(clean(initial[key]));
    });
  }

  function problem(): string | null {
    if (!form.firstName.trim() || !form.lastName.trim()) return "Enter the first and last name.";
    if (form.personalEmail.trim() && !EMAIL_RE.test(form.personalEmail.trim())) return "Enter a valid personal email address.";
    if (form.mobile.trim() && !validPhone(form.mobile)) return "Enter a valid mobile number: 8–15 digits.";
    if (form.emergencyPhone.trim() && !validPhone(form.emergencyPhone)) return "Enter a valid emergency contact phone: 8–15 digits.";
    if (form.dateOfBirth) {
      const age = new Date().getFullYear() - Number(form.dateOfBirth.slice(0, 4));
      if (age < 15 || age > 90) return "Enter a valid date of birth.";
    }
    return checkOwnBackground({
      preferredName: form.preferredName,
      preferredLanguage: form.preferredLanguage,
      spokenLanguages: form.languages,
      education: form.education,
      experience: form.experience,
      careerGoals: form.careerGoals,
    });
  }

  function apiBody(changed: (keyof ProfileForm)[]): ApiHrProfileUpdate {
    const out: Record<string, unknown> = {};
    for (const key of changed) {
      if (key === "address") continue;
      if (key === "education") out.education = form.education.map((e) => ({ degree: e.degree.trim(), institution: e.institution.trim(), year: Number(e.year) }));
      else if (key === "experience") out.experience = form.experience.map((x) => ({ employer: x.employer.trim(), title: x.title.trim(), from: x.from, to: x.to }));
      else if (key === "languages") out.languages = form.languages;
      else out[API_KEY[key]] = String(form[key]).trim() || null;
    }
    return out as ApiHrProfileUpdate;
  }

  /** Local mode: write the directory record, the personal-details store and (yourself) the signed-in profile. */
  function saveLocal(changed: (keyof ProfileForm)[]): string | null {
    const person = getPerson(record.id) ?? record;
    const has = (key: keyof ProfileForm) => changed.includes(key);
    if (isSelf && (has("mobile") || has("address") || photo)) {
      const failed = updateProfile({
        fullName: employee.fullName,
        designation: employee.designation,
        email: employee.email,
        shiftName: employee.shiftName,
        shiftHours: employee.shiftHours,
        mobile: form.mobile.trim() || employee.mobile,
        address: form.address.trim() || employee.address,
        photo: photo || undefined,
      });
      if (failed) return failed;
    }
    const languages = form.preferredLanguage.trim() && !form.languages.includes(form.preferredLanguage.trim()) ? [form.preferredLanguage.trim(), ...form.languages] : form.languages;
    const first = form.firstName.trim();
    const middle = form.middleName.trim();
    const last = form.lastName.trim();
    const next: LocalPersonRecord = {
      ...(person as LocalPersonRecord),
      firstName: first,
      middleName: middle || undefined,
      lastName: last,
      fullName: [first, middle, last].filter(Boolean).join(" "),
      preferredName: form.preferredName.trim() || first,
      dateOfBirth: form.dateOfBirth || person.dateOfBirth,
      gender: form.gender.trim(),
      nationality: form.nationality.trim(),
      preferredLanguage: form.preferredLanguage.trim(),
      spokenLanguages: languages,
      personalEmail: form.personalEmail.trim(),
      mobile: form.mobile.trim() || person.mobile,
      address: form.address.trim() || person.address,
      emergencyName: form.emergencyName.trim(),
      emergencyRelationship: form.emergencyRelationship.trim(),
      emergencyPhone: form.emergencyPhone.trim(),
      workArrangement: (form.workArrangement || person.workArrangement) as WorkArrangement | undefined,
      education: [...form.education].sort((a, b) => b.year - a.year),
      experience: [...form.experience].sort((a, b) => b.from.localeCompare(a.from)),
      careerGoals: form.careerGoals.trim(),
    };
    upsertPerson(next);
    const extras = profileExtrasFor(record.id);
    saveProfileExtras(record.id, {
      ...extras,
      personalEmail: form.personalEmail.trim(),
      preferredName: form.preferredName.trim(),
      emergencyName: form.emergencyName.trim(),
      emergencyRelation: form.emergencyRelationship.trim(),
      emergencyPhone: form.emergencyPhone.trim(),
    });
    appendAuditEntries([
      {
        at: new Date().toISOString(),
        actorId: viewer.id,
        actorName: viewer.fullName,
        entity: "Employee profile",
        entityId: record.id,
        subjectId: record.id,
        action: "Updated",
        changes: changed.map((key) => ({
          field: LABEL[key],
          before: SENSITIVE.has(key) ? "•••" : brief(clean(initial[key])),
          after: SENSITIVE.has(key) ? "Updated" : brief(clean(form[key])),
        })),
      },
    ]);
    return null;
  }

  async function submit(): Promise<boolean> {
    setError("");
    const invalid = problem();
    if (invalid) {
      setError(invalid);
      return false;
    }
    const changed = changedKeys();
    if (!changed.length && !photo) {
      onClose();  // nothing to save: Save simply closes, like Cancel
      return true;
    }
    const done = () => onSaved(isSelf ? "Profile saved." : `Profile saved for ${record.fullName}.`);
    if (!isSelf) {
      const failed = API_ENABLED ? await apiUpdatePerson(record.id, apiBody(changed)) : saveLocal(changed);
      if (failed) {
        setError(failed);
        return false;
      }
      done();
      return true;
    }
    const body = apiBody(changed);
    const result = await codeFlow.start({
      userId: viewer.id,
      apiChanges: body,
      localChanges: Object.fromEntries(changed.filter((k) => CODE_FIELDS.has(k)).map((k) => [k, clean(form[k])])),
      save: (otp) => {
        if (!API_ENABLED) return saveLocal(changed);
        const withCode: ApiHrProfileUpdate = otp ? { ...body, otp_code: otp } : body;
        return apiUpdateOwnProfile(withCode);
      },
      onSaved: done,
    });
    if (typeof result === "string") setError(result);
    return result === true;
  }

  const what = section ? SECTION_TITLE[section] : "profile";
  const name = isSelf ? `Edit ${what}` : `Edit ${what} · ${record.fullName}`;

  return (
    <>
      <Dialog open wide title={name} onClose={onClose}>
        <form className="stack prof-edit-form" onSubmit={saveAction.submit(submit, { success: "Profile saved." })}>
          {show("personal") && (<>
          {!section && <h3 className="profile-subhead">Personal</h3>}
          <div className="form-grid-2">
            <Field label="First name" required>
              <input value={form.firstName} maxLength={100} onChange={text("firstName")} />
            </Field>
            <Field label="Middle name">
              <input value={form.middleName} maxLength={100} onChange={text("middleName")} />
            </Field>
            <Field label="Last name" required>
              <input value={form.lastName} maxLength={100} onChange={text("lastName")} />
            </Field>
            <Field label="Preferred name">
              <input value={form.preferredName} maxLength={40} onChange={text("preferredName")} />
            </Field>
            <Field label="Date of birth">
              <input type="date" value={form.dateOfBirth} onChange={text("dateOfBirth")} />
              {masked.has("dateOfBirth") && <span className="note">Leave blank to keep the date on file.</span>}
            </Field>
            <Field label="Gender">
              <select value={form.gender} onChange={text("gender")}>
                {!GENDERS.includes(form.gender) && <option value={form.gender}>{form.gender || "Choose…"}</option>}
                {GENDERS.map((g) => (
                  <option key={g}>{g}</option>
                ))}
              </select>
            </Field>
            <Field label="Nationality">
              <select value={form.nationality} onChange={text("nationality")}>
                {!NATIONALITIES.includes(form.nationality) && <option value={form.nationality}>{form.nationality || "Choose…"}</option>}
                {NATIONALITIES.map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </Field>
            <Field label="Preferred language">
              <select value={form.preferredLanguage} onChange={text("preferredLanguage")}>
                <option value="">Choose…</option>
                {languageChoices.map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Languages spoken" wide>
            <div className="row-gap" style={{ flexWrap: "wrap" }}>
              {form.languages.map((l) => (
                <button key={l} type="button" className="btn-ghost btn-tiny" onClick={() => set("languages", form.languages.filter((x) => x !== l))} aria-label={`Remove ${l}`}>
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
                {PROFILE_LANGUAGES.filter((l) => !form.languages.includes(l)).map((l) => (
                  <option key={l} value={l} />
                ))}
              </datalist>
              <button type="button" className="btn-ghost btn-tiny" onClick={addLanguage} disabled={!newLanguage.trim()}>
                Add
              </button>
            </div>
          </Field>
          {isSelf && !API_ENABLED && (
            <Field label="Photo" wide>
              <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => e.target.files?.[0] && readPhoto(e.target.files[0])} />
              <span className="note">{photo ? "New photo ready to save." : "JPEG, PNG or WebP, up to 5 MB."}</span>
            </Field>
          )}
          </>)}

          {show("contact") && (<>
          {!section && <h3 className="profile-subhead">Contact</h3>}
          <div className="form-grid-2">
            <Field label="Personal email">
              <input type="email" value={form.personalEmail} maxLength={255} onChange={text("personalEmail")} placeholder={unchanged("personalEmail")} />
            </Field>
            <Field label="Mobile">
              <input type="tel" inputMode="tel" value={form.mobile} maxLength={32} onChange={text("mobile")} placeholder={unchanged("mobile")} />
            </Field>
            {API_ENABLED ? (
              <>
                <Field label="Address line" wide>
                  <input value={form.addressLine} maxLength={300} onChange={text("addressLine")} placeholder={unchanged("addressLine")} />
                </Field>
                <Field label="City">
                  <input value={form.addressCity} maxLength={100} onChange={text("addressCity")} />
                </Field>
                <Field label="Postcode">
                  <input value={form.addressPostcode} maxLength={20} onChange={text("addressPostcode")} placeholder={unchanged("addressPostcode")} />
                </Field>
                <Field label="Country">
                  <input value={form.addressCountry} maxLength={100} onChange={text("addressCountry")} />
                </Field>
              </>
            ) : (
              <Field label="Home address" wide>
                <input value={form.address} maxLength={300} onChange={text("address")} />
              </Field>
            )}
            <Field label="Emergency contact">
              <input value={form.emergencyName} maxLength={200} onChange={text("emergencyName")} />
            </Field>
            <Field label="Relationship">
              <input value={form.emergencyRelationship} maxLength={64} onChange={text("emergencyRelationship")} />
            </Field>
            <Field label="Emergency phone">
              <input type="tel" inputMode="tel" value={form.emergencyPhone} maxLength={32} onChange={text("emergencyPhone")} placeholder={unchanged("emergencyPhone")} />
            </Field>
          </div>
          </>)}

          {show("work") && (<>
          {!section && <h3 className="profile-subhead">Work arrangement</h3>}
          <div className="form-grid-2">
            <Field label="Work arrangement">
              <select value={form.workArrangement} onChange={text("workArrangement")}>
                {!WORK_ARRANGEMENTS.includes(form.workArrangement as WorkArrangement) && <option value={form.workArrangement}>{form.workArrangement || "Choose…"}</option>}
                {WORK_ARRANGEMENTS.map((w) => (
                  <option key={w}>{w}</option>
                ))}
              </select>
            </Field>
          </div>
          </>)}

          {show("background") && <BackgroundFields
            education={form.education}
            experience={form.experience}
            careerGoals={form.careerGoals}
            setEducation={(next) => set("education", next)}
            setExperience={(next) => set("experience", next)}
            setCareerGoals={(next) => set("careerGoals", next)}
          />}

          {isSelf ? (
            <p className="note">Job title, department, manager and grade are kept by HR.</p>
          ) : (
            onEditJob && (
              <p className="note">
                Job title, department, manager and grade:{" "}
                <button type="button" className="quiet-link" onClick={onEditJob}>
                  edit the job record
                </button>
              </p>
            )
          )}
          <div className="dialog-actions prof-edit-actions">
            {error && <p className="note err prof-edit-error">{error}</p>}
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

function BackgroundFields({
  education,
  experience,
  careerGoals,
  setEducation,
  setExperience,
  setCareerGoals,
}: {
  education: EducationRecord[];
  experience: ExperienceRecord[];
  careerGoals: string;
  setEducation: (next: EducationRecord[]) => void;
  setExperience: (next: ExperienceRecord[]) => void;
  setCareerGoals: (next: string) => void;
}) {
  const setEdu = (i: number, patch: Partial<EducationRecord>) => setEducation(education.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  const setExp = (i: number, patch: Partial<ExperienceRecord>) => setExperience(experience.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <>
      <h3 className="profile-subhead">Education</h3>
      {education.length === 0 && <p className="muted">None added.</p>}
      {education.map((e, i) => (
        <div key={i} className="prof-row">
          <Field label="Degree" required>
            <input value={e.degree} maxLength={80} onChange={(ev) => setEdu(i, { degree: ev.target.value })} />
          </Field>
          <Field label="Institution" required>
            <input value={e.institution} maxLength={100} onChange={(ev) => setEdu(i, { institution: ev.target.value })} />
          </Field>
          <Field label="Year" required>
            <input type="number" value={e.year || ""} min={1950} max={2040} onChange={(ev) => setEdu(i, { year: Number(ev.target.value) })} />
          </Field>
          <button type="button" className="quiet-link prof-row-remove" onClick={() => setEducation(education.filter((_, j) => j !== i))}>
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
        <div key={i} className="prof-row">
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
          <button type="button" className="quiet-link prof-row-remove" onClick={() => setExperience(experience.filter((_, j) => j !== i))}>
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
  );
}
