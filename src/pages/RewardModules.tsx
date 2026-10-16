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
  canApproveCompReviews,
  canManageLetters,
  canViewCompStructures,
  canViewSalaryAmount,
  displayMoney,
  formatCompAmount,
  getCompensationAccess,
  hasModuleAccess,
} from "../data/peoplePermissions.ts";
import {
  BENEFIT_HISTORY,
  BENEFIT_PLANS,
  COMP_CYCLES,
  COMP_HISTORY,
  DEPENDENTS,
  GRADE_BANDS,
  LEGAL_DISCLAIMER,
  LETTER_TEMPLATES,
  type LetterStatus,
  type LetterType,
} from "../data/rewardData.ts";
import {
  UPLOAD_EXTENSIONS,
  addLetterRequest,
  addLibraryDoc,
  canAdminBenefits,
  canViewLetter,
  decideEnrollment,
  getRewardState,
  isMandatoryPlan,
  nextLetterStatuses,
  requestEnrollment,
  requestEnrollmentChange,
  setLetterStatus,
  setReviewStatus,
  subscribeReward,
  validateUpload,
} from "../data/rewardLocal.ts";
import type { DocumentGroup } from "../model.ts";
import { usePortal } from "../store.tsx";

function useReward() {
  return useSyncExternalStore(subscribeReward, getRewardState, getRewardState);
}

function ScopeNote({ text }: { text: string }) {
  return <p className="note">{text}</p>;
}

/* ───────────────────────────── COMPENSATION ── */

export function CompensationPage() {
  const { demoProfile, employee } = usePortal();
  const reward = useReward();
  const [tab, setTab] = useState("structures");
  const [cycleId, setCycleId] = useState(COMP_CYCLES[0]?.id ?? "");
  const [country, setCountry] = useState("");
  const [reviewMsg, setReviewMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const structuresOk = canViewCompStructures(demoProfile);
  const canApprove = canApproveCompReviews(demoProfile);
  const compAccess = getCompensationAccess(demoProfile);
  const moduleOk =
    hasModuleAccess(demoProfile, "compensation") ||
    (compAccess.module && structuresOk) ||
    (compAccess.othersAmounts !== "hidden" && structuresOk);

  const bands = GRADE_BANDS.filter((b) => !country || b.country === country);
  const cycle = COMP_CYCLES.find((c) => c.id === cycleId) ?? COMP_CYCLES[0];

  const visibleHistory = useMemo(() => {
    return COMP_HISTORY.filter((row) => {
      const access = canViewSalaryAmount(demoProfile, row.employeeId, {
        selfId: employee.id,
        isDirectReport: row.managerId === employee.id || row.managerId === demoProfile.id,
      });
      return access !== "hidden";
    });
  }, [demoProfile, employee.id]);

  const visibleReviews = useMemo(() => {
    return reward.reviews.filter((row) => {
      if (row.cycleId !== cycleId) return false;
      if (canApprove) return true;
      if (row.managerId === employee.id || row.managerId === demoProfile.id) return true;
      if (row.employeeId === employee.id) return true;
      // Executives with compensation access see cycle counts, not individual proposals
      if (demoProfile.role === "executive" || demoProfile.role === "founder" || demoProfile.role === "cofounder") {
        return false;
      }
      if (demoProfile.role === "hrbp") return true;
      return false;
    });
  }, [reward.reviews, cycleId, canApprove, employee.id, demoProfile]);

  const visibleBonuses = useMemo(() => {
    return reward.bonuses.filter((row) => {
      const access = canViewSalaryAmount(demoProfile, row.employeeId, {
        selfId: employee.id,
        isDirectReport: false,
      });
      // Managers don't get org-wide bonus lists — only self
      if (demoProfile.role === "manager") {
        return row.employeeId === employee.id;
      }
      return access !== "hidden";
    });
  }, [reward.bonuses, demoProfile, employee.id]);

  if (!moduleOk) {
    return (
      <Page title="Compensation">
        <EmptyState
          title="Not authorized"
          description="Compensation is outside this persona's navAccess / permission configuration."
        />
      </Page>
    );
  }

  return (
    <Page title="Compensation" subtitle="Structures, history, review cycles, incentives">
      <MetricGrid>
        <MetricCard label="Grade bands" value={GRADE_BANDS.length} />
        <MetricCard label="Open cycle" value={cycle?.status ?? "—"} hint={cycle?.name} />
        <MetricCard label="Reviews in your scope" value={visibleReviews.length} />
        <MetricCard
          label="Pending approvals"
          value={visibleReviews.filter((r) => r.status === "Pending approval").length}
        />
      </MetricGrid>

      <Tabs
        tabs={[
          { id: "structures", label: "Structures & ranges" },
          { id: "history", label: "Compensation history" },
          { id: "cycles", label: "Review cycles" },
          { id: "bonuses", label: "Bonus & incentives" },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "structures" && (
        <Card title="Compensation structures, grades and salary ranges">
          {!structuresOk ? (
            <EmptyState title="Structures hidden" description="This persona cannot view grade bands." />
          ) : (
            <>
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
                rows={bands.map((b) => [b.grade, b.family, b.country, b.currency, b.min, b.mid, b.max])}
              />
            </>
          )}
        </Card>
      )}

      {tab === "history" && (
        <Card title="Compensation history (scoped)">
          {visibleHistory.length === 0 ? (
            <EmptyState
              title="No visible history"
              description="There are no compensation changes for you to see."
            />
          ) : (
            <DataTable
              headers={["Employee", "Effective", "Event", "Grade", "Base"]}
              rows={visibleHistory.map((row) => {
                const access = canViewSalaryAmount(demoProfile, row.employeeId, {
                  selfId: employee.id,
                  isDirectReport: row.managerId === employee.id || row.managerId === demoProfile.id,
                });
                return [
                  row.employeeName,
                  row.effective,
                  row.event,
                  row.grade,
                  displayMoney(row.base, access),
                ];
              })}
            />
          )}
        </Card>
      )}

      {tab === "cycles" && (
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
                <div className="info-fact"><dt>Status</dt><dd><StatusBadge status={cycle.status} /></dd></div>
                <div className="info-fact"><dt>Window</dt><dd>{cycle.window}</dd></div>
                <div className="info-fact"><dt>Countries</dt><dd>{cycle.countries.join(", ")}</dd></div>
              </dl>
            </Card>
          )}
          <Card title="Increment proposals & approval workflow">
            {(demoProfile.role === "executive" || demoProfile.role === "founder" || demoProfile.role === "cofounder") &&
              !canApprove && (
                <Banner
                  message={{
                    tone: "ok",
                    text: "Executive personas see cycle status only — not employee-level salary proposals — unless granted compensation_admin / HR / Finance rights.",
                  }}
                />
              )}
            {cycle?.status === "Closed" && (
              <Banner message={{ tone: "info", text: "This cycle is closed — proposals are read-only." }} />
            )}
            <Banner message={reviewMsg} />
            {visibleReviews.length === 0 ? (
              <EmptyState
                title="No proposals to review"
                description="You only see your own row, direct reports (masked), or the HR/Comp approval queue."
              />
            ) : (
              <DataTable
                headers={["Employee", "Manager", "Grade", "Current", "Proposed", "Incr %", "Bonus", "Status", "Decided by", "Action"]}
                rows={visibleReviews.map((r) => {
                  const access = canViewSalaryAmount(demoProfile, r.employeeId, {
                    selfId: employee.id,
                    isDirectReport: r.managerId === employee.id || r.managerId === demoProfile.id,
                  });
                  const decide = (status: "Approved" | "Rejected") => {
                    const error = setReviewStatus(demoProfile, r.id, status);
                    setReviewMsg(error ? { tone: "err", text: error } : { tone: "ok", text: `${r.employeeName}: ${status}.` });
                  };
                  let action: ReactNode;
                  if (!canApprove) action = <span className="muted">View only</span>;
                  else if (cycle?.status === "Closed") action = <span className="muted">Locked</span>;
                  else if (r.employeeId === employee.id) action = <span className="muted">Your own review</span>;
                  else if (r.status !== "Pending approval") action = <span className="muted">—</span>;
                  else
                    action = (
                      <span className="reward-actions">
                        <button type="button" className="btn" onClick={() => decide("Approved")}>Approve</button>
                        <button type="button" className="btn-ghost" onClick={() => decide("Rejected")}>Reject</button>
                      </span>
                    );
                  return [
                    r.employeeName,
                    r.managerName,
                    // Proposed grade and % reveal the outcome, so mask them with the amounts
                    `${r.currentGrade} → ${formatCompAmount(access, r.proposedGrade, "•••")}`,
                    displayMoney(r.currentBase, access),
                    displayMoney(r.proposedBase, access),
                    formatCompAmount(access, `${r.proposedIncreasePct}%`, "•••"),
                    displayMoney(r.bonusProposal, access),
                    <StatusBadge key={r.id} status={r.status} />,
                    r.approver ? `${r.approver} · ${r.decidedOn ?? ""}` : "—",
                    <span key={`${r.id}-a`}>{action}</span>,
                  ];
                })}
              />
            )}
          </Card>
        </div>
      )}

      {tab === "bonuses" && (
        <Card title="Bonus and incentive records">
          {visibleBonuses.length === 0 ? (
            <EmptyState title="No incentives to show" description="Company-wide bonus lists are visible to HR and Compensation only." />
          ) : (
            <DataTable
              headers={["Employee", "Type", "Period", "Amount", "Status"]}
              rows={visibleBonuses.map((b) => {
                const access = canViewSalaryAmount(demoProfile, b.employeeId, { selfId: employee.id });
                return [
                  b.employeeName,
                  b.type,
                  b.period,
                  displayMoney(b.amount, access),
                  <StatusBadge key={b.id} status={b.status} />,
                ];
              })}
            />
          )}
        </Card>
      )}
    </Page>
  );
}

/* ───────────────────────────── BENEFITS ── */

export function BenefitsPage() {
  const { demoProfile, employee, demoAccounts } = usePortal();
  const reward = useReward();
  const [tab, setTab] = useState("plans");
  const [planId, setPlanId] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const canSeeOthers =
    demoProfile.role === "hr_admin" ||
    demoProfile.role === "hr" ||
    demoProfile.role === "hrbp" ||
    demoProfile.role === "compensation_admin" ||
    demoProfile.role === "super_admin";
  const isBenefitsAdmin = canAdminBenefits(demoProfile);

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
  const availablePlans = plans.filter((p) => p.country === ownCountry && !myPlanIds.has(p.id));

  const dependents = DEPENDENTS.filter((d) => inScope(d.employeeId));
  const history = BENEFIT_HISTORY.filter((h) => inScope(h.employeeId));

  function run(error: string | null, okText: string) {
    setMsg(error ? { tone: "err", text: error } : { tone: "ok", text: okText });
  }

  function enrollmentAction(e: (typeof enrollments)[number]): ReactNode {
    const mandatory = isMandatoryPlan(e.planId);
    if (e.employeeId === employee.id) {
      if (e.status === "Pending") return <span className="muted">Awaiting HR</span>;
      if (e.status === "Enrolled") {
        return mandatory ? (
          <span className="muted">Mandatory</span>
        ) : (
          <button type="button" className="quiet-link" onClick={() => run(requestEnrollmentChange(demoProfile, e.id), "Change request sent to HR.")}>
            Request change
          </button>
        );
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
        <EmptyState title="Not authorized" description="Benefits module is outside this persona's navAccess." />
      </Page>
    );
  }

  return (
    <Page title="Benefits" subtitle="Country plans, eligibility, enrollment, dependents and plan documents">

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
          { id: "enrollment", label: "Eligibility & enrollment" },
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
                  {p.mandatory && <span className="reward-tag">Mandatory</span>}
                </>,
                p.category,
                p.provider,
                p.employeeCost,
                <button key={p.id} type="button" className="quiet-link" onClick={() => setPlanId(p.id)}>
                  Details
                </button>,
              ])}
              empty={<EmptyState title="No plans" description="No benefit plans are available for this country." />}
            />
          </Card>
          {selectedPlan && (
            <Card title={selectedPlan.name}>
              <p>{selectedPlan.summary}</p>
              <p className="note">Provider: {selectedPlan.provider}</p>
              {selectedPlan.mandatory && (
                <p className="note">Statutory plan — enrollment is compulsory and cannot be waived.</p>
              )}
              <h3 style={{ fontSize: 14, marginTop: 12 }}>Benefit documents</h3>
              <ul className="todo">
                {selectedPlan.documents.map((d) => (
                  <li key={d}>
                    {d}{" "}
                    <button
                      type="button"
                      className="quiet-link"
                      onClick={() =>
                        downloadText(
                          d.replace(/\.pdf$/i, ".txt"),
                          `${d}\n\n${LEGAL_DISCLAIMER}\n\nPlan excerpt for ${selectedPlan.name}.`,
                        )
                      }
                    >
                      Download
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
          <Card title="Eligibility and enrollment status">
            <DataTable
              headers={["Employee", "Plan", "Country", "Status", "Effective", "Action"]}
              rows={enrollments.map((e) => [
                e.employeeName,
                e.planName,
                e.country,
                <StatusBadge key={e.id} status={e.status} />,
                e.effective,
                <span key={`${e.id}-a`}>{enrollmentAction(e)}</span>,
              ])}
              empty={<EmptyState title="No enrollments" description="No enrollments yet." />}
            />
            {!canSeeOthers && <ScopeNote text="Changes are sent to HR for approval." />}
          </Card>
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
            empty={<EmptyState title="No dependents on file" description="No dependents are recorded for this scope." />}
          />
        </Card>
      )}

      {tab === "history" && (
        <Card title="Benefit history">
          <DataTable
            headers={["Date", "Event", "Detail"]}
            rows={history.map((h) => [h.date, h.event, h.detail])}
            empty={<EmptyState title="No history" description="No benefit events for this scope." />}
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
  const [letterType, setLetterType] = useState<LetterType>("Employment");
  const [letterNote, setLetterNote] = useState("");
  const [letterMsg, setLetterMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadName, setUploadName] = useState("");
  const [uploadCategory, setUploadCategory] = useState("Identity");
  const [uploadPreview, setUploadPreview] = useState("");
  const [uploadFileLabel, setUploadFileLabel] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [letterPreview, setLetterPreview] = useState<string | null>(null);

  const canLetters = canManageLetters(demoProfile);
  const portalDocs = state.documents.filter((d) => d.employeeId === employee.id);

  const library = reward.library.filter((d) => {
    if (canLetters) return !category || d.category === category;
    return d.employeeId === employee.id && (!category || d.category === category);
  });

  const letters = reward.letters.filter((l) => canViewLetter(demoProfile, l));

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

  function moveLetter(id: string, status: LetterStatus) {
    const error = setLetterStatus(demoProfile, id, status);
    setLetterMsg(error ? { tone: "err", text: error } : { tone: "ok", text: `Letter moved to ${status}.` });
  }

  const letterActionLabel: Record<LetterStatus, string> = {
    Draft: "Draft",
    "Pending approval": "Submit",
    Approved: "Approve",
    Rejected: "Reject",
    Issued: "Issue",
  };

  return (
    <Page
      title="Documents & Letters"
      subtitle="Employee library, uploads, letter templates and approval history"
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
          { id: "personal", label: "My ESS documents" },
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
              <EmptyState title="Select a document" description="Choose Preview on a document to see it here." />
            ) : previewDoc.preview.startsWith("data:image") ? (
              <div>
                <p className="note">{previewDoc.name}</p>
                <img src={previewDoc.preview} alt="" style={{ maxWidth: "100%", borderRadius: 8 }} />
              </div>
            ) : (
              <pre className="doc-preview-pre">{previewDoc.preview}</pre>
            )}
            {previewDoc && (
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

      {tab === "letters" && (
        <div className="mgr-home-grid">
          <Card title="Letter templates">
            <DataTable
              headers={["Type", "Description"]}
              rows={LETTER_TEMPLATES.map((t) => [t.type, t.description])}
            />
            <form
              className="stack"
              style={{ marginTop: 12 }}
              onSubmit={(e) => {
                e.preventDefault();
                const error = addLetterRequest(demoProfile, {
                  employeeId: employee.id,
                  employeeName: employee.fullName,
                  type: letterType,
                  note: letterNote.trim() || "No reason given",
                });
                if (error) {
                  setLetterMsg({ tone: "err", text: error });
                  return;
                }
                setLetterMsg({ tone: "ok", text: `${letterType} letter requested — sent to HR for approval.` });
                setLetterNote("");
                setTab("history");
              }}
            >
              <Field label="Request letter type">
                <select value={letterType} onChange={(e) => setLetterType(e.target.value as LetterType)}>
                  {LETTER_TEMPLATES.map((t) => (
                    <option key={t.type} value={t.type}>{t.type}</option>
                  ))}
                </select>
              </Field>
              <Field label="Note" wide>
                <input value={letterNote} onChange={(e) => setLetterNote(e.target.value)} placeholder="Reason for request" />
              </Field>
              <button type="submit" className="btn">
                Request letter
              </button>
            </form>
          </Card>
          <Card title="Letter workflow statuses">
            <p className="note">Pending approval → Approved → Issued (or Rejected).</p>
            <Banner message={letterMsg} />
            <DataTable
              headers={["Employee", "Type", "Status", "Preview", "Action"]}
              rows={letters.map((l) => {
                const next = nextLetterStatuses(demoProfile, l);
                return [
                  l.employeeName,
                  l.type,
                  <StatusBadge key={l.id} status={l.status} />,
                  <button
                    key={`${l.id}-p`}
                    type="button"
                    className="quiet-link"
                    onClick={() => setLetterPreview(l.previewBody)}
                  >
                    View letter
                  </button>,
                  next.length === 0 ? (
                    <span key={`${l.id}-a`} className="muted">—</span>
                  ) : (
                    <span key={`${l.id}-a`} className="reward-actions">
                      {next.map((s) => (
                        <button
                          key={s}
                          type="button"
                          className={s === "Rejected" ? "btn-ghost" : "btn"}
                          onClick={() => moveLetter(l.id, s)}
                        >
                          {letterActionLabel[s]}
                        </button>
                      ))}
                    </span>
                  ),
                ];
              })}
            />
          </Card>
        </div>
      )}

      {tab === "history" && (
        <Card title="Request and approval history">
          <Banner message={letterMsg} />
          <DataTable
            headers={["Requested", "Employee", "Type", "By", "Status", "Approver", "Decided", "Note"]}
            rows={letters.map((l) => [
              l.requestedOn,
              l.employeeName,
              l.type,
              l.requestedBy,
              <StatusBadge key={l.id} status={l.status} />,
              l.approver ?? "—",
              l.decidedOn ?? "—",
              l.note,
            ])}
            empty={<EmptyState title="No letter requests" description="Request a letter from the Letters tab." />}
          />
        </Card>
      )}

      {tab === "personal" && (
        <Card title="My ESS documents (portal store)">
          <DataTable
            headers={["Name", "Category", "Type", "Expires"]}
            rows={portalDocs.map((d) => [d.name, d.category, d.docType, d.expires || "None"])}
            empty={<EmptyState title="No ESS documents" description="Uploads also appear in the library tab." />}
          />
        </Card>
      )}

      <Dialog open={!!letterPreview} title="Letter preview" onClose={() => setLetterPreview(null)}>
        <pre className="doc-preview-pre">{letterPreview}</pre>
      </Dialog>

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
