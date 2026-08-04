/**
 * PayPal webhook / capture handler
 * POST /api/payments/paypal/capture — called by frontend after PayPal approval
 * POST /api/payments/paypal/webhook — async server-to-server notifications
 */
const paypal       = require('../services/paypalService');
const { supabase } = require('../config/supabase');
const wallet       = require('../controllers/walletController');
const email        = require('../services/emailService');
const logger       = require('../utils/logger');
const asyncHandler = require('../utils/asyncHandler');
const ApiError     = require('../utils/apiError');
const { toCamelCase } = require('../utils/caseMapper');

/**
 * Direct capture — frontend calls this after user approves on PayPal
 */
exports.capturePayment = asyncHandler(async (req, res) => {
  const { paypalOrderId } = req.body;
  if (!paypalOrderId) throw ApiError.badRequest('paypalOrderId required');

  const { data: pendingRow, error: findErr } = await supabase
    .from('transactions').select('*').eq('external_id', paypalOrderId).eq('user_id', req.userId).eq('status', 'pending').maybeSingle();
  if (findErr) throw ApiError.internal(findErr.message);
  if (!pendingRow) throw ApiError.notFound('Pending transaction not found');
  const pending = toCamelCase(pendingRow);

  const captureResult = await paypal.captureOrder(paypalOrderId);

  if (captureResult.status !== 'COMPLETED') {
    const { error } = await supabase.from('transactions').update({
      status: 'failed', external_status: captureResult.status
    }).eq('id', pending.id);
    if (error) logger.error('PayPal webhook: failed to mark tx failed:', error.message);
    throw ApiError.badRequest(`Payment status: ${captureResult.status}`);
  }

  const amount = pending.amount;
  const bonus  = pending.bonusAmount || 0;

  const { user, tx } = await wallet.creditWallet({
    userId:      req.userId,
    amount,
    bonus,
    externalId:  paypalOrderId,
    method:      'paypal',
    description: `PayPal top-up ($${amount})`
  });

  const { error: updateErr } = await supabase.from('transactions').update({
    status:        'success',
    balance_after: user.walletBalance,
    metadata:      { ...(pending.metadata || {}), paypalCaptureId: captureResult.id }
  }).eq('id', pending.id);
  if (updateErr) logger.error('PayPal webhook: failed to mark pending tx fulfilled:', updateErr.message);

  email.sendTopupConfirmation(user, tx)
    .catch(e => logger.error('Topup email:', e.message));

  res.json({
    success:     true,
    message:     'Payment captured, wallet credited',
    newBalance:  user.walletBalance,
    transaction: tx
  });
});

/**
 * Async webhook (server-to-server notifications)
 */
exports.webhook = asyncHandler(async (req, res) => {
  const event = req.body;
  logger.info(`PayPal webhook: ${event.event_type}`);
  // Optional: auto-capture on CHECKOUT.ORDER.APPROVED
  res.json({ received: true });
});
