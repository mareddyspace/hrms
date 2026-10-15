import { RoleHomeRouter } from "./dashboards/RoleHomes.tsx";
import { usePortal } from "../store.tsx";

export function Dashboard() {
  const { demoProfile } = usePortal();
  return <RoleHomeRouter profile={demoProfile} />;
}
