import { useMemo } from "react";
import { Link } from "react-router-dom";
import { ActionButton, Banner, Card, DataTable, EmptyState, Page, StatusBadge } from "../components/ui.tsx";
import { useAuditTrail } from "../data/auditTrail.ts";
import {
  AI_FEATURES,
  aiSettingsError,
  knowledgePolicies,
  setAgentEnabled,
  setAiFeature,
  setPoliciesEnabled,
  useAiSettings,
} from "../data/aiSettings.ts";
import { AI_AGENTS } from "../data/platformData.ts";
import { TIMEZ_COUNTRIES } from "../model.ts";
import { usePortal } from "../store.tsx";

const COUNTRY_NAME = new Map<string, string>(TIMEZ_COUNTRIES.map((c) => [c.code, c.name]));

function policyGroup(id: string): string {
  const code = /-([A-Z]{2})$/.exec(id)?.[1];
  return code ? COUNTRY_NAME.get(code) ?? code : "Company-wide";
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** /admin/ai — knowledge sources, agents, AI features and the Copilot question log. Admin only. */
export function AiSettingsPage() {
  const { demoProfile, employee } = usePortal();
  const settings = useAiSettings();
  const audit = useAuditTrail();
  const actor = { id: employee.id, name: employee.fullName };
  const policies = knowledgePolicies();
  const groups = useMemo(() => {
    const map = new Map<string, typeof policies>();
    for (const p of policies) {
      const g = policyGroup(p.id);
      map.set(g, [...(map.get(g) ?? []), p]);
    }
    return [...map.entries()];
  }, [policies]);
  const questions = useMemo(() => audit.filter((e) => e.entity === "Copilot question").slice(0, 50), [audit]);

  if (demoProfile.role !== "admin" && demoProfile.role !== "super_admin") {
    return (
      <Page title="AI settings">
        <EmptyState title="Not authorized" description="Only Admin can change AI settings." />
      </Page>
    );
  }

  const offPolicies = new Set(settings.disabledPolicies);
  const enabledCount = policies.filter((p) => !offPolicies.has(p.id)).length;
  const field = (changes: { field: string; after: string }[], name: string) => changes.find((c) => c.field === name)?.after ?? "—";

  return (
    <Page title="AI settings">
      {aiSettingsError() && <Banner message={{ tone: "err", text: aiSettingsError() ?? "" }} />}
      <Card title={`Knowledge sources (${enabledCount} of ${policies.length} on)`}>
        <p className="note">Copilot answers only from policies that are on.</p>
        {groups.map(([group, list]) => {
          const allOn = list.every((p) => !offPolicies.has(p.id));
          return (
            <div key={group}>
              <div className="row-between" style={{ marginTop: 12 }}>
                <h3 className="profile-subhead">{group}</h3>
                <ActionButton
                  className="btn-ghost btn-tiny"
                  busyLabel="Saving…"
                  doneLabel="Saved"
                  success={`${group} policies turned ${allOn ? "off" : "on"}.`}
                  toastError
                  onAction={() => setPoliciesEnabled(list.map((p) => p.id), !allOn, actor)}
                >
                  {allOn ? "Turn all off" : "Turn all on"}
                </ActionButton>
              </div>
              <ul className="perm-grid">
                {list.map((p) => (
                  <li key={p.id}>
                    <label className="perm-item">
                      <input
                        type="checkbox"
                        checked={!offPolicies.has(p.id)}
                        onChange={(e) => setPoliciesEnabled([p.id], e.target.checked, actor)}
                      />
                      <span>
                        <strong>{p.title}</strong>
                        <span className="note">
                          v{p.version} · {p.category}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </Card>

      <Card title="Agents">
        <ul className="perm-grid">
          {AI_AGENTS.map((a) => (
            <li key={a.id}>
              <label className="perm-item">
                <input
                  type="checkbox"
                  checked={!settings.disabledAgents.includes(a.id)}
                  onChange={(e) => setAgentEnabled(a.id, e.target.checked, actor)}
                />
                <span>
                  <strong>{a.name}</strong>
                  <span className="note">{a.purpose}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="AI features">
        <ul className="perm-grid">
          {AI_FEATURES.map((f) => (
            <li key={f.key}>
              <label className="perm-item">
                <input
                  type="checkbox"
                  checked={!settings.disabledFeatures.includes(f.key)}
                  onChange={(e) => setAiFeature(f.key, e.target.checked, actor)}
                />
                <span>
                  <strong>{f.label}</strong>
                  <span className="note">{f.hint}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="AI question log" action={<Link to="/admin/audit">Full audit log</Link>}>
        <p className="note">Latest 50 Copilot questions.</p>
        <DataTable
          headers={["When", "Asked by", "Question", "Sources", "Access"]}
          empty={<p className="note">No questions yet.</p>}
          rows={questions.map((e) => {
            const denied = field(e.changes, "access denied") === "Yes";
            return [
              when(e.at),
              e.actorName,
              field(e.changes, "question"),
              <small key="s" className="note">{field(e.changes, "sources")}</small>,
              <StatusBadge key="a" status={denied ? "Denied" : "Allowed"} tone={denied ? "danger" : "ok"} literal />,
            ];
          })}
        />
      </Card>
    </Page>
  );
}
