# TimeZ — AI-Powered Global HR Portal

TimeZ is a full HR management system (HRMS / HCM) for a multinational company: one portal where employees,
managers, HR, recruiters, admins and executives do all their HR work. The sample company has **500 employees across
8 countries** (India, USA, UK, Australia, Canada, UAE, Saudi Arabia, Germany).

**Live demo:** https://hrms-lemon-mu.vercel.app
**API docs:** https://timez-hrms-api.onrender.com/docs

> Demo sign-in: open the portal, click **Fill** on any account card, then **Sign in**.
> The free server may take ~30 s to wake up on the first visit.

---

## Features

**Self-service and team management**
- Role-based home dashboards with a daily summary
- Profile with masked personal data, self-edits and HR-approved corrections
- Company directory and Employee 360 view with an AI summary
- Attendance (check-in/out, corrections), leave (balances, eligibility rules, Manager → HR approvals), timesheets,
  shift rosters with coverage checks and swaps
- Travel requests and expense claims with receipts and multi-step approval

**Talent**
- Recruiting: requisition approvals, candidate pipeline, CV reading, job matching, candidate comparison,
  interviews, offers
- Onboarding with pre-boarding form and checklist; lifecycle actions (transfer, promotion, leave of absence, rehire)
- Performance (cycles, goals, 1:1s, 360 feedback, ratings, development plans), learning, skills library and career paths

**Rewards, documents and services**
- Compensation (restricted access, review cycles), benefits, dependents and nominees
- Documents and letters with approval and PDF generation
- Confidential HR cases, HR helpdesk with SLAs, surveys, recognition with points

**Platform**
- Configurable approval workflows (parallel steps, conditions, delegation, reminders, escalation)
- AI Copilot that answers from permitted data and company policies, with sources and an audit trail
- Roles & data scopes, audit log, two-step sign-in (MFA), session management, 90-day password rule
- Country settings, leave policy admin, integrations with failure quarantine, payroll status, email outbox

---

## Tech stack

| Layer | Technology | Hosting |
|---|---|---|
| Front end | React, TypeScript, Vite | Vercel |
| Back end | Python, FastAPI, SQLAlchemy, Alembic | Render |
| Database | PostgreSQL | Neon |
| File storage | S3-compatible object storage | Backblaze B2 |
| AI | LLMs via OpenRouter (permission-filtered context, policy retrieval) | — |

- 243 automated back-end tests (pytest)
- Security: argon2 password hashing, JWT with refresh rotation, TOTP MFA, account lockout, PII masking,
  security headers, per-request permission checks

---

## Project structure

```
src/                 front end (pages, data stores, API connectors)
backend/app/         FastAPI app (models, routers, services)
backend/migrations/  database migrations
backend/tests/       automated tests
docs/                project guide
render.yaml          Render deployment blueprint
```

## Run locally

```bash
# back end
cd backend
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
# create backend/.env from backend/.env.example (DATABASE_URL etc.)
.\.venv\Scripts\python.exe -m app.db_init
.\.venv\Scripts\python.exe -m app.seed
.\.venv\Scripts\python.exe -m uvicorn app.main:app --port 8000

# front end (new terminal, repo root)
npm install
npm run dev
```

Set `VITE_API_URL=http://localhost:8000` in `.env.local` to use the back end; without it the portal runs on
browser storage.

More detail: [docs/TimeZ-Project-Guide.md](docs/TimeZ-Project-Guide.md) and [DEPLOY.md](DEPLOY.md).
