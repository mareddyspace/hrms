import { useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { fmtDay, getManagedPolicies, pendingForMe, publishedVersion, subscribeManagedPolicies } from "../data/policyAdmin.ts";
import "../pages/policies.css";
import { Card } from "./ui.tsx";

/** Home: policies and rule changes HR published that still need this person's acknowledgement. */
export function PolicyAckBanner({ employeeId }: { employeeId: string }) {
  const { policies } = useSyncExternalStore(subscribeManagedPolicies, getManagedPolicies, getManagedPolicies);
  const pending = pendingForMe(policies, employeeId);
  if (!pending.length) return null;
  return (
    <Card title="Needs your acknowledgement" className="pol-home-banner">
      <ul>
        {pending.map((p) => {
          const v = publishedVersion(p);
          return (
            <li key={p.id}>
              <div>
                <strong>{p.title}</strong>
                {v?.changeSummary && <p>{v.changeSummary}</p>}
                {v?.effectiveDate && <p>Effective {fmtDay(v.effectiveDate)}</p>}
              </div>
              <Link className="btn" to={`/policies?policy=${encodeURIComponent(p.id)}`}>
                Read and acknowledge
              </Link>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
