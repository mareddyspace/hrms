import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card, DataTable, StatusBadge } from "../../components/ui.tsx";
import { formatShortDate } from "../../model.ts";
import type { PersonRecord } from "../../data/peopleData.ts";
import type { OfferRecord, Requisition } from "../../data/talentData.ts";
import {
  ARRANGEMENTS,
  HEADCOUNT_DIMS,
  TODAY_PLACES,
  type PlaceMember,
  headcountBreakdown,
  monthlyHires,
  offerStats,
  recentJoiners,
  shortDay,
  timeToHire,
  type CoverageRisk,
  type HeadcountDim,
  type lateArrivals,
  type teamAbsence,
} from "../../data/hrAnalytics.ts";
import { MiniBars, ShareBars } from "./widgets.tsx";

const select = (value: string, onChange: (v: string) => void, options: { id: string; label: string }[], label: string) => (
  <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
    {options.map((o) => (
      <option key={o.id} value={o.id}>
        {o.label}
      </option>
    ))}
  </select>
);

const personLink = (p: PersonRecord) => (
  <Link key={p.id} to={`/people/${p.id}`}>
    {p.fullName}
  </Link>
);

export function HeadcountAnalysisCard({ scopePeople, allPeople, today }: { scopePeople: PersonRecord[]; allPeople: PersonRecord[]; today: string }) {
  const [dim, setDim] = useState<HeadcountDim>("location");
  const data = useMemo(() => headcountBreakdown(scopePeople, allPeople, dim, today), [scopePeople, allPeople, dim, today]);
  return (
    <Card title={`Headcount analysis · ${data.total}`} action={select(dim, (v) => setDim(v as HeadcountDim), HEADCOUNT_DIMS, "Breakdown")}>
      {data.rows.length ? <ShareBars items={data.rows} /> : <p className="note">No people in this scope.</p>}
      {data.note && <p className="note">{data.note}</p>}
    </Card>
  );
}

export function NewHiringCard({ people, today }: { people: PersonRecord[]; today: string }) {
  const [days, setDays] = useState("30");
  const joiners = useMemo(() => recentJoiners(people, today, Number(days)), [people, today, days]);
  const trend = useMemo(() => monthlyHires(people, today, 12), [people, today]);
  return (
    <Card
      title={`New hiring · ${joiners.length}`}
      action={select(days, setDays, [{ id: "30", label: "Last 30 days" }, { id: "90", label: "Last 90 days" }], "Joined within")}
    >
      <DataTable
        headers={["Name", "Title", "Location", "Joined"]}
        rows={joiners.slice(0, 6).map((p) => [personLink(p), p.designation, p.location, formatShortDate(p.dateOfJoining)])}
        empty={<p className="note">No joiners in this period.</p>}
      />
      {joiners.length > 6 && <p className="muted">+{joiners.length - 6} more</p>}
      <p className="muted" style={{ marginTop: 8 }}>
        Hires per month
      </p>
      <MiniBars items={trend} />
    </Card>
  );
}

export function TimeToHireCard({ offers, requisitions, countryName }: { offers: OfferRecord[]; requisitions: Requisition[]; countryName?: string }) {
  const t = useMemo(() => timeToHire(offers, requisitions, countryName), [offers, requisitions, countryName]);
  return (
    <Card title="Time to hire" to="/recruiting">
      {t.avg === null ? (
        <p className="note">No accepted offers yet.</p>
      ) : (
        <>
          <p>
            <strong>{t.avg} days</strong> avg · {t.median} median · {t.rows.length} hire{t.rows.length === 1 ? "" : "s"}
          </p>
          <p className="muted">Requisition approved → offer accepted</p>
          {t.byDepartment.length > 1 && <MiniBars items={t.byDepartment} valueSuffix="d" />}
          <DataTable
            headers={["Candidate", "Role", "Approved", "Accepted", "Days"]}
            rows={t.rows.slice(0, 5).map((r) => [r.candidate, r.role, formatShortDate(r.approvedOn), formatShortDate(r.acceptedOn), String(r.days)])}
          />
        </>
      )}
    </Card>
  );
}

export function OfferAcceptanceCard({ offers, requisitions, countryName }: { offers: OfferRecord[]; requisitions: Requisition[]; countryName?: string }) {
  const s = useMemo(() => offerStats(offers, requisitions, countryName), [offers, requisitions, countryName]);
  return (
    <Card title={`Offer acceptance${s.ratePct === null ? "" : ` · ${s.ratePct}%`}`} to="/recruiting">
      <p className="muted">
        Sent {s.sent} · Accepted {s.accepted} · Declined {s.declined} · Pending {s.pending}
        {s.withdrawn ? ` · Withdrawn ${s.withdrawn}` : ""}
      </p>
      <DataTable
        headers={["Candidate", "Role", "Sent", "Outcome"]}
        rows={s.recent.slice(0, 5).map((o) => [
          o.candidateName,
          o.role,
          formatShortDate(o.sentOn ?? ""),
          o.status === "Accepted" || o.status === "Declined"
            ? `${o.status} ${o.respondedOn ? formatShortDate(o.respondedOn) : ""}`.trim()
            : o.status === "Sent"
              ? "Pending"
              : o.status,
        ])}
        empty={<p className="note">No offers sent.</p>}
      />
    </Card>
  );
}

export function LateArrivalsCard({ data }: { data: ReturnType<typeof lateArrivals> }) {
  return (
    <Card title={`Late arrivals today · ${data.today.length}`} to="/attendance">
      {data.today.length > 0 && (
        <DataTable
          headers={["Name", "Location", "In", "Late"]}
          rows={data.today.slice(0, 5).map((r) => [personLink(r.person), r.person.location, r.checkIn, `${r.minutes} min`])}
        />
      )}
      <p className="muted" style={{ marginTop: 8 }}>
        Last 4 weeks · {data.totalLate} late ({data.latePct}% of check-ins)
      </p>
      {data.totalLate > 0 ? (
        <MiniBars items={data.trend.map((t) => ({ label: t.label, value: t.value }))} />
      ) : (
        <p className="note">No late check-ins recorded.</p>
      )}
      {data.byLocation.length > 0 && (
        <>
          <p className="muted" style={{ marginTop: 8 }}>
            Top locations
          </p>
          <MiniBars items={data.byLocation} />
        </>
      )}
      {data.byDepartment.length > 0 && (
        <>
          <p className="muted" style={{ marginTop: 8 }}>
            Top teams
          </p>
          <MiniBars items={data.byDepartment} />
        </>
      )}
      <p className="note">Based on recorded attendance · {data.sampleSize} people</p>
    </Card>
  );
}

export function TeamCoverCard({ data }: { data: ReturnType<typeof teamAbsence> }) {
  return (
    <Card title={`Team absence & cover · ${data.absentToday} out today`} to="/leave">
      <p className="muted">
        {data.absentWeek} out to {shortDay(data.weekEnd)} · {data.belowToday} of {data.teamCount} teams below 70% today
      </p>
      {data.teams.length === 0 ? (
        <p className="note">No approved leave this week.</p>
      ) : (
        <ul className="todo">
          {data.teams.slice(0, 6).map((t) => (
            <li key={t.managerId}>
              <div className="row-between" style={{ gap: 8 }}>
                <strong>{t.name}</strong>
                {t.pctToday !== null ? (
                  <StatusBadge status={`${t.pctToday}% present`} tone={t.pctToday < 70 ? "danger" : "ok"} literal />
                ) : (
                  <span className="muted">Off today</span>
                )}
              </div>
              <p className="muted" style={{ margin: 0 }}>
                {t.size} people
                {t.expectedToday ? ` · ${t.presentToday} of ${t.expectedToday} in today` : ""}
                {t.weekLowPct !== null && t.weekLowDay && t.weekLowPct < (t.pctToday ?? 101) ? ` · low ${t.weekLowPct}% ${shortDay(t.weekLowDay)}` : ""}
              </p>
              {t.absences.map((a) => (
                <p key={a.person.id} style={{ margin: "2px 0" }}>
                  {a.person.fullName} · {a.outToday ? "out today" : `out ${a.days.map(shortDay).join(", ")}`}
                  {a.days.length > 1 && a.outToday ? ` + ${a.days.length - 1}d` : ""} —{" "}
                  {a.cover ? (
                    <span>
                      Cover: {a.cover.fullName} ({a.coverIsManager ? "manager" : a.cover.designation})
                    </span>
                  ) : (
                    <span className="warn">No cover</span>
                  )}
                </p>
              ))}
            </li>
          ))}
        </ul>
      )}
      {data.teams.length > 6 && <p className="muted">+{data.teams.length - 6} more teams</p>}
    </Card>
  );
}

const RISK_TONE: Record<CoverageRisk["severity"], "danger" | "warn" | "info"> = { High: "danger", Medium: "warn", Low: "info" };

export function CoverageRisksCard({ risks }: { risks: CoverageRisk[] }) {
  return (
    <Card title={`Coverage risks · ${risks.length}`}>
      <DataTable
        headers={["Severity", "Risk"]}
        rows={risks.slice(0, 8).map((r) => [<StatusBadge key={r.id} status={r.severity} tone={RISK_TONE[r.severity]} literal />, r.text])}
        empty={<p className="note">No coverage risks this week.</p>}
      />
      {risks.length > 8 && <p className="muted">+{risks.length - 8} more</p>}
    </Card>
  );
}

function NameGroups({ groups }: { groups: { label: string; names: { id: string; name: string }[] }[] }) {
  return (
    <ul className="todo">
      {groups
        .filter((g) => g.names.length > 0)
        .map((g) => (
          <li key={g.label}>
            <details>
              <summary>
                {g.label} · <strong>{g.names.length}</strong>
              </summary>
              <p className="muted" style={{ margin: "4px 0 0" }}>
                {g.names.map((n, i) => (
                  <span key={n.id}>
                    {i > 0 && ", "}
                    <Link to={`/people/${n.id}`}>{n.name}</Link>
                  </span>
                ))}
              </p>
            </details>
          </li>
        ))}
    </ul>
  );
}

export function WhereTeamWorksCard({ members }: { members: PlaceMember[] }) {
  if (!members.length) {
    return (
      <Card title="Where the team works">
        <p className="note">Nobody reports to you.</p>
      </Card>
    );
  }
  return (
    <Card title="Where the team works" to="/team">
      <p className="muted">Today</p>
      <NameGroups groups={TODAY_PLACES.map((label) => ({ label, names: members.filter((m) => m.today === label) }))} />
      <p className="muted" style={{ marginTop: 8 }}>
        Work arrangement
      </p>
      <NameGroups groups={ARRANGEMENTS.map((label) => ({ label, names: members.filter((m) => m.arrangement === label) }))} />
    </Card>
  );
}
