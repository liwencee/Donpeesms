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
DATABASE_URL=postgresql://postgres.chhsrqazmzdwrtreskdp:T6QAxv1d5UO5XmzK@aws-0-eu-west-1.pooler.supabase.com:5432/postgres?connection_limit=3&pool_timeout=20
DIRECT_URL=postgresql://postgres.chhsrqazmzdwrtreskdp:T6QAxv1d5UO5XmzK@aws-0-eu-west-1.pooler.supabase.com:5432/postgres
JWT_SECRET=5ad1d02e7f3e170ca94d2c25d9f13e48d73610ea139ec7860db6dd51d90d0f0e57b8df1ec59fb50c65b71e2a088926b6186f6c9223fda74b2a84158335773cc5
JWT_REFRESH_SECRET=55a31e97127553da310fb32b0d487c697ef17491b41dd72ab1837d39dd73b45892214759c12776536c235dc469365565b92f097200893c1ab52f28a1c49ab13c
JWT_EXPIRES_IN=7d
JWT_REFRESH_EXPIRES_IN=30d
COOKIE_SECRET=3a4bf4a9cbf6bfcc0e2f2c8102e77b778ca08a71b3615762fbcbeef467f96f63
BCRYPT_ROUNDS=12
APP_NAME=DonPeeSMS
FRONTEND_URL=https://donpeesms.com
BACKEND_URL=https://donpeesms.com
SMS_PROVIDER=sureverifications
SURE_VERIFICATIONS_BASE_URL=https://sureverifications.com/api/v1
SURE_VERIFICATIONS_API_KEY=YOUR_REAL_KEY
PRICE_MARKUP=1.4
LOG_LEVEL=info
```

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
