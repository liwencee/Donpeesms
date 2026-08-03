# Supabase Backend Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Prisma + custom JWT auth with Supabase (`supabase-js` for data, Supabase Auth for authentication) across the DonPeeSMS backend, eliminating the connection-pooling and engine-compatibility issues that caused repeated Hostinger outages.

**Architecture:** Express stays the HTTP framework. All `prisma.*` calls become `supabase.from(...)` calls (or `supabase.rpc(...)` for the two operations that need atomicity). `protect` middleware verifies a Supabase-issued JWT instead of our own. The `profiles` table (snake_case columns) replaces the Prisma `User` model; a small case-mapper utility converts DB rows to the camelCase shape the frontend already expects, so business-data API responses are unchanged.

**Tech Stack:** Express (unchanged), `@supabase/supabase-js` (new), Postgres via Supabase (schema below), Jest + Supertest (existing, adapted).

**Scope note:** This plan covers the backend and database only. Login/register/2FA/password-reset UI in the frontend (`public/`) is **not** touched here — those pages keep calling the old (now-removed) `/api/auth/*` endpoints until a separate follow-up plan rewires them to `supabase-js` directly, per the design doc's rollout section. Do not start that work as part of this plan.

## Global Constraints

- No real users exist in production yet — no data/account migration is needed anywhere in this plan.
- Business-data API response shapes (orders, wallet, products, admin) must stay camelCase, matching what the frontend (untouched in this plan) already expects.
- Currency fields default to `USD` (matches `products.price`'s existing "stored in USD, displayed in Naira via app rate" convention — do not change this).
- Every new/changed file must keep the project's existing patterns: `asyncHandler` wrapping every route handler, `ApiError` for all thrown errors, `logger` (not `console`) for all logging, full error objects logged (not just `.message`) per the logging gap found during the outage investigation.
- The `uncaughtException` and `unhandledRejection` handlers in `server.js` must never call `process.exit()` or `shutdown()` (regression-guarded by `tests/config.test.js`) — this is specifically about those two crash handlers, not a ban on `process.exit()` in the intentional SIGTERM/SIGINT graceful-shutdown path, which legitimately exits after closing the server.

---

## Task 1: Supabase schema migration

**Files:**
- Create: `supabase/migrations/0001_init.sql`
- Create: `scripts/migrate.js`
- Modify: `package.json` (add `pg` devDependency, add `"db:migrate": "node scripts/migrate.js"` script)

**Interfaces:**
- Produces: the full Postgres schema (`profiles`, `transactions`, `orders`, `api_keys`, `categories`, `products`, `api_providers`), RLS policies, the `handle_new_user` trigger, and the `credit_wallet`/`debit_wallet` RPC functions that every later task depends on.

- [ ] **Step 1: Write the migration SQL**

Create `supabase/migrations/0001_init.sql`:

```sql
-- ═══════════════════════════════════════════════
-- PROFILES (1:1 with auth.users)
-- ═══════════════════════════════════════════════
create table profiles (
  id                 uuid primary key references auth.users(id) on delete cascade,
  username           varchar(30) unique not null,
  first_name         varchar(50) not null default '',
  last_name          varchar(50) not null default '',
  role               text not null default 'user',
  status             text not null default 'active',
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

create index profiles_username_idx on profiles (username);
create index profiles_referral_code_idx on profiles (referral_code);
create index profiles_created_at_idx on profiles (created_at);

-- ═══════════════════════════════════════════════
-- TRANSACTIONS
-- ═══════════════════════════════════════════════
create table transactions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references profiles(id) on delete cascade,
  type             text not null,
  amount           numeric not null,
  currency         text not null default 'USD',
  balance_after    numeric not null,
  method           text not null,
  external_id      text,
  external_status  text,
  order_id         uuid,
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

create index transactions_user_created_idx on transactions (user_id, created_at);
create index transactions_type_status_idx on transactions (type, status);
create index transactions_external_id_idx on transactions (external_id);

-- ═══════════════════════════════════════════════
-- ORDERS
-- ═══════════════════════════════════════════════
create table orders (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references profiles(id) on delete cascade,
  order_id          text unique not null,
  provider          text not null,
  provider_order_id text,
  service_type      text not null,
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
  refund_tx_id      uuid,
  ip_address        text,
  user_agent        text,
  metadata          jsonb not null default '{}',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table transactions add constraint transactions_order_id_fkey
  foreign key (order_id) references orders(id) on delete set null;

create index orders_user_created_idx on orders (user_id, created_at);
create index orders_status_expires_idx on orders (status, expires_at);
create index orders_provider_idx on orders (provider, provider_order_id);
create index orders_phone_idx on orders (phone_number);

-- ═══════════════════════════════════════════════
-- API KEYS
-- ═══════════════════════════════════════════════
create table api_keys (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references profiles(id) on delete cascade,
  name         varchar(50) not null,
  key_prefix   text not null,
  key_hash     text not null,
  scopes       text[] not null default '{}',
  last_used_at timestamptz,
  last_used_ip text,
  usage_count  int not null default 0,
  active       boolean not null default true,
  expires_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index api_keys_user_idx on api_keys (user_id);
create index api_keys_prefix_idx on api_keys (key_prefix);
create index api_keys_hash_idx on api_keys (key_hash);

-- ═══════════════════════════════════════════════
-- CATEGORIES + PRODUCTS + API PROVIDERS
-- ═══════════════════════════════════════════════
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

create index categories_slug_idx on categories (slug);
create index categories_active_idx on categories (active);

create table products (
  id           uuid primary key default gen_random_uuid(),
  name         varchar(160) not null,
  description  text,
  price        numeric not null,
  image_url    text,
  color        text,
  stock        int not null default -1,
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

create index products_enabled_idx on products (enabled);
create index products_category_idx on products (category_id);
create index products_sort_idx on products (sort_order);

create table api_providers (
  id          uuid primary key default gen_random_uuid(),
  name        varchar(80) unique not null,
  slug        varchar(80) unique not null,
  base_url    text not null,
  auth_header text not null default 'x-api-key',
  api_key_enc text,
  notes       text,
  enabled     boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index api_providers_slug_idx on api_providers (slug);
create index api_providers_enabled_idx on api_providers (enabled);

-- ═══════════════════════════════════════════════
-- ROW LEVEL SECURITY (defense-in-depth — the backend uses the
-- service-role key and bypasses these; this only matters if the anon
-- key or a direct frontend query ever touches these tables)
-- ═══════════════════════════════════════════════
alter table profiles     enable row level security;
alter table transactions enable row level security;
alter table orders       enable row level security;
alter table api_keys     enable row level security;
alter table categories   enable row level security;
alter table products     enable row level security;
alter table api_providers enable row level security;

create policy "own profile"      on profiles     for select using (auth.uid() = id);
create policy "own transactions" on transactions for select using (auth.uid() = user_id);
create policy "own orders"       on orders       for select using (auth.uid() = user_id);
create policy "own api keys"     on api_keys     for select using (auth.uid() = user_id);
create policy "public categories" on categories  for select using (active = true);
create policy "public products"   on products    for select using (enabled = true);
-- api_providers has no public policy: contains encrypted keys, service-role only.

-- ═══════════════════════════════════════════════
-- NEW USER TRIGGER — creates a profiles row when someone signs up via
-- Supabase Auth. The frontend's supabase.auth.signUp() call must pass
-- { data: { username, first_name, last_name, referral_code } } in
-- options — that's how these values reach raw_user_meta_data below.
-- (Wiring the frontend signUp call itself is out of scope for this plan.)
-- ═══════════════════════════════════════════════
create or replace function generate_referral_code(p_username text) returns text
language sql as $$
  select lower(p_username) || substr(md5(random()::text), 1, 4);
$$;

create or replace function handle_new_user() returns trigger
language plpgsql security definer as $$
declare
  v_username text;
begin
  v_username := coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1));

  insert into profiles (id, username, first_name, last_name, referral_code, referred_by_id)
  values (
    new.id,
    v_username,
    coalesce(new.raw_user_meta_data->>'first_name', ''),
    coalesce(new.raw_user_meta_data->>'last_name', ''),
    generate_referral_code(v_username),
    (select id from profiles where referral_code = new.raw_user_meta_data->>'referral_code')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ═══════════════════════════════════════════════
-- ATOMIC WALLET OPERATIONS — replace the two prisma.$transaction blocks
-- in the old walletController. Row-locked with `for update` so two
-- concurrent debits on the same user can't both read a stale balance.
-- ═══════════════════════════════════════════════
create or replace function credit_wallet(
  p_user_id uuid,
  p_amount numeric,
  p_bonus numeric,
  p_method text,
  p_external_id text,
  p_description text,
  p_order_id uuid,
  p_type text default 'topup'
) returns table (new_balance numeric, transaction_id uuid)
language plpgsql as $$
declare
  v_total numeric := round(p_amount + p_bonus, 2);
  v_new_balance numeric;
  v_tx_id uuid;
  v_referrer_id uuid;
  v_referrer_username text;
  v_commission numeric;
  v_referrer_balance numeric;
begin
  update profiles set wallet_balance = wallet_balance + v_total, updated_at = now()
    where id = p_user_id
    returning wallet_balance into v_new_balance;
  if not found then raise exception 'User not found'; end if;

  insert into transactions (user_id, type, amount, bonus_amount, balance_after, method, external_id, status, description, order_id)
  values (p_user_id, p_type, v_total, p_bonus, v_new_balance, p_method, p_external_id, 'success', p_description, p_order_id)
  returning id into v_tx_id;

  if p_type != 'refund' and p_method != 'bonus' then
    select referred_by_id, username into v_referrer_id, v_referrer_username from profiles where id = p_user_id;
    if v_referrer_id is not null then
      v_commission := round(p_amount * 0.10, 2);
      update profiles set wallet_balance = wallet_balance + v_commission,
                           referral_earnings = referral_earnings + v_commission,
                           updated_at = now()
        where id = v_referrer_id
        returning wallet_balance into v_referrer_balance;

      insert into transactions (user_id, type, amount, balance_after, method, status, description)
      values (v_referrer_id, 'referral_payout', v_commission, v_referrer_balance, 'system', 'success',
              'Referral commission from ' || v_referrer_username);
    end if;
  end if;

  return query select v_new_balance, v_tx_id;
end;
$$;

create or replace function debit_wallet(
  p_user_id uuid,
  p_amount numeric,
  p_order_id uuid,
  p_description text
) returns table (new_balance numeric, transaction_id uuid)
language plpgsql as $$
declare
  v_balance numeric;
  v_new_balance numeric;
  v_tx_id uuid;
begin
  select wallet_balance into v_balance from profiles where id = p_user_id for update;
  if not found then raise exception 'User not found'; end if;
  if v_balance < p_amount then raise exception 'Insufficient wallet balance'; end if;

  update profiles set wallet_balance = wallet_balance - p_amount, updated_at = now()
    where id = p_user_id
    returning wallet_balance into v_new_balance;

  insert into transactions (user_id, type, amount, balance_after, method, status, order_id, description)
  values (p_user_id, 'purchase', -p_amount, v_new_balance, 'wallet', 'success', p_order_id, p_description)
  returning id into v_tx_id;

  return query select v_new_balance, v_tx_id;
end;
$$;
```

- [ ] **Step 2: Write the migration runner script**

Create `scripts/migrate.js`:

```js
/**
 * One-time/idempotent schema migration runner.
 * Usage: node scripts/migrate.js
 * Reads DATABASE_URL from .env (the same Supabase Postgres connection
 * already used for direct-SQL access), applies every .sql file in
 * supabase/migrations/ in filename order, inside a single transaction.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'supabase', 'migrations');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set — check your .env file.');
    process.exit(1);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  console.log(`Found ${files.length} migration file(s): ${files.join(', ')}`);

  try {
    await client.query('BEGIN');
    for (const file of files) {
      console.log(`Applying ${file}...`);
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query(sql);
    }
    await client.query('COMMIT');
    console.log('All migrations applied successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed, rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
```

- [ ] **Step 3: Add `pg` as a devDependency and the `db:migrate` script**

In `package.json`, add to `devDependencies`:

```json
"pg": "^8.13.0"
```

And add to `scripts`:

```json
"db:migrate": "node scripts/migrate.js"
```

- [ ] **Step 4: Install and run the migration against the real Supabase database**

```bash
npm install
npm run db:migrate
```

Expected output: `Found 1 migration file(s): 0001_init.sql`, then `Applying 0001_init.sql...`, then `All migrations applied successfully.`

- [ ] **Step 5: Verify the tables exist**

```bash
node -e "require('dotenv').config(); const {Client}=require('pg'); const c=new Client({connectionString:process.env.DATABASE_URL}); c.connect().then(()=>c.query(\"select table_name from information_schema.tables where table_schema='public' order by table_name\")).then(r=>{console.log(r.rows.map(x=>x.table_name)); return c.end();})"
```

Expected: an array including `api_keys`, `api_providers`, `categories`, `orders`, `products`, `profiles`, `transactions`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0001_init.sql scripts/migrate.js package.json package-lock.json
git commit -m "feat: add Supabase schema migration (profiles, orders, wallet RPCs)"
```

---

## Task 2: Supabase client, env config, and case-mapper utility

**Files:**
- Create: `config/supabase.js`
- Create: `utils/caseMapper.js`
- Create: `tests/caseMapper.test.js`
- Modify: `config/env.js`
- Modify: `.env.example`
- Modify: `package.json` (add `@supabase/supabase-js` dependency)

**Interfaces:**
- Produces: `supabase` client (from `config/supabase.js`), `toCamelCase(obj)` / `toSnakeCase(obj)` (from `utils/caseMapper.js`) — every later controller task imports both.

- [ ] **Step 1: Add the dependency**

In `package.json` `dependencies`, add:

```json
"@supabase/supabase-js": "^2.45.4"
```

Run:

```bash
npm install
```

- [ ] **Step 2: Write the failing test for the case mapper**

Create `tests/caseMapper.test.js`:

```js
const { toCamelCase, toSnakeCase } = require('../utils/caseMapper');

describe('toCamelCase', () => {
  test('converts snake_case keys to camelCase', () => {
    expect(toCamelCase({ first_name: 'A', wallet_balance: 10 }))
      .toEqual({ firstName: 'A', walletBalance: 10 });
  });

  test('recurses into nested objects and arrays', () => {
    expect(toCamelCase({ order_id: 'x', category: { sort_order: 1 } }))
      .toEqual({ orderId: 'x', category: { sortOrder: 1 } });
    expect(toCamelCase([{ user_id: '1' }, { user_id: '2' }]))
      .toEqual([{ userId: '1' }, { userId: '2' }]);
  });

  test('passes through null and non-object values unchanged', () => {
    expect(toCamelCase(null)).toBeNull();
    expect(toCamelCase(5)).toBe(5);
  });

  test('does not mangle Date instances', () => {
    const d = new Date('2026-01-01T00:00:00.000Z');
    expect(toCamelCase({ created_at: d }).createdAt).toBe(d);
  });
});

describe('toSnakeCase', () => {
  test('converts camelCase keys to snake_case', () => {
    expect(toSnakeCase({ firstName: 'A', walletBalance: 10 }))
      .toEqual({ first_name: 'A', wallet_balance: 10 });
  });

  test('passes through null unchanged', () => {
    expect(toSnakeCase(null)).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npx jest tests/caseMapper.test.js
```

Expected: FAIL with "Cannot find module '../utils/caseMapper'"

- [ ] **Step 4: Implement the case mapper**

Create `utils/caseMapper.js`:

```js
/**
 * Converts between Postgres snake_case column names and the camelCase
 * shape the frontend already expects from the old Prisma-backed API.
 */
const snakeToCamel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const camelToSnake = (s) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());

const toCamelCase = (obj) => {
  if (Array.isArray(obj)) return obj.map(toCamelCase);
  if (obj === null || typeof obj !== 'object' || obj instanceof Date) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[snakeToCamel(k)] = (v !== null && typeof v === 'object' && !(v instanceof Date)) ? toCamelCase(v) : v;
  }
  return out;
};

const toSnakeCase = (obj) => {
  if (obj === null || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[camelToSnake(k)] = v;
  }
  return out;
};

module.exports = { toCamelCase, toSnakeCase };
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx jest tests/caseMapper.test.js
```

Expected: PASS, 6 tests.

- [ ] **Step 6: Write the Supabase client config**

Create `config/supabase.js`:

```js
/**
 * Supabase client — replaces config/db.js (Prisma). Talks to Supabase
 * over HTTPS (PostgREST), so the Node process never holds a persistent
 * Postgres connection open — this is what removes the entire class of
 * connection-pool-exhaustion / idle-connection-drop bugs Prisma had on
 * Hostinger.
 */
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

module.exports = { supabase };
```

- [ ] **Step 7: Update env config for Supabase vars**

In `config/env.js`, replace this block:

```js
if (!process.env.DATABASE_URL) {
  warnings.push('DATABASE_URL missing — database features will fail until it is set.');
}
```

with:

```js
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  warnings.push('SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing — database features will fail until they are set.');
}
```

And replace this line:

```js
  databaseUrl: process.env.DATABASE_URL,
```

with:

```js
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
```

- [ ] **Step 8: Update `.env.example`**

In `.env.example`, replace the `DATABASE_URL`/`DIRECT_URL` lines with:

```
# Supabase project settings — Project Settings > API in the Supabase dashboard
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here
# DATABASE_URL is still needed for scripts/migrate.js (direct Postgres access)
DATABASE_URL=postgresql://postgres.your-project:password@aws-0-region.pooler.supabase.com:5432/postgres
```

- [ ] **Step 9: Add your real Supabase credentials to your local `.env`**

This is a manual step you do yourself (not committed — `.env` is gitignored): open your Supabase project dashboard → Project Settings → API, copy the **Project URL** into `SUPABASE_URL` and the **service_role** key (not the anon key) into `SUPABASE_SERVICE_ROLE_KEY` in `.env`. Keep the existing `DATABASE_URL` — it's still used by `scripts/migrate.js`.

- [ ] **Step 10: Verify the Supabase client can reach the database**

```bash
node -e "require('dotenv').config(); const {supabase}=require('./config/supabase'); supabase.from('categories').select('count').then(r=>console.log(JSON.stringify(r)))"
```

Expected: `{"data":[{"count":0}],...}` with no `error` field populated (an empty `categories` table is expected at this point).

- [ ] **Step 11: Commit**

```bash
git add config/supabase.js config/env.js utils/caseMapper.js tests/caseMapper.test.js .env.example package.json package-lock.json
git commit -m "feat: add Supabase client, env config, and snake_case/camelCase mapper"
```

---

## Task 3: Rewrite `models/User.js` and `models/ApiKey.js`

**Files:**
- Modify: `models/User.js`
- Modify: `models/ApiKey.js`

**Interfaces:**
- Consumes: `supabase` from `config/supabase.js`.
- Produces: `PROFILE_COLUMNS` (string, for `.select()`), `generateKey()`, `findByKey(rawKey)` — used by Task 4 (`middleware/auth.js`) and Task 8 (`userController.js`).

- [ ] **Step 1: Rewrite `models/User.js`**

The old file exported password-hashing, token-generation, and lockout helpers — all now handled by Supabase Auth. `toSafeJSON` also becomes unnecessary: the new `profiles` table has no secret columns to strip. What's left is just the column list for `.select()`.

Replace the entire contents of `models/User.js` with:

```js
/**
 * Profile helpers — the profiles table has no secret columns (no
 * password, no 2FA secret, no verification/reset tokens — Supabase Auth
 * owns all of that), so there is no toSafeJSON/stripping step needed
 * anymore. This file just centralizes the column list used across
 * controllers.
 */
const PROFILE_COLUMNS = [
  'id', 'created_at', 'updated_at',
  'username', 'first_name', 'last_name',
  'role', 'status',
  'wallet_balance',
  'referral_code', 'referred_by_id', 'referral_earnings',
  'telegram', 'avatar_url',
  'last_login', 'last_login_ip'
].join(', ');

module.exports = { PROFILE_COLUMNS };
```

- [ ] **Step 2: Rewrite `models/ApiKey.js`**

Replace the entire contents of `models/ApiKey.js` with:

```js
/**
 * ApiKey helpers
 */
const crypto = require('crypto');
const { supabase } = require('../config/supabase');

const generateKey = () => {
  const raw    = 'dps_live_' + crypto.randomBytes(24).toString('hex');
  const hash   = crypto.createHash('sha256').update(raw).digest('hex');
  const prefix = raw.substring(0, 16);
  return { raw, hash, prefix };
};

const findByKey = async (rawKey) => {
  const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const { data, error } = await supabase
    .from('api_keys')
    .select('*, profiles(*)')
    .eq('key_hash', hash)
    .eq('active', true)
    .maybeSingle();
  if (error) throw error;
  return data;
};

module.exports = { generateKey, findByKey };
```

- [ ] **Step 3: Verify nothing else still imports the removed `models/User.js` exports**

```bash
grep -rn "require('../models/User')\|require(\"../models/User\")" controllers middleware
```

Expected: matches only in files this plan rewrites later (Tasks 4, 6–9) — confirm no other file references `hashPassword`, `comparePassword`, `toSafeJSON`, `USER_PUBLIC`, etc. that this task didn't account for. If you find an unexpected reference, note it and adjust that file's task below before proceeding.

- [ ] **Step 4: Commit**

```bash
git add models/User.js models/ApiKey.js
git commit -m "feat: rewrite models/User.js and models/ApiKey.js for Supabase"
```

---

## Task 4: Rewrite `middleware/auth.js`

**Files:**
- Modify: `middleware/auth.js`
- Create: `tests/auth.test.js`

**Interfaces:**
- Consumes: `supabase` (Task 2), `PROFILE_COLUMNS` (Task 3).
- Produces: `protect`, `requireRole`, `apiKeyAuth` — every protected route (Tasks 6–9's routes) depends on these being unchanged in name/signature. `requireEmailVerified` is **removed**: Supabase Auth's own email-confirmation gate replaces it, and no `profiles` column tracks this anymore — remove its one usage in `routes/walletRoutes.js` in Task 9.

- [ ] **Step 1: Write the failing test**

Create `tests/auth.test.js`:

```js
jest.mock('../config/supabase', () => ({
  supabase: {
    auth: { getUser: jest.fn() },
    from: jest.fn()
  }
}));

const { supabase } = require('../config/supabase');
const { protect } = require('../middleware/auth');

const mockReqRes = (headers = {}) => {
  const req = { headers, cookies: {} };
  const res = {};
  const next = jest.fn();
  return { req, res, next };
};

describe('protect middleware', () => {
  beforeEach(() => jest.clearAllMocks());

  test('rejects when no token is present', async () => {
    const { req, res, next } = mockReqRes();
    await protect(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  test('rejects an invalid/expired token', async () => {
    supabase.auth.getUser.mockResolvedValue({ data: { user: null }, error: { message: 'invalid JWT' } });
    const { req, res, next } = mockReqRes({ authorization: 'Bearer bad.token.here' });
    await protect(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  test('rejects a valid token with no matching profile row', async () => {
    supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    supabase.from.mockReturnValue({
      select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'no rows' } }) }) })
    });
    const { req, res, next } = mockReqRes({ authorization: 'Bearer good.token' });
    await protect(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  test('attaches req.user and req.userId on success', async () => {
    supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    supabase.from.mockReturnValue({
      select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { id: 'u1', status: 'active', role: 'user' }, error: null }) }) })
    });
    const { req, res, next } = mockReqRes({ authorization: 'Bearer good.token' });
    await protect(req, res, next);
    expect(next).toHaveBeenCalledWith(); // called with no error
    expect(req.userId).toBe('u1');
    expect(req.user.role).toBe('user');
  });

  test('rejects a suspended/banned account', async () => {
    supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    supabase.from.mockReturnValue({
      select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { id: 'u1', status: 'banned', role: 'user' }, error: null }) }) })
    });
    const { req, res, next } = mockReqRes({ authorization: 'Bearer good.token' });
    await protect(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx jest tests/auth.test.js
```

Expected: FAIL (the current `middleware/auth.js` still uses `verifyAccessToken`/Prisma, not the mocked Supabase client's shape).

- [ ] **Step 3: Rewrite `middleware/auth.js`**

Replace the entire contents of `middleware/auth.js` with:

```js
/**
 * Auth middleware — verifies a Supabase-issued JWT or a developer API
 * key, attaches the matching profile to req.
 */
const crypto       = require('crypto');
const { supabase } = require('../config/supabase');
const { PROFILE_COLUMNS } = require('../models/User');
const ApiError     = require('../utils/apiError');
const asyncHandler = require('../utils/asyncHandler');
const { toCamelCase } = require('../utils/caseMapper');

const extractToken = (req) => {
  if (req.headers.authorization?.startsWith('Bearer ')) {
    return req.headers.authorization.split(' ')[1];
  }
  return null;
};

/**
 * protect — requires a valid Supabase session token
 */
const protect = asyncHandler(async (req, res, next) => {
  const token = extractToken(req);
  if (!token) throw ApiError.unauthorized('Authentication required');

  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData?.user) {
    throw ApiError.unauthorized('Invalid or expired session');
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select(PROFILE_COLUMNS)
    .eq('id', authData.user.id)
    .single();

  if (profileError || !profile) throw ApiError.unauthorized('User no longer exists');

  const user = toCamelCase(profile);
  if (user.status !== 'active') throw ApiError.forbidden(`Account ${user.status}`);

  req.user   = user;
  req.userId = user.id;
  next();
});

/**
 * requireRole — role-based access control
 */
const requireRole = (...roles) => (req, _res, next) => {
  if (!roles.includes(req.user.role)) throw ApiError.forbidden('Insufficient permissions');
  next();
};

/**
 * apiKeyAuth — for developer endpoints (/api/v1/*)
 */
const apiKeyAuth = asyncHandler(async (req, res, next) => {
  const rawKey = req.headers['x-api-key'] ||
    (req.headers.authorization?.startsWith('Bearer dps_') && req.headers.authorization.split(' ')[1]);

  if (!rawKey) throw ApiError.unauthorized('API key required');

  const { findByKey } = require('../models/ApiKey');
  const key = await findByKey(rawKey);

  if (!key)                                        throw ApiError.unauthorized('Invalid API key');
  if (key.expires_at && new Date(key.expires_at) < new Date()) throw ApiError.unauthorized('API key expired');
  if (!key.profiles || key.profiles.status !== 'active')       throw ApiError.forbidden('User account inactive');

  const { supabase: sb } = require('../config/supabase');
  sb.from('api_keys')
    .update({ usage_count: key.usage_count + 1, last_used_at: new Date().toISOString(), last_used_ip: req.ip })
    .eq('id', key.id)
    .then(() => {}, () => {}); // fire-and-forget

  req.user   = toCamelCase(key.profiles);
  req.userId = key.profiles.id;
  req.apiKey = toCamelCase(key);
  next();
});

module.exports = { protect, requireRole, apiKeyAuth };
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx jest tests/auth.test.js
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add middleware/auth.js tests/auth.test.js
git commit -m "feat: rewrite auth middleware to verify Supabase JWTs"
```

---

## Task 5: Rewrite `controllers/walletController.js`

**Files:**
- Modify: `controllers/walletController.js`

**Interfaces:**
- Consumes: `supabase` (Task 2), `toCamelCase`/`toSnakeCase` (Task 2).
- Produces: `getWallet`, `initiateTopup`, `creditWallet({userId, amount, bonus, externalId, method, description, refundFor})`, `debitWallet({userId, amount, orderId, description})`, `getTransactions`, `getTransaction`, `calculateBonus` — Task 6 (`numberController.js`) calls `debitWallet` and `creditWallet` with these exact same parameter names.

- [ ] **Step 1: Rewrite the file**

Replace the entire contents of `controllers/walletController.js` with:

```js
/**
 * Wallet controller — balance, top-up initiation, transaction history
 */
const { supabase } = require('../config/supabase');
const ApiError     = require('../utils/apiError');
const asyncHandler = require('../utils/asyncHandler');
const stripe       = require('../services/stripeService');
const nowpay       = require('../services/nowPaymentsService');
const paypal       = require('../services/paypalService');
const { toCamelCase } = require('../utils/caseMapper');

const calculateBonus = (amount) => {
  if (amount >= 100) return amount * 0.20;
  if (amount >= 50)  return amount * 0.15;
  if (amount >= 25)  return amount * 0.10;
  return 0;
};

// ═════════════════════════════════════════════
// GET /api/wallet
// ═════════════════════════════════════════════
exports.getWallet = asyncHandler(async (req, res) => {
  res.json({ success: true, balance: req.user.walletBalance, currency: 'USD' });
});

// ═════════════════════════════════════════════
// POST /api/wallet/topup
// ═════════════════════════════════════════════
exports.initiateTopup = asyncHandler(async (req, res) => {
  const { amount, method, payCurrency } = req.body;
  const amt = parseFloat(amount);

  if (!amt || amt < 1) throw ApiError.badRequest('Minimum top-up is $1');
  if (amt > 10000)     throw ApiError.badRequest('Maximum top-up is $10,000');

  const bonus = calculateBonus(amt);

  const { data: txRow, error: txErr } = await supabase.from('transactions').insert({
    user_id: req.userId,
    type: 'topup',
    amount: amt,
    bonus_amount: bonus,
    balance_after: req.user.walletBalance,
    method,
    status: 'pending',
    description: `Top-up via ${method}`,
    ip_address: req.ip,
    user_agent: req.get('User-Agent')
  }).select().single();
  if (txErr) throw new ApiError(500, txErr.message);

  let paymentData;

  switch (method) {
    case 'stripe': {
      const session = await stripe.createCheckoutSession({
        userId: req.userId, email: req.user.email, amount: amt, bonus
      });
      await supabase.from('transactions').update({ external_id: session.sessionId }).eq('id', txRow.id);
      paymentData = { url: session.url, sessionId: session.sessionId };
      break;
    }
    case 'nowpayments': {
      const payment = await nowpay.createPayment({
        userId: req.userId, amount: amt, bonus, payCurrency: payCurrency || 'usdttrc20'
      });
      await supabase.from('transactions').update({
        external_id: String(payment.paymentId),
        crypto_currency: payment.payCurrency,
        crypto_amount: payment.payAmount,
        crypto_address: payment.payAddress
      }).eq('id', txRow.id);
      paymentData = {
        paymentId: payment.paymentId, payAddress: payment.payAddress,
        payAmount: payment.payAmount, payCurrency: payment.payCurrency, expiresAt: payment.expiresAt
      };
      break;
    }
    case 'paypal': {
      const order = await paypal.createOrder({ userId: req.userId, amount: amt, bonus });
      await supabase.from('transactions').update({ external_id: order.orderId }).eq('id', txRow.id);
      paymentData = { orderId: order.orderId, approvalUrl: order.approvalUrl };
      break;
    }
    default:
      throw ApiError.badRequest('Invalid payment method');
  }

  res.status(201).json({
    success: true, transactionId: txRow.id, amount: amt, bonus, total: amt + bonus, method, payment: paymentData
  });
});

// ═════════════════════════════════════════════
// creditWallet (internal — used by webhooks + refunds)
// ═════════════════════════════════════════════
exports.creditWallet = async ({ userId, amount, bonus = 0, externalId, method, description, refundFor }) => {
  const { data, error } = await supabase.rpc('credit_wallet', {
    p_user_id: userId,
    p_amount: amount,
    p_bonus: bonus,
    p_method: method,
    p_external_id: externalId || null,
    p_description: description || `Credited $${(amount + bonus).toFixed(2)}`,
    p_order_id: refundFor || null,
    p_type: refundFor ? 'refund' : 'topup'
  });
  if (error) throw new ApiError(500, error.message);

  const row = data[0];
  return { user: { id: userId, walletBalance: row.new_balance }, tx: { id: row.transaction_id } };
};

// ═════════════════════════════════════════════
// debitWallet (internal — used by purchase controller)
// ═════════════════════════════════════════════
exports.debitWallet = async ({ userId, amount, orderId, description }) => {
  const { data, error } = await supabase.rpc('debit_wallet', {
    p_user_id: userId,
    p_amount: amount,
    p_order_id: orderId || null,
    p_description: description || 'Number purchase'
  });
  if (error) {
    if (error.message === 'Insufficient wallet balance') throw ApiError.badRequest('Insufficient wallet balance');
    if (error.message === 'User not found') throw ApiError.notFound('User not found');
    throw new ApiError(500, error.message);
  }

  const row = data[0];
  return { user: { id: userId, walletBalance: row.new_balance }, tx: { id: row.transaction_id } };
};

// ═════════════════════════════════════════════
// GET /api/wallet/transactions
// ═════════════════════════════════════════════
exports.getTransactions = asyncHandler(async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const from  = (page - 1) * limit;
  const to    = from + limit - 1;

  let query = supabase.from('transactions').select('*', { count: 'exact' }).eq('user_id', req.userId);
  if (req.query.type)   query = query.eq('type', req.query.type);
  if (req.query.status) query = query.eq('status', req.query.status);

  const { data, error, count } = await query.order('created_at', { ascending: false }).range(from, to);
  if (error) throw new ApiError(500, error.message);

  res.json({
    success: true, page, limit, total: count, totalPages: Math.ceil(count / limit),
    transactions: toCamelCase(data)
  });
});

// ═════════════════════════════════════════════
// GET /api/wallet/transactions/:id
// ═════════════════════════════════════════════
exports.getTransaction = asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('transactions')
    .select('*, orders(*)')
    .eq('id', req.params.id)
    .eq('user_id', req.userId)
    .maybeSingle();
  if (error) throw new ApiError(500, error.message);
  if (!data) throw ApiError.notFound('Transaction not found');
  res.json({ success: true, transaction: toCamelCase(data) });
});

exports.calculateBonus = calculateBonus;
```

- [ ] **Step 2: Commit**

```bash
git add controllers/walletController.js
git commit -m "feat: rewrite walletController for Supabase (RPC-based atomic wallet ops)"
```

---

## Task 6: Rewrite `controllers/numberController.js`

**Files:**
- Modify: `controllers/numberController.js`

**Interfaces:**
- Consumes: `supabase`, `toCamelCase` (Task 2); `wallet.debitWallet`/`wallet.creditWallet` (Task 5).
- Produces: `providerCheck`, `listCountries`, `listServices`, `getPrice`, `buyNumber`, `checkOrderStatus`, `cancelOrder`, `listOrders`, `getOrder`, `_refundOrder(order, reason)` — `_refundOrder` is called by `server.js`'s background job (Task 7).

- [ ] **Step 1: Rewrite the file**

Replace the entire contents of `controllers/numberController.js` with (unchanged sections — `FALLBACK_COUNTRIES`, `FALLBACK_SERVICES`, `providerCheck`, `listCountries`, `listServices`, `getPrice` — carried over verbatim since they don't touch the database at all):

```js
/**
 * Number controller — buy, check, cancel, finish virtual numbers
 */
const { supabase } = require('../config/supabase');
const ApiError     = require('../utils/apiError');
const asyncHandler = require('../utils/asyncHandler');
const { getProvider, calculateUserPrice } = require('../services/smsProvider');
const { generateOrderId, getTimeRemaining } = require('../models/Order');
const wallet       = require('./walletController');
const email        = require('../services/emailService');
const logger       = require('../utils/logger');
const { toCamelCase } = require('../utils/caseMapper');

const FALLBACK_COUNTRIES = [
  { code: 'US', name: 'United States',  flag: '🇺🇸' },
  { code: 'GB', name: 'United Kingdom', flag: '🇬🇧' },
  { code: 'DE', name: 'Germany',        flag: '🇩🇪' },
  { code: 'FR', name: 'France',         flag: '🇫🇷' },
  { code: 'IN', name: 'India',          flag: '🇮🇳' },
  { code: 'BR', name: 'Brazil',         flag: '🇧🇷' },
  { code: 'CA', name: 'Canada',         flag: '🇨🇦' },
  { code: 'AU', name: 'Australia',      flag: '🇦🇺' },
  { code: 'RU', name: 'Russia',         flag: '🇷🇺' },
  { code: 'NG', name: 'Nigeria',        flag: '🇳🇬' },
  { code: 'PK', name: 'Pakistan',       flag: '🇵🇰' },
  { code: 'ID', name: 'Indonesia',      flag: '🇮🇩' },
  { code: 'TR', name: 'Turkey',         flag: '🇹🇷' },
  { code: 'MX', name: 'Mexico',         flag: '🇲🇽' },
  { code: 'PH', name: 'Philippines',    flag: '🇵🇭' },
  { code: 'VN', name: 'Vietnam',        flag: '🇻🇳' },
  { code: 'UA', name: 'Ukraine',        flag: '🇺🇦' },
  { code: 'ZA', name: 'South Africa',   flag: '🇿🇦' },
  { code: 'EG', name: 'Egypt',          flag: '🇪🇬' },
  { code: 'SA', name: 'Saudi Arabia',   flag: '🇸🇦' },
  { code: 'AE', name: 'UAE',            flag: '🇦🇪' },
  { code: 'KE', name: 'Kenya',          flag: '🇰🇪' },
  { code: 'GH', name: 'Ghana',          flag: '🇬🇭' },
  { code: 'JP', name: 'Japan',          flag: '🇯🇵' },
  { code: 'KR', name: 'South Korea',    flag: '🇰🇷' },
  { code: 'MY', name: 'Malaysia',       flag: '🇲🇾' },
  { code: 'SG', name: 'Singapore',      flag: '🇸🇬' },
  { code: 'TH', name: 'Thailand',       flag: '🇹🇭' }
];

exports.providerCheck = asyncHandler(async (_req, res) => {
  const provider = getProvider();
  const out = { provider: provider.name, keyConfigured: false, balance: null, countriesCount: null, errors: {} };
  try {
    const env = require('../config/env');
    out.keyConfigured = !!(env.sms.sureVerifications && env.sms.sureVerifications.apiKey);
    out.baseUrl = env.sms.sureVerifications && env.sms.sureVerifications.baseUrl;
  } catch (_e) {}
  if (typeof provider.getBalance === 'function') {
    try { out.balance = await provider.getBalance(); }
    catch (err) { out.errors.balance = err.response?.data || err.message; }
  }
  if (typeof provider.getCountries === 'function') {
    try { const c = await provider.getCountries(); out.countriesCount = Array.isArray(c) ? c.length : 0; }
    catch (err) { out.errors.countries = err.response?.data || err.message; }
  }
  out.ok = out.balance !== null && Object.keys(out.errors).length === 0;
  res.json(out);
});

exports.listCountries = asyncHandler(async (_req, res) => {
  const provider = getProvider();
  if (typeof provider.getCountries === 'function') {
    try {
      const raw = await provider.getCountries();
      const countries = raw.map(c => {
        if (typeof c === 'string') return { code: c.toUpperCase(), name: c, flag: '' };
        return {
          code: (c.code || c.iso || c.country || '').toUpperCase(),
          name: c.name || c.country_name || c.code || '',
          flag: c.flag || ''
        };
      }).filter(c => c.code);
      return res.json({ success: true, count: countries.length, countries, source: 'live' });
    } catch (err) {
      logger.warn('Live countries fetch failed, using fallback:', err.message);
    }
  }
  res.json({ success: true, count: FALLBACK_COUNTRIES.length, countries: FALLBACK_COUNTRIES, source: 'static' });
});

const FALLBACK_SERVICES = [
  { code: 'whatsapp',  name: 'WhatsApp',    icon: 'whatsapp'  },
  { code: 'telegram',  name: 'Telegram',    icon: 'telegram'  },
  { code: 'google',    name: 'Google',      icon: 'google'    },
  { code: 'facebook',  name: 'Facebook',    icon: 'facebook'  },
  { code: 'instagram', name: 'Instagram',   icon: 'instagram' },
  { code: 'twitter',   name: 'Twitter / X', icon: 'twitter'   },
  { code: 'tiktok',    name: 'TikTok',      icon: 'tiktok'    },
  { code: 'uber',      name: 'Uber',        icon: 'uber'      },
  { code: 'amazon',    name: 'Amazon',      icon: 'amazon'    },
  { code: 'paypal',    name: 'PayPal',      icon: 'paypal'    },
  { code: 'microsoft', name: 'Microsoft',   icon: 'microsoft' },
  { code: 'discord',   name: 'Discord',     icon: 'discord'   },
  { code: 'any',       name: 'Any Service', icon: 'any'       }
];

exports.listServices = asyncHandler(async (_req, res) => {
  const provider = getProvider();
  if (typeof provider.getServices === 'function') {
    try {
      const raw = await provider.getServices('server1');
      const services = raw.map(s => {
        if (typeof s === 'string') return { code: s.toLowerCase(), name: s, icon: s.toLowerCase() };
        return {
          code: (s.code || s.service || s.name || '').toLowerCase(),
          name: s.name || s.service || s.code || '',
          icon: (s.icon || s.code || s.name || '').toLowerCase()
        };
      }).filter(s => s.code);
      return res.json({ success: true, services, source: 'live' });
    } catch (err) {
      logger.warn('Live services fetch failed, using fallback:', err.message);
    }
  }
  res.json({ success: true, services: FALLBACK_SERVICES, source: 'static' });
});

exports.getPrice = asyncHandler(async (req, res) => {
  const { country, service = 'any' } = req.query;
  if (!country) throw ApiError.badRequest('Country required');
  const provider  = getProvider();
  const { cost, count, currency } = await provider.getPrice(country.toUpperCase(), service);
  const userPrice = calculateUserPrice(cost);
  res.json({
    success: true, country: country.toUpperCase(), service, providerCost: cost, userPrice,
    currency: 'USD', providerCurrency: currency, available: count, provider: provider.name
  });
});

// ═════════════════════════════════════════════
// POST /api/numbers/buy
// ═════════════════════════════════════════════
exports.buyNumber = asyncHandler(async (req, res) => {
  const { serviceType, country, service } = req.body;

  if (!['whatsapp', 'sms'].includes(serviceType)) throw ApiError.badRequest('Invalid service type');
  if (!country) throw ApiError.badRequest('Country required');

  const targetService = serviceType === 'whatsapp' ? 'whatsapp' : (service || 'any');

  const provider = getProvider();
  let priceInfo;
  try {
    priceInfo = await provider.getPrice(country.toUpperCase(), targetService);
  } catch (_err) {
    throw ApiError.badRequest('Pricing unavailable for this combo');
  }

  const userCost = calculateUserPrice(priceInfo.cost);
  if (req.user.walletBalance < userCost) {
    throw ApiError.badRequest(
      `Insufficient balance. Need $${userCost.toFixed(2)}, have $${req.user.walletBalance.toFixed(2)}`
    );
  }

  let purchase;
  try {
    purchase = await provider.buyNumber(country.toUpperCase(), targetService);
  } catch (err) {
    logger.error('Provider buyNumber failed:', err.stack || err.message);
    throw err;
  }

  const expiresAtDate = purchase.expiresAt ? new Date(purchase.expiresAt) : new Date(Date.now() + 20 * 60 * 1000);

  const { data: orderRow, error: orderErr } = await supabase.from('orders').insert({
    user_id: req.userId,
    order_id: generateOrderId(),
    provider: provider.name,
    provider_order_id: purchase.providerOrderId,
    service_type: serviceType,
    service: targetService,
    country: country.toUpperCase(),
    phone_number: purchase.phoneNumber,
    provider_cost: priceInfo.cost,
    user_cost: userCost,
    status: 'active',
    activated_at: new Date().toISOString(),
    expires_at: expiresAtDate.toISOString(),
    ip_address: req.ip,
    user_agent: req.get('User-Agent')
  }).select().single();
  if (orderErr) throw new ApiError(500, orderErr.message);

  const order = toCamelCase(orderRow);

  try {
    await wallet.debitWallet({
      userId: req.userId,
      amount: userCost,
      orderId: order.id,
      description: `${serviceType.toUpperCase()} ${country.toUpperCase()} ${order.phoneNumber}`
    });
  } catch (err) {
    await provider.cancelOrder(purchase.providerOrderId).catch(() => {});
    await supabase.from('orders').update({ status: 'cancelled' }).eq('id', order.id);
    throw err;
  }

  email.sendOrderConfirmation(req.user, order).catch(e => logger.error('Order email:', e.stack || e.message));

  logger.info(`Order ${order.orderId} created: ${order.phoneNumber} ($${userCost})`);

  res.status(201).json({
    success: true,
    order: {
      id: order.id, orderId: order.orderId, phoneNumber: order.phoneNumber, country: order.country,
      serviceType: order.serviceType, service: order.service, cost: order.userCost, status: order.status,
      expiresAt: order.expiresAt, timeRemainingMs: getTimeRemaining(order)
    }
  });
});

const fetchOwnOrder = async (id, userId) => {
  const { data, error } = await supabase.from('orders').select('*').eq('id', id).eq('user_id', userId).maybeSingle();
  if (error) throw new ApiError(500, error.message);
  return data ? toCamelCase(data) : null;
};

// ═════════════════════════════════════════════
// GET /api/numbers/orders/:id/status
// ═════════════════════════════════════════════
exports.checkOrderStatus = asyncHandler(async (req, res) => {
  let order = await fetchOwnOrder(req.params.id, req.userId);
  if (!order) throw ApiError.notFound('Order not found');

  const now = new Date();

  if (order.status === 'active' && new Date(order.expiresAt) > now) {
    try {
      const provider = getProvider(order.provider);
      const status   = await provider.checkOrder(order.providerOrderId);

      if (status.sms && status.sms.length) {
        const { data, error } = await supabase.from('orders').update({
          sms_messages: status.sms, otp_code: status.otpCode, status: 'received', completed_at: now.toISOString()
        }).eq('id', order.id).select().single();
        if (error) throw new ApiError(500, error.message);
        order = toCamelCase(data);
        provider.finishOrder(order.providerOrderId).catch(() => {});
      } else if (status.status === 'cancelled') {
        const { data, error } = await supabase.from('orders').update({
          status: 'cancelled', cancelled_at: now.toISOString()
        }).eq('id', order.id).select().single();
        if (error) throw new ApiError(500, error.message);
        order = toCamelCase(data);
        await refundOrder(order, 'Provider cancelled');
      }
    } catch (err) {
      logger.error('checkOrderStatus provider error:', err.stack || err.message);
    }
  }

  if (order.status === 'active' && new Date(order.expiresAt) < now) {
    const { data, error } = await supabase.from('orders').update({ status: 'expired' }).eq('id', order.id).select().single();
    if (error) throw new ApiError(500, error.message);
    order = toCamelCase(data);
    await refundOrder(order, 'No SMS received within window');
  }

  res.json({
    success: true,
    order: {
      id: order.id, orderId: order.orderId, phoneNumber: order.phoneNumber, status: order.status,
      otpCode: order.otpCode, smsMessages: order.smsMessages, timeRemainingMs: getTimeRemaining(order)
    }
  });
});

// ═════════════════════════════════════════════
// POST /api/numbers/orders/:id/cancel
// ═════════════════════════════════════════════
exports.cancelOrder = asyncHandler(async (req, res) => {
  let order = await fetchOwnOrder(req.params.id, req.userId);
  if (!order) throw ApiError.notFound('Order not found');
  if (order.status !== 'active') throw ApiError.badRequest(`Cannot cancel order with status: ${order.status}`);

  try {
    const provider = getProvider(order.provider);
    await provider.cancelOrder(order.providerOrderId);
  } catch (err) {
    logger.warn('Provider cancel failed (continuing):', err.message);
  }

  const { data, error } = await supabase.from('orders').update({
    status: 'cancelled', cancelled_at: new Date().toISOString()
  }).eq('id', order.id).select().single();
  if (error) throw new ApiError(500, error.message);
  order = toCamelCase(data);

  await refundOrder(order, 'User cancelled');

  res.json({ success: true, message: 'Order cancelled and refunded', order });
});

// ═════════════════════════════════════════════
// GET /api/numbers/orders
// ═════════════════════════════════════════════
exports.listOrders = asyncHandler(async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);
  const from  = (page - 1) * limit;
  const to    = from + limit - 1;

  let query = supabase.from('orders').select('*', { count: 'exact' }).eq('user_id', req.userId);
  if (req.query.status)      query = query.eq('status', req.query.status);
  if (req.query.serviceType) query = query.eq('service_type', req.query.serviceType);
  if (req.query.country)     query = query.eq('country', req.query.country.toUpperCase());

  const { data, error, count } = await query.order('created_at', { ascending: false }).range(from, to);
  if (error) throw new ApiError(500, error.message);

  res.json({
    success: true, page, limit, total: count, totalPages: Math.ceil(count / limit), orders: toCamelCase(data)
  });
});

// ═════════════════════════════════════════════
// GET /api/numbers/orders/:id
// ═════════════════════════════════════════════
exports.getOrder = asyncHandler(async (req, res) => {
  const order = await fetchOwnOrder(req.params.id, req.userId);
  if (!order) throw ApiError.notFound('Order not found');
  res.json({ success: true, order });
});

// ── Helper: refund an order ─────────────────────────────────
async function refundOrder(order, reason) {
  if (order.refundedAt) return;

  const refundTx = await wallet.creditWallet({
    userId: order.userId,
    amount: order.userCost,
    method: 'system',
    refundFor: order.id,
    description: `Refund for order ${order.orderId}: ${reason}`
  });

  const statusUpdate = order.status !== 'cancelled' ? { status: 'refunded' } : {};

  const { error } = await supabase.from('orders').update({
    refunded_at: new Date().toISOString(),
    refund_reason: reason,
    refund_tx_id: refundTx.tx.id,
    ...statusUpdate
  }).eq('id', order.id);
  if (error) logger.error('refundOrder update failed:', error.message);

  logger.info(`Order ${order.orderId} refunded: ${reason}`);
  return refundTx;
}

exports._refundOrder = refundOrder;
```

- [ ] **Step 2: Commit**

```bash
git add controllers/numberController.js
git commit -m "feat: rewrite numberController for Supabase"
```

---

## Task 7: Rewrite `controllers/userController.js`

**Files:**
- Modify: `controllers/userController.js`

**Interfaces:**
- Consumes: `supabase`, `toCamelCase` (Task 2); `PROFILE_COLUMNS` (Task 3); `generateKey` (Task 3).
- Produces: `getProfile`, `updateProfile`, `deleteAccount`, `listApiKeys`, `createApiKey`, `revokeApiKey`, `getReferralStats`, `getDashboardStats`.
- **Behavior change (documented, not silent):** `deleteAccount` no longer re-verifies a password server-side — the backend has no access to Supabase-managed password hashes at all. Authorization now rests entirely on the caller holding a valid Supabase session token (already enforced by `protect`). The `password` field in the request body is ignored.

- [ ] **Step 1: Rewrite the file**

Replace the entire contents of `controllers/userController.js` with:

```js
/**
 * User controller — profile, API keys, referral, dashboard stats
 */
const { supabase } = require('../config/supabase');
const { generateKey } = require('../models/ApiKey');
const { PROFILE_COLUMNS } = require('../models/User');
const ApiError     = require('../utils/apiError');
const asyncHandler = require('../utils/asyncHandler');
const { toCamelCase, toSnakeCase } = require('../utils/caseMapper');

// ═════════════════════════════════════════════
// GET /api/users/me
// ═════════════════════════════════════════════
exports.getProfile = asyncHandler(async (req, res) => {
  res.json({ success: true, user: req.user });
});

// ═════════════════════════════════════════════
// PATCH /api/users/me
// ═════════════════════════════════════════════
exports.updateProfile = asyncHandler(async (req, res) => {
  const allowed = ['firstName', 'lastName', 'telegram', 'avatarUrl'];
  const updates = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }

  const { data, error } = await supabase
    .from('profiles')
    .update(toSnakeCase(updates))
    .eq('id', req.userId)
    .select(PROFILE_COLUMNS)
    .single();
  if (error) throw new ApiError(500, error.message);

  res.json({ success: true, user: toCamelCase(data) });
});

// ═════════════════════════════════════════════
// DELETE /api/users/me
// Note: no server-side password re-check — Supabase Auth owns password
// verification and a valid session token is already required by
// `protect`. If you want a "re-enter password" UX step, do it on the
// frontend via supabase.auth.signInWithPassword() before calling this.
// ═════════════════════════════════════════════
exports.deleteAccount = asyncHandler(async (req, res) => {
  const { error } = await supabase.from('profiles').update({
    status: 'banned',
    username: `deleted_${req.userId}`
  }).eq('id', req.userId);
  if (error) throw new ApiError(500, error.message);

  const { error: authErr } = await supabase.auth.admin.deleteUser(req.userId);
  if (authErr) throw new ApiError(500, authErr.message);

  res.json({ success: true, message: 'Account deleted' });
});

// ═════════════════════════════════════════════
// GET /api/users/api-keys
// ═════════════════════════════════════════════
exports.listApiKeys = asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('api_keys')
    .select('*')
    .eq('user_id', req.userId)
    .order('created_at', { ascending: false });
  if (error) throw new ApiError(500, error.message);
  res.json({ success: true, keys: toCamelCase(data) });
});

// ═════════════════════════════════════════════
// POST /api/users/api-keys
// ═════════════════════════════════════════════
exports.createApiKey = asyncHandler(async (req, res) => {
  const { name, scopes = ['read', 'write'] } = req.body;
  if (!name) throw ApiError.badRequest('Name required');

  const { count, error: countErr } = await supabase
    .from('api_keys')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', req.userId)
    .eq('active', true);
  if (countErr) throw new ApiError(500, countErr.message);
  if (count >= 5) throw ApiError.badRequest('Max 5 active API keys per account');

  const { raw, hash, prefix } = generateKey();

  const { data, error } = await supabase.from('api_keys').insert({
    user_id: req.userId, name, key_prefix: prefix, key_hash: hash, scopes
  }).select().single();
  if (error) throw new ApiError(500, error.message);

  res.status(201).json({
    success: true,
    message: 'Save this key — it will not be shown again',
    apiKey: { id: data.id, name, prefix, scopes, key: raw }
  });
});

// ═════════════════════════════════════════════
// DELETE /api/users/api-keys/:id
// ═════════════════════════════════════════════
exports.revokeApiKey = asyncHandler(async (req, res) => {
  const { data: key, error: findErr } = await supabase
    .from('api_keys').select('id').eq('id', req.params.id).eq('user_id', req.userId).maybeSingle();
  if (findErr) throw new ApiError(500, findErr.message);
  if (!key) throw ApiError.notFound('API key not found');

  const { error } = await supabase.from('api_keys').delete().eq('id', req.params.id);
  if (error) throw new ApiError(500, error.message);
  res.json({ success: true, message: 'API key revoked' });
});

// ═════════════════════════════════════════════
// GET /api/users/referral
// ═════════════════════════════════════════════
exports.getReferralStats = asyncHandler(async (req, res) => {
  const [{ count: referredCount, error: refErr }, { data: payouts, error: payErr }] = await Promise.all([
    supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('referred_by_id', req.userId),
    supabase.from('transactions').select('id, amount').eq('user_id', req.userId).eq('type', 'referral_payout').eq('status', 'success')
  ]);
  if (refErr) throw new ApiError(500, refErr.message);
  if (payErr) throw new ApiError(500, payErr.message);

  res.json({
    success: true,
    referralCode: req.user.referralCode,
    referralLink: `${require('../config/env').frontendUrl}/register?ref=${req.user.referralCode}`,
    totalReferred: referredCount || 0,
    totalEarnings: req.user.referralEarnings,
    commissionRate: 0.10,
    payoutCount: payouts.length
  });
});

// ═════════════════════════════════════════════
// GET /api/users/dashboard-stats
// ═════════════════════════════════════════════
exports.getDashboardStats = asyncHandler(async (req, res) => {
  const [ordersRes, completedRes, refundsRes] = await Promise.all([
    supabase.from('orders').select('user_cost').eq('user_id', req.userId),
    supabase.from('orders').select('id', { count: 'exact', head: true }).eq('user_id', req.userId).in('status', ['received', 'completed']),
    supabase.from('transactions').select('amount').eq('user_id', req.userId).eq('type', 'refund').eq('status', 'success')
  ]);
  if (ordersRes.error) throw new ApiError(500, ordersRes.error.message);
  if (completedRes.error) throw new ApiError(500, completedRes.error.message);
  if (refundsRes.error) throw new ApiError(500, refundsRes.error.message);

  const totalOrders = ordersRes.data.length;
  const totalSpent  = ordersRes.data.reduce((sum, o) => sum + Number(o.user_cost), 0);
  const refundTotal = refundsRes.data.reduce((sum, t) => sum + Number(t.amount), 0);
  const refundCount = refundsRes.data.length;
  const completedCount = completedRes.count || 0;

  res.json({
    success: true,
    stats: {
      walletBalance: req.user.walletBalance,
      totalOrders,
      completedOrders: completedCount,
      successRate: totalOrders ? +(completedCount / totalOrders * 100).toFixed(1) : 0,
      totalSpent: +totalSpent.toFixed(2),
      refundsCount: refundCount,
      refundsTotal: +refundTotal.toFixed(2)
    }
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add controllers/userController.js
git commit -m "feat: rewrite userController for Supabase"
```

---

## Task 8: Rewrite `controllers/adminController.js`

**Files:**
- Modify: `controllers/adminController.js`

**Interfaces:**
- Consumes: `supabase`, `toCamelCase` (Task 2).
- Produces: `listUsers`, `toggleBan`, `listOrders` — unchanged function names, mounted the same way in `routes/adminRoutes.js` (no route changes needed).

- [ ] **Step 1: Rewrite the file**

Replace the entire contents of `controllers/adminController.js` with:

```js
/**
 * Admin controller — cross-cutting admin views (users, orders).
 * All routes are gated by protect + requireRole('admin').
 */
const { supabase } = require('../config/supabase');
const ApiError     = require('../utils/apiError');
const asyncHandler = require('../utils/asyncHandler');

// GET /api/admin/users
exports.listUsers = asyncHandler(async (req, res) => {
  const search = (req.query.search || '').trim().toLowerCase();

  const { data: users, error } = await supabase
    .from('profiles')
    .select('id, first_name, last_name, username, wallet_balance, status, role, created_at')
    .order('created_at', { ascending: false });
  if (error) throw new ApiError(500, error.message);

  // Order counts per user (one query, grouped client-side — admin list
  // sizes are small enough that this is simpler and cheaper than N+1).
  const { data: orderCounts, error: ocErr } = await supabase.from('orders').select('user_id');
  if (ocErr) throw new ApiError(500, ocErr.message);
  const countByUser = {};
  for (const o of orderCounts) countByUser[o.user_id] = (countByUser[o.user_id] || 0) + 1;

  // Supabase Auth owns email, not `profiles` — fetch it via the admin API.
  // Fetched before filtering so search can still match against email,
  // matching the original behavior (search matched username OR email).
  const { data: authList, error: authErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (authErr) throw new ApiError(500, authErr.message);
  const emailById = {};
  for (const u of authList.users) emailById[u.id] = u.email;

  const filtered = search
    ? users.filter(u =>
        u.username.toLowerCase().includes(search) ||
        (emailById[u.id] || '').toLowerCase().includes(search))
    : users;

  res.json({
    success: true,
    count: filtered.length,
    users: filtered.map(u => ({
      id: u.id,
      name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username,
      email: emailById[u.id] || '—',
      balance: u.wallet_balance,
      orders: countByUser[u.id] || 0,
      joined: u.created_at,
      status: u.status,
      role: u.role
    }))
  });
});

// PATCH /api/admin/users/:id/ban
exports.toggleBan = asyncHandler(async (req, res) => {
  const { data: user, error: findErr } = await supabase.from('profiles').select('id, role, status').eq('id', req.params.id).maybeSingle();
  if (findErr) throw new ApiError(500, findErr.message);
  if (!user) throw ApiError.notFound('User not found');
  if (user.role === 'admin') throw ApiError.badRequest('Cannot ban an admin account');

  const nextStatus = user.status === 'banned' ? 'active' : 'banned';
  const { data: updated, error } = await supabase
    .from('profiles').update({ status: nextStatus }).eq('id', user.id).select('id, status').single();
  if (error) throw new ApiError(500, error.message);

  res.json({ success: true, user: updated });
});

// GET /api/admin/orders
exports.listOrders = asyncHandler(async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || 50);
  const from  = (page - 1) * limit;
  const to    = from + limit - 1;

  const { data: orders, error, count } = await supabase
    .from('orders')
    .select('order_id, user_id, service_type, phone_number, country, user_cost, provider, status, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);
  if (error) throw new ApiError(500, error.message);

  const { data: authList, error: authErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (authErr) throw new ApiError(500, authErr.message);
  const emailById = {};
  for (const u of authList.users) emailById[u.id] = u.email;

  res.json({
    success: true, page, limit, total: count,
    orders: orders.map(o => ({
      id: o.order_id,
      user: emailById[o.user_id] || '—',
      service: o.service_type,
      number: o.phone_number,
      country: o.country,
      cost: o.user_cost,
      provider: o.provider,
      status: o.status,
      date: o.created_at
    }))
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add controllers/adminController.js
git commit -m "feat: rewrite adminController for Supabase"
```

---

## Task 9: Rewrite `controllers/productController.js` and `controllers/apiProviderController.js`

**Files:**
- Modify: `controllers/productController.js`
- Modify: `controllers/apiProviderController.js`

**Interfaces:**
- Consumes: `supabase` (Task 2).
- Produces: unchanged export names for both files — `routes/productRoutes.js` and `routes/apiProviderRoutes.js` need no changes.

- [ ] **Step 1: Rewrite `controllers/productController.js`**

Replace the entire contents with:

```js
/**
 * Product controller — admin-managed catalog (CRUD) + public listing.
 */
const { supabase } = require('../config/supabase');
const ApiError     = require('../utils/apiError');
const asyncHandler = require('../utils/asyncHandler');

const slugify = (s) => String(s || '')
  .toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '') || 'item';

const shape = (p) => ({
  id: p.id,
  name: p.name,
  description: p.description,
  price: p.price,
  imageUrl: p.image_url,
  color: p.color,
  stock: p.stock,
  stockLabel: p.stock_label,
  apiProvider: p.api_provider,
  enabled: p.enabled,
  featured: p.featured,
  sortOrder: p.sort_order,
  categoryId: p.category_id,
  category: p.categories ? { id: p.categories.id, name: p.categories.name, slug: p.categories.slug } : null,
  createdAt: p.created_at
});

const stockText = (p) => {
  if (p.stockLabel) return p.stockLabel;
  if (p.stock === 0) return 'Out of stock';
  return 'In stock';
};

// ═════════════════════════════════════════════
// PUBLIC
// ═════════════════════════════════════════════

// GET /api/products
exports.listPublic = asyncHandler(async (req, res) => {
  let query = supabase.from('products').select('*, categories(*)').eq('enabled', true);
  if (req.query.category && req.query.category !== 'all') {
    query = query.eq('categories.slug', req.query.category);
  }
  const { data, error } = await query.order('sort_order', { ascending: true }).order('created_at', { ascending: false });
  if (error) throw new ApiError(500, error.message);

  const shaped = data.map(shape);
  res.json({ success: true, count: shaped.length, products: shaped.map(p => ({ ...p, stockText: stockText(p) })) });
});

// GET /api/products/categories
exports.listCategoriesPublic = asyncHandler(async (_req, res) => {
  const { data, error } = await supabase
    .from('categories').select('*').eq('active', true)
    .order('sort_order', { ascending: true }).order('name', { ascending: true });
  if (error) throw new ApiError(500, error.message);
  res.json({ success: true, categories: data.map(c => ({ id: c.id, name: c.name, slug: c.slug, icon: c.icon })) });
});

// ═════════════════════════════════════════════
// ADMIN — PRODUCTS
// ═════════════════════════════════════════════

exports.adminList = asyncHandler(async (_req, res) => {
  const { data, error } = await supabase
    .from('products').select('*, categories(*)')
    .order('sort_order', { ascending: true }).order('created_at', { ascending: false });
  if (error) throw new ApiError(500, error.message);
  res.json({ success: true, count: data.length, products: data.map(shape) });
});

exports.adminCreate = asyncHandler(async (req, res) => {
  const { name, description, price, imageUrl, color, stock, stockLabel, apiProvider, categoryId, enabled, featured, sortOrder } = req.body;
  if (!name || !String(name).trim()) throw ApiError.badRequest('Product name is required');
  if (price == null || isNaN(parseFloat(price))) throw ApiError.badRequest('Valid price is required');

  const { data, error } = await supabase.from('products').insert({
    name: String(name).trim(),
    description: description || null,
    price: parseFloat(price),
    image_url: imageUrl || null,
    color: color || null,
    stock: stock == null ? -1 : parseInt(stock, 10),
    stock_label: stockLabel || null,
    api_provider: apiProvider || 'manual',
    category_id: categoryId || null,
    enabled: enabled == null ? true : !!enabled,
    featured: !!featured,
    sort_order: sortOrder == null ? 0 : parseInt(sortOrder, 10)
  }).select('*, categories(*)').single();
  if (error) throw new ApiError(500, error.message);

  res.status(201).json({ success: true, product: shape(data) });
});

exports.adminUpdate = asyncHandler(async (req, res) => {
  const { data: existing, error: findErr } = await supabase.from('products').select('id').eq('id', req.params.id).maybeSingle();
  if (findErr) throw new ApiError(500, findErr.message);
  if (!existing) throw ApiError.notFound('Product not found');

  const b = req.body;
  const data = {};
  if (b.name != null)        data.name = String(b.name).trim();
  if (b.description != null) data.description = b.description || null;
  if (b.price != null)       data.price = parseFloat(b.price);
  if (b.imageUrl != null)    data.image_url = b.imageUrl || null;
  if (b.color != null)       data.color = b.color || null;
  if (b.stock != null)       data.stock = parseInt(b.stock, 10);
  if (b.stockLabel != null)  data.stock_label = b.stockLabel || null;
  if (b.apiProvider != null) data.api_provider = b.apiProvider || 'manual';
  if (b.categoryId !== undefined) data.category_id = b.categoryId || null;
  if (b.enabled != null)     data.enabled = !!b.enabled;
  if (b.featured != null)    data.featured = !!b.featured;
  if (b.sortOrder != null)   data.sort_order = parseInt(b.sortOrder, 10);

  const { data: product, error } = await supabase.from('products').update(data).eq('id', req.params.id).select('*, categories(*)').single();
  if (error) throw new ApiError(500, error.message);
  res.json({ success: true, product: shape(product) });
});

exports.adminToggle = asyncHandler(async (req, res) => {
  const { data: existing, error: findErr } = await supabase.from('products').select('enabled').eq('id', req.params.id).maybeSingle();
  if (findErr) throw new ApiError(500, findErr.message);
  if (!existing) throw ApiError.notFound('Product not found');

  const { data: product, error } = await supabase
    .from('products').update({ enabled: !existing.enabled }).eq('id', req.params.id).select('*, categories(*)').single();
  if (error) throw new ApiError(500, error.message);
  res.json({ success: true, product: shape(product) });
});

exports.adminDelete = asyncHandler(async (req, res) => {
  const { data: existing, error: findErr } = await supabase.from('products').select('id').eq('id', req.params.id).maybeSingle();
  if (findErr) throw new ApiError(500, findErr.message);
  if (!existing) throw ApiError.notFound('Product not found');

  const { error } = await supabase.from('products').delete().eq('id', req.params.id);
  if (error) throw new ApiError(500, error.message);
  res.json({ success: true, message: 'Product deleted' });
});

// ═════════════════════════════════════════════
// ADMIN — CATEGORIES
// ═════════════════════════════════════════════

exports.adminListCategories = asyncHandler(async (_req, res) => {
  const { data, error } = await supabase
    .from('categories').select('*, products(count)')
    .order('sort_order', { ascending: true }).order('name', { ascending: true });
  if (error) throw new ApiError(500, error.message);

  res.json({
    success: true,
    categories: data.map(c => ({
      id: c.id, name: c.name, slug: c.slug, icon: c.icon, sortOrder: c.sort_order,
      active: c.active, productCount: c.products?.[0]?.count || 0
    }))
  });
});

exports.adminCreateCategory = asyncHandler(async (req, res) => {
  const { name, icon, sortOrder } = req.body;
  if (!name || !String(name).trim()) throw ApiError.badRequest('Category name is required');

  const base = slugify(name);
  let slug = base, n = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data: taken } = await supabase.from('categories').select('id').eq('slug', slug).maybeSingle();
    if (!taken) break;
    slug = `${base}-${n++}`;
  }

  const { data, error } = await supabase.from('categories').insert({
    name: String(name).trim(), slug, icon: icon || null, sort_order: sortOrder == null ? 0 : parseInt(sortOrder, 10)
  }).select().single();
  if (error) throw new ApiError(500, error.message);
  res.status(201).json({ success: true, category: data });
});

exports.adminUpdateCategory = asyncHandler(async (req, res) => {
  const { data: existing, error: findErr } = await supabase.from('categories').select('id').eq('id', req.params.id).maybeSingle();
  if (findErr) throw new ApiError(500, findErr.message);
  if (!existing) throw ApiError.notFound('Category not found');

  const b = req.body;
  const data = {};
  if (b.name != null)      data.name = String(b.name).trim();
  if (b.icon != null)      data.icon = b.icon || null;
  if (b.sortOrder != null) data.sort_order = parseInt(b.sortOrder, 10);
  if (b.active != null)    data.active = !!b.active;

  const { data: cat, error } = await supabase.from('categories').update(data).eq('id', req.params.id).select().single();
  if (error) throw new ApiError(500, error.message);
  res.json({ success: true, category: cat });
});

exports.adminDeleteCategory = asyncHandler(async (req, res) => {
  const { data: existing, error: findErr } = await supabase.from('categories').select('id').eq('id', req.params.id).maybeSingle();
  if (findErr) throw new ApiError(500, findErr.message);
  if (!existing) throw ApiError.notFound('Category not found');

  const { error } = await supabase.from('categories').delete().eq('id', req.params.id);
  if (error) throw new ApiError(500, error.message);
  res.json({ success: true, message: 'Category deleted' });
});

// GET /api/admin/providers
exports.adminListProviders = asyncHandler(async (_req, res) => {
  const env = require('../config/env');
  const builtIn = [
    { id: 'manual', name: 'Manual fulfilment', configured: true },
    { id: 'sureverifications', name: 'SureVerifications', configured: !!(env.sms.sureVerifications && env.sms.sureVerifications.apiKey) }
  ];
  const { data, error } = await supabase.from('api_providers').select('*').eq('enabled', true).order('name', { ascending: true });
  if (error) throw new ApiError(500, error.message);

  res.json({
    success: true,
    providers: [...builtIn, ...data.map(p => ({ id: p.slug, name: p.name, configured: !!p.api_key_enc }))]
  });
});
```

- [ ] **Step 2: Rewrite `controllers/apiProviderController.js`**

Replace the entire contents with:

```js
/**
 * API Provider controller — admin CRUD for 3rd-party integrations.
 */
const { supabase } = require('../config/supabase');
const ApiError     = require('../utils/apiError');
const asyncHandler = require('../utils/asyncHandler');
const { encrypt, maskSecret } = require('../utils/crypto');

const slugify = (s) => String(s || '')
  .toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '') || 'provider';

const shape = (p, rawKey) => ({
  id: p.id,
  name: p.name,
  slug: p.slug,
  baseUrl: p.base_url,
  authHeader: p.auth_header,
  hasKey: !!p.api_key_enc,
  keyPreview: rawKey ? maskSecret(rawKey) : (p.api_key_enc ? '••••••••' : null),
  notes: p.notes,
  enabled: p.enabled,
  createdAt: p.created_at
});

exports.list = asyncHandler(async (_req, res) => {
  const { data, error } = await supabase.from('api_providers').select('*').order('name', { ascending: true });
  if (error) throw new ApiError(500, error.message);
  res.json({ success: true, count: data.length, providers: data.map(p => shape(p)) });
});

exports.create = asyncHandler(async (req, res) => {
  const { name, baseUrl, authHeader, apiKey, notes, enabled } = req.body;
  if (!name || !String(name).trim()) throw ApiError.badRequest('Provider name is required');
  if (!baseUrl || !String(baseUrl).trim()) throw ApiError.badRequest('Base URL is required');

  const base = slugify(name);
  let slug = base, n = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data: taken } = await supabase.from('api_providers').select('id').eq('slug', slug).maybeSingle();
    if (!taken) break;
    slug = `${base}-${n++}`;
  }

  const { data, error } = await supabase.from('api_providers').insert({
    name: String(name).trim(), slug, base_url: String(baseUrl).trim(),
    auth_header: (authHeader || 'x-api-key').trim(), api_key_enc: apiKey ? encrypt(apiKey) : null,
    notes: notes || null, enabled: enabled == null ? true : !!enabled
  }).select().single();
  if (error) throw new ApiError(500, error.message);

  res.status(201).json({ success: true, provider: shape(data, apiKey) });
});

exports.update = asyncHandler(async (req, res) => {
  const { data: existing, error: findErr } = await supabase.from('api_providers').select('id').eq('id', req.params.id).maybeSingle();
  if (findErr) throw new ApiError(500, findErr.message);
  if (!existing) throw ApiError.notFound('Provider not found');

  const b = req.body;
  const data = {};
  if (b.name != null)       data.name = String(b.name).trim();
  if (b.baseUrl != null)    data.base_url = String(b.baseUrl).trim();
  if (b.authHeader != null) data.auth_header = String(b.authHeader).trim() || 'x-api-key';
  if (b.notes != null)      data.notes = b.notes || null;
  if (b.enabled != null)    data.enabled = !!b.enabled;
  if (b.apiKey) data.api_key_enc = encrypt(b.apiKey);

  const { data: provider, error } = await supabase.from('api_providers').update(data).eq('id', req.params.id).select().single();
  if (error) throw new ApiError(500, error.message);
  res.json({ success: true, provider: shape(provider, b.apiKey || null) });
});

exports.toggle = asyncHandler(async (req, res) => {
  const { data: existing, error: findErr } = await supabase.from('api_providers').select('enabled').eq('id', req.params.id).maybeSingle();
  if (findErr) throw new ApiError(500, findErr.message);
  if (!existing) throw ApiError.notFound('Provider not found');

  const { data: provider, error } = await supabase
    .from('api_providers').update({ enabled: !existing.enabled }).eq('id', req.params.id).select().single();
  if (error) throw new ApiError(500, error.message);
  res.json({ success: true, provider: shape(provider) });
});

exports.remove = asyncHandler(async (req, res) => {
  const { data: existing, error: findErr } = await supabase.from('api_providers').select('id').eq('id', req.params.id).maybeSingle();
  if (findErr) throw new ApiError(500, findErr.message);
  if (!existing) throw ApiError.notFound('Provider not found');

  const { error } = await supabase.from('api_providers').delete().eq('id', req.params.id);
  if (error) throw new ApiError(500, error.message);
  res.json({ success: true, message: 'Provider deleted' });
});

exports._getDecryptedKey = async (slug) => {
  const { decrypt } = require('../utils/crypto');
  const { data, error } = await supabase.from('api_providers').select('api_key_enc').eq('slug', slug).maybeSingle();
  if (error) throw new ApiError(500, error.message);
  return data && data.api_key_enc ? decrypt(data.api_key_enc) : null;
};
```

- [ ] **Step 3: Commit**

```bash
git add controllers/productController.js controllers/apiProviderController.js
git commit -m "feat: rewrite productController and apiProviderController for Supabase"
```

---

## Task 10: Update `server.js` and remove the old auth stack

**Files:**
- Modify: `server.js`
- Modify: `routes/walletRoutes.js` (drop `requireEmailVerified`, which no longer exists)
- Modify: `services/emailService.js` (remove now-dead auth-email exports)
- Modify: `package.json` (remove Prisma deps/scripts, add nothing new here — already added in Task 1/2)
- Delete: `controllers/authController.js`, `routes/authRoutes.js`, `utils/jwt.js`, `services/totpService.js`, `config/db.js`, `prisma/` (entire directory)

**Interfaces:**
- Consumes: `supabase` (Task 2).
- Produces: `server.js`'s `module.exports = app` — same shape tests import in Task 11.

- [ ] **Step 1: Remove the auth route mount and its import**

In `server.js`, delete this line:

```js
const authRoutes         = require('./routes/authRoutes');
```

And delete this line:

```js
app.use('/api/auth',    authRoutes);
```

- [ ] **Step 2: Replace the Prisma import with the Supabase client**

Replace:

```js
const { connectDB } = require('./config/db');
const { prisma }    = require('./config/db');
```

with:

```js
const { supabase } = require('./config/supabase');
```

- [ ] **Step 3: Rewrite `/api/dbcheck` to check Supabase instead of Prisma**

Replace the entire `/api/dbcheck` route handler (from `app.get('/api/dbcheck', ...)` through its closing `});`) with:

```js
app.get('/api/dbcheck', protect, requireRole('admin'), async (_req, res) => {
  const started = Date.now();
  try {
    const { error } = await supabase.from('categories').select('id').limit(1);
    if (error) throw error;
    res.json({ ok: true, latencyMs: Date.now() - started });
  } catch (err) {
    res.status(503).json({ ok: false, latencyMs: Date.now() - started, error: err.message });
  }
});
```

- [ ] **Step 4: Remove the `connectDB()` call in `start()`**

In the `start` function, delete this line:

```js
  await connectDB();
```

(Supabase-js makes plain HTTPS requests — there's no connection to establish at boot.)

- [ ] **Step 5: Remove the `disconnectDB()` call in `shutdown()`**

Replace:

```js
      require('./config/db').disconnectDB().then(() => process.exit(0));
```

with:

```js
      process.exit(0);
```

- [ ] **Step 6: Rewrite the background job to use Supabase**

Replace the entire `startBackgroundJobs` function with:

```js
const startBackgroundJobs = () => {
  const numberCtrl = require('./controllers/numberController');
  const { toCamelCase } = require('./utils/caseMapper');

  setInterval(async () => {
    try {
      const { data: expired, error } = await supabase
        .from('orders')
        .select('*')
        .eq('status', 'active')
        .lt('expires_at', new Date().toISOString())
        .limit(50);
      if (error) throw error;

      for (const orderRow of expired) {
        const { data: updatedRow, error: updateErr } = await supabase
          .from('orders').update({ status: 'expired' }).eq('id', orderRow.id).select().single();
        if (updateErr) { logger.error('Auto-expire update failed:', updateErr.message); continue; }

        await numberCtrl._refundOrder(toCamelCase(updatedRow), 'No SMS received within window')
          .catch(err => logger.error(`Auto-refund failed for ${orderRow.order_id}:`, err.stack || err.message));
      }

      if (expired.length) logger.info(`Auto-expired ${expired.length} stale orders`);
    } catch (err) {
      logger.error('Background job error:', err.stack || err.message);
    }
  }, 60_000);
};
```

Note: the old keep-alive `SELECT 1` (needed because Prisma's pooled Postgres connection would go idle and get dropped) is gone entirely — `supabase-js` makes a fresh HTTPS request each time, so there's no persistent connection to keep warm.

- [ ] **Step 7: Update the `/api` index route's endpoint list**

Replace:

```js
    endpoints: ['/api/auth', '/api/wallet', '/api/numbers', '/api/users', '/api/payments', '/api/v1']
```

with:

```js
    endpoints: ['/api/wallet', '/api/numbers', '/api/users', '/api/payments', '/api/v1']
```

- [ ] **Step 8: Drop `requireEmailVerified` from `routes/walletRoutes.js`**

In `routes/walletRoutes.js`, replace:

```js
const { protect, requireEmailVerified } = require('../middleware/auth');
```

with:

```js
const { protect } = require('../middleware/auth');
```

And replace:

```js
router.post('/topup', requireEmailVerified, topupRules, validate, c.initiateTopup);
```

with:

```js
router.post('/topup', topupRules, validate, c.initiateTopup);
```

(Supabase Auth's own email-confirmation setting, configured in the Supabase dashboard, is the new gate for unverified accounts signing in at all — there's no separate backend-side flag to check anymore.)

- [ ] **Step 9: Remove the dead auth-email exports from `services/emailService.js`**

Remove the `sendVerificationEmail`, `sendPasswordResetEmail`, and `send2FACode` functions entirely (Supabase Auth sends these itself), and update the final export block from:

```js
module.exports = {
  send,
  sendVerificationEmail,
  sendPasswordResetEmail,
  send2FACode,
  sendOrderConfirmation,
  sendTopupConfirmation
};
```

to:

```js
module.exports = {
  send,
  sendOrderConfirmation,
  sendTopupConfirmation
};
```

- [ ] **Step 10: Delete the old auth stack and Prisma**

```bash
git rm controllers/authController.js routes/authRoutes.js utils/jwt.js services/totpService.js config/db.js
git rm -r prisma/
```

- [ ] **Step 11: Remove Prisma from `package.json`**

Remove from `dependencies`:

```json
"@prisma/client": "^5.22.0",
"prisma": "^5.22.0",
```

Remove from `scripts`:

```json
"postinstall": "prisma generate || true",
"db:generate": "prisma generate",
"db:migrate": "prisma migrate dev",
"db:push": "prisma db push",
"db:studio": "prisma studio",
```

(Note: `"db:migrate": "node scripts/migrate.js"` from Task 1 stays — this removes only the old Prisma-specific scripts of the same and similar names, replaced already in Task 1.)

- [ ] **Step 12: Run `npm install` to update the lockfile**

```bash
npm install
```

- [ ] **Step 13: Verify the app still boots**

```bash
node --check server.js
```

Expected: no output (syntax is valid). Then:

```bash
NODE_ENV=test node -e "const app = require('./server'); console.log(typeof app);"
```

Expected: `function`

- [ ] **Step 14: Commit**

```bash
git add server.js routes/walletRoutes.js services/emailService.js package.json package-lock.json
git commit -m "feat: remove Prisma and custom JWT auth stack, wire server.js to Supabase"
```

---

## Task 11: Update the test suite

**Files:**
- Modify: `tests/setup.js`
- Modify: `tests/smoke.test.js`
- Modify: `tests/config.test.js`

**Interfaces:**
- Consumes: nothing new — this task only adjusts existing tests to match Tasks 1–10's changes.

- [ ] **Step 1: Update `tests/setup.js`**

Replace:

```js
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_only_jwt_secret_0123456789abcdef0123456789abcdef';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test_only_refresh_secret_abcdef0123456789abcdef0123';
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test_only_cookie_secret';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0'.repeat(64);
process.env.BCRYPT_ROUNDS = process.env.BCRYPT_ROUNDS || '4'; // fast hashing in tests

// Point at an unreachable DB by default. Smoke tests must not need a
// real database — they verify the app boots and routes behave, which is
// exactly what has broken in production before.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@127.0.0.1:59999/testdb';
process.env.DIRECT_URL = process.env.DIRECT_URL || process.env.DATABASE_URL;
```

with:

```js
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test_only_cookie_secret';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0'.repeat(64);

// Dummy Supabase credentials. Smoke tests must not need a real Supabase
// project — supabase-js only makes a network call when a route actually
// queries it, and every route tested here either doesn't touch the DB
// or is expected to fail auth before it would.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
```

- [ ] **Step 2: Update `tests/smoke.test.js`**

Replace the top env-setup block:

```js
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_not_used_in_production_0123456789abcdef';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test_refresh_secret_not_used_in_prod_0123456789ab';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0'.repeat(64);
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:5432/db';
```

with:

```js
process.env.NODE_ENV = 'test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0'.repeat(64);
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
```

Replace the `describe('auth endpoints respond correctly (no 500s)', ...)` block — `/api/auth/*` no longer exists, so these now target `/api/wallet/topup` (an existing protected POST route) instead:

```js
describe('protected endpoints respond correctly (no 500s)', () => {
  test('POST to a protected route without a token returns 401, not a crash', async () => {
    const res = await request(app)
      .post('/api/wallet/topup')
      .send({ amount: 10, method: 'stripe' })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(401);
  });

  test('protected route without a token returns 401', async () => {
    const res = await request(app).get('/api/users/me');
    expect(res.status).toBe(401);
  });

  test('protected route with a garbage token returns 401 (not 500)', async () => {
    const res = await request(app)
      .get('/api/users/me')
      .set('Authorization', 'Bearer not.a.real.token');
    expect(res.status).toBe(401);
  });
});
```

Replace the malformed-JSON test's target route (it was hitting `/api/auth/login`, which is gone) — in the `describe('error handling', ...)` block, replace:

```js
  test('malformed JSON body does not crash the server', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"bad json"');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
```

with:

```js
  test('malformed JSON body does not crash the server', async () => {
    const res = await request(app)
      .post('/api/wallet/topup')
      .set('Content-Type', 'application/json')
      .send('{"bad json"');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
```

- [ ] **Step 3: Update `tests/config.test.js`**

Remove the now-invalid `'database queries are bounded by a timeout'` test — that concern (half-open pooled connections hanging forever) was specific to Prisma's persistent connection pool and no longer applies with `supabase-js`'s per-request HTTPS calls. Delete this entire test:

```js
  test('database queries are bounded by a timeout', () => {
    // A half-open pooled connection used to hang requests forever.
    const db = read('config/db.js');
    expect(db).toMatch(/QUERY_TIMEOUT_MS/);
    expect(db).toMatch(/Promise\.race/);
  });
```

- [ ] **Step 4: Run the full test suite**

```bash
npm test
```

Expected: all tests pass (no failures, no unexpected skips).

- [ ] **Step 5: Commit**

```bash
git add tests/setup.js tests/smoke.test.js tests/config.test.js
git commit -m "test: adapt smoke and config tests for Supabase-based backend"
```

---

## Task 12: Final integration check and push

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite one more time**

```bash
npm test
```

Expected: all green.

- [ ] **Step 2: Confirm no remaining references to Prisma or the old auth stack**

```bash
grep -rln "require('@prisma/client')\|require(\"../config/db\")\|require('../config/db')\|authController\|utils/jwt\|totpService" --include="*.js" . --exclude-dir=node_modules --exclude-dir=docs
```

Expected: no output (empty).

- [ ] **Step 3: Push to GitHub**

```bash
git push origin main
```

- [ ] **Step 4: Manually verify against the live Supabase project**

Run the app locally with your real `.env` (Supabase URL/service-role key/SMS provider key) and confirm end-to-end:

```bash
npm start
```

Then, in another terminal, exercise a couple of real flows once you have a valid Supabase session token (get one via the Supabase dashboard's SQL editor or a quick `supabase.auth.admin.createUser` script, since the frontend auth pages aren't updated yet):

```bash
curl -s http://localhost:5099/health
curl -s http://localhost:5099/api/numbers/provider-check -H "Authorization: Bearer <a-real-supabase-token>"
```

Confirm `/health` returns `{"status":"ok",...}` and the authenticated route returns real data rather than a 401/500.
