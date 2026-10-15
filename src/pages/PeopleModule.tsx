import { useMemo, useState, useSyncExternalStore, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import {
  Banner,
  Card,
  Dialog,
  EmptyState,
  Field,
  FilterBar,
  Page,
  StatusBadge,
} from "../components/ui.tsx";
import {
  FILTER_OPTIONS,
  type EmploymentStatus,
  type PersonRecord,
} from "../data/peopleData.ts";
import { getPerson, listPeople, subscribePeople, upsertPerson } from "../data/peopleLocal.ts";
import {
  canManagePeople,
  canViewPeopleDirectory,
  getPeopleListScope,
  getProfileDepth,
} from "../data/peoplePermissions.ts";
import { RegionalFilter } from "../locale/RegionalFilter.tsx";
import { useLocale } from "../locale/LocaleContext.tsx";
import { maskEmail } from "../model.ts";
import { usePortal } from "../store.tsx";
import { Employee360View } from "./Employee360View.tsx";

function usePeople(): PersonRecord[] {
  return useSyncExternalStore(subscribePeople, listPeople, listPeople);
}

type SortKey = "fullName" | "employeeCode" | "department" | "countryName" | "employmentStatus";
type ViewMode = "list" | "grid";

const EMPTY_FORM: Omit<PersonRecord, "id"> = {
  employeeCode: "",
  fullName: "",
  email: "",
  personalEmail: "",
  mobile: "",
  photo: "/profile.svg",
  gender: "Unspecified",
  dateOfJoining: new Date().toISOString().slice(0, 10),
  employmentType: "Full Time",
  employmentStatus: "Active",
  designation: "",
  jobFamily: "Engineering",
  jobProfileId: "JP-NEW-1",
  positionId: "POS-NEW",
  grade: "L4",
  department: "Engineering",
  division: "Engineering Delivery",
  businessUnit: "Infotech India",
  costCenter: "CC-IN-1",
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
};

function validatePerson(draft: Omit<PersonRecord, "id"> | PersonRecord): string[] {
  const errors: string[] = [];
  if (!draft.fullName.trim()) errors.push("Full name is required.");
  if (!draft.employeeCode.trim()) errors.push("Employee ID is required.");
  if (!draft.email.trim() || !draft.email.includes("@")) errors.push("Valid work email is required.");
  if (!draft.designation.trim()) errors.push("Job title is required.");
  if (!draft.department.trim()) errors.push("Department is required.");
  return errors;
}

export function PeopleDirectoryPage() {
  const { demoProfile, employee } = usePortal();
  const { matchesRegion, t } = useLocale();
  const people = usePeople();
  const navigate = useNavigate();
  const canEdit = canManagePeople(demoProfile.role);

  const [q, setQ] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [country, setCountry] = useState("");
  const [legalEntity, setLegalEntity] = useState("");
  const [department, setDepartment] = useState("");
  const [manager, setManager] = useState("");
  const [job, setJob] = useState("");
  const [location, setLocation] = useState("");
  const [status, setStatus] = useState<EmploymentStatus | "">("");
  const [sortKey, setSortKey] = useState<SortKey>("fullName");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [view, setView] = useState<ViewMode>("list");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(12);

  const managers = useMemo(
    () => [...new Set(people.map((p) => p.managerName))].sort(),
    [people],
  );
  const locations = useMemo(
    () => [...new Set(people.map((p) => p.location))].sort(),
    [people],
  );
  const jobs = useMemo(
    () => [...new Set(people.map((p) => p.designation))].sort().slice(0, 80),
    [people],
  );

  const listScope = getPeopleListScope(demoProfile);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let rows = people.filter((p) => {
      if (!matchesRegion(String(p.countryCode), p.countryName)) return false;

      // RBAC people-list scope
      if (listScope === "self") {
        if (p.id !== employee.id && p.employeeCode !== employee.employeeCode) return false;
      } else if (listScope === "team") {
        const isSelf = p.id === employee.id || p.employeeCode === employee.employeeCode;
        const isReport = p.managerId === employee.id || p.managerName === employee.fullName;
        const sameDept = p.department === (employee.department ?? "");
        if (!isSelf && !isReport && !sameDept) return false;
      }
      // org / global → all (still region-filtered)

      if (employeeId && !p.employeeCode.toLowerCase().includes(employeeId.toLowerCase())) return false;
      if (name && !p.fullName.toLowerCase().includes(name.toLowerCase())) return false;
      if (email && !p.email.toLowerCase().includes(email.toLowerCase())) return false;
      if (country && p.countryName !== country) return false;
      if (legalEntity && p.legalEntity !== legalEntity) return false;
      if (department && p.department !== department) return false;
      if (manager && p.managerName !== manager) return false;
      if (job && p.designation !== job) return false;
      if (location && p.location !== location) return false;
      if (status && p.employmentStatus !== status) return false;
      if (needle) {
        const blob = `${p.fullName} ${p.employeeCode} ${p.email} ${p.department} ${p.location}`.toLowerCase();
        if (!blob.includes(needle)) return false;
      }
      return true;
    });
    rows = [...rows].sort((a, b) => {
      const av = String(a[sortKey] ?? "");
      const bv = String(b[sortKey] ?? "");
      const cmp = av.localeCompare(bv, undefined, { numeric: true });
      return sortDir === "asc" ? cmp : -cmp;
    });
    return rows;
  }, [
    people,
    q,
    employeeId,
    name,
    email,
    country,
    legalEntity,
    department,
    manager,
    job,
    location,
    status,
    sortKey,
    sortDir,
    matchesRegion,
    listScope,
    employee,
  ]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(safePage * pageSize, safePage * pageSize + pageSize);

  function clearFilters() {
    setQ("");
    setEmployeeId("");
    setName("");
    setEmail("");
    setCountry("");
    setLegalEntity("");
    setDepartment("");
    setManager("");
    setJob("");
    setLocation("");
    setStatus("");
    setPage(0);
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  if (!canViewPeopleDirectory(demoProfile)) {
    return (
      <Page title="People">
        <EmptyState
          title="Not authorized"
          description="This demo persona does not include People directory access in navAccess."
        />
      </Page>
    );
  }

  return (
    <Page
      title="People"
      subtitle={`${filtered.length.toLocaleString()} in scope (${listScope}) · ${people.length.toLocaleString()} total demo records`}
      action={
        canEdit ? (
          <Link className="btn" to="/directory/new">
            Add employee
          </Link>
        ) : undefined
      }
    >
      <Card title={`${t("common.filter")} & search`}>
        <FilterBar>
          <RegionalFilter label={t("locale.region")} />
          <label className="filter-label">
            Quick search
            <input value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} placeholder="Name, ID, email…" />
          </label>
          <label className="filter-label">
            Employee ID
            <input value={employeeId} onChange={(e) => { setEmployeeId(e.target.value); setPage(0); }} />
          </label>
          <label className="filter-label">
            Name
            <input value={name} onChange={(e) => { setName(e.target.value); setPage(0); }} />
          </label>
          <label className="filter-label">
            Email
            <input value={email} onChange={(e) => { setEmail(e.target.value); setPage(0); }} />
          </label>
          <label className="filter-label">
            Country
            <select value={country} onChange={(e) => { setCountry(e.target.value); setPage(0); }}>
              <option value="">All</option>
              {FILTER_OPTIONS.countries.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="filter-label">
            Legal entity
            <select value={legalEntity} onChange={(e) => { setLegalEntity(e.target.value); setPage(0); }}>
              <option value="">All</option>
              {FILTER_OPTIONS.legalEntities.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="filter-label">
            Department
            <select value={department} onChange={(e) => { setDepartment(e.target.value); setPage(0); }}>
              <option value="">All</option>
              {FILTER_OPTIONS.departments.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="filter-label">
            Manager
            <select value={manager} onChange={(e) => { setManager(e.target.value); setPage(0); }}>
              <option value="">All</option>
              {managers.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="filter-label">
            Job
            <select value={job} onChange={(e) => { setJob(e.target.value); setPage(0); }}>
              <option value="">All</option>
              {jobs.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="filter-label">
            Location
            <select value={location} onChange={(e) => { setLocation(e.target.value); setPage(0); }}>
              <option value="">All</option>
              {locations.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="filter-label">
            Employment status
            <select value={status} onChange={(e) => { setStatus(e.target.value as EmploymentStatus | ""); setPage(0); }}>
              <option value="">All</option>
              {FILTER_OPTIONS.employmentStatuses.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
        </FilterBar>
        <div className="row-between" style={{ marginTop: 8 }}>
          <div className="row-gap">
            <button type="button" className="btn-ghost" onClick={clearFilters}>
              Clear filters
            </button>
            <div className="soft-tabs" role="group" aria-label="View mode">
              <button type="button" className={view === "list" ? "soft-tab active" : "soft-tab"} onClick={() => setView("list")}>
                List
              </button>
              <button type="button" className={view === "grid" ? "soft-tab active" : "soft-tab"} onClick={() => setView("grid")}>
                Grid
              </button>
            </div>
          </div>
          <label className="filter-label">
            Page size
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(0);
              }}
            >
              {[12, 24, 50, 100].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
        </div>
      </Card>

      {filtered.length === 0 ? (
        <EmptyState title="No employees match" description="Try clearing filters or broadening search." />
      ) : view === "list" ? (
        <Card>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  {(
                    [
                      ["fullName", "Name"],
                      ["employeeCode", "Employee ID"],
                      ["department", "Department"],
                      ["countryName", "Country"],
                      ["employmentStatus", "Status"],
                    ] as [SortKey, string][]
                  ).map(([key, label]) => (
                    <th key={key}>
                      <button type="button" className="table-sort" onClick={() => toggleSort(key)}>
                        {label}
                        {sortKey === key ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                      </button>
                    </th>
                  ))}
                  <th>Email</th>
                  <th>Manager</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pageRows.map((person) => (
                  <tr key={person.id}>
                    <td>
                      <div className="people-name-cell">
                        <img src={person.photo} alt="" />
                        <div>
                          <strong>{person.fullName}</strong>
                          <span className="muted">{person.designation}</span>
                        </div>
                      </div>
                    </td>
                    <td>{person.employeeCode}</td>
                    <td>{person.department}</td>
                    <td>{person.countryName}</td>
                    <td>
                      <StatusBadge
                        status={person.employmentStatus}
                        tone={
                          person.employmentStatus === "Active"
                            ? "ok"
                            : person.employmentStatus === "Terminated"
                              ? "danger"
                              : "warn"
                        }
                      />
                    </td>
                    <td>{maskEmail(person.email)}</td>
                    <td>{person.managerName}</td>
                    <td>
                      <Link to={`/directory/${person.id}`}>Open</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
        <div className="people-grid">
          {pageRows.map((person) => (
            <button
              key={person.id}
              type="button"
              className="people-grid-card"
              onClick={() => navigate(`/directory/${person.id}`)}
            >
              <img src={person.photo} alt="" />
              <strong>{person.fullName}</strong>
              <span>{person.designation}</span>
              <span className="muted">
                {person.employeeCode} · {person.location}
              </span>
              <StatusBadge status={person.employmentStatus} tone={person.employmentStatus === "Active" ? "ok" : "warn"} />
            </button>
          ))}
        </div>
      )}

      <div className="row-between people-pager">
        <span className="muted">
          Page {safePage + 1} of {pageCount}
          {employee.id ? ` · Signed in as ${employee.fullName}` : ""}
        </span>
        <div className="row-gap">
          <button type="button" className="btn-ghost" disabled={safePage <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            Previous
          </button>
          <button
            type="button"
            className="btn-ghost"
            disabled={safePage >= pageCount - 1}
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
          >
            Next
          </button>
        </div>
      </div>
    </Page>
  );
}

export function PeopleDetailPage() {
  const { id = "" } = useParams();
  const { demoProfile, employee } = usePortal();
  const people = usePeople();
  const person = useMemo(() => getPerson(id) ?? people.find((p) => p.id === id), [id, people]);
  const canEdit = canManagePeople(demoProfile.role);
  const [editOpen, setEditOpen] = useState(false);

  if (!person) {
    return (
      <Page title="Employee">
        <EmptyState title="Employee not found" description="This ID is not in the Infotech demo directory." />
        <Link to="/directory" className="btn">
          Back to People
        </Link>
      </Page>
    );
  }

  const depth = getProfileDepth(demoProfile, {
    subjectId: person.id,
    selfId: employee.id,
    isDirectReport: person.managerId === employee.id || person.managerName === employee.fullName,
    inHrScope: true,
  });

  if (depth === "none") {
    return (
      <Page title="Employee">
        <EmptyState
          title="Profile restricted"
          description={`${demoProfile.personaLabel} cannot open this colleague's profile under current RBAC rules.`}
        />
        <Link to="/directory" className="btn">
          Back to People
        </Link>
      </Page>
    );
  }

  return (
    <Page title="Employee 360" subtitle={`${person.fullName} · ${person.employeeCode}`}>
      <Employee360View
        person={person}
        viewer={demoProfile}
        selfId={employee.id}
        onEdit={canEdit && depth === "full_hr" ? () => setEditOpen(true) : undefined}
      />
      <EmployeeFormDialog
        open={editOpen}
        title="Edit employee"
        initial={person}
        onClose={() => setEditOpen(false)}
        onSave={(next) => {
          upsertPerson(next);
          setEditOpen(false);
        }}
      />
    </Page>
  );
}

export function PeopleNewPage() {
  const { demoProfile } = usePortal();
  const navigate = useNavigate();
  if (!canManagePeople(demoProfile.role)) {
    return <Navigate to="/directory" replace />;
  }
  return (
    <Page title="Add employee" subtitle="Creates a local demo record only (localStorage overlay).">
      <EmployeeFormDialog
        open
        embedded
        title="New employee"
        initial={null}
        onClose={() => navigate("/directory")}
        onSave={(next) => {
          upsertPerson(next);
          navigate(`/directory/${next.id}`);
        }}
      />
    </Page>
  );
}

function EmployeeFormDialog({
  open,
  title,
  initial,
  onClose,
  onSave,
  embedded = false,
}: {
  open: boolean;
  title: string;
  initial: PersonRecord | null;
  onClose: () => void;
  onSave: (person: PersonRecord) => void;
  embedded?: boolean;
}) {
  const [draft, setDraft] = useState<PersonRecord>(
    () =>
      initial ?? {
        id: `local-${Date.now()}`,
        ...EMPTY_FORM,
        employeeCode: `TZ${String(Math.floor(8000 + Math.random() * 1000))}`,
      },
  );
  const [errors, setErrors] = useState<string[]>([]);

  if (!open) return null;

  function submit(event: FormEvent) {
    event.preventDefault();
    const nextErrors = validatePerson(draft);
    setErrors(nextErrors);
    if (nextErrors.length) return;
    onSave({
      ...draft,
      fullName: draft.fullName.trim(),
      employeeCode: draft.employeeCode.trim().toUpperCase(),
      email: draft.email.trim().toLowerCase(),
    });
  }

  const form = (
    <form className="stack" onSubmit={submit}>
      {errors.length > 0 && (
        <Banner message={{ tone: "err", text: errors.join(" ") }} />
      )}
      <div className="form-grid-2">
        <Field label="Full name">
          <input value={draft.fullName} onChange={(e) => setDraft({ ...draft, fullName: e.target.value })} required />
        </Field>
        <Field label="Employee ID">
          <input
            value={draft.employeeCode}
            onChange={(e) => setDraft({ ...draft, employeeCode: e.target.value })}
            required
            disabled={!!initial}
          />
        </Field>
        <Field label="Work email">
          <input type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} required />
        </Field>
        <Field label="Mobile">
          <input value={draft.mobile} onChange={(e) => setDraft({ ...draft, mobile: e.target.value })} />
        </Field>
        <Field label="Job title">
          <input value={draft.designation} onChange={(e) => setDraft({ ...draft, designation: e.target.value })} required />
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
              const countryName = e.target.value;
              const idx = FILTER_OPTIONS.countries.findIndex((c) => c === countryName);
              setDraft({
                ...draft,
                countryName,
                legalEntity: idx >= 0 ? FILTER_OPTIONS.legalEntities[idx] : draft.legalEntity,
              });
            }}
          >
            {FILTER_OPTIONS.countries.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Field label="Location">
          <input value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.target.value })} />
        </Field>
        <Field label="Legal entity">
          <select value={draft.legalEntity} onChange={(e) => setDraft({ ...draft, legalEntity: e.target.value })}>
            {FILTER_OPTIONS.legalEntities.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Field label="Employment status">
          <select
            value={draft.employmentStatus}
            onChange={(e) => setDraft({ ...draft, employmentStatus: e.target.value as EmploymentStatus })}
          >
            {FILTER_OPTIONS.employmentStatuses.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Field label="Manager name">
          <input value={draft.managerName} onChange={(e) => setDraft({ ...draft, managerName: e.target.value })} />
        </Field>
        <Field label="Grade">
          <input value={draft.grade} onChange={(e) => setDraft({ ...draft, grade: e.target.value })} />
        </Field>
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

/** Legacy export name used by App.tsx */
export function DirectoryPage() {
  return <PeopleDirectoryPage />;
}
