# Roadmap gap check B: design doc sections 25-48 against TimeZ HRMS

Read-only review, 2026-11-06, branch fix/module-audit (working tree). Paths are relative to `C:\Users\Gayathri\OneDrive\Desktop\hrmsspare`.
Status key: **P** = Present, **Pa** = Partial, **M** = Missing. If something only works in the browser (localStorage or client-side computing) while the app runs in backend mode, it counts as Partial.
Deliberate deviation (not a gap): admin and super_admin get full HR data access (`HR_ACCESS_ROLES` / `SUPER_ADMIN_ROLES` in `backend/app/services/scope.py`; `data_scope.scope_for` ignores saved scopes for them).

## §25-26 Workflows and approvals

| Item | Status | Evidence / what is missing |
|---|---|---|
| Central workflow engine | P | `backend/app/services/approvals.py` (versioned `WorkflowDefinition`, `ApprovalInstance`, `ApprovalDecision`). Used by leave, attendance corrections and timesheets (`services/time_approvals.py`), expense, travel, lifecycle, compensation, letters, exits, overtime, self-service, and requisitions (`services/recruiting.py`). Editor: `/workflows` (`routers/approvals.py` workflows_router, `src/api/syncWorkflows.ts`, `src/pages/ApprovalWorkflowsPage.tsx`) |
| Sequential | P | The ordered step list in approvals.py (`_next_step`) |
| Parallel | P | Step `mode:"all"`: every role group in the step must approve (`_step_complete`). Groups are parallel inside one step; there are no parallel branches |
| Conditional | P | Per-step `condition` (country/department/grade), `only_if` (needs_hr/via_manager), and `min_amount` (approvals.py `condition_matches`, `_step_applies`) |
| Delegated | P | `ApprovalDelegation`, `delegators_for`, `on_behalf_of` on the decision (approvals.py; `routers/delegations.py`, `src/pages/DelegationSettings.tsx`) |
| Escalated | Pa | `escalate_overdue_steps` only notifies the approvers' managers and audits the event. The approval is not reassigned. It runs only at API startup or on `POST /admin/jobs/run` (`services/jobs.py`, `main.py` `_lifespan_jobs`), with no periodic scheduler |
| SLA-based | Pa | A per-step `sla_hours` exists, but it is only checked when the job runs (see Escalated). No SLA dashboard or SLA field in the UI was verified |
| Example: Leave Employee→Manager→HR | P | `services/workflow_defaults.py` "leave" (HR step `only_if: needs_hr`) |
| Example: Compensation Manager→HRBP→Comp team→Authorized approver | Pa | `services/compensation.py` `COMP_WORKFLOW` = HR → finance/admin → executive (≥10%). The role groups (`ROLE_GROUPS` in approvals.py) have no HRBP-only group and no compensation-team group |
| Example: Recruiting HM→Dept approval→HR→Finance→Approved | P | `services/recruiting.py` `DEFAULT_REQUISITION_STEPS` (skip_manager → hr → finance). The department approval is done by the skip-level manager |
| Approval history | P | `ApprovalDecision` rows, `decisions_of`, GET `/approvals/{id}` |
| Rejection reason / Comments | P | `ApprovalDecision.note` (`models/approvals.py`) |
| Delegation record | P | `on_behalf_of` |
| Escalation record | P | `steps[i].escalated_at/escalated_to` plus the `approval_escalated` audit entry |
| SLA record | P | `sla_hours` on the step snapshot |
| Timestamp | P | `ApprovalDecision.at`, `ApprovalInstance.completed_at` (UTC) |
| Audit information | P | `record_audit` in approvals.py |
| §26 Reject → Resubmit | Pa | No generic resubmit in the engine (no "resubmit" in `backend/app`). After a rejection the requester raises a new request. The timesheet UI has its own resubmit path (`src/pages/TimesheetPage.tsx`) |
| §26 Final → Audit | P | `_finish` plus audit |
| Leave on the central engine | P | `time_approvals.py` uses the engine. The engine's docstring still says "Leave keeps its own logic", which is out of date |

## §27 Roles (15). Can an account hold the role on the server, and does the server act on it?

General finding: `Account.role` is a free `String(32)` (`backend/app/models/people.py`). No API creates accounts or changes a role. `routers/admin_console.py` only offers deactivate, reactivate, unlock and force-reset. `routers/platform_admin.py` only sets data scope and page access. The roles page (`src/pages/RolesPermissionsPage.tsx`) edits page access and scope, not roles. The only accounts are the ones seeded from `backend/seed/accounts.json`: admin, employee×3, executive, hr_admin, manager, recruiter. Any other role needs a direct database edit.

| Role | Status | Evidence |
|---|---|---|
| Super Admin | P | `super_admin`/`admin` in `SUPER_ADMIN_ROLES` (scope.py). The seed account is `admin`. Admin console (`routers/admin_console.py`) |
| HR Admin | P | `hr_admin` in `HR_ROLES`; seeded |
| HRBP | Pa | `hrbp` is in `HR_ROLES` but is treated exactly like HR (global, or limited to countries). There is no "assigned business/function" scope by default (a saved BU/department scope can approximate it via `data_scope.py`). Not seeded and not assignable |
| Recruiter | P | `recruiter` checks in `services/recruiting.py`, `routers/recruiting.py`, `services/onboarding.py`; seeded |
| Hiring Manager | P (by relationship) | Not an account role. It comes from `Requisition.hiring_manager_id` (`rules.is_hiring_manager`, `routers/recruiting.py`) |
| Manager | P | Reporting line (`scope.report_ids`); seeded |
| Employee | P | Seeded; own scope |
| Candidate | Pa | No candidate account or portal for "own recruitment info". There is a public apply page and offer response by token (`routers/careers.py` `/careers/*`, `/offers/{token}`) |
| L&D Admin | M | Front end has `learning_admin` (`src/model.ts`). The backend never mentions it; learning admin is HR (`routers/learning.py`) |
| Performance Admin | M | Front end has `performance_admin`. Zero backend references |
| Compensation Admin | Pa | The backend honours `compensation` (`services/compensation.py` `PAY_ROLES`, `services/tax_declarations.py`), but the front end calls it `compensation_admin` (`src/model.ts`), so the names do not match. Not seeded or assignable |
| Finance User | Pa | `finance` is honoured widely (`services/approvals.py` finance group, `routers/expenses.py`, `routers/payroll.py`, `services/payroll_runs.py`, `routers/overtime.py`). No account is seeded or assignable, so the finance step falls back to admin |
| IT Admin | Pa | `it_admin` is honoured in `services/exits.py:321` and `services/onboarding.py` `IT_ROLES`. No identity/integration admin rights: `/admin/integrations` is for `ADMIN_ROLES` (`routers/platform_admin.py`). Not seeded |
| Compliance/Audit | M | `compliance` exists only in the front end (`src/model.ts`, `src/data/rbac.ts`). The server has no read-only auditor role; the audit log is super-admin only (`routers/admin_console.py` `/audit`) |
| Payroll Admin | Pa | The server honours `payroll` (`services/payroll_runs.py` `PAYROLL_ROLES`, `tax_declarations.py`, `routers/team.py`), but `payroll` is not in the front-end `UserRole` (`src/model.ts`). Not seeded |
| (extra) executive | n/a | Present: `executive` org-wide aggregates (scope.py) |

## §28 Access model

| Item | Status | Evidence |
|---|---|---|
| Employee → own data | P | `Scope.employee_filter` (scope.py) |
| Manager → own + direct + authorised team | P | Recursive `report_ids`; saved scope `direct` / `line` |
| HR → assigned HR scope | P | `AccessScope.country_codes` plus saved scopes (`data_scope.py`, `routers/platform_admin.py` PUT data-scope) |
| HR Admin → global HR scope | P | `default_scope_name` returns "global" |
| Super Admin → platform scope | P | `SUPER_ADMIN_ROLES` (deliberate deviation: full HR data) |
| Recruiter → candidates | P | `services/recruiting.py` rules |

## §29-30 Permission model

| Item | Status | Evidence |
|---|---|---|
| RBAC (role permissions) | Pa | Checks are hard-coded role checks in each router. Page grants and revokes (`PageAccessOverride`, `routers/platform_admin.py`) are only used by the portal for navigation; the server does not enforce them generically (only the compensation grant, `services/compensation.py` `has_comp_flag`). There is no permission catalogue like "Approve Leave" |
| ABAC: Country | P | `AccessScope.country_codes`; saved scope `country` |
| ABAC: Legal Entity | P | Saved scope `entity` (`SCOPE_MATCH_COLUMNS`) |
| ABAC: Business Unit | P | Saved scope `business_unit` |
| ABAC: Department | P | Saved scope `department` |
| ABAC: Location | P | Saved scope `location` |
| ABAC: Manager relationship | P | `report_ids` / `manager_chain_ids` |
| ABAC: Employee type | M | No scope or rule on `employment_type` (data_scope.py `DATA_SCOPES`) |
| Scope: Own | P | `own` |
| Scope: Direct Reports | P | `direct` |
| Scope: Indirect Reports | P | `line` (recursive) |
| Scope: Department | P | `department` |
| Scope: Business Unit | P | `business_unit` |
| Scope: Legal Entity | P | `entity` |
| Scope: Country | P | `country` |
| Scope: Organization | Pa | No separate scope; `global` / executive `org_wide` (aggregates only) cover it |
| Scope: Global | P | `global` |
| Saved scope combined with role defaults | Pa | One saved scope per account (`AccountDataScope`), not a combination of several rules |
| Sensitive: Compensation | P | `PAY_ROLES`, `require_pay_view`, `log_pay_view` (`services/compensation.py`) |
| Sensitive: Confidential HR notes | P | `services/cases.py`; chat `RESTRICTED` (`routers/chat.py`) |
| Sensitive: Personal information | P | Masking plus audited reveal (`services/pii.py`) |
| Sensitive: Documents | P | HR / own checks in `routers/documents.py`; sensitive letters hidden until issued (`services/letters.py`) |
| Sensitive: Legal information | Pa | No separate "legal" class; covered only through cases and documents |
| Sensitive: Sensitive employee records | P | Cases, exits, pii |
| Field-level security | Pa | Server: pii masking and pay gating. Field depth per viewer is computed in the front end (`src/data/rbac.ts`); there is no generic server field policy |

## §31 Copilots (AI answers via OpenRouter: `backend/app/services/ai_copilot.py`, context `services/ai_context.py` + `ai_talent_context.py`; browser rule-based fallback `src/features/copilot/*`)

| Item | Status | Evidence |
|---|---|---|
| Employee: Leave | P | `_leave_block` |
| Employee: Policies | P | `policy_kb.search` (keyword) |
| Employee: Benefits | P | Own benefits block (`ai_talent_context.py`) |
| Employee: Learning | P | `learning_block` |
| Employee: Documents | Pa | "document" agent prompt plus browser letter drafts (`src/features/copilot/assist.ts`). The server context has no documents list |
| Employee: Profile | P | `_profile_block` (no contact or pay data) |
| Employee: Career | P | `career_block`, skills |
| Employee: HR requests | Pa | Approvals count only; no status of own tickets, cases, expenses or letters in the server context |
| Manager: Who is on leave | P | `_team_block` |
| Manager: Pending approvals | P | `_approvals_block` |
| Manager: Team performance | Pa | Team goals progress only; ratings are excluded on purpose (`ai_talent_context.py`) |
| Manager: Skills available | P | Team skills block (unverified depth) |
| Manager: Mandatory learning completed | P | `team_learning_block` |
| HR: Find employees matching criteria | M | No search tool in the copilot (context is counts only, `_org_block`) |
| HR: Workforce analysis | Pa | Server gives counts by country, department and type. Richer analysis is computed in the browser (`src/features/copilot/analytics.ts`) |
| HR: Employee information | Pa | "Summarise <name>" (`answers.ts` plus `/ai` employee summary in `routers/ai_drafts.py`). Not in the free-form `/ai/ask` |
| HR: Pending HR actions | Pa | Only items waiting on the asker; no HR work queue |
| HR: Organization insights | Pa | Counts only (server); browser facts in `src/data/workforceStats.ts` |
| HR: Policy questions | P | policy_kb |
| Recruiter: Resume analysis | P | Rule-based CV reader (`services/talent_ai.py` `read_cv`; `src/features/ai/CvReader.tsx`) |
| Recruiter: Candidate summaries | P | `compare_candidates`, `feedback_summary` (`routers/ai_drafts.py`, LLM with rule fallback) |
| Recruiter: JD generation | Pa | Template, rule-based, browser only (`src/features/ai/jobDescription.ts`, `JobDescriptionWriter.tsx`); no server/LLM |
| Recruiter: Candidate matching | P | `talent_ai.match_candidate` |
| Recruiter: Interview preparation | P | Suggested gap questions (`src/features/ai/CandidateMatchCard.tsx`; server match) |
| Executive: Global headcount | P | `_org_block` (executive in `ORG_ROLES`) |
| Executive: Country trends | Pa | Snapshot by country only; trends computed in the browser (analytics.ts) |
| Executive: Attrition | Pa | Browser analytics.ts only |
| Executive: Hiring | Pa | Browser analytics.ts only |
| Executive: Skills | Pa | Not in the executive server context (unverified in the browser) |
| Executive: Workforce trends | Pa | Browser only |

## §32-34 AI architecture and operating principle

| Item | Status | Evidence |
|---|---|---|
| Intent / context step | Pa | Context is built per user (`ai_context.build_context`). Intent is a regex deny (`_SENSITIVE`, `is_denied`); no intent classifier |
| AI orchestrator | M | No orchestrator. `ai_copilot.ask` does one LLM call with stuffed context |
| Employee / Manager / HR agents | Pa | `services/ai_agents.py`: 8 "agents" that add a focus line to the prompt, gated by role. Same context, no own tools |
| Knowledge / Analytics / Document agents | Pa | Same: prompt focus only |
| Tool layer → Authorization → Business APIs | M (server) | The server LLM has no tool calls and cannot act. Actions such as letter drafts and profile changes are prepared by browser rules (`src/features/copilot/assist.ts`); the person confirms and normal APIs are called |
| Authorization check / denied message | P | `is_denied` refuses before retrieval; context is scope-filtered |
| AI not given raw DB access | P | Context built by code; LLM gets text only |
| Audit of AI use | P | `record_audit` entity "Copilot question" (`ai_copilot.py`); drafts audited (`ai_drafts.py`); AI actions audited (`apiAuditAiAction`) |
| Understand→Recommend→Prepare→Human approval→Execute→Audit | Pa | Followed for letters and profile edits (browser-prepared, user-confirmed, OTP, approval). No server-side AI action pipeline |
| Rate limit / model fallback | P | `RATE_LIMIT`, `AI_MODEL_FALLBACKS` |

## §35 AI Employee 360

| Item | Status | Evidence |
|---|---|---|
| Employee 360 view | P | `src/pages/Employee360View.tsx` |
| AI contextual summary within permissions | P | `ai_drafts.employee_summary` (built from viewer-visible blocks; rule-based fallback) |
| Sections: Employment, Organization, Attendance, Leave, Timesheet, Goals, Performance (released ratings), Learning, Skills, Career, Benefits | P | `ai_talent_context.py`, `ai_drafts.py` |
| Section: Compensation | Pa | Excluded from the AI summary on purpose ("Never pay") |
| Section: Documents | Pa | Not in the AI summary blocks (unverified in the view) |

## §36 AI skills intelligence

| Item | Status | Evidence |
|---|---|---|
| Graph: Employee→Skills→Jobs→Career paths→Courses→Certifications | P | `services/career.py` (Skill, EmployeeSkill, CareerPath, JobProfile, Course, certifications per skill, `related_course_ids`) |
| Skill gaps | P | Career matches / analytics "Critical skill gaps" (`src/pages/PlatformModules.tsx`) |
| Critical skills | P | Same card |
| Emerging skills | M | No trend over time or emerging-skill logic |
| Available internal talent | Pa | Candidate/role matching and succession/job board exist, but `src/features/talentplus/jobBoardStore.ts` and `successionStore.ts` are browser stores (unverified sync) |
| Training requirements | P | Courses for gaps (`career.py`) |
| Career opportunities | P | `/career/matches` |
| Workforce risks | M | No skills-risk output |

## §37 AI career navigator

| Item | Status | Evidence |
|---|---|---|
| Pick target position | P | `CareerProfile.target_role_ids` (max 3), `routers/career.py` PUT `/career/me` |
| Inputs: current skills, learning, certifications | P | `career.py` |
| Inputs: experience, performance, goals | M | Matching uses skills only (no rating, goal or tenure references in `career.py`) |
| Outputs: current / required skills, skill gap, recommended courses | P | `career.py` matches; `src/pages/CareerPanels.tsx` |
| Recommended certifications | P | Skill library certifications (shown in CareerPanels) |
| Recommended projects | M | None |
| Suggested timeline | P | `career._timeline` (`WEEKS_PER_LEVEL`) |
| "AI" | Pa | Deterministic rules, no model (career.py docstring); the career agent can discuss it via LLM |

## §38 AI HR service automation

| Item | Status | Evidence |
|---|---|---|
| Address change: understand, required info, verify identity, prepare, confirm, submit via API, record | Pa | Done by browser rules (`src/features/copilot/assist.ts`: prepared change, OTP, `PATCH /people/me` in `routers/profile.py`, `apiAuditAiAction`). Intent detection is regex, not AI. Whether it triggers a workflow is unverified |

## §39 AI document assistant

| Item | Status | Evidence |
|---|---|---|
| Identify employee, validate authority, retrieve data, retrieve promotion info, template, populate, missing-field check, draft, approval, store | P | `backend/app/services/letters.py` (templates per type/country, missing-field check, "letter" approval workflow, PDF stored as document version). Copilot entry "Prepare a promotion letter for X" (`assist.ts`). Rule-based; no LLM wording |

## §40 AI/RAG knowledge architecture

| Item | Status | Evidence |
|---|---|---|
| Knowledge content: Handbook, HR policies, Leave, Benefits, Travel, Remote work, Code of conduct, Learning, HR procedures | P | `backend/seed/policies.json` (64 policies, per country for IN/US/GB/AU/CA/...) |
| Approved HR documents | M | Not indexed |
| HR-published policies (DB) in the KB | M | `policy_kb.load_policies` reads only the static JSON (`lru_cache`); policies HR publishes (`models/policies.py`, `routers/policies.py`) are not searched |
| Document processing / chunking | Pa | Sections are pre-split at export (`scripts/export-policies.mjs`); no ingestion pipeline for uploads |
| Embeddings | M | None (no embedding / pgvector code in backend) |
| Vector store | M | None |
| RAG layer / retrieval | Pa | Keyword + synonym scoring (`services/policy_kb.py` `search`), top hits injected into the prompt. This is retrieval-augmented, but rules, not semantic |
| Permission filter before retrieval | P | `applies_to` (country, role, contractor, legal entity) plus admin-disabled policies, before search |
| Sources shown with answer | P | `Source` with version/effective/section; `src/features/copilot/CopilotSources.tsx` |

## §41 AI context model

| Item | Status | Evidence |
|---|---|---|
| Employee ID, Role, Country, Department, Location, Job, Manager, Employment type | P | `_profile_block` |
| Legal entity | Pa | Used for policy filtering, not in the context text |
| Business unit | M | Not in context |
| Language | Pa | "Reply in the same language as the question"; the person's `preferred_language` is not used |
| Timezone | Pa | Dates use `local_today(me)`; the timezone is not stated in the context |
| Permissions | P | Scope-filtered blocks |

## §42 Natural-language HR analytics

| Item | Status | Evidence |
|---|---|---|
| Example questions (headcount by country, attrition by dept, joined this quarter, mandatory training not done, overtime by location) | Pa | All handled by rule-based parsing in the browser (`src/features/copilot/analytics.ts`) over portal stores. Not on the server |
| Controlled query + validation | Pa | Fixed templates (safe by construction); no generated or validated queries; computed client-side |
| Returns table / chart / summary / filters | P | `analytics.ts` answer with `table`, `chart`, `filters` |

## §43 Analytics dashboards (`/analytics`, `AnalyticsPage` in `src/pages/PlatformModules.tsx`, `src/pages/dashboards/HrInsightCards.tsx`). All computed in the browser from synced stores

| Item | Status | Evidence |
|---|---|---|
| Workforce: headcount, new hires, exits, attrition | P | MetricGrid in AnalyticsPage |
| Country / department distribution | P | Cards "Country distribution", "Department distribution" |
| Recruiting: open requisitions, pipeline | P | "Requisitions", "Recruitment pipeline" |
| Recruiting: applications | Pa | Pipeline counts by stage; no applications volume trend (unverified) |
| Time to hire, offer status | P | `HrInsightCards.tsx` "Time to hire", "Offer acceptance" |
| Onboarding: new joiners, checklist completion, pending | P | `OnboardingAnalyticsPanel` (`src/features/onboarding/OnboardingAnalytics.tsx`, contents unverified) |
| Attendance, absence, overtime | P | "Attendance · weekly", absent days, "Overtime by department" |
| Attendance exceptions | Pa | Late arrivals (`HrInsightCards.tsx`); no exceptions dashboard |
| Leave utilization | Pa | Approved leave days by period only; no utilisation % vs entitlement |
| Leave trends | P | "Leave days · approved" |
| Leave country comparison | Pa | Country filter only; no side-by-side comparison |
| Performance: review completion | P | "Performance · cycle" |
| Performance: goal completion | M | No goal-completion analytic found |
| Performance distribution | Pa | "Rated" % only; distribution unverified |
| Learning: training completion, certifications, mandatory | P | "Learning & certifications" |
| Skills: availability, gaps, critical | P | "Skill coverage", "Critical skill gaps" |
| Compensation: review status | P | Comp tab (submitted, pending, awaiting, avg increase) |
| Compensation distribution, grade analysis | M | No pay distribution, compa-ratio or grade-band analysis |
| Server-side analytics API | Pa | Dashboards compute in the browser; server only has `services/headcount.py` / `admin_console` overview |

## §44 Global workforce intelligence

| Item | Status | Evidence |
|---|---|---|
| Risk: high attrition, critical skill gaps, low learning completion, high overtime | Pa | Separate cards exist; no combined risk view |
| Risk: hiring pressure | M | — |
| Capacity: headcount, open positions, skills | P | Analytics cards |
| Capacity: project allocation, utilization | Pa | Projects (`src/pages/ProjectsPage.tsx`) and timesheet utilisation (`TimesheetPage.tsx`) exist, not in analytics |
| Org: growth, department size, location trends | P | Joiners trend, distributions |
| Org: management span | Pa | Text fact only (`src/data/workforceStats.ts`) |
| Org: workforce movement | M | No analytics of transfers or promotions (lifecycle data exists in `services/lifecycle.py`, `org_history.py`) |

## §45-46 Country architecture and localization

| Item | Status | Evidence |
|---|---|---|
| Multi-country in one app | P | `Country` table; seeded IN, US, GB, AU, CA, AE, SA, DE (`backend/seed/countries.json`; thresholds in `workflow_defaults.py`) |
| Country, Currency, Time zone, Language | P | `models/people.py` Country (currency, time_zone, languages) |
| Legal entity | Pa | Only a string on Employee/assignment; no LegalEntity config table per country |
| Holiday calendar | P | `Holiday`, `OptionalHoliday` per country/calendar (`models/leave.py`) |
| Leave policy | P | `LeavePolicy` per country, effective-dated |
| Employment information | P | probation_months, notice_days on Country |
| Documents | P | `required_documents`; letter templates per country (`models/documents.py`) |
| Working time | P | `work_week_days`, `standard_daily_hours` |
| Benefits | P | `BenefitPlan.country_code` |
| Compensation configuration | P | `GradeBand` per grade+country; cycle countries |
| Workflow rules | Pa | `workflow_notes` is free text; real rules via step `condition` country (`approvals.py`). No per-country workflow definitions |
| Admin UI for country profile | P | `routers/leave_admin.py` (workflow_notes etc.), `src/pages/LocalePages.tsx` |

## §47 Timezone

| Item | Status | Evidence |
|---|---|---|
| Timestamps stored in UTC | P | `UTCDateTime` (`backend/app/db.py`) |
| Display in user's timezone | P | `Employee.time_zone`, `local_today`; `src/locale/LocaleContext.tsx` `userTimeZone` |

## §48 Integration center (`routers/platform_admin.py` /integrations, `services/integrations.py`; the sync runs are SIMULATED: fake records, deterministic failures)

| Item | Status | Evidence |
|---|---|---|
| Identity/SSO | Pa | Connector row only (simulated); no OIDC/SAML login (no oidc/saml code) |
| Email | Pa | Outbox queue (`EmailOutboxItem`, `/admin/email-outbox`, manual mark-sent). No SMTP/provider sending |
| Microsoft Teams | Pa | Simulated connector |
| Slack | Pa | Simulated connector |
| Attendance systems | Pa | Simulated connector |
| Job portals | M | No connector (public careers page only) |
| Learning platforms | Pa | Simulated connector |
| Benefits providers | Pa | Simulated connector |
| Finance systems | M | No connector |
| External payroll providers | Pa | Simulated connector; payroll router uses the connector id (`routers/payroll.py`) |
| Method: REST API | Pa | The app's own REST API (docs admin-only, `docs_auth.py`); no partner API keys |
| Method: Webhooks | M | None |
| Method: Scheduled | Pa | Per-connector schedule plus `next_run_at`; `run_due_syncs` runs only on `POST /admin/jobs/run` (`platform_admin.py:425`), no scheduler |
| Method: File-based | Pa | Bulk import/mass update is browser localStorage (`src/features/datatools/bulkStore.ts`) |
| Method: Event-based | M | None |
| Monitoring: status, last execution, next execution, records processed, success, error counts | P | `IntegrationConnector` fields, `next_run_at` |
| Monitoring: retry, logs, error details, audit history | P | Quarantine retry/fix/dismiss, `IntegrationRun`, `IntegrationQuarantine.reason`, `record_audit` |
