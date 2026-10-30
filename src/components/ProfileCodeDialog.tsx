import { useEffect, useRef, useState, type ReactNode } from "react";
import { API_ENABLED } from "../api/client.ts";
import { apiRequestProfileOtp, type ApiSelfProfileUpdate, type ProfileCodeSent } from "../api/syncProfile.ts";
import { checkLocalProfileCode, sendLocalProfileCode } from "../data/profileOtpLocal.ts";
import { ActionButton, Banner, Dialog, Field, useAction } from "./ui.tsx";

/** One save of your own personal details that may need a code. */
export interface ProfileCodeRequest {
  userId: string;
  /** Backend mode: the PATCH /people/me body (the server decides whether a code is needed). */
  apiChanges: ApiSelfProfileUpdate;
  /** Local mode: only the personal-detail fields that changed; empty = no code needed. */
  localChanges: Record<string, unknown>;
  /** Saves the change; code is null when none was needed. Returns null when saved, else the reason. */
  save: (code: string | null) => Promise<string | null> | string | null;
  onSaved?: () => void;
}

interface Open {
  req: ProfileCodeRequest;
  sent: ProfileCodeSent;
  sentAt: number;
}

const send = (req: ProfileCodeRequest) => (API_ENABLED ? apiRequestProfileOtp(req.apiChanges) : sendLocalProfileCode(req.userId, req.localChanges));

const isLock = (text: string) => text.startsWith("Too many wrong codes");

function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Save flow for your own personal details: start() asks for a code and, when one is needed, opens a dialog to
 * enter it (the code is in your TimeZ inbox). Returns the dialog to render.
 */
export function useProfileCode(): { start: (req: ProfileCodeRequest) => Promise<boolean | string>; dialog: ReactNode } {
  const [open, setOpen] = useState<Open | null>(null);

  async function start(req: ProfileCodeRequest): Promise<boolean | string> {
    const sent = await send(req);
    if (sent.error) return sent.error;
    if (!sent.required) {
      const failed = await req.save(null);
      if (failed) return failed;
      req.onSaved?.();
      return true;
    }
    setOpen({ req, sent, sentAt: Date.now() });
    return false;
  }

  const dialog = open ? <CodeDialog key={open.sentAt} open={open} setOpen={setOpen} /> : null;
  return { start, dialog };
}

function CodeDialog({ open, setOpen }: { open: Open; setOpen: (next: Open | null) => void }) {
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [locked, setLocked] = useState(false);
  const [now, setNow] = useState(Date.now());
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState(open);
  const verifyAction = useAction();

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    input.current?.focus();
    return () => window.clearInterval(timer);
  }, []);

  const { req, sent, sentAt } = state;
  const expiresIn = (sent.expiresAt ?? sentAt + 600_000) - now;
  const resendIn = sentAt + (sent.resendAfter ?? 30) * 1000 - now;
  const expired = expiresIn <= 0;
  const href = sent.inboxHref ?? "/mail";
  const inboxName = href.startsWith("/mail") ? "Mail" : "Notifications";

  async function verify(): Promise<boolean> {
    if (!/^\d{6}$/.test(code)) {
      setMessage({ tone: "err", text: "Enter the 6-digit code." });
      return false;
    }
    let failed: string | null;
    if (!API_ENABLED) {
      failed = await checkLocalProfileCode(req.userId, req.localChanges, code);
      if (!failed) failed = await req.save(null);
    } else {
      failed = await req.save(code);
    }
    if (failed) {
      setMessage({ tone: "err", text: failed });
      if (isLock(failed)) setLocked(true);
      return false;
    }
    setOpen(null);
    req.onSaved?.();
    return true;
  }

  async function resend(): Promise<boolean> {
    const next = await send(req);
    if (next.error) {
      setMessage({ tone: "err", text: next.error });
      if (isLock(next.error)) setLocked(true);
      return false;
    }
    setState({ req, sent: next, sentAt: Date.now() });
    setCode("");
    setLocked(false);
    setMessage({ tone: "ok", text: "New code sent." });
    input.current?.focus();
    return true;
  }

  return (
    <Dialog
      open
      title="Verify it's you"
      onClose={() => setOpen(null)}
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={() => setOpen(null)}>
            Cancel
          </button>
          <ActionButton className="btn-ghost" onAction={resend} disabled={resendIn > 0} busyLabel="Sending…" doneLabel="Sent">
            {resendIn > 0 ? `Resend in ${Math.ceil(resendIn / 1000)}s` : "Resend code"}
          </ActionButton>
          <ActionButton
            className="btn"
            onAction={verify}
            action={verifyAction}
            success="Profile saved."
            disabled={locked || expired || code.length !== 6}
            busyLabel="Verifying…"
            doneLabel="Verified"
          >
            Verify
          </ActionButton>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={verifyAction.submit(() => (locked || expired ? false : verify()), { success: "Profile saved." })}
      >
        <p>
          We sent a code to your TimeZ inbox.{" "}
          <a href={href} target="_blank" rel="opener">
            Open {inboxName}
          </a>
        </p>
        <Field label="Code">
          <input
            ref={input}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="6 digits"
            maxLength={6}
            disabled={locked}
            aria-label="Verification code"
          />
        </Field>
        <p className={`note${expired ? " err" : ""}`}>{expired ? "Code expired. Send a new one." : `Expires in ${mmss(expiresIn)}`}</p>
        {sent.devCode && <p className="note">Code: <strong>{sent.devCode}</strong></p>}
        <Banner message={message} />
      </form>
    </Dialog>
  );
}
