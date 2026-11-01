import { useEffect, useState, useSyncExternalStore } from "react";
import { RoleHomeRouter } from "./dashboards/RoleHomes.tsx";
import { PolicyAckBanner } from "../components/PolicyAckBanner.tsx";
import { LoadingState } from "../components/ui.tsx";
import { API_ENABLED } from "../api/client.ts";
import { subscribePeople, usingApiPeople } from "../data/peopleLocal.ts";
import { usePortal } from "../store.tsx";

export function Dashboard() {
  const { demoProfile, employee } = usePortal();
  // Backend mode: wait for the server's directory instead of showing the local sample numbers for a moment.
  const loaded = useSyncExternalStore(subscribePeople, () => !API_ENABLED || usingApiPeople());
  // Let the home render quickly from its existing role-scoped fallback while the server wakes.
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    if (loaded) return;
    const timer = window.setTimeout(() => setWaited(true), 2000);
    return () => window.clearTimeout(timer);
  }, [loaded]);
  const ready = loaded || waited;
  return (
    <>
      <PolicyAckBanner employeeId={employee.id} />
      {!loaded && waited && <p className="note" role="status">Your home is ready. Syncing the latest company data…</p>}
      {ready ? <RoleHomeRouter profile={demoProfile} /> : <LoadingState label="Loading your home…" />}
    </>
  );
}
