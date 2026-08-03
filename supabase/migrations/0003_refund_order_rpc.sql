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
  update profiles set wallet_balance = wallet_balance + p_amount, updated_at = now()
    where id = p_user_id
    returning wallet_balance into v_new_balance;
  if not found then raise exception 'User not found'; end if;

  insert into transactions (user_id, type, amount, balance_after, method, status, description, order_id)
  values (p_user_id, 'refund', p_amount, v_new_balance, 'system', 'success', p_description, p_order_id)
  returning id into v_tx_id;

  update orders set
    refunded_at = now(),
    refund_reason = p_refund_reason,
    refund_tx_id = v_tx_id,
    status = coalesce(p_new_status, status)
  where id = p_order_id;

  return query select v_new_balance, v_tx_id;
end;
$$;
