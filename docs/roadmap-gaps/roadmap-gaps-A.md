# Roadmap gap check, part A (design doc sections 1-24)

Read-only check of the TimeZ HRMS repo (`C:\Users\Gayathri\OneDrive\Desktop\hrmsspare`, branch fix/module-audit, uncommitted state as found) against the product design document, lines 1-830.

Rules used:
- **Present**: UI + API + table, working in backend mode (VITE_API_URL set).
- **Partial**: something is missing (UI only, browser-only in backend mode, no API, missing field, rule-based only where the doc asks for more). The reason is given.
- **Missing**: nothing found.
- "Rule-based" means the AI-labelled feature works from rules, not an LLM. It still counts as Present when it does the job end to end. The general Copilot (`POST /ai/ask`, backend/app/routers/ai.py:20) is an LLM with role-scoped context.

Paths are relative to the repo root. `BE` = backend/app.

## §1-4 Vision, use case, objectives (only the concrete items)

| # | Item | Status | Evidence / gap |
|---|------|--------|----------------|
| 1 | Multi-country, single app, 8 countries (IN, US, GB, AU, CA, AE, SA, DE) | Present | `BE/models/people.py` Country table; seed `BE/seed_hcm.py` |
| 2 | Employee / manager / HR self-service | Present | role homes `src/pages/dashboards/RoleHomes.tsx`; approvals `BE/routers/approvals.py` |
| 3 | Localization: currency | Present | `countries.currency`, `employees.currency` (`BE/models/people.py:18,62`) |
| 4 | Localization: time zone | Present | `countries.time_zone`, `employees.time_zone`; attendance in local zone (`BE/services/attendance.py:50`) |
| 5 | Localization: language | Partial | `countries.languages` stored, but the UI has only about 20 translated keys (`src/locale/i18n.ts`). The app is effectively English only. |
| 6 | Localization: holiday calendar | Present | `holidays` table + `/leave-admin/holidays` (`BE/routers/leave_admin.py:216-298`) |
| 7 | Localization: leave policies | Present | `leave_policies` per country (`BE/models/leave.py:25`) |
| 8 | Localization: employment info / working time | Present | `countries.work_week_days`, `standard_daily_hours`, `probation_months`, `notice_days` (`BE/models/people.py:21-25`) |
| 9 | Localization: documents | Present | `countries.required_documents`; `/documents/country` page (`src/App.tsx:173`) |
| 10 | Localization: benefits | Present | `benefit_plans.country_code` (`BE/models/benefits.py:20`) |
| 11 | Localization: compensation config | Present | `grade_bands` per country (`BE/models/compensation.py:17`) |
| 12 | Integration ready (APIs, files, events, webhooks) | Partial | REST API and connector/run/quarantine tables exist (`BE/models/platform.py:59-105`). No outbound webhook or event-bus table was found. Detailed check belongs to part B. |
| 13 | Common TimeZ 500-employee dataset | Present | `BE/seed_hcm.py` (exact per-country counts not checked) |

## §5 Main navigation

| # | Item | Status | Evidence / gap |
|---|------|--------|----------------|
| 14 | Home | Present | `src/nav.ts` pinned "/"; `src/App.tsx:145` |
| 15 | My Profile | Present | `/info` (`src/App.tsx:146`) |
| 16 | People | Present | `/directory` "Directory" (`src/nav.ts`) |
| 17 | Organization | Present | `/organization` |
| 18 | Jobs & Positions | Present | `/jobs` |
| 19 | Recruiting | Present | `/recruiting` |
| 20 | Onboarding | Present | `/onboarding` |
| 21 | Time & Attendance | Present | `/attendance` |
| 22 | Leave & Absence | Present | `/leave` (labelled "Leave & holidays") |
| 23 | Timesheet | Present | `/timesheet` |
| 24 | Performance | Present | `/evaluations` |
| 25 | Learning | Present | `/programs` |
| 26 | Skills & Career | Present | `/skills` |
| 27 | Compensation | Present | `/compensation` |
| 28 | Benefits | Present | `/benefits` |
| 29 | Documents & Letters | Present | `/documents` |
| 30 | Workflows & Approvals | Present | `/workflows`, `/approvals` |
| 31 | Analytics | Present | `/analytics` |
| 32 | AI Copilot | Present | `/ai/copilot` plus the floating popup (`src/components/CopilotPopup.tsx`, mounted in `Shell.tsx:711`) |
| 33 | AI Agents | Present | `/ai/agents`; `GET /ai/agents` (`BE/routers/ai.py:49`) |
| 34 | Integration Center | Present | `/integrations` |
| 35 | Payroll (placeholder) | Present | `/payroll`; goes beyond a placeholder (`payroll_runs` tables) |
| 36 | Administration | Present | `/admin` "Console" |

Note: the sidebar groups do not follow the doc's flat order. Time & Attendance, Leave, Timesheet, Benefits and Documents sit under "Time & pay"; Performance, Learning and Skills sit under "Performance & learning". This is a labelling difference only.

## §6 Functional map

Every module in the map has a route and a router: Employee, Organization, Jobs, Attendance, Leave, Timesheet, Recruiting, Onboarding, Performance, Learning, Skills & Career, Compensation, Benefits, Documents, Workflows, Analytics and AI. **Present.** Details are in the sections below.

## §7 Home dashboard (role-based)

`RoleHomeRouter` is at `src/pages/dashboards/RoleHomes.tsx:2323`.

| # | Item | Status | Evidence / gap |
|---|------|--------|----------------|
| 37 | Role-based home: Employee | Present | `EmployeeHome` :357 |
| 38 | Manager | Present | `ManagerHome` :942 |
| 39 | HR user | Present | `HrAdminHome` :1261 |
| 40 | Recruiter | Present | `RecruiterHome` :1694 |
| 41 | HRBP | Present | `HrAdminHome hrbp` |
| 42 | Administrator | Present | `AdministrationHome` :1954 |
| 43 | Executive | Present | `ExecutiveHome` :1795 |
| 44 | Other authorized role | Partial | finance, learning_admin and performance_admin fall to `EmployeeHome` (`default:` branch :2340). They get no home of their own. |
| 45 | Emp: My Profile | Present | card :596 |
| 46 | Emp: Today's Attendance | Present | card :625 |
| 47 | Emp: Leave Balance | Present | card :671 |
| 48 | Emp: Upcoming Holidays | Present | :683 |
| 49 | Emp: Pending Requests | Present | :708 |
| 50 | Emp: Timesheet | Present | :750 |
| 51 | Emp: Goals | Present | :778 |
| 52 | Emp: Learning | Present | :796 |
| 53 | Emp: Documents | Present | :821 |
| 54 | Emp: Notifications | Present | :840 |
| 55 | Emp: AI Assistant | Present | The floating Copilot popup is on every page (`CopilotPopup.tsx`, `POST /ai/ask`). There is also a rule-based "Today's summary" card (`src/features/copilot/homeSummary.tsx`). |
| 56 | Mgr: Team Headcount | Present | MetricCard :1246 |
| 57 | Mgr: Team Attendance | Present | `TeamTodayCard`, data from `GET /team/today` (`src/api/syncTeam.ts:29`) |
| 58 | Mgr: Pending Approvals | Present | `MyApprovalsCard` |
| 59 | Mgr: Leave Requests | Present | :1070 |
| 60 | Mgr: Timesheet Approvals | Present | :1088 |
| 61 | Mgr: Goal Progress | Present | :1101 |
| 62 | Mgr: Performance Activities | Present | :1126 |
| 63 | Mgr: Team Skills | Present | :1147 |
| 64 | Mgr: New Joiners | Present | :1165 |
| 65 | Mgr: Open Positions | Present | :1182 |
| 66 | Mgr: Team Alerts | Present | :1051 |
| 67 | HR: Global Headcount | Present | MetricCard :1682 |
| 68 | HR: Country Headcount | Present | :1427 |
| 69 | HR: New Joiners | Present | :1452 |
| 70 | HR: Exits | Present | :1472 |
| 71 | HR: Open Positions | Present | :1490 |
| 72 | HR: Recruitment Pipeline | Present | :1503 |
| 73 | HR: Pending HR Actions | Present | :1404 |
| 74 | HR: Leave Trends | Present | :1517; data from `GET /leave/requests?view=all` (`src/api/portalSync.ts:193`, capped at 500 rows) |
| 75 | HR: Attendance Trends | Partial | The card (:1557) uses `attendanceTrend()` over `getAttendanceState()`. In backend mode that holds only the signed-in user's own sessions (`src/api/syncAttendance.ts:148`, `src/data/attendanceLocal.ts:85`). There is no company-wide attendance API, so the org trend is wrong in production. |
| 76 | HR: Performance Cycle Status | Present | :1591 |
| 77 | HR: Learning Completion | Present | :1605 |
| 78 | HR: Workforce Insights | Present | :1616 |

## §8 My Profile (fields)

Model: `BE/models/people.py` `Employee`. UI: `src/pages/Employee360View.tsx` (personal tab :640-760, employment :810-842, org :859-865, job :935-942), embedded in `src/pages/PersonProfilePage.tsx`. API mapping: `src/api/portalSync.ts:55-110`.

| # | Field | Status | Evidence / gap |
|---|-------|--------|----------------|
| 79 | Employee ID | Present | `employee_code`; 360 :659 |
| 80 | First Name | Present | `first_name`; :661 |
| 81 | Middle Name | Present | `middle_name`; :662 |
| 82 | Last Name | Present | `last_name`; :663 |
| 83 | Preferred Name | Present | `preferred_name`; :664 |
| 84 | Date of Birth | Present | `date_of_birth` (masked); :666 |
| 85 | Gender | Present | `gender`; :682 |
| 86 | Nationality | Present | `nationality`; :683 |
| 87 | Personal Email | Present | `personal_email`; :691 |
| 88 | Work Email | Present | `email`; :689 |
| 89 | Phone Number | Present | `mobile`; :702 |
| 90 | Address | Present | `address_line/city/postcode/country`; :712 |
| 91 | Emergency Contact | Present | `emergency_name/relationship/phone`; :723-726 |
| 92 | Joining Date | Present | `joining_date`; :816 |
| 93 | Employment Status | Present | `employment_status`; :812 |
| 94 | Employment Type | Present | `employment_type`; :815 |
| 95 | Country | Present | `country_code`; :865 |
| 96 | Legal Entity | Present | `legal_entity`; :859 |
| 97 | Business Unit | Present | `business_unit`; :860 |
| 98 | Division | Present | `division`; :861 |
| 99 | Department | Present | `department`; :862 |
| 100 | Cost Center | Present | `cost_centre`; :863 |
| 101 | Location | Present | `location`; :864 |
| 102 | Manager | Present | `manager_id`; :828 |
| 103 | Job | Present | `job_title`; :935 |
| 104 | Job Profile | Partial | `employees` has no `job_profile_id`; it exists only on `employee_assignments` (`people.py:120`). Backend mode hard-codes `jobProfileId: ""` (`src/api/portalSync.ts:66`), so the 360 "Job profile" row (:938) is always blank in production. |
| 105 | Job Family | Present | `job_family`; :937 |
| 106 | Position | Present | `position_id`; :939 |
| 107 | Grade | Present | `grade`; :936 |
| 108 | Work Location | Present | `location` + country; :716/:830 |
| 109 | Work Arrangement | Present | `work_arrangement` (Office/Hybrid/Remote); :829 |
| 110 | Skills | Present | `employee_skills` table, `PUT /learning/skills/me` (`BE/routers/learning.py:273`) |
| 111 | Certifications | Present | `certifications` table, `/learning/certifications`; profile card `PersonProfilePage.tsx:684` |
| 112 | Education | Present | `employees.education` JSON; editor `ProfileDetailsCards.tsx:696` |
| 113 | Experience | Present | `employees.experience` JSON; editor `ProfileDetailsCards.tsx:720` |
| 114 | Dependents | Partial | The `benefit_dependents` table and `/benefits/dependents` API exist. The profile "Dependents" section (360 :772) reads `person.dependents`, which backend mode always sets to `[]` (`portalSync.ts:93`), so it shows "None recorded". Dependents do show under Benefits coverage (360 :343). |
| 115 | Documents | Present | `employee_documents` + `/documents`; 360 "Documents" tab :433 |
| 116 | Employment History | Present | `employee_assignments`; `GET /people/{id}/history` (`BE/routers/lifecycle.py:205`, `src/api/syncOpsLifecycle.ts:297`); 360 "Lifecycle history" tab |
| 117 | Compensation History | Present | `compensation_records`; 360 comp tab `reward.history` (:338) |
| 118 | Performance History | Present | `perf_reviews`; 360 Performance tab |
| 119 | Learning History | Present | `enrollments`/`certifications`; 360 Learning tab |

## §9-10 People, Employee 360, AI Employee 360

Directory: `src/pages/PeopleModule.tsx:469`. It filters client-side over the API-loaded list. Server filters are `q`/department/country/location/status (`BE/routers/people.py:49-80`).

| # | Item | Status | Evidence / gap |
|---|------|--------|----------------|
| 120 | Search by Employee ID | Present | `q` matches employee_code (people.py:71) |
| 121 | Name | Present | people.py:69 |
| 122 | Email | Present | people.py:70 |
| 123 | Country | Present | `country` param + UI |
| 124 | Legal Entity | Present | UI filter PeopleModule.tsx:99 (client-side) |
| 125 | Department | Present | server + UI |
| 126 | Business Unit | Present | UI :106 (client-side, HR only) |
| 127 | Manager | Present | UI :100 (client-side) |
| 128 | Job | Present | `q` job_title + UI `job` filter |
| 129 | Position | Present | UI :108 (client-side) |
| 130 | Grade | Present | UI :107 (client-side) |
| 131 | Location | Present | server + UI |
| 132 | Employment Status | Present | server + UI |
| 133 | Employee 360 page | Present | `src/pages/Employee360View.tsx`, routes `/people/:id`, `/directory/:id` |
| 134 | 360: Personal information | Present | tab "personal" :414 |
| 135 | 360: Employment | Present | :415 |
| 136 | 360: Organization | Present | :416 |
| 137 | 360: Manager | Present | :417 |
| 138 | 360: Job | Present | :418 (see Job Profile gap, #104) |
| 139 | 360: Attendance | Present | :421; `/attendance/summary?employee_id=` |
| 140 | 360: Leave | Present | :422 |
| 141 | 360: Timesheet | Present | :423 |
| 142 | 360: Goals | Present | :424 |
| 143 | 360: Performance | Present | :425 |
| 144 | 360: Learning | Present | :426 |
| 145 | 360: Skills | Present | :427 |
| 146 | 360: Career | Present | :428 |
| 147 | 360: Compensation | Present | :431, permission-gated. Note: "Monthly gross" (:1157-1160) comes from static `payRulesFor(country)` in the front end, not the employee's `compensation_records`. |
| 148 | 360: Benefits | Present | :432 |
| 149 | 360: Documents | Present | :433 |
| 150 | 360: Lifecycle history | Present | :434 |
| 151 | AI Employee 360 summary, permission-aware | Present | `POST /ai/employee-summary` (`BE/routers/ai_drafts.py:34`, `BE/services/ai_drafts.py:66-101` scoped facts); UI `src/api/syncCareer.ts:194` |
| 152 | Free-form questions about an employee | Present | Copilot `/ai/ask` with scoped context (`BE/services/ai_context.py`) |

## §11 Organization management

| # | Item | Status | Evidence / gap |
|---|------|--------|----------------|
| 153 | Company → Country → Legal Entity → BU → Division → Department → Cost Center → Location hierarchy | Present | `ORG_UNIT_TYPES` (`BE/models/org.py:11`), `/org/units` CRUD (`BE/routers/org.py:138-243`) |
| 154 | Job Family → Job Profile → Position → Grade | Present | `job_families`, `job_profiles`, `positions` (org.py:32-83); grade on profile/position plus `grade_bands` |
| 155 | Supervisory Organization | Present | `supervisory_org` unit type (org.py:11) |
| 156 | Effective-dated org changes | Present | `effective_from/to` + `org_change_history` (org.py:86); `/units/{id}/history` |
| 157 | Department change | Present | lifecycle `transfer` (`BE/services/lifecycle.py:51`) |
| 158 | Manager change | Present | lifecycle `manager_change` |
| 159 | Business unit transfer | Present | `transfer` covers business_unit |
| 160 | Legal entity transfer | Present | `transfer` covers legal_entity |
| 161 | Location change | Present | `location_change` |
| 162 | Promotion | Present | `promotion` |
| 163 | Reorganization | Partial | Unit moves and renames are versioned in `org_change_history`. There is no reorganization transaction that moves a group of people at once; people move one transfer at a time or through bulk data. "Reorganization" exists only as a front-end history label (`src/data/lifecycleHistory.ts:169`). |
| 164 | Historical tracking of all changes | Present | `employee_assignments` (closed and reopened per action, lifecycle.py:129) + `audit_log` |

## §12 Jobs & positions

| # | Item | Status | Evidence / gap |
|---|------|--------|----------------|
| 165 | Job families (Engineering, Finance, HR, Sales, Marketing, Ops, IT, Support) | Present | CRUD `/org/job-families`; seeded from employee data (`BE/services/org.py:6,150`). Whether every example family exists in the seed is unverified. |
| 166 | Job profile: Job Family | Present | `family_id` |
| 167 | Job Level | Present | `job_level` |
| 168 | Job Description | Present | `description` |
| 169 | Required Skills | Present | `required_skills` |
| 170 | Preferred Skills | Present | `preferred_skills` |
| 171 | Experience | Present | `experience_min_years/max_years` |
| 172 | Education | Present | `education` |
| 173 | Responsibilities | Present | `responsibilities` |
| 174 | Position: code, job, dept, location, country, grade, manager, status | Present | `positions` (org.py:64-83); `/org/positions` |
| 175 | AI: Job description creation | Present (rule-based) | `src/features/ai/JobDescriptionWriter.tsx` + `jobDescription.ts:112`, drafted in the browser and saved via the job-profile API. No LLM. |
| 176 | AI: Required skill identification | Present (rule-based) | `needs_for_role` (`BE/services/talent_ai.py:331`); front-end draft required list (`jobDescription.ts:133`) |
| 177 | AI: Skill recommendations | Present (rule-based) | preferred/required suggestions in the JD writer from the skills library |
| 178 | AI: Job-to-skill mapping | Present | `job_profiles.required_skills`, `skills.related_profile_ids` (`BE/models/career.py`) |
| 179 | AI: Position analysis | Missing | No position analysis (vacancy, cost or fill-risk insight) was found in the API or UI. |
| 180 | AI: Internal candidate matching | Partial | Employee-side only: `GET /career/matches` ranks roles for a person (`BE/routers/career.py:222`), and internal applicants are scored by `match_candidate`. There is no "find internal people for this position" ranking. Succession (`src/features/talentplus/successionStore.ts`) is a browser-local store with no skill matching. |

## §13 Recruiting

| # | Item | Status | Evidence / gap |
|---|------|--------|----------------|
| 181 | Job requisitions | Present | `requisitions`; `/recruiting/requisitions` |
| 182 | Requisition approval | Present | `POST /requisitions/{id}/decision` (recruiting.py:238) |
| 183 | Job posting | Present | `job_postings`; `/requisitions/{id}/posting`; public `/careers` (`BE/routers/careers.py`) |
| 184 | Candidates | Present | `candidates`; `/recruiting/candidates` |
| 185 | Applications | Present | public apply (careers.py:83) + internal apply (recruiting.py:362) |
| 186 | Resume | Present | `PUT/GET /candidates/{id}/cv` |
| 187 | Screening | Present | `POST /candidates/{id}/screen` |
| 188 | Interviews | Present | `interviews`; `/candidates/{id}/interviews` |
| 189 | Interview feedback | Present | `/interviews/{id}/feedback`, scorecard ratings (`models/recruiting.py:118`) |
| 190 | Candidate communication | Partial | No messages or emails to external candidates. The email outbox only covers notifications to employees (`BE/services/email_outbox.py`). The UI has a `mailto:` link only (`CandidatePipeline.tsx:344`). The offer link (response token) is the only candidate-facing channel. |
| 191 | Offers | Present | `offers`; create, submit, approve, status; public offer answer page (careers.py:152) |
| 192 | Hiring | Present | accepted offer → Hired → Employee + Joiner created (`BE/services/onboarding.py:150-186`) |
| 193 | Recruitment analytics | Present | Recruiting "Analytics" tab (`TalentModules.tsx:499`); HR home time-to-hire and offer-acceptance cards |
| 194 | Pipeline stages Applied → Screening → Shortlisted → Interview → Assessment → Final Review → Offer → Hired | Present | `PIPELINE_STAGES` (`BE/services/recruiting.py:27`) + `candidate_stages` history |
| 195 | AI: Resume parsing | Present (rule-based) | `POST /recruiting/cv/parse` → `read_cv` (`talent_ai.py:215`) |
| 196 | AI: Resume summarization | Partial | `read_cv` extracts fields (name, contacts, years, role, education, skills) but writes no narrative summary. |
| 197 | AI: Skill extraction | Present | `read_cv` library_skills/other_skills |
| 198 | AI: Candidate-job matching | Present | `GET /candidates/{id}/match` (recruiting.py:637) |
| 199 | AI: Candidate comparison | Present | `ai_drafts.compare_candidates` (`BE/routers/ai_drafts.py:56`) |
| 200 | AI: Interview question preparation | Present (rule-based) | `match_candidate` questions (`talent_ai.py:383`); UI `CandidateMatchCard.tsx:63` |
| 201 | AI: Job description generation | Present (rule-based) | JD writer (see #175) |
| 202 | AI: Interview feedback summarization | Present | `POST /recruiting/candidates/{id}/feedback-summary` (ai_drafts.py:83); UI `CandidatePipeline.tsx:1041` |
| 203 | Human final decision | Present | AI is draft-only (`BE/services/ai_drafts.py:29`) |

## §14 Onboarding

| # | Item | Status | Evidence / gap |
|---|------|--------|----------------|
| 204 | Pre-boarding: employee info collection | Present | `PUT /onboarding/joiners/{id}/preboarding` (onboarding.py:123); `PreboardingPersonalIn` (`BE/schemas/onboarding_payroll.py:13`) |
| 205 | Pre-boarding: document submission | Partial | Only an HR-owned "HR documentation" task and a `docsStatus` label (`TalentModules.tsx:1312`). The joiner cannot upload documents in the onboarding flow; general uploads are under /documents. |
| 206 | Pre-boarding: policy acknowledgement | Present | `POST /joiners/{id}/acknowledge`; `joiners.policy_ack*` |
| 207 | Pre-boarding: personal information | Present | preboarding.personal |
| 208 | Pre-boarding: emergency contacts | Present | `PreboardingEmergencyIn` |
| 209 | Pre-boarding: equipment requirements | Present | `equipment` list → equipment tasks (`BE/services/onboarding.py:329`) |
| 210 | Pre-boarding: IT provisioning request | Present | `it_request` → task (onboarding.py:334) |
| 211 | Checklist: HR Documentation | Present | default task `hr_docs` (`BE/services/onboarding.py:43`) |
| 212 | IT Account Creation | Present | `it_account` |
| 213 | Laptop Assignment | Present | `laptop` |
| 214 | Access Provisioning | Present | `access` |
| 215 | Manager Introduction | Present | `manager_intro` |
| 216 | Orientation | Present | `orientation` |
| 217 | Policy Training | Present | `policy_training` |
| 218 | Mandatory Learning | Present | `mandatory_learning` |
| 219 | Team Introduction | Present | `team_intro` |
| 220 | First Week Review | Present | `first_week_review` |
| 221 | Checklist varies by country, legal entity, employee type | Present | `onboarding_template_tasks` country/legal_entity/employment_type (`BE/models/onboarding.py:22-24`); overrides at onboarding.py:55-64 |
| 222 | AI Onboarding Assistant ("what do I need before my joining date?") | Missing | The Copilot context has no joiner checklist; `BE/services/ai_context.py` mentions joiners only to exclude them from headcount. The front-end rule answer only links to /onboarding (`src/features/copilot/answers.ts:1006`). Job and location are not used to pick checklists. |

## §15 Employee lifecycle

| # | Item | Status | Evidence / gap |
|---|------|--------|----------------|
| 223 | Candidate → Selected → Offer | Present | pipeline stages + offers |
| 224 | Pre-boarding → Onboarding → Active | Present | Joiner + `employment_status="Onboarding"` → active on completion (`BE/services/onboarding.py:150,270`) |
| 225 | Promotion | Present | `promotion` action (`BE/services/lifecycle.py:53`) |
| 226 | Transfer | Present | `transfer` |
| 227 | Manager change | Present | `manager_change` |
| 228 | Job change | Present | `job_change` |
| 229 | Location change | Present | `location_change` |
| 230 | Leave of absence | Present | `leave_of_absence` / `return_from_leave` |
| 231 | Rehire | Present | `rehire` (reopens account, lifecycle.py:148) |
| 232 | Separation → Exit | Present | `exit_cases` + `/exits` routes; `last_working_day` |
| 233 | Auditable history record per event | Present | `record_audit` + `employee_assignments` (lifecycle.py:24,129) |

## §16 Time & attendance

| # | Item | Status | Evidence / gap |
|---|------|--------|----------------|
| 234 | Check-in | Present | `POST /attendance/check-in` |
| 235 | Check-out | Present | `POST /attendance/check-out`; auto check-out at 9 worked hours (`BE/services/attendance.py` `close_overdue`, :193) |
| 236 | Working hours | Present | `worked_minutes`, breaks, `/attendance/summary` |
| 237 | Shifts | Present | `shift_types`, `roster_shifts`, swaps (`BE/routers/shifts.py`) |
| 238 | Overtime | Present | summary overtime + `overtime_requests` (`BE/routers/overtime.py`) |
| 239 | Late arrival | Present | `is_late/late_minutes` |
| 240 | Early departure | Present | `is_early_leave/early_minutes` |
| 241 | Attendance correction | Present | `attendance_corrections` + decision endpoint |
| 242 | Remote work | Present | `work_mode` office/wfh/remote |
| 243 | Hybrid work | Present | `employees.work_arrangement` = Hybrid with a per-day `work_mode` |
| 244 | Holidays | Present | holidays table, `/leave/holidays` |
| 245 | Attendance calendar | Present | calendar in `src/pages/AttendanceModule.tsx` (:912) |
| 246 | Mgr: view team attendance | Present | `GET /team/today`; `/attendance?employee_id=` for reports |
| 247 | Mgr: review exceptions | Present | late/missing-punch/pending flags; Team alerts card |
| 248 | Mgr: approve corrections | Present | `POST /attendance/corrections/{id}/decision` |
| 249 | Mgr: attendance trends | Partial | No team or org attendance aggregate API. Trend charts read only the browser's own sessions in backend mode (see #75). |

## §17 Leave & absence

| # | Item | Status | Evidence / gap |
|---|------|--------|----------------|
| 250 | Leave types | Present | `leave_types`; `/leave-admin/types` |
| 251 | Leave balances | Present | `GET /leave/balances` |
| 252 | Leave request | Present | `POST /leave/requests` (+ attachment) |
| 253 | Leave approval | Present | `/requests/{id}/decision`; manager then HR chain |
| 254 | Leave cancellation | Present | `/requests/{id}/cancel` |
| 255 | Leave correction | Missing | There is no endpoint to amend an approved or pending request's dates or type (`BE/routers/leave.py`); only cancel and re-apply. |
| 256 | Accrual | Present | `leave_policies.accrual` annual/monthly (`BE/services/leave.py:86`) |
| 257 | Carry-forward | Present | `carry_forward_max`, `leave_carry_forwards`, `POST /leave-admin/carry-forward/run` |
| 258 | Eligibility | Present | gender, min service, employment types, probation (`BE/models/leave.py`) |
| 259 | Holiday calendar | Present | `/holidays` page + API |
| 260 | Leave history | Present | `/leave/requests?view=mine` |
| 261 | Country-specific policies | Present | `leave_policies.country_code` |
| 262 | Workflow: type → dates → reason → submit → manager → HR rules → approved | Present | approval chain `chain.LEAVE`; `needs_hr_approval` on type |
| 263 | AI Leave Assistant (balance, what can I apply for, country policy) | Present | `_leave_block` in `BE/services/ai_context.py:72` + policy KB per country (`BE/services/policy_kb.py`) |

## §18 Timesheet

| # | Item | Status | Evidence / gap |
|---|------|--------|----------------|
| 264 | Project tracking | Present | `projects`, `project_members` |
| 265 | Client tracking | Present | `projects.client` |
| 266 | Task tracking | Present | `timesheet_entries.task`, work_type/work_id |
| 267 | Billable hours | Present | `billable` |
| 268 | Non-billable hours | Present | `billable=false` |
| 269 | Utilization | Present | `GET /timesheets/utilization` |
| 270 | Resource management | Partial | Project members, roles and budget hours exist (`BE/models/timesheets.py`). There is no capacity or allocation planning view. |
| 271 | Manager approval | Present | `/weeks/{id}/decision`, `/days/{id}/decision` |
| 272 | Reporting | Present | utilization + report builder `/data-tools/reports` |
| 273 | Fields: Date, Project, Client, Task, Hours, Billable, Comments, Status | Present | `timesheet_entries` + week/day status |
| 274 | Workflow: enter → submit → review → approve/reject → finalized | Present | day/week submit + decision; reopen by manager; a day auto-closed by attendance can be submitted later (`BE/routers/timesheets.py:96 _auto_closed_day`) |
| 275 | Not linked to payroll | Present | no payroll consumption found (by design) |

## §19 Performance

| # | Item | Status | Evidence / gap |
|---|------|--------|----------------|
| 276 | Performance cycles | Present | `review_cycles`; `/performance/cycles` + advance |
| 277 | Goals | Present | `goals` type=goal |
| 278 | OKRs | Present | `goals.type` okr |
| 279 | KPIs | Present | `goals.type` kpi |
| 280 | Self assessment | Present | `PUT /reviews/{id}/self` |
| 281 | Manager assessment | Present | `PUT /reviews/{id}/manager` |
| 282 | 360 feedback | Present | `review_360_reviewers`, `/reviews/{id}/360` |
| 283 | Reviews | Present | `perf_reviews` |
| 284 | Ratings | Present | `/reviews/{id}/rating`, `/release` |
| 285 | Development plans | Present | `dev_actions` |
| 286 | Performance history | Present | reviews across cycles; 360 tab |
| 287 | Goal fields: target, period, weight, status | Partial | target, period and weight are stored (`BE/models/performance.py`). There is no status column; "In Progress" is only implied by `progress`. |
| 288 | AI: Goal drafting | Missing | No goal-draft feature in the performance UI or API; only free-form Copilot chat. |
| 289 | AI: Goal summarization | Partial | Copilot chat only, with goals in its context (`BE/services/ai_talent_context.py:47,60`); no in-page action. |
| 290 | AI: Review preparation | Partial | Copilot chat only (goals + ratings context); no draft button on self/manager assessment (`TalentModules.tsx:1844,1883`). |
| 291 | AI: Feedback summarization | Missing | Exists for interview feedback only. Nothing summarizes `perf_feedback` or 360 responses. |
| 292 | AI: Development suggestions | Partial | Career coach agent suggests courses for skill gaps (`BE/services/ai_agents.py:32`); not tied to review outcomes. |
| 293 | AI: Performance trend analysis | Partial | ratings in the Copilot context only; no trend view or analysis. |

## §20 Learning

| # | Item | Status | Evidence / gap |
|---|------|--------|----------------|
| 294 | Course catalog | Present | `courses`; `/learning/courses` |
| 295 | Training programs | Missing | No program or cohort entity beyond single courses. |
| 296 | Learning paths | Partial | Hard-coded front-end `LEARNING_PATHS` (`src/data/talentData.ts:1185`). There is no table or API; enrolling goes through the API course by course. |
| 297 | Course enrollment | Present | `enrollments`; `POST /learning/enrollments` |
| 298 | Training requests | Missing | No request or approval flow for training (only direct enrol or assignment). |
| 299 | Assessments | Partial | `enrollments.score` is recorded by HR only; there are no quizzes or tests. |
| 300 | Certifications | Present | `certifications`; expiring endpoint |
| 301 | Mandatory training | Present | `courses.mandatory` + due dates |
| 302 | Learning history | Present | enrollments/completed_on |
| 303 | Completion tracking | Present | progress, complete endpoint; Team completions tab |
| 304 | AI learning recommendations (job, skills, target career, gaps, goals, certs) | Present | `GET /career/matches` gaps → recommended courses; "Recommended courses" tab (`TalentModules.tsx:2556`); career coach agent. Performance goals and required certifications are not used as inputs (Partial on those two inputs). |

## §21 Skills & career

| # | Item | Status | Evidence / gap |
|---|------|--------|----------------|
| 305 | Skill name | Present | `skills.name` (`BE/models/career.py:18`) |
| 306 | Category | Present | `category` technical/behavioural |
| 307 | Skill level | Present | global 5-step scale `SKILL_LEVELS` (career.py:13) |
| 308 | Description | Present | `description` |
| 309 | Related jobs | Present | `related_profile_ids` |
| 310 | Related courses | Present | `related_course_ids` |
| 311 | Certification | Present | `certifications` list |
| 312 | Proficiency level | Present | `employee_skills.level` 1-5 |
| 313 | Employee: current skills | Present | `employee_skills` |
| 314 | Employee: proficiency | Present | `level` |
| 315 | Employee: certifications | Present | `certifications` |
| 316 | Employee: experience | Present | `years`, `last_used`, `evidence_url` |
| 317 | Employee: skills to develop | Present | `target_level` |
| 318 | Career: current role | Present | `career_profiles.current_role` |
| 319 | Career: target role | Present | `target_role_ids` |
| 320 | Career: career path | Present | `career_paths` |
| 321 | Career: required skills | Present | `career_paths.required_skills` |
| 322 | Career: skill gaps | Present | `/career/matches` gaps |
| 323 | Career: development activities | Present | `dev_actions` + course recommendations |
| 324 | Career: mentoring | Present | `career_profiles.mentor_id` |
| 325 | AI Career Navigator | Present | career agent (`ai_agents.py:32`) with `skills_block` and `career_block` (`BE/services/ai_talent_context.py`) |

## §22 Compensation

| # | Item | Status | Evidence / gap |
|---|------|--------|----------------|
| 326 | Base salary | Present | `compensation_records.base_salary` |
| 327 | Salary history | Present | `GET /compensation/records` |
| 328 | Compensation structures | Partial | Only annual base salary is stored. Pay components (allowances and similar) live in front-end static country rules (`src/countryPay.ts`); there is no structure table. |
| 329 | Grades | Present | grade on employee, record and proposal |
| 330 | Salary ranges | Present | `grade_bands` min/mid/max per country |
| 331 | Promotions | Present | proposals with `proposed_grade` + lifecycle promotion |
| 332 | Increment cycles | Present | `comp_review_cycles` |
| 333 | Bonuses | Present | `comp_bonuses` |
| 334 | Incentives | Present | `comp_bonuses.bonus_type` free text (no separate incentive plan model) |
| 335 | Compensation review | Present | proposals per cycle |
| 336 | Approval workflow | Present | `/proposals/{id}/decision`, withdraw |
| 337 | Security: self only; managers only when permitted | Present | `access_scopes.comp_access` gate (`BE/services/compensation.py:6,65`) |

## §23 Benefits

| # | Item | Status | Evidence / gap |
|---|------|--------|----------------|
| 338 | Benefit plans | Present | `benefit_plans`; `/benefits/plans` |
| 339 | Eligibility | Present | `eligibility` JSON + `/plans/{id}/eligibility` |
| 340 | Enrollment | Present | `benefit_enrollments` + decision, cancel, windows |
| 341 | Dependents | Present | `benefit_dependents` + verification |
| 342 | Benefit history | Present | `GET /benefits/history` |
| 343 | Benefit documents | Present | `benefit_plan_documents`, summary.pdf |
| 344 | Country-specific plans | Present | `country_code`, `legal_entity` |
| 345 | Health benefits | Present | plan_type Medical/Dental/Vision |
| 346 | Insurance | Present | Life (and Medical) |
| 347 | Retirement | Present | plan_type Retirement |
| 348 | Allowances | Partial | No "Allowance" plan type (`PLAN_TYPES`, `BE/services/benefits.py:27`); only "Other". |
| 349 | Wellness programs | Present | plan_type Wellness |

## §24 Documents & letters

Letter types are in `LETTER_TYPES` (`BE/services/letters.py:44-64`). Routes are `/letters/*` (`BE/routers/documents.py:453-708`).

| # | Item | Status | Evidence / gap |
|---|------|--------|----------------|
| 350 | Offer letter | Present | "Offer" type + `offers.letter` |
| 351 | Appointment letter | Present | "Appointment" |
| 352 | Employment certificate | Present | "Employment" |
| 353 | Experience letter | Present | "Experience" |
| 354 | Confirmation letter | Present | "Confirmation" |
| 355 | Promotion letter | Present | "Promotion" |
| 356 | Transfer letter | Present | "Transfer" |
| 357 | Salary revision letter | Present | "Salary revision" |
| 358 | Increment letter | Present | same type as salary revision (label "Increment letter") |
| 359 | Relieving letter | Present | "Relieving" |
| 360 | Warning letter | Present | "Warning" |
| 361 | NOC | Present | "NOC" |
| 362 | Visa/Travel letter | Present | "Visa/Travel" |
| 363 | Internship letter | Present | "Internship" |
| 364 | Contract | Partial | No contract letter template or type. Contracts can only be uploaded under the "Contracts" document category (`BE/services/documents.py:28,111`). |
| 365 | Termination letter | Present | "Termination" |
| 366 | Process: request → type → approved data → template → validation → approval → generate → store → employee access | Present | `/letters/requests`, templates, `draft-preview`, required-field check (`BASE_REQUIRED`, letters.py:92), `/decision`, `/issue`, `letter_issues`, `/download` |
| 367 | AI assists drafting; approval before issue | Present | `POST /letters/word-text` (`WORD_PROMPT`, letters.py:502); issue requires decision |
| 368 | Central employee document store | Present | `employee_documents` + versions + verification queue |

## Counts

- Present: 338 (7 of them rule-based AI, marked "Present (rule-based)")
- Partial: 23
- Missing: 7

Total: 368 items.
