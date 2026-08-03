# DonPeeSMS Backend Rewrite — Supabase Auth + Data Design

## Context

The current backend (Express + Prisma, deployed on Hostinger, Postgres on Supabase)
has been the source of repeated production outages: Prisma's binary query engine
has had compatibility issues on Hostinger, and tuning Prisma's connection pool
(`connection_limit`) against Supabase's pooler has been a recurring source of
timeouts and, most recently, a total site outage whose root cause was never
conclusively identified. There are no real users in production yet, which
removes the need for a careful phased migration — this is a clean rewrite and
cutover.

**Goal:** eliminate the entire class of Prisma/connection-pooling failures by
moving off Prisma and off custom auth, onto Supabase Auth (used directly by the
frontend) and `supabase-js` (used by the backend over HTTPS, no persistent DB
connection held by the Node process).

## Architecture

Three pieces, cleanly separated:

- **Frontend (Vercel)** — existing vanilla JS SPA, unchanged except the auth
  pages. Login/register/forgot-password/reset-password/2FA are rewritten to
  call `supabase-js` directly. After login the frontend holds a Supabase
  session (JWT) and sends it as `Authorization: Bearer <token>` on every
  request to the Hostinger API.

- **Backend (Hostinger/Express)** — a thin business-logic API with no
  authentication logic of its own. A single middleware verifies the incoming
  Supabase JWT and attaches the user/profile to `req.user`. Everything else
  (wallet, SMS number ordering, products, admin CRUD, orders, payments) is the
  existing business logic, querying Supabase instead of Prisma.

- **Data + Auth (Supabase)** — `auth.users` (passwords, sessions, MFA, email
  verification, password reset — all managed by Supabase) plus a `profiles`
  table for app-specific fields, linked 1:1 to `auth.users.id`. Business
  tables are plain Postgres tables, accessed from Express via `supabase-js`
  with the **service-role key**.

This removes Prisma's binary engine and Node-side connection pooling
entirely — the backend makes HTTPS calls to Supabase's PostgREST API instead
of holding open Postgres connections, so there is no `connection_limit` to
tune and no idle-connection-drop class of bug to chase.

## Auth Flow

- Register/login/logout/session refresh: frontend calls Supabase Auth
  directly via `supabase-js`. No backend involvement.
- 2FA: Supabase Auth's built-in MFA (TOTP), enrolled/verified directly from
  the frontend. The custom `totpService.js` and its backup-codes flow are
  dropped; account recovery relies on Supabase's standard recovery flow.
- Email verification / password reset: Supabase's built-in flows, triggered
  and handled directly by the frontend. Custom SMTP-based verification and
  reset-token logic is removed from the backend.
- Backend authentication: a single `protect` middleware verifies the bearer
  token via `supabase.auth.getUser(token)`, then fetches the matching
  `profiles` row via `supabase-js`. `requireRole` reads `profiles.role`.
  `apiKeyAuth` (for the `/api/v1/*` developer endpoints) keeps its existing
  logic, just querying the `api_keys` table via `supabase-js` instead of
  Prisma — this is a separate, non-Supabase-Auth concern and is unaffected by
  the rest of this rewrite.

No real users exist yet, so there is no account-migration workstream —
Supabase Auth starts empty.

## Database Schema

Plain SQL, no Prisma migrations. Mapped from the current Prisma models:

```sql
-- profiles: 1:1 with auth.users, created via trigger on signup
create table profiles (
  id                 uuid primary key references auth.users(id) on delete cascade,
  username           varchar(30) unique not null,
  first_name         varchar(50) not null,
  last_name          varchar(50) not null,
  role               text not null default 'user',       -- user | admin | support
  status             text not null default 'active',     -- active | suspended | banned
  wallet_balance     numeric not null default 0,
  referral_code      text unique,
  referred_by_id     uuid references profiles(id) on delete set null,
  referral_earnings  numeric not null default 0,
  telegram           text,
  avatar_url         text,
  last_login         timestamptz,
  last_login_ip      text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table transactions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references profiles(id) on delete cascade,
  type             text not null,       -- topup | purchase | refund | referral_payout | admin_adjustment
  amount           numeric not null,    -- signed
  currency         text not null default 'NGN',
  balance_after    numeric not null,
  currency         text not null default 'USD',
  method           text not null,       -- stripe | paypal | nowpayments | wallet | bonus | manual | system
  external_id      text,
  external_status  text,
  order_id         uuid references orders(id) on delete set null,
  crypto_currency  text,
  crypto_amount    numeric,
  crypto_address   text,
  crypto_tx_hash   text,
  bonus_amount     numeric not null default 0,
  status           text not null default 'pending',
  description      text,
  metadata         jsonb not null default '{}',
  ip_address       text,
  user_agent       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table orders (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references profiles(id) on delete cascade,
  order_id          text unique not null,   -- human-readable: NV123456...
  provider          text not null,
  provider_order_id text,
  service_type      text not null,          -- whatsapp | sms
  service           text,
  country           varchar(4) not null,
  operator          text,
  phone_number      text not null,
  provider_cost     numeric not null,
  user_cost         numeric not null,
  currency          text not null default 'USD',
  sms_messages      jsonb not null default '[]',
  otp_code          text,
  status            text not null default 'pending',
  expires_at        timestamptz,
  activated_at      timestamptz,
  completed_at      timestamptz,
  cancelled_at      timestamptz,
  refunded_at       timestamptz,
  refund_reason     text,
  refund_tx_id      text,
  ip_address        text,
  user_agent        text,
  metadata          jsonb not null default '{}',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table api_keys (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references profiles(id) on delete cascade,
  name         varchar(50) not null,
  key_prefix   text not null,
  key_hash     text not null,   -- sha256 of the raw key
  scopes       text[] not null default '{}',
  last_used_at timestamptz,
  last_used_ip text,
  usage_count  int not null default 0,
  active       boolean not null default true,
  expires_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table categories (
  id          uuid primary key default gen_random_uuid(),
  name        varchar(80) unique not null,
  slug        varchar(80) unique not null,
  icon        text,
  sort_order  int not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table products (
  id           uuid primary key default gen_random_uuid(),
  name         varchar(160) not null,
  description  text,
  price        numeric not null,   -- stored in USD; UI displays Naira via app rate
  image_url    text,
  color        text,
  stock        int not null default -1,  -- -1 unlimited, 0 out of stock, >0 quantity
  stock_label  text,
  api_provider text not null default 'manual',
  enabled      boolean not null default true,
  featured     boolean not null default false,
  sort_order   int not null default 0,
  metadata     jsonb not null default '{}',
  category_id  uuid references categories(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table api_providers (
  id          uuid primary key default gen_random_uuid(),
  name        varchar(80) unique not null,
  slug        varchar(80) unique not null,
  base_url    text not null,
  auth_header text not null default 'x-api-key',
  api_key_enc text,   -- encrypted, same utils/crypto.js AES-256-GCM scheme
  notes       text,
  enabled     boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- indexes mirroring the current Prisma @@index directives
create index on transactions (user_id, created_at);
create index on transactions (type, status);
create index on transactions (external_id);
create index on orders (user_id, created_at);
create index on orders (status, expires_at);
create index on orders (provider, provider_order_id);
create index on orders (phone_number);
create index on api_keys (user_id);
create index on api_keys (key_prefix);
create index on api_keys (key_hash);
create index on categories (slug);
create index on categories (active);
create index on products (enabled);
create index on products (category_id);
create index on products (sort_order);
create index on api_providers (slug);
create index on api_providers (enabled);
```

Row Level Security is enabled on every table, with policies scoping rows to
their owning user (`auth.uid() = user_id`). The Express backend uses the
service-role key, which bypasses RLS — this is defense-in-depth in case the
frontend or anon key ever touches these tables directly.

A Postgres trigger on `auth.users` insert creates the matching `profiles` row
(mirrors the `handle_new_user` pattern Supabase's own docs recommend).

## Data Access Layer

`config/supabase.js` replaces `config/db.js`:

```js
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
module.exports = { supabase };
```

Controllers call it directly, e.g.:

```js
const { data, error } = await supabase.from('orders').select('*').eq('user_id', userId);
if (error) throw new ApiError(500, error.message);
```

Atomic multi-step operations (e.g. "debit wallet and create order together")
are implemented as Postgres functions and invoked via
`supabase.rpc('purchase_number', { ... })`, so correctness doesn't depend on
application-level transactions.

## Backend Component Inventory

**Removed:**
- `controllers/authController.js`
- `utils/jwt.js`
- `services/totpService.js`
- `config/db.js`, `prisma/` (schema, migrations, generated client), the
  `@prisma/client` and `prisma` npm packages

**Rewritten (same responsibility, Supabase instead of Prisma):**
- `middleware/auth.js` — `protect` verifies the Supabase JWT and fetches
  `profiles`; `requireRole` and `apiKeyAuth` keep their logic, swap the
  data source.
- `controllers/{admin,apiProvider,number,product,user,wallet}Controller.js`
  — same business logic, `prisma.*` calls become `supabase.from(...)` calls.
- The 60-second background job in `server.js` (auto-expire stale orders +
  refund) — same logic against `supabase.from('orders')`.

**Unchanged:**
- `services/{nowPayments,paypal,stripe,smsProvider}.js` — external API
  clients, no DB access.
- `middleware/{errorHandler,rateLimiter,validate}.js` — `errorHandler.js`
  gets its Prisma-error-code branch replaced with a PostgREST-error-shape
  branch.
- The log-only `uncaughtException`/`unhandledRejection` handlers in
  `server.js` (the actual root-cause fix from earlier this session) —
  unrelated to the DB layer, carried forward as-is.

**Trimmed:**
- `services/emailService.js` — keeps only business/transactional emails (if
  any are wanted, e.g. order confirmations); verification/reset emails move
  to Supabase's built-in flows.

**Logging fix folded in:** the current code logs `logger.error('Prisma:',
e.message)`, which we found produces empty log entries when `e.message` is
blank — a real gap that left an active incident undiagnosable from the logs.
The rewrite logs the full error (`err.stack` / `JSON.stringify(err)` /
Supabase's `error.code` + `error.details`) everywhere, not just `.message`.

## Error Handling & Resilience (carried forward)

These were already correct and are not being changed:
- `uncaughtException` / `unhandledRejection` handlers log and continue —
  never call `process.exit()` or a `shutdown()` that tears down the server.
- Server always calls `start()` unconditionally outside of `NODE_ENV=test`,
  regardless of how Hostinger loads the file.
- Malformed JSON / oversized body → clean 400/413, not a 500.

## Testing

- Existing smoke test suite (`tests/smoke.test.js`, `tests/config.test.js`)
  is updated to assert against the new middleware (Supabase JWT verification
  instead of custom JWT) and drops any Prisma-specific assertions.
- `tests/setup.js` sets dummy Supabase env vars instead of a dummy
  `DATABASE_URL`.
- New unit coverage for the `protect` middleware against a mocked Supabase
  client (valid token, expired token, missing profile row).
- CI (`ci.yml`) unchanged in shape — same "parse every file, run smoke
  tests" gate, just against the new dependency set.

## Rollout

Since there are no real production users or data to preserve, this is a
clean cutover rather than a phased migration:

1. Provision the schema above in Supabase (SQL migration + RLS policies +
   the `handle_new_user` trigger).
2. Build the rewritten backend on a branch, verified locally against the
   real Supabase project.
3. Update the frontend's auth pages to use `supabase-js` and switch the
   Vercel deployment's API base to the same Hostinger domain (unchanged —
   only the auth pages change; business-data endpoints keep their existing
   URLs/contracts).
4. Deploy the new backend to Hostinger via the existing GitHub auto-deploy,
   replacing the current Prisma-based code.
5. Manually verify each flow end-to-end (signup, login, 2FA, wallet topup,
   number purchase, admin CRUD, payment webhooks) before considering the
   cutover complete.

## Out of Scope

- No account/data migration (no real users exist yet).
- No change to the SMS provider integration logic itself (SureVerifications
  etc.) beyond swapping its DB calls.
- No change to payment provider integrations (Stripe/PayPal/NOWPayments)
  beyond swapping their DB calls.
- Custom 2FA backup codes are not preserved — Supabase MFA's own recovery
  flow replaces them.
