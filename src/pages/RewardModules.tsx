import { useMemo, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import {
  Banner,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  FilterBar,
  MetricCard,
  MetricGrid,
  Page,
  StatusBadge,
  Tabs,
  downloadText,
} from "../components/ui.tsx";
import {
  canManageLetters,
  canViewSalaryAmount,
  displayMoney,
  formatCompAmount,
  getCompensationAccess,
  hasModuleAccess,
} from "../data/peoplePermissions.ts";
import { DEMO_ACCOUNTS } from "../demoAccounts.ts";
import {
  BENEFIT_HISTORY,
  BENEFIT_PLANS,
  COMP_CYCLES,
  DEPENDENTS,
  GRADE_BANDS,
  LEGAL_DISCLAIMER,
} from "../data/rewardData.ts";
import {
  UPLOAD_EXTENSIONS,
  addLibraryDoc,
  canAdminBenefits,
  canDecideCompReview,
  decideChangeRequest,
  decideCompReview,
  decideEnrollment,
  getRewardState,
  isAboveInLine,
  isMandatoryPlan,
  pendingChangeFor,
  requestEnrollment,
  requestEnrollmentChange,
  submitCompReview,
  subscribeReward,
  validateUpload,
} from "../data/rewardLocal.ts";
import type { DocumentGroup } from "../model.ts";
import { usePortal } from "../store.tsx";
import { LetterHistoryPanel, LetterRequestsPanel, LetterViewerDialog, MyLettersPanel, type OpenLetter } from "./LettersPanel.tsx";

function useReward() {
  return useSyncExternalStore(subscribeReward, getRewardState, getRewardState);
}

function ScopeNote({ text }: { text: string }) {
  return <p className="note">{text}</p>;
}

/* ───────────────────────────── COMPENSATION ── */

const STRUCTURE_ROLES = ["compensation_admin", "finance", "hr", "hr_admin", "hrbp", "manager", "hiring_manager", "executive", "founder", "cofounder"];

const COMP_STATUS_TONE: Record<string, "ok" | "warn" | "danger" | "info" | "neutral"> = {
  Draft: "neutral",
  "Pending approval": "warn",
  "Pending final approval": "info",
  Approved: "ok",
  Rejected: "danger",
};

export function CompensationPage() {
  const { demoProfile } = usePortal();
  const reward = useReward();
  const me = demoProfile;
  const access = getCompensationAccess(me);
  const compTeam = access.peopleScope === "global";
  const leadsPeople = demoAccountsBelow(me.id);
  const showStructures = STRUCTURE_ROLES.includes(me.role);
  const showCycles = compTeam || leadsPeople;
  const tabs = [
    ...(showStructures ? [{ id: "structures", label: "Structures & ranges" }] : []),
    { id: "history", label: compTeam ? "Compensation history" : "My pay history" },
    ...(showCycles ? [{ id: "cycles", label: "Review cycles" }] : []),
    { id: "bonuses", label: compTeam ? "Bonus & incentives" : "My bonuses" },
  ];
  const [tab, setTab] = useState(tabs[0].id);
  const [cycleId, setCycleId] = useState(COMP_CYCLES[0]?.id ?? "");
  const [country, setCountry] = useState("");
  const [reviewMsg, setReviewMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const moduleOk = hasModuleAccess(me, "compensation") || access.module;
  const bands = GRADE_BANDS.filter((b) => !country || b.country === country);
  const cycle = COMP_CYCLES.find((c) => c.id === cycleId) ?? COMP_CYCLES[0];

  // Pay amounts: your own, or everyone's for Compensation / HR.
  const seesPay = (employeeId: string) => employeeId === me.id || canViewSalaryAmount(me, employeeId, { selfId: me.id }) !== "hidden";
  const visibleHistory = reward.history.filter((row) => seesPay(row.employeeId));
  const visibleBonuses = reward.bonuses.filter((row) => seesPay(row.employeeId));

  // Proposals: never your own; Compensation / HR see the cycle, others only people below them.
  const visibleReviews = useMemo(
    () =>
      reward.reviews.filter(
        (row) => row.cycleId === cycleId && row.employeeId !== me.id && (compTeam || isAboveInLine(me.id, row.employeeId)),
      ),
    [reward.reviews, cycleId, compTeam, me.id],
  );
  const amountAccess = (employeeId: string) =>
    isAboveInLine(me.id, employeeId) ? ("full" as const) : canViewSalaryAmount(me, employeeId, { selfId: me.id });
  const myDecisions = reward.reviews.filter((r) => canDecideCompReview(me, r)).length;

  if (!moduleOk) {
    return (
      <Page title="Compensation">
        <EmptyState title="No access" description="You don't have access to compensation." />
      </Page>
    );
  }

  return (
    <Page title="Compensation">
      <MetricGrid>
        {compTeam || leadsPeople ? (
          <>
            <MetricCard label="Open cycle" value={cycle?.status ?? "—"} hint={cycle?.name} />
            <MetricCard label="Proposals in view" value={visibleReviews.length} />
            <MetricCard label="Waiting for you" value={myDecisions} />
          </>
        ) : (
          <>
            <MetricCard label="Current grade" value={visibleHistory.find((h) => h.employeeId === me.id)?.grade ?? "—"} />
            <MetricCard label="Pay changes" value={visibleHistory.length} />
            <MetricCard label="Bonuses" value={visibleBonuses.length} />
          </>
        )}
      </MetricGrid>

      <Tabs tabs={tabs} value={tabs.some((t) => t.id === tab) ? tab : tabs[0].id} onChange={setTab} />

      {tab === "structures" && showStructures && (
        <Card title="Grades and salary ranges">
          <FilterBar>
            <label className="filter-label">
              Country
              <select value={country} onChange={(e) => setCountry(e.target.value)}>
                <option value="">All</option>
                {[...new Set(GRADE_BANDS.map((b) => b.country))].map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>
          </FilterBar>
          <DataTable
            headers={["Grade", "Family", "Country", "Currency", "Min", "Mid", "Max"]}
            rows={bands.map((b) =>
              access.ranges === "full"
                ? [b.grade, b.family, b.country, b.currency, b.min, b.mid, b.max]
                : [b.grade, b.family, b.country, b.currency, "••••", "••••", "••••"],
            )}
          />
        </Card>
      )}

      {tab === "history" && (
        <Card title={compTeam ? "Compensation history" : "My pay history"}>
          <DataTable
            headers={[...(compTeam ? ["Employee"] : []), "Effective", "Event", "Grade", "Base"]}
            rows={visibleHistory.map((row) => [...(compTeam ? [row.employeeName] : []), row.effective, row.event, row.grade, row.base])}
            empty={<EmptyState title="No pay changes" description="Nothing recorded yet." />}
          />
        </Card>
      )}

      {tab === "cycles" && showCycles && (
        <div className="stack">
          <FilterBar>
            <label className="filter-label">
              Cycle
              <select value={cycleId} onChange={(e) => setCycleId(e.target.value)}>
                {COMP_CYCLES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.status}
                  </option>
                ))}
              </select>
            </label>
          </FilterBar>
          {cycle && (
            <Card title={cycle.name}>
              <dl className="info-grid">
                <div className="info-fact"><dt>Status</dt><dd><StatusBadge status={cycle.status} literal /></dd></div>
                <div className="info-fact"><dt>Window</dt><dd>{cycle.window}</dd></div>
                <div className="info-fact"><dt>Countries</dt><dd>{cycle.countries.join(", ")}</dd></div>
              </dl>
            </Card>
          )}
          <Card title="Increase proposals">
            <p className="note">Approval: someone above the employee (not the proposer), then Compensation.</p>
            {cycle?.status === "Closed" && <Banner message={{ tone: "info", text: "This cycle is closed." }} />}
            <Banner message={reviewMsg} />
            <DataTable
              headers={["Employee", "Proposed by", "Grade", "Current", "Proposed", "Incr %", "Bonus", "Status", "Line approval", "Final", "Action"]}
              rows={visibleReviews.map((r) => {
                const vis = amountAccess(r.employeeId);
                const report = (error: string | null, ok: string) =>
                  setReviewMsg(error ? { tone: "err", text: error } : { tone: "ok", text: ok });
                let action: ReactNode = <span className="muted">—</span>;
                if (canDecideCompReview(me, r)) {
                  action = (
                    <span className="reward-actions">
                      <button type="button" className="btn" onClick={() => report(decideCompReview(me, r.id, "Approved"), `${r.employeeName}: approved.`)}>
                        Approve
                      </button>
                      <button type="button" className="btn-ghost" onClick={() => report(decideCompReview(me, r.id, "Rejected"), `${r.employeeName}: rejected.`)}>
                        Reject
                      </button>
                    </span>
                  );
                } else if (r.status === "Draft" && r.managerId === me.id && cycle?.status !== "Closed") {
                  action = (
                    <button type="button" className="btn" onClick={() => report(submitCompReview(me, r.id), `${r.employeeName}: submitted.`)}>
                      Submit
                    </button>
                  );
                }
                return [
                  r.employeeName,
                  r.managerName,
                  `${r.currentGrade} → ${formatCompAmount(vis, r.proposedGrade, "•••")}`,
                  displayMoney(r.currentBase, vis),
                  displayMoney(r.proposedBase, vis),
                  formatCompAmount(vis, `${r.proposedIncreasePct}%`, "•••"),
                  displayMoney(r.bonusProposal, vis),
                  <StatusBadge key={r.id} status={r.status} tone={COMP_STATUS_TONE[r.status]} literal />,
                  r.lineApprover ? `${r.lineApprover} · ${r.lineApprovedOn ?? ""}` : "—",
                  r.approver ? `${r.approver} · ${r.decidedOn ?? ""}` : "—",
                  <span key={`${r.id}-a`}>{action}</span>,
                ];
              })}
              empty={<EmptyState title="No proposals" description="Nothing in this cycle for you." />}
            />
          </Card>
        </div>
      )}

      {tab === "bonuses" && (
        <Card title={compTeam ? "Bonus and incentive records" : "My bonuses"}>
          <DataTable
            headers={[...(compTeam ? ["Employee"] : []), "Type", "Period", "Amount", "Status"]}
            rows={visibleBonuses.map((b) => [
              ...(compTeam ? [b.employeeName] : []),
              b.type,
              b.period,
              b.amount,
              <StatusBadge key={b.id} status={b.status} literal />,
            ])}
            empty={<EmptyState title="No bonuses" description="Nothing recorded yet." />}
          />
        </Card>
      )}
    </Page>
  );
}

/** True when anyone in the demo org reports (directly or not) to this person. */
function demoAccountsBelow(id: string): boolean {
  return DEMO_ACCOUNTS.some((a) => isAboveInLine(id, a.id));
}

/* ───────────────────────────── BENEFITS ── */

function ChangeRequestButton({ onSend }: { onSend: (note: string) => string | null }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  if (!open) {
    return (
      <button type="button" className="quiet-link" onClick={() => setOpen(true)}>
        Request change
      </button>
    );
  }
  return (
    <span className="row-gap">
      <input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="What should change?" />
      <button type="button" className="btn btn-tiny" disabled={note.trim().length < 5} onClick={() => !onSend(note) && setOpen(false)}>
        Send
      </button>
    </span>
  );
}

export function BenefitsPage() {
  const { demoProfile, employee, demoAccounts } = usePortal();
  const reward = useReward();
  const [tab, setTab] = useState("plans");
  const [planId, setPlanId] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const isBenefitsAdmin = canAdminBenefits(demoProfile);
  const canSeeOthers = isBenefitsAdmin;

  // Employees are locked to their own country; HR can browse any country.
  const ownCountry = employee.countryName ?? "";
  const [hrCountry, setHrCountry] = useState(ownCountry);
  const country = canSeeOthers ? hrCountry : ownCountry;

  const countryOf = (employeeId: string) =>
    demoAccounts.find((a) => a.id === employeeId)?.countryName ??
    reward.enrollments.find((e) => e.employeeId === employeeId)?.country ??
    "";
  const inScope = (employeeId: string) =>
    canSeeOthers ? !country || countryOf(employeeId) === country : employeeId === employee.id;

  const plans = BENEFIT_PLANS.filter((p) => (canSeeOthers ? !country || p.country === country : p.country === ownCountry));
  const selectedPlan = plans.find((p) => p.id === planId) ?? plans[0];

  const enrollments = reward.enrollments.filter((e) =>
    canSeeOthers ? !country || e.country === country : e.employeeId === employee.id,
  );
  const myPlanIds = new Set(reward.enrollments.filter((e) => e.employeeId === employee.id).map((e) => e.planId));
  const availablePlans = plans.filter((p) => p.country === ownCountry && !myPlanIds.has(p.id) && !p.mandatory);
  const changeRequests = reward.changeRequests.filter((c) => (canSeeOthers ? inScope(c.employeeId) : c.employeeId === employee.id));

  const dependents = DEPENDENTS.filter((d) => inScope(d.employeeId));
  const history = BENEFIT_HISTORY.filter((h) => inScope(h.employeeId));

  function run(error: string | null, okText: string) {
    setMsg(error ? { tone: "err", text: error } : { tone: "ok", text: okText });
    return error;
  }

  function enrollmentAction(e: (typeof enrollments)[number]): ReactNode {
    const mandatory = isMandatoryPlan(e.planId);
    if (e.employeeId === employee.id) {
      if (e.status === "Pending") return <span className="muted">Awaiting HR</span>;
      if (e.status === "Enrolled") {
        if (mandatory) return <span className="muted">Mandatory</span>;
        if (pendingChangeFor(reward, e.id)) return <span className="muted">Change requested</span>;
        return <ChangeRequestButton onSend={(note) => run(requestEnrollmentChange(demoProfile, e.id, note), "Change request sent to HR.")} />;
      }
      return (
        <button type="button" className="quiet-link" onClick={() => run(requestEnrollment(demoProfile, e.planId), "Enrollment request sent to HR.")}>
          Request enrollment
        </button>
      );
    }
    if (isBenefitsAdmin && e.status === "Pending") {
      return (
        <span className="reward-actions">
          <button type="button" className="btn" onClick={() => run(decideEnrollment(demoProfile, e.id, "Enrolled"), `${e.employeeName} enrolled in ${e.planName}.`)}>
            Enroll
          </button>
          {!mandatory && (
            <button type="button" className="btn-ghost" onClick={() => run(decideEnrollment(demoProfile, e.id, "Waived"), `${e.employeeName} waived ${e.planName}.`)}>
              Waive
            </button>
          )}
        </span>
      );
    }
    return "—";
  }

  if (!hasModuleAccess(demoProfile, "benefits")) {
    return (
      <Page title="Benefits">
        <EmptyState title="No access" description="You don't have access to benefits." />
      </Page>
    );
  }

  return (
    <Page title="Benefits">
      <FilterBar>
        <label className="filter-label">
          Country
          {canSeeOthers ? (
            <select value={hrCountry} onChange={(e) => setHrCountry(e.target.value)}>
              <option value="">All countries</option>
              {[...new Set(BENEFIT_PLANS.map((p) => p.country))].map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          ) : (
            <select value={ownCountry} disabled>
              <option value={ownCountry}>{ownCountry || "Not set"}</option>
            </select>
          )}
        </label>
      </FilterBar>

      <Banner message={msg} />

      <Tabs
        tabs={[
          { id: "plans", label: "Plans" },
          { id: "enrollment", label: "Enrollment" },
          { id: "dependents", label: "Dependents" },
          { id: "history", label: "Benefit history" },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "plans" && (
        <div className="mgr-home-grid">
          <Card title={`Benefit plans · ${country || "All countries"}`}>
            <DataTable
              headers={["Plan", "Category", "Provider", "Employee cost", ""]}
              rows={plans.map((p) => [
                <>
                  {p.name}
                  {p.mandatory ? <span className="reward-tag">Mandatory</span> : p.autoEnrolled ? <span className="reward-tag">Automatic</span> : null}
                </>,
                p.category,
                p.provider,
                p.employeeCost,
                <button key={p.id} type="button" className="quiet-link" onClick={() => setPlanId(p.id)}>
                  Details
                </button>,
              ])}
              empty={<EmptyState title="No plans" description="No benefit plans for this country." />}
            />
          </Card>
          {selectedPlan && (
            <Card title={selectedPlan.name}>
              <p>{selectedPlan.summary}</p>
              <p className="note">Provider: {selectedPlan.provider}</p>
              {selectedPlan.mandatory ? (
                <p className="note">Statutory. Enrollment is automatic and can't be waived.</p>
              ) : selectedPlan.autoEnrolled ? (
                <p className="note">You are enrolled automatically. Ask HR to opt out.</p>
              ) : null}
              <h3 style={{ fontSize: 14, marginTop: 12 }}>Plan documents</h3>
              <ul className="todo">
                {selectedPlan.documents.map((d) => (
                  <li key={d}>
                    {d}{" "}
                    <button
                      type="button"
                      className="quiet-link"
                      onClick={() => downloadText(`${d}.txt`, `${d}\n\n${LEGAL_DISCLAIMER}\n\nPlan summary for ${selectedPlan.name}.`)}
                    >
                      Download (.txt)
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}

      {tab === "enrollment" && (
        <div className="stack">
          <Card title="Enrollment status">
            <DataTable
              headers={["Employee", "Plan", "Country", "Status", "Effective", "Action"]}
              rows={enrollments.map((e) => [
                e.employeeName,
                e.planName,
                e.country,
                <StatusBadge key={e.id} status={e.status} literal />,
                e.effective,
                <span key={`${e.id}-a`}>{enrollmentAction(e)}</span>,
              ])}
              empty={<EmptyState title="No enrollments" />}
            />
            {!canSeeOthers && <ScopeNote text="Requests go to HR." />}
          </Card>
          {changeRequests.length > 0 && (
            <Card title="Change requests">
              <DataTable
                headers={["Requested", "Employee", "Plan", "Change", "Status", ""]}
                rows={changeRequests.map((c) => [
                  c.requestedOn,
                  c.employeeName,
                  c.planName,
                  c.note,
                  <StatusBadge key={c.id} status={c.status} literal />,
                  isBenefitsAdmin && c.status === "Pending" && c.employeeId !== employee.id ? (
                    <span key={`${c.id}-a`} className="reward-actions">
                      <button type="button" className="btn" onClick={() => run(decideChangeRequest(demoProfile, c.id, "Done"), "Change marked done.")}>
                        Done
                      </button>
                      <button type="button" className="btn-ghost" onClick={() => run(decideChangeRequest(demoProfile, c.id, "Declined"), "Change declined.")}>
                        Decline
                      </button>
                    </span>
                  ) : (
                    c.decidedBy ? `${c.decidedBy} · ${c.decidedOn ?? ""}` : "—"
                  ),
                ])}
              />
            </Card>
          )}
          {availablePlans.length > 0 && (
            <Card title="Plans you can join">
              <DataTable
                headers={["Plan", "Category", "Employee cost", ""]}
                rows={availablePlans.map((p) => [
                  p.name,
                  p.category,
                  p.employeeCost,
                  <button
                    key={p.id}
                    type="button"
                    className="quiet-link"
                    onClick={() => run(requestEnrollment(demoProfile, p.id), "Enrollment request sent to HR.")}
                  >
                    Request enrollment
                  </button>,
                ])}
              />
            </Card>
          )}
        </div>
      )}

      {tab === "dependents" && (
        <Card title="Dependents">
          <DataTable
            headers={["Name", "Relationship", "Covered plans"]}
            rows={dependents.map((d) => [d.name, d.relationship, d.coveredPlans.join(", ")])}
            empty={<EmptyState title="No dependents on file" />}
          />
        </Card>
      )}

      {tab === "history" && (
        <Card title="Benefit history">
          <DataTable
            headers={["Date", "Event", "Detail"]}
            rows={history.map((h) => [h.date, h.event, h.detail])}
            empty={<EmptyState title="No history" description="No benefit events yet." />}
          />
        </Card>
      )}
    </Page>
  );
}

/* ───────────────────────────── DOCUMENTS & LETTERS ── */

/** Library categories → portal DocumentGroup for the ESS mirror. */
const PORTAL_GROUP: Record<string, DocumentGroup> = {
  Identity: "Immigration",
  Compliance: "Employment",
  Onboarding: "Onboarding",
  Benefits: "Employment",
  Other: "Employment",
};

export function DocumentsLettersPage() {
  const { demoProfile, employee, state, addDocument } = usePortal();
  const reward = useReward();
  const [tab, setTab] = useState("library");
  const [category, setCategory] = useState("");
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [openLetter, setOpenLetter] = useState<OpenLetter>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadName, setUploadName] = useState("");
  const [uploadCategory, setUploadCategory] = useState("Identity");
  const [uploadPreview, setUploadPreview] = useState("");
  const [uploadFileLabel, setUploadFileLabel] = useState("");
  const [uploadError, setUploadError] = useState("");

  const canLetters = canManageLetters(demoProfile);
  const portalDocs = state.documents.filter((d) => d.employeeId === employee.id);

  const library = reward.library.filter((d) => {
    if (canLetters) return !category || d.category === category;
    return d.employeeId === employee.id && (!category || d.category === category);
  });

  const previewDoc = library.find((d) => d.id === previewId) ?? null;
  const categories = [...new Set(reward.library.map((d) => d.category))];

  function resetUpload() {
    setUploadName("");
    setUploadPreview("");
    setUploadFileLabel("");
    setUploadError("");
  }

  function onFilePicked(file: File | null) {
    resetUpload();
    if (!file) return;
    const invalid = validateUpload(file);
    if (invalid) {
      setUploadError(invalid);
      return;
    }
    setUploadName(file.name.replace(/\.[^.]+$/, ""));
    setUploadFileLabel(`${file.name} · ${(file.size / 1024).toFixed(0)} KB`);
    const reader = new FileReader();
    if (file.type.startsWith("text/") || /\.(txt|csv)$/i.test(file.name)) {
      reader.onload = () => {
        const text = String(reader.result ?? "").slice(0, 4000);
        setUploadPreview(`Preview of ${file.name}:\n\n${text || "(empty file)"}`);
      };
      reader.readAsText(file);
    } else if (file.type.startsWith("image/")) {
      reader.onload = () => {
        setUploadPreview(String(reader.result ?? ""));
      };
      reader.readAsDataURL(file);
    } else {
      setUploadPreview(`File details\nName: ${file.name}\nType: ${file.type || "unknown"}\nSize: ${file.size} bytes`);
    }
  }

  function saveUpload(event: FormEvent) {
    event.preventDefault();
    if (!uploadName.trim() || uploadError) return;
    const error = addLibraryDoc({
      employeeId: employee.id,
      employeeName: employee.fullName,
      name: uploadName.trim(),
      category: uploadCategory,
      docType: "Upload",
      uploadedBy: employee.fullName,
      sizeLabel: uploadFileLabel || "—",
      preview: uploadPreview || uploadName.trim(),
      isDemoFile: false,
    });
    if (error) {
      setUploadError(error);
      return;
    }
    // Mirror a short metadata line into portal documents (never the binary data URL)
    const mirrorError = addDocument({
      name: uploadName.trim(),
      category: PORTAL_GROUP[uploadCategory] ?? "Employment",
      docType: "Upload",
      expires: "",
      body: `${uploadCategory} upload · ${uploadFileLabel || uploadName.trim()} · stored in the document library.`,
    });
    if (mirrorError) {
      setUploadError(`Saved to the library, but not to My ESS documents: ${mirrorError}`);
      return;
    }
    setUploadOpen(false);
    resetUpload();
  }

  return (
    <Page
      title="Documents & Letters"
      action={
        <button
          type="button"
          className="btn"
          onClick={() => {
            resetUpload();
            setUploadOpen(true);
          }}
        >
          Upload document
        </button>
      }
    >

      <Tabs
        tabs={[
          { id: "library", label: "Document library" },
          { id: "letters", label: "Letters & templates" },
          { id: "history", label: "Request & approval history" },
          { id: "personal", label: "My letters & documents" },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "library" && (
        <div className="mgr-home-grid">
          <Card title="Employee document library">
            <FilterBar>
              <label className="filter-label">
                Category
                <select value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="">All</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </label>
            </FilterBar>
            <DataTable
              headers={["Document", "Employee", "Category", "Type", "Uploaded", "Size", ""]}
              rows={library.map((d) => [
                <>
                  {d.name}
                </>,
                d.employeeName,
                d.category,
                d.docType,
                d.uploadedAt.slice(0, 10),
                d.sizeLabel,
                <button key={d.id} type="button" className="quiet-link" onClick={() => setPreviewId(d.id)}>
                  Preview
                </button>,
              ])}
              empty={<EmptyState title="No documents" description="Upload a document or switch category." />}
            />
          </Card>
          <Card title="Preview">
            {!previewDoc ? (
              <EmptyState title="Select a document" />
            ) : previewDoc.preview.startsWith("data:image") ? (
              <div>
                <p className="note">{previewDoc.name}</p>
                <img src={previewDoc.preview} alt="" style={{ maxWidth: "100%", borderRadius: 8 }} />
              </div>
            ) : (
              <pre className="doc-preview-pre">{previewDoc.preview}</pre>
            )}
            {previewDoc?.letterId && (
              <button
                type="button"
                className="btn"
                style={{ marginTop: 8, marginRight: 8 }}
                onClick={() => setOpenLetter({ letterId: previewDoc.letterId!, docId: previewDoc.docId })}
              >
                Open letter
              </button>
            )}
            {previewDoc && !previewDoc.letterId && (
              <button
                type="button"
                className="btn-ghost"
                style={{ marginTop: 8 }}
                onClick={() =>
                  downloadText(
                    `${previewDoc.name}.txt`,
                    previewDoc.preview.startsWith("data:")
                      ? `${previewDoc.name}\n${LEGAL_DISCLAIMER}`
                      : previewDoc.preview,
                  )
                }
              >
                Download
              </button>
            )}
          </Card>
        </div>
      )}

      {tab === "letters" && <LetterRequestsPanel actor={demoProfile} onOpen={setOpenLetter} />}

      {tab === "history" && <LetterHistoryPanel actor={demoProfile} onOpen={setOpenLetter} />}

      {tab === "personal" && (
        <>
          <MyLettersPanel actor={demoProfile} onOpen={setOpenLetter} />
          <Card title="My documents">
            <DataTable
              headers={["Name", "Category", "Type", "Expires"]}
              rows={portalDocs.map((d) => [d.name, d.category, d.docType, d.expires || "None"])}
              empty={<EmptyState title="No ESS documents" />}
            />
          </Card>
        </>
      )}

      <LetterViewerDialog actor={demoProfile} open={openLetter} onClose={() => setOpenLetter(null)} />

      <Dialog open={uploadOpen} title="Upload document" onClose={() => setUploadOpen(false)}>
        <form className="stack" onSubmit={saveUpload}>
          <Field label="File">
            <input
              type="file"
              accept={UPLOAD_EXTENSIONS.map((ext) => `.${ext}`).join(",")}
              onChange={(e) => onFilePicked(e.target.files?.[0] ?? null)}
            />
          </Field>
          <p className="note">PDF, PNG, JPG, WEBP, TXT or CSV · max 2 MB.</p>
          {uploadFileLabel && <p className="note">{uploadFileLabel}</p>}
          {uploadError && <Banner message={{ tone: "err", text: uploadError }} />}
          <Field label="Display name">
            <input value={uploadName} onChange={(e) => setUploadName(e.target.value)} required />
          </Field>
          <Field label="Category">
            <select value={uploadCategory} onChange={(e) => setUploadCategory(e.target.value)}>
              {Object.keys(PORTAL_GROUP).map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </Field>
          <div className="dialog-actions">
            <button type="button" className="btn-ghost" onClick={() => setUploadOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="btn" disabled={!uploadName.trim() || !!uploadError}>
              Save to library
            </button>
          </div>
        </form>
      </Dialog>
    </Page>
  );
}

/** Route alias used by App `/documents` */
export function DocumentsPage() {
  return <DocumentsLettersPage />;
}
