import { useSyncExternalStore } from "react";
import type { IndiaRegime } from "../countryPay.ts";

/** India tax regime chosen by each employee (new by default), kept in this browser. */
const KEY = (employeeId: string) => `hrms.taxRegime.${employeeId}`;
const listeners = new Set<() => void>();
let revision = 0;

export function getTaxRegime(employeeId: string): IndiaRegime {
  try {
    return localStorage.getItem(KEY(employeeId)) === "old" ? "old" : "new";
  } catch {
    return "new";
  }
}

export function setTaxRegime(employeeId: string, regime: IndiaRegime): void {
  try {
    localStorage.setItem(KEY(employeeId), regime);
  } catch {
    /* storage unavailable — choice lasts for this page only */
  }
  revision += 1;
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The person's regime; re-renders when it changes. */
export function useTaxRegime(employeeId: string): IndiaRegime {
  useSyncExternalStore(subscribe, () => revision);
  return getTaxRegime(employeeId);
}
