/**
 * PayPal webhook handler — credits wallet on order approval
 * Note: Frontend typically captures via API; this is a safety net for asynchronous events.
 */
const paypal = require('../services/paypalService');
const Transaction = require('../models/Transaction');
const wallet = require('../controllers/walletController');
const email = require('../services/emailService');
const logger = require('../utils/logger');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/apiError');

/**
 * Direct capture endpoint — called by frontend after PayPal approval
 * POST /api/payments/paypal/capture
 * Body: { paypalOrderId }
 */
exports.capturePayment = asyncHandler(async (req, res) => {
  const { paypalOrderId } = req.body;
  if (!paypalOrderId) throw ApiError.badRequest('paypalOrderId required');

  const pending = await Transaction.findOne({
    externalId: paypalOrderId,
    user: req.userId,
    status: 'pending'
  });
  if (!pending) throw ApiError.notFound('Pending transaction not found');

  const captureResult = await paypal.captureOrder(paypalOrderId);

  if (captureResult.status !== 'COMPLETED') {
    pending.status = 'failed';
    pending.externalStatus = captureResult.status;
    await pending.save();
    throw ApiError.badRequest(`Payment status: ${captureResult.status}`);
  }

  const amount = pending.amount;
  const bonus = pending.bonusAmount || 0;

  const { user, tx } = await wallet.creditWallet({
    userId: req.userId,
    amount,
    bonus,
    externalId: paypalOrderId,
    method: 'paypal',
    description: `PayPal top-up ($${amount})`
  });

  pending.status = 'success';
  pending.balanceAfter = user.walletBalance;
  pending.metadata = { ...pending.metadata, paypalCaptureId: captureResult.id };
  await pending.save();

  email.sendTopupConfirmation(user, tx).catch(e => logger.error('Topup email:', e.message));

  res.json({
    success: true,
    message: 'Payment captured, wallet credited',
    newBalance: user.walletBalance,
    transaction: tx
  });
});

/**
 * Async webhook (server-to-server notifications)
 */
exports.webhook = asyncHandler(async (req, res) => {
  const event = req.body;
  logger.info(`PayPal webhook: ${event.event_type}`);

  if (event.event_type === 'CHECKOUT.ORDER.APPROVED') {
    // Optional: auto-capture here too
  }

  res.json({ received: true });
});
