import type { CopilotPersonLookup } from "../../data/platformData.ts";
import { DEMO_ACCOUNTS, managementChain, type DemoAccount } from "../../demoAccounts.ts";
import { currentCycle, weightedProgress } from "../../data/homeInsights.ts";
import { getLifecycleHistory, historyFor } from "../../data/lifecycleHistory.ts";
import type { PersonRecord } from "../../data/peopleData.ts";
import { listPeople, managerChainIds } from "../../data/peopleLocal.ts";
import { COURSES } from "../../data/talentData.ts";
import { getTalentState, skillProfileFor } from "../../data/talentLocal.ts";
import { tenureLabel } from "../../data/workforceStats.ts";
import { formatShortDate, todayISO } from "../../model.ts";

const HR_ROLES = new Set(["hr", "hr_admin", "hrbp"]);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** Who matches the name typed: an exact full name wins, otherwise names that start with or contain it. */
function matchPeople(query: string, people: readonly PersonRecord[]): PersonRecord[] {
  const q = norm(query);
  if (!q) return [];
  const exact = people.filter((p) => norm(p.fullName) === q);
  if (exact.length) return exact;
  const starts = people.filter((p) => norm(p.fullName).startsWith(q) || norm(p.fullName).split(" ").some((w) => w === q));
  if (starts.length) return starts;
  return people.filter((p) => norm(p.fullName).includes(q));
}

/** HR, the person themselves, or anyone above them in the reporting line. */
export function canSummarise(viewer: Pick<DemoAccount, "id" | "role">, personId: string): boolean {
  if (HR_ROLES.has(viewer.role) || viewer.id === personId) return true;
  return managerChainIds(personId).includes(viewer.id) || managementChain(personId, DEMO_ACCOUNTS).some((m) => m.id === viewer.id);
}

/** Employee 360 summary for Copilot. Never reads or returns pay. */
export function summarisePersonFor(viewer: Pick<DemoAccount, "id" | "role">, query: string): CopilotPersonLookup {
  const people = listPeople();
  const matches = matchPeople(query, people);
  if (!matches.length) return { status: "not_found" };
  const active = matches.filter((p) => p.employmentStatus !== "Terminated");
  const pool = active.length ? active : matches;
  if (pool.length > 1) return { status: "ambiguous", names: pool.slice(0, 5).map((p) => p.fullName) };
  const person = pool[0];
  if (!canSummarise(viewer, person.id)) return { status: "denied" };

  const today = todayISO();
  const talent = getTalentState();
  const cycle = currentCycle(talent);
  // The persona reporting line wins over the directory record, so this matches "who is my manager".
  const managerName =
    managementChain(person.id, DEMO_ACCOUNTS)[0]?.fullName ||
    person.managerName || people.find((p) => p.id === person.managerId)?.fullName || DEMO_ACCOUNTS.find((a) => a.id === person.managerId)?.fullName;
  const tenure = tenureLabel(person.dateOfJoining, today);

  const goals = talent.goals.filter((g) => g.ownerId === person.id && g.cycleId === cycle.id);
  const review = talent.reviews.find((r) => r.employeeId === person.id && r.cycleId === cycle.id);
  const enrollments = talent.enrollments.filter((e) => e.employeeId === person.id);
  const completed = enrollments.filter((e) => e.status === "Completed").length;
  const skills = skillProfileFor(talent, person.id);
  const LEVELS = ["Awareness", "Working", "Intermediate", "Advanced", "Expert"];
  const gaps = skills.filter((s) => LEVELS.indexOf(s.level) < LEVELS.indexOf(s.targetLevel));
  const events = historyFor(person.id, getLifecycleHistory()).slice(0, 3);

  const rows: string[][] = [
    ...goals.map((g) => ["Goal", `${g.title} · ${g.progress}% (weight ${g.weight}%)`]),
    ...skills.slice(0, 4).map((s) => ["Skill", `${s.skillName} · ${s.level}${s.level !== s.targetLevel ? ` → ${s.targetLevel}` : ""}`]),
    ...enrollments
      .filter((e) => e.status !== "Completed")
      .slice(0, 3)
      .map((e) => ["Learning", `${COURSES.find((c) => c.id === e.courseId)?.title ?? "Course"} · ${e.progress}%${e.due ? ` · due ${formatShortDate(e.due)}` : ""}`]),
    ...events.map((e) => [e.type, `${e.before} → ${e.after} · ${formatShortDate(e.effectiveDate)}`]),
  ];

  const notes: string[] = [];
  if (person.employmentStatus !== "Active") notes.push(`Status: ${person.employmentStatus}.`);
  if (!events.length) notes.push("No recorded job changes.");

  return {
    status: "ok",
    id: person.id,
    name: person.fullName,
    headline: `${person.fullName} is ${/^[aeiou]/i.test(person.designation) ? "an" : "a"} ${person.designation} in ${person.department}, ${person.location || person.countryName}. ${
      managerName ? `Reports to ${managerName}. ` : ""
    }Joined ${formatShortDate(person.dateOfJoining)} (${tenure}).`,
    metrics: [
      { label: "Role", value: person.designation || "—" },
      { label: "Department", value: person.department || "—" },
      { label: "Manager", value: managerName ?? "—" },
      { label: "Tenure", value: tenure },
      { label: `Goals · ${cycle.name}`, value: goals.length ? `${weightedProgress(goals)}% across ${goals.length}` : "None set" },
      {
        label: "Review",
        value: review ? `Self ${review.selfStatus.toLowerCase()} · Manager ${review.managerStatus.toLowerCase()}` : "Not in this cycle",
      },
      { label: "Learning", value: enrollments.length ? `${completed} of ${enrollments.length} completed` : "No courses" },
      { label: "Skills", value: skills.length ? `${skills.length} tracked · ${gaps.length} below target` : "No profile" },
    ],
    table: rows.length ? { headers: ["Area", "Detail"], rows } : undefined,
    notes,
  };
}
