import type { DemoAccount } from "../demoAccounts.ts";
import { isAbove } from "./peopleLocal.ts";
import { canViewSensitivePiiFor } from "./peoplePermissions.ts";

/** What one viewer may see on another person's profile / Employee 360. */
export interface ProfileAccess {
  isSelf: boolean;
  isHr: boolean;
  /** The viewer sits above the person in the reporting line. */
  aboveInLine: boolean;
  /** Personal details: self, HR, anyone above in the reporting line. */
  personal: boolean;
  /** Attendance, leave, timesheets, goals, performance, learning, skills, career, lifecycle: self, line, HR. */
  work: boolean;
  /** Compensation history and pay: the person and HR (compensation & benefits sit with HR). */
  compensation: boolean;
  /** Benefit enrolments and covered dependents: the person and HR. */
  benefits: boolean;
  /** Documents on file: the person and HR. */
  documents: boolean;
  /** Ratings before HR releases them (the person sees only released ratings). */
  unreleasedRatings: boolean;
}

const HR_ROLES = new Set(["hr", "hr_admin", "hrbp"]);

export function profileAccessFor(viewer: DemoAccount, personId: string, selfId: string): ProfileAccess {
  const isSelf = personId === selfId;
  const isHr = HR_ROLES.has(viewer.role);
  const aboveInLine = !isSelf && isAbove(selfId, personId);
  const personal =
    isSelf ||
    aboveInLine ||
    canViewSensitivePiiFor(viewer, { subjectId: personId, selfId, isDirectReport: aboveInLine, inHrScope: true });
  const work = isSelf || isHr || aboveInLine;
  return {
    isSelf,
    isHr,
    aboveInLine,
    personal,
    work,
    compensation: isSelf || (isHr && viewer.rbacFlags?.hrCompAuthorized !== false),
    benefits: isSelf || isHr,
    documents: isSelf || isHr,
    unreleasedRatings: !isSelf && (isHr || aboveInLine),
  };
}

/** True when the viewer may open the full record at all. */
export function canOpenFullRecord(access: ProfileAccess): boolean {
  return access.personal || access.work || access.compensation || access.benefits;
}
