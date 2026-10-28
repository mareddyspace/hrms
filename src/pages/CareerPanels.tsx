import { useState, useSyncExternalStore, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Banner, Card, DataTable, EmptyState, Field, StatusBadge } from "../components/ui.tsx";
import { TARGET_ROLES } from "../data/talentData.ts";
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
  type CareerTimeframe,
  type TalentActor,
} from "../data/talentLocal.ts";
import { rankRoles } from "../data/careerMatch.ts";
import { openPostings } from "../features/talentplus/jobBoardStore.ts";
import { accountHasNavAccess, type DemoAccount } from "../demoAccounts.ts";
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

const ROLE_IDS = TARGET_ROLES.map((r) => r.id);
const roleTitle = (id: string) => TARGET_ROLES.find((r) => r.id === id)?.title ?? id;

function nameOf(id: string): string {
  return getPerson(id)?.fullName ?? taskPersonById(id)?.fullName ?? id;
}

function plusDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* ───────────── My career interests ───────────── */

export function CareerInterestsPanel({ me }: { me: TalentActor }) {
  const list = useInterests();
  const saved = careerInterestsFor(me.id, list);
  const [roles, setRoles] = useState<string[]>(saved?.targetRoleIds ?? []);
  const [functions, setFunctions] = useState<string[]>(saved?.functions ?? []);
  const [relocate, setRelocate] = useState(saved?.openToRelocation ?? false);
  const [timeframe, setTimeframe] = useState<CareerTimeframe>(saved?.timeframe ?? "6–12 months");
  const [note, setNote] = useState(saved?.note ?? "");
  const [notice, setNotice] = useState<Notice>(null);

  const toggle = (value: string, current: string[], set: (v: string[]) => void) =>
    set(current.includes(value) ? current.filter((v) => v !== value) : [...current, value]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const error = saveCareerInterests(me, { targetRoleIds: roles, functions, openToRelocation: relocate, timeframe, note }, ROLE_IDS);
    setNotice(error ? { tone: "err", text: error } : { tone: "ok", text: "Career interests saved. Your manager and HR can see them." });
  }

  return (
    <Card title="My career interests">
      <form className="stack" onSubmit={submit}>
        <Banner message={notice} />
        <p className="muted">Visible to you, your manager and HR. {saved ? `Last updated ${saved.updatedOn}.` : "Not shared yet."}</p>
        <fieldset className="stack">
          <legend>Target roles (up to 3)</legend>
          <div className="row-gap" style={{ flexWrap: "wrap" }}>
            {TARGET_ROLES.map((r) => (
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
          <button className="btn" type="submit">Save interests</button>
        </div>
      </form>
    </Card>
  );
}

/* ───────────── Role matches ───────────── */

export function RoleMatchesPanel({ me }: { me: DemoAccount }) {
  const talent = useTalent();
  const list = useInterests();
  const [notice, setNotice] = useState<Notice>(null);
  const [open, setOpen] = useState<string | null>(null);
  const interests = careerInterestsFor(me.id, list);
  const skills = skillProfileFor(talent, me.id);
  const person = getPerson(me.id);
  const learner = { id: me.id, fullName: me.fullName, role: me.role, department: person?.department ?? me.department };
  const myEnrollments = talent.enrollments.filter((e) => e.employeeId === me.id);
  const seesJobs = accountHasNavAccess(me, "internaljobs");
  const review = openDevPlanReview(talent, me.id);
  const planTitles = review ? devActionsOf(review).map((a) => a.title) : [];

  const matches = rankRoles({
        skills,
        interests,
        currentTitle: person?.designation ?? me.designation,
        homeLocation: person?.countryName ?? me.countryName,
        openings: seesJobs ? openPostings() : [],
        courseOpen: (c) => courseOpenTo(c, learner),
        completedCourseIds: myEnrollments.filter((e) => e.status === "Completed").map((e) => e.courseId),
      });

  const planText = (courseTitle: string, skill: string) => `Complete "${courseTitle}" to build ${skill}`;

  return (
    <div className="stack">
      <Banner message={notice} />
      {!interests && (
        <p className="note info">Add your career interests to rank roles by what you want next, not only by skills.</p>
      )}
      <Card title="Top role matches">
        {matches.length === 0 ? (
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
        <p className="muted">Match compares your skills profile with each role's required levels. Keep your profile current for better matches.</p>
      </Card>

      {matches
        .filter((m) => m.role.key === open)
        .map((m) => (
          <Card key={m.role.key} title={`Path to ${m.role.title}`}>
            {m.gaps.length === 0 ? (
              <EmptyState
                title="You meet every skill requirement"
                description={m.role.postingId ? "This job is open now." : "Talk to your manager about next steps."}
              />
            ) : (
              <div className="stack">
                {m.gaps.map((g) => (
                  <div key={g.skillId} className="stack">
                    <strong>
                      {g.name}: {g.have} → {g.need}
                    </strong>
                    {g.courses.length === 0 ? (
                      <p className="muted">No course in the catalogue yet — agree a stretch task with your manager.</p>
                    ) : (
                      <ul className="todo">
                        {g.courses.map((c) => {
                          const enrolled = myEnrollments.some((e) => e.courseId === c.id);
                          const text = planText(c.title, g.name);
                          const inPlan = planTitles.includes(text);
                          return (
                            <li key={c.id}>
                              {c.title} · {c.durationHours}h{" "}
                              {enrolled ? (
                                <span className="muted">· Enrolled </span>
                              ) : (
                                <button
                                  className="btn-ghost btn-tiny"
                                  type="button"
                                  onClick={() => {
                                    const error = enrollInCourse(learner, c.id);
                                    setNotice(error ? { tone: "err", text: error } : { tone: "ok", text: `Enrolled in ${c.title}.` });
                                  }}
                                >
                                  Enroll
                                </button>
                              )}{" "}
                              {review &&
                                (inPlan ? (
                                  <span className="muted">· In your plan</span>
                                ) : (
                                  <button
                                    className="btn btn-tiny"
                                    type="button"
                                    onClick={() => {
                                      const error = addDevAction(me, review.id, { title: text, due: plusDays(60) });
                                      setNotice(error ? { tone: "err", text: error } : { tone: "ok", text: "Added to your development plan." });
                                    }}
                                  >
                                    Add to my development plan
                                  </button>
                                ))}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                ))}
                <p className="muted">
                  {review ? "Plan items show under Performance → Development plan." : "No open review cycle — enroll directly or ask your manager to add a plan item."}{" "}
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
  const rows = visibleCareerInterests(me, list).sort((a, b) => nameOf(a.employeeId).localeCompare(nameOf(b.employeeId)));
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
