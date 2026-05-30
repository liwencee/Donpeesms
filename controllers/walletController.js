/**
 * Wallet controller — balance, top-up initiation, transaction history
 */
const mongoose = require('mongoose');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const ApiError = require('../utils/apiError');
const asyncHandler = require('../utils/asyncHandler');
const stripe = require('../services/stripeService');
const nowpay = require('../services/nowPaymentsService');
const paypal = require('../services/paypalService');

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
  const user = await User.findById(req.userId).select('walletBalance');
  res.json({ success: true, balance: user.walletBalance, currency: 'USD' });
});

// ═════════════════════════════════════════════
// POST /api/wallet/topup
// Body: { amount, method: 'stripe'|'nowpayments'|'paypal', payCurrency? }
// ═════════════════════════════════════════════
exports.initiateTopup = asyncHandler(async (req, res) => {
  const { amount, method, payCurrency } = req.body;
  const amt = parseFloat(amount);

  if (!amt || amt < 1) throw ApiError.badRequest('Minimum top-up is $1');
  if (amt > 10000) throw ApiError.badRequest('Maximum top-up is $10,000');

  const bonus = calculateBonus(amt);

  // Create a pending transaction
  const tx = await Transaction.create({
    user: req.userId,
    type: 'topup',
    amount: amt,
    bonusAmount: bonus,
    balanceAfter: req.user.walletBalance, // not yet credited
    method,
    status: 'pending',
    description: `Top-up via ${method}`,
    ipAddress: req.ip,
    userAgent: req.get('User-Agent')
  });

  let paymentData;

  switch (method) {
    case 'stripe': {
      const session = await stripe.createCheckoutSession({
        userId: req.userId,
        email: req.user.email,
        amount: amt,
        bonus
      });
      tx.externalId = session.sessionId;
      await tx.save();
      paymentData = { url: session.url, sessionId: session.sessionId };
      break;
    }

    case 'nowpayments': {
      const payment = await nowpay.createPayment({
        userId: req.userId,
        amount: amt,
        bonus,
        payCurrency: payCurrency || 'usdttrc20'
      });
      tx.externalId = String(payment.paymentId);
      tx.cryptoCurrency = payment.payCurrency;
      tx.cryptoAmount = payment.payAmount;
      tx.cryptoAddress = payment.payAddress;
      await tx.save();
      paymentData = {
        paymentId: payment.paymentId,
        payAddress: payment.payAddress,
        payAmount: payment.payAmount,
        payCurrency: payment.payCurrency,
        expiresAt: payment.expiresAt
      };
      break;
    }

    case 'paypal': {
      const order = await paypal.createOrder({
        userId: req.userId,
        amount: amt,
        bonus
      });
      tx.externalId = order.orderId;
      await tx.save();
      paymentData = { orderId: order.orderId, approvalUrl: order.approvalUrl };
      break;
    }

    default:
      throw ApiError.badRequest('Invalid payment method');
  }

  res.status(201).json({
    success: true,
    transactionId: tx._id,
    amount: amt,
    bonus,
    total: amt + bonus,
    method,
    payment: paymentData
  });
});

// ═════════════════════════════════════════════
// POST /api/wallet/credit (internal — used by webhooks)
// ═════════════════════════════════════════════
exports.creditWallet = async ({ userId, amount, bonus = 0, externalId, method, description, refundFor }) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const user = await User.findById(userId).session(session);
    if (!user) throw ApiError.notFound('User not found');

    const total = amount + bonus;
    user.walletBalance = +(user.walletBalance + total).toFixed(2);
    await user.save({ session });

    const tx = await Transaction.create([{
      user: userId,
      type: refundFor ? 'refund' : 'topup',
      amount: total,
      bonusAmount: bonus,
      balanceAfter: user.walletBalance,
      method,
      externalId,
      status: 'success',
      description: description || `Credited ${total}`,
      order: refundFor
    }], { session });

    // Referral commission (10% for first-time top-ups)
    if (!refundFor && user.referredBy && method !== 'bonus') {
      const referrer = await User.findById(user.referredBy).session(session);
      if (referrer) {
        const commission = +(amount * 0.10).toFixed(2);
        referrer.walletBalance = +(referrer.walletBalance + commission).toFixed(2);
        referrer.referralEarnings = +(referrer.referralEarnings + commission).toFixed(2);
        await referrer.save({ session });

        await Transaction.create([{
          user: referrer._id,
          type: 'referral_payout',
          amount: commission,
          balanceAfter: referrer.walletBalance,
          method: 'system',
          status: 'success',
          description: `Referral commission from ${user.username}`
        }], { session });
      }
    }

    await session.commitTransaction();
    return { user, tx: tx[0] };
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
};

// ═════════════════════════════════════════════
// POST /api/wallet/debit (internal — used by purchase controller)
// ═════════════════════════════════════════════
exports.debitWallet = async ({ userId, amount, orderId, description }) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const user = await User.findById(userId).session(session);
    if (!user) throw ApiError.notFound('User not found');
    if (user.walletBalance < amount) {
      throw ApiError.badRequest('Insufficient wallet balance');
    }

    user.walletBalance = +(user.walletBalance - amount).toFixed(2);
    await user.save({ session });

    const tx = await Transaction.create([{
      user: userId,
      type: 'purchase',
      amount: -amount,
      balanceAfter: user.walletBalance,
      method: 'wallet',
      status: 'success',
      order: orderId,
      description: description || 'Number purchase'
    }], { session });

    await session.commitTransaction();
    return { user, tx: tx[0] };
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
};

// ═════════════════════════════════════════════
// GET /api/wallet/transactions
// ═════════════════════════════════════════════
exports.getTransactions = asyncHandler(async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const skip  = (page - 1) * limit;

  const filter = { user: req.userId };
  if (req.query.type) filter.type = req.query.type;
  if (req.query.status) filter.status = req.query.status;

  const [transactions, total] = await Promise.all([
    Transaction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Transaction.countDocuments(filter)
  ]);

  res.json({
    success: true,
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
  const tx = await Transaction.findOne({ _id: req.params.id, user: req.userId }).populate('order');
  if (!tx) throw ApiError.notFound('Transaction not found');
  res.json({ success: true, transaction: tx });
});

exports.calculateBonus = calculateBonus;
