# UI click-through (portal on the audit API, throwaway PostgreSQL)

Script: clicks every safe control on every page in each person's menu. Safe means tabs, filters, dropdowns, search
boxes, expand/details/open buttons and in-app links. It records crashes, "not authorized" pages, browser errors and
failed server calls (4xx/5xx except 401). Buttons that save or change data are listed, not clicked; the workflow checks
and the automated tests cover them.

| Person | Pages | Buttons | Clicked | Dropdowns | Search | Links | Problems |
|---|---|---|---|---|---|---|---|
| Babu (Employee) | 47 | 571 | 224 | 65 | 17 | 17 | none |
| Ram (Manager, Hiring Manager) | 56 | 712 | 252 | 85 | 17 | 26 | `/onboarding` task status dropdown → 409 "finish the earlier task first" (bug 5) |
| Farhan (HR) | 70 | 599 | 213 | 95 | 14 | 25 | 6 × 404 for offline people `wf-TZ0076/77` on goals, check-ins, learning (bug 2); onboarding dropdown 409 (bug 5) |
| Sophie (Recruiter) | 52 | 472 | 194 | 60 | 17 | 14 | none |
| Jordan (Executive) | 58 | 646 | 228 | 85 | 15 | 13 | See below |
| Alex (Super Admin / Admin) | 76 | 1,001 | 309 | 116 | 18 | 26 | onboarding dropdown 409 × 3 (bug 5) |

Jordan's problems:
- **Bug 2:**
  - 80+ × 404 on `/performance/goals`, `/performance/check-ins`, `/learning/enrollments`, `/learning/certifications` and
    `/learning/skills` for `wf-TZ0001, 0194, 0290, 0349, 0389, 0424, 0449, 0469` (the retired country managers kept in
    the offline directory).
  - Team overview links to `/people/wf-TZ0090, 0120, 0150, 0180, 0210, 0300`, which don't exist on the server; their AI
    summary returns 404.
- **Bug 3:** the `/documents` employee picker includes `wf-TZ0014` (404).
- **Bug 4:** `/payroll/providers` → `GET /payroll/status` 403.
- **Bug 6:** `/announcements` and `/help` show "Can't reach the server" for a request cancelled by navigating away.
- **Not a bug:** AI summaries for people outside Jordan's line, opened from `/celebrations`, are correctly refused (404).

Data-changing buttons listed, not clicked (Babu's list as an example; other roles add Approve, Approve selected, Send back,
Assign task, New announcement, Raise action, Save and admin actions):
Accept task, Acknowledge, Add, Add document, Add files, Add goal, Add skill, Apply, Apply for <each leave type>, Check in,
Clear history, Clear read, Decline, Delete <notification>, Download CSV/PDF/report, Edit, Edit profile, Enroll, Like,
Log time, Mark read, New group, New message, New request, Post, Print, Raise a case, Raise ticket, Remove, Request,
Request asset, Request correction, Save reminder, Schedule, Send, Send kudos, Send request, Send wishes, Submit case,
Submit claim, Submit for approval, Submit request, Update, Upload document.
