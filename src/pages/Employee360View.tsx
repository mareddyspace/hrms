import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link } from "react-router-dom";
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

type TabId =
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
}: {
  person: PersonRecord;
  viewer: DemoAccount;
  selfId: string;
  onEdit?: () => void;
  /** Skip the photo/name card when the page already shows a profile header. */
  hideHeader?: boolean;
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
  const [tab, setTab] = useState<TabId>("personal");
  const [revealPay, setRevealPay] = useState(false);
  // Personal details are masked; the person, and HR / admin in scope, can show one field at a time.
  const canReveal = access.personal && canRevealPersonal(viewer, person.id, selfId, access.personal);
  const firstName = person.preferredName || person.firstName || person.fullName.split(" ")[0];

  // Self-maintained details (preferred name, personal email, emergency contact) win over the HR record.
  const preferredName = extras.preferredName || person.preferredName;
  const personalEmail = extras.personalEmail || person.personalEmail;
  const mobile = isSelf ? employee.mobile || person.mobile : person.mobile;
  // Backend mode: address and emergency contact come from the server record (masked parts arrive masked).
  const address = API_ENABLED ? person.address : isSelf ? employee.address || person.address : person.address;
  const emergencyName = API_ENABLED ? person.emergencyName ?? "" : extras.emergencyName;
  const emergencyPhone = API_ENABLED ? person.emergencyPhone ?? "" : extras.emergencyPhone;
  const emergencyRelation = API_ENABLED ? person.emergencyRelationship ?? "" : extras.emergencyRelation;
  const emergency = emergencyName ? [emergencyName, emergencyRelation].filter(Boolean).join(" · ") : "";
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
  const leaveRequests = state.leaveRequests.filter((l) => l.employeeId === person.id).slice(0, 6);

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
  const rules = payRulesFor(String(person.countryCode) as CountryCode);
  const monthly = rules.earnings.reduce((sum, line) => sum + line.amount, 0);
  const showPay = revealPay;

  const documents = state.documents.filter((d) => d.employeeId === person.id);

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

  const tabs: { id: TabId; label: string }[] = [
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
    ...(access.documents ? [{ id: "docs" as const, label: "Documents" }] : []),
    ...(access.work ? [{ id: "lifecycle" as const, label: "Lifecycle history" }] : []),
  ];
  const activeTab = tabs.some((t) => t.id === tab) ? tab : "personal";

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

      {summaryOn && (
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

      <Tabs tabs={tabs} value={activeTab} onChange={(id) => setTab(id as TabId)} />

      {activeTab === "personal" && (
        <Card title="Personal information">
          <dl className="info-grid">
            {access.personal && <Fact label="Employee ID" value={person.employeeCode} />}
            <Fact label="First name" value={person.firstName} />
            {access.personal && <Fact label="Middle name" value={person.middleName ?? ""} />}
            <Fact label="Last name" value={person.lastName} />
            <Fact label="Preferred name" value={preferredName} />
            <Fact label="Work email" value={person.email} />
            {access.personal && (
              <>
                <Fact
                  label="Date of birth"
                  value={
                    <MaskedValue
                      value={person.dateOfBirth}
                      kind="dob"
                      canReveal={canReveal}
                      onReveal={personRevealer(person.id, "date_of_birth", person.dateOfBirth)}
                      format={(dob) => (isMasked(dob) ? dob : `${dob} · ${ageOn(dob, today)} yrs`)}
                    />
                  }
                />
                <Fact label="Gender" value={person.gender} />
                <Fact label="Nationality" value={person.nationality} />
                <Fact
                  label="Personal email"
                  value={
                    <MaskedValue
                      value={personalEmail}
                      kind="email"
                      canReveal={canReveal}
                      onReveal={personRevealer(person.id, "personal_email", personalEmail)}
                    />
                  }
                />
                <Fact
                  label="Phone"
                  value={<MaskedValue value={mobile} kind="phone" canReveal={canReveal} onReveal={personRevealer(person.id, "mobile", mobile)} />}
                />
                <Fact label="Address" value={<MaskedValue value={address} kind="address" canReveal={canReveal} onReveal={revealAddress} />} />
                <Fact
                  label="Emergency contact"
                  value={
                    emergency ? (
                      <>
                        {emergency}
                        {emergencyPhone && (
                          <>
                            {" · "}
                            <MaskedValue
                              value={emergencyPhone}
                              kind="phone"
                              canReveal={canReveal}
                              onReveal={personRevealer(person.id, "emergency_phone", emergencyPhone)}
                            />
                          </>
                        )}
                      </>
                    ) : (
                      "Not provided"
                    )
                  }
                />
                <Fact label="Time zone" value={person.timeZone} />
              </>
            )}
          </dl>
          {!access.personal && <p className="muted">Visible to {firstName}, their managers and HR.</p>}
        </Card>
      )}

      {activeTab === "personal" && access.personal && (
        <div className="mgr-home-grid">
          <Card title="Education">
            {person.education.length === 0 ? (
              <EmptyState title="None recorded" />
            ) : (
              <ul className="todo">
                {person.education.map((e) => (
                  <li key={`${e.degree}-${e.year}`}>
                    <strong>{e.degree}</strong> · {e.institution} · {e.year}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Experience">
            {person.experience.length === 0 ? (
              <EmptyState title={`None before ${COMPANY_NAME}`} />
            ) : (
              <ul className="todo">
                {person.experience.map((x) => (
                  <li key={`${x.employer}-${x.from}`}>
                    <strong>{x.title}</strong> · {x.employer} · {x.from.slice(0, 7)} to {x.to.slice(0, 7)}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Dependents">
            {person.dependents.length === 0 ? (
              <EmptyState title="None recorded" />
            ) : (
              <ul className="todo">
                {person.dependents.map((d) => (
                  <li key={d.name}>
                    <strong>{d.name}</strong> · {d.relation} · <MaskedValue value={d.dateOfBirth} kind="dob" canReveal={canReveal} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      {activeTab === "employment" && (
        <Card title="Employment information">
          <dl className="info-grid">
            <Fact label="Employee ID" value={person.employeeCode} />
            <Fact label="Status" value={person.employmentStatus} />
            {terminated && <Fact label="Exit date" value={exit.exitDate ?? ""} />}
            {terminated && access.isHr && <Fact label="Exit reason" value={exit.exitReason ?? ""} />}
            <Fact label="Employment type" value={person.employmentType} />
            <Fact label="Joining date" value={`${formatShortDate(person.dateOfJoining)} · ${tenureText(person.dateOfJoining, today)}`} />
            <Fact label="Work location" value={`${person.location}, ${person.countryName}`} />
            <Fact label="Work arrangement" value={person.workArrangement} />
            {person.company && <Fact label="Company" value={person.company} />}
            {access.personal && person.holidayCalendar && <Fact label="Holiday calendar" value={person.holidayCalendar} />}
            {access.personal && person.leavePolicy && <Fact label="Leave policy" value={person.leavePolicy} />}
            {access.personal && person.payrollStatus && <Fact label="Payroll status" value={person.payrollStatus} />}
            {access.personal && person.aiProfileStatus && <Fact label="AI profile status" value={person.aiProfileStatus} />}
            <Fact label="Working hours" value={schedule.hoursLabel} />
            <Fact label="Time zone" value={person.timeZone} />
          </dl>
        </Card>
      )}

      {activeTab === "org" && (
        <Card title="Org structure">
          <dl className="info-grid">
            <Fact label="Legal entity" value={person.legalEntity} />
            <Fact label="Business unit" value={person.businessUnit} />
            <Fact label="Division" value={person.division} />
            <Fact label="Department" value={person.department} />
            <Fact label="Cost center" value={person.costCenter} />
            <Fact label="Location" value={person.location} />
            <Fact label="Country" value={person.countryName} />
            <Fact label="Supervisory org" value={manager ? `${manager.fullName}'s team` : "Top of the company"} />
          </dl>
        </Card>
      )}

      {activeTab === "manager" && (
        <div className="mgr-home-grid">
          <Card title="Manager">
            {manager ? (
              <dl className="info-grid">
                <Fact label="Name" value={<Link to={`/people/${manager.id}`}>{manager.fullName}</Link>} />
                <Fact label="Title" value={manager.designation} />
                <Fact label="Department" value={manager.department} />
                <Fact label="Location" value={`${manager.location}, ${manager.countryName}`} />
              </dl>
            ) : (
              <EmptyState title="Top of the company" />
            )}
            {chain.length > 1 && (
              <p className="muted">
                Reporting line: {[...chain].reverse().map((p) => p.fullName).join(" › ")} › {person.fullName}
              </p>
            )}
          </Card>
          <Card title={`Direct reports (${reports.length})`}>
            {reports.length === 0 ? (
              <EmptyState title="No direct reports" />
            ) : (
              <ul className="todo">
                {reports.slice(0, 10).map((r) => (
                  <li key={r.id}>
                    <Link to={`/people/${r.id}`}>{r.fullName}</Link> · {r.designation}
                  </li>
                ))}
                {reports.length > 10 && <li className="muted">+{reports.length - 10} more</li>}
              </ul>
            )}
          </Card>
        </div>
      )}

      {activeTab === "job" && (
        <Card title="Job">
          <dl className="info-grid">
            <Fact label="Job title" value={person.designation} />
            <Fact label="Job family" value={person.jobFamily} />
            <Fact label="Job profile" value={jobProfileLabel(person.jobProfileId)} />
            <Fact label="Position" value={positionLabel(person)} />
            <Fact label="Grade" value={person.grade} />
          </dl>
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
          <Card title="Recent requests">
            {leaveRequests.length === 0 ? (
              <EmptyState title="No leave requests" />
            ) : (
              <ul className="todo">
                {leaveRequests.map((l) => (
                  <li key={l.id}>
                    {l.code} · {formatShortDate(l.from)}
                    {l.to !== l.from ? ` to ${formatShortDate(l.to)}` : ""} · <StatusBadge status={l.status} />
                  </li>
                ))}
              </ul>
            )}
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
            goals.map((g) => <Progress key={g.id} value={g.progress} label={`${g.title} · ${g.weight}%`} />)
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
            {certifications.length === 0 ? (
              <EmptyState title="No certifications" />
            ) : (
              <ul className="todo">
                {certifications.map((c) => (
                  <li key={c.id}>
                    {c.name} · {c.issuer} · {formatShortDate(c.earnedOn)}
                    {c.expiresOn ? ` · expires ${formatShortDate(c.expiresOn)}` : ""}
                  </li>
                ))}
              </ul>
            )}
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
            {person.dependents.length === 0 ? (
              <EmptyState title="None recorded" />
            ) : (
              <ul className="todo">
                {person.dependents.map((d) => {
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

      {activeTab === "docs" && access.documents && (
        <Card title="Documents">
          {documents.length === 0 ? (
            <EmptyState title="No documents" />
          ) : (
            <ul className="todo">
              {documents.map((d) => (
                <li key={d.id}>
                  {d.name} · {d.category} · {d.uploadedAt.slice(0, 10)}
                </li>
              ))}
            </ul>
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

    </div>
  );
}

function rank(level: string): number {
  return ["Awareness", "Working", "Intermediate", "Advanced", "Expert"].indexOf(level);
}
