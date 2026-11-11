import { useEffect, useRef, type ReactNode } from "react";
import "../styles/workspace.css";

type FlashMessage = { tone: "ok" | "err" | "warn" | "info"; text: string } | null;

/**
 * A clear confirmation right where the person acted: a tick, the message and an optional next step.
 * Scrolls itself into view, and an ok message clears itself after a while.
 */
export function SuccessFlash({
  message,
  onDismiss,
  action,
  autoHideMs = 9000,
}: {
  message: FlashMessage;
  onDismiss?: () => void;
  action?: ReactNode;
  autoHideMs?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const text = message?.text ?? "";
  const tone = message?.tone ?? "ok";
  useEffect(() => {
    if (!text) return;
    ref.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    if (tone !== "ok" || !onDismiss || !autoHideMs) return;
    const timer = window.setTimeout(onDismiss, autoHideMs);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, tone]);
  if (!message || !text) return null;
  const ok = tone === "ok";
  return (
    <div ref={ref} className={`ws-flash ${tone}`} role={ok || tone === "info" ? "status" : "alert"} key={text}>
      <span className="ws-flash-icon" aria-hidden="true">
        {ok ? "✓" : tone === "info" ? "i" : "!"}
      </span>
      <span className="ws-flash-text">{text}</span>
      {action}
      {onDismiss && (
        <button type="button" className="ws-flash-close" aria-label="Dismiss" onClick={onDismiss}>
          ×
        </button>
      )}
    </div>
  );
}

/** Small inline tick shown next to something that was just saved. */
export function SavedTick({ label = "Saved" }: { label?: string }) {
  return (
    <span className="ws-saved" role="status">
      ✓ {label}
    </span>
  );
}
