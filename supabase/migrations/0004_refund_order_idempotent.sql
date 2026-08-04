-- ═══════════════════════════════════════════════
-- 0004 — Make refunds idempotent, and make signup survive a username clash.
--
-- Both fixes are `create or replace` only, so this file is safe to
-- re-run (scripts/migrate.js replays every migration on each invocation).
-- ═══════════════════════════════════════════════

-- ───────────────────────────────────────────────
-- refund_order — atomic AND idempotent.
--
-- 0003 credited the wallet first and updated `orders` unconditionally,
-- so the only double-refund guard was the application-level
-- `if (order.refundedAt) return;` read-then-act check in
-- numberController.refundOrder(). Two paths refund the same order and
-- routinely race: the 60s auto-expire background job in server.js, and
-- checkOrderStatus() when a user polls GET /orders/:id/status on an
-- order that just expired. Both could read refunded_at = null and both
-- credit the wallet — the user gets paid twice.
--
-- Now the `orders` UPDATE runs FIRST and doubles as the guard and the
-- row lock: `where refunded_at is null` means the second caller matches
-- zero rows, takes the `not found` branch, and returns without emitting
-- a row. Callers treat an empty result set as "already refunded".
--
-- NOTE: p_new_status keeps its `default null` — Postgres refuses to
-- remove a parameter default via CREATE OR REPLACE.
-- ───────────────────────────────────────────────
create or replace function refund_order(
  p_order_id uuid,
  p_user_id uuid,
  p_amount numeric,
  p_description text,
  p_refund_reason text,
  p_new_status text default null
) returns table (new_balance numeric, transaction_id uuid)
language plpgsql as $$
declare
  v_new_balance numeric;
  v_tx_id uuid;
begin
  -- Claim the refund first. This UPDATE is the idempotency guard AND the row
  -- lock: a concurrent caller for the same order finds refunded_at already set,
  -- matches zero rows, and returns without crediting anything a second time.
  update orders
    set refunded_at   = now(),
        refund_reason = p_refund_reason,
        status        = coalesce(p_new_status, status),
        updated_at    = now()
    where id = p_order_id and refunded_at is null;

  if not found then
    return;  -- already refunded; emit no rows
  end if;

  update profiles set wallet_balance = wallet_balance + p_amount, updated_at = now()
    where id = p_user_id
    returning wallet_balance into v_new_balance;
  if not found then raise exception 'User not found'; end if;

  insert into transactions (user_id, type, amount, balance_after, method, status, description, order_id)
  values (p_user_id, 'refund', p_amount, v_new_balance, 'system', 'success', p_description, p_order_id)
  returning id into v_tx_id;

  update orders set refund_tx_id = v_tx_id where id = p_order_id;

  return query select v_new_balance, v_tx_id;
end;
$$;

-- ───────────────────────────────────────────────
-- generate_referral_code / handle_new_user — pinned search_path.
--
-- handle_new_user runs `security definer` on an auth.users trigger; with
-- no search_path pinned, a schema earlier in the caller's search_path
-- could shadow `profiles` and run attacker-chosen code with the
-- definer's rights. This is also the standard Supabase security-linter
-- warning ("Function Search Path Mutable").
-- ───────────────────────────────────────────────
create or replace function generate_referral_code(p_username text) returns text
language sql
set search_path = public, pg_temp
as $$
  select lower(p_username) || substr(md5(random()::text), 1, 4);
$$;

-- handle_new_user — must never abort the auth.users insert.
--
-- Previously a duplicate username (or, less likely, a duplicate referral
-- code) raised a unique_violation that rolled back the whole signup and
-- surfaced to the frontend as the opaque "Database error saving new
-- user". Nothing else in the system validates username uniqueness since
-- the old authController's pre-check was deleted. So: retry on
-- unique_violation with a suffixed username until one is free.
--
-- The insert sits in its own BEGIN...EXCEPTION block (a subtransaction),
-- which is what makes retry-after-conflict possible and also makes this
-- correct under concurrent signups — unlike a pre-flight SELECT, which
-- would still race.
create or replace function handle_new_user() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_base        text;
  v_username    text;
  v_ref_code    text;
  v_referrer_id uuid;
  i             int;
begin
  -- Base username: metadata → email local-part → 'user'. Stripped of
  -- characters we never want in a handle, never empty, and capped so a
  -- collision suffix still fits profiles.username varchar(30).
  v_base := lower(regexp_replace(
    coalesce(
      nullif(trim(new.raw_user_meta_data->>'username'), ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'user'
    ),
    '[^a-zA-Z0-9._-]', '', 'g'));
  if v_base is null or v_base = '' then v_base := 'user'; end if;
  v_base := left(v_base, 24);

  select id into v_referrer_id
    from profiles
    where referral_code = nullif(new.raw_user_meta_data->>'referral_code', '');

  v_username := v_base;
  v_ref_code := generate_referral_code(v_username);

  for i in 0..49 loop
    begin
      insert into profiles (id, username, first_name, last_name, referral_code, referred_by_id)
      values (
        new.id,
        v_username,
        coalesce(new.raw_user_meta_data->>'first_name', ''),
        coalesce(new.raw_user_meta_data->>'last_name', ''),
        v_ref_code,
        v_referrer_id
      )
      on conflict (id) do nothing;  -- profile already exists: nothing to do
      return new;
    exception when unique_violation then
      -- username or referral_code taken — pick fresh ones and retry.
      if i < 8 then
        v_username := left(v_base, 26) || (i + 1)::text;
      else
        v_username := left(v_base, 20) || substr(md5(random()::text || clock_timestamp()::text), 1, 6);
      end if;
      v_ref_code := generate_referral_code(v_username);
    end;
  end loop;

  raise exception 'Could not allocate a unique username for new user %', new.id;
end;
$$;
