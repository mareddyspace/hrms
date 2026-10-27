import { COUNTRY_PAY, claimLimitsFor, legalEntityFor, money, receiptThresholdFor } from "../countryPay.ts";
import { BENEFIT_PLANS } from "./rewardData.ts";
import { scheduleForEmployee } from "./workSchedule.ts";
import { NOTICE_POLICY, CONTRACTOR_NOTICE_DAYS, probationLabel } from "../features/lifecycle/lifecycleShared.ts";
import { DUE_WINDOW_DAYS, MAX_EXTENSIONS } from "../features/lifecycle/probationStore.ts";
import { TIMEZ_COUNTRIES, localPolicy, type CountryCode, type Holiday, type UserRole } from "../model.ts";
import { createSeed } from "../seed.ts";

/**
 * The policy library: every rule here is the rule the portal enforces. Country numbers are read from
 * the same sources the modules use (countryPay, workSchedule, rewardData, lifecycle) so the text can't drift.
 */

export const POLICY_CATEGORIES = [
  "Handbook",
  "Code of conduct",
  "Leave",
  "Holidays",
  "Working time & attendance",
  "Remote work",
  "Travel & expenses",
  "Benefits",
  "Pay & tax",
  "Learning",
  "Data privacy & security",
  "Exit",
] as const;
export type PolicyCategory = (typeof POLICY_CATEGORIES)[number];

/** Categories everyone must acknowledge. */
export const MANDATORY_CATEGORIES: PolicyCategory[] = ["Code of conduct", "Data privacy & security", "Leave", "Working time & attendance"];

export type PolicyOwner = "HR" | "IT";

/** Who a policy applies to. Empty / missing fields mean "everyone". */
export interface PolicyScope {
  countries?: CountryCode[];
  legalEntities?: string[];
  roles?: UserRole[];
  /** "employees" = everyone except contractors; "contractors" = contractors only. */
  employment?: "employees" | "contractors";
}

export interface PolicySection {
  heading: string;
  rules: string[];
}

export interface Policy {
  id: string;
  title: string;
  category: PolicyCategory;
  appliesTo: "all" | PolicyScope;
  version: string;
  effective: string;
  owner: PolicyOwner;
  mandatory: boolean;
  sections: PolicySection[];
}

/** The facts about a person that decide which policies apply to them. */
export interface PolicyAudience {
  countryCode: CountryCode;
  legalEntity?: string;
  role: UserRole;
  employmentType?: string;
}

export function isContractorType(employmentType: string | undefined): boolean {
  return /contract/i.test(employmentType ?? "");
}

export function policyAppliesTo(policy: Policy, who: PolicyAudience): boolean {
  if (policy.appliesTo === "all") return true;
  const scope = policy.appliesTo;
  if (scope.countries?.length && !scope.countries.includes(who.countryCode)) return false;
  if (scope.legalEntities?.length && !(who.legalEntity && scope.legalEntities.includes(who.legalEntity))) return false;
  if (scope.roles?.length && !scope.roles.includes(who.role)) return false;
  if (scope.employment === "contractors" && !isContractorType(who.employmentType)) return false;
  if (scope.employment === "employees" && isContractorType(who.employmentType)) return false;
  return true;
}

export function appliesToLabel(policy: Policy): string {
  if (policy.appliesTo === "all") return "Everyone";
  const scope = policy.appliesTo;
  const parts: string[] = [];
  if (scope.countries?.length) parts.push(scope.countries.map(countryName).join(", "));
  if (scope.roles?.length) parts.push(`Roles: ${scope.roles.map((r) => r.replace(/_/g, " ")).join(", ")}`);
  if (scope.employment === "contractors") parts.push("Contractors");
  if (scope.employment === "employees") parts.push("Employees (not contractors)");
  return parts.join(" · ") || "Everyone";
}

export function countryName(code: CountryCode): string {
  return TIMEZ_COUNTRIES.find((c) => c.code === code)?.name ?? code;
}

function currencyOf(code: CountryCode): string {
  return COUNTRY_PAY[code]?.currency ?? "INR";
}

/* ───────────── Leave entitlements (days per year, as the leave engine grants them) ───────────── */

export interface LeaveEntitlement {
  name: string;
  days: number;
  note?: string;
}

/** Read from the leave engine's own policies, so this page always matches what people are granted. */
const COUNTRY_LEAVE_CODES = ["pto", "casual", "sick"] as const;
export const LEAVE_ENTITLEMENTS: Record<CountryCode, LeaveEntitlement[]> = Object.fromEntries(
  TIMEZ_COUNTRIES.map((c) => [
    c.code,
    createSeed()
      .leavePolicies.filter((p) => (COUNTRY_LEAVE_CODES as readonly string[]).includes(p.code))
      .map((p) => localPolicy(p, c.code))
      .filter((p) => p.quota > 0)
      .map((p) => ({
        name: p.name,
        days: p.quota,
        note: [
          p.accrual === "monthly" ? "accrues monthly" : "",
          p.carryForwardMax ? `up to ${p.carryForwardMax} days carry over` : "",
          c.code === "GB" && p.code === "pto" ? "plus bank holidays" : "",
        ]
          .filter(Boolean)
          .join("; ") || undefined,
      })),
  ]),
) as Record<CountryCode, LeaveEntitlement[]>;

export const COMMON_LEAVE: LeaveEntitlement[] = [
  { name: "Work from home", days: 8 },
  { name: "Emergency work from home", days: 3 },
  { name: "Bereavement leave", days: 3 },
  { name: "Leave without pay", days: 12 },
];

export const COMP_OFF_VALID_DAYS = 90;
export const PAST_DATED_LIMIT_DAYS = 7;
export const PRIOR_PERMISSION_VALID_DAYS = 30;
export const MAX_TIMESHEET_HOURS = 9;
export const CLAIM_WINDOW_DAYS = 90;
export const IDLE_SIGN_OUT_MINUTES = 30;

const EFFECTIVE = "2026-04-01";

/* ───────────── Builders ───────────── */

export interface PolicyContext {
  countryCode: CountryCode;
  /** The holidays to list (a country's calendar, or one person's incl. optional picks). */
  holidays: Holiday[];
  shiftName?: string;
  shiftHours?: string;
}

const fmtDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", weekday: "short" });

const entitlementLine = (e: LeaveEntitlement) => `${e.name}: ${e.days} days a year${e.note ? ` (${e.note})` : ""}.`;

function globalPolicies(): Policy[] {
  return [
    {
      id: "handbook",
      title: "Employee handbook",
      category: "Handbook",
      appliesTo: "all",
      version: "1.0",
      effective: EFFECTIVE,
      owner: "HR",
      mandatory: false,
      sections: [
        {
          heading: "How things work here",
          rules: [
            "Your country, legal entity and role decide which policies apply to you. This page shows only those.",
            "Requests (leave, expenses, letters, exits) go to the person above you in the reporting line.",
            "If nobody is above you (the CEO), your time off is recorded without approval.",
            "Ask HR through the Helpdesk if a rule is unclear.",
          ],
        },
        {
          heading: "Where to find things",
          rules: [
            "Leave, holidays, timesheets and pay sit under Time & pay.",
            "Letters and your own documents sit under Documents & letters.",
            "Concerns can be raised in confidence under Raise a concern.",
          ],
        },
      ],
    },
    {
      id: "code-of-conduct",
      title: "Code of conduct",
      category: "Code of conduct",
      appliesTo: "all",
      version: "2.0",
      effective: EFFECTIVE,
      owner: "HR",
      mandatory: true,
      sections: [
        {
          heading: "Expected behaviour",
          rules: [
            "Treat colleagues with respect. Harassment and discrimination are not tolerated.",
            "Declare conflicts of interest to your manager and HR.",
            "Use company systems and data only for work.",
          ],
        },
        {
          heading: "Raising a concern",
          rules: [
            "Raise concerns under Me → Raise a concern. HR handles them in confidence.",
            "Retaliation against anyone who raises a concern in good faith is a conduct breach.",
          ],
        },
      ],
    },
    {
      id: "remote-work",
      title: "Remote work",
      category: "Remote work",
      appliesTo: "all",
      version: "1.0",
      effective: EFFECTIVE,
      owner: "HR",
      mandatory: false,
      sections: [
        {
          heading: "Allowance",
          rules: COMMON_LEAVE.filter((l) => /work from home/i.test(l.name)).map(entitlementLine),
        },
        {
          heading: "How to apply",
          rules: [
            "Apply under Leave & holidays, like any other leave type.",
            "Approval goes up your reporting line.",
            "Keep your usual working hours and stay reachable.",
          ],
        },
      ],
    },
    {
      id: "learning",
      title: "Learning",
      category: "Learning",
      appliesTo: "all",
      version: "1.0",
      effective: EFFECTIVE,
      owner: "HR",
      mandatory: false,
      sections: [
        {
          heading: "Programs",
          rules: [
            "Programs assigned to you appear under Learning.",
            "Progress is recorded module by module.",
            "Once a program is marked complete it can't be reopened.",
          ],
        },
      ],
    },
    {
      id: "data-privacy",
      title: "Data privacy & security",
      category: "Data privacy & security",
      appliesTo: "all",
      version: "1.0",
      effective: EFFECTIVE,
      owner: "IT",
      mandatory: true,
      sections: [
        {
          heading: "Who can see what",
          rules: [
            "Your personal data: you, HR, and people above you in your reporting line.",
            "Your pay and payslips: you and Compensation only.",
            "Managers do not see individual pay.",
          ],
        },
        {
          heading: "Account security",
          rules: [
            `You are signed out after ${IDLE_SIGN_OUT_MINUTES} minutes without activity.`,
            "Editing your own profile needs two-step verification.",
            "Never share your password or one-time codes.",
            "You can see and request your data under Me → Privacy.",
          ],
        },
      ],
    },
    {
      id: "manager-approvals",
      title: "Approving for your team",
      category: "Handbook",
      appliesTo: { roles: ["manager", "executive", "founder", "cofounder", "hr_admin", "hrbp"] },
      version: "1.0",
      effective: EFFECTIVE,
      owner: "HR",
      mandatory: false,
      sections: [
        {
          heading: "What you approve",
          rules: [
            "You decide requests from people below you in the reporting line, never your own.",
            `Sick leave can't be applied in advance; past-dated leave older than ${PAST_DATED_LIMIT_DAYS} days needs your prior permission (valid ${PRIOR_PERMISSION_VALID_DAYS} days).`,
            `Timesheets above ${MAX_TIMESHEET_HOURS} hours a day are refused.`,
            "Pay stays restricted: you don't see your team's salaries.",
          ],
        },
      ],
    },
    {
      id: "hr-procedures",
      title: "HR procedures",
      category: "Handbook",
      appliesTo: { roles: ["hr", "hr_admin", "hrbp"] },
      version: "1.0",
      effective: EFFECTIVE,
      owner: "HR",
      mandatory: false,
      sections: [
        {
          heading: "Probation",
          rules: [
            `Reviews come due ${DUE_WINDOW_DAYS} days before probation ends.`,
            `Probation can be extended at most ${MAX_EXTENSIONS} times, 1 to 3 months each.`,
            "HR finalises the manager's recommendation.",
          ],
        },
        {
          heading: "Notice periods",
          rules: [
            ...NOTICE_POLICY.map((n) => `${n.country}: ${n.days} days (${n.basis}).`),
            `Contractors: ${CONTRACTOR_NOTICE_DAYS} days.`,
          ],
        },
      ],
    },
    {
      id: "contractor-terms",
      title: "Contractor terms",
      category: "Handbook",
      appliesTo: { employment: "contractors" },
      version: "1.0",
      effective: EFFECTIVE,
      owner: "HR",
      mandatory: false,
      sections: [
        {
          heading: "Key terms",
          rules: [
            `Notice to end the engagement: ${CONTRACTOR_NOTICE_DAYS} days.`,
            "Employee benefit plans don't apply to contractors.",
          ],
        },
      ],
    },
  ];
}

export function leavePolicy(code: CountryCode): Policy {
  return {
    id: `leave-${code}`,
    title: `Leave policy — ${countryName(code)}`,
    category: "Leave",
    appliesTo: { countries: [code] },
    version: "2026.1",
    effective: EFFECTIVE,
    owner: "HR",
    mandatory: true,
    sections: [
      { heading: "Your yearly entitlement", rules: LEAVE_ENTITLEMENTS[code].map(entitlementLine) },
      {
        heading: "Everyone also gets",
        rules: [
          ...COMMON_LEAVE.map(entitlementLine),
          `Comp-off: earned only by working on a weekly off or holiday; use it within ${COMP_OFF_VALID_DAYS} days.`,
        ],
      },
      {
        heading: "Applying",
        rules: [
          "Sick leave can't be applied in advance.",
          `Past-dated leave older than ${PAST_DATED_LIMIT_DAYS} days needs prior permission from your manager (valid ${PRIOR_PERMISSION_VALID_DAYS} days).`,
          "Approval goes up your reporting line. The CEO's time off is recorded with no approval.",
        ],
      },
      {
        heading: "Encashment",
        rules:
          code === "IN"
            ? ["Only privilege leave can be encashed, up to your available balance."]
            : ["Only privilege leave (India) can be encashed. Leave in this country can't be encashed."],
      },
    ],
  };
}

export function holidayPolicy(ctx: PolicyContext): Policy {
  const { countryCode: code } = ctx;
  return {
    id: `holidays-${code}`,
    title: `Holiday calendar — ${countryName(code)}`,
    category: "Holidays",
    appliesTo: { countries: [code] },
    version: "2026.1",
    effective: "2026-01-01",
    owner: "HR",
    mandatory: false,
    sections: [
      {
        heading: "Holidays",
        rules: ctx.holidays.length ? ctx.holidays.map((h) => `${fmtDate(h.date)} — ${h.name}`) : ["No holidays published yet."],
      },
      {
        heading: "Rules",
        rules: [
          "Holidays don't count against your leave balance.",
          `Working on a holiday earns a comp-off, valid ${COMP_OFF_VALID_DAYS} days.`,
        ],
      },
    ],
  };
}

export function workingTimePolicy(ctx: PolicyContext): Policy {
  const code = ctx.countryCode;
  const schedule = scheduleForEmployee({ countryCode: code, shiftName: ctx.shiftName, shiftHours: ctx.shiftHours });
  const overtime = COUNTRY_PAY[code]?.overtime;
  return {
    id: `working-time-${code}`,
    title: `Working time & attendance — ${countryName(code)}`,
    category: "Working time & attendance",
    appliesTo: { countries: [code] },
    version: "2026.1",
    effective: EFFECTIVE,
    owner: "HR",
    mandatory: true,
    sections: [
      {
        heading: "Your week",
        rules: [
          `Work days: ${schedule.workDaysLabel}.`,
          `Weekly off: ${schedule.weeklyOffLabels.join(" and ") || "none"}.`,
          `Shift: ${schedule.shiftName}, ${schedule.hoursLabel}.`,
          ...(schedule.note ? [schedule.note] : []),
        ],
      },
      {
        heading: "Timesheets",
        rules: [
          `Log at most ${MAX_TIMESHEET_HOURS} hours a day.`,
          "Timesheets are approved up your reporting line.",
          ...(overtime ? [`Hourly staff earn overtime above ${overtime.weeklyHours} hours a week at ${overtime.factor}×.`] : []),
        ],
      },
    ],
  };
}

export function expensePolicy(code: CountryCode): Policy {
  const currency = currencyOf(code);
  const limits = claimLimitsFor(code);
  return {
    id: `travel-expenses-${code}`,
    title: `Travel & expenses — ${countryName(code)}`,
    category: "Travel & expenses",
    appliesTo: { countries: [code] },
    version: "2026.1",
    effective: EFFECTIVE,
    owner: "HR",
    mandatory: false,
    sections: [
      {
        heading: "Claims",
        rules: [
          `Claim within ${CLAIM_WINDOW_DAYS} days of spending.`,
          `Attach a receipt for anything above ${money(receiptThresholdFor(code), currency)}.`,
          `Largest single claim: ${money(limits.maxClaim, currency)}.`,
          "Claims are approved up your reporting line.",
        ],
      },
      {
        heading: "Cash advance",
        rules: [`Up to ${money(limits.maxCashAdvance, currency)} per advance.`, "Settle the advance with receipts after the trip."],
      },
    ],
  };
}

export function benefitsPolicy(code: CountryCode): Policy {
  const name = countryName(code);
  const plans = BENEFIT_PLANS.filter((p) => p.country === name);
  return {
    id: `benefits-${code}`,
    title: `Benefits — ${name}`,
    category: "Benefits",
    appliesTo: { countries: [code], employment: "employees" },
    version: "2026.1",
    effective: EFFECTIVE,
    owner: "HR",
    mandatory: false,
    sections: [
      {
        heading: "Plans",
        rules: plans.length
          ? plans.map(
              (p) =>
                `${p.name} (${p.category}) — ${p.summary}. Cost: ${p.employeeCost}.${p.mandatory ? " Compulsory." : ""}${p.autoEnrolled ? " Auto-enrolled." : ""}`,
            )
          : ["No benefit plans are published for this country yet. Ask HR."],
      },
      { heading: "Changes", rules: ["Request enrolment changes under Benefits.", "Compulsory plans can't be waived."] },
    ],
  };
}

export function payTaxPolicy(code: CountryCode): Policy {
  const rules = COUNTRY_PAY[code];
  const start = new Date(2026, rules.taxYearStart.month - 1, rules.taxYearStart.day).toLocaleDateString("en-GB", { day: "numeric", month: "long" });
  return {
    id: `pay-tax-${code}`,
    title: `Pay & tax — ${countryName(code)}`,
    category: "Pay & tax",
    appliesTo: { countries: [code] },
    version: "2026.1",
    effective: EFFECTIVE,
    owner: "HR",
    mandatory: false,
    sections: [
      {
        heading: "Pay",
        rules: [
          `Paid in ${rules.currency} by ${legalEntityFor(code)}.`,
          rules.incomeTaxName ? `Income tax on your payslip: ${rules.incomeTaxName}.` : "No personal income tax is deducted.",
          `Tax year starts ${start}.`,
          "Only you and Compensation can see your payslips.",
        ],
      },
      {
        heading: "Tax declarations",
        rules: rules.declarations.length
          ? [
              ...rules.declarations.map((d) => `${d.label}${d.cap != null ? ` — up to ${money(d.cap, rules.currency)} a year` : ""}.`),
              rules.declarationNote,
            ]
          : [rules.declarationNote || "There are no tax declarations in this country."],
      },
    ],
  };
}

export function exitPolicy(code: CountryCode): Policy {
  const notice = NOTICE_POLICY.find((n) => n.code === code);
  return {
    id: `exit-${code}`,
    title: `Resignation & exit — ${countryName(code)}`,
    category: "Exit",
    appliesTo: { countries: [code] },
    version: "2026.1",
    effective: EFFECTIVE,
    owner: "HR",
    mandatory: false,
    sections: [
      {
        heading: "Notice and probation",
        rules: [
          `Notice period: ${notice?.days ?? 30} days${notice ? ` (${notice.basis})` : ""}.`,
          `Contractors: ${CONTRACTOR_NOTICE_DAYS} days.`,
          `Probation: ${probationLabel(code)}.`,
        ],
      },
      {
        heading: "How to resign",
        rules: [
          "Resign under Me → Resignation. Your last day is set from your notice period.",
          "An earlier last day needs your manager's agreement.",
          "Return company assets before your last day.",
        ],
      },
    ],
  };
}

/** All policies for one country (global + country-specific). */
export function countryPolicies(ctx: PolicyContext): Policy[] {
  const code = ctx.countryCode;
  return [
    leavePolicy(code),
    holidayPolicy(ctx),
    workingTimePolicy(ctx),
    expensePolicy(code),
    benefitsPolicy(code),
    payTaxPolicy(code),
    exitPolicy(code),
  ];
}

/** Every policy in the library, across all countries. `holidaysFor` gives each country's calendar. */
export function policyCatalog(holidaysFor: (code: CountryCode) => Holiday[]): Policy[] {
  return [
    ...globalPolicies(),
    ...TIMEZ_COUNTRIES.flatMap((c) => countryPolicies({ countryCode: c.code, holidays: holidaysFor(c.code) })),
  ];
}

/** The policies that apply to one person, with their own holidays and shift filled in. */
export function policiesForPerson(who: PolicyAudience, ctx: Omit<PolicyContext, "countryCode">): Policy[] {
  const all = [...globalPolicies(), ...countryPolicies({ ...ctx, countryCode: who.countryCode })];
  return all.filter((p) => policyAppliesTo(p, who));
}

/** Policy ids applicable to someone (text-independent, for acknowledgement tracking). */
export function policyIdsFor(who: PolicyAudience): string[] {
  return policiesForPerson(who, { holidays: [] }).map((p) => p.id);
}

export function legalEntityLabel(code: CountryCode, legalEntity?: string): string {
  return legalEntity || legalEntityFor(code);
}
