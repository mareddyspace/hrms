import { useEffect } from "react";
import { runDueSyncs } from "./platformLocal.ts";

/** While an admin is signed in, connectors run on their schedule (checked every minute). */
export function useScheduledSyncs(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    runDueSyncs();
    const timer = window.setInterval(() => runDueSyncs(), 60_000);
    return () => window.clearInterval(timer);
  }, [enabled]);
}
