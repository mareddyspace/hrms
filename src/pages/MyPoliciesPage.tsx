import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Card, Page } from "../components/ui.tsx";
import { DEMO_ACCOUNTS } from "../demoAccounts.ts";
import { getPerson, subscribePeople } from "../data/peopleLocal.ts";
import { acknowledgePolicy, getPolicyAcks, hasAcknowledged, latestAck, subscribePolicyAcks } from "../data/policyAcks.ts";
import {
  POLICY_CATEGORIES,
  appliesToLabel,
  countryName,
  legalEntityLabel,
  policiesForPerson,
  policyAppliesTo,
  policyCatalog,
  type Policy,
  type PolicyAudience,
} from "../data/policyLibrary.ts";
import { holidaysForCountry, holidaysForPerson, type CountryCode, type UserRole } from "../model.ts";
import { usePortal } from "../store.tsx";
import "./policies.css";

const HR_ROLES: UserRole[] = ["hr", "hr_admin", "hrbp"];
/** Engineering teammates who appear across the portal but can't sign in. */
const TEAMMATE_IDS = ["emp-priya", "emp-anu", "emp-kabir", "emp-diya"];

type PersonRow = { id: string; name: string; audience: PolicyAudience; canSignIn: boolean };

function population(): PersonRow[] {
  const rows: PersonRow[] = DEMO_ACCOUNTS.map((a) => {
    const p = getPerson(a.id);
    return {
      id: a.id,
      name: a.fullName,
      canSignIn: true,
      audience: {
        countryCode: (p?.countryCode ?? a.countryCode ?? "IN") as CountryCode,
        legalEntity: p?.legalEntity ?? a.legalEntity,
        role: a.role,
        employmentType: p?.employmentType ?? a.employmentType,
      },
    };
  });
  for (const id of TEAMMATE_IDS) {
    const p = getPerson(id);
    if (!p || rows.some((r) => r.id === id)) continue;
    rows.push({
      id,
      name: p.fullName,
      canSignIn: false,
      audience: { countryCode: p.countryCode as CountryCode, legalEntity: p.legalEntity, role: "employee", employmentType: p.employmentType },
    });
  }
  return rows;
}

const fmtStamp = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

export function MyPoliciesPage() {
  const { state, employee } = usePortal();
  const acks = useSyncExternalStore(subscribePolicyAcks, getPolicyAcks, getPolicyAcks);
  const isHr = HR_ROLES.includes(employee.role);
  const [tab, setTab] = useState<"mine" | "acks">("mine");

  const countryCode = (employee.countryCode ?? "IN") as CountryCode;
  const audience: PolicyAudience = {
    countryCode,
    legalEntity: employee.legalEntity,
    role: employee.role,
    employmentType: employee.employmentType,
  };
  const policies = useMemo(
    () =>
      policiesForPerson(
        { countryCode, legalEntity: employee.legalEntity, role: employee.role, employmentType: employee.employmentType },
        { holidays: holidaysForPerson(state.holidays, employee.id), shiftName: employee.shiftName, shiftHours: employee.shiftHours },
      ),
    [countryCode, employee.legalEntity, employee.role, employee.employmentType, employee.id, employee.shiftName, employee.shiftHours, state.holidays],
  );
  const pending = policies.filter((p) => p.mandatory && !hasAcknowledged(acks, employee.id, p.id, p.version));

  return (
    <Page
      title="Policies"
      subtitle={`${countryName(countryCode)} · ${legalEntityLabel(countryCode, audience.legalEntity)} · ${employee.employmentType || "Full Time"}`}
    >
      {isHr && (
        <div className="soft-tabs" role="tablist" aria-label="Policies view">
          <button type="button" role="tab" aria-selected={tab === "mine"} className={tab === "mine" ? "soft-tab active" : "soft-tab"} onClick={() => setTab("mine")}>
            My policies
          </button>
          <button type="button" role="tab" aria-selected={tab === "acks"} className={tab === "acks" ? "soft-tab active" : "soft-tab"} onClick={() => setTab("acks")}>
            Acknowledgements
          </button>
        </div>
      )}
      {tab === "acks" && isHr ? (
        <AcknowledgementsView acks={acks} />
      ) : (
        <MyPoliciesView policies={policies} pendingCount={pending.length} userId={employee.id} acks={acks} />
      )}
    </Page>
  );
}

function MyPoliciesView({
  policies,
  pendingCount,
  userId,
  acks,
}: {
  policies: Policy[];
  pendingCount: number;
  userId: string;
  acks: ReturnType<typeof getPolicyAcks>;
}) {
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState("");
  const q = query.trim().toLowerCase();
  const matches = (p: Policy) =>
    !q ||
    p.title.toLowerCase().includes(q) ||
    p.category.toLowerCase().includes(q) ||
    p.sections.some((s) => s.heading.toLowerCase().includes(q) || s.rules.some((r) => r.toLowerCase().includes(q)));
  const filtered = policies.filter(matches);
  const open = policies.find((p) => p.id === openId) ?? null;

  return (
    <>
      {pendingCount > 0 && (
        <p className="note warn pol-alert">
          {pendingCount} mandatory {pendingCount === 1 ? "policy needs" : "policies need"} your acknowledgement.
        </p>
      )}
      <div className="pol-layout">
        <Card className="pol-list-card">
          <input
            className="pol-search"
            value={query}
            placeholder="Search policies and rules…"
            aria-label="Search policies"
            onChange={(e) => setQuery(e.target.value)}
          />
          {filtered.length === 0 && <p className="empty">No policy matches that search.</p>}
          {POLICY_CATEGORIES.map((cat) => {
            const inCat = filtered.filter((p) => p.category === cat);
            if (inCat.length === 0) return null;
            return (
              <div key={cat} className="pol-group">
                <h3>{cat}</h3>
                <ul>
                  {inCat.map((p) => {
                    const ack = latestAck(acks, userId, p.id);
                    const current = ack?.version === p.version;
                    return (
                      <li key={p.id}>
                        <button type="button" className={p.id === openId ? "pol-row active" : "pol-row"} onClick={() => setOpenId(p.id)}>
                          <span className="pol-row-title">{p.title}</span>
                          <span className="pol-row-meta">
                            v{p.version}
                            {p.mandatory && !current && <span className="pol-badge pol-badge-due">{ack ? "Updated — re-acknowledge" : "Acknowledge"}</span>}
                            {current && <span className="pol-badge pol-badge-ok">Acknowledged</span>}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </Card>
        <Card className="pol-detail">
          {open ? (
            <PolicyDetail policy={open} userId={userId} acks={acks} query={q} />
          ) : (
            <p className="empty">Pick a policy to read it. Only policies that apply to you are listed.</p>
          )}
        </Card>
      </div>
    </>
  );
}

function PolicyDetail({ policy, userId, acks, query }: { policy: Policy; userId: string; acks: ReturnType<typeof getPolicyAcks>; query: string }) {
  const ack = latestAck(acks, userId, policy.id);
  const current = ack?.version === policy.version;
  return (
    <article className="pol-article">
      <header>
        <h2>{policy.title}</h2>
        <p className="muted">
          {policy.category} · Version {policy.version} · Effective {policy.effective} · Owner: {policy.owner}
          {policy.mandatory ? " · Mandatory" : ""}
        </p>
      </header>
      {policy.sections.map((s) => (
        <section key={s.heading}>
          <h3>{s.heading}</h3>
          <ul>
            {s.rules.map((r) => (
              <li key={r} className={query && r.toLowerCase().includes(query) ? "pol-hit" : undefined}>
                {r}
              </li>
            ))}
          </ul>
        </section>
      ))}
      <footer className="pol-ack">
        {current ? (
          <span className="pol-badge pol-badge-ok">Acknowledged v{ack.version} on {fmtStamp(ack.at)}</span>
        ) : (
          <>
            {ack && <span className="muted">You acknowledged v{ack.version}. This version changed.</span>}
            <button type="button" className="btn" onClick={() => acknowledgePolicy(userId, policy.id, policy.version)}>
              Acknowledge v{policy.version}
            </button>
          </>
        )}
      </footer>
    </article>
  );
}

function AcknowledgementsView({ acks }: { acks: ReturnType<typeof getPolicyAcks> }) {
  const { state } = usePortal();
  const [peopleTick, setPeopleTick] = useState(0);
  useEffect(() => subscribePeople(() => setPeopleTick((n) => n + 1)), []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const people = useMemo(() => population(), [peopleTick]);
  const [mandatoryOnly, setMandatoryOnly] = useState(true);
  const catalog = useMemo(() => policyCatalog((code) => holidaysForCountry(state.holidays, code)), [state.holidays]);

  const rows = catalog
    .filter((p) => !mandatoryOnly || p.mandatory)
    .map((p) => {
      const applicable = people.filter((person) => policyAppliesTo(p, person.audience));
      const done = applicable.filter((person) => hasAcknowledged(acks, person.id, p.id, p.version));
      const pending = applicable.filter((person) => !done.includes(person));
      return { policy: p, applicable, done, pending };
    })
    .filter((row) => row.applicable.length > 0);

  return (
    <Card title="Acknowledgements">
      <p className="muted pol-hint">
        Acknowledgements of an older version count as pending.
      </p>
      <label className="pol-toggle">
        <input type="checkbox" checked={mandatoryOnly} onChange={(e) => setMandatoryOnly(e.target.checked)} /> Mandatory policies only
      </label>
      <div className="doc-table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Policy</th>
              <th>Applies to</th>
              <th>Version</th>
              <th>Acknowledged</th>
              <th>Pending</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ policy, applicable, done, pending }) => {
              const pct = Math.round((done.length / applicable.length) * 100);
              return (
                <tr key={policy.id}>
                  <td>{policy.title}</td>
                  <td>{appliesToLabel(policy)}</td>
                  <td>v{policy.version}</td>
                  <td>
                    <div className="pol-meter" aria-label={`${pct}% acknowledged`}>
                      <span style={{ width: `${pct}%` }} />
                    </div>
                    {pct}% ({done.length}/{applicable.length})
                  </td>
                  <td>
                    {pending.length === 0
                      ? "—"
                      : pending.map((person) => (
                          <span key={person.id} className="pol-person">
                            {person.name}
                            {!person.canSignIn && <em> (can't sign in)</em>}
                          </span>
                        ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <p className="empty">No policies apply to anyone in this group.</p>}
    </Card>
  );
}
