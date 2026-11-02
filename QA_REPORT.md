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
- **Unverified functional workflows:** Benefits, payslips, tax declarations, comp-off, document upload/verification, recruitment, onboarding, and other approval types were not fully exercised. The follow-up below covers selected attendance, overtime, shift swap, reimbursement, travel, cash advance, and leave-encashment request paths.
- **Role-specific business actions:** HR/admin compensation edits, broader compensation review cycles, manager assessment submission, feedback submission, 360 nominations, learning-path start/completion/certification, employee profile updates, admin actions, and logout/relogin persistence for every module were not comprehensively tested.
- **Responsive and visual review:** Mobile/tablet sizing, keyboard-only navigation, contrast, hover states, and systematic design review were not completed.
- **Runtime diagnostics and performance:** No browser-console audit, network trace, Lighthouse run, or measured page-load/login timing was performed.

## Consolidated issue list

A reproducible shift-swap approval failure was observed in local demo data: manager approval was blocked because the roster had changed, and the requester had no published future shift to submit a replacement request. Other untested features are not considered defect-free based on this audit.

| Severity | Status | Finding |
|---|---|---|
| Critical | BLOCKED | Backend authorization and data scoping have not been verified; local mode does not exercise API guards. |
| High | BLOCKED | Live sign-in, home-page latency, Render wake behavior, database connectivity, and deployment behavior were not assessed in this isolated local run. |
| Medium | NEEDS REVIEW | Directory documents were not present/visible on the selected test profile. |
| Medium | NEEDS REVIEW | Seeded shift swap could not pass manager approval because the roster was considered changed; no replacement request could be created from the employee's schedule. |
| Medium | NEEDS REVIEW | User reports missing previous-month data in Leave, Attendance, or Timesheets. Source inspection confirms the local demo dataset is intentionally sparse in these areas; live database completeness remains unverified. |
| Medium | BLOCKED | Timesheet end-to-end flow could not be run because the tested date was a configured day off. |
| Low | BLOCKED | Responsive, accessibility, and detailed visual checks remain incomplete. |

## Recommended next QA pass

Use a staging API/database and test-only accounts with known roles and seeded records. Run the blocked cross-role workflows on an eligible workday, including server-side denial checks, file handling, and the connected AI/storage/database paths. Keep production credentials and employee data out of the QA artifacts. After reviewing this report, fixes can be prioritized and retested locally before any push or deployment.

## Follow-up QA — 2026-11-02

The original report above describes the first audit pass. This follow-up adds local demo-mode request and approval workflows requested on 02 Nov. The browser was still isolated at `http://localhost:5174/`; outbound calls to Render, Neon, Backblaze, and OpenRouter were blocked. No production data, real notification, email, or payment action was used.

### Additional workflow results

| Workflow | Result | Evidence and limits |
|---|---|---|
| Attendance correction (employee → manager) | PASS | Local employee request was submitted after required check-in and check-out times were supplied. Manager opened the correction queue, approved it, and saw the request marked Approved. |
| Travel (employee → manager) | PASS | Dummy trip request appeared in the manager approvals queue. Approval displayed a success message and removed it from the pending queue. |
| Reimbursement (employee → manager) | PASS | A dummy claim below the receipt threshold submitted successfully, appeared in the manager reimbursement queue, and approval displayed “Claim approved” and removed it from the pending queue. The receipt-required path was not submitted. |
| Cash advance (employee → manager → HR) | PASS, approval stages | Dummy request appeared under manager “To action”; manager approval moved it to Finance/HR. HR approved it and the UI showed the Approved / Being paid out stage. Testing stopped before “Mark paid”; no payout was initiated. |
| Overtime (employee → manager) | PASS | Dummy request submitted despite the visible no-attendance warning. The warning was preserved in the manager queue; manager approval succeeded and cleared the pending queue. |
| Leave encashment (employee → manager) | PASS, approval stages | Dummy one-day request submitted and appeared under manager “To approve”. Manager approval succeeded. Testing stopped before any payroll/payment stage. |
| Shift swap (employee acceptance → manager) | NEEDS REVIEW | Employee accepted an existing local demo swap and it moved to “Waiting for manager”. Manager approval was blocked with “The roster changed since this request — ask for a new swap.” The employee had no published future shift available to create a fresh request, so the manager completion step could not be retried. |

### Remaining blocks after this follow-up

- **Timesheets:** Still BLOCKED. The employee’s test-week schedule shows every weekday as Off, and the app disables logging with “Day off today”; no valid submission date was available in the local profile.
- **Requester-side re-login checks for these new workflows:** BLOCKED. After the manager actions, the isolated Chrome DevTools connection stopped responding during the final employee re-login/status sweep. The manager-side success messages and pending-queue transitions above were captured, but requester-side persistence for these new records was not confirmed. The earlier leave workflow’s employee re-login check remains PASS as recorded above.
- **Shift swap completion:** BLOCKED by inconsistent/stale seeded roster data, as detailed above.
- All prior blocked areas remain blocked or unverified: backend authorization and live persistence, connected integrations and file operations, notification/email delivery, other recruitment/onboarding and document verification flows, manager assessment/360 submissions, and systematic responsive/accessibility/performance review.

### Historical-data follow-up (source inspection)

The user identified Leave, Attendance, and Timesheets as the affected areas. The app was not connected to the live API for this audit, so this confirms local demo-data limits and client query bounds, not whether the production Neon database contains the expected history.

- **Leave:** The local employee seed contains example requests in March, April, June, and October 2026, not a complete monthly ledger. The page filters the request history by selected year and displays requests that exist for that employee. In backend mode, the client loads up to 500 requests and then filters by year.
- **Attendance:** Local demo punches are generated for only the previous 60 days; older working days become “No record.” With the audit date of 02 Nov 2026, generated punches start around 03 Sep 2026. Backend mode requests sessions for the last 365 days.
- **Timesheets:** The local employee seed has sample weeks in August, September, and October 2026; other months have no seeded entries. Backend mode loads entries and day records from 26 weeks before the current week through 13 weeks ahead, so older records are outside this client load window.

These limits can explain blank prior months in the local demo. To determine whether the public portal is also missing actual records, repeat the same month selections while connected to the intended backend and verify that the database contains those employee records. No production records were queried as part of this audit.

The temporary request records in this follow-up exist only in the isolated local QA browser profile. No application source was changed. The working tree contained unrelated user changes in `backend/tests/` and `src/pages/HelpdeskPage.tsx`; those files were left untouched.
