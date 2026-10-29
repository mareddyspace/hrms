# TimeZ HRMS — Project Guide

A plain-language guide to what was built, how it fits together, which accounts and keys it uses, and how it is deployed.
No passwords or keys are written in this file.

---

## 1. What TimeZ is

TimeZ is an HR portal for a company: one website where employees, managers, HR, recruiters, admins and the CEO do
their HR work. The sample company has **500 employees in 8 countries** (India, USA, UK, Australia, Canada, UAE,
Saudi Arabia, Germany), loaded from the Excel file `TimeZ_500_Employee_Sample_HCM_Data.xlsx`.

It has two halves:

| Part | What it is | Technology | Where it runs |
|---|---|---|---|
| **Front end** (the portal) | The screens people see and click | React + TypeScript + Vite | **Vercel** — https://hrms-lemon-mu.vercel.app |
| **Back end** (the API) | Sign-in, permissions, rules, approvals, AI, saving data | Python + FastAPI | **Render** — https://timez-hrms-api.onrender.com |

The back end stores data in a **Neon PostgreSQL** database, files in **Backblaze B2**, and asks **OpenRouter** for AI
answers.

---

## 2. How the pieces connect

```
 Person opens https://hrms-lemon-mu.vercel.app
          │
          ▼
 ┌──────────────────────────┐
 │ VERCEL — front end       │  screens, forms, buttons
 └────────────┬─────────────┘
              │  HTTPS requests (VITE_API_URL)
              ▼
 ┌──────────────────────────┐
 │ RENDER — back end (API)  │  sign-in, permissions, approvals, AI, audit
 └──┬──────────┬─────────┬──┘
    │          │         │
    ▼          ▼         ▼
  NEON     BACKBLAZE  OPENROUTER
 database    files     AI model
```

- The front end never talks to the database directly; everything goes through the API, which checks who you are and
  what you may see.
- **GitHub** (`mareddyspace/hrms`) holds the code. Vercel and Render both build from the `main` branch automatically.

---

## 3. What we built — front end

### Look and navigation
- Renamed everything to **TimeZ** (logo, sign-in, emails `@timez.com`).
- Sidebar with every page by name, plus a horizontal section bar on top.
- Sign-in page: each test account has a **Fill** button that fills email + password; then press **Sign in**.
- Every Submit / Save / Approve button shows **"Submitting…" → "✓ Submitted"** and a confirmation message.

### Modules (pages)
| Area | What people can do |
|---|---|
| Home | Role-based dashboard, "Today's summary", quick actions |
| My profile | Personal, employment and background details; edit allowed fields; request corrections; masked personal data |
| People / Employee 360 | Company directory, full record per permission, AI summary |
| Organization, Jobs & positions | Org tree with history and "as of date", positions, job profiles, job-description writer |
| Recruiting | Requisitions with approvals, candidate pipeline cards, CV reading, match to job, compare candidates, interviews, offers |
| Onboarding | Joiners, 10-step checklist, pre-boarding form, onboarding analytics |
| Lifecycle actions | Transfer, promotion, manager/job/location change, leave of absence, rehire, probation completion |
| Time & attendance | Check-in/out, corrections, monthly summary |
| Leave | Apply, approve (Manager → HR when needed), balances, eligibility rules, holidays, encashment |
| Timesheets | Log time to projects/tickets/tasks, submit week, manager approval, utilization |
| Shifts | Roster, publish with coverage check, swaps |
| Performance | Cycles, goals, 1:1s, 360 feedback, ratings, development actions |
| Learning, Skills & career | Courses, certifications, skills library, career interests, role matches |
| Compensation, Benefits | Pay history (restricted), review cycles, benefits, dependents, nominees |
| Documents & letters | Upload documents, request letters, approval, PDF download |
| Travel & expenses | Travel requests, expense claims with receipts, multi-step approval, paid status |
| HR cases, Helpdesk | Confidential cases, HR requests with due times (SLA) |
| Surveys, Recognition | Pulse surveys, kudos with points and rewards |
| Approvals | One inbox for everything waiting on you; delegation while away |
| Analytics, AI Copilot, AI Agents | Reports and charts; Copilot answers with sources |
| Admin | Roles & permissions, approval steps, leave policies, country settings, AI settings, integrations, payroll status, email outbox, audit log, two-step sign-in, signed-in devices |

### How the front end works
- **Two modes**: if `VITE_API_URL` is set, it uses the back end (real shared data). If not, it runs on browser
  storage (each browser has its own copy) — useful for offline demos.
- Code lives in `src/` — pages in `src/pages`, data stores in `src/data`, back-end connectors in `src/api`.

---

## 4. What we built — back end

### Structure (`backend/`)
| Folder / file | Purpose |
|---|---|
| `app/main.py` | Starts the API, registers all routes |
| `app/models/` | Database tables (about 100) |
| `app/routers/` | API endpoints (`/api/v1/...`) — see https://timez-hrms-api.onrender.com/docs |
| `app/services/` | Business rules (leave counting, approvals, masking, AI context…) |
| `migrations/versions/` | Database changes 0001 → 0013 (run automatically on start) |
| `app/seed*.py`, `seed/` | Starting data: the Excel employees, 6 logins, policies, holidays, sample requests |
| `tests/` | 243 automatic tests |

### Main features
- **Sign-in & security**: hashed passwords (argon2), lock after 5 wrong tries, 30-minute tokens with refresh,
  90-day password change, optional two-step sign-in (MFA), signed-in devices list, security headers.
- **Permissions**: each person sees only what their role and data scope allow (own / team / department / country /
  legal entity / business unit / location / global). Directory shows basic details of everyone.
- **Personal data masking**: phone, personal email, date of birth, address, emergency phone, ID numbers are masked;
  owner and HR can reveal (HR reveals are audited).
- **Approval engine**: steps like Manager → HR → Finance, parallel steps, conditions (amount, country, department,
  grade), "only when HR is needed", delegation, reminders, overdue escalation, nobody approves twice.
- **Audit log**: every change (who, what, when, before/after, result) — never secret values.
- **AI Copilot**: builds a context of only the data the person may see + matching company policies, asks the AI
  model, shows sources, logs the question. Falls back to built-in answers if the AI is slow or unavailable.
- **Files**: receipts, CVs, documents, letter PDFs stored in Backblaze B2.
- **Scheduled jobs on start / admin button**: reminders, SLA escalation, case retention, leave carry-forward.

---

## 5. Services, accounts and keys

| Service | Used for | Where you got it | Key / value | Where it is kept |
|---|---|---|---|---|
| **GitHub** | Code storage | github.com/mareddyspace/hrms | — | — |
| **Vercel** | Hosts the front end | vercel.com (project `hrms`) | `VITE_API_URL` = `https://timez-hrms-api.onrender.com` (not secret) | Vercel → Settings → Environment Variables |
| **Render** | Runs the back end | render.com (signed up with GitHub), Blueprint `timez`, service `timez-hrms-api`, region **Ohio** | All back-end settings below | Render → timez-hrms-api → Environment |
| **Neon** | PostgreSQL database | neon.tech, project `timez-hrms`, region AWS us-east-2 (Ohio) | `DATABASE_URL` (secret) | `backend/.env` on your PC + Render |
| **Backblaze B2** | File storage | backblaze.com (free, no card), private bucket | `S3_ENDPOINT_URL`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID` (keyID), `S3_SECRET_ACCESS_KEY` (applicationKey, secret) | Render (and your Notepad) |
| **OpenRouter** | AI model for Copilot | openrouter.ai → Keys | `OPENROUTER_API_KEY` (secret), `AI_MODEL`, `AI_MODEL_FALLBACKS` | `backend/.env` + Render |
| — | Signs sign-in tokens | Generated by Render / random text | `JWT_SECRET` (secret) | `backend/.env` + Render |

Other back-end settings (not secret): `CORS_ORIGINS` (which websites may call the API —
`https://hrms-lemon-mu.vercel.app,http://localhost:5173,http://localhost:5174`), `APP_ENV=production`,
`STORAGE_BACKEND=s3`, `RUN_MIGRATIONS_ON_START=true`, `DOCS_ENABLED=true`, `OTP_DEV_ECHO=false`, `PYTHON_VERSION`.

AI models (all free):
- `AI_MODEL` = `nvidia/nemotron-3-ultra-550b-a55b:free`
- `AI_MODEL_FALLBACKS` = `nvidia/nemotron-3.5-lightning:free,dots-studio/dots-3-note-preview:free,google/gemma-4-31b-it:free`
- "Thinking" is switched off in the code so answers come in about 1–3 seconds.

**Rules for secrets**
- Never put keys in code or in GitHub. `backend/.env` is ignored by git.
- Never paste keys in chats or screenshots. If one is exposed, replace it (new key / new value) in Render and `.env`.

---

## 6. The 6 sign-in accounts (test only)

| Person | Role | Email | Password |
|---|---|---|---|
| Babu Menon | Employee (reports to Ram) | babu.menon@timez.com | Employee@1184 |
| Ram Krishnan | Manager (reports to Jordan) | ram.krishnan@timez.com | Manager@1001 |
| Farhan Ali | HR | farhan.ali@timez.com | HrAdmin@2001 |
| Sophie Clark | Recruiter | sophie.clark@timez.com | Recruiter@3001 |
| Jordan Blake | CEO | jordan.blake@timez.com | Executive@5001 |
| Alex Morgan | Admin | alex.morgan@timez.com | Admin@8001 |

These are public test logins. Before real employees use the portal, give everyone their own login and remove or
change these. To reset them: `python -m app.seed --reset-passwords` (in `backend`).

---

## 7. How it was deployed

1. **Database (Neon)**: created a free project, copied the pooled connection string into `backend/.env`.
   Tables were created with `python -m app.db_init` and data loaded with `python -m app.seed`.
2. **Files (Backblaze B2)**: created a private bucket and an application key with Read and Write access to it.
3. **Code to GitHub**: committed and pushed, merged `fix/module-audit` into `main`.
4. **Back end (Render)**: New → Blueprint → repo `mareddyspace/hrms`, branch `main`, file `render.yaml`.
   Filled the environment settings (section 5). Moved the service to **Ohio** (same region as Neon) — this made
   pages about 8× faster. Health check: https://timez-hrms-api.onrender.com/health.
5. **Front end (Vercel)**: added `VITE_API_URL` = the Render address (Production + Preview) and redeployed.

### Updating the live site later
1. Change code on your PC, test at http://localhost:5173.
2. `git add -A` → `git commit -m "..."` → `git push`, then merge into `main` on GitHub.
3. Vercel and Render rebuild automatically from `main` (Render also runs new database migrations on start).

### Running everything on your PC
```
cd C:\Users\Gayathri\OneDrive\Desktop\hrmsspare\backend
.\.venv\Scripts\python.exe -m uvicorn app.main:app --port 8000
```
In a second terminal:
```
cd C:\Users\Gayathri\OneDrive\Desktop\hrmsspare
npm run dev
```
Then open http://localhost:5173. Your PC and the live site use the **same Neon database**.

---

## 8. Free-plan limits

| Limit | Effect |
|---|---|
| Render free sleeps after 15 min idle | First request after that takes ~30–50 s. A free uptime pinger (e.g. uptimerobot.com → `/health` every 5 min) keeps it awake. |
| Free AI models | Usually 1–3 s; if all are busy, Copilot shows a "Built-in" answer. |
| No email service yet | Notifications/verification codes are queued in the email outbox but not sent; phone/email changes need a code, so they can't be finished online yet. |
| Neon free | Pauses when idle (adds ~1 s), enough storage for testing. |
| Backblaze free | 10 GB of files. |

---

## 9. What is not done yet

- Real email sending (e.g. Resend, free) — needed for verification codes and email notifications.
- Logins for all 500 employees (kept to 6 by choice).
- Company sign-in (SSO), real connections to Teams/Slack/job portals/payroll providers (currently simulated).
- AI orchestrator that performs actions through tools; smart document search (embeddings / pgvector).
- Different weekend days per country (Fri–Sat in UAE/Saudi) in leave counting.
- Payroll provider names per country are "Not set" — set them in Payroll (admin).
