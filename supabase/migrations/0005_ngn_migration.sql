-- Migrate the wallet/transaction/order currency model from USD to NGN.
-- profiles.wallet_balance is a single running total with no per-row
-- currency tag, so every existing balance must be rescaled now to
-- preserve real value (a $50 balance becomes ₦80,000 — same purchasing
-- power, new unit). This must ship in the same deploy as the NGN-aware
-- backend code — see docs/superpowers/specs/2026-08-06-drexpay-payment-migration-design.md.
update profiles set wallet_balance = wallet_balance * 1600;

-- transactions and orders keep their own per-row currency column —
-- historical rows correctly stay 'USD' (an accurate record of what
-- actually happened); only the default for newly-inserted rows changes.
alter table transactions alter column currency set default 'NGN';
alter table orders alter column currency set default 'NGN';
