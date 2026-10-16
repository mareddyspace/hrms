import { useMemo } from "react";
import { usePortal } from "../../store.tsx";
import type { PlusActor } from "./shared.ts";

/** The signed-in persona as an actor for the talent plus stores. */
export function useActor(): PlusActor {
  const { demoProfile } = usePortal();
  return useMemo(
    () => ({
      id: demoProfile.id,
      fullName: demoProfile.fullName,
      role: demoProfile.role,
      department: demoProfile.department,
      countryCode: demoProfile.countryCode,
    }),
    [demoProfile.id, demoProfile.fullName, demoProfile.role, demoProfile.department, demoProfile.countryCode],
  );
}
