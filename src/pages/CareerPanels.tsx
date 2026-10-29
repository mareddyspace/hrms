import { useEffect, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { ActionButton, Banner, Card, DataTable, EmptyState, Field, StatusBadge, SubmitButton, notify, useAction } from "../components/ui.tsx";
import { SKILL_LIBRARY, TARGET_ROLES, type Course } from "../data/talentData.ts";
import { API_ENABLED } from "../api/client.ts";
import {
  apiAddSkill,
  apiRetireSkill,
  apiRoleMatches,
  apiSaveCareerProfile,
  apiTargetRoles,
  careerMirror,
  toInterests,
  type CareerMatchesOut,
} from "../api/syncCareer.ts";
import {
  addDevAction,
  CAREER_FUNCTIONS,
  CAREER_TIMEFRAMES,
  careerInterestsFor,
  courseOpenTo,
  devActionsOf,
  enrollInCourse,
  getCareerInterestsList,
  getTalentState,
  isHrRole,
  openDevPlanReview,
  saveCareerInterests,
  skillProfileFor,
  subscribeTalent,
  visibleCareerInterests,
  courseCatalog,
  talentAction,
  type CareerTimeframe,
  type TalentActor,
  type TalentResult,
} from "../data/talentLocal.ts";
import { rankRoles, type RoleMatch } from "../data/careerMatch.ts";
import { openPostings } from "../features/talentplus/jobBoardStore.ts";
import { accountHasNavAccess, managementChain, type DemoAccount } from "../demoAccounts.ts";
import { getPerson } from "../data/peopleLocal.ts";
import { taskPersonById, taskTeamFor } from "../data/taskTeam.ts";
import { todayISO } from "../model.ts";

type Notice = { tone: "ok" | "err"; text: string } | null;

function useTalent() {
  return useSyncExternalStore(subscribeTalent, getTalentState, getTalentState);
}

function useInterests() {
  return useSyncExternalStore(subscribeTalent, getCareerInterestsList, getCareerInterestsList);
}

/** Backend mode: skills library, career paths and profiles from the server (api/syncCareer.ts). */
function useCareer() {
  return useSyncExternalStore(careerMirror.subscribe, careerMirror.get, careerMirror.get);
}

const targetRoles = () => apiTargetRoles() ?? TARGET_ROLES;
const roleTitle = (id: string) => targetRoles().find((r) => r.id === id)?.title ?? id;

function personName(id: string): string {
  return getPerson(id)?.fullName ?? taskPersonById(id)?.fullName ?? id;
}

/** talentAction as a promise, so the button waits for the backend call. */
function runTalent(change: () => TalentResult): Promise<TalentResult> {
  return new Promise((resolve) => talentAction(change, resolve));
}

function plusDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* ───────────── My career interests ───────────── */

export function CareerInterestsPanel({ me }: { me: TalentActor }) {
  const list = useInterests();
  const career = useCareer();
  if (API_ENABLED) {
    const saved = toInterests(career.me);
    return <InterestsForm key={career.me?.updated_at ?? "new"} me={me} saved={saved} mentor={career.me?.mentor_name ?? null} />;
  }
  return <InterestsForm me={me} saved={careerInterestsFor(me.id, list)} mentor={null} />;
}

function InterestsForm({ me, saved, mentor }: { me: TalentActor; saved: ReturnType<typeof careerInterestsFor>; mentor: string | null }) {
  const [roles, setRoles] = useState<string[]>(saved?.targetRoleIds ?? []);
  const [functions, setFunctions] = useState<string[]>(saved?.functions ?? []);
  const [relocate, setRelocate] = useState(saved?.openToRelocation ?? false);
  const [timeframe, setTimeframe] = useState<CareerTimeframe>(saved?.timeframe ?? "6–12 months");
  const [note, setNote] = useState(saved?.note ?? "");
  const [notice, setNotice] = useState<Notice>(null);

  const toggle = (value: string, current: string[], set: (v: string[]) => void) =>
    set(current.includes(value) ? current.filter((v) => v !== value) : [...current, value]);

  // The CEO has no manager: his interests are shared with HR only.
  const sharedWith = managementChain(me.id).length > 0 ? "your manager and HR" : "HR";
  const ok = { tone: "ok" as const, text: `Career interests saved. ${sharedWith === "HR" ? "HR" : "Your manager and HR"} can see them.` };
  const saveAct = useAction();
  async function submit() {
    const input = { targetRoleIds: roles, functions, openToRelocation: relocate, timeframe, note };
    const error = API_ENABLED ? await apiSaveCareerProfile(input) : saveCareerInterests(me, input, TARGET_ROLES.map((r) => r.id));
    setNotice(error ? { tone: "err", text: error } : ok);
    if (!error) notify(`Career interests saved and shared with ${sharedWith}.`);
    return error;
  }

  return (
    <Card title="My career interests">
      <form className="stack" onSubmit={saveAct.submit(submit)}>
        <Banner message={notice} />
        <p className="muted">
          Visible to you{sharedWith === "HR" ? " and HR" : ", your manager and HR"}. {saved ? `Last updated ${saved.updatedOn}.` : "Not shared yet."}
          {mentor ? ` Mentor: ${mentor}.` : ""}
        </p>
        <fieldset className="stack">
          <legend>Target roles (up to 3)</legend>
          <div className="row-gap" style={{ flexWrap: "wrap" }}>
            {targetRoles().map((r) => (
              <label key={r.id} className="row-gap">
                <input type="checkbox" checked={roles.includes(r.id)} onChange={() => toggle(r.id, roles, setRoles)} />
                <span>{r.title}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="stack">
          <legend>Preferred functions</legend>
          <div className="row-gap" style={{ flexWrap: "wrap" }}>
            {CAREER_FUNCTIONS.map((f) => (
              <label key={f} className="row-gap">
                <input type="checkbox" checked={functions.includes(f)} onChange={() => toggle(f, functions, setFunctions)} />
                <span>{f}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="form-grid-2">
          <Field label="Timeframe">
            <select value={timeframe} onChange={(e) => setTimeframe(e.target.value as CareerTimeframe)}>
              {CAREER_TIMEFRAMES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </Field>
          <Field label="Open to relocation">
            <select value={relocate ? "yes" : "no"} onChange={(e) => setRelocate(e.target.value === "yes")}>
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </select>
          </Field>
          <Field label="Anything else (optional)" wide>
            <textarea value={note} maxLength={500} rows={3} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
        <div className="row-gap">
          <SubmitButton action={saveAct} className="btn">Save interests</SubmitButton>
        </div>
      </form>
    </Card>
  );
}

/* ───────────── Role matches ───────────── */

type ServerMatch = CareerMatchesOut["matches"][number];

/** Backend mode: role matches computed on the server (same rules as careerMatch.ts), with courses and a timeline. */
function useServerMatches(employeeId: string): CareerMatchesOut | null {
  const career = useCareer();
  const [data, setData] = useState<CareerMatchesOut | null>(null);
  const savedAt = career.me?.updated_at ?? "";
  useEffect(() => {
    if (!API_ENABLED) return;
    let live = true;
    apiRoleMatches()
      .then((d) => {
        if (live) setData(d);
      })
      .catch(() => {
        if (live) setData({ employee_id: employeeId, skills_saved: false, matches: [] });
      });
    return () => {
      live = false;
    };
  }, [employeeId, savedAt]);
  return data;
}

function fromServer(m: ServerMatch, catalog: Course[]): RoleMatch & { timeline: ServerMatch["timeline"] } {
  const course = (c: { id: string; title: string; duration_hours: number }): Course =>
    catalog.find((x) => x.id === c.id) ?? { id: c.id, title: c.title, category: "", durationHours: c.duration_hours, mandatory: false, audience: "All", skills: [] };
  return {
    role: {
      key: m.key,
      title: m.title,
      source: m.source,
      function: m.function,
      required: {},
      ...(m.target_role_id ? { targetRoleId: m.target_role_id } : {}),
      ...(m.location ? { location: m.location } : {}),
      ...(m.posting_id ? { postingId: m.posting_id } : {}),
    },
    match: m.match,
    score: m.score,
    reasons: m.reasons,
    gaps: m.gaps.map((g) => ({ skillId: g.skill_id, name: g.name, have: g.have, need: g.need, levels: g.levels, courses: g.courses.map(course) })),
    timeline: m.timeline,
  };
}

export function RoleMatchesPanel({ me }: { me: DemoAccount }) {
  const talent = useTalent();
  const list = useInterests();
  const career = useCareer();
  const server = useServerMatches(me.id);
  const [notice, setNotice] = useState<Notice>(null);
  const [open, setOpen] = useState<string | null>(null);
  const interests = API_ENABLED ? toInterests(career.me) : careerInterestsFor(me.id, list);
  const skills = skillProfileFor(talent, me.id);
  const person = getPerson(me.id);
  const learner = { id: me.id, fullName: me.fullName, role: me.role, department: person?.department ?? me.department };
  const myEnrollments = talent.enrollments.filter((e) => e.employeeId === me.id);
  // Backend mode: the server picks each gap's courses (open to the person, not completed yet).
  const gapCourses = (g: { skillId: string; courses: Course[] }): Course[] => g.courses;
  const seesJobs = accountHasNavAccess(me, "internaljobs");
  const review = openDevPlanReview(talent, me.id);
  const planTitles = review ? devActionsOf(review).map((a) => a.title) : [];

  const local = API_ENABLED ? [] : rankRoles({
        skills,
        interests,
        currentTitle: person?.designation ?? me.designation,
        homeLocation: person?.countryName ?? me.countryName,
        openings: seesJobs ? openPostings() : [],
        courseOpen: (c) => courseOpenTo(c, learner),
        completedCourseIds: myEnrollments.filter((e) => e.status === "Completed").map((e) => e.courseId),
      });
  const matches: (RoleMatch & { timeline?: ServerMatch["timeline"] })[] = API_ENABLED
    ? (server?.matches ?? []).map((m) => fromServer(m, courseCatalog()))
    : local;

  const planText = (courseTitle: string, skill: string) => `Complete "${courseTitle}" to build ${skill}`;

  return (
    <div className="stack">
      <Banner message={notice} />
      {!interests && (
        <p className="note info">Add career interests for better matches.</p>
      )}
      <Card title="Top role matches">
        {API_ENABLED && !server ? (
          <p className="muted">Loading matches…</p>
        ) : matches.length === 0 ? (
          <EmptyState title="No roles to suggest" />
        ) : (
          <DataTable
            headers={["Role", "Match", "Why", "Gap skills", ""]}
            rows={matches.map((m) => [
              <span key="r">
                <strong>{m.role.title}</strong>
                <span className="muted" style={{ display: "block" }}>
                  {m.role.source}
                  {m.role.location ? ` · ${m.role.location}` : ""}
                </span>
              </span>,
              <StatusBadge key="m" status={`${m.match}%`} tone={m.match >= 80 ? "ok" : m.match >= 55 ? "warn" : "neutral"} literal />,
              m.reasons.join(" · ") || "Skills fit",
              m.gaps.length ? m.gaps.map((g) => `${g.name} (${g.have} → ${g.need})`).join(", ") : "None",
              <button key="b" className="btn-ghost btn-tiny" type="button" onClick={() => setOpen(open === m.role.key ? null : m.role.key)}>
                {open === m.role.key ? "Hide path" : "Development path"}
              </button>,
            ])}
          />
        )}
      </Card>

      {matches
        .filter((m) => m.role.key === open)
        .map((m) => (
          <Card key={m.role.key} title={`Path to ${m.role.title}`}>
            {m.gaps.length === 0 ? (
              <EmptyState
                title="You meet every skill requirement"
                description={m.role.postingId ? "This job is open now." : managementChain(me.id).length > 0 ? "Talk to your manager about next steps." : "Talk to HR about next steps."}
              />
            ) : (
              <div className="stack">
                {m.gaps.map((g) => (
                  <div key={g.skillId} className="stack">
                    <strong>
                      {g.name}: {g.have} → {g.need}
                    </strong>
                    {gapCourses(g).length === 0 ? (
                      <p className="muted">No course yet.</p>
                    ) : (
                      <ul className="todo">
                        {gapCourses(g).map((c) => {
                          const enrolled = myEnrollments.some((e) => e.courseId === c.id);
                          const text = planText(c.title, g.name);
                          const inPlan = planTitles.includes(text);
                          return (
                            <li key={c.id}>
                              {c.title} · {c.durationHours}h{" "}
                              {enrolled ? (
                                <span className="muted">· Enrolled </span>
                              ) : (
                                <ActionButton
                                  className="btn-ghost btn-tiny"
                                  success={`Enrolled in ${c.title}.`}
                                  onAction={async () => {
                                    const error = await runTalent(() => enrollInCourse(learner, c.id));
                                    setNotice(error ? { tone: "err", text: error } : { tone: "ok", text: `Enrolled in ${c.title}.` });
                                    return error;
                                  }}
                                >
                                  Enroll
                                </ActionButton>
                              )}{" "}
                              {review &&
                                (inPlan ? (
                                  <span className="muted">· In your plan</span>
                                ) : (
                                  <ActionButton
                                    className="btn btn-tiny"
                                    success="Added to your development plan."
                                    onAction={async () => {
                                      const error = await runTalent(() => addDevAction(me, review.id, { title: text, due: plusDays(60) }));
                                      setNotice(error ? { tone: "err", text: error } : { tone: "ok", text: "Added to your development plan." });
                                      return error;
                                    }}
                                  >
                                    Add to my development plan
                                  </ActionButton>
                                ))}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                ))}
                {m.timeline && m.timeline.length > 0 && (
                  <div className="stack">
                    <strong>Suggested timeline</strong>
                    <ul className="todo">
                      {m.timeline.map((t) => (
                        <li key={`${t.from_week}-${t.text}`}>
                          Weeks {t.from_week}–{t.to_week}: {t.text}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <p className="muted">
                  {review ? "Plan items show under Performance → Development plan." : managementChain(me.id).length > 0 ? "No open review cycle — enroll directly or ask your manager to add a plan item." : "No open review cycle — enroll directly."}{" "}
                  {m.role.postingId && seesJobs && <Link to="/internal-jobs">See the job</Link>}
                </p>
              </div>
            )}
          </Card>
        ))}
    </div>
  );
}

/* ───────────── Team interests (manager / HR) ───────────── */

/** Managers (anyone with people below them) and HR see their team's interests. */
export function canSeeTeamInterests(actor: TalentActor): boolean {
  return isHrRole(actor.role) || taskTeamFor(actor.id).length > 0;
}

export function TeamInterestsPanel({ me }: { me: TalentActor }) {
  const list = useInterests();
  const career = useCareer();
  const serverNames = new Map(career.team.map((p) => [p.employee_id, p.employee_name ?? p.employee_id]));
  const nameOf = (id: string) => serverNames.get(id) ?? personName(id);
  const source = API_ENABLED ? career.team.map(toInterests).filter((i): i is NonNullable<typeof i> => !!i) : visibleCareerInterests(me, list);
  const rows = [...source].sort((a, b) => nameOf(a.employeeId).localeCompare(nameOf(b.employeeId)));
  const today = todayISO();
  return (
    <Card title="Team career interests">
      <DataTable
        headers={["Person", "Target roles", "Functions", "Timeframe", "Relocation", "Updated"]}
        rows={rows.map((i) => [
          <span key="p">
            <strong>{nameOf(i.employeeId)}</strong>
            {i.note && <span className="muted" style={{ display: "block" }}>{i.note}</span>}
          </span>,
          i.targetRoleIds.map(roleTitle).join(", ") || "—",
          i.functions.join(", ") || "—",
          i.timeframe,
          i.openToRelocation ? "Open" : "No",
          i.updatedOn === today ? "Today" : i.updatedOn,
        ])}
        empty={<EmptyState title="No career interests shared yet" />}
      />
    </Card>
  );
}

/* ───────────── Skills library ───────────── */

/** The skills library. Backend mode: from the server; HR can add and retire skills. */
export function SkillsLibraryPanel({ me }: { me: TalentActor }) {
  const career = useCareer();
  const [notice, setNotice] = useState<Notice>(null);
  const [name, setName] = useState("");
  const [category, setCategory] = useState<"technical" | "behavioural">("technical");
  const [area, setArea] = useState("");
  const [description, setDescription] = useState("");
  const addAct = useAction();
  if (!API_ENABLED) {
    return (
      <Card title="Skills library">
        <DataTable headers={["Skill", "Category", "Proficiency scale"]} rows={SKILL_LIBRARY.map((s) => [s.name, s.category, s.levels.join(" → ")])} />
      </Card>
    );
  }
  const canEdit = career.isHr && isHrRole(me.role);
  const add = async () => {
    const clean = name.trim();
    const error = await apiAddSkill({ name: clean, category, area: area.trim(), description: description.trim() });
    setNotice(error ? { tone: "err", text: error } : { tone: "ok", text: `Added ${clean}.` });
    if (!error) {
      notify(`${clean} added to the skills library.`);
      setName("");
      setArea("");
      setDescription("");
    }
    return error;
  };
  const retire = async (id: string, skillName: string) => {
    const error = await apiRetireSkill(id);
    setNotice(error ? { tone: "err", text: error } : { tone: "ok", text: `Retired ${skillName}.` });
    if (!error) notify(`${skillName} retired.`);
    return error;
  };
  const courseTitle = (id: string) => courseCatalog().find((c) => c.id === id)?.title ?? id;
  return (
    <div className="stack">
      <Banner message={notice} />
      <Card title="Skills library">
        <DataTable
          headers={["Skill", "Type", "Area", "Courses", "Certifications", ...(canEdit ? [""] : [])]}
          rows={career.skills.map((s) => [
            <span key="n">
              <strong>{s.name}</strong>
              {s.description && <span className="muted" style={{ display: "block" }}>{s.description}</span>}
            </span>,
            s.category === "technical" ? "Technical" : "Behavioural",
            s.area ?? "—",
            s.related_course_ids.map(courseTitle).join(", ") || "—",
            s.certifications.join(", ") || "—",
            ...(canEdit
              ? [
                  s.active ? (
                    <ActionButton key="r" className="btn-ghost btn-tiny" busyLabel="Retiring…" doneLabel="Retired" onAction={() => retire(s.id, s.name)}>
                      Retire
                    </ActionButton>
                  ) : (
                    <span key="r" className="muted">Retired</span>
                  ),
                ]
              : []),
          ])}
          empty={<EmptyState title="No skills yet" />}
        />
      </Card>
      {canEdit && (
        <Card title="Add a skill">
          <form className="stack" onSubmit={addAct.submit(add)}>
            <div className="form-grid-2">
              <Field label="Name">
                <input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Type">
                <select value={category} onChange={(e) => setCategory(e.target.value as "technical" | "behavioural")}>
                  <option value="technical">Technical</option>
                  <option value="behavioural">Behavioural</option>
                </select>
              </Field>
              <Field label="Area (optional)">
                <input value={area} maxLength={64} onChange={(e) => setArea(e.target.value)} />
              </Field>
              <Field label="Description (optional)" wide>
                <textarea value={description} maxLength={1000} rows={2} onChange={(e) => setDescription(e.target.value)} />
              </Field>
            </div>
            <div className="row-gap">
              <SubmitButton action={addAct} className="btn" disabled={name.trim().length < 2}>
                Add skill
              </SubmitButton>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
