import { useEffect, useState, type ReactNode } from "react";
import { isMasked, maskValue, type MaskKind } from "../utils/mask.ts";

/**
 * A sensitive personal detail, masked by default. With canReveal, a Show / Hide toggle shows the full value:
 * from onReveal when given (backend reveal, audited for HR / admin), else from value itself.
 * Managers and everyone else get the masked value only.
 */
export function MaskedValue({
  value,
  kind,
  canReveal = false,
  onReveal,
  format,
  empty = "—",
}: {
  value: string | null | undefined;
  kind: MaskKind;
  canReveal?: boolean;
  /** Returns the full value (e.g. from the API). Called each time Show is pressed. */
  onReveal?: () => Promise<string | null | undefined> | string | null | undefined;
  /** How to show the full value once revealed (e.g. a formatted date). */
  format?: (full: string) => ReactNode;
  empty?: ReactNode;
}) {
  const [shown, setShown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setShown(null);
    setError("");
  }, [value]);

  const raw = (value ?? "").trim();
  if (!raw) return <>{empty}</>;
  const masked = maskValue(raw, kind);
  const revealable = canReveal && (Boolean(onReveal) || !isMasked(raw));

  async function toggle() {
    if (shown !== null) {
      setShown(null);
      return;
    }
    setError("");
    if (!onReveal) {
      setShown(raw);
      return;
    }
    setBusy(true);
    try {
      const full = await onReveal();
      if (full) setShown(full);
      else setError("Not available");
    } catch {
      setError("Couldn't show");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="masked-value">
      <span>{shown !== null ? (format ? format(shown) : shown) : masked}</span>
      {revealable && (
        <button
          type="button"
          className="masked-toggle"
          onClick={() => void toggle()}
          disabled={busy}
          aria-pressed={shown !== null}
          title={shown !== null ? "Hide" : "Show"}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
            <circle cx="12" cy="12" r="3" />
            {shown !== null && <path d="M4 4l16 16" />}
          </svg>
          {busy ? "…" : shown !== null ? "Hide" : "Show"}
        </button>
      )}
      {error && <small className="muted">{error}</small>}
    </span>
  );
}
