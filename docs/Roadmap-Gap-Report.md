# TimeZ HRMS — Roadmap Gap Check and Full Application Test

Date: 6 November 2026 · Compared against your design document "HRMS Roadmap and Execution and sample company step by
step process document.docx" (all 73 sections). Testing used a scratch copy of the sample data only; the live site and
the live database were not touched. Nothing in the app was changed by this check.

---

## 1. The short answer

- **Most of the roadmap is built.**

  | Sections | Topic | Present | Partial | Missing | Detail |
  |---|---|---|---|---|---|
  | 1–24 | Modules | 338 | 23 | 7 | [table A](roadmap-gaps/roadmap-gaps-A.md) |
  | 25–48 | Workflows, roles, AI, analytics, localization, integrations | 114 | 66 | 24 | [table B](roadmap-gaps/roadmap-gaps-B.md) |
  | 49–73 | Data, security, administration, MVP, decisions | 178 | 96 | 21 | [table C](roadmap-gaps/roadmap-gaps-C.md) |

  Every row in those tables has a file path as evidence.
- **The core HR modules are complete:** people, organization, recruiting, onboarding, attendance, leave, timesheets,
  performance, learning, skills, compensation, benefits, documents and workflows.
- **The gaps are mostly in the "platform" layer:** true AI (RAG, agents, AI actions), real integrations (SSO, webhooks,
  live connectors), configurable roles, and server-side analytics.
- **Every person's application works.** All 8 people signed in, and I opened every page in each person's menu:
  **453 pages, 0 crashes, 0 "not authorized", 0 server errors.** The earlier 204 rule checks also passed
  ([Role-Test-Report.md](Role-Test-Report.md)).

## 2. Application test per person

| Person | Role | Home page | Pages in menu | Problems |
|---|---|---|---|---|
| Babu | Employee | Employee home | 47 | 0 |
| Priya | Employee (India) | Employee home | 47 | 0 |
| Oliver | Employee (UK) | Employee home | 47 | 0 |
| Ram | Manager | Manager home | 56 | 0 |
| Farhan | HR Admin | HR home | 70 | 0 |
| Sophie | Recruiter | Recruiter home | 52 | 0 |
| Jordan | CEO | Executive home | 58 | 0 |
| Alex | Super Admin | Admin home | 76 | 0 |

**How:**
- Signed in with each person's sign-in card on a local copy, then opened every link in their sidebar, one by one.
- Recorded any page that crashed, said "not authorized" or "not found", logged a browser error, or got a 4xx/5xx
  answer from the server.
- I checked separately that the error recording really sees the portal's server calls.

**Correction to the earlier audit:** Jordan's "Exits" page is not broken. For an executive it loads only his own
team's exits, and the server does not refuse it.

## 3. The gaps that matter most

Effort: **S** = under a day, **M** = 1–3 days, **L** = a week or more.

### A. Things people will notice (do these first)

| # | Gap (roadmap section) | What is there today | Effort |
|---|---|---|---|
| 1 | **No way to create sign-in accounts or change someone's role** (§27, §66). Verified: no endpoint creates an account or sets a role. | Only the accounts in `backend/seed/accounts.json` exist. A new hire or new HR person can't get a login without editing the database. | M |
| 2 | **HR dashboard attendance trends are wrong in production** (§7, §16). | In backend mode the portal loads only the signed-in person's own attendance (`src/api/syncAttendance.ts:148`), so company-wide charts don't reflect everyone. | S |
| 3 | **Leave correction** (§17). Verified: leave has cancel only, no change. | Changing dates means cancelling and applying again. | S |
| 4 | **Profile shows Job Profile and Dependents as blank** (§8). | `src/api/portalSync.ts:66,93` fills them with empty values, though benefits has the real dependents. | S |
| 5 | **Training programs and training requests** (§20). | Only single courses; no request-and-approve flow. | M |
| 6 | **Joiner can't upload documents during onboarding** (§14). | Only an HR task and a status label. | S |
| 7 | **Other admin roles get the employee home and are not real on the server** (§7, §27). | L&D Admin, Performance Admin and Compliance/Audit exist only in the portal (`src/model.ts`, `src/data/rbac.ts`). The Compensation and Payroll role names don't match between the portal and the server. | M |

### B. AI (§31–42, §57–58): the roadmap's biggest promise, mostly simplified

| # | Gap | Today | Effort |
|---|---|---|---|
| 8 | **Policy answers aren't real RAG.** Verified. | Keyword matching over a fixed `backend/seed/policies.json` (`services/policy_kb.py`). Policies HR publishes in the portal and approved documents are not searched. No embeddings or vector store. | L |
| 9 | **The 8 AI agents are one assistant** with a different instruction line each. There's no orchestrator and no AI actions on the server. | `services/ai_agents.py`. Prepare-confirm-execute happens only in the browser. | L |
| 10 | **Natural-language analytics** runs as rules in the browser, not as controlled server queries. | `src/features/copilot/analytics.ts` | M |
| 11 | **Missing AI features:** position analysis (§12), the onboarding assistant (§14), goal drafting (§19), and a performance/360 feedback summary (§19). | None of these exist (only interview feedback has a summary). | M each |
| 12 | **AI audit** stores 80 characters of the question, not the data used or the final action (§55). | `audit_log` rows | S |

### C. Integrations and security platform (§48, §55, §66)

| # | Gap | Today | Effort |
|---|---|---|---|
| 13 | **SSO / identity integration** (MVP item). | A disabled button only (`src/pages/InfoPages.tsx:274`). | L |
| 14 | **Connectors are simulated.** No webhooks, no events, no API keys for partner systems. | `services/integrations.py` | L |
| 15 | **Email is never actually sent.** It is queued in the outbox, with no SMTP. | `email_outbox` table | S–M |
| 16 | **Bulk import, report builder and locale settings save only in the browser.** | `src/features/datatools/bulkStore.ts`, `src/locale/LocaleContext.tsx` | M |
| 17 | **Settings that are hard-coded instead of configurable:** employment types, attendance rules, security policies, grades (no grade master), and allowances. | Constants in code | M |
| 18 | **Analytics are computed in the browser.** They won't scale past a few thousand employees. | Analytics pages | M |

### D. Deliberate or accepted differences (not to fix unless you want to)

- **Payroll processing was built**, although the roadmap (§49, Decision 8) says payroll processing is out of scope for
  V1 and only an integration-ready tab is needed. The tab exists too.
- **Admin has full HR data access:** your decision of 3 November, which is wider than the roadmap's "platform scope".
- **The tech stack differs from the suggestions in §53:** no Tailwind, Redis, Kafka, pgvector or Docker. These were
  suggestions, and the app works without them.
- **Languages:** only about 20 screen texts are translated; other languages are marked "Preview".
- **9-hour attendance stop:** your new rule. Overtime beyond 9 hours now needs an overtime request.

## 4. Suggested order

1. **Quick fixes (about 2–3 days):** #2 attendance trends, #3 leave correction, #4 profile blanks, #6 onboarding
   upload, #12 AI audit detail.
2. **Account and role management (about 1 week):** #1 and #7, which fit the Super Admin console work already planned
   (User & Admin Management).
3. **Then pick one big track:** real AI (RAG with embeddings, server-side agents), **or** real integrations (SSO, SMTP
   email, webhooks). Each is a multi-week effort.
