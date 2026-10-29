import { useMemo, useState, useSyncExternalStore } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ActionButton,
  Banner,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  FilterBar,
  MetricCard,
  MetricGrid,
  Page,
  StatusBadge,
  SubmitButton,
  Tabs,
  useAction,
} from "../components/ui.tsx";
import {
  buildOrgTree,
  buildPositions,
  familyForDepartment,
  type JobProfile,
  type OrgNode,
  type PositionRecord,
} from "../data/peopleData.ts";
import { getLifecycleHistory, isScheduled, subscribeLifecycleHistory } from "../data/lifecycleHistory.ts";
import {
  GRADE_OPTIONS,
  ORG_UNIT_TYPES,
  addOrgUnit,
  applyOrgOverlay,
  applyPositionOverlay,
  canEditOrganisation,
  getOrgOverlay,
  listJobFamilies,
  listJobProfiles,
  listOrgUnits,
  locationOptions,
  parentTypeOf,
  positionDefFor,
  saveJobProfileAsync,
  savePosition,
  setJobProfileActive,
  setPositionActive,
  subscribeOrgOverlay,
  unitOptions,
  unitTypeLabel,
  updateOrgUnit,
  type OrgUnit,
  type OrgUnitType,
} from "../data/orgStructureLocal.ts";
import { API_ENABLED } from "../api/syncOps.ts";
import { listPeople, subscribePeople } from "../data/peopleLocal.ts";
import { hasModuleAccess } from "../data/peoplePermissions.ts";
import { RegionalFilter } from "../locale/RegionalFilter.tsx";
import { useLocale } from "../locale/LocaleContext.tsx";
import { TIMEZ_COUNTRIES } from "../model.ts";
import { usePortal } from "../store.tsx";
import { JobDescriptionWriter } from "../features/ai/JobDescriptionWriter.tsx";
import { useAiOn } from "../features/ai/flags.ts";
import "../features/lifecycle/lifecycle.css";
import { AsOfOrgTree, JobProfileDetails, OrgHistoryList, UnitDatedChange } from "../features/org/OrgHistoryPanels.tsx";

type Message = { tone: "ok" | "err" | "warn" | "info"; text: string } | null;

function usePeople() {
  return useSyncExternalStore(subscribePeople, listPeople, listPeople);
}

function useOrgOverlay() {
  return useSyncExternalStore(subscribeOrgOverlay, getOrgOverlay, getOrgOverlay);
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
  if (node.type === type && !node.inactive) names.add(node.name);
  node.children?.forEach((child) => countNodes(child, type, names));
  return names;
}

function countryName(code: string): string {
  return TIMEZ_COUNTRIES.find((c) => c.code === code)?.name ?? code;
}

function OrgTreeNode({
  node,
  expanded,
  toggle,
  onEdit,
  depth = 0,
}: {
  node: OrgNode;
  expanded: Set<string>;
  toggle: (id: string) => void;
  onEdit?: (unitKey: string) => void;
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
            <strong className={node.inactive ? "muted" : undefined}>{node.name}</strong>
          )}
          <span className="muted">
            {" "}
            · {TYPE_LABEL[node.type]}
            {node.code ? ` · ${node.code}` : ""}
            {typeof node.headcount === "number" && node.type !== "employee" ? ` · ${node.headcount}` : ""}
            {node.managerName && node.type !== "supervisoryOrg" ? ` · Head: ${node.managerName}` : ""}
          </span>
          {node.inactive && (
            <>
              {" "}
              <StatusBadge status="Inactive" tone="neutral" literal />
            </>
          )}
          {onEdit && node.unitKey && (
            <>
              {" "}
              <button type="button" className="btn-ghost btn-tiny" onClick={() => onEdit(node.unitKey!)}>
                Edit
              </button>
            </>
          )}
        </div>
      </div>
      {hasChildren && isOpen && (
        <ul className="org-tree-list">
          {node.children!.map((child) => (
            <OrgTreeNode key={child.id} node={child} expanded={expanded} toggle={toggle} onEdit={onEdit} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

/* ───────────── Org unit dialog ───────────── */

function UnitForm({
  units,
  unit,
  onDone,
}: {
  units: OrgUnit[];
  unit: OrgUnit | null;
  onDone: (m: Message) => void;
}) {
  const { demoProfile } = usePortal();
  const people = usePeople();
  const [type, setType] = useState<OrgUnitType>(unit?.type ?? "department");
  const [countryCode, setCountryCode] = useState(unit?.countryCode ?? "IN");
  const [parentKey, setParentKey] = useState(unit?.parentKey ?? "");
  const [name, setName] = useState(unit?.name ?? "");
  const [code, setCode] = useState(unit?.code ?? "");
  const [error, setError] = useState<string | null>(null);
  // Backend mode: the API's tree is company-wide (departments have no country), so any active unit can be the parent.
  const parentType = API_ENABLED ? "any" : parentTypeOf(type);
  const parents = API_ENABLED
    ? units.filter((u) => u.active && u.type !== "location" && (!u.countryCode || !countryCode || u.countryCode === countryCode))
    : units.filter((u) => u.type === parentType && u.countryCode === countryCode && u.active);
  const act = useAction();
  const okText = unit ? `${name.trim()} saved.` : `${unitTypeLabel(type)} ${name.trim()} added.`;

  async function submit() {
    const result = await (unit
      ? updateOrgUnit(demoProfile, people, unit.key, { name, code })
      : addOrgUnit(demoProfile, people, { type, countryCode, name, code, parentKey }));
    if (result) {
      setError(result);
      return false;
    }
    onDone({ tone: "ok", text: okText });
    return true;
  }

  async function toggleActive() {
    if (!unit) return false;
    const result = await updateOrgUnit(demoProfile, people, unit.key, { active: !unit.active });
    if (result) {
      setError(result);
      return false;
    }
    onDone({ tone: "ok", text: `${unit.name} ${unit.active ? "deactivated" : "reactivated"}.` });
    return true;
  }

  return (
    <form className="stack" onSubmit={act.submit(submit, { success: okText })}>
      <Banner message={error ? { tone: "err", text: error } : null} />
      {unit && unit.headcount > 0 && unit.active && (
        <p className="muted">
          {unit.headcount} {unit.headcount === 1 ? "person is" : "people are"} here. Deactivating stops new moves in; current people stay.
        </p>
      )}
      <div className="lc-grid">
        <Field label="Type">
          <select value={type} disabled={Boolean(unit)} onChange={(e) => { setType(e.target.value as OrgUnitType); setParentKey(""); }}>
            {ORG_UNIT_TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Country">
          <select value={countryCode} disabled={Boolean(unit)} onChange={(e) => { setCountryCode(e.target.value); setParentKey(""); }}>
            {API_ENABLED && <option value="">All countries</option>}
            {TIMEZ_COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        {!unit && parentType === "any" && (
          <Field label="Parent unit" wide>
            <select value={parentKey} onChange={(e) => setParentKey(e.target.value)}>
              <option value="">The company</option>
              {parents.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name} · {unitTypeLabel(p.type)}
                  {p.countryCode ? ` · ${p.countryCode}` : ""}
                </option>
              ))}
            </select>
          </Field>
        )}
        {!unit && parentType !== "country" && parentType !== "any" && (
          <Field label={`Parent ${unitTypeLabel(parentType).toLowerCase()}`} wide>
            <select value={parentKey} onChange={(e) => setParentKey(e.target.value)} required>
              <option value="">Choose…</option>
              {parents.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Name">
          <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="Code">
          <input value={code} maxLength={30} onChange={(e) => setCode(e.target.value)} placeholder="Optional" />
        </Field>
      </div>
      <div className="row-gap">
        <SubmitButton action={act} className="btn">
          {unit ? "Save" : "Add unit"}
        </SubmitButton>
        {unit && (
          <ActionButton
            className="btn-ghost"
            busyLabel="Updating…"
            doneLabel="Done"
            success={`${unit.name} ${unit.active ? "deactivated" : "reactivated"}.`}
            onAction={toggleActive}
          >
            {unit.active ? "Deactivate" : "Reactivate"}
          </ActionButton>
        )}
      </div>
    </form>
  );
}

export function OrganizationPage() {
  const { demoProfile } = usePortal();
  const { t, matchesRegion } = useLocale();
  const people = usePeople();
  const overlay = useOrgOverlay();
  const history = useSyncExternalStore(subscribeLifecycleHistory, getLifecycleHistory, getLifecycleHistory);
  const scopedPeople = useMemo(
    () => people.filter((p) => matchesRegion(String(p.countryCode), p.countryName)),
    [people, matchesRegion],
  );
  const treePeople = scopedPeople.length ? scopedPeople : people;
  const tree = useMemo(() => applyOrgOverlay(buildOrgTree(treePeople), people, overlay), [treePeople, people, overlay]);
  const units = useMemo(() => listOrgUnits(people, overlay), [people, overlay]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["company-timez"]));
  const [tab, setTab] = useState("structure");
  const [message, setMessage] = useState<Message>(null);
  const [dialog, setDialog] = useState<{ key: string | null } | null>(null);
  const [unitType, setUnitType] = useState("");
  const [unitQ, setUnitQ] = useState("");
  // Effective-dated history of one unit (API mode).
  const [historyUnit, setHistoryUnit] = useState<OrgUnit | null>(null);
  const countries = (tree.children ?? []).filter((c) => (c.headcount ?? 0) > 0 || c.children?.some((x) => x.id.startsWith("added-")));
  const canEdit = canEditOrganisation(demoProfile.role);
  const editing = dialog?.key ? units.find((u) => u.key === dialog.key) ?? null : null;
  const unitName = (key: string) => units.find((u) => u.key === key)?.name ?? "";

  const shownUnits = useMemo(() => {
    const q = unitQ.trim().toLowerCase();
    return units.filter(
      (u) =>
        (!unitType || u.type === unitType) &&
        matchesRegion(u.countryCode, countryName(u.countryCode)) &&
        (!q || `${u.name} ${u.code}`.toLowerCase().includes(q)),
    );
  }, [units, unitType, unitQ, matchesRegion]);

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
    <Page
      title="Organization"
      action={
        canEdit ? (
          <button type="button" className="btn" onClick={() => setDialog({ key: null })}>
            Add unit
          </button>
        ) : undefined
      }
    >
      <Banner message={message} />
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
          { id: "units", label: "Units" },
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
            <OrgTreeNode node={tree} expanded={expanded} toggle={toggle} onEdit={canEdit ? (key) => setDialog({ key }) : undefined} />
          </ul>
          <Link to="/directory" className="quiet-link">
            See everyone in People
          </Link>
        </Card>
      )}

      {tab === "structure" && API_ENABLED && (
        <Card title="Structure on a date">
          <AsOfOrgTree />
        </Card>
      )}

      {tab === "units" && (
        <Card title="Org units">
          <FilterBar>
            <label className="filter-label">
              Search
              <input value={unitQ} onChange={(e) => setUnitQ(e.target.value)} placeholder="Name or code" />
            </label>
            <label className="filter-label">
              Type
              <select value={unitType} onChange={(e) => setUnitType(e.target.value)}>
                <option value="">All</option>
                {ORG_UNIT_TYPES.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.label}
                  </option>
                ))}
              </select>
            </label>
          </FilterBar>
          <DataTable
            headers={["Name", "Type", "Country", "Parent", "Code", "People", "Status", ""]}
            rows={shownUnits.slice(0, 300).map((u) => [
              u.name,
              unitTypeLabel(u.type),
              countryName(u.countryCode),
              u.parentKey ? unitName(u.parentKey) : countryName(u.countryCode),
              u.code || "—",
              u.headcount,
              <StatusBadge key={`st-${u.key}`} status={u.active ? "Active" : "Inactive"} tone={u.active ? "ok" : "neutral"} literal />,
              <div key={`e-${u.key}`} className="row-gap">
                {canEdit && (
                  <button type="button" className="btn-ghost btn-tiny" onClick={() => setDialog({ key: u.key })}>
                    Edit
                  </button>
                )}
                {API_ENABLED && (
                  <button type="button" className="btn-ghost btn-tiny" onClick={() => setHistoryUnit(u)}>
                    History
                  </button>
                )}
              </div>,
            ])}
            empty={<EmptyState title="No units" description="Try other filters." />}
          />
          {shownUnits.length > 300 && <p className="muted">Showing 300 of {shownUnits.length}.</p>}
        </Card>
      )}

      {tab === "history" && (
        <>
          <Card title="Structure and job changes">
            <DataTable
              headers={["Date", "Record", "Name", "Change", "From", "To", "By"]}
              rows={overlay.changes.map((c) => [c.date, c.entity, c.name, c.action, c.before, c.after, c.by])}
              empty={<EmptyState title="No structure changes yet" />}
            />
          </Card>
          <Card title="People changes">
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
        </>
      )}

      <Dialog
        open={Boolean(dialog) && canEdit}
        title={editing ? `Edit ${unitTypeLabel(editing.type).toLowerCase()}` : "Add org unit"}
        onClose={() => setDialog(null)}
      >
        {dialog && (
          <UnitForm
            key={dialog.key ?? "new"}
            units={units}
            unit={editing}
            onDone={(m) => {
              setMessage(m);
              setDialog(null);
            }}
          />
        )}
      </Dialog>
      <Dialog open={Boolean(historyUnit)} title={historyUnit ? `${historyUnit.name} · history` : "History"} onClose={() => setHistoryUnit(null)} wide>
        {historyUnit && <UnitDatedChange key={historyUnit.key} unitId={historyUnit.key} canEdit={canEdit} />}
      </Dialog>
    </Page>
  );
}

/* ───────────── Job profile and position dialogs ───────────── */

function ProfileForm({
  profile,
  families,
  profiles,
  onDone,
}: {
  profile: JobProfile | null;
  families: string[];
  profiles: JobProfile[];
  onDone: (m: Message) => void;
}) {
  const { demoProfile } = usePortal();
  const [writerOpen, setWriterOpen] = useState(false);
  const jdOn = useAiOn("jobDescription");
  const [title, setTitle] = useState(profile?.title ?? "");
  const [familyName, setFamilyName] = useState(profile?.familyName ?? families[0] ?? "");
  const [gradeBand, setGradeBand] = useState(profile?.gradeBand ?? "L4");
  const [description, setDescription] = useState(profile?.description ?? "");
  const [error, setError] = useState<string | null>(null);

  const act = useAction();

  async function submit() {
    const result = await saveJobProfileAsync(demoProfile, profile?.id ?? null, { title, familyName, gradeBand, description });
    if (result) {
      setError(result);
      return false;
    }
    onDone({ tone: "ok", text: `${title.trim()} saved.` });
    return true;
  }

  async function toggleActive() {
    if (!profile) return false;
    const result = await setJobProfileActive(demoProfile, profile.id, Boolean(profile.inactive));
    if (result) {
      setError(result);
      return false;
    }
    onDone({ tone: "ok", text: `${profile.title} ${profile.inactive ? "reactivated" : "deactivated"}.` });
    return true;
  }

  return (
    <form className="stack" onSubmit={act.submit(submit, { success: profile ? `Job profile ${title.trim()} saved.` : `Job profile ${title.trim()} added.` })}>
      <Banner message={error ? { tone: "err", text: error } : null} />
      <div className="lc-grid">
        <Field label="Title">
          <input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} required />
        </Field>
        <Field label="Job family">
          <select value={familyName} onChange={(e) => setFamilyName(e.target.value)}>
            {families.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </Field>
        <Field label="Grade band">
          <select value={gradeBand} onChange={(e) => setGradeBand(e.target.value)}>
            {[...new Set([gradeBand, ...GRADE_OPTIONS])].map((g) => (
              <option key={g}>{g}</option>
            ))}
          </select>
        </Field>
        <Field label="Description" wide>
          <textarea value={description} maxLength={4000} rows={description.length > 200 ? 10 : 3} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </div>
      {jdOn &&
        (writerOpen ? (
          <JobDescriptionWriter
            input={{ title, familyName, gradeBand }}
            profile={profile}
            profiles={profiles}
            actor={demoProfile}
            canSave={false}
            autoStart
            onUseText={(text) => {
              setDescription(text);
              setWriterOpen(false);
            }}
          />
        ) : (
          <div>
            <button type="button" className="btn-ghost btn-tiny" disabled={!title.trim()} onClick={() => setWriterOpen(true)}>
              Draft description
            </button>
          </div>
        ))}
      <div className="row-gap">
        <SubmitButton action={act} className="btn">
          {profile ? "Save" : "Add profile"}
        </SubmitButton>
        {profile && (
          <ActionButton
            className="btn-ghost"
            busyLabel="Updating…"
            doneLabel="Done"
            success={`${profile.title} ${profile.inactive ? "reactivated" : "deactivated"}.`}
            onAction={toggleActive}
          >
            {profile.inactive ? "Reactivate" : "Deactivate"}
          </ActionButton>
        )}
      </div>
    </form>
  );
}

function PositionForm({
  position,
  profiles,
  families,
  onDone,
}: {
  position: PositionRecord | null;
  profiles: JobProfile[];
  families: string[];
  onDone: (m: Message) => void;
}) {
  const { demoProfile } = usePortal();
  const people = usePeople();
  const def = position ? positionDefFor(position) : null;
  const [title, setTitle] = useState(def?.title ?? "");
  const [department, setDepartment] = useState(def?.department ?? "Engineering");
  const [jobFamily, setJobFamily] = useState(def?.jobFamily ?? familyForDepartment("Engineering"));
  const [jobProfileId, setJobProfileId] = useState(def?.jobProfileId ?? "");
  const [grade, setGrade] = useState(def?.grade ?? "L4");
  const [location, setLocation] = useState(def ? `${def.countryCode}|${def.location}` : "");
  const [headcount, setHeadcount] = useState(String(def?.headcount ?? 1));
  const [status, setStatus] = useState<"Open" | "Frozen">(def?.status ?? "Open");
  const [requirements, setRequirements] = useState((def?.requirements ?? []).join("\n"));
  const [error, setError] = useState<string | null>(null);
  const departments = useMemo(() => unitOptions(people, "department"), [people]);
  const locations = useMemo(() => locationOptions(people), [people]);
  const familyProfiles = profiles.filter((p) => p.familyName === jobFamily && (!p.inactive || p.id === jobProfileId));

  const act = useAction();

  async function submit() {
    const [countryCode, ...rest] = location.split("|");
    const result = await savePosition(demoProfile, position, {
      title,
      department,
      jobFamily,
      jobProfileId,
      grade,
      countryCode,
      location: rest.join("|"),
      headcount: Number(headcount),
      status,
      requirements: requirements.split("\n"),
    });
    if (result) {
      setError(result);
      return false;
    }
    onDone({ tone: "ok", text: `${title.trim()} saved.` });
    return true;
  }

  async function toggleActive() {
    if (!position) return false;
    const result = await setPositionActive(demoProfile, position, Boolean(position.inactive));
    if (result) {
      setError(result);
      return false;
    }
    onDone({ tone: "ok", text: `${position.title} ${position.inactive ? "reactivated" : "deactivated"}.` });
    return true;
  }

  return (
    <form className="stack" onSubmit={act.submit(submit, { success: position ? `Position ${title.trim()} saved.` : `Position ${title.trim()} added.` })}>
      <Banner message={error ? { tone: "err", text: error } : null} />
      <div className="lc-grid">
        <Field label="Title" wide>
          <input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} required />
        </Field>
        <Field label="Department">
          <select
            value={department}
            onChange={(e) => {
              setDepartment(e.target.value);
              setJobFamily(familyForDepartment(e.target.value));
              setJobProfileId("");
            }}
          >
            {!departments.some((d) => d.value === department) && <option value={department}>{department}</option>}
            {departments.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Location">
          <select value={location} onChange={(e) => setLocation(e.target.value)} required>
            <option value="">Choose…</option>
            {location && !locations.some((l) => `${l.countryCode}|${l.location}` === location) && (
              <option value={location}>{location.split("|").slice(1).join("|")}</option>
            )}
            {locations.map((l) => (
              <option key={`${l.countryCode}|${l.location}`} value={`${l.countryCode}|${l.location}`}>
                {l.label} · {l.countryName}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Job family">
          <select value={jobFamily} onChange={(e) => { setJobFamily(e.target.value); setJobProfileId(""); }}>
            {families.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </Field>
        <Field label="Job profile">
          <select value={jobProfileId} onChange={(e) => setJobProfileId(e.target.value)}>
            <option value="">None</option>
            {familyProfiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title} · {p.gradeBand}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Grade">
          <select value={grade} onChange={(e) => setGrade(e.target.value)}>
            {[...new Set([grade, ...GRADE_OPTIONS])].map((g) => (
              <option key={g}>{g}</option>
            ))}
          </select>
        </Field>
        <Field label="Headcount">
          <input type="number" min={1} max={500} value={headcount} onChange={(e) => setHeadcount(e.target.value)} required />
        </Field>
        <Field label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value as "Open" | "Frozen")}>
            <option>Open</option>
            <option>Frozen</option>
          </select>
        </Field>
        <Field label="Requirements (one per line)" wide>
          <textarea value={requirements} onChange={(e) => setRequirements(e.target.value)} />
        </Field>
      </div>
      <div className="row-gap">
        <SubmitButton action={act} className="btn">
          {position ? "Save" : "Add position"}
        </SubmitButton>
        {position && (
          <ActionButton
            className="btn-ghost"
            busyLabel="Updating…"
            doneLabel="Done"
            success={`${position.title} ${position.inactive ? "reactivated" : "deactivated"}.`}
            onAction={toggleActive}
          >
            {position.inactive ? "Reactivate" : "Deactivate"}
          </ActionButton>
        )}
      </div>
    </form>
  );
}

function positionTone(p: PositionRecord): "ok" | "warn" | "info" | "neutral" {
  if (p.inactive) return "neutral";
  return p.status === "Open" ? "ok" : p.status === "Frozen" ? "warn" : "info";
}

export function JobsPage() {
  const { demoProfile } = usePortal();
  const people = usePeople();
  const overlay = useOrgOverlay();
  const allPositions = useMemo(() => applyPositionOverlay(buildPositions(people), people, overlay), [people, overlay]);
  const allProfiles = useMemo(() => listJobProfiles(overlay), [overlay]);
  const families = useMemo(() => listJobFamilies(allProfiles), [allProfiles]);
  const familyNames = families.map((f) => f.name);
  const [tab, setTab] = useState("families");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [family, setFamily] = useState("");
  const [selectedId, setSelectedId] = useState("pos-221");
  const [message, setMessage] = useState<Message>(null);
  const [profileDialog, setProfileDialog] = useState<{ id: string | null } | null>(null);
  const [positionDialog, setPositionDialog] = useState<{ id: string | null } | null>(null);
  // Job level, experience, education, responsibilities and history of one profile (API mode).
  const [detailsProfileId, setDetailsProfileId] = useState<string | null>(null);
  const { id } = useParams();
  const canEdit = canEditOrganisation(demoProfile.role);
  const jdOn = useAiOn("jobDescription");

  const profiles = useMemo(() => {
    return allProfiles.filter((p) => {
      if (family && p.familyName !== family) return false;
      if (q && !`${p.title} ${p.id}`.toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    });
  }, [allProfiles, q, family]);

  const positions = useMemo(() => {
    return allPositions.filter((p) => {
      if (status === "Inactive") {
        if (!p.inactive) return false;
      } else {
        if (p.inactive) return false;
        if (status && p.status !== status) return false;
      }
      if (family && p.jobFamily !== family) return false;
      if (q && !`${p.title} ${p.code} ${p.location}`.toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    });
  }, [allPositions, q, status, family]);

  const activePositions = allPositions.filter((p) => !p.inactive);
  const seats = activePositions.reduce((sum, p) => sum + (p.headcount ?? 0), 0);
  const filled = activePositions.reduce((sum, p) => sum + (p.filled ?? 0), 0);

  const selected: PositionRecord | undefined =
    allPositions.find((p) => p.id === (id || selectedId) || p.code === id) ??
    allPositions.find((p) => p.id === selectedId) ??
    positions[0];
  const editingProfile = profileDialog?.id ? allProfiles.find((p) => p.id === profileDialog.id) ?? null : null;
  const editingPosition = positionDialog?.id ? allPositions.find((p) => p.id === positionDialog.id) ?? null : null;

  if (!hasModuleAccess(demoProfile, "jobs") && !hasModuleAccess(demoProfile, "*")) {
    return (
      <Page title="Jobs & positions">
        <EmptyState title="Not available" description="No access." />
      </Page>
    );
  }

  const done = (m: Message) => {
    setMessage(m);
    setProfileDialog(null);
    setPositionDialog(null);
  };

  return (
    <Page
      title="Jobs & positions"
      action={
        canEdit ? (
          <div className="row-gap">
            <button type="button" className="btn-ghost" onClick={() => setProfileDialog({ id: null })}>
              Add job profile
            </button>
            <button type="button" className="btn" onClick={() => setPositionDialog({ id: null })}>
              Add position
            </button>
          </div>
        ) : undefined
      }
    >
      <Banner message={message} />
      <MetricGrid>
        <MetricCard label="Positions" value={activePositions.length} />
        <MetricCard label="Headcount" value={seats} />
        <MetricCard label="Filled" value={filled} />
        <MetricCard label="Vacant" value={seats - filled} />
      </MetricGrid>
      <FilterBar>
        <label className="filter-label">
          Search
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title, code, location…" />
        </label>
        <label className="filter-label">
          Job family
          <select value={family} onChange={(e) => setFamily(e.target.value)}>
            <option value="">All</option>
            {families.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-label">
          Position status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All active</option>
            <option value="Open">Open</option>
            <option value="Filled">Filled</option>
            <option value="Frozen">Frozen</option>
            <option value="Inactive">Inactive</option>
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
            rows={families.map((f) => [
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
              headers={["ID", "Title", "Family", "Grade band", "Description", "Status", ""]}
              rows={profiles.map((p) => [
                p.id,
                p.title,
                p.familyName,
                p.gradeBand,
                p.description.length > 120 ? `${p.description.slice(0, 120).replace(/\s+/g, " ")}…` : p.description,
                <StatusBadge key={`ps-${p.id}`} status={p.inactive ? "Inactive" : "Active"} tone={p.inactive ? "neutral" : "ok"} literal />,
                <div key={`pe-${p.id}`} className="row-gap">
                  {canEdit && (
                    <button type="button" className="btn-ghost btn-tiny" onClick={() => setProfileDialog({ id: p.id })}>
                      Edit
                    </button>
                  )}
                  {API_ENABLED && overlay.api?.profiles.some((x) => x.id === p.id) && (
                    <button type="button" className="btn-ghost btn-tiny" onClick={() => setDetailsProfileId(p.id)}>
                      Details
                    </button>
                  )}
                </div>,
              ])}
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
              headers={["Code", "Title", "Grade", "Country", "Location", "Manager", "Headcount", "Vacant", "Status", ""]}
              rows={positions.slice(0, 200).map((p) => [
                p.code,
                p.title,
                p.grade,
                p.country,
                p.location,
                p.managerName,
                p.headcount ?? 0,
                (p.headcount ?? 0) - (p.filled ?? 0),
                <StatusBadge key={p.id} status={p.inactive ? "Inactive" : p.status} tone={positionTone(p)} literal={p.inactive} />,
                <div key={`${p.id}-open`} className="row-gap">
                  <button
                    type="button"
                    className="quiet-link"
                    onClick={() => {
                      setSelectedId(p.id);
                      setTab("detail");
                    }}
                  >
                    View
                  </button>
                  {canEdit && !p.incumbentId && (
                    <button type="button" className="quiet-link" onClick={() => setPositionDialog({ id: p.id })}>
                      Edit
                    </button>
                  )}
                </div>,
              ])}
            />
          )}
          {positions.length > 200 && <p className="muted">Showing 200 of {positions.length}.</p>}
        </Card>
      )}

      {tab === "detail" && selected && (
        <div className="mgr-home-grid">
          <Card
            title={`${selected.title} · ${selected.code}`}
            action={
              canEdit && !selected.incumbentId ? (
                <button type="button" className="btn-ghost btn-tiny" onClick={() => setPositionDialog({ id: selected.id })}>
                  Edit
                </button>
              ) : undefined
            }
          >
            <dl className="info-grid">
              <div className="info-fact">
                <dt>Job family</dt>
                <dd>{selected.jobFamily}</dd>
              </div>
              <div className="info-fact">
                <dt>Job profile</dt>
                <dd>{selected.jobProfileId || "—"}</dd>
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
                <dd>{selected.managerName || "—"}</dd>
              </div>
              <div className="info-fact">
                <dt>Status</dt>
                <dd>
                  <StatusBadge status={selected.inactive ? "Inactive" : selected.status} tone={positionTone(selected)} literal={selected.inactive} />
                </dd>
              </div>
              <div className="info-fact">
                <dt>Headcount</dt>
                <dd>
                  {selected.headcount ?? 0} · {selected.filled ?? 0} filled · {(selected.headcount ?? 0) - (selected.filled ?? 0)} vacant
                </dd>
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
          {API_ENABLED && overlay.api?.positions.some((p) => p.id === selected.id) && (
            <Card title="Position history">
              <OrgHistoryList key={selected.id} entity="positions" id={selected.id} />
            </Card>
          )}
          <Card title="Open positions">
            <ul className="todo">
              {activePositions.filter((p) => p.id !== selected.id && p.status !== "Filled").map((p) => (
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
          {jdOn && (
            <Card title="Job description">
              <JobDescriptionWriter
                key={selected.id}
                input={{
                  title: selected.title,
                  familyName: selected.jobFamily,
                  gradeBand: selected.grade,
                  department: selected.department,
                  location: selected.location,
                  requirements: selected.requirements,
                }}
                profile={allProfiles.find((p) => p.id === selected.jobProfileId) ?? null}
                profiles={allProfiles}
                actor={demoProfile}
                canSave={canEdit}
              />
            </Card>
          )}
        </div>
      )}

      <Dialog open={Boolean(profileDialog) && canEdit} title={editingProfile ? "Edit job profile" : "Add job profile"} onClose={() => setProfileDialog(null)}>
        {profileDialog && (
          <ProfileForm key={profileDialog.id ?? "new"} profile={editingProfile} families={familyNames} profiles={allProfiles} onDone={done} />
        )}
      </Dialog>
      <Dialog
        open={Boolean(detailsProfileId)}
        title={`${allProfiles.find((p) => p.id === detailsProfileId)?.title ?? "Job profile"} · details`}
        onClose={() => setDetailsProfileId(null)}
        wide
      >
        {detailsProfileId && <JobProfileDetails key={detailsProfileId} profileId={detailsProfileId} canEdit={canEdit} />}
      </Dialog>
      <Dialog open={Boolean(positionDialog) && canEdit} title={editingPosition ? "Edit position" : "Add position"} onClose={() => setPositionDialog(null)}>
        {positionDialog && (
          <PositionForm key={positionDialog.id ?? "new"} position={editingPosition} profiles={allProfiles} families={familyNames} onDone={done} />
        )}
      </Dialog>
    </Page>
  );
}
