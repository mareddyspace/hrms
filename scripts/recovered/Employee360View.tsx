import { Link } from "react-router-dom";
import { Card, EmptyState, MetricCard, MetricGrid, ProgressBarish, StatusBadge, Tabs } from "../components/ui.tsx";
import {
  getPerson360Extras,
  type PersonRecord,
} from "../data/peopleData.ts";
import { canViewCompensation, canViewSensitivePii } from "../data/peoplePermissions.ts";
import type { DemoAccount } from "../demoAccounts.ts";
import { maskEmail, maskMobile } from "../model.ts";
import { useState } from "react";

/** Inline progress to avoid depending on dashboard widgets. */
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

void ProgressBarish;

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-fact">
      <dt>{label}</dt>
      <dd>{value || "—"}</dd>
    </div>
  );
}

export function Employee360View({
  person,
  viewer,
  selfId,
  onEdit,
}: {
  person: PersonRecord;
  viewer: DemoAccount;
  selfId: string;
  onEdit?: () => void;
}) {
  const isSelf = person.id === selfId || person.employeeCode === viewer.employeeCode;
  const extras = getPerson360Extras(person);
  const showPii = canViewSensitivePii(viewer, isSelf);
  const compAccess = canViewCompensation(viewer, person.id, { selfId });
  const [tab, setTab] = useState("personal");

  const tabs = [
    { id: "personal", label: "Personal" },
    { id: "employment", label: "Employment" },
    { id: "org", label: "Organization" },
    { id: "skills", label: "Skills & career" },
    { id: "time", label: "Time & leave" },
    { id: "goals", label: "Goals & learning" },
    { id: "docs", label: "Documents & lifecycle" },
    ...(compAccess !== "hidden" ? [{ id: "comp", label: "Compensation & benefits" }] : []),
  ];

  return (
    <div className="stack">
      <Card>
        <div className="who row-between" style={{ alignItems: "flex-start", gap: 16 }}>
          <div className="who" style={{ margin: 0 }}>
            <img className="identity-photo who-photo" src={person.photo} alt="" />
            <div className="who-copy">
              <h2>{person.fullName}</h2>
              <p className="muted">
                {person.employeeCode} · {person.employmentType} · {person.employmentStatus}
              </p>
              <p className="role">{person.designation}</p>
              <p className="muted">
                {person.department} · {person.location}, {person.countryName}
              </p>
            </div>
          </div>
          <div className="row-gap">
            {onEdit && (
              <button type="button" className="btn" onClick={onEdit}>
                Edit employee
              </button>
            )}
            {!isSelf && (
              <Link className="btn-ghost" to={`/directory`}>
                Back to People
              </Link>
            )}
          </div>
        </div>
      </Card>

      <Tabs tabs={tabs} value={tab} onChange={setTab} />

      {tab === "personal" && (
        <Card title="Personal information">
          <dl className="info-grid">
            <Fact label="Full name" value={person.fullName} />
            <Fact label="Gender" value={person.gender} />
            <Fact label="Work email" value={showPii ? person.email : maskEmail(person.email)} />
            <Fact label="Personal email" value={showPii ? person.personalEmail : maskEmail(person.personalEmail)} />
            <Fact label="Mobile" value={showPii ? person.mobile : maskMobile(person.mobile)} />
            <Fact label="Address" value={showPii ? person.address : "••••"} />
            <Fact label="Time zone" value={person.timeZone} />
          </dl>
          {!showPii && <p className="note">Contact details are masked for this demo persona.</p>}
        </Card>
      )}

      {tab === "employment" && (
        <Card title="Employment information">
          <dl className="info-grid">
            <Fact label="Employee ID" value={person.employeeCode} />
            <Fact label="Status" value={person.employmentStatus} />
            <Fact label="Employment type" value={person.employmentType} />
            <Fact label="Date of joining" value={person.dateOfJoining} />
            <Fact label="Job title" value={person.designation} />
            <Fact label="Job family" value={person.jobFamily} />
            <Fact label="Job profile" value={person.jobProfileId} />
            <Fact label="Position" value={person.positionId} />
            <Fact label="Grade" value={person.grade} />
            <Fact label="Availability" value={person.availability} />
          </dl>
        </Card>
      )}

      {tab === "org" && (
        <Card title="Organization & reporting">
          <dl className="info-grid">
            <Fact label="Legal entity" value={person.legalEntity} />
            <Fact label="Business unit" value={person.businessUnit} />
            <Fact label="Division" value={person.division} />
            <Fact label="Department" value={person.department} />
            <Fact label="Cost center" value={person.costCenter} />
            <Fact label="Location" value={person.location} />
            <Fact label="Country" value={person.countryName} />
            <Fact label="Manager" value={person.managerName} />
          </dl>
          {person.managerId && (
            <p className="note">
              Manager record:{" "}
              <Link to={`/directory/${person.managerId}`}>{person.managerName}</Link>
            </p>
          )}
        </Card>
      )}

      {tab === "skills" && (
        <div className="mgr-home-grid">
          <Card title="Skills">
            <ul className="todo">
              {extras.skills.map((s) => (
                <li key={s.name}>
                  {s.name} · <StatusBadge status={s.level} tone="info" />
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Certifications">
            <ul className="todo">
              {extras.certifications.map((c) => (
                <li key={c.name}>
                  {c.name} · {c.issuer} · {c.year}
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Education">
            <ul className="todo">
              {extras.education.map((e) => (
                <li key={e.school}>
                  {e.degree} · {e.school} · {e.year}
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Experience">
            <ul className="todo">
              {extras.experience.map((e) => (
                <li key={`${e.company}-${e.from}`}>
                  {e.title} @ {e.company} · {e.from}–{e.to}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      {tab === "time" && (
        <div className="stack">
          <MetricGrid>
            <MetricCard label="Present (30d)" value={extras.attendanceSummary.present} />
            <MetricCard label="WFH" value={extras.attendanceSummary.wfh} />
            <MetricCard label="Leave" value={extras.attendanceSummary.leave} />
            <MetricCard label="Absent" value={extras.attendanceSummary.absent} />
          </MetricGrid>
          <div className="mgr-home-grid">
            <Card title="Leave balances" to="/leave">
              <ul className="todo">
                {extras.leaveBalances.map((b) => (
                  <li key={b.type}>
                    {b.type}: <strong>{b.balance}</strong>
                  </li>
                ))}
              </ul>
            </Card>
            <Card title="Timesheet" to="/timesheet">
              <p>
                {extras.timesheet.period} · <StatusBadge status={extras.timesheet.status} /> · {extras.timesheet.hours}h
              </p>
            </Card>
          </div>
        </div>
      )}

      {tab === "goals" && (
        <div className="mgr-home-grid">
          <Card title="Goals" to="/evaluations">
            {extras.goals.map((g) => (
              <Progress key={g.name} value={g.progress} label={g.name} />
            ))}
          </Card>
          <Card title="Learning history" to="/programs">
            <ul className="todo">
              {extras.learning.map((l) => (
                <li key={l.name}>
                  {l.name} · <StatusBadge status={l.status} /> {l.completed ? `· ${l.completed}` : ""}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      {tab === "docs" && (
        <div className="mgr-home-grid">
          <Card title="Documents" to="/documents">
            <ul className="todo">
              {extras.documents.map((d) => (
                <li key={d.name}>
                  {d.name} · {d.category} · {d.updated}
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Employment lifecycle">
            <ul className="todo">
              {extras.lifecycle.map((e) => (
                <li key={`${e.date}-${e.event}`}>
                  <strong>{e.date}</strong> · {e.event} — {e.detail}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      {tab === "comp" && compAccess !== "hidden" && (
        <div className="mgr-home-grid">
          <Card title="Compensation">
            {compAccess === "full" ? (
              <dl className="info-grid">
                <Fact label="Currency" value={extras.compensation.currency} />
                <Fact label="Base" value={extras.compensation.base} />
                <Fact label="Variable" value={extras.compensation.variable} />
                <Fact label="Grade" value={extras.compensation.grade} />
                <Fact label="Effective" value={extras.compensation.effective} />
              </dl>
            ) : (
              <dl className="info-grid">
                <Fact label="Currency" value={extras.compensation.currency} />
                <Fact label="Base" value="••••••" />
                <Fact label="Variable" value="••••" />
                <Fact label="Grade" value={extras.compensation.grade} />
                <Fact label="Effective" value={extras.compensation.effective} />
              </dl>
            )}
            {compAccess === "masked" && (
              <p className="note">Amounts are masked for this demo permission set.</p>
            )}
          </Card>
          <Card title="Benefits">
            {extras.benefits.length ? (
              <ul className="todo">
                {extras.benefits.map((b) => (
                  <li key={b.plan}>
                    {b.plan} · {compAccess === "full" ? b.coverage : "Coverage hidden"} · {b.status}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No benefits" description="No benefit enrollments on file." />
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
