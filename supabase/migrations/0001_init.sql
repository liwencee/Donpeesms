-- ⚠️  THIS FILE IS ALREADY APPLIED TO PRODUCTION. Do not re-run it, and
-- never add `drop table` / `create table` for these tables to a NEW
-- migration file — that is exactly what wiped the products/categories
-- catalog once already (see utils/seedProducts.js, which was written to
-- recover from it). Future schema changes to existing tables belong in a
-- new migration using `alter table`, which preserves existing rows.
--
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
