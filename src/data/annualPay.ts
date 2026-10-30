import { useSyncExternalStore } from "react";
import { API_ENABLED, api, apiSessionAccount } from "../api/client.ts";
import type { CompHistoryOut } from "../api/syncRewards.ts";
import { payRulesFor } from "../countryPay.ts";
import { todayISO, type CountryCode } from "../model.ts";
import { getRewardState, parseAmount, subscribeReward } from "./rewardLocal.ts";

/**
 * The annual base pay on a person's current compensation record — the one figure Compensation shows and
 * payslips are worked out from (src/data/payslipGenerator.ts). Local mode: the browser's pay history.
 * Backend mode: the pay history already loaded by the Compensation page, else the signed-in person's own
 * record fetched once (GET /compensation/records). null when there's no record (payslips then use the
 * country's standard package for the role).
 */
export type AnnualBase = { amount: number; currency: string };

const fetched = new Map<string, AnnualBase | null>();
const pending = new Set<string>();
const listeners = new Set<() => void>();
let revision = 0;

function changed() {
  revision += 1;
  listeners.forEach((fn) => fn());
}

function fromHistory(employeeId: string, today: string): AnnualBase | null {
  const row = getRewardState()
    .history.filter((h) => h.employeeId === employeeId && h.effective <= today)
    .sort((a, b) => b.effective.localeCompare(a.effective))[0];
  const amount = row ? parseAmount(row.base) : Number.NaN;
  return row && Number.isFinite(amount) && amount > 0 ? { amount, currency: row.currency } : null;
}

export function annualBaseFor(employeeId: string, today: string = todayISO()): AnnualBase | null {
  const local = fromHistory(employeeId, today);
  if (local || !API_ENABLED) return local;
  if (fetched.has(employeeId)) return fetched.get(employeeId) ?? null;
  // Only your own record is fetched here (anyone may read their own pay).
  if (apiSessionAccount() === employeeId && !pending.has(employeeId)) {
    pending.add(employeeId);
    void api
      .get<CompHistoryOut | null>("/compensation/records")
      .then((out) => {
        const cur = out?.current;
        fetched.set(employeeId, cur && cur.base_salary > 0 ? { amount: cur.base_salary, currency: cur.currency } : null);
      })
      .catch(() => fetched.set(employeeId, null))
      .finally(() => {
        pending.delete(employeeId);
        changed();
      });
  }
  return null;
}

/** The payslip input's `annualBase`: the record's amount when it is in the country's pay currency. */
export function payslipAnnualBase(employeeId: string, countryCode: CountryCode | undefined): number | undefined {
  const comp = annualBaseFor(employeeId);
  return comp && comp.currency === payRulesFor(countryCode).currency ? comp.amount : undefined;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  const off = subscribeReward(fn);
  return () => {
    listeners.delete(fn);
    off();
  };
}

/** Re-renders when a pay record loads or changes. */
let seenHistory: unknown = null;
function snapshot(): number {
  const history = getRewardState().history;
  if (history !== seenHistory) {
    seenHistory = history;
    revision += 1;
  }
  return revision;
}

export function useAnnualPayRevision(): number {
  return useSyncExternalStore(subscribe, snapshot);
}
