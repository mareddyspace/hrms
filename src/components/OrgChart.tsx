import { useMemo, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import { MessageCircle, UserRound } from "lucide-react";
import { startDirectChat } from "../data/collabLocal.ts";
import type { PersonRecord } from "../data/peopleData.ts";
import { listPeople, managerChainIds, subscribePeople } from "../data/peopleLocal.ts";
import { usePortal } from "../store.tsx";

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

/** The CEO — the top of the reporting line. */
const ROOT_ID = "demo-ceo";

/** A person in the chart. Clicking it reveals Visit profile / Message inside the same card. */
function PersonCard({
  person,
  reportCount,
  highlight,
  selected,
  onSelect,
}: {
  person: PersonRecord;
  reportCount: number;
  highlight?: boolean;
  selected?: boolean;
  onSelect?: () => void;
}) {
  return (
    <article className={`orgchart-card${highlight ? " is-you" : ""}${selected ? " is-selected" : ""}`}>
      <button type="button" className="orgchart-card-toggle" aria-expanded={selected} onClick={onSelect}>
        <div className="orgchart-avatar" aria-hidden>
          {person.photo && person.photo !== "/profile.svg" ? <img src={person.photo} alt="" /> : <span>{initials(person.fullName)}</span>}
        </div>
        <div className="orgchart-text">
          <strong>{person.fullName}</strong>
          <span className="orgchart-role">{person.designation}</span>
          <span className="orgchart-role muted">
            {person.department} · {person.countryName}
            {reportCount ? ` · ${reportCount} report${reportCount === 1 ? "" : "s"}` : ""}
          </span>
          {highlight && <span className="orgchart-you">You</span>}
        </div>
      </button>
      {selected && <PersonActions person={person} isYou={Boolean(highlight)} />}
    </article>
  );
}

/** Visit profile / Message buttons shown inside a selected card, under the name. */
function PersonActions({ person, isYou }: { person: PersonRecord; isYou: boolean }) {
  const navigate = useNavigate();
  const { employee } = usePortal();

  function message() {
    const id = startDirectChat(person.id, person.fullName, employee.id, employee.fullName);
    navigate(`/chat?c=${encodeURIComponent(id)}`);
  }

  return (
    <div className="orgchart-actions">
      <button type="button" className="btn btn-tiny" onClick={() => navigate(isYou ? "/info" : `/people/${person.id}`)}>
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

type Tree = { byId: Map<string, PersonRecord>; children: Map<string, PersonRecord[]> };

function OrgBranch({
  person,
  tree,
  selfId,
  openPath,
  selectedId,
  onSelect,
  depth = 0,
}: {
  person: PersonRecord;
  tree: Tree;
  selfId: string;
  /** People on the path down to you start expanded. */
  openPath: Set<string>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  depth?: number;
}) {
  // Branches load only when opened: the root and the path to you start open, everything else is collapsed.
  const [open, setOpen] = useState(depth === 0 || openPath.has(person.id));
  const kids = tree.children.get(person.id) ?? [];
  const hasKids = kids.length > 0;

  return (
    <div className={`orgchart-branch depth-${Math.min(depth, 3)}`}>
      <div className="orgchart-node">
        <PersonCard
          person={person}
          reportCount={kids.length}
          highlight={person.id === selfId}
          selected={selectedId === person.id}
          onSelect={() => onSelect(selectedId === person.id ? null : person.id)}
        />
        {hasKids && (
          <button type="button" className="orgchart-expand" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? `Hide ${kids.length}` : `Show ${kids.length}`}
          </button>
        )}
      </div>

      {hasKids && open && (
        <>
          <div className="orgchart-stem" aria-hidden />
          <div className={`orgchart-row kids-${Math.min(kids.length, 4)}`} role="group" aria-label={`Reports to ${person.fullName}`}>
            {kids.map((child) => (
              <div key={child.id} className="orgchart-col">
                <div className="orgchart-elbow" aria-hidden />
                <OrgBranch
                  person={child}
                  tree={tree}
                  selfId={selfId}
                  openPath={openPath}
                  selectedId={selectedId}
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

/** Top-down org chart of everyone in the company, built from each person's manager, starting at the CEO. */
export function OrgChart() {
  const { employee } = usePortal();
  const people = useSyncExternalStore(subscribePeople, listPeople, listPeople);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const tree = useMemo<Tree>(() => {
    const active = people.filter((p) => p.employmentStatus !== "Terminated");
    const byId = new Map(active.map((p) => [p.id, p]));
    const children = new Map<string, PersonRecord[]>();
    for (const p of active) {
      if (!p.managerId || p.managerId === p.id || !byId.has(p.managerId)) continue;
      const list = children.get(p.managerId) ?? [];
      list.push(p);
      children.set(p.managerId, list);
    }
    // Managers first, then by name.
    // Most senior first (E → M3 … M1 → L6 … L1), then people who lead others, then by name.
    const GRADE_ORDER = ["E1", "M3", "M2", "M1", "L6", "L5", "L4", "L3", "L2", "L1"];
    const rank = (p: PersonRecord) => {
      const i = GRADE_ORDER.indexOf(String((p as { grade?: string }).grade ?? ""));
      return i === -1 ? GRADE_ORDER.length : i;
    };
    const isManager = (id: string) => (children.has(id) ? 1 : 0);
    for (const list of children.values()) {
      list.sort(
        (a, b) => rank(a) - rank(b) || isManager(b.id) - isManager(a.id) || a.fullName.localeCompare(b.fullName),
      );
    }
    return { byId, children };
  }, [people]);

  const openPath = useMemo(() => new Set(managerChainIds(employee.id)), [employee.id, people]); // eslint-disable-line react-hooks/exhaustive-deps
  const root = tree.byId.get(ROOT_ID);

  if (!root) return <p className="muted">The org chart is not available.</p>;

  return (
    <div className="orgchart">
      <div className="orgchart-canvas">
        <OrgBranch
          person={root}
          tree={tree}
          selfId={employee.id}
          openPath={openPath}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      </div>
    </div>
  );
}
