import { useMemo, useState, type FormEvent } from "react";
import { Banner, Card, Dialog, Field } from "../components/ui.tsx";
import {
  FILTER_OPTIONS,
  NATIONALITIES,
  WORK_ARRANGEMENTS,
  ageOn,
  costCenterFor,
  divisionForDepartment,
  familyForDepartment,
  joinName,
  jobProfileFor,
  nationalityForCountry,
  type EmploymentStatus,
  type PersonRecord,
  type WorkArrangement,
} from "../data/peopleData.ts";
import { recordLifecycleChanges } from "../data/lifecycleHistory.ts";
import {
  getExitDetails,
  isTerminated,
  schedulePersonChange,
  upsertPerson,
  wouldCreateLoop,
  type LocalPersonRecord,
} from "../data/peopleLocal.ts";
import { TIMEZ_COUNTRIES, todayISO } from "../model.ts";
import { LOCATIONS, gradeForTitle } from "../workforce.ts";

const GRADES = ["L3", "L4", "L5", "L6", "M1", "M2", "M3", "E1"];
const GENDERS = ["Female", "Male", "Non-binary", "Unspecified"];
/** Exits go through the exit workflow, so the form never sets Terminated. */
const EDITABLE_STATUSES: EmploymentStatus[] = ["Active", "On Leave", "Contractor"];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const EMPTY_PERSON: Omit<PersonRecord, "id"> = {
  employeeCode: "",
  fullName: "",
  email: "",
  personalEmail: "",
  mobile: "",
  photo: "/profile.svg",
  gender: "Unspecified",
  dateOfJoining: todayISO(),
  employmentType: "Full Time",
  employmentStatus: "Active",
  designation: "",
  jobFamily: "Engineering",
  jobProfileId: "",
  positionId: "",
  grade: "L4",
  department: "Engineering",
  division: divisionForDepartment("Engineering"),
  businessUnit: "Infotech India",
  costCenter: costCenterFor("IN", "Engineering"),
  location: "Bengaluru",
  countryCode: "IN",
  countryName: "India",
  legalEntity: "Infotech India Pvt Ltd",
  managerId: "emp-ram",
  managerName: "Ram Krishnan",
  availability: "In Office",
  timeZone: "Asia/Kolkata",
  currency: "INR",
  address: "Bengaluru, India",
  firstName: "",
  middleName: "",
  lastName: "",
  preferredName: "",
  dateOfBirth: "",
  nationality: "Indian",
  workArrangement: "Office",
  education: [],
  experience: [],
  dependents: [],
};

/** A TZ code no one in the directory already uses. */
function nextEmployeeCode(people: PersonRecord[]): string {
  const taken = new Set(people.map((p) => p.employeeCode.trim().toUpperCase()));
  let n = 8000;
  while (taken.has(`TZ${n}`)) n += 1;
  return `TZ${n}`;
}

function validatePerson(draft: LocalPersonRecord, people: PersonRecord[], isNew: boolean, effectiveDate: string): string[] {
  const errors: string[] = [];
  const today = todayISO();
  const others = people.filter((p) => p.id !== draft.id);
  const code = draft.employeeCode.trim().toUpperCase();
  const email = draft.email.trim().toLowerCase();
  if (!draft.firstName?.trim()) errors.push("First name is required.");
  if (!draft.lastName?.trim()) errors.push("Last name is required.");
  if (!draft.dateOfBirth || !/^\d{4}-\d{2}-\d{2}$/.test(draft.dateOfBirth)) errors.push("Enter the date of birth.");
  else if (draft.dateOfJoining && ageOn(draft.dateOfBirth, draft.dateOfJoining) < 18) {
    errors.push("The employee must be at least 18 on the joining date.");
  } else if (ageOn(draft.dateOfBirth, today) > 80) errors.push("Check the date of birth.");
  if (!code) errors.push("Employee ID is required.");
  else if (others.some((p) => p.employeeCode.trim().toUpperCase() === code)) {
    errors.push(`Employee ID ${code} is already used by someone else.`);
  }
  if (!EMAIL_PATTERN.test(email)) errors.push("Enter a valid work email (name@company.com).");
  else if (others.some((p) => p.email.trim().toLowerCase() === email)) {
    errors.push("That work email already belongs to another employee.");
  }
  if (!draft.designation.trim()) errors.push("Job title is required.");
  if (!draft.department.trim()) errors.push("Department is required.");
  if (!draft.location.trim()) errors.push("Location is required.");
  if (isNew) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.dateOfJoining)) errors.push("Enter the joining date.");
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) {
    errors.push("Enter the date the change takes effect.");
  } else if (draft.dateOfJoining && effectiveDate < draft.dateOfJoining) {
    errors.push("The change cannot take effect before the joining date.");
  }
  if (draft.dateOfJoining > addYears(today, 1)) errors.push("Joining date is too far ahead.");

  // An empty manager means top of the organization.
  if (draft.managerId) {
    const manager = others.find((p) => p.id === draft.managerId);
    if (draft.managerId === draft.id) errors.push("An employee cannot report to themselves.");
    else if (!manager) errors.push("Pick a manager from the directory.");
    else if (isTerminated(manager)) errors.push(`${manager.fullName} is no longer with the company. Pick another manager.`);
    else if (!isNew && wouldCreateLoop(draft.id, draft.managerId)) {
      errors.push(`${manager.fullName} already reports to ${draft.fullName}. Pick someone outside their team.`);
    }
  }
  return errors;
}

/**
 * Save an add/edit and record job changes as dated lifecycle events.
 * An edit dated after today is held and applied on that date. Returns true when it was scheduled.
 */
export function saveEmployee(
  next: LocalPersonRecord,
  effectiveDate: string,
  before: PersonRecord | null,
  actor: { id: string; fullName: string },
): boolean {
  if (before && effectiveDate > todayISO()) {
    const change = schedulePersonChange(before, next, effectiveDate, actor);
    if (change) recordLifecycleChanges(before, next, effectiveDate, actor);
    return Boolean(change);
  }
  upsertPerson(next);
  if (before) recordLifecycleChanges(before, next, effectiveDate, actor);
  return false;
}

function addYears(iso: string, years: number): string {
  const [y, m, d] = iso.split("-");
  return `${Number(y) + years}-${m}-${d}`;
}

export function EmployeeFormDialog({
  open,
  title,
  initial,
  people,
  onClose,
  onSave,
  embedded = false,
}: {
  open: boolean;
  title: string;
  initial: PersonRecord | null;
  people: PersonRecord[];
  onClose: () => void;
  /** effectiveDate is when job changes take effect (the joining date for a new hire). */
  onSave: (person: LocalPersonRecord, effectiveDate: string) => void;
  embedded?: boolean;
}) {
  const freshDraft = (): LocalPersonRecord =>
    initial
      ? {
          ...initial,
          ...getExitDetails(initial),
          ...(initial.managerId === initial.id ? { managerId: "", managerName: "" } : null),
        }
      : { id: `local-${Date.now()}`, ...EMPTY_PERSON, employeeCode: nextEmployeeCode(people) };
  const [draft, setDraft] = useState<LocalPersonRecord>(freshDraft);
  const [effectiveDate, setEffectiveDate] = useState(todayISO());
  const [errors, setErrors] = useState<string[]>([]);
  const [managerQuery, setManagerQuery] = useState("");
  const isNew = !initial;
  const leftCompany = isTerminated(initial);

  const managerOptions = useMemo(() => {
    const needle = managerQuery.trim().toLowerCase();
    const eligible = people.filter(
      (p) =>
        p.id !== draft.id &&
        !isTerminated(p) &&
        (isNew || !wouldCreateLoop(draft.id, p.id)) &&
        (!needle || `${p.fullName} ${p.employeeCode} ${p.designation}`.toLowerCase().includes(needle)),
    );
    const shown = eligible.slice(0, 100);
    const current = people.find((p) => p.id === draft.managerId);
    if (current && !shown.includes(current)) shown.unshift(current);
    return shown;
  }, [people, managerQuery, draft.id, draft.managerId, isNew]);

  if (!open) return null;

  const countryLocations = LOCATIONS[String(draft.countryCode)] ?? [];

  function submit(event: FormEvent) {
    event.preventDefault();
    const nextErrors = validatePerson(draft, people, isNew, effectiveDate);
    setErrors(nextErrors);
    if (nextErrors.length) return;
    const family = familyForDepartment(draft.department);
    const firstName = (draft.firstName ?? "").trim();
    const lastName = (draft.lastName ?? "").trim();
    const middleName = (draft.middleName ?? "").trim();
    // The display name is "First Last"; an existing name is kept when the name parts did not change.
    const namesChanged = !initial || initial.firstName !== firstName || initial.lastName !== lastName;
    onSave(
      {
        ...draft,
        firstName,
        middleName: middleName || undefined,
        lastName,
        preferredName: (draft.preferredName ?? "").trim() || firstName,
        fullName: namesChanged ? joinName(firstName, undefined, lastName) : draft.fullName.trim(),
        employeeCode: draft.employeeCode.trim().toUpperCase(),
        email: draft.email.trim().toLowerCase(),
        designation: draft.designation.trim(),
        jobFamily: family,
        jobProfileId: jobProfileFor(draft.designation, family)?.id ?? draft.jobProfileId,
        division: divisionForDepartment(draft.department),
        costCenter: costCenterFor(String(draft.countryCode), draft.department),
        businessUnit: `Infotech ${draft.countryName}`,
        address: `${draft.location}, ${draft.countryName}`,
      },
      isNew ? draft.dateOfJoining : effectiveDate,
    );
  }

  const form = (
    <form className="stack" onSubmit={submit}>
      {errors.length > 0 && <Banner message={{ tone: "err", text: errors.join(" ") }} />}
      <div className="form-grid-2">
        <Field label="First name">
          <input value={draft.firstName ?? ""} onChange={(e) => setDraft({ ...draft, firstName: e.target.value })} required />
        </Field>
        <Field label="Middle name">
          <input value={draft.middleName ?? ""} onChange={(e) => setDraft({ ...draft, middleName: e.target.value })} />
        </Field>
        <Field label="Last name">
          <input value={draft.lastName ?? ""} onChange={(e) => setDraft({ ...draft, lastName: e.target.value })} required />
        </Field>
        <Field label="Preferred name">
          <input value={draft.preferredName ?? ""} onChange={(e) => setDraft({ ...draft, preferredName: e.target.value })} />
        </Field>
        <Field label="Date of birth">
          <input
            type="date"
            value={draft.dateOfBirth ?? ""}
            max={todayISO()}
            onChange={(e) => setDraft({ ...draft, dateOfBirth: e.target.value })}
            required
          />
        </Field>
        <Field label="Gender">
          <select value={draft.gender} onChange={(e) => setDraft({ ...draft, gender: e.target.value })}>
            {(GENDERS.includes(draft.gender) ? GENDERS : [draft.gender, ...GENDERS]).map((g) => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>
        </Field>
        <Field label="Nationality">
          <select value={draft.nationality ?? ""} onChange={(e) => setDraft({ ...draft, nationality: e.target.value })}>
            {(NATIONALITIES.includes(draft.nationality ?? "") ? NATIONALITIES : [draft.nationality ?? "", ...NATIONALITIES]).map((n) => (
              <option key={n} value={n}>{n || "Choose"}</option>
            ))}
          </select>
        </Field>
        <Field label="Work arrangement">
          <select
            value={draft.workArrangement ?? "Office"}
            onChange={(e) => setDraft({ ...draft, workArrangement: e.target.value as WorkArrangement })}
          >
            {WORK_ARRANGEMENTS.map((w) => (
              <option key={w} value={w}>{w}</option>
            ))}
          </select>
        </Field>
        <Field label="Employee ID">
          <input
            value={draft.employeeCode}
            onChange={(e) => setDraft({ ...draft, employeeCode: e.target.value })}
            required
            disabled={!isNew}
          />
        </Field>
        <Field label="Work email">
          <input type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} required />
        </Field>
        <Field label="Mobile">
          <input value={draft.mobile} onChange={(e) => setDraft({ ...draft, mobile: e.target.value })} />
        </Field>
        <Field label="Joining date">
          <input
            type="date"
            value={draft.dateOfJoining}
            onChange={(e) => setDraft({ ...draft, dateOfJoining: e.target.value })}
            disabled={!isNew}
            required
          />
        </Field>
        <Field label="Job title">
          <input
            value={draft.designation}
            onChange={(e) => setDraft({ ...draft, designation: e.target.value, grade: gradeForTitle(e.target.value) })}
            required
          />
        </Field>
        <Field label="Grade">
          <select value={draft.grade} onChange={(e) => setDraft({ ...draft, grade: e.target.value })}>
            {(GRADES.includes(draft.grade) ? GRADES : [draft.grade, ...GRADES]).map((g) => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>
        </Field>
        <Field label="Department">
          <select value={draft.department} onChange={(e) => setDraft({ ...draft, department: e.target.value })}>
            {FILTER_OPTIONS.departments.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </Field>
        <Field label="Country">
          <select
            value={draft.countryName}
            onChange={(e) => {
              const country = TIMEZ_COUNTRIES.find((c) => c.name === e.target.value);
              if (!country) return;
              const idx = FILTER_OPTIONS.countries.indexOf(country.name);
              setDraft({
                ...draft,
                countryName: country.name,
                countryCode: country.code,
                timeZone: country.timeZone,
                currency: country.currency,
                legalEntity: idx >= 0 ? FILTER_OPTIONS.legalEntities[idx] : draft.legalEntity,
                // A new country means a new office.
                location: LOCATIONS[country.code]?.[0] ?? "",
                ...(isNew ? { nationality: nationalityForCountry(country.code) } : null),
              });
            }}
          >
            {FILTER_OPTIONS.countries.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Field label="Location">
          <select value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.target.value })}>
            {!countryLocations.includes(draft.location) && <option value={draft.location}>{draft.location || "Choose"}</option>}
            {countryLocations.map((loc) => (
              <option key={loc} value={loc}>{loc}</option>
            ))}
          </select>
        </Field>
        <Field label="Employment status">
          {leftCompany ? (
            <input value="Terminated (exit completed)" disabled />
          ) : (
            <select
              value={draft.employmentStatus}
              onChange={(e) => {
                const status = e.target.value as EmploymentStatus;
                setDraft({ ...draft, employmentStatus: status, employmentType: status === "Contractor" ? "Contract" : "Full Time" });
              }}
            >
              {EDITABLE_STATUSES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Manager">
          <div className="people-manager-picker">
            <input
              type="search"
              value={managerQuery}
              onChange={(e) => setManagerQuery(e.target.value)}
              placeholder="Search name or ID…"
              aria-label="Search managers"
            />
            <select
              value={draft.managerId}
              onChange={(e) => {
                const manager = people.find((p) => p.id === e.target.value);
                setDraft({ ...draft, managerId: manager?.id ?? "", managerName: manager?.fullName ?? "" });
              }}
            >
              <option value="">No manager (top of organization)</option>
              {managerOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.fullName} · {p.employeeCode}
                </option>
              ))}
            </select>
          </div>
        </Field>
        {!isNew && (
          <Field label="Changes take effect on">
            <input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} required />
          </Field>
        )}
      </div>
      <div className="dialog-actions" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn">
          Save
        </button>
      </div>
    </form>
  );

  if (embedded) return <Card title={title}>{form}</Card>;

  return (
    <Dialog open={open} title={title} onClose={onClose}>
      {form}
    </Dialog>
  );
}
