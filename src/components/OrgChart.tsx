import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import { MessageCircle, UserRound } from "lucide-react";
import { startDirectChat } from "../data/collabLocal.ts";
import { buildDemoOrgTree, DEMO_ACCOUNTS, type DemoOrgNode } from "../demoAccounts.ts";
import { usePortal } from "../store.tsx";
import { listPeople, subscribePeople } from "../data/peopleLocal.ts";
import { hasStarted, type PersonRecord } from "../data/peopleData.ts";
import { getTalentState, hiringManagerIdOf, subscribeTalent } from "../data/talentLocal.ts";
import { formatShortDate, todayISO } from "../model.ts";
import "./orgchartTools.css";

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

/** One box in the chart: a person, or an open role (dashed) from an approved / pending requisition. */
interface OrgNode {
  id: string;
  fullName: string;
  designation: string;
  tag: string;
  department: string;
  countryCode: string;
  photo?: string;
  joiningSoon?: string;
  vacancy?: { openings: number; status: string };
  children: OrgNode[];
  /** Everyone below (people only). */
  total: number;
  /** Direct reports (people only). */
  direct: number;
}

/** Show only the sign-in accounts (the full directory has 500 people, which is too much for this chart). */
const SIGN_IN_ACCOUNTS_ONLY = true;

/** Directory people (and pre-boarding joiners) into reporting trees; open requisitions become dashed boxes. */
function buildTree(people: readonly PersonRecord[], vacancies: { managerId: string; id: string; title: string; openings: number; department: string; country: string; status: string }[]): OrgNode[] {
  const today = todayISO();
  const live = people.filter((p) => p.employmentStatus !== "Terminated");
  if (SIGN_IN_ACCOUNTS_ONLY || !live.length) {
    // The chart shows the sign-in accounts and how they report to each other.
    const fromDemo = (n: DemoOrgNode): OrgNode => {
      const children = n.children.map(fromDemo);
      return { id: n.id, fullName: n.fullName, designation: n.designation, tag: n.personaLabel, department: n.department ?? "", countryCode: String(n.countryCode ?? ""), photo: n.photo, children, direct: children.length, total: children.reduce((s, c) => s + 1 + c.total, 0) };
    };
    return buildDemoOrgTree().map(fromDemo);
  }
  const byId = new Map<string, OrgNode>();
  for (const p of live) {
    const persona = DEMO_ACCOUNTS.find((a) => a.id === p.id);
    const joining = hasStarted(p, today) ? undefined : `Joining soon · starts ${formatShortDate(p.dateOfJoining)}`;
    byId.set(p.id, {
      id: p.id,
      fullName: p.fullName,
      designation: p.designation,
      tag: joining ?? p.department,
      department: p.department,
      countryCode: String(p.countryCode),
      photo: persona?.photo ?? (p.photo || undefined),
      joiningSoon: joining,
      children: [],
      total: 0,
      direct: 0,
    });
  }
  const roots: OrgNode[] = [];
  const managerOf = new Map(live.map((p) => [p.id, p.managerId]));
  for (const p of live) {
    const node = byId.get(p.id)!;
    const parent = p.managerId && p.managerId !== p.id ? byId.get(p.managerId) : undefined;
    // Guard against loops: walk up and make sure we don't reach ourselves.
    let cursor = parent ? managerOf.get(parent.id) : undefined;
    let loop = false;
    for (let i = 0; cursor && i < 50; i += 1) {
      if (cursor === p.id) {
        loop = true;
        break;
      }
      cursor = managerOf.get(cursor);
    }
    if (parent && !loop) parent.children.push(node);
    else roots.push(node);
  }
  for (const v of vacancies) {
    const manager = byId.get(v.managerId);
    if (!manager) continue;
    manager.children.push({
      id: `vac-${v.id}`,
      fullName: v.title,
      designation: `${v.openings} opening${v.openings === 1 ? "" : "s"}`,
      tag: v.status === "Approved" ? "Open role" : "Role waiting for approval",
      department: v.department,
      countryCode: v.country,
      vacancy: { openings: v.openings, status: v.status },
      children: [],
      total: 0,
      direct: 0,
    });
  }
  const finish = (n: OrgNode): number => {
    n.children.sort((a, b) => Number(Boolean(a.vacancy)) - Number(Boolean(b.vacancy)) || b.children.length - a.children.length || a.fullName.localeCompare(b.fullName));
    let total = 0;
    for (const c of n.children) total += c.vacancy ? 0 : 1 + finish(c);
    n.direct = n.children.filter((c) => !c.vacancy).length;
    n.total = total;
    return total;
  };
  roots.forEach(finish);
  return roots.sort((a, b) => b.total - a.total || a.fullName.localeCompare(b.fullName));
}

function walk(nodes: OrgNode[], fn: (n: OrgNode, parents: OrgNode[]) => void, parents: OrgNode[] = []) {
  for (const n of nodes) {
    fn(n, parents);
    walk(n.children, fn, [...parents, n]);
  }
}

/** Keep people matching the filters, plus the managers above them (shown faded) so the lines stay readable. */
function filterTree(nodes: OrgNode[], match: (n: OrgNode) => boolean): { nodes: OrgNode[]; matched: Set<string> } {
  const matched = new Set<string>();
  const keep = (n: OrgNode): OrgNode | null => {
    const kids = n.children.map(keep).filter((c): c is OrgNode => c !== null);
    const hit = match(n);
    if (hit) matched.add(n.id);
    return hit || kids.length ? { ...n, children: kids } : null;
  };
  return { nodes: nodes.map(keep).filter((n): n is OrgNode => n !== null), matched };
}

/** A person in the chart. Clicking it reveals Visit profile / Message inside the same card. */
function PersonCard({
  node,
  isYou,
  selected,
  found,
  faded,
  onSelect,
}: {
  node: OrgNode;
  isYou: boolean;
  selected: boolean;
  found: boolean;
  faded: boolean;
  onSelect: () => void;
}) {
  if (node.vacancy) {
    return (
      <article className="orgchart-card is-vacancy" data-org-id={node.id}>
        <div className="orgchart-text">
          <strong>{node.fullName}</strong>
          <span className="orgchart-role">{node.designation}</span>
          <span className="orgchart-tag">{node.tag}</span>
        </div>
      </article>
    );
  }
  return (
    <article
      data-org-id={node.id}
      className={`orgchart-card${isYou ? " is-you" : ""}${selected ? " is-selected" : ""}${found ? " is-found" : ""}${faded ? " is-faded" : ""}${node.joiningSoon ? " is-joining" : ""}`}
    >
      <button type="button" className="orgchart-card-toggle" aria-expanded={selected} onClick={onSelect}>
        <div className="orgchart-avatar" aria-hidden>
          {node.photo && node.photo !== "/profile.svg" ? <img src={node.photo} alt="" /> : <span>{initials(node.fullName)}</span>}
        </div>
        <div className="orgchart-text">
          <strong>{node.fullName}</strong>
          <span className="orgchart-role">{node.designation}</span>
          <span className="orgchart-tag">{node.tag}</span>
          {node.direct > 0 && (
            <span className="orgchart-count" title={`${node.direct} direct · ${node.total} in total`}>
              {node.direct} direct · {node.total} total
            </span>
          )}
          {isYou && <span className="orgchart-you">You</span>}
        </div>
      </button>
      {selected && <PersonActions node={node} isYou={isYou} />}
    </article>
  );
}

/** Visit profile / Message buttons shown inside a selected card, under the name. */
function PersonActions({ node, isYou }: { node: OrgNode; isYou: boolean }) {
  const navigate = useNavigate();
  const { employee } = usePortal();

  function message() {
    const id = startDirectChat(node.id, node.fullName, employee.id, employee.fullName);
    navigate(`/chat?c=${encodeURIComponent(id)}`);
  }

  return (
    <div className="orgchart-actions">
      <button type="button" className="btn btn-tiny" onClick={() => navigate(isYou ? "/info" : `/people/${node.id}`)}>
        <UserRound size={14} aria-hidden /> {isYou ? "View my profile" : "Visit profile"}
      </button>
      {!isYou && (
        <button type="button" className="btn-ghost btn-tiny" onClick={message}>
          <MessageCircle size={14} aria-hidden /> Message
        </button>
      )}
    </div>
  );
}

type BranchProps = {
  node: OrgNode;
  selfId: string;
  selectedId: string | null;
  foundId: string | null;
  matched: Set<string> | null;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onSelect: (id: string | null) => void;
  depth?: number;
};

function OrgBranch({ node, selfId, selectedId, foundId, matched, expanded, onToggle, onSelect, depth = 0 }: BranchProps) {
  const kids = node.children;
  const open = expanded.has(node.id);
  const wide = kids.length > 6;
  return (
    <div className={`orgchart-branch depth-${Math.min(depth, 3)}`}>
      <div className="orgchart-node">
        <PersonCard
          node={node}
          isYou={node.id === selfId}
          selected={selectedId === node.id}
          found={foundId === node.id}
          faded={Boolean(matched && !matched.has(node.id))}
          onSelect={() => onSelect(selectedId === node.id ? null : node.id)}
        />
        {kids.length > 0 && (
          <button type="button" className="orgchart-expand" aria-expanded={open} onClick={() => onToggle(node.id)}>
            {open ? `Hide ${kids.length}` : `Show ${kids.length}`}
          </button>
        )}
      </div>
      {kids.length > 0 && open && (
        <>
          <div className="orgchart-stem" aria-hidden />
          <div className={`orgchart-row kids-${Math.min(kids.length, 4)}${wide ? " is-wide" : ""}`} role="group" aria-label={`Reports to ${node.fullName}`}>
            {kids.map((child) => (
              <div key={child.id} className="orgchart-col">
                <div className="orgchart-elbow" aria-hidden />
                <OrgBranch
                  node={child}
                  selfId={selfId}
                  selectedId={selectedId}
                  foundId={foundId}
                  matched={matched}
                  expanded={expanded}
                  onToggle={onToggle}
                  onSelect={onSelect}
                  depth={depth + 1}
                />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Org chart from the directory: everyone's reporting line, with headcounts on each box, open roles from
 * requisitions as dashed boxes and joiners tagged "Joining soon". Search jumps to a person and opens their chain;
 * filters keep matching people (and the managers above them); expand / collapse all; print view.
 */
export function OrgChart({ tools = true }: { tools?: boolean }) {
  const { employee } = usePortal();
  const people = useSyncExternalStore(subscribePeople, listPeople, listPeople);
  const talent = useSyncExternalStore(subscribeTalent, getTalentState, getTalentState);
  const vacancies = useMemo(
    () =>
      talent.requisitions
        .filter((r) => (r.approvalStatus === "Approved" || r.approvalStatus === "Pending approval") && r.posting?.status !== "Closed" && r.openings > 0)
        .map((r) => ({ managerId: hiringManagerIdOf(r) ?? "", id: r.id, title: r.title, openings: r.openings, department: r.department, country: r.country, status: r.approvalStatus })),
    [talent.requisitions],
  );
  const roots = useMemo(() => buildTree(people, vacancies), [people, vacancies]);
  const index = useMemo(() => {
    const parents = new Map<string, string[]>();
    const all: OrgNode[] = [];
    walk(roots, (n, ps) => {
      parents.set(n.id, ps.map((p) => p.id));
      if (!n.vacancy) all.push(n);
    });
    return { parents, all };
  }, [roots]);
  const departments = useMemo(() => [...new Set(index.all.map((n) => n.department).filter(Boolean))].sort(), [index]);
  const countries = useMemo(() => [...new Set(index.all.map((n) => n.countryCode).filter(Boolean))].sort(), [index]);

  const defaultOpen = useMemo(() => {
    // Your own line opens; other teams start folded so the page stays short.
    const chain = index.parents.get(employee.id) ?? [];
    const open = new Set<string>(chain);
    if (roots.length === 1) open.add(roots[0].id);
    open.add(employee.id);
    return open;
  }, [roots, index, employee.id]);
  const [expanded, setExpanded] = useState<Set<string>>(defaultOpen);
  useEffect(() => setExpanded((prev) => new Set([...prev, ...defaultOpen])), [defaultOpen]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [foundId, setFoundId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [department, setDepartment] = useState("");
  const [country, setCountry] = useState("");
  const canvas = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    if (!department && !country) return { nodes: roots, matched: null as Set<string> | null };
    const r = filterTree(roots, (n) => !n.vacancy && (!department || n.department === department) && (!country || n.countryCode === country));
    return { nodes: r.nodes, matched: r.matched };
  }, [roots, department, country]);
  const shownExpanded = useMemo(() => {
    if (!filtered.matched) return expanded;
    // Filtering opens the lines down to every match.
    const open = new Set(expanded);
    for (const id of filtered.matched) for (const p of index.parents.get(id) ?? []) open.add(p);
    return open;
  }, [expanded, filtered.matched, index]);

  // People with no manager and no reports are listed apart, so the reporting trees stay readable.
  const myRoot = (index.parents.get(employee.id) ?? [])[0] ?? employee.id;
  const trees = filtered.nodes
    .filter((n) => n.children.length > 0 || n.id === employee.id)
    .sort((a, b) => Number(b.id === myRoot) - Number(a.id === myRoot));
  const [firstTree, ...otherTrees] = trees;
  const loose = filtered.nodes.filter((n) => n.children.length === 0 && n.id !== employee.id);
  const [looseOpen, setLooseOpen] = useState(false);
  const looseShown = looseOpen || Boolean(filtered.matched) || (foundId !== null && loose.some((n) => n.id === foundId)) || trees.length === 0;

  const q = query.trim().toLowerCase();
  const suggestions = q.length >= 2 ? index.all.filter((n) => n.fullName.toLowerCase().includes(q) || n.designation.toLowerCase().includes(q)).slice(0, 8) : [];

  function jumpTo(id: string) {
    setExpanded((prev) => new Set([...prev, ...(index.parents.get(id) ?? [])]));
    setFoundId(id);
    setSelectedId(id);
    setQuery("");
    if (department || country) {
      const n = index.all.find((x) => x.id === id);
      if (n && ((department && n.department !== department) || (country && n.countryCode !== country))) {
        setDepartment("");
        setCountry("");
      }
    }
  }
  useEffect(() => {
    if (!foundId) return;
    const el = canvas.current?.querySelector(`[data-org-id="${CSS.escape(foundId)}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  }, [foundId, shownExpanded]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const expandAll = () => setExpanded(new Set(index.all.filter((n) => n.children.length).map((n) => n.id)));
  const collapseAll = () => setExpanded(new Set());
  function printView() {
    expandAll();
    window.setTimeout(() => window.print(), 300);
  }

  return (
    <div className="orgchart">
      {tools && (
        <div className="orgchart-tools no-print">
          <div className="orgchart-search">
            <input
              type="search"
              value={query}
              placeholder="Find a person"
              aria-label="Find a person"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && suggestions[0]) jumpTo(suggestions[0].id);
              }}
            />
            {suggestions.length > 0 && (
              <ul className="orgchart-suggest" role="listbox">
                {suggestions.map((n) => (
                  <li key={n.id}>
                    <button type="button" onClick={() => jumpTo(n.id)}>
                      <strong>{n.fullName}</strong> <span className="muted">{n.designation}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {q.length >= 2 && suggestions.length === 0 && <p className="muted orgchart-none">No one found.</p>}
          </div>
          <select aria-label="Department" value={department} onChange={(e) => setDepartment(e.target.value)}>
            <option value="">All departments</option>
            {departments.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
          <select aria-label="Country" value={country} onChange={(e) => setCountry(e.target.value)}>
            <option value="">All countries</option>
            {countries.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <button type="button" className="btn-ghost" onClick={expandAll}>
            Expand all
          </button>
          <button type="button" className="btn-ghost" onClick={collapseAll}>
            Collapse all
          </button>
          <button type="button" className="btn-ghost" onClick={printView}>
            Print
          </button>
        </div>
      )}
      {filtered.matched && (
        <p className="muted no-print">
          {filtered.matched.size} match{filtered.matched.size === 1 ? "" : "es"} · managers above them shown faded
        </p>
      )}
      <div className="orgchart-canvas" ref={canvas}>
        {filtered.nodes.length === 0 && <p className="muted">No one matches these filters.</p>}
        {firstTree && (
          <OrgBranch
            key={firstTree.id}
            node={firstTree}
            selfId={employee.id}
            selectedId={selectedId}
            foundId={foundId}
            matched={filtered.matched}
            expanded={shownExpanded}
            onToggle={toggle}
            onSelect={setSelectedId}
          />
        )}
        {otherTrees.length > 0 && (
          <div className="orgchart-forest">
            {otherTrees.map((root) => (
              <OrgBranch
                key={root.id}
                node={root}
                selfId={employee.id}
                selectedId={selectedId}
                foundId={foundId}
                matched={filtered.matched}
                expanded={shownExpanded}
                onToggle={toggle}
                onSelect={setSelectedId}
              />
            ))}
          </div>
        )}
        {loose.length > 0 && (
          <section className="orgchart-loose">
            <button type="button" className="orgchart-expand" aria-expanded={looseShown} onClick={() => (looseShown ? (setLooseOpen(false), setFoundId(null)) : setLooseOpen(true))}>
              {looseShown ? `Hide no manager set (${loose.length})` : `No manager set (${loose.length})`}
            </button>
            {looseShown && (
              <div className="orgchart-loose-grid">
                {loose.map((n) => (
                  <PersonCard
                    key={n.id}
                    node={n}
                    isYou={n.id === employee.id}
                    selected={selectedId === n.id}
                    found={foundId === n.id}
                    faded={Boolean(filtered.matched && !filtered.matched.has(n.id))}
                    onSelect={() => setSelectedId(selectedId === n.id ? null : n.id)}
                  />
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
