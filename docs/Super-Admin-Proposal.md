# TimeZ HRMS — Super Admin Control Center: Review and Proposal

Date: 3 November 2026 · Read-only review of the code on `main` (commit `0665eb6`). Nothing has been changed yet.

**Who this covers:** the super admin is the `admin` / `super_admin` role (Alex Morgan in the sample data). Earlier
today we decided the admin has full data access on the server (`HR_ACCESS_ROLES` in
`backend/app/services/scope.py`). This proposal is about what the admin **sees and works with**: the sidebar, the home
page and the platform pages.

---

## 1. What is there today

**Home page.** `AdministrationHome` (`src/pages/dashboards/RoleHomes.tsx:1954-2310`).
- Its cards: headcount by country, country distribution, admin modules by role, system activity (14 days),
  sign-in roles, who can do what, recent audit events, platform links.
- The audit cards read the **browser's own local list** (`listAuditLog()` → localStorage, `src/data/platformLocal.ts:221`),
  not the server's `audit_log` table. On the live site they show sample rows, not real activity.
- Headcount and country cards are workforce numbers, not platform numbers.

**Sidebar.** Since this morning `navAccess: ["*"]` (`src/demoAccounts.ts`), so the admin sees **every** menu group
(`src/nav.ts`): Me, Time & pay, My workplace, Team, People & organization, Talent, Performance & learning, Admin,
Copilot & policies.
- That is about 70 links, most of them employee or HR work.

**Admin pages that exist**

| Page | Route | Data source in backend mode |
|---|---|---|
| Console (Users, Roles, Country & legal entity, Organization & locations, Audit log, Notification preferences tabs) | `/admin` (`src/pages/PlatformModules.tsx:1381`) | Mixed. The audit tab is local only. |
| Roles & permissions | `/admin/roles` (`src/pages/RolesPermissionsPage.tsx`) | Server: `/admin/accounts`, data scope, page access |
| Country configuration | `/admin/countries` (`src/pages/LocalePages.tsx:161`) | Server: `PUT /countries/{code}` |
| Locale settings | `/settings/locale` | Server: `/admin/settings` |
| Integrations | `/integrations` (`src/pages/PlatformModules.tsx:956`) | Server: `/admin/integrations`, runs, quarantine |
| Approval steps (workflow editor) | `/admin/workflows-config` | Server: `/workflows` |
| Email outbox | `/admin/email-outbox` | Server: `/admin/email-outbox` |
| AI settings | `/admin/ai` | Server: `/admin/ai-settings` |
| Leave policies | `/admin/leave-policies` | Server (an HR configuration page) |
| Audit log | `/admin/audit` (`src/pages/AuditLogPage.tsx`) | **Local only.** No server endpoint lists `audit_log`. |
| My security (MFA, sessions) | `/settings/security` | Server: `/account/mfa`, `/account/sessions` |

**Back-end endpoints for admins**
- `backend/app/routers/platform_admin.py`: accounts, data scope, page access, AI settings, platform settings,
  integrations (runs, quarantine, retry), email switches, email outbox, run jobs.
- `backend/app/routers/account_security.py`: MFA, MFA policy, sessions, revoking another account's sessions.

**Database tables we can build on (all exist)**
- `accounts`: role, active, `locked_until`, `failed_attempts`, `last_login_at`, MFA flags
- `refresh_tokens`: sign-ins and sessions
- `audit_log`: every admin action and every sign-in event (`login`, `login_failed`, `login_blocked_locked`,
  `account_locked`, `refresh_token_reuse`, `mfa_failed`, …)
- `account_data_scopes`, `access_scopes`, `page_access_overrides`
- `platform_settings`, `ai_settings`, `email_channel_switches`
- `integration_connectors`, `integration_runs`, `integration_quarantine`
- `email_outbox`, `reminder_log`
- `countries`, `org_units`, workflow tables
- `/health` already checks the database connection.

---

## 2. Unnecessary on the super admin view (remove from his home and sidebar)

These are not deleted from the app. They stay in their own modules for the roles that use them.

- **Employee self-service groups in the sidebar:** Me (calendar, tasks, tickets, mail, messages, …), Time & pay (attendance,
  leave, timesheets, payslips, tax, benefits, reimbursements, travel, cash advance, overtime, encashment), My workplace.
  Keep only **My profile**, **My security** and **Notifications**, in the user menu at the top right.
- **HR operations groups:** Team, People & organization (directory, compensation, HR cases, exits), Talent, Performance &
  learning, Payroll, Pay preview, Leave policies, Compliance calendar, Bulk data, Report builder, Copilot, Policies.
- **Home cards:** headcount by country, country distribution, sign-in roles chart, "admin modules by role" chart and
  the 14-day activity chart based on local data. They are workforce or decorative, not platform signals.

## 3. Keep (reuse what works)

- Roles & permissions page (server-backed): the base for section 4.
- Integrations page with runs, quarantine and retry (server-backed): the base for section 6.
- Workflow editor (`/admin/workflows-config`): the base for section 8.
- Country configuration, locale settings and the platform settings endpoint: the base for section 5.
- Email outbox, email switches and AI settings: placed under System Configuration and Monitoring.
- MFA, MFA policy and session revoke: reused in sections 3 and 5.

## 4. Duplicated

- **Audit log three times:** the Console tab, the `/admin/audit` page and the home card. All read the same local list.
  This becomes one server-backed page.
- **Roles and permissions twice:** the Console "Roles & permissions" tab and `/admin/roles`. This becomes one page.
- **Country and legal entity twice:** the Console "Country & legal entity" tab and `/admin/countries`. This becomes one page.
- **Org chart and locations** inside the Console duplicate the Organization page and the org chart.

## 5. Missing (needed for a real control center)

| Need | What is missing | Proposed |
|---|---|---|
| Real audit trail | No API lists `audit_log` | `GET /admin/audit` with filters (who, action, entity, dates), paged |
| Sign-in history and failed sign-ins | Data is in `audit_log`, no API | `GET /admin/security/sign-ins` with summaries (failed in 24 h, locked accounts, token reuse) |
| Active sessions, platform-wide | Only per account | `GET /admin/security/sessions` (live refresh tokens), revoke reuses the existing endpoint |
| Account activate/deactivate, unlock, recovery | No endpoints | `POST /admin/accounts/{id}/deactivate`, `/reactivate`, `/unlock`, `/force-password-reset` (all audited, confirmed, never self) |
| Platform KPIs | Nothing server-side | `GET /admin/overview`: users, active admins, active sessions, failed sign-ins (24 h), locked accounts, legal entities, countries, integration failures, email queue, DB health |
| System monitoring | Only `/health` | `GET /admin/monitoring`: DB round-trip time and version, migration revision, email outbox backlog, last job runs (`reminder_log`, `integration_runs`), app uptime |
| Application errors | Errors only go to Render logs | Optional: a small `app_errors` table (new migration 0030, adds a table only) that the global error handler writes to: path, error type, time, with **no request body or personal data** |

**About "organizations".** TimeZ is a single company with legal entities in 8 countries. There is no multi-company
(multi-tenant) data model, and adding one would mean rewriting the app. So **Organization Management** is proposed as
legal entities, countries and the organisation structure, using what already exists. "Total organizations" on the
home page would be **legal entities** and **countries**.

## 6. Security concerns found

1. **Admin can open every HR and employee page.** This is consistent with this morning's decision, but it makes the
   console noisy and widens what a stolen admin session could do in the browser. The menu change fixes the noise; the
   server rule stays as you decided unless you change it (question 2 below).
2. **No MFA requirement for admins.** An MFA policy endpoint exists (`account_security.py:122-127`). Proposal: platform
   actions (deactivate, unlock, permission changes, settings) require the admin to have MFA turned on. You choose whether
   to switch this on.
3. **Audit page shows browser data.** Admins cannot see real admin actions or sign-in attacks today.
4. **Failed sign-ins for unknown emails are not stored.** Only the in-memory per-IP throttle sees them. Proposal: record
   them in `audit_log` with the email masked.
5. **Sensitive actions without confirmation:** permission and scope saves, integration runs and settings saves. Proposal:
   use the existing `ConfirmDialog` with a short reason, and store that reason in the audit row.
6. **Backend checks:** every new `/admin/*` endpoint checks `SUPER_ADMIN_ROLES` on the server. Secrets (the OpenRouter
   key, the Backblaze keys, the database URL) are never returned. Monitoring shows only "set / not set".

---

## 7. Proposed structure

**Sidebar for the super admin:** 9 items, nothing else. The user menu at the top right keeps My profile, My security,
Notifications and Sign out.

| # | Section | Contents (all server data) | Built from |
|---|---|---|---|
| 1 | **Overview** | KPI row: users · active admins · active sessions · failed sign-ins (24 h) · locked accounts · legal entities / countries. Health strip: database, API, email queue, integrations. Lists: recent security alerts, recent admin actions, integration failures. | new `/admin/overview`, `/admin/audit`, `/admin/security/sign-ins` |
| 2 | **Organization Management** | Legal entities (name, country, headcount, status), countries (currency, time zone, work week, probation), org units (link to the existing Organization page for structure editing) | `countries`, `org_units`, existing endpoints |
| 3 | **User & Admin Management** | Accounts table (role, status, last sign-in, MFA, locked); deactivate / reactivate / unlock / force password reset / revoke sessions, each with confirmation | `accounts`, `refresh_tokens`, new account actions |
| 4 | **Roles & Permissions** | The current Roles & permissions page (page access, data scope); one place only | existing |
| 5 | **System Configuration** | Platform settings, locale, MFA policy, email channel switches, AI settings (model only, the key shown as "set / not set") | existing endpoints |
| 6 | **Integrations** | The current Integrations page: status, last run, errors, quarantine, retry | existing |
| 7 | **Security & Audit Logs** | Tabs: Sign-ins (success, failed, locked), Admin actions, Full audit trail; filters and CSV export | new `/admin/audit`, `/admin/security/*` |
| 8 | **Workflow Configuration** | The current workflow editor (steps, escalation rules); no approval inbox | existing |
| 9 | **System Monitoring** | Database (status, response time, migration version), API (uptime, version), background jobs (last reminder and integration runs), email queue, application errors (if the optional table is approved) | new `/admin/monitoring` |

**Home page (Overview).**
1. A single row of 6 KPI tiles.
2. A health strip with 4 status chips.
3. Three short lists: security alerts, admin activity and integration failures, 5 rows each with a "View all" link.

There are no charts unless one adds real information. Every number comes from one server call: `GET /admin/overview`.

**Delivery in steps (each one tested, then shown to you):**
1. Server: overview, audit, sign-ins, sessions and monitoring endpoints, admin-only, with tests.
2. Server: account actions (deactivate, reactivate, unlock, force reset), audited and with tests.
3. Portal: the 9-section sidebar for the super admin and the new Overview home; other roles unchanged.
4. Portal: the Security & Audit, User & Admin, Monitoring and Organization pages; existing pages moved under their
   sections; duplicate Console tabs removed.
5. Optional: the `app_errors` table and the MFA requirement for platform actions.

**Rough effort:** steps 1 to 4 take about 3 to 4 days of work. Step 5 adds half a day.

---

## 8. Decisions needed before building

1. **Organizations = legal entities and countries** (no multi-company rewrite). Agree?
2. **Admin's HR data access on the server:** keep it full as decided this morning (the menu only hides HR pages),
   or limit admin back to platform data only now that the console is separate?
3. **New `app_errors` table** (one new table, nothing else changed) for the Monitoring page: yes or no?
4. **Require MFA** for the super admin's platform actions: yes or no?
