/**
 * Wallet controller — balance, top-up initiation, transaction history
 */
const { prisma }   = require('../config/db');
const { USER_PUBLIC } = require('../models/User');
const ApiError     = require('../utils/apiError');
const asyncHandler = require('../utils/asyncHandler');
const stripe       = require('../services/stripeService');
const nowpay       = require('../services/nowPaymentsService');
const paypal       = require('../services/paypalService');

// Bonus tiers
const calculateBonus = (amount) => {
  if (amount >= 100) return amount * 0.20;
  if (amount >= 50)  return amount * 0.15;
  if (amount >= 25)  return amount * 0.10;
  return 0;
};

// ═════════════════════════════════════════════
// GET /api/wallet
// ═════════════════════════════════════════════
exports.getWallet = asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({
    where:  { id: req.userId },
    select: { walletBalance: true }
  });
  res.json({ success: true, balance: user.walletBalance, currency: 'USD' });
});

// ═════════════════════════════════════════════
// POST /api/wallet/topup
// Body: { amount, method: 'stripe'|'nowpayments'|'paypal', payCurrency? }
// ═════════════════════════════════════════════
exports.initiateTopup = asyncHandler(async (req, res) => {
  const { amount, method, payCurrency } = req.body;
  const amt = parseFloat(amount);

  if (!amt || amt < 1)    throw ApiError.badRequest('Minimum top-up is $1');
  if (amt > 10000)         throw ApiError.badRequest('Maximum top-up is $10,000');

  const bonus = calculateBonus(amt);

  // Pending transaction (not yet credited)
  const tx = await prisma.transaction.create({
    data: {
      userId:      req.userId,
      type:        'topup',
      amount:      amt,
      bonusAmount: bonus,
      balanceAfter: req.user.walletBalance, // not yet credited
      method,
      status:      'pending',
      description: `Top-up via ${method}`,
      ipAddress:   req.ip,
      userAgent:   req.get('User-Agent')
    }
  });

  let paymentData;

  switch (method) {
    case 'stripe': {
      const session = await stripe.createCheckoutSession({
        userId: req.userId,
        email:  req.user.email,
        amount: amt,
        bonus
      });
      await prisma.transaction.update({
        where: { id: tx.id },
        data:  { externalId: session.sessionId }
      });
      paymentData = { url: session.url, sessionId: session.sessionId };
      break;
    }

    case 'nowpayments': {
      const payment = await nowpay.createPayment({
        userId:      req.userId,
        amount:      amt,
        bonus,
        payCurrency: payCurrency || 'usdttrc20'
      });
      await prisma.transaction.update({
        where: { id: tx.id },
        data: {
          externalId:     String(payment.paymentId),
          cryptoCurrency: payment.payCurrency,
          cryptoAmount:   payment.payAmount,
          cryptoAddress:  payment.payAddress
        }
      });
      paymentData = {
        paymentId:   payment.paymentId,
        payAddress:  payment.payAddress,
        payAmount:   payment.payAmount,
        payCurrency: payment.payCurrency,
        expiresAt:   payment.expiresAt
      };
      break;
    }

    case 'paypal': {
      const order = await paypal.createOrder({
        userId: req.userId,
        amount: amt,
        bonus
      });
      await prisma.transaction.update({
        where: { id: tx.id },
        data:  { externalId: order.orderId }
      });
      paymentData = { orderId: order.orderId, approvalUrl: order.approvalUrl };
      break;
    }

    default:
      throw ApiError.badRequest('Invalid payment method');
  }

  res.status(201).json({
    success:       true,
    transactionId: tx.id,
    amount:        amt,
    bonus,
    total:         amt + bonus,
    method,
    payment:       paymentData
  });
});

// ═════════════════════════════════════════════
// creditWallet  (internal — used by webhooks)
// ═════════════════════════════════════════════
exports.creditWallet = async ({ userId, amount, bonus = 0, externalId, method, description, refundFor }) => {
  const total = +(amount + bonus).toFixed(2);

  const result = await prisma.$transaction(async (ctx) => {
    const user = await ctx.user.findUnique({ where: { id: userId } });
    if (!user) throw ApiError.notFound('User not found');

    const newBalance = +(user.walletBalance + total).toFixed(2);

    const updatedUser = await ctx.user.update({
      where:  { id: userId },
      data:   { walletBalance: newBalance },
      select: USER_PUBLIC
    });

    const tx = await ctx.transaction.create({
      data: {
        userId,
        type:         refundFor ? 'refund' : 'topup',
        amount:       total,
        bonusAmount:  bonus,
        balanceAfter: newBalance,
        method,
        externalId,
        status:       'success',
        description:  description || `Credited $${total}`,
        orderId:      refundFor || undefined
      }
    });

    // Referral commission (10% for first top-up, not for refunds/bonuses)
    if (!refundFor && user.referredById && method !== 'bonus') {
      const referrer = await ctx.user.findUnique({ where: { id: user.referredById } });
      if (referrer) {
        const commission         = +(amount * 0.10).toFixed(2);
        const referrerNewBalance = +(referrer.walletBalance + commission).toFixed(2);

        await ctx.user.update({
          where: { id: referrer.id },
          data: {
            walletBalance:    referrerNewBalance,
            referralEarnings: +(referrer.referralEarnings + commission).toFixed(2)
          }
        });

        await ctx.transaction.create({
          data: {
            userId:      referrer.id,
            type:        'referral_payout',
            amount:      commission,
            balanceAfter: referrerNewBalance,
            method:      'system',
            status:      'success',
            description: `Referral commission from ${user.username}`
          }
        });
      }
    }

    return { user: updatedUser, tx };
  });

  return result;
};

// ═════════════════════════════════════════════
// debitWallet  (internal — used by purchase controller)
// ═════════════════════════════════════════════
exports.debitWallet = async ({ userId, amount, orderId, description }) => {
  const result = await prisma.$transaction(async (ctx) => {
    const user = await ctx.user.findUnique({ where: { id: userId } });
    if (!user) throw ApiError.notFound('User not found');
    if (user.walletBalance < amount) throw ApiError.badRequest('Insufficient wallet balance');

    const newBalance = +(user.walletBalance - amount).toFixed(2);

    const updatedUser = await ctx.user.update({
      where:  { id: userId },
      data:   { walletBalance: newBalance },
      select: USER_PUBLIC
    });

    const tx = await ctx.transaction.create({
      data: {
        userId,
        type:        'purchase',
        amount:      -amount,
        balanceAfter: newBalance,
        method:      'wallet',
        status:      'success',
        orderId:     orderId || undefined,
        description: description || 'Number purchase'
      }
    });

    return { user: updatedUser, tx };
  });

  return result;
};

// ═════════════════════════════════════════════
// GET /api/wallet/transactions
// ═════════════════════════════════════════════
exports.getTransactions = asyncHandler(async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const skip  = (page - 1) * limit;

  const where = { userId: req.userId };
  if (req.query.type)   where.type   = req.query.type;
  if (req.query.status) where.status = req.query.status;

  const [transactions, total] = await Promise.all([
    prisma.transaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit
    }),
    prisma.transaction.count({ where })
  ]);

  res.json({
    success:    true,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
    transactions
  });
});

// ═════════════════════════════════════════════
// GET /api/wallet/transactions/:id
// ═════════════════════════════════════════════
exports.getTransaction = asyncHandler(async (req, res) => {
  const tx = await prisma.transaction.findFirst({
    where:   { id: req.params.id, userId: req.userId },
    include: { order: true }
  });
  if (!tx) throw ApiError.notFound('Transaction not found');
  res.json({ success: true, transaction: tx });
});

exports.calculateBonus = calculateBonus;
