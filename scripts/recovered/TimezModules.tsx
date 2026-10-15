import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { PRODUCT_NAME, PRODUCT_TAGLINE } from "../brand.ts";
import { Banner, Card, Field, Page, StatusPill } from "../components/ui.tsx";
import { TIMEZ_COUNTRIES } from "../model.ts";
import { usePortal } from "../store.tsx";
import { countryRollup } from "../workforce.ts";

export function OrganizationPage() {
  const countries = countryRollup();
  const total = countries.reduce((sum, row) => sum + row.headcount, 0);
  return (
    <Page title="Organization" subtitle={`${PRODUCT_NAME} global structure · ${total} employees across ${countries.length} countries`}>
      <div className="grid-2">
        <Card title="Legal entities">
          <ul className="stack">
            <li>TimeZ India Pvt Ltd · INR · Asia/Kolkata</li>
            <li>TimeZ Inc · USD · America/New_York</li>
            <li>TimeZ UK Ltd · GBP · Europe/London</li>
            <li>TimeZ Australia Pty · AUD · Australia/Sydney</li>
            <li>TimeZ Canada Inc · CAD · America/Toronto</li>
            <li>TimeZ Middle East FZ · AED · Asia/Dubai</li>
            <li>TimeZ Saudi LLC · SAR · Asia/Riyadh</li>
            <li>TimeZ Germany GmbH · EUR · Europe/Berlin</li>
          </ul>
        </Card>
        <Card title="Headcount by country">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Country</th>
                  <th>Currency</th>
                  <th>Time zone</th>
                  <th>Headcount</th>
                </tr>
              </thead>
              <tbody>
                {countries.map((row) => (
                  <tr key={row.code}>
                    <td>
                      {row.name} ({row.code})
                    </td>
                    <td>{row.currency}</td>
                    <td>{row.timeZone}</td>
                    <td>{row.headcount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </Page>
  );
}

export function JobsPage() {
  const jobs = [
    { id: "JOB-221", title: "Senior React Engineer", loc: "Bengaluru / Hybrid", openings: 3, status: "Open" },
    { id: "JOB-218", title: "HR Business Partner", loc: "London", openings: 1, status: "Open" },
    { id: "JOB-210", title: "Talent Sourcer", loc: "New York", openings: 2, status: "Interviewing" },
    { id: "JOB-205", title: "Finance Analyst", loc: "Toronto", openings: 1, status: "On hold" },
  ];
  return (
    <Page title="Jobs & positions" subtitle="Global job architecture and open requisitions">
      <Card title="Open requisitions">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Title</th>
                <th>Location</th>
                <th>Openings</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td>{job.id}</td>
                  <td>{job.title}</td>
                  <td>{job.loc}</td>
                  <td>{job.openings}</td>
                  <td>
                    <StatusPill status={job.status === "Open" ? "approved" : job.status === "Interviewing" ? "pending" : "withdrawn"} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </Page>
  );
}

export function RecruitingPage() {
  const pipeline = [
    { name: "Aisha Khan", role: "Senior React Engineer", stage: "Technical", country: "India" },
    { name: "Tom Hughes", role: "HR Business Partner", stage: "Offer", country: "UK" },
    { name: "Mei Lin", role: "Talent Sourcer", stage: "Screen", country: "USA" },
    { name: "Jonas Weber", role: "Finance Analyst", stage: "HM interview", country: "Germany" },
  ];
  return (
    <Page title="Recruiting" subtitle="ATS pipeline for TimeZ — requisitions, candidates, interviews">
      <div className="grid-2">
        <Card title="Pipeline">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Candidate</th>
                  <th>Role</th>
                  <th>Stage</th>
                  <th>Country</th>
                </tr>
              </thead>
              <tbody>
                {pipeline.map((row) => (
                  <tr key={row.name}>
                    <td>{row.name}</td>
                    <td>{row.role}</td>
                    <td>{row.stage}</td>
                    <td>{row.country}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title="Recruiter actions">
          <p className="note">Create requisitions, screen resumes, schedule interviews, and hand off to onboarding.</p>
          <p className="note">
            Open <Link to="/ai/copilot">AI Copilot</Link> for JD drafts and resume intelligence.
          </p>
        </Card>
      </div>
    </Page>
  );
}

export function OnboardingPage() {
  const checklist = [
    { step: "Offer accepted", owner: "Recruiter", status: "done" },
    { step: "Identity & tax docs", owner: "HR", status: "progress" },
    { step: "Laptop & access", owner: "IT", status: "pending" },
    { step: "Buddy assigned", owner: "Manager", status: "pending" },
    { step: "Policy acknowledgements", owner: "Employee", status: "pending" },
  ];
  return (
    <Page title="Onboarding" subtitle="Day-0 to day-30 checklist for new TimeZ joiners">
      <Card title="Active onboarding cases">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Step</th>
                <th>Owner</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {checklist.map((row) => (
                <tr key={row.step}>
                  <td>{row.step}</td>
                  <td>{row.owner}</td>
                  <td>
                    <StatusPill
                      status={row.status === "done" ? "approved" : row.status === "progress" ? "pending" : "withdrawn"}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </Page>
  );
}

export function SkillsCareerPage() {
  const skills = [
    { name: "React / TypeScript", level: "Advanced", gap: "Mentor others" },
    { name: "People leadership", level: "Developing", gap: "Manager path" },
    { name: "Cloud architecture", level: "Intermediate", gap: "Certification" },
  ];
  return (
    <Page title="Skills & career" subtitle="Skills inventory, gaps, and career navigator">
      <div className="grid-2">
        <Card title="My skills">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Skill</th>
                  <th>Level</th>
                  <th>Next step</th>
                </tr>
              </thead>
              <tbody>
                {skills.map((row) => (
                  <tr key={row.name}>
                    <td>{row.name}</td>
                    <td>{row.level}</td>
                    <td>{row.gap}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title="Career paths">
          <p>Suggested next roles: Senior Engineer → Tech Lead → Engineering Manager.</p>
          <p className="note">
            Ask <Link to="/ai/copilot">AI Career Assistant</Link> for a personalized plan.
          </p>
        </Card>
      </div>
    </Page>
  );
}

export function CompensationPage() {
  return (
    <Page title="Compensation" subtitle="Grades, ranges, and review cycles (payroll calculation remains out of scope)">
      <div className="grid-2">
        <Card title="Grade bands (sample)">
          <ul className="stack">
            <li>G5 Engineer · India · INR 12–18 LPA</li>
            <li>G6 Senior · India · INR 18–28 LPA</li>
            <li>G6 Senior · USA · USD 140–180k</li>
            <li>G7 Lead · UK · GBP 85–110k</li>
          </ul>
        </Card>
        <Card title="Cycle">
          <p>Annual compensation review · Oct–Nov</p>
          <p className="note">Promotions and bonuses are recorded here; payslips remain in Pay.</p>
        </Card>
      </div>
    </Page>
  );
}

export function BenefitsPage() {
  return (
    <Page title="Benefits" subtitle="Country-localized benefit catalogs and enrollment">
      <Card title="My enrollments">
        <ul className="stack">
          <li>Medical insurance — enrolled (India)</li>
          <li>Provident Fund — enrolled</li>
          <li>Wellness stipend — available</li>
          <li>Learning allowance — available</li>
        </ul>
      </Card>
    </Page>
  );
}

export function PayrollPage() {
  return (
    <Page title="Payroll" subtitle="Integration-ready placeholder — payroll processing is outside current scope">
      <Card title="Payroll tab">
        <Banner message={{ tone: "ok", text: "This module is a placeholder for external payroll systems (API / file / webhook)." }} />
        <p>Use payslips, compensation, and benefits for employee-facing pay information.</p>
        <p className="note">
          See <Link to="/integrations">Integration center</Link> for payroll connectors.
        </p>
      </Card>
    </Page>
  );
}

export function AnalyticsPage() {
  const { state } = usePortal();
  const headcount = state.colleagues.length;
  const countries = useMemo(() => {
    const map = new Map<string, number>();
    for (const person of state.colleagues) {
      map.set(person.workingCountry, (map.get(person.workingCountry) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [state.colleagues]);
  const leavePending = state.leaveRequests.filter((item) => item.status === "pending").length;

  return (
    <Page title="Analytics" subtitle="Workforce intelligence for managers, HR, and executives">
      <div className="grid-2">
        <Card title="Workforce">
          <p>
            <strong>{headcount}</strong> employees in directory
          </p>
          <p>
            <strong>{TIMEZ_COUNTRIES.length}</strong> countries configured
          </p>
          <p>
            <strong>{leavePending}</strong> leave requests pending
          </p>
        </Card>
        <Card title="Headcount by country">
          <ul className="stack">
            {countries.slice(0, 8).map(([name, count]) => (
              <li key={name}>
                {name}: {count}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </Page>
  );
}

export function AiCopilotPage() {
  const { employee } = usePortal();
  const [prompt, setPrompt] = useState("");
  const [reply, setReply] = useState<string | null>(null);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const q = prompt.trim().toLowerCase();
    let text =
      "I can help with leave balances, policies, career paths, and recruiting drafts. Connect the AI gateway for live model responses.";
    if (q.includes("leave")) text = "Open Leave & absence to apply. Balances update after manager/HR approval. Holidays are skipped in working-day counts.";
    else if (q.includes("career") || q.includes("skill")) text = "Your suggested path is Senior Engineer → Tech Lead. Open Skills & career for gaps, or Learning for programs.";
    else if (q.includes("policy")) text = "Key policies live under Documents → Policies (leave, attendance, security). I can summarize once RAG is connected.";
    else if (q.includes("recruit") || q.includes("jd")) text = "Draft JD outline: role summary, must-have skills, nice-to-haves, locations, and interview loop. Open Recruiting to attach it to a req.";
    setReply(`Hi ${employee.fullName.split(" ")[0]} — ${text}`);
  }

  return (
    <Page title="AI Copilot" subtitle={`${PRODUCT_TAGLINE} · contextual assistant for employees, managers, and HR`}>
      <Card title="Ask TimeZ Copilot">
        <form onSubmit={onSubmit} className="stack">
          <Field label="Prompt" wide>
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={3} placeholder="e.g. How do I apply leave? Draft a JD for Senior React Engineer." />
          </Field>
          <button className="btn" type="submit">
            Ask
          </button>
        </form>
        {reply && <Banner message={{ tone: "ok", text: reply }} />}
        <p className="note">Rule-based demo replies today. Phase 5 wires AI Gateway + RAG + tool calling.</p>
      </Card>
    </Page>
  );
}

export function AiAgentsPage() {
  const agents = [
    { name: "Leave triage agent", status: "Ready", desc: "Routes leave exceptions and quota warnings" },
    { name: "Onboarding agent", status: "Ready", desc: "Chases checklist owners and escalates SLA" },
    { name: "Recruiting agent", status: "Beta", desc: "Screens resumes and drafts interview kits" },
    { name: "Policy RAG agent", status: "Planned", desc: "Answers from the TimeZ policy knowledge base" },
  ];
  return (
    <Page title="AI Agents" subtitle="Autonomous assistants with audit trails">
      <Card title="Agent catalog">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Status</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => (
                <tr key={agent.name}>
                  <td>{agent.name}</td>
                  <td>{agent.status}</td>
                  <td>{agent.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </Page>
  );
}

export function AdminPage() {
  return (
    <Page title="Administration" subtitle="Users, roles, countries, and platform configuration">
      <div className="grid-2">
        <Card title="Roles">
          <ul className="stack">
            <li>Employee · Manager · HR · Recruiter · Admin · Executive</li>
            <li>RBAC + data-scope controls (Phase 1 foundation)</li>
          </ul>
        </Card>
        <Card title="Demo logins">
          <p className="note">Password for all: welcome</p>
          <ul className="stack">
            <li>EMP1184 Employee · MGR1001 Manager</li>
            <li>HR2001 HR · REC3001 Recruiter</li>
            <li>ADM4001 Admin · EXE5001 Executive</li>
          </ul>
        </Card>
      </div>
    </Page>
  );
}

export function IntegrationsPage() {
  return (
    <Page title="Integration center" subtitle="APIs, webhooks, files, and events">
      <Card title="Connectors">
        <ul className="stack">
          <li>REST APIs — TimeZ FastAPI (`/api/*`)</li>
          <li>Webhooks — outbound lifecycle events (planned)</li>
          <li>File drop — payroll / benefits feeds (planned)</li>
          <li>SSO / identity — Phase 1 foundation</li>
        </ul>
      </Card>
    </Page>
  );
}

export function RoadmapPage() {
  const phases = [
    { name: "Phase 0 – Discovery", status: "Done" },
    { name: "Phase 1 – Platform foundation", status: "In progress" },
    { name: "Phase 2 – Core workforce", status: "In progress" },
    { name: "Phase 3 – Talent", status: "Scaffolded" },
    { name: "Phase 4 – Compensation & benefits", status: "Scaffolded" },
    { name: "Phase 5 – AI platform", status: "Scaffolded" },
    { name: "Phase 6 – Global enterprise", status: "Planned" },
  ];
  return (
    <Page title="Product roadmap" subtitle={`${PRODUCT_NAME} delivery phases from the HCM blueprint`}>
      <Card title="Roadmap">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Phase</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {phases.map((phase) => (
                <tr key={phase.name}>
                  <td>{phase.name}</td>
                  <td>{phase.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </Page>
  );
}
