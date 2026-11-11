import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  Briefcase,
  Building2,
  CalendarClock,
  Eye,
  HeartPulse,
  IdCard,
  Languages,
  Lock,
  MapPin,
  Network,
  Phone,
  Users,
} from "lucide-react";
import { CertificateDialog, type CertificateDoc } from "../components/CertificateViewer.tsx";
import { initials } from "../components/OrgChart.tsx";
import type { CorrectionField } from "../data/profileCorrections.ts";
import { Card, DataTable, EmptyState, MetricCard, MetricGrid, StatusBadge, Tabs } from "../components/ui.tsx";
import { COMPANY_NAME } from "../brand.ts";
import { money, payRulesFor } from "../countryPay.ts";
import { attendanceContextFor, buildAttendanceHistory, formatHm, kindLabel } from "../data/attendanceData.ts";
import { getAttendanceState, listCorrectionsForEmployee, subscribeAttendance } from "../data/attendanceLocal.ts";
import { careerTarget, skillsFor } from "../data/careerProfile.ts";
import { getLifecycleHistory, isScheduled, subscribeLifecycleHistory, timelineFor, type LifecycleEvent } from "../data/lifecycleHistory.ts";
import { ageOn, ensureProfileDetails, jobProfileLabel, positionLabel, type PersonRecord } from "../data/peopleData.ts";
import { directReportIds, getExitDetails, isTerminated, listPeople, managerChainIds, subscribePeople } from "../data/peopleLocal.ts";
import { profileAccessFor } from "../data/profileAccess.ts";
import { useProfileExtras } from "../data/profileExtras.ts";
import { DEPENDENTS } from "../data/rewardData.ts";
import { getRewardState, subscribeReward } from "../data/rewardLocal.ts";
import { COURSES, PERF_CYCLES } from "../data/talentData.ts";
import { getTalentState, subscribeTalent } from "../data/talentLocal.ts";
import { scheduleForEmployee } from "../data/workSchedule.ts";
import type { DemoAccount } from "../demoAccounts.ts";
import { formatShortDate, leaveRows, parseISODate, toISO, todayISO, type CountryCode } from "../model.ts";
import { MaskedValue } from "../components/MaskedValue.tsx";
import { canRevealPersonal, personRevealer } from "../data/piiReveal.ts";
import { isMasked } from "../utils/mask.ts";
import { API_ENABLED } from "../api/client.ts";
import { revealPersonDetail } from "../api/portalSync.ts";
import { fetchDocuments, type RepoDocument } from "../api/syncRewards.ts";
import { usePortal } from "../store.tsx";
import { DraftTag } from "../features/ai/DraftTag.tsx";
import { apiEmployeeSummary } from "../api/syncCareer.ts";
import { useAiOn } from "../features/ai/flags.ts";

function Progress({ value, label }: { value: number; label: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="dash-progress">
      <div className="dash-progress-meta">
        <span>{label}</span>
        <span>{pct}%</span>
      </div>
      <div className="dash-progress-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="dash-progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="info-fact">
      <dt>{label}</dt>
      <dd>{value === "" || value === undefined || value === null ? "—" : value}</dd>
    </div>
  );
}

/** One titled block of a record tab: icon, heading, optional Edit, then a label / value grid or a list. */
function Section({ icon, title, action, wide = false, children }: { icon: ReactNode; title: string; action?: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <section className={`pi-section${wide ? " wide" : ""}`}>
      <header className="pi-head">
        <span className="pi-icon" aria-hidden>
          {icon}
        </span>
        <h3>{title}</h3>
        {action && <span className="pi-action">{action}</span>}
      </header>
      {children}
    </section>
  );
}

function Item({ label, value, action, wide = false }: { label: string; value: ReactNode; action?: ReactNode; wide?: boolean }) {
  const empty = value === "" || value === undefined || value === null;
  return (
    <div className={`pi-item${wide ? " wide" : ""}`}>
      <dt>{label}</dt>
      <dd>
        {empty ? <span className="muted">—</span> : value}
        {action && <span className="pi-item-action">{action}</span>}
      </dd>
    </div>
  );
}

function EditLink({ onClick, label = "Edit" }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" className="btn-ghost btn-tiny" onClick={onClick}>
      {label}
    </button>
  );
}

/** Avatar, name (linked to the profile) and title — for reporting lines and teams. */
function PersonRow({ person, current = false, note }: { person: PersonRecord; current?: boolean; note?: string }) {
  const body = (
    <>
      <span className="pi-avatar" aria-hidden>
        {person.photo && person.photo !== "/profile.svg" ? <img src={person.photo} alt="" /> : initials(person.fullName)}
      </span>
      <span className="pi-person-text">
        <strong>{person.fullName}</strong>
        <span className="muted">
          {person.designation}
          {note ? ` · ${note}` : ""}
        </span>
      </span>
    </>
  );
  return current ? (
    <div className="pi-person current">{body}</div>
  ) : (
    <Link className="pi-person" to={`/people/${person.id}`}>
      {body}
    </Link>
  );
}

function shiftISO(iso: string, days: number): string {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + days);
  return toISO(d);
}

function tenureText(dateOfJoining: string, today: string): string {
  const [y1, m1] = dateOfJoining.split("-").map(Number);
  const [y2, m2] = today.split("-").map(Number);
  const months = (y2 - y1) * 12 + (m2 - m1);
  if (months < 1) return "under a month";
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return [years ? `${years} yr${years > 1 ? "s" : ""}` : "", rest ? `${rest} mo` : ""].filter(Boolean).join(" ");
}

const MASK = "••••••";

export type TabId =
  | "personal"
  | "employment"
  | "org"
  | "manager"
  | "job"
  | "attendance"
  | "leave"
  | "timesheet"
  | "goals"
  | "performance"
  | "learning"
  | "skills"
  | "career"
  | "comp"
  | "benefits"
  | "docs"
  | "lifecycle";

/** Employee 360: the full record, section by section, limited to what the viewer may see. */
export function Employee360View({
  person: rawPerson,
  viewer,
  selfId,
  onEdit,
  hideHeader = false,
  hideSummary = false,
  selfEdit,
  onlyTabs,
  extraTabs = [],
}: {
  person: PersonRecord;
  viewer: DemoAccount;
  selfId: string;
  onEdit?: () => void;
  /** Skip the photo/name card when the page already shows a profile header. */
  hideHeader?: boolean;
  /** Your own profile: no drafted summary (the tabs already say it all). */
  hideSummary?: boolean;
  /** Your own profile: Edit buttons per section and "Request correction" for HR-owned fields. */
  selfEdit?: { editContact: () => void; editPersonal: () => void; correct: (field: CorrectionField) => ReactNode };
  /** Only these tabs, in this order (the profile page shows personal and employment details as cards above). */
  onlyTabs?: TabId[];
  /** Extra tabs from the page (e.g. Calendar on the profile), after the built-in ones. */
  extraTabs?: { id: string; label: string; node: ReactNode }[];
}) {
  const { state, employee } = usePortal();
  const talent = useSyncExternalStore(subscribeTalent, getTalentState, getTalentState);
  const reward = useSyncExternalStore(subscribeReward, getRewardState, getRewardState);
  const attendanceState = useSyncExternalStore(subscribeAttendance, getAttendanceState, getAttendanceState);
  const history = useSyncExternalStore(subscribeLifecycleHistory, getLifecycleHistory, getLifecycleHistory);
  const people = useSyncExternalStore(subscribePeople, listPeople, listPeople);
  const person = useMemo(() => ensureProfileDetails(rawPerson), [rawPerson]);
  const extras = useProfileExtras(person.id);
  const today = todayISO();
  const access = profileAccessFor(viewer, person.id, selfId);
  const isSelf = access.isSelf;
  const terminated = isTerminated(person);
  const exit = getExitDetails(person);
  const [tab, setTab] = useState<string>(onlyTabs?.[0] ?? "personal");
  const [revealPay, setRevealPay] = useState(false);
  const [viewingCert, setViewingCert] = useState<CertificateDoc | null>(null);
  const correct = (field: CorrectionField) => selfEdit?.correct(field);
  // Personal details are masked; the person, and HR / admin in scope, can show one field at a time.
  const canReveal = access.personal && canRevealPersonal(viewer, person.id, selfId, access.personal);
  const firstName = person.preferredName || person.firstName || person.fullName.split(" ")[0];

  // Self-maintained details (preferred name, personal email, emergency contact) win over the HR record.
  const preferredName = extras.preferredName || person.preferredName;
  const personalEmail = extras.personalEmail || person.personalEmail;
  // Backend mode: the server record (reloaded after a profile save), not the session copy from sign-in.
  const mobile = API_ENABLED ? person.mobile || (isSelf ? employee.mobile : "") : isSelf ? employee.mobile || person.mobile : person.mobile;
  // Backend mode: address and emergency contact come from the server record (masked parts arrive masked).
  const address = API_ENABLED ? person.address : isSelf ? employee.address || person.address : person.address;
  const emergencyName = API_ENABLED ? person.emergencyName ?? "" : extras.emergencyName;
  const emergencyPhone = API_ENABLED ? person.emergencyPhone ?? "" : extras.emergencyPhone;
  const emergencyRelation = API_ENABLED ? person.emergencyRelationship ?? "" : extras.emergencyRelation;
  const revealAddress =
    API_ENABLED && isMasked(address)
      ? async () => {
          const [line, postcode] = await Promise.all([
            person.addressLine ? revealPersonDetail(person.id, "address_line") : Promise.resolve(null),
            person.addressPostcode ? revealPersonDetail(person.id, "address_postcode") : Promise.resolve(null),
          ]);
          return [line, person.addressCity, postcode, person.addressCountry].filter(Boolean).join(", ");
        }
      : undefined;

  /* ───── Reporting line ───── */
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const manager = person.managerId ? byId.get(person.managerId) : undefined;
  const chain = managerChainIds(person.id).map((id) => byId.get(id)).filter((p): p is PersonRecord => Boolean(p));
  const reports = directReportIds(person.id).map((id) => byId.get(id)).filter((p): p is PersonRecord => Boolean(p));
  const peers = manager
    ? directReportIds(manager.id)
        .filter((id) => id !== person.id)
        .map((id) => byId.get(id))
        .filter((p): p is PersonRecord => Boolean(p) && !isTerminated(p))
    : [];

  /* ───── Schedule, attendance, leave, timesheets ───── */
  const schedule = scheduleForEmployee({
    shiftName: isSelf ? employee.shiftName : undefined,
    shiftHours: isSelf ? employee.shiftHours : undefined,
    countryCode: String(person.countryCode),
  });
  const attendance = useMemo(() => {
    if (!access.work) return [];
    const ctx = attendanceContextFor({ id: person.id, countryCode: String(person.countryCode) }, state.holidays, state.leaveRequests);
    return buildAttendanceHistory({
      employeeId: person.id,
      employeeName: person.fullName,
      from: shiftISO(today, -29),
      to: today,
      holidays: ctx.holidays,
      leaveRequests: state.leaveRequests,
      absences: isSelf ? state.absences : [],
      shiftHours: schedule.hoursLabel,
      corrections: listCorrectionsForEmployee(person.id),
      weeklyOffDays: schedule.weeklyOffDays,
      sessions: attendanceState.sessions,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [access.work, person.id, person.countryCode, state.holidays, state.leaveRequests, state.absences, attendanceState, today, isSelf, schedule.hoursLabel]);
  const worked = attendance.filter((d) => ["present", "wfh", "missing_punch", "pending_correction"].includes(d.kind));
  const attendanceStats = {
    present: worked.length,
    absent: attendance.filter((d) => d.kind === "absent").length,
    leave: attendance.filter((d) => d.kind === "leave").length,
    late: attendance.filter((d) => d.lateMinutes > 0).length,
    avgHours: worked.length ? worked.reduce((s, d) => s + d.hoursWorked, 0) / worked.length : 0,
  };
  const attendanceExceptions = attendance
    .filter((d) => d.kind === "absent" || d.kind === "missing_punch" || d.kind === "pending_correction" || d.lateMinutes > 0)
    .slice(-8)
    .reverse();

  const leaveBalances = access.work
    ? leaveRows(
        state.leavePolicies,
        state.leaveRequests,
        state.encashments,
        state.holidays,
        person.id,
        schedule.weeklyOffDays,
        Number(today.slice(0, 4)),
      )
    : [];
  const leaveRequests = state.leaveRequests.filter((l) => l.employeeId === person.id).slice(0, 8);
  const leaveName = (code: string) => leaveBalances.find((r) => r.code === code)?.name ?? code.toUpperCase();

  const timesheetWeeks = useMemo(() => {
    const weeks = new Map<string, { week: string; hours: number; status: string; projects: string }>();
    for (const row of state.orgTimesheets.filter((r) => r.personId === person.id)) {
      weeks.set(row.weekStart, { week: row.weekStart, hours: row.hours, status: row.status, projects: row.projectSummary });
    }
    for (const sheet of state.timesheets.filter((t) => t.employeeId === person.id)) {
      const hours = Object.values(sheet.hours).reduce((s, h) => s + h, 0);
      const project = state.projects.find((p) => p.id === sheet.projectId)?.name ?? "";
      const row = weeks.get(sheet.weekStart);
      if (row && state.orgTimesheets.some((r) => r.personId === person.id && r.weekStart === sheet.weekStart)) continue;
      if (row) {
        row.hours += hours;
        row.projects = [row.projects, project].filter(Boolean).join(", ");
      } else {
        weeks.set(sheet.weekStart, { week: sheet.weekStart, hours, status: sheet.status, projects: project });
      }
    }
    return [...weeks.values()].sort((a, b) => b.week.localeCompare(a.week)).slice(0, 8);
  }, [state.orgTimesheets, state.timesheets, state.projects, person.id]);

  /* ───── Talent ───── */
  const goals = talent.goals.filter((g) => g.ownerId === person.id);
  const goalWeight = goals.reduce((s, g) => s + (g.weight || 0), 0);
  const goalProgress = goals.length
    ? goalWeight
      ? goals.reduce((s, g) => s + g.progress * (g.weight || 0), 0) / goalWeight
      : goals.reduce((s, g) => s + g.progress, 0) / goals.length
    : 0;
  const reviews = talent.reviews.filter((r) => r.employeeId === person.id);
  const ratingFor = (r: (typeof reviews)[number]): string | undefined =>
    isSelf ? (r.released ? r.rating : undefined) : access.unreleasedRatings ? r.rating : undefined;
  const praise = talent.feedback.filter((f) => f.kind === "Praise" && f.toId === person.id);
  const learning = talent.enrollments.filter((e) => e.employeeId === person.id);
  const certifications = talent.certifications.filter((c) => c.employeeId === person.id);
  const skills = skillsFor(talent.skillProfiles, person);
  const career = careerTarget(person, skills);
  const openGaps = career ? career.gaps.filter((g) => g.gap > 0).sort((a, b) => b.gap - a.gap) : [];
  const courseFor = (skillId: string) => COURSES.find((c) => c.skills.includes(skillId));

  /* ───── Reward ───── */
  const compHistory = reward.history
    .filter((h) => h.employeeId === person.id)
    .sort((a, b) => b.effective.localeCompare(a.effective));
  const bonuses = reward.bonuses.filter((b) => b.employeeId === person.id);
  const enrolments = reward.enrollments.filter((e) => e.employeeId === person.id);
  const coverage = (reward.dependents ?? DEPENDENTS).filter((d) => d.employeeId === person.id);
  // Backend mode keeps dependents in Benefits; the profile shows those when it has none of its own.
  const dependents: typeof person.dependents = person.dependents.length
    ? person.dependents
    : coverage.map((d) => ({ name: d.name, relation: d.relationship as (typeof person.dependents)[number]["relation"], dateOfBirth: d.dateOfBirth ?? "" }));
  const rules = payRulesFor(String(person.countryCode) as CountryCode);
  const monthly = rules.earnings.reduce((sum, line) => sum + line.amount, 0);
  const showPay = revealPay;

  const localDocuments = state.documents.filter((d) => d.employeeId === person.id);
  // With the backend, documents come from the server, which returns only what this viewer may see
  // (the person, HR in scope, and their managers for manager-visible categories).
  const docsVisible = access.documents || (API_ENABLED && access.aboveInLine);
  const [apiDocs, setApiDocs] = useState<{ id: string; rows: RepoDocument[]; error: string | null } | null>(null);
  useEffect(() => {
    if (!API_ENABLED || !docsVisible || tab !== "docs") return;
    let live = true;
    void fetchDocuments(isSelf ? undefined : person.id).then(({ data, error }) => {
      if (live) setApiDocs({ id: person.id, rows: data, error });
    });
    return () => {
      live = false;
    };
  }, [docsVisible, tab, person.id, isSelf]);
  const apiDocsHere = apiDocs && apiDocs.id === person.id ? apiDocs : null;
  const documents = API_ENABLED
    ? (apiDocsHere?.rows ?? []).map((d) => ({
        id: d.id,
        name: d.title,
        category: d.category,
        docType: d.versions[0]?.fileName ?? "",
        uploadedAt: d.updatedOn,
        expires: d.expiryDate ?? "",
      }))
    : localDocuments.map((d) => ({ id: d.id, name: d.name, category: d.category, docType: d.docType, uploadedAt: d.uploadedAt, expires: d.expires }));
  const certificateFor = (c: (typeof certifications)[number]): CertificateDoc => ({
    id: c.id,
    kind: "professional",
    title: c.name,
    recipient: c.employeeName || person.fullName,
    issuer: c.issuer,
    issuedOn: c.earnedOn,
    expiresOn: c.expiresOn,
    credentialId: c.verifiedBy ? c.credentialId : undefined,
    verified: Boolean(c.verifiedBy),
    expired: Boolean(c.expiresOn && c.expiresOn < today),
  });

  /* ───── Lifecycle (compensation changes only for viewers who may see pay) ───── */
  const timeline: LifecycleEvent[] = useMemo(() => {
    const events = timelineFor({ ...person, ...exit }, history);
    if (!access.compensation) return events.filter((e) => e.type !== "Compensation change");
    const compEvents: LifecycleEvent[] = compHistory.map((h) => ({
      id: `comp-${h.id}`,
      personId: person.id,
      personName: person.fullName,
      type: "Compensation change",
      effectiveDate: h.effective,
      before: "",
      after: `${h.event} · ${h.grade}`,
      by: "HR",
      byId: "",
      recordedOn: h.effective,
      derived: true,
    }));
    return [...events, ...compEvents].sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [person, history, access.compensation, reward.history]);

  // Latest job, promotion or hire that is already in effect.
  const roleSince = timeline
    .filter((e) => (e.type === "Hire" || e.type === "Promotion" || e.type === "Job change") && !isScheduled(e, today))
    .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate))[0]?.effectiveDate;

  const allTabs: { id: TabId; label: string }[] = [
    { id: "personal", label: "Personal information" },
    { id: "employment", label: "Employment information" },
    { id: "org", label: "Org structure" },
    { id: "manager", label: "Manager" },
    { id: "job", label: "Job" },
    ...(access.work
      ? ([
          { id: "attendance", label: "Attendance" },
          { id: "leave", label: "Leave" },
          { id: "timesheet", label: "Timesheet" },
          { id: "goals", label: "Goals" },
          { id: "performance", label: "Performance" },
          { id: "learning", label: "Learning" },
          { id: "skills", label: "Skills" },
          { id: "career", label: "Career" },
        ] as { id: TabId; label: string }[])
      : []),
    ...(access.compensation ? [{ id: "comp" as const, label: "Compensation" }] : []),
    ...(access.benefits ? [{ id: "benefits" as const, label: "Benefits" }] : []),
    ...(docsVisible ? [{ id: "docs" as const, label: "Documents" }] : []),
    ...(access.work ? [{ id: "lifecycle" as const, label: "Lifecycle history" }] : []),
  ];
  const tabs: { id: string; label: string }[] = [
    ...(onlyTabs ? onlyTabs.flatMap((id) => allTabs.filter((t) => t.id === id)) : allTabs),
    ...extraTabs.map(({ id, label }) => ({ id, label })),
  ];
  const activeTab = tabs.some((t) => t.id === tab) ? tab : (tabs[0]?.id ?? "personal");
  const extraTab = extraTabs.find((t) => t.id === activeTab);

  /* ───── Summary draft: built only from sections this viewer can already see ───── */
  const summaryOn = useAiOn("employee360");
  const [summaryRun, setSummaryRun] = useState(0);
  const [summaryAt, setSummaryAt] = useState(() => new Date());
  // Backend mode: the server drafts the paragraph from what this viewer may see; the rule-based one is the fallback.
  const [aiParagraph, setAiParagraph] = useState<{ key: string; text: string | null } | null>(null);
  const summaryKey = `${person.id}:${summaryRun}`;
  useEffect(() => {
    if (!API_ENABLED || !summaryOn) return;
    let live = true;
    apiEmployeeSummary(person.id)
      .then((r) => {
        if (live) setAiParagraph({ key: summaryKey, text: r.used_ai ? r.summary : null });
      })
      .catch(() => {
        if (live) setAiParagraph({ key: summaryKey, text: null });
      });
    return () => {
      live = false;
    };
  }, [summaryOn, person.id, summaryKey]);
  const summary = useMemo(() => {
    const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
    const tenure = tenureText(person.dateOfJoining, today);
    const bullets: { label: string; text: string }[] = [];
    const sentences: string[] = [];

    // Role and tenure: shown on the Job, Manager and Employment tabs to every viewer.
    const roleText = `${person.designation} (${person.grade}) in ${person.department}, ${person.location}${
      manager ? `; reports to ${manager.fullName}` : ""
    }${reports.length ? `; leads ${plural(reports.length, "direct report")}` : ""}.`;
    bullets.push({ label: "Current role", text: roleText });
    const recent = access.work
      ? timeline.find((e) => e.type !== "Hire" && !isScheduled(e, today) && e.type !== "Compensation change")
      : undefined;
    bullets.push({
      label: "Tenure",
      text: terminated
        ? `Joined ${formatShortDate(person.dateOfJoining)}; left${exit.exitDate ? ` on ${formatShortDate(exit.exitDate)}` : ""}.`
        : `${tenure} since ${formatShortDate(person.dateOfJoining)}${recent ? `; last change was a ${recent.type.toLowerCase()} on ${formatShortDate(recent.effectiveDate)}` : ""}.`,
    });

    const openers = terminated
      ? [`${firstName} was a ${person.designation} in ${person.department}.`]
      : [
          `${firstName} is a ${person.designation} in ${person.department} with ${tenure} at ${COMPANY_NAME}.`,
          `${firstName} has been with ${COMPANY_NAME} for ${tenure} and works as a ${person.designation} in ${person.department}.`,
          `In ${tenure} at ${COMPANY_NAME}, ${firstName} has grown into a ${person.designation} role in ${person.department}.`,
        ];
    sentences.push(openers[summaryRun % openers.length]);

    const dev: string[] = [];
    if (access.work) {
      // Performance: rating only when this viewer may see it (released, or HR/manager access).
      const rated = reviews.map((r) => ({ r, rating: ratingFor(r) })).find((x) => x.rating);
      const lowest = goals.length ? [...goals].sort((a, b) => a.progress - b.progress)[0] : undefined;
      const perf: string[] = [];
      if (rated) {
        const cycle = PERF_CYCLES.find((c) => c.id === rated.r.cycleId)?.name ?? "the latest cycle";
        perf.push(`rated ${rated.rating} in ${cycle}${rated.r.released ? "" : " (not released)"}`);
      }
      if (goals.length) perf.push(`${Math.round(goalProgress)}% through ${plural(goals.length, "goal")}${lowest ? `, lowest is "${lowest.title}" at ${lowest.progress}%` : ""}`);
      if (praise.length) perf.push(`${plural(praise.length, "recognition")} received`);
      if (perf.length) bullets.push({ label: "Performance", text: `${perf.join("; ")}.` });
      if (goals.length) {
        sentences.push(
          goalProgress >= 70
            ? `Goals are on track at ${Math.round(goalProgress)}% overall.`
            : goalProgress >= 40
              ? `Goals are moving at ${Math.round(goalProgress)}% overall, with room to push the slower ones.`
              : `Goal progress is early at ${Math.round(goalProgress)}% overall.`,
        );
      }

      // Skills: strengths and gaps for the next role.
      const top = [...skills].sort((a, b) => rank(b.level) - rank(a.level)).slice(0, 3);
      if (top.length) {
        bullets.push({
          label: "Skills",
          text: `Strongest in ${top.map((s) => `${s.skillName} (${s.level})`).join(", ")}${
            career && openGaps.length ? `. For ${career.role.title}, gaps are ${openGaps.map((g) => `${g.name} (${g.have} → ${g.need})`).join(", ")}` : ""
          }.`,
        });
        sentences.push(`Main strength is ${top[0].skillName}${career && openGaps.length ? `, and the next step toward ${career.role.title} is ${openGaps[0].name}` : ""}.`);
      }

      // Learning.
      const done = learning.filter((l) => l.status === "Completed").length;
      const active = learning.filter((l) => l.status !== "Completed");
      const soon = certifications.filter((c) => c.expiresOn && c.expiresOn >= today && c.expiresOn <= shiftISO(today, 90));
      if (learning.length || certifications.length) {
        bullets.push({
          label: "Learning",
          text: `${plural(done, "course")} completed${active.length ? `, ${active.length} in progress` : ""}${
            certifications.length ? `; ${plural(certifications.length, "certification")}` : ""
          }${soon.length ? ` (${soon.map((c) => c.name).join(", ")} expires within 90 days)` : ""}.`,
        });
      }

      // Attendance and leave, last 30 days.
      if (attendance.length) {
        // Paid leave only — work from home and unpaid leave are not days off to count.
        const leaveLeft = leaveBalances
          .filter((r) => r.code !== "unpaid" && r.code !== "wfh" && r.code !== "emergency_wfh")
          .reduce((s, r) => s + Math.max(0, Number(r.available || 0)), 0);
        const pending = leaveRequests.filter((l) => l.status === "pending").length;
        bullets.push({
          label: "Attendance & leave",
          text: `Last 30 days: ${attendanceStats.present} days worked, ${attendanceStats.leave} on leave, ${attendanceStats.absent} absent, ${plural(
            attendanceStats.late,
            "late arrival",
          )}, ${attendanceStats.avgHours.toFixed(1)} h/day on average. ${leaveLeft} paid leave days left this year${pending ? `, ${pending} pending` : ""}.`,
        });
        if (attendanceStats.late >= 3) dev.push(`look at start times (${attendanceStats.late} late arrivals in 30 days)`);
        if (attendanceStats.absent >= 2) dev.push(`check in on ${attendanceStats.absent} unplanned absences`);
      }

      // Development areas.
      for (const g of openGaps.slice(0, 2)) {
        const course = courseFor(g.skillId);
        dev.unshift(course ? `build ${g.name} through "${course.title}"` : `build ${g.name} (${g.have} → ${g.need})`);
      }
      if (lowest && lowest.progress < 50) dev.push(`agree a plan for "${lowest.title}"`);
      if (soon.length) dev.push(`renew ${soon[0].name}`);
      if (dev.length) {
        bullets.push({ label: "Development areas", text: `${dev.slice(0, 3).map((d, i) => (i ? d : d[0].toUpperCase() + d.slice(1))).join("; ")}.` });
        sentences.push(`A good focus for the next quarter: ${dev[0]}.`);
      }
    }

    return { paragraph: sentences.join(" "), bullets };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [person, manager, reports.length, access.work, goals, reviews, skills, career, timeline, today, terminated, attendance, leaveBalances, learning, certifications, praise.length, summaryRun]);

  return (
    <div className="stack">
      {!hideHeader && (
        <Card>
          <div className="who row-between" style={{ alignItems: "flex-start", gap: 16 }}>
            <div className="who" style={{ margin: 0 }}>
              <img className="identity-photo who-photo" src={person.photo} alt="" />
              <div className="who-copy">
                <h2>{person.fullName}</h2>
                {terminated && (
                  <p className="profile-left-chip">
                    No longer with the company{exit.exitDate ? ` · left ${formatShortDate(exit.exitDate)}` : ""}
                  </p>
                )}
                <p className="role">{person.designation}</p>
                <p className="muted">
                  {person.department} · {person.location}, {person.countryName}
                </p>
              </div>
            </div>
            {onEdit && (
              <button type="button" className="btn" onClick={onEdit}>
                Edit employee
              </button>
            )}
          </div>
        </Card>
      )}

      {summaryOn && !hideSummary && (
        <Card
          title="Summary"
          action={
            <div className="ai-row">
              <DraftTag />
              <button
                type="button"
                className="btn-ghost btn-tiny"
                onClick={() => {
                  setSummaryRun((n) => n + 1);
                  setSummaryAt(new Date());
                }}
              >
                Regenerate
              </button>
            </div>
          }
        >
          <p>{aiParagraph?.key === summaryKey && aiParagraph.text ? aiParagraph.text : summary.paragraph}</p>
          <ul className="ai-bullets">
            {summary.bullets.map((b) => (
              <li key={b.label}>
                <strong>{b.label}:</strong>
                {b.text}
              </li>
            ))}
          </ul>
          <p className="ai-note">Generated {summaryAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>
        </Card>
      )}

      <Tabs tabs={tabs} value={activeTab} onChange={(id) => setTab(id)} />
      {extraTab?.node}

      {activeTab === "personal" && (
        <Card title="Personal information" className="pi-card">
          {!access.personal ? (
            <>
              <dl className="pi-grid">
                <Item label="First name" value={person.firstName} />
                <Item label="Last name" value={person.lastName} />
                <Item label="Preferred name" value={preferredName} />
                <Item label="Work email" value={person.email} />
                <Item label="Employee ID" value={person.employeeCode} />
              </dl>
              <p className="profile-private">
                <Lock size={13} aria-hidden /> Visible to {firstName}, their managers and HR.
              </p>
            </>
          ) : (
            <div className="pi-layout">
              <Section
                icon={<IdCard size={16} />}
                title="Identity"
                wide
                action={selfEdit && <EditLink onClick={selfEdit.editPersonal} />}
              >
                <dl className="pi-grid">
                  <Item label="Employee ID" value={person.employeeCode} />
                  <Item label="Legal name" value={person.fullName} action={correct("fullName")} />
                  <Item label="First name" value={person.firstName} />
                  <Item label="Middle name" value={person.middleName ?? ""} action={correct("middleName")} />
                  <Item label="Last name" value={person.lastName} />
                  <Item label="Preferred name" value={preferredName} />
                  <Item
                    label="Date of birth"
                    value={
                      person.dateOfBirth ? (
                        <MaskedValue
                          value={person.dateOfBirth}
                          kind="dob"
                          canReveal={canReveal}
                          onReveal={personRevealer(person.id, "date_of_birth", person.dateOfBirth)}
                          format={(dob) => (isMasked(dob) ? dob : `${formatShortDate(dob)} · ${ageOn(dob, today)} yrs`)}
                        />
                      ) : (
                        ""
                      )
                    }
                    action={correct("dateOfBirth")}
                  />
                  <Item label="Gender" value={person.gender} />
                  <Item label="Nationality" value={person.nationality} action={correct("nationality")} />
                </dl>
              </Section>

              <Section icon={<Phone size={16} />} title="Contact" action={selfEdit && <EditLink onClick={selfEdit.editContact} />}>
                <dl className="pi-grid two">
                  <Item label="Work email" value={person.email} wide />
                  <Item
                    label="Personal email"
                    wide
                    value={
                      personalEmail ? (
                        <MaskedValue value={personalEmail} kind="email" canReveal={canReveal} onReveal={personRevealer(person.id, "personal_email", personalEmail)} />
                      ) : (
                        ""
                      )
                    }
                  />
                  <Item
                    label="Mobile"
                    value={mobile ? <MaskedValue value={mobile} kind="phone" canReveal={canReveal} onReveal={personRevealer(person.id, "mobile", mobile)} /> : ""}
                  />
                  <Item label="Time zone" value={person.timeZone} />
                </dl>
              </Section>

              <Section icon={<MapPin size={16} />} title="Address" action={selfEdit && <EditLink onClick={selfEdit.editContact} />}>
                <dl className="pi-grid two">
                  <Item
                    label="Home address"
                    wide
                    value={address ? <MaskedValue value={address} kind="address" canReveal={canReveal} onReveal={revealAddress} /> : ""}
                  />
                  <Item label="Work location" value={[person.location, person.countryName].filter(Boolean).join(", ")} wide />
                </dl>
              </Section>

              <Section icon={<HeartPulse size={16} />} title="Emergency contact" action={selfEdit && <EditLink onClick={selfEdit.editContact} />}>
                {emergencyName ? (
                  <dl className="pi-grid two">
                    <Item label="Name" value={emergencyName} />
                    <Item label="Relationship" value={emergencyRelation} />
                    <Item
                      label="Phone"
                      wide
                      value={
                        emergencyPhone ? (
                          <MaskedValue
                            value={emergencyPhone}
                            kind="phone"
                            canReveal={canReveal}
                            onReveal={personRevealer(person.id, "emergency_phone", emergencyPhone)}
                          />
                        ) : (
                          ""
                        )
                      }
                    />
                  </dl>
                ) : (
                  <p className="pi-missing">{isSelf ? "Not added yet. Add one so HR can reach someone in an emergency." : "Not provided"}</p>
                )}
              </Section>

              <Section icon={<Languages size={16} />} title="Languages" action={selfEdit && <EditLink onClick={selfEdit.editPersonal} />}>
                <dl className="pi-grid two">
                  <Item label="Preferred language" value={person.preferredLanguage ?? ""} />
                  <Item
                    label="Spoken"
                    wide
                    value={
                      (person.spokenLanguages ?? []).length ? (
                        <span className="pi-chips">
                          {(person.spokenLanguages ?? []).map((l) => (
                            <span key={l} className="pi-chip">
                              {l}
                            </span>
                          ))}
                        </span>
                      ) : (
                        ""
                      )
                    }
                  />
                </dl>
              </Section>

              <Section
                icon={<Users size={16} />}
                title={`Dependents${dependents.length ? ` (${dependents.length})` : ""}`}
                action={isSelf ? <Link to="/benefits" className="btn-ghost btn-tiny">Benefits</Link> : undefined}
              >
                {dependents.length === 0 ? (
                  <p className="pi-missing">None recorded</p>
                ) : (
                  <table className="pi-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Relation</th>
                        <th>Date of birth</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dependents.map((d) => (
                        <tr key={d.name}>
                          <td>{d.name}</td>
                          <td>{d.relation}</td>
                          <td>
                            <MaskedValue value={d.dateOfBirth} kind="dob" canReveal={canReveal} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Section>
            </div>
          )}
        </Card>
      )}

      {activeTab === "employment" && (
        <Card title="Employment information" className="pi-card">
          <div className="pi-layout">
            <Section icon={<Briefcase size={16} />} title="Employment" wide>
              <dl className="pi-grid">
                <Item label="Employee ID" value={person.employeeCode} />
                <Item
                  label="Status"
                  value={<StatusBadge status={person.employmentStatus} tone={terminated ? "danger" : person.employmentStatus === "Active" ? "ok" : "warn"} literal />}
                />
                <Item label="Employment type" value={person.employmentType} />
                <Item label="Date of joining" value={`${formatShortDate(person.dateOfJoining)} · ${tenureText(person.dateOfJoining, today)}`} />
                {person.confirmationDate && <Item label="Confirmed on" value={formatShortDate(person.confirmationDate)} />}
                {person.contractEndDate && <Item label="Contract ends" value={formatShortDate(person.contractEndDate)} />}
                <Item label="Company" value={person.company || person.legalEntity} />
                {terminated && <Item label="Exit date" value={exit.exitDate ? formatShortDate(exit.exitDate) : ""} />}
                {terminated && access.isHr && <Item label="Exit reason" value={exit.exitReason ?? ""} />}
              </dl>
            </Section>
            <Section icon={<Building2 size={16} />} title="Role & placement">
              <dl className="pi-grid two">
                <Item label="Job title" value={person.designation} action={correct("designation")} />
                <Item label="Department" value={person.department} action={correct("department")} />
                <Item label="Manager" value={manager ? <Link to={`/people/${manager.id}`}>{manager.fullName}</Link> : person.managerName || "Top of the company"} action={correct("managerId")} />
                <Item label="Work arrangement" value={person.workArrangement} action={correct("workArrangement")} />
                <Item label="Work location" value={`${person.location}, ${person.countryName}`} wide />
              </dl>
            </Section>
            <Section icon={<CalendarClock size={16} />} title="Schedule & policies">
              <dl className="pi-grid two">
                <Item label="Working hours" value={schedule.hoursLabel} />
                <Item label="Time zone" value={person.timeZone} />
                {access.personal && <Item label="Holiday calendar" value={person.holidayCalendar ?? ""} />}
                {access.personal && <Item label="Leave policy" value={person.leavePolicy ?? ""} />}
                {access.personal && <Item label="Payroll status" value={person.payrollStatus ?? ""} />}
                {access.personal && person.leaveOfAbsence && (
                  <Item
                    label="Leave of absence"
                    wide
                    value={`${person.leaveOfAbsence.type} · ${formatShortDate(person.leaveOfAbsence.start)} – ${formatShortDate(person.leaveOfAbsence.end)}`}
                  />
                )}
              </dl>
            </Section>
          </div>
          {selfEdit && <p className="note">Managed by HR. Use Request correction if something is wrong.</p>}
        </Card>
      )}

      {activeTab === "org" && (
        <Card title="Org structure" className="pi-card">
          <div className="pi-layout">
            <Section icon={<Building2 size={16} />} title="Organization">
              <dl className="pi-grid two">
                <Item label="Legal entity" value={person.legalEntity} wide />
                <Item label="Business unit" value={person.businessUnit} />
                <Item label="Division" value={person.division} />
                <Item label="Department" value={person.department} />
                <Item label="Cost center" value={person.costCenter} />
                <Item label="Location" value={person.location} />
                <Item label="Country" value={person.countryName} />
              </dl>
            </Section>
            <Section icon={<Network size={16} />} title="Reporting line" action={<Link to="/org-chart" className="btn-ghost btn-tiny">Org chart</Link>}>
              <ol className="pi-chain">
                {[...chain].reverse().map((p) => (
                  <li key={p.id}>
                    <PersonRow person={p} />
                  </li>
                ))}
                <li>
                  <PersonRow person={person} current note={isSelf ? "You" : undefined} />
                </li>
              </ol>
              <p className="muted pi-foot">
                {reports.length ? `${reports.length} direct report${reports.length === 1 ? "" : "s"}` : "No direct reports"} ·{" "}
                {manager ? `${manager.fullName}'s team` : "Top of the company"}
              </p>
            </Section>
          </div>
        </Card>
      )}

      {activeTab === "manager" && (
        <Card title="Manager" className="pi-card">
          <div className="pi-layout">
            <Section icon={<Users size={16} />} title="Reports to">
              {manager ? (
                <>
                  <PersonRow person={manager} note={manager.department} />
                  <dl className="pi-grid two" style={{ marginTop: 10 }}>
                    <Item label="Email" value={manager.email} wide />
                    <Item label="Location" value={`${manager.location}, ${manager.countryName}`} wide />
                  </dl>
                </>
              ) : (
                <p className="pi-missing">Top of the company</p>
              )}
            </Section>
            <Section icon={<Network size={16} />} title={`Direct reports (${reports.length})`}>
              {reports.length === 0 ? (
                <p className="pi-missing">No direct reports</p>
              ) : (
                <div className="pi-people">
                  {reports.slice(0, 12).map((r) => (
                    <PersonRow key={r.id} person={r} />
                  ))}
                  {reports.length > 12 && <span className="muted">+{reports.length - 12} more</span>}
                </div>
              )}
            </Section>
            {peers.length > 0 && (
              <Section icon={<Users size={16} />} title={`Same team (${peers.length})`} wide>
                <div className="pi-people grid">
                  {peers.slice(0, 9).map((p) => (
                    <PersonRow key={p.id} person={p} />
                  ))}
                </div>
                {peers.length > 9 && <p className="muted pi-foot">+{peers.length - 9} more</p>}
              </Section>
            )}
          </div>
        </Card>
      )}

      {activeTab === "job" && (
        <Card title="Job" className="pi-card">
          <div className="pi-layout">
            <Section icon={<Briefcase size={16} />} title="Current job" wide>
              <dl className="pi-grid">
                <Item label="Job title" value={person.designation} />
                <Item label="Grade" value={person.grade} />
                <Item label="Job family" value={person.jobFamily} />
                <Item label="Job profile" value={person.jobProfileTitle || jobProfileLabel(person.jobProfileId)} />
                <Item label="Position" value={positionLabel(person)} />
                <Item label="Department" value={person.department} />
                <Item label="In this role since" value={roleSince ? `${formatShortDate(roleSince)} · ${tenureText(roleSince, today)}` : ""} />
                {access.work && career && <Item label="Next role" value={career.role.title} />}
              </dl>
            </Section>
          </div>
        </Card>
      )}

      {activeTab === "attendance" && access.work && (
        <Card title="Attendance · last 30 days" to={isSelf ? "/attendance" : undefined}>
          <MetricGrid>
            <MetricCard label="Days worked" value={attendanceStats.present} />
            <MetricCard label="Absent" value={attendanceStats.absent} />
            <MetricCard label="On leave" value={attendanceStats.leave} />
            <MetricCard label="Late arrivals" value={attendanceStats.late} />
            <MetricCard label="Avg hours / day" value={attendanceStats.avgHours.toFixed(1)} />
          </MetricGrid>
          <DataTable
            headers={["Date", "Status", "In", "Out", "Note"]}
            rows={attendanceExceptions.map((d) => [
              formatShortDate(d.date),
              kindLabel(d.kind) + (d.lateMinutes > 0 && d.kind === "present" ? ` · late ${d.lateMinutes} min` : ""),
              d.checkIn ? formatHm(d.checkIn) : "—",
              d.checkOut ? formatHm(d.checkOut) : "—",
              d.note ?? "",
            ])}
            empty={<EmptyState title="No exceptions" />}
          />
        </Card>
      )}

      {activeTab === "leave" && access.work && (
        <div className="mgr-home-grid">
          <Card title={`Leave balances ${today.slice(0, 4)}`} to={isSelf ? "/leave" : undefined}>
            <DataTable
              headers={["Type", "Entitled", "Used", "Pending", "Available"]}
              rows={leaveBalances.map((r) => [r.name, r.quota, r.utilized, r.pending, r.available])}
              empty={<EmptyState title="No leave policies" />}
            />
          </Card>
          <Card title="Recent requests" to={isSelf ? "/leave" : undefined}>
            <DataTable
              headers={["Type", "From", "To", "Applied", "Status"]}
              rows={leaveRequests.map((l) => [
                leaveName(l.code),
                formatShortDate(l.from),
                l.to !== l.from ? formatShortDate(l.to) : l.half ? `Half day (${l.half})` : "—",
                l.appliedOn ? formatShortDate(l.appliedOn.slice(0, 10)) : "—",
                <StatusBadge key={l.id} status={l.status} />,
              ])}
              empty={<EmptyState title="No leave requests" />}
            />
          </Card>
        </div>
      )}

      {activeTab === "timesheet" && access.work && (
        <Card title="Timesheets · recent weeks" to={isSelf ? "/timesheet" : undefined}>
          <DataTable
            headers={["Week of", "Hours", "Status", "Projects"]}
            rows={timesheetWeeks.map((w) => [w.week, w.hours.toFixed(1), <StatusBadge key={w.week} status={w.status} />, w.projects || "—"])}
            empty={<EmptyState title="No timesheets" />}
          />
        </Card>
      )}

      {activeTab === "goals" && access.work && (
        <Card title={goals.length ? `Goals · ${Math.round(goalProgress)}% overall` : "Goals"}>
          {goals.length === 0 ? (
            <EmptyState title="No goals this cycle" />
          ) : (
            <>
              <MetricGrid>
                <MetricCard label="Goals" value={goals.length} />
                <MetricCard label="Overall progress" value={`${Math.round(goalProgress)}%`} />
                <MetricCard label="Completed" value={goals.filter((g) => g.progress >= 100).length} />
                <MetricCard label="Below 40%" value={goals.filter((g) => g.progress < 40).length} />
              </MetricGrid>
              <DataTable
                headers={["Goal", "Type", "Target", "Weight", "Period", "Progress"]}
                rows={goals.map((g) => [
                  <strong key={`t-${g.id}`}>{g.title}</strong>,
                  g.type,
                  g.target || "—",
                  `${g.weight}%`,
                  g.period || "—",
                  <Progress key={`p-${g.id}`} value={g.progress} label="" />,
                ])}
              />
            </>
          )}
        </Card>
      )}

      {activeTab === "performance" && access.work && (
        <div className="mgr-home-grid">
          <Card title="Reviews">
            <DataTable
              headers={["Cycle", "Self", "Manager", "Rating"]}
              rows={reviews.map((r) => [
                PERF_CYCLES.find((c) => c.id === r.cycleId)?.name ?? r.cycleId,
                r.selfStatus,
                r.managerStatus,
                ratingFor(r) ? `${ratingFor(r)}${r.released ? "" : " (not released)"}` : isSelf && r.rating ? "Not released yet" : "Not rated",
              ])}
              empty={<EmptyState title="No reviews yet" />}
            />
          </Card>
          <Card title={`Recognition (${praise.length})`}>
            {praise.length === 0 ? (
              <EmptyState title="No praise yet" />
            ) : (
              <ul className="todo">
                {praise.slice(0, 6).map((p) => (
                  <li key={p.id}>
                    {p.badge ? `${p.badge} · ` : ""}from {p.fromName} · {p.createdOn}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      {activeTab === "learning" && access.work && (
        <div className="mgr-home-grid">
          <Card title="Courses">
            {learning.length === 0 ? (
              <EmptyState title="No courses" />
            ) : (
              <ul className="todo">
                {learning.map((l) => (
                  <li key={l.id}>
                    {COURSES.find((c) => c.id === l.courseId)?.title ?? "Course"} · <StatusBadge status={l.status} literal />
                    {l.completedOn ? ` · ${formatShortDate(l.completedOn)}` : ` · ${l.progress}%`}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Certifications">
            <DataTable
              headers={["Certification", "Issued", "Expires", "Status", ""]}
              rows={certifications.map((c) => [
                <span key={`n-${c.id}`}>
                  <strong>{c.name}</strong>
                  <br />
                  <span className="muted">{c.issuer}</span>
                </span>,
                formatShortDate(c.earnedOn),
                c.expiresOn ? formatShortDate(c.expiresOn) : "No expiry",
                c.expiresOn && c.expiresOn < today ? (
                  <StatusBadge key={`s-${c.id}`} status="Expired" tone="danger" literal />
                ) : c.verifiedBy ? (
                  <StatusBadge key={`s-${c.id}`} status="Verified" tone="ok" literal />
                ) : (
                  <StatusBadge key={`s-${c.id}`} status="Not verified" tone="warn" literal />
                ),
                <button key={`v-${c.id}`} type="button" className="btn-ghost btn-tiny" onClick={() => setViewingCert(certificateFor(c))}>
                  <Eye size={13} aria-hidden /> View
                </button>,
              ])}
              empty={<EmptyState title="No certifications" />}
            />
          </Card>
        </div>
      )}

      {activeTab === "skills" && access.work && (
        <Card title="Skills">
          <DataTable
            headers={["Skill", "Level", "Target"]}
            rows={skills.map((s) => [s.skillName, <StatusBadge key={s.skillId} status={s.level} tone="info" literal />, s.targetLevel])}
            empty={<EmptyState title="No skills recorded" />}
          />
        </Card>
      )}

      {activeTab === "career" && access.work && (
        <Card title={career ? `Career · next role: ${career.role.title}` : "Career"}>
          {!career ? (
            <EmptyState title="No career path defined" />
          ) : (
            <DataTable
              headers={["Skill", "Current", "Needed", "Gap", "Suggested course"]}
              rows={career.gaps.map((g) => [
                g.name,
                g.have,
                g.need,
                g.gap > 0 ? <StatusBadge key={g.skillId} status={`${g.gap} level${g.gap > 1 ? "s" : ""}`} tone="warn" literal /> : "Met",
                g.gap > 0 ? courseFor(g.skillId)?.title ?? "—" : "—",
              ])}
            />
          )}
        </Card>
      )}

      {activeTab === "comp" && access.compensation && (
        <div className="stack">
          <Card
            title="Compensation history"
            action={
              <button type="button" className="btn-ghost" onClick={() => setRevealPay((v) => !v)}>
                {revealPay ? "Hide amounts" : "Show amounts"}
              </button>
            }
          >
            <DataTable
              headers={["Effective", "Change", "Grade", "Base pay"]}
              rows={compHistory.map((h) => [formatShortDate(h.effective), h.event, h.grade, showPay ? h.base : MASK])}
              empty={<EmptyState title="No changes on file" />}
            />
          </Card>
          <div className="mgr-home-grid">
            <Card title="Standard pay">
              <dl className="info-grid">
                <Fact label="Currency" value={rules.currency} />
                <Fact label="Grade" value={person.grade} />
                <Fact label="Monthly gross" value={showPay ? money(monthly, rules.currency) : MASK} />
                <Fact label="Yearly gross" value={showPay ? money(monthly * 12, rules.currency) : MASK} />
              </dl>
            </Card>
            <Card title="Bonuses">
              {bonuses.length === 0 ? (
                <EmptyState title="No bonuses" />
              ) : (
                <ul className="todo">
                  {bonuses.map((b) => (
                    <li key={b.id}>
                      {b.type} · {b.period} · {showPay ? b.amount : MASK} · <StatusBadge status={b.status} literal />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      )}

      {activeTab === "benefits" && access.benefits && (
        <div className="mgr-home-grid">
          <Card title="Enrolments" to={isSelf ? "/benefits" : undefined}>
            <DataTable
              headers={["Plan", "Status", "Effective"]}
              rows={enrolments.map((e) => [e.planName, <StatusBadge key={e.id} status={e.status} literal />, formatShortDate(e.effective)])}
              empty={<EmptyState title="No enrolments" />}
            />
          </Card>
          <Card title="Dependents">
            {dependents.length === 0 ? (
              <EmptyState title="None recorded" />
            ) : (
              <ul className="todo">
                {dependents.map((d) => {
                  const covered = coverage.find((c) => c.name === d.name)?.coveredPlans ?? [];
                  return (
                    <li key={d.name}>
                      <strong>{d.name}</strong> · {d.relation}
                      {covered.length ? ` · covered: ${covered.join(", ")}` : " · not covered"}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      )}

      {activeTab === "docs" && docsVisible && (
        <Card title={`Documents${API_ENABLED && !apiDocsHere ? "" : ` (${documents.length})`}`} to={isSelf ? "/documents" : undefined}>
          {API_ENABLED && !apiDocsHere ? (
            <p className="muted">Loading documents…</p>
          ) : apiDocsHere?.error ? (
            <p className="note err" role="alert">{apiDocsHere.error}</p>
          ) : (
          <DataTable
            headers={["Document", "Category", "Type", "Uploaded", "Expires"]}
            rows={documents.map((d) => [
              <strong key={d.id}>{d.name}</strong>,
              d.category,
              d.docType || "—",
              d.uploadedAt ? formatShortDate(d.uploadedAt.slice(0, 10)) : "—",
              d.expires ? formatShortDate(d.expires.slice(0, 10)) : "—",
            ])}
            empty={<EmptyState title="No documents" />}
          />
          )}
        </Card>
      )}

      {activeTab === "lifecycle" && access.work && (
        <Card title="Lifecycle history">
          <DataTable
            headers={["Effective", "Change", "From", "To", "By"]}
            rows={timeline.map((e) => [
              <span key={e.id}>
                {formatShortDate(e.effectiveDate)}
                {isScheduled(e, today) ? (
                  <>
                    {" "}
                    <StatusBadge status="Scheduled" tone="info" literal />
                  </>
                ) : null}
              </span>,
              e.type,
              e.before || "—",
              e.after || "—",
              e.by,
            ])}
          />
        </Card>
      )}

      <CertificateDialog doc={viewingCert} onClose={() => setViewingCert(null)} />
    </div>
  );
}

function rank(level: string): number {
  return ["Awareness", "Working", "Intermediate", "Advanced", "Expert"].indexOf(level);
}
