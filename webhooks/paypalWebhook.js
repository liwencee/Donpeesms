/**
 * PayPal webhook / capture handler
 * POST /api/payments/paypal/capture — called by frontend after PayPal approval
 * POST /api/payments/paypal/webhook — async server-to-server notifications
 */
const paypal       = require('../services/paypalService');
const { prisma }   = require('../config/db');
const wallet       = require('../controllers/walletController');
const email        = require('../services/emailService');
const logger       = require('../utils/logger');
const asyncHandler = require('../utils/asyncHandler');
const ApiError     = require('../utils/apiError');

/**
 * Direct capture — frontend calls this after user approves on PayPal
 */
exports.capturePayment = asyncHandler(async (req, res) => {
  const { paypalOrderId } = req.body;
  if (!paypalOrderId) throw ApiError.badRequest('paypalOrderId required');

  const pending = await prisma.transaction.findFirst({
    where: { externalId: paypalOrderId, userId: req.userId, status: 'pending' }
  });
  if (!pending) throw ApiError.notFound('Pending transaction not found');

  const captureResult = await paypal.captureOrder(paypalOrderId);

  if (captureResult.status !== 'COMPLETED') {
    await prisma.transaction.update({
      where: { id: pending.id },
      data:  { status: 'failed', externalStatus: captureResult.status }
    });
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

  await prisma.transaction.update({
    where: { id: pending.id },
    data: {
      status:      'success',
      balanceAfter: user.walletBalance,
      metadata:    { ...(pending.metadata || {}), paypalCaptureId: captureResult.id }
    }
  });

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
