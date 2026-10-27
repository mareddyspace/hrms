import { useMemo, useState, useSyncExternalStore } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { Card, EmptyState, FilterBar, Page, StatusBadge } from "../components/ui.tsx";
import { FILTER_OPTIONS, type EmploymentStatus, type PersonRecord } from "../data/peopleData.ts";
import { allReportIds, listPeople, subscribePeople } from "../data/peopleLocal.ts";
import { canManagePeople, canViewPeopleDirectory, getPeopleListScope } from "../data/peoplePermissions.ts";
import { directoryFieldLevel } from "../data/rbac.ts";
import { RegionalFilter } from "../locale/RegionalFilter.tsx";
import { useLocale } from "../locale/LocaleContext.tsx";
import { usePortal } from "../store.tsx";
import { EmployeeFormDialog, saveEmployee } from "./EmployeeFormDialog.tsx";
import { PersonProfilePage } from "./PersonProfilePage.tsx";

function usePeople(): PersonRecord[] {
  return useSyncExternalStore(subscribePeople, listPeople, listPeople);
}

type SortKey = "fullName" | "employeeCode" | "department" | "countryName" | "employmentStatus";
type ViewMode = "list" | "grid";

function statusTone(status: EmploymentStatus): "ok" | "warn" | "danger" {
  if (status === "Active") return "ok";
  if (status === "Terminated") return "danger";
  return "warn";
}

export function PeopleDirectoryPage() {
  const { demoProfile, employee } = usePortal();
  const { matchesRegion, t } = useLocale();
  const people = usePeople();
  const navigate = useNavigate();
  const canEdit = canManagePeople(demoProfile.role);
  const basic = directoryFieldLevel(demoProfile) === "basic";

  const [q, setQ] = useState("");
  const [country, setCountry] = useState("");
  const [legalEntity, setLegalEntity] = useState("");
  const [department, setDepartment] = useState("");
  const [manager, setManager] = useState("");
  const [job, setJob] = useState("");
  const [location, setLocation] = useState("");
  const [status, setStatus] = useState<EmploymentStatus | "">("");
  const [businessUnit, setBusinessUnit] = useState("");
  const [position, setPosition] = useState("");
  const [grade, setGrade] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("fullName");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [view, setView] = useState<ViewMode>("list");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(12);

  const listScope = getPeopleListScope(demoProfile);
  // Business unit, position and grade filters are for HR (company-wide scope) only.
  const hrFilters = listScope === "global";
  // Managers see the people below them in the reporting line (direct and indirect), plus themselves.
  const teamIds = useMemo(
    () => (listScope === "team" ? new Set([employee.id, ...allReportIds(employee.id)]) : null),
    // `people` is listed so the team refreshes after edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [listScope, employee.id, people],
  );

  const scoped = useMemo(
    () =>
      people.filter((p) => {
        if (!matchesRegion(String(p.countryCode), p.countryName)) return false;
        if (listScope === "self") return p.id === employee.id;
        if (teamIds && !teamIds.has(p.id)) return false;
        // The basic directory lists current colleagues only.
        if (basic && p.employmentStatus === "Terminated") return false;
        return true;
      }),
    [people, matchesRegion, listScope, employee.id, teamIds, basic],
  );

  const managers = useMemo(() => [...new Set(scoped.map((p) => p.managerName).filter(Boolean))].sort(), [scoped]);
  const locations = useMemo(() => [...new Set(scoped.map((p) => p.location))].sort(), [scoped]);
  const jobs = useMemo(() => [...new Set(scoped.map((p) => p.designation))].sort(), [scoped]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let rows = scoped.filter((p) => {
      if (country && p.countryName !== country) return false;
      if (department && p.department !== department) return false;
      if (!basic) {
        if (legalEntity && p.legalEntity !== legalEntity) return false;
        if (manager && p.managerName !== manager) return false;
        if (job && p.designation !== job) return false;
        if (location && p.location !== location) return false;
        if (status && p.employmentStatus !== status) return false;
      }
      if (hrFilters) {
        if (businessUnit && p.businessUnit !== businessUnit) return false;
        if (grade && p.grade !== grade) return false;
        if (position && !`${p.positionId} ${p.designation}`.toLowerCase().includes(position.trim().toLowerCase())) return false;
      }
      if (needle) {
        const blob = basic
          ? `${p.fullName} ${p.email} ${p.designation} ${p.department}`
          : hrFilters
            ? `${p.fullName} ${p.employeeCode} ${p.email} ${p.designation} ${p.department} ${p.location} ${p.businessUnit} ${p.positionId} ${p.grade}`
            : `${p.fullName} ${p.employeeCode} ${p.email} ${p.designation} ${p.department} ${p.location}`;
        if (!blob.toLowerCase().includes(needle)) return false;
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
  }, [scoped, q, country, legalEntity, department, manager, job, location, status, businessUnit, grade, position, hrFilters, sortKey, sortDir, basic]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(safePage * pageSize, safePage * pageSize + pageSize);

  function clearFilters() {
    setQ("");
    setCountry("");
    setLegalEntity("");
    setDepartment("");
    setManager("");
    setJob("");
    setLocation("");
    setStatus("");
    setBusinessUnit("");
    setPosition("");
    setGrade("");
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
        <EmptyState title="Not available" description="No access." />
      </Page>
    );
  }

  const sortable: [SortKey, string][] = basic
    ? [
        ["fullName", "Name"],
        ["department", "Department"],
        ["countryName", "Country"],
      ]
    : [
        ["fullName", "Name"],
        ["employeeCode", "Employee ID"],
        ["department", "Department"],
        ["countryName", "Country"],
        ["employmentStatus", "Status"],
      ];

  return (
    <Page
      title="People"
      subtitle={`${filtered.length.toLocaleString()} ${filtered.length === 1 ? "person" : "people"}${
        listScope === "team" ? " in your team" : listScope === "self" ? " (your profile)" : ""
      }`}
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
            Search
            <input
              value={q}
              onChange={(e) => { setQ(e.target.value); setPage(0); }}
              placeholder={basic ? "Name, email or title" : hrFilters ? "Name, ID, position, grade…" : "Name, ID, email or title"}
            />
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
            Department
            <select value={department} onChange={(e) => { setDepartment(e.target.value); setPage(0); }}>
              <option value="">All</option>
              {FILTER_OPTIONS.departments.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          {!basic && (
            <>
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
                Status
                <select value={status} onChange={(e) => { setStatus(e.target.value as EmploymentStatus | ""); setPage(0); }}>
                  <option value="">All</option>
                  {FILTER_OPTIONS.employmentStatuses.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </label>
            </>
          )}
          {hrFilters && (
            <>
              <label className="filter-label">
                Business unit
                <select value={businessUnit} onChange={(e) => { setBusinessUnit(e.target.value); setPage(0); }}>
                  <option value="">All</option>
                  {FILTER_OPTIONS.businessUnits.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label className="filter-label">
                Position
                <input
                  value={position}
                  onChange={(e) => { setPosition(e.target.value); setPage(0); }}
                  placeholder="ID or title"
                />
              </label>
              <label className="filter-label">
                Grade
                <select value={grade} onChange={(e) => { setGrade(e.target.value); setPage(0); }}>
                  <option value="">All</option>
                  {FILTER_OPTIONS.grades.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </label>
            </>
          )}
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
        <EmptyState title="No one matches" description="Try other filters." />
      ) : view === "list" ? (
        <Card>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  {sortable.map(([key, label]) => (
                    <th key={key}>
                      <button type="button" className="table-sort" onClick={() => toggleSort(key)}>
                        {label}
                        {sortKey === key ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                      </button>
                    </th>
                  ))}
                  <th>Work email</th>
                  {!basic && <th>Manager</th>}
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
                    {!basic && <td>{person.employeeCode}</td>}
                    <td>{person.department}</td>
                    <td>{person.countryName}</td>
                    {!basic && (
                      <td>
                        <StatusBadge status={person.employmentStatus} tone={statusTone(person.employmentStatus)} />
                      </td>
                    )}
                    <td>{person.email}</td>
                    {!basic && <td>{person.managerName || "—"}</td>}
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
                {basic ? `${person.department} · ${person.countryName}` : `${person.employeeCode} · ${person.location}`}
              </span>
              {!basic && <StatusBadge status={person.employmentStatus} tone={statusTone(person.employmentStatus)} />}
            </button>
          ))}
        </div>
      )}

      <div className="row-between people-pager">
        <span className="muted">
          Page {safePage + 1} of {pageCount}
        </span>
        <div className="row-gap">
          <button type="button" className="btn-ghost" disabled={safePage <= 0} onClick={() => setPage(Math.max(0, safePage - 1))}>
            Previous
          </button>
          <button
            type="button"
            className="btn-ghost"
            disabled={safePage >= pageCount - 1}
            onClick={() => setPage(Math.min(pageCount - 1, safePage + 1))}
          >
            Next
          </button>
        </div>
      </div>
    </Page>
  );
}

/** /directory/:id — the same profile page as /people/:id (HR gets the Edit button there). */
export function PeopleDetailPage() {
  const { id = "" } = useParams();
  return <PersonProfilePage personId={id} key={id} />;
}

export function PeopleNewPage() {
  const { demoProfile } = usePortal();
  const people = usePeople();
  const navigate = useNavigate();
  if (!canManagePeople(demoProfile.role)) {
    return <Navigate to="/directory" replace />;
  }
  return (
    <Page title="Add employee">
      <EmployeeFormDialog
        open
        embedded
        title="New employee"
        initial={null}
        people={people}
        onClose={() => navigate("/directory")}
        onSave={(next, effectiveDate) => {
          saveEmployee(next, effectiveDate, null, demoProfile);
          navigate(`/directory/${next.id}`);
        }}
      />
    </Page>
  );
}

/** Legacy export name used by App.tsx */
export function DirectoryPage() {
  return <PeopleDirectoryPage />;
}
