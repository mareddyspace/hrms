# TimeZ HRMS — Audit Report

Date: 3 November 2026 · Branch: `fix/module-audit` (same as `main`, commit `c55c919`) · Read-only audit: no code was changed.

**How this was checked**
- Every file under `backend/app` and `src/` that belongs to the modules below was read. The full working notes are kept outside the repo.
- The back-end test suite was run on a throw-away SQLite database (`backend/tests/conftest.py` forces SQLite):
  `1 failed, 1629 passed, 1 xfailed` in 9 min 5 s (see "What is broken", item B1).
- Git was checked for leaked secrets (`git ls-files`, full `git log -p` history search, `.gitignore`).
- Nothing touched the live Neon database or the live sites.

**Not counted as findings (accepted risks):** demo passwords on the sign-in page, MFA secrets and bank numbers not yet
encrypted, reminders that run only at start-up or from Admin, and the browser-only mode when `VITE_API_URL` is unset.

**Words used below**
- *Backend mode* = the portal is built with `VITE_API_URL`, so it should load and save through the API.
- *Local only* = saved in the browser (localStorage) even in backend mode, so other people never see it and it is lost on another device.

---

## 1. The short version

- **The back end is in good shape.** Every module has real endpoints that read and write PostgreSQL through
  SQLAlchemy and commit. No stub endpoints, no "coming soon", no `NotImplemented`, no TODOs were found.
  Security basics (argon2id, JWT rotation, lockout, CORS, `/docs`, secrets) are done well.
- **The weak spots are in the front end in backend mode.** A few screens still save to the browser only, or show
  seeded/demo data next to real data. Some of them tell the user "saved" when the server never got the change.
- **Some role checks are too loose.** The worst is that recruiters and admins can read every new joiner's
  personal details.

---

## 2. Module by module

| Module | Verdict | Notes |
|---|---|---|
| Employee management / directory | **Partly** | Reading and scoped detail views work. Adding an employee and most HR edits do not reach the server (A1, A2). |
| Attendance | **Mostly works** | Check-in/out, breaks, corrections go through the API. Calendar holidays and Employee 360 tab use local data (M6). |
| Leave | **Mostly works** | Server checks balance, overlap, eligibility under a row lock (`backend/app/services/leave.py:191-255`). Policies from the server are fetched then ignored on the front end (M7). |
| Timesheets | **Works end to end** | `backend/app/routers/timesheets.py`, `src/api/syncTimeSheets.ts`. |
| Approvals / workflows / delegations | **Mostly works** | Engine is solid. Approvals Center still mixes in seeded browser rows (M8). |
| Payroll runs and payslips | **Partly** | Runs are stored and locked on the server with a second approver. But pay figures are worked out in the browser and the server does not re-check basic pay or tax (H3). |
| Documents and letters | **Works end to end** | Server-side PDFs, upload type and size checks, no path traversal (`backend/app/services/storage.py:125-149`). |
| Recruitment and onboarding | **Works end to end** | Hire → new joiner → Active employee. Access to joiners is too wide (H1). |
| Performance | **Mostly works** | Reviews, 360, goals, feedback go through the API. 1:1 meeting planning is local only (M9). |
| Expenses | **Works end to end** | Admin can see every claim (H2). |
| Travel | **Works end to end** | `src/data/travelStore.ts` uses the API in backend mode. |
| Organization | **Mostly works** | Units, jobs and history are on the server. The org chart draws only the 8 demo accounts (M10). |
| Notifications | **Works end to end** | Users see only their own. "Clear read" is local only (low). |

---

## 3. Roles and data scope

How it works: the role is a text field on the account (`Account.role`). `backend/app/deps.py` attaches a data scope to
each request and each router checks roles itself (`backend/app/services/scope.py`, `backend/app/services/data_scope.py`).

| Person | Role | What they can see and do | Problems found |
|---|---|---|---|
| Babu, Priya, Oliver | Employee | Their own records; basic directory of everyone | None |
| Ram | Manager | Full records for Babu, Priya, Oliver; decides their requests; no pay data | None |
| Farhan | HR | Everyone, all modules | An HR account limited to some countries can still change other countries' leave policies, holidays, org units, payroll and recruiting (M1) |
| Sophie | Recruiter | Herself; only her assigned job openings | Can read every new joiner's personal details (H1) |
| Jordan | CEO | Company-wide totals; HR data only for people in his reporting line | "Exits" page is in his menu, but the API refuses it (L) |
| Alex | Admin | Platform settings, email outbox, org edits | Sees every expense claim and receipt (H2); can give any account "global" HR scope (M2); every joiner's details (H1) |

**Only demo accounts can sign in (H4).** In backend mode the portal looks the signed-in user up in the hard-coded
list `src/demoAccounts.ts`. Anyone else gets "This account can't use the portal yet" (`src/store.tsx:1185-1189`). The role
shown in the portal also comes from that list, not from the server.

---

## 4. What works (with evidence)

- **Security**
  - **Passwords:** argon2id with OWASP settings (`backend/app/security.py:1-16`).
  - **Tokens:** 30-minute access tokens and 7-day refresh tokens (`backend/app/config.py`). Each refresh token works
    once, and reusing an old one ends that whole session (`backend/app/routers/auth.py:171-194`).
  - **Lockout:** an account locks for 15 minutes after 5 wrong passwords (`backend/app/routers/auth.py:68-74`). There
    is also a per-IP throttle (`backend/app/services/login_throttle.py`).
  - **JWT secret:** the server refuses to start in production with a weak `JWT_SECRET` (`backend/app/config.py:110-121`).
  - **CORS:** an allow-list plus an optional pattern, with no cookies (`allow_credentials=False`, `backend/app/main.py:38-41`).
  - **`/docs`:** off in production. If `DOCS_ENABLED=true` it asks for a portal sign-in (`backend/app/main.py:26-35`, `backend/app/docs_auth.py`).
  - **Errors:** any unexpected error is logged on the server and the user gets a plain message, with no stack trace (`backend/app/main.py:49-53`).
  - **PII masking** is tested (`backend/tests/test_pii_masking.py`).
- **Secrets are not in git.**
  - `.gitignore` ignores `.env`, `.env.*`, `*.db` and `backend/storage/`.
  - `git check-ignore` confirms `backend/.env` and the local `.db` files are ignored.
  - The only tracked env files are `backend/.env.example` and `.env.production`, which contains only `VITE_DEMO_MODE=true`.
  - A search of the full git history found no database URLs with passwords, no OpenRouter keys, no JWT secrets and no Backblaze keys.
- **Data layer:** every audited router writes real tables through SQLAlchemy sessions and commits. Leave booking uses a row lock.
- **Tests:** 1,629 tests pass (see the run above).

---

## 5. What is broken

| ID | Problem | Evidence |
|---|---|---|
| B1 | Test `test_calendar_circle_shows_only_people_around_me` fails in the full run but passes on its own (`5 passed` for `tests/test_celebrations.py` alone). The "people around you" list adds every account that can sign in (`backend/app/routers/celebrations.py:80`). Earlier tests create accounts for workbook employees, so those strangers appear in Babu's calendar. Real bug in the new calendar feature, not just a flaky test. | `backend/tests/test_celebrations.py:115`, pytest run |
| A1 | **Add employee** saves only in the browser. In backend mode the new person disappears on reload. | `src/pages/PeopleModule.tsx:435-457` → `src/pages/EmployeeFormDialog.tsx:142-157` → `src/data/peopleLocal.ts:124` |
| A2 | **HR edits of department, title, manager, location, grade or status are dropped** in backend mode, yet the page says "Employee record saved". Only name, nationality, gender, date of birth and work arrangement are sent (`src/pages/EmployeeFormDialog.tsx:160-175`). Server errors go only to the browser console (`:172-174`). There is no back-end endpoint for job changes or deactivation. | as listed |
| B2 | `super_admin` can open the workflow editor but every save fails with 403. | `backend/app/routers/approvals.py:199` vs `src/pages/ApprovalWorkflowsPage.tsx:34` |
| B3 | Admin sees a payroll **Prepare** button, but the server refuses it (403). | `src/features/payroll/runsStore.ts:35-36` |
| B4 | Payroll status tab counts are near-empty for admin and finance (uses `employee_filter` instead of `org_filter`). | `backend/app/routers/payroll.py:69` |

## 6. What is incomplete or placeholder (backend mode)

| ID | Screen | What happens | Evidence |
|---|---|---|---|
| M6 | Attendance calendar | Uses seeded browser holidays until the Holiday Calendar page is opened; a seeded holiday hides real punches. Employee 360 attendance shows only your own punches. A seeded absence on 2026-08-12 shows for everyone. | `src/pages/AttendanceModule.tsx:247-268`, `src/pages/Employee360View.tsx:253-270`, `src/seed.ts:1685` |
| M7 | Leave balances | Server leave policies are fetched then thrown away; other years and Employee 360 use seed policies. Backdated leave cannot be applied (server refuses past dates; the permission flow is browser only). | `src/store.tsx:642-651`, `src/pages/LeavePage.tsx:85-94,139`, `backend/app/services/leave.py:211` |
| M8 | Approvals Center | Shows seeded browser rows (reimbursements, investment proofs, encashments, asset and cab requests) next to the real inbox. | `src/pages/ApprovalsCenter.tsx:134-142` |
| M9 | Performance 1:1s | Scheduling, agenda, actions and notes are local only; only "Completed" reaches the server. HR goal view loads only demo accounts, max 25 people. | `src/data/talentLocal.ts:2470-2545`, `src/api/syncTalentPerf.ts:37,380-385` |
| M10 | Org chart | Always draws the 8 demo accounts, never the 509 server employees (`SIGN_IN_ACCOUNTS_ONLY = true`). | `src/components/OrgChart.tsx:41,47` |
| M11 | Audit log page | Reads only the browser's own trail; no API returns the server `audit_log`. | `src/pages/AuditLogPage.tsx:3-4` |
| L | Notifications | "Clear read" is browser only; no "mark all read". | `src/data/notificationFeed.ts` |
| L | Timesheets | Everyone sees Approve controls (server still blocks them). Employee 360 has no daily timesheets. | `src/pages/TimesheetPage.tsx:184`, `src/pages/Employee360View.tsx:300-316` |

## 7. Security findings

| ID | Severity | Finding | Evidence |
|---|---|---|---|
| H1 | **High** | Recruiter, admin and it_admin can list and open **every** new joiner, including the pre-boarding form (personal email, mobile, home address, emergency contact). No country or job-opening check. Not covered by tests. | `backend/app/services/onboarding.py:39,208-210`, `backend/app/schemas/talent.py:363` |
| H2 | **High** | Admin counts as "finance" (`FINANCE_ROLES = {"finance","admin"}`), so admin sees all expense claims and downloads any receipt. This contradicts the admin rule written in `backend/app/services/scope.py:5-8`. | `backend/app/routers/expenses.py:43,91,123,381` |
| H3 | **High** (data integrity) | Payslip figures (basic, tax, statutory deductions, YTD) are calculated in the preparer's browser and stored as sent. The server re-checks only overtime, reimbursements, encashment, recovery and unpaid days. A missing salary record silently falls back to a role-based default; hourly rates are hard-coded in the browser. The locked "FINAL" PDF prints these numbers. | `src/features/payroll/runsStore.ts:439-455`, `backend/app/services/payroll_runs.py:286-300`, `src/data/payslipGenerator.ts:17,132`, `backend/app/services/payslip_pdf.py:265-280` |
| H4 | **High** (function) | In backend mode only hard-coded demo accounts can use the portal, and the role comes from the front-end list. | `src/store.tsx:1185-1189`, `src/demoAccounts.ts` |
| M1 | Medium | HR scope limited by country is not applied in several places: leave admin (policies, holidays, carry-forward), org edits, payroll lines, recruiting, onboarding, rating release, review cycles, shift rosters, team-calendar leave reasons. | `backend/app/routers/leave_admin.py:43-299`, `backend/app/routers/org.py:45-47`, `backend/app/services/payroll_runs.py:87-101`, `backend/app/services/recruiting.py:64`, `backend/app/routers/performance.py:71,100-137`, `backend/app/routers/shifts.py:106-107`, `backend/app/routers/leave.py:365` |
| M2 | Medium | An admin can give any account (even an employee) "global" HR scope; only changing your own scope is blocked. | `backend/app/routers/platform_admin.py:96-124`, `backend/app/services/data_scope.py:270` |
| M3 | Medium | Public job application `POST /public/careers/{id}/apply` has no rate limit and accepts ~7 MB base64 per request; only a honeypot field protects it. The CV is written before the database commit with no clean-up on failure. | `backend/app/routers/careers.py:63-109,98` |
| L1 | Low | `/docs` (when turned on in production) accepts any portal account, not only admins. | `backend/app/docs_auth.py` |
| L2 | Low | Login throttle is in memory, so a restart resets it (fine on one Render instance). | `backend/app/services/login_throttle.py:3` |
| L3 | Low | Some GET endpoints write to the database (review row created on GET; org history GET commits). | `backend/app/routers/performance.py:332-349`, `backend/app/routers/org.py:86` |
| L4 | Low | An employee can change the expiry date of an HR-verified document without it going back for verification. | `backend/app/services/documents.py:358-369` |
| L5 | Low | `spend.csv` and `spend.qbo` (personal-looking spend data, not HRMS) are tracked in git since the first commit. | `git ls-files` |
| L6 | Low | Approvals inbox loads every pending request in the company and runs one query each, on every load (slow as data grows). | `backend/app/services/approvals.py:329-337,578-588` |

---

## 8. Prioritised fix list

**Progress (3 Nov 2026):**
- **Done and pushed (commit `1a25fb8`):** high items 1, 2, 3, 4 and 6. Item 5 is partly done: the server flags a missing
  salary record and pay above the salary on record. Tax and statutory deductions are still worked out in the browser.
- **Done next (not committed yet):**
  - **Admin is now a super admin, as the owner decided.** Admin and super_admin have full access to everything HR
    can see and do, in every country, including pay and personal details: `HR_ACCESS_ROLES` and `SUPER_ADMIN_ROLES`
    in `backend/app/services/scope.py`; in the portal, `isSuperAdmin` in `src/model.ts` and every page. This replaces
    finding H2 and the admin parts of H1. HR approval tasks still go only to HR.
  - **Fixed:** M1 for leave admin and org edits; M2 (only HR and admin accounts can be given global scope); M3's rate
    limit (5 applications per address every 10 minutes); B3 (admin can prepare payroll); B4 (payroll status counts);
    L1 (`/docs` for admins only); L4 (a changed expiry date goes back for verification).
- **Still open:**
  - the payroll tax engine on the server
  - the HR country limit for payroll lines, recruiting, onboarding and performance cycles
  - clean-up of the CV file when an application fails
  - the CEO Exits menu
  - L3 (GET endpoints that write; by design)
  - L6 (approvals inbox performance)
  - the front-end medium items

Effort: **S** = under 2 hours, **M** = half a day to a day, **L** = 2+ days.

### High
| # | Fix | Effort |
|---|---|---|
| 1 | Limit joiner access (H1): recruiter only for their job openings, admin/it_admin only IT tasks, hide the pre-boarding form from them; add tests. | S |
| 2 | Take admin out of `FINANCE_ROLES` (H2), or seed a real finance account; add tests. | S |
| 3 | Employee add and HR job edits (A1, A2): add server endpoints for create, job change and status, send all fields, show the server's error instead of "saved". | L |
| 4 | Sign in for any server account (H4): use the role and profile from `/auth/me` instead of `demoAccounts.ts` in backend mode. | M |
| 5 | Payroll on the server (H3): compute basic, tax and statutory deductions on the server (or re-check them), flag missing salary records, store hourly rates on the server. | L |
| 6 | Fix the calendar circle (B1): build it from the reporting line, not "every account that can sign in". | S |

### Medium
| # | Fix | Effort |
|---|---|---|
| 7 | Apply HR country scope everywhere listed in M1, with tests per router. | M |
| 8 | Admin data-scope grant (M2): only allow "global" for HR roles, or require a second admin. | S |
| 9 | Rate-limit the public apply endpoint and clean up CV files on failure (M3). | S |
| 10 | Remove seeded rows from the Approvals Center in backend mode (M8). | S |
| 11 | Use server leave policies and holidays on the front end; add a backdated-leave request on the server (M7, M6). | M |
| 12 | Org chart from server employees (M10). | M |
| 13 | Audit log page from a new admin-only API (M11). | M |
| 14 | 1:1 meetings and HR goals through the API (M9). | M |
| 15 | Small role mismatches: `super_admin` workflow saves (B2), admin payroll button (B3), payroll status counts (B4), CEO exits menu. | S |

### Low
| # | Fix | Effort |
|---|---|---|
| 16 | `/docs` sign-in: admins only (L1). | S |
| 17 | Stop GET endpoints writing (L3). | S |
| 18 | Re-verify a document when its expiry changes (L4). | S |
| 19 | Remove `spend.csv` / `spend.qbo` from git if they are not part of the project (L5). | S |
| 20 | Approvals inbox query performance (L6). | M |
| 21 | Notifications "clear read" and "mark all read" on the server; hide Approve buttons for non-approvers; timesheets on Employee 360. | S |
| 22 | Add missing role tests: expenses, travel, overtime, exits, joiners, lifecycle, utilization with `?employee_id=`; Priya/Oliver cross-country cases. | M |
