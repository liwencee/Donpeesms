/**
 * Wallet controller — balance, top-up initiation, transaction history
 */
const { supabase } = require('../config/supabase');
const ApiError     = require('../utils/apiError');
const asyncHandler = require('../utils/asyncHandler');
const drexpay      = require('../services/drexpayService');
const logger       = require('../utils/logger');
const { toCamelCase } = require('../utils/caseMapper');

// Bonuses are disabled — kept as a function (not deleted) since `bonus`
// still flows through initiateTopup/creditWallet/transactions.bonus_amount
// and the email template's conditional bonus line; forcing the source to
// 0 makes all of that correctly inert without touching those call sites.
const calculateBonus = (_amount) => 0;

// ═════════════════════════════════════════════
// GET /api/wallet
// ═════════════════════════════════════════════
exports.getWallet = asyncHandler(async (req, res) => {
  res.json({ success: true, balance: req.user.walletBalance, currency: 'NGN' });
});

// ═════════════════════════════════════════════
// POST /api/wallet/topup
// ═════════════════════════════════════════════
exports.initiateTopup = asyncHandler(async (req, res) => {
  const { amount, method } = req.body;
  const amt = parseFloat(amount);

  if (!amt || amt < 1500)     throw ApiError.badRequest('Minimum top-up is ₦1,500');
  if (amt > 15000000)         throw ApiError.badRequest('Maximum top-up is ₦15,000,000');

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
    case 'drexpay': {
      const link = await drexpay.createPaymentLink({ email: req.user.email, amount: amt });
      await supabase.from('transactions').update({ external_id: link.reference }).eq('id', txRow.id);
      paymentData = { url: link.url, reference: link.reference };
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

  // All three payment webhooks hand this `user` straight to
  // email.sendTopupConfirmation, which needs an address — and `email`
  // lives in auth.users, not profiles, so it has to be looked up.
  //
  // Deliberately non-fatal: the money has already moved by this point
  // and the RPC has committed. Failing (or worse, appearing to fail)
  // over an email address would be far more damaging than a missing
  // confirmation email, so log and carry on.
  let email;
  try {
    const { data: authUser, error: authErr } = await supabase.auth.admin.getUserById(userId);
    if (authErr) throw authErr;
    email = authUser?.user?.email;
  } catch (err) {
    logger.warn(`creditWallet: credited user ${userId} but could not resolve their email:`, err.message);
  }

  return {
    user: { id: userId, walletBalance: row.new_balance, email },
    // NOTE: `amount` is the BASE amount, excluding the bonus. The RPC
    // stores amount+bonus in transactions.amount; the confirmation email
    // shows Amount and Bonus as separate lines, so double-counting the
    // bonus here would overstate the top-up. Guarded by tests/wallet.test.js.
    tx: { id: row.transaction_id, amount: amount, bonusAmount: bonus, balanceAfter: row.new_balance }
  };
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
