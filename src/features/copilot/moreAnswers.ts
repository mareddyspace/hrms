/**
 * More rule-based Copilot answers, from the extra data in moreContext.ts: profile facts, upcoming leave, colleagues'
 * directory cards (who reports to whom), department heads, attendance today / this month, tasks and tickets, tax
 * declarations, trips and advances, the next pay date and "where do I ..." navigation.
 *
 * Two entry points so the existing rules keep their questions:
 * - earlyAnswer: narrow questions that older rules would misread ("when did I join" is not onboarding,
 *   "who does Priya report to" is a directory fact, not someone else's private data).
 * - lateAnswer: attendance, after the leave and holiday rules.
 */
import type { CopilotContext } from "../../data/platformData.ts";
import type { CopilotContextMore, CopilotMore, DirectoryCard } from "./moreContext.ts";
import { hasWord } from "./normalize.ts";
import type { RawCopilotAnswer } from "./answers.ts";

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const date = new Date(y, (m ?? 1) - 1, d ?? 1);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function hm(iso?: string): string {
  if (!iso) return "—";
  if (/^\d{1,2}:\d{2}/.test(iso)) return iso.slice(0, 5);
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${currency} ${Math.round(amount)}`;
  }
}

function yearsSince(iso: string, today: string): string {
  const [y1, m1, d1] = iso.split("-").map(Number);
  const [y2, m2, d2] = today.split("-").map(Number);
  let months = (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0);
  months = Math.max(0, months);
  const y = Math.floor(months / 12);
  const m = months % 12;
  return [y ? `${y} year${y === 1 ? "" : "s"}` : "", m ? `${m} month${m === 1 ? "" : "s"}` : ""].filter(Boolean).join(" ") || "less than a month";
}

const list = (xs: string[], max = 8) => (xs.length > max ? `${xs.slice(0, max).join(", ")} and ${xs.length - max} more` : xs.join(", "));

function moreOf(ctx: CopilotContext): CopilotMore | undefined {
  return (ctx as CopilotContextMore).more;
}

/* —— "where do I …" —— */

/** Page, label and the words that point to it. Links the viewer can't open are dropped by answerCopilot. */
const PAGES: { to: string; label: string; words: string[] }[] = [
  { to: "/leave", label: "Leave", words: ["leave", "leaves", "time off", "pto", "vacation", "wfh", "work from home", "comp off"] },
  { to: "/holidays", label: "Holiday calendar", words: ["holiday", "holidays", "holiday calendar"] },
  { to: "/workforce/optional-holidays", label: "Optional holidays", words: ["optional holiday", "optional holidays", "floating holiday"] },
  { to: "/attendance", label: "Attendance", words: ["attendance", "check in", "check out", "punch", "clock in", "attendance correction", "regularise", "regularize"] },
  { to: "/timesheet", label: "Timesheet", words: ["timesheet", "timesheets", "log hours", "hours"] },
  { to: "/payslips", label: "My payslips", words: ["payslip", "payslips", "salary slip", "pay slip", "tax regime", "form 16"] },
  { to: "/investment", label: "Tax declarations", words: ["tax declaration", "tax declarations", "investment proof", "investment proofs", "80c", "80d", "hra", "declare"] },
  { to: "/benefits", label: "Benefits", words: ["benefit", "benefits", "insurance", "dependent", "dependents", "beneficiary", "nominee", "enrol", "enroll"] },
  { to: "/expenses", label: "Reimbursements", words: ["expense", "expenses", "reimbursement", "reimbursements", "claim", "claims", "receipt", "bill"] },
  { to: "/travel", label: "Travel", words: ["travel", "trip", "trips", "flight", "hotel", "business trip"] },
  { to: "/cash", label: "Cash advance", words: ["cash advance", "advance", "salary advance"] },
  { to: "/overtime", label: "Overtime", words: ["overtime", "extra hours"] },
  { to: "/encashment", label: "Leave encashment", words: ["encash", "encashment"] },
  { to: "/documents", label: "Documents & letters", words: ["letter", "letters", "document", "documents", "experience letter", "address proof", "salary certificate", "employment letter", "visa letter"] },
  { to: "/info", label: "My profile", words: ["profile", "address", "phone", "mobile", "emergency contact", "bank details", "bank account", "personal details", "photo", "name change"] },
  { to: "/approvals", label: "Approvals", words: ["approve", "approvals", "approval", "reject"] },
  { to: "/tasks", label: "Tasks", words: ["task", "tasks", "to do", "todo"] },
  { to: "/tickets", label: "Tickets", words: ["ticket", "tickets", "bug", "it support", "access request", "laptop issue"] },
  { to: "/help", label: "Helpdesk", words: ["helpdesk", "help desk", "hr request", "hr query", "faq", "faqs", "support"] },
  { to: "/org-chart", label: "Org chart", words: ["org chart", "reporting line", "reporting tree", "hierarchy"] },
  { to: "/directory", label: "Directory", words: ["directory", "colleague", "colleagues", "find someone", "find a person", "employee search"] },
  { to: "/evaluations", label: "Performance", words: ["goal", "goals", "okr", "review", "appraisal", "self review", "check in with manager", "feedback"] },
  { to: "/programs", label: "Learning", words: ["course", "courses", "training", "learning", "certification", "mandatory training"] },
  { to: "/skills", label: "Skills & career", words: ["skill", "skills", "career", "next role", "career path"] },
  { to: "/internal-jobs", label: "Internal jobs", words: ["internal job", "internal jobs", "job opening", "job openings", "apply for a job", "transfer", "internal move"] },
  { to: "/policies", label: "Policies", words: ["policy", "policies", "handbook", "code of conduct"] },
  { to: "/workforce/shifts", label: "Shifts & roster", words: ["shift", "shifts", "roster", "shift swap", "swap shift"] },
  { to: "/calendar", label: "Calendar", words: ["calendar", "meeting", "meetings", "in person day"] },
  { to: "/assets", label: "Assets", words: ["asset", "assets", "laptop", "monitor", "headset", "equipment"] },
  { to: "/software", label: "Software", words: ["software", "license", "licence", "tool access"] },
  { to: "/me/grievances", label: "Raise a concern", words: ["grievance", "concern", "complaint", "harassment", "whistle", "speak up"] },
  { to: "/me/exit", label: "Resignation", words: ["resign", "resignation", "quit", "notice period", "exit"] },
  { to: "/me/probation", label: "Probation", words: ["probation", "confirmation"] },
  { to: "/me/immigration", label: "Visas & permits", words: ["visa", "visas", "work permit", "immigration"] },
  { to: "/me/privacy", label: "Privacy", words: ["privacy", "my data", "data request", "consent"] },
  { to: "/recognition", label: "Recognition", words: ["kudos", "recognition", "appreciate", "thank a colleague", "reward points"] },
  { to: "/engagement-surveys", label: "Surveys", words: ["survey", "surveys", "pulse"] },
  { to: "/announcements", label: "Announcements", words: ["announcement", "announcements", "company news"] },
  { to: "/chat", label: "Messages", words: ["message", "messages", "chat", "dm"] },
  { to: "/notifications", label: "Notifications", words: ["notification", "notifications", "alerts"] },
  { to: "/settings/security", label: "Security settings", words: ["password", "change password", "two factor", "2fa", "mfa"] },
  { to: "/team", label: "Team", words: ["my team page", "team overview", "team calendar"] },
  { to: "/analytics", label: "Analytics", words: ["analytics", "dashboard", "dashboards", "report", "reports"] },
  { to: "/recruiting", label: "Recruiting", words: ["requisition", "requisitions", "candidate", "candidates", "hiring", "job post", "raise a requisition"] },
  { to: "/onboarding", label: "Onboarding", words: ["onboarding", "new joiner", "joiner checklist"] },
  { to: "/compensation", label: "Compensation", words: ["compensation", "pay band", "salary band", "increment cycle"] },
  { to: "/admin", label: "Administration", words: ["admin console", "administration", "roles and permissions", "ai settings"] },
];

const WHERE = /^where (?:do|can|should|would) i\b|^where (?:is|are|can i find|to)\b|\bhow (?:do|can) i (?:find|get to|open|go to)\b|^(?:which|what) (?:page|screen|menu|tab)\b|\b(?:take me to|navigate to|link to)\b/;

function navigationAnswer(q: string): RawCopilotAnswer | null {
  if (!WHERE.test(q)) return null;
  const hits = PAGES.map((p) => ({ p, n: p.words.filter((w) => hasWord(q, [w])).reduce((a, w) => a + w.length, 0) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 2)
    .map((x) => x.p);
  if (!hits.length) return null;
  return {
    kind: "text",
    summary: hits.length === 1 ? `That's on ${hits[0].label} (${hits[0].to}).` : `Open ${hits[0].label} (${hits[0].to}); ${hits[1].label} (${hits[1].to}) may also help.`,
    links: hits.map((p) => ({ label: p.label, to: p.to })),
  };
}

/* —— profile, people and organisation —— */

const SELF = ["my", "i", "me", "im", "am i", "do i", "did i"];

function profileAnswer(q: string, ctx: CopilotContext, more: CopilotMore): RawCopilotAnswer | null {
  const p = more.profile;
  const today = ctx.today ?? new Date().toISOString().slice(0, 10);
  const links = [{ label: "My profile", to: "/info" }];
  if (!hasWord(q, SELF)) return null;
  if (hasWord(q, ["hired me", "hired by", "who hired", "recruited me", "my recruiter", "my hiring manager", "hiring manager"])) {
    if (!p.hiredBy && !p.hiringManager) return { kind: "text", summary: "Who hired you isn't recorded on your profile. HR can add it.", links };
    return {
      kind: "text",
      summary: `You were hired by ${p.hiredBy ?? "—"}${p.hiringManager ? `; your hiring manager was ${p.hiringManager}` : ""}.`,
      links,
    };
  }
  if (
    hasWord(q, ["when did i join", "joining date", "date of joining", "doj", "start date", "joined", "how long have i", "years of service", "service years", "work anniversary", "my anniversary", "tenure"]) &&
    !hasWord(q, ["team", "who joined", "joiners"])
  ) {
    if (!p.joiningDate) return { kind: "text", summary: "Your joining date is on My profile.", links };
    return { kind: "text", summary: `You joined on ${fmtDate(p.joiningDate)} — ${yearsSince(p.joiningDate, today)} of service.`, links };
  }
  if (hasWord(q, ["employee id", "employee code", "emp id", "staff id", "employee number"])) {
    return { kind: "text", summary: p.employeeCode ? `Your employee ID is ${p.employeeCode}.` : "Your employee ID is on My profile.", links };
  }
  if (hasWord(q, ["where am i based", "where do i work", "my location", "my office", "which office", "where am i located", "my work location", "am i based"]) && !hasWord(q, ["holiday", "holidays"])) {
    return {
      kind: "text",
      summary: `You're based in ${p.location || "—"}${p.country ? `, ${p.country}` : ""}${p.legalEntity ? ` (${p.legalEntity})` : ""}${p.workArrangement ? `; work arrangement: ${p.workArrangement}` : ""}.`,
      links,
    };
  }
  if (hasWord(q, ["my department", "which department", "my designation", "my job title", "my title", "my role", "my grade", "my band", "my level", "my position", "what is my job"])) {
    return {
      kind: "text",
      summary: `You're ${p.designation || "—"} in ${p.department || "—"}${p.grade ? `, grade ${p.grade}` : ""}${ctx.managerName ? `, reporting to ${ctx.managerName}` : ""}.`,
      links,
    };
  }
  if (hasWord(q, ["legal entity", "which entity", "which company am i"])) {
    return { kind: "text", summary: `You're employed by ${p.legalEntity ?? "—"}.`, links };
  }
  return null;
}

function upcomingLeaveAnswer(q: string, ctx: CopilotContext): RawCopilotAnswer | null {
  if (!hasWord(q, ["leave", "leaves", "time off", "pto", "vacation", "wfh", "holiday booked"])) return null;
  if (!hasWord(q, ["upcoming", "planned", "booked", "scheduled", "next leave", "future"]) || !hasWord(q, SELF)) return null;
  const today = ctx.today ?? new Date().toISOString().slice(0, 10);
  const rows = (ctx.myLeave ?? []).filter((r) => r.to >= today && (r.status === "approved" || r.status === "pending")).sort((a, b) => a.from.localeCompare(b.from));
  const links = [{ label: "Leave", to: "/leave" }];
  if (!rows.length) return { kind: "text", summary: "You have no upcoming leave booked (approved or pending).", links };
  return {
    kind: "text",
    summary: `Your upcoming leave: ${rows
      .slice(0, 6)
      .map((r) => `${r.type} ${r.from === r.to ? fmtDate(r.from) : `${fmtDate(r.from)} – ${fmtDate(r.to)}`} (${r.days} day${r.days === 1 ? "" : "s"}, ${r.status})`)
      .join("; ")}.`,
    links,
  };
}

const PERSON_Q =
  /\b(report(?:s|ing)? to|manager|boss|lead(?:s)?|reportees|direct reports|team|department|title|designation|role|job|based|located|location|office|work(?:s)? (?:in|at|as)|join(?:ed)?|joining)\b|^what does [a-z]+(?: [a-z]+)? do$/;
const PRIVATE = ["salary", "pay", "ctc", "payslip", "bonus", "address", "phone", "mobile", "email", "birthday", "date of birth", "dob", "medical", "health", "rating", "appraisal", "performance", "leave", "leaves", "balance", "attendance", "late", "goals", "disciplinary", "grievance", "complaint", "bank"];

function cardLine(c: DirectoryCard): string {
  return `${c.name}${c.self ? " (you)" : ""} is ${c.title || "—"} in ${c.department || "—"}, ${c.location || "—"}${c.country ? ` (${c.country})` : ""}; reports to ${c.manager || "nobody"}; joined ${fmtDate(c.joined)}.`;
}

function directoryAnswer(q: string, question: string, more: CopilotMore): RawCopilotAnswer | null {
  if (!PERSON_Q.test(q) || hasWord(q, PRIVATE)) return null;
  // Questions about the asker's own line are answered elsewhere ("who is my manager", "who reports to me").
  if (/\b(my|me|i)\b/.test(q) && !/\b(does|did|is)\s+(?!my\b|me\b|i\b)[a-z]+\b.*\b(report|manager|join|based|work)/.test(q)) return null;
  const cards = more.findPeople(question).filter((c) => !c.self);
  if (!cards.length) return null;
  const links = [
    { label: "Directory", to: "/directory" },
    { label: "Org chart", to: "/org-chart" },
  ];
  const c = cards[0];
  const others = cards.length > 1 ? ` (Other matches: ${cards.slice(1).map((x) => x.name).join(", ")} — use the full name to pick one.)` : "";
  if (/\b(who reports to|reportees|direct reports|whose team|team of|[a-z]+s team|who works (?:for|under))\b/.test(q)) {
    return {
      kind: "text",
      summary: c.directReports.length
        ? `${c.directReports.length} ${c.directReports.length === 1 ? "person reports" : "people report"} directly to ${c.name}: ${list(c.directReports, 12)}.${others}`
        : `Nobody reports directly to ${c.name}.${others}`,
      links,
    };
  }
  if (/\b(report(?:s|ing)? to|manager|boss)\b/.test(q)) {
    return { kind: "text", summary: `${c.name} reports to ${c.manager || "nobody (top of the line)"}.${others}`, links };
  }
  return { kind: "text", summary: `${cardLine(c)}${others}`, links };
}

function departmentHeadsAnswer(q: string, more: CopilotMore): RawCopilotAnswer | null {
  if (!(/\b(department heads?|heads? of|who heads|who leads|who runs|leader of|leaders)\b/.test(q) || (hasWord(q, ["head", "heads"]) && hasWord(q, ["department", "departments", "team", "function"])))) return null;
  const links = [{ label: "Organization", to: "/organization" }, { label: "Org chart", to: "/org-chart" }];
  if (!more.departmentHeads) return { kind: "text", summary: "Department leaders are shown in the org chart.", links };
  const named = more.departmentHeads.find((d) => q.includes(d.department.toLowerCase()) || q.includes(d.department.toLowerCase().split(" ")[0]));
  if (named) return { kind: "text", summary: `${named.head} heads ${named.department}.`, links };
  return {
    kind: "table",
    summary: `${more.departmentHeads.length} departments.`,
    table: { headers: ["Department", "Head"], rows: more.departmentHeads.map((d) => [d.department, d.head]) },
    links,
  };
}

function lineBreakdownAnswer(q: string, ctx: CopilotContext, more: CopilotMore): RawCopilotAnswer | null {
  if (ctx.orgWide || !more.line) return null;
  if (!hasWord(q, ["headcount", "how many people", "people", "team", "my reports", "my line", "reporting line"]) || !hasWord(q, ["department", "departments", "country", "countries", "location"])) return null;
  const byCountry = hasWord(q, ["country", "countries", "location"]);
  const rows = byCountry ? more.line.byCountry : more.line.byDepartment;
  return {
    kind: "text",
    summary: `Your reporting line by ${byCountry ? "country" : "department"}: ${rows.map((r) => `${r.name} ${r.count}`).join(", ")}. Company-wide numbers need HR or leadership access.`,
    links: [{ label: "Team", to: "/team" }],
  };
}

/* —— own records —— */

function attendanceAnswer(q: string, more: CopilotMore): RawCopilotAnswer | null {
  if (!hasWord(q, ["attendance", "checked in", "check in", "checked out", "check out", "late", "punctual", "present", "absent", "days present", "days absent", "hours worked", "clocked in", "punch", "punched in"])) return null;
  if (hasWord(q, ["how do i", "how to", "correct", "correction", "fix", "forgot", "wrong", "policy", "rule", "rules", "team", "who", "everyone", "by location", "by department", "by person"])) return null;
  const links = [{ label: "Attendance", to: "/attendance" }];
  const t = more.attendanceToday;
  const m = more.attendanceMonth;
  if (hasWord(q, ["today", "now", "am i checked in", "did i check in", "checked in", "checked out", "punched in"]) && !hasWord(q, ["month", "this month"])) {
    const s =
      t.status === "checked in"
        ? `You checked in at ${hm(t.checkIn)} today and haven't checked out yet.`
        : t.status === "checked out"
          ? `You checked in at ${hm(t.checkIn)} and out at ${hm(t.checkOut)} today.`
          : t.status === "not checked in"
            ? "You haven't checked in today."
            : `Today is ${t.status === "on leave" ? "a leave day for you" : `a ${t.status}`}.`;
    return { kind: "text", summary: s, links };
  }
  if (hasWord(q, ["late", "punctual", "late days", "came late"])) {
    return {
      kind: "text",
      summary: m.lateDays.length ? `You were late on ${m.lateDays.length} day${m.lateDays.length === 1 ? "" : "s"} this month: ${list(m.lateDays.map((d) => fmtDate(d)))}.` : "You haven't been late this month.",
      links,
    };
  }
  return {
    kind: "metrics",
    summary: `This month so far: ${m.present} day(s) present, ${m.wfh} WFH, ${m.leave} on leave, ${m.absent} absent, ${m.missing} missing a punch; ${m.hours} h worked, ${m.lateDays.length} late day(s). Today: ${t.status}.`,
    metrics: [
      { label: "Present", value: String(m.present) },
      { label: "Late days", value: String(m.lateDays.length) },
      { label: "Hours", value: String(m.hours) },
      { label: "Absent", value: String(m.absent) },
    ],
    links,
  };
}

function tasksAnswer(q: string, more: CopilotMore): RawCopilotAnswer | null {
  const tickets = hasWord(q, ["ticket", "tickets", "bug", "bugs"]);
  const tasks = hasWord(q, ["task", "tasks", "to do", "todo", "work items"]);
  if (!tickets && !tasks) return null;
  if (hasWord(q, ["how do i", "how to", "create", "raise", "new", "where"])) return null;
  if (tickets) {
    const t = more.ticketsOwned;
    return {
      kind: "text",
      summary: t.length
        ? `You own ${t.length} open ticket${t.length === 1 ? "" : "s"}: ${t.slice(0, 6).map((x) => `${x.id} ${x.title} (${x.status}, ${x.priority}${x.due ? `, due ${fmtDate(x.due)}` : ""})`).join("; ")}. You raised ${more.ticketsRaised} that are still open.`
        : `No open tickets are assigned to you. You raised ${more.ticketsRaised} that are still open.`,
      links: [{ label: "Tickets", to: "/tickets" }],
    };
  }
  const t = more.tasks;
  const status: Record<string, string> = { open: "open", progress: "in progress", scheduled: "scheduled" };
  return {
    kind: "text",
    summary: t.length
      ? `You have ${t.length} open task${t.length === 1 ? "" : "s"}: ${t.slice(0, 6).map((x) => `${x.code} ${x.subject} (${status[x.status] ?? x.status}${x.due ? `, due ${fmtDate(x.due)}` : ""})`).join("; ")}.`
      : "You have no open tasks.",
    links: [{ label: "Tasks", to: "/tasks" }],
  };
}

function taxAnswer(q: string, more: CopilotMore): RawCopilotAnswer | null {
  if (!hasWord(q, ["tax declaration", "tax declarations", "investment proof", "investment proofs", "proofs", "80c", "80d", "hra", "declaration", "declarations", "declared"])) return null;
  if (hasWord(q, ["how do i", "how to", "policy", "rule", "rules", "where"])) return null;
  const rows = more.tax;
  const links = [{ label: "Tax declarations", to: "/investment" }];
  if (!rows.length) return { kind: "text", summary: "You haven't declared anything yet.", links };
  const fy = rows.map((r) => r.fy).sort().pop()!;
  const cur = rows.filter((r) => r.fy === fy);
  return {
    kind: "text",
    summary: `${fy}: ${cur.map((r) => `${r.section} ${r.title} ${money(r.amount, r.currency)} (${r.status})`).join("; ")}.`,
    links,
  };
}

function tripsAnswer(q: string, more: CopilotMore): RawCopilotAnswer | null {
  const trip = hasWord(q, ["trip", "trips", "travel", "travel request", "business trip"]);
  const adv = hasWord(q, ["cash advance", "cash advances", "salary advance", "my advance", "my advances"]);
  if (!trip && !adv) return null;
  if (hasWord(q, ["how do i", "how to", "policy", "rule", "rules", "limit", "limits", "where", "allowance", "per diem"])) return null;
  if (adv && !trip) {
    const a = more.cashAdvances;
    return {
      kind: "text",
      summary: a.length ? `Your cash advances: ${a.slice(0, 5).map((x) => `${x.category} ${money(x.amount, x.currency)} (${x.status})`).join("; ")}.` : "You have no cash advances.",
      links: [{ label: "Cash advance", to: "/cash" }],
    };
  }
  const t = more.trips;
  return {
    kind: "text",
    summary: t.length ? `Your travel requests: ${t.slice(0, 5).map((x) => `${x.from} to ${x.to}, ${fmtDate(x.depart)} – ${fmtDate(x.back)} (${x.status})`).join("; ")}.` : "You have no travel requests.",
    links: [{ label: "Travel", to: "/travel" }],
  };
}

function paydayAnswer(q: string, ctx: CopilotContext, more: CopilotMore): RawCopilotAnswer | null {
  if (!hasWord(q, ["payday", "pay day", "pay date", "salary date", "salary day", "when will i get paid", "when do i get paid", "when is salary", "when is my salary", "salary credited", "salary credit", "when is pay"]) &&
      !(hasWord(q, ["when"]) && hasWord(q, ["salary", "pay", "paid"]) && !hasWord(q, ["tax", "deduction", "deductions", "increment", "raise"]))) return null;
  const last = ctx.payslips?.[0];
  return {
    kind: "text",
    summary: `Pay is credited on the last working day of the month — next on ${fmtDate(more.nextPayday)}.${last ? ` Your latest payslip is for ${last.label} (net ${money(last.net, last.currency)}).` : ""}`,
    links: [{ label: "My payslips", to: "/payslips" }],
  };
}

/** "who is <name>" when no Employee 360 summary is available to the viewer: the directory card only. */
export function directoryCardAnswer(question: string, ctx: CopilotContext): RawCopilotAnswer | null {
  const card = moreOf(ctx)?.findPeople(question).find((c) => !c.self);
  if (!card) return null;
  return { kind: "text", summary: cardLine(card), links: [{ label: "Directory", to: "/directory" }, { label: "Org chart", to: "/org-chart" }] };
}

/* —— entry points —— */

export function earlyAnswer(q: string, question: string, ctx: CopilotContext): RawCopilotAnswer | null {
  const more = moreOf(ctx);
  const nav = navigationAnswer(q);
  if (nav) return nav;
  if (!more) return null;
  return (
    profileAnswer(q, ctx, more) ??
    upcomingLeaveAnswer(q, ctx) ??
    departmentHeadsAnswer(q, more) ??
    lineBreakdownAnswer(q, ctx, more) ??
    directoryAnswer(q, question, more) ??
    paydayAnswer(q, ctx, more) ??
    taxAnswer(q, more) ??
    tripsAnswer(q, more) ??
    tasksAnswer(q, more)
  );
}

export function lateAnswer(q: string, ctx: CopilotContext): RawCopilotAnswer | null {
  const more = moreOf(ctx);
  if (!more) return null;
  return attendanceAnswer(q, more);
}
