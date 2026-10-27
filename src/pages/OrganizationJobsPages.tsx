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
  buildOrgTree,
  buildPositions,
  type OrgNode,
  type PositionRecord,
} from "../data/peopleData.ts";
import { getLifecycleHistory, isScheduled, subscribeLifecycleHistory } from "../data/lifecycleHistory.ts";
import { listPeople, subscribePeople } from "../data/peopleLocal.ts";
import { hasModuleAccess } from "../data/peoplePermissions.ts";
import { RegionalFilter } from "../locale/RegionalFilter.tsx";
import { useLocale } from "../locale/LocaleContext.tsx";
import { usePortal } from "../store.tsx";

function usePeople() {
  return useSyncExternalStore(subscribePeople, listPeople, listPeople);
}

const TYPE_LABEL: Record<OrgNode["type"], string> = {
  company: "Company",
  country: "Country",
  legalEntity: "Legal entity",
  businessUnit: "Business unit",
  division: "Division",
  department: "Department",
  costCenter: "Cost center",
  location: "Location",
  jobFamily: "Job family",
  jobProfile: "Job profile",
  position: "Position",
  grade: "Grade",
  supervisoryOrg: "Supervisory org",
  employee: "Employee",
};

function countNodes(node: OrgNode, type: OrgNode["type"], names = new Set<string>()): Set<string> {
  if (node.type === type) names.add(node.name);
  node.children?.forEach((child) => countNodes(child, type, names));
  return names;
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
          {node.personId ? (
            <Link to={`/people/${node.personId}`}>
              <strong>{node.name}</strong>
            </Link>
          ) : (
            <strong>{node.name}</strong>
          )}
          <span className="muted">
            {" "}
            · {TYPE_LABEL[node.type]}
            {node.code ? ` · ${node.code}` : ""}
            {typeof node.headcount === "number" && node.type !== "employee" ? ` · ${node.headcount}` : ""}
            {node.managerName && node.type !== "supervisoryOrg" ? ` · Head: ${node.managerName}` : ""}
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
  const { t, matchesRegion } = useLocale();
  const people = usePeople();
  const history = useSyncExternalStore(subscribeLifecycleHistory, getLifecycleHistory, getLifecycleHistory);
  const scopedPeople = useMemo(
    () => people.filter((p) => matchesRegion(String(p.countryCode), p.countryName)),
    [people, matchesRegion],
  );
  const tree = useMemo(() => buildOrgTree(scopedPeople.length ? scopedPeople : people), [scopedPeople, people]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["company-timez"]));
  const [tab, setTab] = useState("structure");
  const countries = (tree.children ?? []).filter((c) => (c.headcount ?? 0) > 0);

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
        <EmptyState title="Not available" description="No access." />
      </Page>
    );
  }

  return (
    <Page title="Organization">
      <FilterBar>
        <RegionalFilter label={t("locale.region")} />
      </FilterBar>
      <MetricGrid>
        <MetricCard label="Headcount" value={tree.headcount ?? 0} />
        <MetricCard label="Countries" value={countries.length} />
        <MetricCard label="Divisions" value={countNodes(tree, "division").size} />
        <MetricCard label="Departments" value={countNodes(tree, "department").size} />
      </MetricGrid>

      <Tabs
        tabs={[
          { id: "structure", label: "Structure" },
          { id: "history", label: "Change history" },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "structure" && (
        <Card
          title="Hierarchy"
          action={
            <div className="row-gap">
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setExpanded(new Set(["company-timez", ...countries.map((c) => c.id)]))}
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
          <Link to="/directory" className="quiet-link">
            See everyone in People
          </Link>
        </Card>
      )}

      {tab === "history" && (
        <Card title="Change history">
          <DataTable
            headers={["Effective", "Status", "Person", "Change", "From", "To", "Recorded", "By"]}
            rows={history.map((e) => [
              e.effectiveDate,
              isScheduled(e) ? (
                <StatusBadge key={`s-${e.id}`} status="Scheduled" tone="info" literal />
              ) : (
                <StatusBadge key={`s-${e.id}`} status="In effect" tone="ok" literal />
              ),
              <Link key={e.id} to={`/people/${e.personId}`}>{e.personName}</Link>,
              e.type,
              e.before,
              e.after,
              e.recordedOn,
              e.by,
            ])}
            empty={<EmptyState title="No changes yet" />}
          />
        </Card>
      )}
    </Page>
  );
}

export function JobsPage() {
  const { demoProfile } = usePortal();
  const people = usePeople();
  const allPositions = useMemo(() => buildPositions(people), [people]);
  const [tab, setTab] = useState("families");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [family, setFamily] = useState("");
  const [selectedId, setSelectedId] = useState("pos-221");
  const { id } = useParams();

  const profiles = useMemo(() => {
    return JOB_PROFILES.filter((p) => {
      if (family && p.familyName !== family) return false;
      if (q && !`${p.title} ${p.id}`.toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    });
  }, [q, family]);

  const positions = useMemo(() => {
    return allPositions.filter((p) => {
      if (status && p.status !== status) return false;
      if (family && p.jobFamily !== family) return false;
      if (q && !`${p.title} ${p.code} ${p.location}`.toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    });
  }, [allPositions, q, status, family]);

  const selected: PositionRecord | undefined =
    allPositions.find((p) => p.id === (id || selectedId) || p.code === id) ??
    allPositions.find((p) => p.id === selectedId) ??
    positions[0];

  if (!hasModuleAccess(demoProfile, "jobs") && !hasModuleAccess(demoProfile, "*")) {
    return (
      <Page title="Jobs & positions">
        <EmptyState title="Not available" description="No access." />
      </Page>
    );
  }

  return (
    <Page title="Jobs & positions">
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
            headers={["Family", "Profiles", "People"]}
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
            <EmptyState title="No profiles" description="Try other filters." />
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
            <EmptyState title="No positions" description="Try other filters." />
          ) : (
            <DataTable
              headers={["Code", "Title", "Grade", "Country", "Location", "Manager", "Status", ""]}
              rows={positions.slice(0, 200).map((p) => [
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
          {positions.length > 200 && <p className="muted">Showing 200 of {positions.length}.</p>}
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
                    <Link to={`/people/${selected.incumbentId}`}>{selected.incumbentName}</Link>
                  </dd>
                </div>
              )}
            </dl>
          </Card>
          <Card title="Job requirements">
            {selected.requirements.length ? (
              <ul className="todo">
                {selected.requirements.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">See the job profile {selected.jobProfileId}.</p>
            )}
            <Link to="/recruiting" className="btn" style={{ marginTop: 8, display: "inline-flex" }}>
              Open recruiting
            </Link>
          </Card>
          <Card title="Open positions">
            <ul className="todo">
              {allPositions.filter((p) => p.id !== selected.id && p.status !== "Filled").map((p) => (
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
