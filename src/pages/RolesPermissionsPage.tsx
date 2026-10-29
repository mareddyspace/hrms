import { useMemo, useState } from "react";
import { ActionButton, Banner, Card, DataTable, EmptyState, Page, StatusBadge, notify } from "../components/ui.tsx";
import { DEMO_ACCOUNTS, type DemoAccount } from "../demoAccounts.ts";
import {
  DATA_SCOPES,
  LOCKED_PAGE_IDS,
  dataScopeFor,
  dataScopeLabel,
  defaultDataScope,
  effectivePageIds,
  hasCustomDataScope,
  hasCustomPageAccess,
  pageCatalog,
  resetPageAccess,
  saveDataScope,
  savePageAccess,
  useAccessVersion,
  type DataScope,
} from "../data/accessControl.ts";
import { TIMEZ_COUNTRIES, type CountryCode } from "../model.ts";
import { roleLabel } from "../nav.ts";
import { usePortal } from "../store.tsx";
import { API_ENABLED } from "../api/syncOps.ts";

type Msg = { tone: "ok" | "err" | "warn"; text: string } | null;

const isAdmin = (a: DemoAccount) => a.role === "admin" || a.role === "super_admin";
const isHr = (a: DemoAccount) => a.role === "hr" || a.role === "hr_admin" || a.role === "hrbp";

/** /admin/roles — page access and data scope for each sign-in account. Admin only. */
export function RolesPermissionsPage() {
  useAccessVersion();
  const { demoProfile } = usePortal();
  const [selectedId, setSelectedId] = useState<string>(DEMO_ACCOUNTS.find((a) => a.id !== demoProfile.id)?.id ?? DEMO_ACCOUNTS[0].id);
  const [msg, setMsg] = useState<Msg>(null);

  if (!isAdmin(demoProfile)) {
    return (
      <Page title="Roles & permissions">
        <EmptyState title="Not authorized" description="Only Admin can change roles and permissions." />
      </Page>
    );
  }

  const selected = DEMO_ACCOUNTS.find((a) => a.id === selectedId) ?? DEMO_ACCOUNTS[0];

  return (
    <Page title="Roles & permissions">
      {msg && <Banner message={msg} />}
      <Card title="Accounts">
        <DataTable
          headers={["Name", "Role", "Pages", "Data scope", ""]}
          rows={DEMO_ACCOUNTS.map((a) => [
            <span key="n">
              <strong>{a.fullName}</strong>
              {a.id === demoProfile.id && <span className="note"> (you)</span>}
            </span>,
            roleLabel(a.role),
            <span key="p" className="chip-row">
              {effectivePageIds(a).length}
              {hasCustomPageAccess(a.id) && <StatusBadge status="Custom" tone="info" literal />}
            </span>,
            <span key="s" className="chip-row">
              {dataScopeLabel(dataScopeFor(a.id))}
              {hasCustomDataScope(a.id) && <StatusBadge status="Custom" tone="info" literal />}
            </span>,
            <button
              key="e"
              type="button"
              className={a.id === selected.id ? "btn btn-tiny" : "btn-ghost btn-tiny"}
              onClick={() => {
                setSelectedId(a.id);
                setMsg(null);
              }}
            >
              {a.id === selected.id ? "Editing" : "Edit"}
            </button>,
          ])}
        />
      </Card>
      <AccountEditor key={selected.id} account={selected} actor={demoProfile} onResult={setMsg} />
    </Page>
  );
}

function AccountEditor({ account, actor, onResult }: { account: DemoAccount; actor: DemoAccount; onResult: (m: Msg) => void }) {
  const self = account.id === actor.id;
  const catalog = useMemo(() => pageCatalog(), []);
  const groups = useMemo(() => [...new Set(catalog.map((p) => p.group))], [catalog]);
  const [pages, setPages] = useState<string[]>(() => effectivePageIds(account));
  const current = dataScopeFor(account.id);
  const [scope, setScope] = useState<DataScope>(current.scope);
  const [countries, setCountries] = useState<CountryCode[]>(current.countries);
  const actorRef = { id: actor.id, name: actor.fullName };

  function togglePage(id: string) {
    setPages((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));
  }

  function toggleCountry(code: CountryCode) {
    setCountries((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));
  }

  const [busy, setBusy] = useState(false);

  async function savePages() {
    setBusy(true);
    const error = await savePageAccess(account, pages, actor);
    setBusy(false);
    onResult(error ? { tone: "err", text: error } : { tone: "ok", text: `Pages saved for ${account.fullName}.` });
    if (error) return false;
    setPages(effectivePageIds(account));
    notify(`Pages saved for ${account.fullName}.`);
    return true;
  }

  async function saveScope() {
    setBusy(true);
    const error = await saveDataScope(account.id, { scope, countries }, actorRef);
    setBusy(false);
    onResult(error ? { tone: "err", text: error } : { tone: "ok", text: `Data scope saved for ${account.fullName}.` });
    if (error) return false;
    notify(`Data scope saved for ${account.fullName}.`);
    return true;
  }

  async function resetAll() {
    setBusy(true);
    const error = self ? null : await resetPageAccess(account, actor);
    if (error) {
      setBusy(false);
      onResult({ tone: "err", text: error });
      return false;
    }
    const def = defaultDataScope(account);
    // Your own data scope can't change (the API refuses it too).
    const scopeError = self && API_ENABLED ? null : await saveDataScope(account.id, def, actorRef);
    setBusy(false);
    if (scopeError) {
      onResult({ tone: "err", text: scopeError });
      return false;
    }
    setPages(effectivePageIds(account));
    setScope(def.scope);
    setCountries(def.countries);
    onResult({ tone: "ok", text: `${account.fullName} is back to the ${roleLabel(account.role)} defaults.` });
    notify(`${account.fullName} is back to the ${roleLabel(account.role)} defaults.`);
    return true;
  }

  return (
    <>
      <Card
        title={`${account.fullName} · pages`}
        action={
          <span className="chip-row">
            <ActionButton className="btn-ghost" busyLabel="Resetting…" doneLabel="Reset" onAction={resetAll} disabled={busy}>
              Reset to default
            </ActionButton>
            <ActionButton className="btn" onAction={savePages} disabled={self || busy}>
              Save pages
            </ActionButton>
          </span>
        }
      >
        {self && <Banner message={{ tone: "warn", text: "You can't change page access on your own account." }} />}
        <p className="note">Turned-off pages leave the menu and can't be opened by link.</p>
        {groups.map((group) => (
          <div key={group}>
            <h3 className="profile-subhead" style={{ marginTop: 12 }}>{group}</h3>
            <ul className="perm-grid">
              {catalog
                .filter((p) => p.group === group)
                .map((p) => {
                  const locked = LOCKED_PAGE_IDS.includes(p.id);
                  return (
                    <li key={p.id}>
                      <label className="perm-item">
                        <input
                          type="checkbox"
                          checked={locked || pages.includes(p.id)}
                          disabled={self || locked}
                          onChange={() => togglePage(p.id)}
                        />
                        <span>
                          <strong>{p.label}</strong>
                          {locked && <span className="note">Always on</span>}
                        </span>
                      </label>
                    </li>
                  );
                })}
            </ul>
          </div>
        ))}
      </Card>

      <Card
        title={`${account.fullName} · data scope`}
        action={
          <ActionButton className="btn" onAction={saveScope} disabled={busy || (API_ENABLED && self)}>
            Save scope
          </ActionButton>
        }
      >
        <p className="note">Whose records they see in lists and search. Default for {roleLabel(account.role)}: {dataScopeLabel(defaultDataScope(account))}.</p>
        <ul className="perm-grid">
          {DATA_SCOPES.map((s) => (
            <li key={s.id}>
              <label className="perm-item">
                <input type="radio" name={`scope-${account.id}`} checked={scope === s.id} onChange={() => setScope(s.id)} />
                <span>
                  <strong>{s.label}</strong>
                  <span className="note">{s.hint}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        {isHr(account) && (
          <>
            <h3 className="profile-subhead" style={{ marginTop: 12 }}>Countries</h3>
            <p className="note">Leave all off for every country.</p>
            <ul className="perm-grid">
              {TIMEZ_COUNTRIES.map((c) => (
                <li key={c.code}>
                  <label className="perm-item">
                    <input type="checkbox" checked={countries.includes(c.code)} onChange={() => toggleCountry(c.code)} />
                    <span>
                      <strong>{c.name}</strong>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </>
  );
}
