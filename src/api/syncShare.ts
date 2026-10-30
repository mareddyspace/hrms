/**
 * Keeps a shared-module mirror (chat, mail, tasks, announcements, calendar) fresh while someone is signed in:
 * reloads when the tab regains focus and on a timer. Backend mode only.
 */
import { API_ENABLED, onApiSession } from "./client.ts";

export function keepFresh(reload: () => Promise<void>, everyMs: number): void {
  if (!API_ENABLED) return;
  let timer: number | undefined;
  let signedIn = false;
  const onFocus = () => {
    if (signedIn && document.visibilityState === "visible") void reload();
  };
  queueMicrotask(() => {
    onApiSession((account) => {
      signedIn = !!account;
      window.clearInterval(timer);
      timer = account ? window.setInterval(() => document.visibilityState === "visible" && void reload(), everyMs) : undefined;
    });
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
  });
}
