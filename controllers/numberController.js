/**
 * Number controller — buy, check, cancel, finish virtual numbers
 */
const { prisma }   = require('../config/db');
const ApiError     = require('../utils/apiError');
const asyncHandler = require('../utils/asyncHandler');
const { getProvider, calculateUserPrice } = require('../services/smsProvider');
const { generateOrderId, getTimeRemaining } = require('../models/Order');
const wallet       = require('./walletController');
const email        = require('../services/emailService');
const logger       = require('../utils/logger');

// ═════════════════════════════════════════════
// GET /api/numbers/countries
// ═════════════════════════════════════════════
exports.listCountries = asyncHandler(async (_req, res) => {
  const countries = [
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
  res.json({ success: true, count: countries.length, countries });
});

// ═════════════════════════════════════════════
// GET /api/numbers/services
// ═════════════════════════════════════════════
exports.listServices = asyncHandler(async (_req, res) => {
  const services = [
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
  res.json({ success: true, services });
});

// ═════════════════════════════════════════════
// GET /api/numbers/price?country=US&service=whatsapp
// ═════════════════════════════════════════════
exports.getPrice = asyncHandler(async (req, res) => {
  const { country, service = 'any' } = req.query;
  if (!country) throw ApiError.badRequest('Country required');

  const provider  = getProvider();
  const { cost, count, currency } = await provider.getPrice(country.toUpperCase(), service);
  const userPrice = calculateUserPrice(cost);

  res.json({
    success:          true,
    country:          country.toUpperCase(),
    service,
    providerCost:     cost,
    userPrice,
    currency:         'USD',
    providerCurrency: currency,
    available:        count,
    provider:         provider.name
  });
});

// ═════════════════════════════════════════════
// POST /api/numbers/buy
// Body: { serviceType: 'whatsapp'|'sms', country, service? }
// ═════════════════════════════════════════════
exports.buyNumber = asyncHandler(async (req, res) => {
  const { serviceType, country, service } = req.body;

  if (!['whatsapp', 'sms'].includes(serviceType)) throw ApiError.badRequest('Invalid service type');
  if (!country) throw ApiError.badRequest('Country required');

  const targetService = serviceType === 'whatsapp' ? 'whatsapp' : (service || 'any');

  // Fresh balance check
  const user = await prisma.user.findUnique({ where: { id: req.userId } });

  // Price + availability
  const provider = getProvider();
  let priceInfo;
  try {
    priceInfo = await provider.getPrice(country.toUpperCase(), targetService);
  } catch (_err) {
    throw ApiError.badRequest('Pricing unavailable for this combo');
  }

  const userCost = calculateUserPrice(priceInfo.cost);
  if (user.walletBalance < userCost) {
    throw ApiError.badRequest(
      `Insufficient balance. Need $${userCost.toFixed(2)}, have $${user.walletBalance.toFixed(2)}`
    );
  }

  // Buy from provider
  let purchase;
  try {
    purchase = await provider.buyNumber(country.toUpperCase(), targetService);
  } catch (err) {
    logger.error('Provider buyNumber failed:', err.message);
    throw err;
  }

  // Create order
  const order = await prisma.order.create({
    data: {
      userId:          req.userId,
      orderId:         generateOrderId(),
      provider:        provider.name,
      providerOrderId: purchase.providerOrderId,
      serviceType,
      service:         targetService,
      country:         country.toUpperCase(),
      phoneNumber:     purchase.phoneNumber,
      providerCost:    priceInfo.cost,
      userCost,
      status:          'active',
      activatedAt:     new Date(),
      expiresAt:       purchase.expiresAt || new Date(Date.now() + 20 * 60 * 1000),
      ipAddress:       req.ip,
      userAgent:       req.get('User-Agent')
    }
  });

  // Debit wallet
  try {
    await wallet.debitWallet({
      userId:      req.userId,
      amount:      userCost,
      orderId:     order.id,
      description: `${serviceType.toUpperCase()} ${country.toUpperCase()} ${order.phoneNumber}`
    });
  } catch (err) {
    // Rollback: cancel provider order + mark cancelled
    await provider.cancelOrder(purchase.providerOrderId).catch(() => {});
    await prisma.order.update({ where: { id: order.id }, data: { status: 'cancelled' } });
    throw err;
  }

  // Confirmation email (async)
  email.sendOrderConfirmation(req.user, order)
    .catch(e => logger.error('Order email:', e.message));

  logger.info(`Order ${order.orderId} created: ${order.phoneNumber} ($${userCost})`);

  res.status(201).json({
    success: true,
    order: {
      id:             order.id,
      orderId:        order.orderId,
      phoneNumber:    order.phoneNumber,
      country:        order.country,
      serviceType:    order.serviceType,
      service:        order.service,
      cost:           order.userCost,
      status:         order.status,
      expiresAt:      order.expiresAt,
      timeRemainingMs: getTimeRemaining(order)
    }
  });
});

// ═════════════════════════════════════════════
// GET /api/numbers/orders/:id/status
// ═════════════════════════════════════════════
exports.checkOrderStatus = asyncHandler(async (req, res) => {
  let order = await prisma.order.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!order) throw ApiError.notFound('Order not found');

  const now = new Date();

  // If still active, poll provider
  if (order.status === 'active' && order.expiresAt > now) {
    try {
      const provider = getProvider(order.provider);
      const status   = await provider.checkOrder(order.providerOrderId);

      if (status.sms && status.sms.length) {
        order = await prisma.order.update({
          where: { id: order.id },
          data: {
            smsMessages: status.sms,
            otpCode:     status.otpCode,
            status:      'received',
            completedAt: new Date()
          }
        });
        provider.finishOrder(order.providerOrderId).catch(() => {});
      } else if (status.status === 'cancelled') {
        order = await prisma.order.update({
          where: { id: order.id },
          data:  { status: 'cancelled', cancelledAt: new Date() }
        });
        await refundOrder(order, 'Provider cancelled');
      }
    } catch (err) {
      logger.error('checkOrderStatus provider error:', err.message);
    }
  }

  // If expired with no SMS, auto-refund
  if (order.status === 'active' && order.expiresAt < now) {
    order = await prisma.order.update({ where: { id: order.id }, data: { status: 'expired' } });
    await refundOrder(order, 'No SMS received within window');
  }

  res.json({
    success: true,
    order: {
      id:             order.id,
      orderId:        order.orderId,
      phoneNumber:    order.phoneNumber,
      status:         order.status,
      otpCode:        order.otpCode,
      smsMessages:    order.smsMessages,
      timeRemainingMs: getTimeRemaining(order)
    }
  });
});

// ═════════════════════════════════════════════
// POST /api/numbers/orders/:id/cancel
// ═════════════════════════════════════════════
exports.cancelOrder = asyncHandler(async (req, res) => {
  let order = await prisma.order.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!order) throw ApiError.notFound('Order not found');
  if (order.status !== 'active') throw ApiError.badRequest(`Cannot cancel order with status: ${order.status}`);

  try {
    const provider = getProvider(order.provider);
    await provider.cancelOrder(order.providerOrderId);
  } catch (err) {
    logger.warn('Provider cancel failed (continuing):', err.message);
  }

  order = await prisma.order.update({
    where: { id: order.id },
    data:  { status: 'cancelled', cancelledAt: new Date() }
  });

  await refundOrder(order, 'User cancelled');

  res.json({ success: true, message: 'Order cancelled and refunded', order });
});

// ═════════════════════════════════════════════
// GET /api/numbers/orders
// ═════════════════════════════════════════════
exports.listOrders = asyncHandler(async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);
  const skip  = (page - 1) * limit;

  const where = { userId: req.userId };
  if (req.query.status)      where.status      = req.query.status;
  if (req.query.serviceType) where.serviceType = req.query.serviceType;
  if (req.query.country)     where.country     = req.query.country.toUpperCase();

  const [orders, total] = await Promise.all([
    prisma.order.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
    prisma.order.count({ where })
  ]);

  res.json({
    success:    true,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
    orders
  });
});

// ═════════════════════════════════════════════
// GET /api/numbers/orders/:id
// ═════════════════════════════════════════════
exports.getOrder = asyncHandler(async (req, res) => {
  const order = await prisma.order.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!order) throw ApiError.notFound('Order not found');
  res.json({ success: true, order });
});

// ── Helper: refund an order ─────────────────────────────────
async function refundOrder(order, reason) {
  if (order.refundedAt) return;

  const refundTx = await wallet.creditWallet({
    userId:      order.userId,
    amount:      order.userCost,
    method:      'system',
    refundFor:   order.id,
    description: `Refund for order ${order.orderId}: ${reason}`
  });

  const statusUpdate = order.status !== 'cancelled' ? { status: 'refunded' } : {};

  await prisma.order.update({
    where: { id: order.id },
    data: {
      refundedAt:  new Date(),
      refundReason: reason,
      refundTxId:  refundTx.tx.id,
      ...statusUpdate
    }
  });

  logger.info(`Order ${order.orderId} refunded: ${reason}`);
  return refundTx;
}

exports._refundOrder = refundOrder;
