import { useMemo, useState, useSyncExternalStore } from "react";
import { Link, useParams } from "react-router-dom";
import {
  Card,
  DataTable,
  EmptyState,
  FilterBar,
  MetricCard,
  MetricGrid,
  Page,
  StatusBadge,
  Tabs,
} from "../components/ui.tsx";
import {
  JOB_FAMILIES,
  JOB_PROFILES,
  ORG_CHANGE_HISTORY,
  POSITIONS,
  buildOrgTree,
  type OrgNode,
  type PositionRecord,
} from "../data/peopleData.ts";
import { listPeople, subscribePeople } from "../data/peopleLocal.ts";
import { hasModuleAccess } from "../data/peoplePermissions.ts";
import { TZ_HEADCOUNT } from "../data/dashboardMock.ts";
import { LocaleContextBanner, RegionalFilter } from "../locale/RegionalFilter.tsx";
import { useLocale } from "../locale/LocaleContext.tsx";
import { usePortal } from "../store.tsx";

function usePeople() {
  return useSyncExternalStore(subscribePeople, listPeople, listPeople);
}

function OrgTreeNode({
  node,
  expanded,
  toggle,
  depth = 0,
}: {
  node: OrgNode;
  expanded: Set<string>;
  toggle: (id: string) => void;
  depth?: number;
}) {
  const hasChildren = !!node.children?.length;
  const isOpen = expanded.has(node.id);
  return (
    <li className="org-tree-node" style={{ marginLeft: depth ? 16 : 0 }}>
      <div className="org-tree-row">
        {hasChildren ? (
          <button type="button" className="org-tree-toggle" onClick={() => toggle(node.id)} aria-expanded={isOpen}>
            {isOpen ? "▾" : "▸"}
          </button>
        ) : (
          <span className="org-tree-spacer" />
        )}
        <div>
          <strong>{node.name}</strong>
          <span className="muted">
            {" "}
            · {node.type}
            {typeof node.headcount === "number" ? ` · ${node.headcount}` : ""}
            {node.managerName ? ` · Mgr: ${node.managerName}` : ""}
          </span>
        </div>
      </div>
      {hasChildren && isOpen && (
        <ul className="org-tree-list">
          {node.children!.map((child) => (
            <OrgTreeNode key={child.id} node={child} expanded={expanded} toggle={toggle} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function OrganizationPage() {
  const { demoProfile } = usePortal();
  const { activeCountry, t, matchesRegion } = useLocale();
  const people = usePeople();
  const scopedPeople = useMemo(
    () => people.filter((p) => matchesRegion(String(p.countryCode), p.countryName)),
    [people, matchesRegion],
  );
  const tree = useMemo(() => buildOrgTree(scopedPeople.length ? scopedPeople : people), [scopedPeople, people]);
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(["company-timez", "country-IN", "country-US"]),
  );
  const [tab, setTab] = useState("chart");
  const [countryFilter, setCountryFilter] = useState("");

  const relationships = useMemo(() => {
    return scopedPeople
      .filter((p) => p.employmentStatus === "Active")
      .filter((p) => !countryFilter || p.countryName === countryFilter)
      .slice(0, 40)
      .map((p) => [p.fullName, p.employeeCode, p.designation, p.managerName, p.department, p.location]);
  }, [scopedPeople, countryFilter]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (!hasModuleAccess(demoProfile, "organization") && !hasModuleAccess(demoProfile, "*")) {
    return (
      <Page title="Organization">
        <EmptyState title="Not authorized" description="Organization module is outside this persona's navAccess." />
      </Page>
    );
  }

  return (
    <Page
      title="Organization"
      subtitle={`${activeCountry.legalEntity} · ${activeCountry.name}`}
    >
      <LocaleContextBanner />
      <FilterBar>
        <RegionalFilter label={t("locale.region")} />
      </FilterBar>
      <Card title="Country & legal entity (active demo region)">
        <dl className="info-grid">
          <div className="info-fact"><dt>Country</dt><dd>{activeCountry.name} ({activeCountry.code})</dd></div>
          <div className="info-fact"><dt>Legal entity</dt><dd>{activeCountry.legalEntity}</dd></div>
          <div className="info-fact"><dt>Currency</dt><dd>{activeCountry.currency}</dd></div>
          <div className="info-fact"><dt>Time zone</dt><dd>{activeCountry.timeZone}</dd></div>
        </dl>
      </Card>
      <MetricGrid>
        <MetricCard label="Global headcount" value={tree.headcount ?? TZ_HEADCOUNT.global} />
        <MetricCard label="Countries" value={TZ_HEADCOUNT.byCountry.length} />
        <MetricCard label="Business units" value={TZ_HEADCOUNT.byBusinessUnit.length} />
        <MetricCard label="Departments" value={TZ_HEADCOUNT.byDepartment.length} />
      </MetricGrid>

      <Tabs
        tabs={[
          { id: "chart", label: "Org chart" },
          { id: "relations", label: "Reporting relationships" },
          { id: "history", label: "Change history" },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "chart" && (
        <Card
          title="Hierarchy"
          action={
            <div className="row-gap">
              <button
                type="button"
                className="btn-ghost"
                onClick={() =>
                  setExpanded(
                    new Set([
                      "company-timez",
                      ...(tree.children ?? []).map((c) => c.id),
                    ]),
                  )
                }
              >
                Expand countries
              </button>
              <button type="button" className="btn-ghost" onClick={() => setExpanded(new Set(["company-timez"]))}>
                Collapse
              </button>
            </div>
          }
        >
          <ul className="org-tree-list">
            <OrgTreeNode node={tree} expanded={expanded} toggle={toggle} />
          </ul>
        </Card>
      )}

      {tab === "relations" && (
        <Card title="Employee → manager">
          <FilterBar>
            <label className="filter-label">
              Country
              <select value={countryFilter} onChange={(e) => setCountryFilter(e.target.value)}>
                <option value="">All</option>
                {TZ_HEADCOUNT.byCountry.map((c) => (
                  <option key={c.code} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          </FilterBar>
          <DataTable
            headers={["Employee", "ID", "Title", "Manager", "Department", "Location"]}
            rows={relationships}
            empty={<EmptyState title="No rows" description="No active employees for this filter." />}
          />
          <p className="note">Showing up to 40 rows. Full directory is under People.</p>
        </Card>
      )}

      {tab === "history" && (
        <Card title="Demo organization-change history">
          <DataTable
            headers={["Date", "Type", "Summary", "Actor"]}
            rows={ORG_CHANGE_HISTORY.map((e) => [e.date, e.type, e.summary, e.actor])}
          />
        </Card>
      )}
    </Page>
  );
}

export function JobsPage() {
  const { demoProfile } = usePortal();
  const people = usePeople();
  const [tab, setTab] = useState("families");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [family, setFamily] = useState("");
  const [selectedId, setSelectedId] = useState(POSITIONS[0]?.id ?? "");
  const { id } = useParams();

  const profiles = useMemo(() => {
    return JOB_PROFILES.filter((p) => {
      if (family && p.familyName !== family) return false;
      if (q && !`${p.title} ${p.id}`.toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    });
  }, [q, family]);

  const positions = useMemo(() => {
    return POSITIONS.filter((p) => {
      if (status && p.status !== status) return false;
      if (family && p.jobFamily !== family) return false;
      if (q && !`${p.title} ${p.code} ${p.location}`.toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    });
  }, [q, status, family]);

  const selected: PositionRecord | undefined =
    POSITIONS.find((p) => p.id === (id || selectedId) || p.code === id) ??
    POSITIONS.find((p) => p.id === selectedId) ??
    positions[0];

  if (!hasModuleAccess(demoProfile, "jobs") && !hasModuleAccess(demoProfile, "*")) {
    return (
      <Page title="Jobs & Positions">
        <EmptyState title="Not authorized" description="Jobs & Positions is outside this persona's navAccess." />
      </Page>
    );
  }

  return (
    <Page title="Jobs & Positions" subtitle="Job families, profiles, and position inventory">
      <FilterBar>
        <label className="filter-label">
          Search
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title, code, location…" />
        </label>
        <label className="filter-label">
          Job family
          <select value={family} onChange={(e) => setFamily(e.target.value)}>
            <option value="">All</option>
            {JOB_FAMILIES.map((f) => (
              <option key={f.id} value={f.name}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-label">
          Position status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="Open">Open</option>
            <option value="Filled">Filled</option>
            <option value="Frozen">Frozen</option>
          </select>
        </label>
      </FilterBar>

      <Tabs
        tabs={[
          { id: "families", label: "Job families" },
          { id: "profiles", label: "Job profiles" },
          { id: "positions", label: "Positions" },
          { id: "detail", label: "Position detail" },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "families" && (
        <Card title="Job families">
          <DataTable
            headers={["Family", "Profiles", "Active people (approx)"]}
            rows={JOB_FAMILIES.map((f) => [
              f.name,
              String(f.profiles),
              String(people.filter((p) => p.jobFamily === f.name && p.employmentStatus === "Active").length),
            ])}
          />
        </Card>
      )}

      {tab === "profiles" && (
        <Card title="Job profiles">
          {profiles.length === 0 ? (
            <EmptyState title="No profiles" description="No job profiles match the current filters." />
          ) : (
            <DataTable
              headers={["ID", "Title", "Family", "Grade band", "Description"]}
              rows={profiles.map((p) => [p.id, p.title, p.familyName, p.gradeBand, p.description])}
            />
          )}
        </Card>
      )}

      {tab === "positions" && (
        <Card title="Positions">
          {positions.length === 0 ? (
            <EmptyState title="No positions" description="No positions match the current filters." />
          ) : (
            <DataTable
              headers={["Code", "Title", "Grade", "Country", "Location", "Manager", "Status", ""]}
              rows={positions.map((p) => [
                p.code,
                p.title,
                p.grade,
                p.country,
                p.location,
                p.managerName,
                <StatusBadge
                  key={p.id}
                  status={p.status}
                  tone={p.status === "Open" ? "ok" : p.status === "Frozen" ? "warn" : "info"}
                />,
                <button
                  key={`${p.id}-open`}
                  type="button"
                  className="quiet-link"
                  onClick={() => {
                    setSelectedId(p.id);
                    setTab("detail");
                  }}
                >
                  View
                </button>,
              ])}
            />
          )}
        </Card>
      )}

      {tab === "detail" && selected && (
        <div className="mgr-home-grid">
          <Card title={`${selected.title} · ${selected.code}`}>
            <dl className="info-grid">
              <div className="info-fact">
                <dt>Job family</dt>
                <dd>{selected.jobFamily}</dd>
              </div>
              <div className="info-fact">
                <dt>Job profile</dt>
                <dd>{selected.jobProfileId}</dd>
              </div>
              <div className="info-fact">
                <dt>Grade</dt>
                <dd>{selected.grade}</dd>
              </div>
              <div className="info-fact">
                <dt>Country</dt>
                <dd>{selected.country}</dd>
              </div>
              <div className="info-fact">
                <dt>Location</dt>
                <dd>{selected.location}</dd>
              </div>
              <div className="info-fact">
                <dt>Department</dt>
                <dd>{selected.department}</dd>
              </div>
              <div className="info-fact">
                <dt>Legal entity</dt>
                <dd>{selected.legalEntity}</dd>
              </div>
              <div className="info-fact">
                <dt>Reporting manager</dt>
                <dd>{selected.managerName}</dd>
              </div>
              <div className="info-fact">
                <dt>Status</dt>
                <dd>
                  <StatusBadge status={selected.status} />
                </dd>
              </div>
              <div className="info-fact">
                <dt>Openings</dt>
                <dd>{selected.openings}</dd>
              </div>
              {selected.incumbentName && (
                <div className="info-fact">
                  <dt>Incumbent</dt>
                  <dd>
                    <Link to={`/directory/${selected.incumbentId}`}>{selected.incumbentName}</Link>
                  </dd>
                </div>
              )}
            </dl>
          </Card>
          <Card title="Job requirements">
            <ul className="todo">
              {selected.requirements.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <Link to="/recruiting" className="btn" style={{ marginTop: 8, display: "inline-flex" }}>
              Open recruiting
            </Link>
          </Card>
          <Card title="Other positions">
            <ul className="todo">
              {POSITIONS.filter((p) => p.id !== selected.id).map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className="quiet-link"
                    onClick={() => {
                      setSelectedId(p.id);
                      setTab("detail");
                    }}
                  >
                    {p.code} · {p.title}
                  </button>{" "}
                  <StatusBadge status={p.status} />
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </Page>
  );
}
