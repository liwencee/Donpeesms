/**
 * Admin controller — cross-cutting admin views (users, orders).
 * All routes are gated by protect + requireRole('admin').
 */
const { supabase } = require('../config/supabase');
const ApiError     = require('../utils/apiError');
const asyncHandler = require('../utils/asyncHandler');
const maintenanceState = require('../utils/maintenanceState');

// GET /api/admin/users
exports.listUsers = asyncHandler(async (req, res) => {
  const search = (req.query.search || '').trim().toLowerCase();

  const { data: users, error } = await supabase
    .from('profiles')
    .select('id, first_name, last_name, username, wallet_balance, status, role, created_at')
    .order('created_at', { ascending: false });
  if (error) throw new ApiError(500, error.message);

  // Order counts per user (one query, grouped client-side — admin list
  // sizes are small enough that this is simpler and cheaper than N+1).
  const { data: orderCounts, error: ocErr } = await supabase.from('orders').select('user_id');
  if (ocErr) throw new ApiError(500, ocErr.message);
  const countByUser = {};
  for (const o of orderCounts) countByUser[o.user_id] = (countByUser[o.user_id] || 0) + 1;

  // Supabase Auth owns email, not `profiles` — fetch it via the admin API.
  // Fetched before filtering so search can still match against email,
  // matching the original behavior (search matched username OR email).
  const { data: authList, error: authErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (authErr) throw new ApiError(500, authErr.message);
  const emailById = {};
  for (const u of authList.users) emailById[u.id] = u.email;

  const filtered = search
    ? users.filter(u =>
        u.username.toLowerCase().includes(search) ||
        (emailById[u.id] || '').toLowerCase().includes(search))
    : users;

  res.json({
    success: true,
    count: filtered.length,
    users: filtered.map(u => ({
      id: u.id,
      name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username,
      email: emailById[u.id] || '—',
      balance: u.wallet_balance,
      orders: countByUser[u.id] || 0,
      joined: u.created_at,
      status: u.status,
      role: u.role
    }))
  });
});

// PATCH /api/admin/users/:id/ban
exports.toggleBan = asyncHandler(async (req, res) => {
  const { data: user, error: findErr } = await supabase.from('profiles').select('id, role, status').eq('id', req.params.id).maybeSingle();
  if (findErr) throw new ApiError(500, findErr.message);
  if (!user) throw ApiError.notFound('User not found');
  if (user.role === 'admin') throw ApiError.badRequest('Cannot ban an admin account');

  const nextStatus = user.status === 'banned' ? 'active' : 'banned';
  const { data: updated, error } = await supabase
    .from('profiles').update({ status: nextStatus }).eq('id', user.id).select('id, status').single();
  if (error) throw new ApiError(500, error.message);

  const { data: authUser, error: authErr } = await supabase.auth.admin.getUserById(user.id);
  if (authErr) throw new ApiError(500, authErr.message);

  res.json({ success: true, user: { ...updated, email: authUser.user?.email || '—' } });
});

// GET /api/admin/orders
exports.listOrders = asyncHandler(async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || 50);
  const from  = (page - 1) * limit;
  const to    = from + limit - 1;

  const { data: orders, error, count } = await supabase
    .from('orders')
    .select('order_id, user_id, service_type, phone_number, country, user_cost, provider, status, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);
  if (error) throw new ApiError(500, error.message);

  const { data: authList, error: authErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (authErr) throw new ApiError(500, authErr.message);
  const emailById = {};
  for (const u of authList.users) emailById[u.id] = u.email;

  res.json({
    success: true, page, limit, total: count,
    orders: orders.map(o => ({
      id: o.order_id,
      user: emailById[o.user_id] || '—',
      service: o.service_type,
      number: o.phone_number,
      country: o.country,
      cost: o.user_cost,
      provider: o.provider,
      status: o.status,
      date: o.created_at
    }))
  });
});

// GET /api/admin/maintenance
exports.getMaintenance = asyncHandler(async (req, res) => {
  res.json({ success: true, enabled: maintenanceState.isEnabled() });
});

// PATCH /api/admin/maintenance
exports.setMaintenance = asyncHandler(async (req, res) => {
  const enabled = !!req.body.enabled;
  await maintenanceState.setEnabled(enabled, req.userId);
  res.json({ success: true, enabled });
});
