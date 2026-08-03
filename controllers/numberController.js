/**
 * Number controller — buy, check, cancel, finish virtual numbers
 */
const { supabase } = require('../config/supabase');
const ApiError     = require('../utils/apiError');
const asyncHandler = require('../utils/asyncHandler');
const { getProvider, calculateUserPrice } = require('../services/smsProvider');
const { generateOrderId, getTimeRemaining } = require('../models/Order');
const wallet       = require('./walletController');
const email        = require('../services/emailService');
const logger       = require('../utils/logger');
const { toCamelCase } = require('../utils/caseMapper');

const FALLBACK_COUNTRIES = [
  { code: 'US', name: 'United States',  flag: '🇺🇸' },
  { code: 'GB', name: 'United Kingdom', flag: '🇬🇧' },
  { code: 'DE', name: 'Germany',        flag: '🇩🇪' },
  { code: 'FR', name: 'France',         flag: '🇫🇷' },
  { code: 'IN', name: 'India',          flag: '🇮🇳' },
  { code: 'BR', name: 'Brazil',         flag: '🇧🇷' },
  { code: 'CA', name: 'Canada',         flag: '🇨🇦' },
  { code: 'AU', name: 'Australia',      flag: '🇦🇺' },
  { code: 'RU', name: 'Russia',         flag: '🇷🇺' },
  { code: 'NG', name: 'Nigeria',        flag: '🇳🇬' },
  { code: 'PK', name: 'Pakistan',       flag: '🇵🇰' },
  { code: 'ID', name: 'Indonesia',      flag: '🇮🇩' },
  { code: 'TR', name: 'Turkey',         flag: '🇹🇷' },
  { code: 'MX', name: 'Mexico',         flag: '🇲🇽' },
  { code: 'PH', name: 'Philippines',    flag: '🇵🇭' },
  { code: 'VN', name: 'Vietnam',        flag: '🇻🇳' },
  { code: 'UA', name: 'Ukraine',        flag: '🇺🇦' },
  { code: 'ZA', name: 'South Africa',   flag: '🇿🇦' },
  { code: 'EG', name: 'Egypt',          flag: '🇪🇬' },
  { code: 'SA', name: 'Saudi Arabia',   flag: '🇸🇦' },
  { code: 'AE', name: 'UAE',            flag: '🇦🇪' },
  { code: 'KE', name: 'Kenya',          flag: '🇰🇪' },
  { code: 'GH', name: 'Ghana',          flag: '🇬🇭' },
  { code: 'JP', name: 'Japan',          flag: '🇯🇵' },
  { code: 'KR', name: 'South Korea',    flag: '🇰🇷' },
  { code: 'MY', name: 'Malaysia',       flag: '🇲🇾' },
  { code: 'SG', name: 'Singapore',      flag: '🇸🇬' },
  { code: 'TH', name: 'Thailand',       flag: '🇹🇭' }
];

exports.providerCheck = asyncHandler(async (_req, res) => {
  const provider = getProvider();
  const out = { provider: provider.name, keyConfigured: false, balance: null, countriesCount: null, errors: {} };
  try {
    const env = require('../config/env');
    out.keyConfigured = !!(env.sms.sureVerifications && env.sms.sureVerifications.apiKey);
    out.baseUrl = env.sms.sureVerifications && env.sms.sureVerifications.baseUrl;
  } catch (_e) {}
  if (typeof provider.getBalance === 'function') {
    try { out.balance = await provider.getBalance(); }
    catch (err) { out.errors.balance = err.response?.data || err.message; }
  }
  if (typeof provider.getCountries === 'function') {
    try { const c = await provider.getCountries(); out.countriesCount = Array.isArray(c) ? c.length : 0; }
    catch (err) { out.errors.countries = err.response?.data || err.message; }
  }
  out.ok = out.balance !== null && Object.keys(out.errors).length === 0;
  res.json(out);
});

exports.listCountries = asyncHandler(async (_req, res) => {
  const provider = getProvider();
  if (typeof provider.getCountries === 'function') {
    try {
      const raw = await provider.getCountries();
      const countries = raw.map(c => {
        if (typeof c === 'string') return { code: c.toUpperCase(), name: c, flag: '' };
        return {
          code: (c.code || c.iso || c.country || '').toUpperCase(),
          name: c.name || c.country_name || c.code || '',
          flag: c.flag || ''
        };
      }).filter(c => c.code);
      return res.json({ success: true, count: countries.length, countries, source: 'live' });
    } catch (err) {
      logger.warn('Live countries fetch failed, using fallback:', err.message);
    }
  }
  res.json({ success: true, count: FALLBACK_COUNTRIES.length, countries: FALLBACK_COUNTRIES, source: 'static' });
});

const FALLBACK_SERVICES = [
  { code: 'whatsapp',  name: 'WhatsApp',    icon: 'whatsapp'  },
  { code: 'telegram',  name: 'Telegram',    icon: 'telegram'  },
  { code: 'google',    name: 'Google',      icon: 'google'    },
  { code: 'facebook',  name: 'Facebook',    icon: 'facebook'  },
  { code: 'instagram', name: 'Instagram',   icon: 'instagram' },
  { code: 'twitter',   name: 'Twitter / X', icon: 'twitter'   },
  { code: 'tiktok',    name: 'TikTok',      icon: 'tiktok'    },
  { code: 'uber',      name: 'Uber',        icon: 'uber'      },
  { code: 'amazon',    name: 'Amazon',      icon: 'amazon'    },
  { code: 'paypal',    name: 'PayPal',      icon: 'paypal'    },
  { code: 'microsoft', name: 'Microsoft',   icon: 'microsoft' },
  { code: 'discord',   name: 'Discord',     icon: 'discord'   },
  { code: 'any',       name: 'Any Service', icon: 'any'       }
];

exports.listServices = asyncHandler(async (_req, res) => {
  const provider = getProvider();
  if (typeof provider.getServices === 'function') {
    try {
      const raw = await provider.getServices('server1');
      const services = raw.map(s => {
        if (typeof s === 'string') return { code: s.toLowerCase(), name: s, icon: s.toLowerCase() };
        return {
          code: (s.code || s.service || s.name || '').toLowerCase(),
          name: s.name || s.service || s.code || '',
          icon: (s.icon || s.code || s.name || '').toLowerCase()
        };
      }).filter(s => s.code);
      return res.json({ success: true, services, source: 'live' });
    } catch (err) {
      logger.warn('Live services fetch failed, using fallback:', err.message);
    }
  }
  res.json({ success: true, services: FALLBACK_SERVICES, source: 'static' });
});

exports.getPrice = asyncHandler(async (req, res) => {
  const { country, service = 'any' } = req.query;
  if (!country) throw ApiError.badRequest('Country required');
  const provider  = getProvider();
  const { cost, count, currency } = await provider.getPrice(country.toUpperCase(), service);
  const userPrice = calculateUserPrice(cost);
  res.json({
    success: true, country: country.toUpperCase(), service, providerCost: cost, userPrice,
    currency: 'USD', providerCurrency: currency, available: count, provider: provider.name
  });
});

// ═════════════════════════════════════════════
// POST /api/numbers/buy
// ═════════════════════════════════════════════
exports.buyNumber = asyncHandler(async (req, res) => {
  const { serviceType, country, service } = req.body;

  if (!['whatsapp', 'sms'].includes(serviceType)) throw ApiError.badRequest('Invalid service type');
  if (!country) throw ApiError.badRequest('Country required');

  const targetService = serviceType === 'whatsapp' ? 'whatsapp' : (service || 'any');

  const provider = getProvider();
  let priceInfo;
  try {
    priceInfo = await provider.getPrice(country.toUpperCase(), targetService);
  } catch (_err) {
    throw ApiError.badRequest('Pricing unavailable for this combo');
  }

  const userCost = calculateUserPrice(priceInfo.cost);
  if (req.user.walletBalance < userCost) {
    throw ApiError.badRequest(
      `Insufficient balance. Need $${userCost.toFixed(2)}, have $${req.user.walletBalance.toFixed(2)}`
    );
  }

  let purchase;
  try {
    purchase = await provider.buyNumber(country.toUpperCase(), targetService);
  } catch (err) {
    logger.error('Provider buyNumber failed:', err.stack || err.message);
    throw err;
  }

  const expiresAtDate = purchase.expiresAt ? new Date(purchase.expiresAt) : new Date(Date.now() + 20 * 60 * 1000);

  const { data: orderRow, error: orderErr } = await supabase.from('orders').insert({
    user_id: req.userId,
    order_id: generateOrderId(),
    provider: provider.name,
    provider_order_id: purchase.providerOrderId,
    service_type: serviceType,
    service: targetService,
    country: country.toUpperCase(),
    phone_number: purchase.phoneNumber,
    provider_cost: priceInfo.cost,
    user_cost: userCost,
    status: 'active',
    activated_at: new Date().toISOString(),
    expires_at: expiresAtDate.toISOString(),
    ip_address: req.ip,
    user_agent: req.get('User-Agent')
  }).select().single();
  if (orderErr) throw new ApiError(500, orderErr.message);

  const order = toCamelCase(orderRow);

  try {
    await wallet.debitWallet({
      userId: req.userId,
      amount: userCost,
      orderId: order.id,
      description: `${serviceType.toUpperCase()} ${country.toUpperCase()} ${order.phoneNumber}`
    });
  } catch (err) {
    await provider.cancelOrder(purchase.providerOrderId).catch(() => {});
    const { error: cancelErr } = await supabase.from('orders').update({ status: 'cancelled' }).eq('id', order.id);
    if (cancelErr) {
      logger.error(`Failed to mark order ${order.orderId} cancelled after debit failure — order may incorrectly remain active:`, cancelErr.message);
    }
    throw err;
  }

  email.sendOrderConfirmation(req.user, order).catch(e => logger.error('Order email:', e.stack || e.message));

  logger.info(`Order ${order.orderId} created: ${order.phoneNumber} ($${userCost})`);

  res.status(201).json({
    success: true,
    order: {
      id: order.id, orderId: order.orderId, phoneNumber: order.phoneNumber, country: order.country,
      serviceType: order.serviceType, service: order.service, cost: order.userCost, status: order.status,
      expiresAt: order.expiresAt, timeRemainingMs: getTimeRemaining(order)
    }
  });
});

const fetchOwnOrder = async (id, userId) => {
  const { data, error } = await supabase.from('orders').select('*').eq('id', id).eq('user_id', userId).maybeSingle();
  if (error) throw new ApiError(500, error.message);
  return data ? toCamelCase(data) : null;
};

// ═════════════════════════════════════════════
// GET /api/numbers/orders/:id/status
// ═════════════════════════════════════════════
exports.checkOrderStatus = asyncHandler(async (req, res) => {
  let order = await fetchOwnOrder(req.params.id, req.userId);
  if (!order) throw ApiError.notFound('Order not found');

  const now = new Date();

  if (order.status === 'active' && new Date(order.expiresAt) > now) {
    try {
      const provider = getProvider(order.provider);
      const status   = await provider.checkOrder(order.providerOrderId);

      if (status.sms && status.sms.length) {
        const { data, error } = await supabase.from('orders').update({
          sms_messages: status.sms, otp_code: status.otpCode, status: 'received', completed_at: now.toISOString()
        }).eq('id', order.id).select().single();
        if (error) throw new ApiError(500, error.message);
        order = toCamelCase(data);
        provider.finishOrder(order.providerOrderId).catch(() => {});
      } else if (status.status === 'cancelled') {
        const { data, error } = await supabase.from('orders').update({
          status: 'cancelled', cancelled_at: now.toISOString()
        }).eq('id', order.id).select().single();
        if (error) throw new ApiError(500, error.message);
        order = toCamelCase(data);
        await refundOrder(order, 'Provider cancelled');
      }
    } catch (err) {
      logger.error('checkOrderStatus provider error:', err.stack || err.message);
    }
  }

  if (order.status === 'active' && new Date(order.expiresAt) < now) {
    const { data, error } = await supabase.from('orders').update({ status: 'expired' }).eq('id', order.id).select().single();
    if (error) throw new ApiError(500, error.message);
    order = toCamelCase(data);
    await refundOrder(order, 'No SMS received within window');
  }

  res.json({
    success: true,
    order: {
      id: order.id, orderId: order.orderId, phoneNumber: order.phoneNumber, status: order.status,
      otpCode: order.otpCode, smsMessages: order.smsMessages, timeRemainingMs: getTimeRemaining(order)
    }
  });
});

// ═════════════════════════════════════════════
// POST /api/numbers/orders/:id/cancel
// ═════════════════════════════════════════════
exports.cancelOrder = asyncHandler(async (req, res) => {
  let order = await fetchOwnOrder(req.params.id, req.userId);
  if (!order) throw ApiError.notFound('Order not found');
  if (order.status !== 'active') throw ApiError.badRequest(`Cannot cancel order with status: ${order.status}`);

  try {
    const provider = getProvider(order.provider);
    await provider.cancelOrder(order.providerOrderId);
  } catch (err) {
    logger.warn('Provider cancel failed (continuing):', err.message);
  }

  const { data, error } = await supabase.from('orders').update({
    status: 'cancelled', cancelled_at: new Date().toISOString()
  }).eq('id', order.id).select().single();
  if (error) throw new ApiError(500, error.message);
  order = toCamelCase(data);

  await refundOrder(order, 'User cancelled');

  res.json({ success: true, message: 'Order cancelled and refunded', order });
});

// ═════════════════════════════════════════════
// GET /api/numbers/orders
// ═════════════════════════════════════════════
exports.listOrders = asyncHandler(async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);
  const from  = (page - 1) * limit;
  const to    = from + limit - 1;

  let query = supabase.from('orders').select('*', { count: 'exact' }).eq('user_id', req.userId);
  if (req.query.status)      query = query.eq('status', req.query.status);
  if (req.query.serviceType) query = query.eq('service_type', req.query.serviceType);
  if (req.query.country)     query = query.eq('country', req.query.country.toUpperCase());

  const { data, error, count } = await query.order('created_at', { ascending: false }).range(from, to);
  if (error) throw new ApiError(500, error.message);

  res.json({
    success: true, page, limit, total: count, totalPages: Math.ceil(count / limit), orders: toCamelCase(data)
  });
});

// ═════════════════════════════════════════════
// GET /api/numbers/orders/:id
// ═════════════════════════════════════════════
exports.getOrder = asyncHandler(async (req, res) => {
  const order = await fetchOwnOrder(req.params.id, req.userId);
  if (!order) throw ApiError.notFound('Order not found');
  res.json({ success: true, order });
});

// ── Helper: refund an order ─────────────────────────────────
async function refundOrder(order, reason) {
  if (order.refundedAt) return;

  const newStatus = order.status !== 'cancelled' ? 'refunded' : null;
  const description = `Refund for order ${order.orderId}: ${reason}`;

  const { data, error } = await supabase.rpc('refund_order', {
    p_order_id: order.id,
    p_user_id: order.userId,
    p_amount: order.userCost,
    p_description: description,
    p_refund_reason: reason,
    p_new_status: newStatus
  });
  if (error) {
    logger.error(`refundOrder RPC failed for order ${order.orderId}:`, error.message);
    throw new ApiError(500, error.message);
  }

  logger.info(`Order ${order.orderId} refunded: ${reason}`);
  return { user: { id: order.userId }, tx: { id: data[0].transaction_id } };
}

exports._refundOrder = refundOrder;
