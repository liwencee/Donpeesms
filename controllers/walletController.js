/**
 * Wallet controller — balance, top-up initiation, transaction history
 */
const { supabase } = require('../config/supabase');
const ApiError     = require('../utils/apiError');
const asyncHandler = require('../utils/asyncHandler');
const stripe       = require('../services/stripeService');
const nowpay       = require('../services/nowPaymentsService');
const paypal       = require('../services/paypalService');
const { toCamelCase } = require('../utils/caseMapper');

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
  res.json({ success: true, balance: req.user.walletBalance, currency: 'USD' });
});

// ═════════════════════════════════════════════
// POST /api/wallet/topup
// ═════════════════════════════════════════════
exports.initiateTopup = asyncHandler(async (req, res) => {
  const { amount, method, payCurrency } = req.body;
  const amt = parseFloat(amount);

  if (!amt || amt < 1) throw ApiError.badRequest('Minimum top-up is $1');
  if (amt > 10000)     throw ApiError.badRequest('Maximum top-up is $10,000');

  const bonus = calculateBonus(amt);

  const { data: txRow, error: txErr } = await supabase.from('transactions').insert({
    user_id: req.userId,
    type: 'topup',
    amount: amt,
    bonus_amount: bonus,
    balance_after: req.user.walletBalance,
    method,
    status: 'pending',
    description: `Top-up via ${method}`,
    ip_address: req.ip,
    user_agent: req.get('User-Agent')
  }).select().single();
  if (txErr) throw new ApiError(500, txErr.message);

  let paymentData;

  switch (method) {
    case 'stripe': {
      const session = await stripe.createCheckoutSession({
        userId: req.userId, email: req.user.email, amount: amt, bonus
      });
      await supabase.from('transactions').update({ external_id: session.sessionId }).eq('id', txRow.id);
      paymentData = { url: session.url, sessionId: session.sessionId };
      break;
    }
    case 'nowpayments': {
      const payment = await nowpay.createPayment({
        userId: req.userId, amount: amt, bonus, payCurrency: payCurrency || 'usdttrc20'
      });
      await supabase.from('transactions').update({
        external_id: String(payment.paymentId),
        crypto_currency: payment.payCurrency,
        crypto_amount: payment.payAmount,
        crypto_address: payment.payAddress
      }).eq('id', txRow.id);
      paymentData = {
        paymentId: payment.paymentId, payAddress: payment.payAddress,
        payAmount: payment.payAmount, payCurrency: payment.payCurrency, expiresAt: payment.expiresAt
      };
      break;
    }
    case 'paypal': {
      const order = await paypal.createOrder({ userId: req.userId, amount: amt, bonus });
      await supabase.from('transactions').update({ external_id: order.orderId }).eq('id', txRow.id);
      paymentData = { orderId: order.orderId, approvalUrl: order.approvalUrl };
      break;
    }
    default:
      throw ApiError.badRequest('Invalid payment method');
  }

  res.status(201).json({
    success: true, transactionId: txRow.id, amount: amt, bonus, total: amt + bonus, method, payment: paymentData
  });
});

// ═════════════════════════════════════════════
// creditWallet (internal — used by webhooks + refunds)
// ═════════════════════════════════════════════
exports.creditWallet = async ({ userId, amount, bonus = 0, externalId, method, description, refundFor }) => {
  const { data, error } = await supabase.rpc('credit_wallet', {
    p_user_id: userId,
    p_amount: amount,
    p_bonus: bonus,
    p_method: method,
    p_external_id: externalId || null,
    p_description: description || `Credited $${(amount + bonus).toFixed(2)}`,
    p_order_id: refundFor || null,
    p_type: refundFor ? 'refund' : 'topup'
  });
  if (error) {
    if (error.message === 'User not found') throw ApiError.notFound('User not found');
    throw new ApiError(500, error.message);
  }

  const row = data[0];
  return { user: { id: userId, walletBalance: row.new_balance }, tx: { id: row.transaction_id } };
};

// ═════════════════════════════════════════════
// debitWallet (internal — used by purchase controller)
// ═════════════════════════════════════════════
exports.debitWallet = async ({ userId, amount, orderId, description }) => {
  const { data, error } = await supabase.rpc('debit_wallet', {
    p_user_id: userId,
    p_amount: amount,
    p_order_id: orderId || null,
    p_description: description || 'Number purchase'
  });
  if (error) {
    if (error.message === 'Insufficient wallet balance') throw ApiError.badRequest('Insufficient wallet balance');
    if (error.message === 'User not found') throw ApiError.notFound('User not found');
    throw new ApiError(500, error.message);
  }

  const row = data[0];
  return { user: { id: userId, walletBalance: row.new_balance }, tx: { id: row.transaction_id } };
};

// ═════════════════════════════════════════════
// GET /api/wallet/transactions
// ═════════════════════════════════════════════
exports.getTransactions = asyncHandler(async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const from  = (page - 1) * limit;
  const to    = from + limit - 1;

  let query = supabase.from('transactions').select('*', { count: 'exact' }).eq('user_id', req.userId);
  if (req.query.type)   query = query.eq('type', req.query.type);
  if (req.query.status) query = query.eq('status', req.query.status);

  const { data, error, count } = await query.order('created_at', { ascending: false }).range(from, to);
  if (error) throw new ApiError(500, error.message);

  res.json({
    success: true, page, limit, total: count, totalPages: Math.ceil(count / limit),
    transactions: toCamelCase(data)
  });
});

// ═════════════════════════════════════════════
// GET /api/wallet/transactions/:id
// ═════════════════════════════════════════════
exports.getTransaction = asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('transactions')
    .select('*, orders(*)')
    .eq('id', req.params.id)
    .eq('user_id', req.userId)
    .maybeSingle();
  if (error) throw new ApiError(500, error.message);
  if (!data) throw ApiError.notFound('Transaction not found');
  res.json({ success: true, transaction: toCamelCase(data) });
});

exports.calculateBonus = calculateBonus;
