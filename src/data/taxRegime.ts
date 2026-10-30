import { useSyncExternalStore } from "react";
import { API_ENABLED, api } from "../api/client.ts";
import type { IndiaRegime } from "../countryPay.ts";
import { getPerson } from "./peopleLocal.ts";

/**
 * India tax regime chosen by each employee (new by default). Local mode: kept in this browser.
 * Backend mode: saved on the employee record (POST /payroll/me/tax-regime), so HR's pay preview and the
 * final settlement use the same choice; the browser copy is only a cache of this user's own choice.
 */
const KEY = (employeeId: string) => `hrms.taxRegime.${employeeId}`;
const listeners = new Set<() => void>();
let revision = 0;
/** Choices saved to the server in this session (newer than the loaded directory). */
const saved = new Map<string, IndiaRegime>();

function localRegime(employeeId: string): IndiaRegime | null {
  try {
    const value = localStorage.getItem(KEY(employeeId));
    return value === "old" || value === "new" ? value : null;
  } catch {
    return null;
  }
}

export function getTaxRegime(employeeId: string): IndiaRegime {
  if (API_ENABLED) {
    return saved.get(employeeId) ?? getPerson(employeeId)?.taxRegime ?? localRegime(employeeId) ?? "new";
  }
  return saved.get(employeeId) ?? localRegime(employeeId) ?? "new";
}

function changed() {
  revision += 1;
  listeners.forEach((fn) => fn());
}

/** Saves the choice; returns an error message or null. */
export async function setTaxRegime(employeeId: string, regime: IndiaRegime): Promise<string | null> {
  if (API_ENABLED) {
    try {
      await api.post("/payroll/me/tax-regime", { regime });
      saved.set(employeeId, regime);
    } catch (error) {
      return error instanceof Error ? error.message : "Could not save the tax regime.";
    }
  }
  try {
    localStorage.setItem(KEY(employeeId), regime);
  } catch {
    /* storage unavailable — choice lasts for this page only */
    saved.set(employeeId, regime);
  }
  changed();
  return null;
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
