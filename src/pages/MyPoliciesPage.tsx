import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "react-router-dom";
import { ActionButton, Banner, Card, DataTable, Dialog, EmptyState, Field, Page, StatusBadge, SubmitButton, notify, useAction } from "../components/ui.tsx";
import { DEMO_ACCOUNTS } from "../demoAccounts.ts";
import { getPerson, subscribePeople } from "../data/peopleLocal.ts";
import {
  acknowledgePolicyAsync,
  getPolicyAcks,
  hasAcknowledged,
  latestAck,
  loadPolicyAcksFor,
  subscribePolicyAcks,
} from "../data/policyAcks.ts";
import {
  acknowledgeManaged,
  appliesToMe,
  archivePolicy,
  asLibraryPolicy,
  audienceLabel,
  audienceOptions,
  canEditPolicies,
  discardDraft,
  draftVersion,
  fetchTracking,
  fmtDay,
  getManagedPolicies,
  myAckOf,
  needsMyAck,
  publishPolicy,
  publishedVersion,
  restorePolicy,
  savePolicy,
  sendReminder,
  subscribeManagedPolicies,
  type AudienceType,
  type ManagedPolicy,
  type PolicyInput,
  type PolicyTracking,
} from "../data/policyAdmin.ts";
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
  type PolicySection,
} from "../data/policyLibrary.ts";
import { holidaysForCountry, holidaysForPerson, type CountryCode } from "../model.ts";
import { usePortal } from "../store.tsx";
import "./policies.css";

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

function useManaged() {
  return useSyncExternalStore(subscribeManagedPolicies, getManagedPolicies, getManagedPolicies);
}

/** One row in "My policies": a built-in library policy, or one HR published here. */
type Entry = { kind: "builtin"; policy: Policy } | { kind: "managed"; policy: Policy; managed: ManagedPolicy };


/** "37%"; a small non-zero share reads "<1%" (not "0%"), and an almost-complete one "99%" (not "100%"). */
function ackPercent(done: number, total: number): string {
  if (!total) return "0%";
  const pct = Math.round((done / total) * 100);
  if (done > 0 && pct === 0) return "<1%";
  if (done < total && pct === 100) return "99%";
  return `${pct}%`;
}
export function MyPoliciesPage() {
  const { state, employee } = usePortal();
  const acks = useSyncExternalStore(subscribePolicyAcks, getPolicyAcks, getPolicyAcks);
  const managed = useManaged();
  const editor = canEditPolicies(employee.role);
  const [params] = useSearchParams();
  const [tab, setTab] = useState<"mine" | "manage" | "acks">(editor && params.get("tab") === "acks" ? "acks" : "mine");

  const countryCode = (employee.countryCode ?? "IN") as CountryCode;
  const audience: PolicyAudience = { countryCode, legalEntity: employee.legalEntity, role: employee.role, employmentType: employee.employmentType };
  const builtins = useMemo(
    () =>
      policiesForPerson(
        { countryCode, legalEntity: employee.legalEntity, role: employee.role, employmentType: employee.employmentType },
        { holidays: holidaysForPerson(state.holidays, employee.id), shiftName: employee.shiftName, shiftHours: employee.shiftHours },
      ),
    [countryCode, employee.legalEntity, employee.role, employee.employmentType, employee.id, employee.shiftName, employee.shiftHours, state.holidays],
  );

  // A built-in policy HR edited here is replaced by the published copy (or hidden once archived).
  const replaced = new Set(managed.policies.filter((p) => p.currentVersion > 0).map((p) => p.id));
  const entries: Entry[] = [
    ...builtins.filter((b) => !replaced.has(b.id)).map((policy): Entry => ({ kind: "builtin", policy })),
    ...managed.policies
      .filter((p) => appliesToMe(p, employee.id))
      .map((p): Entry | null => {
        const policy = asLibraryPolicy(p);
        return policy ? { kind: "managed", policy, managed: p } : null;
      })
      .filter((e): e is Entry => e !== null),
  ];
  const builtinPending = entries.filter((e) => e.kind === "builtin" && e.policy.mandatory && !hasAcknowledged(acks, employee.id, e.policy.id, e.policy.version)).length;
  const managedPending = managed.policies.filter((p) => needsMyAck(p, employee.id));

  return (
    <Page title="Policies" subtitle={`${countryName(countryCode)} · ${legalEntityLabel(countryCode, audience.legalEntity)} · ${employee.employmentType || "Full Time"}`}>
      {editor && (
        <div className="soft-tabs" role="tablist" aria-label="Policies view">
          {(
            [
              ["mine", "My policies"],
              ["manage", "Manage"],
              ["acks", "Acknowledgements"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "soft-tab active" : "soft-tab"} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
      )}
      {managed.error && <Banner message={{ tone: "warn", text: managed.error }} />}
      {tab === "manage" && editor ? (
        <ManageView />
      ) : tab === "acks" && editor ? (
        <>
          <ManagedAcksView />
          <AcknowledgementsView acks={acks} />
        </>
      ) : (
        <MyPoliciesView entries={entries} builtinPending={builtinPending} managedPending={managedPending} userId={employee.id} acks={acks} />
      )}
    </Page>
  );
}

/* ───────────── My policies ───────────── */

function MyPoliciesView({
  entries,
  builtinPending,
  managedPending,
  userId,
  acks,
}: {
  entries: Entry[];
  builtinPending: number;
  managedPending: ManagedPolicy[];
  userId: string;
  acks: ReturnType<typeof getPolicyAcks>;
}) {
  const [query, setQuery] = useState("");
  const [params] = useSearchParams();
  // Copilot source links and notifications open a policy directly: /policies?policy=<id>
  const [openId, setOpenId] = useState(params.get("policy") ?? managedPending[0]?.id ?? "");
  useEffect(() => {
    const linked = params.get("policy");
    if (linked) setOpenId(linked);
  }, [params]);
  const q = query.trim().toLowerCase();
  const matches = (p: Policy) =>
    !q ||
    p.title.toLowerCase().includes(q) ||
    p.category.toLowerCase().includes(q) ||
    p.sections.some((s) => s.heading.toLowerCase().includes(q) || s.rules.some((r) => r.toLowerCase().includes(q)));
  const filtered = entries.filter((e) => matches(e.policy));
  const open = entries.find((e) => e.policy.id === openId) ?? null;
  const categories = [...POLICY_CATEGORIES, ...new Set(entries.map((e) => e.policy.category).filter((c) => !(POLICY_CATEGORIES as readonly string[]).includes(c)))];

  return (
    <>
      {managedPending.length > 0 && (
        <Card title="Needs your acknowledgement" className="pol-due-card">
          <ul className="pol-due-list">
            {managedPending.map((p) => (
              <li key={p.id}>
                <div>
                  <strong>{p.title}</strong> <span className="muted">v{p.currentVersion}</span>
                  {publishedVersion(p)?.changeSummary && <p className="muted">{publishedVersion(p)?.changeSummary}</p>}
                </div>
                <button type="button" className="btn" onClick={() => setOpenId(p.id)}>
                  Read
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {builtinPending > 0 && (
        <p className="note warn pol-alert">
          {builtinPending} mandatory {builtinPending === 1 ? "policy needs" : "policies need"} your acknowledgement.
        </p>
      )}
      <div className="pol-layout">
        <Card className="pol-list-card">
          <input className="pol-search" value={query} placeholder="Search policies and rules…" aria-label="Search policies" onChange={(e) => setQuery(e.target.value)} />
          {filtered.length === 0 && <p className="empty">No policy matches that search.</p>}
          {categories.map((cat) => {
            const inCat = filtered.filter((e) => e.policy.category === cat);
            if (inCat.length === 0) return null;
            return (
              <div key={cat} className="pol-group">
                <h3>{cat}</h3>
                <ul>
                  {inCat.map((e) => {
                    const p = e.policy;
                    let badge = null;
                    if (e.kind === "managed") {
                      const ack = myAckOf(e.managed, userId);
                      if (needsMyAck(e.managed, userId)) badge = <span className="pol-badge pol-badge-due">{ack ? "Updated — re-acknowledge" : "Acknowledge"}</span>;
                      else if (e.managed.requiresAck) badge = <span className="pol-badge pol-badge-ok">Acknowledged</span>;
                    } else {
                      const ack = latestAck(acks, userId, p.id);
                      const current = ack?.version === p.version;
                      if (p.mandatory && !current) badge = <span className="pol-badge pol-badge-due">{ack ? "Updated — re-acknowledge" : "Acknowledge"}</span>;
                      else if (current) badge = <span className="pol-badge pol-badge-ok">Acknowledged</span>;
                    }
                    return (
                      <li key={p.id}>
                        <button type="button" className={p.id === openId ? "pol-row active" : "pol-row"} onClick={() => setOpenId(p.id)}>
                          <span className="pol-row-title">{p.title}</span>
                          <span className="pol-row-meta">
                            v{p.version}
                            {badge}
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
            open.kind === "managed" ? (
              <ManagedDetail policy={open.managed} userId={userId} query={q} />
            ) : (
              <PolicyDetail policy={open.policy} userId={userId} acks={acks} query={q} />
            )
          ) : (
            <p className="empty">Pick a policy to read it. Only policies that apply to you are listed.</p>
          )}
        </Card>
      </div>
    </>
  );
}

function Sections({ sections, query }: { sections: PolicySection[]; query: string }) {
  return (
    <>
      {sections.map((s, i) => (
        <section key={`${s.heading}-${i}`}>
          <h3>{s.heading}</h3>
          <ul>
            {s.rules.map((r, j) => (
              <li key={`${j}-${r}`} className={query && r.toLowerCase().includes(query) ? "pol-hit" : undefined}>
                {r}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function PolicyDetail({ policy, userId, acks, query }: { policy: Policy; userId: string; acks: ReturnType<typeof getPolicyAcks>; query: string }) {
  const ack = latestAck(acks, userId, policy.id);
  const current = ack?.version === policy.version;
  const [ackError, setAckError] = useState<string | null>(null);
  useEffect(() => setAckError(null), [policy.id]);
  return (
    <article className="pol-article">
      <header>
        <h2>{policy.title}</h2>
        <p className="muted">
          {policy.category} · Version {policy.version} · Effective {policy.effective} · Owner: {policy.owner}
          {policy.mandatory ? " · Mandatory" : ""}
        </p>
      </header>
      <Sections sections={policy.sections} query={query} />
      <footer className="pol-ack">
        {current ? (
          <span className="pol-badge pol-badge-ok">
            Acknowledged v{ack.version} on {fmtStamp(ack.at)}
          </span>
        ) : (
          <>
            {ack && <span className="muted">You acknowledged v{ack.version}. This version changed.</span>}
            <ActionButton
              className="btn"
              busyLabel="Saving…"
              doneLabel="Acknowledged"
              success={`Policy acknowledged: ${policy.title}.`}
              onAction={async () => {
                const error = await acknowledgePolicyAsync(userId, policy.id, policy.version);
                setAckError(error);
                return error;
              }}
            >
              {`Acknowledge v${policy.version}`}
            </ActionButton>
          </>
        )}
        {ackError && <span className="pol-badge pol-badge-due">{ackError}</span>}
      </footer>
    </article>
  );
}

/** A policy HR published here: what changed, the text, version history and the acknowledgement. */
function ManagedDetail({ policy, userId, query }: { policy: ManagedPolicy; userId: string; query: string }) {
  const published = policy.versions.filter((v) => v.status === "published");
  const [viewing, setViewing] = useState(policy.currentVersion);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setViewing(policy.currentVersion);
    setComment("");
    setError(null);
  }, [policy.id, policy.currentVersion]);
  const v = published.find((x) => x.version === viewing) ?? publishedVersion(policy);
  if (!v) return <p className="empty">This policy has no published version.</p>;
  const ack = myAckOf(policy, userId);
  const due = needsMyAck(policy, userId);
  const older = v.version !== policy.currentVersion;

  return (
    <article className="pol-article">
      <header>
        <h2>{policy.title}</h2>
        <p className="muted">
          {policy.category} · Version {v.version}
          {v.effectiveDate ? ` · Effective ${fmtDay(v.effectiveDate)}` : ""}
          {v.publishedAt ? ` · Published ${fmtDay(v.publishedAt)}` : ""}
          {v.publishedBy ? ` by ${v.publishedBy}` : ""}
        </p>
      </header>
      {older && <Banner message={{ tone: "info", text: `You're reading v${v.version}. The current version is v${policy.currentVersion}.` }} />}
      {v.changeSummary && (
        <div className="pol-change">
          <strong>What changed</strong>
          <p>{v.changeSummary}</p>
        </div>
      )}
      {v.summary && <p className="pol-summary">{v.summary}</p>}
      <Sections sections={v.sections} query={query} />
      {published.length > 1 && (
        <section className="pol-history">
          <h3>Version history</h3>
          <ul>
            {published.map((x) => (
              <li key={x.version}>
                <button type="button" className={x.version === v.version ? "quiet-link active" : "quiet-link"} onClick={() => setViewing(x.version)}>
                  v{x.version}
                </button>{" "}
                <span className="muted">
                  {x.publishedAt ? fmtDay(x.publishedAt) : ""}
                  {x.version === policy.currentVersion ? " · current" : ""}
                </span>
                {x.changeSummary && <span> — {x.changeSummary}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {policy.requiresAck && (
        <footer className="pol-ack">
          {!due && ack ? (
            <span className="pol-badge pol-badge-ok">
              Acknowledged v{ack.version} on {fmtStamp(ack.at)}
              {ack.comment ? ` · "${ack.comment}"` : ""}
            </span>
          ) : (
            <div className="pol-ack-form">
              {ack && <span className="muted">You acknowledged v{ack.version}. This version changed.</span>}
              <Field label="Comment or question (optional)" wide>
                <textarea value={comment} rows={2} maxLength={1000} onChange={(e) => setComment(e.target.value)} />
              </Field>
              <ActionButton
                className="btn"
                busyLabel="Saving…"
                doneLabel="Acknowledged"
                success={`Acknowledged: ${policy.title}.`}
                onAction={async () => {
                  const err = await acknowledgeManaged(policy.id, userId, comment);
                  setError(err);
                  return err;
                }}
              >
                {`Acknowledge v${policy.currentVersion}`}
              </ActionButton>
              {error && <span className="pol-badge pol-badge-due">{error}</span>}
            </div>
          )}
        </footer>
      )}
    </article>
  );
}

/* ───────────── Manage (HR) ───────────── */

const emptyInput = (): PolicyInput => ({
  title: "",
  category: "Handbook",
  audienceType: "all",
  audienceValues: [],
  requiresAck: true,
  summary: "",
  sections: [{ heading: "", rules: [] }],
  changeSummary: "",
  effectiveDate: "",
});

function inputFromManaged(p: ManagedPolicy): PolicyInput {
  const v = draftVersion(p) ?? publishedVersion(p) ?? p.versions[0];
  const isDraft = v?.status === "draft";
  return {
    title: p.title,
    category: p.category,
    audienceType: p.audienceType,
    audienceValues: p.audienceValues,
    requiresAck: p.requiresAck,
    summary: v?.summary ?? "",
    sections: v?.sections.length ? v.sections : [{ heading: "", rules: [] }],
    changeSummary: isDraft ? v.changeSummary : "",
    effectiveDate: isDraft ? v.effectiveDate : "",
  };
}

function inputFromBuiltin(b: Policy): PolicyInput {
  const countries = b.appliesTo !== "all" ? b.appliesTo.countries ?? [] : [];
  return {
    id: b.id,
    title: b.title,
    category: b.category,
    audienceType: countries.length ? "country" : "all",
    audienceValues: countries,
    requiresAck: b.mandatory,
    baseVersion: Math.max(0, Math.floor(Number.parseFloat(b.version) || 0)),
    summary: "",
    sections: b.sections.map((s) => ({ heading: s.heading, rules: [...s.rules] })),
    changeSummary: "",
    effectiveDate: "",
  };
}

type EditorTarget = { input: PolicyInput; existingId?: string; published: boolean; label: string } | null;

function ManageView() {
  const { state, employee } = usePortal();
  const managed = useManaged();
  const [editing, setEditing] = useState<EditorTarget>(null);
  const [showArchived, setShowArchived] = useState(false);
  const catalog = useMemo(() => policyCatalog((code) => holidaysForCountry(state.holidays, code)), [state.holidays]);
  const managedIds = new Set(managed.policies.map((p) => p.id));
  const rows = managed.policies.filter((p) => showArchived || p.status !== "archived");

  const publish = async (p: ManagedPolicy) => {
    const [error, notified] = await publishPolicy(p.id, employee.fullName);
    if (!error) notify(`Published v${draftVersion(p)?.version ?? p.currentVersion + 1} of ${p.title}. ${notified} ${notified === 1 ? "person" : "people"} notified.`);
    return error;
  };

  return (
    <div className="stack">
      <Card
        title="Policies"
        action={
          <button type="button" className="btn" onClick={() => setEditing({ input: emptyInput(), published: false, label: "New policy" })}>
            New policy
          </button>
        }
      >
        <label className="pol-toggle">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
        </label>
        <DataTable
          headers={["Policy", "Applies to", "Status", "Acknowledge", "Updated", ""]}
          rows={rows.map((p) => {
            const draft = draftVersion(p);
            return [
              <span key="t">
                <strong>{p.title}</strong>
                <span className="muted" style={{ display: "block" }}>
                  {p.category}
                </span>
              </span>,
              audienceLabel(p),
              <span key="s" className="pol-status">
                <StatusBadge literal status={p.status === "published" ? `Published v${p.currentVersion}` : p.status === "archived" ? "Archived" : "Draft"} tone={p.status === "published" ? "ok" : p.status === "archived" ? "neutral" : "warn"} />
                {draft && p.status !== "archived" && p.currentVersion > 0 && <span className="muted">Draft v{draft.version} not published</span>}
              </span>,
              p.requiresAck ? "Yes" : "No",
              fmtDay(p.updatedAt),
              <span key="a" className="reward-actions">
                {p.status !== "archived" && (
                  <button type="button" className="quiet-link" onClick={() => setEditing({ input: inputFromManaged(p), existingId: p.id, published: p.currentVersion > 0, label: `Edit ${p.title}` })}>
                    Edit
                  </button>
                )}
                {draft && p.status !== "archived" && (
                  <ActionButton className="btn btn-tiny" toastError onAction={() => publish(p)}>
                    Publish
                  </ActionButton>
                )}
                {draft && p.currentVersion > 0 && p.status !== "archived" && (
                  <ActionButton className="btn-ghost btn-tiny" toastError success="Draft discarded." busyLabel="Discarding…" doneLabel="Discarded" onAction={() => discardDraft(p.id)}>
                    Discard draft
                  </ActionButton>
                )}
                {p.status === "archived" ? (
                  <ActionButton className="btn-ghost btn-tiny" toastError success={`${p.title} restored.`} busyLabel="Restoring…" doneLabel="Restored" onAction={() => restorePolicy(p.id)}>
                    Restore
                  </ActionButton>
                ) : (
                  <ActionButton className="btn-ghost btn-tiny" toastError success={`${p.title} archived.`} busyLabel="Archiving…" doneLabel="Archived" onAction={() => archivePolicy(p.id)}>
                    Archive
                  </ActionButton>
                )}
              </span>,
            ];
          })}
          empty={<EmptyState title={managed.loaded ? "No policies yet" : "Loading policies…"} description="Create one, or edit a built-in policy below." />}
        />
      </Card>

      <Card title="Built-in policies">
        <DataTable
          headers={["Policy", "Applies to", "Version", ""]}
          rows={catalog.map((b) => [
            b.title,
            appliesToLabel(b),
            `v${b.version}`,
            managedIds.has(b.id) ? (
              <span key="e" className="muted">
                Edited above
              </span>
            ) : (
              <button key="e" type="button" className="quiet-link" onClick={() => setEditing({ input: inputFromBuiltin(b), published: false, label: `Edit ${b.title}` })}>
                Edit
              </button>
            ),
          ])}
        />
      </Card>

      {editing && <PolicyEditor target={editing} onClose={() => setEditing(null)} publisherName={employee.fullName} />}
    </div>
  );
}

function PolicyEditor({ target, onClose, publisherName }: { target: NonNullable<EditorTarget>; onClose: () => void; publisherName: string }) {
  const [form, setForm] = useState<PolicyInput>(target.input);
  const [options, setOptions] = useState<{ countries: { code: string; name: string }[]; departments: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState(target.existingId);
  const saveAct = useAction();
  useEffect(() => {
    void audienceOptions().then(setOptions);
  }, []);
  const set = (patch: Partial<PolicyInput>) => setForm((f) => ({ ...f, ...patch }));
  const setSection = (i: number, patch: Partial<PolicySection>) => set({ sections: form.sections.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const toggle = (value: string) =>
    set({ audienceValues: form.audienceValues.includes(value) ? form.audienceValues.filter((v) => v !== value) : [...form.audienceValues, value] });
  const needsChange = target.published || (form.baseVersion ?? 0) > 0;

  async function persist(): Promise<[string | null, string]> {
    const [err, id] = await savePolicy(form, savedId);
    setError(err);
    if (!err) setSavedId(id);
    return [err, id];
  }

  const save = async () => (await persist())[0];

  async function saveAndPublish(): Promise<string | null> {
    if (needsChange && !form.changeSummary.trim()) {
      setError("Say what changed in this version.");
      return "Say what changed in this version.";
    }
    const [err, id] = await persist();
    if (err) return err;
    const [pubErr, notified] = await publishPolicy(id, publisherName);
    setError(pubErr);
    if (pubErr) return pubErr;
    notify(`${form.title.trim()} published. ${notified} ${notified === 1 ? "person" : "people"} notified.`);
    onClose();
    return null;
  }

  return (
    <Dialog open wide title={target.label} onClose={onClose}>
      <form
        className="stack pol-editor"
        onSubmit={saveAct.submit(save, {
          success: "Draft saved.",
        })}
      >
        <Banner message={error ? { tone: "err", text: error } : null} />
        <div className="form-grid-2">
          <Field label="Title">
            <input value={form.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} required />
          </Field>
          <Field label="Category">
            <select value={form.category} onChange={(e) => set({ category: e.target.value })}>
              {[...new Set([...POLICY_CATEGORIES, form.category])].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="Applies to">
            <select value={form.audienceType} onChange={(e) => set({ audienceType: e.target.value as AudienceType, audienceValues: [] })}>
              <option value="all">Everyone</option>
              <option value="country">Countries</option>
              <option value="department">Departments</option>
            </select>
          </Field>
          <Field label="Effective date">
            <input type="date" value={form.effectiveDate} onChange={(e) => set({ effectiveDate: e.target.value })} />
          </Field>
        </div>
        {form.audienceType !== "all" && (
          <fieldset className="pol-audience">
            <legend>{form.audienceType === "country" ? "Countries" : "Departments"}</legend>
            {!options && <span className="muted">Loading…</span>}
            {options &&
              (form.audienceType === "country" ? options.countries.map((c) => ({ value: c.code, label: c.name })) : options.departments.map((d) => ({ value: d, label: d }))).map((o) => (
                <label key={o.value} className="pol-check">
                  <input type="checkbox" checked={form.audienceValues.includes(o.value)} onChange={() => toggle(o.value)} /> {o.label}
                </label>
              ))}
          </fieldset>
        )}
        <label className="pol-toggle">
          <input type="checkbox" checked={form.requiresAck} onChange={(e) => set({ requiresAck: e.target.checked })} /> Employees must acknowledge
        </label>
        <Field label={needsChange ? "What changed" : "What changed (optional for the first version)"} wide>
          <input value={form.changeSummary} maxLength={1000} placeholder="e.g. PF contribution goes up from 12% to 13% from 1 Dec" onChange={(e) => set({ changeSummary: e.target.value })} />
        </Field>
        <Field label="Introduction (optional)" wide>
          <textarea value={form.summary} rows={2} maxLength={4000} onChange={(e) => set({ summary: e.target.value })} />
        </Field>
        {form.sections.map((s, i) => (
          <div key={i} className="pol-section-edit">
            <div className="pol-section-head">
              <Field label={`Section ${i + 1} heading`}>
                <input value={s.heading} maxLength={200} onChange={(e) => setSection(i, { heading: e.target.value })} />
              </Field>
              {form.sections.length > 1 && (
                <button type="button" className="btn-ghost btn-tiny" onClick={() => set({ sections: form.sections.filter((_, j) => j !== i) })}>
                  Remove
                </button>
              )}
            </div>
            <Field label="Rules (one per line)" wide>
              <textarea value={s.rules.join("\n")} rows={4} onChange={(e) => setSection(i, { rules: e.target.value.split("\n") })} />
            </Field>
          </div>
        ))}
        <div className="row-gap">
          <button type="button" className="btn-ghost" onClick={() => set({ sections: [...form.sections, { heading: "", rules: [] }] })}>
            Add section
          </button>
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <SubmitButton action={saveAct} className="btn-ghost">
            Save draft
          </SubmitButton>
          <ActionButton className="btn" onAction={saveAndPublish}>
            Publish
          </ActionButton>
        </div>
      </form>
    </Dialog>
  );
}

/* ───────────── Acknowledgement tracking (HR) ───────────── */

function ManagedAcksView() {
  const managed = useManaged();
  const tracked = managed.policies.filter((p) => p.status === "published" && p.requiresAck);
  const [open, setOpen] = useState<string | null>(null);
  const [data, setData] = useState<Record<string, PolicyTracking>>({});
  const [tick, setTick] = useState(0);
  const ids = tracked.map((p) => `${p.id}:${p.currentVersion}`).join("|");
  useEffect(() => {
    let live = true;
    for (const p of tracked) {
      void fetchTracking(p.id).then(({ data: t }) => {
        if (live && t) setData((d) => ({ ...d, [p.id]: t }));
      });
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, tick]);

  return (
    <Card title="Published policies">
      <DataTable
        headers={["Policy", "Version", "Applies to", "Acknowledged", ""]}
        rows={tracked.map((p) => {
          const t = data[p.id];
          return [
            p.title,
            `v${p.currentVersion}`,
            audienceLabel(p),
            t ? (
              <span key="m">
                <div className="pol-meter" aria-label={`${t.percent}% acknowledged`}>
                  <span style={{ width: `${t.percent}%` }} />
                </div>
                {ackPercent(t.acknowledged, t.targeted)} ({t.acknowledged}/{t.targeted})
              </span>
            ) : (
              "…"
            ),
            <span key="a" className="reward-actions">
              <button type="button" className="quiet-link" onClick={() => setOpen(open === p.id ? null : p.id)}>
                {open === p.id ? "Hide" : "Details"}
              </button>
              <ActionButton
                className="btn-ghost btn-tiny"
                busyLabel="Sending…"
                doneLabel="Sent"
                disabled={t ? t.pending.length === 0 : false}
                toastError
                onAction={async () => {
                  const [error, count] = await sendReminder(p.id);
                  if (!error) notify(count ? `Reminder sent to ${count} ${count === 1 ? "person" : "people"}.` : "Everyone has acknowledged.");
                  return error;
                }}
              >
                Send reminder
              </ActionButton>
            </span>,
          ];
        })}
        empty={managed.loaded ? <EmptyState title="No published policies need acknowledgement" description="Publish one under Manage." /> : <EmptyState title="Loading policies…" />}
      />
      {open && data[open] && (
        <div className="pol-track">
          <div>
            <h3>Pending ({data[open].pending.length})</h3>
            {data[open].pending.length === 0 ? (
              <p className="muted">Everyone has acknowledged.</p>
            ) : (
              <ul>
                {data[open].pending.slice(0, 200).map((x) => (
                  <li key={x.id}>
                    {x.name}
                    <span className="muted">{[x.department, x.countryCode].filter(Boolean).join(" · ") ? ` · ${[x.department, x.countryCode].filter(Boolean).join(" · ")}` : ""}</span>
                  </li>
                ))}
                {data[open].pending.length > 200 && <li className="muted">and {data[open].pending.length - 200} more</li>}
              </ul>
            )}
          </div>
          <div>
            <h3>Acknowledged ({data[open].done.length})</h3>
            {data[open].done.length === 0 ? (
              <p className="muted">Nobody yet.</p>
            ) : (
              <ul>
                {data[open].done.map((x) => (
                  <li key={x.id}>
                    {x.name} <span className="muted">· {fmtStamp(x.at)}</span>
                    {x.comment && <div className="pol-comment">“{x.comment}”</div>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button type="button" className="btn-ghost btn-tiny" onClick={() => setTick((n) => n + 1)}>
            Refresh
          </button>
        </div>
      )}
    </Card>
  );
}

function AcknowledgementsView({ acks }: { acks: ReturnType<typeof getPolicyAcks> }) {
  const { state } = usePortal();
  const managed = useManaged();
  const [peopleTick, setPeopleTick] = useState(0);
  useEffect(() => subscribePeople(() => setPeopleTick((n) => n + 1)), []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const people = useMemo(() => population(), [peopleTick]);
  const [mandatoryOnly, setMandatoryOnly] = useState(true);
  const replaced = new Set(managed.policies.filter((p) => p.currentVersion > 0).map((p) => p.id));
  const catalog = useMemo(() => policyCatalog((code) => holidaysForCountry(state.holidays, code)), [state.holidays]).filter((p) => !replaced.has(p.id));
  // Backend mode: load everyone's acknowledgements for these policies (no-op in browser-only mode).
  const catalogIds = catalog.map((p) => p.id).join("|");
  useEffect(() => {
    if (catalogIds) void loadPolicyAcksFor(catalogIds.split("|"));
  }, [catalogIds]);

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
    <Card title="Built-in policies">
      <p className="muted pol-hint">Acknowledgements of an older version count as pending.</p>
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
                    {ackPercent(done.length, applicable.length)} ({done.length}/{applicable.length})
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
