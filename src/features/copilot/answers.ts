/**
 * Copilot's rule-based answers. Every number, name and date comes from the CopilotContext the page
 * builds (the viewer's own data, their reporting line, or company-wide figures only when allowed).
 * When the data isn't there, it says so in one line and links the right page — it never guesses.
 */
import { enabledPolicyIds } from "../../data/aiSettings.ts";
import { COMPANY_NAME, PRODUCT_NAME, PRODUCT_TAGLINE } from "../../brand.ts";
import type { CopilotAnswer, CopilotContext } from "../../data/platformData.ts";
import type { NavAccessId } from "../../demoAccounts.ts";
import { hasWord, monthIn, normalizeQuestion } from "./normalize.ts";
import { leaveSources, policyLibraryAnswer } from "./policyAnswers.ts";

export type RawCopilotAnswer = CopilotAnswer & { requires?: NavAccessId };

const POLICY_WORDS = ["policy", "policies", "handbook", "acknowledge", "acknowledgement", "procedure", "procedures", "code of conduct", "contractor terms", "notice period", "probation"];

export const NO_DECISIONS = "I can't approve or reject anything — decisions are made in Approvals. Changes I prepare only happen after you confirm.";

const SUMMARY_INTENT =
  /^(?:please |pls |can you |could you )?(?:summari[sz]e|give me (?:a )?summary of|summary of|summary for|tell me about|employee 360 (?:for|of)|ai employee 360 (?:for|of)|360 (?:view )?(?:for|of)|profile of)\s+(.+)$/;

/** The name asked about in "summarise <name>" style questions, or null. */
export function summaryTarget(question: string): string | null {
  const q = question.toLowerCase().replace(/[?!.,'"]/g, " ").replace(/\s+/g, " ").trim();
  const match = q.match(SUMMARY_INTENT);
  const name = match?.[1]?.replace(/^(?:of|for|about)\s+/, "").replace(/\s+(?:please|profile|record)$/, "").trim();
  if (!name || name.length < 2 || /^(?:my|me|our|the|this|these|all|team|leave|approvals?|you|yourself|it|company|policy|holidays?)\b/.test(name)) return null;
  return name;
}

/* —— formatting —— */

function fmtDate(iso: string, weekday = false): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, (m ?? 1) - 1, d ?? 1);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-GB", { ...(weekday ? { weekday: "short" } : {}), day: "2-digit", month: "short", year: "numeric" });
}

function range(from: string, to: string): string {
  return from === to ? fmtDate(from) : `${fmtDate(from)} – ${fmtDate(to)}`;
}

function days(n: number): string {
  return `${n} day${n === 1 ? "" : "s"}`;
}

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${currency} ${Math.round(amount)}`;
  }
}

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d + n);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function mondayOf(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  return addDays(iso, dow === 0 ? -6 : 1 - dow);
}

function todayOf(ctx: CopilotContext): string {
  if (ctx.today) return ctx.today;
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/* —— vocabulary —— */

const LEAVE = ["leave", "leaves", "pto", "absence", "absences", "wfh", "comp off", "sick", "casual", "bereavement", "unpaid"];
const APPROVAL = ["approval", "approvals", "approve", "approving", "approver"];

/** Leave type the question names, by policy code. */
function leaveCodeIn(q: string): string | null {
  if (hasWord(q, ["emergency wfh", "emergency"])) return "emergency_wfh";
  if (hasWord(q, ["sick", "medical leave", "illness"])) return "sick";
  if (hasWord(q, ["casual", "cl"])) return "casual";
  if (hasWord(q, ["pto", "pl", "el"])) return "pto";
  if (hasWord(q, ["wfh"])) return "wfh";
  if (hasWord(q, ["comp off"])) return "comp_off";
  if (hasWord(q, ["bereavement"])) return "bereavement";
  if (hasWord(q, ["unpaid"])) return "unpaid";
  return null;
}

/* —— individual answers —— */

function personSummaryAnswer(target: string, ctx: CopilotContext, quietIfMissing = false): RawCopilotAnswer | null {
  if (!ctx.summarisePerson) {
    return { kind: "text", summary: "Open the full Copilot page to get a colleague summary.", links: [{ label: "AI Copilot", to: "/ai/copilot" }] };
  }
  const found = ctx.summarisePerson(target);
  if (found.status === "denied") {
    return {
      kind: "text",
      denied: true,
      summary: "I can only summarise you or people below you in the reporting line. HR can summarise anyone.",
      links: [{ label: "Directory", to: "/directory" }],
    };
  }
  if (found.status === "not_found") {
    if (quietIfMissing) return null;
    return { kind: "text", summary: `I couldn't find anyone called "${target}". Try their full name.`, links: [{ label: "Directory", to: "/directory" }] };
  }
  if (found.status === "ambiguous") {
    return { kind: "text", summary: `More than one person matches "${target}": ${found.names.join(", ")}. Which one did you mean?` };
  }
  return {
    kind: "metrics",
    summary: [found.headline, ...found.notes].join(" "),
    metrics: found.metrics,
    table: found.table,
    links: [
      { label: "Open profile", to: `/people/${found.id}` },
      { label: "Performance", to: "/evaluations" },
    ],
  };
}

function balanceAnswer(q: string, ctx: CopilotContext): RawCopilotAnswer {
  const code = leaveCodeIn(q);
  const rows = ctx.leaveRows;
  if (!rows.length) return { kind: "text", summary: "I couldn't find your leave balances.", links: [{ label: "Leave", to: "/leave" }] };
  if (code) {
    const row = rows.find((r) => r.code === code);
    if (!row) return { kind: "text", summary: "That leave type isn't in your leave policy.", links: [{ label: "Leave", to: "/leave" }] };
    const used = row.utilized != null ? ` You've used ${days(row.utilized)} of ${row.quota} this year.` : "";
    const pending = row.pending ? ` ${days(row.pending)} more ${row.pending === 1 ? "is" : "are"} pending approval.` : "";
    return {
      kind: "text",
      // Same "Left" figure as the Leave page; pending requests are mentioned separately.
      summary: `You have ${days(row.available + row.pending)} of ${row.name} left.${used}${pending}`,
      links: [{ label: "Leave", to: "/leave" }],
    };
  }
  // Types not offered (no quota, nothing used) and an empty comp-off bank are left out.
  const paid = rows.filter((r) => r.code !== "unpaid" && !(!r.quota && !r.utilized && r.available <= 0) && !(r.code === "comp_off" && r.available <= 0));
  const leaveOnly = paid.filter((r) => r.code !== "wfh" && r.code !== "emergency_wfh");
  const total = leaveOnly.reduce((n, r) => n + Math.max(0, r.available + r.pending), 0);
  const pendingTotal = leaveOnly.reduce((n, r) => n + (r.pending ?? 0), 0);
  return {
    kind: "metrics",
    summary: `You have ${days(total)} of paid leave left this year: ${leaveOnly.map((r) => `${r.name} ${r.available + r.pending}`).join(", ")}.${pendingTotal ? ` ${days(pendingTotal)} pending approval.` : ""}`,
    metrics: paid.map((r) => ({ label: r.name, value: `${days(r.available + r.pending)}${r.pending ? ` (${r.pending} pending)` : ""}` })),
    links: [{ label: "Leave", to: "/leave" }],
  };
}

function leavePolicyAnswer(q: string, ctx: CopilotContext): RawCopilotAnswer {
  const code = leaveCodeIn(q);
  const policies = ctx.leavePolicies ?? [];
  const links = [
    { label: "Leave", to: "/leave" },
    { label: "Policies", to: "/policies" },
  ];
  if (hasWord(q, ["carry", "carry forward", "carried", "roll over", "rollover", "lapse", "lapses"])) {
    const carry = policies.filter((p) => p.carryForwardMax);
    return {
      kind: "text",
      summary: carry.length
        ? `${carry.map((p) => `${p.name}: up to ${days(p.carryForwardMax!)} carry into next year`).join("; ")}. Other leave types reset on 1 January.`
        : "No leave type carries forward; balances reset on 1 January.",
      links,
      sources: leaveSources(ctx, hasWord(q, ["encash", "encashment"]) ? ["Your yearly entitlement", "Encashment"] : ["Your yearly entitlement"]),
    };
  }
  const describe = (p: (typeof policies)[number]) =>
    `${p.name}: ${days(p.quota)} a year${p.accrual === "monthly" ? ", earned monthly" : ""}${p.carryForwardMax ? `, up to ${p.carryForwardMax} carry forward` : ""}`;
  if (code) {
    const p = policies.find((x) => x.code === code);
    if (!p) return { kind: "text", summary: "That leave type isn't in your leave policy.", links, sources: leaveSources(ctx, ["Your yearly entitlement"]) };
    const extra =
      code === "sick"
        ? ` It can't be booked in advance, and you can apply up to 7 days after being ill${ctx.managerName ? "; older dates need your manager's permission first" : ""}.`
        : code === "comp_off"
          ? " It's earned by working a holiday or weekly off."
          : code === "wfh" || code === "emergency_wfh"
            ? (() => {
                const body = ctx.policies?.find((x) => /work from home/i.test(x.title))?.body;
                return body ? ` ${body}` : "";
              })()
            : "";
    return {
      kind: "text",
      summary: `${describe(p)}.${extra}`,
      links,
      sources: leaveSources(ctx, code === "sick" ? ["Your yearly entitlement", "Applying"] : code === "comp_off" || code === "wfh" || code === "emergency_wfh" ? ["Everyone also gets"] : ["Your yearly entitlement"]),
    };
  }
  return {
    kind: "table",
    summary: ctx.managerName
      ? `Leave policy for ${ctx.countryName}. Past dates need your manager's permission first (sick leave: within 7 days is fine).`
      : `Leave policy for ${ctx.countryName}.`,
    table: { headers: ["Type", "Rule"], rows: policies.map((p) => [p.name, describe(p).split(": ")[1]]) },
    links,
    sources: leaveSources(ctx, ["Your yearly entitlement", "Applying"]),
  };
}

function holidayAnswer(q: string, ctx: CopilotContext): RawCopilotAnswer {
  const today = todayOf(ctx);
  const all = ctx.allHolidays ?? ctx.holidays;
  const upcoming = all.filter((h) => h.date >= today);
  const links = [
    { label: "Holidays", to: "/holidays" },
    { label: "Leave", to: "/leave" },
  ];
  const where = ctx.countryName;
  const month = monthIn(q);
  // A holiday named in the question ("is diwali a holiday").
  const generic = new Set(["day", "holiday", "national", "the", "and", "of", "annual", "shutdown", "substitute", "new", "year"]);
  const named = upcoming.find((h) => h.name.toLowerCase().split(/[^a-z]+/).some((w) => w.length > 3 && !generic.has(w) && hasWord(q, [w])))
    ?? all.find((h) => h.name.toLowerCase().split(/[^a-z]+/).some((w) => w.length > 3 && !generic.has(w) && hasWord(q, [w])));
  if (named) {
    return { kind: "text", summary: `${named.name} is a holiday in ${where} on ${fmtDate(named.date, true)}${named.date < today ? " (already passed)" : ""}.`, links };
  }
  if (hasWord(q, ["tomorrow", "today"])) {
    const day = hasWord(q, ["tomorrow"]) ? addDays(today, 1) : today;
    const hit = all.find((h) => h.date === day);
    return {
      kind: "text",
      summary: hit
        ? `Yes — ${fmtDate(day, true)} is ${hit.name}.`
        : `No, ${fmtDate(day, true)} isn't a holiday in ${where}.${upcoming[0] ? ` The next one is ${upcoming[0].name} on ${fmtDate(upcoming[0].date, true)}.` : ""}`,
      links,
    };
  }
  if (month) {
    const year = Number(today.slice(0, 4));
    const inMonth = (y: number) => all.filter((h) => Number(h.date.slice(0, 4)) === y && Number(h.date.slice(5, 7)) === month);
    let list = inMonth(year);
    if (!list.length && month < Number(today.slice(5, 7))) list = inMonth(year + 1);
    const label = new Date(year, month - 1, 1).toLocaleDateString("en-GB", { month: "long" });
    return {
      kind: list.length ? "table" : "text",
      summary: list.length ? `${list.length} holiday${list.length === 1 ? "" : "s"} in ${label} for ${where}.` : `No holidays in ${label} for ${where}.`,
      table: list.length ? { headers: ["Date", "Holiday"], rows: list.map((h) => [fmtDate(h.date, true), h.name]) } : undefined,
      links,
    };
  }
  if (hasWord(q, ["how many", "count", "left", "remaining"])) {
    const year = today.slice(0, 4);
    const left = upcoming.filter((h) => h.date.startsWith(year));
    const total = all.filter((h) => h.date.startsWith(year)).length;
    return {
      kind: left.length ? "table" : "text",
      summary: `${left.length} of ${total} holidays in ${where} are still to come this year.`,
      table: left.length ? { headers: ["Date", "Holiday"], rows: left.map((h) => [fmtDate(h.date, true), h.name]) } : undefined,
      links,
    };
  }
  if (!upcoming.length) return { kind: "text", summary: `No more holidays this year in ${where}.`, links };
  const next = upcoming[0];
  const wantsNext = hasWord(q, ["next", "upcoming next", "when is", "when"]) && !hasWord(q, ["list", "all", "upcoming holidays", "coming up"]);
  if (wantsNext) {
    return { kind: "text", summary: `The next holiday in ${where} is ${next.name} on ${fmtDate(next.date, true)}.`, links };
  }
  const list = upcoming.slice(0, 6);
  return {
    kind: "table",
    summary: `Next holiday in ${where}: ${next.name} on ${fmtDate(next.date, true)}.`,
    table: { headers: ["Date", "Holiday"], rows: list.map((h) => [fmtDate(h.date, true), h.name]) },
    links,
  };
}

function awayAnswer(q: string, ctx: CopilotContext): RawCopilotAnswer {
  const today = todayOf(ctx);
  const links = [
    { label: "Team", to: "/team" },
    { label: "Calendar", to: "/calendar" },
  ];
  if (!ctx.away) return { kind: "text", summary: "I can't see leave calendars here.", links: [{ label: "Calendar", to: "/calendar" }] };
  let from = today;
  let to = today;
  let label = "today";
  if (hasWord(q, ["tomorrow"])) {
    from = to = addDays(today, 1);
    label = "tomorrow";
  } else if (hasWord(q, ["next week"])) {
    from = addDays(mondayOf(today), 7);
    to = addDays(from, 6);
    label = "next week";
  } else if (hasWord(q, ["this week", "week"])) {
    from = today;
    to = addDays(mondayOf(today), 6);
    label = "this week";
  }
  const wantWfh = hasWord(q, ["wfh", "remote"]);
  const rows = ctx.away.filter((a) => a.from <= to && a.to >= from && (wantWfh ? a.wfh : !a.wfh));
  const scope = ctx.awayScope === "org" ? "in the company" : ctx.awayScope === "team" ? "in your team" : "";
  const what = wantWfh ? "working from home" : "on leave";
  if (ctx.awayScope === "self") {
    const me = rows[0];
    return {
      kind: "text",
      summary: `${me ? `You're ${what} ${label} (${range(me.from, me.to)}).` : `You're not ${what} ${label}.`} I can only show your own leave — nobody reports to you.`,
      links: [{ label: "Leave", to: "/leave" }],
    };
  }
  if (!rows.length) return { kind: "text", summary: `Nobody ${scope} is ${what} ${label}.`, links };
  return {
    kind: "table",
    summary: `${rows.length} ${rows.length === 1 ? "person is" : "people are"} ${what} ${label} ${scope}.`,
    table: { headers: ["Person", "Type", "Dates"], rows: rows.map((a) => [a.self ? `${a.name} (you)` : a.name, a.type, range(a.from, a.to)]) },
    links,
  };
}

function myLeaveStatusAnswer(q: string, ctx: CopilotContext): RawCopilotAnswer {
  const links = [{ label: "Leave", to: "/leave" }];
  const mine = ctx.myLeave ?? [];
  if (!mine.length) return { kind: "text", summary: "You haven't applied for any leave yet.", links };
  const wantPending = hasWord(q, ["pending", "waiting", "open"]);
  const list = wantPending ? mine.filter((r) => r.status === "pending") : mine;
  if (wantPending && !list.length) {
    const last = mine[0];
    return { kind: "text", summary: `None of your leave requests are pending. Your latest, ${last.type} for ${range(last.from, last.to)}, is ${last.status}.`, links };
  }
  const last = list[0];
  const by = last.decidedBy ? ` by ${last.decidedBy}` : "";
  const waiting = last.status === "pending" ? (ctx.managerName ? ` — waiting on ${ctx.managerName}` : "") : by;
  return {
    kind: "table",
    summary: `Your latest request, ${last.type} for ${range(last.from, last.to)} (${days(last.days)}), is ${last.status}${waiting}.`,
    table: { headers: ["Type", "Dates", "Days", "Status"], rows: list.slice(0, 5).map((r) => [r.type, range(r.from, r.to), String(r.days), cap(r.status)]) },
    links,
  };
}

function payslipAnswer(q: string, ctx: CopilotContext): RawCopilotAnswer {
  const links = [{ label: "My payslips", to: "/payslips" }];
  const slips = ctx.payslips;
  if (!slips) return { kind: "text", summary: "Open My payslips to see your pay.", links };
  if (!slips.length) return { kind: "text", summary: "You don't have any payslips yet.", links };
  const month = monthIn(q);
  const slip = (month ? slips.find((s) => Number(s.month.slice(5, 7)) === month) : undefined) ?? slips[0];
  if (month && Number(slip.month.slice(5, 7)) !== month) {
    return { kind: "text", summary: `There's no payslip for that month. Your latest is ${slips[0].label}.`, links };
  }
  const c = slip.currency;
  if (hasWord(q, ["when", "pay date", "payday", "credited", "salary date"]) && !hasWord(q, ["tax", "deduction", "deductions"])) {
    return { kind: "text", summary: `I don't have pay dates. Your latest payslip is for ${slips[0].label} (net ${money(slips[0].net, slips[0].currency)}).`, links };
  }
  if (hasWord(q, ["tax", "taxes", "tds", "income tax", "paye", "withholding"])) {
    const year = slips[0].month.slice(0, 4);
    const ytd = slips.filter((s) => s.month.startsWith(year)).reduce((n, s) => n + s.tax, 0);
    const lines = slip.deductions.filter((d) => d.amount > 0 && /tds|tax|paye|withholding|federal|state|medicare|social security|national insurance/i.test(d.name));
    return {
      kind: "metrics",
      summary: `Tax on your ${slip.label} payslip: ${money(slip.tax, c)} (${lines.map((d) => `${d.name} ${money(d.amount, c)}`).join(", ") || "none"}). ${year} so far: ${money(ytd, c)} across ${slips.filter((s) => s.month.startsWith(year)).length} payslips.`,
      metrics: [
        { label: `Tax · ${slip.label}`, value: money(slip.tax, c) },
        { label: `Tax · ${year} so far`, value: money(ytd, c) },
      ],
      links,
    };
  }
  if (hasWord(q, ["deduction", "deductions", "pf", "provident fund", "deducted"])) {
    return {
      kind: "table",
      summary: `Deductions on your ${slip.label} payslip total ${money(slip.gross - slip.net, c)}.`,
      table: { headers: ["Deduction", "Amount"], rows: slip.deductions.map((d) => [d.name, money(d.amount, c)]) },
      links,
    };
  }
  return {
    kind: "metrics",
    summary: `Your ${slip.label} payslip: net pay ${money(slip.net, c)} (gross ${money(slip.gross, c)}, deductions ${money(slip.gross - slip.net, c)}).`,
    metrics: [
      { label: "Net pay", value: money(slip.net, c) },
      { label: "Gross", value: money(slip.gross, c) },
      { label: "Deductions", value: money(slip.gross - slip.net, c) },
    ],
    links,
  };
}

function timesheetAnswer(q: string, ctx: CopilotContext): RawCopilotAnswer {
  const links = [{ label: "Timesheet", to: "/timesheet" }];
  const weeks = ctx.timesheetWeeks;
  if (!weeks?.length) return { kind: "text", summary: "Log project hours for the week in Timesheet, then submit it.", links };
  const w = hasWord(q, ["last week", "previous week"]) ? weeks[1] : weeks[0];
  const when = w === weeks[0] ? "this week" : "last week";
  const what =
    w.status === "not started"
      ? `you haven't logged any hours ${when} (week of ${fmtDate(w.weekStart)}).`
      : `your timesheet ${when} (week of ${fmtDate(w.weekStart)}) is ${w.status} with ${w.hours} h logged.`;
  return {
    kind: "text",
    summary: `${cap(what)}${w.status === "draft" || w.status === "not started" ? (ctx.managerName ? " Submit it in Timesheet so your manager can review it." : " Submit it in Timesheet.") : ""}`,
    links,
  };
}

function goalsAnswer(ctx: CopilotContext): RawCopilotAnswer {
  const links = [{ label: "Performance", to: "/evaluations" }];
  const g = ctx.goals;
  if (!g) return { kind: "text", summary: "Your goals and reviews are in Performance.", links };
  if (!g.items.length) return { kind: "text", summary: `You have no goals set for ${g.cycle}.${g.review ? ` Review: ${g.review}.` : ""}`, links };
  return {
    kind: "table",
    summary: `Your ${g.cycle} goals are ${g.weighted}% complete (weighted, ${g.items.length} goals).${g.review ? ` Review: ${g.review}.` : ""}`,
    table: { headers: ["Goal", "Progress", "Weight"], rows: g.items.map((x) => [x.title, `${x.progress}%`, `${x.weight}%`]) },
    links,
  };
}

function learningAnswer(q: string, ctx: CopilotContext): RawCopilotAnswer {
  const links = [{ label: "Learning", to: "/programs" }];
  if (hasWord(q, ["mandatory", "required", "must"]) && ctx.mandatoryCourses) {
    const m = ctx.mandatoryCourses;
    // Assigned and unfinished, plus company-wide ("All") courses not yet assigned.
    const open = m.filter((c) => c.status !== "Completed" && (c.status !== "Not assigned" || c.audience === "All"));
    return {
      kind: "table",
      summary: `${m.length} courses are mandatory: ${m.map((c) => c.title).join(", ")}. ${open.length ? `You still have ${open.length} to complete: ${open.map((c) => c.title).join(", ")}.` : "You have none outstanding."}`,
      table: { headers: ["Course", "For", "Your status"], rows: m.map((c) => [c.title, c.audience, `${c.status}${c.due && c.status !== "Completed" ? ` · due ${fmtDate(c.due)}` : ""}`]) },
      links,
    };
  }
  const l = ctx.learning;
  if (!l) return { kind: "text", summary: "Your courses and certifications are in Learning.", links };
  if (!l.length) return { kind: "text", summary: "You aren't enrolled in any courses.", links };
  const done = l.filter((c) => c.status === "Completed").length;
  return {
    kind: "table",
    summary: `You've completed ${done} of ${l.length} courses.`,
    table: { headers: ["Course", "Status", "Due"], rows: l.map((c) => [c.title + (c.mandatory ? " (mandatory)" : ""), `${c.status} · ${c.progress}%`, c.due ? fmtDate(c.due) : "—"]) },
    links,
  };
}

function workforceAnswer(q: string, ctx: CopilotContext): RawCopilotAnswer {
  const wf = ctx.workforce;
  if (!ctx.orgWide || !wf) {
    return {
      kind: "text",
      summary: ctx.teamSize
        ? `Company-wide numbers need HR or executive access. Your own team has ${ctx.teamSize} ${ctx.teamSize === 1 ? "person" : "people"}.`
        : "Company-wide numbers need HR or executive access.",
      links: [{ label: "Team", to: "/team" }],
    };
  }
  const links = [{ label: "Analytics", to: "/analytics" }];
  const country = wf.byCountry?.find((c) => q.includes(c.name.toLowerCase()) || (c.name === "United States" && hasWord(q, ["us", "usa"])) || (c.name === "United Kingdom" && hasWord(q, ["uk"])) || (c.name === "United Arab Emirates" && hasWord(q, ["uae"])));
  if (country && !hasWord(q, ["attrition", "turnover", "exits", "joiners"])) {
    return { kind: "text", requires: "analytics", summary: `${country.count} active people in ${country.name} (of ${wf.headcount} company-wide).`, links };
  }
  if (hasWord(q, ["country", "countries", "location", "locations", "region"]) && wf.byCountry) {
    return {
      kind: "table",
      requires: "analytics",
      summary: `Active headcount is ${wf.headcount} across ${wf.byCountry.length} countries.`,
      table: { headers: ["Country", "People"], rows: wf.byCountry.map((c) => [c.name, String(c.count)]) },
      links,
    };
  }
  if (hasWord(q, ["department", "departments", "dept", "function", "team wise"]) && wf.byDepartment) {
    return {
      kind: "table",
      requires: "analytics",
      summary: `Active headcount is ${wf.headcount} across ${wf.byDepartment.length} departments.`,
      table: { headers: ["Department", "People"], rows: wf.byDepartment.map((c) => [c.name, String(c.count)]) },
      links,
    };
  }
  if (hasWord(q, ["joiners", "joining", "hired", "onboarded"])) {
    const month = hasWord(q, ["this month", "month"]);
    return {
      kind: "text",
      requires: "analytics",
      summary: month ? `${wf.joinersMonth ?? 0} people joined this month (${wf.joiners} so far this year).` : `${wf.joiners} people have joined so far this year (${wf.joinersMonth ?? 0} this month).`,
      links,
    };
  }
  if (hasWord(q, ["attrition", "turnover", "exits", "exit", "left", "resigned", "leavers", "churn"])) {
    return {
      kind: "metrics",
      requires: "analytics",
      summary: `Year to date: ${wf.exits} exit${wf.exits === 1 ? "" : "s"}, ${wf.attritionPct}% of current headcount.${wf.attrition12 ? ` ${wf.attrition12}` : ""}`,
      metrics: [
        { label: "Exits (YTD)", value: String(wf.exits) },
        { label: "Attrition (YTD)", value: `${wf.attritionPct}%` },
        { label: "Exits this month", value: String(wf.exitsMonth ?? 0) },
      ],
      links,
    };
  }
  return {
    kind: "metrics",
    requires: "analytics",
    summary: `Active headcount is ${wf.headcount}. Year to date: ${wf.joiners} joiners, ${wf.exits} exits, ${wf.attritionPct}% attrition.`,
    metrics: [
      { label: "Headcount", value: String(wf.headcount) },
      { label: "Joiners (YTD)", value: String(wf.joiners) },
      { label: "Exits (YTD)", value: String(wf.exits) },
      { label: "Attrition (YTD)", value: `${wf.attritionPct}%` },
    ],
    links,
  };
}

function recruitingAnswer(q: string, ctx: CopilotContext): RawCopilotAnswer {
  const links = [
    { label: "Recruiting", to: "/recruiting" },
    { label: "Jobs", to: "/jobs" },
  ];
  const r = ctx.recruiting;
  if (!r) return { kind: "text", summary: "Recruiting numbers need recruiting access.", links: [{ label: "Help", to: "/help" }] };
  if (hasWord(q, ["candidate", "candidates", "pipeline", "stage", "stages", "interview", "interviews", "applicants", "offers"])) {
    if (r.candidates == null || !r.byStage) {
      return { kind: "text", summary: "The candidate pipeline needs recruiting access.", links: [{ label: "Jobs", to: "/jobs" }] };
    }
    return {
      kind: "table",
      summary: `${r.candidates} candidates in the pipeline; ${r.openOffers ?? 0} offer${r.openOffers === 1 ? "" : "s"} still open.`,
      table: { headers: ["Stage", "Candidates"], rows: r.byStage.map((s) => [s.stage, String(s.count)]) },
      links,
    };
  }
  return {
    kind: "table",
    summary: `${r.openings} opening${r.openings === 1 ? "" : "s"} across ${r.approvedReqs} approved requisition${r.approvedReqs === 1 ? "" : "s"}${r.pendingReqs ? `; ${r.pendingReqs} awaiting approval` : ""}${r.onHoldReqs ? `; ${r.onHoldReqs} on hold` : ""}.`,
    table: { headers: ["Role", "Country", "Openings"], rows: r.roles.map((x) => [x.title, x.country, String(x.openings)]) },
    links,
  };
}

function approvalsAnswer(ctx: CopilotContext): RawCopilotAnswer {
  const links = [{ label: "Open approvals", to: "/approvals" }];
  if (!ctx.approvalsCount) return { kind: "text", summary: `Nothing is waiting on you. ${NO_DECISIONS}`, links };
  const rows = ctx.approvals.slice(0, 8);
  return {
    kind: "table",
    summary: `${ctx.approvalsCount} item${ctx.approvalsCount === 1 ? " is" : "s are"} waiting on you. ${NO_DECISIONS}`,
    table: rows.length ? { headers: ["Person", "Type", "Detail", "Date"], rows: rows.map((a) => [a.who, a.kind, a.detail, a.date ? fmtDate(a.date) : "—"]) } : undefined,
    links,
  };
}

function shiftAnswer(q: string, ctx: CopilotContext): RawCopilotAnswer {
  const links = [
    { label: "Attendance", to: "/attendance" },
    { label: "Timesheet", to: "/timesheet" },
  ];
  const off = ctx.weeklyOff?.length ? ctx.weeklyOff.join(" and ") : "";
  if (hasWord(q, ["weekly off", "weekly offs", "weekend", "weekends", "off days", "off day"]) && off) {
    return { kind: "text", summary: `Your weekly offs are ${off}.`, links };
  }
  if (hasWord(q, ["time zone", "timezone", "tz"]) && !hasWord(q, ["shift"])) {
    return { kind: "text", summary: `Your time zone is ${ctx.timeZone}.`, links };
  }
  const today = ctx.todayShift ? ` Today you're rostered on ${ctx.todayShift}.` : "";
  return {
    kind: "metrics",
    summary: `Your shift is ${ctx.shiftName ? `${ctx.shiftName}, ` : ""}${ctx.shiftHours} (${ctx.timeZone}).${off ? ` Weekly offs: ${off}.` : ""}${today}`,
    metrics: [
      { label: "Shift", value: ctx.shiftHours },
      { label: "Time zone", value: ctx.timeZone },
      ...(off ? [{ label: "Weekly off", value: off }] : []),
    ],
    links,
  };
}

function correctionAnswer(ctx: CopilotContext): RawCopilotAnswer {
  const pending = (ctx.corrections ?? []).filter((c) => c.status === "Pending");
  const who = ctx.managerName ?? "your manager";
  return {
    kind: "text",
    summary: `Open Attendance, pick the day and choose Request correction with the right times and a reason; ${ctx.managerName ? `${who} approves it` : "it's approved automatically"}.${
      pending.length ? ` You already have ${pending.length} pending (${pending.map((c) => `${fmtDate(c.date)}, ${c.kind}`).join("; ")}).` : ""
    }`,
    links: [{ label: "Attendance", to: "/attendance" }],
  };
}

function expensesAnswer(ctx: CopilotContext): RawCopilotAnswer {
  const links = [
    { label: "Expenses", to: "/expenses" },
    { label: "Reimbursement", to: "/reimbursement" },
  ];
  const ex = ctx.expenses;
  if (!ex) return { kind: "text", summary: "Submit claims in Expenses; they go to someone above you in the reporting line.", links };
  if (!ex.length) return { kind: "text", summary: "You have no expense or reimbursement claims.", links };
  const open = ex.filter((x) => x.status === "submitted" || x.status === "pending");
  return {
    kind: "table",
    summary: `You have ${ex.length} claim${ex.length === 1 ? "" : "s"}; ${open.length} ${open.length === 1 ? "is" : "are"} awaiting approval.`,
    table: { headers: ["Type", "Category", "Amount", "Status"], rows: ex.slice(0, 8).map((x) => [x.kind, x.category, money(x.amount, x.currency), cap(x.status)]) },
    links,
  };
}

function policyTextAnswer(q: string, ctx: CopilotContext): RawCopilotAnswer | null {
  // Once an admin limits Copilot's policy sources, only the approved library answers; this older text is skipped.
  if (enabledPolicyIds() !== null) return null;
  const list = ctx.policies ?? [];
  const words = q.split(" ").filter((w) => w.length > 3 && !["policy", "policies", "what", "about", "tell", "with"].includes(w));
  const hit = list.find((p) => words.some((w) => p.title.toLowerCase().includes(w)));
  if (!hit) return null;
  return {
    kind: "text",
    summary: hit.body ? `${hit.title}: ${hit.body}` : `See the ${hit.title} in Policies.`,
    links: [{ label: "Policies", to: "/policies" }],
  };
}

/* —— the router —— */

export function copilotAnswer(question: string, ctx: CopilotContext): RawCopilotAnswer {
  const q = normalizeQuestion(question);
  const self = hasWord(q, ["my", "i", "me", "mine", "im", "ive", "do i", "am i"]);

  if (!q) return { kind: "text", summary: "Ask me about your leave, holidays, payslips, approvals, timesheet or team.", links: [{ label: "Help", to: "/help" }] };

  if (/^(hi|hello|hey|hii|good (morning|afternoon|evening)|thanks|thank you|ok|okay)\b/.test(q) && q.split(" ").length <= 3) {
    return { kind: "text", summary: `Hi ${ctx.firstName || "there"} — ask about your leave, holidays, payslips, approvals, timesheet or team.` };
  }

  const target = summaryTarget(question);
  if (target) return personSummaryAnswer(target, ctx)!;

  // Somebody else's pay: only HR (compensation & benefits) sees it, and never in chat.
  const payWord = hasWord(q, ["salary", "pay", "ctc", "payslip", "earn", "earns", "earning", "package", "compensation"]);
  const otherPay = payWord && !self && (/\b(salary|pay|ctc|payslip|package|compensation) (of|for) [a-z]+/.test(q) || /\b[a-z]+s (salary|pay|ctc|payslip|package)\b/.test(q) || /\bdoes [a-z]+ (earn|make|get)\b/.test(q));
  const payOf =
    q.match(/\b(?:salary|pay|ctc|payslip|package|compensation) (?:of|for) ([a-z]+)/)?.[1] ??
    q.match(/\b([a-z]+)s (?:salary|pay|ctc|payslip|package)\b/)?.[1] ??
    q.match(/\bdoes ([a-z]+) (?:earn|make|get)\b/)?.[1];
  if (otherPay && payOf && ctx.firstName && payOf === ctx.firstName.toLowerCase()) return payslipAnswer(q, ctx);
  if (otherPay && !/\b(my|your|our)s? (salary|pay)/.test(q)) {
    const comp = ctx.viewer.role === "hr" || ctx.viewer.role === "hr_admin" || ctx.viewer.role === "super_admin";
    return comp
      ? { kind: "text", denied: true, summary: "I don't show individual pay in chat. Open Compensation to see it.", links: [{ label: "Compensation", to: "/compensation" }] }
      : { kind: "text", denied: true, summary: "I can't share anyone else's pay — only the person and HR can see it.", links: [{ label: "My payslips", to: "/payslips" }] };
  }

  // "<Name>'s leave / manager / goals …": Copilot only answers these about the asker.
  const possessive = q.match(
    /\b([a-z]{3,})s (leave|leaves|balance|leave balance|manager|goals|goal|timesheet|shift|attendance|holidays|review|rating|learning|courses|expenses|pto|wfh|team)\b/,
  )?.[1];
  if (
    possessive &&
    !["thi", "hi", "it", "doe", "wa", "ha", "ye", "da", "hour", "month", "week", "year", "our", "your", "other", "employee", "people", "member", "colleague", "everyone", "anyone"].includes(possessive) &&
    possessive !== ctx.firstName.toLowerCase() &&
    ctx.summarisePerson &&
    ctx.summarisePerson(possessive).status !== "not_found"
  ) {
    const name = cap(possessive);
    return {
      kind: "text",
      summary: `I only answer that kind of question about you. For someone below you in the reporting line, ask "Summarise ${name}".`,
      links: [{ label: "Directory", to: "/directory" }],
    };
  }

  if (hasWord(q, ["copilot", "how do you work", "are you real", "llm", "chatgpt", "what can you do", "what can i ask", "help me"])) {
    return {
      kind: "text",
      summary: `I answer from your own portal data and your team's, within your access — leave, holidays, payslips, approvals, timesheet, goals, learning. Ask "Summarise <name>" for someone below you, "headcount by country" or "leave taken by department this month" for numbers, "experience letter for me" for a letter draft, or "apply leave next Friday" and I'll prepare it for you to confirm. ${NO_DECISIONS}`,
      links: [{ label: "Help", to: "/help" }],
    };
  }

  if (hasWord(q, ["company name", "organisation name", "organization name", "who are we", "brand name"]) ||
      (hasWord(q, ["company", "organisation", "organization", "employer"]) && hasWord(q, ["name", "called", "brand"]))) {
    return { kind: "text", summary: `You work for ${COMPANY_NAME} (${PRODUCT_TAGLINE}).`, links: [{ label: "Organization", to: "/organization" }] };
  }
  if (hasWord(q, ["product name", "app name", "portal name", "what is this app", "what is this portal"])) {
    return { kind: "text", summary: `${PRODUCT_NAME} is the ${COMPANY_NAME} employee portal.`, links: [{ label: "Home", to: "/" }] };
  }

  // A policy that doesn't apply to the asker (another country, role or contract type) is never quoted.
  if (hasWord(q, POLICY_WORDS)) {
    const denied = policyLibraryAnswer(q, ctx, true);
    if (denied) return denied;
  }

  const isLeave = hasWord(q, LEAVE);
  const mentionsApproval = hasWord(q, APPROVAL) || /\bapprov/.test(q);

  // Items waiting on me (as the approver).
  if (
    /\b(for|on|need|needs|needing|awaiting|await|requires?|with) (my|me) (approval|approvals|sign off|decision|action)\b/.test(q) ||
    /\b(waiting|pending) (on|with|for) me\b/.test(q) ||
    /\b(to|should|can|must) i approve\b/.test(q) ||
    /\b(anything|something|what|items?|requests?) to approve\b/.test(q) ||
    /\bmy (approvals|inbox|approval queue|queue)\b/.test(q) ||
    /\bpending approvals?\b/.test(q) && !hasWord(q, ["my leave", "my request", "my requests"]) ||
    /^(approvals|inbox|approval queue)$/.test(q) ||
    (hasWord(q, ["team", "teams"]) && mentionsApproval && hasWord(q, ["pending", "waiting"]))
  ) {
    return approvalsAnswer(ctx);
  }

  // Who is away.
  if (
    (hasWord(q, ["who", "whos", "who is", "who are", "anyone", "anybody", "people", "team", "colleagues"]) &&
      (hasWord(q, ["on leave", "off", "out", "away", "absent", "wfh", "out of office", "ooo", "on pto"]) || (isLeave && hasWord(q, ["today", "tomorrow", "this week", "next week"])))) &&
    !hasWord(q, ["most", "highest", "top", "max"])
  ) {
    return awayAnswer(q, ctx);
  }

  // Who in my team took the most leave.
  if ((isLeave || hasWord(q, ["holiday", "holidays"])) && hasWord(q, ["most", "highest", "top", "max"]) && hasWord(q, ["who", "which", "team", "people"])) {
    if (!ctx.teamSize) return { kind: "text", summary: "You can only see your own leave — nobody reports to you.", links: [{ label: "Leave", to: "/leave" }] };
    const rows = ctx.teamLeave.filter((r) => r.days > 0).slice(0, 5);
    return {
      kind: rows.length ? "table" : "text",
      summary: rows.length ? `${rows[0].name} has taken the most leave this year (${days(rows[0].days)}).` : "Nobody in your team has taken leave yet this year.",
      table: rows.length ? { headers: ["Person", "Days"], rows: rows.map((r) => [r.name, String(r.days)]) } : undefined,
      links: [{ label: "Leave", to: "/leave" }],
    };
  }

  // Leave already used this year.
  if (isLeave && hasWord(q, ["taken", "used", "utilized", "utilised", "consumed", "availed", "took"]) && !hasWord(q, ["who", "team"])) {
    const code = leaveCodeIn(q);
    const rows = ctx.leaveRows.filter((r) => (code ? r.code === code : true) && (r.utilized ?? 0) > 0);
    const leaveDaysUsed = rows.filter((r) => r.code !== "wfh" && r.code !== "emergency_wfh").reduce((n, r) => n + (r.utilized ?? 0), 0);
    return {
      kind: rows.length ? "table" : "text",
      summary: rows.length
        ? code
          ? `You've used ${days(rows[0].utilized ?? 0)} of ${rows[0].name} this year.`
          : `You've taken ${days(leaveDaysUsed)} of leave this year${rows.some((r) => r.code === "wfh" || r.code === "emergency_wfh") ? " (WFH days listed separately)" : ""}.`
        : "You haven't taken any of that leave this year.",
      table: rows.length ? { headers: ["Type", "Used", "Available"], rows: rows.map((r) => [r.name, String(r.utilized ?? 0), String(r.available)]) } : undefined,
      links: [{ label: "Leave", to: "/leave" }],
    };
  }

  // Status of my own leave requests.
  if (
    (isLeave || hasWord(q, ["request", "requests", "application"])) &&
    (hasWord(q, ["status", "approved", "rejected", "pending", "decided", "declined", "withdrawn", "history", "applied", "requests", "taken", "did i take"]) ||
      mentionsApproval) &&
    !hasWord(q, ["how do i", "how to", "how can i", "policy"])
  ) {
    if (hasWord(q, ["expense", "expenses", "reimbursement", "claim", "claims"])) return expensesAnswer(ctx);
    return myLeaveStatusAnswer(q, ctx);
  }

  // Leave on past dates.
  if (
    (isLeave || hasWord(q, ["apply"])) &&
    hasWord(q, ["last week", "yesterday", "past", "previous", "backdated", "back date", "back dated", "earlier", "last month", "missed", "old dates", "past dates"])
  ) {
    const sick = leaveCodeIn(q) === "sick";
    return {
      kind: "text",
      summary: !ctx.managerName
        ? "Yes — with nobody above you, past dates are recorded and approved automatically."
        : sick
        ? "Yes — sick leave can be applied up to 7 days after the date. Older dates need your manager's permission first."
        : `Not directly — past dates need ${ctx.managerName ?? "your manager"}'s permission first. In Leave, choose Request permission for those dates; once approved you have 30 days to apply. Sick leave within the last 7 days needs no permission.`,
      links: [{ label: "Leave", to: "/leave" }],
    };
  }

  // Leave rules.
  if (
    (isLeave && hasWord(q, ["policy", "policies", "rule", "rules", "per year", "a year", "per month", "quota", "entitled", "entitlement", "allowed", "eligible", "carry", "carry forward", "lapse", "encash", "encashment", "accrue", "accrual"])) ||
    (hasWord(q, ["carry forward", "encashment", "encash"]) && !hasWord(q, ["balance"]))
  ) {
    return leavePolicyAnswer(q, ctx);
  }

  // How to apply.
  if (
    isLeave &&
    hasWord(q, ["apply", "request", "book", "submit", "take", "raise"]) &&
    hasWord(q, ["how", "how do i", "how to", "how can i", "where", "steps", "process", "want to", "need to", "can i"]) &&
    !hasWord(q, ["how many", "left", "balance", "remaining"])
  ) {
    return {
      kind: "text",
      summary: ctx.managerName
        ? `Open Leave, pick the type and dates, add a reason and submit. ${ctx.managerName} (or someone above them) decides it.`
        : "Open Leave, pick the type and dates, add a reason and submit. With nobody above you, it's approved automatically.",
      links: [
        { label: "Leave", to: "/leave" },
        { label: "Holidays", to: "/holidays" },
      ],
    };
  }

  // Leave balance.
  if (isLeave || hasWord(q, ["balance", "balances"])) {
    if (hasWord(q, ["balance", "balances"]) && !isLeave && hasWord(q, ["comp", "salary", "pay"])) {
      // fall through to other rules
    } else {
      return balanceAnswer(q, ctx);
    }
  }

  // Holiday policy text, then holidays.
  if (hasWord(q, ["holiday", "holidays", "festival", "festivals", "public holiday", "bank holiday", "closure", "long weekend"])) {
    if (hasWord(q, ["policy", "rule", "rules"])) {
      const p = policyLibraryAnswer(`holiday ${q}`, ctx) ?? policyTextAnswer("holiday", ctx);
      if (p) return p;
    }
    return holidayAnswer(q, ctx);
  }

  // Reporting line.
  if (hasWord(q, ["who is my manager", "my manager", "manager", "report to", "reporting manager", "my lead", "line manager", "supervisor"]) &&
      !hasWord(q, ["reports to me", "report to me", "my reports", "hiring manager"])) {
    return {
      kind: "text",
      summary: ctx.managerName
        ? `You report to ${ctx.managerName}. They (or someone above them) decide your requests.`
        : "Nobody is above you in the reporting line, so your requests are approved automatically.",
      links: [
        { label: "Org chart", to: "/org-chart" },
        { label: "My profile", to: "/info" },
      ],
    };
  }
  if (hasWord(q, ["reports to me", "report to me", "my reports", "direct reports", "direct report", "my team", "team size", "my teams", "reportees", "subordinates", "who works for me", "in my team"]) ||
      (hasWord(q, ["team"]) && hasWord(q, ["how many", "who", "list", "members"]))) {
    const team = ctx.team ?? [];
    const direct = team.filter((m) => m.direct);
    if (!ctx.teamSize) {
      return { kind: "text", summary: "Nobody reports to you.", links: [{ label: "Org chart", to: "/org-chart" }] };
    }
    return {
      kind: team.length ? "table" : "text",
      summary: `${direct.length} ${direct.length === 1 ? "person reports" : "people report"} directly to you${ctx.teamSize > direct.length ? `; ${ctx.teamSize} in your whole reporting line` : ""}.${direct.length ? ` Direct: ${direct.map((m) => m.name).join(", ")}.` : ""}`,
      table: team.length ? { headers: ["Person", "Role", "Direct"], rows: team.slice(0, 12).map((m) => [m.name, m.designation || "—", m.direct ? "Yes" : "No"]) } : undefined,
      links: [
        { label: "Team", to: "/team" },
        { label: "Org chart", to: "/org-chart" },
      ],
    };
  }

  if (hasWord(q, ["org chart", "orgchart", "organisation chart", "organization chart", "reporting tree"])) {
    return { kind: "text", summary: ctx.managerName ? `You report to ${ctx.managerName}. The full tree is in the org chart.` : "The full tree is in the org chart.", links: [{ label: "Org chart", to: "/org-chart" }] };
  }

  // Shift / hours / time zone.
  if (
    hasWord(q, ["shift", "working hours", "work hours", "office hours", "business hours", "start time", "end time", "login time", "logout time", "duty hours", "working time", "time zone", "timezone", "weekly off", "weekly offs", "off days"]) ||
    (hasWord(q, ["hours", "timing", "timings"]) && hasWord(q, ["work", "working", "office", "my"])) ||
    hasWord(q, ["what time do i", "when do i start", "when do i work"])
  ) {
    if (!hasWord(q, ["timesheet", "log", "logged", "overtime"])) return shiftAnswer(q, ctx);
  }

  // Own pay.
  if (hasWord(q, ["payslip", "payslips", "net pay", "gross", "salary", "pay", "tax", "taxes", "tds", "income tax", "deduction", "deductions", "pf", "provident fund", "paid", "ctc", "earn", "earnings"]) &&
      !hasWord(q, ["band", "bands", "range", "comp review", "compensation review", "increment cycle", "bonus cycle"])) {
    if (hasWord(q, ["ctc", "salary structure", "package"]) && !hasWord(q, ["payslip", "net pay"])) {
      return { kind: "text", summary: "Your salary structure is in My payslips; I only read your payslips here.", links: [{ label: "My payslips", to: "/payslips" }] };
    }
    return payslipAnswer(q, ctx);
  }

  // Compensation programme.
  if (hasWord(q, ["compensation", "salary band", "pay band", "band", "bands", "comp review", "compensation review", "merit", "increment", "increments", "raise", "bonus", "bonus cycle"])) {
    const c = ctx.compReview;
    if (c) {
      return {
        kind: "metrics",
        requires: "compensation",
        summary: `${c.cycle} (${c.status}): ${c.total} reviews, ${c.submittedPct}% submitted, ${c.approved} approved, ${c.awaiting} awaiting approval; average proposed increase ${c.avgIncreasePct}%.`,
        metrics: [
          { label: "Reviews", value: String(c.total) },
          { label: "Submitted", value: `${c.submittedPct}%` },
          { label: "Approved", value: String(c.approved) },
          { label: "Avg increase", value: `${c.avgIncreasePct}%` },
        ],
        links: [{ label: "Compensation", to: "/compensation" }],
      };
    }
    return { kind: "text", requires: "compensation", summary: "Compensation reviews and pay bands are in Compensation.", links: [{ label: "Compensation", to: "/compensation" }] };
  }

  // Timesheet.
  if (hasWord(q, ["timesheet", "timesheets", "log hours", "logged hours", "fill hours", "project hours", "billable", "hours logged", "hours this week"])) {
    return timesheetAnswer(q, ctx);
  }

  // Attendance.
  if (hasWord(q, ["attendance correction", "correct attendance", "correction", "fix attendance", "wrong check in", "wrong check out", "forgot to check out", "forgot to check in", "forgot to punch"]) ||
      (hasWord(q, ["attendance", "check in", "check out", "punch"]) && hasWord(q, ["correct", "fix", "wrong", "missed", "forgot", "change", "update", "edit"]))) {
    return correctionAnswer(ctx);
  }
  if (hasWord(q, ["attendance", "overtime", "check in", "check out", "present", "punch", "clock in", "clock out"])) {
    return { kind: "text", summary: ctx.managerName ? "Check in and out from Home or Attendance. Mistakes can be fixed with a correction request to your manager." : "Check in and out from Home or Attendance. Fix mistakes with a correction request.", links: [{ label: "Attendance", to: "/attendance" }] };
  }

  // Performance.
  if (hasWord(q, ["goal", "goals", "okr", "okrs", "kpi", "kpis", "performance", "appraisal", "review", "reviews", "rating", "evaluation"])) {
    return goalsAnswer(ctx);
  }

  // Learning.
  if (hasWord(q, ["course", "courses", "training", "trainings", "learning", "certification", "certifications", "lms", "mandatory"])) {
    return learningAnswer(q, ctx);
  }

  // Recruiting (before workforce: "how many candidates", "open positions").
  if (hasWord(q, ["open positions", "requisition", "requisitions", "req", "reqs", "pipeline", "candidate", "candidates", "recruiting", "recruitment", "hiring", "interview", "interviews", "offers", "time to hire", "applicants"])) {
    return recruitingAnswer(q, ctx);
  }

  // Workforce.
  if (hasWord(q, ["headcount", "attrition", "turnover", "workforce", "joiners", "exits", "leavers", "employees", "how many people", "staff", "churn"])) {
    return workforceAnswer(q, ctx);
  }

  if (hasWord(q, ["expense", "expenses", "reimbursement", "reimbursements", "claim", "claims"])) {
    if (hasWord(q, ["policy", "policies", "rule", "rules", "limit", "limits", "receipt", "receipts", "advance"])) {
      const p = policyLibraryAnswer(q, ctx);
      if (p) return p;
    }
    return expensesAnswer(ctx);
  }

  if (hasWord(q, POLICY_WORDS)) {
    return (
      policyLibraryAnswer(q, ctx) ??
      policyTextAnswer(q, ctx) ?? { kind: "text", summary: "Company policies and your acknowledgements are under Policies.", links: [{ label: "Policies", to: "/policies" }] }
    );
  }

  if (hasWord(q, ["integration", "integrations", "sso", "audit", "connector", "connectors", "admin", "administration"])) {
    return {
      kind: "text",
      requires: "integrations",
      summary: "Connector status and retries are in Integration Center; the audit log is in Administration.",
      links: [
        { label: "Integrations", to: "/integrations" },
        { label: "Administration", to: "/admin" },
      ],
    };
  }

  const pointers: [string[], string, { label: string; to: string }][] = [
    [["calendar", "meeting", "meetings", "reminder", "reminders", "ip day", "ip days", "in person"], "Your calendar shows in-person days, meetings, reminders, leave and holidays.", { label: "My calendar", to: "/calendar" }],
    [["benefit", "benefits", "medical", "insurance", "dependents", "dependent"], `Benefits shows the plans for ${ctx.countryName}, your enrolment and dependents.`, { label: "Benefits", to: "/benefits" }],
    [["profile", "my info", "my details", "employee id", "who am i", "my email", "contact", "address", "phone"], "Open My profile to see and update your details.", { label: "My profile", to: "/info" }],
    [["task", "tasks", "to do", "todo"], "Tasks lists your open, scheduled and closed work.", { label: "Tasks", to: "/tasks" }],
    [["notification", "notifications", "alert", "alerts"], "Your alerts are in Notifications.", { label: "Notifications", to: "/notifications" }],
    [["announcement", "announcements", "company news", "news"], "Company announcements are under Announcements.", { label: "Announcements", to: "/announcements" }],
    [["message", "messages", "chat", "dm"], "Use Messages to chat with colleagues.", { label: "Messages", to: "/chat" }],
    [["document", "documents", "letter", "letters", "offer letter", "forms", "form"], "Documents holds your letters, forms and requests.", { label: "Documents", to: "/documents" }],
    [["password", "change password", "reset password", "login", "log in", "sign in"], "Change your password from the profile menu, or use Forgot password on the sign-in page. I never see or share passwords.", { label: "Help", to: "/help" }],
    [["onboarding", "new joiner", "day 0", "joining"], "Onboarding tracks joiner checklists.", { label: "Onboarding", to: "/onboarding" }],
    [["skill", "skills", "skill gap", "capacity"], "Your skills and targets are in Skills.", { label: "Skills", to: "/skills" }],
    [["help", "hr request", "support", "ticket", "faq", "raise a ticket"], "Raise a ticket or browse FAQs in Help.", { label: "Help", to: "/help" }],
  ];
  for (const [words, summary, link] of pointers) if (hasWord(q, words)) return { kind: "text", summary, links: [link] };

  // "who is <name>" / "<name>" — only when the name matches someone.
  const who = q.match(/^(?:who is|whos|who s|find|look up|lookup|show me|show)\s+([a-z][a-z ]{1,40})$/)?.[1]?.trim();
  if (who && !/^(?:my|on|in|out|off|the|this|that|it|available|free|online)\b/.test(who)) {
    const found = personSummaryAnswer(who, ctx, true);
    if (found) return found;
  }

  return {
    kind: "text",
    summary: "I can't answer that from your portal data. I can help with leave, holidays, payslips, approvals, timesheet, goals, learning and your team.",
    links: [{ label: "Help", to: "/help" }],
  };
}
