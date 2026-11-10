# TimeZ HRMS — Roadmap gaps, empty screens and role rules

Date: 11 November 2026 · Compared against "HRMS Roadmap and Execution and sample company step by step process
document.docx" (the same 73 sections as the 6 November check; only spacing differs). All checks and changes ran on a
throwaway test database. The live site and the live database were not touched.

---

## 1. The 500-employee Excel sheet

**It works.** All 500 people and all 24 data columns load. Values match the sheet on every row. Country counts are
exact: India 200, USA 100, UK 60, Australia 40, Canada 35, UAE 25, Saudi Arabia 20, Germany 20.

Details:

- The only blanks in the sheet are 231 empty "Manager Employee ID" cells. These are now filled automatically: the
  department head, else the country head, else the CEO.
- There are 509 people in the database: the 500 from the sheet, the 8 sign-in people and 1 sample new joiner.
- **Fixed:** the People page's Grade, Business unit and Legal entity filters found nobody when you were signed in to
  the server. They were built from the offline sample, which uses different grades (L3–M3, not G1–G9). They are now
  built from the people actually loaded.
- **Still different:** the offline mode (used only when the portal has no server) makes up its own 500 people instead
  of reading the sheet. The Vercel link uses the server, so your manager sees the sheet's people.

## 2. Empty fields and empty screens

**Cause:** about 35 kinds of records never got any sample rows, so those screens were empty for everyone, and most
visibly for Alex. Profile fields were also blank for many people.

**Added (sample data, insert-only):**

| Area | What now has data |
|---|---|
| Profiles | Every blank field filled (gender, date of birth, nationality, address, emergency contact, education, experience, languages and more): about 9,800 fields. Everyone has a manager. |
| Attendance | About 9,200 days over the last 4 weeks, respecting weekends, each country's holidays and approved leave. Includes late arrivals and work from home. Also corrections, overtime and comp-off. |
| Timesheets | Entries for project members: approved, sent back and waiting for Ram, so utilization has numbers. |
| Organization | 512 positions, job profile details (description, skills, experience, education), job family descriptions, and a manager and headcount for every unit. |
| Holidays | Descriptions, the 2027 holidays for all 8 countries, and optional holidays outside India. |
| Admin (Alex) | Integration run history, an audit log with 3 weeks of sign-ins, changes, approvals and AI questions, sent emails, payroll provider status, and role-permission examples. |
| Talent | About 2,200 skills, 1,800 course enrollments, 490 certifications, a finished H1 review cycle, goals, 1:1s, 360 feedback, development actions, 730 kudos, survey answers with a 3-point trend, and career mentors. |
| Recruiting | Requisition budgets and reasons, candidate CVs and match scores, interview feedback, and Sophie's activity. |
| HR queues | An exit in progress, confidential cases, letter requests, profile corrections, policy acknowledgements, documents to verify, cash advance, encashment, software requests, life events and a pay proposal. |
| Sign-in people | Alex, Farhan, Jordan, Ram and Sophie now have their own leave, documents, expenses, travel, tax declarations, dependents, bonuses, benefits, tasks, mail and meetings, like Babu, Priya and Oliver already had. |

**Left empty on purpose:** middle name, last working day for people still working, contract end for permanent staff,
and India tax regime for other countries. Also left out: a past payroll run with payslips, because payroll processing is
outside the roadmap's scope (§49) and its amounts are calculated in the browser.

## 3. Rules that didn't make sense for some people (fixed)

| # | Problem | Now |
|---|---|---|
| 1 | Ask AI told the CEO, admin and HR they still had mandatory courses, including "Secure coding" (Engineering only). | Mandatory courses count only for the people they're meant for. Executives are exempt from employee compliance courses and get leadership courses instead. |
| 2 | The CEO's expenses, travel and overtime, and every expense needing a finance check, went to Alex (IT admin). | The CEO's own requests are approved automatically, with the reason recorded. Finance checks go to HR, then the CEO, never IT. |
| 3 | HR or admin could terminate, demote, re-parent or give a raise to the CEO. | Blocked for anyone above you in the reporting line or with the executive role. |
| 4 | Paid overtime at 1.5× was open to the CEO, managers and HR. | Not for executives. Managers, HR and senior grades (M, E, G8–G9) get comp-off only. |
| 5 | The CEO's home said "Not checked in". | Executives are exempt from the check-in reminder. |
| 6 | Everyone needed 9 hours a day to submit a timesheet, though UK/US shifts are 7.5–8 hours and part-timers work less. | The target is the person's shift minus break (or the country's standard day), halved for part-time, and never over 9 hours. |
| 7 | The CEO's menu had Internal jobs, Resign, Cash advance, Encashment and Overtime. | Removed. Internal job applications are blocked for executives and for people on probation or serving notice. |
| 8 | A performance review was opened for the CEO that nobody could rate. Admin could release HR's rating. | No review for someone with no manager. An HR person's rating is released by another HR person or their own manager. |
| 9 | People serving notice still got raises, bonuses, promotions and review cycles. | Blocked. |
| 10 | Contractors and people on probation could get pay proposals. | Blocked. |
| 11 | "Probation completion" worked for someone who joined in 2014, and "contract extension" for permanent staff. | Probation completion only within 13 months of joining. Contract extension only for contractors. |
| 12 | The HR Director's own long leave needed the IT admin's approval. | It goes to the CEO. |
| 13 | The CEO had a 14-day notice period, like a junior US employee. | Minimum 90 days for executive grades and 60 for managers. |
| 14 | Career levels didn't know the sheet's grades G1–G9. | Added. |
| 15 | Parental leave was strictly maternity or paternity. | Added a "Parental / adoption leave" type, open to anyone. |

**Not yet done:** contractors and part-timers still get the full leave package. Contractors get paid holidays and
maternity leave, and part-time allowances aren't reduced (M size).

## 4. Roadmap items still missing

From the 6 November check, after the quick fixes and today's work:

| # | Missing (roadmap section) | Size |
|---|---|---|
| 1 | **Creating sign-in accounts and changing someone's role from the screen** (§27, §66). A new hire or new HR person can't get a login without editing the database. | M |
| 2 | **L&D Admin, Performance Admin, Compliance/Audit and Finance roles** exist only in the portal, not on the server. There is no Finance sign-in. | M |
| 3 | **Training programs and training requests** (§20). Only single courses exist, with no request-and-approve flow. | M |
| 4 | **Real AI policy search (RAG)** (§40). Answers use keyword matching over a fixed policy list. HR-published policies and documents aren't searched. | L |
| 5 | **AI agents and actions on the server** (§58). The 8 "agents" are one assistant, and prepare-confirm-execute happens only in the browser. | L |
| 6 | **AI features:** position analysis (§12), onboarding assistant (§14), goal drafting and performance feedback summary (§19). | M each |
| 7 | **Natural-language analytics** run as rules in the browser, not as checked queries on the server (§42). | M |
| 8 | **Single sign-on** (MVP item, §61). Only a disabled button exists. | L |
| 9 | **Real integrations** (§48): webhooks, events and partner API keys. Connectors are simulated. | L |
| 10 | **Email is never actually sent** (queued only, no mail server). | S–M |
| 11 | **Settings that are fixed in the code:** employment types, attendance rules, security policies, a grade master and allowances (§66). | M |
| 12 | **Analytics computed in the browser.** This works for 500 people but won't scale to many thousands (§43). | M |
| 13 | Bulk import, report builder and language settings save only in the browser. | M |
| 14 | Contractor and part-time leave packages (from §3 above). | M |

**Different from the roadmap on purpose:** payroll processing was built (the roadmap says payroll tab only), admin has
full HR data access (your decision), and the tech stack is simpler than §53 suggests.

**Suggested order:** 1 + 2 (accounts and roles, about 1 week) → 3 + 14 → then one big track: real AI (4–7) or real
integrations (8–10).

## 5. Before this reaches the live site

- After pushing, run the seed once on Render (`SEED_ON_START=true`, then set it back to `false`). It only adds
  rows and fills blanks. It never overwrites or deletes.
- It adds sample rows for any person who has none of that kind. On the live site that is the 500 sample people.
- Integration syncs never run on their own. They run only when an admin presses "sync" or calls the jobs endpoint
  with `include_syncs=true`, so no "record quarantined" notices appear by themselves. The startup jobs only send the
  usual "waiting for your approval" reminders.
- All sample activity rows have "seed" in their ids, so they can be told apart from real entries later.
