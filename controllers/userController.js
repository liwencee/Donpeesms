/**
 * User controller — profile, API keys, referral, dashboard stats
 */
const { prisma }   = require('../config/db');
const { generateKey, findByKey } = require('../models/ApiKey');
const { comparePassword, toSafeJSON, USER_PUBLIC, USER_WITH_PASSWORD } = require('../models/User');
const ApiError     = require('../utils/apiError');
const asyncHandler = require('../utils/asyncHandler');

// ═════════════════════════════════════════════
// GET /api/users/me
// ═════════════════════════════════════════════
exports.getProfile = asyncHandler(async (req, res) => {
  res.json({ success: true, user: toSafeJSON(req.user) });
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

  const user = await prisma.user.update({
    where:  { id: req.userId },
    data:   updates,
    select: USER_PUBLIC
  });
  res.json({ success: true, user: toSafeJSON(user) });
});

// ═════════════════════════════════════════════
// DELETE /api/users/me
// ═════════════════════════════════════════════
exports.deleteAccount = asyncHandler(async (req, res) => {
  const userWithPass = await prisma.user.findUnique({
    where:  { id: req.userId },
    select: { id: true, password: true }
  });
  const ok = await comparePassword(userWithPass.password, req.body.password || '');
  if (!ok) throw ApiError.unauthorized('Password required');

  await prisma.user.update({
    where: { id: req.userId },
    data: {
      status:   'banned',
      email:    `deleted_${req.userId}@deleted.donpeesms`,
      username: `deleted_${req.userId}`
    }
  });

  res.clearCookie('accessToken');
  res.clearCookie('refreshToken', { path: '/api/auth' });
  res.json({ success: true, message: 'Account deleted' });
});

// ═════════════════════════════════════════════
// GET /api/users/api-keys
// ═════════════════════════════════════════════
exports.listApiKeys = asyncHandler(async (req, res) => {
  const keys = await prisma.apiKey.findMany({
    where:   { userId: req.userId },
    orderBy: { createdAt: 'desc' }
  });
  res.json({ success: true, keys });
});

// ═════════════════════════════════════════════
// POST /api/users/api-keys
// ═════════════════════════════════════════════
exports.createApiKey = asyncHandler(async (req, res) => {
  const { name, scopes = ['read', 'write'] } = req.body;
  if (!name) throw ApiError.badRequest('Name required');

  const existing = await prisma.apiKey.count({ where: { userId: req.userId, active: true } });
  if (existing >= 5) throw ApiError.badRequest('Max 5 active API keys per account');

  const { raw, hash, prefix } = generateKey();

  const apiKey = await prisma.apiKey.create({
    data: {
      userId:    req.userId,
      name,
      keyPrefix: prefix,
      keyHash:   hash,
      scopes
    }
  });

  res.status(201).json({
    success: true,
    message: 'Save this key — it will not be shown again',
    apiKey:  { id: apiKey.id, name, prefix, scopes, key: raw }
  });
});

// ═════════════════════════════════════════════
// DELETE /api/users/api-keys/:id
// ═════════════════════════════════════════════
exports.revokeApiKey = asyncHandler(async (req, res) => {
  const key = await prisma.apiKey.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!key) throw ApiError.notFound('API key not found');

  await prisma.apiKey.delete({ where: { id: req.params.id } });
  res.json({ success: true, message: 'API key revoked' });
});

// ═════════════════════════════════════════════
// GET /api/users/referral
// ═════════════════════════════════════════════
exports.getReferralStats = asyncHandler(async (req, res) => {
  const [referredCount, payoutAgg] = await Promise.all([
    prisma.user.count({ where: { referredById: req.userId } }),
    prisma.transaction.aggregate({
      where:  { userId: req.userId, type: 'referral_payout', status: 'success' },
      _sum:   { amount: true },
      _count: { id: true }
    })
  ]);

  res.json({
    success:        true,
    referralCode:   req.user.referralCode,
    referralLink:   `${require('../config/env').frontendUrl}/register?ref=${req.user.referralCode}`,
    totalReferred:  referredCount,
    totalEarnings:  req.user.referralEarnings,
    commissionRate: 0.10,
    payoutCount:    payoutAgg._count.id || 0
  });
});

// ═════════════════════════════════════════════
// GET /api/users/dashboard-stats
// ═════════════════════════════════════════════
exports.getDashboardStats = asyncHandler(async (req, res) => {
  const [orderAgg, completedCount, refundAgg] = await Promise.all([
    prisma.order.aggregate({
      where:  { userId: req.userId },
      _count: { id: true },
      _sum:   { userCost: true }
    }),
    prisma.order.count({
      where: { userId: req.userId, status: { in: ['received', 'completed'] } }
    }),
    prisma.transaction.aggregate({
      where:  { userId: req.userId, type: 'refund', status: 'success' },
      _sum:   { amount: true },
      _count: { id: true }
    })
  ]);

  const totalOrders = orderAgg._count.id      || 0;
  const totalSpent  = orderAgg._sum.userCost   || 0;
  const refundTotal = refundAgg._sum.amount    || 0;
  const refundCount = refundAgg._count.id      || 0;

  res.json({
    success: true,
    stats: {
      walletBalance:    req.user.walletBalance,
      totalOrders,
      completedOrders:  completedCount,
      successRate:      totalOrders
        ? +(completedCount / totalOrders * 100).toFixed(1)
        : 0,
      totalSpent:       +totalSpent.toFixed(2),
      refundsCount:     refundCount,
      refundsTotal:     +refundTotal.toFixed(2)
    }
  });
});

// Re-export for use in api-key middleware
exports._findByKey = findByKey;
