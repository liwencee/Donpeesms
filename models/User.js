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
