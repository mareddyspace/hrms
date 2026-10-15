import { useMemo, useState, useSyncExternalStore, type FormEvent } from "react";
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
  type LetterType,
} from "../data/rewardData.ts";
import {
  addLetterRequest,
  addLibraryDoc,
  getRewardState,
  setEnrollmentStatus,
  setLetterStatus,
  setReviewStatus,
  subscribeReward,
} from "../data/rewardLocal.ts";
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
              <p className="note">Ranges are fictional market bands for UI demos — not real pay offers.</p>
            </>
          )}
        </Card>
      )}

      {tab === "history" && (
        <Card title="Compensation history (scoped)">
          {visibleHistory.length === 0 ? (
            <EmptyState
              title="No visible history"
              description="No compensation events are in scope for this persona (or amounts are fully restricted)."
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
            {visibleReviews.length === 0 ? (
              <EmptyState
                title="No proposals in scope"
                description="You only see your own row, direct reports (masked), or the HR/Comp approval queue."
              />
            ) : (
              <DataTable
                headers={["Employee", "Manager", "Grade", "Current", "Proposed", "Incr %", "Bonus", "Status", "Action"]}
                rows={visibleReviews.map((r) => {
                  const access = canViewSalaryAmount(demoProfile, r.employeeId, {
                    selfId: employee.id,
                    isDirectReport: r.managerId === employee.id || r.managerId === demoProfile.id,
                  });
                  return [
                    r.employeeName,
                    r.managerName,
                    `${r.currentGrade} → ${r.proposedGrade}`,
                    displayMoney(r.currentBase, access),
                    displayMoney(r.proposedBase, access),
                    `${r.proposedIncreasePct}%`,
                    displayMoney(r.bonusProposal, access),
                    <StatusBadge key={r.id} status={r.status} />,
                    canApprove ? (
                      <select
                        key={`${r.id}-a`}
                        value={r.status}
                        onChange={(e) => setReviewStatus(r.id, e.target.value as typeof r.status)}
                      >
                        {(["Draft", "Pending approval", "Approved", "Rejected"] as const).map((s) => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </select>
                    ) : (
                      <span className="muted">View only</span>
                    ),
                  ];
                })}
              />
            )}
            <p className="note">Approvals are human-controlled local demo actions — not payroll commits.</p>
          </Card>
        </div>
      )}

      {tab === "bonuses" && (
        <Card title="Bonus and incentive records">
          {visibleBonuses.length === 0 ? (
            <EmptyState title="No incentive rows in scope" description="Org-wide bonus lists are not shown to managers or executives." />
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
  const { demoProfile, employee } = usePortal();
  const reward = useReward();
  const [tab, setTab] = useState("plans");
  const [country, setCountry] = useState(employee.countryName ?? "India");
  const [planId, setPlanId] = useState("");

  const canSeeOthers =
    demoProfile.role === "hr_admin" ||
    demoProfile.role === "hr" ||
    demoProfile.role === "hrbp" ||
    demoProfile.role === "compensation_admin" ||
    demoProfile.role === "super_admin";

  const plans = BENEFIT_PLANS.filter((p) => !country || p.country === country);
  const selectedPlan = BENEFIT_PLANS.find((p) => p.id === planId) ?? plans[0];

  const enrollments = reward.enrollments.filter((e) => {
    if (canSeeOthers) return !country || e.country === country;
    return e.employeeId === employee.id;
  });

  const dependents = DEPENDENTS.filter((d) =>
    canSeeOthers ? true : d.employeeId === employee.id,
  ).filter((d) => d.employeeId === employee.id || canSeeOthers);

  const history = BENEFIT_HISTORY.filter((h) =>
    canSeeOthers ? true : h.employeeId === employee.id,
  );

  if (!hasModuleAccess(demoProfile, "benefits")) {
    return (
      <Page title="Benefits">
        <EmptyState title="Not authorized" description="Benefits module is outside this persona's navAccess." />
      </Page>
    );
  }

  return (
    <Page title="Benefits" subtitle="Country plans, eligibility, enrollment, dependents and plan documents">
      <Banner message={{ tone: "ok", text: LEGAL_DISCLAIMER }} />

      <FilterBar>
        <label className="filter-label">
          Country
          <select value={country} onChange={(e) => setCountry(e.target.value)}>
            {[...new Set(BENEFIT_PLANS.map((p) => p.country))].map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
      </FilterBar>

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
          <Card title={`Benefit plans · ${country}`}>
            <DataTable
              headers={["Plan", "Category", "Provider", "Employee cost", ""]}
              rows={plans.map((p) => [
                p.name,
                p.category,
                p.provider,
                p.employeeCost,
                <button key={p.id} type="button" className="quiet-link" onClick={() => setPlanId(p.id)}>
                  Details
                </button>,
              ])}
              empty={<EmptyState title="No plans" description="No demo plans for this country." />}
            />
          </Card>
          {selectedPlan && (
            <Card title={selectedPlan.name}>
              <p>{selectedPlan.summary}</p>
              <p className="note">Provider: {selectedPlan.provider}</p>
              <h3 style={{ fontSize: 14, marginTop: 12 }}>Benefit documents (demo)</h3>
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
                          `${d}\n\n${LEGAL_DISCLAIMER}\n\nDemo plan excerpt for ${selectedPlan.name}.`,
                        )
                      }
                    >
                      Download demo file
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}

      {tab === "enrollment" && (
        <Card title="Eligibility and enrollment status">
          <DataTable
            headers={["Employee", "Plan", "Country", "Status", "Effective", "Update"]}
            rows={enrollments.map((e) => [
              e.employeeName,
              e.planName,
              e.country,
              <StatusBadge key={e.id} status={e.status} />,
              e.effective,
              e.employeeId === employee.id || canSeeOthers ? (
                <select
                  key={`${e.id}-s`}
                  value={e.status}
                  onChange={(ev) => setEnrollmentStatus(e.id, ev.target.value as typeof e.status)}
                >
                  {(["Eligible", "Enrolled", "Waived", "Pending"] as const).map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              ) : (
                "—"
              ),
            ])}
            empty={<EmptyState title="No enrollments" description="No enrollment rows in scope." />}
          />
          {!canSeeOthers && <ScopeNote text="Showing your enrollments only. HR personas see broader country queues." />}
        </Card>
      )}

      {tab === "dependents" && (
        <Card title="Dependents">
          <DataTable
            headers={["Name", "Relationship", "Covered plans"]}
            rows={dependents
              .filter((d) => d.employeeId === employee.id || canSeeOthers)
              .map((d) => [d.name, d.relationship, d.coveredPlans.join(", ")])}
            empty={<EmptyState title="No dependents on file" description="Demo dependent records appear for sample employees." />}
          />
        </Card>
      )}

      {tab === "history" && (
        <Card title="Benefit history">
          <DataTable
            headers={["Date", "Event", "Detail"]}
            rows={history
              .filter((h) => h.employeeId === employee.id || canSeeOthers)
              .map((h) => [h.date, h.event, h.detail])}
            empty={<EmptyState title="No history" description="No benefit events for this scope." />}
          />
        </Card>
      )}
    </Page>
  );
}

/* ───────────────────────────── DOCUMENTS & LETTERS ── */

export function DocumentsLettersPage() {
  const { demoProfile, employee, state, addDocument } = usePortal();
  const reward = useReward();
  const [tab, setTab] = useState("library");
  const [category, setCategory] = useState("");
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [letterType, setLetterType] = useState<LetterType>("Employment");
  const [letterNote, setLetterNote] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadName, setUploadName] = useState("");
  const [uploadCategory, setUploadCategory] = useState("Identity");
  const [uploadPreview, setUploadPreview] = useState("");
  const [uploadFileLabel, setUploadFileLabel] = useState("");
  const [letterPreview, setLetterPreview] = useState<string | null>(null);

  const canLetters = canManageLetters(demoProfile);
  const portalDocs = state.documents.filter((d) => d.employeeId === employee.id);

  const library = reward.library.filter((d) => {
    if (canLetters) return !category || d.category === category;
    return d.employeeId === employee.id && (!category || d.category === category);
  });

  const letters = reward.letters.filter((l) => {
    if (canLetters) return true;
    return l.employeeId === employee.id;
  });

  const previewDoc = library.find((d) => d.id === previewId) ?? null;
  const categories = [...new Set(reward.library.map((d) => d.category))];

  function onFilePicked(file: File | null) {
    if (!file) return;
    setUploadName(file.name.replace(/\.[^.]+$/, ""));
    setUploadFileLabel(`${file.name} · ${(file.size / 1024).toFixed(0)} KB (demo)`);
    const reader = new FileReader();
    if (file.type.startsWith("text/") || file.name.endsWith(".txt") || file.name.endsWith(".csv")) {
      reader.onload = () => {
        const text = String(reader.result ?? "").slice(0, 4000);
        setUploadPreview(`Demo upload preview of ${file.name}:\n\n${text || "(empty file)"}`);
      };
      reader.readAsText(file);
    } else if (file.type.startsWith("image/")) {
      reader.onload = () => {
        setUploadPreview(String(reader.result ?? ""));
      };
      reader.readAsDataURL(file);
    } else {
      setUploadPreview(
        `Demo file metadata only.\nName: ${file.name}\nType: ${file.type || "unknown"}\nSize: ${file.size} bytes\n\n${LEGAL_DISCLAIMER}`,
      );
    }
  }

  function saveUpload(event: FormEvent) {
    event.preventDefault();
    if (!uploadName.trim()) return;
    addLibraryDoc({
      employeeId: employee.id,
      employeeName: employee.fullName,
      name: uploadName.trim(),
      category: uploadCategory,
      docType: "Upload",
      uploadedBy: employee.fullName,
      sizeLabel: uploadFileLabel || "Demo",
      preview: uploadPreview || `Demo file: ${uploadName}`,
      isDemoFile: true,
    });
    // Also mirror into portal documents for ESS compatibility
    addDocument({
      name: uploadName.trim(),
      category: "Onboarding",
      docType: "Upload",
      expires: "",
      body: uploadPreview.slice(0, 2000) || "Demo upload",
    });
    setUploadOpen(false);
    setUploadName("");
    setUploadPreview("");
    setUploadFileLabel("");
  }

  return (
    <Page
      title="Documents & Letters"
      subtitle="Employee library, demo uploads, letter templates and approval history"
      action={
        <button type="button" className="btn" onClick={() => setUploadOpen(true)}>
          Upload demo file
        </button>
      }
    >
      <Banner message={{ tone: "ok", text: LEGAL_DISCLAIMER }} />

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
                  {d.name} {d.isDemoFile && <span className="muted">(demo)</span>}
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
              empty={<EmptyState title="No documents" description="Upload a demo file or switch category." />}
            />
          </Card>
          <Card title="Preview">
            {!previewDoc ? (
              <EmptyState title="Select a document" description="Preview opens metadata / demo content only." />
            ) : previewDoc.preview.startsWith("data:image") ? (
              <div>
                <p className="note">{previewDoc.name} · demo image preview</p>
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
                Download demo text
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
                addLetterRequest({
                  employeeId: employee.id,
                  employeeName: employee.fullName,
                  type: letterType,
                  requestedBy: employee.fullName,
                  note: letterNote || "Demo request",
                });
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
                Create draft request
              </button>
            </form>
          </Card>
          <Card title="Letter workflow statuses">
            <p className="note">Draft → Pending approval → Approved → Issued (local demo only).</p>
            <DataTable
              headers={["Employee", "Type", "Status", "Preview"]}
              rows={letters.map((l) => [
                l.employeeName,
                l.type,
                <StatusBadge key={l.id} status={l.status} />,
                <button
                  key={`${l.id}-p`}
                  type="button"
                  className="quiet-link"
                  onClick={() => setLetterPreview(l.previewBody)}
                >
                  View demo text
                </button>,
              ])}
            />
            {canLetters && (
              <div style={{ marginTop: 12 }}>
                <p className="note">HR actions</p>
                {letters.map((l) => (
                  <div key={`${l.id}-hr`} className="row-gap" style={{ marginBottom: 8 }}>
                    <span>{l.employeeName} · {l.type}</span>
                    <select
                      value={l.status}
                      onChange={(e) =>
                        setLetterStatus(l.id, e.target.value as typeof l.status, demoProfile.fullName)
                      }
                    >
                      {(["Draft", "Pending approval", "Approved", "Issued"] as const).map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === "history" && (
        <Card title="Request and approval history">
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
            empty={<EmptyState title="No letter requests" description="Create a draft from the Letters tab." />}
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

      <Dialog open={!!letterPreview} title="Demo letter preview" onClose={() => setLetterPreview(null)}>
        <Banner message={{ tone: "ok", text: LEGAL_DISCLAIMER }} />
        <pre className="doc-preview-pre">{letterPreview}</pre>
      </Dialog>

      <Dialog open={uploadOpen} title="Upload demo file" onClose={() => setUploadOpen(false)}>
        <form className="stack" onSubmit={saveUpload}>
          <Field label="File">
            <input
              type="file"
              accept=".txt,.csv,.png,.jpg,.jpeg,.pdf,.doc,.docx"
              onChange={(e) => onFilePicked(e.target.files?.[0] ?? null)}
            />
          </Field>
          {uploadFileLabel && <p className="note">{uploadFileLabel}</p>}
          <Field label="Display name">
            <input value={uploadName} onChange={(e) => setUploadName(e.target.value)} required />
          </Field>
          <Field label="Category">
            <select value={uploadCategory} onChange={(e) => setUploadCategory(e.target.value)}>
              {["Identity", "Compliance", "Onboarding", "Benefits", "Other"].map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </Field>
          <p className="note">Files stay in browser local/demo state. PDFs show metadata preview only.</p>
          <div className="dialog-actions">
            <button type="button" className="btn-ghost" onClick={() => setUploadOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="btn" disabled={!uploadName.trim()}>
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
