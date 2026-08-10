-- Migrate the wallet/transaction/order currency model from USD to NGN.
-- Per explicit product decision, existing balances are NOT rescaled to
-- preserve value — they are reset to zero. No real DrexPay payment has
-- ever been processed (the gateway didn't exist until this migration),
-- so every non-zero balance on record is test/dev data, not money owed
-- to a user. This must ship in the same deploy as the NGN-aware backend
-- code — see docs/superpowers/specs/2026-08-06-drexpay-payment-migration-design.md.
update profiles set wallet_balance = 0;

-- transactions and orders keep their own per-row currency column —
-- historical rows correctly stay 'USD' (an accurate record of what
-- actually happened); only the default for newly-inserted rows changes.
alter table transactions alter column currency set default 'NGN';
alter table orders alter column currency set default 'NGN';
