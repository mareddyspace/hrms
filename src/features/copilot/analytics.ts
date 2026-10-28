/**
 * Plain-language analytics for Copilot: "headcount by country", "attrition by department",
 * "how many joined this quarter", "who hasn't finished mandatory training", "overtime by location",
 * "leave taken by department this month". Rule-based over the same stores the dashboards read.
 * HR, executives and admins see company-wide numbers; managers see their own reporting line only.
 */
import type { CopilotAnswer } from "../../data/platformData.ts";
import type { PersonRecord } from "../../data/peopleData.ts";
import { getExitDetails } from "../../data/peopleLocal.ts";
import { shiftFor } from "../../data/hrAnalytics.ts";
import { buildAttendanceHistory, type AttendanceCorrection, type TodaySession } from "../../data/attendanceData.ts";
import { COURSES, type Enrollment } from "../../data/talentData.ts";
import { addDaysISO, holidaySet, holidaysForPerson, parseISODate, toISO, workingDays, type PortalState } from "../../model.ts";
import { monthIn } from "./normalize.ts";

export type AnalyticsScope = "org" | "team" | "none";

export interface AnalyticsSources {
  today: string;
  scope: AnalyticsScope;
  viewerId: string;
  /** Whole directory; trimmed to the viewer's scope here. */
  people: readonly PersonRecord[];
  /** People below the viewer in the reporting line. */
  teamIds: ReadonlySet<string>;
  state: Pick<PortalState, "holidays" | "leaveRequests" | "absences">;
  attendance: { sessions: TodaySession[]; corrections: AttendanceCorrection[] };
  enrollments: readonly Enrollment[];
}

type Metric = "headcount" | "attrition" | "joiners" | "training" | "overtime" | "late" | "leave";
type Dim = "country" | "department" | "location" | "grade" | "gender" | "type" | "tenure" | "person" | "course";
type Period = { from: string; to: string; label: string };

const DIM_LABEL: Record<Dim, string> = {
  country: "Country",
  department: "Department",
  location: "Location",
  grade: "Grade",
  gender: "Gender",
  type: "Employment type",
  tenure: "Tenure",
  person: "Person",
  course: "Course",
};

const WFH = new Set(["wfh", "emergency_wfh"]);
const MAX_HISTORY_DAYS = 92;
const MAX_SAMPLE = 200;

/** Lower case, apostrophes dropped, punctuation to spaces — keeps the words people typed. */
export function plainText(question: string): string {
  return ` ${question
    .toLowerCase()
    .replace(/[’`']/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
}

const has = (q: string, words: readonly string[]) => words.some((w) => q.includes(` ${w} `));

function metricIn(q: string, dim: Dim | null): Metric | null {
  const selfOnly = has(q, ["my", "i", "me", "mine"]) && !has(q, ["team", "my team", "reports", "department", "company", "org", "organisation", "organization", "everyone", "who"]);
  if (selfOnly && !dim) return null;
  if (has(q, ["overtime", "extra hours", "ot hours"])) return "overtime";
  if (has(q, ["late arrivals", "late arrival", "late check ins", "late check in", "latecomers", "late comers", "came late", "arrived late", "late logins"])) return "late";
  const trainingWord = has(q, ["training", "trainings", "course", "courses", "learning", "certification", "certifications"]);
  if (trainingWord && (has(q, ["mandatory", "compulsory", "required", "compliance"]) || dim) && (has(q, ["who", "hasnt", "havent", "not", "pending", "incomplete", "overdue", "outstanding", "yet", "finished", "completed", "completion", "done"]) || dim)) {
    return "training";
  }
  if (has(q, ["attrition", "turnover", "exits", "exit", "leavers", "resignations", "resigned", "churn", "left the company", "left"]) && !has(q, ["leave balance", "days left", "left in"])) return "attrition";
  if (has(q, ["joined", "joiners", "new joiners", "joinees", "new hires", "hires", "onboarded", "started"]) && !has(q, ["when i joined", "when did i join", "i joined"])) return "joiners";
  const leaveWord = has(q, ["leave", "leaves", "absence", "absences", "time off", "pto", "sick leave", "vacation"]);
  if (leaveWord && (dim || has(q, ["taken", "used", "took", "usage", "days"])) && (dim || has(q, ["team", "department", "departments", "company", "org", "everyone", "country", "location"])) && !has(q, ["balance", "who is on", "whos on", "who is off", "on leave today", "on leave this week"])) {
    return "leave";
  }
  if (dim && has(q, ["headcount", "head count", "how many people", "how many employees", "number of employees", "number of people", "employees", "people", "staff", "workforce", "team size"])) return "headcount";
  return null;
}

function dimIn(q: string, scope: AnalyticsScope): Dim | null {
  const m = q.match(/ (?:by|per|across|each|split by|broken down by|grouped by|which|what) (countries|country|departments|department|dept|depts|teams|team|locations|location|offices|office|sites|site|cities|city|grades|grade|levels|level|genders|gender|employment type|contract type|type|tenure|person|people|employee|employees|course|courses) /);
  if (!m) return null;
  const w = m[1];
  if (w.startsWith("countr")) return "country";
  if (w.startsWith("dep")) return "department";
  if (w.startsWith("team")) return scope === "team" ? "person" : "department";
  if (/^(location|office|site|cit)/.test(w)) return "location";
  if (/^(grade|level)/.test(w)) return "grade";
  if (w.startsWith("gender")) return "gender";
  if (/type/.test(w)) return "type";
  if (w === "tenure") return "tenure";
  if (w.startsWith("course")) return "course";
  return "person";
}

/* ───────────── periods ───────────── */

const fmt = (iso: string) => parseISODate(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const span = (from: string, to: string) => (from === to ? fmt(from) : `${fmt(from)} – ${fmt(to)}`);

function monthRange(year: number, month0: number): { from: string; to: string } {
  return { from: toISO(new Date(year, month0, 1)), to: toISO(new Date(year, month0 + 1, 0)) };
}

function periodIn(q: string, today: string, fallback: "ytd" | "month" | "30d"): Period & { stated: boolean } {
  const d = parseISODate(today);
  const y = d.getFullYear();
  const m0 = d.getMonth();
  const min = (a: string, b: string) => (a < b ? a : b);
  const make = (from: string, to: string, label: string, stated = true) => ({ from, to: min(to, today), label: `${label} (${span(from, min(to, today))})`, stated });
  if (has(q, ["today"])) return make(today, today, "Today");
  if (has(q, ["yesterday"])) return make(addDaysISO(today, -1), addDaysISO(today, -1), "Yesterday");
  const monday = addDaysISO(today, d.getDay() === 0 ? -6 : 1 - d.getDay());
  if (has(q, ["this week"])) return make(monday, today, "This week");
  if (has(q, ["last week", "previous week"])) return make(addDaysISO(monday, -7), addDaysISO(monday, -1), "Last week");
  if (has(q, ["this month", "month to date", "mtd", "current month"])) return make(monthRange(y, m0).from, today, "This month");
  if (has(q, ["last month", "previous month"])) {
    const r = monthRange(y, m0 - 1);
    return make(r.from, r.to, "Last month");
  }
  const qStart = Math.floor(m0 / 3) * 3;
  if (has(q, ["this quarter", "quarter to date", "qtd", "current quarter"])) return make(toISO(new Date(y, qStart, 1)), today, "This quarter");
  if (has(q, ["last quarter", "previous quarter"])) return make(toISO(new Date(y, qStart - 3, 1)), toISO(new Date(y, qStart, 0)), "Last quarter");
  if (has(q, ["last year", "previous year"])) return make(`${y - 1}-01-01`, `${y - 1}-12-31`, "Last year");
  if (has(q, ["this year", "ytd", "year to date", "so far this year", "current year"])) return make(`${y}-01-01`, today, "Year to date");
  const lastN = q.match(/ (?:last|past|previous) (\d{1,3}) (day|days|week|weeks|month|months) /);
  if (lastN) {
    const n = Number(lastN[1]);
    const days = lastN[2].startsWith("day") ? n : lastN[2].startsWith("week") ? n * 7 : n * 30;
    return make(addDaysISO(today, -(Math.max(1, days) - 1)), today, `Last ${n} ${lastN[2]}`);
  }
  const month = monthIn(q.trim());
  if (month) {
    const year = month - 1 > m0 ? y - 1 : y;
    const r = monthRange(year, month - 1);
    return make(r.from, r.to, parseISODate(r.from).toLocaleDateString("en-GB", { month: "long", year: "numeric" }));
  }
  if (fallback === "month") return { ...make(monthRange(y, m0).from, today, "This month"), stated: false };
  if (fallback === "30d") return { ...make(addDaysISO(today, -29), today, "Last 30 days"), stated: false };
  return { ...make(`${y}-01-01`, today, "Year to date"), stated: false };
}

/** "This month (1 Oct – 28 Oct)" → "this month"; "Last 30 days" → "in the last 30 days"; "October 2026" → "in October 2026". */
function when(label: string): string {
  const core = label.split(" (")[0];
  if (core === "Year to date") return "so far this year";
  if (/^(This|Last|Today|Yesterday)\b/.test(core) && !/^Last \d/.test(core)) return core.toLowerCase();
  return `in ${/^Last \d/.test(core) ? "the " + core.toLowerCase() : core}`;
}

/* ───────────── grouping ───────────── */

function tenureBand(joined: string, today: string): string {
  if (!joined) return "Not set";
  const years = (parseISODate(today).getTime() - parseISODate(joined).getTime()) / (365.25 * 86_400_000);
  if (years < 1) return "< 1 yr";
  if (years < 3) return "1–3 yrs";
  if (years < 5) return "3–5 yrs";
  return "5+ yrs";
}

function keyOf(p: PersonRecord, dim: Dim, today: string): string {
  switch (dim) {
    case "country":
      return p.countryName || String(p.countryCode) || "Not set";
    case "department":
      return p.department || "Not set";
    case "location":
      return p.location || "Not set";
    case "grade":
      return p.grade || "Not set";
    case "gender":
      return p.gender || "Not set";
    case "type":
      return p.employmentType || "Not set";
    case "tenure":
      return tenureBand(p.dateOfJoining, today);
    default:
      return p.fullName;
  }
}

type Row = { label: string; value: number; extra?: string[] };

/** Top rows by value; the rest folded into "Other". */
function topRows(rows: Row[], limit = 12): Row[] {
  const sorted = [...rows].sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  if (sorted.length <= limit) return sorted;
  const rest = sorted.slice(limit - 1);
  const extra = rest.every((r) => r.extra?.length) ? [String(rest.reduce((n, r) => n + Number(r.extra?.[0] ?? 0), 0))] : undefined;
  return [...sorted.slice(0, limit - 1), { label: `Other (${rest.length})`, value: Number(rest.reduce((n, r) => n + r.value, 0).toFixed(1)), extra }];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const round1 = (n: number) => Math.round(n * 10) / 10;

/* ───────────── filters from the question ───────────── */

const COUNTRY_ALIASES: Record<string, string[]> = {
  "United States": ["us", "usa", "america", "united states"],
  "United Kingdom": ["uk", "britain", "united kingdom", "england"],
  "United Arab Emirates": ["uae", "emirates", "dubai", "united arab emirates"],
  "Saudi Arabia": ["ksa", "saudi", "saudi arabia"],
};

function countryFilter(q: string, people: readonly PersonRecord[]): string | null {
  const names = [...new Set(people.map((p) => p.countryName).filter(Boolean))];
  for (const name of names) {
    const words = [name.toLowerCase(), ...(COUNTRY_ALIASES[name] ?? [])];
    if (words.some((w) => q.includes(` in ${w} `) || q.includes(` for ${w} `) || q.includes(` ${w} `) && w.length > 3)) return name;
  }
  return null;
}

function departmentFilter(q: string, people: readonly PersonRecord[]): string | null {
  const names = [...new Set(people.map((p) => p.department).filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const name of names) {
    const w = name.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    if (q.includes(` in ${w} `) || q.includes(` for ${w} `) || q.includes(` within ${w} `) || (w.length > 4 && q.includes(` ${w} team `))) return name;
  }
  return null;
}

/* ───────────── the answer ───────────── */

/** Returns null when the question is not an analytics question. */
/** True for a numbers question ("headcount by country", "overtime by location this month"). */
export function isAnalyticsQuestion(question: string): boolean {
  const q = plainText(question);
  return metricIn(q, dimIn(q, "org")) != null;
}

export function analyticsAnswer(question: string, src: AnalyticsSources): CopilotAnswer | null {
  const q = plainText(question);
  const dimAsked = dimIn(q, src.scope === "team" ? "team" : "org");
  const metric = metricIn(q, dimAsked);
  if (!metric) return null;

  if (src.scope === "none" || (src.scope === "team" && src.teamIds.size === 0)) {
    return {
      kind: "text",
      denied: src.scope === "none",
      summary:
        src.scope === "none"
          ? "Team and company numbers aren't available with your access. I can answer questions about your own records."
          : "Nobody reports to you, so there are no team numbers to show. I can answer questions about your own records.",
      links: [{ label: "Help", to: "/help" }],
    };
  }

  const today = src.today;
  const org = src.scope === "org";
  const country = countryFilter(q, src.people);
  const dept = dimAsked === "department" ? null : departmentFilter(q, src.people);
  const inScope = (p: PersonRecord) =>
    (org || src.teamIds.has(p.id) || (p.employmentStatus === "Terminated" && p.managerId === src.viewerId)) &&
    (!country || p.countryName === country) &&
    (!dept || p.department === dept);
  const scoped = src.people.filter(inScope);
  const active = scoped.filter((p) => p.employmentStatus !== "Terminated");
  const defaultDim: Dim = org ? "department" : "person";
  const filters: string[] = [org ? "Scope: whole company" : `Scope: your team (${src.teamIds.size} ${src.teamIds.size === 1 ? "person" : "people"})`];
  if (country) filters.push(`Country: ${country}`);
  if (dept) filters.push(`Department: ${dept}`);
  const links: { label: string; to: string }[] = org ? [{ label: "Analytics", to: "/analytics" }] : [{ label: "Team", to: "/team" }];
  const where = `${country ? ` in ${country}` : ""}${dept ? ` in ${dept}` : ""}${org ? "" : " in your team"}`;

  const finish = (answer: Omit<CopilotAnswer, "kind">, extraLinks: { label: string; to: string }[] = []): CopilotAnswer => ({
    kind: answer.table ? "table" : "text",
    ...answer,
    filters: [...filters, ...(answer.filters ?? [])],
    links: [...extraLinks, ...links],
  });

  /* Headcount */
  if (metric === "headcount") {
    const dim = dimAsked ?? defaultDim;
    const counts = new Map<string, number>();
    for (const p of active) counts.set(keyOf(p, dim, today), (counts.get(keyOf(p, dim, today)) ?? 0) + 1);
    const rows = topRows([...counts.entries()].map(([label, value]) => ({ label, value })));
    const total = active.length;
    const top = rows[0];
    return finish({
      summary: total
        ? `${plural(total, "active person", "active people")}${where}, across ${plural(counts.size, DIM_LABEL[dim].toLowerCase(), dim === "country" ? "countries" : `${DIM_LABEL[dim].toLowerCase()}s`)}. The largest is ${top.label} with ${top.value} (${Math.round((top.value / total) * 100)}%).`
        : `Nobody matches${where}.`,
      table: rows.length ? { headers: [DIM_LABEL[dim], "People", "Share"], rows: rows.map((r) => [r.label, String(r.value), `${Math.round((r.value / total) * 100)}%`]) } : undefined,
      chart: rows.length ? { title: `Headcount by ${DIM_LABEL[dim].toLowerCase()}`, bars: rows.map((r) => ({ label: r.label, value: r.value })) } : undefined,
      filters: [`Grouped by: ${DIM_LABEL[dim]}`, "Active people today"],
    });
  }

  /* Attrition */
  if (metric === "attrition") {
    const dim = dimAsked && dimAsked !== "person" ? dimAsked : "department";
    const period = periodIn(q, today, "ytd");
    const exits = scoped
      .filter((p) => p.employmentStatus === "Terminated")
      .map((p) => ({ p, exitDate: getExitDetails(p).exitDate ?? "" }))
      .filter((x) => x.exitDate && x.exitDate >= period.from && x.exitDate <= period.to);
    const groups = new Map<string, { exits: number; active: number }>();
    for (const p of active) {
      const k = keyOf(p, dim, today);
      groups.set(k, { exits: groups.get(k)?.exits ?? 0, active: (groups.get(k)?.active ?? 0) + 1 });
    }
    for (const { p } of exits) {
      const k = keyOf(p, dim, today);
      groups.set(k, { exits: (groups.get(k)?.exits ?? 0) + 1, active: groups.get(k)?.active ?? 0 });
    }
    const rate = (e: number, a: number) => (e + a ? round1((e / (e + a)) * 100) : 0);
    const rows = [...groups.entries()]
      .map(([label, g]) => ({ label, ...g, rate: rate(g.exits, g.active) }))
      .sort((a, b) => b.exits - a.exits || b.rate - a.rate)
      .slice(0, 12);
    const withExits = rows.filter((r) => r.exits > 0);
    const overall = rate(exits.length, active.length);
    return finish({
      summary: exits.length
        ? `${plural(exits.length, "exit")}${where} ${when(period.label)}, ${overall}% of headcount. Highest: ${withExits[0].label} with ${withExits[0].exits} (${withExits[0].rate}%).`
        : `No exits${where} ${when(period.label)}.`,
      table: rows.length ? { headers: [DIM_LABEL[dim], "Exits", "Active now", "Attrition"], rows: rows.map((r) => [r.label, String(r.exits), String(r.active), `${r.rate}%`]) } : undefined,
      chart: withExits.length ? { title: `Exits by ${DIM_LABEL[dim].toLowerCase()}`, bars: withExits.map((r) => ({ label: r.label, value: r.exits })) } : undefined,
      filters: [`Period: ${period.label}`, `Grouped by: ${DIM_LABEL[dim]}`, "Attrition = exits ÷ (active + exits)"],
    });
  }

  /* Joiners */
  if (metric === "joiners") {
    const dim = dimAsked && dimAsked !== "person" ? dimAsked : "department";
    const period = periodIn(q, today, "ytd");
    const joined = scoped
      .filter((p) => p.dateOfJoining && p.dateOfJoining >= period.from && p.dateOfJoining <= period.to)
      .sort((a, b) => b.dateOfJoining.localeCompare(a.dateOfJoining));
    const counts = new Map<string, number>();
    for (const p of joined) counts.set(keyOf(p, dim, today), (counts.get(keyOf(p, dim, today)) ?? 0) + 1);
    const bars = topRows([...counts.entries()].map(([label, value]) => ({ label, value })), 8);
    const stillHere = joined.filter((p) => p.employmentStatus !== "Terminated").length;
    return finish({
      summary: joined.length
        ? `${plural(joined.length, "person", "people")} joined${where} ${when(period.label)}${stillHere < joined.length ? ` (${joined.length - stillHere} since left)` : ""}. Most went to ${bars[0].label} (${bars[0].value}).`
        : `Nobody joined${where} ${when(period.label)}.`,
      table: joined.length
        ? {
            headers: ["Name", "Department", "Country", "Joined"],
            rows: joined.slice(0, 15).map((p) => [p.fullName, p.department || "—", p.countryName || String(p.countryCode), fmt(p.dateOfJoining)]),
          }
        : undefined,
      chart: bars.length ? { title: `Joiners by ${DIM_LABEL[dim].toLowerCase()}`, bars: bars.map((r) => ({ label: r.label, value: r.value })) } : undefined,
      filters: [`Period: ${period.label}`, `Chart grouped by: ${DIM_LABEL[dim]}`, ...(joined.length > 15 ? [`Table shows 15 of ${joined.length}`] : [])],
    });
  }

  /* Mandatory training */
  if (metric === "training") {
    const mandatory = new Map(COURSES.filter((c) => c.mandatory).map((c) => [c.id, c.title]));
    const byId = new Map(active.map((p) => [p.id, p]));
    const open = src.enrollments
      .filter((e) => mandatory.has(e.courseId) && e.status !== "Completed" && byId.has(e.employeeId))
      .map((e) => ({ e, p: byId.get(e.employeeId)!, overdue: Boolean(e.due && e.due < today) }))
      .sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.e.due ?? "9999").localeCompare(b.e.due ?? "9999"));
    const assigned = src.enrollments.filter((e) => mandatory.has(e.courseId) && byId.has(e.employeeId));
    const people = new Set(open.map((x) => x.p.id));
    const overdue = open.filter((x) => x.overdue).length;
    const dim: Dim = dimAsked ?? (org ? "department" : "course");
    const counts = new Map<string, Set<string>>();
    for (const x of open) {
      const k = dim === "course" ? mandatory.get(x.e.courseId) ?? "Course" : keyOf(x.p, dim, today);
      counts.set(k, (counts.get(k) ?? new Set()).add(x.p.id));
    }
    const bars = topRows([...counts.entries()].map(([label, set]) => ({ label, value: set.size })), 8);
    const donePct = assigned.length ? Math.round(((assigned.length - open.length) / assigned.length) * 100) : 100;
    return finish(
      {
        summary: open.length
          ? `${plural(people.size, "person", "people")}${where} still ${people.size === 1 ? "has" : "have"} mandatory training open — ${plural(open.length, "course")}, ${overdue} overdue. ${donePct}% of assigned mandatory courses are done.`
          : assigned.length
            ? `Everyone${where} has finished their mandatory training (${assigned.length} assigned courses).`
            : `No mandatory courses are assigned${where}.`,
        table: open.length
          ? {
              headers: ["Person", "Course", "Status", "Due"],
              rows: open.slice(0, 15).map((x) => [x.p.fullName, mandatory.get(x.e.courseId) ?? "Course", `${x.e.status} · ${x.e.progress}%`, x.e.due ? `${fmt(x.e.due)}${x.overdue ? " · overdue" : ""}` : "—"]),
            }
          : undefined,
        chart: bars.length ? { title: `People with open mandatory training by ${DIM_LABEL[dim].toLowerCase()}`, bars: bars.map((r) => ({ label: r.label, value: r.value })) } : undefined,
        filters: ["Mandatory courses only", "Assigned courses not completed", ...(open.length > 15 ? [`Table shows 15 of ${open.length}`] : [])],
      },
      [{ label: "Learning", to: "/programs" }],
    );
  }

  /* Leave taken */
  if (metric === "leave") {
    const dim = dimAsked ?? defaultDim;
    const period = periodIn(q, today, "month");
    const byId = new Map(active.map((p) => [p.id, p]));
    const groups = new Map<string, { days: number; people: Set<string> }>();
    let total = 0;
    for (const r of src.state.leaveRequests) {
      if (r.status !== "approved" || WFH.has(r.code)) continue;
      const p = byId.get(r.employeeId);
      if (!p) continue;
      const from = r.from > period.from ? r.from : period.from;
      const to = r.to < period.to ? r.to : period.to;
      if (from > to) continue;
      let days = workingDays(from, to, holidaySet(holidaysForPerson(src.state.holidays, p.id)), shiftFor(p).offs);
      if (r.half && r.from === r.to) days = Math.min(days, 0.5);
      if (!days) continue;
      total += days;
      const k = keyOf(p, dim, today);
      const g = groups.get(k) ?? { days: 0, people: new Set<string>() };
      g.days += days;
      g.people.add(p.id);
      groups.set(k, g);
    }
    const rows = topRows([...groups.entries()].map(([label, g]) => ({ label, value: round1(g.days), extra: [String(g.people.size)] })));
    const takers = new Set([...groups.values()].flatMap((g) => [...g.people])).size;
    return finish(
      {
        summary: total
          ? `${round1(total)} leave ${round1(total) === 1 ? "day" : "days"} taken${where} ${when(period.label)}, by ${plural(takers, "person", "people")}. Most: ${rows[0].label} (${rows[0].value} ${rows[0].value === 1 ? "day" : "days"}).`
          : `No approved leave${where} ${when(period.label)}.`,
        table: rows.length ? { headers: [DIM_LABEL[dim], "Days", ...(dim === "person" ? [] : ["People"])], rows: rows.map((r) => [r.label, String(r.value), ...(dim === "person" ? [] : [r.extra?.[0] ?? "—"])]) } : undefined,
        chart: rows.length ? { title: `Leave days by ${DIM_LABEL[dim].toLowerCase()}`, unit: "d", bars: rows.slice(0, 8).map((r) => ({ label: r.label, value: r.value })) } : undefined,
        filters: [`Period: ${period.label}`, `Grouped by: ${DIM_LABEL[dim]}`, "Approved leave, working days, WFH excluded"],
      },
      [{ label: "Leave", to: "/leave" }],
    );
  }

  /* Overtime / late arrivals — from attendance history */
  const dim = dimAsked ?? defaultDim;
  const period = periodIn(q, today, "30d");
  const from = period.from < addDaysISO(period.to, -(MAX_HISTORY_DAYS - 1)) ? addDaysISO(period.to, -(MAX_HISTORY_DAYS - 1)) : period.from;
  const first = new Set([src.viewerId, ...src.teamIds]);
  const sample = [...active.filter((p) => first.has(p.id)), ...active.filter((p) => !first.has(p.id))].slice(0, MAX_SAMPLE);
  const groups = new Map<string, { value: number; people: Set<string> }>();
  let total = 0;
  for (const p of sample) {
    const shift = shiftFor(p);
    const rows = buildAttendanceHistory({
      employeeId: p.id,
      employeeName: p.fullName,
      from,
      to: period.to,
      holidays: holidaysForPerson(src.state.holidays, p.id),
      leaveRequests: src.state.leaveRequests,
      absences: src.state.absences,
      shiftHours: shift.hours,
      corrections: src.attendance.corrections,
      weeklyOffDays: shift.offs,
      sessions: src.attendance.sessions,
    });
    const value = metric === "overtime" ? rows.reduce((n, r) => n + Math.max(0, r.overtimeMinutes), 0) / 60 : rows.filter((r) => r.checkIn && r.lateMinutes > 0).length;
    if (!value) continue;
    total += value;
    const k = keyOf(p, dim, today);
    const g = groups.get(k) ?? { value: 0, people: new Set<string>() };
    g.value += value;
    g.people.add(p.id);
    groups.set(k, g);
  }
  const rows = topRows([...groups.entries()].map(([label, g]) => ({ label, value: round1(g.value), extra: [String(g.people.size)] })));
  const affected = new Set([...groups.values()].flatMap((g) => [...g.people])).size;
  const periodText = when(period.label);
  const sampleNote = [
    `Period: ${from === period.from ? period.label : `${span(from, period.to)} (longest history shown is ${MAX_HISTORY_DAYS} days)`}`,
    `Grouped by: ${DIM_LABEL[dim]}`,
    ...(active.length > sample.length ? [`Based on ${sample.length} of ${active.length} people`] : []),
  ];
  if (metric === "overtime") {
    return finish(
      {
        summary: total
          ? `${round1(total)} hours of overtime${where} ${periodText}, from ${plural(affected, "person", "people")}. Most: ${rows[0].label} (${rows[0].value} h).`
          : `No overtime recorded${where} ${periodText}.`,
        table: rows.length ? { headers: [DIM_LABEL[dim], "Overtime (h)", ...(dim === "person" ? [] : ["People"])], rows: rows.map((r) => [r.label, String(r.value), ...(dim === "person" ? [] : [r.extra?.[0] ?? "—"])]) } : undefined,
        chart: rows.length ? { title: `Overtime hours by ${DIM_LABEL[dim].toLowerCase()}`, unit: "h", bars: rows.slice(0, 8).map((r) => ({ label: r.label, value: r.value })) } : undefined,
        filters: [...sampleNote, "Time worked beyond the shift"],
      },
      [{ label: "Attendance", to: "/attendance" }],
    );
  }
  return finish(
    {
      summary: total
        ? `${plural(total, "late arrival")}${where} ${periodText}, by ${plural(affected, "person", "people")}. Most: ${rows[0].label} (${rows[0].value}).`
        : `No late arrivals${where} ${periodText}.`,
      table: rows.length ? { headers: [DIM_LABEL[dim], "Late days", ...(dim === "person" ? [] : ["People"])], rows: rows.map((r) => [r.label, String(r.value), ...(dim === "person" ? [] : [r.extra?.[0] ?? "—"])]) } : undefined,
      chart: rows.length ? { title: `Late arrivals by ${DIM_LABEL[dim].toLowerCase()}`, bars: rows.slice(0, 8).map((r) => ({ label: r.label, value: r.value })) } : undefined,
      filters: [...sampleNote, "Check-in after shift start"],
    },
    [{ label: "Attendance", to: "/attendance" }],
  );
}
