import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MessageCircle, UserRound } from "lucide-react";
import { startDirectChat } from "../data/collabLocal.ts";
import { buildDemoOrgTree, type DemoOrgNode } from "../demoAccounts.ts";
import { usePortal } from "../store.tsx";

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

/** A person in the chart. Clicking it reveals Visit profile / Message inside the same card. */
function PersonCard({
  node,
  highlight,
  compact,
  selected,
  onSelect,
}: {
  node: DemoOrgNode;
  highlight?: boolean;
  compact?: boolean;
  selected?: boolean;
  onSelect?: () => void;
}) {
  return (
    <article
      className={`orgchart-card${highlight ? " is-you" : ""}${compact ? " is-compact" : ""}${selected ? " is-selected" : ""}`}
    >
      <button type="button" className="orgchart-card-toggle" aria-expanded={selected} onClick={onSelect}>
        <div className="orgchart-avatar" aria-hidden>
          {node.photo && node.photo !== "/profile.svg" ? (
            <img src={node.photo} alt="" />
          ) : (
            <span>{initials(node.fullName)}</span>
          )}
        </div>
        <div className="orgchart-text">
          <strong>{node.fullName}</strong>
          <span className="orgchart-role">{node.designation}</span>
          <span className="orgchart-tag">{node.personaLabel}</span>
          {highlight && <span className="orgchart-you">You</span>}
        </div>
      </button>
      {selected && <PersonActions node={node} isYou={Boolean(highlight)} />}
    </article>
  );
}

/** Visit profile / Message buttons shown inside a selected card, under the name. */
function PersonActions({ node, isYou }: { node: DemoOrgNode; isYou: boolean }) {
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

function OrgBranch({
  node,
  selfId,
  selectedId,
  onSelect,
  depth = 0,
}: {
  node: DemoOrgNode;
  selfId: string;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  depth?: number;
}) {
  const [open, setOpen] = useState(true);
  const kids = node.children;
  const hasKids = kids.length > 0;
  const isYou = node.id === selfId;

  return (
    <div className={`orgchart-branch depth-${Math.min(depth, 3)}`}>
      <div className="orgchart-node">
        <PersonCard
          node={node}
          highlight={isYou}
          selected={selectedId === node.id}
          onSelect={() => onSelect(selectedId === node.id ? null : node.id)}
        />
        {hasKids && (
          <button
            type="button"
            className="orgchart-expand"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? `Hide ${kids.length}` : `Show ${kids.length}`}
          </button>
        )}
      </div>

      {hasKids && open && (
        <>
          <div className="orgchart-stem" aria-hidden />
          <div className={`orgchart-row kids-${Math.min(kids.length, 4)}`} role="group" aria-label={`Reports to ${node.fullName}`}>
            {kids.map((child) => (
              <div key={child.id} className="orgchart-col">
                <div className="orgchart-elbow" aria-hidden />
                <OrgBranch
                  node={child}
                  selfId={selfId}
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

/** Top-down org chart for the 8 demo personas — shown in every role's sidebar. */
export function OrgChart() {
  const { employee } = usePortal();
  const roots = useMemo(() => buildDemoOrgTree(), []);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <div className="orgchart">
      <div className="orgchart-canvas">
        {roots.map((root) => (
          <OrgBranch
            key={root.id}
            node={root}
            selfId={employee.id}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        ))}
      </div>
    </div>
  );
}
