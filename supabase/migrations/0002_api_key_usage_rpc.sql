create or replace function increment_api_key_usage(
  p_key_id uuid,
  p_ip text
) returns void
language plpgsql as $$
begin
  update api_keys
  set usage_count = usage_count + 1,
      last_used_at = now(),
      last_used_ip = p_ip
  where id = p_key_id;
end;
$$;
