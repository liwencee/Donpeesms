-- Adds purchasable monthly quotas to API keys (Developer API catalog
-- products). monthly_quota is nullable on purpose: null means unlimited
-- (both self-service keys created via Profile > API Keys, which are
-- unaffected by this migration, and the "Business" plan, which is
-- explicitly unlimited).
alter table api_keys add column monthly_quota int;
alter table api_keys add column quota_used int not null default 0;
alter table api_keys add column quota_reset_at timestamptz;

-- Atomically checks and consumes one unit of quota for a request.
-- Separate from increment_api_key_usage (0002), which is a fire-and-
-- forget lifetime counter for admin display and is left untouched.
-- This one is awaited by apiKeyAuth and must actually block the
-- request when quota is exhausted, so it raises instead of returning
-- a boolean — simpler to catch as a Postgres error in JS than to
-- thread a false-y result through a fire-and-forget call site.
create or replace function check_and_consume_api_quota(p_key_id uuid)
returns void
language plpgsql as $$
declare
  v_quota   int;
  v_used    int;
  v_reset   timestamptz;
begin
  select monthly_quota, quota_used, quota_reset_at
    into v_quota, v_used, v_reset
    from api_keys
    where id = p_key_id
    for update;

  -- No purchased plan on this key -> unlimited, nothing to enforce.
  if v_quota is null then
    return;
  end if;

  -- Period elapsed (or never started) -> start a fresh 30-day window.
  if v_reset is null or now() >= v_reset then
    v_used  := 0;
    v_reset := now() + interval '30 days';
  end if;

  if v_used >= v_quota then
    raise exception 'Monthly API quota exceeded' using errcode = 'P0001';
  end if;

  update api_keys
    set quota_used = v_used + 1,
        quota_reset_at = v_reset
    where id = p_key_id;
end;
$$;
