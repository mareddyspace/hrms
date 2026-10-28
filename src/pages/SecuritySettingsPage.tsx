import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { API_ENABLED, apiSessionMe, isApiAdmin } from "../api/client.ts";
import {
  deviceLabel,
  disableMfa,
  enableMfa,
  getMfaPolicy,
  getMfaStatus,
  listAccountSessions,
  listAccounts,
  listMySessions,
  renewBackupCodes,
  revokeAccountSessions,
  revokeOtherSessions,
  revokeSession,
  setMfaPolicy,
  startMfaSetup,
  type AdminAccountRow,
  type MfaSetup,
  type MfaStatus,
  type SignedInDevice,
} from "../api/securitySettings.ts";
import { Banner, Card, Field, Page, downloadText } from "../components/ui.tsx";

type Note = { tone: "ok" | "err" | "warn" | "info"; text: string } | null;

const errText = (e: unknown) => (e instanceof Error ? e.message : "That didn't work. Try again.");
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");
const groupKey = (key: string) => key.replace(/(.{4})/g, "$1 ").trim();

/** Profile menu → "Two-step sign-in": authenticator app, backup codes, signed-in devices (and admin tools). */
export function SecuritySettingsPage() {
  if (!API_ENABLED) {
    return (
      <Page title="Two-step sign-in" subtitle="Sign-in security for your account">
        <Card title="Not available">
          <p className="muted">Two-step sign-in and signed-in devices work when the portal is connected to the server.</p>
        </Card>
      </Page>
    );
  }
  return <SecuritySettings />;
}

function SecuritySettings() {
  const [role, setRole] = useState("");
  useEffect(() => {
    apiSessionMe().then((me) => setRole(me.role)).catch(() => setRole(""));
  }, []);
  return (
    <Page title="Two-step sign-in" subtitle="Sign-in security for your account">
      <div className="stack">
        <MfaCard />
        <DevicesCard />
        {isApiAdmin(role) && <AdminSecurityCard />}
      </div>
    </Page>
  );
}

function BackupCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <div className="stack">
      <p className="note warn">Save these backup codes now. Each works once if you lose your phone. They won't be shown again.</p>
      <ul className="stack-tight" style={{ fontFamily: "monospace", columns: 2 }}>
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="form-actions">
        <button type="button" className="btn-ghost" onClick={() => downloadText("timez-backup-codes.txt", codes.join("\n") + "\n")}>
          Download
        </button>
        <button type="button" className="btn-ghost" onClick={() => void navigator.clipboard?.writeText(codes.join("\n"))}>
          Copy
        </button>
        <button type="button" className="btn" onClick={onDone}>
          I've saved them
        </button>
      </div>
    </div>
  );
}

function MfaCard() {
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [setup, setSetup] = useState<MfaSetup | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    getMfaStatus().then(setStatus).catch((e) => setNote({ tone: "err", text: errText(e) }));
  }, []);
  useEffect(load, [load]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setNote({ tone: "err", text: errText(e) });
    } finally {
      setBusy(false);
    }
  }

  const begin = () =>
    run(async () => {
      setSetup(await startMfaSetup());
      setCode("");
    });

  const confirm = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const out = await enableMfa(code);
      setCodes(out.backup_codes);
      setSetup(null);
      setCode("");
      setNote({ tone: "ok", text: "Two-step sign-in is on." });
      load();
    });
  };

  const turnOff = () =>
    run(async () => {
      if (!password) throw new Error("Enter your password.");
      setStatus(await disableMfa(password));
      setPassword("");
      setNote({ tone: "ok", text: "Two-step sign-in is off." });
    });

  const newCodes = () =>
    run(async () => {
      if (!password) throw new Error("Enter your password.");
      const out = await renewBackupCodes(password);
      setCodes(out.backup_codes);
      setPassword("");
      load();
    });

  return (
    <Card title="Authenticator app">
      {status?.setup_required && (
        <p className="note warn">Your administrator requires two-step sign-in for your role. Set it up to keep using the portal.</p>
      )}
      {codes ? (
        <BackupCodes codes={codes} onDone={() => setCodes(null)} />
      ) : status === null ? (
        <p className="muted">Loading…</p>
      ) : status.enabled ? (
        <div className="stack">
          <p>
            <strong>On</strong> since {when(status.enabled_at)}. Backup codes left: {status.backup_codes_left}.
          </p>
          <Field label="Password (to turn off or get new backup codes)">
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </Field>
          <div className="form-actions">
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => void newCodes()}>
              New backup codes
            </button>
            <button type="button" className="btn-ghost" disabled={busy || status.required_by_policy} onClick={() => void turnOff()}>
              Turn off
            </button>
          </div>
          {status.required_by_policy && <p className="muted">Your role must use two-step sign-in.</p>}
        </div>
      ) : setup ? (
        <form className="stack" onSubmit={confirm}>
          <p>1. In your authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…), add an account with this setup key:</p>
          <p style={{ fontFamily: "monospace", fontSize: 18, letterSpacing: 1 }}>{groupKey(setup.secret)}</p>
          <p className="muted">
            Account: {setup.account_name} · Issuer: {setup.issuer} · Type: time-based
          </p>
          <details>
            <summary>Setup link</summary>
            <p className="muted" style={{ wordBreak: "break-all" }}>{setup.otpauth_uri}</p>
          </details>
          <Field label="2. Enter the 6-digit code it shows">
            <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={8} />
          </Field>
          <div className="form-actions">
            <button type="submit" className="btn" disabled={busy || code.trim().length < 6}>
              Turn on
            </button>
            <button type="button" className="btn-ghost" onClick={() => setSetup(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="stack">
          <p>
            <strong>Off.</strong> Add a code from your phone when you sign in, so a stolen password isn't enough.
          </p>
          <div className="form-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => void begin()}>
              Set up
            </button>
          </div>
        </div>
      )}
      <Banner message={note} />
    </Card>
  );
}

function DeviceTable({ rows, onEnd }: { rows: SignedInDevice[]; onEnd?: (row: SignedInDevice) => void }) {
  if (!rows.length) return <p className="muted">No signed-in devices.</p>;
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="data">
        <thead>
          <tr>
            <th>Device</th>
            <th>IP address</th>
            <th>Signed in</th>
            <th>Last used</th>
            {onEnd && <th />}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.session_id}>
              <td title={row.user_agent ?? ""}>
                {deviceLabel(row.user_agent)}
                {row.current && <strong> (this device)</strong>}
              </td>
              <td>{row.ip ?? "—"}</td>
              <td>{when(row.started_at)}</td>
              <td>{when(row.last_used_at)}</td>
              {onEnd && (
                <td>
                  {!row.current && (
                    <button type="button" className="btn-ghost btn-tiny" onClick={() => onEnd(row)}>
                      Sign out
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DevicesCard() {
  const [rows, setRows] = useState<SignedInDevice[]>([]);
  const [note, setNote] = useState<Note>(null);
  const load = useCallback(() => {
    listMySessions().then(setRows).catch((e) => setNote({ tone: "err", text: errText(e) }));
  }, []);
  useEffect(load, [load]);

  async function act(fn: () => Promise<{ revoked: number }>, done: string) {
    try {
      await fn();
      setNote({ tone: "ok", text: done });
    } catch (e) {
      setNote({ tone: "err", text: errText(e) });
    }
    load();
  }

  return (
    <Card
      title="Signed-in devices"
      action={
        rows.length > 1 ? (
          <button type="button" className="btn-ghost btn-tiny" onClick={() => void act(revokeOtherSessions, "Signed out of all other devices.")}>
            Sign out all other devices
          </button>
        ) : undefined
      }
    >
      <DeviceTable rows={rows} onEnd={(row) => void act(() => revokeSession(row.session_id), "That device is signed out.")} />
      <Banner message={note} />
    </Card>
  );
}

function AdminSecurityCard() {
  const [policy, setPolicy] = useState<boolean | null>(null);
  const [accounts, setAccounts] = useState<AdminAccountRow[]>([]);
  const [accountId, setAccountId] = useState("");
  const [rows, setRows] = useState<SignedInDevice[] | null>(null);
  const [note, setNote] = useState<Note>(null);

  useEffect(() => {
    getMfaPolicy().then((p) => setPolicy(p.require_mfa_admin_hr)).catch(() => setPolicy(null));
    listAccounts().then(setAccounts).catch(() => setAccounts([]));
  }, []);

  const loadSessions = useCallback((id: string) => {
    setRows(null);
    if (id) listAccountSessions(id).then(setRows).catch((e) => setNote({ tone: "err", text: errText(e) }));
  }, []);

  async function togglePolicy(on: boolean) {
    try {
      setPolicy((await setMfaPolicy(on)).require_mfa_admin_hr);
      setNote({ tone: "ok", text: on ? "Admins and HR must now use two-step sign-in." : "Two-step sign-in is optional for everyone." });
    } catch (e) {
      setNote({ tone: "err", text: errText(e) });
    }
  }

  async function endAll() {
    try {
      const out = await revokeAccountSessions(accountId);
      setNote({ tone: "ok", text: `Ended ${out.revoked} session${out.revoked === 1 ? "" : "s"}.` });
    } catch (e) {
      setNote({ tone: "err", text: errText(e) });
    }
    loadSessions(accountId);
  }

  return (
    <Card title="Administrator">
      <div className="stack">
        <label className="remember-row">
          <input type="checkbox" checked={Boolean(policy)} disabled={policy === null} onChange={(e) => void togglePolicy(e.target.checked)} />
          <span>Require two-step sign-in for administrators and HR</span>
        </label>
        <p className="muted">When on, admin and HR accounts without it are asked to set it up before they can use the portal.</p>
        <Field label="See or end an account's sessions">
          <select
            value={accountId}
            onChange={(e) => {
              setAccountId(e.target.value);
              loadSessions(e.target.value);
            }}
          >
            <option value="">Choose an account</option>
            {accounts.map((a) => (
              <option key={a.account_id} value={a.account_id}>
                {(a.full_name ?? a.email) + ` · ${a.role}`}
              </option>
            ))}
          </select>
        </Field>
        {accountId && rows && (
          <>
            <DeviceTable rows={rows} />
            <div className="form-actions">
              <button type="button" className="btn-ghost" disabled={!rows.length} onClick={() => void endAll()}>
                End all sessions
              </button>
            </div>
          </>
        )}
      </div>
      <Banner message={note} />
    </Card>
  );
}
