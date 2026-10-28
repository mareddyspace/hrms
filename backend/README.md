# TimeZ HRMS API (v1)

FastAPI + PostgreSQL (Neon). With no database set it uses a local SQLite file (`timez-dev.db`).

## Set up (Windows PowerShell, run inside `backend`)

```powershell
cd backend
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## Database

1. Open `.env` and paste your Neon connection string after `DATABASE_URL=`
   (Neon dashboard -> Connect -> connection string, starts with `postgresql://`). Leave it empty to use SQLite.
2. Create the tables: `python -m app.db_init`
3. Load the data: `python -m app.seed`
   - 500 people from `seed/TimeZ_500_Employee_Sample_HCM_Data.xlsx` (checked on load: unique IDs, managers exist,
     no loops, country and department counts match the summary sheets)
   - the 6 portal sign-in accounts as 6 more people, leave policies per country, holidays, sample leave
   - safe to run again; `python -m app.seed --reset-passwords` puts the demo passwords back and unlocks accounts

## Run

```powershell
uvicorn app.main:app --reload --port 8000
```

- Health: http://localhost:8000/health
- API docs: http://localhost:8000/docs (click Authorize and paste the `access_token` from `POST /api/v1/auth/login`)

Sign in with the portal's demo accounts, e.g. `babu.menon@timez.com` / `Employee@1184`.

## Connect the portal (front end)

The portal uses this API for sign-in, the People directory, Leave and leave notifications when `VITE_API_URL` is set.
Without it (as on Vercel today) everything stays in the browser as before.

1. In the repo root, create `.env.local` (git ignores it) with one line:
   `VITE_API_URL=http://localhost:8000`
2. Start the API (above), then the portal from the repo root: `npm run dev` (http://localhost:5173).
   Restart `npm run dev` after changing `.env.local`.
3. Sign in with a demo account (the quick "Sign in" buttons use the default passwords).

- The portal must be allowed in `CORS_ORIGINS` in `.env` (comma-separated; default `http://localhost:5173,http://localhost:5174`).
- Sign-in tokens are kept for the browser tab only (sessionStorage). After 5 wrong passwords the account is
  locked for 15 minutes; `python -m app.seed --reset-passwords` unlocks it.
- Don't put `VITE_API_URL` in `.env.production` until the API is hosted.

## Tests

```powershell
python -m pytest
```

Tests always use a temporary SQLite database, never the one in `.env`.

## Updating the seed files

`seed/accounts.json`, `leave_policies.json`, `holidays.json` and `countries.json` come from the front end.
From the repo root: `node --experimental-strip-types scripts/export-seed.mjs`
