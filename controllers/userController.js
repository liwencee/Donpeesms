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
