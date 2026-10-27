import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Award,
  Briefcase,
  Building2,
  CalendarDays,
  Check,
  Clock,
  Copy,
  Lock,
  Pencil,
  Mail,
  MapPin,
  MessageCircle,
  Phone,
  Sparkles,
  Users,
  Video,
} from "lucide-react";
import { COMPANY_NAME } from "../brand.ts";
import { Banner, Card, Dialog, EmptyState, Field, Page } from "../components/ui.tsx";
import { SelfProfileEditor } from "../components/SelfProfileEditor.tsx";
import { initials } from "../components/OrgChart.tsx";
import { saveLocalMeeting } from "../data/calendarData.ts";
import { startDirectChat } from "../data/collabLocal.ts";
import type { PersonRecord } from "../data/peopleData.ts";
import { getLifecycleHistory, isScheduled, subscribeLifecycleHistory, timelineFor } from "../data/lifecycleHistory.ts";
import { canOpenFullRecord, profileAccessFor } from "../data/profileAccess.ts";
import { skillsFor } from "../data/careerProfile.ts";
import { getExitDetails, getPerson, isTerminated, listPeople, subscribePeople } from "../data/peopleLocal.ts";
import { canManagePeople } from "../data/peoplePermissions.ts";
import { getTalentState, subscribeTalent } from "../data/talentLocal.ts";
import { getLinksState, setLinkedIn, subscribeLinks } from "../data/socialLinks.ts";
import type { DemoAccount } from "../demoAccounts.ts";
import { todayISO } from "../model.ts";
import { usePortal } from "../store.tsx";
import { Employee360View } from "./Employee360View.tsx";
import { EmployeeFormDialog, saveEmployee } from "./EmployeeFormDialog.tsx";

/** What a coworker sees about someone — no pay, leave balances or other HR-only records. */
type ProfilePerson = {
  id: string;
  fullName: string;
  designation: string;
  department: string;
  email: string;
  mobile: string;
  photo: string;
  location: string;
  countryName: string;
  timeZone: string;
  employeeCode: string;
  legalEntity: string;
  employmentType: string;
  dateOfJoining?: string;
  availability?: string;
  shiftHours?: string;
  managerId?: string;
  managerName?: string;
  record?: PersonRecord;
};

function fromAccount(account: DemoAccount, record?: PersonRecord): ProfilePerson {
  return {
    id: account.id,
    fullName: account.fullName,
    designation: account.designation,
    department: account.department ?? record?.department ?? "",
    email: account.email,
    mobile: account.mobile,
    photo: account.photo,
    location: account.location ?? record?.location ?? "",
    countryName: account.countryName ?? record?.countryName ?? "",
    timeZone: account.timeZone,
    employeeCode: account.employeeCode,
    legalEntity: account.legalEntity ?? record?.legalEntity ?? "",
    employmentType: account.employmentType,
    dateOfJoining: record?.dateOfJoining,
    availability: record?.availability,
    shiftHours: account.shiftHours,
    managerId: account.reportsToId,
    record,
  };
}

function fromRecord(record: PersonRecord): ProfilePerson {
  return {
    id: record.id,
    fullName: record.fullName,
    designation: record.designation,
    department: record.department,
    email: record.email,
    mobile: record.mobile,
    photo: record.photo,
    location: record.location,
    countryName: record.countryName,
    timeZone: record.timeZone,
    employeeCode: record.employeeCode,
    legalEntity: record.legalEntity,
    employmentType: record.employmentType,
    dateOfJoining: record.dateOfJoining,
    availability: record.availability,
    managerId: record.managerId,
    managerName: record.managerName,
    record,
  };
}

function Avatar({ name, photo, size = 40 }: { name: string; photo?: string; size?: number }) {
  return (
    <span className="profile-avatar" style={{ width: size, height: size, fontSize: size * 0.36 }} aria-hidden>
      {photo && photo !== "/profile.svg" ? <img src={photo} alt="" /> : initials(name)}
    </span>
  );
}

function localTime(timeZone: string, now: Date): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(now);
  } catch {
    return "";
  }
}

function tenure(dateOfJoining: string, today: string): string {
  const [y1, m1] = dateOfJoining.split("-").map(Number);
  const [y2, m2] = today.split("-").map(Number);
  const months = (y2 - y1) * 12 + (m2 - m1);
  if (months < 1) return "Joined this month";
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return [years ? `${years} yr${years > 1 ? "s" : ""}` : "", rest ? `${rest} mo` : ""].filter(Boolean).join(" ");
}

function nextHalfHour(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * The one profile page. `/info` (My profile) and `/directory/:id` render it via `personId`;
 * `/people/:id` renders it from the route. HR can edit the employee record from here.
 */
export function PersonProfilePage({ personId }: { personId?: string } = {}) {
  const params = useParams();
  const id = personId ?? params.id ?? "";
  const navigate = useNavigate();
  const { employee, demoAccounts, demoProfile } = usePortal();
  const people = useSyncExternalStore(subscribePeople, listPeople, listPeople);
  const talent = useSyncExternalStore(subscribeTalent, getTalentState, getTalentState);
  const links = useSyncExternalStore(subscribeLinks, getLinksState, getLinksState);
  const history = useSyncExternalStore(subscribeLifecycleHistory, getLifecycleHistory, getLifecycleHistory);
  const [hrEditOpen, setHrEditOpen] = useState(false);
  const now = useNow();
  const today = todayISO();
  const [meetOpen, setMeetOpen] = useState(false);
  const [banner, setBanner] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);

  // Opening another person's profile from this one reuses the page, so clear the last banner.
  useEffect(() => {
    setBanner(null);
    setEditing(false);
    setHrEditOpen(false);
  }, [id]);

  const person = useMemo<ProfilePerson | null>(() => {
    // Your own profile uses the live signed-in record so edits (name, mobile, photo) show immediately.
    const account = id === employee.id ? { ...demoProfile, ...employee } : demoAccounts.find((a) => a.id === id);
    const record = getPerson(id) ?? people.find((p) => p.id === id);
    if (account) return fromAccount(account, record);
    return record ? fromRecord(record) : null;
  }, [id, demoAccounts, people, employee, demoProfile]);

  // Your own profile lives at /info so "My profile" in the menu stays highlighted.
  if (!personId && id === employee.id) return <Navigate to="/info" replace />;

  if (!person) {
    return (
      <Page title="Profile">
        <EmptyState title="Person not found" description="It may have been removed." />
        <Link to="/org-chart" className="btn">
          Back to org chart
        </Link>
      </Page>
    );
  }

  const isMe = person.id === employee.id;
  // Personal details: the person, anyone up their reporting line, and HR. Other sections have their own rules.
  const access = profileAccessFor(demoProfile, person.id, employee.id);
  const canSeePersonal = access.personal;
  const canOpenRecord = canOpenFullRecord(access) && Boolean(person.record);
  // Someone who has left keeps a read-only profile: no chat, email or meeting actions.
  const hasLeft = isTerminated(person.record);
  const managerId = person.record?.managerId ?? person.managerId;
  const manager = managerId && managerId !== person.id ? people.find((p) => p.id === managerId) : undefined;
  const managerName = manager?.fullName ?? (managerId ? person.managerName : "");
  const managerTitle = manager?.designation ?? "";

  const reports = people
    .filter((p) => p.managerId === person.id && p.id !== person.id && !isTerminated(p))
    .map((p) => ({ id: p.id, name: p.fullName, title: p.designation, photo: p.photo }));
  const peers = manager
    ? people.filter((p) => p.managerId === manager.id && p.id !== person.id && !isTerminated(p)).slice(0, 6)
    : [];

  const skills = person.record
    ? skillsFor(talent.skillProfiles, person.record)
    : talent.skillProfiles.find((sp) => sp.employeeId === person.id)?.skills ?? [];
  const career = person.record ? timelineFor({ ...person.record, ...getExitDetails(person.record) }, history) : [];
  const canHrEdit = canManagePeople(demoProfile.role) && !isMe && Boolean(person.record);
  const certs = talent.certifications.filter((c) => c.employeeId === person.id);
  const praise = talent.feedback.filter((f) => f.kind === "Praise" && f.toId === person.id);
  const theirTime = localTime(person.timeZone, now);
  const myTime = localTime(employee.timeZone, now);
  const firstName = person.fullName.split(" ")[0];

  function openChat() {
    const conversationId = startDirectChat(person!.id, person!.fullName, employee.id, employee.fullName);
    navigate(`/chat?c=${encodeURIComponent(conversationId)}`);
  }

  async function copyEmail() {
    try {
      await navigator.clipboard.writeText(person!.email);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setBanner({ tone: "err", text: "Could not copy the email." });
    }
  }

  return (
    <Page title={isMe ? "My profile" : person.fullName} hideBreadcrumbs={!personId}>
      {!personId && (
        <button type="button" className="btn-ghost btn-tiny profile-back" onClick={() => navigate(-1)}>
          <ArrowLeft size={14} aria-hidden /> Back
        </button>
      )}

      <section className="profile-hero" aria-label={`${person.fullName} profile header`}>
        <div className="profile-cover" aria-hidden />
        <div className="profile-hero-body">
          <Avatar name={person.fullName} photo={person.photo} size={104} />
          <div className="profile-identity">
            <h2>
              {person.fullName}
              {isMe && <span className="profile-you">You</span>}
            </h2>
            <p className="profile-title">
              {person.designation}
              {person.department ? ` · ${person.department}` : ""}
            </p>
            <ul className="profile-chips">
              {hasLeft && <li className="profile-left-chip">No longer with the company</li>}
              {!hasLeft && person.availability && (
                <li>
                  <span className={`presence-dot ${person.availability === "On Leave" ? "away" : "on"}`} aria-hidden />
                  {person.availability}
                </li>
              )}
              {person.location && (
                <li>
                  <MapPin size={14} aria-hidden /> {person.location}
                  {person.countryName ? `, ${person.countryName}` : ""}
                </li>
              )}
              {theirTime && (
                <li title={person.timeZone}>
                  <Clock size={14} aria-hidden /> {theirTime} local time
                  {theirTime !== myTime && !isMe ? ` (you: ${myTime})` : ""}
                </li>
              )}
            </ul>
          </div>
          <div className="profile-actions">
            {canHrEdit && (
              <button type="button" className="btn" onClick={() => setHrEditOpen(true)}>
                <Pencil size={15} aria-hidden /> Edit employee
              </button>
            )}
            {isMe ? (
              <button type="button" className="btn" onClick={() => setEditing((open) => !open)}>
                <Pencil size={15} aria-hidden /> {editing ? "Close editor" : "Edit profile"}
              </button>
            ) : hasLeft ? null : (
              <>
                <button type="button" className="btn" onClick={openChat}>
                  <MessageCircle size={16} aria-hidden /> Message
                </button>
                <a className="btn-ghost" href={`mailto:${person.email}`} title={person.email}>
                  <Mail size={16} aria-hidden /> Email
                </a>
                <button type="button" className="btn-ghost" onClick={() => setMeetOpen(true)}>
                  <Video size={16} aria-hidden /> Meet
                </button>
              </>
            )}
          </div>
        </div>
      </section>

      <Banner message={banner} />

      {isMe && editing && <SelfProfileEditor onClose={() => setEditing(false)} />}

      <div className="profile-grid">
        <div className="stack">
          <Card title="About">
            <dl className="profile-facts">
              <div>
                <dt>
                  <Briefcase size={14} aria-hidden /> Role
                </dt>
                <dd>{person.designation}</dd>
              </div>
              <div>
                <dt>
                  <Building2 size={14} aria-hidden /> Department
                </dt>
                <dd>{person.department || "—"}</dd>
              </div>
              <div>
                <dt>Company</dt>
                <dd>{person.legalEntity || "—"}</dd>
              </div>
              {canSeePersonal && (
                <div>
                  <dt>Employee ID</dt>
                  <dd>{person.employeeCode}</dd>
                </div>
              )}
              {canSeePersonal && (
                <div>
                  <dt>Employment</dt>
                  <dd>{person.employmentType}</dd>
                </div>
              )}
              {canSeePersonal && person.dateOfJoining && (
                <div>
                  <dt>
                    <CalendarDays size={14} aria-hidden /> Joined
                  </dt>
                  <dd>
                    {person.dateOfJoining} · {tenure(person.dateOfJoining, today)}
                  </dd>
                </div>
              )}
              {canSeePersonal && person.shiftHours && (
                <div>
                  <dt>Working hours</dt>
                  <dd>{person.shiftHours}</dd>
                </div>
              )}
            </dl>
            {!canSeePersonal && (
              <p className="profile-private">
                <Lock size={13} aria-hidden /> Visible to {firstName}, their managers and HR.
              </p>
            )}
          </Card>

          {skills.length > 0 && (
            <Card title="Skills">
              <ul className="profile-skill-list">
                {skills.map((sk) => (
                  <li key={sk.skillId}>
                    <Sparkles size={14} aria-hidden /> {sk.skillName}
                    <span className="muted">{sk.level}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {access.work && career.length > 0 && (
            <Card title={`Career at ${COMPANY_NAME}`}>
              <ol className="profile-timeline">
                {career
                  .filter((e) => access.compensation || e.type !== "Compensation change")
                  .map((e) => (
                    <li key={e.id}>
                      <strong>
                        {e.type === "Hire" ? `Joined ${COMPANY_NAME}` : e.type}
                        {isScheduled(e) ? " · Scheduled" : ""}
                      </strong>
                      <span>
                        {e.effectiveDate}
                        {e.type === "Hire" ? ` · ${e.after}` : ` · ${e.before} → ${e.after}`}
                      </span>
                    </li>
                  ))}
              </ol>
            </Card>
          )}

          <Card title={`Recognition${praise.length ? ` (${praise.length})` : ""}`}>
            {praise.length === 0 ? (
              <EmptyState
                title="No praise yet"
              />
            ) : (
              <ul className="feedback-list">
                {praise.map((p) => (
                  <li key={p.id} className="feedback-item praise">
                    <div className="row-between">
                      <strong>From {p.fromName}</strong>
                      {p.badge && <span className="praise-badge">{p.badge}</span>}
                    </div>
                    <p>{p.message}</p>
                    <span className="muted">{p.createdOn}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="stack">
          <Card title="Contact">
            <ul className="profile-contact">
              <li>
                <Mail size={16} aria-hidden />
                {hasLeft ? <span>{person.email}</span> : <a href={`mailto:${person.email}`}>{person.email}</a>}
                <button type="button" className="icon-btn" onClick={copyEmail} aria-label="Copy email address">
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </li>
              <LinkedInRow personId={person.id} url={links[person.id]?.linkedin} editable={isMe} />
              {canSeePersonal && person.mobile && (
                <li>
                  <Phone size={16} aria-hidden />
                  <a href={`tel:${person.mobile.replace(/\s+/g, "")}`}>{person.mobile}</a>
                </li>
              )}
              {person.location && (
                <li>
                  <MapPin size={16} aria-hidden />
                  <span>
                    {person.location}
                    {person.countryName ? `, ${person.countryName}` : ""}
                  </span>
                </li>
              )}
              <li>
                <Clock size={16} aria-hidden />
                <span>
                  {theirTime} · {person.timeZone}
                </span>
              </li>
            </ul>
          </Card>

          <Card title="Organization">
            <div className="stack">
              <section>
                <h3 className="profile-subhead">Reports to</h3>
                {managerName ? (
                  // Only link when the manager has a profile; some sample managers exist as a name only.
                  <PersonLink id={manager?.id} name={managerName} title={managerTitle} photo={manager?.photo} />
                ) : (
                  <p className="muted">Top of the organization</p>
                )}
              </section>
              {reports.length > 0 && (
                <section>
                  <h3 className="profile-subhead">
                    <Users size={14} aria-hidden /> Direct reports ({reports.length})
                  </h3>
                  {reports.slice(0, 6).map((r) => (
                    <PersonLink key={r.id} id={r.id} name={r.name} title={r.title} photo={r.photo} />
                  ))}
                  {reports.length > 6 && (
                    <Link className="muted" to="/directory">
                      +{reports.length - 6} more in Directory
                    </Link>
                  )}
                </section>
              )}
              {peers.length > 0 && (
                <section>
                  <h3 className="profile-subhead">Works with</h3>
                  {peers.map((p) => (
                    <PersonLink key={p.id} id={p.id} name={p.fullName} title={p.designation} photo={p.photo} />
                  ))}
                </section>
              )}
              <Link to="/org-chart" className="btn-ghost btn-tiny" style={{ justifySelf: "start" }}>
                View in org chart
              </Link>
            </div>
          </Card>

          {/* Certifications are part of the personal record: self, reporting line and HR only. */}
          {canSeePersonal && (
          <Card title="Certifications">
            {certs.length === 0 ? (
              <p className="muted">None listed.</p>
            ) : (
              <ul className="profile-certs">
                {certs.map((c) => ({ key: c.id, name: c.name, issuer: c.issuer, when: c.earnedOn })).map((c) => (
                  <li key={c.key}>
                    <Award size={16} aria-hidden />
                    <span>
                      <strong>{c.name}</strong>
                      <span className="muted">
                        {c.issuer} · {c.when}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          )}

        </div>
      </div>
      {/* Everything about the person, below the summary — no tab to find it. */}
      {canOpenRecord && person.record && (
        <section className="profile-full-record" aria-label={isMe ? "My full record" : "Full record"}>
          <h2 className="card-title">{isMe ? "My full record" : "Full record"}</h2>
          <Employee360View
            person={{ ...person.record, photo: person.photo }}
            viewer={demoProfile}
            selfId={employee.id}
            hideHeader
          />
        </section>
      )}

      {hrEditOpen && person.record && (
        <EmployeeFormDialog
          key={person.id}
          open
          title="Edit employee"
          initial={person.record}
          people={people}
          onClose={() => setHrEditOpen(false)}
          onSave={(next, effectiveDate) => {
            const scheduled = saveEmployee(next, effectiveDate, person.record!, demoProfile);
            setHrEditOpen(false);
            setBanner({ tone: "ok", text: scheduled ? `Change scheduled for ${effectiveDate}.` : "Employee record saved." });
          }}
        />
      )}

      <MeetDialog
        key={person.id}
        open={meetOpen && !hasLeft}
        onClose={() => setMeetOpen(false)}
        meName={employee.fullName}
        meId={employee.id}
        person={person}
        onBooked={(text) => {
          setMeetOpen(false);
          setBanner({ tone: "ok", text });
        }}
      />
    </Page>
  );
}

function LinkedInMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden className="linkedin-mark">
      <rect width="24" height="24" rx="4" fill="#0a66c2" />
      <path
        fill="#fff"
        d="M7.1 9.6h-2.4V18h2.4V9.6zM5.9 5.8a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8zM19.3 13.2c0-2.3-1.2-3.8-3.4-3.8-1.1 0-1.9.6-2.2 1.2V9.6h-2.3V18h2.4v-4.2c0-1.1.2-2.2 1.6-2.2 1.3 0 1.4 1.3 1.4 2.3V18h2.5v-4.8z"
      />
    </svg>
  );
}

/** LinkedIn in the Contact card: a link for everyone, and add/edit on your own profile. */
function LinkedInRow({ personId, url, editable }: { personId: string; url?: string; editable: boolean }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(url ?? "");
  const [error, setError] = useState("");

  if (!url && !editable) return null;

  if (editing) {
    return (
      <li className="profile-linkedin-edit">
        <LinkedInMark />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const problem = setLinkedIn(personId, value);
            setError(problem ?? "");
            if (!problem) setEditing(false);
          }}
        >
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="linkedin.com/in/your-name"
            aria-label="LinkedIn profile address"
            autoFocus
          />
          <button type="submit" className="btn btn-tiny">
            Save
          </button>
          <button type="button" className="btn-ghost btn-tiny" onClick={() => setEditing(false)}>
            Cancel
          </button>
          {error && <span className="note err">{error}</span>}
        </form>
      </li>
    );
  }

  return (
    <li>
      <LinkedInMark />
      {url ? (
        <a href={url} target="_blank" rel="noopener noreferrer">
          {url.replace(/^https:\/\/www\./, "")}
        </a>
      ) : (
        <span className="muted">No LinkedIn added</span>
      )}
      {editable && (
        <button
          type="button"
          className="icon-btn"
          onClick={() => {
            setValue(url ?? "");
            setError("");
            setEditing(true);
          }}
        >
          {url ? "Edit" : "Add LinkedIn"}
        </button>
      )}
    </li>
  );
}

function PersonLink({ id, name, title, photo }: { id?: string; name: string; title?: string; photo?: string }) {
  const body = (
    <>
      <Avatar name={name} photo={photo} size={32} />
      <span>
        <strong>{name}</strong>
        {title && <span className="muted">{title}</span>}
      </span>
    </>
  );
  return id ? (
    <Link to={`/people/${id}`} className="profile-person-link">
      {body}
    </Link>
  ) : (
    <div className="profile-person-link">{body}</div>
  );
}

function MeetDialog({
  open,
  onClose,
  meName,
  meId,
  person,
  onBooked,
}: {
  open: boolean;
  onClose: () => void;
  meName: string;
  meId: string;
  person: ProfilePerson;
  onBooked: (message: string) => void;
}) {
  const [title, setTitle] = useState(`${meName.split(" ")[0]} / ${person.fullName.split(" ")[0]} catch-up`);
  const [date, setDate] = useState(todayISO());
  const [time, setTime] = useState(nextHalfHour());
  const [duration, setDuration] = useState("30");
  const [mode, setMode] = useState<"Video call" | "In person">("Video call");
  const [agenda, setAgenda] = useState("");
  const [error, setError] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!date || !time) return setError("Pick a date and time.");
    if (date < todayISO()) return setError("Pick today or a future date.");
    saveLocalMeeting({
      title,
      date,
      time,
      location: mode === "Video call" ? "Video call" : person.location || "Office",
      description: [`With ${person.fullName} · ${duration} min`, agenda.trim()].filter(Boolean).join("\n"),
      attendeeIds: [meId, person.id],
    });
    setError("");
    onBooked(`Meeting booked with ${person.fullName} on ${date} at ${time}. It's on both calendars.`);
  }

  return (
    <Dialog open={open} title={`Meet with ${person.fullName}`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Title" wide>
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <div className="form-grid-2">
          <Field label="Date">
            <input type="date" value={date} min={todayISO()} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Time (your time)">
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </Field>
          <Field label="Duration">
            <select value={duration} onChange={(e) => setDuration(e.target.value)}>
              {["15", "30", "45", "60"].map((d) => (
                <option key={d} value={d}>
                  {d} min
                </option>
              ))}
            </select>
          </Field>
          <Field label="Where">
            <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
              <option>Video call</option>
              <option>In person</option>
            </select>
          </Field>
        </div>
        <Field label="Agenda (optional)" wide>
          <textarea rows={3} value={agenda} onChange={(e) => setAgenda(e.target.value)} placeholder="What do you want to cover?" />
        </Field>
        {error && <p className="note err">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn">
            Book meeting
          </button>
        </div>
      </form>
    </Dialog>
  );
}
