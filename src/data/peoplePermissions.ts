/**
 * People / compensation permission helpers.
 * Delegates to `rbac.ts` — keep imports stable for existing modules.
 */
import type { DemoAccount, NavAccessId } from "../demoAccounts.ts";
import type { UserRole } from "../model.ts";
import {
  canApproveCompReviews as rbacCanApproveCompReviews,
  canManageLetters as rbacCanManageLetters,
  canManagePeopleRecords,
  canViewColleagueBasicProfile,
  canViewCompStructures as rbacCanViewCompStructures,
  canViewFullHrRecord,
  canViewPayslip,
  canViewSensitivePii as rbacCanViewSensitivePii,
  displayMoney,
  formatCompAmount,
  getPeopleListScope,
  getProfileDepth,
  getSalaryVisibility,
  hasModuleAccess,
  type SubjectContext,
  type Visibility,
} from "./rbac.ts";

export type CompAmountVisibility = Visibility;

export {
  displayMoney,
  formatCompAmount,
  getPeopleListScope,
  getProfileDepth,
  getSalaryVisibility,
  hasModuleAccess,
  canViewPayslip,
  canViewColleagueBasicProfile,
  canViewFullHrRecord,
};

export function canManagePeople(role: UserRole): boolean {
  return (
    role === "hr_admin" ||
    role === "hr" ||
    role === "hrbp" ||
    role === "super_admin"
  );
}

export function canManagePeopleAccount(account: DemoAccount): boolean {
  return canManagePeopleRecords(account);
}

export function canViewPeopleDirectory(account: DemoAccount): boolean {
  const scope = getPeopleListScope(account);
  return scope === "team" || scope === "org" || scope === "global";
}

export function canViewCompensation(
  viewer: DemoAccount,
  subjectId: string,
  opts?: { selfId?: string; isDirectReport?: boolean },
): Visibility {
  return getSalaryVisibility(viewer, {
    subjectId,
    selfId: opts?.selfId ?? viewer.id,
    isDirectReport: opts?.isDirectReport,
  });
}

export function canViewSensitivePii(viewer: DemoAccount, isSelf: boolean): boolean {
  return rbacCanViewSensitivePii(viewer, {
    subjectId: isSelf ? viewer.id : "other",
    selfId: viewer.id,
    isDirectReport: false,
  });
}

export function canViewSensitivePiiFor(viewer: DemoAccount, ctx: SubjectContext): boolean {
  return rbacCanViewSensitivePii(viewer, ctx);
}

export function canViewSalaryAmount(
  viewer: DemoAccount,
  subjectId: string,
  opts?: { selfId?: string; isDirectReport?: boolean },
): Visibility {
  return getSalaryVisibility(viewer, {
    subjectId,
    selfId: opts?.selfId ?? viewer.id,
    isDirectReport: opts?.isDirectReport,
  });
}

export function canViewCompStructures(viewer: DemoAccount): boolean {
  return rbacCanViewCompStructures(viewer);
}

export function canApproveCompReviews(viewer: DemoAccount): boolean {
  return rbacCanApproveCompReviews(viewer);
}

export function canManageLetters(viewer: DemoAccount): boolean {
  return rbacCanManageLetters(viewer);
}

export interface CompensationAccess {
  module: boolean;
  structures: boolean;
  ranges: CompAmountVisibility;
  ownAmounts: CompAmountVisibility;
  othersAmounts: CompAmountVisibility;
  peopleScope: "self" | "team" | "org" | "global" | "none";
  canApprove: boolean;
  canConfigure: boolean;
}

export function getCompensationAccess(viewer: DemoAccount): CompensationAccess {
  const role = viewer.role;
  const own = getSalaryVisibility(viewer, { subjectId: viewer.id, selfId: viewer.id });
  const otherSample = getSalaryVisibility(viewer, {
    subjectId: "other-employee",
    selfId: viewer.id,
    isDirectReport: true,
  });

  if (role === "compensation_admin" || role === "finance") {
    return {
      module: true,
      structures: true,
      ranges: "full",
      ownAmounts: "full",
      othersAmounts: "full",
      peopleScope: "global",
      canApprove: role === "compensation_admin",
      canConfigure: role === "compensation_admin",
    };
  }

  if (role === "hr_admin" || role === "hr" || role === "hrbp") {
    return {
      module: true,
      structures: true,
      ranges: "full",
      ownAmounts: own,
      othersAmounts: otherSample,
      peopleScope: "global",
      canApprove: canApproveCompReviews(viewer),
      canConfigure: role === "hr_admin",
    };
  }

  if (role === "manager" || role === "hiring_manager") {
    return {
      module: hasModuleAccess(viewer, "compensation"),
      structures: true,
      ranges: "masked",
      ownAmounts: "full",
      othersAmounts: "hidden", // no individual salaries by default
      peopleScope: "team",
      canApprove: false,
      canConfigure: false,
    };
  }

  if (role === "executive" || role === "founder" || role === "cofounder") {
    const authorized = otherSample !== "hidden";
    return {
      module: authorized || hasModuleAccess(viewer, "compensation"),
      structures: true,
      ranges: authorized ? "masked" : "hidden",
      ownAmounts: "full",
      othersAmounts: authorized ? "full" : "hidden",
      peopleScope: "none",
      canApprove: false,
      canConfigure: false,
    };
  }

  if (role === "admin" || role === "it_admin" || role === "super_admin" || role === "compliance") {
    return {
      module: false,
      structures: false,
      ranges: "hidden",
      ownAmounts: "full",
      othersAmounts: "hidden",
      peopleScope: "none",
      canApprove: false,
      canConfigure: false,
    };
  }

  // Employee / recruiter default — own pay only
  return {
    module: false,
    structures: false,
    ranges: "hidden",
    ownAmounts: "full",
    othersAmounts: "hidden",
    peopleScope: "self",
    canApprove: false,
    canConfigure: false,
  };
}

export type { NavAccessId };
