/**
 * Admin controller — cross-cutting admin views (users, orders).
 * All routes are gated by protect + requireRole('admin').
 */
const { prisma }   = require('../config/db');
const ApiError     = require('../utils/apiError');
const asyncHandler = require('../utils/asyncHandler');

// GET /api/admin/users — real registered users with order counts
exports.listUsers = asyncHandler(async (req, res) => {
  const search = (req.query.search || '').trim();
  const where = search
    ? { OR: [{ email: { contains: search, mode: 'insensitive' } }, { username: { contains: search, mode: 'insensitive' } }] }
    : {};

  const users = await prisma.user.findMany({
    where,
    select: {
      id: true, firstName: true, lastName: true, username: true, email: true,
      walletBalance: true, status: true, role: true, createdAt: true,
      _count: { select: { orders: true } }
    },
    orderBy: { createdAt: 'desc' }
  });

  res.json({
    success: true,
    count: users.length,
    users: users.map(u => ({
      id: u.id,
      name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username,
      email: u.email,
      balance: u.walletBalance,
      orders: u._count.orders,
      joined: u.createdAt,
      status: u.status,
      role: u.role
    }))
  });
});

// PATCH /api/admin/users/:id/ban — toggle banned/active
exports.toggleBan = asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) throw ApiError.notFound('User not found');
  if (user.role === 'admin') throw ApiError.badRequest('Cannot ban an admin account');

  const nextStatus = user.status === 'banned' ? 'active' : 'banned';
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { status: nextStatus },
    select: { id: true, email: true, status: true }
  });
  res.json({ success: true, user: updated });
});

// GET /api/admin/orders — real orders across all users
exports.listOrders = asyncHandler(async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || 50);

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      include: { user: { select: { email: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit
    }),
    prisma.order.count()
  ]);

  res.json({
    success: true,
    page, limit, total,
    orders: orders.map(o => ({
      id: o.orderId,
      user: o.user?.email || '—',
      service: o.serviceType,
      number: o.phoneNumber,
      country: o.country,
      cost: o.userCost,
      provider: o.provider,
      status: o.status,
      date: o.createdAt
    }))
  });
});
