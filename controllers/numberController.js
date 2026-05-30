/**
 * Number controller — buy, check, cancel, finish virtual numbers
 */
const Order = require('../models/Order');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const ApiError = require('../utils/apiError');
const asyncHandler = require('../utils/asyncHandler');
const { getProvider, calculateUserPrice } = require('../services/smsProvider');
const wallet = require('./walletController');
const email = require('../services/emailService');
const logger = require('../utils/logger');

// ═════════════════════════════════════════════
// GET /api/numbers/countries
// ═════════════════════════════════════════════
exports.listCountries = asyncHandler(async (req, res) => {
  // Static list for now — could fetch from provider for live availability
  const countries = [
    { code: 'US', name: 'United States', flag: '🇺🇸' },
    { code: 'GB', name: 'United Kingdom', flag: '🇬🇧' },
    { code: 'DE', name: 'Germany', flag: '🇩🇪' },
    { code: 'FR', name: 'France', flag: '🇫🇷' },
    { code: 'IN', name: 'India', flag: '🇮🇳' },
    { code: 'BR', name: 'Brazil', flag: '🇧🇷' },
    { code: 'CA', name: 'Canada', flag: '🇨🇦' },
    { code: 'AU', name: 'Australia', flag: '🇦🇺' },
    { code: 'RU', name: 'Russia', flag: '🇷🇺' },
    { code: 'NG', name: 'Nigeria', flag: '🇳🇬' },
    { code: 'PK', name: 'Pakistan', flag: '🇵🇰' },
    { code: 'ID', name: 'Indonesia', flag: '🇮🇩' },
    { code: 'TR', name: 'Turkey', flag: '🇹🇷' },
    { code: 'MX', name: 'Mexico', flag: '🇲🇽' },
    { code: 'PH', name: 'Philippines', flag: '🇵🇭' },
    { code: 'VN', name: 'Vietnam', flag: '🇻🇳' },
    { code: 'UA', name: 'Ukraine', flag: '🇺🇦' },
    { code: 'ZA', name: 'South Africa', flag: '🇿🇦' },
    { code: 'EG', name: 'Egypt', flag: '🇪🇬' },
    { code: 'SA', name: 'Saudi Arabia', flag: '🇸🇦' },
    { code: 'AE', name: 'UAE', flag: '🇦🇪' },
    { code: 'KE', name: 'Kenya', flag: '🇰🇪' },
    { code: 'GH', name: 'Ghana', flag: '🇬🇭' },
    { code: 'JP', name: 'Japan', flag: '🇯🇵' },
    { code: 'KR', name: 'South Korea', flag: '🇰🇷' },
    { code: 'MY', name: 'Malaysia', flag: '🇲🇾' },
    { code: 'SG', name: 'Singapore', flag: '🇸🇬' },
    { code: 'TH', name: 'Thailand', flag: '🇹🇭' }
  ];
  res.json({ success: true, count: countries.length, countries });
});

// ═════════════════════════════════════════════
// GET /api/numbers/services
// ═════════════════════════════════════════════
exports.listServices = asyncHandler(async (req, res) => {
  const services = [
    { code: 'whatsapp',  name: 'WhatsApp',     icon: 'whatsapp' },
    { code: 'telegram',  name: 'Telegram',     icon: 'telegram' },
    { code: 'google',    name: 'Google',       icon: 'google' },
    { code: 'facebook',  name: 'Facebook',     icon: 'facebook' },
    { code: 'instagram', name: 'Instagram',    icon: 'instagram' },
    { code: 'twitter',   name: 'Twitter / X',  icon: 'twitter' },
    { code: 'tiktok',    name: 'TikTok',       icon: 'tiktok' },
    { code: 'uber',      name: 'Uber',         icon: 'uber' },
    { code: 'amazon',    name: 'Amazon',       icon: 'amazon' },
    { code: 'paypal',    name: 'PayPal',       icon: 'paypal' },
    { code: 'microsoft', name: 'Microsoft',    icon: 'microsoft' },
    { code: 'discord',   name: 'Discord',      icon: 'discord' },
    { code: 'any',       name: 'Any Service',  icon: 'any' }
  ];
  res.json({ success: true, services });
});

// ═════════════════════════════════════════════
// GET /api/numbers/price?country=US&service=whatsapp
// ═════════════════════════════════════════════
exports.getPrice = asyncHandler(async (req, res) => {
  const { country, service = 'any' } = req.query;
  if (!country) throw ApiError.badRequest('Country required');

  const provider = getProvider();
  const { cost, count, currency } = await provider.getPrice(country.toUpperCase(), service);
  const userPrice = calculateUserPrice(cost);

  res.json({
    success: true,
    country: country.toUpperCase(),
    service,
    providerCost: cost,
    userPrice,
    currency: 'USD',
    providerCurrency: currency,
    available: count,
    provider: provider.name
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

  // Get user with fresh balance
  const user = await User.findById(req.userId);

  // Get price + check availability
  const provider = getProvider();
  let priceInfo;
  try {
    priceInfo = await provider.getPrice(country.toUpperCase(), targetService);
  } catch (err) {
    throw ApiError.badRequest('Pricing unavailable for this combo');
  }

  const userCost = calculateUserPrice(priceInfo.cost);
  if (user.walletBalance < userCost) {
    throw ApiError.badRequest(`Insufficient balance. Need $${userCost.toFixed(2)}, have $${user.walletBalance.toFixed(2)}`);
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
  const order = await Order.create({
    user: req.userId,
    orderId: Order.generateOrderId(),
    provider: provider.name,
    providerOrderId: purchase.providerOrderId,
    serviceType,
    service: targetService,
    country: country.toUpperCase(),
    phoneNumber: purchase.phoneNumber,
    providerCost: priceInfo.cost,
    userCost,
    status: 'active',
    activatedAt: new Date(),
    expiresAt: purchase.expiresAt || new Date(Date.now() + 20 * 60 * 1000),
    ipAddress: req.ip,
    userAgent: req.get('User-Agent')
  });

  // Debit wallet
  try {
    await wallet.debitWallet({
      userId: req.userId,
      amount: userCost,
      orderId: order._id,
      description: `${serviceType.toUpperCase()} ${country.toUpperCase()} ${order.phoneNumber}`
    });
  } catch (err) {
    // Rollback: cancel provider order
    await provider.cancelOrder(purchase.providerOrderId).catch(() => {});
    order.status = 'cancelled';
    await order.save();
    throw err;
  }

  // Send confirmation email (async)
  email.sendOrderConfirmation(req.user, order).catch(e => logger.error('Order email:', e.message));

  logger.info(`Order ${order.orderId} created: ${order.phoneNumber} (${userCost})`);

  res.status(201).json({
    success: true,
    order: {
      id: order._id,
      orderId: order.orderId,
      phoneNumber: order.phoneNumber,
      country: order.country,
      serviceType: order.serviceType,
      service: order.service,
      cost: order.userCost,
      status: order.status,
      expiresAt: order.expiresAt,
      timeRemainingMs: order.timeRemaining
    }
  });
});

// ═════════════════════════════════════════════
// GET /api/numbers/orders/:id/status
// ═════════════════════════════════════════════
exports.checkOrderStatus = asyncHandler(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, user: req.userId });
  if (!order) throw ApiError.notFound('Order not found');

  // If still active, check provider for SMS
  if (order.status === 'active' && order.expiresAt > Date.now()) {
    try {
      const provider = getProvider(order.provider);
      const status = await provider.checkOrder(order.providerOrderId);

      if (status.sms && status.sms.length) {
        order.smsMessages = status.sms;
        order.otpCode = status.otpCode;
        order.status = 'received';
        order.completedAt = new Date();
        await order.save();

        // Auto-finish on provider
        provider.finishOrder(order.providerOrderId).catch(() => {});
      } else if (status.status === 'cancelled') {
        order.status = 'cancelled';
        order.cancelledAt = new Date();
        await order.save();
        await refundOrder(order, 'Provider cancelled');
      }
    } catch (err) {
      logger.error('checkOrderStatus provider error:', err.message);
    }
  }

  // If expired and no SMS, auto-refund
  if (order.status === 'active' && order.expiresAt < Date.now()) {
    order.status = 'expired';
    await order.save();
    await refundOrder(order, 'No SMS received within window');
  }

  res.json({
    success: true,
    order: {
      id: order._id,
      orderId: order.orderId,
      phoneNumber: order.phoneNumber,
      status: order.status,
      otpCode: order.otpCode,
      smsMessages: order.smsMessages,
      timeRemainingMs: order.timeRemaining
    }
  });
});

// ═════════════════════════════════════════════
// POST /api/numbers/orders/:id/cancel
// ═════════════════════════════════════════════
exports.cancelOrder = asyncHandler(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, user: req.userId });
  if (!order) throw ApiError.notFound('Order not found');
  if (order.status !== 'active') throw ApiError.badRequest(`Cannot cancel order with status: ${order.status}`);

  try {
    const provider = getProvider(order.provider);
    await provider.cancelOrder(order.providerOrderId);
  } catch (err) {
    logger.warn('Provider cancel failed (continuing):', err.message);
  }

  order.status = 'cancelled';
  order.cancelledAt = new Date();
  await order.save();

  await refundOrder(order, 'User cancelled');

  res.json({ success: true, message: 'Order cancelled and refunded', order });
});

// ═════════════════════════════════════════════
// GET /api/numbers/orders
// ═════════════════════════════════════════════
exports.listOrders = asyncHandler(async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);
  const skip  = (page - 1) * limit;

  const filter = { user: req.userId };
  if (req.query.status)      filter.status = req.query.status;
  if (req.query.serviceType) filter.serviceType = req.query.serviceType;
  if (req.query.country)     filter.country = req.query.country.toUpperCase();

  const [orders, total] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Order.countDocuments(filter)
  ]);

  res.json({
    success: true,
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
  const order = await Order.findOne({ _id: req.params.id, user: req.userId });
  if (!order) throw ApiError.notFound('Order not found');
  res.json({ success: true, order });
});

// ── Helper: refund an order ──
async function refundOrder(order, reason) {
  if (order.refundedAt) return;

  const refundTx = await wallet.creditWallet({
    userId: order.user,
    amount: order.userCost,
    method: 'system',
    refundFor: order._id,
    description: `Refund for order ${order.orderId}: ${reason}`
  });

  order.refundedAt = new Date();
  order.refundReason = reason;
  order.refundTx = refundTx.tx._id;
  if (order.status !== 'cancelled') order.status = 'refunded';
  await order.save();

  logger.info(`Order ${order.orderId} refunded: ${reason}`);
  return refundTx;
}

exports._refundOrder = refundOrder;
