/**
 * User controller — profile, API keys, referral
 */
const User = require('../models/User');
const ApiKey = require('../models/ApiKey');
const Transaction = require('../models/Transaction');
const ApiError = require('../utils/apiError');
const asyncHandler = require('../utils/asyncHandler');

// ═════════════════════════════════════════════
// GET /api/users/me
// ═════════════════════════════════════════════
exports.getProfile = asyncHandler(async (req, res) => {
  res.json({ success: true, user: req.user.toSafeJSON() });
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

  const user = await User.findByIdAndUpdate(req.userId, updates, { new: true, runValidators: true });
  res.json({ success: true, user: user.toSafeJSON() });
});

// ═════════════════════════════════════════════
// DELETE /api/users/me
// ═════════════════════════════════════════════
exports.deleteAccount = asyncHandler(async (req, res) => {
  const user = await User.findById(req.userId).select('+password');
  const ok = await user.comparePassword(req.body.password || '');
  if (!ok) throw ApiError.unauthorized('Password required');

  user.status = 'banned';
  user.email = `deleted_${user._id}@deleted.donpeesms`;
  user.username = `deleted_${user._id}`;
  await user.save({ validateBeforeSave: false });

  res.clearCookie('accessToken');
  res.clearCookie('refreshToken', { path: '/api/auth' });
  res.json({ success: true, message: 'Account deleted' });
});

// ═════════════════════════════════════════════
// GET /api/users/api-keys
// ═════════════════════════════════════════════
exports.listApiKeys = asyncHandler(async (req, res) => {
  const keys = await ApiKey.find({ user: req.userId }).sort({ createdAt: -1 });
  res.json({ success: true, keys });
});

// ═════════════════════════════════════════════
// POST /api/users/api-keys
// ═════════════════════════════════════════════
exports.createApiKey = asyncHandler(async (req, res) => {
  const { name, scopes = ['read', 'write'] } = req.body;
  if (!name) throw ApiError.badRequest('Name required');

  const existing = await ApiKey.countDocuments({ user: req.userId, active: true });
  if (existing >= 5) throw ApiError.badRequest('Max 5 active API keys per account');

  const { raw, hash, prefix } = ApiKey.generateKey();

  const apiKey = await ApiKey.create({
    user: req.userId,
    name,
    keyPrefix: prefix,
    keyHash: hash,
    scopes
  });

  res.status(201).json({
    success: true,
    message: 'Save this key — it will not be shown again',
    apiKey: { id: apiKey._id, name, prefix, scopes, key: raw }
  });
});

// ═════════════════════════════════════════════
// DELETE /api/users/api-keys/:id
// ═════════════════════════════════════════════
exports.revokeApiKey = asyncHandler(async (req, res) => {
  const key = await ApiKey.findOneAndDelete({ _id: req.params.id, user: req.userId });
  if (!key) throw ApiError.notFound('API key not found');
  res.json({ success: true, message: 'API key revoked' });
});

// ═════════════════════════════════════════════
// GET /api/users/referral
// ═════════════════════════════════════════════
exports.getReferralStats = asyncHandler(async (req, res) => {
  const [referredCount, payouts] = await Promise.all([
    User.countDocuments({ referredBy: req.userId }),
    Transaction.aggregate([
      { $match: { user: req.user._id, type: 'referral_payout', status: 'success' } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ])
  ]);

  res.json({
    success: true,
    referralCode: req.user.referralCode,
    referralLink: `${require('../config/env').frontendUrl}/register?ref=${req.user.referralCode}`,
    totalReferred: referredCount,
    totalEarnings: req.user.referralEarnings,
    commissionRate: 0.10,
    payoutCount: payouts[0]?.count || 0
  });
});

// ═════════════════════════════════════════════
// GET /api/users/dashboard-stats
// ═════════════════════════════════════════════
exports.getDashboardStats = asyncHandler(async (req, res) => {
  const Order = require('../models/Order');

  const [orderStats, refundStats] = await Promise.all([
    Order.aggregate([
      { $match: { user: req.user._id } },
      {
        $group: {
          _id: null,
          totalOrders: { $sum: 1 },
          completedOrders: { $sum: { $cond: [{ $in: ['$status', ['received','completed']] }, 1, 0] } },
          totalSpent: { $sum: '$userCost' }
        }
      }
    ]),
    Transaction.aggregate([
      { $match: { user: req.user._id, type: 'refund', status: 'success' } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ])
  ]);

  const stats = orderStats[0] || { totalOrders: 0, completedOrders: 0, totalSpent: 0 };
  const refunds = refundStats[0] || { total: 0, count: 0 };

  res.json({
    success: true,
    stats: {
      walletBalance: req.user.walletBalance,
      totalOrders: stats.totalOrders,
      completedOrders: stats.completedOrders,
      successRate: stats.totalOrders ? +(stats.completedOrders / stats.totalOrders * 100).toFixed(1) : 0,
      totalSpent: +stats.totalSpent.toFixed(2),
      refundsCount: refunds.count,
      refundsTotal: +refunds.total.toFixed(2)
    }
  });
});
