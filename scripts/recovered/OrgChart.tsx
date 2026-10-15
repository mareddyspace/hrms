import { useMemo, useState } from "react";
import { buildDemoOrgTree, type DemoOrgNode } from "../demoAccounts.ts";
import { usePortal } from "../store.tsx";

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

function PersonCard({
  node,
  highlight,
  compact,
}: {
  node: DemoOrgNode;
  highlight?: boolean;
  compact?: boolean;
}) {
  return (
    <article className={`orgchart-card${highlight ? " is-you" : ""}${compact ? " is-compact" : ""}`}>
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
    </article>
  );
}

function OrgBranch({
  node,
  selfId,
  depth = 0,
}: {
  node: DemoOrgNode;
  selfId: string;
  depth?: number;
}) {
  const [open, setOpen] = useState(true);
  const kids = node.children;
  const hasKids = kids.length > 0;
  const isYou = node.id === selfId;

  return (
    <div className={`orgchart-branch depth-${Math.min(depth, 3)}`}>
      <div className="orgchart-node">
        <PersonCard node={node} highlight={isYou} />
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
                <OrgBranch node={child} selfId={selfId} depth={depth + 1} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Top-down org chart for the 8 demo personas — available to every role. */
export function OrgChart({ showLegend = true }: { showLegend?: boolean }) {
  const { employee } = usePortal();
  const roots = useMemo(() => buildDemoOrgTree(), []);

  return (
    <div className="orgchart">
      {showLegend && (
        <p className="orgchart-legend note">
          Top = leader · cards below = people who report to them · your card is marked <strong>You</strong>
        </p>
      )}
      <div className="orgchart-canvas">
        {roots.map((root) => (
          <OrgBranch key={root.id} node={root} selfId={employee.id} />
        ))}
      </div>
    </div>
  );
}
