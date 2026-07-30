# Deploying DonPeeSMS to Railway

The backend (Express + Prisma) and the frontend (static SPA in `public/`)
run as **one** Railway service. The database stays on **Supabase** — no
migration, same data.

## 1. Create the project
1. Go to https://railway.com → **New Project** → **Deploy from GitHub repo**
2. Authorize Railway to access GitHub and pick **liwencee/Donpeesms**
3. Railway auto-detects Node, runs `npm install` (which runs
   `prisma generate`) and starts with `npm start`. `railway.json` pins the
   start command and a `/health` health check.

## 2. Set environment variables
Railway → your service → **Variables** → add these. Railway sets `PORT`
automatically, so you do **not** add it.

```
NODE_ENV=production
DATABASE_URL=postgresql://<user>:<password>@<host>:5432/postgres?connection_limit=3&pool_timeout=20
DIRECT_URL=postgresql://<user>:<password>@<host>:5432/postgres
JWT_SECRET=<generate with: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))">
JWT_REFRESH_SECRET=<generate the same way — must differ from JWT_SECRET>
JWT_EXPIRES_IN=7d
JWT_REFRESH_EXPIRES_IN=30d
COOKIE_SECRET=<generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
BCRYPT_ROUNDS=12
APP_NAME=DonPeeSMS
FRONTEND_URL=https://donpeesms.com
BACKEND_URL=https://donpeesms.com
SMS_PROVIDER=sureverifications
SURE_VERIFICATIONS_BASE_URL=https://sureverifications.com/api/v1
SURE_VERIFICATIONS_API_KEY=<your real key — never commit this>
PRICE_MARKUP=1.4
LOG_LEVEL=info
```

> ⚠️ **Never commit real secret values to this (or any tracked) file.**
> This repo is public — anything committed here is visible to anyone,
> forever, even after the file is edited (git history retains it).
> Fill in real values only in your host's environment-variable panel.

Add SMTP vars too when email is ready (SMTP_HOST/PORT/USER/PASS/
SMTP_FROM_NAME/SMTP_FROM_EMAIL).

## 3. Generate a domain / point donpeesms.com
- Railway → service → **Settings → Networking → Generate Domain**
  gives you a `*.up.railway.app` URL to test immediately.
- To use **donpeesms.com**: Railway → **Custom Domain** → enter
  `donpeesms.com`. Railway shows a CNAME target. Add that CNAME at your
  DNS provider (where donpeesms.com's DNS is managed) and wait for it to
  verify. Remove the old Hostinger A/CNAME record for the domain.

## 4. Verify
- Open the Railway domain → the site should load.
- `<domain>/health` → JSON `{ status: "ok", ... }`
- `<domain>/api/dbcheck` → `{ ok: true, ... }` once the DB connects.

## Notes
- `PORT` is provided by Railway; the app reads `process.env.PORT`.
- Deploys are automatic on every push to `main`.
- Logs: Railway → service → **Deployments / Logs** (real-time, unlike
  Hostinger's).
