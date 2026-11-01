# TimeZ HRMS Manual QA Report

**Audit date:** 2026-11-01
**Environment:** Local Vite frontend at `http://localhost:5174/`, isolated headless Chrome profile, local demo mode with API base URL blank.
**Scope:** Read-only application inspection plus UI interaction and safe dummy-data workflows in browser local storage. No application source was changed during the audit. No GitHub, Render, Neon, Backblaze, OpenRouter, email, or other production service was called by the tested browser session.

## Executive summary

All six demo profiles authenticated and rendered their dashboards. I expanded the sidebar groups and opened **339 accessible routes** across the six profiles; each route rendered a nonblank main area without a navigation failure. These visits are route/render smoke checks, not full interaction tests of every control on those pages.

The employee leave request-to-manager-approval workflow passed in local mode, including the updated status when the employee signed in again. Employee directory search, country/department filters, clear filters, list/grid, pagination, and profile opening were exercised. Learning enrollment and progress, performance goal add/edit/progress, skill add/edit/remove, AI assistant responses/privacy refusal, and document preview/cancel were also exercised successfully in the local browser.

**This is a partial audit, not a complete end-to-end sign-off.** Testing every control and all cross-role business workflows would require more time, a test date with an eligible workday, and connected staging/backend services. Backend/API access controls, external integrations, uploads/downloads, and many module-specific actions remain unverified. See the blocked list below.

## Environment and data safety

- The checked-in working tree contained pre-existing changes. No application files were edited as part of QA; only this report is added.
- The local browser was deliberately configured so the API base URL was blank. The transformed client bundle had no Render hostname. Tests used local demo data and browser local storage only.
- One temporary local leave request, one test course enrollment/progress update, and one temporary performance goal were created. The leave was approved through the local manager UI. A temporary skill was added, edited, and removed. These changes exist only in the isolated QA browser profile.
- No real employee names, email addresses, passwords, compensation amounts, or dummy record identifiers are included in this report.
- No screenshots were saved. Evidence was recorded as route results and UI state checks through the local browser session.

## Profile coverage

| Profile | Accessible routes opened | Route/render result | Permission probes |
|---|---:|---|---|
| Employee | 46 | PASS | Payroll, role administration, and HR cases denied; self-service compensation route allowed. |
| Manager | 55 | PASS | Payroll, role administration, and HR cases denied; compensation route allowed. |
| HR | 69 | PASS | Compensation, payroll, and HR cases allowed; role administration denied. |
| Recruiter | 51 | PASS | Payroll, role administration, and HR cases denied; compensation route allowed. |
| Executive | 57 | PASS | Payroll allowed; role administration and HR cases denied; compensation route allowed. |
| Admin | 61 | PASS | Payroll and role administration allowed; HR cases denied; compensation route allowed. |

For every profile, sign-in reached a dashboard and each listed sidebar route was clicked. UI route-denial checks showed the expected “No access” state on the tested restricted routes. These results establish frontend route behavior only; they do **not** establish server-side authorization.

## Feature and workflow results

### PASS

- **Authentication and navigation:** All six demo profiles signed in independently. Dashboard and sidebar rendered. Every accessible sidebar route listed above rendered a nonblank main area.
- **Leave request and approval (employee → manager → employee):** A safe local request was submitted, appeared in manager approvals, was approved after the confirmation prompt, and showed the updated status when the employee signed in again. State persisted across profile changes in the same local browser.
- **Directory (employee):** Search empty state, clear filters, country and department selection, list/grid toggle, pagination, and Open profile navigation were exercised. Profile content included job, department, manager, contact, and skills fields. A document section was not observed for the selected profile; this is listed as needing review rather than passed.
- **Learning (employee):** Course search empty state, category selection, mandatory-course filter control, clear filters, enrollment, My Learning status, and progress update were exercised. Enrollment status changed to Assigned, and progress update persisted as In progress in local state.
- **Performance (employee):** Cycle selector and the Goals, Feedback & praise, 1:1, Self-assessment, Manager assessment, 360 feedback, and Ratings & plans tabs were opened. Add Goal validation correctly prevented an addition while existing weights used the full allocation. After freeing capacity through an edit, a local test goal was added and its progress updated.
- **Skills & Career (employee):** Career interests, role matches, target-role skill gaps, and recommended courses rendered. A temporary skill was added, proficiency edited, then removed; the list returned to its previous row count.
- **AI assistant (employee):** Assistant opened with suggested questions and returned a response. A question requesting other employees’ salary information received a privacy refusal. An employment-letter request displayed a preview and explicit confirmation action; Cancel closed the flow without creating a document.
- **Compensation (non-HR profile):** The page exposed only personal pay-history and personal-bonuses tabs for the profile checked. Pay rows were not copied into the report. Wider salary visibility and other profiles’ records were not verified.

### BLOCKED / NEEDS REVIEW

- **Timesheet submit and manager approval:** The browser’s test date was Sunday. The “Log time” action was disabled with a “Day off today” reason, and the form did not offer an eligible workday. No submission or approval was attempted. This may be the intended business rule; verify on a configured workday or with an approved test calendar.
- **Directory documents:** The opened profile showed job and contact sections but no document section. The profile may not have documents; verify using an authorized test profile with a document or HR account.
- **Total rewards:** The tab is only exposed in API mode. It could not be validated in isolated local demo mode.
- **Server-side access control:** All authorization checks were in the frontend. API endpoints were intentionally not called, so unauthorized API reads/writes, tenant scoping, and backend salary/document permissions remain untested.
- **Live persistence and integrations:** Neon persistence, Render behavior/wake latency, Vercel deployment, Backblaze upload/download, OpenRouter availability, cron wake behavior, notifications, email, and external financial actions were not tested.
- **Unverified functional workflows:** Attendance/regularization, overtime, shift swap/comp-off, benefits, payslips, tax declarations, reimbursements, travel, cash advances, document upload/verification, recruitment, onboarding, and other approvals were opened only where their routes were in the navigation sweep. Their forms and end-to-end transitions were not exhaustively exercised.
- **Role-specific business actions:** HR/admin compensation edits, broader compensation review cycles, manager assessment submission, feedback submission, 360 nominations, learning-path start/completion/certification, employee profile updates, admin actions, and logout/relogin persistence for every module were not comprehensively tested.
- **Responsive and visual review:** Mobile/tablet sizing, keyboard-only navigation, contrast, hover states, and systematic design review were not completed.
- **Runtime diagnostics and performance:** No browser-console audit, network trace, Lighthouse run, or measured page-load/login timing was performed.

## Consolidated issue list

No reproducible functional defect was confirmed in the interactions completed above. This is not evidence that untested features are defect-free.

| Severity | Status | Finding |
|---|---|---|
| Critical | BLOCKED | Backend authorization and data scoping have not been verified; local mode does not exercise API guards. |
| High | BLOCKED | Live sign-in, home-page latency, Render wake behavior, database connectivity, and deployment behavior were not assessed in this isolated local run. |
| Medium | NEEDS REVIEW | Directory documents were not present/visible on the selected test profile. |
| Medium | BLOCKED | Timesheet end-to-end flow could not be run because the tested date was a configured day off. |
| Low | BLOCKED | Responsive, accessibility, and detailed visual checks remain incomplete. |

## Recommended next QA pass

Use a staging API/database and test-only accounts with known roles and seeded records. Run the blocked cross-role workflows on an eligible workday, including server-side denial checks, file handling, and the connected AI/storage/database paths. Keep production credentials and employee data out of the QA artifacts. After reviewing this report, fixes can be prioritized and retested locally before any push or deployment.
