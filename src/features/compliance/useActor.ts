import { useMemo } from "react";
import { usePortal } from "../../store.tsx";
import type { ComplianceActor } from "./shared.ts";

/** The signed-in persona as a compliance actor. */
export function useComplianceActor(): ComplianceActor & { countryCode?: string; countryName?: string } {
  const { demoProfile } = usePortal();
  return useMemo(
    () => ({
      id: demoProfile.id,
      fullName: demoProfile.fullName,
      role: demoProfile.role,
      email: demoProfile.email,
      countryCode: demoProfile.countryCode,
      countryName: demoProfile.countryName,
    }),
    [demoProfile],
  );
}
